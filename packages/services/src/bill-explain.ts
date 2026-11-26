// Bill giải trình — LÕI THUẦN ctx-based. PORT phần CRUD DỮ LIỆU từ apps/desktop/src/main/bill-explain-service.ts
// (Admin Demo 16/7). Thay `requirePermission(current-user global)` bằng ctx = { db, user }; mỗi hàm tự kiểm quyền qua
// hasPermission(ctx.user, ...). GIỮ NGUYÊN business + message tiếng Việt. XÁC NHẬN MẬT KHẨU (§14) do ADAPTER kiểm
// TRƯỚC khi gọi lõi (khớp customer.ts) — lõi KHÔNG kiểm password.
//
// PHẠM VI đợt này (CHỈ CRUD DỮ LIỆU thuần-DB): (A) Thư viện sản phẩm — listProducts/createProduct/updateProduct/
// deleteProducts/importProducts. (B) Theo dõi bill — listBillExplains/deleteBillExplains.
//
// KHÔNG PORT trong đợt này (Electron/file/dialog + storage chưa chốt — GIỮ IPC ở desktop):
//   • importInvoiceTemplate / exportInvoiceTemplate / resetInvoiceTemplate / getBillExplainConfig / setBillExplainConfig
//     / getBillFilePath / getBillOutputDir — dùng dialog/BrowserWindow/fs + AppSetting đường-dẫn-đĩa-Electron.
//   • generateBills — TENTATIVE (LEAD quyết): sinh file .xlsx qua renderBills (engine billexplain/ ~680 dòng, thuần
//     Node) + resolveTemplatePath/resolveOutputDir dùng Electron `app.getPath`. Bản thuần-server cần: (1) template
//     .xlsx được cấp trên server, (2) thư mục xuất là đường dẫn server, (3) 1 route TẢI/MỞ file (đã loại khỏi đợt
//     này). Đây LÀ CÙNG cổng storage-design như đính kèm ảnh — KHÔNG tự thiết kế, chờ LEAD chốt cơ chế (render tại
//     server + download route, hay trả bytes .xlsx về client). Cột BillExplain.filePath BẮT BUỘC non-null nên
//     KHÔNG thể tạo bản ghi generateBills khi chưa chốt nơi lưu file.
import { auditSnapshot } from '@sigma/business-rules';
import { hasPermission, groupDigits } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit, writeAuditStrict } from './audit.js';
import { nextCode } from './code.js';
import { staleGuard } from './optimistic-lock.js';
import { dateRange, type ServiceCtx, type MutationResult } from './customer.js';
// TÌM KIẾM hoa/thường: DB collation "C" → Prisma mode:'insensitive' (ILIKE) KHÔNG gập chữ tiếng Việt có dấu
// (đo thật trên sổ thật: ILIKE '%nguyễn%' = 0 dòng / ILIKE '%NGUYỄN%' = 10 dòng). Xem tim-kiem-hoa-thuong.ts.
import { dieuKienTimKiem } from './tim-kiem-hoa-thuong.js';

const VIEW = 'BILLEXPLAIN_VIEW';
const PRODUCT_MANAGE = 'PRODUCT_MANAGE';
const BILLEXPLAIN_DELETE = 'BILLEXPLAIN_DELETE';
const BILLEXPLAIN_CREATE = 'BILLEXPLAIN_CREATE';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';
// FIX-PERF — phân trang/take-cap chống kéo full-bảng (khuôn listCustomers). Client KHÔNG gửi → trang 1, take 100.
const PRODUCT_PAGE_SIZE_DEFAULT = 100;
const PRODUCT_PAGE_SIZE_MAX = 500;
const BILLEXPLAIN_PAGE_SIZE_DEFAULT = 100;
const BILLEXPLAIN_PAGE_SIZE_MAX = 500;

// ═══════════════════════════════════════════════════════════════════════════════
// (A) THƯ VIỆN SẢN PHẨM
// ═══════════════════════════════════════════════════════════════════════════════
export interface ProductDto {
  id: number;
  industryId: number;
  industryName: string | null;
  name: string;
  unit: string;
  price: number;
  priority: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}
export interface ProductFilter {
  industryId?: number;
  search?: string;
  status?: string; // ACTIVE | INACTIVE
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
}
export interface CreateProductInput {
  industryId: number;
  name: string;
  unit: string;
  price: number;
  priority?: number;
  status?: string;
}
export interface UpdateProductInput {
  industryId?: number;
  name?: string;
  unit?: string;
  price?: number;
  priority?: number;
  status?: string;
  expectedUpdatedAt?: string | null;
}

async function industryNameMap(db: Db, ids: number[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids)];
  const map = new Map<number, string>();
  if (!uniq.length) return map;
  const rows = await db.industry.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
  for (const r of rows) map.set(r.id, r.name);
  return map;
}
/** Đơn giá SP hợp lệ (VND, số nguyên dương ≤ MAX_SAFE). VN-format cho phép dấu nhóm nghìn `. , ` khoảng
 *  trắng (import "45.000"→45000) NHƯNG chặn dấu âm/mũ/chữ (`-100`/`1e3`/`abc`→null) — không đổi giá trị ngầm
 *  (FE53-06 / lớp B62). Số truyền vào phải nguyên dương. */
function validPrice(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isInteger(v) && v > 0 && v <= Number.MAX_SAFE_INTEGER ? v : null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || !/^[\d.,\s]+$/.test(s)) return null; // chỉ chữ số + dấu nhóm; loại '-'/'e'/chữ
  const digits = s.replace(/[.,\s]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const b = BigInt(digits);
  if (b <= 0n || b > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(b);
}
/** Ưu tiên SP: số nguyên 0..1000 (cao = hữu dụng hơn). Không hợp lệ/thiếu → 0 (trung tính, không đổi hành vi cũ). */
function validPriority(v: unknown): number {
  let n: number | null = null;
  if (typeof v === 'number' && Number.isInteger(v)) n = v;
  else if (typeof v === 'string' && /^\d+$/.test(v.trim())) n = Number(v.trim());
  if (n === null || n < 0) return 0;
  return Math.min(n, 1000);
}

export async function listProducts(ctx: ServiceCtx, filter: ProductFilter = {}): Promise<{ ok: boolean; data?: ProductDto[]; total?: number; page?: number; pageSize?: number; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(PRODUCT_PAGE_SIZE_MAX, Math.max(1, filter.pageSize ?? PRODUCT_PAGE_SIZE_DEFAULT));
  const where: Record<string, unknown> = {
    deletedAt: null,
    industryId: filter.industryId ?? undefined,
    status: filter.status || undefined,
    createdAt: dateRange(filter.fromDate, filter.toDate),
    // Tìm kiếm tên/đơn vị SP — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts).
    AND: await dieuKienTimKiem(db, 'products', { name: 'name', unit: 'unit' }, filter.search)
  };
  const total = await db.product.count({ where });
  const rows = await db.product.findMany({
    where,
    orderBy: { id: 'asc' },
    skip: (page - 1) * pageSize,
    take: pageSize
  });
  const names = await industryNameMap(db, rows.map((r) => r.industryId));
  return {
    ok: true,
    total,
    page,
    pageSize,
    data: rows.map((r) => ({
      id: r.id, industryId: r.industryId, industryName: names.get(r.industryId) ?? null,
      name: r.name, unit: r.unit, price: r.price, priority: r.priority, status: r.status,
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString()
    }))
  };
}

export async function createProduct(ctx: ServiceCtx, input: CreateProductInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, PRODUCT_MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!input.industryId) return { ok: false, error: 'VALIDATION', message: 'Chọn nhóm ngành nghề.' };
  const industry = await db.industry.findUnique({ where: { id: input.industryId }, select: { id: true, deletedAt: true } });
  if (!industry || industry.deletedAt) return { ok: false, error: 'VALIDATION', message: 'Ngành nghề không tồn tại.' };
  const name = input.name?.trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên sản phẩm bắt buộc.' };
  const unit = input.unit?.trim();
  if (!unit) return { ok: false, error: 'VALIDATION', message: 'Đơn vị tính bắt buộc.' };
  const price = validPrice(input.price);
  if (price === null) return { ok: false, error: 'VALIDATION', message: 'Đơn giá phải là số nguyên dương (VND).' };

  const priority = validPriority(input.priority);
  const created = await db.product.create({
    data: { industryId: input.industryId, name, unit, price, priority, status: input.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE', createdBy: user.id }
  });
  await writeAudit(db, {
    actorUserId: user.id, action: 'PRODUCT_CREATED', targetType: 'Product', targetId: String(created.id),
    after: auditSnapshot({ industryId: created.industryId, name: created.name, unit: created.unit, price: created.price, priority: created.priority, status: created.status })
  });
  return { ok: true, id: created.id };
}

export async function updateProduct(ctx: ServiceCtx, id: number, input: UpdateProductInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, PRODUCT_MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const row = await db.product.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Sản phẩm không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;

  const name = input.name !== undefined ? input.name.trim().replace(/\s+/g, ' ') : row.name;
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên sản phẩm không được để trống.' };
  const unit = input.unit !== undefined ? input.unit.trim() : row.unit;
  if (!unit) return { ok: false, error: 'VALIDATION', message: 'Đơn vị tính không được để trống.' };
  let price = row.price;
  if (input.price !== undefined) {
    const p = validPrice(input.price);
    if (p === null) return { ok: false, error: 'VALIDATION', message: 'Đơn giá phải là số nguyên dương (VND).' };
    price = p;
  }
  if (input.industryId !== undefined && input.industryId !== row.industryId) {
    const ind = await db.industry.findUnique({ where: { id: input.industryId }, select: { id: true, deletedAt: true } });
    if (!ind || ind.deletedAt) return { ok: false, error: 'VALIDATION', message: 'Ngành nghề không tồn tại.' };
  }

  const priority = input.priority !== undefined ? validPriority(input.priority) : row.priority;
  const before = auditSnapshot({ industryId: row.industryId, name: row.name, unit: row.unit, price: row.price, priority: row.priority, status: row.status });
  const updated = await db.product.update({
    where: { id },
    data: {
      industryId: input.industryId ?? row.industryId,
      name, unit, price, priority,
      status: input.status !== undefined ? (input.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE') : row.status,
      updatedBy: user.id
    }
  });
  await writeAudit(db, {
    actorUserId: user.id, action: 'PRODUCT_UPDATED', targetType: 'Product', targetId: String(id), before,
    after: auditSnapshot({ industryId: updated.industryId, name: updated.name, unit: updated.unit, price: updated.price, priority: updated.priority, status: updated.status })
  });
  return { ok: true, id };
}

/** Xóa mềm 1..n SP. Xác nhận MẬT KHẨU (§14) do ADAPTER kiểm TRƯỚC khi gọi. */
export async function deleteProducts(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, PRODUCT_MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn sản phẩm để xóa.' };
  let deleted = 0;
  for (const id of ids) {
    const row = await db.product.findUnique({ where: { id } });
    if (!row || row.deletedAt) continue;
    await db.product.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.id, deletedBy: user.id } });
    await writeAudit(db, { actorUserId: user.id, action: 'PRODUCT_DELETED', targetType: 'Product', targetId: String(id), before: auditSnapshot({ name: row.name, unit: row.unit, price: row.price }) });
    deleted++;
  }
  return { ok: true, deleted };
}

/** Import danh sách SP cho 1 ngành (rows đã parse ở client: {name,unit,price,priority?}). Bỏ dòng thiếu/không hợp lệ. */
export async function importProducts(ctx: ServiceCtx, industryId: number, rows: { name?: string; unit?: string; price?: unknown; priority?: unknown }[]): Promise<MutationResult & { imported?: number; skipped?: number }> {
  if (!hasPermission(ctx.user, PRODUCT_MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!industryId) return { ok: false, error: 'VALIDATION', message: 'Chọn nhóm ngành nghề trước khi import.' };
  const industry = await db.industry.findUnique({ where: { id: industryId }, select: { id: true, deletedAt: true } });
  if (!industry || industry.deletedAt) return { ok: false, error: 'VALIDATION', message: 'Ngành nghề không tồn tại.' };
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, error: 'VALIDATION', message: 'File không có dòng sản phẩm hợp lệ.' };

  let imported = 0, skipped = 0;
  for (const r of rows) {
    const name = String(r.name ?? '').trim().replace(/\s+/g, ' ');
    const unit = String(r.unit ?? '').trim();
    const price = validPrice(r.price);
    if (!name || !unit || price === null) { skipped++; continue; }
    await db.product.create({ data: { industryId, name, unit, price, priority: validPriority(r.priority), status: 'ACTIVE', createdBy: user.id } });
    imported++;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'PRODUCT_IMPORTED', targetType: 'Product', after: { industryId, imported, skipped } });
  return { ok: true, imported, skipped };
}

// ═══════════════════════════════════════════════════════════════════════════════
// (B) THEO DÕI BILL GIẢI TRÌNH (đọc + xóa mềm — sinh bill = TENTATIVE, xem đầu file)
// ═══════════════════════════════════════════════════════════════════════════════
export interface BillExplainDto {
  id: number;
  code: string | null;
  dossierId: number | null; // null = bill dùng tên HKD của TID (không Hồ sơ)
  dossierName: string | null;
  tidId: number | null;
  tidCode: string | null;
  industryId: number;
  industryName: string | null;
  billDate: string;
  totalAmount: number;
  billCount: number;
  filePath: string;
  createdByName: string | null;
  createdAt: string;
}
export interface BillExplainFilter {
  dossierId?: number;
  industryId?: number;
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
}

export async function listBillExplains(ctx: ServiceCtx, filter: BillExplainFilter = {}): Promise<{ ok: boolean; data?: BillExplainDto[]; total?: number; page?: number; pageSize?: number; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db } = ctx;
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(BILLEXPLAIN_PAGE_SIZE_MAX, Math.max(1, filter.pageSize ?? BILLEXPLAIN_PAGE_SIZE_DEFAULT));
  const where: Record<string, unknown> = { deletedAt: null, dossierId: filter.dossierId ?? undefined, industryId: filter.industryId ?? undefined, createdAt: dateRange(filter.fromDate, filter.toDate) };
  const total = await db.billExplain.count({ where });
  const rows = await db.billExplain.findMany({
    where,
    orderBy: { id: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize
  });
  const dossierIds = [...new Set(rows.map((r) => r.dossierId).filter((x): x is number => x != null))];
  const tidIds = [...new Set(rows.map((r) => r.tidId).filter((x): x is number => x != null))];
  const industryIds = [...new Set(rows.map((r) => r.industryId))];
  const userIds = [...new Set(rows.map((r) => r.createdBy).filter((x): x is number => x != null))];
  const [dossiers, tids, industries, users] = await Promise.all([
    dossierIds.length ? db.dossier.findMany({ where: { id: { in: dossierIds } }, select: { id: true, hkdName: true } }) : Promise.resolve([]),
    tidIds.length ? db.tid.findMany({ where: { id: { in: tidIds } }, select: { id: true, tid: true } }) : Promise.resolve([]),
    industryIds.length ? db.industry.findMany({ where: { id: { in: industryIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, username: true } }) : Promise.resolve([])
  ]);
  const dMap = new Map(dossiers.map((x) => [x.id, x.hkdName]));
  const tMap = new Map(tids.map((x) => [x.id, x.tid]));
  const iMap = new Map(industries.map((x) => [x.id, x.name]));
  const uMap = new Map(users.map((x) => [x.id, x.fullName || x.username]));
  return {
    ok: true,
    total,
    page,
    pageSize,
    data: rows.map((r) => ({
      id: r.id, code: r.code, dossierId: r.dossierId, dossierName: r.dossierId != null ? dMap.get(r.dossierId) ?? null : null,
      tidId: r.tidId, tidCode: r.tidId != null ? tMap.get(r.tidId) ?? null : null,
      industryId: r.industryId, industryName: iMap.get(r.industryId) ?? null,
      billDate: r.billDate.toISOString(), totalAmount: Number(r.totalAmount), billCount: r.billCount,
      filePath: r.filePath, createdByName: r.createdBy != null ? uMap.get(r.createdBy) ?? null : null, createdAt: r.createdAt.toISOString()
    }))
  };
}

/** Xóa mềm 1..n bill (tab theo dõi). Xác nhận MẬT KHẨU (§14) do ADAPTER kiểm TRƯỚC khi gọi. */
export async function deleteBillExplains(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, BILLEXPLAIN_DELETE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn bill để xóa.' };
  let deleted = 0;
  for (const id of ids) {
    const row = await db.billExplain.findUnique({ where: { id } });
    if (!row || row.deletedAt) continue;
    await db.billExplain.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: user.id } });
    await writeAudit(db, { actorUserId: user.id, action: 'BILLEXPLAIN_DELETED', targetType: 'BillExplain', targetId: String(id), before: auditSnapshot({ code: row.code, billCount: row.billCount }) });
    deleted++;
  }
  return { ok: true, deleted };
}

// ═══════════════════════════════════════════════════════════════════════════════
// (C) CẤU HÌNH — phần DỮ LIỆU DB (AppSetting) — R201
// ─────────────────────────────────────────────────────────────────────────────
// PORT phần DB của getBillExplainConfig/setBillExplainConfig từ desktop bill-explain-service.ts. CHỈ số HĐ
// (billNoStart/billNoYear) + đường dẫn template riêng ĐÃ LƯU (templateCustomPath, để client biết CÓ cấu hình
// template riêng hay không). outputDir + resolve template thực = PER-MACHINE, GIỮ Ở MAIN (mỗi máy tự chọn thư
// mục xuất/đọc template cục bộ userData) → adapter/preload MERGE với phần DB này. KHÔNG centralize outputDir.
// ═══════════════════════════════════════════════════════════════════════════════
const K_BILL_NO = 'billexplain.billNoStart';
const K_BILL_YEAR = 'billexplain.billNoYear';
const K_TEMPLATE_PATH = 'billexplain.templatePath';

async function getSetting(db: Db, key: string): Promise<string | null> {
  const row = await db.appSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}
async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

export interface BillExplainDbConfig {
  billNoStart: number;
  billNoYear: number;
  /** Đường dẫn template riêng ĐÃ LƯU trong AppSetting (per-machine path). null = chưa cấu hình template riêng. */
  templateCustomPath: string | null;
}

/** BILLEXPLAIN_VIEW — phần DB của cấu hình Bill giải trình (số HĐ + cờ template riêng). Local paths do main merge. */
export async function getBillExplainDbConfig(
  ctx: ServiceCtx
): Promise<{ ok: boolean; data?: BillExplainDbConfig; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db } = ctx;
  const custom = await getSetting(db, K_TEMPLATE_PATH);
  return {
    ok: true,
    data: {
      billNoStart: Number(await getSetting(db, K_BILL_NO)) || 1,
      billNoYear: Number(await getSetting(db, K_BILL_YEAR)) || new Date().getFullYear(),
      templateCustomPath: custom && custom.trim() ? custom : null
    }
  };
}

export interface SetBillExplainDbConfigInput {
  billNoStart?: number;
  billNoYear?: number;
  /** R201: con trỏ mẫu hóa đơn RIÊNG (path userData máy client). undefined = không đổi; null/'' = xóa (về mẫu mặc định). */
  templateCustomPath?: string | null;
}
/** Ghi phần DB của cấu hình. Số HĐ (billNoStart/billNoYear) cần BILLEXPLAIN_CREATE; con trỏ template riêng cần
 *  PRODUCT_MANAGE (KHỚP importInvoiceTemplate/resetInvoiceTemplate desktop cũ). Gate THEO TỪNG trường được đổi. */
export async function setBillExplainDbConfig(ctx: ServiceCtx, input: SetBillExplainDbConfigInput): Promise<MutationResult> {
  const wantsBillNo = input.billNoStart !== undefined || input.billNoYear !== undefined;
  const wantsTemplate = input.templateCustomPath !== undefined;
  if (wantsBillNo && !hasPermission(ctx.user, BILLEXPLAIN_CREATE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  if (wantsTemplate && !hasPermission(ctx.user, PRODUCT_MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  if (!wantsBillNo && !wantsTemplate && !hasPermission(ctx.user, BILLEXPLAIN_CREATE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db } = ctx;
  if (input.billNoStart !== undefined && Number.isFinite(input.billNoStart) && input.billNoStart >= 1) {
    await setSetting(db, K_BILL_NO, String(Math.floor(input.billNoStart)));
  }
  if (input.billNoYear !== undefined && Number.isFinite(input.billNoYear)) {
    await setSetting(db, K_BILL_YEAR, String(Math.floor(input.billNoYear)));
  }
  if (wantsTemplate) {
    // null/'' = xóa con trỏ (về mẫu mặc định) — KHỚP resetInvoiceTemplate cũ (setSetting(K_TEMPLATE_PATH, '')).
    await setSetting(db, K_TEMPLATE_PATH, input.templateCustomPath ?? '');
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// (D) SINH BILL — phần SERVER-SIDE (R201): validate + cấp DẢI SỐ HĐ atomic (reserve) + LƯU bản ghi (record).
// ─────────────────────────────────────────────────────────────────────────────
// File .xlsx được RENDER + GHI CỤC BỘ ở main (đĩa client Electron). generateLineItems + renderBills là NGẪU
// NHIÊN (Math.random) + có deadline → KHÔNG thể render server rồi client tái tạo (kết quả lệch). Vì bill_no
// nhúng trong ô hóa đơn (billNoStart+idx) nên PHẢI cấp số TRƯỚC khi render, mà billCount/filePath chỉ biết SAU
// render → tách 2 bước: reserve (cấp số atomic) → [client render local] → record (lưu bản ghi). Đúng cấu trúc
// desktop cũ (vốn cũng 2 transaction: reserve tx + record tx). Số HĐ ĐƯỢC PHÉP NHẢY QUÃNG (chốt Admin Demo 16/7)
// nên crash giữa reserve↔record chỉ tạo LỖ số vô hại — KHÔNG BAO GIỜ cấp trùng.
// ═══════════════════════════════════════════════════════════════════════════════
const BILL_CODE_PREFIX = 'BE';
const BILLNO_LOCK = 561053; // pg advisory lock cấp DẢI số HĐ (BILL-06 chống race/TOCTOU) — GIỮ NGUYÊN desktop
const MAX_TARGET = Number.MAX_SAFE_INTEGER;
const REAL_CEILING = 299_000_000;

export interface ProductLite {
  name: string;
  unit: string;
  price: number;
  priority?: number;
}
export interface ReserveBillNumbersInput {
  dossierId?: number | null; // null = dùng tên HKD của TID (cần tidId có hkdName)
  tidId?: number | null;
  industryId: number;
  billDate: string; // yyyy-mm-dd
  targets: (number | string)[];
}
export interface ReserveBillNumbersResult {
  ok: boolean;
  error?: string;
  message?: string;
  billNoStart?: number;
  billNoYear?: number;
  count?: number;
  targets?: number[]; // đã parse STRICT → main render đúng giá trị (không parse lại lệch)
  dossier?: { hkdName: string; hkdAddress: string; ownerName: string };
  products?: ProductLite[];
}

/** Parse danh sách số tiền STRICT (BILL-04/05/09) — KHÔNG strip/mutate. GIỮ NGUYÊN desktop. */
function parseTargets(list: unknown): { targets: number[]; invalid: number } {
  if (!Array.isArray(list)) return { targets: [], invalid: -1 };
  const out: number[] = [];
  let invalid = 0;
  const MAX = BigInt(MAX_TARGET);
  for (const raw of list) {
    let b: bigint | null = null;
    if (typeof raw === 'number') {
      if (Number.isInteger(raw) && raw > 0 && raw <= MAX_TARGET) b = BigInt(raw);
    } else if (typeof raw === 'string') {
      const s = raw.trim();
      if (/^\d+$/.test(s)) { const v = BigInt(s); if (v > 0n && v <= MAX) b = v; }
    }
    if (b === null) { invalid++; continue; }
    out.push(Number(b));
  }
  return { targets: out, invalid };
}
/** Ngày STRICT yyyy-mm-dd CÓ THẬT (round-trip UTC). GIỮ NGUYÊN desktop. */
function parseStrictYmd(s: unknown): { y: number; m: number; d: number } | null {
  if (typeof s !== 'string') return null;
  const mm = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!mm) return null;
  const y = +mm[1], m = +mm[2], d = +mm[3];
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { y, m, d };
}

/**
 * BILLEXPLAIN_CREATE — VALIDATE toàn bộ input sinh bill (khớp generateBills desktop) + CẤP DẢI SỐ HĐ ATOMIC.
 * Cấp `targets.length` số trong 1 $transaction dưới `pg_advisory_xact_lock(BILLNO_LOCK)` → 2 request đồng thời
 * KHÔNG chồng dải (đọc-tăng-ghi không tách rời). Trả kèm dossier (common render) + products (ACTIVE) để main
 * render CỤC BỘ mà KHÔNG cần DB. KHÔNG lưu bản ghi ở đây (record sau khi render xong, biết billCount/filePath).
 */
export async function reserveBillNumbers(ctx: ServiceCtx, input: ReserveBillNumbersInput): Promise<ReserveBillNumbersResult> {
  if (!hasPermission(ctx.user, BILLEXPLAIN_CREATE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db } = ctx;

  if (!input || typeof input !== 'object') return { ok: false, error: 'VALIDATION', message: 'Dữ liệu không hợp lệ.' };
  if (typeof input.industryId !== 'number' || !Number.isInteger(input.industryId)) return { ok: false, error: 'VALIDATION', message: 'Chọn nhóm ngành nghề.' };

  // HKD (Admin Demo 21/8 "TID có tên HKD rồi"): nguồn tên/địa chỉ/chủ hộ = Hồ sơ HKD (dossierId) HOẶC TÊN HKD của TID
  // (Tid.hkdName; địa chỉ+chủ hộ để trống khi chưa có Hồ sơ — hệ hiện 0 Hồ sơ). Cần ÍT NHẤT 1 nguồn.
  const hasDossier = typeof input.dossierId === 'number' && Number.isInteger(input.dossierId);
  let hkd: { hkdName: string; hkdAddress: string; ownerName: string } | null = null;
  if (hasDossier) {
    const dossier = await db.dossier.findUnique({ where: { id: input.dossierId as number } });
    if (!dossier || dossier.deletedAt) return { ok: false, error: 'VALIDATION', message: 'Hồ sơ HKD không tồn tại.' };
    hkd = { hkdName: dossier.hkdName || '', hkdAddress: dossier.hkdAddress || '', ownerName: dossier.ownerName || '' };
  }

  const industry = await db.industry.findUnique({ where: { id: input.industryId }, select: { id: true, deletedAt: true } });
  if (!industry || industry.deletedAt) return { ok: false, error: 'VALIDATION', message: 'Nhóm ngành nghề không tồn tại.' };

  if (input.tidId != null) {
    if (typeof input.tidId !== 'number' || !Number.isInteger(input.tidId)) return { ok: false, error: 'VALIDATION', message: 'TID không hợp lệ.' };
    const tid = await db.tid.findUnique({ where: { id: input.tidId }, select: { id: true, deletedAt: true, dossierId: true, hkdName: true } });
    if (!tid || tid.deletedAt) return { ok: false, error: 'VALIDATION', message: 'TID không tồn tại.' };
    if (hasDossier && tid.dossierId != null && tid.dossierId !== input.dossierId) return { ok: false, error: 'VALIDATION', message: 'TID không thuộc Hộ Kinh Doanh đã chọn.' };
    // Không chọn Hồ sơ → dùng TÊN HKD của TID cho bill (địa chỉ/chủ hộ trống).
    if (!hasDossier) {
      if (!tid.hkdName) return { ok: false, error: 'VALIDATION', message: 'TID chưa có tên HKD — chọn Hộ Kinh Doanh hoặc gán tên HKD cho TID.' };
      hkd = { hkdName: tid.hkdName, hkdAddress: '', ownerName: '' };
    }
  }
  if (!hkd) return { ok: false, error: 'VALIDATION', message: 'Chọn Hộ Kinh Doanh hoặc chọn TID có tên HKD.' };

  const dd = parseStrictYmd(input.billDate);
  if (!dd) return { ok: false, error: 'VALIDATION', message: 'Ngày hóa đơn không hợp lệ (yyyy-mm-dd, ngày có thật).' };

  const { targets, invalid } = parseTargets(input.targets);
  if (invalid !== 0) {
    return { ok: false, error: 'VALIDATION', message: invalid < 0 ? 'Danh sách số tiền không hợp lệ.' : `${invalid} số tiền không hợp lệ (số nguyên dương ≤ ${MAX_TARGET}, không âm/thập phân/chữ).` };
  }
  if (!targets.length) return { ok: false, error: 'VALIDATION', message: 'Chưa có số tiền hợp lệ nào để sinh bill.' };
  const overCeil = targets.filter((t) => t > REAL_CEILING);
  if (overCeil.length) {
    return { ok: false, error: 'VALIDATION', message: `Mỗi hóa đơn tối đa ${groupDigits(REAL_CEILING.toString())}đ (số tiền thực tế 1 hóa đơn). Có ${overCeil.length} số vượt trần — hãy nhập số nhỏ hơn (vd chia thành nhiều hóa đơn).` };
  }

  const products = await db.product.findMany({ where: { industryId: input.industryId, status: 'ACTIVE', deletedAt: null }, select: { name: true, unit: true, price: true, priority: true } });
  if (!products.length) return { ok: false, error: 'NO_PRODUCTS', message: 'Thư viện sản phẩm của ngành nghề này đang trống — thêm sản phẩm trước khi sinh bill.' };

  const billNoYear = Number(await getSetting(db, K_BILL_YEAR)) || dd.y;

  // BILL-06 (race/TOCTOU): cấp DẢI số HĐ ATOMIC dưới advisory lock trong 1 transaction — GIỮ NGUYÊN desktop.
  const billNoStart = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${BILLNO_LOCK})`);
    const row = await tx.appSetting.findUnique({ where: { key: K_BILL_NO } });
    const cur = Number(row?.value) || 1;
    const next = String(cur + targets.length);
    await tx.appSetting.upsert({ where: { key: K_BILL_NO }, update: { value: next }, create: { key: K_BILL_NO, value: next } });
    await tx.appSetting.upsert({ where: { key: K_BILL_YEAR }, update: { value: String(billNoYear) }, create: { key: K_BILL_YEAR, value: String(billNoYear) } });
    return cur;
  });

  return {
    ok: true,
    billNoStart,
    billNoYear,
    count: targets.length,
    targets,
    dossier: hkd,
    products: products.map((p) => ({ name: p.name, unit: p.unit, price: p.price, priority: p.priority }))
  };
}

export interface RecordBillExplainInput {
  dossierId?: number | null; // null = bill dùng tên HKD của TID
  tidId?: number | null;
  industryId: number;
  billDate: string; // yyyy-mm-dd
  totalAmount: string; // chuỗi chữ số (BigInt) — tổng Σ mọi target, KHÔNG qua Number
  billCount: number; // số bill THỰC render được (post-render)
  filePath: string; // đường dẫn file .xlsx trên đĩa client (main render xong)
}
export interface RecordBillExplainResult {
  ok: boolean;
  error?: string;
  message?: string;
  id?: number;
  code?: string | null;
}

/**
 * BILLEXPLAIN_CREATE — LƯU bản ghi Bill giải trình SAU khi main render file cục bộ (biết billCount + filePath).
 * 1 $transaction: nextCode + billExplain.create + writeAuditStrict (bill + vết audit ATOMIC — mẫu LOW-A desktop).
 * Số HĐ đã cấp atomic ở reserve; nếu record fail → main dọn file cục bộ + số HĐ dôi (nhảy quãng — vô hại).
 */
export async function recordBillExplain(ctx: ServiceCtx, input: RecordBillExplainInput): Promise<RecordBillExplainResult> {
  if (!hasPermission(ctx.user, BILLEXPLAIN_CREATE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  if (!input || typeof input !== 'object') return { ok: false, error: 'VALIDATION', message: 'Dữ liệu không hợp lệ.' };
  // HKD nguồn = Hồ sơ (dossierId) HOẶC tên HKD của TID — cần ít nhất 1 (Admin Demo 21/8).
  const hasDossier = typeof input.dossierId === 'number' && Number.isInteger(input.dossierId);
  if (input.dossierId != null && !hasDossier) return { ok: false, error: 'VALIDATION', message: 'Hộ Kinh Doanh không hợp lệ.' };
  if (!hasDossier && input.tidId == null) return { ok: false, error: 'VALIDATION', message: 'Chọn Hộ Kinh Doanh hoặc TID có tên HKD.' };
  if (typeof input.industryId !== 'number' || !Number.isInteger(input.industryId)) return { ok: false, error: 'VALIDATION', message: 'Chọn nhóm ngành nghề.' };
  const dd = parseStrictYmd(input.billDate);
  if (!dd) return { ok: false, error: 'VALIDATION', message: 'Ngày hóa đơn không hợp lệ (yyyy-mm-dd, ngày có thật).' };
  if (typeof input.totalAmount !== 'string' || !/^\d+$/.test(input.totalAmount)) return { ok: false, error: 'VALIDATION', message: 'Tổng tiền không hợp lệ.' };
  if (typeof input.billCount !== 'number' || !Number.isInteger(input.billCount) || input.billCount < 1) return { ok: false, error: 'VALIDATION', message: 'Số bill không hợp lệ.' };
  if (typeof input.filePath !== 'string' || !input.filePath.trim()) return { ok: false, error: 'VALIDATION', message: 'Thiếu đường dẫn file bill.' };

  if (hasDossier) {
    const dossier = await db.dossier.findUnique({ where: { id: input.dossierId as number }, select: { id: true, deletedAt: true } });
    if (!dossier || dossier.deletedAt) return { ok: false, error: 'VALIDATION', message: 'Hồ sơ HKD không tồn tại.' };
  }
  const industry = await db.industry.findUnique({ where: { id: input.industryId }, select: { id: true, deletedAt: true } });
  if (!industry || industry.deletedAt) return { ok: false, error: 'VALIDATION', message: 'Nhóm ngành nghề không tồn tại.' };

  let tidCode: string | null = null;
  if (input.tidId != null) {
    if (typeof input.tidId !== 'number' || !Number.isInteger(input.tidId)) return { ok: false, error: 'VALIDATION', message: 'TID không hợp lệ.' };
    const tid = await db.tid.findUnique({ where: { id: input.tidId }, select: { id: true, tid: true, deletedAt: true, dossierId: true } });
    if (!tid || tid.deletedAt) return { ok: false, error: 'VALIDATION', message: 'TID không tồn tại.' };
    if (hasDossier && tid.dossierId != null && tid.dossierId !== input.dossierId) return { ok: false, error: 'VALIDATION', message: 'TID không thuộc Hộ Kinh Doanh đã chọn.' };
    tidCode = tid.tid;
  }

  const totalAmount = BigInt(input.totalAmount);
  let rec;
  try {
    rec = await db.$transaction(async (tx) => {
      const code = await nextCode(tx, BILL_CODE_PREFIX);
      const created = await tx.billExplain.create({
        data: {
          code, dossierId: input.dossierId ?? null, tidId: input.tidId ?? null, industryId: input.industryId,
          billDate: new Date(Date.UTC(dd.y, dd.m - 1, dd.d)), totalAmount,
          billCount: input.billCount, filePath: input.filePath, createdBy: user.id
        }
      });
      await writeAuditStrict(tx, {
        actorUserId: user.id, action: 'BILLEXPLAIN_CREATED', targetType: 'BillExplain', targetId: String(created.id),
        after: auditSnapshot({ code: created.code, dossierId: input.dossierId, tidCode, industryId: input.industryId, billCount: input.billCount, totalAmount: totalAmount.toString(), file: input.filePath })
      });
      return created;
    });
  } catch (e) {
    return { ok: false, error: 'DB_FAILED', message: e instanceof Error ? e.message : 'Lưu bill vào cơ sở dữ liệu thất bại.' };
  }
  return { ok: true, id: rec.id, code: rec.code };
}
