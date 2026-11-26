// Route adapter cho 6 màn quản trị (role / user / audit / dashboard / search / message) qua supertest. KHÔNG dựa
// app.ts (LEAD gom mount sau) → dựng express app CỤC BỘ mount 6 router mới + cookieParser + json + errorHandler,
// bơm Db giả in-memory (__setDbForTest). Kiểm: 401 không phiên, 403 thiếu quyền, 200 có quyền, role DELETE
// {password} (§14) sai→409/đúng→200, user lock (không mật khẩu), message send. requireQlSession + core chạy THẬT.
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '@sigma/database';
import { hashPassword } from '@sigma/business-rules';
import { __setDbForTest } from '../src/db.js';
import { makeFakeDb as buildFakeDb } from './_fake-db.js';
import { errorHandler } from '../src/app.js';
import { roleRouter } from '../src/routes/role.js';
import { userRouter } from '../src/routes/user.js';
import { auditRouter } from '../src/routes/audit.js';
import { dashboardRouter } from '../src/routes/dashboard.js';
import { searchRouter } from '../src/routes/search.js';
import { messageRouter } from '../src/routes/message.js';

const PASSWORD = 'matkhau-dung-123';
const PW_HASH = hashPassword(PASSWORD);
const COOKIE = 'ql_session=sess-1';
const ALL_PERMS = ['ROLE_READ', 'ROLE_CREATE', 'ROLE_UPDATE', 'ROLE_LOCK', 'ROLE_UNLOCK', 'ROLE_DELETE', 'USER_READ', 'USER_LOCK', 'AUDIT_LOG_VIEW', 'DASHBOARD_VIEW', 'CUSTOMER_VIEW', 'MESSAGE_VIEW', 'MESSAGE_SEND'];

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(roleRouter);
  app.use(userRouter);
  app.use(auditRouter);
  app.use(dashboardRouter);
  app.use(searchRouter);
  app.use(messageRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Route không tồn tại.' }));
  app.use(errorHandler);
  return app;
}

function makeFakeDb(permissions: string[]) {
  const user = {
    id: 7, username: 'admin', fullName: 'Admin', status: 'ACTIVE', deletedAt: null, forceChangePassword: false,
    passwordHash: PW_HASH,
    roles: [{ role: { code: 'ADMIN', status: 'ACTIVE', permissions: permissions.map((c) => ({ permission: { code: c } })) } }]
  };
  const sessions = [{ id: 'sess-1', userId: 7, expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() }];
  const roles = [{ id: 1, name: 'Kế toán', code: 'ACCOUNTANT', description: null as string | null, status: 'ACTIVE', isSystem: false, permissionCodes: ['USER_READ'], userCount: 0, createdBy: 7, updatedAt: new Date('2026-01-01'), deletedAt: null as Date | null }];
  const users = [{ id: 11, employeeCode: 'NV11', fullName: 'Nhân Viên', birthDate: null, gender: null, phone: null, email: null, address: null, joinDate: null, username: 'nhanvien11', status: 'ACTIVE', forceChangePassword: false, lockedAt: null as Date | null, lockReason: null as string | null, failedAttempts: 0, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), deletedAt: null as Date | null, roleCodes: ['STAFF'] }];
  const messages = [{ id: 1, kind: 'USER', category: null as string | null, subject: 'Chào', body: 'Nội dung', senderId: null as number | null, recipientId: 7, readAt: null as Date | null, createdAt: new Date('2026-01-01'), deletedAt: null as Date | null }];
  const audits: Record<string, unknown>[] = [];
  const permRow = (c: string) => ({ id: ALL_PERMS.indexOf(c) + 1, code: c, name: c, group: null });

  // Shared factory stub SẴN 87 model (join model mới KHÔNG 500 test); $transaction mặc định xử lý CẢ dạng mảng.
  const db = buildFakeDb({
    user: {
      findUnique: async ({ where }: { where: { id: number } }) => (where.id === 7 ? { ...user } : (users.find((u) => u.id === where.id) ? { ...users.find((u) => u.id === where.id)!, roles: users.find((u) => u.id === where.id)!.roleCodes.map((c) => ({ role: { code: c } })) } : null)),
      findUniqueOrThrow: async ({ where }: { where: { id: number } }) => { if (where.id !== 7) throw new Error('no user'); return JSON.parse(JSON.stringify(user)); },
      // B132 #1: verifyActorPassword sai → registerActorReauthFail dùng user.updateMany (feed lockout). Mock phải khớp shape Prisma.
      updateMany: async ({ where, data }: { where: { id?: number; status?: { notIn?: string[] } }; data: Record<string, unknown> }) => {
        const u = user as unknown as Record<string, unknown>;
        if (where.id !== undefined && where.id !== u.id) return { count: 0 };
        if (where.status?.notIn && where.status.notIn.includes(u.status as string)) return { count: 0 };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as object)) u[k] = ((u[k] as number) ?? 0) + ((v as { increment: number }).increment ?? 0);
          else u[k] = v;
        }
        return { count: 1 };
      },
      findFirst: async () => null,
      findMany: async () => users.filter((u) => u.deletedAt === null).map((u) => ({ ...u, roles: u.roleCodes.map((c) => ({ role: { code: c } })) })),
      count: async () => 1,
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const u = users.find((x) => x.id === where.id)!; Object.assign(u, data); return { ...u }; }
    },
    userRole: { count: async () => 0, findMany: async () => [], deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    loginSession: {
      findUnique: async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null,
      update: async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null,
      deleteMany: async () => ({ count: 0 })
    },
    role: {
      findMany: async () => roles.filter((r) => r.deletedAt === null).map((r) => ({ ...r, permissions: r.permissionCodes.map((c) => ({ permission: permRow(c) })), _count: { users: r.userCount } })),
      findUnique: async ({ where }: { where: { id?: number; code?: string } }) => { const r = roles.find((x) => (where.id !== undefined ? x.id === where.id : x.code === where.code)); return r ? { ...r, permissions: r.permissionCodes.map((c) => ({ permission: permRow(c) })), _count: { users: r.userCount } } : null; },
      create: async () => ({ id: 2 }),
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = roles.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; }
    },
    permission: { findMany: async ({ where }: { where?: { code?: { in: string[] } } } = {}) => (where?.code?.in ?? ALL_PERMS).filter((c) => ALL_PERMS.includes(c)).map(permRow) },
    rolePermission: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    message: {
      findMany: async ({ where }: { where: { recipientId: number } }) => messages.filter((m) => m.recipientId === where.recipientId && m.deletedAt === null).map((m) => ({ ...m })),
      count: async () => 1,
      findUnique: async ({ where }: { where: { id: number } }) => messages.find((m) => m.id === where.id) ?? null,
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 99, ...data })
    },
    auditLog: { findMany: async () => [{ id: 1, actorUserId: 7, action: 'LOGIN', targetType: null, targetId: null, beforeJson: null, afterJson: null, ipAddress: null, deviceInfo: null, createdAt: new Date('2026-01-01'), actor: { username: 'admin' } }], create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) },
    // dashboard models — FIX-PERF B132: getStats nay dùng groupBy (tid/posDevice) + $queryRawUnsafe (12 tháng).
    tid: { count: async () => 0, findMany: async () => [], groupBy: async () => [] },
    customer: { count: async () => 0, findMany: async () => [] },
    posDevice: { count: async () => 0, findMany: async () => [], groupBy: async () => [] },
    dossier: { count: async () => 0 },
    bank: { count: async () => 0, findMany: async () => [] },
    partner: { count: async () => 0 },
    $queryRaw: async () => [],
    $queryRawUnsafe: async () => [],
    $executeRawUnsafe: async () => 0
  });
  return { db, roles, users, messages, audits };
}

afterEach(() => __setDbForTest(null));

describe('6 route quản trị — adapter API', () => {
  it('role: không cookie → 401 NO_SESSION', async () => {
    __setDbForTest(makeFakeDb(['ROLE_READ']).db);
    const res = await request(buildApp()).get('/v1/roles');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('NO_SESSION');
  });

  it('role: có ROLE_READ → 200 list; thiếu → 403', async () => {
    __setDbForTest(makeFakeDb(['ROLE_READ']).db);
    const ok = await request(buildApp()).get('/v1/roles').set('Cookie', COOKIE);
    expect(ok.status).toBe(200);
    expect(ok.body.data[0].code).toBe('ACCOUNTANT');

    __setDbForTest(makeFakeDb([]).db);
    const forb = await request(buildApp()).get('/v1/roles').set('Cookie', COOKIE);
    expect(forb.status).toBe(403);
    expect(forb.body.error).toBe('FORBIDDEN');
  });

  it('role: DELETE {password} sai → 409 WRONG_PASSWORD; đúng → 200', async () => {
    const { db, roles } = makeFakeDb(['ROLE_DELETE']);
    __setDbForTest(db);
    const bad = await request(buildApp()).delete('/v1/roles/1').set('Cookie', COOKIE).send({ password: 'sai' });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe('WRONG_PASSWORD');
    expect(roles[0]!.deletedAt).toBeNull();

    const ok = await request(buildApp()).delete('/v1/roles/1').set('Cookie', COOKIE).send({ password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
  });

  it('role: POST /:id/lock (không mật khẩu) → 200 LOCKED', async () => {
    const { db, roles } = makeFakeDb(['ROLE_LOCK']);
    __setDbForTest(db);
    const res = await request(buildApp()).post('/v1/roles/1/lock').set('Cookie', COOKIE).send({});
    expect(res.status).toBe(200);
    expect(roles[0]!.status).toBe('LOCKED');
  });

  it('user: có USER_READ → 200 list', async () => {
    __setDbForTest(makeFakeDb(['USER_READ']).db);
    const res = await request(buildApp()).get('/v1/users').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.data[0].username).toBe('nhanvien11');
  });

  it('user: POST /:id/lock (không mật khẩu) → 200 LOCKED', async () => {
    const { db, users } = makeFakeDb(['USER_LOCK']);
    __setDbForTest(db);
    const res = await request(buildApp()).post('/v1/users/11/lock').set('Cookie', COOKIE).send({});
    expect(res.status).toBe(200);
    expect(users[0]!.status).toBe('LOCKED');
  });

  it('audit: có AUDIT_LOG_VIEW → 200 list', async () => {
    __setDbForTest(makeFakeDb(['AUDIT_LOG_VIEW']).db);
    const res = await request(buildApp()).get('/v1/audit-logs').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.data[0].actorUsername).toBe('admin');
  });

  it('dashboard: có DASHBOARD_VIEW → 200 stats (12 tháng)', async () => {
    __setDbForTest(makeFakeDb(['DASHBOARD_VIEW']).db);
    const res = await request(buildApp()).get('/v1/dashboard/stats').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.data.monthly).toHaveLength(12);
  });

  it('search: q<2 → 200 rỗng; có CUSTOMER_VIEW + q → 200', async () => {
    __setDbForTest(makeFakeDb(['CUSTOMER_VIEW']).db);
    const res = await request(buildApp()).get('/v1/search?q=abc').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('message: inbox (MESSAGE_VIEW) → 200; send (MESSAGE_SEND) validate tiêu đề', async () => {
    __setDbForTest(makeFakeDb(['MESSAGE_VIEW']).db);
    const inbox = await request(buildApp()).get('/v1/messages').set('Cookie', COOKIE);
    expect(inbox.status).toBe(200);
    expect(inbox.body.data[0].subject).toBe('Chào');

    __setDbForTest(makeFakeDb(['MESSAGE_SEND']).db);
    const bad = await request(buildApp()).post('/v1/messages').set('Cookie', COOKIE).send({ recipientId: 11, subject: '  ', body: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('EMPTY_SUBJECT');
  });
});
