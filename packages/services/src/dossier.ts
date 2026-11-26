// Quản lý Hồ sơ HKD — LÕI THUẦN ctx-based. PORT nghiệp vụ từ apps/desktop/src/main/dossier-service.ts (IMS_SPEC §10).
// Thay `requirePermission(current-user global)` bằng ctx = { db, user } do adapter dựng; mỗi hàm tự kiểm quyền qua
// hasPermission(ctx.user, CONFIG_DOSSIER_*). GIỮ NGUYÊN business: Nguồn hồ sơ (§10a/b: mã + chiết khấu % ×1000) +
// Hồ sơ HKD (§10c/d: đủ trường). Audit before/after, soft-delete, DUPLICATE_TRASH, P2002 guard, optimistic-lock.
// XÁC NHẬN MẬT KHẨU (§14) do ADAPTER kiểm TRƯỚC khi gọi lõi (khớp customer.ts) — lõi KHÔNG kiểm password.
//
// ĐÍNH KÈM (ảnh ĐKKD/CCCD) — TENTATIVE (LEAD quyết): desktop lưu ảnh qua file-store đĩa (storeAttachment) rồi ghi
// path/tên vào cột dkkd*Path/cccd*Path. Ở bản THUẦN SERVER lõi này CHỈ port METADATA (mọi trường text/ngày +
// ĐỌC path/tên ảnh trong DTO) — KHÔNG nhận/ghi BYTES ảnh (bỏ *Src của DossierInput). Upload/gỡ ảnh cần route
// multipart RIÊNG (đề xuất `POST /v1/dossiers/:id/attachment` + storage do LEAD chốt: BLOB-DB hay object-store).
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
import { dieuKienTimKiem } from './tim-kiem-hoa-thuong.js';

const VIEW = 'CONFIG_DOSSIER_VIEW';
const MANAGE = 'CONFIG_DOSSIER_MANAGE';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';
const SCALE = 1000; // phần trăm × 1000 (≤3 thập phân, Int chính xác)
// FIX-PERF — phân trang/take-cap chống kéo full-bảng (khuôn listCustomers). Client KHÔNG gửi → trang 1, take 100.
const DOSSIER_PAGE_SIZE_DEFAULT = 100;
const DOSSIER_PAGE_SIZE_MAX = 500;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}
/** Phần trăm (số, ≤3 thập phân, ≥0) → Int ×1000. null nếu không hợp lệ. */
function pctToMilli(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  const milli = Math.round(n * SCALE);
  if (Math.abs(n * SCALE - milli) > 1e-6) return null; // quá 3 số thập phân
  return milli;
}
const milliToPct = (m: number): number => m / SCALE;

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

// Trạng thái MST hồ sơ HKD (§10c): 'ACTIVE'=Hoạt động / 'CLOSED'=Đóng.
const MST_STATUSES = ['ACTIVE', 'CLOSED'] as const;
function isMstStatus(v: unknown): v is (typeof MST_STATUSES)[number] {
  return typeof v === 'string' && (MST_STATUSES as readonly string[]).includes(v);
}

// ═════════════════════════════════════════════════════════════════════════════
// §10a/b — NGUỒN HỒ SƠ
// ═════════════════════════════════════════════════════════════════════════════
export interface DossierSourceDto extends AuditTrail {
  id: number;
  code: string;
  discountRate: number; // phần trăm (đã /1000)
}
export interface CreateDossierSourceInput {
  code: string;
  discountRate: number;
}
export interface UpdateDossierSourceInput {
  code?: string;
  discountRate?: number;
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock — mốc updatedAt client giữ lúc mở form
}

export async function listDossierSources(ctx: ServiceCtx): Promise<{ ok: boolean; data?: DossierSourceDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.dossierSource.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.createdBy, r.updatedBy]));
  return { ok: true, data: rows.map((r) => ({ id: r.id, code: r.code, discountRate: milliToPct(r.discountRate), ...trail(r, names) })) };
}

export async function createDossierSource(ctx: ServiceCtx, input: CreateDossierSourceInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const code = input.code?.trim();
  if (!code) return { ok: false, error: 'VALIDATION', message: 'Mã nguồn hồ sơ bắt buộc.' };
  const milli = pctToMilli(input.discountRate);
  if (milli === null) return { ok: false, error: 'VALIDATION', message: 'Chính sách chiết khấu phải ≥ 0 và tối đa 3 số thập phân.' };
  const dup = await db.dossierSource.findFirst({ where: { code } });
  if (dup) {
    return dup.deletedAt
      ? { ok: false, error: 'DUPLICATE_TRASH', message: `Mã nguồn hồ sơ "${code}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn mã khác.` }
      : { ok: false, error: 'DUPLICATE', message: `Mã nguồn hồ sơ "${code}" đã tồn tại.` };
  }
  let created;
  try {
    created = await db.dossierSource.create({ data: { code, discountRate: milli, createdBy: user.id } });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `Mã nguồn hồ sơ "${code}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'DOSSIER_SOURCE_CREATED', targetType: 'DossierSource', targetId: String(created.id), after: auditSnapshot({ code, discountRate: milli }) });
  return { ok: true, id: created.id };
}

export async function updateDossierSource(ctx: ServiceCtx, id: number, input: UpdateDossierSourceInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const row = await db.dossierSource.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Nguồn hồ sơ không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;
  const code = input.code !== undefined ? input.code.trim() : row.code;
  if (!code) return { ok: false, error: 'VALIDATION', message: 'Mã nguồn hồ sơ không được để trống.' };
  let milli = row.discountRate;
  if (input.discountRate !== undefined) {
    const m = pctToMilli(input.discountRate);
    if (m === null) return { ok: false, error: 'VALIDATION', message: 'Chính sách chiết khấu phải ≥ 0 và tối đa 3 số thập phân.' };
    milli = m;
  }
  if (code !== row.code) {
    const dup = await db.dossierSource.findFirst({ where: { code, NOT: { id } } });
    if (dup) {
      return dup.deletedAt
        ? { ok: false, error: 'DUPLICATE_TRASH', message: `Mã nguồn hồ sơ "${code}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn mã khác.` }
        : { ok: false, error: 'DUPLICATE', message: `Mã nguồn hồ sơ "${code}" đã tồn tại.` };
    }
  }
  const before = auditSnapshot({ code: row.code, discountRate: row.discountRate });
  let updated;
  try {
    updated = await db.dossierSource.update({ where: { id }, data: { code, discountRate: milli, updatedBy: user.id } });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `Mã nguồn hồ sơ "${code}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'DOSSIER_SOURCE_UPDATED', targetType: 'DossierSource', targetId: String(id), before, after: auditSnapshot({ code: updated.code, discountRate: updated.discountRate }) });
  return { ok: true, id };
}

/** Xóa mềm 1..n nguồn hồ sơ. Xác nhận MẬT KHẨU (§14) do ADAPTER kiểm TRƯỚC khi gọi (lõi giả định caller đã xác thực). */
export async function deleteDossierSources(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn nguồn hồ sơ để xóa.' };
  let deleted = 0;
  for (const id of ids) {
    const row = await db.dossierSource.findUnique({ where: { id } });
    if (!row || row.deletedAt) continue;
    await db.dossierSource.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.id, deletedBy: user.id } });
    await writeAudit(db, { actorUserId: user.id, action: 'DOSSIER_SOURCE_DELETED', targetType: 'DossierSource', targetId: String(id), before: auditSnapshot({ code: row.code }) });
    deleted++;
  }
  return { ok: true, deleted };
}

// ═════════════════════════════════════════════════════════════════════════════
// §10c/d — HỒ SƠ HKD
// ═════════════════════════════════════════════════════════════════════════════
export interface DossierDto extends AuditTrail {
  id: number;
  sourceId: number;
  sourceCode: string | null;
  hkdName: string;
  hkdAddress: string | null;
  taxCode: string | null;
  mstStatus: string; // 'ACTIVE'=Hoạt động / 'CLOSED'=Đóng
  dkkdIssueDate: string | null;
  dkkdIssuePlace: string | null;
  ownerName: string;
  gender: string | null;
  ethnicity: string | null;
  cccdNumber: string | null;
  cccdIssueDate: string | null;
  cccdIssuePlace: string | null;
  cccdExpiry: string | null;
  permanentAddress: string | null;
  currentAddress: string | null;
  email: string | null;
  // Ảnh ĐKKD/CCCD (ĐỌC path/tên đã lưu). Upload/gỡ qua route multipart riêng (TENTATIVE — xem đầu file).
  dkkdFrontPath: string | null;
  dkkdFrontName: string | null;
  dkkdBackPath: string | null;
  dkkdBackName: string | null;
  cccdFrontPath: string | null;
  cccdFrontName: string | null;
  cccdBackPath: string | null;
  cccdBackName: string | null;
  note: string | null;
}
export interface DossierFilter {
  search?: string;
  sourceId?: number;
  mstStatus?: string; // lọc theo trạng thái MST ('ACTIVE'/'CLOSED'); bỏ trống = tất cả
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
}
/** Đầu vào tạo/sửa hồ sơ — CHỈ METADATA (không nhận bytes ảnh; upload ảnh qua route riêng — TENTATIVE). */
export interface DossierInput {
  sourceId: number;
  hkdName: string;
  hkdAddress?: string | null;
  taxCode?: string | null;
  mstStatus?: string; // 'ACTIVE' (mặc định) / 'CLOSED'
  dkkdIssueDate?: string | null;
  dkkdIssuePlace?: string | null;
  ownerName: string;
  gender?: string | null;
  ethnicity?: string | null;
  cccdNumber?: string | null;
  cccdIssueDate?: string | null;
  cccdIssuePlace?: string | null;
  cccdExpiry?: string | null;
  permanentAddress?: string | null;
  currentAddress?: string | null;
  email?: string | null;
  note?: string | null;
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock — mốc updatedAt client giữ lúc mở form (chỉ dùng ở updateDossier)
}

export async function listDossiers(ctx: ServiceCtx, filter: DossierFilter = {}): Promise<{ ok: boolean; data?: DossierDto[]; total?: number; page?: number; pageSize?: number; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(DOSSIER_PAGE_SIZE_MAX, Math.max(1, filter.pageSize ?? DOSSIER_PAGE_SIZE_DEFAULT));
  const where: Record<string, unknown> = {
    deletedAt: null,
    sourceId: filter.sourceId ?? undefined,
    mstStatus: isMstStatus(filter.mstStatus) ? filter.mstStatus : undefined,
    createdAt: dateRange(filter.fromDate, filter.toDate),
    // Tìm kiếm tên HKD/chủ hộ/MST/CCCD — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts).
    AND: await dieuKienTimKiem(db, 'dossiers', { hkdName: 'hkd_name', ownerName: 'owner_name', taxCode: 'tax_code', cccdNumber: 'cccd_number' }, filter.search)
  };
  const total = await db.dossier.count({ where });
  const rows = await db.dossier.findMany({
    where,
    orderBy: { id: 'asc' },
    skip: (page - 1) * pageSize,
    take: pageSize
  });
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.createdBy, r.updatedBy]));
  const sources = new Map((await db.dossierSource.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.sourceId))] } }, select: { id: true, code: true } })).map((s) => [s.id, s]));
  return {
    ok: true,
    total,
    page,
    pageSize,
    data: rows.map((r) => ({
      id: r.id,
      sourceId: r.sourceId,
      sourceCode: sources.get(r.sourceId)?.code ?? null,
      hkdName: r.hkdName,
      hkdAddress: r.hkdAddress,
      taxCode: r.taxCode,
      mstStatus: r.mstStatus,
      dkkdIssueDate: r.dkkdIssueDate ? r.dkkdIssueDate.toISOString() : null,
      dkkdIssuePlace: r.dkkdIssuePlace,
      ownerName: r.ownerName,
      gender: r.gender,
      ethnicity: r.ethnicity,
      cccdNumber: r.cccdNumber,
      cccdIssueDate: r.cccdIssueDate ? r.cccdIssueDate.toISOString() : null,
      cccdIssuePlace: r.cccdIssuePlace,
      cccdExpiry: r.cccdExpiry ? r.cccdExpiry.toISOString() : null,
      permanentAddress: r.permanentAddress,
      currentAddress: r.currentAddress,
      email: r.email,
      dkkdFrontPath: r.dkkdFrontPath,
      dkkdFrontName: r.dkkdFrontName,
      dkkdBackPath: r.dkkdBackPath,
      dkkdBackName: r.dkkdBackName,
      cccdFrontPath: r.cccdFrontPath,
      cccdFrontName: r.cccdFrontName,
      cccdBackPath: r.cccdBackPath,
      cccdBackName: r.cccdBackName,
      note: r.note,
      ...trail(r, names)
    }))
  };
}

/** Nguồn hồ sơ tồn tại & còn sống. */
async function validateRefs(db: Db, sourceId: number): Promise<MutationResult | null> {
  const src = await db.dossierSource.findUnique({ where: { id: sourceId } });
  if (!src || src.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Nguồn hồ sơ đã chọn không tồn tại.' };
  return null;
}

export async function createDossier(ctx: ServiceCtx, input: DossierInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const hkdName = input.hkdName?.trim();
  const ownerName = input.ownerName?.trim();
  if (!input.sourceId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn nguồn hồ sơ.' };
  if (!hkdName) return { ok: false, error: 'VALIDATION', message: 'Tên Hộ Kinh Doanh bắt buộc.' };
  if (!ownerName) return { ok: false, error: 'VALIDATION', message: 'Tên chủ hộ kinh doanh bắt buộc.' };
  if (input.mstStatus !== undefined && !isMstStatus(input.mstStatus)) return { ok: false, error: 'VALIDATION', message: 'Trạng thái MST không hợp lệ (chỉ Hoạt động / Đóng).' };
  const refErr = await validateRefs(db, input.sourceId);
  if (refErr) return refErr;

  const created = await db.dossier.create({
    data: {
      sourceId: input.sourceId,
      hkdName,
      hkdAddress: input.hkdAddress?.trim() || null,
      taxCode: input.taxCode?.trim() || null,
      mstStatus: isMstStatus(input.mstStatus) ? input.mstStatus : 'ACTIVE',
      dkkdIssueDate: parseDate(input.dkkdIssueDate) ?? null,
      dkkdIssuePlace: input.dkkdIssuePlace?.trim() || null,
      ownerName,
      gender: input.gender?.trim() || null,
      ethnicity: input.ethnicity?.trim() || null,
      cccdNumber: input.cccdNumber?.trim() || null,
      cccdIssueDate: parseDate(input.cccdIssueDate) ?? null,
      cccdIssuePlace: input.cccdIssuePlace?.trim() || null,
      cccdExpiry: parseDate(input.cccdExpiry) ?? null,
      permanentAddress: input.permanentAddress?.trim() || null,
      currentAddress: input.currentAddress?.trim() || null,
      email: input.email?.trim() || null,
      note: input.note?.trim() || null,
      createdBy: user.id
    }
  });
  await writeAudit(db, { actorUserId: user.id, action: 'DOSSIER_CREATED', targetType: 'Dossier', targetId: String(created.id), after: auditSnapshot({ hkdName, ownerName, sourceId: input.sourceId }) });
  return { ok: true, id: created.id };
}

export async function updateDossier(ctx: ServiceCtx, id: number, input: DossierInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const row = await db.dossier.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Hồ sơ không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;
  const hkdName = input.hkdName !== undefined ? input.hkdName.trim() : row.hkdName;
  const ownerName = input.ownerName !== undefined ? input.ownerName.trim() : row.ownerName;
  const sourceId = input.sourceId ?? row.sourceId;
  if (!hkdName) return { ok: false, error: 'VALIDATION', message: 'Tên Hộ Kinh Doanh không được để trống.' };
  if (!ownerName) return { ok: false, error: 'VALIDATION', message: 'Tên chủ hộ không được để trống.' };
  if (input.mstStatus !== undefined && !isMstStatus(input.mstStatus)) return { ok: false, error: 'VALIDATION', message: 'Trạng thái MST không hợp lệ (chỉ Hoạt động / Đóng).' };
  const refErr = await validateRefs(db, sourceId);
  if (refErr) return refErr;

  const before = auditSnapshot({ hkdName: row.hkdName, ownerName: row.ownerName, sourceId: row.sourceId });
  await db.dossier.update({
    where: { id },
    data: {
      sourceId,
      hkdName,
      hkdAddress: input.hkdAddress !== undefined ? input.hkdAddress?.trim() || null : row.hkdAddress,
      taxCode: input.taxCode !== undefined ? input.taxCode?.trim() || null : row.taxCode,
      mstStatus: isMstStatus(input.mstStatus) ? input.mstStatus : row.mstStatus,
      dkkdIssueDate: input.dkkdIssueDate !== undefined ? parseDate(input.dkkdIssueDate) ?? null : row.dkkdIssueDate,
      dkkdIssuePlace: input.dkkdIssuePlace !== undefined ? input.dkkdIssuePlace?.trim() || null : row.dkkdIssuePlace,
      ownerName,
      gender: input.gender !== undefined ? input.gender?.trim() || null : row.gender,
      ethnicity: input.ethnicity !== undefined ? input.ethnicity?.trim() || null : row.ethnicity,
      cccdNumber: input.cccdNumber !== undefined ? input.cccdNumber?.trim() || null : row.cccdNumber,
      cccdIssueDate: input.cccdIssueDate !== undefined ? parseDate(input.cccdIssueDate) ?? null : row.cccdIssueDate,
      cccdIssuePlace: input.cccdIssuePlace !== undefined ? input.cccdIssuePlace?.trim() || null : row.cccdIssuePlace,
      cccdExpiry: input.cccdExpiry !== undefined ? parseDate(input.cccdExpiry) ?? null : row.cccdExpiry,
      permanentAddress: input.permanentAddress !== undefined ? input.permanentAddress?.trim() || null : row.permanentAddress,
      currentAddress: input.currentAddress !== undefined ? input.currentAddress?.trim() || null : row.currentAddress,
      email: input.email !== undefined ? input.email?.trim() || null : row.email,
      note: input.note !== undefined ? input.note?.trim() || null : row.note,
      updatedBy: user.id
    }
  });
  await writeAudit(db, { actorUserId: user.id, action: 'DOSSIER_UPDATED', targetType: 'Dossier', targetId: String(id), before, after: auditSnapshot({ hkdName, ownerName, sourceId }) });
  return { ok: true, id };
}

/** Xóa mềm 1..n hồ sơ. Xác nhận MẬT KHẨU (§14) do ADAPTER kiểm TRƯỚC khi gọi. */
export async function deleteDossiers(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn hồ sơ để xóa.' };
  let deleted = 0;
  for (const id of ids) {
    const row = await db.dossier.findUnique({ where: { id } });
    if (!row || row.deletedAt) continue;
    await db.dossier.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.id, deletedBy: user.id } });
    await writeAudit(db, { actorUserId: user.id, action: 'DOSSIER_DELETED', targetType: 'Dossier', targetId: String(id), before: auditSnapshot({ hkdName: row.hkdName, ownerName: row.ownerName }) });
    deleted++;
  }
  return { ok: true, deleted };
}

// ═════════════════════════════════════════════════════════════════════════════
// ĐÍNH KÈM ẢNH ĐKKD/CCCD — KHO FILE SERVER (thuần server, xem file-store.ts). BYTES đi qua route multipart RIÊNG
// (apps/quanly-api dossier.ts), lõi này nhận BUFFER + ghi kho + lưu path/tên vào DB (KHÔNG BLOB). Nhận ảnh + PDF
// (DOC_FAMILIES) vì ĐKKD/CCCD desktop vốn cho scan PDF. Thay ảnh cùng mặt → trash bản cũ (R_AUDIT_TRAIL).
// ═════════════════════════════════════════════════════════════════════════════
export type DossierAttachField = 'dkkdFront' | 'dkkdBack' | 'cccdFront' | 'cccdBack';
const DOSSIER_ATTACH_FIELDS: DossierAttachField[] = ['dkkdFront', 'dkkdBack', 'cccdFront', 'cccdBack'];
export function isDossierAttachField(v: unknown): v is DossierAttachField {
  return typeof v === 'string' && (DOSSIER_ATTACH_FIELDS as string[]).includes(v);
}

type DossierAttachCols = { dkkdFrontPath: string | null; dkkdFrontName: string | null; dkkdBackPath: string | null; dkkdBackName: string | null; cccdFrontPath: string | null; cccdFrontName: string | null; cccdBackPath: string | null; cccdBackName: string | null };
function dossierAttachPath(row: DossierAttachCols, field: DossierAttachField): string | null {
  switch (field) {
    case 'dkkdFront': return row.dkkdFrontPath;
    case 'dkkdBack': return row.dkkdBackPath;
    case 'cccdFront': return row.cccdFrontPath;
    case 'cccdBack': return row.cccdBackPath;
  }
}
function dossierAttachName(row: DossierAttachCols, field: DossierAttachField): string | null {
  switch (field) {
    case 'dkkdFront': return row.dkkdFrontName;
    case 'dkkdBack': return row.dkkdBackName;
    case 'cccdFront': return row.cccdFrontName;
    case 'cccdBack': return row.cccdBackName;
  }
}
/** Đối tượng update chỉ chứa ĐÚNG cặp cột (path/name) của 1 mặt — literal keys nên khớp DossierUpdateInput. */
function dossierAttachUpdate(field: DossierAttachField, path: string | null, name: string | null) {
  switch (field) {
    case 'dkkdFront': return { dkkdFrontPath: path, dkkdFrontName: name };
    case 'dkkdBack': return { dkkdBackPath: path, dkkdBackName: name };
    case 'cccdFront': return { cccdFrontPath: path, cccdFrontName: name };
    case 'cccdBack': return { cccdBackPath: path, cccdBackName: name };
  }
}

/** Upload/thay 1 ảnh ĐKKD/CCCD của hồ sơ. Route ĐÃ validate quyền phiên + parse multipart; lõi kiểm quyền MANAGE. */
export async function setDossierAttachment(ctx: ServiceCtx, id: number, field: string, upload: AttachmentUpload): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!isDossierAttachField(field)) return { ok: false, error: 'VALIDATION', message: 'Loại ảnh hồ sơ không hợp lệ (chỉ ĐKKD/CCCD mặt trước/sau).' };
  const row = await db.dossier.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Hồ sơ không tồn tại.' };
  const stored = storeFile('dossiers', id, upload.buffer, DOC_FAMILIES);
  if (!stored.ok) return { ok: false, error: stored.error, message: stored.message };
  const oldPath = dossierAttachPath(row as DossierAttachCols, field);
  const name = upload.originalName?.trim() || null;
  await db.dossier.update({ where: { id }, data: { ...dossierAttachUpdate(field, stored.file.relPath, name), updatedBy: user.id } });
  if (oldPath && oldPath !== stored.file.relPath) trashFileFromStore(oldPath);
  await writeAudit(db, { actorUserId: user.id, action: 'DOSSIER_ATTACHMENT_SET', targetType: 'Dossier', targetId: String(id), after: auditSnapshot({ field, relPath: stored.file.relPath, bytes: stored.file.size }) });
  return { ok: true, id };
}

/** Tải 1 ảnh ĐKKD/CCCD của hồ sơ về (bytes + mime). Route set Content-Type rồi res.send. Lõi kiểm quyền VIEW. */
export async function getDossierAttachment(ctx: ServiceCtx, id: number, field: string): Promise<AttachmentDownload> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  if (!isDossierAttachField(field)) return { ok: false, error: 'VALIDATION', message: 'Loại ảnh hồ sơ không hợp lệ (chỉ ĐKKD/CCCD mặt trước/sau).' };
  const row = await db.dossier.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Hồ sơ không tồn tại.' };
  const path = dossierAttachPath(row as DossierAttachCols, field);
  if (!path) return { ok: false, error: 'NOT_FOUND', message: 'Hồ sơ chưa có ảnh này.' };
  const r = readFileFromStore(path);
  if (!r.ok) return { ok: false, error: r.error, message: r.message };
  return { ok: true, buffer: r.buffer, mime: r.mime, fileName: dossierAttachName(row as DossierAttachCols, field) };
}
