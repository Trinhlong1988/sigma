// NHÀ ĐẦU TƯ — "Nhóm chat riêng của NĐT" (Phase E) — LÕI THUẦN ctx-based (NHÂN BẢN customer-chat-group.ts nhưng
// theo investorId, KHÔNG khóa theo loại phí). 1 NĐT có NHIỀU nhóm chat TỰ DO; mỗi nhóm = phòng NỘI BỘ SigMa
// (roomId → ChatRoom), lưu kèm name/link/qr/note để hiển thị. SigMa = nguồn cấu hình cơ sở.
//
// MÔ HÌNH KỲ (như CustomerChatGroup): mỗi hàng = 1 KỲ gán, `assignedFrom`..`unassignedAt` (null = active). Xóa =
// đóng kỳ (set unassignedAt = now, GIỮ lịch sử) — KHÔNG hard-delete. KHÁC customer: NHIỀU nhóm active/NĐT được
// phép (KHÔNG partial-unique theo investorId). Chống trùng phòng: 1 roomId chỉ 1 kỳ ACTIVE / NĐT (guard mềm ở
// service, cùng triết lý no-hard-FK).
//
// Quyền: list/picker = INVESTOR_VIEW; create/update/delete = INVESTOR_UPDATE. Audit INVESTOR_UPDATED (targetType
// Investor). Scalar join (roomId → ChatRoom.name) — join tại service, cùng triết lý schema.
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { assertChatRoomExists } from './chat-room-tid.js';
import type { ServiceCtx, MutationResult } from './customer.js';
// TÌM KIẾM hoa/thường: DB collation "C" → Prisma mode:'insensitive' (ILIKE) KHÔNG gập chữ tiếng Việt có dấu
// (đo thật trên sổ thật: ILIKE '%nguyễn%' = 0 dòng / ILIKE '%NGUYỄN%' = 10 dòng). Xem tim-kiem-hoa-thuong.ts.
import { dieuKienTimKiem } from './tim-kiem-hoa-thuong.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

export interface InvestorChatGroupDto {
  id: number;
  investorId: number;
  roomId: string | null;
  roomName: string | null; // tên phòng GROUP (join ChatRoom) — hiển thị trong danh sách cấu hình của NĐT
  name: string | null; // tên nhóm (NĐT tự đặt)
  link: string | null;
  qr: string | null;
  note: string | null;
}

/** Đầu vào tạo/sửa 1 nhóm chat của NĐT (tất cả tùy chọn — NĐT tự do). */
export interface InvestorChatGroupInput {
  name?: string | null;
  roomId?: string | null;
  link?: string | null;
  qr?: string | null;
  note?: string | null;
}

export interface ListInvestorChatGroupsResult {
  ok: boolean;
  data?: InvestorChatGroupDto[];
  error?: string;
  message?: string;
}

/** 1 lựa chọn trong dropdown "Nhóm chat NĐT" ở form TK nhận tiền — nhóm ĐANG GÁN (active) của ĐÚNG NĐT đó. */
export interface InvestorChatGroupOptionDto {
  id: number;
  name: string;
}

export interface ListAssignableInvestorChatGroupsResult {
  ok: boolean;
  data?: InvestorChatGroupOptionDto[];
  error?: string;
  message?: string;
}

/** '' / undefined → null (chuẩn hóa để so & ghi DB nhất quán). */
function normStr(v: string | null | undefined): string | null {
  return v != null && v !== '' ? v : null;
}

/** FIX-FK (khuôn assertFeeTypeValid customer-chat-group): investorId scalar KHÔNG có FK cứng → validate ở service. */
async function assertInvestorValid(db: Db, investorId: number): Promise<MutationResult | null> {
  if (!Number.isInteger(investorId) || investorId <= 0) {
    return { ok: false, error: 'VALIDATION', message: 'Nhà đầu tư không hợp lệ. Vui lòng chọn lại.' };
  }
  const inv = await db.investor.findFirst({ where: { id: investorId, deletedAt: null }, select: { id: true } });
  if (!inv) return { ok: false, error: 'NOT_FOUND', message: 'Nhà đầu tư không tồn tại (hoặc đã bị xóa).' };
  return null;
}

/** Map tên phòng cho danh sách nhóm (roomId → ChatRoom.name), 1 findMany distinct (KHÔNG N+1). */
async function roomNameMap(db: Db, roomIds: (string | null)[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(roomIds.filter((x): x is string => x != null))];
  if (ids.length === 0) return new Map();
  const rooms = await db.chatRoom.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(rooms.map((r) => [r.id, r.name]));
}

/** 1 lựa chọn trong dropdown CHỌN NHÓM CHAT (SigMa GROUP room) khi cấu hình nhóm chat của NĐT. */
export interface PickableChatGroupDto {
  roomId: string;
  name: string;
}
export interface ListPickableChatGroupsForInvestorResult {
  ok: boolean;
  data?: PickableChatGroupDto[];
  error?: string;
  message?: string;
}

/** INVESTOR_VIEW — PICKER dropdown chọn phòng GROUP SigMa khi cấu hình nhóm chat của NĐT (Admin Demo 19/8 "cho
 * room id show danh sách nhóm chat để gợi ý, show tên không show id như khách hàng"). KHÁC customer picker
 * (`listAssignableChatGroups`): **KHÔNG loại phòng đã gán khách** — NĐT được trỏ tới BẤT KỲ phòng GROUP nào, kể
 * cả phòng đang là nhóm của 1 khách (vd Nam Hà SG vừa là nhóm khách vừa có thể là nhóm NĐT). Nếu tái dùng picker
 * khách sẽ bị loại mất → đúng lỗi "chưa có sổ nhóm ra để chọn". Tìm theo tên/id (tham số hóa, an toàn injection). */
export async function listPickableChatGroupsForInvestor(
  ctx: ServiceCtx,
  opts?: { search?: string | null; limit?: number | null }
): Promise<ListPickableChatGroupsForInvestorResult> {
  if (!hasPermission(ctx.user, 'INVESTOR_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db } = ctx;
  const search = (opts?.search ?? '').trim();
  const rawLimit = opts?.limit;
  const limit = Number.isInteger(rawLimit) && (rawLimit as number) > 0 ? Math.min(rawLimit as number, 100) : 50;
  // Admin Demo 20/8 "chỉ show nhóm CHƯA gán": loại phòng đang là nhóm chat ACTIVE của BẤT KỲ NĐT nào (unassignedAt
  // null) → 1 phòng chỉ thuộc 1 NĐT, không hiện lại nhóm đã gán. VẪN KHÔNG loại phòng đã gán KHÁCH (đó là mối
  // quan hệ khác — 1 phòng có thể vừa là nhóm khách vừa là nhóm NĐT, xem docstring trên).
  const takenRows = await db.investorChatGroup.findMany({ where: { unassignedAt: null, roomId: { not: null } }, select: { roomId: true } });
  const takenRoomIds = [...new Set(takenRows.map((r) => r.roomId).filter((x): x is string => x != null))];
  const where: Record<string, unknown> = { type: 'GROUP', deletedAt: null };
  if (takenRoomIds.length > 0) where['id'] = { notIn: takenRoomIds };
  // Tìm kiếm tên/id nhóm — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts).
  const dkTim = await dieuKienTimKiem(db, 'chat_rooms', { name: 'name', id: 'id' }, search);
  if (dkTim) where['AND'] = dkTim;
  const rooms = await db.chatRoom.findMany({ where: where as never, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: limit });
  return { ok: true, data: rooms.map((r) => ({ roomId: r.id, name: r.name?.trim() || 'Nhóm chưa đặt tên' })) };
}

/** INVESTOR_VIEW — nhóm chat ĐANG GÁN (kỳ active) của 1 NĐT, kèm TÊN phòng (join). Sắp theo id tăng dần. */
export async function listInvestorChatGroups(ctx: ServiceCtx, investorId: number): Promise<ListInvestorChatGroupsResult> {
  if (!hasPermission(ctx.user, 'INVESTOR_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db } = ctx;
  const rows = await db.investorChatGroup.findMany({ where: { investorId, unassignedAt: null }, orderBy: { id: 'asc' } });
  const roomNames = await roomNameMap(db, rows.map((r) => r.roomId));
  const data: InvestorChatGroupDto[] = rows.map((r) => ({
    id: r.id,
    investorId: r.investorId,
    roomId: r.roomId,
    roomName: r.roomId != null ? (roomNames.get(r.roomId) ?? '(nhóm đã xóa)') : null,
    name: r.name,
    link: r.link,
    qr: r.qr,
    note: r.note
  }));
  return { ok: true, data };
}

/**
 * INVESTOR_VIEW — PICKER cho dropdown ở form TK nhận tiền: nhóm chat ĐANG GÁN (active) của ĐÚNG NĐT `investorId`.
 * Tên hiển thị = name (nếu có) → tên phòng (join) → 'Nhóm chưa đặt tên'. Sắp theo id tăng dần (thứ tự tạo).
 */
export async function listAssignableInvestorChatGroups(ctx: ServiceCtx, investorId: number): Promise<ListAssignableInvestorChatGroupsResult> {
  if (!hasPermission(ctx.user, 'INVESTOR_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db } = ctx;
  const rows = await db.investorChatGroup.findMany({ where: { investorId, unassignedAt: null }, orderBy: { id: 'asc' } });
  const roomNames = await roomNameMap(db, rows.map((r) => r.roomId));
  const data: InvestorChatGroupOptionDto[] = rows.map((r) => ({
    id: r.id,
    name: (r.name?.trim() || (r.roomId != null ? (roomNames.get(r.roomId)?.trim() ?? '') : '') || 'Nhóm chưa đặt tên')
  }));
  return { ok: true, data };
}

/** Validate roomId (nếu có): phòng tồn tại + còn sống + KHÔNG bị 1 kỳ ACTIVE khác của CÙNG NĐT chiếm (excludeId để sửa). */
async function assertRoomAssignable(db: Db, investorId: number, roomId: string | null, excludeId?: number): Promise<MutationResult | null> {
  if (roomId == null) return null;
  const roomOk = await assertChatRoomExists(db, roomId);
  if (!roomOk) return { ok: false, error: 'VALIDATION', message: 'Phòng chat được chọn không tồn tại (hoặc đã bị xóa). Vui lòng chọn lại.' };
  // FIX INV-1: 1 phòng = 1 nhà đầu tư. Bỏ scope investorId khỏi dup-check để CHẶN cả khi phòng đang ACTIVE cho NĐT KHÁC
  // (không chỉ trùng trong cùng NĐT). Giữ excludeId cho luồng SỬA chính nhóm này.
  const dup = await db.investorChatGroup.findFirst({
    where: { roomId, unassignedAt: null, ...(excludeId != null ? { id: { not: excludeId } } : {}) },
    select: { id: true }
  });
  if (dup) return { ok: false, error: 'VALIDATION', message: 'Phòng chat này đã là nhóm của một nhà đầu tư khác. Vui lòng chọn phòng khác.' };
  return null;
}

/** INVESTOR_UPDATE — tạo 1 nhóm chat cho NĐT (mở kỳ mới, assignedFrom = now). */
export async function createInvestorChatGroup(ctx: ServiceCtx, investorId: number, input: InvestorChatGroupInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'INVESTOR_UPDATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const badInv = await assertInvestorValid(db, investorId);
  if (badInv) return badInv;
  const roomId = normStr(input.roomId);
  const roomErr = await assertRoomAssignable(db, investorId, roomId);
  if (roomErr) return roomErr;
  // Fix audit #5a (25/8): mutation + audit ATOMIC trong $transaction (khớp chuẩn investor.ts) — audit lỗi thì
  // rollback cả tạo nhóm, không commit thiếu dấu vết. #5b: bắt lỗi UNIQUE 1-phần room_id (race 2 admin gán cùng
  // phòng) → map về thông báo cũ (assertRoomAssignable chỉ chặn tuần tự).
  try {
    const created = await db.$transaction(async (tx) => {
      const c = await tx.investorChatGroup.create({
        data: { investorId, roomId, name: normStr(input.name), link: normStr(input.link), qr: normStr(input.qr), note: normStr(input.note), assignedFrom: new Date(), createdBy: user.id }
      });
      await writeAudit(tx, { actorUserId: user.id, action: 'INVESTOR_UPDATED', targetType: 'Investor', targetId: String(investorId), after: { chatGroupCreated: { id: c.id, roomId, name: normStr(input.name) } } });
      return c;
    });
    return { ok: true, id: created.id };
  } catch (err) {
    if (isRoomActiveUniqueViolation(err)) return { ok: false, error: 'VALIDATION', message: 'Phòng chat này đã là nhóm của một nhà đầu tư khác. Vui lòng chọn phòng khác.' };
    throw err;
  }
}

/** Prisma unique-constraint (P2002) trên index room-active — dùng bắt race gán trùng phòng (audit #5b). */
function isRoomActiveUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/** INVESTOR_UPDATE — sửa 1 nhóm chat (chỉ nhóm ĐANG GÁN). Đổi roomId → validate lại (phòng sống + không trùng). */
export async function updateInvestorChatGroup(ctx: ServiceCtx, id: number, input: InvestorChatGroupInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'INVESTOR_UPDATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const row = await db.investorChatGroup.findUnique({ where: { id } });
  if (!row || row.unassignedAt != null) return { ok: false, error: 'NOT_FOUND', message: 'Nhóm chat không tồn tại (hoặc đã bị xóa).' };
  const roomId = input.roomId !== undefined ? normStr(input.roomId) : row.roomId;
  if (input.roomId !== undefined && roomId !== row.roomId) {
    const roomErr = await assertRoomAssignable(db, row.investorId, roomId, id);
    if (roomErr) return roomErr;
  }
  // Fix audit #5a (25/8): mutation + audit ATOMIC. #5b: bắt race unique room.
  try {
    await db.$transaction(async (tx) => {
      await tx.investorChatGroup.update({
        where: { id },
        data: {
          roomId,
          name: input.name !== undefined ? normStr(input.name) : row.name,
          link: input.link !== undefined ? normStr(input.link) : row.link,
          qr: input.qr !== undefined ? normStr(input.qr) : row.qr,
          note: input.note !== undefined ? normStr(input.note) : row.note
        }
      });
      await writeAudit(tx, { actorUserId: user.id, action: 'INVESTOR_UPDATED', targetType: 'Investor', targetId: String(row.investorId), after: { chatGroupUpdated: { id, roomId } } });
    });
    return { ok: true, id };
  } catch (err) {
    if (isRoomActiveUniqueViolation(err)) return { ok: false, error: 'VALIDATION', message: 'Phòng chat này đã là nhóm của một nhà đầu tư khác. Vui lòng chọn phòng khác.' };
    throw err;
  }
}

/** INVESTOR_UPDATE — "xóa" 1 nhóm chat = ĐÓNG KỲ (set unassignedAt = now), GIỮ hàng lịch sử. */
export async function deleteInvestorChatGroup(ctx: ServiceCtx, id: number): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'INVESTOR_UPDATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const row = await db.investorChatGroup.findUnique({ where: { id } });
  if (!row || row.unassignedAt != null) return { ok: false, error: 'NOT_FOUND', message: 'Nhóm chat không tồn tại (hoặc đã bị xóa).' };
  // Fix audit #5a (25/8): đóng kỳ + audit ATOMIC.
  await db.$transaction(async (tx) => {
    await tx.investorChatGroup.update({ where: { id }, data: { unassignedAt: new Date() } });
    await writeAudit(tx, { actorUserId: user.id, action: 'INVESTOR_UPDATED', targetType: 'Investor', targetId: String(row.investorId), after: { chatGroupDeleted: { id, roomId: row.roomId } } });
  });
  return { ok: true, id };
}
