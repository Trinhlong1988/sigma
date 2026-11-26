// SIGMA — "TỰ LẤY BILL ZALO → SigMa" (Admin Demo). Module lõi cho tính năng bot tự nhặt ảnh bill từ 1
// nhóm Zalo (ngoài) rồi đưa vào ĐÚNG phòng chat SigMa tương ứng. Ở đây gồm 2 mảnh nền tảng, KHÔNG có
// side-effect ngoài DB:
//   1. ensureSupportAlphaAgent — tạo/đảm bảo Agent hệ thống "Support SigMa" (bot chủ thể đăng bill vào phòng).
//      CÙNG TIỀN LỆ ensureAlphaBotAgent (investor-crosspost-service.ts): upsert theo code @unique (idempotent),
//      avatar gán BEST-EFFORT từ assets/brand/alpha-icon-master.png (thiếu file/lỗi đọc KHÔNG chặn).
//   2. matchRoomByZaloGroupName — KHỚP tên nhóm Zalo (chuỗi thô, có dấu/ký tự lạ) sang 1 phòng GROUP SigMa
//      còn sống. Chuẩn hoá 2 vế (bỏ dấu + đ→d + uppercase + bỏ ký tự lạ + gộp space) rồi so KHỚP CHÍNH XÁC
//      trước, không có thì CHỨA-nhau (chọn tên dài gần nhất). MƠ HỒ (>1 khớp exact) → null: thà KHÔNG khớp
//      còn hơn đẩy bill nhầm nhóm (mệnh lệnh bảo mật Admin Demo — không đoán liều).
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

/** Mã + tên cố định cho bot hệ thống "Support SigMa". code là @unique → upsert idempotent (nhiều lần gọi = 1). */
export const SUPPORT_SIGMA_CODE = 'SUPPORT_ALPHA';
export const SUPPORT_SIGMA_NAME = 'Support SigMa';

/** Đường dẫn ảnh icon master của brand — avatar bot (best-effort). Từ apps/bot-api/src lên gốc repo 3 cấp
 * (src → bot-api → apps → repoRoot), rồi assets/brand/alpha-icon-master.png. (Y HỆT investor-crosspost.) */
function alphaIconMasterPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // apps/bot-api/src
  const repoRoot = join(here, '..', '..', '..'); // repo root
  return join(repoRoot, 'assets', 'brand', 'alpha-icon-master.png');
}

/** Tạo/đảm bảo Agent bot "Support SigMa" tồn tại (idempotent). Avatar gán BEST-EFFORT từ icon master — thiếu
 * file/lỗi đọc KHÔNG chặn (bot vẫn dùng được, chỉ không có avatar). Dùng avatarImageMime làm cờ "đã có avatar
 * chưa" để KHÔNG tải lại BLOB mỗi lần gọi. KHÔNG cần migration (dùng cột Agent.avatar* có sẵn). */
export async function ensureSupportAlphaAgent(db: Db): Promise<{ id: number }> {
  const bot = await db.agent.upsert({
    where: { code: SUPPORT_SIGMA_CODE },
    update: {},
    create: { code: SUPPORT_SIGMA_CODE, name: SUPPORT_SIGMA_NAME },
    select: { id: true, avatarImageMime: true }
  });
  if (!bot.avatarImageMime) {
    try {
      const bytes = await readFile(alphaIconMasterPath());
      await db.agent.update({
        where: { id: bot.id },
        data: { avatarImage: bytes, avatarImageMime: 'image/png', avatarUpdatedAt: new Date() }
      });
    } catch (err) {
      // R198 — KHÔNG nuốt câm: log rõ nhưng KHÔNG chặn (avatar là phụ, bot vẫn hoạt động).
      console.error('[zalo-bill-support] gán avatar bot Support SigMa thất bại (best-effort, bot vẫn dùng được):', err);
    }
  }
  return { id: bot.id };
}

/**
 * SELF-HEAL (Admin Demo 6/9 — GỐC bug 4 đại lý Lộc SG/Mạnh HN/Quỳnh SG/Hoài SG sót doanh số CÂM; R198 "chống tái diễn"):
 * Bot GHI doanh số = SupportAlpha (agentScopeCustomerIds gate theo THÀNH VIÊN nhóm). Nếu SupportAlpha VẮNG nhóm đại lý
 * → mọi bill của nhóm đó rơi doanh số câm (createLo → TID_NOT_IN_AGENT_SCOPE). Trước đây SupportAlpha chỉ được thêm
 * vào nhóm qua đường zalo-watcher → đại lý dùng menu OCR-send (không watcher) bị VẮNG → drift.
 *
 * Hàm này ĐẢM BẢO SupportAlpha là thành viên (leftAt=null) của MỌI nhóm GROUP có khách gán (customer_chat_groups
 * active) — phủ CẢ đường edit/ingest/recovery, KHÔNG chỉ send. Idempotent. Chạy lúc boot + định kỳ 6h (index.ts).
 * LOG LOUD số nhóm vừa hàn (surface drift — R198, KHÔNG hàn câm) để vận hành biết có drift xảy ra.
 * Trả { scanned, healed, healedRoomIds } — healed>0 nghĩa là ĐÃ có drift (đáng cảnh báo).
 */
export async function healSupportBotDealerGroupMembership(
  db: Db
): Promise<{ scanned: number; healed: number; healedRoomIds: string[]; healedSendBot: string[]; roomsKhongNguoi: { roomId: string; name: string }[] }> {
  const bot = await ensureSupportAlphaAgent(db);
  // Nhóm đại lý = room GROUP còn sống CÓ khách gán active (customer_chat_groups.unassignedAt null).
  const groups = await db.customerChatGroup.findMany({
    where: { unassignedAt: null, roomId: { not: null } },
    select: { roomId: true }
  });
  const roomIds = [...new Set(groups.map((g) => g.roomId).filter((r): r is string => !!r))];
  if (roomIds.length === 0) return { scanned: 0, healed: 0, healedRoomIds: [], healedSendBot: [], roomsKhongNguoi: [] };
  const liveRooms = await db.chatRoom.findMany({
    where: { id: { in: roomIds }, type: 'GROUP', deletedAt: null },
    select: { id: true }
  });
  const liveRoomIds = liveRooms.map((r) => r.id);
  // Nhóm nào SupportAlpha đã là thành viên active (leftAt null) → bỏ qua. Còn lại = cần hàn.
  const already = await db.chatRoomMember.findMany({
    where: { agentId: bot.id, roomId: { in: liveRoomIds }, leftAt: null },
    select: { roomId: true }
  });
  const alreadySet = new Set(already.map((m) => m.roomId));
  const missing = liveRoomIds.filter((id) => !alreadySet.has(id));
  for (const roomId of missing) {
    await db.chatRoomMember.upsert({
      where: { roomId_agentId: { roomId, agentId: bot.id } },
      update: { leftAt: null },
      create: { roomId, agentId: bot.id, role: 'MEMBER' }
    });
  }
  // [Admin Demo 9/9 — chống tái diễn, ca "ĐL - Mạnh HN"] Bot GỬI (SIGMA_BOT) cũng phải có mặt: thiếu nó thì bill KHÔNG
  // được đăng vào nhóm (đại lý không thấy gì) dù doanh số vẫn ghi. Hàn cùng lượt với bot GHI.
  const botGui = await db.agent.findFirst({ where: { code: 'SIGMA_BOT' }, select: { id: true } });
  const healedSendBot: string[] = [];
  if (botGui) {
    const coBotGui = await db.chatRoomMember.findMany({ where: { agentId: botGui.id, roomId: { in: liveRoomIds }, leftAt: null }, select: { roomId: true } });
    const coSet = new Set(coBotGui.map((m) => m.roomId));
    for (const roomId of liveRoomIds.filter((id) => !coSet.has(id))) {
      await db.chatRoomMember.upsert({
        where: { roomId_agentId: { roomId, agentId: botGui.id } },
        update: { leftAt: null },
        create: { roomId, agentId: botGui.id, role: 'MEMBER' }
      });
      healedSendBot.push(roomId);
    }
  }

  // [Admin Demo 9/9 — ca "ĐL- Hà Khach Demo SG"] Phòng CHỈ CÓ BOT (0 người thật) ⇒ bill gửi vào nhưng KHÔNG AI ĐỌC.
  // KHÔNG tự thêm người (quyền/nhân sự là việc của Admin Demo) nhưng PHẢI nêu tên phòng — không hàn câm, không bỏ qua.
  const tv = await db.chatRoomMember.findMany({ where: { roomId: { in: liveRoomIds }, leftAt: null }, select: { roomId: true, agentId: true } });
  const agentIds = [...new Set(tv.map((m) => m.agentId))];
  const nguoiThat = agentIds.length
    ? new Set((await db.agent.findMany({ where: { id: { in: agentIds }, code: { notIn: ['SIGMA_BOT', 'SUPPORT_ALPHA'] } }, select: { id: true } })).map((a) => a.id))
    : new Set<number>();
  const demNguoi = new Map<string, number>();
  for (const m of tv) if (nguoiThat.has(m.agentId)) demNguoi.set(m.roomId, (demNguoi.get(m.roomId) ?? 0) + 1);
  const trong = liveRoomIds.filter((id) => (demNguoi.get(id) ?? 0) === 0);
  const tenPhong = trong.length
    ? await db.chatRoom.findMany({ where: { id: { in: trong } }, select: { id: true, name: true } })
    : [];
  const roomsKhongNguoi = tenPhong.map((r) => ({ roomId: r.id, name: r.name ?? r.id }));

  return { scanned: liveRoomIds.length, healed: missing.length, healedRoomIds: missing, healedSendBot, roomsKhongNguoi };
}

/**
 * Chuẩn hoá tên (nhóm Zalo hoặc phòng SigMa) để SO KHỚP không phụ thuộc dấu/hoa-thường/ký tự trang trí:
 *   1. NFD tách dấu tiếng Việt thành base + dấu tổ hợp → bỏ dấu tổ hợp (̀-ͯ).
 *   2. đ/Đ KHÔNG tách bằng NFD (là chữ cái riêng) → thay tay đ→d, Đ→D.
 *   3. uppercase.
 *   4. mọi ký tự KHÔNG phải [A-Z0-9 ] → space (giữ ranh giới từ, vd "ĐL-" → "DL ").
 *   5. gộp nhiều space → 1, trim.
 * Vd "ĐL- Mr. Bảo SG" → "DL MR BAO SG".
 */
export function normalizeGroupName(raw: string): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface MatchedRoom {
  roomId: string;
  roomName: string;
}

/**
 * Khớp tên nhóm Zalo → 1 phòng GROUP SigMa còn sống (deletedAt = null), hoặc null nếu không chắc chắn.
 * Chiến lược (Admin Demo "tự khớp theo tên nhóm", ưu tiên AN TOÀN hơn phủ sóng):
 *   • Ưu tiên 1 — KHỚP CHÍNH XÁC tên chuẩn-hoá. Đúng 1 phòng → chọn. >1 phòng cùng tên chuẩn-hoá → null
 *     (MƠ HỒ, không đoán liều — thà không khớp còn hơn đẩy nhầm nhóm).
 *   • Ưu tiên 2 — CHỨA-nhau: tên phòng chứa tên Zalo HOẶC tên Zalo chứa tên phòng. Chọn phòng có ĐỘ DÀI tên
 *     chuẩn-hoá GẦN NHẤT với tên Zalo (giảm nguy cơ khớp mảnh quá ngắn).
 *   • Không gì khớp / tên Zalo rỗng → null.
 * Phòng tên chuẩn-hoá RỖNG bị loại (tránh z.includes('') khớp bừa mọi phòng).
 */
export async function matchRoomByZaloGroupName(db: Db, zaloGroupName: string): Promise<MatchedRoom | null> {
  const z = normalizeGroupName(zaloGroupName ?? '');
  if (!z) return null;

  const rooms = await db.chatRoom.findMany({
    where: { type: 'GROUP', deletedAt: null },
    select: { id: true, name: true }
  });

  const candidates = rooms
    .map((r) => ({ roomId: r.id, roomName: r.name ?? '', norm: normalizeGroupName(r.name ?? '') }))
    .filter((r) => r.norm.length > 0);

  // Ưu tiên 1 — khớp chính xác.
  const exact = candidates.filter((r) => r.norm === z);
  if (exact.length === 1) return { roomId: exact[0].roomId, roomName: exact[0].roomName };
  if (exact.length > 1) return null; // mơ hồ — KHÔNG đoán liều.

  // Ưu tiên 2 — chứa-nhau NHƯNG CHẶT (Admin Demo 25/8 "logic chéo chặt chẽ", sau bug contains lỏng khớp nhầm chuỗi
  // con ngắn như "LA"/"TON" của tên nhóm dài): tên NGẮN phải là CỤM-TỪ TRỌN (bao bởi khoảng trắng/biên) + độ dài
  // ≥ MIN_CONTAINS_LEN → tránh khớp bừa. Chọn phòng độ dài tên gần nhất.
  let best: { roomId: string; roomName: string } | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const r of candidates) {
    if (containsWholeWord(r.norm, z) || containsWholeWord(z, r.norm)) {
      const delta = Math.abs(r.norm.length - z.length);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = { roomId: r.roomId, roomName: r.roomName };
      }
    }
  }
  return best;
}

/** Khớp CHÍNH XÁC nhóm Zalo → phòng SigMa theo `zaloGroupId` đã dán trên customer_chat_groups (Admin Demo 25/8:
 *  tên 2 bên khác nhau → dùng groupId dán tay, 100% chính xác). Trả phòng + customerId của khách. null nếu chưa dán. */
export interface MatchedRoomByZalo {
  roomId: string;
  roomName: string;
  customerId: number;
}
/** Chuẩn hoá zaloGroupId về canonical `g<digits>` (khớp DB do service lưu cùng dạng). `123`/`123_group`/`g123`→`g123`. */
export function canonicalZaloGroupId(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const m = t.match(/^g?(\d+)(?:_group)?$/i);
  return m ? `g${m[1]}` : t;
}

export async function matchRoomByZaloGroupId(db: Db, zaloGroupId: string): Promise<MatchedRoomByZalo | null> {
  const gid = canonicalZaloGroupId(zaloGroupId);
  if (!gid) return null;
  const grp = await db.customerChatGroup.findFirst({
    where: { zaloGroupId: gid, unassignedAt: null, roomId: { not: null } },
    select: { roomId: true, customerId: true },
    orderBy: { id: 'desc' }
  });
  if (!grp?.roomId) return null;
  const room = await db.chatRoom.findFirst({ where: { id: grp.roomId, deletedAt: null }, select: { id: true, name: true } });
  if (!room) return null;
  return { roomId: room.id, roomName: room.name ?? '', customerId: grp.customerId };
}

const MIN_CONTAINS_LEN = 5;
/** `needle` xuất hiện trong `hay` như CỤM-TỪ TRỌN (bao bởi khoảng trắng hoặc biên chuỗi) + độ dài ≥ ngưỡng. */
function containsWholeWord(hay: string, needle: string): boolean {
  if (needle.length < MIN_CONTAINS_LEN) return false;
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) return false;
    const before = idx === 0 ? ' ' : hay[idx - 1];
    const after = idx + needle.length >= hay.length ? ' ' : hay[idx + needle.length];
    if (before === ' ' && after === ' ') return true;
    from = idx + 1;
  }
}
