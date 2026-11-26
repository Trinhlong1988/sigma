// NHÀ ĐẦU TƯ (Admin Demo 9/8) — LÕI THUẦN ctx-based (như customer.ts). Nhà đầu tư bỏ tiền đối ứng → hưởng lãi =
// doanh số × %phí đầu tư (invest_fee_milli ×1000; 0.1%=100). userId gắn user role INVESTOR để login xem báo cáo
// của mình. Permission INVESTOR_*, audited, soft-delete. §14 xác thực mật khẩu khi XÓA do ADAPTER (route) kiểm.
import { auditSnapshot } from '@sigma/business-rules';
import { hasPermission, type AuthUser } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { staleGuard } from './optimistic-lock.js';
// TÌM KIẾM hoa/thường: DB collation "C" → Prisma mode:'insensitive' (ILIKE) KHÔNG gập chữ tiếng Việt có dấu
// (đo thật trên sổ thật: ILIKE '%nguyễn%' = 0 dòng / ILIKE '%NGUYỄN%' = 10 dòng). Xem tim-kiem-hoa-thuong.ts.
import { dieuKienTimKiem } from './tim-kiem-hoa-thuong.js';

interface ServiceCtx { db: Db; user: AuthUser }
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';
const FEE_SCALE = 1000;
// TRẦN %phí đầu tư (Money-F1, Admin Demo): 0–100% ⇒ 0–100000 milli. Chống nhập 50000000(=50 000 000%) bơm lãi khổng
// lồ (int4 overflow / lãi phi lý). Áp CHUNG cho create/update NĐT (pctToMilli) + createInvestorForUserTx.
const INVEST_FEE_MILLI_MAX = 100000;

interface MutationResult { ok: boolean; error?: string; message?: string; id?: number }
export interface InvestorDto {
  id: number; code: string; fullName: string; nickname: string; status: string;
  phone: string | null; email: string | null; address: string | null;
  // settleFeePct (%phí cài máy tất toán trên NĐT) ĐÃ BỎ (Admin Demo 11/8) — tất toán lấy phí cài máy THEO TID (per-txn).
  // Cột DB settle_fee_milli giữ nguyên để không phá migration cũ, nhưng KHÔNG còn nhập/hiển thị.
  investFeePct: number; userId: number | null; note: string | null;
  // Mục 2 (Gán tài khoản đăng nhập): username của user login gắn với NĐT (join theo userId, user chưa xóa mềm).
  // null = NĐT CHƯA có tài khoản đăng nhập (userId null HOẶC user đã bị xóa). UI dùng để hiện "đã có tài khoản: X".
  loginUsername: string | null;
  // Nhóm chat SigMa ĐANG GÁN của NĐT (Admin Demo 24/8 "cột danh sách nhóm chat đâu?") — tên nhóm (name → tên
  // phòng → 'Nhóm chưa đặt tên'). 1 NĐT thường 1 nhóm; mảng để không vỡ nếu cấu hình nhiều. [] = chưa gán.
  chatGroupNames: string[];
  createdBy: number | null; createdByName: string | null; createdAt: string;
  updatedAt: string;
}
export interface InvestorFilter { search?: string; status?: string }
export interface CreateInvestorInput { fullName: string; nickname: string; phone?: string | null; email?: string | null; address?: string | null; investFeePct?: number | null; userId?: number | null; note?: string | null }
export interface UpdateInvestorInput extends Partial<CreateInvestorInput> { status?: string; expectedUpdatedAt?: string | null }

function pctToMilli(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0) return null;
  const m = Math.round(n * FEE_SCALE);
  if (Math.abs(n * FEE_SCALE - m) > 1e-6) return null;
  if (m > INVEST_FEE_MILLI_MAX) return null; // trần 100% — chống bơm lãi (Money-F1)
  return m;
}

/** Validate userId gán cho NĐT (Money-F2): tồn tại + còn sống + CHƯA gắn NĐT khác (1 user = TỐI ĐA 1 NĐT active).
 *  excludeInvestorId = NĐT đang cập nhật (loại chính nó khi kiểm trùng). Trả message lỗi (VN) hoặc null nếu hợp lệ. */
async function validateInvestorUserId(db: Db, userId: number, excludeInvestorId?: number): Promise<string | null> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { id: true, deletedAt: true } });
  if (!u || u.deletedAt) return 'Tài khoản đăng nhập gắn nhà đầu tư không tồn tại hoặc đã bị xóa.';
  const dup = await db.investor.findFirst({
    where: { userId, deletedAt: null, ...(excludeInvestorId != null ? { NOT: { id: excludeInvestorId } } : {}) },
    select: { id: true }
  });
  if (dup) return 'Tài khoản này đã là nhà đầu tư khác (1 tài khoản chỉ gắn 1 nhà đầu tư).';
  return null;
}
async function resolveUserNames(db: Db, ids: (number | null)[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids.filter((x): x is number => typeof x === 'number'))];
  const map = new Map<number, string>();
  if (uniq.length === 0) return map;
  const users = await db.user.findMany({ where: { id: { in: uniq } }, select: { id: true, fullName: true, username: true } });
  for (const u of users) map.set(u.id, u.fullName || u.username);
  return map;
}
/** Map userId → username cho các user login gắn NĐT (CHỈ user chưa xóa mềm). 1 findMany theo distinct userId
 *  (KHÔNG N+1). Dùng để hiển thị "đã có tài khoản: X" ở DTO. */
async function resolveLoginUsernames(db: Db, ids: (number | null)[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids.filter((x): x is number => typeof x === 'number'))];
  const map = new Map<number, string>();
  if (uniq.length === 0) return map;
  const users = await db.user.findMany({ where: { id: { in: uniq }, deletedAt: null }, select: { id: true, username: true } });
  for (const u of users) map.set(u.id, u.username);
  return map;
}
/** Map investorId → tên nhóm chat ĐANG GÁN (name → tên phòng → 'Nhóm chưa đặt tên'). 2 findMany (KHÔNG N+1):
 *  nhóm active + tên phòng. CÙNG quy tắc nhãn với listInvestorChatGroups (investor-chat-group.ts). */
async function resolveInvestorChatGroupNames(db: Db, investorIds: number[]): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (investorIds.length === 0) return map;
  const groups = await db.investorChatGroup.findMany({
    where: { investorId: { in: investorIds }, unassignedAt: null },
    select: { investorId: true, roomId: true, name: true },
    orderBy: { id: 'asc' }
  });
  const roomIds = [...new Set(groups.map((g) => g.roomId).filter((x): x is string => x != null))];
  const rooms = roomIds.length > 0 ? await db.chatRoom.findMany({ where: { id: { in: roomIds } }, select: { id: true, name: true } }) : [];
  const roomName = new Map(rooms.map((r) => [r.id, r.name] as const));
  for (const g of groups) {
    const label = (g.name?.trim() || (g.roomId != null ? roomName.get(g.roomId)?.trim() ?? '' : '') || 'Nhóm chưa đặt tên');
    const arr = map.get(g.investorId) ?? [];
    arr.push(label);
    map.set(g.investorId, arr);
  }
  return map;
}

function toDto(r: { id: number; code: string; fullName: string; nickname: string; status: string; phone: string | null; email: string | null; address: string | null; investFeeMilli: number; userId: number | null; note: string | null; createdBy: number | null; createdAt: Date; updatedAt: Date }, names: Map<number, string>, loginNames: Map<number, string>, chatGroups: Map<number, string[]>): InvestorDto {
  return {
    id: r.id, code: r.code, fullName: r.fullName, nickname: r.nickname, status: r.status,
    phone: r.phone, email: r.email, address: r.address,
    investFeePct: r.investFeeMilli / FEE_SCALE, userId: r.userId, note: r.note,
    loginUsername: r.userId != null ? loginNames.get(r.userId) ?? null : null,
    chatGroupNames: chatGroups.get(r.id) ?? [],
    createdBy: r.createdBy, createdByName: r.createdBy != null ? names.get(r.createdBy) ?? null : null, createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString()
  };
}

/** INVESTOR_VIEW — danh sách nhà đầu tư (ẩn soft-deleted), lọc search + trạng thái. */
export async function listInvestors(ctx: ServiceCtx, filter: InvestorFilter = {}): Promise<{ ok: boolean; data?: InvestorDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'INVESTOR_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const s = (filter.search ?? '').trim();
  const rows = await db.investor.findMany({
    where: {
      deletedAt: null,
      status: filter.status && filter.status !== 'ALL' ? filter.status : undefined,
      // Tìm kiếm mã/tên/biệt danh/SĐT — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts).
      AND: await dieuKienTimKiem(db, 'investors', { code: 'code', fullName: 'full_name', nickname: 'nickname', phone: 'phone' }, s)
    },
    orderBy: { id: 'desc' }
  });
  const names = await resolveUserNames(db, rows.map((r) => r.createdBy));
  const loginNames = await resolveLoginUsernames(db, rows.map((r) => r.userId)); // 1 findMany (KHÔNG N+1)
  const chatGroups = await resolveInvestorChatGroupNames(db, rows.map((r) => r.id)); // tên nhóm chat cho cột list
  return { ok: true, data: rows.map((r) => toDto(r, names, loginNames, chatGroups)) };
}

// Nhận CẢ Db LẪN transaction client (khuôn `Client` ở code.ts) — để gọi được TRONG $transaction (createInvestor).
async function nextInvestorCode(db: Db | Parameters<Parameters<Db['$transaction']>[0]>[0]): Promise<string> {
  const last = await db.investor.findFirst({ where: { code: { startsWith: 'INV' } }, orderBy: { code: 'desc' }, select: { code: true } });
  const n = last ? Number(last.code.replace(/\D/g, '')) || 0 : 0;
  return `INV${String(n + 1).padStart(2, '0')}`;
}

/**
 * HỢP NHẤT NĐT↔USER (Admin Demo 11/8): tạo hồ sơ Nhà đầu tư GẮN với 1 user vừa tạo ở Quản lý nhân sự (tích "Nhà đầu
 * tư"). Chạy TRONG cùng `$transaction` với createUser (truyền tx). KHÔNG kiểm quyền ở đây (createUser đã gate
 * USER_CREATE). Chốt Money-F5: 1 user = TỐI ĐA 1 NĐT active (chặn trùng userId). Trả id NĐT mới. Ném lỗi (message
 * tiếng Việt) nếu %phí sai hoặc user đã là NĐT — để createUser rollback cả user lẫn investor.
 */
export async function createInvestorForUserTx(
  tx: Db,
  params: { userId: number; fullName: string; nickname?: string | null; investFeePct: number; createdBy: number }
): Promise<number> {
  const investFeeMilli = pctToMilli(params.investFeePct);
  if (investFeeMilli === null || investFeeMilli > INVEST_FEE_MILLI_MAX) {
    throw new Error('% phí đầu tư không hợp lệ (0–100%, tối đa 3 số thập phân).');
  }
  const dup = await tx.investor.findFirst({ where: { userId: params.userId, deletedAt: null }, select: { id: true } });
  if (dup) throw new Error('Tài khoản này đã là nhà đầu tư.');
  const fullName = params.fullName.trim();
  const nickname = (params.nickname ?? '').trim() || fullName; // biệt danh mặc định = họ tên (sửa sau ở tab NĐT)
  const code = await nextInvestorCode(tx);
  const created = await tx.investor.create({ data: { code, fullName, nickname, investFeeMilli, userId: params.userId, createdBy: params.createdBy } });
  return created.id;
}

export async function createInvestor(ctx: ServiceCtx, input: CreateInvestorInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'INVESTOR_CREATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const fullName = input.fullName?.trim();
  const nickname = input.nickname?.trim();
  if (!fullName) return { ok: false, error: 'VALIDATION', message: 'Tên nhà đầu tư bắt buộc.' };
  if (!nickname) return { ok: false, error: 'VALIDATION', message: 'Biệt danh bắt buộc.' };
  const investFeeMilli = pctToMilli(input.investFeePct ?? 0);
  if (investFeeMilli === null) return { ok: false, error: 'VALIDATION', message: '% phí đầu tư không hợp lệ (0–100%, tối đa 3 số thập phân).' };
  // Money-F2 — userId (nếu gán): tồn tại + còn sống + chưa gắn NĐT khác (1 user = 1 NĐT). Cùng lớp lỗi với updateInvestor.
  if (input.userId != null) {
    const uerr = await validateInvestorUserId(db, input.userId);
    if (uerr) return { ok: false, error: 'VALIDATION', message: uerr };
  }
  // settleFeeMilli (phí cài máy tất toán trên NĐT) ĐÃ BỎ (Admin Demo 11/8) — cột DB @default(0), không set ở đây.
  // ATOMIC (audit 20/8) — cấp mã + tạo + audit TRONG CÙNG $transaction (writeAudit(tx)) — không commit thiếu dấu vết.
  const created = await db.$transaction(async (tx) => {
    const code = await nextInvestorCode(tx);
    const c = await tx.investor.create({ data: { code, fullName, nickname, phone: input.phone ?? null, email: input.email ?? null, address: input.address ?? null, investFeeMilli, userId: input.userId ?? null, note: input.note ?? null, createdBy: user.id } });
    await writeAudit(tx, { actorUserId: user.id, action: 'INVESTOR_CREATED', targetType: 'Investor', targetId: String(c.id), after: auditSnapshot({ code, fullName, nickname, investFeeMilli }) });
    return c;
  });
  return { ok: true, id: created.id };
}

export async function updateInvestor(ctx: ServiceCtx, id: number, input: UpdateInvestorInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'INVESTOR_UPDATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const row = await db.investor.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Nhà đầu tư không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;
  const fullName = input.fullName !== undefined ? input.fullName.trim() : row.fullName;
  const nickname = input.nickname !== undefined ? input.nickname.trim() : row.nickname;
  if (!fullName) return { ok: false, error: 'VALIDATION', message: 'Tên nhà đầu tư không được để trống.' };
  if (!nickname) return { ok: false, error: 'VALIDATION', message: 'Biệt danh không được để trống.' };
  let investFeeMilli = row.investFeeMilli;
  if (input.investFeePct !== undefined && input.investFeePct !== null) {
    const m = pctToMilli(input.investFeePct);
    if (m === null) return { ok: false, error: 'VALIDATION', message: '% phí đầu tư không hợp lệ (0–100%, tối đa 3 số thập phân).' };
    investFeeMilli = m;
  }
  // Money-F2 — khi set userId (số): kiểm user tồn tại + còn sống + KHÔNG trùng NĐT khác (1 user = 1 NĐT). null = gỡ gán.
  // FIX INV-2: form SỬA luôn gửi lại userId = row.userId (link không đổi) → BỎ QUA re-validate khi link KHÔNG đổi,
  // để user đã bị xóa mềm không chặn việc sửa các trường khác (phí/trạng thái...). Chỉ validate khi userId THỰC SỰ đổi.
  if (input.userId !== undefined && input.userId !== null && input.userId !== row.userId) {
    const uerr = await validateInvestorUserId(db, input.userId, id);
    if (uerr) return { ok: false, error: 'VALIDATION', message: uerr };
  }
  // settleFeeMilli ĐÃ BỎ nhập (Admin Demo 11/8) — KHÔNG đụng cột settle_fee_milli khi update (giữ nguyên giá trị cũ).
  const before = auditSnapshot({ fullName: row.fullName, nickname: row.nickname, investFeeMilli: row.investFeeMilli, status: row.status });
  // ATOMIC (audit 20/8) — cập nhật + audit trong CÙNG $transaction (writeAudit(tx)) — không commit thiếu dấu vết.
  await db.$transaction(async (tx) => {
    await tx.investor.update({ where: { id }, data: { fullName, nickname, phone: input.phone !== undefined ? input.phone : row.phone, email: input.email !== undefined ? input.email : row.email, address: input.address !== undefined ? input.address : row.address, investFeeMilli, userId: input.userId !== undefined ? input.userId : row.userId, note: input.note !== undefined ? input.note : row.note, status: input.status ?? row.status } });
    await writeAudit(tx, { actorUserId: user.id, action: 'INVESTOR_UPDATED', targetType: 'Investor', targetId: String(id), before, after: auditSnapshot({ fullName, nickname, investFeeMilli, status: input.status ?? row.status }) });
  });
  return { ok: true, id };
}

/** INVESTOR_DELETE — soft-delete. §14 xác thực mật khẩu do ROUTE (adapter) kiểm TRƯỚC khi gọi hàm này. */
export async function deleteInvestor(ctx: ServiceCtx, id: number): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'INVESTOR_DELETE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const row = await db.investor.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Nhà đầu tư không tồn tại.' };
  // Precheck IN_USE (khuôn deleteCustomer — chốt finding đối kháng F2): CẤM xóa NĐT còn quan hệ TIỀN sống, nếu không
  // báo cáo tất toán/công nợ NĐT sẽ biến mất im lặng (report/settlement lọc deletedAt:null) trong khi bút toán tiền
  // vẫn nằm trong DB. Chặn khi: còn tài khoản uỷ đang trỏ NĐT (định tuyến tiền) HOẶC còn tạm ứng chưa xử lý.
  const [owyCount, advCount] = await Promise.all([
    db.receiveAccount.count({ where: { investorId: id, deletedAt: null } }),
    db.investorAdvance.count({ where: { investorId: id, deletedAt: null } })
  ]);
  if (owyCount > 0) return { ok: false, error: 'IN_USE', message: `Không thể xóa: nhà đầu tư đang gắn ${owyCount} tài khoản uỷ nhận tiền. Hãy gỡ/đổi uỷ các tài khoản đó trước.` };
  if (advCount > 0) return { ok: false, error: 'IN_USE', message: `Không thể xóa: nhà đầu tư còn ${advCount} khoản tạm ứng chưa xử lý. Hãy xử lý tạm ứng trước.` };
  // ATOMIC (audit 20/8) — xóa mềm + audit trong CÙNG $transaction (writeAudit(tx)) — không commit thiếu dấu vết.
  await db.$transaction(async (tx) => {
    await tx.investor.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: user.id } });
    await writeAudit(tx, { actorUserId: user.id, action: 'INVESTOR_DELETED', targetType: 'Investor', targetId: String(id), before: auditSnapshot({ code: row.code, fullName: row.fullName }) });
  });
  return { ok: true, id };
}
