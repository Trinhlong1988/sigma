// Cấu hình TID — LÕI THUẦN ctx-based. PORT nghiệp vụ từ apps/desktop/src/main/tid-config-service.ts (IMS_SPEC §9).
// Cách 1 (Admin Demo 9/7): gộp thông tin thương mại vào bảng `tids` đang có (không tạo bảng riêng). §9a trạng thái TID
// cấu hình (bảng riêng tidConfigStatus). Thay `requirePermission(current-user global)` bằng ctx = { db, user } do
// adapter dựng; mỗi hàm tự kiểm quyền qua hasPermission(ctx.user, CONFIG_TID_VIEW/MANAGE). GIỮ NGUYÊN business:
// validate khóa tham chiếu, chống trùng TID (active vs trash), audit, soft-delete. §14 xác nhận MẬT KHẨU do ADAPTER
// kiểm TRƯỚC khi gọi lõi (khuôn customer.ts). LƯU Ý R34: desktop ĐÃ GỠ IPC xóa cấu hình TID trực tiếp (xóa TID chỉ
// qua Duyệt Hủy) → route API KHÔNG expose DELETE; deleteConfigTids GIỮ NỘI BỘ cho parity/entity-cancel tương lai.
import { auditSnapshot } from '@sigma/business-rules';
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { staleGuard } from './optimistic-lock.js';
import { dateRange, type ServiceCtx, type MutationResult } from './customer.js';
import type { AuditTrail } from './industry.js';
import { deriveOwyType } from './receive-account.js';
// TÌM KIẾM hoa/thường: DB collation "C" → Prisma mode:'insensitive' (ILIKE) KHÔNG gập chữ tiếng Việt có dấu
// (đo thật trên sổ thật: ILIKE '%nguyễn%' = 0 dòng / ILIKE '%NGUYỄN%' = 10 dòng). Xem tim-kiem-hoa-thuong.ts.
import { dieuKienTimKiem } from './tim-kiem-hoa-thuong.js';
import { nhanBank } from './nhan-bank.js';

const VIEW = 'CONFIG_TID_VIEW';
const MANAGE = 'CONFIG_TID_MANAGE';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';
// TRẦN %phí đầu tư override theo TID (Money-F1, Admin Demo): giá trị đã ở MILLI (×1000; 0.1%=100). Hợp lệ = số NGUYÊN
// trong [0,100000] (0–100%). null = dùng mặc định NĐT. Chống nhập 50000000(=50000%) / số âm / phần thập phân bơm lãi.
const INVEST_FEE_MILLI_MAX = 100000;
/** Kiểm investFeeMilli override theo TID. Trả message lỗi (VN) nếu sai; null nếu hợp lệ (kể cả null = bỏ trống). */
function invalidTidInvestFee(v: number | null | undefined): string | null {
  if (v == null) return null; // null/undefined = không override → dùng mặc định NĐT
  if (!Number.isInteger(v) || v < 0 || v > INVEST_FEE_MILLI_MAX) {
    return '% phí đầu tư override theo TID không hợp lệ (0–100%, tức số nguyên 0–100000 ×1000).';
  }
  return null;
}

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
function parseDate(v: string | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

// ═════════════════════════════════════════════════════════════════════════════
// §9a — TRẠNG THÁI TID CẤU HÌNH
// ═════════════════════════════════════════════════════════════════════════════
export interface TidConfigStatusDto extends AuditTrail {
  id: number;
  name: string;
}
export interface CreateTidConfigStatusInput {
  name: string;
}
export interface UpdateTidConfigStatusInput {
  name?: string;
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock — mốc updatedAt client giữ lúc mở form
}

export async function listStatuses(ctx: ServiceCtx): Promise<{ ok: boolean; data?: TidConfigStatusDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.tidConfigStatus.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.createdBy, r.updatedBy]));
  return { ok: true, data: rows.map((r) => ({ id: r.id, name: r.name, ...trail(r, names) })) };
}

export async function createStatus(ctx: ServiceCtx, input: CreateTidConfigStatusInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const name = input.name?.trim();
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên trạng thái TID bắt buộc.' };
  const dup = await db.tidConfigStatus.findFirst({ where: { name } });
  if (dup) {
    return dup.deletedAt
      ? { ok: false, error: 'DUPLICATE_TRASH', message: `Trạng thái "${name}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn tên khác.` }
      : { ok: false, error: 'DUPLICATE', message: `Trạng thái "${name}" đã tồn tại.` };
  }
  let created;
  try {
    created = await db.tidConfigStatus.create({ data: { name, createdBy: user.id } });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `Trạng thái "${name}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'TID_CONFIG_STATUS_CREATED', targetType: 'TidConfigStatus', targetId: String(created.id), after: auditSnapshot({ name }) });
  return { ok: true, id: created.id };
}

export async function updateStatus(ctx: ServiceCtx, id: number, input: UpdateTidConfigStatusInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const row = await db.tidConfigStatus.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Trạng thái không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;
  const name = input.name !== undefined ? input.name.trim() : row.name;
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên trạng thái không được để trống.' };
  if (name !== row.name) {
    const dup = await db.tidConfigStatus.findFirst({ where: { name, NOT: { id } } });
    if (dup) {
      return dup.deletedAt
        ? { ok: false, error: 'DUPLICATE_TRASH', message: `Trạng thái "${name}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn tên khác.` }
        : { ok: false, error: 'DUPLICATE', message: `Trạng thái "${name}" đã tồn tại.` };
    }
  }
  const before = auditSnapshot({ name: row.name });
  let updated;
  try {
    updated = await db.tidConfigStatus.update({ where: { id }, data: { name, updatedBy: user.id } });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `Trạng thái "${name}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'TID_CONFIG_STATUS_UPDATED', targetType: 'TidConfigStatus', targetId: String(id), before, after: auditSnapshot({ name: updated.name }) });
  return { ok: true, id };
}

/** Xóa mềm 1..n trạng thái TID. §14 xác nhận MẬT KHẨU do ADAPTER kiểm TRƯỚC khi gọi. */
export async function deleteStatuses(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn trạng thái để xóa.' };
  let deleted = 0;
  for (const id of ids) {
    const row = await db.tidConfigStatus.findUnique({ where: { id } });
    if (!row || row.deletedAt) continue;
    await db.tidConfigStatus.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.id, deletedBy: user.id } });
    await writeAudit(db, { actorUserId: user.id, action: 'TID_CONFIG_STATUS_DELETED', targetType: 'TidConfigStatus', targetId: String(id), before: auditSnapshot({ name: row.name }) });
    deleted++;
  }
  return { ok: true, deleted };
}

// ═════════════════════════════════════════════════════════════════════════════
// §9 — CẤU HÌNH TID (thao tác trên bảng tids)
// ═════════════════════════════════════════════════════════════════════════════
export interface ConfigTidDto extends AuditTrail {
  id: number;
  tid: string;
  status: string; // vòng đời vận hành (UNASSIGNED|ACTIVE|…)
  posSerial: string | null;
  bankId: number | null;
  bankCode: string | null;
  bankName: string | null;
  partnerId: number | null;
  partnerCode: string | null;
  partnerName: string | null;
  hkdName: string | null;
  receiveAccountId: number | null;
  receiveAccountLabel: string | null;
  // Phase B — suy UỶ qua TK nhận tiền + %phí đầu tư override theo TID.
  owyType: string | null; // CUSTOMER|INVESTOR|INTERNAL của TK nhận tiền
  owyName: string | null; // tên khách/NĐT của uỷ
  investFeeMilli: number | null; // %phí đầu tư override theo TID (×1000); null = dùng mặc định NĐT
  issuedAt: string | null;
  configStatusId: number | null;
  configStatusName: string | null;
  dossierSourceId: number | null;
  dossierSourceCode: string | null;
  // Bill giải trình (Admin Demo 21/8) — HKD (Dossier) + Ngành nghề (Industry) tự suy theo TID: chọn TID → tự điền HKD
  // + ngành trong form sinh bill (KHÔNG bắt chọn tay 3 select rời). `dossierId` = Tid.dossierId (link Hồ sơ HKD).
  dossierId: number | null;
  industryId: number | null; // Tid.industryId (Ngành nghề) — pre-chọn ngành theo TID.
  customerId: number | null; // khách được giao TID (Tid.customerId) — GD tự liên kết theo TID
  customerName: string | null; // nickname||fullName của khách theo TID
  note: string | null;
}
export interface ConfigTidFilter {
  search?: string;
  bankId?: number;
  partnerId?: number;
  configStatusId?: number;
  fromDate?: string;
  toDate?: string;
}
export interface ConfigTidInput {
  tid: string;
  bankId: number;
  partnerId: number;
  hkdName: string;
  receiveAccountId?: number | null;
  investFeeMilli?: number | null; // Phase B — %phí đầu tư override theo TID (×1000)
  issuedAt?: string | null;
  configStatusId?: number | null;
  dossierSourceId?: number | null;
  note?: string | null;
  // Nhóm 1 (Admin Demo 12/7) — sửa FULL thông tin TID từ danh sách: thêm MID + ngành nghề + link HKD + máy khách.
  mid?: string | null;
  industryId?: number | null; // #11 LANE A — ngành nghề (phải tồn tại + active nếu gán)
  dossierId?: number | null; // Q-T3 — link Hồ sơ HKD
  customerDeviceSerial?: string | null; // Q-T6 — serial máy của khách (tra cứu, không tạo PosDevice)
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock — mốc updatedAt client giữ lúc mở form (chỉ dùng ở updateConfigTid)
}

export async function listConfigTids(ctx: ServiceCtx, filter: ConfigTidFilter = {}): Promise<{ ok: boolean; data?: ConfigTidDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.tid.findMany({
    where: {
      deletedAt: null,
      bankId: filter.bankId ?? undefined,
      partnerId: filter.partnerId ?? undefined,
      configStatusId: filter.configStatusId ?? undefined,
      createdAt: dateRange(filter.fromDate, filter.toDate),
      // Tìm kiếm TID/tên HKD — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts).
      AND: await dieuKienTimKiem(db, 'tids', { tid: 'tid', hkdName: 'hkd_name' }, filter.search)
    },
    orderBy: { id: 'asc' }
  });
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.createdBy, r.updatedBy]));
  const banks = new Map((await db.bank.findMany({ where: { id: { in: uniqIds(rows.map((r) => r.bankId)) } }, select: { id: true, code: true, name: true } })).map((b) => [b.id, b]));
  const partners = new Map((await db.partner.findMany({ where: { id: { in: uniqIds(rows.map((r) => r.partnerId)) } }, select: { id: true, code: true, name: true } })).map((p) => [p.id, p]));
  // Phase B — TK nhận tiền + UỶ suy từ (customerId, investorId): 1 findMany accounts + resolve tên qua customer/investor (distinct, không N+1).
  const accRows = await db.receiveAccount.findMany({ where: { id: { in: uniqIds(rows.map((r) => r.receiveAccountId)) } }, select: { id: true, accountName: true, accountNumber: true, customerId: true, investorId: true } });
  const accounts = new Map(accRows.map((a) => [a.id, a]));
  const owyCusts = new Map((await db.customer.findMany({ where: { id: { in: uniqIds(accRows.map((a) => a.customerId)) } }, select: { id: true, nickname: true, fullName: true } })).map((c) => [c.id, c]));
  const owyInvs = new Map((await db.investor.findMany({ where: { id: { in: uniqIds(accRows.map((a) => a.investorId)) } }, select: { id: true, nickname: true, fullName: true } })).map((v) => [v.id, v]));
  const owyNameOfAcc = (a: { customerId: number | null; investorId: number | null } | undefined): string | null => {
    if (!a) return null;
    if (a.investorId != null) { const v = owyInvs.get(a.investorId); return v ? v.nickname || v.fullName : null; }
    if (a.customerId != null) { const c = owyCusts.get(a.customerId); return c ? c.nickname || c.fullName : null; }
    return null;
  };
  const statuses = new Map((await db.tidConfigStatus.findMany({ where: { id: { in: uniqIds(rows.map((r) => r.configStatusId)) } }, select: { id: true, name: true } })).map((s) => [s.id, s]));
  const dsources = new Map((await db.dossierSource.findMany({ where: { id: { in: uniqIds(rows.map((r) => r.dossierSourceId)) } }, select: { id: true, code: true } })).map((s) => [s.id, s]));
  // Khách được giao TID (Tid.customerId) — GD tự liên kết khách theo TID (không chọn tay ở form ghi nhận GD).
  const custs = new Map((await db.customer.findMany({ where: { id: { in: uniqIds(rows.map((r) => r.customerId)) } }, select: { id: true, nickname: true, fullName: true } })).map((c) => [c.id, c]));
  return {
    ok: true,
    data: rows.map((r) => {
      const acc = r.receiveAccountId != null ? accounts.get(r.receiveAccountId) : undefined;
      return {
        id: r.id,
        tid: r.tid,
        status: r.status,
        posSerial: r.posSerial,
        bankId: r.bankId,
        bankCode: r.bankId != null ? banks.get(r.bankId)?.code ?? null : null,
        bankName: r.bankId != null ? nhanBank(banks.get(r.bankId)) : null, // [16/11] mã viết tắt
        partnerId: r.partnerId,
        partnerCode: r.partnerId != null ? partners.get(r.partnerId)?.code ?? null : null,
        partnerName: r.partnerId != null ? partners.get(r.partnerId)?.name ?? null : null,
        hkdName: r.hkdName,
        receiveAccountId: r.receiveAccountId,
        receiveAccountLabel: acc ? `${acc.accountNumber} · ${acc.accountName}` : null,
        owyType: acc ? deriveOwyType(acc.customerId, acc.investorId) : null,
        owyName: owyNameOfAcc(acc),
        investFeeMilli: r.investFeeMilli,
        issuedAt: r.issuedAt ? r.issuedAt.toISOString() : null,
        configStatusId: r.configStatusId,
        configStatusName: r.configStatusId != null ? statuses.get(r.configStatusId)?.name ?? null : null,
        dossierSourceId: r.dossierSourceId,
        dossierSourceCode: r.dossierSourceId != null ? dsources.get(r.dossierSourceId)?.code ?? null : null,
        dossierId: r.dossierId,
        industryId: r.industryId,
        customerId: r.customerId,
        customerName: r.customerId != null ? (custs.get(r.customerId)?.nickname || custs.get(r.customerId)?.fullName || null) : null,
        note: r.note,
        ...trail(r, names)
      };
    })
  };
}

function uniqIds(arr: (number | null)[]): number[] {
  return [...new Set(arr.filter((x): x is number => typeof x === 'number'))];
}

/** Kiểm tra khóa tham chiếu (ngân hàng/đối tác bắt buộc; TK nhận/trạng thái/nguồn hồ sơ nếu có).
 *  PHASE K2 (D5): export để createTidUnified (tid-service) tái dùng — 1 nguồn kiểm chứng ref. */
export async function validateRefs(db: Db, input: { bankId: number; partnerId: number; receiveAccountId?: number | null; configStatusId?: number | null; dossierSourceId?: number | null }): Promise<MutationResult | null> {
  const bank = await db.bank.findUnique({ where: { id: input.bankId } });
  if (!bank || bank.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Ngân hàng đã chọn không tồn tại.' };
  const partner = await db.partner.findUnique({ where: { id: input.partnerId } });
  if (!partner || partner.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Đối tác đã chọn không tồn tại.' };
  if (input.receiveAccountId != null) {
    const a = await db.receiveAccount.findUnique({ where: { id: input.receiveAccountId } });
    if (!a || a.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Tài khoản nhận tiền đã chọn không tồn tại.' };
  }
  if (input.configStatusId != null) {
    const s = await db.tidConfigStatus.findUnique({ where: { id: input.configStatusId } });
    if (!s || s.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Trạng thái TID đã chọn không tồn tại.' };
  }
  if (input.dossierSourceId != null) {
    const d = await db.dossierSource.findUnique({ where: { id: input.dossierSourceId } });
    if (!d || d.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Nguồn hồ sơ đã chọn không tồn tại.' };
  }
  return null;
}

export async function createConfigTid(ctx: ServiceCtx, input: ConfigTidInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const tid = input.tid?.trim();
  const hkdName = input.hkdName?.trim();
  if (!tid) return { ok: false, error: 'VALIDATION', message: 'Chuỗi TID bắt buộc.' };
  if (!input.bankId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn ngân hàng.' };
  if (!input.partnerId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn đối tác.' };
  if (!hkdName) return { ok: false, error: 'VALIDATION', message: 'Tên Hộ Kinh Doanh bắt buộc.' };
  const feeErr = invalidTidInvestFee(input.investFeeMilli); // Money-F1 — trần %phí đầu tư override
  if (feeErr) return { ok: false, error: 'VALIDATION', message: feeErr };
  const refErr = await validateRefs(db, input);
  if (refErr) return refErr;
  // B05: tid @unique + có deletedAt → phân biệt trùng đang dùng vs trùng trong thùng rác.
  const dup = await db.tid.findFirst({ where: { tid } });
  if (dup) {
    return dup.deletedAt
      ? { ok: false, error: 'DUPLICATE_TRASH', message: `TID "${tid}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn TID khác.` }
      : { ok: false, error: 'DUPLICATE', message: `TID "${tid}" đã tồn tại.` };
  }
  let created;
  try {
    created = await db.tid.create({
      data: {
        tid,
        status: 'UNASSIGNED',
        bankId: input.bankId,
        partnerId: input.partnerId,
        hkdName,
        receiveAccountId: input.receiveAccountId ?? null,
        investFeeMilli: input.investFeeMilli ?? null, // Phase B — %phí đầu tư override theo TID
        // [B288/F4 24/11 — agent phản biện] 4 trường này route NHẬN từ client nhưng create VỨT IM (update
        // thì ghi đủ) ⇒ import/bulk/client khác mất dữ liệu câm, API vẫn 200 (R198).
        mid: input.mid?.trim() || null,
        industryId: input.industryId ?? null,
        dossierId: input.dossierId ?? null,
        customerDeviceSerial: input.customerDeviceSerial?.trim() || null,
        issuedAt: parseDate(input.issuedAt) ?? null,
        configStatusId: input.configStatusId ?? null,
        dossierSourceId: input.dossierSourceId ?? null,
        note: input.note?.trim() || null,
        createdBy: user.id
      }
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `TID "${tid}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'TID_CONFIG_CREATED', targetType: 'Tid', targetId: String(created.id), after: auditSnapshot({ tid, bankId: input.bankId, partnerId: input.partnerId, hkdName }) });
  return { ok: true, id: created.id };
}

export async function updateConfigTid(ctx: ServiceCtx, id: number, input: ConfigTidInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const row = await db.tid.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'TID không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;
  const tid = input.tid !== undefined ? input.tid.trim() : row.tid;
  // [B289/F1 24/11 — agent phản biện, CHẶN SHIP] Chuỗi TID là ĐỊNH DANH (khoá join của pos_devices.
  // current_tid, pos_tid_bindings, asset_events, device_deposits/sales, và lo-service tra bill theo CHUỖI).
  // PATCH này trước đây đổi được chuỗi mà KHÔNG cascade, KHÔNG mật khẩu ⇒ máy mang TID vô hình, bill bị
  // từ chối "TID chưa khai báo". Đổi chuỗi CHỈ qua nút "Sửa lỗi nhập chuỗi TID" (renameTidString — cascade
  // 6 bảng + xác nhận mật khẩu).
  if (input.tid !== undefined && tid !== row.tid) {
    return {
      ok: false, error: 'VALIDATION',
      message: 'Chuỗi TID là định danh — không đổi được ở màn này. CÁCH SỬA: dùng nút "Sửa lỗi nhập chuỗi TID" '
        + '(có đồng bộ 6 bảng + xác nhận mật khẩu) ở màn Quản Lý TID.'
    };
  }
  const hkdName = input.hkdName !== undefined ? input.hkdName.trim() : row.hkdName ?? '';
  const bankId = input.bankId ?? row.bankId ?? 0;
  const partnerId = input.partnerId ?? row.partnerId ?? 0;
  if (!tid) return { ok: false, error: 'VALIDATION', message: 'Chuỗi TID không được để trống.' };
  if (!bankId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn ngân hàng.' };
  if (!partnerId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn đối tác.' };
  if (!hkdName) return { ok: false, error: 'VALIDATION', message: 'Tên Hộ Kinh Doanh không được để trống.' };
  if (input.investFeeMilli !== undefined) { // Money-F1 — chỉ validate khi client GỬI (undefined = giữ nguyên cũ)
    const feeErr = invalidTidInvestFee(input.investFeeMilli);
    if (feeErr) return { ok: false, error: 'VALIDATION', message: feeErr };
  }
  const refErr = await validateRefs(db, { bankId, partnerId, receiveAccountId: input.receiveAccountId, configStatusId: input.configStatusId, dossierSourceId: input.dossierSourceId });
  if (refErr) return refErr;
  // Nhóm 1 — validate ngành nghề (nếu gán): phải tồn tại + đang dùng (active). null = gỡ ngành nghề.
  if (input.industryId != null) {
    const ind = await db.industry.findUnique({ where: { id: input.industryId } });
    if (!ind || ind.deletedAt || !ind.active) return { ok: false, error: 'VALIDATION', message: 'Ngành nghề đã chọn không tồn tại hoặc đã ngừng dùng.' };
  }
  if (input.dossierId != null) {
    const d = await db.dossier.findUnique({ where: { id: input.dossierId } });
    if (!d || d.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Hồ sơ HKD đã chọn không tồn tại.' };
  }
  if (tid !== row.tid) {
    const dup = await db.tid.findFirst({ where: { tid, NOT: { id } } });
    if (dup) {
      return dup.deletedAt
        ? { ok: false, error: 'DUPLICATE_TRASH', message: `TID "${tid}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn TID khác.` }
        : { ok: false, error: 'DUPLICATE', message: `TID "${tid}" đã tồn tại.` };
    }
  }
  const before = auditSnapshot({ tid: row.tid, bankId: row.bankId, partnerId: row.partnerId, hkdName: row.hkdName });
  try {
    await db.tid.update({
      where: { id },
      data: {
        tid,
        bankId,
        partnerId,
        hkdName,
        receiveAccountId: input.receiveAccountId !== undefined ? input.receiveAccountId : row.receiveAccountId,
        investFeeMilli: input.investFeeMilli !== undefined ? input.investFeeMilli : row.investFeeMilli, // Phase B
        issuedAt: input.issuedAt !== undefined ? parseDate(input.issuedAt) ?? null : row.issuedAt,
        configStatusId: input.configStatusId !== undefined ? input.configStatusId : row.configStatusId,
        dossierSourceId: input.dossierSourceId !== undefined ? input.dossierSourceId : row.dossierSourceId,
        note: input.note !== undefined ? input.note?.trim() || null : row.note,
        mid: input.mid !== undefined ? input.mid?.trim() || null : row.mid,
        industryId: input.industryId !== undefined ? input.industryId : row.industryId,
        dossierId: input.dossierId !== undefined ? input.dossierId : row.dossierId,
        customerDeviceSerial: input.customerDeviceSerial !== undefined ? input.customerDeviceSerial?.trim() || null : row.customerDeviceSerial,
        updatedBy: user.id
      }
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `TID "${tid}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'TID_CONFIG_UPDATED', targetType: 'Tid', targetId: String(id), before, after: auditSnapshot({ tid, bankId, partnerId, hkdName, industryId: input.industryId !== undefined ? input.industryId : row.industryId }) });
  return { ok: true, id };
}

/** Kết quả cascade khi SỬA LỖI NHẬP chuỗi TID — số dòng đã cập nhật MỖI bảng nối theo chuỗi (đếm ĐỘNG, R198:
 *  cấm hard-code → phát hiện ngay nếu 1 bảng bị sót). */
export interface RenameTidCascade {
  assetEvents: number; // asset_events.tid — timeline vòng đời
  bindings: number; // pos_tid_bindings.tid — gắn máy POS (lịch sử + binding mở)
  posDevices: number; // pos_devices.current_tid — TID hiện tại của máy
  deposits: number; // device_deposits.tid — nhãn TID chứng từ cọc
  sales: number; // device_sales.tid — nhãn TID chứng từ bán
  exportLines: number; // export_request_lines.tid — dòng yêu cầu xuất kho
  ocrSent: number; // [B318] ocr_bill_sent.ocr_send_key — marker chống gửi-lại bill (chứa chuỗi TID)
}

/**
 * SỬA LỖI NHẬP chuỗi TID (Admin Demo 3/9) — đổi ĐỊNH DANH chuỗi TID + CASCADE NGUYÊN TỬ mọi bảng nối theo CHUỖI trong
 * 1 transaction, để KHÔNG sót (bug class: đổi định danh mà quên bảng nối → mồ côi lịch sử/lệch máy). Các bảng nối
 * theo `id` SỐ (LoRow.tidId=doanh số lô, ChatRoomTid.tidId=nối nhóm chat quy doanh số, TidSellFee.tidId) TỰ ĐÚNG —
 * KHÔNG cần đụng. CỐ Ý KHÔNG viết lại `Lo.billKey` (khóa chống trùng TIỀN, chứa chuỗi cũ) — rủi ro va chạm/đụng tiền;
 * doanh số cũ vẫn quy về đúng TID qua LoRow.tidId, OCR sau này tự dùng chuỗi mới. GATE mật khẩu + rate-limit ở ROUTE
 * (verifyActorPassword TRƯỚC khi gọi — khuôn §14). KHÁC updateConfigTid: hàm này CHỈ đổi chuỗi (không sửa field khác),
 * và LÀ nơi DUY NHẤT được đổi chuỗi TID có lịch sử (form Sửa thường giữ chuỗi immutable).
 */
export async function renameTidString(ctx: ServiceCtx, id: number, newTidRaw: string, expectedUpdatedAt?: string | null): Promise<MutationResult & { cascade?: RenameTidCascade }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const newTid = newTidRaw?.trim();
  if (!newTid) return { ok: false, error: 'VALIDATION', message: 'Chuỗi TID mới bắt buộc.' };
  const row = await db.tid.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'TID không tồn tại.' };
  const stale = staleGuard(row.updatedAt, expectedUpdatedAt);
  if (stale) return stale;
  const oldTid = row.tid;
  if (newTid === oldTid) return { ok: false, error: 'VALIDATION', message: 'Chuỗi TID mới trùng chuỗi cũ — không có gì để sửa.' };
  // Chống đổi sang chuỗi đã có (đang dùng hoặc trong thùng rác) — @unique(tid) cũng chặn ở DB (backstop catch).
  const dup = await db.tid.findFirst({ where: { tid: newTid, NOT: { id } } });
  if (dup) {
    return dup.deletedAt
      ? { ok: false, error: 'DUPLICATE_TRASH', message: `TID "${newTid}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn TID khác.` }
      : { ok: false, error: 'DUPLICATE', message: `TID "${newTid}" đã tồn tại — không thể trùng.` };
  }
  const before = auditSnapshot({ tid: oldTid });
  let cascade: RenameTidCascade;
  try {
    cascade = await db.$transaction(async (tx) => {
      await tx.tid.update({ where: { id }, data: { tid: newTid, updatedBy: user.id } });
      const ae = await tx.assetEvent.updateMany({ where: { tid: oldTid }, data: { tid: newTid } });
      const bd = await tx.posTidBinding.updateMany({ where: { tid: oldTid }, data: { tid: newTid } });
      const pd = await tx.posDevice.updateMany({ where: { currentTid: oldTid }, data: { currentTid: newTid } });
      const dp = await tx.deviceDeposit.updateMany({ where: { tid: oldTid }, data: { tid: newTid } });
      const sl = await tx.deviceSale.updateMany({ where: { tid: oldTid }, data: { tid: newTid } });
      const el = await tx.exportRequestLine.updateMany({ where: { tid: oldTid }, data: { tid: newTid } });
      // [B318/F4 24/11 — agent đào vét] ocr_bill_sent.ocr_send_key chứa CHUỖI TID ('<tid>|<lô>|…') —
      // bỏ sót thì sau rename lớp chống-gửi-lại dựng key bằng chuỗi MỚI, miss marker cũ ⇒ BILL CŨ GỬI
      // LẠI phòng đại lý (đo: 1 dòng chuỗi cũ nằm nguyên). Thay 2 đoạn như khuôn bill-edit-service.
      const ob = await tx.$executeRawUnsafe(
        `UPDATE ocr_bill_sent SET ocr_send_key = replace(ocr_send_key, $1 || '|', $2 || '|')
          WHERE ocr_send_key LIKE $1 || '|%'`, oldTid, newTid);
      return { assetEvents: ae.count, bindings: bd.count, posDevices: pd.count, deposits: dp.count, sales: sl.count, exportLines: el.count, ocrSent: Number(ob) };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `TID "${newTid}" đã tồn tại — không thể trùng.` };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'TID_STRING_CORRECTED', targetType: 'Tid', targetId: String(id), before, after: auditSnapshot({ tid: newTid, oldTid, cascade }) });
  return { ok: true, id, cascade };
}

/**
 * NỘI BỘ (KHÔNG có route API — R34: desktop đã GỠ IPC xóa cấu hình TID trực tiếp, xóa TID CHỈ qua Duyệt Hủy
 * TID_CANCEL_*). Giữ lõi để parity + entity-cancel tương lai tái dùng. §14 xác nhận MẬT KHẨU do ADAPTER (nếu
 * có ngày expose lại) kiểm TRƯỚC khi gọi.
 */
export async function deleteConfigTids(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn TID để xóa.' };
  let deleted = 0;
  for (const id of ids) {
    const row = await db.tid.findUnique({ where: { id } });
    if (!row || row.deletedAt) continue;
    await db.tid.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.id, deletedBy: user.id } });
    await writeAudit(db, { actorUserId: user.id, action: 'TID_CONFIG_DELETED', targetType: 'Tid', targetId: String(id), before: auditSnapshot({ tid: row.tid }) });
    deleted++;
  }
  return { ok: true, deleted };
}
