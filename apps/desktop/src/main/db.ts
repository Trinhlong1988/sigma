// DB bootstrap for the Electron main process (G10: FULL-SWITCH → PostgreSQL).
// - Connection = postgresql:// built from SIGMA_DB_URL (self-test), DATABASE_URL (.env dev),
//   or the client server-config file (userData/server-config.json — màn "Cấu hình máy chủ").
// - Role split (G10 model A): CHỈ máy chủ (SIGMA_ROLE=server) chạy seed. Client (mặc định) chỉ connect.
//   Prisma 7 `prisma-client` KHÔNG kèm migrate engine → migrate chạy bằng prisma CLI phía server,
//   KHÔNG từ .exe.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { app, safeStorage } from 'electron';
import { Client } from 'pg';
import { createPrisma, type Db } from '@sigma/database';
import {
  PERMISSIONS,
  ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  validateServerConfig,
  DEFAULT_SERVER_PORT,
  DEFAULT_SERVER_DATABASE,
  DEFAULT_SERVER_USER,
  type ServerConfigInput,
  type NormalizedServerConfig
} from '@sigma/shared';
import { hashPassword } from '@sigma/business-rules';
import { backfillEmployeeCodes, nextCode } from './code-service.js';
import { writeAudit } from './audit.js';

const ADMIN_USERNAME = 'adminroot';
const ADMIN_DEFAULT_PASSWORD = 'Admin@123456';

// ── G-CFG.7 §11 Pha I1 — bug class "DB tiến hóa" (memory 9/7 H7) ──────────────
// Quyền ngành nghề MỚI phải được cấp cho role ĐÃ TỒN TẠI trên DB cũ (không chỉ role tạo mới
// hay ADMIN). ADMIN đã tự đồng bộ ĐỦ quyền mỗi boot (R_ADMIN_SUPERUSER). MANAGER (+ role
// quản-lý-cấu-hình) cần cấp 1 LẦN — idempotent, guard bằng cờ AppSetting để KHÔNG cấp lại quyền
// admin đã CHỦ ĐỘNG gỡ về sau (tôn trọng G-POS-A01: reboot không tự bật lại quyền đã tắt).
const INDUSTRY_PERM_CODES = ['CONFIG_INDUSTRY_VIEW', 'CONFIG_INDUSTRY_CREATE', 'CONFIG_INDUSTRY_UPDATE', 'CONFIG_INDUSTRY_DELETE'];
const INDUSTRY_PERM_TARGET_ROLES = ['MANAGER'];
const INDUSTRY_GRANT_FLAG = 'seed.industryPermsGrantedV1';

/**
 * Cấp (idempotent) quyền ngành nghề cho các role đã có sẵn trên DB (db-evolution).
 * Trả về số (role×quyền) vừa được thêm mới. Bỏ qua cặp đã có → an toàn chạy lại.
 * Không guard cờ ở đây (để selftest gọi trực tiếp mô phỏng DB tiến hóa); cờ guard nằm ở seedIfEmpty.
 */
export async function grantIndustryPermsToExistingRoles(db: Db): Promise<number> {
  const perms = await db.permission.findMany({ where: { code: { in: INDUSTRY_PERM_CODES } }, select: { id: true } });
  let granted = 0;
  for (const roleCode of INDUSTRY_PERM_TARGET_ROLES) {
    const role = await db.role.findUnique({ where: { code: roleCode }, select: { id: true } });
    if (!role) continue;
    for (const perm of perms) {
      const existing = await db.rolePermission.findUnique({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } }
      });
      if (existing) continue;
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      granted++;
    }
  }
  return granted;
}

// ── Bill giải trình (Admin Demo 16/7) — db-evolution: cấp quyền cho role CŨ trên production ────────────
// ADMIN tự nhận qua R_ADMIN_SUPERUSER mỗi boot; helper này cấp cho MANAGER + ACCOUNTANT (khớp DEFAULT).
const BILLEXPLAIN_PERM_CODES = ['BILLEXPLAIN_VIEW', 'BILLEXPLAIN_CREATE', 'BILLEXPLAIN_DELETE', 'PRODUCT_MANAGE'];
const BILLEXPLAIN_TARGET_ROLES = ['MANAGER', 'ACCOUNTANT'];
const BILLEXPLAIN_GRANT_FLAG = 'seed.billExplainPermsGrantedV1';

export async function grantBillExplainPermsToExistingRoles(db: Db): Promise<number> {
  const perms = await db.permission.findMany({ where: { code: { in: BILLEXPLAIN_PERM_CODES } }, select: { id: true } });
  let granted = 0;
  for (const roleCode of BILLEXPLAIN_TARGET_ROLES) {
    const role = await db.role.findUnique({ where: { code: roleCode }, select: { id: true } });
    if (!role) continue;
    for (const perm of perms) {
      const existing = await db.rolePermission.findUnique({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } }
      });
      if (existing) continue;
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      granted++;
    }
  }
  return granted;
}

// ── Seed THƯ VIỆN SẢN PHẨM gốc từ renbill (Admin Demo 16/7 "import luôn thư viện đã có làm gốc") ──────
// File bundled build/billexplain-seed.json (extraResources): 5 ngành renbill + 199 SP Siêu thị (giá/ĐVT
// THẬT từ DANH MỤC SẢN PHẨM SIÊU THỊ.xlsx). Idempotent: ngành match theo TÊN (không tạo trùng); SP chỉ
// seed khi ngành đang RỖNG (không đè dữ liệu người dùng đã nhập). Cờ guard ở seedIfEmpty (1 lần/DB).
const BILLEXPLAIN_LIBRARY_FLAG = 'seed.billExplainLibraryV1';
interface BillExplainSeed {
  industries?: string[];
  products?: Record<string, { name: string; unit: string; price: number }[]>;
}
function billExplainSeedPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'billexplain-seed.json')
    : join(app.getAppPath(), 'build', 'billexplain-seed.json');
}
export async function seedBillExplainLibrary(db: Db): Promise<{ industries: number; products: number }> {
  const p = billExplainSeedPath();
  if (!existsSync(p)) return { industries: 0, products: 0 };
  let seed: BillExplainSeed;
  try { seed = JSON.parse(readFileSync(p, 'utf8')) as BillExplainSeed; } catch { return { industries: 0, products: 0 }; }

  let indCount = 0, prodCount = 0;
  // B71 FIX (mở rộng — F1 audit đa-agent 16/7): CHỈ seed ngành CÓ sản phẩm (KHÔNG tạo ngành rỗng).
  // Khớp ngành theo tên CHUẨN HÓA trong JS (NFC + gộp khoảng trắng + trim + toLowerCase Unicode) — KÍN hơn
  // Prisma `mode:'insensitive'` (ILIKE chỉ fold hoa/thường ASCII, KHÔNG phủ NFD/space-thừa/hoa-thường-CÓ-DẤU
  // như "CÀ PHÊ" vs "Cà phê"). Nhờ vậy KHÔNG đẻ ngành trùng dù encoding/space/case của ngành sẵn có khác nhau.
  const existing = await db.industry.findMany({ where: { deletedAt: null }, select: { id: true, name: true } });
  const byNorm = new Map<string, number>();
  for (const e of existing) { const k = normIndustryName(e.name); if (!byNorm.has(k)) byNorm.set(k, e.id); }
  for (const [indName, prods] of Object.entries(seed.products ?? {})) {
    const list = (prods ?? []).filter((pr) => pr.name && pr.unit && Number.isFinite(pr.price) && pr.price > 0);
    if (!list.length) continue;
    const key = normIndustryName(indName);
    let indId = byNorm.get(key);
    if (indId == null) {
      const code = await nextCode('NGH', db);
      const created = await db.industry.create({ data: { code, name: indName, active: true }, select: { id: true } });
      indId = created.id;
      byNorm.set(key, indId);
      indCount++;
    }
    const have = await db.product.count({ where: { industryId: indId, deletedAt: null } });
    if (have > 0) continue; // ngành đã có SP → KHÔNG seed đè
    await db.product.createMany({ data: list.map((pr) => ({ industryId: indId!, name: pr.name, unit: pr.unit, price: Math.round(pr.price), status: 'ACTIVE' })) });
    prodCount += list.length;
  }
  return { industries: indCount, products: prodCount };
}
/**
 * ÁNH XẠ tên ngành trong file seed → tên ngành NGƯỜI DÙNG đang dùng thật trên DB.
 *
 * VÌ SAO CẦN (đo thật trên DB production 2/10/2026, KHÔNG suy luận): file seed (gốc renbill) đặt khoá
 * `"Siêu thị"`, nhưng ngành người dùng tự tạo tên `"Siêu thị - Tạp hóa"` (NGH04, id 5) và đang RỖNG 0 SP.
 * So khớp theo tên chuẩn hoá đơn thuần ⇒ seed ĐẺ THÊM ngành `"Siêu thị"` nằm cạnh ngành đang dùng ⇒ người
 * dùng thấy 2 ngành siêu thị, thư viện vẫn rỗng. Không có chỗ nào trong code đặt tên các ngành này ⇒ chúng
 * do người dùng tạo, nên DB là nguồn sự thật về cách gọi, file seed phải CHỊU theo.
 *
 * Bảng này khai TƯỜNG MINH, không dùng so khớp mờ (chứa/gần giống) — so mờ là chỗ sinh gán sai âm thầm.
 */
const BILLEXPLAIN_IND_ALIAS: Record<string, string[]> = {
  'siêu thị': ['siêu thị - tạp hóa', 'siêu thị tạp hóa', 'siêu thị - tạp hoá', 'tạp hóa', 'tạp hoá'],
  'cửa hàng gas': ['gas', 'cửa hàng gas'],
  'vận tải': ['vận tải'],
  'thu hộ': ['dịch vụ thu hộ'],
  'cà phê': ['cửa hàng cafe', 'cửa hàng cà phê', 'cafe', 'cà phê']
};
/** Tìm id ngành khớp tên seed: khớp CHÍNH XÁC trước, rồi tới alias khai tường minh. null = chưa có. */
function timNganhTheoAlias(tenSeed: string, byNorm: Map<string, number>): number | null {
  const k = normIndustryName(tenSeed);
  const chinhXac = byNorm.get(k);
  if (chinhXac != null) return chinhXac;
  for (const ten of BILLEXPLAIN_IND_ALIAS[k] ?? []) {
    const id = byNorm.get(normIndustryName(ten));
    if (id != null) return id;
  }
  return null;
}
const BILLEXPLAIN_LIBRARY_FLAG_V2 = 'seed.billExplainLibraryV2';
/**
 * Seed V2 (2/10/2026) — BỔ SUNG thư viện SP vào ngành ĐÃ CÓ SẢN PHẨM.
 *
 * VÌ SAO CẦN: `seedBillExplainLibrary` (V1) có `if (have > 0) continue` + cờ V1 ⇒ máy nào đã seed 1 lần là
 * thư viện ĐÓNG BĂNG mãi; mở rộng file seed (199 → 800 SP siêu thị) KHÔNG bao giờ tới máy đang dùng.
 * Đúng lớp lỗi "làm xong mà không nối dây" ([[feedback_tool_built_not_wired_gap_global_30_6]]).
 *
 * LUẬT GHI (R202 — dữ liệu người dùng nhập tay nằm cùng bảng):
 *  · CHỈ `createMany` SP mà ngành CHƯA có tên đó. KHÔNG `update`, KHÔNG `delete`, KHÔNG đổi giá SP sẵn có —
 *    giá người dùng tự sửa là nguồn sự thật của họ.
 *  · So trùng trên TOÀN BỘ hàng, **kể cả đã xoá mềm** (KHÔNG lọc `deletedAt: null`): nếu lọc, SP người dùng
 *    CHỦ Ý xoá sẽ bị seed hồi sinh mỗi lần chạy — lỗi âm thầm khó thấy.
 *  · Idempotent: chạy lần 2 trở đi thêm 0 SP.
 */
export async function seedBillExplainLibraryBoSung(db: Db): Promise<{ industries: number; products: number; daCo: number }> {
  const p = billExplainSeedPath();
  if (!existsSync(p)) return { industries: 0, products: 0, daCo: 0 };
  let seed: BillExplainSeed;
  try { seed = JSON.parse(readFileSync(p, 'utf8')) as BillExplainSeed; } catch { return { industries: 0, products: 0, daCo: 0 }; }

  let indCount = 0, prodCount = 0, daCo = 0;
  const existing = await db.industry.findMany({ where: { deletedAt: null }, select: { id: true, name: true } });
  const byNorm = new Map<string, number>();
  for (const e of existing) { const k = normIndustryName(e.name); if (!byNorm.has(k)) byNorm.set(k, e.id); }

  for (const [indName, prods] of Object.entries(seed.products ?? {})) {
    const list = (prods ?? []).filter((pr) => pr.name && pr.unit && Number.isFinite(pr.price) && pr.price > 0);
    if (!list.length) continue;
    const key = normIndustryName(indName);
    let indId = timNganhTheoAlias(indName, byNorm);
    if (indId == null) {
      const code = await nextCode('NGH', db);
      const created = await db.industry.create({ data: { code, name: indName, active: true }, select: { id: true } });
      indId = created.id;
      byNorm.set(key, indId);
      indCount++;
    }
    // CỐ Ý không lọc deletedAt — xem luật ghi ở doc-comment trên.
    const coSan = await db.product.findMany({ where: { industryId: indId }, select: { name: true } });
    const daCoTen = new Set(coSan.map((r) => normIndustryName(r.name)));
    const canThem: { name: string; unit: string; price: number }[] = [];
    const themTen = new Set<string>();
    for (const pr of list) {
      const k = normIndustryName(pr.name);
      if (daCoTen.has(k) || themTen.has(k)) { daCo++; continue; }
      themTen.add(k);
      canThem.push(pr);
    }
    if (!canThem.length) continue;
    await db.product.createMany({ data: canThem.map((pr) => ({ industryId: indId!, name: pr.name, unit: pr.unit, price: Math.round(pr.price), status: 'ACTIVE' })) });
    prodCount += canThem.length;
  }
  return { industries: indCount, products: prodCount, daCo };
}

/** Chuẩn hóa tên ngành để so khớp dedup: NFC (gộp NFD) + gộp mọi khoảng trắng về 1 + trim + toLowerCase
 *  (Unicode, fold cả chữ CÓ DẤU). KHÔNG bỏ dấu → "Cà phê" ≠ "Ca phe" (giữ tên khác biệt), nhưng
 *  "CÀ PHÊ"/"Cà  phê"/NFD đều chuẩn về 1 khóa. */
export function normIndustryName(s: string): string {
  return String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ── R27 (§C kho) — Danh mục Kho: bug class "DB tiến hóa" (H7) ─────────────────
// Quyền kho MỚI (CONFIG_WAREHOUSE_*) phải cấp cho role ĐÃ TỒN TẠI trên DB cũ. Cùng khuôn ngành nghề:
// ADMIN tự đồng bộ đủ mỗi boot; MANAGER + WAREHOUSE cấp CẢ view+manage 1 lần; D_MANAGER chỉ view.
// Idempotent, guard bằng cờ AppSetting để KHÔNG cấp lại quyền admin đã CHỦ ĐỘNG gỡ về sau.
const WAREHOUSE_FULL_CODES = ['CONFIG_WAREHOUSE_VIEW', 'CONFIG_WAREHOUSE_MANAGE'];
const WAREHOUSE_FULL_ROLES = ['MANAGER', 'WAREHOUSE'];
const WAREHOUSE_VIEW_ROLES = ['D_MANAGER'];
const WAREHOUSE_GRANT_FLAG = 'seed.warehousePermsGrantedV1';

/**
 * Cấp (idempotent) quyền danh mục kho cho role đã có sẵn trên DB (db-evolution).
 * MANAGER + WAREHOUSE nhận view+manage; D_MANAGER chỉ view. Trả về số (role×quyền) vừa thêm mới.
 * Không guard cờ ở đây (để selftest gọi trực tiếp mô phỏng DB tiến hóa); cờ guard nằm ở seedIfEmpty.
 */
export async function grantWarehousePermsToExistingRoles(db: Db): Promise<number> {
  const allPerms = await db.permission.findMany({ where: { code: { in: WAREHOUSE_FULL_CODES } }, select: { id: true, code: true } });
  const viewPerm = allPerms.filter((p) => p.code === 'CONFIG_WAREHOUSE_VIEW');
  let granted = 0;
  const grantSet = async (roleCode: string, perms: { id: number }[]): Promise<void> => {
    const role = await db.role.findUnique({ where: { code: roleCode }, select: { id: true } });
    if (!role) return;
    for (const perm of perms) {
      const existing = await db.rolePermission.findUnique({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } }
      });
      if (existing) continue;
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      granted++;
    }
  };
  for (const roleCode of WAREHOUSE_FULL_ROLES) await grantSet(roleCode, allPerms);
  for (const roleCode of WAREHOUSE_VIEW_ROLES) await grantSet(roleCode, viewPerm);
  return granted;
}

// ── #3 (Admin Demo 12/7) — Bán thiết bị: bug class "DB tiến hóa" (H7) ────────────
// Quyền bán thiết bị MỚI (DEVICE_SALE_*) cấp cho role CŨ: MANAGER+ACCOUNTANT view+manage; D_MANAGER+WAREHOUSE view.
const DEVICE_SALE_FULL_CODES = ['DEVICE_SALE_VIEW', 'DEVICE_SALE_MANAGE'];
const DEVICE_SALE_FULL_ROLES = ['MANAGER', 'ACCOUNTANT'];
const DEVICE_SALE_VIEW_ROLES = ['D_MANAGER', 'WAREHOUSE'];
const DEVICE_SALE_GRANT_FLAG = 'seed.deviceSalePermsGrantedV1';

/** Cấp (idempotent) quyền bán thiết bị cho role đã có sẵn (db-evolution). MANAGER/ACCOUNTANT view+manage;
 * D_MANAGER/WAREHOUSE chỉ view. Trả về số (role×quyền) vừa thêm. Cờ guard ở seedIfEmpty. */
export async function grantDeviceSalePermsToExistingRoles(db: Db): Promise<number> {
  const allPerms = await db.permission.findMany({ where: { code: { in: DEVICE_SALE_FULL_CODES } }, select: { id: true, code: true } });
  const viewPerm = allPerms.filter((p) => p.code === 'DEVICE_SALE_VIEW');
  let granted = 0;
  const grantSet = async (roleCode: string, perms: { id: number }[]): Promise<void> => {
    const role = await db.role.findUnique({ where: { code: roleCode }, select: { id: true } });
    if (!role) return;
    for (const perm of perms) {
      const existing = await db.rolePermission.findUnique({ where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } } });
      if (existing) continue;
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      granted++;
    }
  };
  for (const roleCode of DEVICE_SALE_FULL_ROLES) await grantSet(roleCode, allPerms);
  for (const roleCode of DEVICE_SALE_VIEW_ROLES) await grantSet(roleCode, viewPerm);
  return granted;
}

// ── LOẠI GIAO MÁY (Admin Demo) — bug class "DB tiến hóa" (H7) ────────────────────
// Quyền loại giao MỚI (CONFIG_HANDOVER_*) phải cấp cho role ĐÃ TỒN TẠI trên DB cũ. Cùng khuôn kho:
// MANAGER nhận view+manage; ACCOUNTANT + D_MANAGER + WAREHOUSE chỉ view (chọn khi giao máy/TID/xem báo cáo).
const HANDOVER_FULL_CODES = ['CONFIG_HANDOVER_VIEW', 'CONFIG_HANDOVER_MANAGE'];
const HANDOVER_FULL_ROLES = ['MANAGER'];
const HANDOVER_VIEW_ROLES = ['ACCOUNTANT', 'D_MANAGER', 'WAREHOUSE'];
const HANDOVER_GRANT_FLAG = 'seed.handoverPermsGrantedV1';

/** Cấp (idempotent) quyền loại giao máy cho role đã có sẵn (db-evolution). MANAGER view+manage;
 * ACCOUNTANT/D_MANAGER/WAREHOUSE chỉ view. Trả số (role×quyền) vừa thêm. Cờ guard ở seedIfEmpty. */
export async function grantHandoverPermsToExistingRoles(db: Db): Promise<number> {
  const allPerms = await db.permission.findMany({ where: { code: { in: HANDOVER_FULL_CODES } }, select: { id: true, code: true } });
  const viewPerm = allPerms.filter((p) => p.code === 'CONFIG_HANDOVER_VIEW');
  let granted = 0;
  const grantSet = async (roleCode: string, perms: { id: number }[]): Promise<void> => {
    const role = await db.role.findUnique({ where: { code: roleCode }, select: { id: true } });
    if (!role) return;
    for (const perm of perms) {
      const existing = await db.rolePermission.findUnique({ where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } } });
      if (existing) continue;
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      granted++;
    }
  };
  for (const roleCode of HANDOVER_FULL_ROLES) await grantSet(roleCode, allPerms);
  for (const roleCode of HANDOVER_VIEW_ROLES) await grantSet(roleCode, viewPerm);
  return granted;
}

// ── PHASE 1 (Admin Demo 13/7) — Yêu cầu xuất kho: bug class "DB tiến hóa" (H7) ───
// Quyền yêu cầu xuất kho MỚI (EXPORT_REQUEST_*) phải cấp cho role ĐÃ TỒN TẠI trên DB cũ. Cùng khuôn kho:
// APPROVE cho MANAGER + WAREHOUSE (ADMIN tự đủ mỗi boot); VIEW+CREATE cho MỌI role vận hành (trừ CUSTOMER).
const EXPORT_REQ_FULL_CODES = ['EXPORT_REQUEST_VIEW', 'EXPORT_REQUEST_CREATE', 'EXPORT_REQUEST_APPROVE'];
const EXPORT_REQ_BASE_CODES = ['EXPORT_REQUEST_VIEW', 'EXPORT_REQUEST_CREATE'];
const EXPORT_REQ_FULL_ROLES = ['MANAGER', 'WAREHOUSE'];
const EXPORT_REQ_BASE_ROLES = ['D_MANAGER', 'ACCOUNTANT', 'TECHNICIAN', 'SUPPORT', 'SALES'];
const EXPORT_REQ_GRANT_FLAG = 'seed.exportReqPermsGrantedV1';

/** Cấp (idempotent) quyền yêu cầu xuất kho cho role đã có sẵn (db-evolution). MANAGER/WAREHOUSE view+create+approve;
 * D_MANAGER/ACCOUNTANT/TECHNICIAN/SUPPORT/SALES chỉ view+create. Trả số (role×quyền) vừa thêm. Cờ guard ở seedIfEmpty. */
export async function grantExportReqPermsToExistingRoles(db: Db): Promise<number> {
  const allPerms = await db.permission.findMany({ where: { code: { in: EXPORT_REQ_FULL_CODES } }, select: { id: true, code: true } });
  const basePerms = allPerms.filter((p) => EXPORT_REQ_BASE_CODES.includes(p.code));
  let granted = 0;
  const grantSet = async (roleCode: string, perms: { id: number }[]): Promise<void> => {
    const role = await db.role.findUnique({ where: { code: roleCode }, select: { id: true } });
    if (!role) return;
    for (const perm of perms) {
      const existing = await db.rolePermission.findUnique({ where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } } });
      if (existing) continue;
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      granted++;
    }
  };
  for (const roleCode of EXPORT_REQ_FULL_ROLES) await grantSet(roleCode, allPerms);
  for (const roleCode of EXPORT_REQ_BASE_ROLES) await grantSet(roleCode, basePerms);
  return granted;
}

// ── LOẠI GIAO MÁY (Admin Demo) — seed 4 loại giao builtin (idempotent theo name, ADDITIVE mỗi boot) ──
// moneyKind quyết định mô hình tiền: SALE (bán đứt → device-sale), RENT (cho thuê → thu 1 lần doanh thu),
// NONE (mượn → 0đ), DEPOSIT (cọc → nợ phải trả, hoàn khi thu máy về). isBuiltin=true: cấm xóa + khóa
// moneyKind (cho đổi name/sortOrder). Khớp biến thể hoa/thường để không đẻ trùng gần-giống (bài học 11/7).
// Admin Demo 9/8 — has_deposit: cho phép nhập cọc (POS/TID) lúc giao (0=không cọc). Bán không cọc; Cho thuê/Mượn/
// Cọc/Đối ứng cho phép cọc. Đối ứng (COUNTERPART): giao POS/TID, phí lấy từ biểu phí niêm yết (logic đã có).
interface SeedHandover { name: string; moneyKind: string; sortOrder: number; hasDeposit: boolean; }
const BUILTIN_HANDOVER_TYPES: SeedHandover[] = [
  { name: 'Bán', moneyKind: 'SALE', sortOrder: 1, hasDeposit: false },
  { name: 'Cho thuê', moneyKind: 'RENT', sortOrder: 2, hasDeposit: true },
  { name: 'Mượn', moneyKind: 'NONE', sortOrder: 3, hasDeposit: true },
  { name: 'Cọc', moneyKind: 'DEPOSIT', sortOrder: 4, hasDeposit: true },
  { name: 'Đối ứng', moneyKind: 'COUNTERPART', sortOrder: 5, hasDeposit: true }
];

/** Seed idempotent loại giao builtin + BACKFILL has_deposit cho builtin ĐÃ tồn tại (DB cũ). Trả số loại tạo mới. */
export async function seedBuiltinHandoverTypes(db: Db): Promise<number> {
  let created = 0;
  for (const h of BUILTIN_HANDOVER_TYPES) {
    const existing = await db.handoverType.findFirst({ where: { name: { equals: h.name, mode: 'insensitive' } }, select: { id: true, hasDeposit: true } });
    if (existing) {
      // Backfill has_deposit cho builtin cũ (seed trước đây chưa có cột) — chỉ set khi lệch, idempotent.
      if (existing.hasDeposit !== h.hasDeposit) await db.handoverType.update({ where: { id: existing.id }, data: { hasDeposit: h.hasDeposit } });
      continue;
    }
    await db.handoverType.create({ data: { name: h.name, moneyKind: h.moneyKind, isBuiltin: true, sortOrder: h.sortOrder, hasDeposit: h.hasDeposit, createdBy: null } });
    created++;
  }
  return created;
}

// ── PHASE H1 — Thu–Chi: bug class "DB tiến hóa" (H7) ──────────────────────────
// Quyền thu-chi MỚI (CASHCAT_*) phải cấp cho role ĐÃ TỒN TẠI trên DB cũ (không chỉ role tạo mới).
// Cùng khuôn với ngành nghề: ADMIN tự đồng bộ mỗi boot (R_ADMIN_SUPERUSER); MANAGER cấp 1 LẦN
// idempotent, guard bằng cờ AppSetting để KHÔNG cấp lại quyền admin đã CHỦ ĐỘNG gỡ về sau.
const CASHCAT_PERM_CODES = ['CASHCAT_VIEW', 'CASHCAT_CREATE', 'CASHCAT_UPDATE', 'CASHCAT_DELETE'];
const CASHCAT_PERM_TARGET_ROLES = ['MANAGER'];
const CASHCAT_GRANT_FLAG = 'seed.cashCatPermsGrantedV1';

/**
 * Cấp (idempotent) quyền thu-chi (CASHCAT_*) cho các role đã có sẵn trên DB (db-evolution).
 * Trả về số (role×quyền) vừa thêm mới. Bỏ qua cặp đã có → an toàn chạy lại.
 * Không guard cờ ở đây (để selftest gọi trực tiếp mô phỏng DB tiến hóa); cờ guard nằm ở seedIfEmpty.
 */
export async function grantCashCatPermsToExistingRoles(db: Db): Promise<number> {
  const perms = await db.permission.findMany({ where: { code: { in: CASHCAT_PERM_CODES } }, select: { id: true } });
  let granted = 0;
  for (const roleCode of CASHCAT_PERM_TARGET_ROLES) {
    const role = await db.role.findUnique({ where: { code: roleCode }, select: { id: true } });
    if (!role) continue;
    for (const perm of perms) {
      const existing = await db.rolePermission.findUnique({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } }
      });
      if (existing) continue;
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      granted++;
    }
  }
  return granted;
}

// ── PHASE H2-core — Thu–Chi: bug class "DB tiến hóa" (H7) ─────────────────────
// Quyền quỹ + phiếu thu/chi MỚI (FUND_*/CASHENTRY_*) phải cấp cho role ĐÃ TỒN TẠI trên DB cũ
// (không chỉ role tạo mới). Cùng khuôn CASHCAT: ADMIN tự đồng bộ mỗi boot (R_ADMIN_SUPERUSER);
// MANAGER + ACCOUNTANT cấp 1 LẦN idempotent, guard bằng cờ AppSetting để KHÔNG cấp lại quyền admin
// đã CHỦ ĐỘNG gỡ về sau. Kế toán (ACCOUNTANT) = vai chính thu-chi (spec §6.4).
const CASHFLOW_PERM_CODES = ['FUND_VIEW', 'FUND_CREATE', 'FUND_UPDATE', 'FUND_DELETE', 'CASHENTRY_VIEW', 'CASHENTRY_CREATE', 'CASHENTRY_CANCEL'];
const CASHFLOW_PERM_TARGET_ROLES = ['MANAGER', 'ACCOUNTANT'];

// ── PHASE H2b — Thu–Chi: bug class "DB tiến hóa" (H7) cho quyền phân loại / ghi giảm công nợ ──────
// DEBT_CLASSIFY (phân loại chất lượng công nợ) cấp cho MANAGER + ACCOUNTANT; DEBT_WRITEOFF (ghi giảm
// nợ xấu — quyền cao) CHỈ MANAGER (ADMIN tự đủ mỗi boot qua R_ADMIN_SUPERUSER). Cấp 1 LẦN idempotent
// cho role ĐÃ TỒN TẠI trên DB cũ (cờ AppSetting), KHÔNG cấp lại quyền admin đã chủ động gỡ về sau.
const DEBT_QUALITY_GRANTS: { role: string; codes: string[] }[] = [
  { role: 'MANAGER', codes: ['DEBT_CLASSIFY', 'DEBT_WRITEOFF'] },
  { role: 'ACCOUNTANT', codes: ['DEBT_CLASSIFY'] }
];
const DEBT_QUALITY_GRANT_FLAG = 'seed.debtQualityPermsGrantedV1';

/**
 * Cấp (idempotent) quyền phân loại/ghi giảm công nợ (DEBT_CLASSIFY/DEBT_WRITEOFF) cho role đã có sẵn
 * trên DB (db-evolution). Mỗi role chỉ nhận đúng whitelist của mình (§6.4/task). Trả số cặp mới thêm.
 * Không guard cờ ở đây (selftest gọi trực tiếp mô phỏng DB tiến hóa); cờ guard nằm ở seedIfEmpty.
 */
export async function grantDebtQualityPermsToExistingRoles(db: Db): Promise<number> {
  let granted = 0;
  for (const { role: roleCode, codes } of DEBT_QUALITY_GRANTS) {
    const role = await db.role.findUnique({ where: { code: roleCode }, select: { id: true } });
    if (!role) continue;
    const perms = await db.permission.findMany({ where: { code: { in: codes } }, select: { id: true } });
    for (const perm of perms) {
      const existing = await db.rolePermission.findUnique({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } }
      });
      if (existing) continue;
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      granted++;
    }
  }
  return granted;
}
const CASHFLOW_GRANT_FLAG = 'seed.cashflowPermsGrantedV1';

/**
 * Cấp (idempotent) quyền quỹ + phiếu thu/chi (FUND_* / CASHENTRY_*) cho các role đã có sẵn trên DB
 * (db-evolution). Trả về số (role×quyền) vừa thêm mới. Bỏ qua cặp đã có → an toàn chạy lại.
 * Không guard cờ ở đây (để selftest gọi trực tiếp mô phỏng DB tiến hóa); cờ guard nằm ở seedIfEmpty.
 */
export async function grantCashflowPermsToExistingRoles(db: Db): Promise<number> {
  const perms = await db.permission.findMany({ where: { code: { in: CASHFLOW_PERM_CODES } }, select: { id: true } });
  let granted = 0;
  for (const roleCode of CASHFLOW_PERM_TARGET_ROLES) {
    const role = await db.role.findUnique({ where: { code: roleCode }, select: { id: true } });
    if (!role) continue;
    for (const perm of perms) {
      const existing = await db.rolePermission.findUnique({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } }
      });
      if (existing) continue;
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      granted++;
    }
  }
  return granted;
}

// ── PHASE H1 — Thu–Chi: seed danh mục thu/chi HỆ THỐNG (isSystem=true), idempotent ────────────
// Khóa tự nhiên = (kind, name). Có → skip; chưa → tạo. Gán affectsPnl đúng bất biến §2.1/§5:
//   sourceKind nội bộ (DEBT_*/DEPOSIT/DEPOSIT_REFUND/ADVANCE/DEVICE_DEPOSIT/FUND_TRANSFER) = false;
//   doanh thu bán trực tiếp (SALE_POS/SALE_TID/DT khác) + chi phí vận hành + chi lương (SALARY) = true.
interface SeedCat { kind: 'THU' | 'CHI'; name: string; unit: string | null; sourceKind: string; affectsPnl: boolean; }
const SYSTEM_CASH_CATEGORIES: SeedCat[] = [
  // THU
  { kind: 'THU', name: 'Công nợ khách hàng', unit: 'đồng', sourceKind: 'DEBT_CUSTOMER', affectsPnl: false },
  { kind: 'THU', name: 'Công nợ đối tác', unit: 'đồng', sourceKind: 'DEBT_PARTNER', affectsPnl: false },
  { kind: 'THU', name: 'Doanh thu bán máy POS', unit: 'đồng', sourceKind: 'SALE_POS', affectsPnl: true },
  { kind: 'THU', name: 'Doanh thu bán TID', unit: 'đồng', sourceKind: 'SALE_TID', affectsPnl: true },
  // #3 (Admin Demo 12/7) — THU tiền bán thiết bị (thu nợ mua máy/TID): chỉ tiền vào quỹ, KHÔNG cộng doanh thu
  // lần 2 (doanh thu đã ghi đủ qua SALE_POS/SALE_TID lúc bán) → affectsPnl=false. Tách khỏi DEBT_CUSTOMER
  // (công nợ POS quẹt thẻ) để không lẫn số. Liên kết chứng từ bán qua DeviceSaleSettlement.
  { kind: 'THU', name: 'Thu tiền bán thiết bị', unit: 'đồng', sourceKind: 'SALE_COLLECT', affectsPnl: false },
  { kind: 'THU', name: 'Doanh thu khác', unit: 'đồng', sourceKind: 'MANUAL', affectsPnl: true },
  // LOẠI GIAO MÁY (Admin Demo) — giao hình thức "Cho thuê": thu 1 lần lúc giao = DOANH THU thật
  // (affectsPnl=true → vào lợi nhuận tháng). Sinh qua applyHandover(moneyKind=RENT). Tách riêng để
  // báo cáo doanh thu theo loại giao đọc đúng nguồn "Cho thuê".
  { kind: 'THU', name: 'Doanh thu cho thuê máy', unit: 'đồng', sourceKind: 'RENT', affectsPnl: true },
  { kind: 'THU', name: 'Thu cọc máy', unit: 'đồng', sourceKind: 'DEPOSIT', affectsPnl: false },
  { kind: 'THU', name: 'Hoàn ứng (thu lại tạm ứng)', unit: 'đồng', sourceKind: 'ADVANCE', affectsPnl: false },
  { kind: 'THU', name: 'Chuyển quỹ đến', unit: 'đồng', sourceKind: 'FUND_TRANSFER', affectsPnl: false },
  // CHI
  { kind: 'CHI', name: 'Chi lương', unit: 'đồng', sourceKind: 'SALARY', affectsPnl: true },
  { kind: 'CHI', name: 'Chi phí vận hành', unit: 'đồng', sourceKind: 'MANUAL', affectsPnl: true },
  { kind: 'CHI', name: 'Chi phí văn phòng', unit: 'đồng', sourceKind: 'MANUAL', affectsPnl: true },
  { kind: 'CHI', name: 'Chi phí khác', unit: 'đồng', sourceKind: 'MANUAL', affectsPnl: true },
  { kind: 'CHI', name: 'Chi tạm ứng', unit: 'đồng', sourceKind: 'ADVANCE', affectsPnl: false },
  { kind: 'CHI', name: 'Hoàn cọc máy', unit: 'đồng', sourceKind: 'DEPOSIT_REFUND', affectsPnl: false },
  { kind: 'CHI', name: 'Chuyển quỹ đi', unit: 'đồng', sourceKind: 'FUND_TRANSFER', affectsPnl: false },
  // H2b — Ghi giảm nợ xấu (write-off): chi phí thật → affectsPnl=true (trừ thẳng lợi nhuận accrual).
  { kind: 'CHI', name: 'Chi phí nợ xấu', unit: 'đồng', sourceKind: 'BAD_DEBT', affectsPnl: true }
];

/** Seed idempotent danh mục thu/chi hệ thống. Trả về số danh mục vừa tạo mới. */
export async function seedSystemCashCategories(db: Db): Promise<number> {
  let created = 0;
  for (const c of SYSTEM_CASH_CATEGORIES) {
    const existing = await db.cashCategory.findFirst({ where: { kind: c.kind, name: c.name }, select: { id: true } });
    if (existing) continue;
    await db.cashCategory.create({
      data: { kind: c.kind, name: c.name, unit: c.unit, periodType: 'NONE', sourceKind: c.sourceKind, affectsPnl: c.affectsPnl, isSystem: true, active: true }
    });
    created++;
  }
  return created;
}

// ── VIỆC 1 — seed mặc định "Trạng thái nhập máy POS" (§C8a) ───────────────────
// Bug gốc: PosIntakeStatus KHÔNG được seed → nút/màn "Nhập kho máy POS" bị chặn vĩnh viễn
// (gate PosSupplyPage đòi statuses.length > 0). Seed 4 trạng thái chuẩn (đúng ví dụ trong UI) cho
// CẢ DB mới LẪN DB đã tồn tại: seedIfEmpty chạy mỗi boot máy chủ theo kiểu ADDITIVE (giống các
// seedSystemCashCategories / grant*) nên phủ luôn DB cũ của Admin Demo.
// Idempotent theo khóa tự nhiên = name, so khớp KHÔNG PHÂN BIỆT HOA/THƯỜNG (fix db-evolution-gap
// 11/7): DB cũ có thể đã có biến thể khác hoa/thường (vd "Máy Mới") → nếu dùng findUnique khớp
// chính xác thì seed đẻ thêm "Máy mới" gần trùng, gây 2 dòng lẫn lộn trong dropdown. Dùng findFirst
// insensitive: (a) chưa có biến thể nào → tạo; (b) đã có bất kỳ biến thể (kể cả xóa mềm) → bỏ qua.
// Vừa tránh trùng gần-giống, vừa KHÔNG "hồi sinh" trạng thái admin đã CHỦ ĐỘNG xóa (tôn trọng
// G-POS-A01: reboot không tự bật lại cái admin đã tắt). createdBy = null (system seed).
const DEFAULT_INTAKE_STATUS_NAMES = ['Máy mới', 'Máy cũ', 'Máy đổi', 'Máy thuê'];

/** Seed idempotent 4 trạng thái nhập máy POS mặc định. Trả về số trạng thái vừa tạo mới. */
export async function seedDefaultIntakeStatusesIfMissing(db: Db): Promise<number> {
  let created = 0;
  for (const name of DEFAULT_INTAKE_STATUS_NAMES) {
    const existing = await db.posIntakeStatus.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true }
    });
    if (existing) continue;
    await db.posIntakeStatus.create({ data: { name, createdBy: null } });
    created++;
  }
  return created;
}

// ── PHASE K1 — Hợp nhất POS: backfill PosDevice từ PosIntake (§2.2, desync #22) ───────────────
// PosDevice = nguồn sự thật DUY NHẤT. DB cũ có phiếu nhập (pos_intakes) nhưng CHƯA có bản ghi máy
// (pos_devices) → máy "tàng hình" ở "Danh sách máy" + không gán TID được. Backfill idempotent:
//   • serial CHƯA có ở pos_devices  → tạo PosDevice IN_STOCK (điền cột nhập) + AssetEvent(STOCK_IN).
//   • serial ĐÃ có ở cả 2 bảng       → chỉ ĐIỀN cột nhập còn TRỐNG; TUYỆT ĐỐI KHÔNG đụng
//     status/currentTid/currentCustomerId/currentAgentId đang chạy.
//   • posModelId ← model(text) nếu match tên/mã PosModel; bankId ← bank(text) nếu match Bank; else null.
//   • Đảm bảo MỌI máy có ≥1 AssetEvent STOCK_IN (timeline gốc).
// Chạy 2 lần KHÔNG nhân đôi PosDevice/AssetEvent. Guard cờ nằm ở seedIfEmpty (1 lần/DB), giống grant*.
const POS_UNIFY_BACKFILL_FLAG = 'seed.posUnifyBackfilledV1';

export interface PosBackfillReport {
  created: number; // số PosDevice mới tạo từ phiếu nhập
  filled: number; // số PosDevice đã có được điền thêm cột nhập
  stockInAdded: number; // số AssetEvent(STOCK_IN) bổ sung
  intakeSerials: number; // distinct serial alive ở pos_intakes
  deviceSerials: number; // số pos_devices tương ứng các serial đó (đối soát)
}

export async function backfillPosDevicesFromIntakes(db: Db): Promise<PosBackfillReport> {
  const norm = (s: string): string => s.trim().toLowerCase();
  const models = await db.posModel.findMany({ where: { deletedAt: null }, select: { id: true, code: true, name: true } });
  const banks = await db.bank.findMany({ where: { deletedAt: null }, select: { id: true, code: true, name: true } });
  const modelByKey = new Map<string, number>();
  for (const m of models) { modelByKey.set(norm(m.code), m.id); modelByKey.set(norm(m.name), m.id); }
  const bankByKey = new Map<string, number>();
  for (const b of banks) { bankByKey.set(norm(b.code), b.id); bankByKey.set(norm(b.name), b.id); }

  const intakes = await db.posIntake.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
  let created = 0, filled = 0, stockInAdded = 0;
  for (const it of intakes) {
    const dev = await db.posDevice.findUnique({ where: { serial: it.serial } });
    if (!dev) {
      await db.$transaction(async (tx) => {
        await tx.posDevice.create({
          data: { serial: it.serial, status: 'IN_STOCK', posModelId: it.posModelId, supplierId: it.supplierId, intakeStatusId: it.intakeStatusId, importPrice: it.importPrice, importedAt: it.importedAt, createdBy: it.createdBy }
        });
        await tx.assetEvent.create({
          data: { deviceSerial: it.serial, eventType: 'STOCK_IN', toState: 'IN_STOCK', actorUserId: it.createdBy, occurredAt: it.importedAt, afterJson: JSON.stringify({ serial: it.serial, backfill: true }) }
        });
      });
      created++;
      stockInAdded++;
    } else {
      // Chỉ ĐIỀN cột nhập còn TRỐNG — KHÔNG đụng trạng thái vận hành đang chạy.
      const patch: Record<string, unknown> = {};
      if (dev.posModelId == null && it.posModelId != null) patch.posModelId = it.posModelId;
      if (dev.supplierId == null && it.supplierId != null) patch.supplierId = it.supplierId;
      if (dev.intakeStatusId == null && it.intakeStatusId != null) patch.intakeStatusId = it.intakeStatusId;
      if (dev.importPrice == null && it.importPrice != null) patch.importPrice = it.importPrice;
      if (dev.importedAt == null && it.importedAt != null) patch.importedAt = it.importedAt;
      if (Object.keys(patch).length > 0) { await db.posDevice.update({ where: { id: dev.id }, data: patch }); filled++; }
      const hasStockIn = await db.assetEvent.findFirst({ where: { deviceSerial: dev.serial, eventType: 'STOCK_IN' }, select: { id: true } });
      if (!hasStockIn) {
        await db.assetEvent.create({
          data: { deviceSerial: dev.serial, eventType: 'STOCK_IN', toState: dev.status, actorUserId: it.createdBy, occurredAt: it.importedAt ?? dev.createdAt, afterJson: JSON.stringify({ serial: dev.serial, backfill: true }) }
        });
        stockInAdded++;
      }
    }
  }
  // Pass 2: map text model/bank → FK cho MỌI máy còn trống (kể cả máy tạo tay không qua phiếu nhập).
  const devsToMap = await db.posDevice.findMany({
    where: { deletedAt: null, OR: [{ posModelId: null, model: { not: null } }, { bankId: null, bank: { not: null } }] },
    select: { id: true, model: true, bank: true, posModelId: true, bankId: true }
  });
  for (const d of devsToMap) {
    const patch: Record<string, unknown> = {};
    if (d.posModelId == null && d.model) { const id = modelByKey.get(norm(d.model)); if (id) patch.posModelId = id; }
    if (d.bankId == null && d.bank) { const id = bankByKey.get(norm(d.bank)); if (id) patch.bankId = id; }
    if (Object.keys(patch).length > 0) { await db.posDevice.update({ where: { id: d.id }, data: patch }); filled++; }
  }
  const distinctSerials = [...new Set(intakes.map((i) => i.serial))];
  const deviceSerials = await db.posDevice.count({ where: { serial: { in: distinctSerials } } });
  return { created, filled, stockInAdded, intakeSerials: distinctSerials.length, deviceSerials };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE K2 (§8, Q-T3) — Backfill dossierId cho tids từ hkdName text.
// Idempotent (chỉ đụng tids dossierId=null có hkdName). Khớp CHÍNH XÁC 1 Dossier alive
// (hkdName, case-insensitive) → set; nhiều hoặc không khớp → GIỮ null + log (đối soát đếm).
// Guard cờ nằm ở seedIfEmpty (1 lần/DB), giống grant*/pos-unify.
// ─────────────────────────────────────────────────────────────────────────────
const TID_UNIFY_BACKFILL_FLAG = 'seed.tidUnifyDossierBackfilledV1';

export interface TidDossierBackfillReport {
  linked: number; // số tids được set dossierId (khớp chính xác 1)
  ambiguous: number; // hkdName khớp ≥2 Dossier → giữ null
  unmatched: number; // hkdName không khớp Dossier nào → giữ null
  scanned: number; // số tids có hkdName, dossierId=null đã quét
}

export async function backfillTidDossierIds(db: Db): Promise<TidDossierBackfillReport> {
  const norm = (s: string): string => s.trim().toLowerCase();
  const dossiers = await db.dossier.findMany({ where: { deletedAt: null }, select: { id: true, hkdName: true } });
  // Đếm số Dossier alive theo hkdName chuẩn hóa → phát hiện mơ hồ (≥2).
  const byName = new Map<string, number[]>();
  for (const d of dossiers) {
    const k = norm(d.hkdName);
    byName.set(k, [...(byName.get(k) ?? []), d.id]);
  }
  const tids = await db.tid.findMany({ where: { deletedAt: null, dossierId: null, NOT: { hkdName: null } }, select: { id: true, hkdName: true } });
  let linked = 0, ambiguous = 0, unmatched = 0;
  for (const t of tids) {
    if (!t.hkdName || !t.hkdName.trim()) { unmatched++; continue; }
    const ids = byName.get(norm(t.hkdName));
    if (!ids || ids.length === 0) { unmatched++; continue; }
    if (ids.length > 1) { ambiguous++; continue; }
    await db.tid.update({ where: { id: t.id }, data: { dossierId: ids[0] } });
    linked++;
  }
  return { linked, ambiguous, unmatched, scanned: tids.length };
}

let prisma: Db | undefined;

/** Cấu hình kết nối máy chủ PostgreSQL (client nhập ở màn "Cấu hình máy chủ", G10 model A).
 * apiBaseUrl (4/8, kiến trúc HTTP): địa chỉ máy chủ REST `quanly-api` mà preload gọi qua httpCall.
 * Tách RIÊNG khỏi host Postgres (khác scheme/cổng). Rỗng → preload tự fallback domain Cloudflare mặc định. */
interface ServerConfig {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  apiBaseUrl?: string;
}

/** Đường dẫn file cấu hình máy chủ.
 * 4/8 (Admin Demo "bản cách ly SigMa KHÔNG còn GLB") — CÁCH LY khỏi GLB: TRƯỚC ĐÂY dùng userData mặc định
 * %APPDATA%\@glb\desktop (TRÙNG bản GLB đã cài vì cùng package name @sigma/desktop) → SigMa đọc NHẦM config GLB
 * (database `glb`, user `KeToanDemo`). Giờ đọc/ghi vào thư mục RIÊNG %APPDATA%\AlphaQuanLy — CHỈ tách FILE
 * CẤU HÌNH (không đổi userData toàn bộ, tránh side-effect cache/session/lock của Electron). Onboarding script
 * ghi server-config.json vào ĐÚNG path này. */
export function serverConfigPath(): string {
  return join(app.getPath('appData'), instanceConfigDir(), 'server-config.json');
}

/**
 * [Admin Demo 10/9 — bản clone "SigMa TN"] TÊN THƯ MỤC CẤU HÌNH theo TỪNG BẢN (instance) để 2 bản cài trên CÙNG một
 * máy KHÔNG dẫm cấu hình của nhau (bản chính đọc %APPDATA%\AlphaQuanLy, bản TN đọc %APPDATA%\AlphaTN).
 * Nguồn: `resources/instance.json` {"configDir":"AlphaTN"} đóng gói theo bản cài; dev dùng env SIGMA_INSTANCE_DIR.
 * Không có gì → giữ NGUYÊN 'AlphaQuanLy' (bản chính không đổi hành vi).
 */
export function instanceName(): string {
  try {
    if (app.isPackaged) {
      const p = join(process.resourcesPath, 'instance.json');
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, 'utf8')) as { name?: unknown };
        if (typeof j.name === 'string' && j.name.trim()) return j.name.trim();
      }
    }
  } catch { /* hỏng → coi như bản chính */ }
  return (process.env['SIGMA_INSTANCE_NAME'] ?? '').trim();
}

export function instanceConfigDir(): string {
  try {
    if (app.isPackaged) {
      const p = join(process.resourcesPath, 'instance.json');
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, 'utf8')) as { configDir?: unknown };
        if (typeof j.configDir === 'string' && j.configDir.trim()) return j.configDir.trim();
      }
    }
  } catch { /* file hỏng → về mặc định */ }
  const env = (process.env['SIGMA_INSTANCE_DIR'] ?? '').trim();
  return env || 'AlphaQuanLy';
}

/** Đọc cấu hình máy chủ nếu client đã cấu hình. Trả null nếu chưa (→ UI hiện màn cấu hình). */
export function readServerConfig(): ServerConfig | null {
  const p = serverConfigPath();
  if (!existsSync(p)) return readBundledDefaultConfig();
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8')) as Partial<ServerConfig> & { password_enc?: string };
    // SEC-01 (audit 15/7, Codex): ưu tiên mật khẩu ĐÃ MÃ HÓA (password_enc base64 safeStorage); fallback
    // password thô cho file cấu hình cũ (tương thích ngược, sẽ được mã hóa lại ở lần save kế).
    let password = cfg.password ?? '';
    if (cfg.password_enc && safeStorage.isEncryptionAvailable()) {
      try { password = safeStorage.decryptString(Buffer.from(cfg.password_enc, 'base64')); } catch { /* hỏng → giữ rỗng */ }
    }
    if (!cfg.host || !cfg.database || !cfg.user || (cfg.password == null && !cfg.password_enc)) return readBundledDefaultConfig();
    return { host: cfg.host, port: cfg.port ?? 5432, database: cfg.database, user: cfg.user, password, apiBaseUrl: cfg.apiBaseUrl?.trim() || undefined };
  } catch {
    return readBundledDefaultConfig();
  }
}

/** Config máy chủ MẶC ĐỊNH đóng gói SẴN trong bản cài (Admin Demo 3/8 "tích hợp luôn, chỉ cài + đăng nhập").
 * Đọc từ resources/server-config.default.json (đóng gói qua electron-builder extraResources). Client KHÔNG
 * phải nhập IP/mật khẩu tay — vào thẳng Login. Nếu client MUỐN đổi máy chủ khác thì màn "Cấu hình máy chủ"
 * vẫn ghi userData/server-config.json (ưu tiên hơn bản mặc định này). Mật khẩu để THÔ (mô hình A: mật khẩu
 * pg chung nằm trên máy client — chấp nhận rủi ro LAN nội bộ tin cậy, đã chốt G10 QA #3/#4). */
function readBundledDefaultConfig(): ServerConfig | null {
  if (!app.isPackaged) return null;
  try {
    const dp = join(process.resourcesPath, 'server-config.default.json');
    if (!existsSync(dp)) return null;
    const cfg = JSON.parse(readFileSync(dp, 'utf8')) as Partial<ServerConfig>;
    if (!cfg.host || !cfg.database || !cfg.user || cfg.password == null) return null;
    return { host: cfg.host, port: cfg.port ?? 5432, database: cfg.database, user: cfg.user, password: cfg.password };
  } catch {
    return null;
  }
}

/** Đọc RIÊNG địa chỉ máy chủ API (apiBaseUrl) — ĐỘC LẬP với tính đầy đủ của cấu hình Postgres
 * (host/user/password). Preload gọi qua IPC `config:apiBase` để lấy nhanh (đồng bộ ở main, cache 1 lần
 * ở renderer). Đọc thẳng file cấu hình client %APPDATA%\AlphaQuanLy\server-config.json; nếu không có,
 * thử server-config.default.json đóng gói (bản cài đặt sẵn). Trả '' nếu chưa cấu hình → preload tự
 * fallback domain Cloudflare mặc định. Đã chuẩn hóa: trim + bỏ dấu '/' thừa cuối. */
export function readApiBaseUrl(): string {
  const pick = (raw: unknown): string => {
    if (typeof raw !== 'string') return '';
    const v = raw.trim().replace(/\/+$/, '');
    return v;
  };
  try {
    const p = serverConfigPath();
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, 'utf8')) as { apiBaseUrl?: unknown };
      const v = pick(cfg.apiBaseUrl);
      if (v) return v;
    }
  } catch { /* file hỏng → thử bản đóng gói */ }
  if (app.isPackaged) {
    try {
      const dp = join(process.resourcesPath, 'server-config.default.json');
      if (existsSync(dp)) {
        const cfg = JSON.parse(readFileSync(dp, 'utf8')) as { apiBaseUrl?: unknown };
        const v = pick(cfg.apiBaseUrl);
        if (v) return v;
      }
    } catch { /* ignore → default domain dưới */ }
  }
  // ĐỒNG NHẤT VỚI SigMa (Admin Demo 12/8 "phải đồng nhất như alpha link") — máy ngoài KHÔNG có config + KHÔNG có
  // file default đóng gói (từng mất trong data-loss) vẫn PHẢI mở-là-chạy: fallback domain quanly-api công khai
  // ĐÃ BAKE (trùng preload DEFAULT_API_BASE + app.ts). => isApiMode=true => needsConfig=false => vào thẳng Login,
  // KHÔNG hỏi cấu hình. Chỉ ở packaged (dev/selftest giữ '' để không nuốt cấu hình Postgres cục bộ).
  if (app.isPackaged) return 'https://alpha-quanly-api.example.com';
  return '';
}

/**
 * Đọc THẺ DỊCH VỤ Cloudflare Access (nếu máy này đã được cấu hình). Trả `null` khi chưa có — khi đó app
 * gọi API y như trước, KHÔNG gửi header thừa, nên bật dần từng máy mà không ai rớt.
 *
 * Thứ tự: biến môi trường (dành cho máy chủ/CI) → server-config.json của máy → file default đóng gói.
 * CẤM hardcode thẻ vào mã nguồn: thẻ là bí mật, mã nguồn thì nằm trong repo và trong bản cài.
 */
export function readCfAccessToken(): { id: string; secret: string } | null {
  const lay = (o: unknown): { id: string; secret: string } | null => {
    const c = o as { cfAccessClientId?: unknown; cfAccessClientSecret?: unknown; cfAccessClientSecret_enc?: unknown } | null;
    const id = typeof c?.cfAccessClientId === 'string' ? c.cfAccessClientId.trim() : '';
    let secret = typeof c?.cfAccessClientSecret === 'string' ? c.cfAccessClientSecret.trim() : '';
    // Secret ĐÃ MÃ HOÁ (safeStorage/DPAPI) được ưu tiên — giống cách làm với mật khẩu DB.
    if (typeof c?.cfAccessClientSecret_enc === 'string' && c.cfAccessClientSecret_enc && safeStorage.isEncryptionAvailable()) {
      try { secret = safeStorage.decryptString(Buffer.from(c.cfAccessClientSecret_enc, 'base64')); } catch { /* hỏng → giữ giá trị thô nếu có */ }
    }
    return id && secret ? { id, secret } : null;
  };
  const envId = (process.env['SIGMA_CF_ACCESS_ID'] ?? '').trim();
  const envSecret = (process.env['SIGMA_CF_ACCESS_SECRET'] ?? '').trim();
  if (envId && envSecret) return { id: envId, secret: envSecret };
  try {
    const p = serverConfigPath();
    if (existsSync(p)) {
      const v = lay(JSON.parse(readFileSync(p, 'utf8')));
      if (v) return v;
    }
  } catch { /* file hỏng → thử bản đóng gói */ }
  if (app.isPackaged) {
    try {
      const dp = join(process.resourcesPath, 'server-config.default.json');
      if (existsSync(dp)) {
        const v = lay(JSON.parse(readFileSync(dp, 'utf8')));
        if (v) return v;
      }
    } catch { /* ignore */ }
  }
  return null;
}

/** Dựng chuỗi postgresql:// (URL-encode user/password để không vỡ khi có ký tự đặc biệt). */
function buildPgUrl(cfg: ServerConfig): string {
  const user = encodeURIComponent(cfg.user);
  const pass = encodeURIComponent(cfg.password);
  // 4/8 (Admin Demo "cài xong rất lâu chưa lên app") — máy ngoài nối DB QUA CẦU Cloudflare (127.0.0.1:5442):
  // cloudflared mở cổng ngay nhưng phiên tới Postgres có thể nối chậm/treo → Prisma $connect KHÔNG timeout mặc
  // định → initDb TREO VÔ HẠN → cửa sổ không lên. `connect_timeout=8` (giây): Prisma bỏ nếu nối > 8s → initDb
  // ném lỗi (fail-closed → màn "Cấu hình máy chủ") thay vì treo. Nối LAN trực tiếp vẫn nhanh (< 1s), không ảnh hưởng.
  return `postgresql://${user}:${pass}@${cfg.host}:${cfg.port ?? 5432}/${cfg.database}?connect_timeout=8`;
}

/** Resolve the PostgreSQL connection URL (postgresql://...) for the current run. */
export function resolveDatabaseUrl(): string {
  // Explicit override (self-test harness points at a throwaway Postgres database).
  if (process.env['SIGMA_DB_URL']) return process.env['SIGMA_DB_URL'] as string;
  // Dev (.env) — máy chủ dev + selftest CLI.
  if (!app.isPackaged && process.env['DATABASE_URL']) return process.env['DATABASE_URL'] as string;
  // Client đóng gói: đọc cấu hình máy chủ (IP:port + tài khoản pg chung).
  const cfg = readServerConfig();
  if (cfg) return buildPgUrl(cfg);
  throw new Error(
    'CHƯA cấu hình máy chủ PostgreSQL. Hãy mở "Cấu hình máy chủ" nhập IP:port + tài khoản, ' +
      'hoặc đặt DATABASE_URL (dev).'
  );
}

// B83 (Admin Demo báo 20/7, "sao không sao lưu được"): SIGMA_ROLE là biến môi trường TIẾN TRÌNH — chỉ
// selftest (harness tự set) mới đặt được. App đóng gói mở bằng icon thường KHÔNG có cách nào tự đặt
// biến này, nên trên chính máy chủ thật, isServerRole() luôn false → mọi gate (backup/statfs) chặn
// nhầm CẢ máy chủ. Fix: thêm marker FILE bền (ProgramData, sống qua reboot/đổi user/quirk kế thừa env
// của Explorer) — 1 lần đánh dấu "máy này là máy chủ" (Admin tạo lúc setup máy chủ), KHÔNG phụ thuộc
// biến môi trường mỗi lần mở app. SIGMA_ROLE vẫn ưu tiên (giữ tương thích selftest hiện có).
function serverRoleMarkerPath(): string {
  // Override cho test (tránh chạm ProgramData thật). Production: %ProgramData%\SigMa\role-server.flag
  // (thư mục dùng chung mọi user trên máy, không như userData vốn theo-từng-user). RIÊNG khỏi GLB
  // (%ProgramData%\GLB\...) để SigMa KHÔNG nhận nhầm vai máy chủ từ marker của GLB trên cùng máy 127.0.0.1.
  if (process.env['SIGMA_ROLE_MARKER']) return process.env['SIGMA_ROLE_MARKER'] as string;
  const base = process.env['ProgramData'] || 'C:/ProgramData';
  return join(base, 'SigMa', 'role-server.flag');
}

/** True nếu tiến trình này là MÁY CHỦ (được phép seed/migrate/backup). Mặc định = client (fail-safe). */
export function isServerRole(): boolean {
  if (process.env['SIGMA_ROLE'] === 'server') return true;
  try {
    return existsSync(serverRoleMarkerPath());
  } catch {
    return false;
  }
}

/**
 * True nếu tiến trình đang ở CHẾ ĐỘ API (4/8 — máy ngoài mở-là-chạy): dữ liệu đi qua REST `quanly-api`
 * (preload httpCall), KHÔNG nối Postgres trực tiếp → boot KHÔNG gọi initDb().
 * LOẠI TRỪ (luôn nối Postgres trực tiếp): selftest (SIGMA_DB_URL), dev (.env DATABASE_URL), máy chủ (serverRole).
 * Điều kiện còn lại: đã cấu hình apiBaseUrl (readApiBaseUrl có giá trị).
 */
export function isApiMode(): boolean {
  if (process.env['SIGMA_DB_URL']) return false;
  if (!app.isPackaged && process.env['DATABASE_URL']) return false;
  if (isServerRole()) return false;
  return readApiBaseUrl() !== '';
}

export function getDb(): Db {
  if (!prisma) {
    // Ở chế độ API (máy ngoài không có Postgres), initDb KHÔNG được gọi nên prisma rỗng. Nếu 1 IPC handler
    // CHƯA migrate sang httpCall còn gọi getDb() → ném lỗi tiếng Việt RÕ (KHÔNG crash tiến trình): handle()
    // trong ipc.ts bắt lỗi này và trả về renderer thông điệp gọn. Đa số IPC đã dùng httpCall nên không tới đây.
    if (isApiMode()) {
      throw new Error(
        'Chức năng này cần chạy trên máy chủ (kết nối cơ sở dữ liệu trực tiếp). Máy này đang ở chế độ kết nối qua máy chủ API.'
      );
    }
    throw new Error('DB not initialised — call initDb() first.');
  }
  return prisma;
}

/**
 * Provision the catalog + default admin. Idempotent and ADDITIVE:
 * - permissions/roles/role_permissions are always upserted so schema evolution
 *   (e.g. new G-POS CUSTOMER/POS/TID permissions) lands on existing databases too.
 * - the default admin is created only when NO admin exists (R001).
 * - every user missing an employee_code is backfilled a NV## code (adminroot → NV01, §D).
 */
export async function seedIfEmpty(db: Db): Promise<void> {
  for (const p of PERMISSIONS) {
    await db.permission.upsert({
      where: { code: p.code },
      update: { name: p.name, group: p.group },
      create: { code: p.code, name: p.name, group: p.group }
    });
  }
  // LEAD lock 9/7: app KHÔNG được tự ý hoàn tác/đổi dữ liệu (đặc biệt quyền) một cách âm thầm.
  // → default role-permissions chỉ được gắn khi role được TẠO MỚI lần đầu. Với role đã tồn tại,
  //   chỉnh tay của admin (thêm/bớt quyền) được GIỮ NGUYÊN — reboot KHÔNG tự cấp lại quyền đã gỡ.
  //   (fix G-POS-A01)
  const freshlyCreatedRoleCodes = new Set<string>();
  for (const r of ROLES) {
    const existed = await db.role.findUnique({ where: { code: r.code }, select: { id: true } });
    await db.role.upsert({
      where: { code: r.code },
      update: { name: r.name, description: r.description, isSystem: r.isSystem },
      create: { name: r.name, code: r.code, description: r.description, isSystem: r.isSystem, status: 'ACTIVE' }
    });
    if (!existed) freshlyCreatedRoleCodes.add(r.code);
  }
  for (const [roleCode, permCodes] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    // Chỉ seed quyền mặc định cho role vừa tạo mới. Role cũ giữ nguyên cấu hình admin đã sửa.
    if (!freshlyCreatedRoleCodes.has(roleCode)) continue;
    const role = await db.role.findUnique({ where: { code: roleCode } });
    if (!role) continue;
    for (const code of permCodes) {
      const perm = await db.permission.findUnique({ where: { code } });
      if (!perm) continue;
      await db.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        update: {},
        create: { roleId: role.id, permissionId: perm.id }
      });
    }
  }
  // R_ADMIN_SUPERUSER (LEAD 9/7): ADMIN = superuser → LUÔN đồng bộ ĐỦ mọi quyền mỗi boot,
  // kể cả quyền MỚI thêm sau này (chống bug "thêm feature → thêm permission → role ADMIN cũ
  // thiếu quyền → menu/tính năng bị ẩn"). Role khác vẫn giữ chỉnh tay của admin (không tự cấp lại).
  {
    const adminRoleForSync = await db.role.findUnique({ where: { code: 'ADMIN' }, select: { id: true } });
    if (adminRoleForSync) {
      const allPerms = await db.permission.findMany({ select: { id: true } });
      for (const perm of allPerms) {
        await db.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: adminRoleForSync.id, permissionId: perm.id } },
          update: {},
          create: { roleId: adminRoleForSync.id, permissionId: perm.id }
        });
      }
    }
  }

  // db-evolution (G-CFG.7 I1): cấp quyền ngành nghề cho role CŨ 1 lần/DB (cờ AppSetting). Trên DB
  // mới, role vừa tạo đã có quyền qua DEFAULT_ROLE_PERMISSIONS → bước này grant=0 (an toàn no-op).
  {
    const flag = await db.appSetting.findUnique({ where: { key: INDUSTRY_GRANT_FLAG } });
    if (!flag) {
      const granted = await grantIndustryPermsToExistingRoles(db);
      await db.appSetting.upsert({
        where: { key: INDUSTRY_GRANT_FLAG },
        update: {},
        create: { key: INDUSTRY_GRANT_FLAG, value: new Date().toISOString() }
      });
      if (granted > 0) {
        await writeAudit(db, {
          actorUserId: null,
          action: 'INDUSTRY_PERMS_GRANTED',
          targetType: 'System',
          after: { granted, roles: INDUSTRY_PERM_TARGET_ROLES, perms: INDUSTRY_PERM_CODES }
        });
      }
    }
  }

  // db-evolution (R27 kho): cấp quyền danh mục kho (CONFIG_WAREHOUSE_*) cho role CŨ 1 lần/DB (cờ
  // AppSetting). DB mới → role vừa tạo đã có quyền qua DEFAULT_ROLE_PERMISSIONS → grant=0 (no-op an toàn).
  {
    const flag = await db.appSetting.findUnique({ where: { key: WAREHOUSE_GRANT_FLAG } });
    if (!flag) {
      const granted = await grantWarehousePermsToExistingRoles(db);
      await db.appSetting.upsert({
        where: { key: WAREHOUSE_GRANT_FLAG },
        update: {},
        create: { key: WAREHOUSE_GRANT_FLAG, value: new Date().toISOString() }
      });
      if (granted > 0) {
        await writeAudit(db, {
          actorUserId: null,
          action: 'WAREHOUSE_PERMS_GRANTED',
          targetType: 'System',
          after: { granted, fullRoles: WAREHOUSE_FULL_ROLES, viewRoles: WAREHOUSE_VIEW_ROLES, perms: WAREHOUSE_FULL_CODES }
        });
      }
    }
  }

  // db-evolution (#3 bán thiết bị): cấp quyền DEVICE_SALE_* cho role CŨ 1 lần/DB (cờ AppSetting).
  {
    const flag = await db.appSetting.findUnique({ where: { key: DEVICE_SALE_GRANT_FLAG } });
    if (!flag) {
      const granted = await grantDeviceSalePermsToExistingRoles(db);
      await db.appSetting.upsert({
        where: { key: DEVICE_SALE_GRANT_FLAG },
        update: {},
        create: { key: DEVICE_SALE_GRANT_FLAG, value: new Date().toISOString() }
      });
      if (granted > 0) {
        await writeAudit(db, {
          actorUserId: null,
          action: 'DEVICE_SALE_PERMS_GRANTED',
          targetType: 'System',
          after: { granted, fullRoles: DEVICE_SALE_FULL_ROLES, viewRoles: DEVICE_SALE_VIEW_ROLES, perms: DEVICE_SALE_FULL_CODES }
        });
      }
    }
  }

  // db-evolution (LOẠI GIAO MÁY): cấp quyền loại giao (CONFIG_HANDOVER_*) cho role CŨ 1 lần/DB (cờ
  // AppSetting). DB mới → role vừa tạo đã có quyền qua DEFAULT_ROLE_PERMISSIONS → grant=0 (no-op an toàn).
  {
    const flag = await db.appSetting.findUnique({ where: { key: HANDOVER_GRANT_FLAG } });
    if (!flag) {
      const granted = await grantHandoverPermsToExistingRoles(db);
      await db.appSetting.upsert({
        where: { key: HANDOVER_GRANT_FLAG },
        update: {},
        create: { key: HANDOVER_GRANT_FLAG, value: new Date().toISOString() }
      });
      if (granted > 0) {
        await writeAudit(db, {
          actorUserId: null,
          action: 'HANDOVER_PERMS_GRANTED',
          targetType: 'System',
          after: { granted, fullRoles: HANDOVER_FULL_ROLES, viewRoles: HANDOVER_VIEW_ROLES, perms: HANDOVER_FULL_CODES }
        });
      }
    }
  }

  // db-evolution (PHASE 1 yêu cầu xuất kho): cấp quyền EXPORT_REQUEST_* cho role CŨ 1 lần/DB (cờ
  // AppSetting). DB mới → role vừa tạo đã có quyền qua DEFAULT_ROLE_PERMISSIONS → grant=0 (no-op an toàn).
  {
    const flag = await db.appSetting.findUnique({ where: { key: EXPORT_REQ_GRANT_FLAG } });
    if (!flag) {
      const granted = await grantExportReqPermsToExistingRoles(db);
      await db.appSetting.upsert({
        where: { key: EXPORT_REQ_GRANT_FLAG },
        update: {},
        create: { key: EXPORT_REQ_GRANT_FLAG, value: new Date().toISOString() }
      });
      if (granted > 0) {
        await writeAudit(db, {
          actorUserId: null,
          action: 'EXPORT_REQ_PERMS_GRANTED',
          targetType: 'System',
          after: { granted, fullRoles: EXPORT_REQ_FULL_ROLES, baseRoles: EXPORT_REQ_BASE_ROLES, perms: EXPORT_REQ_FULL_CODES }
        });
      }
    }
  }

  // db-evolution (Bill giải trình): cấp quyền BILLEXPLAIN_*/PRODUCT_MANAGE cho role CŨ (MANAGER/ACCOUNTANT)
  // 1 lần/DB (cờ AppSetting). ADMIN đã tự nhận qua R_ADMIN_SUPERUSER. DB mới → role vừa tạo đã có → grant=0.
  {
    const flag = await db.appSetting.findUnique({ where: { key: BILLEXPLAIN_GRANT_FLAG } });
    if (!flag) {
      const granted = await grantBillExplainPermsToExistingRoles(db);
      await db.appSetting.upsert({
        where: { key: BILLEXPLAIN_GRANT_FLAG },
        update: {},
        create: { key: BILLEXPLAIN_GRANT_FLAG, value: new Date().toISOString() }
      });
      if (granted > 0) {
        await writeAudit(db, {
          actorUserId: null,
          action: 'BILLEXPLAIN_PERMS_GRANTED',
          targetType: 'System',
          after: { granted, targetRoles: BILLEXPLAIN_TARGET_ROLES, perms: BILLEXPLAIN_PERM_CODES }
        });
      }
    }
  }

  // seed THƯ VIỆN SẢN PHẨM gốc từ renbill 1 lần/DB (cờ AppSetting). Idempotent + non-destructive (chỉ
  // seed SP khi ngành rỗng). Lỗi đọc file/seed KHÔNG làm chết boot (nuốt, log audit khi có thay đổi).
  {
    const flag = await db.appSetting.findUnique({ where: { key: BILLEXPLAIN_LIBRARY_FLAG } });
    if (!flag) {
      try {
        const r = await seedBillExplainLibrary(db);
        await db.appSetting.upsert({
          where: { key: BILLEXPLAIN_LIBRARY_FLAG },
          update: {},
          create: { key: BILLEXPLAIN_LIBRARY_FLAG, value: new Date().toISOString() }
        });
        if (r.industries > 0 || r.products > 0) {
          await writeAudit(db, { actorUserId: null, action: 'PRODUCT_IMPORTED', targetType: 'System', after: { seededFromRenbill: true, ...r } });
        }
      } catch {
        // nuốt lỗi seed thư viện (offline-safe) — không đặt cờ để lần boot sau thử lại.
      }
    }
  }

  // Seed V2 (2/10/2026) — BỔ SUNG SP còn thiếu cho máy ĐÃ seed V1 (thư viện siêu thị 199 → 800 SP). Cờ
  // riêng V2 nên máy cũ cũng chạy đúng 1 lần. Non-destructive: chỉ thêm tên chưa có, không đè/không xoá.
  {
    const flagV2 = await db.appSetting.findUnique({ where: { key: BILLEXPLAIN_LIBRARY_FLAG_V2 } });
    if (!flagV2) {
      try {
        const r2 = await seedBillExplainLibraryBoSung(db);
        await db.appSetting.upsert({
          where: { key: BILLEXPLAIN_LIBRARY_FLAG_V2 },
          update: {},
          create: { key: BILLEXPLAIN_LIBRARY_FLAG_V2, value: new Date().toISOString() }
        });
        if (r2.industries > 0 || r2.products > 0) {
          await writeAudit(db, { actorUserId: null, action: 'PRODUCT_IMPORTED', targetType: 'System', after: { seedBoSungV2: true, ...r2 } });
        }
      } catch (e) {
        // KHÔNG đặt cờ ⇒ boot sau thử lại. KHÔNG nuốt im (R198): in lỗi để còn truy được.
        console.error('[seed] bổ sung thư viện SP V2 lỗi:', e instanceof Error ? e.message : e);
      }
    }
  }

  // db-evolution (PHASE H1): cấp quyền thu-chi (CASHCAT_*) cho role CŨ 1 lần/DB (cờ AppSetting).
  // DB mới → role vừa tạo đã có quyền qua DEFAULT_ROLE_PERMISSIONS → grant=0 (no-op an toàn).
  {
    const flag = await db.appSetting.findUnique({ where: { key: CASHCAT_GRANT_FLAG } });
    if (!flag) {
      const granted = await grantCashCatPermsToExistingRoles(db);
      await db.appSetting.upsert({
        where: { key: CASHCAT_GRANT_FLAG },
        update: {},
        create: { key: CASHCAT_GRANT_FLAG, value: new Date().toISOString() }
      });
      if (granted > 0) {
        await writeAudit(db, {
          actorUserId: null,
          action: 'CASHCAT_PERMS_GRANTED',
          targetType: 'System',
          after: { granted, roles: CASHCAT_PERM_TARGET_ROLES, perms: CASHCAT_PERM_CODES }
        });
      }
    }
  }

  // db-evolution (PHASE H2-core): cấp quyền quỹ + phiếu thu/chi (FUND_*/CASHENTRY_*) cho role CŨ
  // (MANAGER/ACCOUNTANT) 1 lần/DB (cờ AppSetting). DB mới → role vừa tạo đã có quyền qua
  // DEFAULT_ROLE_PERMISSIONS → grant=0 (no-op an toàn).
  {
    const flag = await db.appSetting.findUnique({ where: { key: CASHFLOW_GRANT_FLAG } });
    if (!flag) {
      const granted = await grantCashflowPermsToExistingRoles(db);
      await db.appSetting.upsert({
        where: { key: CASHFLOW_GRANT_FLAG },
        update: {},
        create: { key: CASHFLOW_GRANT_FLAG, value: new Date().toISOString() }
      });
      if (granted > 0) {
        await writeAudit(db, {
          actorUserId: null,
          action: 'CASHFLOW_PERMS_GRANTED',
          targetType: 'System',
          after: { granted, roles: CASHFLOW_PERM_TARGET_ROLES, perms: CASHFLOW_PERM_CODES }
        });
      }
    }
  }

  // db-evolution (PHASE H2b): cấp quyền phân loại/ghi giảm công nợ (DEBT_CLASSIFY/DEBT_WRITEOFF) cho
  // role CŨ (MANAGER/ACCOUNTANT) 1 lần/DB (cờ AppSetting). DB mới → role vừa tạo đã có quyền qua
  // DEFAULT_ROLE_PERMISSIONS → grant=0 (no-op an toàn).
  {
    const flag = await db.appSetting.findUnique({ where: { key: DEBT_QUALITY_GRANT_FLAG } });
    if (!flag) {
      const granted = await grantDebtQualityPermsToExistingRoles(db);
      await db.appSetting.upsert({
        where: { key: DEBT_QUALITY_GRANT_FLAG },
        update: {},
        create: { key: DEBT_QUALITY_GRANT_FLAG, value: new Date().toISOString() }
      });
      if (granted > 0) {
        await writeAudit(db, {
          actorUserId: null,
          action: 'DEBT_QUALITY_PERMS_GRANTED',
          targetType: 'System',
          after: { granted, grants: DEBT_QUALITY_GRANTS }
        });
      }
    }
  }

  // PHASE H1: seed danh mục thu/chi hệ thống (idempotent — bỏ qua danh mục đã tồn tại).
  await seedSystemCashCategories(db);

  // LOẠI GIAO MÁY (Admin Demo): seed 4 loại giao builtin (Bán/Cho thuê/Mượn/Cọc) — idempotent theo name.
  await seedBuiltinHandoverTypes(db);

  // VIỆC 1: seed 4 trạng thái nhập máy POS mặc định (idempotent theo name). Fix màn/nút "Nhập kho
  // máy POS" bị chặn vĩnh viễn khi PosIntakeStatus rỗng — áp cho cả DB mới lẫn DB đã tồn tại.
  await seedDefaultIntakeStatusesIfMissing(db);

  // PHASE K1 (§2.2, desync #22): backfill PosDevice từ pos_intakes 1 LẦN/DB (cờ AppSetting). DB mới
  // (chưa có phiếu nhập) → no-op an toàn. Idempotent nên kể cả không guard cũng không nhân đôi; cờ
  // chỉ để tránh quét lại toàn bảng mỗi boot.
  {
    const flag = await db.appSetting.findUnique({ where: { key: POS_UNIFY_BACKFILL_FLAG } });
    if (!flag) {
      const report = await backfillPosDevicesFromIntakes(db);
      await db.appSetting.upsert({
        where: { key: POS_UNIFY_BACKFILL_FLAG },
        update: {},
        create: { key: POS_UNIFY_BACKFILL_FLAG, value: new Date().toISOString() }
      });
      if (report.created > 0 || report.filled > 0 || report.stockInAdded > 0) {
        await writeAudit(db, { actorUserId: null, action: 'POS_UNIFY_BACKFILL', targetType: 'System', after: report });
      }
      if (report.intakeSerials !== report.deviceSerials) {
        // eslint-disable-next-line no-console
        console.warn(`[pos-unify] đối soát lệch: ${report.intakeSerials} serial phiếu nhập vs ${report.deviceSerials} máy tương ứng`);
      }
    }
  }

  // PHASE K2 (§8, Q-T3): backfill dossierId cho tids từ hkdName 1 LẦN/DB (cờ AppSetting). DB mới
  // (chưa có TID/Dossier) → no-op. Idempotent; khớp chính xác 1 → set, mơ hồ/không khớp → null + log.
  {
    const flag = await db.appSetting.findUnique({ where: { key: TID_UNIFY_BACKFILL_FLAG } });
    if (!flag) {
      const report = await backfillTidDossierIds(db);
      await db.appSetting.upsert({
        where: { key: TID_UNIFY_BACKFILL_FLAG },
        update: {},
        create: { key: TID_UNIFY_BACKFILL_FLAG, value: new Date().toISOString() }
      });
      if (report.linked > 0 || report.ambiguous > 0 || report.unmatched > 0) {
        await writeAudit(db, { actorUserId: null, action: 'TID_UNIFY_DOSSIER_BACKFILL', targetType: 'System', after: report });
      }
      if (report.ambiguous > 0 || report.unmatched > 0) {
        // eslint-disable-next-line no-console
        console.warn(`[tid-unify] dossierId backfill: linked=${report.linked} ambiguous=${report.ambiguous} unmatched=${report.unmatched} (giữ null, cần gán tay)`);
      }
    }
  }

  const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
  const existingAdmin = await db.user.findFirst({
    where: { deletedAt: null, roles: { some: { roleId: adminRole.id } } }
  });
  if (!existingAdmin) {
    await db.user.create({
      data: {
        fullName: 'Quản trị hệ thống',
        username: ADMIN_USERNAME,
        passwordHash: hashPassword(ADMIN_DEFAULT_PASSWORD),
        status: 'ACTIVE',
        forceChangePassword: true,
        roles: { create: { roleId: adminRole.id } }
      }
    });
  }

  // §D: ensure every user carries a mã NV (adminroot → NV01).
  await backfillEmployeeCodes(db);
}

/**
 * SELF-HEAL schema (bug DB-tiến-hóa 0.2.34): Prisma 7 KHÔNG có migrate engine trong .exe → nếu deploy bản mới
 * mà QUÊN chạy `prisma migrate deploy` trên DB dùng chung, các cột ADDITIVE mà CODE ĐANG ĐỌC bị thiếu →
 * login truy vấn `users.lock_reason` → "column does not exist" → "Lỗi hệ thống khi đăng nhập".
 * Vá triệt để: mỗi boot chạy `ADD COLUMN IF NOT EXISTS` (PostgreSQL, idempotent, KHÔNG mất dữ liệu) cho các cột
 * additive sau baseline. Fresh DB (đã migrate) → no-op. Mỗi câu bọc try/catch → non-fatal (không sập app).
 */
export async function ensureCriticalSchema(db: Db): Promise<void> {
  const stmts = [
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lock_reason" TEXT`,
    `ALTER TABLE "export_requests" ADD COLUMN IF NOT EXISTS "method" TEXT NOT NULL DEFAULT 'CASH'`,
    // LOẠI GIAO — ĐẶT CỌC độc lập (Admin Demo 9/8): cờ has_deposit (cho phép nhập cọc lúc giao, 0=không cọc) ghép
    // mọi hình thức tiền (Cho thuê/Mượn/Đối ứng kèm cọc, Bán không). Additive, default false → self-heal an toàn.
    `ALTER TABLE "handover_types" ADD COLUMN IF NOT EXISTS "has_deposit" BOOLEAN NOT NULL DEFAULT false`,
    // NHÀ ĐẦU TƯ (Admin Demo 9/8, Phase A) — bảng investors (mirror customers). Client .exe không có migrate engine
    // → self-heal CREATE TABLE IF NOT EXISTS mỗi boot (server migrate qua CLI; fresh DB đã có → no-op).
    `CREATE TABLE IF NOT EXISTS "investors" (
      "id" SERIAL NOT NULL,
      "code" TEXT NOT NULL,
      "full_name" TEXT NOT NULL,
      "nickname" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'ACTIVE',
      "phone" TEXT, "email" TEXT, "address" TEXT,
      "invest_fee_milli" INTEGER NOT NULL DEFAULT 0,
      "user_id" INTEGER,
      "note" TEXT,
      "created_by" INTEGER,
      "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "deleted_at" TIMESTAMPTZ(3), "deleted_by" INTEGER,
      CONSTRAINT "investors_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "investors_code_key" ON "investors" ("code")`,
    `CREATE INDEX IF NOT EXISTS "investors_deleted_at_status_idx" ON "investors" ("deleted_at", "status")`,
    // NHÀ ĐẦU TƯ Phase C-2b (Admin Demo 10/8) — %phí cài máy TẤT TOÁN (×1000; 1.06%=1060). tiềnVề = doanhThu×(1−fee/100000).
    `ALTER TABLE "investors" ADD COLUMN IF NOT EXISTS "settle_fee_milli" INTEGER NOT NULL DEFAULT 0`,
    // NHÀ ĐẦU TƯ Phase C-2a (Admin Demo 10/8) — Sổ TẠM ỨNG vốn + TK CK "đi tiền tạm ứng". Client .exe không có migrate
    // engine → self-heal CREATE TABLE IF NOT EXISTS mỗi boot (KHỚP migration 20260810000000_investor_advance). amount
    // BIGINT (int8, tiền VND không giới hạn). timestamptz(3).
    `CREATE TABLE IF NOT EXISTS "investor_advances" (
      "id" SERIAL NOT NULL,
      "investor_id" INTEGER NOT NULL,
      "amount" BIGINT NOT NULL,
      "advance_date" TIMESTAMPTZ(3) NOT NULL,
      "source" TEXT NOT NULL DEFAULT 'MANUAL',
      "note" TEXT,
      "created_by" INTEGER,
      "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "deleted_at" TIMESTAMPTZ(3), "deleted_by" INTEGER,
      CONSTRAINT "investor_advances_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE INDEX IF NOT EXISTS "investor_advances_investor_id_idx" ON "investor_advances" ("investor_id")`,
    `CREATE INDEX IF NOT EXISTS "investor_advances_advance_date_idx" ON "investor_advances" ("advance_date")`,
    // Chi tiết TẠM ỨNG (Admin Demo 11/8) — người ứng + người nhận (STK/tên/NH), nguồn OCR|tay. 6 cột TEXT nullable
    // additive (KHỚP migration 20260811200000_advance_detail). IF NOT EXISTS → idempotent mỗi boot.
    `ALTER TABLE "investor_advances" ADD COLUMN IF NOT EXISTS "sender_account_number" TEXT`,
    `ALTER TABLE "investor_advances" ADD COLUMN IF NOT EXISTS "sender_name" TEXT`,
    `ALTER TABLE "investor_advances" ADD COLUMN IF NOT EXISTS "sender_bank" TEXT`,
    `ALTER TABLE "investor_advances" ADD COLUMN IF NOT EXISTS "receiver_account_number" TEXT`,
    `ALTER TABLE "investor_advances" ADD COLUMN IF NOT EXISTS "receiver_name" TEXT`,
    `ALTER TABLE "investor_advances" ADD COLUMN IF NOT EXISTS "receiver_bank" TEXT`,
    // Nối bill→doanh số (21/8): khóa bill tự nhiên trên los để gửi-lại/SỬA cùng bill = UPSERT cùng Lô.
    `ALTER TABLE "los" ADD COLUMN IF NOT EXISTS "bill_key" TEXT`,
    `CREATE INDEX IF NOT EXISTS "los_agent_id_bill_key_idx" ON "los" ("agent_id", "bill_key")`,
    // Bill giải trình (21/8): cho dùng TÊN HKD của TID thay Hồ sơ → dossier_id nullable (idempotent).
    `ALTER TABLE "bill_explains" ALTER COLUMN "dossier_id" DROP NOT NULL`,
    `CREATE TABLE IF NOT EXISTS "investor_bank_accounts" (
      "id" SERIAL NOT NULL,
      "investor_id" INTEGER NOT NULL,
      "bank_name" TEXT,
      "account_number" TEXT NOT NULL,
      "account_holder" TEXT,
      "note" TEXT,
      "created_by" INTEGER,
      "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "deleted_at" TIMESTAMPTZ(3), "deleted_by" INTEGER,
      CONSTRAINT "investor_bank_accounts_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE INDEX IF NOT EXISTS "investor_bank_accounts_investor_id_idx" ON "investor_bank_accounts" ("investor_id")`,
    // Tìm kiếm tiếng Việt không phân biệt HOA/thường + DẤU (Admin Demo 15/7): ILIKE không fold Đ↔đ. Dùng
    // unaccent(lower()) để "đức dũng"/"duc dung"/"ĐỨC DŨNG" đều khớp. Extension idempotent, tạo mỗi boot.
    `CREATE EXTENSION IF NOT EXISTS unaccent`,
    // REL-12 (Codex 15/7): đổi txn_date sang timestamptz như mọi cột thời gian khác (chống lệch múi giờ). GUARD:
    // CHỈ đổi khi còn 'timestamp without time zone' → idempotent, KHÔNG double-convert. Giá trị cũ lưu là UTC
    // instant nên interpret AT TIME ZONE 'UTC' là đúng.
    `DO $$ BEGIN IF (SELECT data_type FROM information_schema.columns WHERE table_name='transactions' AND column_name='txn_date') = 'timestamp without time zone' THEN ALTER TABLE transactions ALTER COLUMN txn_date TYPE timestamptz(3) USING txn_date AT TIME ZONE 'UTC'; END IF; END $$`,
    // REL-06 (Codex 15/7): partial-unique bản-ghi-SỐNG cho FeeRate/FeeSellQuote (trước chỉ enforce ở service
    // FOR UPDATE → 2 transaction song song có thể chèn trùng kỳ giá). Partial (WHERE deleted_at IS NULL) để
    // không phá soft-delete (bài học B05). Idempotent (IF NOT EXISTS).
    `CREATE UNIQUE INDEX IF NOT EXISTS "fee_rates_active_uq" ON "fee_rates" ("partner_id", "card_type_id", "effective_from") WHERE "deleted_at" IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "fee_sell_quotes_active_uq" ON "fee_sell_quotes" ("partner_id", "card_type_id", "fee_type_id", "effective_from") WHERE "deleted_at" IS NULL`,
    // BOT-3 (audit 21/8) — 1 room chỉ 1 khách active (defense-in-depth chống rò scope tài chính cross-đại-lý). PARITY
    // với migration 20260821120000_customer_chat_group_room_active_unique (self-heal phải khớp migrate — audit F LOW).
    `CREATE UNIQUE INDEX IF NOT EXISTS "customer_chat_groups_room_id_active_unique" ON "customer_chat_groups" ("room_id") WHERE "unassigned_at" IS NULL AND "room_id" IS NOT NULL`,
    // Bill giải trình (Admin Demo 16/7): bảng MỚI (products + bill_explains). Client .exe KHÔNG có migrate engine
    // (Prisma 7) → self-heal CREATE TABLE IF NOT EXISTS mỗi boot (server migrate qua CLI; fresh DB đã có → no-op).
    // updated_at có DEFAULT CURRENT_TIMESTAMP (phòng raw-insert); Prisma vẫn set @updatedAt mỗi write.
    `CREATE TABLE IF NOT EXISTS "products" (
      "id" SERIAL NOT NULL,
      "industry_id" INTEGER NOT NULL,
      "name" TEXT NOT NULL,
      "unit" TEXT NOT NULL,
      "price" INTEGER NOT NULL,
      "priority" INTEGER NOT NULL DEFAULT 0,
      "status" TEXT NOT NULL DEFAULT 'ACTIVE',
      "created_by" INTEGER,
      "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_by" INTEGER,
      "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "deleted_at" TIMESTAMPTZ(3),
      "deleted_by" INTEGER,
      CONSTRAINT "products_pkey" PRIMARY KEY ("id")
    )`,
    // Bill giải trình (Admin Demo 16/7): cột priority ADDITIVE cho DB đã có bảng products từ 0.2.5x cũ (self-heal).
    `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS "products_industry_id_idx" ON "products" ("industry_id")`,
    `CREATE TABLE IF NOT EXISTS "bill_explains" (
      "id" SERIAL NOT NULL,
      "code" TEXT,
      "dossier_id" INTEGER NOT NULL,
      "tid_id" INTEGER,
      "industry_id" INTEGER NOT NULL,
      "bill_date" TIMESTAMPTZ(3) NOT NULL,
      "total_amount" BIGINT NOT NULL,
      "bill_count" INTEGER NOT NULL,
      "file_path" TEXT NOT NULL,
      "created_by" INTEGER,
      "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "deleted_at" TIMESTAMPTZ(3),
      "deleted_by" INTEGER,
      CONSTRAINT "bill_explains_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "bill_explains_code_key" ON "bill_explains" ("code")`,
    `CREATE INDEX IF NOT EXISTS "bill_explains_dossier_id_idx" ON "bill_explains" ("dossier_id")`,
    // Trường "của ai" nhập tay trên phiếu thu/chi (Admin Demo 20/7): đối tác lẻ ngoài danh sách (loại trừ partner_id).
    // Additive nullable — client .exe (Prisma 7 thiếu migrate engine) tự thêm cột mỗi boot, tránh "column does not exist".
    `ALTER TABLE "cash_entries" ADD COLUMN IF NOT EXISTS "partner_text" TEXT`,
    // Phase B UỶ qua tài khoản nhận tiền (Admin Demo 9/8) — MODEL 2-field: receive_accounts.investor_id (tái dùng
    // customer_id sẵn có; owyType SUY RA) + tids.invest_fee_milli. Additive nullable + index, idempotent.
    `ALTER TABLE "receive_accounts" ADD COLUMN IF NOT EXISTS "investor_id" INT`,
    `ALTER TABLE "tids" ADD COLUMN IF NOT EXISTS "receive_account_id" INT`,
    `ALTER TABLE "tids" ADD COLUMN IF NOT EXISTS "invest_fee_milli" INT`,
    `CREATE INDEX IF NOT EXISTS "tids_receive_account_id_idx" ON "tids" ("receive_account_id")`,
    // NHÀ ĐẦU TƯ Phase E — Nhóm chat riêng của NĐT (mirror customer_chat_groups nhưng theo investor_id, không khóa
    // loại phí). Client .exe không có migrate engine → self-heal CREATE TABLE IF NOT EXISTS mỗi boot (KHỚP migration
    // 20260811000000_investor_chat_group). + cột receive_accounts.investor_chat_group_id (gắn nhóm khi uỷ=NĐT).
    `CREATE TABLE IF NOT EXISTS "investor_chat_groups" (
      "id" SERIAL NOT NULL,
      "investor_id" INTEGER NOT NULL,
      "room_id" TEXT,
      "name" TEXT,
      "link" TEXT,
      "qr" TEXT,
      "note" TEXT,
      "assigned_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "unassigned_at" TIMESTAMPTZ(3),
      "created_by" INTEGER,
      "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMPTZ(3) NOT NULL,
      CONSTRAINT "investor_chat_groups_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE INDEX IF NOT EXISTS "investor_chat_groups_investor_id_idx" ON "investor_chat_groups" ("investor_id")`,
    `ALTER TABLE "receive_accounts" ADD COLUMN IF NOT EXISTS "investor_chat_group_id" INTEGER`,
    // NHÀ ĐẦU TƯ (Admin Demo 11/8) — PHÍ CÀI MÁY chốt trên từng GD (×1000). Tất toán NĐT lấy tiền về THEO phí cài máy
    // của TID (per-txn), không dùng %phí cấu hình ở tab NĐT. Additive default 0 (KHỚP migration 20260811100000_txn_phi_cai_may).
    `ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "phi_cai_may_milli" INT NOT NULL DEFAULT 0`,
    // TÀI KHOẢN CON của NĐT (Admin Demo 12/8) — users.investor_id (scalar → investors.id) + index. Client .exe không có
    // migrate engine → self-heal mỗi boot (KHỚP migration 20260812100000_user_investor_subuser). Chống db-evolution-gap.
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "investor_id" INTEGER`,
    `CREATE INDEX IF NOT EXISTS "users_investor_id_idx" ON "users" ("investor_id")`,
    // Quyền INVESTOR_SUBUSER_MANAGE (nhóm INVESTOR) + grant ADMIN/MANAGER — INSERT idempotent (ON CONFLICT DO
    // NOTHING) để role CŨ có ngay quyền (chống "quyền mới không vào DB dùng chung → menu ẩn"). ADMIN cũng được
    // superuser-sync ở seedIfEmpty; grant tường minh ở đây bảo đảm cả client-only boot (không chạy seed server) đủ.
    `INSERT INTO "permissions" ("code", "name", "group") VALUES ('INVESTOR_SUBUSER_MANAGE', 'Quản lý tài khoản xem của nhà đầu tư', 'INVESTOR') ON CONFLICT ("code") DO NOTHING`,
    `INSERT INTO "role_permissions" ("role_id", "permission_id") SELECT r."id", p."id" FROM "roles" r CROSS JOIN "permissions" p WHERE r."code" IN ('ADMIN', 'MANAGER') AND p."code" = 'INVESTOR_SUBUSER_MANAGE' ON CONFLICT ("role_id", "permission_id") DO NOTHING`,
    // [Admin Demo 4/9] QR bán hàng + giá cuối tuần — bảng phụ additive (raw, KHÔNG trong Prisma client, tránh regenerate
    // phá server). PARITY với packages/services/src/schema-ensure.ts (bot-api/quanly-api ensure lúc boot) — để selftest
    // + desktop boot cũng có. tids.kind phân biệt POS/QR; weekend_sell_adjust (POS giảm phí bán cuối tuần theo thẻ);
    // qr_partner_fee (giá QR gốc theo đối tác) + qr_fee_rates (giá QR theo từng mã, đè đối tác). Phí ×1000.
    `ALTER TABLE "tids" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'POS'`,
    `CREATE TABLE IF NOT EXISTS "weekend_sell_adjust" ("id" BIGSERIAL PRIMARY KEY, "card_type_id" INTEGER NOT NULL, "delta_milli" INTEGER NOT NULL, "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "created_by" INTEGER, "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "updated_by" INTEGER, "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMPTZ(3), "deleted_by" INTEGER)`,
    `CREATE INDEX IF NOT EXISTS "weekend_sell_adjust_card_type_id_idx" ON "weekend_sell_adjust" ("card_type_id")`,
    `CREATE TABLE IF NOT EXISTS "qr_partner_fee" ("id" BIGSERIAL PRIMARY KEY, "partner_id" INTEGER NOT NULL, "phi_mua_thuong" INTEGER NOT NULL, "phi_mua_cuoi_tuan" INTEGER NOT NULL, "phi_ban" INTEGER NOT NULL, "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "created_by" INTEGER, "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "updated_by" INTEGER, "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMPTZ(3), "deleted_by" INTEGER)`,
    `CREATE INDEX IF NOT EXISTS "qr_partner_fee_partner_id_idx" ON "qr_partner_fee" ("partner_id")`,
    `CREATE TABLE IF NOT EXISTS "qr_fee_rates" ("id" BIGSERIAL PRIMARY KEY, "tid_id" INTEGER NOT NULL, "phi_mua_thuong" INTEGER NOT NULL, "phi_mua_cuoi_tuan" INTEGER NOT NULL, "phi_ban" INTEGER NOT NULL, "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "created_by" INTEGER, "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "updated_by" INTEGER, "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMPTZ(3), "deleted_by" INTEGER)`,
    `CREATE INDEX IF NOT EXISTS "qr_fee_rates_tid_id_idx" ON "qr_fee_rates" ("tid_id")`,
    // DEDUP GỬI BILL QR (Đợt 2) — khoá theo `ref` (Số giao dịch unique). PARITY schema-ensure.ts. Chống doanh số x2.
    `CREATE TABLE IF NOT EXISTS "qr_bill_sent" ("id" BIGSERIAL PRIMARY KEY, "ref" TEXT NOT NULL, "image_hash" TEXT, "dealer_room_id" TEXT, "amount" BIGINT, "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now())`,
    // DEDUP KEY = (ref, amount) — MED phản biện. PARITY schema-ensure.ts. Drop constraint ref cũ + unique index mới (idempotent).
    `ALTER TABLE "qr_bill_sent" DROP CONSTRAINT IF EXISTS "qr_bill_sent_ref_uq"`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "qr_bill_sent_ref_amount_uq" ON "qr_bill_sent" ("ref", "amount")`,
    `CREATE INDEX IF NOT EXISTS "qr_bill_sent_image_hash_idx" ON "qr_bill_sent" ("image_hash")`,
    // Attribution đại lý cho GD QR (báo cáo tổng gộp) — TEXT (chat_rooms.id = cuid). PARITY schema-ensure.ts.
    `ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "qr_dealer_room_id" TEXT`,
    `CREATE INDEX IF NOT EXISTS "transactions_qr_dealer_room_id_idx" ON "transactions" ("qr_dealer_room_id")`,
    // Ghép đối soát báo-có + báo cáo QR (Admin Demo 5/9). PARITY schema-ensure.ts. qr_ref = Số giao dịch bill (ghép
    // external_ref_no báo-có); qr_payer_name = tên người quẹt (nhãn báo cáo). Cột RAW, additive/idempotent.
    `ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "qr_ref" TEXT`,
    `ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "qr_payer_name" TEXT`,
    `CREATE INDEX IF NOT EXISTS "transactions_qr_ref_idx" ON "transactions" ("qr_ref")`,
    // GIÁ BÁN QR THEO ĐẠI LÝ (lớp đè per-khách trên giá bán mặc định mã). PARITY schema-ensure.ts. Phí ×1000.
    `CREATE TABLE IF NOT EXISTS "qr_dealer_sell_fee" ("id" BIGSERIAL PRIMARY KEY, "customer_id" INTEGER NOT NULL, "phi_ban" INTEGER NOT NULL, "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "created_by" INTEGER, "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "updated_by" INTEGER, "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMPTZ(3), "deleted_by" INTEGER)`,
    `CREATE INDEX IF NOT EXISTS "qr_dealer_sell_fee_customer_id_idx" ON "qr_dealer_sell_fee" ("customer_id")`,
    // ĐỐI SOÁT "BÁO CÓ" DIGISTORE (Admin Demo 5/9) — cache raw giao dịch báo-có QR kéo từ portal BVBank. PARITY với
    // packages/services/src/schema-ensure.ts. bill_id (mã hóa đơn merchant UUID) UNIQUE để UPSERT khi poll lại.
    `CREATE TABLE IF NOT EXISTS "digistore_baoco" ("id" BIGSERIAL PRIMARY KEY, "bill_id" TEXT NOT NULL, "qr_code" TEXT, "hkd_name" TEXT, "amount" BIGINT, "payer_name" TEXT, "description" TEXT, "at_ms" BIGINT, "status" TEXT, "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "reconcile_status" TEXT, "matched_bill_key" TEXT)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "digistore_baoco_bill_id_uq" ON "digistore_baoco" ("bill_id")`,
    `CREATE INDEX IF NOT EXISTS "digistore_baoco_at_ms_idx" ON "digistore_baoco" ("at_ms")`,
    `CREATE INDEX IF NOT EXISTS "digistore_baoco_hkd_amount_idx" ON "digistore_baoco" ("hkd_name", "amount")`,
    // PER-MÃ + GHÉP EXACT (Admin Demo 5/9) — PARITY schema-ensure.ts. source_tid_id (mã QR nguồn) + external_ref_no
    // (Số giao dịch, ghép EXACT). Additive/idempotent.
    `ALTER TABLE "digistore_baoco" ADD COLUMN IF NOT EXISTS "source_tid_id" INTEGER`,
    `ALTER TABLE "digistore_baoco" ADD COLUMN IF NOT EXISTS "external_ref_no" TEXT`,
    `CREATE INDEX IF NOT EXISTS "digistore_baoco_source_tid_id_idx" ON "digistore_baoco" ("source_tid_id")`,
    `CREATE INDEX IF NOT EXISTS "digistore_baoco_external_ref_no_idx" ON "digistore_baoco" ("external_ref_no")`,
    // TÀI KHOẢN DIGISTORE PER-MÃ QR (Admin Demo 5/9) — PARITY schema-ensure.ts. base NULL = host mặc định chung;
    // username + password_enc (AES-256-GCM, khoá env DIGISTORE_ENC_KEY) BẮT BUỘC. tid_id UNIQUE (1 mã 1 tài khoản).
    `CREATE TABLE IF NOT EXISTS "qr_digistore_cred" ("id" BIGSERIAL PRIMARY KEY, "tid_id" INTEGER NOT NULL, "base" TEXT, "username" TEXT NOT NULL, "password_enc" TEXT NOT NULL, "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now())`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "qr_digistore_cred_tid_id_uq" ON "qr_digistore_cred" ("tid_id")`
  ];
  for (const s of stmts) {
    try {
      await db.$executeRawUnsafe(s);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[schema self-heal] bỏ qua:', s, e instanceof Error ? e.message : e);
    }
  }
}

export async function initDb(): Promise<Db> {
  const url = resolveDatabaseUrl();
  prisma = createPrisma(url);
  // Self-heal cột additive TRƯỚC mọi truy vấn (login đọc lock_reason ngay) — cả server lẫn client, non-fatal.
  await ensureCriticalSchema(prisma);
  // G10 model A: máy chủ seed FATAL (bắt buộc). Client cũng seed để ĐỒNG BỘ catalog quyền/role mới
  // khi auto-update (fix "quyền mới không vào DB dùng chung → menu bị ẩn"), nhưng bọc advisory lock
  // (serialize nhiều client) + NON-FATAL (lỗi seed không sập app client). Migrate KHÔNG chạy từ .exe
  // (Prisma 7 prisma-client thiếu migrate engine) — máy chủ migrate bằng prisma CLI.
  if (isServerRole()) {
    await seedIfEmpty(prisma);
  } else {
    // Client cũng ĐỒNG BỘ catalog quyền/role khi boot (seedIfEmpty idempotent+additive) để quyền
    // MỚI (thêm ở bản cập nhật) tự vào DB dùng chung → menu/tính năng không bị ẩn. Advisory lock cho
    // Postgres serialize nhiều client; lỗi seed client là NON-FATAL (không sập app).
    try {
      await prisma.$executeRaw`SELECT pg_advisory_lock(918273645)`;
      try { await seedIfEmpty(prisma); }
      finally { await prisma.$executeRaw`SELECT pg_advisory_unlock(918273645)`; }
    } catch (e) {
      console.error('[seed] client catalog sync bỏ qua (non-fatal):', e instanceof Error ? e.message : e);
    }
  }
  return prisma;
}

// ── G10.3 Cấu hình máy chủ (client first-run) ────────────────────────────────

/**
 * True nếu tiến trình này PHẢI dựa vào file server-config.json để biết máy chủ (→ có thể cần màn cấu hình).
 * Máy chủ (SIGMA_ROLE=server), selftest (SIGMA_DB_URL) và dev có DATABASE_URL đều KHÔNG dùng màn này.
 */
function isClientConfigMode(): boolean {
  if (isServerRole()) return false;
  if (process.env['SIGMA_DB_URL']) return false;
  if (!app.isPackaged && process.env['DATABASE_URL']) return false;
  return true;
}

/** Kiểm tra kết nối SỐNG bằng 1 truy vấn nhẹ. Trả false nếu chưa init hoặc mất kết nối. */
async function probeConnection(): Promise<boolean> {
  if (!prisma) return false;
  try {
    // 4/8 (Admin Demo "mở lên màn trắng xoay vòng") — `serverConfigGet` (IPC lúc renderer khởi động) gọi hàm này;
    // nếu `SELECT 1` TREO (client đã tạo nhưng nối DB qua cầu Cloudflare chậm/treo — connect_timeout chỉ chặn
    // bước CONNECT, không chặn QUERY treo) → IPC không trả → renderer kẹt màn loading (trắng + xoay). Bọc timeout
    // 8s: quá hạn coi như KHÔNG kết nối được → trả false → hiện màn "Cấu hình máy chủ" thay vì treo vô hạn.
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout 8s')), 8_000))
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Trạng thái CSDL cho renderer quyết định luồng khởi động:
 * - `ready`: đã kết nối được (SELECT 1 OK) → vào đăng nhập.
 * - `needsConfig`: client dựa server-config nhưng CHƯA kết nối được → hiện màn "Cấu hình máy chủ".
 * - `serverRole`: máy chủ KHÔNG bao giờ hiện màn cấu hình.
 */
export async function getDbStatus(): Promise<{ ready: boolean; needsConfig: boolean; serverRole: boolean; apiMode: boolean }> {
  const serverRole = isServerRole();
  // Chế độ API (4/8): dữ liệu qua HTTP, KHÔNG nối Postgres trực tiếp → KHÔNG probe, KHÔNG bao giờ cần màn
  // "Cấu hình máy chủ" (needsConfig=false) → renderer vào THẲNG đăng nhập. ready=true = "app sẵn sàng dùng".
  if (isApiMode()) {
    return { ready: true, needsConfig: false, serverRole, apiMode: true };
  }
  const ready = await probeConnection();
  const needsConfig = isClientConfigMode() && !ready;
  return { ready, needsConfig, serverRole, apiMode: false };
}

/** Cấu hình hiện tại (để đổ vào form). Thiếu → trả giá trị mặc định để form gợi ý sẵn. */
function currentServerConfig(): NormalizedServerConfig {
  const cfg = readServerConfig();
  if (cfg) return { host: cfg.host, port: cfg.port ?? DEFAULT_SERVER_PORT, database: cfg.database, user: cfg.user, password: cfg.password };
  return { host: '', port: DEFAULT_SERVER_PORT, database: DEFAULT_SERVER_DATABASE, user: DEFAULT_SERVER_USER, password: '' };
}

/** IPC `serverConfig:get` — trạng thái CSDL + cấu hình hiện có (đổ form). */
export async function getServerConfig(): Promise<{
  ready: boolean;
  needsConfig: boolean;
  serverRole: boolean;
  apiMode: boolean;
  configured: boolean;
  passwordSet: boolean;
  /** [10/9] Tên BẢN CÀI (instance) — vd "SigMa TN" cho bản clone; rỗng = bản SigMa chính. Renderer hiện lên Login
   *  để 2 bản trên cùng máy KHÔNG bị nhìn nhầm nhau. */
  instanceName: string;
  /** Thẻ dịch vụ Cloudflare Access: trả ID (không phải bí mật) + CỜ đã có secret hay chưa.
   *  TUYỆT ĐỐI không trả chính secret ra renderer — cùng nguyên tắc với mật khẩu DB. */
  cfAccessClientId: string;
  cfAccessSecretSet: boolean;
  config: Omit<NormalizedServerConfig, 'password'> & { password: ''; apiBaseUrl: string };
}> {
  const status = await getDbStatus();
  const cfg = currentServerConfig();
  const apiBaseUrl = readApiBaseUrl();
  // P1-02 (invariant #6): TUYỆT ĐỐI KHÔNG trả mật khẩu DB ra renderer. Chỉ báo passwordSet để form biết
  // "đã có mật khẩu — để trống nếu giữ nguyên". Mật khẩu ở lại main (server-config.json).
  // apiBaseUrl (không phải secret) trả về để đổ sẵn form khi sửa cấu hình.
  // configured = có cấu hình Postgres hợp lệ HOẶC đã cấu hình apiBaseUrl (chế độ API) — dùng để renderer biết
  // "đã từng cấu hình" (không hiện màn nhập lần đầu).
  return {
    ...status,
    configured: readServerConfig() != null || apiBaseUrl !== '',
    passwordSet: cfg.password !== '',
    instanceName: instanceName(),
    cfAccessClientId: readCfAccessToken()?.id ?? '',
    cfAccessSecretSet: (readCfAccessToken()?.secret ?? '') !== '',
    config: { ...cfg, password: '', apiBaseUrl }
  };
}

/** P1-02: bổ khuyết mật khẩu từ cấu hình đã lưu khi input để trống (sửa host/cổng không phải gõ lại mật khẩu).
 *  AUTH-04 (audit 15/7, Codex): CHỈ bổ khuyết khi ĐÍCH test/save TRÙNG máy chủ đã lưu (host+port+user+database).
 *  Nếu đích khác (host lạ do renderer bị chiếm/gọi trực tiếp) → KHÔNG gửi mật khẩu đã lưu, tránh rò credential
 *  DB ra máy chủ của kẻ tấn công qua serverConfig:test. Đổi máy chủ thật thì người dùng phải gõ lại mật khẩu. */
function fillPasswordFromStored(input: ServerConfigInput): ServerConfigInput {
  if ((input.password ?? '').trim() !== '') return input;
  const stored = readServerConfig();
  if (!stored?.password) return input;
  const sameTarget =
    (input.host ?? '').trim() === stored.host &&
    Number(input.port ?? 5432) === (stored.port ?? 5432) &&
    (input.user ?? '').trim() === stored.user &&
    (input.database ?? '').trim() === stored.database;
  if (!sameTarget) return input;
  return { ...input, password: stored.password };
}

/** Gói lỗi pg thành thông điệp tiếng Việt dễ hiểu (giữ nguyên chi tiết gốc phía sau). */
function friendlyPgError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const raw = e?.message ?? String(err);
  if (e?.code === 'ECONNREFUSED') return `Máy chủ từ chối kết nối (kiểm tra IP/cổng + PostgreSQL đang chạy). ${raw}`;
  if (e?.code === 'ETIMEDOUT' || /timeout/i.test(raw)) return `Hết thời gian chờ kết nối tới máy chủ (kiểm tra IP/mạng LAN/tường lửa). ${raw}`;
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') return `Không tìm thấy máy chủ theo địa chỉ đã nhập. ${raw}`;
  if (e?.code === '28P01' || e?.code === '28000') return `Sai tài khoản hoặc mật khẩu PostgreSQL. ${raw}`;
  if (e?.code === '3D000') return `Cơ sở dữ liệu không tồn tại trên máy chủ. ${raw}`;
  return raw;
}

/** IPC `serverConfig:test` — thử `new Client(...).connect()` (pg) với timeout, KHÔNG ghi file. */
export async function testServerConfig(input: ServerConfigInput): Promise<{ ok: boolean; error?: string }> {
  const v = validateServerConfig(fillPasswordFromStored(input));
  if (!v.valid || !v.config) return { ok: false, error: v.error ?? 'Cấu hình không hợp lệ.' };
  const c = v.config;
  const client = new Client({
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    password: c.password,
    connectionTimeoutMillis: 6000
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyPgError(err) };
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore cleanup error */
    }
  }
}

/** Đóng kết nối cũ + init lại theo cấu hình mới, rồi xác nhận kết nối sống. */
async function reinitDb(): Promise<{ ok: boolean; error?: string }> {
  try {
    if (prisma) {
      try {
        await prisma.$disconnect();
      } catch {
        /* ignore */
      }
      prisma = undefined;
    }
    await initDb();
    if (!(await probeConnection())) {
      return { ok: false, error: 'Đã lưu cấu hình nhưng không kết nối được tới máy chủ. Kiểm tra lại thông tin.' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyPgError(err) };
  }
}

/** IPC `serverConfig:save` — validate → ghi server-config.json → init lại kết nối. */
export async function saveServerConfig(input: ServerConfigInput): Promise<{ ok: boolean; error?: string }> {
  // apiBaseUrl (kiến trúc HTTP 4/8): KHÔNG đi qua validateServerConfig (chỉ chuẩn hóa cấu hình Postgres).
  // Đọc + chuẩn hóa RIÊNG; validate cơ bản phải bắt đầu http:// hoặc https:// (khớp validate ở renderer).
  const rawApiBase = (input as ServerConfigInput & { apiBaseUrl?: unknown }).apiBaseUrl;
  const apiBaseUrl = typeof rawApiBase === 'string' ? rawApiBase.trim().replace(/\/+$/, '') : '';
  if (apiBaseUrl && !/^https?:\/\//i.test(apiBaseUrl)) {
    return { ok: false, error: 'Địa chỉ máy chủ (API) phải bắt đầu bằng http:// hoặc https://' };
  }
  // NỚI (4/8): có apiBaseUrl → chế độ API, host/mật khẩu Postgres KHÔNG bắt buộc (validateServerConfig tự nới
  // khi input.apiBaseUrl khớp http(s)). KHÔNG có apiBaseUrl → giữ ràng buộc Postgres như cũ.
  const v = validateServerConfig({ ...fillPasswordFromStored(input), apiBaseUrl: apiBaseUrl || undefined });
  if (!v.valid || !v.config) return { ok: false, error: v.error ?? 'Cấu hình không hợp lệ.' };
  try {
    // SEC-01 (audit 15/7, Codex): KHÔNG ghi mật khẩu DB dạng thô — mã hóa bằng safeStorage (Windows DPAPI).
    // Nếu OS không hỗ trợ mã hóa (hiếm) thì đành ghi thô để app vẫn chạy được.
    const c = v.config;
    const toWrite: Record<string, unknown> = { host: c.host, port: c.port, database: c.database, user: c.user };
    if (apiBaseUrl) toWrite.apiBaseUrl = apiBaseUrl;
    // ── THẺ CLOUDFLARE ACCESS ────────────────────────────────────────────────────────────────────
    // LỖI CŨ: hàm này dựng object MỚI rồi ghi đè, nên mọi trường ngoài danh sách bị XOÁ — ai bấm Lưu ở
    // màn cấu hình là mất thẻ Access, rồi máy đó rớt khi cổng bật gác mà không ai hiểu vì sao.
    // Nay: đọc file cũ, giữ nguyên thẻ nếu lần lưu này KHÔNG nhập thẻ mới.
    {
      let cuJson: Record<string, unknown> = {};
      try {
        if (existsSync(serverConfigPath())) cuJson = JSON.parse(readFileSync(serverConfigPath(), 'utf8')) as Record<string, unknown>;
      } catch { /* file hỏng → coi như chưa có */ }
      const vao = input as ServerConfigInput & { cfAccessClientId?: unknown; cfAccessClientSecret?: unknown };
      const idMoi = typeof vao.cfAccessClientId === 'string' ? vao.cfAccessClientId.trim() : undefined;
      const secretMoi = typeof vao.cfAccessClientSecret === 'string' ? vao.cfAccessClientSecret.trim() : undefined;
      // id: '' nghĩa là NGƯỜI DÙNG CỐ Ý GỠ thẻ; undefined nghĩa là màn hình không đụng tới.
      const idCuoi = idMoi !== undefined ? idMoi : (typeof cuJson.cfAccessClientId === 'string' ? cuJson.cfAccessClientId : '');
      if (idCuoi) toWrite.cfAccessClientId = idCuoi;
      if (secretMoi) {
        if (safeStorage.isEncryptionAvailable()) toWrite.cfAccessClientSecret_enc = safeStorage.encryptString(secretMoi).toString('base64');
        else toWrite.cfAccessClientSecret = secretMoi;
      } else if (idCuoi && idMoi === undefined) {
        // không nhập secret mới mà vẫn giữ thẻ → bê nguyên giá trị cũ sang
        if (typeof cuJson.cfAccessClientSecret_enc === 'string') toWrite.cfAccessClientSecret_enc = cuJson.cfAccessClientSecret_enc;
        if (typeof cuJson.cfAccessClientSecret === 'string') toWrite.cfAccessClientSecret = cuJson.cfAccessClientSecret;
      } else if (idCuoi && idMoi !== undefined && !secretMoi) {
        // sửa id mà để trống secret → giữ secret cũ (khỏi bắt gõ lại chuỗi dài)
        if (typeof cuJson.cfAccessClientSecret_enc === 'string') toWrite.cfAccessClientSecret_enc = cuJson.cfAccessClientSecret_enc;
        if (typeof cuJson.cfAccessClientSecret === 'string') toWrite.cfAccessClientSecret = cuJson.cfAccessClientSecret;
      }
    }
    if (c.password && safeStorage.isEncryptionAvailable()) {
      toWrite.password = '';
      toWrite.password_enc = safeStorage.encryptString(c.password).toString('base64');
    } else {
      toWrite.password = c.password;
    }
    // 4/8 — thư mục cấu hình riêng %APPDATA%\AlphaQuanLy có thể CHƯA tồn tại (khác userData mặc định Electron
    // luôn tạo sẵn) → tạo trước khi ghi, tránh writeFileSync ENOENT.
    mkdirSync(dirname(serverConfigPath()), { recursive: true });
    writeFileSync(serverConfigPath(), JSON.stringify(toWrite, null, 2), 'utf8');
  } catch (err) {
    return { ok: false, error: 'Không ghi được file cấu hình máy chủ: ' + (err as Error).message };
  }
  // Chế độ API: dữ liệu đi qua REST, KHÔNG nối Postgres trực tiếp → KHÔNG reinit Prisma (reinit sẽ ném lỗi
  // "CHƯA cấu hình máy chủ PostgreSQL" khi host trống). Đã ghi apiBaseUrl xong → chỉ cần khởi động lại app để
  // đổi sang chế độ boot API (index.ts đọc readApiBaseUrl lúc whenReady). Báo ok để renderer chuyển màn đăng nhập.
  if (apiBaseUrl) return { ok: true };
  return reinitDb();
}
