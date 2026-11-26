// LOẠI GIAO MÁY — LÕI THUẦN ctx-based. PORT nghiệp vụ từ apps/desktop/src/main/handover-service.ts (danh mục hình
// thức GIAO máy/TID). `moneyKind`: SALE (bán đứt) | RENT (cho thuê) | DEPOSIT (cọc) | NONE (mượn). Builtin (4 loại
// seed): cấm xóa + KHÓA moneyKind (chỉ đổi name/sortOrder). Permission-guarded (CONFIG_HANDOVER_VIEW/MANAGE),
// audited, R_UX_WARN tiếng Việt. CHỈ port các hàm IPC — resolveHandoverInput/buildHandoverContext là helper nhận db,
// GIỮ NGUYÊN bên desktop, KHÔNG migrate. XÁC NHẬN MẬT KHẨU (§14) do ADAPTER kiểm TRƯỚC khi gọi lõi (khớp customer.ts).
// MutationResult/ServiceCtx từ customer.js, AuditTrail từ industry.js.
import { auditSnapshot } from '@sigma/business-rules';
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { staleGuard } from './optimistic-lock.js';
import { type ServiceCtx, type MutationResult } from './customer.js';
import type { AuditTrail } from './industry.js';

const VIEW = 'CONFIG_HANDOVER_VIEW';
const MANAGE = 'CONFIG_HANDOVER_MANAGE';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

/** moneyKind hợp lệ — quyết định mô hình tiền của loại giao. */
export const MONEY_KINDS = new Set(['SALE', 'RENT', 'DEPOSIT', 'NONE', 'COUNTERPART']);

export interface HandoverTypeDto extends AuditTrail {
  id: number;
  name: string;
  moneyKind: string;
  hasDeposit: boolean; // Admin Demo 9/8 — cho phép nhập cọc lúc giao (0=không), độc lập moneyKind
  isBuiltin: boolean;
  sortOrder: number;
}
export interface CreateHandoverTypeInput {
  name: string;
  moneyKind: string;
  hasDeposit?: boolean;
  sortOrder?: number;
}
export interface UpdateHandoverTypeInput {
  name?: string;
  moneyKind?: string; // Admin Demo 9/8 — MỞ khoá sửa cả builtin
  hasDeposit?: boolean;
  sortOrder?: number;
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock
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
function toDto(r: { id: number; name: string; moneyKind: string; hasDeposit: boolean; isBuiltin: boolean; sortOrder: number; createdBy: number | null; createdAt: Date; updatedBy: number | null; updatedAt: Date }, names: Map<number, string>): HandoverTypeDto {
  return { id: r.id, name: r.name, moneyKind: r.moneyKind, hasDeposit: r.hasDeposit, isBuiltin: r.isBuiltin, sortOrder: r.sortOrder, ...trail(r, names) };
}

/** CONFIG_HANDOVER_VIEW — danh sách loại giao (chưa xóa), theo sortOrder rồi id. */
export async function listHandoverTypes(ctx: ServiceCtx): Promise<{ ok: boolean; data?: HandoverTypeDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.handoverType.findMany({ where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.createdBy, r.updatedBy]));
  return { ok: true, data: rows.map((r) => toDto(r, names)) };
}

/** Danh sách loại giao GỌN cho picker "Giao máy / Giao TID" — chấp nhận CONFIG_HANDOVER_VIEW HOẶC
 *  POS_VIEW HOẶC TID_VIEW (người giao máy/TID phải chọn được loại giao dù không quản danh mục). */
export async function listHandoverTypesLite(ctx: ServiceCtx): Promise<{ ok: boolean; data?: { id: number; name: string; moneyKind: string; hasDeposit: boolean; sortOrder: number }[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW) && !hasPermission(ctx.user, 'POS_VIEW') && !hasPermission(ctx.user, 'TID_VIEW')) {
    return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  }
  const rows = await ctx.db.handoverType.findMany({ where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, name: true, moneyKind: true, hasDeposit: true, sortOrder: true } });
  return { ok: true, data: rows };
}

/** CONFIG_HANDOVER_MANAGE — tạo loại giao mới (KHÔNG builtin) + chống trùng tên + audit. */
export async function createHandoverType(ctx: ServiceCtx, input: CreateHandoverTypeInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const name = input.name?.trim();
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên loại giao bắt buộc.' };
  const moneyKind = (input.moneyKind ?? '').trim().toUpperCase();
  if (!MONEY_KINDS.has(moneyKind)) return { ok: false, error: 'VALIDATION', message: 'Mô hình tiền phải là Bán / Cho thuê / Mượn / Cọc / Đối ứng.' };
  const sortOrder = Number.isInteger(input.sortOrder) ? (input.sortOrder as number) : 0;
  const hasDeposit = input.hasDeposit === true;
  const dup = await db.handoverType.findFirst({ where: { name } });
  if (dup) {
    return dup.deletedAt
      ? { ok: false, error: 'DUPLICATE_TRASH', message: `Loại giao "${name}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn tên khác.` }
      : { ok: false, error: 'DUPLICATE', message: `Loại giao "${name}" đã tồn tại.` };
  }
  let created;
  try {
    created = await db.handoverType.create({ data: { name, moneyKind, hasDeposit, isBuiltin: false, sortOrder, createdBy: user.id } });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `Loại giao "${name}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'HANDOVER_TYPE_CREATED', targetType: 'HandoverType', targetId: String(created.id), after: auditSnapshot({ name, moneyKind, sortOrder }) });
  return { ok: true, id: created.id };
}

/** CONFIG_HANDOVER_MANAGE — sửa loại giao. Builtin: chỉ đổi name/sortOrder (KHÓA moneyKind). Audit before/after. */
export async function updateHandoverType(ctx: ServiceCtx, id: number, input: UpdateHandoverTypeInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const row = await db.handoverType.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại giao không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;

  const name = input.name !== undefined ? input.name.trim() : row.name;
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên loại giao không được để trống.' };

  let moneyKind = row.moneyKind;
  if (input.moneyKind !== undefined) {
    const next = input.moneyKind.trim().toUpperCase();
    // Admin Demo 9/8 — MỞ khoá sửa mô hình tiền cho cả builtin. Bỏ chặn BUILTIN_LOCKED.
    if (!MONEY_KINDS.has(next)) return { ok: false, error: 'VALIDATION', message: 'Mô hình tiền phải là Bán / Cho thuê / Mượn / Cọc / Đối ứng.' };
    moneyKind = next;
  }
  const hasDeposit = input.hasDeposit !== undefined ? input.hasDeposit === true : row.hasDeposit;
  const sortOrder = Number.isInteger(input.sortOrder) ? (input.sortOrder as number) : row.sortOrder;

  if (name !== row.name) {
    const dup = await db.handoverType.findFirst({ where: { name, NOT: { id } } });
    if (dup) {
      return dup.deletedAt
        ? { ok: false, error: 'DUPLICATE_TRASH', message: `Loại giao "${name}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn tên khác.` }
        : { ok: false, error: 'DUPLICATE', message: `Loại giao "${name}" đã tồn tại.` };
    }
  }
  const before = auditSnapshot({ name: row.name, moneyKind: row.moneyKind, sortOrder: row.sortOrder });
  let updated;
  try {
    updated = await db.handoverType.update({ where: { id }, data: { name, moneyKind, hasDeposit, sortOrder, updatedBy: user.id } });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `Loại giao "${name}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'HANDOVER_TYPE_UPDATED', targetType: 'HandoverType', targetId: String(id), before, after: auditSnapshot({ name: updated.name, moneyKind: updated.moneyKind, sortOrder: updated.sortOrder }) });
  return { ok: true, id };
}

/** CONFIG_HANDOVER_MANAGE — xóa mềm 1..n loại giao. Builtin KHÔNG xóa (BUILTIN_LOCKED). Xác nhận MẬT KHẨU (§14)
 *  do ADAPTER kiểm TRƯỚC khi gọi lõi (khớp customer.ts). */
export async function deleteHandoverTypes(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn loại giao để xóa.' };
  // ATOMIC (audit 20/8) — TOÀN BỘ vòng xóa hàng loạt trong 1 $transaction: lỗi giữa chừng → ROLLBACK cả mẻ (không
  // còn cảnh vài loại đã xóa+commit, phần còn lại chưa, rồi ném 500). Audit dùng tx → dấu vết cùng số phận mutation.
  let deleted = 0;
  let builtinBlocked = 0;
  await db.$transaction(async (tx) => {
    for (const id of ids) {
      const row = await tx.handoverType.findUnique({ where: { id } });
      if (!row || row.deletedAt) continue;
      if (row.isBuiltin) { builtinBlocked++; continue; }
      await tx.handoverType.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.id, deletedBy: user.id } });
      await writeAudit(tx, { actorUserId: user.id, action: 'HANDOVER_TYPE_DELETED', targetType: 'HandoverType', targetId: String(id), before: auditSnapshot({ name: row.name, moneyKind: row.moneyKind }) });
      deleted++;
    }
  });
  if (deleted === 0 && builtinBlocked > 0) {
    return { ok: false, error: 'BUILTIN_LOCKED', message: 'Loại giao mặc định (Bán/Cho thuê/Mượn/Cọc) không thể xóa.' };
  }
  return { ok: true, deleted };
}
