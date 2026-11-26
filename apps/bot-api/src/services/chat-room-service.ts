// SIGMA Phase 2 (29/7) — chat lõi tự xây, thay Rocket.Chat (kế hoạch "bỏ hẳn RC"). Quản lý phòng
// (ChatRoom/ChatRoomMember) — DIRECT (1-1) và GROUP. Đặt tên "Chat*" để KHÔNG đụng model `Message` (thư nội
// bộ/thông báo hệ thống) đã có từ trước, khác ngữ nghĩa hoàn toàn.
//
// QUAN TRỌNG — Db ở đây LÀ Prisma client model API bình thường (`db.chatRoom.create(...)`), KHÁC với
// chat-attachment-service.ts (file đó viết TRƯỚC khi bảng `chat_attachments` có model đầy đủ trên client dùng
// chung, nên phải dùng raw SQL). Bảng chat_rooms/chat_room_members/chat_messages/chat_message_reactions được
// tạo CÙNG lúc migration `20260729100000_chat_core` + `prisma generate` lại trong worktree này (đã tự verify
// bằng script gọi `createPrisma()` thật, kiểm `typeof db.chatRoom === 'object'` — KHÔNG suy đoán, xem báo cáo
// build) nên dùng thẳng API model chuẩn, KHÔNG cần raw SQL.
import { Prisma, type Db } from '@sigma/database';
import { fileTypeFromBuffer } from 'file-type';
import { canMessageAgent } from '../friend-service.js';
import { sendPushToAgent } from '../push-notification-service.js';
import { notifyGroupAdded } from '../notification-service.js';
import { postSystemMessage } from './chat-message-service.js';
import { normalizeGroupName } from '../zalo-bill-support.js'; // chuẩn hoá tên nhóm (bỏ dấu/hoa-thường) — 1 nguồn, không tự chế lại

/** Lỗi nghiệp vụ CHUNG cho toàn bộ Phase 2 chat lõi (room/message/reaction) — dùng `code` (string) để route
 * layer (Agent B) map sang HTTP status, CÙNG khuôn `error.code` đã dùng ở device-trust-service.ts/otp-
 * service.ts (không phải discriminated-union `{ok:false,...}` như friend-service.ts — chọn kiểu throw ở ĐÂY
 * vì brief yêu cầu rõ "throw lỗi có code", để route Agent B viết `catch (err) { if (err instanceof
 * ChatServiceError) ... }` gọn hơn phải unwrap `{ok:false}` xuyên suốt nhiều lớp gọi hàm lồng nhau như
 * findOrCreateDirectRoom() gọi canMessageAgent() gọi... ). */
export class ChatServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ChatServiceError';
    this.code = code;
  }
}

export type ChatRoomType = 'DIRECT' | 'GROUP';
export type ChatRoomMemberRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface ChatRoomMemberDto {
  agentId: number;
  role: string;
  joinedAt: Date;
  leftAt: Date | null;
  lastReadMessageId: string | null;
  mutedUntil: Date | null;
  clearedAt: Date | null;
}

export interface ChatRoomWithMembers {
  id: string;
  type: string;
  name: string | null;
  avatarColor: string | null;
  avatarUrl: string | null;
  directPairKey: string | null;
  pinnedMessageId: string | null;
  lastMessageAt: Date | null;
  // debt-chat-gaps (31/7, Việc 4) — "chỉ trưởng/phó nhóm được gửi tin" (xem comment schema.prisma
  // ChatRoom.readOnly + GroupInfoPanel.tsx). Thêm vào DTO chi tiết phòng để FE tự khóa MessageComposer/hiện
  // thông báo cho MEMBER thường mà KHÔNG cần round-trip riêng — sendMessage() (chat-message-service.ts) enforce
  // THẬT ở server, field này CHỈ để UI tự ẩn/khóa trước, cùng nguyên tắc MESSAGE_DELETE_WINDOW_HOURS.
  readOnly: boolean;
  // "nhóm chat đầy đủ như Zalo" (5/8) — cờ duyệt thành viên + giới hạn số thành viên (null = không giới hạn).
  // Trả trong DTO chi tiết để FE hiện đúng trạng thái toggle "Duyệt thành viên" + ô "Giới hạn thành viên" mà
  // không cần round-trip riêng (enforce THẬT ở service: requestJoin/addMember/approveJoin).
  requireApproval: boolean;
  maxMembers: number | null;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
  members: ChatRoomMemberDto[];
}

// RoomDetailDto = ChatRoomWithMembers nguyên vẹn (phòng + đủ danh sách thành viên, kể cả người đã rời —
// route/FE tự lọc leftAt nếu chỉ muốn hiện thành viên đang hoạt động). KHÔNG tạo type riêng trùng lặp field.
export type RoomDetailDto = ChatRoomWithMembers;

export interface RoomSummaryDto {
  id: string;
  type: string;
  name: string | null;
  // QUYẾT ĐỊNH THIẾT KẾ: room-service KHÔNG tự tra cứu tên/avatar Agent đối phương cho phòng DIRECT (giữ
  // service này thuần domain chat, không phụ thuộc chéo sang bảng Agent để "đặt tên hộ") — trả thẳng
  // `otherAgentId` (chỉ có giá trị khi type==='DIRECT') để route/FE tự tra Agent.name/avatar, CÙNG cách
  // friend-service.ts để route tự join tên (xem listFriends()).
  otherAgentId: number | null;
  avatarColor: string | null;
  avatarUrl: string | null;
  pinnedMessageId: string | null;
  lastMessageAt: Date | null;
  lastMessage: { id: string; kind: string; body: string | null; senderId: number | null; createdAt: Date } | null;
  // Đếm SAU thời điểm đọc cuối (lastReadMessageId → createdAt của tin đó, hoặc joinedAt nếu chưa đọc gì) —
  // KHÔNG đếm tin do CHÍNH agentId đó tự gửi (tin mình gửi không bao giờ tính "chưa đọc" của chính mình).
  // Chọn cách này (so với đếm toàn bộ theo 1 con trỏ id tuyến tính) vì đơn giản, đúng ngữ nghĩa "còn bao nhiêu
  // tin MỚI tôi chưa xem kể từ lần đọc trước", và không lệch khi lastReadMessageId trỏ tới 1 tin đã bị xóa mềm
  // (vẫn còn createdAt để so sánh).
  unreadCount: number;
  myRole: string;
  // MENU HỘI THOẠI (7/8) — trạng thái CÁ NHÂN per-agent của phòng (đọc từ hàng ChatRoomMember của chính agent):
  //   muted  — đang tắt thông báo (mutedUntil > now). Client hiện icon chuông gạch + KHÔNG chuông/push (push tắt
  //            ở notifyRoomMembersOfNewMessage, routes/chat.ts) NHƯNG unreadCount VẪN đếm (mute không giấu số).
  //   pinned — đang GHIM hội thoại lên đầu (pinnedAt != null). Phòng ghim sort lên trước (listRoomsForAgent).
  muted: boolean;
  pinned: boolean;
}

function toMemberDto(m: { agentId: number; role: string; joinedAt: Date; leftAt: Date | null; lastReadMessageId: string | null; mutedUntil: Date | null; clearedAt?: Date | null }): ChatRoomMemberDto {
  return {
    agentId: m.agentId,
    role: m.role,
    joinedAt: m.joinedAt,
    leftAt: m.leftAt,
    lastReadMessageId: m.lastReadMessageId,
    mutedUntil: m.mutedUntil,
    clearedAt: m.clearedAt ?? null
  };
}

function toRoomWithMembers(room: {
  id: string;
  type: string;
  name: string | null;
  avatarColor: string | null;
  avatarUrl: string | null;
  directPairKey: string | null;
  pinnedMessageId: string | null;
  lastMessageAt: Date | null;
  readOnly: boolean;
  requireApproval: boolean;
  maxMembers: number | null;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
  members: Array<{ agentId: number; role: string; joinedAt: Date; leftAt: Date | null; lastReadMessageId: string | null; mutedUntil: Date | null }>;
}): ChatRoomWithMembers {
  return {
    id: room.id,
    type: room.type,
    name: room.name,
    avatarColor: room.avatarColor,
    avatarUrl: room.avatarUrl,
    directPairKey: room.directPairKey,
    pinnedMessageId: room.pinnedMessageId,
    lastMessageAt: room.lastMessageAt,
    readOnly: room.readOnly,
    requireApproval: room.requireApproval,
    maxMembers: room.maxMembers,
    createdBy: room.createdBy,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    members: room.members.map(toMemberDto)
  };
}

function directPairKeyOf(a: number, b: number): string {
  return `${Math.min(a, b)}-${Math.max(a, b)}`;
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Audit độc lập ĐỢT 2 (29/7, MEDIUM): `ChatRoomMember` KHÔNG có `@relation` Prisma tới `Agent` (đúng convention
 * bolt-on table — xem comment đầu file), nên KHÔNG lọc được "Agent còn sống" ngay trong 1 query join. Helper
 * này truy 2 bước: lấy `agentIds` ứng viên → lọc lại qua bảng `Agent` (`deletedAt: null`) → trả Set id còn
 * sống. Dùng ở MỌI chỗ đếm/chọn "thành viên khác" có ý nghĩa nghiệp vụ thật (chặn OWNER rời/chọn người kế
 * nhiệm/đổi vai trò) — KHÔNG dùng cho các chỗ chỉ hiển thị (assertActiveMember gốc không đổi, tránh query thêm
 * không cần thiết cho đường đọc tin nhắn tần suất cao). */
async function aliveAgentIds(db: Db, agentIds: number[]): Promise<Set<number>> {
  if (agentIds.length === 0) return new Set();
  const rows = await db.agent.findMany({ where: { id: { in: agentIds }, deletedAt: null }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/** POST tương đương /v1/chat/rooms/direct — tìm HOẶC tạo phòng DIRECT giữa meAgentId và otherAgentId. PHẢI
 * kiểm bạn bè/chặn qua `canMessageAgent()` (friend-service.ts — KHÔNG viết lại logic bạn bè) TRƯỚC khi tạo mới
 * (không kiểm lại nếu phòng ĐÃ tồn tại — 2 người từng là bạn rồi hủy kết bạn vẫn được xem lại lịch sử phòng cũ,
 * chỉ CẤM tạo phòng MỚI khi không đủ điều kiện, giống hành vi "vẫn thấy khung chat cũ nhưng không gửi được tin
 * mới nếu đã bị chặn" phổ biến ở các app chat — enforcement gửi tin mới lại nằm ở sendMessage(), KHÔNG lặp lại
 * kiểm tra bạn bè ở đây theo đúng nguyên tắc DRY chỉ 1 nguồn logic). */
export async function findOrCreateDirectRoom(db: Db, meAgentId: number, otherAgentId: number): Promise<ChatRoomWithMembers> {
  if (!Number.isInteger(meAgentId) || !Number.isInteger(otherAgentId) || meAgentId <= 0 || otherAgentId <= 0) {
    throw new ChatServiceError('VALIDATION', 'meAgentId/otherAgentId phải là số nguyên dương.');
  }
  if (meAgentId === otherAgentId) {
    throw new ChatServiceError('VALIDATION', 'Không thể tự tạo phòng chat trực tiếp với chính mình.');
  }

  const pairKey = directPairKeyOf(meAgentId, otherAgentId);

  const existing = await db.chatRoom.findFirst({
    where: { type: 'DIRECT', directPairKey: pairKey, deletedAt: null },
    include: { members: true }
  });
  if (existing) {
    // KHÔI PHỤC KHI NHẮN LẠI kiểu Zalo (7/8, Admin Demo "xóa hội thoại rồi Nhắn tin lại không ra trò chuyện") —
    // GỐC: "Xóa hội thoại" (setRoomRemoved) đặt removedAt (và có thể hiddenAt) trên membership của mình → phòng
    // bị ẩn khỏi danh sách. Trước đây findOrCreateDirectRoom trả NGUYÊN trạng → mở lại vẫn removed, không thấy
    // trò chuyện. FIX: bấm "Nhắn tin" người đó = Ý ĐỊNH mở lại → XOÁ removedAt + hiddenAt cho CHÍNH meAgentId
    // (chỉ khi đang bị set → tránh ghi thừa) rồi trả phòng đã khôi phục. Không đụng membership của người kia.
    const mine = existing.members.find((m) => m.agentId === meAgentId);
    if (mine && (mine.removedAt != null || mine.hiddenAt != null)) {
      await db.chatRoomMember.updateMany({ where: { roomId: existing.id, agentId: meAgentId }, data: { removedAt: null, hiddenAt: null } });
      const refreshed = await db.chatRoom.findFirst({ where: { id: existing.id }, include: { members: true } });
      if (refreshed) return toRoomWithMembers(refreshed);
    }
    return toRoomWithMembers(existing);
  }

  // CHỈ kiểm bạn bè/chặn khi THỰC SỰ sắp tạo phòng mới (đúng comment trên đầu hàm).
  const allowed = await canMessageAgent(db, meAgentId, otherAgentId);
  if (!allowed) {
    throw new ChatServiceError('CANNOT_MESSAGE', 'Không thể nhắn tin — 2 bên chưa là bạn bè hoặc đã chặn nhau.');
  }

  try {
    const created = await db.chatRoom.create({
      data: {
        type: 'DIRECT',
        directPairKey: pairKey,
        createdBy: meAgentId,
        members: {
          create: [
            { agentId: meAgentId, role: 'MEMBER' },
            { agentId: otherAgentId, role: 'MEMBER' }
          ]
        }
      },
      include: { members: true }
    });
    return toRoomWithMembers(created);
  } catch (err) {
    // Race: 2 request tạo phòng DIRECT cùng cặp agent gần như đồng thời (vd double-click "Nhắn tin" ở FE) —
    // UNIQUE INDEX có điều kiện (chat_rooms_direct_pair_key_unique, xem migration) chặn hàng 2 ở tầng DB, request
    // thua cuộc vào đây đọc lại phòng request kia vừa tạo xong thay vì trả lỗi 500 cho người dùng.
    if (isUniqueConstraintViolation(err)) {
      const raceWinner = await db.chatRoom.findFirst({
        where: { type: 'DIRECT', directPairKey: pairKey, deletedAt: null },
        include: { members: true }
      });
      if (raceWinner) return toRoomWithMembers(raceWinner);
    }
    throw err;
  }
}

/** POST tương đương /v1/chat/rooms/group — tạo phòng nhóm, creator tự động OWNER. */
export async function createGroupRoom(db: Db, creatorAgentId: number, name: string, memberAgentIds: number[]): Promise<ChatRoomWithMembers> {
  if (!Number.isInteger(creatorAgentId) || creatorAgentId <= 0) {
    throw new ChatServiceError('VALIDATION', 'creatorAgentId phải là số nguyên dương.');
  }
  const trimmedName = (name ?? '').trim();
  if (!trimmedName) {
    throw new ChatServiceError('VALIDATION', 'Tên nhóm không được để trống.');
  }
  if (!Array.isArray(memberAgentIds) || memberAgentIds.length === 0) {
    throw new ChatServiceError('VALIDATION', 'Danh sách thành viên (memberAgentIds) không được rỗng.');
  }
  const invalid = memberAgentIds.find((id) => !Number.isInteger(id) || id <= 0);
  if (invalid !== undefined) {
    throw new ChatServiceError('VALIDATION', `memberAgentIds chứa giá trị không hợp lệ: ${invalid}.`);
  }
  // Loại trùng + loại chính creator khỏi danh sách "members thường" (creator luôn được thêm riêng làm OWNER,
  // tránh tạo 2 hàng ChatRoomMember cho cùng 1 agent nếu FE lỡ gửi creator trong memberAgentIds).
  const distinctMembers = [...new Set(memberAgentIds)].filter((id) => id !== creatorAgentId);

  // Admin Demo chốt 29/7: "phải thêm thành viên thứ 3 mới được coi là nhóm chat" — 1 phòng GROUP PHẢI có ÍT NHẤT
  // 3 người (creator + tối thiểu 2 người khác, SAU khi đã loại trùng/loại chính creator ở trên). Creator + ĐÚNG
  // 1 người khác về bản chất là chat 1-1 (đã có findOrCreateDirectRoom riêng cho trường hợp đó) — KHÔNG cho tạo
  // "nhóm" 2 người để tránh trùng khái niệm/2 loại phòng cùng biểu diễn 1 cuộc trò chuyện.
  if (distinctMembers.length < 2) {
    throw new ChatServiceError('VALIDATION', 'Nhóm chat cần ít nhất 3 người (bạn + tối thiểu 2 thành viên khác) — chat với đúng 1 người hãy dùng nhắn tin 1-1.');
  }

  // [Admin Demo 9/9 — GATE "sao lại có 2 nhóm Khach Demo SG?"] TRÙNG NHÓM là lỗi TIỀN, không phải lỗi thẩm mỹ: đại lý có
  // 2 nhóm thì bot gắn khách + gửi bill vào nhóm A, người lại ngồi nhóm B ⇒ bill "gửi thành công" mà KHÔNG AI THẤY
  // (ca Khach Demo 8-9/9). Bằng chứng thật: "ĐL- Hà Khach Demo SG" bị tạo 2 lần cách nhau 29 GIÂY (26/8 01:11:45 và
  // 01:12:14) — bấm tạo 2 lần; cộng thêm 1 nhóm tên lệch dấu/thiếu chữ tạo tay hôm trước. "ĐL - Quỳnh SG" cũng bị
  // tạo 2 lần cách 1 phút (1/9). CHẶN NGAY tại nguồn: tên nhóm SAU CHUẨN HOÁ (bỏ dấu/hoa-thường/ký tự trang trí)
  // trùng nhóm còn sống ⇒ từ chối, chỉ rõ nhóm đã có để người dùng vào đúng nhóm đó.
  // Phạm vi gate: NHÓM ĐẠI LÝ (tên bắt đầu "ĐL…") — đây là nhóm gắn khách/nhận bill nên trùng là mất tiền. Nhóm
  // nội bộ/nhóm chat thường trùng tên không gây hại nên KHÔNG chặn (tránh chặn oan việc dùng hằng ngày).
  const tenChuan = normalizeGroupName(trimmedName);
  if (tenChuan.startsWith('DL ') || tenChuan.startsWith('DL-')) {
    const dsGroup = await db.chatRoom.findMany({ where: { type: 'GROUP', deletedAt: null }, select: { id: true, name: true, createdAt: true } });
    const trung = dsGroup.find((g) => normalizeGroupName(g.name ?? '') === tenChuan);
    if (trung) {
      throw new ChatServiceError(
        'DUPLICATE_GROUP_NAME',
        `Đã có nhóm "${trung.name}" (tạo ${trung.createdAt.toLocaleString('vi-VN')}) — dùng nhóm đó, đừng tạo nhóm thứ 2 cùng đại lý (bill/doanh số sẽ rơi vào nhóm không ai đọc).`
      );
    }
  }

  // Admin Demo chốt 29/7: mời vào NHÓM cũng áp gate chặn/bạn bè giống nhắn 1-1 — đã chặn nhau thì không mời được
  // vào nhóm (trước đó chỉ áp cho DIRECT, đây là lỗ hổng audit độc lập nêu — bịt luôn theo quyết định thật).
  for (const memberId of distinctMembers) {
    const allowed = await canMessageAgent(db, creatorAgentId, memberId);
    if (!allowed) {
      throw new ChatServiceError('CANNOT_MESSAGE', `Không thể mời agent id=${memberId} vào nhóm — chưa là bạn bè hoặc đã chặn nhau.`);
    }
  }

  const created = await db.chatRoom.create({
    data: {
      type: 'GROUP',
      name: trimmedName,
      createdBy: creatorAgentId,
      members: {
        create: [
          { agentId: creatorAgentId, role: 'OWNER' },
          ...distinctMembers.map((agentId) => ({ agentId, role: 'MEMBER' as const }))
        ]
      }
    },
    include: { members: true }
  });
  // #17 (Admin Demo 8/8 "push được thêm vào nhóm") — báo FCM cho MỌI thành viên được thêm lúc TẠO nhóm (creator đã
  // loại). Best-effort THUẦN: KHÔNG throw ra luồng (nhóm đã tạo là chính). kind:'group_added'+roomId để deep-link.
  try {
    const creator = await db.agent.findUnique({ where: { id: creatorAgentId }, select: { name: true } });
    const actorName = creator?.name || 'Một người';
    await Promise.all(
      distinctMembers.map((memberId) =>
        sendPushToAgent(db, memberId, {
          title: trimmedName,
          body: `${actorName} đã thêm bạn vào nhóm`,
          data: { kind: 'group_added', roomId: created.id },
          priority: 'high'
        })
      )
    );
  } catch (err) {
    console.error('[bot-api] chat-room-service: push tạo nhóm thất bại (best-effort):', err);
  }
  // 8/8 (Admin Demo "đồng bộ mọi push event số đếm") — chuông IN-APP + WS realtime GROUP_ADDED cho MỖI thành viên được
  // thêm lúc tạo nhóm (song song FCM ở trên). Helper best-effort THUẦN (không throw). Chuông đếm đồng bộ web/exe/apk
  // như sự kiện Nhật ký; postId=roomId để click mở đúng nhóm.
  for (const memberId of distinctMembers) {
    await notifyGroupAdded(db, memberId, creatorAgentId, created.id);
  }
  // #33 — tin HỆ THỐNG "X đã tạo nhóm" mở đầu lịch sử nhóm (lưu vĩnh viễn, kiểu Zalo). Best-effort.
  try {
    const creator = await db.agent.findUnique({ where: { id: creatorAgentId }, select: { name: true } });
    await postSystemMessage(db, created.id, `${creator?.name || 'Một người'} đã tạo nhóm "${trimmedName}"`);
  } catch (err) {
    console.error('[bot-api] chat-room-service: tin hệ thống tạo nhóm thất bại (best-effort):', err);
  }
  return toRoomWithMembers(created);
}

/** B83 (31/7, tối ưu N+1 listRoomsForAgent — ĐỢT 2 sau khi tự đo THẬT phát hiện Promise.all() N câu
 * `chatMessage.count` riêng lẻ CHẬM HƠN bản tuần tự cũ trên benchmark local, xem BUGS_FIXED.md B83 "phát hiện
 * phụ"): thay N câu `chatMessage.count` (dù chạy song song qua Promise.all vẫn là N round-trip, chỉ khác thứ
 * tự) bằng ĐÚNG 1 câu raw SQL `GROUP BY` duy nhất cho TOÀN BỘ phòng — mỗi phòng có "ngưỡng since" (sinceDate)
 * KHÁC NHAU nên không viết được bằng Prisma model API thường (`count` không có "so sánh theo nhóm"), dùng
 * `VALUES (...)` làm bảng tạm ánh xạ room_id→since_at rồi LEFT JOIN + GROUP BY.
 *
 * Ngữ nghĩa `sender_id != ${agentId}` PHẢI khớp CHÍNH XÁC hành vi cũ `senderId: { not: agentId }` của Prisma
 * (không suy đoán, đúng CẤM SUY LUẬN) — đã kiểm THỰC NGHIỆM (script tạm, xem báo cáo build B83): Prisma dịch
 * `not:` trên cột nullable thành so sánh KHÔNG null-safe (tương đương `!=` thường của Postgres) — 1 tin
 * `senderId=null` (tin hệ thống) bị LOẠI khỏi kết quả count, KHÔNG được coi là "khác agentId". Dùng thẳng
 * `!=` (KHÔNG phải `IS DISTINCT FROM`) ở đây tự nhiên tái tạo đúng hành vi đó (Postgres `!=` với NULL luôn cho
 * UNKNOWN → hàng bị loại khỏi WHERE, giống Prisma).
 *
 * LEFT JOIN (không INNER JOIN) đảm bảo MỌI phòng trong danh sách đều có 1 hàng kết quả (kể cả 0 tin chưa đọc)
 * — nếu dùng INNER JOIN, phòng không có tin nào khớp điều kiện sẽ KHÔNG xuất hiện trong kết quả, caller phải
 * tự nhớ mặc định 0 cho phòng thiếu key (đã làm — `?? 0` ở listRoomsForAgent — nhưng LEFT JOIN + COUNT an toàn
 * hơn, không phụ thuộc caller nhớ đúng). */
interface UnreadCountRawRow {
  room_id: string;
  cnt: number;
}

// FIX unread-tuple (12/8) — con trỏ "đã đọc" là TUPLE `(createdAt, id)` (đúng tie-break `ORDER BY created_at
// DESC, id DESC` mà lastMessagesForRooms()/markAllRead() dùng — cuid mới hơn thắng khi cùng millisecond), KHÔNG
// PHẢI chỉ `createdAt`. Bản cũ đếm `m.created_at > since_at` (chỉ so createdAt) → tin CÙNG millisecond với tin-
// đã-đọc-cuối nhưng `id > lastReadId` (mới hơn theo tie-break, ĐÁNG LẼ chưa đọc) bị BỎ SÓT → badge undercount/
// kẹt 0. Sửa: so THEO TUPLE `(created_at > since) OR (created_at = since AND id > lastReadId)`. `lastReadId` CHỈ
// có ý nghĩa khi since_at LẤY THẬT từ createdAt của tin đó (sinceDatesForMemberships trả null khi fallback
// joinedAt / tin đã xóa cứng / clearedAt ghi đè since — lúc đó `last_read_id IS NOT NULL` sai → nhánh tuple tắt,
// GIỮ NGUYÊN ngữ nghĩa `> since` cũ). So `m.id > last_read_id` dùng ĐÚNG collation text mà tie-break id DESC dùng.
async function unreadCountsForRooms(
  db: Db,
  agentId: number,
  roomSinceDates: Array<{ roomId: string; sinceDate: Date; lastReadId: string | null }>
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (roomSinceDates.length === 0) return counts;

  const valueRows = roomSinceDates.map(({ roomId, sinceDate, lastReadId }) => Prisma.sql`(${roomId}::text, ${sinceDate}::timestamptz, ${lastReadId}::text)`);
  const rows = await db.$queryRaw<UnreadCountRawRow[]>`
    SELECT since.room_id AS room_id, COUNT(m.id)::int AS cnt
    FROM (VALUES ${Prisma.join(valueRows)}) AS since(room_id, since_at, last_read_id)
    LEFT JOIN chat_messages m
      ON m.room_id = since.room_id
      AND (
        m.created_at > since.since_at
        OR (m.created_at = since.since_at AND since.last_read_id IS NOT NULL AND m.id > since.last_read_id)
      )
      AND m.sender_id != ${agentId}
      AND m.deleted_at IS NULL
    GROUP BY since.room_id
  `;
  for (const r of rows) counts.set(r.room_id, Number(r.cnt));
  return counts;
}

/** APK badge cộng/trừ dồn (7/8, Admin Demo "cộng dồn và trừ dồn ở icon phải đúng") — đếm SỐ tin CHƯA ĐỌC của 1
 * recipient trong 1 phòng NGAY SAU khi có tin mới, để đính vào payload FCM (`unreadCount`) → native
 * setNumber(count) cho badge launcher khớp tổng chưa đọc (không chỉ +1/đè). "since" = createdAt của
 * lastReadMessageId (fallback joinedAt nếu chưa đọc gì / lastRead trỏ tin đã xóa) — CÙNG ngữ nghĩa
 * unreadCountsForRooms/sinceDatesForMemberships ở trên. Đếm tin sau `since`, KHÔNG tính tin của chính recipient,
 * bỏ tin đã xóa mềm. Best-effort ở caller (push là UX phụ) — hàm này chỉ đọc, không ghi. */
export async function countUnreadForRoomMember(
  db: Db,
  roomId: string,
  member: { agentId: number; lastReadMessageId: string | null; joinedAt: Date; clearedAt?: Date | null }
): Promise<number> {
  let since: Date = member.joinedAt;
  // FIX unread-tuple (12/8) — con trỏ đọc là TUPLE (createdAt,id): giữ lastReadId để đếm THÊM tin cùng
  // millisecond với tin-đã-đọc-cuối nhưng id lớn hơn (mới hơn theo tie-break) — nếu chỉ so `createdAt > since`
  // sẽ SÓT chúng → badge APK/FCM undercount/kẹt. lastReadId CHỈ hợp lệ khi since LẤY THẬT từ createdAt tin đó
  // VÀ không bị clearedAt ghi đè (mốc clearedAt không có id tin để tie-break).
  let sinceMessageId: string | null = null;
  if (member.lastReadMessageId) {
    const row = await db.chatMessage.findUnique({ where: { id: member.lastReadMessageId }, select: { createdAt: true } });
    if (row) {
      since = row.createdAt;
      sinceMessageId = member.lastReadMessageId;
    }
  }
  // XÓA HỘI THOẠI kiểu Zalo (7/8) — không đếm tin trước clearedAt (đã xóa lịch sử phía mình).
  if (member.clearedAt && member.clearedAt.getTime() > since.getTime()) {
    since = member.clearedAt;
    sinceMessageId = null; // mốc so giờ là clearedAt (không phải tin) → tắt nhánh tuple tie-break.
  }
  return db.chatMessage.count({
    where: {
      roomId,
      senderId: { not: member.agentId },
      deletedAt: null,
      ...(sinceMessageId
        ? { OR: [{ createdAt: { gt: since } }, { createdAt: since, id: { gt: sinceMessageId } }] }
        : { createdAt: { gt: since } })
    }
  });
}

/** B83 (31/7, tối ưu N+1 listRoomsForAgent) — thay vì N câu `chatMessage.findUnique` riêng lẻ (1 câu/phòng) để
 * tra `createdAt` của `lastReadMessageId`, gộp lại thành ĐÚNG 1 câu `findMany({id:{in:[...]}})` cho TOÀN BỘ
 * `lastReadMessageId` khác null của mọi membership cùng lúc — rồi tính lại "since" cho từng phòng (fallback
 * `joinedAt` nếu chưa đọc gì HOẶC lastReadMessageId trỏ tới tin đã bị xóa cứng — giữ NGUYÊN hành vi hàm cũ,
 * không đổi ngữ nghĩa). Trả về Map<roomId, sinceDate> vì trong `listRoomsForAgent()` mỗi phòng chỉ xuất hiện
 * ĐÚNG 1 lần cho 1 agentId (bảng ChatRoomMember unique theo [roomId,agentId]) — key theo roomId là đủ, không
 * cần key kép agentId+roomId. */
async function sinceDatesForMemberships(
  db: Db,
  memberships: Array<{ room: { id: string }; joinedAt: Date; lastReadMessageId: string | null; clearedAt?: Date | null }>
): Promise<Map<string, { sinceDate: Date; lastReadId: string | null }>> {
  const lastReadIds = [...new Set(memberships.map((m) => m.lastReadMessageId).filter((id): id is string => id !== null))];
  const lastReadRows =
    lastReadIds.length > 0
      ? await db.chatMessage.findMany({ where: { id: { in: lastReadIds } }, select: { id: true, createdAt: true } })
      : [];
  const createdAtByMessageId = new Map(lastReadRows.map((r) => [r.id, r.createdAt]));

  // FIX unread-tuple (12/8) — trả THÊM `lastReadId` cùng `sinceDate` để unreadCountsForRooms() so tuple
  // `(createdAt,id)`. lastReadId CHỈ set khi sinceDate LẤY THẬT từ createdAt của tin đó (tin còn tồn tại) VÀ
  // KHÔNG bị clearedAt ghi đè (khi clearedAt > createdAt tin, mốc so là clearedAt — KHÔNG có id tin để tie-break).
  const sinceMap = new Map<string, { sinceDate: Date; lastReadId: string | null }>();
  for (const m of memberships) {
    let sinceDate: Date = m.joinedAt;
    let lastReadId: string | null = null;
    if (m.lastReadMessageId) {
      const createdAt = createdAtByMessageId.get(m.lastReadMessageId);
      if (createdAt) {
        sinceDate = createdAt;
        lastReadId = m.lastReadMessageId;
      }
    }
    // XÓA HỘI THOẠI kiểu Zalo (7/8) — không đếm unread tin trước clearedAt (đã xóa lịch sử phía mình).
    if (m.clearedAt && m.clearedAt.getTime() > sinceDate.getTime()) {
      sinceDate = m.clearedAt;
      lastReadId = null; // mốc so giờ là clearedAt (không phải tin) → tắt nhánh tuple tie-break.
    }
    sinceMap.set(m.room.id, { sinceDate, lastReadId });
  }
  return sinceMap;
}

/** B83 (31/7, tối ưu N+1 listRoomsForAgent) — thay vì N câu `chatMessage.findFirst` riêng lẻ (1 câu/phòng) để
 * lấy tin nhắn mới nhất, gộp thành ĐÚNG 1 câu raw SQL cho TOÀN BỘ roomIds cùng lúc lấy "top-1 tin mới nhất mỗi
 * phòng". Trả Map<roomId, row> để tra O(1); phòng không có tin nào (hoặc mọi tin đã xóa mềm) đơn giản KHÔNG có
 * key trong map → caller tự coi là `null`, giữ đúng hành vi cũ (`findFirst` trả `null` khi không khớp).
 *
 * FIX-PERF (4/8) — ĐỔI từ `DISTINCT ON (room_id) ... ORDER BY room_id, created_at DESC, id DESC` sang
 * **CROSS JOIN LATERAL top-1/phòng**. Lý do (ĐO THẬT bằng EXPLAIN ANALYZE, seed 50 phòng × 10k = 500k tin):
 * `DISTINCT ON` buộc Postgres SẮP XẾP TOÀN BỘ tin của mọi phòng trong danh sách rồi mới nhặt hàng đầu mỗi nhóm
 * → `Sort Method: external merge Disk: 28MB`, ~1392ms (tràn đĩa). LATERAL chạy Index Scan `LIMIT 1` cho TỪNG
 * phòng qua index `chat_messages_room_created_id_desc_idx (room_id, created_at DESC, id DESC)` (migration
 * 20260804120000) → Nested Loop 50 lần LIMIT 1, ~2ms (KHÔNG còn Sort/đĩa). Kết quả GIỐNG HỆT `DISTINCT ON`
 * (đã verify EXPLAIN + EXCEPT 2 chiều = 0 khác biệt trên seed 500k, kể cả cạnh "tin mới nhất bị xóa mềm →
 * nhặt tin kế tiếp"). `ORDER BY m.created_at DESC, m.id DESC LIMIT 1` GIỮ NGUYÊN tie-break
 * `[{createdAt:'desc'},{id:'desc'}]` (2 tin cùng millisecond — id cuid mới hơn thắng). VALUES tham số hoá qua
 * `Prisma.join` — CÙNG pattern raw SQL đã dùng ở unreadCountsForRooms() (trên) + chat-attachment-service.ts. */
interface LastMessageRawRow {
  room_id: string;
  id: string;
  kind: string;
  body: string | null;
  sender_id: number | null;
  created_at: Date;
}

async function lastMessagesForRooms(
  db: Db,
  roomIds: string[]
): Promise<Map<string, { id: string; kind: string; body: string | null; senderId: number | null; createdAt: Date }>> {
  const map = new Map<string, { id: string; kind: string; body: string | null; senderId: number | null; createdAt: Date }>();
  if (roomIds.length === 0) return map;

  const roomValues = roomIds.map((id) => Prisma.sql`(${id}::text)`);
  const rows = await db.$queryRaw<LastMessageRawRow[]>`
    SELECT lm.room_id, lm.id, lm.kind, lm.body, lm.sender_id, lm.created_at
    FROM (VALUES ${Prisma.join(roomValues)}) AS rooms(room_id)
    CROSS JOIN LATERAL (
      SELECT m.room_id, m.id, m.kind, m.body, m.sender_id, m.created_at
      FROM chat_messages m
      WHERE m.room_id = rooms.room_id AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    ) lm
  `;
  for (const r of rows) {
    map.set(r.room_id, { id: r.id, kind: r.kind, body: r.body, senderId: r.sender_id, createdAt: r.created_at });
  }
  return map;
}

/** GET tương đương /v1/chat/rooms — danh sách phòng (đang hoạt động, leftAt IS NULL) của 1 agent, kèm tin mới
 * nhất + số chưa đọc, sort lastMessageAt DESC (phòng chưa có tin nào — lastMessageAt null — xuống cuối).
 * `unreadOnly` (Admin Demo chốt 29/7, "lọc tin nhắn chưa đọc như Zalo") — true = CHỈ trả phòng có unreadCount > 0.
 * Lọc SAU KHI tính unreadCount — chấp nhận được vì số phòng 1 agent tham gia luôn nhỏ.
 *
 * B83 (31/7) — TỐI ƯU N+1: bản cũ chạy vòng lặp `for` TUẦN TỰ qua từng phòng, MỖI phòng tự gọi RIÊNG 2-3 câu
 * (findFirst tin cuối + findUnique lastRead + count chưa đọc) → N phòng ra tới 2-3N round-trip DB nối tiếp
 * nhau, gây "load rất lâu" (Admin Demo tự test điện thoại thấy). Bản mới gộp thành ĐÚNG 3 câu truy vấn CỐ ĐỊNH
 * (KHÔNG phụ thuộc N) cho TOÀN BỘ danh sách phòng: (1) `lastMessagesForRooms` — raw SQL DISTINCT ON lấy tin
 * mới nhất mọi phòng; (2) `sinceDatesForMemberships` — 1 câu findMany batch tra createdAt của mọi
 * lastReadMessageId; (3) `unreadCountsForRooms` — raw SQL GROUP BY đếm chưa đọc mọi phòng cùng lúc (đã thử
 * Promise.all() N câu count song song trước — ĐO THẬT thấy CHẬM HƠN bản tuần tự cũ trên benchmark vì pool kết
 * nối `pg` mặc định max=10, N>10 request đồng thời chỉ gây queue/tranh chấp connection, KHÔNG tăng tốc — xem
 * BUGS_FIXED.md B83 "phát hiện phụ". Raw SQL gộp 1 câu GROUP BY loại bỏ HẲN vấn đề này). Giữ NGUYÊN 100% output
 * shape/thứ tự sort/hành vi filter unreadOnly so bản cũ — chỉ đổi CÁCH lấy dữ liệu, không đổi KẾT QUẢ. */
export async function listRoomsForAgent(db: Db, agentId: number, opts: { unreadOnly?: boolean; hiddenOnly?: boolean } = {}): Promise<RoomSummaryDto[]> {
  // PERF (5/8, EDIT AGENT) — CHỈ select đúng cột phòng mà RoomSummaryDto dùng (KHÔNG `include` cả hàng). Trước
  // đây `include: { room: { include: ... } }` kéo TOÀN BỘ cột ChatRoom, KỂ CẢ `avatar_image` BYTEA nặng (ảnh
  // đại diện nhóm upload thật) — bị đọc+truyền rồi VỨT ĐI cho MỖI phòng trong danh sách (summary chỉ cần
  // avatarColor/avatarUrl). Ảnh nhóm có endpoint riêng GET /v1/chat/rooms/:id/avatar tải theo nhu cầu. Danh
  // sách cột dưới = ĐÚNG các field summary đọc (id/type/name/avatarColor/avatarUrl/pinnedMessageId/
  // lastMessageAt) + deletedAt (lọc phòng đã xóa) + members(agentId) cho otherAgentId phòng DIRECT.
  const memberships = await db.chatRoomMember.findMany({
    where: { agentId, leftAt: null },
    include: {
      room: {
        select: {
          id: true,
          type: true,
          name: true,
          avatarColor: true,
          avatarUrl: true,
          pinnedMessageId: true,
          lastMessageAt: true,
          deletedAt: true,
          members: { where: { agentId: { not: agentId } }, select: { agentId: true } }
        }
      }
    }
  });
  // MENU HỘI THOẠI (7/8) — LOẠI phòng đã ẨN (hiddenAt) HOẶC đã XÓA phía mình (removedAt) khỏi danh sách. (removedAt
  // tự được clear khi phòng có tin mới — sendMessage() — nên phòng "xóa" hiện lại tự nhiên khi có tin, kiểu Zalo.)
  // hiddenOnly (7/8) — màn "Trò chuyện đã ẩn" (Cài đặt kiểu Zalo) → CHỈ trả phòng ĐÃ ẨN (hiddenAt != null) để
  // người dùng bỏ ẩn. Mặc định (hiddenOnly=false) → loại phòng ẩn/xóa như danh sách chính. removedAt luôn loại.
  const activeMemberships = memberships.filter(
    (m) => m.room.deletedAt === null && m.removedAt === null &&
      (opts.hiddenOnly ? m.hiddenAt !== null : m.hiddenAt === null)
  );

  const [lastMessages, sinceDates] = await Promise.all([
    lastMessagesForRooms(db, activeMemberships.map((m) => m.room.id)),
    sinceDatesForMemberships(db, activeMemberships)
  ]);
  const unreadCounts = await unreadCountsForRooms(
    db,
    agentId,
    activeMemberships.map((m) => {
      const info = sinceDates.get(m.room.id)!;
      return { roomId: m.room.id, sinceDate: info.sinceDate, lastReadId: info.lastReadId };
    })
  );

  // MENU HỘI THOẠI (7/8) — pinnedAt của CHÍNH agent theo phòng (dùng cho sort ghim-lên-đầu). Đọc từ hàng
  // ChatRoomMember (m.pinnedAt) — `include: { room }` trả kèm mọi cột scalar của membership nên có sẵn, KHÔNG
  // query thêm.
  const pinnedAtByRoom = new Map(activeMemberships.map((m) => [m.room.id, m.pinnedAt]));
  const nowMs = Date.now();

  const summaries: RoomSummaryDto[] = activeMemberships.map((m) => {
    const room = m.room;
    return {
      id: room.id,
      type: room.type,
      name: room.name,
      otherAgentId: room.type === 'DIRECT' ? (room.members[0]?.agentId ?? null) : null,
      avatarColor: room.avatarColor,
      avatarUrl: room.avatarUrl,
      pinnedMessageId: room.pinnedMessageId,
      lastMessageAt: room.lastMessageAt,
      lastMessage: lastMessages.get(room.id) ?? null,
      unreadCount: unreadCounts.get(room.id) ?? 0,
      myRole: m.role,
      // muted = mutedUntil còn hiệu lực (> now); pinned = có ghim hội thoại.
      muted: m.mutedUntil != null && m.mutedUntil.getTime() > nowMs,
      pinned: m.pinnedAt != null
    };
  });

  // Sort JS-side (không dựa vào cú pháp `orderBy: {sort,nulls}` của Prisma cho field nullable — tránh phụ
  // thuộc version cụ thể). MENU HỘI THOẠI (7/8): phòng GHIM (pinnedAt != null) lên đầu — pinnedAt DESC NULLS
  // LAST (ghim gần nhất trước), rồi TRONG cùng nhóm (đều-ghim / đều-không-ghim) mới xét lastMessageAt DESC
  // (null = chưa có tin nào → coi "cũ nhất", xuống cuối nhóm của nó).
  summaries.sort((a, b) => {
    const ap = pinnedAtByRoom.get(a.id) ?? null;
    const bp = pinnedAtByRoom.get(b.id) ?? null;
    if (ap && bp) {
      const d = bp.getTime() - ap.getTime();
      if (d !== 0) return d;
    } else if (ap) {
      return -1; // a ghim, b không → a trước.
    } else if (bp) {
      return 1; // b ghim, a không → b trước.
    }
    return (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0);
  });
  return opts.unreadOnly ? summaries.filter((s) => s.unreadCount > 0) : summaries;
}

/** GET tương đương /v1/chat/rooms/:roomId — chi tiết 1 phòng (kèm đủ member). Throw NOT_MEMBER nếu requester
 * không phải thành viên còn hiệu lực. */
export async function getRoomDetail(db: Db, roomId: string, requesterAgentId: number): Promise<RoomDetailDto> {
  await assertActiveMember(db, roomId, requesterAgentId);
  // PERF (5/8, EDIT AGENT) — select đúng cột toRoomWithMembers() cần (BỎ `avatar_image` BYTEA + các cột không
  // dùng), tránh kéo blob ảnh nhóm mỗi lần MỞ chi tiết phòng. members lấy đủ field toMemberDto() đọc.
  const room = await db.chatRoom.findUnique({
    where: { id: roomId },
    select: {
      id: true,
      type: true,
      name: true,
      avatarColor: true,
      avatarUrl: true,
      directPairKey: true,
      pinnedMessageId: true,
      lastMessageAt: true,
      readOnly: true,
      requireApproval: true,
      maxMembers: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
      members: { select: { agentId: true, role: true, joinedAt: true, leftAt: true, lastReadMessageId: true, mutedUntil: true, clearedAt: true } }
    }
  });
  if (!room || room.deletedAt) {
    // Phòng vừa bị xóa GIỮA lúc assertActiveMember() (đã pass) và findUnique() ở đây (khoảng hở race rất hẹp)
    // — vẫn phải trả lỗi rõ ràng thay vì để `room` null lọt qua toRoomWithMembers() và crash.
    throw new ChatServiceError('NOT_MEMBER', `Phòng id=${roomId} không tồn tại hoặc đã bị xóa.`);
  }
  return toRoomWithMembers(room);
}

/** Helper DÙNG CHUNG (export cho Agent B dùng làm route guard, VÀ dùng nội bộ bởi chat-message-service.ts/
 * chat-reaction-service.ts) — throw ChatServiceError code NOT_MEMBER nếu agentId không phải thành viên phòng
 * roomId, hoặc đã rời (leftAt khác null). Trả về row thành viên nếu hợp lệ (để caller đọc role/lastReadMessageId
 * mà không phải query lại). */
export async function assertActiveMember(db: Db, roomId: string, agentId: number) {
  const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId, agentId } } });
  if (!member || member.leftAt !== null) {
    throw new ChatServiceError('NOT_MEMBER', `Agent id=${agentId} không phải thành viên đang hoạt động của phòng id=${roomId}.`);
  }
  // Audit độc lập 30/7 (LOW — chưa có tính năng xóa/giải tán phòng nào gọi tới lúc audit, nhưng gấp 1 chỗ
  // chặn CHUNG ở đây an toàn hơn phải nhớ thêm ở từng call site tương lai): phòng đã bị xóa mềm KHÔNG còn ai
  // được coi là "thành viên đang hoạt động", dù ChatRoomMember row của họ vẫn leftAt=null.
  const room = await db.chatRoom.findUnique({ where: { id: roomId }, select: { deletedAt: true } });
  if (!room || room.deletedAt !== null) {
    throw new ChatServiceError('NOT_MEMBER', `Phòng id=${roomId} không tồn tại hoặc đã bị xóa.`);
  }
  return member;
}

/** Chỉ OWNER/ADMIN được gọi các thao tác quản trị phòng (thêm/xóa thành viên, đổi vai trò, ghim tin) —
 * QUYẾT ĐỊNH THIẾT KẾ (LEAD tự chọn khi build, brief không nói rõ áp cho addMember/removeMember/pinMessage
 * hay chỉ riêng changeMemberRole — áp DÙNG CHUNG cho cả nhóm thao tác quản trị vì để MEMBER thường thêm/xóa
 * người khác hoặc ghim tin tuỳ ý là lỗ hổng rõ ràng, cùng tinh thần "role cấp phòng thay owner/moderator cứng
 * của RC" đã ghi trong comment schema.prisma — CẦN LEAD REVIEW LẠI, xem báo cáo build). Ngoại lệ: tự rời phòng
 * (removeMember với targetAgentId === requesterAgentId) KHÔNG cần quyền này — ai cũng tự rời được. */
async function assertOwnerOrAdmin(db: Db, roomId: string, agentId: number): Promise<ChatRoomMemberRole> {
  const member = await assertActiveMember(db, roomId, agentId);
  if (member.role !== 'OWNER' && member.role !== 'ADMIN') {
    throw new ChatServiceError('FORBIDDEN_ROLE', 'Chỉ chủ phòng/quản trị viên mới được thực hiện thao tác này.');
  }
  return member.role as ChatRoomMemberRole;
}

/** PHÒNG CẤP-PHẠM-VI-TÀI-CHÍNH (BOT-3/BOT-4): phòng đang gắn với 1 khách qua `customer_chat_groups`
 * (unassignedAt IS NULL). Thành viên active của phòng như thế được agent-tid-scope.ts cấp quyền
 * xem/khớp/báo-giá/tạo-lô TID của khách đó — nên việc VÀO/THÊM người vào phòng loại này = mở rộng phạm vi
 * tài chính, phải siết chặt hơn phòng thường (self-join CẤM auto-add; addMember CHỈ OWNER/ADMIN). */
async function isFinancialScopeRoom(db: Db, roomId: string): Promise<boolean> {
  const link = await db.customerChatGroup.findFirst({ where: { roomId, unassignedAt: null }, select: { id: true } });
  return link !== null;
}

// GIỚI HẠN SỐ THÀNH VIÊN (5/8) — mã lỗi trần đầy khi maxMembers đã đạt (route map → 409 qua statusForCode).
type MembershipTx = Parameters<Parameters<Db['$transaction']>[0]>[0];

/** Khóa hàng phòng (SELECT ... FOR UPDATE) TRONG 1 transaction để serialize mọi thao tác TĂNG số thành viên
 * cùng 1 phòng (chống race 2 người vào cùng lúc vượt trần maxMembers — Postgres read-committed KHÔNG tự chặn
 * việc này nếu chỉ count rồi insert). Trả maxMembers hiện tại (đọc trong khóa). Ném NOT_FOUND nếu phòng
 * không tồn tại/đã xóa mềm. Dùng chung bởi addMember/approveJoin/requestJoin(join thẳng). */
async function lockRoomForMembership(tx: MembershipTx, roomId: string): Promise<{ maxMembers: number | null }> {
  const rows = await tx.$queryRaw<Array<{ id: string; max_members: number | null; deleted_at: Date | null }>>`
    SELECT id, max_members, deleted_at FROM chat_rooms WHERE id = ${roomId} FOR UPDATE
  `;
  const room = rows[0];
  if (!room || room.deleted_at !== null) {
    throw new ChatServiceError('NOT_FOUND', `Phòng id=${roomId} không tồn tại.`);
  }
  return { maxMembers: room.max_members };
}

/** Thêm/tái kích hoạt 1 thành viên bên TRONG transaction đã khóa hàng phòng (lockRoomForMembership gọi TRƯỚC).
 * Idempotent với người ĐANG là thành viên (không tính trần lại). Chỉ kiểm trần khi THỰC SỰ tăng số người
 * (tạo mới HOẶC tái kích hoạt người đã rời — họ quay lại chiếm 1 chỗ). Tái kích hoạt GIỮ NGUYÊN leftAt=null,
 * KHÔNG đổi role cũ (giữ hành vi addMember gốc). */
async function addOrReactivateMemberTx(tx: MembershipTx, roomId: string, newAgentId: number, maxMembers: number | null) {
  const existing = await tx.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId, agentId: newAgentId } } });
  if (existing && existing.leftAt === null) return existing; // đã là thành viên — idempotent, không tính trần.
  if (maxMembers !== null) {
    const activeCount = await tx.chatRoomMember.count({ where: { roomId, leftAt: null } });
    if (activeCount >= maxMembers) {
      throw new ChatServiceError('ROOM_FULL', `Nhóm đã đạt giới hạn ${maxMembers} thành viên — không thể thêm người mới.`);
    }
  }
  if (existing) {
    return tx.chatRoomMember.update({ where: { id: existing.id }, data: { leftAt: null } });
  }
  return tx.chatRoomMember.create({ data: { roomId, agentId: newAgentId, role: 'MEMBER' } });
}

/** Thêm 1 thành viên vào phòng (chỉ OWNER/ADMIN, xem assertOwnerOrAdmin). Nếu agent đó ĐÃ từng là thành viên
 * rồi rời (leftAt khác null) → tái kích hoạt (clear leftAt), KHÔNG tạo hàng mới (unique index roomId+agentId
 * chặn hàng trùng, xem migration). Idempotent nếu đã là thành viên đang hoạt động (không lỗi, trả nguyên trạng).
 * GIỚI HẠN SỐ THÀNH VIÊN (5/8): CHẶN khi số thành viên đang hoạt động đạt maxMembers (transaction + khóa hàng
 * phòng chống race). */
export async function addMember(db: Db, roomId: string, requesterAgentId: number, newAgentId: number) {
  // #29 (Admin Demo 8/8 "thêm mem thì AI CŨNG thêm được") — nới quyền: chỉ cần là THÀNH VIÊN đang hoạt động của
  // nhóm (assertActiveMember) thay vì OWNER/ADMIN. Vẫn giữ gate bạn-bè/chặn (canMessageAgent) + trần thành viên.
  // Kick (removeMember người khác) VẪN chỉ OWNER/ADMIN theo yêu cầu "chỉ trưởng phó mới xóa mem".
  await assertActiveMember(db, roomId, requesterAgentId);
  // BOT-4: phòng gắn khách (customer_chat_groups active) = phòng cấp phạm-vi-tài-chính. KHÔNG cho member thường
  // kéo người ngoài vào (mở rộng ngang phạm vi TID của khách) — CHỈ OWNER/ADMIN mới thêm. Phòng thường giữ nguyên
  // hành vi nới quyền #29. Gate bạn-bè/chặn (canMessageAgent) + trần thành viên bên dưới vẫn áp cho MỌI phòng.
  if (await isFinancialScopeRoom(db, roomId)) {
    await assertOwnerOrAdmin(db, roomId, requesterAgentId);
  }
  if (!Number.isInteger(newAgentId) || newAgentId <= 0) {
    throw new ChatServiceError('VALIDATION', 'newAgentId phải là số nguyên dương.');
  }
  // Admin Demo chốt 29/7 — CÙNG gate với createGroupRoom (xem comment ở đó): người mời (requester) và người được
  // mời phải chưa chặn nhau/đã là bạn bè, KHÔNG chỉ áp lúc TẠO nhóm mà cả lúc THÊM thành viên sau này.
  const allowed = await canMessageAgent(db, requesterAgentId, newAgentId);
  if (!allowed) {
    throw new ChatServiceError('CANNOT_MESSAGE', `Không thể thêm agent id=${newAgentId} vào nhóm — chưa là bạn bè hoặc đã chặn nhau.`);
  }
  const member = await db.$transaction(async (tx) => {
    const { maxMembers } = await lockRoomForMembership(tx, roomId);
    return addOrReactivateMemberTx(tx, roomId, newAgentId, maxMembers);
  });
  // #17 (Admin Demo 8/8 "push được thêm vào nhóm") — báo FCM cho người vừa được thêm. Best-effort THUẦN: KHÔNG throw
  // ra luồng (thành viên đã ghi DB là chính). `kind:'group_added'` + roomId để client deep-link mở đúng nhóm.
  try {
    const [room, actor] = await Promise.all([
      db.chatRoom.findUnique({ where: { id: roomId }, select: { name: true } }),
      db.agent.findUnique({ where: { id: requesterAgentId }, select: { name: true } })
    ]);
    const groupName = room?.name || 'Nhóm chat';
    const actorName = actor?.name || 'Một người';
    await sendPushToAgent(
      db,
      newAgentId,
      { title: groupName, body: `${actorName} đã thêm bạn vào nhóm`, data: { kind: 'group_added', roomId }, priority: 'high' }
    );
  } catch (err) {
    console.error(`[bot-api] chat-room-service: push thêm vào nhóm thất bại roomId=${roomId} newAgentId=${newAgentId} (best-effort):`, err);
  }
  // 8/8 (Admin Demo "đồng bộ mọi push event số đếm") — chuông IN-APP + WS realtime GROUP_ADDED cho người vừa được thêm
  // (song song FCM ở trên). Best-effort THUẦN (không throw). postId=roomId để click mở đúng nhóm.
  await notifyGroupAdded(db, newAgentId, requesterAgentId, roomId);
  // #33 — tin HỆ THỐNG "X đã thêm Y vào nhóm" (lưu vĩnh viễn + realtime, kiểu Zalo). Best-effort.
  try {
    const [actor2, newAgent] = await Promise.all([
      db.agent.findUnique({ where: { id: requesterAgentId }, select: { name: true } }),
      db.agent.findUnique({ where: { id: newAgentId }, select: { name: true } })
    ]);
    await postSystemMessage(db, roomId, `${actor2?.name || 'Một người'} đã thêm ${newAgent?.name || 'một thành viên'} vào nhóm`);
  } catch (err) {
    console.error(`[bot-api] chat-room-service: tin hệ thống thêm thành viên thất bại roomId=${roomId} (best-effort):`, err);
  }
  return toMemberDto(member);
}

/** Xóa mềm 1 thành viên khỏi phòng (set leftAt=now, KHÔNG xóa hàng). Cho phép TỰ rời (targetAgentId ===
 * requesterAgentId) không cần quyền OWNER/ADMIN; xóa NGƯỜI KHÁC bắt buộc requester là OWNER/ADMIN.
 *
 * Admin Demo chốt 29/7 — OWNER KHÔNG được tự rời trực tiếp nếu còn ai khác trong phòng: "phải nhường phó nhóm mới
 * rời đi được" (gọi changeMemberRole(newRole:'OWNER') để chuyển nhượng TRƯỚC — hàm đó tự động hạ requester
 * xuống ADMIN, sau đó gọi lại removeMember bình thường sẽ qua được vì lúc đó role không còn là OWNER nữa).
 * Ngoại lệ: nếu OWNER là người CUỐI CÙNG còn lại trong phòng (không còn ai để nhường) → cho rời, phòng trống.
 * Tài khoản bị XÓA (khác voluntary rời) đi qua autoTransferOwnershipOnDeletion() riêng, KHÔNG qua hàm này. */
export async function removeMember(db: Db, roomId: string, requesterAgentId: number, targetAgentId: number) {
  if (!Number.isInteger(targetAgentId) || targetAgentId <= 0) {
    throw new ChatServiceError('VALIDATION', 'targetAgentId phải là số nguyên dương.');
  }
  let requesterMember: { role: string } | null = null;
  if (requesterAgentId !== targetAgentId) {
    await assertOwnerOrAdmin(db, roomId, requesterAgentId);
  } else {
    requesterMember = await assertActiveMember(db, roomId, requesterAgentId); // vẫn phải đang là thành viên mới "rời" được.
  }
  const target = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId, agentId: targetAgentId } } });
  if (!target || target.leftAt !== null) {
    throw new ChatServiceError('NOT_MEMBER', `Agent id=${targetAgentId} không phải thành viên đang hoạt động của phòng id=${roomId}.`);
  }

  if (requesterAgentId === targetAgentId && requesterMember?.role === 'OWNER') {
    // Audit độc lập ĐỢT 2 (29/7, MEDIUM): PHẢI loại "thành viên ma" (Agent đã bị XÓA TÀI KHOẢN thật nhưng
    // ChatRoomMember row của họ chưa được dọn vì họ không phải OWNER — chỉ autoTransferOwnershipOnDeletion mới
    // dọn phòng nơi agent đó LÀ OWNER, còn phòng nơi họ chỉ là MEMBER/ADMIN thì KHÔNG ai dọn) — nếu không lọc,
    // OWNER bị kẹt vĩnh viễn vì "người khác" duy nhất còn lại đã là tài khoản không tồn tại, không ai transfer
    // được cho 1 Agent đã xóa.
    const otherRows = await db.chatRoomMember.findMany({ where: { roomId, agentId: { not: requesterAgentId }, leftAt: null }, select: { agentId: true } });
    const alive = await aliveAgentIds(db, otherRows.map((r) => r.agentId));
    if (alive.size > 0) {
      throw new ChatServiceError('OWNER_MUST_TRANSFER_FIRST', 'Chủ phòng phải chuyển quyền cho người khác (changeMemberRole → OWNER) trước khi rời phòng.');
    }
  }

  await db.chatRoomMember.update({ where: { id: target.id }, data: { leftAt: new Date() } });
  // #33 — tin HỆ THỐNG: tự rời → "X đã rời nhóm"; bị kick → "Admin đã xóa Y khỏi nhóm" (lưu vĩnh viễn + realtime).
  try {
    if (requesterAgentId === targetAgentId) {
      const a = await db.agent.findUnique({ where: { id: targetAgentId }, select: { name: true } });
      await postSystemMessage(db, roomId, `${a?.name || 'Một thành viên'} đã rời nhóm`);
    } else {
      const [actor, tgt] = await Promise.all([
        db.agent.findUnique({ where: { id: requesterAgentId }, select: { name: true } }),
        db.agent.findUnique({ where: { id: targetAgentId }, select: { name: true } })
      ]);
      await postSystemMessage(db, roomId, `${actor?.name || 'Quản trị viên'} đã xóa ${tgt?.name || 'một thành viên'} khỏi nhóm`);
    }
  } catch (err) {
    console.error(`[bot-api] chat-room-service: tin hệ thống rời/xóa thành viên thất bại roomId=${roomId} (best-effort):`, err);
  }
}

/** Gọi khi 1 Agent bị XÓA TÀI KHOẢN THẬT (deletion-service.ts performAccountDeletion, sau 48h ân hạn) — Admin Demo
 * chốt 29/7 "tài khoản bị xóa tự động nhường" quyền OWNER, KHÁC HẲN nhánh removeMember tự rời ở trên (đòi OWNER
 * tự tay chuyển nhượng trước) — ở đây tài khoản không còn tồn tại để tự tay làm gì, PHẢI tự động. Với MỌI phòng
 * agentId này đang là OWNER còn hoạt động: nếu còn thành viên khác → thăng người ADMIN gia nhập SỚM NHẤT lên
 * OWNER (ưu tiên ADMIN sẵn có, không có ADMIN thì thăng MEMBER gia nhập sớm nhất); nếu phòng chỉ còn mỗi agent
 * này → không có ai để nhường, phòng để trống (cùng hành vi degenerate-case chấp nhận ở removeMember). Best-
 * effort TỪNG phòng độc lập — 1 phòng lỗi không chặn phòng khác/không chặn tiến trình xóa tài khoản. */
export async function autoTransferOwnershipOnDeletion(db: Db, deletedAgentId: number): Promise<void> {
  const ownedRooms = await db.chatRoomMember.findMany({
    where: { agentId: deletedAgentId, role: 'OWNER', leftAt: null },
    select: { roomId: true }
  });

  for (const { roomId } of ownedRooms) {
    try {
      const others = await db.chatRoomMember.findMany({
        where: { roomId, agentId: { not: deletedAgentId }, leftAt: null },
        orderBy: { joinedAt: 'asc' }
      });
      // Audit độc lập ĐỢT 2 (29/7, MEDIUM): loại "thành viên ma" (Agent đã bị xóa nhưng row ChatRoomMember chưa
      // dọn — có thể xảy ra nếu 2 agent trong CÙNG phòng đều bị xóa tài khoản, người xử lý trước không dọn được
      // người kia vì lúc đó họ chưa phải OWNER) — KHÔNG được tự động phong 1 Agent đã xóa làm OWNER mới.
      const alive = await aliveAgentIds(db, others.map((m) => m.agentId));
      const aliveOthers = others.filter((m) => alive.has(m.agentId));
      const successor = aliveOthers.find((m) => m.role === 'ADMIN') ?? aliveOthers[0] ?? null;

      await db.$transaction([
        db.chatRoomMember.update({ where: { roomId_agentId: { roomId, agentId: deletedAgentId } }, data: { leftAt: new Date() } }),
        ...(successor ? [db.chatRoomMember.update({ where: { id: successor.id }, data: { role: 'OWNER' as const } })] : [])
      ]);
    } catch (err) {
      console.error(
        `[chat-room-service] autoTransferOwnershipOnDeletion: lỗi xử lý phòng id=${roomId} cho agent bị xóa id=${deletedAgentId} (best-effort, tiếp tục phòng khác, không chặn xóa tài khoản):`,
        err
      );
    }
  }
}

/** GIẢI TÁN NHÓM (dissolve) — Admin Demo "nhóm chat đầy đủ như Zalo": trưởng nhóm giải tán CẢ nhóm (khác
 * removeMember là tự rời/kick 1 người). CHỈ OWNER được giải tán — ADMIN (phó nhóm) KHÔNG được (gate
 * assertOwnerOrAdmin lấy role rồi chặn thêm requesterRole==='OWNER', đúng brief). CHỈ áp phòng GROUP (DIRECT
 * không có khái niệm "giải tán"). Xóa MỀM phòng (deletedAt=now) — assertActiveMember đã coi phòng deletedAt!=null
 * là không còn (xem ~dòng 620), nên MỌI thành viên tự động mất quyền vào phòng, KHÔNG cần dọn từng
 * ChatRoomMember. Phát tin hệ thống "X đã giải tán nhóm" TRƯỚC khi set deletedAt (postSystemMessage cần phòng
 * còn "sống" để ghi + broadcast; sau khi set deletedAt mọi thao tác gửi tin sẽ bị assertActiveMember từ chối).
 * Broadcast `room-dissolved` để client mọi máy đang mở phòng tự rời — do route layer làm (giữ service thuần DB,
 * CÙNG convention removeMember/updateGroupSettings). Best-effort tin hệ thống (nhóm đã giải tán là chính). */
export async function dissolveRoom(db: Db, roomId: string, requesterAgentId: number): Promise<void> {
  const requesterRole = await assertOwnerOrAdmin(db, roomId, requesterAgentId);
  if (requesterRole !== 'OWNER') {
    throw new ChatServiceError('FORBIDDEN', 'Chỉ trưởng nhóm được giải tán nhóm.');
  }
  const room = await db.chatRoom.findUnique({ where: { id: roomId } });
  if (!room || room.deletedAt) {
    throw new ChatServiceError('NOT_FOUND', `Phòng id=${roomId} không tồn tại.`);
  }
  if (room.type !== 'GROUP') {
    throw new ChatServiceError('VALIDATION', 'Chỉ giải tán được phòng NHÓM (phòng 1-1 không có khái niệm giải tán).');
  }
  // Tin HỆ THỐNG "X đã giải tán nhóm" — phát TRƯỚC khi set deletedAt (postSystemMessage broadcast tin mới; sau
  // set deletedAt thì assertActiveMember trong sendMessage sẽ từ chối). Best-effort: lỗi tin hệ thống KHÔNG
  // chặn việc giải tán (nhóm bị xóa mềm là mục tiêu chính).
  try {
    const actor = await db.agent.findUnique({ where: { id: requesterAgentId }, select: { name: true } });
    await postSystemMessage(db, roomId, `${actor?.name || 'Trưởng nhóm'} đã giải tán nhóm`);
  } catch (err) {
    console.error(`[bot-api] chat-room-service: tin hệ thống giải tán nhóm thất bại roomId=${roomId} (best-effort):`, err);
  }
  await db.chatRoom.update({ where: { id: roomId }, data: { deletedAt: new Date() } });
}

/** Đổi vai trò 1 thành viên (chỉ OWNER/ADMIN được gọi — spec chốt rõ). Ràng buộc THÊM (quyết định thiết kế,
 * cùng tinh thần "chỉ OWNER mới động vào OWNER" phổ biến ở app chat khác): CHỈ chính OWNER hiện tại của phòng
 * mới được đặt ai đó thành OWNER MỚI hoặc đổi vai trò của 1 OWNER khác — ADMIN chỉ đổi qua lại được giữa
 * MEMBER/ADMIN, KHÔNG được tự phong OWNER cho mình/người khác (tránh 1 ADMIN tự leo thang chiếm quyền chủ phòng). */
export async function changeMemberRole(db: Db, roomId: string, requesterAgentId: number, targetAgentId: number, newRole: ChatRoomMemberRole) {
  if (newRole !== 'OWNER' && newRole !== 'ADMIN' && newRole !== 'MEMBER') {
    throw new ChatServiceError('VALIDATION', `newRole không hợp lệ: ${newRole}.`);
  }
  const requesterRole = await assertOwnerOrAdmin(db, roomId, requesterAgentId);
  const target = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId, agentId: targetAgentId } } });
  if (!target || target.leftAt !== null) {
    throw new ChatServiceError('NOT_MEMBER', `Agent id=${targetAgentId} không phải thành viên đang hoạt động của phòng id=${roomId}.`);
  }
  if ((newRole === 'OWNER' || target.role === 'OWNER') && requesterRole !== 'OWNER') {
    throw new ChatServiceError('FORBIDDEN_ROLE', 'Chỉ chủ phòng (OWNER) mới được phong/đổi vai trò của chủ phòng.');
  }
  // Audit độc lập ĐỢT 2 (29/7, MEDIUM): không phong 1 Agent đã bị xóa tài khoản làm OWNER/ADMIN — target row
  // ChatRoomMember có thể "ma" (leftAt null nhưng Agent.deletedAt đã set, xem comment aliveAgentIds() trên).
  if (newRole !== 'MEMBER') {
    const alive = await aliveAgentIds(db, [targetAgentId]);
    if (!alive.has(targetAgentId)) {
      throw new ChatServiceError('NOT_MEMBER', `Agent id=${targetAgentId} đã bị xóa tài khoản, không thể phong vai trò.`);
    }
  }

  // Admin Demo chốt 29/7 — "trưởng nhóm đi phó nhóm làm": OWNER hiện tại phong ai đó thành OWNER MỚI = CHUYỂN
  // NHƯỢNG (không phải "thêm 1 OWNER nữa") — requester cũ TỰ ĐỘNG hạ xuống ADMIN trong CÙNG giao dịch, phòng
  // luôn đúng 1 OWNER duy nhất tại mọi thời điểm. Không áp dụng khi requester tự đổi role của CHÍNH MÌNH (already OWNER->OWNER vô nghĩa, chặn ở validate trên nếu cần).
  if (newRole === 'OWNER' && requesterAgentId !== targetAgentId) {
    // Audit độc lập ĐỢT 2 (29/7, MEDIUM — race 2 chuyển nhượng đồng thời tạo 2 OWNER): BẮT BUỘC dùng
    // transaction DẠNG CALLBACK (không phải mảng — mảng KHÔNG cho phép throw giữa chừng để rollback, mọi câu
    // lệnh trong mảng ĐỀU commit dù câu đầu không khớp gì, chỉ phát hiện SAU KHI đã ghi DB rồi mới throw —
    // KHÔNG ngăn được race thật). Dạng callback: `updateMany` có điều kiện `role:'OWNER'` (compare-and-swap)
    // — nếu requester KHÔNG CÒN là OWNER lúc này (1 request chuyển nhượng KHÁC vừa chạy trước), `count`=0 →
    // throw NGAY, Prisma tự ROLLBACK toàn bộ transaction (câu update target KHÔNG BAO GIỜ được gọi tới) —
    // đảm bảo thật sự KHÔNG BAO GIỜ có 2 OWNER cùng lúc, không chỉ phát hiện sau khi đã xảy ra.
    const updatedTarget = await db.$transaction(async (tx) => {
      const demoteResult = await tx.chatRoomMember.updateMany({ where: { roomId, agentId: requesterAgentId, role: 'OWNER' }, data: { role: 'ADMIN' } });
      if (demoteResult.count !== 1) {
        throw new ChatServiceError('CONFLICT', 'Quyền chủ phòng vừa bị đổi bởi 1 yêu cầu khác — thử lại.');
      }
      return tx.chatRoomMember.update({ where: { id: target.id }, data: { role: 'OWNER' } });
    });
    return toMemberDto(updatedTarget);
  }

  const updated = await db.chatRoomMember.update({ where: { id: target.id }, data: { role: newRole } });
  return toMemberDto(updated);
}

/** Đổi cài đặt nhóm (tên/màu-ảnh đại diện) — Admin Demo chốt 29/7: "chỉ trưởng nhóm, phó nhóm mới có quyền... thao
 * tác cài đặt nhóm như Zalo" — CHỈ OWNER/ADMIN (assertOwnerOrAdmin, CÙNG gate addMember/removeMember/
 * changeMemberRole/pin đã có). CHỈ áp dụng cho phòng GROUP (DIRECT không có "tên nhóm" để đổi — name luôn null
 * theo thiết kế, xem comment ChatRoomWithMembers). Mọi field optional — chỉ đổi field nào client THẬT SỰ gửi
 * (không ghi đè field không gửi thành null/rỗng ngoài ý muốn). */
export async function updateGroupSettings(
  db: Db,
  roomId: string,
  requesterAgentId: number,
  input: { name?: string; avatarColor?: string | null; avatarUrl?: string | null; readOnly?: boolean; requireApproval?: boolean; maxMembers?: number | null }
): Promise<ChatRoomWithMembers> {
  await assertOwnerOrAdmin(db, roomId, requesterAgentId);
  const room = await db.chatRoom.findUnique({ where: { id: roomId } });
  if (!room || room.deletedAt) {
    throw new ChatServiceError('NOT_FOUND', `Phòng id=${roomId} không tồn tại.`);
  }
  if (room.type !== 'GROUP') {
    throw new ChatServiceError('VALIDATION', 'Chỉ đổi được cài đặt cho phòng NHÓM (DIRECT không có tên/đại diện riêng để đổi).');
  }
  // Audit độc lập ĐỢT 2 (29/7, LOW): thiếu giới hạn độ dài — thêm cap nhất quán với MAX_BODY_LENGTH/
  // MAX_EMOJI_CODEPOINTS đã có ở 2 service khác. avatarUrl thêm chặn scheme (chỉ http/https) — phòng ngừa
  // trước khi FE dùng làm `<img src>` (chưa có component nào render field này lúc audit, nhưng phòng sẵn).
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (!trimmed) throw new ChatServiceError('VALIDATION', 'Tên nhóm không được để trống.');
    if (trimmed.length > 100) throw new ChatServiceError('VALIDATION', 'Tên nhóm tối đa 100 ký tự.');
    data.name = trimmed;
  }
  if (input.avatarColor !== undefined) {
    if (input.avatarColor !== null && input.avatarColor.length > 32) {
      throw new ChatServiceError('VALIDATION', 'avatarColor tối đa 32 ký tự.');
    }
    data.avatarColor = input.avatarColor;
  }
  if (input.avatarUrl !== undefined) {
    if (input.avatarUrl !== null) {
      if (input.avatarUrl.length > 2000) throw new ChatServiceError('VALIDATION', 'avatarUrl tối đa 2000 ký tự.');
      if (!/^https?:\/\//i.test(input.avatarUrl)) throw new ChatServiceError('VALIDATION', 'avatarUrl phải bắt đầu bằng http:// hoặc https://.');
    }
    data.avatarUrl = input.avatarUrl;
  }
  // debt-chat-gaps (31/7, Việc 4) — "chỉ trưởng/phó nhóm được gửi tin". Cùng gate assertOwnerOrAdmin() đã gọi ở
  // đầu hàm (KHÔNG thêm gate riêng) — chỉ OWNER/ADMIN mới đổi được cờ này, đúng brief.
  if (input.readOnly !== undefined) {
    data.readOnly = input.readOnly;
  }
  // DUYỆT THÀNH VIÊN (5/8) — bật/tắt cờ yêu cầu duyệt (chỉ OWNER/ADMIN, đã gate ở đầu hàm).
  if (input.requireApproval !== undefined) {
    data.requireApproval = input.requireApproval;
  }
  // GIỚI HẠN SỐ THÀNH VIÊN (5/8) — null = bỏ giới hạn; số nguyên dương = trần. CHẶN đặt trần NHỎ HƠN số thành
  // viên đang hoạt động hiện tại (tránh trạng thái "đã vượt trần" mơ hồ — thành viên cũ vẫn ở lại nhưng số liệu
  // sai). KHÔNG tự đá bớt ai (Zalo không làm vậy) — chỉ chặn hạ trần xuống dưới thực tế.
  if (input.maxMembers !== undefined) {
    if (input.maxMembers !== null) {
      if (!Number.isInteger(input.maxMembers) || input.maxMembers <= 0) {
        throw new ChatServiceError('VALIDATION', 'maxMembers phải là số nguyên dương, hoặc null để bỏ giới hạn.');
      }
      const activeCount = await db.chatRoomMember.count({ where: { roomId, leftAt: null } });
      if (input.maxMembers < activeCount) {
        throw new ChatServiceError('VALIDATION', `Giới hạn (${input.maxMembers}) không được nhỏ hơn số thành viên hiện tại (${activeCount}).`);
      }
    }
    data.maxMembers = input.maxMembers;
  }

  const updated = await db.chatRoom.update({ where: { id: roomId }, data, include: { members: true } });
  // #33 — tin HỆ THỐNG khi ĐỔI TÊN nhóm: "X đã đổi tên nhóm thành ..." (lưu vĩnh viễn + realtime, kiểu Zalo).
  // Chỉ khi tên thực sự đổi (data.name có + khác tên cũ). Best-effort.
  if (typeof data.name === 'string' && data.name !== room.name) {
    try {
      const actor = await db.agent.findUnique({ where: { id: requesterAgentId }, select: { name: true } });
      await postSystemMessage(db, roomId, `${actor?.name || 'Một người'} đã đổi tên nhóm thành "${data.name}"`);
    } catch (err) {
      console.error(`[bot-api] chat-room-service: tin hệ thống đổi tên nhóm thất bại roomId=${roomId} (best-effort):`, err);
    }
  }
  return toRoomWithMembers(updated);
}

// ── GHIM KHÔNG GIỚI HẠN / "Bảng tin" (5/8, Admin Demo nhấn mạnh) ────────────────────────────────────────────────
// Zalo cho ghim NHIỀU tin (không chỉ 1). Bảng PinnedMessage = nguồn sự thật (mỗi hàng 1 tin ghim). GIỮ
// ChatRoom.pinnedMessageId cho tương thích client cũ = luôn đồng bộ tới tin ghim MỚI NHẤT (hoặc null khi hết).
//
// AI ĐƯỢC GHIM — hiện GIỮ OWNER/ADMIN (assertOwnerOrAdmin, CÙNG gate readOnly/thêm-xóa-thành-viên đã có). Brief
// đánh dấu "member được ghim không" = CẦN XÁC MINH với Admin Demo — KHÔNG tự nới cho MEMBER (CẤM SUY LUẬN). Nếu
// Admin Demo chốt "cho member ghim như Zalo", chỉ cần đổi assertOwnerOrAdmin → assertActiveMember ở 2 hàm dưới.

export interface PinnedMessageDto {
  id: number;
  roomId: string;
  messageId: string;
  pinnedByAgentId: number;
  pinnedAt: Date;
  // Nội dung tin đã ghim, hoặc null nếu tin đó đã bị thu hồi/xóa mềm SAU khi ghim (client hiện "tin đã thu hồi",
  // KHÔNG tự ẩn hàng ghim — người ghim vẫn thấy mình từng ghim gì).
  message: { id: string; kind: string; body: string | null; senderId: number | null; attachmentId: string | null; metadataJson: string | null; createdAt: Date } | null;
}

/** Ghim 1 tin nhắn (chỉ OWNER/ADMIN) — kiểm tin nhắn THẬT thuộc đúng phòng này, chưa bị xóa mềm. Thêm 1 hàng
 * PinnedMessage (idempotent qua unique roomId+messageId — ghim lại tin đã ghim KHÔNG lỗi, giữ nguyên pinnedAt/
 * pinnedBy gốc) + đồng bộ con trỏ tương thích ChatRoom.pinnedMessageId = tin vừa ghim. */
export async function pinMessage(db: Db, roomId: string, requesterAgentId: number, messageId: string): Promise<void> {
  await assertOwnerOrAdmin(db, roomId, requesterAgentId);
  const message = await db.chatMessage.findUnique({ where: { id: messageId } });
  if (!message || message.roomId !== roomId || message.deletedAt !== null) {
    throw new ChatServiceError('NOT_FOUND', `Tin nhắn id=${messageId} không tồn tại trong phòng này.`);
  }
  await db.$transaction(async (tx) => {
    await tx.pinnedMessage.upsert({
      where: { roomId_messageId: { roomId, messageId } },
      create: { roomId, messageId, pinnedByAgentId: requesterAgentId },
      update: {} // đã ghim rồi → giữ nguyên (idempotent), KHÔNG dời pinnedAt/pinnedBy.
    });
    await tx.chatRoom.update({ where: { id: roomId }, data: { pinnedMessageId: messageId } });
  });
}

/** Gỡ ghim (chỉ OWNER/ADMIN) — idempotent. `messageId` có → gỡ ĐÚNG tin đó khỏi "Bảng tin"; `messageId` bỏ
 * trống → gỡ TẤT CẢ tin đã ghim (giữ tương thích route DELETE .../pin cũ — trước đây phòng chỉ có 1 pin). Sau
 * khi gỡ, đồng bộ lại con trỏ ChatRoom.pinnedMessageId = tin ghim còn lại MỚI NHẤT (hoặc null nếu hết). */
export async function unpinMessage(db: Db, roomId: string, requesterAgentId: number, messageId?: string): Promise<void> {
  await assertOwnerOrAdmin(db, roomId, requesterAgentId);
  await db.$transaction(async (tx) => {
    if (messageId) {
      await tx.pinnedMessage.deleteMany({ where: { roomId, messageId } });
    } else {
      await tx.pinnedMessage.deleteMany({ where: { roomId } });
    }
    const latest = await tx.pinnedMessage.findFirst({ where: { roomId }, orderBy: { pinnedAt: 'desc' } });
    await tx.chatRoom.update({ where: { id: roomId }, data: { pinnedMessageId: latest?.messageId ?? null } });
  });
}

/** "Bảng tin" — liệt kê MỌI tin đã ghim của phòng (mới ghim trước), kèm nội dung tin + người ghim + thời gian.
 * Requester phải là thành viên đang hoạt động (assertActiveMember — ai trong phòng cũng XEM được bảng tin, chỉ
 * OWNER/ADMIN mới ghim/gỡ). Tin đã bị thu hồi sau khi ghim → message:null (KHÔNG ẩn hàng ghim, xem PinnedMessageDto). */
export async function listPinnedMessages(db: Db, roomId: string, requesterAgentId: number): Promise<PinnedMessageDto[]> {
  await assertActiveMember(db, roomId, requesterAgentId);
  const pins = await db.pinnedMessage.findMany({ where: { roomId }, orderBy: { pinnedAt: 'desc' } });
  if (pins.length === 0) return [];
  const messages = await db.chatMessage.findMany({ where: { id: { in: pins.map((p) => p.messageId) } } });
  const byId = new Map(messages.map((m) => [m.id, m]));
  return pins.map((p) => {
    const m = byId.get(p.messageId);
    const alive = m && m.deletedAt === null ? m : null;
    return {
      id: p.id,
      roomId: p.roomId,
      messageId: p.messageId,
      pinnedByAgentId: p.pinnedByAgentId,
      pinnedAt: p.pinnedAt,
      message: alive
        ? { id: alive.id, kind: alive.kind, body: alive.body, senderId: alive.senderId, attachmentId: alive.attachmentId, metadataJson: alive.metadataJson, createdAt: alive.createdAt }
        : null
    };
  });
}

// ── DUYỆT THÀNH VIÊN (5/8) — ChatRoomJoinRequest ────────────────────────────────────────────────────────────
// requireApproval=true: người lạ gọi requestJoin() → tạo yêu cầu PENDING → OWNER/ADMIN approveJoin/rejectJoin.
// requireApproval=false (mặc định): requestJoin() vào THẲNG (như addMember không cần lời mời) — vẫn áp trần
// maxMembers. KHÔNG áp gate bạn-bè cho requestJoin (người tự xin vào nhóm mở, không có "người mời" — kiểm soát
// bằng chính cờ duyệt của chủ nhóm; QUYẾT ĐỊNH THIẾT KẾ ghi rõ, khác addMember có người mời nên giữ gate đó).

export type RequestJoinResult =
  | { status: 'JOINED'; member: ChatRoomMemberDto }
  | { status: 'PENDING'; request: { id: number; roomId: string; agentId: number; status: string; requestedAt: Date } };

export async function requestJoin(db: Db, roomId: string, agentId: number): Promise<RequestJoinResult> {
  if (!Number.isInteger(agentId) || agentId <= 0) {
    throw new ChatServiceError('VALIDATION', 'agentId phải là số nguyên dương.');
  }
  const room = await db.chatRoom.findUnique({ where: { id: roomId } });
  if (!room || room.deletedAt) {
    throw new ChatServiceError('NOT_FOUND', `Phòng id=${roomId} không tồn tại.`);
  }
  if (room.type !== 'GROUP') {
    throw new ChatServiceError('VALIDATION', 'Chỉ xin vào được phòng NHÓM (phòng 1-1 không có khái niệm xin vào).');
  }
  const existingMember = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId, agentId } } });
  if (existingMember && existingMember.leftAt === null) {
    throw new ChatServiceError('ALREADY_MEMBER', 'Bạn đã là thành viên của nhóm này.');
  }

  // BOT-3: phòng gắn khách (customer_chat_groups active) cấp phạm-vi-tài-chính cho MỌI thành viên active (xem
  // agent-tid-scope.ts) → agent chỉ cần biết roomId là tự vào để chiếm quyền TID của khách. CẤM auto-add BẤT KỂ
  // requireApproval: phòng loại này LUÔN đi đường PENDING, OWNER/ADMIN phải duyệt (approveJoin) mới được thêm.
  const financialScope = await isFinancialScopeRoom(db, roomId);
  if (!room.requireApproval && !financialScope) {
    const member = await db.$transaction(async (tx) => {
      const { maxMembers } = await lockRoomForMembership(tx, roomId);
      return addOrReactivateMemberTx(tx, roomId, agentId, maxMembers);
    });
    return { status: 'JOINED', member: toMemberDto(member) };
  }

  const existingReq = await db.chatRoomJoinRequest.findFirst({ where: { roomId, agentId, status: 'PENDING' } });
  if (existingReq) return { status: 'PENDING', request: existingReq };
  try {
    const created = await db.chatRoomJoinRequest.create({ data: { roomId, agentId } });
    return { status: 'PENDING', request: created };
  } catch (err) {
    // Race: 2 request-join gần đồng thời — partial-unique (room_id, agent_id) WHERE status='PENDING' chặn hàng
    // 2 ở DB, request thua đọc lại yêu cầu kia vừa tạo (giống findOrCreateDirectRoom).
    if (isUniqueConstraintViolation(err)) {
      const race = await db.chatRoomJoinRequest.findFirst({ where: { roomId, agentId, status: 'PENDING' } });
      if (race) return { status: 'PENDING', request: race };
    }
    throw err;
  }
}

/** Duyệt 1 yêu cầu vào nhóm (OWNER/ADMIN) → tạo/tái kích hoạt ChatRoomMember + đánh dấu yêu cầu APPROVED, ATOMIC
 * trong 1 transaction có khóa hàng phòng (chống race trần + double-approve). Ném JOIN_REQUEST_NOT_FOUND nếu
 * không có yêu cầu PENDING của agent đó; ROOM_FULL nếu đã đạt trần. */
export async function approveJoin(db: Db, roomId: string, requesterAgentId: number, targetAgentId: number) {
  await assertOwnerOrAdmin(db, roomId, requesterAgentId);
  if (!Number.isInteger(targetAgentId) || targetAgentId <= 0) {
    throw new ChatServiceError('VALIDATION', 'targetAgentId phải là số nguyên dương.');
  }
  const member = await db.$transaction(async (tx) => {
    const { maxMembers } = await lockRoomForMembership(tx, roomId);
    const pending = await tx.chatRoomJoinRequest.findFirst({ where: { roomId, agentId: targetAgentId, status: 'PENDING' } });
    if (!pending) {
      throw new ChatServiceError('JOIN_REQUEST_NOT_FOUND', `Không có yêu cầu vào nhóm đang chờ của agent id=${targetAgentId}.`);
    }
    const added = await addOrReactivateMemberTx(tx, roomId, targetAgentId, maxMembers);
    // compare-and-swap: chỉ hàng còn PENDING mới chuyển APPROVED — belt-and-suspenders trên khóa FOR UPDATE.
    const upd = await tx.chatRoomJoinRequest.updateMany({
      where: { id: pending.id, status: 'PENDING' },
      data: { status: 'APPROVED', decidedBy: requesterAgentId, decidedAt: new Date() }
    });
    if (upd.count !== 1) {
      throw new ChatServiceError('CONFLICT', 'Yêu cầu vừa được xử lý bởi người khác — thử lại.');
    }
    return added;
  });
  return toMemberDto(member);
}

/** Từ chối 1 yêu cầu vào nhóm (OWNER/ADMIN) — chuyển PENDING → REJECTED. Ném JOIN_REQUEST_NOT_FOUND nếu không có. */
export async function rejectJoin(db: Db, roomId: string, requesterAgentId: number, targetAgentId: number): Promise<void> {
  await assertOwnerOrAdmin(db, roomId, requesterAgentId);
  if (!Number.isInteger(targetAgentId) || targetAgentId <= 0) {
    throw new ChatServiceError('VALIDATION', 'targetAgentId phải là số nguyên dương.');
  }
  const upd = await db.chatRoomJoinRequest.updateMany({
    where: { roomId, agentId: targetAgentId, status: 'PENDING' },
    data: { status: 'REJECTED', decidedBy: requesterAgentId, decidedAt: new Date() }
  });
  if (upd.count === 0) {
    throw new ChatServiceError('JOIN_REQUEST_NOT_FOUND', `Không có yêu cầu vào nhóm đang chờ của agent id=${targetAgentId}.`);
  }
}

/** Danh sách yêu cầu vào nhóm ĐANG chờ (OWNER/ADMIN) — cũ nhất trước (xử lý theo thứ tự đến). */
export async function listPendingJoinRequests(db: Db, roomId: string, requesterAgentId: number) {
  await assertOwnerOrAdmin(db, roomId, requesterAgentId);
  return db.chatRoomJoinRequest.findMany({ where: { roomId, status: 'PENDING' }, orderBy: { requestedAt: 'asc' } });
}

// ── AVATAR NHÓM (5/8) — upload ảnh THẬT (BLOB), TÁI DÙNG cơ chế magic-bytes của agent-media-service.ts ──────────
export const MAX_ROOM_AVATAR_SIZE_BYTES = 5 * 1024 * 1024; // 5MB — CÙNG hằng số avatar Agent (agent-media-service.ts).
const ROOM_AVATAR_ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type SaveRoomAvatarResult =
  | { ok: true }
  | { ok: false; reason: 'EMPTY_FILE' }
  | { ok: false; reason: 'FILE_TOO_LARGE' }
  | { ok: false; reason: 'MIME_NOT_ALLOWED'; detectedMime: string | null };

/** Đặt ảnh đại diện nhóm (chỉ OWNER/ADMIN, CHỈ phòng GROUP) — sniff magic-bytes THẬT (KHÔNG tin Content-Type
 * client, CÙNG saveAgentMedia). Ghi BLOB + mime + updatedAt, và set avatarUrl = đường dẫn GET để client cũ đọc
 * avatarUrl vẫn render ảnh mới. KHÔNG throw cho lỗi nghiệp vụ (rỗng/quá cỡ/sai loại) — trả {ok:false,reason}. */
export async function saveRoomAvatar(db: Db, roomId: string, requesterAgentId: number, buffer: Buffer): Promise<SaveRoomAvatarResult> {
  await assertOwnerOrAdmin(db, roomId, requesterAgentId);
  const room = await db.chatRoom.findUnique({ where: { id: roomId } });
  if (!room || room.deletedAt) {
    throw new ChatServiceError('NOT_FOUND', `Phòng id=${roomId} không tồn tại.`);
  }
  if (room.type !== 'GROUP') {
    throw new ChatServiceError('VALIDATION', 'Chỉ đặt được ảnh đại diện cho phòng NHÓM.');
  }
  if (buffer.length === 0) return { ok: false, reason: 'EMPTY_FILE' };
  if (buffer.length > MAX_ROOM_AVATAR_SIZE_BYTES) return { ok: false, reason: 'FILE_TOO_LARGE' };
  const detected = await fileTypeFromBuffer(buffer);
  const mimeType = detected?.mime ?? null;
  if (!mimeType || !ROOM_AVATAR_ALLOWED_MIMES.has(mimeType)) {
    return { ok: false, reason: 'MIME_NOT_ALLOWED', detectedMime: mimeType };
  }
  const bytes = new Uint8Array(buffer); // Prisma 7 Bytes = Uint8Array<ArrayBuffer> (xem agent-media-service.ts).
  await db.chatRoom.update({
    where: { id: roomId },
    data: { avatarImage: bytes, avatarImageMime: mimeType, avatarUpdatedAt: new Date(), avatarUrl: `/v1/chat/rooms/${roomId}/avatar` }
  });
  return { ok: true };
}

/** Đọc ảnh đại diện nhóm — bất kỳ thành viên đang hoạt động nào xem được (assertActiveMember). null nếu phòng
 * chưa đặt ảnh (route map 404). */
export async function getRoomAvatar(db: Db, roomId: string, requesterAgentId: number): Promise<{ buffer: Buffer; mimeType: string } | null> {
  await assertActiveMember(db, roomId, requesterAgentId);
  const room = await db.chatRoom.findUnique({ where: { id: roomId }, select: { avatarImage: true, avatarImageMime: true } });
  if (!room) return null;
  const image = room.avatarImage;
  if (!image || image.length === 0) return null;
  return { buffer: Buffer.from(image), mimeType: room.avatarImageMime ?? 'image/jpeg' };
}

/** Tên + loại phòng để render avatar fallback (chữ cái đầu + màu theo roomId) khi nhóm CHƯA đặt ảnh, xem
 * fallback-avatar.ts. KHÔNG assert thành viên lại — route chỉ gọi hàm này SAU khi getRoomAvatar() (đã
 * assertActiveMember) trả null, nên requester chắc chắn là thành viên. `null` nếu phòng không tồn tại → route
 * trả 404 thật. */
export async function getRoomFallbackInfo(db: Db, roomId: string): Promise<{ name: string | null; type: string } | null> {
  const room = await db.chatRoom.findUnique({ where: { id: roomId }, select: { name: true, type: true } });
  if (!room) return null;
  return { name: room.name, type: room.type };
}

// ── MENU HỘI THOẠI (nhấn giữ 1 dòng danh sách chat, kiểu Zalo — 7/8) ─────────────────────────────────────────
// Các hành động CẤP-HỘI-THOẠI PER-AGENT: thao tác CHỈ trên hàng ChatRoomMember của CHÍNH agent gọi (không đụng
// người khác trong cùng phòng — đúng bản chất "1 hàng = 1 agent là thành viên 1 phòng", giống mutedUntil/
// categoryId/lastReadMessageId đã có). MỌI hàm assertActiveMember TRƯỚC (NOT_MEMBER 403 nếu không phải thành
// viên đang hoạt động). Broadcast (nếu có) do route layer làm (giữ service thuần DB, cùng convention file này).

/** Sentinel "tắt thông báo vô thời hạn" — CÙNG mốc client dùng để phân biệt "mute mãi mãi" (Zalo không có hạn
 * giờ ở menu này). mutedUntil so với now: > now = đang mute. */
const MUTE_FOREVER = new Date('2099-01-01T00:00:00.000Z');

/** Tắt/bật thông báo phòng cho CHÍNH agent (mutedUntil = mute ? '2099-01-01' : null). */
export async function setRoomMuted(db: Db, roomId: string, agentId: number, muted: boolean): Promise<void> {
  await assertActiveMember(db, roomId, agentId);
  await db.chatRoomMember.update({
    where: { roomId_agentId: { roomId, agentId } },
    data: { mutedUntil: muted ? MUTE_FOREVER : null }
  });
}

/** Ghim/bỏ ghim HỘI THOẠI lên đầu danh sách chat cho CHÍNH agent (pinnedAt = pinned ? now() : null). KHÁC
 * pinMessage() (ghim TIN trong phòng, cấp phòng, OWNER/ADMIN) — đây là ghim CÁ NHÂN cấp-hội-thoại. */
export async function setConversationPinned(db: Db, roomId: string, agentId: number, pinned: boolean): Promise<void> {
  await assertActiveMember(db, roomId, agentId);
  await db.chatRoomMember.update({
    where: { roomId_agentId: { roomId, agentId } },
    data: { pinnedAt: pinned ? new Date() : null }
  });
}

/** Đánh dấu CHƯA ĐỌC cho CHÍNH agent — set lastReadMessageId = tin nhắn NGAY TRƯỚC tin mới nhất (chưa xóa) trong
 * phòng, để unreadCount >= 1 (unreadCount đếm tin có createdAt > createdAt của lastRead, không do chính mình gửi
 * — xem RoomSummaryDto). Phòng ≤ 1 tin (0 hoặc 1) → set null (không có "tin trước" để lùi con trỏ; null = tính
 * unread từ joinedAt). Route sau đó broadcast 'room-unread-self' cho đa thiết bị đồng bộ. */
export async function markRoomUnread(db: Db, roomId: string, agentId: number): Promise<void> {
  await assertActiveMember(db, roomId, agentId);
  // 2 tin mới nhất chưa xóa (cùng tie-break [createdAt desc, id desc] như lastMessagesForRooms/listMessages).
  const lastTwo = await db.chatMessage.findMany({
    where: { roomId, deletedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 2,
    select: { id: true }
  });
  const prevId = lastTwo.length >= 2 ? lastTwo[1].id : null; // tin NGAY TRƯỚC tin mới nhất, hoặc null nếu ≤1 tin.
  await db.chatRoomMember.update({
    where: { roomId_agentId: { roomId, agentId } },
    data: { lastReadMessageId: prevId }
  });
}

/** Ẩn/bỏ ẩn hội thoại khỏi danh sách cho CHÍNH agent (hiddenAt = hidden ? now() : null). KHÁC removedAt: ẩn
 * KHÔNG tự hiện lại khi có tin mới. */
export async function setRoomHidden(db: Db, roomId: string, agentId: number, hidden: boolean): Promise<void> {
  await assertActiveMember(db, roomId, agentId);
  await db.chatRoomMember.update({
    where: { roomId_agentId: { roomId, agentId } },
    data: { hiddenAt: hidden ? new Date() : null }
  });
}

/** Xóa hội thoại phía mình cho CHÍNH agent (removedAt = now(); tin VẪN còn). TỰ hiện lại khi phòng có tin mới —
 * clear removedAt ở sendMessage() (chat-message-service.ts), KHÔNG ở đây. */
export async function setRoomRemoved(db: Db, roomId: string, agentId: number): Promise<void> {
  await assertActiveMember(db, roomId, agentId);
  // XÓA HỘI THOẠI kiểu Zalo (7/8, Admin Demo "xóa xong nhắn lại vẫn còn lịch sử là sai") — đặt CẢ removedAt (ẩn khỏi
  // danh sách) LẪN clearedAt=now (ẩn TOÀN BỘ tin cũ phía mình). Nhắn lại → findOrCreateDirectRoom clear
  // removedAt/hiddenAt (hiện lại danh sách) nhưng GIỮ clearedAt → mở ra TRỐNG, chỉ thấy tin MỚI sau khi xóa. Chỉ
  // ảnh hưởng agent này (phía kia giữ nguyên lịch sử). Tin KHÔNG bị xóa thật khỏi DB (đúng "chỉ xóa phía bạn").
  await db.chatRoomMember.update({
    where: { roomId_agentId: { roomId, agentId } },
    data: { removedAt: new Date(), clearedAt: new Date() }
  });
}

/** Báo xấu 1 phòng: INSERT chat_reports + ẨN luôn phòng phía người báo (hiddenAt = now()). Trả record vừa tạo
 * (id) để route dựng thông báo kênh admin. Thông báo kênh admin (SIGMA_ADMIN_REPORT_ROOM_ID) do route làm. */
export async function reportRoom(db: Db, roomId: string, agentId: number, reason?: string): Promise<{ id: string; roomId: string; reporterAgentId: number; reason: string | null; createdAt: Date }> {
  await assertActiveMember(db, roomId, agentId);
  const trimmedReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 1000) : null;
  const [report] = await db.$transaction([
    db.chatReport.create({ data: { roomId, reporterAgentId: agentId, reason: trimmedReason } }),
    db.chatRoomMember.update({ where: { roomId_agentId: { roomId, agentId } }, data: { hiddenAt: new Date() } })
  ]);
  return { id: report.id, roomId: report.roomId, reporterAgentId: report.reporterAgentId, reason: report.reason, createdAt: report.createdAt };
}
