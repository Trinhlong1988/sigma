// CẤU HÌNH "Nhóm chat theo loại phí của khách hàng" — LÕI THUẦN ctx-based (khuôn customer.ts). 1 khách hàng có
// tối đa N nhóm chat ĐANG GÁN, MỖI nhóm ứng ĐÚNG 1 LOẠI PHÍ (FeeType). Nhóm = phòng NỘI BỘ SigMa (roomId →
// ChatRoom type='GROUP'), lưu kèm link + QR để hiển thị. SigMa = nguồn cấu hình cơ sở.
//
// MÔ HÌNH KỲ (Admin Demo 5/8): mỗi hàng CustomerChatGroup = 1 KỲ gán, `assignedFrom`..`unassignedAt` (null=active).
// MIRROR ChatRoomTid.createdAt/unlinkedAt + tid_sell_fees hiệu-lực-theo-kỳ — doanh số/OCR/TID quy về ĐÚNG nhóm
// đang gán TẠI THỜI ĐIỂM phát sinh. Partial-unique (customerId, feeTypeId) WHERE unassigned_at IS NULL (1 nhóm
// ACTIVE / loại phí / khách). Xem schema.prisma + migration 20260805130000_customer_chat_groups.
//   • Hủy gán   = set unassignedAt = now (đóng kỳ, GIỮ lịch sử).
//   • Đổi nhóm  = đóng kỳ nhóm cũ + mở kỳ mới (hàng mới, assignedFrom = now).
//   • Gán lại   = mở kỳ mới (kỳ cũ đã unassignedAt → KHÔNG bị unique chặn).
//
// Quyền: list = CUSTOMER_VIEW; set = CUSTOMER_UPDATE HOẶC CUSTOMER_CREATE; picker = CUSTOMER_VIEW. Validate tiếng
// Việt (§E). Audit CUSTOMER_UPDATED. $transaction ATOMIC. Scalar join (feeTypeId → FeeType.name; roomId → ChatRoom)
// — cùng triết lý schema (no hard FK, join tại service).
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { assertChatRoomExists } from './chat-room-tid.js';
import type { ServiceCtx, MutationResult } from './customer.js';
// TÌM KIẾM hoa/thường: DB collation "C" → Prisma mode:'insensitive' (ILIKE) KHÔNG gập chữ tiếng Việt có dấu
// (đo thật trên sổ thật: ILIKE '%nguyễn%' = 0 dòng / ILIKE '%NGUYỄN%' = 10 dòng). Xem tim-kiem-hoa-thuong.ts.
import { dieuKienTimKiem } from './tim-kiem-hoa-thuong.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

export interface CustomerChatGroupDto {
  id: number;
  feeTypeId: number;
  feeTypeName: string;
  roomId: string | null;
  roomName: string | null; // tên phòng GROUP (join ChatRoom) — hiển thị trong danh sách cấu hình của khách
  link: string | null;
  qr: string | null;
  note: string | null;
  zaloGroupId: string | null; // groupId Zalo dán tay (watcher lấy bill nhóm Zalo này → phòng + doanh số khách này)
}

/** 1 nhóm chat gửi lên khi cấu hình — khớp theo feeTypeId (1 loại phí = 1 nhóm ACTIVE/khách). */
export interface CustomerChatGroupInput {
  feeTypeId: number;
  roomId?: string | null;
  link?: string | null;
  qr?: string | null;
  note?: string | null;
  zaloGroupId?: string | null;
}

export interface ListCustomerChatGroupsResult {
  ok: boolean;
  data?: CustomerChatGroupDto[];
  error?: string;
  message?: string;
}

/** 1 lựa chọn trong dropdown-tìm-kiếm "Nhóm chat" ở form khách — CHỈ nhóm GROUP CHƯA GÁN cho khách nào (active). */
export interface AssignableChatGroupDto {
  roomId: string;
  name: string;
}

export interface ListAssignableChatGroupsResult {
  ok: boolean;
  data?: AssignableChatGroupDto[];
  error?: string;
  message?: string;
}

/**
 * FIX-FK (khuôn assertAgentValid ở customer.ts): feeTypeId là scalar KHÔNG có FK cứng ở DB — nếu client gửi
 * feeTypeId trỏ tới loại phí KHÔNG tồn tại / đã xóa mềm → ghi thẳng thành tham chiếu MỒ CÔI. Vì vậy PHẢI validate
 * ở tầng service TRƯỚC khi ghi. Trả message VALIDATION tiếng Việt nếu sai; null nếu hợp lệ.
 */
async function assertFeeTypeValid(db: Db, feeTypeId: number): Promise<MutationResult | null> {
  if (!Number.isInteger(feeTypeId) || feeTypeId <= 0) {
    return { ok: false, error: 'VALIDATION', message: 'Loại phí không hợp lệ. Vui lòng chọn lại.' };
  }
  const fee = await db.feeType.findFirst({ where: { id: feeTypeId, deletedAt: null }, select: { id: true } });
  if (!fee) return { ok: false, error: 'VALIDATION', message: 'Loại phí được chọn không tồn tại (hoặc đã bị xóa). Vui lòng chọn lại.' };
  return null;
}

/** Chuẩn hóa roomId gửi lên: '' / undefined → null (để so kỳ cũ↔mới + ghi DB nhất quán). */
function normRoomId(v: string | null | undefined): string | null {
  return v != null && v !== '' ? v : null;
}

/** Chuẩn hóa zaloGroupId về canonical `g<digits>` (khớp key LevelDB + token tên file watcher). Nhận `g123` /
 *  `123` / `123_group` → `g123`. Dạng lạ (không phải id nhóm) → giữ nguyên (đã trim). '' → null. Watcher gửi
 *  cùng dạng canonical → khớp DB chính xác dù admin dán kiểu nào. */
function normZaloGroupId(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  if (!t) return null;
  const m = t.match(/^g?(\d+)(?:_group)?$/i);
  return m ? `g${m[1]}` : t;
}

/** CUSTOMER_VIEW — liệt kê nhóm chat ĐANG GÁN (kỳ active) của 1 khách, kèm TÊN loại phí + TÊN phòng (join). */
export async function listCustomerChatGroups(ctx: ServiceCtx, customerId: number): Promise<ListCustomerChatGroupsResult> {
  if (!hasPermission(ctx.user, 'CUSTOMER_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db } = ctx;

  const rows = await db.customerChatGroup.findMany({ where: { customerId, unassignedAt: null }, orderBy: { id: 'asc' } });
  const feeTypeIds = [...new Set(rows.map((r) => r.feeTypeId))];
  const feeTypes = feeTypeIds.length > 0 ? await db.feeType.findMany({ where: { id: { in: feeTypeIds } }, select: { id: true, name: true } }) : [];
  const feeNameById = new Map(feeTypes.map((f) => [f.id, f.name]));

  const roomIds = [...new Set(rows.map((r) => r.roomId).filter((x): x is string => x != null))];
  const rooms = roomIds.length > 0 ? await db.chatRoom.findMany({ where: { id: { in: roomIds } }, select: { id: true, name: true } }) : [];
  const roomNameById = new Map(rooms.map((r) => [r.id, r.name]));

  const data: CustomerChatGroupDto[] = rows.map((r) => ({
    id: r.id,
    feeTypeId: r.feeTypeId,
    feeTypeName: feeNameById.get(r.feeTypeId) ?? '(loại phí đã xóa)',
    roomId: r.roomId,
    roomName: r.roomId != null ? (roomNameById.get(r.roomId) ?? '(nhóm đã xóa)') : null,
    link: r.link,
    qr: r.qr,
    note: r.note,
    zaloGroupId: r.zaloGroupId ?? null
  }));
  return { ok: true, data };
}

/**
 * CUSTOMER_VIEW — PICKER: danh sách nhóm chat GROUP (ChatRoom type='GROUP', deletedAt null) CHƯA được gán cho khách
 * nào (KHÔNG có KỲ ACTIVE nào — unassignedAt IS NULL — trỏ tới roomId). Đúng ý Admin Demo: dropdown gán-MỚI chỉ hiện
 * nhóm còn trống; nhóm đã gán KHÔNG xuất hiện (muốn đổi/hủy thì thao tác ở danh sách cấu hình của khách). Tìm kiếm
 * gợi ý theo `search`: khớp TÊN (contains, không phân biệt hoa/thường) HOẶC id (contains). Sắp theo tên. `limit`
 * mặc định 50 (chặn tối đa 100) — dropdown gợi ý không cần trả toàn bộ.
 */
export async function listAssignableChatGroups(
  ctx: ServiceCtx,
  opts?: { search?: string | null; limit?: number | null }
): Promise<ListAssignableChatGroupsResult> {
  if (!hasPermission(ctx.user, 'CUSTOMER_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db } = ctx;

  const search = (opts?.search ?? '').trim();
  const rawLimit = opts?.limit;
  const limit = Number.isInteger(rawLimit) && (rawLimit as number) > 0 ? Math.min(rawLimit as number, 100) : 50;

  // roomId đang bị 1 KỲ ACTIVE nào đó chiếm (bất kỳ khách nào) → loại khỏi danh sách gán-mới.
  const activeRows = await db.customerChatGroup.findMany({ where: { unassignedAt: null, roomId: { not: null } }, select: { roomId: true } });
  const takenRoomIds = [...new Set(activeRows.map((r) => r.roomId).filter((x): x is string => x != null))];

  // `id.notIn` (loại nhóm đã gán) ở top-level + mệnh đề tìm kiếm ở `AND` → Prisma AND chúng lại.
  // Tìm kiếm KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts — collation "C" làm ILIKE vô dụng
  // với tên nhóm tiếng Việt). Truy vấn tham số hóa → an toàn injection.
  const where: Record<string, unknown> = { type: 'GROUP', deletedAt: null };
  if (takenRoomIds.length > 0) where['id'] = { notIn: takenRoomIds };
  const dkTim = await dieuKienTimKiem(db, 'chat_rooms', { name: 'name', id: 'id' }, search);
  if (dkTim) where['AND'] = dkTim;

  const rooms = await db.chatRoom.findMany({
    where: where as never,
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
    take: limit
  });

  const data: AssignableChatGroupDto[] = rooms.map((r) => ({ roomId: r.id, name: r.name?.trim() || 'Nhóm chưa đặt tên' }));
  return { ok: true, data };
}

/**
 * CUSTOMER_UPDATE hoặc CUSTOMER_CREATE — đặt TRỌN danh sách nhóm chat ĐANG GÁN của 1 khách khớp `rows` gửi lên
 * theo MÔ HÌNH KỲ:
 *   • loại phí mới (chưa có kỳ active)             → mở kỳ mới (create, assignedFrom = now).
 *   • loại phí đã có kỳ active, ĐỔI roomId         → ĐÓNG kỳ cũ (unassignedAt = now) + MỞ kỳ mới (Đổi nhóm).
 *   • loại phí đã có kỳ active, GIỮ nguyên roomId  → update link/qr/note tại chỗ (KHÔNG mở kỳ mới).
 *   • loại phí có kỳ active nhưng KHÔNG còn trong danh sách gửi → ĐÓNG kỳ (Hủy gán).
 * Validate (tiếng Việt): khách tồn tại; KHÔNG trùng feeTypeId trong cùng 1 lần gửi; feeTypeId tồn tại; roomId nếu
 * có phải là ChatRoom tồn tại + đang sống (assertChatRoomExists TÁI DÙNG). ATOMIC $transaction. Audit CUSTOMER_UPDATED.
 */
export async function setCustomerChatGroups(ctx: ServiceCtx, customerId: number, rows: CustomerChatGroupInput[]): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'CUSTOMER_UPDATE') && !hasPermission(ctx.user, 'CUSTOMER_CREATE')) {
    return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  }
  const { db, user } = ctx;
  const list = Array.isArray(rows) ? rows : [];

  const customer = await db.customer.findUnique({ where: { id: customerId }, select: { id: true, deletedAt: true } });
  if (!customer || customer.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Khách hàng không tồn tại.' };

  // Chống trùng loại phí trong CÙNG 1 lần gửi (1 loại phí = 1 nhóm ACTIVE/khách — nếu không chặn, 2 hàng cùng
  // feeType sẽ đá nhau ở partial-unique / ghi đè lẫn nhau khó lường).
  const seen = new Set<number>();
  for (const r of list) {
    if (seen.has(r.feeTypeId)) {
      return { ok: false, error: 'VALIDATION', message: 'Mỗi loại phí chỉ được cấu hình 1 nhóm chat cho khách. Vui lòng bỏ loại phí bị trùng.' };
    }
    seen.add(r.feeTypeId);
  }

  // Validate feeTypeId + roomId TRƯỚC khi mở transaction (lỗi rõ trước khi ghi).
  for (const r of list) {
    const badFee = await assertFeeTypeValid(db, r.feeTypeId);
    if (badFee) return badFee;
    const roomId = normRoomId(r.roomId);
    if (roomId != null) {
      const roomOk = await assertChatRoomExists(db, roomId);
      if (!roomOk) return { ok: false, error: 'VALIDATION', message: 'Phòng chat được chọn không tồn tại (hoặc đã bị xóa). Vui lòng chọn lại.' };
    }
  }

  // BẤT BIẾN "1 groupId Zalo → 1 phòng SigMa" (chống định tuyến bill sai — matchRoomByZaloGroupId chọn 1 phòng).
  // (a) Không 2 dòng trong CÙNG lần gửi dùng chung 1 zaloGroupId cho 2 phòng khác nhau. (b) Không đụng zaloGroupId
  // đang được 1 kỳ ACTIVE khác (khách/phòng khác) giữ.
  const submittedZalo = new Map<string, string | null>(); // zaloGroupId → roomId trong lần gửi
  for (const r of list) {
    const zid = normZaloGroupId(r.zaloGroupId);
    if (!zid) continue;
    const roomId = normRoomId(r.roomId);
    if (submittedZalo.has(zid) && submittedZalo.get(zid) !== roomId) {
      return { ok: false, error: 'VALIDATION', message: `GroupId Zalo "${zid}" đang bị gán cho 2 nhóm khác nhau trong cùng khách. Mỗi nhóm Zalo chỉ ứng 1 phòng.` };
    }
    submittedZalo.set(zid, roomId);
    const clash = await db.customerChatGroup.findFirst({
      where: { zaloGroupId: zid, unassignedAt: null, NOT: { customerId } },
      select: { customerId: true, roomId: true }
    });
    if (clash) {
      return { ok: false, error: 'VALIDATION', message: `GroupId Zalo "${zid}" đã được gán cho khách khác (mã KH ${clash.customerId}). Mỗi nhóm Zalo chỉ ứng 1 phòng.` };
    }
  }

  const existing = await db.customerChatGroup.findMany({ where: { customerId, unassignedAt: null } });
  const existingByFee = new Map(existing.map((e) => [e.feeTypeId, e]));
  const keepFeeIds = new Set(list.map((r) => r.feeTypeId));
  const now = new Date();

  await db.$transaction(async (tx) => {
    for (const r of list) {
      const roomId = normRoomId(r.roomId);
      const link = r.link ?? null;
      const qr = r.qr ?? null;
      const note = r.note ?? null;
      const zaloGroupId = normZaloGroupId(r.zaloGroupId);
      const cur = existingByFee.get(r.feeTypeId);
      if (cur) {
        if (normRoomId(cur.roomId) !== roomId) {
          // ĐỔI NHÓM: đóng kỳ cũ + mở kỳ mới (attribution doanh số cũ giữ ở kỳ đã đóng).
          await tx.customerChatGroup.update({ where: { id: cur.id }, data: { unassignedAt: now } });
          await tx.customerChatGroup.create({ data: { customerId, feeTypeId: r.feeTypeId, roomId, link, qr, note, zaloGroupId, assignedFrom: now, createdBy: user.id } });
        } else {
          // GIỮ nhóm: cập nhật link/qr/note + zaloGroupId tại chỗ (KHÔNG mở kỳ mới — cùng nhóm, không đổi attribution).
          await tx.customerChatGroup.update({ where: { id: cur.id }, data: { link, qr, note, zaloGroupId } });
        }
      } else {
        // MỞ KỲ MỚI. Kỳ đã đóng (unassignedAt != null) cùng (customerId,feeTypeId) — nếu có — KHÔNG chặn vì
        // partial-unique chỉ tính unassigned_at IS NULL; giữ chúng làm lịch sử kỳ.
        await tx.customerChatGroup.create({ data: { customerId, feeTypeId: r.feeTypeId, roomId, link, qr, note, zaloGroupId, assignedFrom: now, createdBy: user.id } });
      }
    }
    // HỦY GÁN: đóng kỳ các nhóm còn active nhưng không còn trong danh sách gửi lên.
    for (const e of existing) {
      if (!keepFeeIds.has(e.feeTypeId)) {
        await tx.customerChatGroup.update({ where: { id: e.id }, data: { unassignedAt: now } });
      }
    }
  });

  await writeAudit(db, {
    actorUserId: user.id,
    action: 'CUSTOMER_UPDATED',
    targetType: 'Customer',
    targetId: String(customerId),
    after: { chatGroups: list.map((r) => ({ feeTypeId: r.feeTypeId, roomId: normRoomId(r.roomId) })) }
  });
  return { ok: true, id: customerId };
}
