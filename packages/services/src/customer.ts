// Customer CRUD — LÕI THUẦN ctx-based (CÁCH 2). PORT nghiệp vụ từ apps/desktop/src/main/customer-service.ts
// nhưng KHÔNG phụ thuộc Electron: thay `requirePermission(current-user global)` bằng ctx = { db, user } do adapter
// (desktop IPC HOẶC route API) dựng sẵn. Mỗi hàm tự kiểm quyền qua hasPermission(ctx.user, ...). Business logic
// (validate tiếng Việt, transaction tạo mã KH##, audit before/after, soft-delete guard quan hệ sống) GIỮ NGUYÊN.
// IMS_SPEC §A/§D. Permission-guarded (§13), audited, soft-delete. Mã KH## auto-minted atomically; nickname (§D) MANDATORY.
// R_UX_WARN (§E): mọi thất bại trả {ok,error,message} tiếng Việt cụ thể.
import { auditSnapshot } from '@sigma/business-rules';
import { hasPermission, type AuthUser } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { staleGuard } from './optimistic-lock.js';
import { nextCode } from './code.js';
// TÌM KIẾM hoa/thường: DB collation "C" → Prisma mode:'insensitive' (ILIKE) KHÔNG gập chữ tiếng Việt có dấu
// (đo thật trên sổ thật: ILIKE '%nguyễn%' = 0 dòng / ILIKE '%NGUYỄN%' = 10 dòng). Xem tim-kiem-hoa-thuong.ts.
import { dieuKienTimKiem } from './tim-kiem-hoa-thuong.js';

/** Ngữ cảnh 1 lời gọi service: Prisma client + user đã xác thực (adapter dựng). Thay cho current-user global. */
export interface ServiceCtx {
  db: Db;
  user: AuthUser;
}

export interface CustomerDto {
  id: number;
  code: string;
  fullName: string;
  nickname: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  agentId: number | null;
  note: string | null;
  status: string; // ACTIVE | LOCKED | CANCELLED
  /** `KH03 · Anh Thanh Hải Phòng (Nguyễn Văn Thanh)` (§D). */
  display: string;
  // Nhóm chat SigMa đang LIÊN KẾT (Admin Demo 11/8): tên phòng của các CustomerChatGroup active có roomId (join
  // ChatRoom.name). `[]` = CHƯA liên kết (hiển thị đỏ + chấm đỏ). ≥1 = đã liên kết (chấm xanh, hiện tên).
  chatGroupNames: string[];
  hasChatGroup: boolean;
  createdAt: string;
  updatedAt: string; // R48 #2 optimistic-lock — client echo lại khi Lưu để chống sửa đè
}

export interface MutationResult {
  ok: boolean;
  error?: string;
  message?: string;
  id?: number;
  /** Non-fatal cảnh báo kèm khi ok:true (vd giao TID thành công nhưng chưa lưu được giá bán thực tế). */
  warning?: string;
}

export interface CustomerFilter {
  search?: string;
  agentId?: number;
  status?: string; // ACTIVE | LOCKED | CANCELLED. Bỏ trống = ẩn CANCELLED (chỉ ACTIVE + LOCKED).
  /** ISO date bounds on createdAt (R_UX_FILTER). */
  fromDate?: string;
  toDate?: string;
  // FIX-PERF B132 — phân trang (khuôn listTransactions). Client KHÔNG gửi → vẫn trả trang 1 nhưng CÓ take mặc
  // định (pageSize 100, max 500) để chặn seq-scan/kéo full-bảng. Trả kèm {total,page,pageSize}.
  page?: number;
  pageSize?: number;
}

/** FIX-PERF B132 — kết quả list khách có phân trang. `data` GIỮ nguyên shape cũ (renderer đọc .data không vỡ). */
export interface ListCustomersResult {
  ok: boolean;
  data?: CustomerDto[];
  total?: number;
  page?: number;
  pageSize?: number;
  error?: string;
  message?: string;
}

const CUSTOMER_PAGE_SIZE_DEFAULT = 100;
const CUSTOMER_PAGE_SIZE_MAX = 500;

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

/** Build a Prisma date range from optional ISO strings; `toDate` is inclusive (end-of-day). */
/**
 * [B262 24/11 — audit đa-agent] BIÊN KỲ THEO NGÀY ĐỊA PHƯƠNG, nửa mở [gte, lt).
 *
 * TRƯỚC ĐÂY: `new Date('2026-11-24')` là nửa đêm **UTC** = 07:00 giờ VN ⇒ cửa sổ "ngày 24/11" thật ra
 * chạy 07:00 hôm nay → 07:00 hôm sau. Hệ quả đo được trên sổ thật: 6 TID mở trong khoảng 00:00–07:00
 * giờ VN KHÔNG lọt vào đúng ngày của nó, còn TID mở 03:00 NGÀY MAI thì lọt nhầm vào hôm nay.
 * Lỗi này nằm chung lớp với B257 (SQL `date AT TIME ZONE` phụ thuộc múi giờ phiên) nhưng ở TẦNG JS,
 * và hàm này được 35 chỗ dùng chung (TID, khách, hồ sơ, POS, kho, tài khoản nhận tiền…) nên vá TẠI GỐC.
 *
 * `new Date(y, m-1, d)` = nửa đêm theo múi giờ MÁY CHỦ (Asia/Bangkok = giờ VN) — đúng ý "ngày Việt Nam".
 * Dùng `lt` (nửa mở) thay `lte` cuối-ngày-trừ-1ms: không bỏ sót mốc 23:59:59.9xx.
 */
export function dateRange(fromDate?: string, toDate?: string): { gte?: Date; lt?: Date } | undefined {
  const nuaDem = (s: string, congNgay: number): Date | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + congNgay);
    return isNaN(d.getTime()) ? null : d;
  };
  const gte = fromDate ? nuaDem(fromDate, 0) : null;
  const lt = toDate ? nuaDem(toDate, 1) : null;
  if (!gte && !lt) return undefined;
  return { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
}

function toDto(c: {
  id: number;
  code: string;
  fullName: string;
  nickname: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  agentId: number | null;
  note: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}, chatGroupNames: string[] = []): CustomerDto {
  return {
    id: c.id,
    code: c.code,
    fullName: c.fullName,
    nickname: c.nickname,
    phone: c.phone,
    email: c.email,
    address: c.address,
    agentId: c.agentId,
    note: c.note,
    status: c.status,
    display: `${c.code} · ${c.nickname} (${c.fullName})`,
    chatGroupNames,
    hasChatGroup: chatGroupNames.length > 0,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString()
  };
}

/** CUSTOMER_VIEW — list customers (excludes soft-deleted), with search + agent filter + phân trang (FIX-PERF B132). */
export async function listCustomers(ctx: ServiceCtx, filter: CustomerFilter = {}): Promise<ListCustomersResult> {
  if (!hasPermission(ctx.user, 'CUSTOMER_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  // Record<string, unknown> (khuôn buildWhere ở transaction.ts) — tách where ra biến để count + findMany DÙNG CHUNG.
  const where: Record<string, unknown> = {
    deletedAt: null,
    // Lọc trạng thái: chọn rõ → đúng trạng thái đó; bỏ trống → ẩn CANCELLED (đã hủy) khỏi list mặc định.
    status: filter.status ? filter.status : { not: 'CANCELLED' },
    agentId: filter.agentId ?? undefined,
    createdAt: dateRange(filter.fromDate, filter.toDate),
    // Tìm kiếm mã/biệt danh/tên/SĐT — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts).
    AND: await dieuKienTimKiem(ctx.db, 'customers', { code: 'code', nickname: 'nickname', fullName: 'full_name', phone: 'phone' }, filter.search)
  };
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(CUSTOMER_PAGE_SIZE_MAX, Math.max(1, filter.pageSize ?? CUSTOMER_PAGE_SIZE_DEFAULT));
  const total = await ctx.db.customer.count({ where });
  const rows = await ctx.db.customer.findMany({ where, orderBy: { id: 'asc' }, skip: (page - 1) * pageSize, take: pageSize });

  // Nhóm chat SigMa đã LIÊN KẾT (Admin Demo 11/8) — 1 findMany kỳ-active có roomId cho TẤT CẢ khách trong trang (KHÔNG
  // N+1) + 1 findMany join tên phòng. `hasChatGroup`/`chatGroupNames` để UI hiện tên + chấm xanh/đỏ trước trạng thái.
  const custIds = rows.map((r) => r.id);
  const namesByCustomer = new Map<number, string[]>();
  if (custIds.length > 0) {
    const groups = await ctx.db.customerChatGroup.findMany({
      where: { customerId: { in: custIds }, unassignedAt: null, roomId: { not: null } },
      select: { customerId: true, roomId: true },
      orderBy: { id: 'asc' }
    });
    const roomIds = [...new Set(groups.map((g) => g.roomId).filter((x): x is string => x != null))];
    const rooms = roomIds.length > 0 ? await ctx.db.chatRoom.findMany({ where: { id: { in: roomIds } }, select: { id: true, name: true } }) : [];
    const roomNameById = new Map(rooms.map((r) => [r.id, (r.name ?? '').trim() || 'Nhóm chưa đặt tên']));
    for (const g of groups) {
      if (g.roomId == null) continue;
      const nm = roomNameById.get(g.roomId) ?? '(nhóm đã xóa)';
      const arr = namesByCustomer.get(g.customerId);
      if (arr) arr.push(nm);
      else namesByCustomer.set(g.customerId, [nm]);
    }
  }

  return { ok: true, data: rows.map((r) => toDto(r, namesByCustomer.get(r.id) ?? [])), total, page, pageSize };
}

/**
 * CUSTOMER_VIEW — bộ đếm TOÀN CỤC (độc lập bộ lọc list): tổng + theo trạng thái + chưa gán đại lý + theo đại lý.
 * Đếm trên `deletedAt: null` (chưa xóa). `total` = tất cả chưa xóa (gồm cả CANCELLED). Dùng cho dash StatBar
 * để "Đã khóa"/"Đã hủy" LUÔN hiện đúng số, không bị lệch vì list mặc định ẩn CANCELLED.
 */
export async function countCustomers(ctx: ServiceCtx): Promise<{
  ok: boolean;
  data?: { total: number; active: number; locked: number; cancelled: number; unassigned: number; byAgent: { agentId: number; count: number }[] };
  error?: string;
  message?: string;
}> {
  if (!hasPermission(ctx.user, 'CUSTOMER_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const [total, active, locked, cancelled, unassigned, grouped] = await Promise.all([
    db.customer.count({ where: { deletedAt: null } }),
    db.customer.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
    db.customer.count({ where: { deletedAt: null, status: 'LOCKED' } }),
    db.customer.count({ where: { deletedAt: null, status: 'CANCELLED' } }),
    db.customer.count({ where: { deletedAt: null, agentId: null } }),
    db.customer.groupBy({ by: ['agentId'], where: { deletedAt: null, agentId: { not: null } }, _count: { _all: true } })
  ]);
  const byAgent = grouped
    .filter((row): row is typeof row & { agentId: number } => row.agentId !== null)
    .map((row) => ({ agentId: row.agentId, count: row._count._all }));
  return { ok: true, data: { total, active, locked, cancelled, unassigned, byAgent } };
}

export interface CreateCustomerInput {
  fullName: string;
  nickname: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  agentId?: number | null;
  note?: string | null;
  status?: string;
}

const CUSTOMER_STATUSES = ['ACTIVE', 'LOCKED', 'CANCELLED'];
function normCustomerStatus(s: string | undefined, fallback: string): string {
  return s !== undefined && CUSTOMER_STATUSES.includes(s) ? s : fallback;
}

/**
 * FIX-FK (5/8, finding QA 5-agent): `Customer.agentId` là scalar KHÔNG có FK cứng ở DB (triết lý schema
 * "no hard FK, join tại service"). Nếu adapter/client gửi agentId trỏ tới đại lý KHÔNG tồn tại / đã xóa mềm →
 * ghi thẳng thành tham chiếu MỒ CÔI (không lỗi DB nào chặn). Vì vậy PHẢI validate ở tầng service TRƯỚC khi ghi.
 * null/undefined = "không gán / giữ nguyên" → hợp lệ, KHÔNG kiểm. Chỉ kiểm khi agentId là số thật.
 * Trả message VALIDATION tiếng Việt nếu sai; null nếu hợp lệ.
 */
async function assertAgentValid(db: Db, agentId: number | null | undefined): Promise<MutationResult | null> {
  if (agentId === null || agentId === undefined) return null;
  const agent = await db.agent.findFirst({ where: { id: agentId, deletedAt: null }, select: { id: true } });
  if (!agent) return { ok: false, error: 'VALIDATION', message: 'Đại lý được chọn không tồn tại (hoặc đã bị xóa). Vui lòng chọn lại.' };
  return null;
}

/** CUSTOMER_CREATE — auto KH## + mandatory nickname (§D) + audit CUSTOMER_CREATED. */
export async function createCustomer(ctx: ServiceCtx, input: CreateCustomerInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'CUSTOMER_CREATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  if (!input.fullName?.trim()) return { ok: false, error: 'VALIDATION', message: 'Tên thật khách hàng bắt buộc.' };
  if (!input.nickname?.trim()) {
    return { ok: false, error: 'VALIDATION', message: 'Biệt danh (tên dễ gọi) của khách hàng là bắt buộc.' };
  }
  // FIX-FK: chặn gán khách vào đại lý không tồn tại/đã xóa (agentId scalar không FK — xem assertAgentValid).
  const badAgent = await assertAgentValid(db, input.agentId);
  if (badAgent) return badAgent;

  const created = await db.$transaction(async (tx) => {
    const code = await nextCode(tx, 'KH');
    return tx.customer.create({
      data: {
        code,
        fullName: input.fullName.trim(),
        nickname: input.nickname.trim(),
        phone: input.phone ?? null,
        email: input.email || null,
        address: input.address ?? null,
        agentId: input.agentId ?? null,
        note: input.note ?? null,
        status: normCustomerStatus(input.status, 'ACTIVE'),
        createdBy: user.id
      }
    });
  });

  await writeAudit(db, {
    actorUserId: user.id,
    action: 'CUSTOMER_CREATED',
    targetType: 'Customer',
    targetId: String(created.id),
    after: auditSnapshot({ code: created.code, fullName: created.fullName, nickname: created.nickname, phone: created.phone })
  });
  return { ok: true, id: created.id };
}

export interface UpdateCustomerInput {
  fullName?: string;
  nickname?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  agentId?: number | null;
  note?: string | null;
  status?: string;
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock — mốc updatedAt client giữ lúc mở form
}

/** CUSTOMER_UPDATE — nickname stays mandatory; audit before/after (R_AUDIT_002). Code is immutable. */
export async function updateCustomer(ctx: ServiceCtx, id: number, input: UpdateCustomerInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'CUSTOMER_UPDATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const row = await db.customer.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Khách hàng không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;

  if (input.fullName !== undefined && !input.fullName.trim()) {
    return { ok: false, error: 'VALIDATION', message: 'Tên thật khách hàng không được để trống.' };
  }
  if (input.nickname !== undefined && !input.nickname.trim()) {
    return { ok: false, error: 'VALIDATION', message: 'Biệt danh (tên dễ gọi) của khách hàng là bắt buộc.' };
  }
  // FIX-FK: đổi đại lý khi Sửa cũng phải trỏ đại lý có thật (chỉ kiểm khi client GỬI agentId là số; null = gỡ gán).
  const badAgent = await assertAgentValid(db, input.agentId);
  if (badAgent) return badAgent;

  const before = auditSnapshot({
    fullName: row.fullName,
    nickname: row.nickname,
    phone: row.phone,
    email: row.email,
    address: row.address,
    agentId: row.agentId,
    note: row.note,
    status: row.status
  });

  const updated = await db.customer.update({
    where: { id },
    data: {
      fullName: input.fullName?.trim() ?? row.fullName,
      nickname: input.nickname?.trim() ?? row.nickname,
      phone: input.phone !== undefined ? input.phone : row.phone,
      email: input.email !== undefined ? input.email || null : row.email,
      address: input.address !== undefined ? input.address : row.address,
      agentId: input.agentId !== undefined ? input.agentId : row.agentId,
      note: input.note !== undefined ? input.note : row.note,
      status: normCustomerStatus(input.status, row.status)
    }
  });

  await writeAudit(db, {
    actorUserId: user.id,
    action: 'CUSTOMER_UPDATED',
    targetType: 'Customer',
    targetId: String(id),
    before,
    after: auditSnapshot({
      fullName: updated.fullName,
      nickname: updated.nickname,
      phone: updated.phone,
      email: updated.email,
      address: updated.address,
      agentId: updated.agentId,
      note: updated.note,
      status: updated.status
    })
  });
  return { ok: true, id };
}

/**
 * P1-08 (invariant #7): chặn xóa khách hàng còn QUAN HỆ SỐNG để không mồ côi tham chiếu tài chính/tài sản.
 * Trả về MutationResult lỗi (IN_USE) nếu còn giữ máy POS / TID / cọc chưa tất toán; null nếu xóa được.
 * Dùng chung cho deleteCustomer (trực tiếp) LẪN entity-cancel Customer.precheck (xóa qua duyệt).
 */
export async function customerLiveRelationGuard(db: Db, id: number): Promise<MutationResult | null> {
  const holdPos = await db.posDevice.count({ where: { currentCustomerId: id, deletedAt: null } });
  if (holdPos > 0) return { ok: false, error: 'IN_USE', message: `Khách đang giữ ${holdPos} máy POS. Thu hồi máy trước khi hủy khách.` };
  const holdTid = await db.tid.count({ where: { customerId: id, deletedAt: null, deliveredAt: { not: null } } });
  if (holdTid > 0) return { ok: false, error: 'IN_USE', message: `Khách đang giữ ${holdTid} TID đã giao. Thu hồi TID trước khi hủy khách.` };
  const openDep = await db.deviceDeposit.count({ where: { customerId: id, status: 'OPEN' } });
  if (openDep > 0) return { ok: false, error: 'IN_USE', message: `Khách còn ${openDep} khoản cọc chưa tất toán. Xử lý cọc trước khi hủy khách.` };
  // REL-05 (audit 15/7, Codex) — bổ sung: phiếu yêu cầu XUẤT KHO đang chờ + NỢ MUA THIẾT BỊ (device sale)
  // chưa tất toán → chặn xóa (trước bỏ sót → xóa khách vẫn còn nợ/phiếu chờ, mồ côi tham chiếu).
  const pendingExport = await db.exportRequest.count({ where: { customerId: id, status: 'PENDING' } });
  if (pendingExport > 0) return { ok: false, error: 'IN_USE', message: `Khách còn ${pendingExport} phiếu yêu cầu xuất kho đang chờ duyệt. Xử lý trước khi hủy khách.` };
  const sales = await db.deviceSale.findMany({ where: { customerId: id, status: 'POSTED', deletedAt: null }, select: { id: true, salePrice: true } });
  if (sales.length > 0) {
    const totalSale = sales.reduce((s, x) => s + x.salePrice, 0n);
    const agg = await db.deviceSaleSettlement.aggregate({ _sum: { amount: true }, where: { deviceSaleId: { in: sales.map((x) => x.id) } } });
    if (totalSale - (agg._sum.amount ?? 0n) > 0n) return { ok: false, error: 'IN_USE', message: 'Khách còn nợ mua thiết bị chưa tất toán. Thu nợ trước khi hủy khách.' };
  }
  return null;
}

/**
 * CUSTOMER_DELETE — soft-delete + guard quan hệ sống + audit. LƯU Ý (CÁCH 2, pha 1): xác thực lại MẬT KHẨU
 * người thao tác (§14) do ADAPTER làm TRƯỚC khi gọi vào đây — core KHÔNG kiểm password (không truy cập session/hash
 * Electron). LEAD quyết cơ chế xác nhận mật khẩu ở pha 2.
 */
export async function deleteCustomer(ctx: ServiceCtx, id: number): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'CUSTOMER_DELETE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const row = await db.customer.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Khách hàng không tồn tại.' };

  // P1-08: chặn xóa khi còn giữ máy/TID/cọc (tránh mồ côi tham chiếu).
  const rel = await customerLiveRelationGuard(db, id);
  if (rel) {
    await writeAudit(db, { actorUserId: user.id, action: 'CUSTOMER_DELETED', targetType: 'Customer', targetId: String(id), after: { denied: true, reason: rel.error } });
    return rel;
  }

  await db.customer.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: user.id } });
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'CUSTOMER_DELETED',
    targetType: 'Customer',
    targetId: String(id),
    before: auditSnapshot({ code: row.code, fullName: row.fullName, nickname: row.nickname })
  });
  return { ok: true, id };
}

/** Small helper for other services / UI: agents for the dropdown. */
export async function listAgents(
  ctx: ServiceCtx
): Promise<{ ok: boolean; data?: { id: number; code: string | null; name: string; region: string | null }[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'CUSTOMER_VIEW') && !hasPermission(ctx.user, 'POS_VIEW') && !hasPermission(ctx.user, 'TID_VIEW')) {
    return { ok: false, error: 'FORBIDDEN', message: 'Bạn không có quyền xem danh sách đại lý.' };
  }
  const rows = await ctx.db.agent.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
  return { ok: true, data: rows.map((a) => ({ id: a.id, code: a.code, name: a.name, region: a.region })) };
}
