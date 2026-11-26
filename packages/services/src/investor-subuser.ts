// TÀI KHOẢN CON của Nhà đầu tư (Admin Demo 12/8) — LÕI THUẦN ctx-based. "Tài khoản xem" = user role R_INVESTOR gắn
// `investorId` của 1 NĐT, để NĐT CHIA SẺ quyền xem báo cáo CỦA MÌNH cho người khác (kế toán riêng, người nhà…).
// resolveOwnInvestorId (investor-scope.ts) đọc users.investor_id → ép data-scope con về đúng NĐT cha.
//
// GATE `canManageSubUsers(ctx, investorId)` = AI được quản tài khoản con của NĐT đó:
//   (1) NHÂN SỰ có quyền INVESTOR_SUBUSER_MANAGE (ADMIN/MANAGER) — quản cho MỌI NĐT; HOẶC
//   (2) CHÍNH CHỦ NĐT: Investor.userId = ctx.user.id — chỉ quản tài khoản con của NĐT MÌNH.
// Tài khoản con (R_INVESTOR + investorId, KHÔNG có SUBUSER_MANAGE và KHÔNG là Investor.userId) → FAIL cả 2 nhánh
// → KHÔNG tự tạo được tài khoản con khác (chống leo thang). Nhân sự của NĐT-A KHÔNG quản được NĐT-B (gate theo id).
//
// §14 xác thực mật khẩu khi XÓA do ADAPTER (route) kiểm TRƯỚC — lõi KHÔNG kiểm password (khuôn customer.ts/user.ts).
import { hashPassword, auditSnapshot } from '@sigma/business-rules';
import { hasPermission, validateUsername, validatePassword } from '@sigma/shared';
import { writeAudit } from './audit.js';
import type { ServiceCtx, MutationResult } from './customer.js';

const INVESTOR_ROLE_CODE = 'R_INVESTOR';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền quản lý tài khoản xem của nhà đầu tư này.';

export interface InvestorSubUserDto {
  id: number;
  username: string;
  fullName: string;
  status: string; // ACTIVE | LOCKED | ...
  createdAt: string;
}

export interface CreateInvestorSubUserInput {
  username: string;
  password: string;
  fullName?: string | null;
}

function toDto(u: { id: number; username: string; fullName: string; status: string; createdAt: Date }): InvestorSubUserDto {
  return { id: u.id, username: u.username, fullName: u.fullName, status: u.status, createdAt: u.createdAt.toISOString() };
}

/** AI được quản tài khoản con của NĐT `investorId`: (1) có INVESTOR_SUBUSER_MANAGE (mọi NĐT) HOẶC (2) là CHÍNH
 *  CHỦ NĐT đó (Investor.userId=ctx.user.id). Đọc DB xác nhận NĐT còn sống + quyền sở hữu. */
async function canManageSubUsers(ctx: ServiceCtx, investorId: number): Promise<boolean> {
  if (hasPermission(ctx.user, 'INVESTOR_SUBUSER_MANAGE')) {
    const inv = await ctx.db.investor.findFirst({ where: { id: investorId, deletedAt: null }, select: { id: true } });
    return !!inv;
  }
  // Chính chủ NĐT tự quản tài khoản con của MÌNH (không cần quyền nhân sự).
  const own = await ctx.db.investor.findFirst({ where: { id: investorId, userId: ctx.user.id, deletedAt: null }, select: { id: true } });
  return !!own;
}

/** Danh sách tài khoản xem (R_INVESTOR gắn investorId) của 1 NĐT, ẩn đã xóa mềm. Gate canManageSubUsers. */
export async function listInvestorSubUsers(ctx: ServiceCtx, investorId: number): Promise<{ ok: boolean; data?: InvestorSubUserDto[]; error?: string; message?: string }> {
  if (!Number.isInteger(investorId) || investorId <= 0) return { ok: false, error: 'VALIDATION', message: 'Mã nhà đầu tư không hợp lệ.' };
  if (!(await canManageSubUsers(ctx, investorId))) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const rows = await ctx.db.user.findMany({
    where: { investorId, deletedAt: null },
    orderBy: { id: 'asc' },
    select: { id: true, username: true, fullName: true, status: true, createdAt: true }
  });
  return { ok: true, data: rows.map(toDto) };
}

/** Tạo 1 tài khoản xem cho NĐT: role R_INVESTOR + investorId, forceChangePassword=false. Gate canManageSubUsers. */
export async function createInvestorSubUser(ctx: ServiceCtx, investorId: number, input: CreateInvestorSubUserInput): Promise<MutationResult> {
  if (!Number.isInteger(investorId) || investorId <= 0) return { ok: false, error: 'VALIDATION', message: 'Mã nhà đầu tư không hợp lệ.' };
  if (!(await canManageSubUsers(ctx, investorId))) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };

  const uname = validateUsername(input.username ?? '');
  if (!uname.valid) return { ok: false, error: 'VALIDATION', message: uname.error };
  const pwd = validatePassword(input.password ?? '');
  if (!pwd.valid) return { ok: false, error: 'VALIDATION', message: pwd.error };

  if (await ctx.db.user.findFirst({ where: { username: input.username } })) {
    return { ok: false, error: 'DUPLICATE', message: `Tên đăng nhập "${input.username}" đã tồn tại.` };
  }
  const role = await ctx.db.role.findUnique({ where: { code: INVESTOR_ROLE_CODE }, select: { id: true } });
  if (!role) return { ok: false, error: 'VALIDATION', message: 'Thiếu vai trò Nhà đầu tư (R_INVESTOR) trong hệ thống.' };

  const fullName = (input.fullName ?? '').trim() || input.username.trim();
  const created = await ctx.db.user.create({
    data: {
      fullName,
      username: input.username,
      passwordHash: hashPassword(input.password),
      status: 'ACTIVE',
      forceChangePassword: false, // tài khoản xem — NĐT đặt mật khẩu, không ép đổi lần đầu
      investorId,
      createdBy: ctx.user.id,
      roles: { create: [{ roleId: role.id }] }
    }
  });
  await writeAudit(ctx.db, {
    actorUserId: ctx.user.id,
    action: 'INVESTOR_SUBUSER_CREATED',
    targetType: 'User',
    targetId: String(created.id),
    after: auditSnapshot({ username: created.username, fullName, investorId })
  });
  return { ok: true, id: created.id };
}

/** Đổi trạng thái khóa/mở 1 tài khoản con. Gate theo NĐT cha của user đó (target PHẢI là tài khoản con). */
async function setSubUserLock(ctx: ServiceCtx, userId: number, lock: boolean): Promise<MutationResult> {
  if (!Number.isInteger(userId) || userId <= 0) return { ok: false, error: 'VALIDATION', message: 'Mã tài khoản không hợp lệ.' };
  const row = await ctx.db.user.findUnique({ where: { id: userId }, select: { id: true, username: true, status: true, investorId: true, deletedAt: true } });
  if (!row || row.deletedAt || row.investorId == null) return { ok: false, error: 'NOT_FOUND', message: 'Tài khoản xem không tồn tại.' };
  if (!(await canManageSubUsers(ctx, row.investorId))) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  await ctx.db.user.update({ where: { id: userId }, data: lock ? { status: 'LOCKED', lockedAt: null, lockReason: 'ADMIN_LOCK' } : { status: 'ACTIVE', lockedAt: null, lockReason: null, failedAttempts: 0 } });
  await writeAudit(ctx.db, {
    actorUserId: ctx.user.id,
    action: lock ? 'INVESTOR_SUBUSER_LOCKED' : 'INVESTOR_SUBUSER_UNLOCKED',
    targetType: 'User',
    targetId: String(userId),
    before: { status: row.status },
    after: { status: lock ? 'LOCKED' : 'ACTIVE', manual: true }
  });
  return { ok: true, id: userId };
}

export const lockInvestorSubUser = (ctx: ServiceCtx, userId: number): Promise<MutationResult> => setSubUserLock(ctx, userId, true);
export const unlockInvestorSubUser = (ctx: ServiceCtx, userId: number): Promise<MutationResult> => setSubUserLock(ctx, userId, false);

/** Xóa mềm 1 tài khoản con. §14 xác thực mật khẩu do ROUTE kiểm TRƯỚC. Target PHẢI là tài khoản con. */
export async function deleteInvestorSubUser(ctx: ServiceCtx, userId: number): Promise<MutationResult> {
  if (!Number.isInteger(userId) || userId <= 0) return { ok: false, error: 'VALIDATION', message: 'Mã tài khoản không hợp lệ.' };
  const row = await ctx.db.user.findUnique({ where: { id: userId }, select: { id: true, username: true, fullName: true, investorId: true, deletedAt: true } });
  if (!row || row.deletedAt || row.investorId == null) return { ok: false, error: 'NOT_FOUND', message: 'Tài khoản xem không tồn tại.' };
  if (!(await canManageSubUsers(ctx, row.investorId))) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  await ctx.db.user.update({ where: { id: userId }, data: { status: 'DELETED', deletedAt: new Date() } });
  await writeAudit(ctx.db, {
    actorUserId: ctx.user.id,
    action: 'INVESTOR_SUBUSER_DELETED',
    targetType: 'User',
    targetId: String(userId),
    before: auditSnapshot({ username: row.username, fullName: row.fullName, investorId: row.investorId })
  });
  return { ok: true, id: userId };
}
