// SIGMA Phase 3+ (24/7) — Kết bạn (kế hoạch mục 27). DB access + orchestration sống Ở ĐÂY (giống
// lo-service.ts) — routes/me.ts CHỈ wrap HTTP, KHÔNG cài lại logic. Model FriendRequest (schema.prisma) —
// xem comment đầu model cho ngữ nghĩa status/acceptedAt/ràng buộc unique-theo-cặp.
//
// QUYẾT ĐỊNH THIẾT KẾ (LEAD tự chọn, KHÔNG hỏi lại theo yêu cầu — ghi rõ để review):
// 1. unfriend() dùng CHUNG 1 endpoint cho CẢ "hủy kết bạn" (quan hệ ACCEPTED) LẪN "thu hồi lời mời đang chờ"
//    (quan hệ PENDING do CHÍNH mình gửi) — cả 2 đều là "tôi chủ động chấm dứt quan hệ với người này", tránh
//    phình thêm endpoint ngoài 5 endpoint đã liệt kê trong spec. KHÔNG cho hủy quan hệ PENDING do NGƯỜI KHÁC
//    gửi tới mình qua unfriend (phải dùng reject cho trường hợp đó — rõ ý nghĩa hơn "từ chối" so với "hủy").
// 2. Gửi lời mời khi NGƯỢC CHIỀU đã có PENDING (B đã mời A, A gọi request tới B) → TỰ ĐỘNG CHẤP NHẬN lời mời
//    cũ thay vì báo lỗi trùng — hành vi giống Zalo/Messenger (2 người cùng bấm kết bạn gần như đồng thời vẫn
//    thành bạn ngay, không bắt 1 trong 2 phải vào lại từ chối/gửi lại). Ghi rõ trong response bằng field
//    `autoAccepted: true` để frontend có thể hiện thông báo khác ("Đã thành bạn bè!" thay vì "Đã gửi lời mời").
// 3. Giới hạn 2000 bạn bè/đại lý (Admin Demo chốt 24/7): kiểm tra CHẶN TRƯỚC khi tạo quan hệ ACCEPTED — áp cho
//    CẢ 2 đường hình thành bạn bè thật: acceptFriendRequest() (explicit) VÀ nhánh auto-accept trong
//    sendFriendRequest() (implicit, xem quyết định #2). Admin Demo yêu cầu tối thiểu kiểm tra phía "agent đang
//    gọi" — LEAD MỞ RỘNG kiểm tra CẢ 2 BÊN ở những chỗ hành động thật sự tạo ra 1 quan hệ ACCEPTED (accept
//    thường + auto-accept), vì accept luôn ảnh hưởng đồng thời tới giới hạn của CẢ 2 phía, chỉ chặn 1 phía sẽ
//    để lọt trường hợp phía kia (người gửi lời mời gốc) đã đầy 2000 bạn từ lúc gửi tới lúc được chấp nhận.
//    Ở sendFriendRequest() nhánh TẠO PENDING mới (chưa phải bạn bè) CHỈ kiểm tra phía người gửi (đúng yêu cầu
//    tối thiểu — PENDING chưa tính là bạn bè của người nhận nên không cần kiểm tra phía họ ở bước này, họ sẽ
//    tự bị chặn khi CHÍNH HỌ gọi accept nếu lúc đó đã đầy).
import { Prisma, type Db } from '@sigma/database';
import { isAccountDeactivated } from './deletion-service.js';
import { agentPresenceOnline, getAgentLastSeen } from './chat-realtime-hub.js';
import { sendPushToAgent } from './push-notification-service.js';
import { notifyFriendConnectionEvent } from './notification-service.js';

// ── Ẩn bot hệ thống "SigMa" khỏi Tìm bạn / Danh bạ (Admin Demo) ──────────────────────────────────────────────
// Bot SigMa (Agent.code='SIGMA_BOT', do investor-crosspost-service.ts seed để tự đẩy bill sang nhóm NĐT) là
// tài khoản HỆ THỐNG — KHÔNG được hiện ra như 1 đại lý có thể kết bạn/tra cứu. NHƯNG bot VẪN là thành viên
// phòng chat NĐT + gửi tin (không đụng tới ở đây — chỉ lọc ở tìm bạn/danh bạ).
//
// LƯU Ý CHO LEAD (hợp nhất sau): hằng gốc là `SIGMA_BOT_CODE` trong `./investor-crosspost-service.js`. KHÔNG
// import trực tiếp từ đó vì tạo VÒNG import: friend-service → investor-crosspost-service →
// services/chat-message-service (`canMessageAgent`) → friend-service (cycle → const có thể undefined lúc nạp).
// Định nghĩa LOCAL để tránh phụ thuộc; giá trị PHẢI luôn khớp SIGMA_BOT_CODE. Khi phá được cycle, gộp về 1 nguồn.
const SIGMA_BOT_AGENT_CODE = 'SIGMA_BOT';

/** true nếu agent là bot hệ thống SigMa (so theo Agent.code). Lọc Ở TẦNG APP (sau khi đọc hàng) — KHÔNG dùng
 * SQL `NOT code='SIGMA_BOT'` vì `code` NULLABLE → điều kiện 3-trị (NULL) sẽ NUỐT luôn agent có code=null. */
function isAlphaBot(agent: { code: string | null } | null | undefined): boolean {
  return agent?.code === SIGMA_BOT_AGENT_CODE;
}

// #17 (Admin Demo 8/8 "THÊM push còn thiếu: kết bạn/lời mời, chấp nhận kết bạn") — đẩy FCM cho sự kiện kết bạn.
// Best-effort THUẦN: KHÔNG BAO GIỜ throw ra luồng (quan hệ đã ghi DB thành công là chính; push chỉ phụ trợ).
// `kind` để client deep-link (friend_request → màn Lời mời; friend_accept → hồ sơ/danh bạ).
async function pushFriendEvent(db: Db, recipientAgentId: number, actorAgentId: number, kind: string, verb: string): Promise<void> {
  try {
    let actorName = 'Một người';
    const a = await db.agent.findUnique({ where: { id: actorAgentId }, select: { name: true } });
    if (a?.name) actorName = a.name;
    await sendPushToAgent(db, recipientAgentId, {
      title: 'SigMa',
      body: `${actorName} ${verb}`,
      data: { kind, actorAgentId: String(actorAgentId) },
      priority: 'high'
    });
  } catch (err) {
    console.error(`[bot-api] friend-service: push sự kiện kết bạn (${kind}) thất bại recipient=${recipientAgentId} (best-effort):`, err);
  }
}

/** Giới hạn tối đa số bạn bè (ACCEPTED)/1 đại lý — Admin Demo chốt 24/7. Đổi ở ĐÚNG 1 chỗ này. */
export const FRIEND_LIMIT = 2000;

/** true nếu err là vi phạm UNIQUE CONSTRAINT thật của Prisma (P2002) — CÙNG helper đã dùng ở
 * chat-room-service.ts (findOrCreateDirectRoom) / chat-room-tid-service.ts (linkTidToRoom) cho race
 * "double-click". Bất biến DB bị chạm ở đây là partial unique index `friend_requests_pair_active_uq`
 * (migration 20260724190000_friend_requests): 1 CẶP agent chỉ có ĐÚNG 1 quan hệ ĐANG SỐNG (PENDING/ACCEPTED)
 * bất kể chiều — chặn ghi TRÙNG khi 2 request đồng thời cùng vượt qua findActiveRelation() rồi cùng create. */
function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export type FriendServiceError =
  | { ok: false; error: 'VALIDATION'; message: string }
  | { ok: false; error: 'SELF_FRIEND_REQUEST'; message: string }
  | { ok: false; error: 'AGENT_NOT_FOUND'; message: string }
  | { ok: false; error: 'ALREADY_FRIENDS'; message: string }
  | { ok: false; error: 'REQUEST_ALREADY_SENT'; message: string }
  | { ok: false; error: 'NOT_FOUND'; message: string }
  | { ok: false; error: 'NO_ACTIVE_RELATION'; message: string }
  | { ok: false; error: 'FRIEND_LIMIT_REACHED'; message: string };

/** Đếm số bạn bè ACCEPTED hiện tại của 1 agent (cả 2 chiều fromAgentId/toAgentId — 1 hàng ACCEPTED = 1 bạn). */
async function countAcceptedFriends(db: Db, agentId: number): Promise<number> {
  return db.friendRequest.count({ where: { status: 'ACCEPTED', OR: [{ fromAgentId: agentId }, { toAgentId: agentId }] } });
}

export interface FriendRequestDto {
  id: number;
  fromAgentId: number;
  toAgentId: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  acceptedAt: Date | null;
}

function toDto(row: {
  id: number;
  fromAgentId: number;
  toAgentId: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  acceptedAt: Date | null;
}): FriendRequestDto {
  return {
    id: row.id,
    fromAgentId: row.fromAgentId,
    toAgentId: row.toAgentId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    acceptedAt: row.acceptedAt
  };
}

/** Tìm quan hệ ĐANG SỐNG (PENDING hoặc ACCEPTED) giữa 2 agent, không phân biệt ai gửi trước. */
async function findActiveRelation(db: Db, agentIdA: number, agentIdB: number) {
  return db.friendRequest.findFirst({
    where: {
      status: { in: ['PENDING', 'ACCEPTED'] },
      OR: [
        { fromAgentId: agentIdA, toAgentId: agentIdB },
        { fromAgentId: agentIdB, toAgentId: agentIdA }
      ]
    }
  });
}

/** Tìm quan hệ ĐÃ LÀ BẠN BÈ (ACCEPTED) giữa 2 agent — biệt danh/chặn CHỈ áp dụng cho bạn bè thật, KHÔNG áp
 * cho PENDING (chưa là bạn thì chưa có gì để đặt biệt danh/chặn — dùng unfriend/reject cho lời mời). */
async function findAcceptedRelation(db: Db, agentIdA: number, agentIdB: number) {
  return db.friendRequest.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [
        { fromAgentId: agentIdA, toAgentId: agentIdB },
        { fromAgentId: agentIdB, toAgentId: agentIdA }
      ]
    }
  });
}

/** POST /v1/me/friends/request — meAgentId gửi lời mời tới toAgentId. */
export async function sendFriendRequest(
  db: Db,
  meAgentId: number,
  toAgentId: number
): Promise<{ ok: true; data: FriendRequestDto; autoAccepted: boolean } | FriendServiceError> {
  if (!Number.isInteger(toAgentId) || toAgentId <= 0) {
    return { ok: false, error: 'VALIDATION', message: 'toAgentId phải là số nguyên dương.' };
  }
  if (toAgentId === meAgentId) {
    return { ok: false, error: 'SELF_FRIEND_REQUEST', message: 'Không thể tự kết bạn với chính mình.' };
  }
  const target = await db.agent.findFirst({ where: { id: toAgentId, deletedAt: null } });
  // Bot SigMa (code=SIGMA_BOT) coi như KHÔNG tồn tại ở luồng kết bạn — không được gửi lời mời tới bot hệ thống.
  if (!target || isAlphaBot(target)) {
    return { ok: false, error: 'AGENT_NOT_FOUND', message: `Đại lý id=${toAgentId} không tồn tại.` };
  }

  const existing = await findActiveRelation(db, meAgentId, toAgentId);
  if (existing) {
    if (existing.status === 'ACCEPTED') {
      return { ok: false, error: 'ALREADY_FRIENDS', message: 'Hai bên đã là bạn bè.' };
    }
    // existing.status === 'PENDING'
    if (existing.fromAgentId === meAgentId) {
      return { ok: false, error: 'REQUEST_ALREADY_SENT', message: 'Bạn đã gửi lời mời kết bạn tới người này rồi, đang chờ trả lời.' };
    }
    // Chiều ngược lại — người kia đã mời mình trước → tự động chấp nhận (xem quyết định thiết kế #2 đầu
    // file). Đây LÀ hành động tạo ra 1 quan hệ ACCEPTED thật → kiểm tra giới hạn 2000 CẢ 2 BÊN (quyết định
    // thiết kế #3): mình (meAgentId) VÀ người gửi lời mời gốc (existing.fromAgentId).
    const [myCount, otherCount] = await Promise.all([countAcceptedFriends(db, meAgentId), countAcceptedFriends(db, existing.fromAgentId)]);
    if (myCount >= FRIEND_LIMIT || otherCount >= FRIEND_LIMIT) {
      return { ok: false, error: 'FRIEND_LIMIT_REACHED', message: `Không thể kết bạn — đã đạt giới hạn tối đa ${FRIEND_LIMIT} bạn bè.` };
    }
    const accepted = await db.friendRequest.update({
      where: { id: existing.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() }
    });
    // Người GỬI lời mời gốc (existing.fromAgentId) được báo "đã chấp nhận" — vì mình vừa gửi ngược lại = auto-accept.
    await pushFriendEvent(db, existing.fromAgentId, meAgentId, 'friend_accept', 'đã chấp nhận lời mời kết bạn');
    // 8/8 — CÙNG người nhận: chuông in-app + WS realtime (đồng bộ đếm mọi nền, xem notifyFriendConnectionEvent). FCM ở trên GIỮ NGUYÊN.
    await notifyFriendConnectionEvent(db, existing.fromAgentId, meAgentId, 'FRIEND_ACCEPT');
    return { ok: true, data: toDto(accepted), autoAccepted: true };
  }

  // Tạo lời mời PENDING mới (CHƯA phải bạn bè) — chỉ kiểm tra giới hạn phía người GỬI (đúng yêu cầu tối
  // thiểu, xem quyết định thiết kế #3): PENDING chưa tính vào số bạn bè của người nhận.
  const myCount = await countAcceptedFriends(db, meAgentId);
  if (myCount >= FRIEND_LIMIT) {
    return { ok: false, error: 'FRIEND_LIMIT_REACHED', message: `Không thể gửi lời mời — bạn đã đạt giới hạn tối đa ${FRIEND_LIMIT} bạn bè.` };
  }

  try {
    const created = await db.friendRequest.create({
      data: { fromAgentId: meAgentId, toAgentId, status: 'PENDING' }
    });
    // Người NHẬN (toAgentId) được báo có lời mời kết bạn mới.
    await pushFriendEvent(db, toAgentId, meAgentId, 'friend_request', 'đã gửi cho bạn lời mời kết bạn');
    // 8/8 — chuông in-app + WS realtime cho người nhận (đồng bộ đếm mọi nền). FCM ở trên GIỮ NGUYÊN.
    await notifyFriendConnectionEvent(db, toAgentId, meAgentId, 'FRIEND_REQUEST');
    return { ok: true, data: toDto(created), autoAccepted: false };
  } catch (err) {
    // TOÀN VẸN GHI (LANE C Vòng 2, 3/8): 2 request "Kết bạn" gần như đồng thời (double-click FE / 2 tab / cùng
    // chiều lẫn ngược chiều) đều vượt qua findActiveRelation() ở trên (chưa thấy hàng sống) rồi CÙNG create —
    // partial unique index `friend_requests_pair_active_uq` chặn hàng thứ 2 ở TẦNG DB (đúng, KHÔNG ghi trùng),
    // nhưng phía thua ném P2002 THÔ ra route → 500 nếu KHÔNG bắt. Đọc lại quan hệ ĐANG SỐNG (bên thắng vừa tạo)
    // rồi trả kết quả nghiệp vụ SẠCH — CÙNG lớp xử lý findOrCreateDirectRoom()/linkTidToRoom().
    if (isUniqueConstraintViolation(err)) {
      const winner = await findActiveRelation(db, meAgentId, toAgentId);
      if (winner) {
        if (winner.status === 'ACCEPTED') {
          return { ok: false, error: 'ALREADY_FRIENDS', message: 'Hai bên đã là bạn bè.' };
        }
        // Còn PENDING (do chính mình vừa gửi ở request song song, HOẶC người kia vừa gửi ngược chiều cùng lúc)
        // → coi như "đã gửi lời mời", KHÔNG tạo thêm hàng. FE refresh sẽ thấy đúng trạng thái (đang chờ /
        // có lời mời đến từ người kia).
        return { ok: false, error: 'REQUEST_ALREADY_SENT', message: 'Đã có lời mời kết bạn đang chờ giữa hai người — không gửi trùng.' };
      }
    }
    throw err;
  }
}

/** POST /v1/me/friends/:requestId/accept — CHỈ người NHẬN lời mời (toAgentId === meAgentId) được chấp nhận. */
export async function acceptFriendRequest(
  db: Db,
  meAgentId: number,
  requestId: number
): Promise<{ ok: true; data: FriendRequestDto } | FriendServiceError> {
  const row = await db.friendRequest.findUnique({ where: { id: requestId } });
  // KHÔNG tiết lộ sự tồn tại của request thuộc người khác — 404 đồng nhất cho "không tồn tại" VÀ "không
  // phải của mình" (cùng nguyên tắc TID_NOT_IN_AGENT_SCOPE/Lô 404 đã áp dụng nơi khác trong routes/me.ts).
  if (!row || row.toAgentId !== meAgentId) {
    return { ok: false, error: 'NOT_FOUND', message: `Lời mời kết bạn id=${requestId} không tồn tại.` };
  }
  if (row.status !== 'PENDING') {
    return { ok: false, error: 'VALIDATION', message: `Lời mời này không còn ở trạng thái chờ (hiện tại: ${row.status}).` };
  }
  // Giới hạn 2000 bạn bè (quyết định thiết kế #3) — kiểm tra CẢ 2 BÊN vì accept tạo quan hệ ACCEPTED cho
  // đồng thời cả người chấp nhận (meAgentId) VÀ người đã gửi lời mời gốc (row.fromAgentId).
  const [myCount, otherCount] = await Promise.all([countAcceptedFriends(db, meAgentId), countAcceptedFriends(db, row.fromAgentId)]);
  if (myCount >= FRIEND_LIMIT || otherCount >= FRIEND_LIMIT) {
    return { ok: false, error: 'FRIEND_LIMIT_REACHED', message: `Không thể chấp nhận — đã đạt giới hạn tối đa ${FRIEND_LIMIT} bạn bè.` };
  }
  const updated = await db.friendRequest.update({ where: { id: requestId }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });
  // Người GỬI lời mời gốc (row.fromAgentId) được báo "đã chấp nhận lời mời kết bạn" (actor = người vừa chấp nhận).
  await pushFriendEvent(db, row.fromAgentId, meAgentId, 'friend_accept', 'đã chấp nhận lời mời kết bạn');
  // 8/8 — chuông in-app + WS realtime cho người gửi lời mời gốc (đồng bộ đếm mọi nền). FCM ở trên GIỮ NGUYÊN.
  await notifyFriendConnectionEvent(db, row.fromAgentId, meAgentId, 'FRIEND_ACCEPT');
  return { ok: true, data: toDto(updated) };
}

/** POST /v1/me/friends/:requestId/reject — CHỈ người NHẬN lời mời được từ chối. */
export async function rejectFriendRequest(
  db: Db,
  meAgentId: number,
  requestId: number
): Promise<{ ok: true; data: FriendRequestDto } | FriendServiceError> {
  const row = await db.friendRequest.findUnique({ where: { id: requestId } });
  if (!row || row.toAgentId !== meAgentId) {
    return { ok: false, error: 'NOT_FOUND', message: `Lời mời kết bạn id=${requestId} không tồn tại.` };
  }
  if (row.status !== 'PENDING') {
    return { ok: false, error: 'VALIDATION', message: `Lời mời này không còn ở trạng thái chờ (hiện tại: ${row.status}).` };
  }
  const updated = await db.friendRequest.update({ where: { id: requestId }, data: { status: 'REJECTED' } });
  return { ok: true, data: toDto(updated) };
}

/** POST /v1/me/friends/:friendAgentId/unfriend — hủy kết bạn (ACCEPTED) HOẶC thu hồi lời mời mình đã gửi
 * (PENDING, fromAgentId === meAgentId) — xem quyết định thiết kế #1 đầu file. KHÔNG cho hủy 1 PENDING mà
 * NGƯỜI KHÁC gửi tới mình (phải dùng reject). */
export async function unfriend(
  db: Db,
  meAgentId: number,
  friendAgentId: number
): Promise<{ ok: true; data: FriendRequestDto } | FriendServiceError> {
  if (!Number.isInteger(friendAgentId) || friendAgentId <= 0) {
    return { ok: false, error: 'VALIDATION', message: 'friendAgentId phải là số nguyên dương.' };
  }
  const relation = await findActiveRelation(db, meAgentId, friendAgentId);
  if (!relation) {
    return { ok: false, error: 'NO_ACTIVE_RELATION', message: 'Không có quan hệ bạn bè/lời mời nào đang hoạt động với người này.' };
  }
  if (relation.status === 'PENDING' && relation.fromAgentId !== meAgentId) {
    // Người kia mời mình, mình không phải người gửi — KHÔNG cho "unfriend" hộ, phải reject.
    return { ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy quan hệ hợp lệ để hủy — dùng chức năng Từ chối cho lời mời đang chờ từ người khác.' };
  }
  const updated = await db.friendRequest.update({ where: { id: relation.id }, data: { status: 'CANCELLED' } });
  return { ok: true, data: toDto(updated) };
}

// ── Biệt danh (25/7, Admin Demo yêu cầu "đặt tên gợi nhớ cho bạn bè") ─────────────────────────────────────────
// Quan hệ 1 CHIỀU tuyệt đối — TÔI đặt biệt danh CHO 1 người bạn, CHỈ TÔI thấy, KHÔNG đổi tên hiển thị thật
// của họ, KHÔNG liên quan gì tới việc họ có đặt biệt danh cho tôi hay không (xem comment schema.prisma).

const NICKNAME_MAX_LENGTH = 50;

export interface FriendNicknameResult {
  friendAgentId: number;
  nickname: string | null;
}

/** POST /v1/me/friends/:friendAgentId/nickname — đặt/xóa biệt danh mà meAgentId đặt CHO friendAgentId.
 * nickname=null → xóa biệt danh (về lại tên thật). CHỈ áp dụng khi 2 bên ĐÃ là bạn bè (ACCEPTED). */
export async function setFriendNickname(
  db: Db,
  meAgentId: number,
  friendAgentId: number,
  nickname: string | null
): Promise<{ ok: true; data: FriendNicknameResult } | FriendServiceError> {
  if (!Number.isInteger(friendAgentId) || friendAgentId <= 0) {
    return { ok: false, error: 'VALIDATION', message: 'friendAgentId phải là số nguyên dương.' };
  }
  let trimmed: string | null = null;
  if (nickname !== null) {
    if (typeof nickname !== 'string') {
      return { ok: false, error: 'VALIDATION', message: 'nickname phải là chuỗi hoặc null.' };
    }
    trimmed = nickname.trim();
    if (trimmed.length === 0) {
      return { ok: false, error: 'VALIDATION', message: 'Biệt danh không được để trống — gửi null để xóa biệt danh.' };
    }
    if (trimmed.length > NICKNAME_MAX_LENGTH) {
      return { ok: false, error: 'VALIDATION', message: `Biệt danh tối đa ${NICKNAME_MAX_LENGTH} ký tự.` };
    }
  }

  const relation = await findAcceptedRelation(db, meAgentId, friendAgentId);
  if (!relation) {
    return { ok: false, error: 'NO_ACTIVE_RELATION', message: 'Không phải bạn bè — không thể đặt biệt danh.' };
  }
  const meIsFrom = relation.fromAgentId === meAgentId;
  await db.friendRequest.update({
    where: { id: relation.id },
    data: meIsFrom ? { nicknameByFrom: trimmed } : { nicknameByTo: trimmed }
  });
  return { ok: true, data: { friendAgentId, nickname: trimmed } };
}

// ── Chặn cuộc gọi/tin nhắn (25/7, Admin Demo yêu cầu) ───────────────────────────────────────────────────────
// 1 CHIỀU tuyệt đối — MÌNH chặn HỌ, KHÔNG phải chặn lẫn nhau. KHÔNG xóa quan hệ bạn bè (status vẫn ACCEPTED),
// chỉ đánh dấu cờ — enforcement thật nằm ở nơi khác đọc field này (xem báo cáo quyết định thiết kế).

export interface FriendBlockResult {
  friendAgentId: number;
  blockedByMe: boolean;
}

async function setFriendBlockFlag(
  db: Db,
  meAgentId: number,
  friendAgentId: number,
  blocked: boolean
): Promise<{ ok: true; data: FriendBlockResult } | FriendServiceError> {
  if (!Number.isInteger(friendAgentId) || friendAgentId <= 0) {
    return { ok: false, error: 'VALIDATION', message: 'friendAgentId phải là số nguyên dương.' };
  }
  const relation = await findAcceptedRelation(db, meAgentId, friendAgentId);
  if (!relation) {
    return { ok: false, error: 'NO_ACTIVE_RELATION', message: 'Không phải bạn bè — không thể chặn.' };
  }
  const meIsFrom = relation.fromAgentId === meAgentId;
  await db.friendRequest.update({
    where: { id: relation.id },
    data: meIsFrom ? { blockedByFrom: blocked } : { blockedByTo: blocked }
  });
  return { ok: true, data: { friendAgentId, blockedByMe: blocked } };
}

/** B44 (28/7, audit độc lập tìm ra — xem BUGS_FIXED.md) — dùng bởi `rc-proxy.ts` để gate `im.create`: generic
 * proxy RC trước đây KHÔNG kiểm bạn bè/chặn gì cả, ai đã đăng nhập cũng gọi thẳng API tạo được phòng DM với
 * BẤT KỲ agent nào. Trả true nếu meAgentId ĐƯỢC PHÉP mở/gửi tin nhắn trực tiếp cho otherAgentId: phải là bạn
 * bè ACCEPTED và KHÔNG bên nào chặn bên kia (cùng ngữ nghĩa `isBlockedForMe` ở ContactsScreen.tsx —
 * `blockedByFrom || blockedByTo`, chặn 1 chiều thì cấm nhắn tin CẢ 2 chiều). Agent không tồn tại/không phải
 * Agent (vd tài khoản RC admin) KHÔNG đi qua hàm này — caller tự quyết định bỏ qua gate khi target không map
 * được sang Agent nào (xem rc-proxy.ts). */
export async function canMessageAgent(db: Db, meAgentId: number, otherAgentId: number): Promise<boolean> {
  if (meAgentId === otherAgentId) return true;
  const relation = await findAcceptedRelation(db, meAgentId, otherAgentId);
  if (!relation) return false;
  if (relation.blockedByFrom || relation.blockedByTo) return false;
  return true;
}

/** POST /v1/me/friends/:friendAgentId/block — meAgentId chặn friendAgentId (voice/video call + nhắn tin,
 * xem enforcement ở routes/me.ts + ContactsScreen.tsx). */
export async function blockFriend(db: Db, meAgentId: number, friendAgentId: number) {
  return setFriendBlockFlag(db, meAgentId, friendAgentId, true);
}

/** POST /v1/me/friends/:friendAgentId/unblock — gỡ chặn. */
export async function unblockFriend(db: Db, meAgentId: number, friendAgentId: number) {
  return setFriendBlockFlag(db, meAgentId, friendAgentId, false);
}

// ── Phân loại bạn bè (31/7, Admin Demo yêu cầu "Gia đình"/"Công việc") ─────────────────────────────────────────
// CÙNG khuôn biệt danh/chặn ở trên — 1 CHIỀU tuyệt đối, MÌNH phân loại 1 người bạn CHO MÌNH, KHÔNG liên quan
// gì tới việc họ phân loại mình là gì (xem comment schema.prisma model FriendRequest categoryByFrom/categoryByTo).

export type FriendCategory = 'FAMILY' | 'WORK' | null;

// SECURITY AUDIT FIX (LOW, phản biện độc lập 31/7) — listFriends() TRƯỚC ĐÂY cast thẳng `raw as FriendCategory`
// khi đọc categoryByFrom/categoryByTo từ DB (cột String tự do, KHÔNG có CHECK constraint) — cast không có
// runtime narrowing, nên nếu sau này có đường ghi khác (backfill/script admin) đưa giá trị lạ vào cột, client
// sẽ âm thầm nhận 1 giá trị sai kiểu TypeScript tưởng là an toàn. Narrow tường minh TRƯỚC khi trả ra — CÙNG
// nguyên tắc "kiểm giá trị, không chỉ tin type system" đã áp dụng ở setFriendCategory() (validate input) và
// assignRoomCategory() (chat-category-service.ts) — giá trị lạ → coi là "chưa phân loại" (null), KHÔNG throw
// (đọc dữ liệu cũ/lạ không nên làm sập cả API danh sách bạn bè).
function toFriendCategory(raw: unknown): FriendCategory {
  return raw === 'FAMILY' || raw === 'WORK' ? raw : null;
}

export interface FriendCategoryResult {
  friendAgentId: number;
  category: FriendCategory;
}

/** POST-ish (route thật là PATCH) /v1/me/friends/:friendAgentId/category — đặt/xóa phân loại MÀ MÌNH gán CHO
 * friendAgentId. category=null → bỏ phân loại (về "Không phân loại"). CHỈ áp dụng khi 2 bên ĐÃ là bạn bè
 * (ACCEPTED) — cùng ràng buộc setFriendNickname/setFriendBlockFlag. */
export async function setFriendCategory(
  db: Db,
  meAgentId: number,
  friendAgentId: number,
  category: FriendCategory
): Promise<{ ok: true; data: FriendCategoryResult } | FriendServiceError> {
  if (!Number.isInteger(friendAgentId) || friendAgentId <= 0) {
    return { ok: false, error: 'VALIDATION', message: 'friendAgentId phải là số nguyên dương.' };
  }
  if (category !== null && category !== 'FAMILY' && category !== 'WORK') {
    return { ok: false, error: 'VALIDATION', message: "category phải là 'FAMILY', 'WORK' hoặc null." };
  }

  const relation = await findAcceptedRelation(db, meAgentId, friendAgentId);
  if (!relation) {
    return { ok: false, error: 'NO_ACTIVE_RELATION', message: 'Không phải bạn bè — không thể phân loại.' };
  }
  const meIsFrom = relation.fromAgentId === meAgentId;
  await db.friendRequest.update({
    where: { id: relation.id },
    data: meIsFrom ? { categoryByFrom: category } : { categoryByTo: category }
  });
  return { ok: true, data: { friendAgentId, category } };
}

export interface AgentLookupResult {
  id: number;
  code: string | null;
  name: string;
}

/** Tra cứu 1 đại lý theo mã CHÍNH XÁC (Agent.code — định danh nghiệp vụ đã dùng khắp nơi, vd
 * /v1/agents/:agentCode/tids) để LÀM CĂN CỨ gửi lời mời kết bạn. QUYẾT ĐỊNH THIẾT KẾ (LEAD tự chọn): đây
 * KHÔNG phải "tìm kiếm Danh bạ nội bộ" đầy đủ (theo tên/email/SĐT, mờ) — mục đó CÒN TREO riêng trong
 * VERSION.md, phạm vi lớn hơn, chưa làm. Đây chỉ là tra cứu CHÍNH XÁC 1 mã, đủ tối thiểu để nút "Kết bạn"
 * hoạt động được (nhập mã đại lý hoặc quét QR cá nhân chứa mã — mục 24), KHÔNG lấn phạm vi search rộng. */
export async function lookupAgentByCode(db: Db, meAgentId: number, code: string): Promise<{ ok: true; data: AgentLookupResult } | FriendServiceError> {
  const trimmed = code.trim();
  if (!trimmed) {
    return { ok: false, error: 'VALIDATION', message: 'Mã đại lý không được để trống.' };
  }
  const agent = await db.agent.findFirst({ where: { code: trimmed, deletedAt: null } });
  // Bot SigMa ẩn khỏi tra cứu — gõ đúng mã 'SIGMA_BOT' cũng coi như không tìm thấy.
  if (!agent || isAlphaBot(agent)) {
    return { ok: false, error: 'AGENT_NOT_FOUND', message: `Không tìm thấy đại lý với mã "${trimmed}".` };
  }
  if (agent.id === meAgentId) {
    return { ok: false, error: 'SELF_FRIEND_REQUEST', message: 'Đây là mã đại lý của chính bạn.' };
  }
  return { ok: true, data: { id: agent.id, code: agent.code, name: agent.name } };
}

/** Tra cứu đại lý theo EMAIL hoặc SĐT — căn cứ tìm bạn THỨ 2 bên cạnh mã đại lý chính xác (lookupAgentByCode
 * ở trên, GIỮ NGUYÊN không đổi), cho trường hợp người dùng không nhớ/không có mã đại lý của bạn mình.
 * QUYẾT ĐỊNH THIẾT KẾ (31/7):
 * - `query` chứa ký tự '@' → coi là EMAIL. `Agent.email` UNIQUE (schema.prisma) → khớp CHÍNH XÁC luôn cho ĐÚNG
 *   0 hoặc 1 kết quả, nên trả 1 object (KHÔNG mảng) HOẶC lỗi AGENT_NOT_FOUND/SELF_FRIEND_REQUEST — CÙNG error
 *   shape lookupAgentByCode (tái dùng, không phát minh union lỗi mới).
 * - Ngược lại coi là SĐT. `Agent.phone` KHÔNG UNIQUE → khớp CHÍNH XÁC có thể ra NHIỀU đại lý, nên trả MẢNG.
 *   Chuẩn hoá bỏ khoảng trắng + gạch ngang TRƯỚC, rồi sinh mọi biến thể tiền tố quốc gia/trung kế hợp lệ
 *   (0xxx/+84xxx/84xxx, xem `buildPhoneSearchVariants()`) rồi so khớp `IN` — B110-tiếp (2/8, Admin Demo yêu cầu
 *   trực tiếp "chuẩn hóa tìm theo số điện thoại") mở rộng thêm phần này, TRƯỚC ĐÂY cố ý chưa làm (ghi rõ ở
 *   B110 là giới hạn đã biết, chờ xác nhận — nay đã xác nhận). Không tìm thấy → mảng RỖNG, KHÔNG lỗi (khác
 *   nhánh email) — SĐT bản chất là "tìm kiếm nhiều kết
 *   quả", rỗng là 1 kết quả hợp lệ, để route/UI tự hiện "không tìm thấy" thay vì bắt buộc xử lý lỗi riêng.
 *   Loại bỏ CHÍNH MÌNH khỏi mảng kết quả (không tự hiện ra để tự kết bạn với bản thân qua nhánh SĐT — nhánh
 *   email đã có lỗi SELF_FRIEND_REQUEST tường minh, nhánh SĐT im lặng lọc ra vì có thể lẫn trong nhiều kết
 *   quả trùng SĐT, báo lỗi cả mảng vì có mặt mình sẽ khó hiểu hơn là chỉ lọc). */
export async function lookupAgentByEmailOrPhone(
  db: Db,
  meAgentId: number,
  query: string
): Promise<{ ok: true; data: AgentLookupResult } | { ok: true; data: AgentLookupResult[] } | FriendServiceError> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { ok: false, error: 'VALIDATION', message: 'Từ khoá tìm kiếm không được để trống.' };
  }

  if (trimmed.includes('@')) {
    // B107-tiếp (2/8, Admin Demo báo trực tiếp "email có chữ viết hoa để tìm không ra chữ thường là lỗi") — TRƯỚC
    // ĐÂY so khớp CHÍNH XÁC phân biệt hoa/thường (`email: trimmed` không có `mode:'insensitive'`). Email chuẩn
    // RFC luôn ASCII (KHÁC lớp lỗi diacritic tiếng Việt đã gặp ở chat-search-service.ts — DB locale "C" chỉ
    // sai fold ký tự CÓ DẤU, ASCII a-z/A-Z fold ĐÚNG bình thường) nên `mode:'insensitive'` (ILIKE) là fix ĐỦ
    // và ĐÚNG ở đây, không cần vòng qua JS như message search.
    const agent = await db.agent.findFirst({ where: { email: { equals: trimmed, mode: 'insensitive' }, deletedAt: null } });
    // Bot SigMa ẩn khỏi tra cứu theo email (không lộ bot hệ thống dù trùng email).
    if (!agent || isAlphaBot(agent)) {
      return { ok: false, error: 'AGENT_NOT_FOUND', message: `Không tìm thấy đại lý với email "${trimmed}".` };
    }
    if (agent.id === meAgentId) {
      return { ok: false, error: 'SELF_FRIEND_REQUEST', message: 'Đây là email của chính bạn.' };
    }
    return { ok: true, data: { id: agent.id, code: agent.code, name: agent.name } };
  }

  // B110-tiếp (2/8, Admin Demo yêu cầu trực tiếp "chuẩn hóa tìm theo số điện thoại") — TRƯỚC ĐÂY chỉ so khớp
  // CHÍNH XÁC 1 chuỗi sau khi bỏ khoảng trắng/gạch ngang — SĐT lưu dạng "0900000000" nhưng tìm bằng
  // "+84981123710" (hoặc ngược lại) sẽ KHÔNG khớp dù CÙNG 1 số thật (giới hạn đã biết, ghi rõ ở B110, giờ
  // chuẩn hoá theo yêu cầu). Tạo mọi BIẾN THỂ hợp lệ của SỐ QUERY (0xxx/+84xxx/84xxx) rồi so khớp `IN` —
  // KHÔNG cần biết DB đang lưu theo dạng nào, KHÔNG cần migration đổi dữ liệu cũ.
  const phoneCandidates = buildPhoneSearchVariants(trimmed);
  const agents = await db.agent.findMany({ where: { phone: { in: phoneCandidates }, deletedAt: null } });
  return {
    ok: true,
    // Lọc CHÍNH MÌNH + bot SigMa khỏi kết quả SĐT (bot không hiện ra để kết bạn). Lọc app-level, KHÔNG SQL.
    data: agents.filter((a) => a.id !== meAgentId && !isAlphaBot(a)).map((a) => ({ id: a.id, code: a.code, name: a.name }))
  };
}

/** Hàm THUẦN (không I/O, test riêng được) — từ 1 chuỗi SĐT người dùng gõ (có thể có khoảng trắng/gạch ngang/
 * tiền tố +84/84/0), trả về DANH SÁCH mọi dạng lưu trữ hợp lệ có thể khớp trong DB (KHÔNG suy đoán chuẩn hoá
 * nào khác ngoài 3 dạng phổ biến thật: "0xxxxxxxxx"/"+84xxxxxxxxx"/"84xxxxxxxxx" — KHÔNG tự đổi số đầu ngoài
 * các tiền tố quốc gia/trung kế đã biết). Luôn bỏ khoảng trắng/gạch ngang trước (giữ hành vi cũ nguyên vẹn). */
export function buildPhoneSearchVariants(rawQuery: string): string[] {
  const cleaned = rawQuery.replace(/[\s-]/g, '');
  let bare = cleaned; // phần số KHÔNG có tiền tố quốc gia/trung kế, vd "981123710".
  if (cleaned.startsWith('+84')) bare = cleaned.slice(3);
  else if (cleaned.startsWith('84') && cleaned.length >= 10) bare = cleaned.slice(2);
  else if (cleaned.startsWith('0')) bare = cleaned.slice(1);
  const variants = new Set([cleaned, `0${bare}`, `+84${bare}`, `84${bare}`]);
  return [...variants];
}

export interface FriendListItem {
  requestId: number;
  agentId: number;
  agentCode: string | null;
  agentName: string;
  acceptedAt: Date | null;
  // Trạng thái online (Admin Demo bổ sung 24/7 — "Online/vừa truy cập/truy cập X trước", nguồn presence RC qua
  // rcUserId từng bạn). CHƯA NỐI THẬT trong đợt này — quyết định ưu tiên rõ ràng của LEAD: gọi RC per-friend
  // (users.info?userId=) đồng bộ trong listFriends() KHÔNG scale khi 1 đại lý có tới 2000 bạn (đúng giới hạn
  // vừa thêm) — sẽ cần N request RC trong 1 lần tải Danh bạ. Cách đúng (RC Realtime API presence subscribe,
  // đã có sẵn hạ tầng DDP WebSocket ở apps/web-demo/src/lib/rc-realtime.ts) nên làm ở FRONTEND (subscribe
  // presence sau khi có danh sách bạn, không phải bot-api gọi REST per-user) — việc này để ĐỢT SAU, hiện trả
  // `null` (chưa biết) chứ KHÔNG suy đoán/giả `false`, tránh hiện sai "offline" cho người đang online thật.
  online: boolean | null;
  // PRESENCE "Hoạt động X phút trước" (6/8, Admin Demo chốt chuẩn Zalo) — mốc hoạt động lần cuối (ISO) để client
  // hiện thời gian khi bạn này OFFLINE. null = đang online (client bỏ qua) HOẶC chưa biết (server vừa restart —
  // presence ephemeral trong RAM). Nguồn: getAgentLastSeen (chat-realtime-hub.ts).
  lastSeenAt: string | null;
  // 25/7 (mục "Lịch" — thông báo sinh nhật bạn bè, kế hoạch curried-plotting-hippo.md): CỘT ĐÃ CÓ SẴN trên
  // Agent (migration `20260724180000_agent_profile_fields`, KHÔNG cần migration mới) — chỉ THÊM vào response
  // đọc-only ở đây, KHÔNG đổi truy vấn `db.agent.findMany` bên dưới (vốn đã lấy nguyên hàng Agent, không có
  // `select` giới hạn cột nào — field này vốn đã nằm sẵn trong `other`, chỉ chưa được map ra DTO).
  dateOfBirth: Date | null;
  // 4/8 (Admin Demo "xem được ngày sinh + GIỚI TÍNH của bạn trong danh bạ") — CÙNG cột Agent.gender đã có sẵn
  // (migration 20260724180000_agent_profile_fields), chỉ map ra DTO đọc-only. "MALE"|"FEMALE"|"OTHER"|null.
  gender: string | null;
  // rcUsername — cần để frontend tạo/lấy phòng chat 1-1 (RC `im.create`) khi gửi tin nhắn chúc mừng sinh
  // nhật tự động. `null` nếu bạn bè đó CHƯA đăng ký/link Rocket.Chat (Agent cũ trước Phase 1 hoặc tạo tay).
  rcUsername: string | null;
  // Biệt danh MÀ MÌNH (meAgentId) đặt CHO người bạn này (đúng chiều, KHÔNG phải biệt danh họ đặt cho mình —
  // xem setFriendNickname). null = chưa đặt, hiện tên thật.
  nickname: string | null;
  // Chặn (25/7) — blockedByMe = MÌNH có chặn người này không (dùng để hiện đúng trạng thái nút "Chặn"/"Bỏ
  // chặn" ở UI). blockedThem = người NÀY có chặn MÌNH không — CHỈ dùng NỘI BỘ để enforce (ẩn/disable nút
  // Nhắn tin/Gọi khi họ đã chặn mình), KHÔNG hiện chi tiết "họ đã chặn bạn" ra UI (xem ContactsScreen.tsx).
  blockedByMe: boolean;
  blockedThem: boolean;
  // Phân loại (31/7) — MÀ MÌNH (meAgentId) gán CHO người bạn này (đúng chiều, KHÔNG phải phân loại họ gán
  // cho mình — xem setFriendCategory). null = chưa phân loại.
  category: FriendCategory;
  // BUG "tài khoản đã xóa vẫn hiện trong danh bạ như bình thường" (5/8, Admin Demo) — true nếu người bạn này đã
  // VÔ HIỆU HÓA (deletionRequestedAt đang chờ xóa HOẶC deletedAt đã xóa, xem isAccountDeactivated()). FE PHẢI:
  // hiện tên = DEACTIVATED_DISPLAY_NAME ("Tài khoản đã bị vô hiệu hóa"), KHÔNG badge "đang hoạt động", KHÔNG mở
  // được khung soạn tin tới họ. Bạn bị xóa CỨNG (agent row biến mất — hiếm) cũng coi là deactivated:true.
  deactivated: boolean;
}
export interface FriendRequestListItem {
  requestId: number;
  agentId: number;
  agentCode: string | null;
  agentName: string;
  createdAt: Date;
}
export interface FriendListResult {
  friends: FriendListItem[];
  incomingRequests: FriendRequestListItem[];
  outgoingRequests: FriendRequestListItem[];
}

/** GET /v1/me/friends — bạn bè (ACCEPTED) + lời mời ĐANG CHỜ gửi đi/nhận về của meAgentId. */
export async function listFriends(db: Db, meAgentId: number): Promise<FriendListResult> {
  const rows = await db.friendRequest.findMany({
    where: {
      status: { in: ['PENDING', 'ACCEPTED'] },
      OR: [{ fromAgentId: meAgentId }, { toAgentId: meAgentId }]
    },
    orderBy: { updatedAt: 'desc' }
  });

  const otherAgentIds = new Set<number>();
  for (const r of rows) otherAgentIds.add(r.fromAgentId === meAgentId ? r.toAgentId : r.fromAgentId);
  const agents = otherAgentIds.size > 0 ? await db.agent.findMany({ where: { id: { in: [...otherAgentIds] } } }) : [];
  const agentById = new Map(agents.map((a) => [a.id, a]));

  const friends: FriendListItem[] = [];
  const incomingRequests: FriendRequestListItem[] = [];
  const outgoingRequests: FriendRequestListItem[] = [];

  for (const r of rows) {
    const otherId = r.fromAgentId === meAgentId ? r.toAgentId : r.fromAgentId;
    const other = agentById.get(otherId);
    // Bot SigMa KHÔNG hiện trong Danh bạ (bạn bè/lời mời đến/đi) — dù (bất thường) có quan hệ với bot. Lọc
    // app-level theo code (KHÔNG SQL 3-trị). Bot vẫn là thành viên phòng chat/tin nhắn (không đụng ở đây).
    if (isAlphaBot(other)) continue;
    // Agent kia có thể đã bị xóa mềm sau khi quan hệ được tạo — vẫn hiện với tên rỗng thay vì làm rớt cả
    // danh sách (findMany where id:in KHÔNG lọc deletedAt để phòng đúng trường hợp này).
    const agentName = other?.name ?? '(đại lý đã bị xóa)';
    const agentCode = other?.code ?? null;

    if (r.status === 'ACCEPTED') {
      const meIsFrom = r.fromAgentId === meAgentId;
      friends.push({
        requestId: r.id,
        agentId: otherId,
        agentCode,
        agentName,
        acceptedAt: r.acceptedAt,
        // BUG#10 (6/8, Admin Demo "danh bạ trạng thái online kiểu Zalo") — presence THẬT (agentPresenceOnline = WS
        // sống HOẶC nhịp sống gần đây, xem chat-realtime-hub.ts) thay vì hard-code null. In-process, O(1) tra Map
        // — KHÔNG gọi RC per-friend. Agent bị vô hiệu hóa hiện offline. Đổi từ agentHasOpenConnection sang
        // agentPresenceOnline (6/8): online = "còn đăng nhập + thiết bị còn kết nối được", KHÔNG chỉ "có WS ngay".
        online: other && !isAccountDeactivated(other) ? agentPresenceOnline(otherId) : false,
        lastSeenAt: (() => {
          const ms = getAgentLastSeen(otherId);
          return ms != null ? new Date(ms).toISOString() : null;
        })(),
        dateOfBirth: other?.dateOfBirth ?? null,
        gender: other?.gender ?? null,
        rcUsername: other?.rcUsername ?? null,
        nickname: meIsFrom ? r.nicknameByFrom : r.nicknameByTo,
        blockedByMe: meIsFrom ? r.blockedByFrom : r.blockedByTo,
        blockedThem: meIsFrom ? r.blockedByTo : r.blockedByFrom,
        category: toFriendCategory(meIsFrom ? r.categoryByFrom : r.categoryByTo),
        // `other` undefined = agent bị xóa CỨNG khỏi DB (findMany id:in không lọc deletedAt nên soft-delete VẪN
        // có `other` với deletedAt set → isAccountDeactivated bắt được; chỉ hard-delete mới thiếu `other`).
        deactivated: other ? isAccountDeactivated(other) : true
      });
    } else if (r.toAgentId === meAgentId) {
      incomingRequests.push({ requestId: r.id, agentId: otherId, agentCode, agentName, createdAt: r.createdAt });
    } else {
      outgoingRequests.push({ requestId: r.id, agentId: otherId, agentCode, agentName, createdAt: r.createdAt });
    }
  }

  return { friends, incomingRequests, outgoingRequests };
}
