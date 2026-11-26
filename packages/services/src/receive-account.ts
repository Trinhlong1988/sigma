// Tài khoản nhận tiền – ủy quyền — LÕI THUẦN ctx-based. PORT nghiệp vụ từ apps/desktop/src/main/receive-account-service.ts
// (IMS_SPEC §8). Thay `requirePermission(current-user global)` bằng ctx = { db, user }; mỗi hàm tự kiểm quyền qua
// hasPermission(ctx.user, CONFIG_RCV_ACCT_*). GIỮ NGUYÊN business: Nguồn TK (§8a) + TK nhận tiền (§8b). Audit
// before/after, soft-delete, DUPLICATE_TRASH, P2002 guard, optimistic-lock. XÁC NHẬN MẬT KHẨU (§14) do ADAPTER kiểm
// TRƯỚC khi gọi lõi (khớp customer.ts) — lõi KHÔNG kiểm password.
//
// ĐÍNH KÈM (ảnh CCCD 2 mặt) — TENTATIVE (LEAD quyết): desktop lưu ảnh qua file-store đĩa (storeAttachment) rồi ghi
// path/tên vào cột cccd*Path. Ở bản THUẦN SERVER lõi này CHỈ port METADATA (mọi trường + ĐỌC path/tên ảnh trong
// DTO) — KHÔNG nhận/ghi BYTES ảnh (bỏ *Src của RcvAccountInput). Upload/gỡ ảnh cần route multipart RIÊNG (đề xuất
// `POST /v1/receive-accounts/:id/attachment` + storage do LEAD chốt: BLOB-DB hay object-store).
import { auditSnapshot } from '@sigma/business-rules';
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { staleGuard } from './optimistic-lock.js';
import { dateRange, type ServiceCtx, type MutationResult } from './customer.js';
import type { AuditTrail } from './industry.js';
import { storeFile, readFileFromStore, trashFileFromStore, DOC_FAMILIES, type AttachmentUpload, type AttachmentDownload } from './file-store.js';
// TÌM KIẾM hoa/thường: DB collation "C" → Prisma mode:'insensitive' (ILIKE) KHÔNG gập chữ tiếng Việt có dấu
// (đo thật trên sổ thật: ILIKE '%nguyễn%' = 0 dòng / ILIKE '%NGUYỄN%' = 10 dòng). Xem tim-kiem-hoa-thuong.ts.
import { idKhopTuKhoa } from './tim-kiem-hoa-thuong.js';
import { nhanBank } from './nhan-bank.js';

const VIEW = 'CONFIG_RCV_ACCT_VIEW';
const MANAGE = 'CONFIG_RCV_ACCT_MANAGE';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';
// FIX-PERF — phân trang/take-cap chống kéo full-bảng (khuôn listCustomers). Client KHÔNG gửi → trang 1, take 100.
const RCV_ACCOUNT_PAGE_SIZE_DEFAULT = 100;
const RCV_ACCOUNT_PAGE_SIZE_MAX = 500;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}
async function resolveUserNames(db: Db, ids: (number | null | undefined)[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids.filter((x): x is number => typeof x === 'number'))];
  const map = new Map<number, string>();
  if (uniq.length === 0) return map;
  const users = await db.user.findMany({ where: { id: { in: uniq } }, select: { id: true, fullName: true, username: true } });
  for (const u of users) map.set(u.id, u.fullName || u.username);
  return map;
}
function trail(row: { createdBy: number | null; createdAt: Date; updatedBy: number | null; updatedAt: Date }, names: Map<number, string>): AuditTrail {
  return {
    createdBy: row.createdBy,
    createdByName: row.createdBy != null ? names.get(row.createdBy) ?? null : null,
    createdAt: row.createdAt.toISOString(),
    updatedBy: row.updatedBy,
    updatedByName: row.updatedBy != null ? names.get(row.updatedBy) ?? null : null,
    updatedAt: row.updatedAt.toISOString()
  };
}
/** UỶ (Phase B) — DERIVED từ 2 cột: investorId set → 'INVESTOR'; customerId set → 'CUSTOMER'; cả 2 null → 'INTERNAL'.
 *  1 nguồn suy loại uỷ dùng chung (receive-account/tid/tid-config). KHÔNG lưu cột owyType. */
export function deriveOwyType(customerId: number | null | undefined, investorId: number | null | undefined): 'CUSTOMER' | 'INVESTOR' | 'INTERNAL' {
  if (investorId != null) return 'INVESTOR';
  if (customerId != null) return 'CUSTOMER';
  return 'INTERNAL';
}

function parseDate(v: string | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d; // undefined = giữ nguyên (bỏ qua giá trị sai)
}

// ═════════════════════════════════════════════════════════════════════════════
// §8a — NGUỒN TÀI KHOẢN ỦY QUYỀN
// ═════════════════════════════════════════════════════════════════════════════
export interface RcvSourceDto extends AuditTrail {
  id: number;
  name: string;
}
export interface CreateRcvSourceInput {
  name: string;
}
export interface UpdateRcvSourceInput {
  name?: string;
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock — mốc updatedAt client giữ lúc mở form
}

export async function listRcvSources(ctx: ServiceCtx): Promise<{ ok: boolean; data?: RcvSourceDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.receiveAccountSource.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.createdBy, r.updatedBy]));
  return { ok: true, data: rows.map((r) => ({ id: r.id, name: r.name, ...trail(r, names) })) };
}

export async function createRcvSource(ctx: ServiceCtx, input: CreateRcvSourceInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const name = input.name?.trim();
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên nguồn tài khoản bắt buộc.' };
  const dup = await db.receiveAccountSource.findFirst({ where: { name } });
  if (dup) {
    return dup.deletedAt
      ? { ok: false, error: 'DUPLICATE_TRASH', message: `Nguồn "${name}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn tên khác.` }
      : { ok: false, error: 'DUPLICATE', message: `Nguồn "${name}" đã tồn tại.` };
  }
  let created;
  try {
    created = await db.receiveAccountSource.create({ data: { name, createdBy: user.id } });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `Nguồn "${name}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'RCV_ACCT_SOURCE_CREATED', targetType: 'ReceiveAccountSource', targetId: String(created.id), after: auditSnapshot({ name }) });
  return { ok: true, id: created.id };
}

export async function updateRcvSource(ctx: ServiceCtx, id: number, input: UpdateRcvSourceInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const row = await db.receiveAccountSource.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Nguồn tài khoản không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;
  const name = input.name !== undefined ? input.name.trim() : row.name;
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên nguồn không được để trống.' };
  if (name !== row.name) {
    const dup = await db.receiveAccountSource.findFirst({ where: { name, NOT: { id } } });
    if (dup) {
      return dup.deletedAt
        ? { ok: false, error: 'DUPLICATE_TRASH', message: `Nguồn "${name}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn tên khác.` }
        : { ok: false, error: 'DUPLICATE', message: `Nguồn "${name}" đã tồn tại.` };
    }
  }
  const before = auditSnapshot({ name: row.name });
  let updated;
  try {
    updated = await db.receiveAccountSource.update({ where: { id }, data: { name, updatedBy: user.id } });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `Nguồn "${name}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'RCV_ACCT_SOURCE_UPDATED', targetType: 'ReceiveAccountSource', targetId: String(id), before, after: auditSnapshot({ name: updated.name }) });
  return { ok: true, id };
}

/** Xóa mềm 1..n nguồn TK. Xác nhận MẬT KHẨU (§14) do ADAPTER kiểm TRƯỚC khi gọi. */
export async function deleteRcvSources(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn nguồn để xóa.' };
  let deleted = 0;
  for (const id of ids) {
    const row = await db.receiveAccountSource.findUnique({ where: { id } });
    if (!row || row.deletedAt) continue;
    await db.receiveAccountSource.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.id, deletedBy: user.id } });
    await writeAudit(db, { actorUserId: user.id, action: 'RCV_ACCT_SOURCE_DELETED', targetType: 'ReceiveAccountSource', targetId: String(id), before: auditSnapshot({ name: row.name }) });
    deleted++;
  }
  return { ok: true, deleted };
}

// ═════════════════════════════════════════════════════════════════════════════
// §8b — TÀI KHOẢN NHẬN TIỀN
// ═════════════════════════════════════════════════════════════════════════════
export interface RcvAccountDto extends AuditTrail {
  id: number;
  sourceId: number;
  sourceName: string | null;
  accountName: string;
  accountNumber: string;
  bankId: number;
  bankCode: string | null;
  bankName: string | null;
  branch: string | null;
  cccdNumber: string | null;
  cccdIssueDate: string | null;
  cccdIssuePlace: string | null;
  cccdExpiry: string | null;
  phone: string | null;
  email: string | null;
  customerId: number | null;
  customerName: string | null;
  investorId: number | null;
  investorName: string | null;
  // Nhóm chat của NĐT gắn vào TK (Phase E) — CHỈ có nghĩa khi uỷ=NĐT. id + tên (join) để hiển thị.
  investorChatGroupId: number | null;
  investorChatGroupName: string | null;
  // UỶ (Phase B) — DERIVED từ (customerId, investorId), KHÔNG lưu cột: loại + tên hiển thị.
  owyType: string | null; // 'CUSTOMER' | 'INVESTOR' | 'INTERNAL'
  owyName: string | null; // tên khách/NĐT của uỷ (INTERNAL → null)
  // Ảnh CCCD (ĐỌC path/tên đã lưu). Upload/gỡ qua route multipart riêng (TENTATIVE — xem đầu file).
  cccdFrontPath: string | null;
  cccdFrontName: string | null;
  cccdBackPath: string | null;
  cccdBackName: string | null;
}
export interface RcvAccountFilter {
  search?: string;
  sourceId?: number;
  bankId?: number;
  customerId?: number;
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
}
/** Đầu vào tạo/sửa TK — CHỈ METADATA (không nhận bytes ảnh; upload ảnh qua route riêng — TENTATIVE). */
export interface RcvAccountInput {
  sourceId: number;
  accountName: string;
  accountNumber: string;
  bankId: number;
  branch?: string | null;
  cccdNumber?: string | null;
  cccdIssueDate?: string | null;
  cccdIssuePlace?: string | null;
  cccdExpiry?: string | null;
  phone?: string | null;
  email?: string | null;
  // UỶ (Phase B) — 1 bên: customerId (Khách) HOẶC investorId (NĐT); cả 2 null = Nội bộ. CẤM set cả 2.
  customerId?: number | null;
  investorId?: number | null;
  // Nhóm chat NĐT (Phase E) — CHỈ dùng khi uỷ=NĐT; group phải thuộc đúng investorId (validate ở core). Uỷ khác → clear null.
  investorChatGroupId?: number | null;
  note?: string | null;
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock — mốc updatedAt client giữ lúc mở form (chỉ dùng ở updateRcvAccount)
}

export async function listRcvAccounts(ctx: ServiceCtx, filter: RcvAccountFilter = {}): Promise<{ ok: boolean; data?: RcvAccountDto[]; total?: number; page?: number; pageSize?: number; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(RCV_ACCOUNT_PAGE_SIZE_MAX, Math.max(1, filter.pageSize ?? RCV_ACCOUNT_PAGE_SIZE_DEFAULT));
  // Tìm kiếm cũng khớp KHÁCH HÀNG gắn với TK (mã KH / biệt danh / tên thật): tra id khách khớp trước rồi lọc
  // theo customerId — ReceiveAccount chỉ có cột customerId (không có quan hệ Prisma) nên không lọc quan hệ trực tiếp được.
  // Tìm kiếm KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts): id khách khớp từ khoá.
  let custMatchIds: Array<number | string> = [];
  if (filter.search) {
    const s = filter.search;
    const idKhach = await idKhopTuKhoa(db, 'customers', { code: 'code', nickname: 'nickname', fullName: 'full_name' }, s);
    custMatchIds =
      idKhach ??
      // Đường lui (CHỈ gặp với Db giả trong unit test — production luôn có $queryRawUnsafe): giữ nguyên mệnh đề cũ.
      (
        await db.customer.findMany({
          where: { deletedAt: null, OR: [{ code: { contains: s, mode: 'insensitive' } }, { nickname: { contains: s, mode: 'insensitive' } }, { fullName: { contains: s, mode: 'insensitive' } }] },
          select: { id: true }
        })
      ).map((c) => c.id);
  }
  // id TK nhận tiền khớp từ khoá (tên TK / số TK / CCCD / SĐT). null = Db giả → dùng lại mệnh đề cũ ở dưới.
  const accMatchIds = filter.search
    ? await idKhopTuKhoa(db, 'receive_accounts', { accountName: 'account_name', accountNumber: 'account_number', cccdNumber: 'cccd_number', phone: 'phone' }, filter.search)
    : null;
  const where: Record<string, unknown> = {
    deletedAt: null,
    sourceId: filter.sourceId ?? undefined,
    bankId: filter.bankId ?? undefined,
    customerId: filter.customerId ?? undefined,
    createdAt: dateRange(filter.fromDate, filter.toDate),
    OR: filter.search
      ? [
          ...(accMatchIds !== null
            ? [{ id: { in: accMatchIds } }]
            : [
                { accountName: { contains: filter.search, mode: 'insensitive' } },
                { accountNumber: { contains: filter.search, mode: 'insensitive' } },
                { cccdNumber: { contains: filter.search, mode: 'insensitive' } },
                { phone: { contains: filter.search, mode: 'insensitive' } }
              ]),
          ...(custMatchIds.length ? [{ customerId: { in: custMatchIds } }] : [])
        ]
      : undefined
  };
  const total = await db.receiveAccount.count({ where });
  const rows = await db.receiveAccount.findMany({
    where,
    orderBy: { id: 'asc' },
    skip: (page - 1) * pageSize,
    take: pageSize
  });
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.createdBy, r.updatedBy]));
  const sources = new Map((await db.receiveAccountSource.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.sourceId))] } }, select: { id: true, name: true } })).map((s) => [s.id, s]));
  const banks = new Map((await db.bank.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.bankId))] } }, select: { id: true, code: true, name: true } })).map((b) => [b.id, b]));
  // Khách (customerId) + Nhà đầu tư (investorId) — mỗi bên 1 findMany distinct (không N+1). UỶ suy từ 2 cột này.
  const custIds = rows.map((r) => r.customerId).filter((x): x is number => typeof x === 'number');
  const customers = new Map((await db.customer.findMany({ where: { id: { in: [...new Set(custIds)] } }, select: { id: true, nickname: true, fullName: true } })).map((c) => [c.id, c]));
  const invIds = rows.map((r) => r.investorId).filter((x): x is number => typeof x === 'number');
  const investors = new Map((await db.investor.findMany({ where: { id: { in: [...new Set(invIds)] } }, select: { id: true, nickname: true, fullName: true } })).map((v) => [v.id, v]));
  // Nhóm chat NĐT (Phase E) — 1 findMany distinct (không N+1). Tên hiển thị = name → tên phòng (join) → fallback.
  // Chỉ query khi CÓ TK gắn nhóm (tránh truy vấn thừa + fake-db test không cần bảng này nếu không dùng).
  const groupIds = rows.map((r) => r.investorChatGroupId).filter((x): x is number => typeof x === 'number');
  const groups = new Map((groupIds.length > 0 ? await db.investorChatGroup.findMany({ where: { id: { in: [...new Set(groupIds)] } }, select: { id: true, name: true, roomId: true } }) : []).map((g) => [g.id, g]));
  const groupRoomIds = [...groups.values()].map((g) => g.roomId).filter((x): x is string => typeof x === 'string');
  const groupRoomNames = new Map((groupRoomIds.length > 0 ? await db.chatRoom.findMany({ where: { id: { in: [...new Set(groupRoomIds)] } }, select: { id: true, name: true } }) : []).map((r) => [r.id, r.name]));
  const groupName = (gid: number | null): string | null => {
    if (gid == null) return null;
    const g = groups.get(gid);
    if (!g) return '(nhóm đã xóa)';
    return g.name?.trim() || (g.roomId != null ? (groupRoomNames.get(g.roomId)?.trim() ?? '') : '') || 'Nhóm chưa đặt tên';
  };
  return {
    ok: true,
    total,
    page,
    pageSize,
    data: rows.map((r) => ({
      id: r.id,
      sourceId: r.sourceId,
      sourceName: sources.get(r.sourceId)?.name ?? null,
      accountName: r.accountName,
      accountNumber: r.accountNumber,
      bankId: r.bankId,
      bankCode: banks.get(r.bankId)?.code ?? null,
      bankName: nhanBank(banks.get(r.bankId)), // [16/11] mã viết tắt
      branch: r.branch,
      cccdNumber: r.cccdNumber,
      cccdIssueDate: r.cccdIssueDate ? r.cccdIssueDate.toISOString() : null,
      cccdIssuePlace: r.cccdIssuePlace,
      cccdExpiry: r.cccdExpiry ? r.cccdExpiry.toISOString() : null,
      phone: r.phone,
      email: r.email,
      customerId: r.customerId,
      customerName: r.customerId != null ? customers.get(r.customerId)?.nickname ?? customers.get(r.customerId)?.fullName ?? null : null,
      investorId: r.investorId,
      investorName: r.investorId != null ? investors.get(r.investorId)?.nickname ?? investors.get(r.investorId)?.fullName ?? null : null,
      investorChatGroupId: r.investorChatGroupId,
      investorChatGroupName: groupName(r.investorChatGroupId),
      owyType: deriveOwyType(r.customerId, r.investorId),
      owyName: r.investorId != null ? (investors.get(r.investorId)?.nickname ?? investors.get(r.investorId)?.fullName ?? null) : r.customerId != null ? (customers.get(r.customerId)?.nickname ?? customers.get(r.customerId)?.fullName ?? null) : null,
      cccdFrontPath: r.cccdFrontPath,
      cccdFrontName: r.cccdFrontName,
      cccdBackPath: r.cccdBackPath,
      cccdBackName: r.cccdBackName,
      ...trail(r, names)
    }))
  };
}

/** Kiểm tra khóa tham chiếu (nguồn/ngân hàng/khách) tồn tại & còn sống. */
async function validateRefs(db: Db, sourceId: number, bankId: number, customerId: number | null | undefined): Promise<MutationResult | null> {
  const src = await db.receiveAccountSource.findUnique({ where: { id: sourceId } });
  if (!src || src.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Nguồn tài khoản đã chọn không tồn tại.' };
  const bank = await db.bank.findUnique({ where: { id: bankId } });
  if (!bank || bank.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Ngân hàng đã chọn không tồn tại.' };
  if (customerId != null) {
    const c = await db.customer.findUnique({ where: { id: customerId } });
    if (!c || c.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Khách hàng đã chọn không tồn tại.' };
  }
  return null;
}

/** UỶ (Phase B, MODEL 2-field) — CẤM set cả customerId LẪN investorId; nếu chọn NĐT thì NĐT phải tồn tại & còn sống.
 *  customerId đã được validateRefs kiểm (khách tồn tại). null/null = Nội bộ. Trả lỗi hoặc null (OK). */
async function validateOwyRef(db: Db, customerId: number | null | undefined, investorId: number | null | undefined): Promise<MutationResult | null> {
  if (customerId != null && investorId != null) {
    return { ok: false, error: 'VALIDATION', message: '1 tài khoản chỉ uỷ cho 1 bên (Khách hàng hoặc Nhà đầu tư), không chọn cả hai.' };
  }
  if (investorId != null) {
    const v = await db.investor.findFirst({ where: { id: investorId, deletedAt: null }, select: { id: true } });
    if (!v) return { ok: false, error: 'NOT_FOUND', message: 'Nhà đầu tư uỷ đã chọn không tồn tại (hoặc đã bị xóa).' };
  }
  return null;
}

/**
 * Nhóm chat NĐT (Phase E) — chuẩn hóa + validate. CHỈ giữ groupId khi uỷ=NĐT (investorId set); uỷ khác → clear null
 * (link "ở uỷ như khách" chỉ có nghĩa với NĐT). Nếu giữ, group PHẢI thuộc ĐÚNG investorId đó + đang gán (active).
 * Trả { value } (id sẽ ghi) hoặc { err } (VALIDATION/NOT_FOUND).
 */
async function resolveInvestorChatGroupId(
  db: Db,
  investorId: number | null | undefined,
  groupId: number | null | undefined
): Promise<{ value: number | null } | { err: MutationResult }> {
  if (investorId == null || groupId == null) return { value: null };
  const g = await db.investorChatGroup.findFirst({ where: { id: groupId, investorId, unassignedAt: null }, select: { id: true } });
  if (!g) return { err: { ok: false, error: 'VALIDATION', message: 'Nhóm chat nhà đầu tư đã chọn không hợp lệ (không thuộc nhà đầu tư này hoặc đã bị xóa). Vui lòng chọn lại.' } };
  return { value: groupId };
}

export async function createRcvAccount(ctx: ServiceCtx, input: RcvAccountInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const accountName = input.accountName?.trim();
  const accountNumber = input.accountNumber?.trim();
  if (!input.sourceId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn nguồn tài khoản.' };
  if (!accountName) return { ok: false, error: 'VALIDATION', message: 'Tên tài khoản bắt buộc.' };
  if (!accountNumber) return { ok: false, error: 'VALIDATION', message: 'Số tài khoản bắt buộc.' };
  if (!input.bankId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn ngân hàng.' };
  const refErr = await validateRefs(db, input.sourceId, input.bankId, input.customerId ?? null);
  if (refErr) return refErr;
  const owyErr = await validateOwyRef(db, input.customerId, input.investorId);
  if (owyErr) return owyErr;
  const chatGroup = await resolveInvestorChatGroupId(db, input.investorId, input.investorChatGroupId);
  if ('err' in chatGroup) return chatGroup.err;

  const created = await db.receiveAccount.create({
    data: {
      sourceId: input.sourceId,
      accountName,
      accountNumber,
      bankId: input.bankId,
      branch: input.branch?.trim() || null,
      cccdNumber: input.cccdNumber?.trim() || null,
      cccdIssueDate: parseDate(input.cccdIssueDate) ?? null,
      cccdIssuePlace: input.cccdIssuePlace?.trim() || null,
      cccdExpiry: parseDate(input.cccdExpiry) ?? null,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      customerId: input.customerId ?? null,
      investorId: input.investorId ?? null,
      investorChatGroupId: chatGroup.value,
      note: input.note?.trim() || null,
      createdBy: user.id
    }
  });
  await writeAudit(db, { actorUserId: user.id, action: 'RCV_ACCT_CREATED', targetType: 'ReceiveAccount', targetId: String(created.id), after: auditSnapshot({ accountName, accountNumber, bankId: input.bankId }) });
  return { ok: true, id: created.id };
}

export async function updateRcvAccount(ctx: ServiceCtx, id: number, input: RcvAccountInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const row = await db.receiveAccount.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Tài khoản không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;
  const accountName = input.accountName !== undefined ? input.accountName.trim() : row.accountName;
  const accountNumber = input.accountNumber !== undefined ? input.accountNumber.trim() : row.accountNumber;
  const sourceId = input.sourceId ?? row.sourceId;
  const bankId = input.bankId ?? row.bankId;
  if (!accountName) return { ok: false, error: 'VALIDATION', message: 'Tên tài khoản không được để trống.' };
  if (!accountNumber) return { ok: false, error: 'VALIDATION', message: 'Số tài khoản không được để trống.' };
  // UỶ (Phase B) — customerId/investorId: undefined = giữ nguyên; validate CẢ 2 (guard 1-bên + NĐT tồn tại).
  const effCustomerId = input.customerId === undefined ? row.customerId : input.customerId;
  const effInvestorId = input.investorId === undefined ? row.investorId : input.investorId;
  const refErr = await validateRefs(db, sourceId, bankId, effCustomerId);
  if (refErr) return refErr;
  const owyErr = await validateOwyRef(db, effCustomerId, effInvestorId);
  if (owyErr) return owyErr;
  // Nhóm chat NĐT: undefined = giữ nguyên; resolve theo effInvestorId (uỷ đổi khỏi NĐT → clear null).
  const effChatGroupId = input.investorChatGroupId === undefined ? row.investorChatGroupId : input.investorChatGroupId;
  const chatGroup = await resolveInvestorChatGroupId(db, effInvestorId, effChatGroupId);
  if ('err' in chatGroup) return chatGroup.err;

  const before = auditSnapshot({ accountName: row.accountName, accountNumber: row.accountNumber, bankId: row.bankId });
  await db.receiveAccount.update({
    where: { id },
    data: {
      sourceId,
      accountName,
      accountNumber,
      bankId,
      branch: input.branch !== undefined ? input.branch?.trim() || null : row.branch,
      cccdNumber: input.cccdNumber !== undefined ? input.cccdNumber?.trim() || null : row.cccdNumber,
      cccdIssueDate: input.cccdIssueDate !== undefined ? parseDate(input.cccdIssueDate) ?? null : row.cccdIssueDate,
      cccdIssuePlace: input.cccdIssuePlace !== undefined ? input.cccdIssuePlace?.trim() || null : row.cccdIssuePlace,
      cccdExpiry: input.cccdExpiry !== undefined ? parseDate(input.cccdExpiry) ?? null : row.cccdExpiry,
      phone: input.phone !== undefined ? input.phone?.trim() || null : row.phone,
      email: input.email !== undefined ? input.email?.trim() || null : row.email,
      customerId: effCustomerId,
      investorId: effInvestorId,
      investorChatGroupId: chatGroup.value,
      note: input.note !== undefined ? input.note?.trim() || null : row.note,
      updatedBy: user.id
    }
  });
  await writeAudit(db, { actorUserId: user.id, action: 'RCV_ACCT_UPDATED', targetType: 'ReceiveAccount', targetId: String(id), before, after: auditSnapshot({ accountName, accountNumber, bankId }) });
  return { ok: true, id };
}

/** Xóa mềm 1..n TK. Xác nhận MẬT KHẨU (§14) do ADAPTER kiểm TRƯỚC khi gọi. */
export async function deleteRcvAccounts(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn tài khoản để xóa.' };
  let deleted = 0;
  for (const id of ids) {
    const row = await db.receiveAccount.findUnique({ where: { id } });
    if (!row || row.deletedAt) continue;
    await db.receiveAccount.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.id, deletedBy: user.id } });
    await writeAudit(db, { actorUserId: user.id, action: 'RCV_ACCT_DELETED', targetType: 'ReceiveAccount', targetId: String(id), before: auditSnapshot({ accountName: row.accountName, accountNumber: row.accountNumber }) });
    deleted++;
  }
  return { ok: true, deleted };
}

// ═════════════════════════════════════════════════════════════════════════════
// ĐÍNH KÈM ẢNH CCCD — KHO FILE SERVER (thuần server, xem file-store.ts). CÙNG khuôn dossier.ts, chỉ 2 mặt CCCD.
// ═════════════════════════════════════════════════════════════════════════════
export type RcvAttachField = 'cccdFront' | 'cccdBack';
const RCV_ATTACH_FIELDS: RcvAttachField[] = ['cccdFront', 'cccdBack'];
export function isRcvAttachField(v: unknown): v is RcvAttachField {
  return typeof v === 'string' && (RCV_ATTACH_FIELDS as string[]).includes(v);
}

type RcvAttachCols = { cccdFrontPath: string | null; cccdFrontName: string | null; cccdBackPath: string | null; cccdBackName: string | null };
function rcvAttachPath(row: RcvAttachCols, field: RcvAttachField): string | null {
  return field === 'cccdFront' ? row.cccdFrontPath : row.cccdBackPath;
}
function rcvAttachName(row: RcvAttachCols, field: RcvAttachField): string | null {
  return field === 'cccdFront' ? row.cccdFrontName : row.cccdBackName;
}
function rcvAttachUpdate(field: RcvAttachField, path: string | null, name: string | null) {
  return field === 'cccdFront' ? { cccdFrontPath: path, cccdFrontName: name } : { cccdBackPath: path, cccdBackName: name };
}

/** Upload/thay 1 ảnh CCCD của tài khoản nhận tiền. Lõi kiểm quyền MANAGE (route đã kiểm phiên + parse multipart). */
export async function setRcvAccountAttachment(ctx: ServiceCtx, id: number, field: string, upload: AttachmentUpload): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!isRcvAttachField(field)) return { ok: false, error: 'VALIDATION', message: 'Loại ảnh CCCD không hợp lệ (chỉ mặt trước/sau).' };
  const row = await db.receiveAccount.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Tài khoản không tồn tại.' };
  const stored = storeFile('receive-accounts', id, upload.buffer, DOC_FAMILIES);
  if (!stored.ok) return { ok: false, error: stored.error, message: stored.message };
  const oldPath = rcvAttachPath(row as RcvAttachCols, field);
  const name = upload.originalName?.trim() || null;
  await db.receiveAccount.update({ where: { id }, data: { ...rcvAttachUpdate(field, stored.file.relPath, name), updatedBy: user.id } });
  if (oldPath && oldPath !== stored.file.relPath) trashFileFromStore(oldPath);
  await writeAudit(db, { actorUserId: user.id, action: 'RCV_ACCT_ATTACHMENT_SET', targetType: 'ReceiveAccount', targetId: String(id), after: auditSnapshot({ field, relPath: stored.file.relPath, bytes: stored.file.size }) });
  return { ok: true, id };
}

/** Tải 1 ảnh CCCD của tài khoản nhận tiền về (bytes + mime). Lõi kiểm quyền VIEW. */
export async function getRcvAccountAttachment(ctx: ServiceCtx, id: number, field: string): Promise<AttachmentDownload> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  if (!isRcvAttachField(field)) return { ok: false, error: 'VALIDATION', message: 'Loại ảnh CCCD không hợp lệ (chỉ mặt trước/sau).' };
  const row = await db.receiveAccount.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Tài khoản không tồn tại.' };
  const path = rcvAttachPath(row as RcvAttachCols, field);
  if (!path) return { ok: false, error: 'NOT_FOUND', message: 'Tài khoản chưa có ảnh này.' };
  const r = readFileFromStore(path);
  if (!r.ok) return { ok: false, error: r.error, message: r.message };
  return { ok: true, buffer: r.buffer, mime: r.mime, fileName: rcvAttachName(row as RcvAttachCols, field) };
}
