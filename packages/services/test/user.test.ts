// Test LÕI THUẦN user core (@sigma/services) — Db GIẢ in-memory ĐÚNG SHAPE Prisma + ServiceCtx = { db, user }.
// ASSERT giá trị cụ thể: error code + nguyên văn message tiếng Việt + mã NV auto + audit + guard (manager scope,
// last-admin). §14 xác nhận MẬT KHẨU + xóa nhân sự CHUYỂN RA ADAPTER — desktop KHÔNG expose xóa trực tiếp (R34);
// deleteUser vẫn test được ở LÕI (nội bộ). me()/getDb() đã thay bằng ctx.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { listUsers, createUser, updateUser, lockUser, deleteUser, type ServiceCtx } from '../src/index.js';

interface FakeUser {
  id: number; employeeCode: string | null; fullName: string; birthDate: Date | null; gender: string | null;
  phone: string | null; email: string | null; address: string | null; joinDate: Date | null; username: string;
  passwordHash: string; status: string; forceChangePassword: boolean; lockedAt: Date | null; lockReason: string | null;
  failedAttempts: number; createdBy: number | null; createdAt: Date; updatedAt: Date; deletedAt: Date | null;
  roleCodes: string[];
}

function makeFakeDb(seed: FakeUser[]) {
  const users = seed.map((u) => ({ ...u }));
  const audits: Record<string, unknown>[] = [];
  const counters: Record<string, number> = {};
  let nextId = users.reduce((m, u) => Math.max(m, u.id), 0) + 1;

  const withRoles = (u: FakeUser) => ({ ...u, roles: u.roleCodes.map((c) => ({ role: { code: c } })) });

  const userModel = {
    findMany: async () => users.filter((u) => u.deletedAt === null).sort((a, b) => a.id - b.id).map(withRoles),
    findUnique: async ({ where }: { where: { id: number } }) => {
      const u = users.find((x) => x.id === where.id);
      return u ? withRoles(u) : null;
    },
    findFirst: async ({ where }: { where: { username?: string; email?: string } }) => {
      const u = users.find((x) => (where.username ? x.username === where.username : where.email ? x.email === where.email : false));
      return u ? { ...u } : null;
    },
    count: async ({ where }: { where?: { roles?: unknown; id?: { not: number } } } = {}) => {
      // countActiveAdmins → chỉ đếm ACTIVE có role ADMIN, honor id.not (loại chính target).
      if (where?.roles) {
        const excl = where.id?.not;
        return users.filter((u) => u.deletedAt === null && u.status === 'ACTIVE' && u.roleCodes.includes('ADMIN') && (excl === undefined || u.id !== excl)).length;
      }
      return users.filter((u) => u.deletedAt === null).length;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const now = new Date();
      const row: FakeUser = {
        id: nextId++, employeeCode: (data['employeeCode'] as string) ?? null, fullName: data['fullName'] as string,
        birthDate: null, gender: null, phone: null, email: (data['email'] as string | null) ?? null, address: null, joinDate: null,
        username: data['username'] as string, passwordHash: data['passwordHash'] as string, status: (data['status'] as string) ?? 'ACTIVE',
        forceChangePassword: (data['forceChangePassword'] as boolean) ?? false, lockedAt: null, lockReason: null, failedAttempts: 0,
        createdBy: (data['createdBy'] as number | null) ?? null, createdAt: now, updatedAt: now, deletedAt: null, roleCodes: []
      };
      users.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
      const u = users.find((x) => x.id === where.id)!;
      Object.assign(u, data);
      return { ...u };
    }
  };

  const fake = {
    user: userModel,
    role: { findMany: async ({ where }: { where?: { code?: { in: string[] } } } = {}) => (where?.code?.in ?? []).map((c, i) => ({ id: i + 1, code: c, permissions: [] })) },
    userRole: {
      count: async ({ where }: { where: { userId: number } }) => {
        const u = users.find((x) => x.id === where.userId);
        return u && u.roleCodes.includes('ADMIN') ? 1 : 0;
      },
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 })
    },
    codeCounter: {
      upsert: async ({ where, create }: { where: { prefix: string }; create: { prefix: string; lastValue: number } }) => {
        const p = where.prefix;
        counters[p] = counters[p] === undefined ? create.lastValue : counters[p] + 1;
        return { prefix: p, lastValue: counters[p] };
      }
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'User', version: 1 }) },
    $executeRawUnsafe: async () => 0,
    $transaction: async (arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(fake))
  };
  return { db: fake as unknown as Db, users, audits };
}

function authUser(permissions: string[], roles: string[] = ['MANAGER']): AuthUser {
  return { id: 42, username: 'actoradmin', fullName: 'Actor', status: 'ACTIVE', forceChangePassword: false, roles, permissions };
}

function seedUser(over: Partial<FakeUser> = {}): FakeUser {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 1, employeeCode: 'NV01', fullName: 'Nguyễn Văn A', birthDate: null, gender: null, phone: null, email: null, address: null,
    joinDate: null, username: 'nguyenvana', passwordHash: 'x', status: 'ACTIVE', forceChangePassword: false, lockedAt: null,
    lockReason: null, failedAttempts: 0, createdBy: null, createdAt: now, updatedAt: now, deletedAt: null, roleCodes: ['STAFF'], ...over
  };
}

describe('listUsers', () => {
  it('thiếu quyền USER_READ → FORBIDDEN nguyên văn', async () => {
    const { db } = makeFakeDb([seedUser()]);
    const r = await listUsers({ db, user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('có quyền → data + roles code', async () => {
    const { db } = makeFakeDb([seedUser()]);
    const r = await listUsers({ db, user: authUser(['USER_READ']) });
    expect(r.ok).toBe(true);
    expect(r.data![0]!.username).toBe('nguyenvana');
    expect(r.data![0]!.roles).toEqual(['STAFF']);
  });
});

describe('createUser', () => {
  it('không có USER_CREATE/LIMITED → FORBIDDEN message riêng', async () => {
    const { db } = makeFakeDb([]);
    const r = await createUser({ db, user: authUser([]) }, { fullName: 'B', username: 'nhanvien01', password: 'MatKhau123', roleCodes: ['STAFF'] });
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền tạo nhân sự.');
  });

  it('không chọn vai trò → VALIDATION', async () => {
    const { db } = makeFakeDb([]);
    const r = await createUser({ db, user: authUser(['USER_CREATE'], ['ADMIN']) }, { fullName: 'B', username: 'nhanvien01', password: 'MatKhau123', roleCodes: [] });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Phải chọn ít nhất 1 vai trò.');
  });

  it('manager tạo vai trò ADMIN → MANAGER_SCOPE + audit từ chối', async () => {
    const { db, audits } = makeFakeDb([]);
    const r = await createUser({ db, user: authUser(['USER_CREATE_LIMITED'], ['MANAGER']) }, { fullName: 'B', username: 'nhanvien01', password: 'MatKhau123', roleCodes: ['ADMIN'] });
    expect(r.error).toBe('MANAGER_SCOPE');
    expect(audits.some((a) => a['action'] === 'PERMISSION_DENIED')).toBe(true);
  });

  it('admin hợp lệ → mã NV01 auto + audit USER_CREATED', async () => {
    const { db, users, audits } = makeFakeDb([]);
    const r = await createUser({ db, user: authUser(['USER_CREATE'], ['ADMIN']) }, { fullName: 'Trần Thị C', username: 'tranthic', password: 'MatKhau123', roleCodes: ['STAFF'] });
    expect(r.ok).toBe(true);
    expect(users.find((u) => u.username === 'tranthic')!.employeeCode).toBe('NV01');
    expect(audits.some((a) => a['action'] === 'USER_CREATED')).toBe(true);
  });
});

describe('lockUser / deleteUser', () => {
  it('lockUser thiếu quyền USER_LOCK → FORBIDDEN', async () => {
    const { db } = makeFakeDb([seedUser()]);
    const r = await lockUser({ db, user: authUser(['USER_READ']) }, 1);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('lockUser nhân sự thường → LOCKED + audit USER_LOCKED', async () => {
    const { db, users, audits } = makeFakeDb([seedUser()]);
    const r = await lockUser({ db, user: authUser(['USER_LOCK']) }, 1);
    expect(r.ok).toBe(true);
    expect(users[0]!.status).toBe('LOCKED');
    expect(users[0]!.lockReason).toBe('ADMIN_LOCK');
    expect(audits.some((a) => a['action'] === 'USER_LOCKED')).toBe(true);
  });

  it('lockUser Admin cuối cùng → LAST_ADMIN', async () => {
    const { db } = makeFakeDb([seedUser({ id: 1, roleCodes: ['ADMIN'], status: 'ACTIVE' })]);
    const r = await lockUser({ db, user: authUser(['USER_LOCK'], ['ADMIN']) }, 1);
    expect(r.error).toBe('LAST_ADMIN');
    expect(r.message).toBe('Không thể khóa Admin cuối cùng.');
  });

  it('deleteUser không tồn tại → NOT_FOUND', async () => {
    const { db } = makeFakeDb([]);
    const r = await deleteUser({ db, user: authUser(['USER_DELETE'], ['ADMIN']) }, 99);
    expect(r.error).toBe('NOT_FOUND');
    expect(r.message).toBe('Nhân sự không tồn tại.');
  });

  it('updateUser không tồn tại → NOT_FOUND', async () => {
    const { db } = makeFakeDb([]);
    const r = await updateUser({ db, user: authUser(['USER_UPDATE'], ['ADMIN']) }, 99, { fullName: 'X' });
    expect(r.error).toBe('NOT_FOUND');
  });
});

// B-audit follow-up (21/8): guard target-outranks-actor áp cho MỌI sửa (updateUser: status/hồ sơ, KHÔNG chỉ đổi
// role) + path khóa/mở (lockUser). MANAGER KHÔNG được sửa/khóa ADMIN (hay target giữ quyền cao hơn mình).
describe('updateUser / lockUser — B-audit target-outranks-actor guard', () => {
  it('MANAGER sửa status của ADMIN → FORBIDDEN (target out-rank) + audit TARGET_OUTRANKS_ACTOR', async () => {
    const { db, audits } = makeFakeDb([
      seedUser({ id: 1, username: 'admin1', roleCodes: ['ADMIN'], status: 'ACTIVE' }),
      seedUser({ id: 2, username: 'admin2', roleCodes: ['ADMIN'], status: 'ACTIVE' })
    ]);
    const r = await updateUser({ db, user: authUser(['USER_UPDATE', 'USER_LOCK'], ['MANAGER']) }, 1, { status: 'LOCKED' });
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toContain('quyền cao hơn');
    expect(audits.some((a) => {
      if (a['action'] !== 'PERMISSION_DENIED' || typeof a['afterJson'] !== 'string') return false;
      return (JSON.parse(a['afterJson'] as string) as Record<string, unknown>)['reason'] === 'TARGET_OUTRANKS_ACTOR';
    })).toBe(true);
  });

  it('MANAGER sửa nhân sự thường (STAFF) → KHÔNG bị chặn (đối chứng: peer/lower ok)', async () => {
    const { db } = makeFakeDb([seedUser({ id: 1, roleCodes: ['STAFF'] })]);
    const r = await updateUser({ db, user: authUser(['USER_UPDATE'], ['MANAGER']) }, 1, { fullName: 'Tên Mới' });
    expect(r.ok).toBe(true);
  });

  it('MANAGER khóa ADMIN → FORBIDDEN (path lockUser riêng)', async () => {
    const { db } = makeFakeDb([
      seedUser({ id: 1, username: 'admin1', roleCodes: ['ADMIN'], status: 'ACTIVE' }),
      seedUser({ id: 2, username: 'admin2', roleCodes: ['ADMIN'], status: 'ACTIVE' })
    ]);
    const r = await lockUser({ db, user: authUser(['USER_LOCK'], ['MANAGER']) }, 1);
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toContain('quyền cao hơn');
  });

  it('ADMIN sửa ADMIN khác → KHÔNG bị guard này chặn (đối chứng: admin qua được)', async () => {
    const { db } = makeFakeDb([
      seedUser({ id: 1, username: 'admin1', roleCodes: ['ADMIN'], status: 'ACTIVE' }),
      seedUser({ id: 2, username: 'admin2', roleCodes: ['ADMIN'], status: 'ACTIVE' })
    ]);
    const r = await updateUser({ db, user: authUser(['USER_UPDATE'], ['ADMIN']) }, 1, { fullName: 'Đổi Tên' });
    expect(r.ok).toBe(true);
  });
});
