// Cấu hình ngành nghề — LÕI THUẦN ctx-based. PORT nghiệp vụ từ apps/desktop/src/main/industry-service.ts
// (IMS_SPEC §11 Pha I1 — master data ONLY). Thay `requirePermission(current-user global)` bằng ctx = { db, user }
// do adapter dựng; mỗi hàm tự kiểm quyền qua hasPermission(ctx.user, CONFIG_INDUSTRY_*). GIỮ NGUYÊN business:
// mã NGH## auto-minted atomic ($transaction), chống trùng tên (active vs trash), audit before/after (kể cả nhánh
// từ chối), soft-delete. XÁC NHẬN MẬT KHẨU (§14) do ADAPTER làm TRƯỚC khi gọi lõi (khớp khuôn customer.ts) —
// lõi KHÔNG kiểm password, giả định caller đã xác thực (để giữ bộ đếm khóa brute-force ở adapter). R_UX_WARN.
import { auditSnapshot } from '@sigma/business-rules';
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { nextCode } from './code.js';
import { staleGuard } from './optimistic-lock.js';
import { dateRange, type ServiceCtx, type MutationResult } from './customer.js';
// TÌM KIẾM hoa/thường: DB collation "C" → Prisma mode:'insensitive' (ILIKE) KHÔNG gập chữ tiếng Việt có dấu
// (đo thật trên sổ thật: ILIKE '%nguyễn%' = 0 dòng / ILIKE '%NGUYỄN%' = 10 dòng). Xem tim-kiem-hoa-thuong.ts.
import { dieuKienTimKiem } from './tim-kiem-hoa-thuong.js';

/** Prefix mã ngành nghề (CodeCounter). Hợp CODE_PREFIX_REGEX /^[A-Z]{2,4}$/ (3 chữ). */
const INDUSTRY_CODE_PREFIX = 'NGH';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';
// FIX-PERF — hard-cap chống kéo full-bảng (bảng cấu hình UI cần toàn bộ; không phân trang, chỉ chặn bộ nhớ).
const INDUSTRY_LIST_MAX = 500;

// MutationResult tái dùng shape từ customer.js (CÙNG { ok, error?, message?, id? }) — 1 nguồn để không đụng
// TS2308 khi index.ts `export *` (nhiều module cùng export tên MutationResult sẽ mơ hồ).

/** Yếu tố truy vết chung (ai tạo/sửa gần nhất) — đồng bộ khuôn bank-config-service. */
export interface AuditTrail {
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
  updatedBy: number | null;
  updatedByName: string | null;
  updatedAt: string;
}

export interface IndustryDto extends AuditTrail {
  id: number;
  code: string;
  name: string;
  active: boolean;
  note: string | null;
}

export interface IndustryFilter {
  search?: string;
  /** Lọc theo trạng thái sử dụng (đang dùng / ngừng dùng). Bỏ trống = tất cả. */
  active?: boolean;
  fromDate?: string;
  toDate?: string;
}

export interface CreateIndustryInput {
  name: string;
  active?: boolean;
  note?: string | null;
}

export interface UpdateIndustryInput {
  name?: string;
  active?: boolean;
  note?: string | null;
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock — mốc updatedAt client giữ lúc mở form
}

// P2002 (mã trùng ở DB) — mã tự sinh nên gần như không xảy ra, nhưng vẫn map an toàn (bài học B05).
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

function trail(
  row: { createdBy: number | null; createdAt: Date; updatedBy: number | null; updatedAt: Date },
  names: Map<number, string>
): AuditTrail {
  return {
    createdBy: row.createdBy,
    createdByName: row.createdBy != null ? names.get(row.createdBy) ?? null : null,
    createdAt: row.createdAt.toISOString(),
    updatedBy: row.updatedBy,
    updatedByName: row.updatedBy != null ? names.get(row.updatedBy) ?? null : null,
    updatedAt: row.updatedAt.toISOString()
  };
}

/** So khớp tên (không phân biệt hoa/thường + khoảng trắng) để chống trùng ngành ở tầng service. */
function normName(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** CONFIG_INDUSTRY_VIEW — liệt kê ngành nghề (loại đã xóa mềm), có tìm + lọc trạng thái + ngày. */
export async function listIndustries(
  ctx: ServiceCtx,
  filter: IndustryFilter = {}
): Promise<{ ok: boolean; data?: IndustryDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'CONFIG_INDUSTRY_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.industry.findMany({
    where: {
      deletedAt: null,
      active: filter.active === undefined ? undefined : filter.active,
      createdAt: dateRange(filter.fromDate, filter.toDate),
      // Tìm kiếm mã/tên ngành — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts).
      AND: await dieuKienTimKiem(db, 'industries', { code: 'code', name: 'name' }, filter.search)
    },
    orderBy: { id: 'asc' },
    take: INDUSTRY_LIST_MAX
  });
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.createdBy, r.updatedBy]));
  return {
    ok: true,
    data: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, active: r.active, note: r.note, ...trail(r, names) }))
  };
}

/** CONFIG_INDUSTRY_CREATE — mã NGH## auto (atomic $transaction) + chống trùng tên + audit. */
export async function createIndustry(ctx: ServiceCtx, input: CreateIndustryInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'CONFIG_INDUSTRY_CREATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const name = input.name?.trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên ngành nghề bắt buộc.' };

  // Chống trùng tên (tên KHÔNG @unique DB — dedup ở service, phân biệt active vs trash).
  const dup = (await db.industry.findMany({ select: { id: true, name: true, deletedAt: true } })).find((r) => normName(r.name) === normName(name));
  if (dup) {
    return dup.deletedAt
      ? { ok: false, error: 'DUPLICATE_TRASH', message: `Ngành "${name}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn tên khác.` }
      : { ok: false, error: 'DUPLICATE', message: `Ngành "${name}" đã tồn tại.` };
  }

  let created;
  try {
    created = await db.$transaction(async (tx) => {
      const code = await nextCode(tx, INDUSTRY_CODE_PREFIX);
      return tx.industry.create({
        data: { code, name, active: input.active ?? true, note: input.note?.trim() || null, createdBy: user.id }
      });
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: 'Mã ngành bị trùng, vui lòng thử lại.' };
    throw e;
  }
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'INDUSTRY_CREATED',
    targetType: 'Industry',
    targetId: String(created.id),
    after: auditSnapshot({ code: created.code, name: created.name, active: created.active, note: created.note })
  });
  return { ok: true, id: created.id };
}

/** CONFIG_INDUSTRY_UPDATE — mã bất biến; đổi tên/trạng thái/ghi chú; chống trùng tên; audit before/after. */
export async function updateIndustry(ctx: ServiceCtx, id: number, input: UpdateIndustryInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'CONFIG_INDUSTRY_UPDATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const row = await db.industry.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Ngành nghề không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;

  const name = input.name !== undefined ? input.name.trim().replace(/\s+/g, ' ') : row.name;
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên ngành nghề không được để trống.' };
  if (normName(name) !== normName(row.name)) {
    const dup = (await db.industry.findMany({ where: { NOT: { id } }, select: { id: true, name: true, deletedAt: true } })).find((r) => normName(r.name) === normName(name));
    if (dup) {
      return dup.deletedAt
        ? { ok: false, error: 'DUPLICATE_TRASH', message: `Ngành "${name}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn tên khác.` }
        : { ok: false, error: 'DUPLICATE', message: `Ngành "${name}" đã tồn tại.` };
    }
  }

  const before = auditSnapshot({ code: row.code, name: row.name, active: row.active, note: row.note });
  const updated = await db.industry.update({
    where: { id },
    data: {
      name,
      active: input.active !== undefined ? input.active : row.active,
      note: input.note !== undefined ? input.note?.trim() || null : row.note,
      updatedBy: user.id
    }
  });
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'INDUSTRY_UPDATED',
    targetType: 'Industry',
    targetId: String(id),
    before,
    after: auditSnapshot({ code: updated.code, name: updated.name, active: updated.active, note: updated.note })
  });
  return { ok: true, id };
}

/** CONFIG_INDUSTRY_DELETE — xóa mềm 1..n ngành. Xác nhận MẬT KHẨU (§14) do ADAPTER kiểm TRƯỚC khi gọi (lõi
 *  giả định caller đã xác thực). Từ chối cũng ghi audit. */
export async function deleteIndustries(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, 'CONFIG_INDUSTRY_DELETE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn ngành nghề để xóa.' };

  let deleted = 0;
  for (const id of ids) {
    const row = await db.industry.findUnique({ where: { id } });
    if (!row || row.deletedAt) continue;
    await db.industry.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.id, deletedBy: user.id } });
    await writeAudit(db, {
      actorUserId: user.id,
      action: 'INDUSTRY_DELETED',
      targetType: 'Industry',
      targetId: String(id),
      before: auditSnapshot({ code: row.code, name: row.name })
    });
    deleted++;
  }
  return { ok: true, deleted };
}
