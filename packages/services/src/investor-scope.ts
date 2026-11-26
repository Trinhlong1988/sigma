// NHÀ ĐẦU TƯ — DATA-SCOPE (Phase D, Admin Demo 11/8). Helper giải quyết "NĐT của CHÍNH user đang đăng nhập" để ép
// phạm vi báo cáo/tất toán về đúng NĐT gắn với tài khoản (Investor.userId = ctx.user.id). Dùng cho user có quyền
// INVESTOR_SELF_VIEW (role R_INVESTOR) — CHỈ được xem dữ liệu của mình, KHÔNG xem NĐT khác.
//
// LÕI THUẦN ctx-based, CHỈ ĐỌC (1 query, KHÔNG N+1). Trả về:
//   • investorId (number) nếu tìm thấy đúng 1 NĐT còn sống gắn userId,
//   • null nếu user chưa gắn NĐT nào (caller trả rỗng data:[], KHÔNG lỗi — user hợp lệ nhưng chưa có dữ liệu).
import type { ServiceCtx } from './customer.js';

/**
 * investorId của NĐT mà user đang đăng nhập ĐƯỢC PHÉP xem (deletedAt null); null nếu không có. Ép scope tự-xem.
 * HAI nhánh (Admin Demo 12/8 — tài khoản CON):
 *  1) CHỦ NĐT: Investor.userId = user đang đăng nhập (tài khoản chính gắn hồ sơ NĐT).
 *  2) TÀI KHOẢN CON: users.investor_id trỏ tới 1 NĐT còn sống (user role R_INVESTOR do NĐT tạo để chia sẻ xem).
 * Con CHỈ thấy NĐT cha của mình, KHÔNG thấy NĐT khác. Nếu NĐT (cha) đã xóa mềm → trả null (không lộ dữ liệu chết).
 */
export async function resolveOwnInvestorId(ctx: ServiceCtx): Promise<number | null> {
  const userId = ctx.user?.id;
  if (userId == null) return null;
  // (1) Chủ NĐT — hồ sơ Investor gắn thẳng userId này.
  const owner = await ctx.db.investor.findFirst({
    where: { userId, deletedAt: null },
    select: { id: true },
    orderBy: { id: 'asc' } // ổn định nếu (bất thường) nhiều NĐT gắn cùng userId — luôn lấy id nhỏ nhất
  });
  if (owner) return owner.id;
  // (2) Tài khoản CON — users.investor_id trỏ NĐT cha; chỉ trả khi NĐT cha còn sống.
  const sub = await ctx.db.user.findUnique({ where: { id: userId }, select: { investorId: true } });
  if (sub?.investorId == null) return null;
  const parent = await ctx.db.investor.findFirst({ where: { id: sub.investorId, deletedAt: null }, select: { id: true } });
  return parent?.id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// KẾ TOÁN NĐT (Admin Demo 24/11) — DATA-SCOPE CỨNG theo cột users.scope_investor_id.
//
// KHÁC resolveOwnInvestorId (R_INVESTOR tự-xem): đây là phạm vi của một NHÂN VIÊN kế toán bị KHÓA đúng 1 NĐT.
// ĐỘC LẬP với permission: dù user có REVENUE_VIEW (xem-tất) thì scope vẫn ÉP về đúng NĐT này — mọi route tiền
// (bill list/create, báo cáo, Excel, danh mục TID/POS/TK-nhận) phải gọi helper này để LỌC, KHÔNG tin tham số client.
//
// Cột `scope_investor_id` là RAW (schema-ensure, NGOÀI Prisma client — tránh prisma generate phá server) ⇒ đọc
// bằng $queryRawUnsafe. CHỈ ĐỌC. Trả null nếu: user không khóa phạm vi, hoặc NĐT gán đã xóa mềm (fail-closed:
// không khóa phạm vi về một NĐT chết — caller sẽ coi như staff bình thường; nhưng với vai R_KETOAN_NDT, LEAD phải
// bảo đảm NĐT còn sống khi gán).
// ─────────────────────────────────────────────────────────────────────────────

/** investorId mà user đang đăng nhập bị KHÓA PHẠM VI (users.scope_investor_id, NĐT còn sống); null nếu không khóa. */
export async function resolveScopeInvestorId(ctx: ServiceCtx): Promise<number | null> {
  const userId = ctx.user?.id;
  if (userId == null) return null;
  const rows = await ctx.db.$queryRawUnsafe<Array<{ scope_investor_id: number | null }>>(
    'SELECT scope_investor_id FROM users WHERE id = $1',
    userId
  );
  const scopeId = rows[0]?.scope_investor_id ?? null;
  if (scopeId == null) return null;
  // NĐT phải còn sống — không khóa phạm vi về NĐT đã xóa (fail-closed, không lộ dữ liệu chết).
  const alive = await ctx.db.investor.findFirst({ where: { id: Number(scopeId), deletedAt: null }, select: { id: true } });
  return alive?.id ?? null;
}

/** Tập id TK nhận tiền (receive_accounts) uỷ cho NĐT scope (deletedAt null). Dùng lọc danh mục TID/TK-nhận. */
export async function scopeReceiveAccountIds(ctx: ServiceCtx, investorId: number): Promise<Set<number>> {
  const ras = await ctx.db.receiveAccount.findMany({ where: { investorId, deletedAt: null }, select: { id: true } });
  return new Set(ras.map((r) => r.id));
}

/** Tập id TID thuộc NĐT scope (qua tids.receiveAccountId → receive_accounts.investorId). KHÔNG lọc tid.deletedAt
 *  (khớp investor-report: TID xóa mềm vẫn gắn doanh thu quá khứ; nhưng danh mục hiện hành caller tự lọc nếu cần). */
export async function scopeTidIds(ctx: ServiceCtx, investorId: number): Promise<Set<number>> {
  const raIds = await scopeReceiveAccountIds(ctx, investorId);
  if (raIds.size === 0) return new Set();
  const tids = await ctx.db.tid.findMany({ where: { receiveAccountId: { in: [...raIds] } }, select: { id: true } });
  return new Set(tids.map((t) => t.id));
}

/** Tập CHUỖI TID (tids.tid) thuộc NĐT scope — dùng lọc danh mục POS theo currentTid. */
export async function scopeTidStrings(ctx: ServiceCtx, investorId: number): Promise<Set<string>> {
  const raIds = await scopeReceiveAccountIds(ctx, investorId);
  if (raIds.size === 0) return new Set();
  const tids = await ctx.db.tid.findMany({ where: { receiveAccountId: { in: [...raIds] } }, select: { tid: true } });
  return new Set(tids.map((t) => t.tid));
}
