// Test LÕI THUẦN role core (@sigma/services) — Db GIẢ in-memory ĐÚNG SHAPE Prisma + ServiceCtx = { db, user }.
// ASSERT giá trị cụ thể: error code + nguyên văn message tiếng Việt + audit + guard business (canDeleteRole).
// §14 xác nhận MẬT KHẨU đã CHUYỂN RA ADAPTER (route) — lõi KHÔNG kiểm password (khuôn customer.ts).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { listRoles, listPermissions, createRole, updateRole, lockRole, deleteRole, type ServiceCtx } from '../src/index.js';

interface FakeRole {
  id: number; name: string; code: string; description: string | null; status: string; isSystem: boolean;
  permissionCodes: string[]; userCount: number; createdBy: number | null; updatedAt: Date; deletedAt: Date | null;
}

const ALL_PERMS = ['ROLE_READ', 'ROLE_CREATE', 'USER_READ', 'TID_VIEW'];

function makeFakeDb(seed: FakeRole[]) {
  const roles = seed.map((r) => ({ ...r }));
  const audits: Record<string, unknown>[] = [];
  const rolePerms: { roleId: number; permissionId: number }[] = [];
  let nextId = roles.reduce((m, r) => Math.max(m, r.id), 0) + 1;

  const permRow = (code: string) => ({ id: ALL_PERMS.indexOf(code) + 1, code, name: code, group: null });

  const roleModel = {
    findMany: async () =>
      roles.filter((r) => r.deletedAt === null).sort((a, b) => a.id - b.id).map((r) => ({
        ...r,
        permissions: r.permissionCodes.map((c) => ({ permission: permRow(c) })),
        _count: { users: r.userCount }
      })),
    findUnique: async ({ where }: { where: { id?: number; code?: string } }) => {
      const r = roles.find((x) => (where.id !== undefined ? x.id === where.id : x.code === where.code));
      if (!r) return null;
      return { ...r, permissions: r.permissionCodes.map((c) => ({ permission: permRow(c) })), _count: { users: r.userCount } };
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row: FakeRole = {
        id: nextId++, name: data['name'] as string, code: data['code'] as string,
        description: (data['description'] as string | null) ?? null, status: (data['status'] as string) ?? 'ACTIVE',
        isSystem: (data['isSystem'] as boolean) ?? false, permissionCodes: [], userCount: 0,
        createdBy: (data['createdBy'] as number | null) ?? null, updatedAt: new Date(), deletedAt: null
      };
      const perms = data['permissions'] as { create: { permissionId: number }[] } | undefined;
      if (perms) row.permissionCodes = perms.create.map((p) => ALL_PERMS[p.permissionId - 1]!).filter(Boolean);
      roles.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
      const r = roles.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      return { ...r };
    }
  };

  const fake = {
    role: roleModel,
    permission: {
      findMany: async ({ where }: { where?: { code?: { in: string[] } } } = {}) => {
        const codes = where?.code?.in ?? ALL_PERMS;
        return codes.filter((c) => ALL_PERMS.includes(c)).map((c) => permRow(c));
      }
    },
    rolePermission: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async ({ data }: { data: { roleId: number; permissionId: number }[] }) => { rolePerms.push(...data); return { count: data.length }; }
    },
    // Admin Demo 11/8 — listRoles đếm nhân sự RIÊNG BIỆT (distinct userId) qua userRole.findMany cho assignedUserTotal.
    // Test cơ bản không cần assignedUserTotal cụ thể → trả rỗng (không có gán userRole nào).
    userRole: { findMany: async () => [] as { userId: number }[] },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'Role', version: 1 }) },
    $transaction: async (arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(fake))
  };
  return { db: fake as unknown as Db, roles, audits };
}

function authUser(permissions: string[], roles: string[] = ['R']): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles, permissions };
}

function seed(over: Partial<FakeRole> = {}): FakeRole {
  return { id: 1, name: 'Kế toán', code: 'ACCOUNTANT', description: null, status: 'ACTIVE', isSystem: false, permissionCodes: ['USER_READ'], userCount: 0, createdBy: 42, updatedAt: new Date('2026-01-01T00:00:00.000Z'), deletedAt: null, ...over };
}

describe('listRoles / listPermissions', () => {
  it('thiếu quyền ROLE_READ → FORBIDDEN + message nguyên văn', async () => {
    const { db } = makeFakeDb([seed()]);
    const r = await listRoles({ db, user: authUser([]) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('có quyền → data (ẩn đã xóa) + permissions + userCount', async () => {
    const { db } = makeFakeDb([seed({ userCount: 3 }), seed({ id: 2, code: 'DELETED_ROLE', deletedAt: new Date() })]);
    const ctx: ServiceCtx = { db, user: authUser(['ROLE_READ']) };
    const r = await listRoles(ctx);
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(r.data![0]!.code).toBe('ACCOUNTANT');
    expect(r.data![0]!.userCount).toBe(3);
    expect(r.data![0]!.permissions).toContain('USER_READ');
    const p = await listPermissions(ctx);
    expect(p.ok).toBe(true);
    expect(p.data!.some((x) => x.code === 'ROLE_READ')).toBe(true);
  });
});

describe('createRole', () => {
  it('mã sai định dạng → VALIDATION nguyên văn', async () => {
    const { db, audits } = makeFakeDb([]);
    const r = await createRole({ db, user: authUser(['ROLE_CREATE']) }, { name: 'Thu ngân', code: 'thu ngan', permissionCodes: [] });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Mã vai trò: CHỮ HOA/số/gạch dưới, không dấu, ≥2 ký tự.');
    expect(audits).toHaveLength(0);
  });

  it('mã trùng → DUPLICATE', async () => {
    const { db } = makeFakeDb([seed({ code: 'ACCOUNTANT' })]);
    const r = await createRole({ db, user: authUser(['ROLE_CREATE']) }, { name: 'x', code: 'ACCOUNTANT', permissionCodes: [] });
    expect(r.error).toBe('DUPLICATE');
    expect(r.message).toBe('Mã vai trò "ACCOUNTANT" đã tồn tại.');
  });

  it('hợp lệ → tạo + gán quyền + audit ROLE_CREATED', async () => {
    const { db, roles, audits } = makeFakeDb([]);
    const r = await createRole({ db, user: authUser(['ROLE_CREATE']) }, { name: 'Thủ kho', code: 'WAREHOUSE', permissionCodes: ['USER_READ', 'TID_VIEW'] });
    expect(r.ok).toBe(true);
    expect(roles.find((x) => x.code === 'WAREHOUSE')!.permissionCodes).toEqual(['USER_READ', 'TID_VIEW']);
    expect(audits.some((a) => a['action'] === 'ROLE_CREATED')).toBe(true);
  });
});

describe('lockRole / deleteRole', () => {
  it('lockRole thiếu quyền ROLE_LOCK → FORBIDDEN', async () => {
    const { db } = makeFakeDb([seed()]);
    const r = await lockRole({ db, user: authUser(['ROLE_READ']) }, 1);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('lockRole hợp lệ → status LOCKED + audit ROLE_LOCKED', async () => {
    const { db, roles, audits } = makeFakeDb([seed()]);
    const r = await lockRole({ db, user: authUser(['ROLE_LOCK']) }, 1);
    expect(r.ok).toBe(true);
    expect(roles[0]!.status).toBe('LOCKED');
    expect(audits.some((a) => a['action'] === 'ROLE_LOCKED')).toBe(true);
  });

  it('deleteRole còn user dùng → ROLE_HAS_USERS message có số user', async () => {
    const { db } = makeFakeDb([seed({ userCount: 2 })]);
    const r = await deleteRole({ db, user: authUser(['ROLE_DELETE']) }, 1);
    expect(r.error).toBe('ROLE_HAS_USERS');
    expect(r.message).toBe('Không thể xóa vai trò đang có 2 nhân sự sử dụng.');
  });

  it('deleteRole (0 user) → soft-delete + audit ROLE_DELETED', async () => {
    const { db, roles, audits } = makeFakeDb([seed({ userCount: 0 })]);
    const r = await deleteRole({ db, user: authUser(['ROLE_DELETE']) }, 1);
    expect(r.ok).toBe(true);
    expect(roles[0]!.deletedAt).toBeInstanceOf(Date);
    expect(audits.some((a) => a['action'] === 'ROLE_DELETED')).toBe(true);
  });

  it('updateRole không tồn tại → NOT_FOUND', async () => {
    const { db } = makeFakeDb([]);
    const r = await updateRole({ db, user: authUser(['ROLE_UPDATE']) }, 99, { name: 'X', code: 'X', permissionCodes: [] });
    expect(r.error).toBe('NOT_FOUND');
    expect(r.message).toBe('Vai trò không tồn tại.');
  });
});
