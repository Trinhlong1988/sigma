// Vai trò (Role) CRUD — LÕI THUẦN ctx-based. PORT nghiệp vụ từ apps/desktop/src/main/role-service.ts
// (IMS_SPEC §8, R_ROLE_001..010). Thay `requirePermission(current-user global)` bằng ctx = { db, user } do adapter
// dựng; mỗi hàm tự kiểm quyền qua hasPermission(ctx.user, ROLE_*). GIỮ NGUYÊN business: mã bất biến, chống trùng
// mã, guard canLock/Unlock/DeleteRole + roleDenyMessage, bảo vệ ADMIN hệ thống, audit before/after, soft-delete.
// XÁC NHẬN MẬT KHẨU (§14, role:delete) do ADAPTER kiểm TRƯỚC khi gọi lõi (khuôn customer.ts/industry.ts) — lõi
// KHÔNG kiểm password. R_UX_WARN (§E): thất bại trả {ok,error,message} tiếng Việt cụ thể.
import { canDeleteRole, canLockRole, canUnlockRole, roleDenyMessage, isValidRoleCode, auditSnapshot } from '@sigma/business-rules';
import { hasPermission } from '@sigma/shared';
import { writeAudit } from './audit.js';
import { staleGuard } from './optimistic-lock.js';
import type { ServiceCtx, MutationResult } from './customer.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

export interface RoleDto {
  id: number;
  name: string;
  code: string;
  description: string | null;
  status: string;
  isSystem: boolean;
  userCount: number;
  permissions: string[]; // permission codes
  updatedAt: string; // R48 #2 optimistic-lock — client echo lại khi Lưu để chống sửa đè
}

export interface PermissionDto {
  code: string;
  name: string;
  group: string | null;
}

/** ROLE_READ — liệt kê vai trò kèm permission codes + số user đang dùng. `assignedUserTotal` = số NHÂN SỰ RIÊNG
 *  BIỆT (distinct userId, user chưa xóa) có ≥1 vai trò — dùng cho bộ đếm "Nhân sự đã gán" (Admin Demo 11/8: KHÔNG cộng
 *  dồn userCount/vai-trò vì 1 nhân sự nhiều vai trò sẽ bị đếm nhiều lần → sai nghĩa nhãn). */
export async function listRoles(ctx: ServiceCtx): Promise<{ ok: boolean; data?: RoleDto[]; assignedUserTotal?: number; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'ROLE_READ')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const rows = await ctx.db.role.findMany({
    where: { deletedAt: null },
    orderBy: { id: 'asc' },
    include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } }
  });
  const data: RoleDto[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    description: r.description,
    status: r.status,
    isSystem: r.isSystem,
    userCount: r._count.users,
    permissions: r.permissions.map((p) => p.permission.code),
    updatedAt: r.updatedAt.toISOString()
  }));
  // Đếm nhân sự RIÊNG BIỆT có vai trò (distinct userId, loại user đã xóa mềm) — không phụ thuộc số vai trò/người.
  const distinctAssigned = await ctx.db.userRole.findMany({ where: { user: { deletedAt: null } }, distinct: ['userId'], select: { userId: true } });
  return { ok: true, data, assignedUserTotal: distinctAssigned.length };
}

/** ROLE_READ — toàn bộ danh mục quyền (cho UI gán quyền). */
export async function listPermissions(ctx: ServiceCtx): Promise<{ ok: boolean; data?: PermissionDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'ROLE_READ')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const rows = await ctx.db.permission.findMany({ orderBy: { id: 'asc' } });
  return { ok: true, data: rows.map((p) => ({ code: p.code, name: p.name, group: p.group })) };
}

export interface RoleInput {
  name: string;
  code: string;
  description?: string;
  status?: string; // ACTIVE | LOCKED
  permissionCodes: string[];
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock — mốc updatedAt client giữ lúc mở form (chỉ dùng ở updateRole)
}

/** R_ROLE_001 tạo vai trò (+ ROLE_ASSIGN qua permissionCodes). */
export async function createRole(ctx: ServiceCtx, input: RoleInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'ROLE_CREATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  if (!input.name?.trim()) return { ok: false, error: 'VALIDATION', message: 'Tên vai trò bắt buộc.' };
  if (!isValidRoleCode(input.code)) {
    return { ok: false, error: 'VALIDATION', message: 'Mã vai trò: CHỮ HOA/số/gạch dưới, không dấu, ≥2 ký tự.' };
  }
  const existing = await db.role.findUnique({ where: { code: input.code } });
  if (existing) return { ok: false, error: 'DUPLICATE', message: `Mã vai trò "${input.code}" đã tồn tại.` };

  const perms = await db.permission.findMany({ where: { code: { in: input.permissionCodes ?? [] } } });
  const role = await db.role.create({
    data: {
      name: input.name.trim(),
      code: input.code,
      description: input.description ?? null,
      status: input.status === 'LOCKED' ? 'LOCKED' : 'ACTIVE',
      isSystem: false,
      createdBy: user.id,
      permissions: { create: perms.map((p) => ({ permissionId: p.id })) }
    }
  });
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'ROLE_CREATED',
    targetType: 'Role',
    targetId: String(role.id),
    after: { name: role.name, code: role.code, status: role.status, permissions: perms.map((p) => p.code) }
  });
  return { ok: true, id: role.id };
}

/** R_ROLE_002 cập nhật vai trò (tên/mô tả/trạng thái/quyền) — audit before/after (R_AUDIT_002). */
export async function updateRole(ctx: ServiceCtx, id: number, input: RoleInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'ROLE_UPDATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const role = await db.role.findUnique({
    where: { id },
    include: { permissions: { include: { permission: true } } }
  });
  if (!role || role.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Vai trò không tồn tại.' };
  const stale = staleGuard(role.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;
  if (!input.name?.trim()) return { ok: false, error: 'VALIDATION', message: 'Tên vai trò bắt buộc.' };

  const before = {
    name: role.name,
    description: role.description,
    status: role.status,
    permissions: role.permissions.map((p) => p.permission.code)
  };

  const perms = await db.permission.findMany({ where: { code: { in: input.permissionCodes ?? [] } } });
  // The protected ADMIN role must never lose permissions or be locked via update.
  const isAdminSystem = role.code === 'ADMIN' && role.isSystem;
  const nextStatus = isAdminSystem ? 'ACTIVE' : input.status === 'LOCKED' ? 'LOCKED' : 'ACTIVE';

  // AUTH-06 (audit 15/7, Codex) — khóa/mở role QUA updateRole phải chịu ĐÚNG guard như setRoleStatus:
  // cần ROLE_LOCK/ROLE_UNLOCK + canLockRole/canUnlockRole. Không thì actor chỉ có ROLE_UPDATE khóa được
  // role bất kỳ (trừ ADMIN đã chặn), vô hiệu hóa toàn bộ quyền của user mang role đó.
  if (nextStatus !== role.status) {
    const lock = nextStatus === 'LOCKED';
    const needPerm = lock ? 'ROLE_LOCK' : 'ROLE_UNLOCK';
    if (!hasPermission(user, needPerm)) {
      return { ok: false, error: 'FORBIDDEN', message: `Đổi trạng thái vai trò cần quyền ${needPerm}.` };
    }
    const decision = lock
      ? canLockRole({ code: role.code, isSystem: role.isSystem, status: role.status })
      : canUnlockRole({ code: role.code, isSystem: role.isSystem, status: role.status });
    if (!decision.allowed) {
      return { ok: false, error: decision.reason, message: roleDenyMessage(decision.reason!) };
    }
  }

  await db.$transaction([
    db.role.update({
      where: { id },
      data: { name: input.name.trim(), description: input.description ?? null, status: nextStatus }
    }),
    ...(isAdminSystem
      ? [] // never rewrite ADMIN permissions
      : [
          db.rolePermission.deleteMany({ where: { roleId: id } }),
          db.rolePermission.createMany({ data: perms.map((p) => ({ roleId: id, permissionId: p.id })) })
        ])
  ]);

  const after = {
    name: input.name.trim(),
    description: input.description ?? null,
    status: nextStatus,
    permissions: isAdminSystem ? before.permissions : perms.map((p) => p.code)
  };
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'ROLE_UPDATED',
    targetType: 'Role',
    targetId: String(id),
    before: auditSnapshot(before),
    after: auditSnapshot(after)
  });
  return { ok: true, id };
}

async function setRoleStatus(ctx: ServiceCtx, id: number, lock: boolean): Promise<MutationResult> {
  const perm = lock ? 'ROLE_LOCK' : 'ROLE_UNLOCK';
  const action = lock ? 'ROLE_LOCKED' : 'ROLE_UNLOCKED';
  if (!hasPermission(ctx.user, perm)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const role = await db.role.findUnique({ where: { id } });
  if (!role || role.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Vai trò không tồn tại.' };

  const decision = lock
    ? canLockRole({ code: role.code, isSystem: role.isSystem, status: role.status })
    : canUnlockRole({ code: role.code, isSystem: role.isSystem, status: role.status });
  if (!decision.allowed) {
    return { ok: false, error: decision.reason, message: roleDenyMessage(decision.reason!) };
  }

  await db.role.update({ where: { id }, data: { status: lock ? 'LOCKED' : 'ACTIVE' } });
  await writeAudit(db, {
    actorUserId: user.id,
    action,
    targetType: 'Role',
    targetId: String(id),
    before: { status: role.status },
    after: { status: lock ? 'LOCKED' : 'ACTIVE' }
  });
  return { ok: true, id };
}

export const lockRole = (ctx: ServiceCtx, id: number): Promise<MutationResult> => setRoleStatus(ctx, id, true);
export const unlockRole = (ctx: ServiceCtx, id: number): Promise<MutationResult> => setRoleStatus(ctx, id, false);

/** R_ROLE_004 + R_ROLE_005/006 — xóa mềm vai trò. XÁC NHẬN MẬT KHẨU người thao tác (§14, R_ROLE_009) do ADAPTER
 *  kiểm TRƯỚC khi gọi lõi (khuôn customer.ts) — lõi KHÔNG kiểm password. Guard canDeleteRole (không xóa ADMIN /
 *  role còn user). */
export async function deleteRole(ctx: ServiceCtx, id: number): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'ROLE_DELETE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const role = await db.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
  if (!role || role.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Vai trò không tồn tại.' };

  const decision = canDeleteRole({ code: role.code, isSystem: role.isSystem }, role._count.users);
  if (!decision.allowed) {
    return { ok: false, error: decision.reason, message: roleDenyMessage(decision.reason!, role._count.users) };
  }

  // Soft delete (consistent with users; keeps referential history).
  await db.$transaction([
    db.rolePermission.deleteMany({ where: { roleId: id } }),
    db.role.update({ where: { id }, data: { deletedAt: new Date(), status: 'LOCKED' } })
  ]);
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'ROLE_DELETED',
    targetType: 'Role',
    targetId: String(id),
    before: { name: role.name, code: role.code }
  });
  return { ok: true, id };
}
