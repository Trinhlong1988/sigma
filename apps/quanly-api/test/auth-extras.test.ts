// Test route auth-extras (đăng nhập-phụ migrate sang API): change-password / admin-reset-password / level2
// set|reset|status / heartbeat / online-users / validate-password. KHÔNG cần Postgres thật: Db GIẢ in-memory qua
// __setDbForTest + createApp() thật qua supertest. Cookie phiên lấy bằng CHÍNH luồng /v1/auth/login (đi qua
// requireQlSession thật). Assert giá trị cụ thể (đổi mật khẩu đúng/sai, level2, validate) — KHÔNG chỉ ok:true.
import request from 'supertest';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@sigma/database';
import { hashPassword, hashLevel2, verifyPassword, verifyLevel2 } from '@sigma/business-rules';
import { errorHandler } from '../src/app.js';
import { authRouter } from '../src/routes/auth.js';
import { authExtrasRouter } from '../src/routes/auth-extras.js';
import { __setDbForTest } from '../src/db.js';

// authExtrasRouter CHƯA được mount trong app.ts (LEAD mount để tránh đụng file dùng chung với agent khác). Dựng
// app test tại chỗ với ĐÚNG middleware createApp cần (trust proxy → req.ip đọc X-Forwarded-For cho rate-limit
// login; json + cookieParser cho cookie ql_session) + mount authRouter (lấy cookie qua /v1/auth/login thật) +
// authExtrasRouter + errorHandler. KHÔNG dùng createApp() vì nó gắn 404 catch-all TRƯỚC khi trả → không thể
// app.use() router mới sau đó.
function createApp(): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use(authRouter);
  app.use(authExtrasRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Route không tồn tại.' }));
  app.use(errorHandler);
  return app;
}

interface FakeUser {
  id: number;
  username: string;
  fullName: string;
  passwordHash: string;
  status: string;
  forceChangePassword: boolean;
  failedAttempts: number;
  lockedAt: Date | null;
  lockReason: string | null;
  deletedAt: Date | null;
  level2Hash: string | null;
  level2SetAt: Date | null;
  roleCodes: string[];
  permissions: string[];
}
interface FakeSession {
  id: string;
  userId: number;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  deviceInfo: string | null;
  deviceId?: string | null;
}

function applyData(target: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as object)) {
      target[k] = ((target[k] as number) ?? 0) + ((v as { increment: number }).increment ?? 0);
    } else {
      target[k] = v;
    }
  }
}
function statusOk(status: string, notIn?: string[]): boolean {
  return notIn ? !notIn.includes(status) : true;
}
// Nested roles→permissions shape mà loadAuthUser (_ctx.ts) mong đợi từ findUniqueOrThrow(include).
function withRoles(u: FakeUser): Record<string, unknown> {
  return {
    ...u,
    roles: u.roleCodes.map((code) => ({
      role: { code, status: 'ACTIVE', permissions: u.permissions.map((pc) => ({ permission: { code: pc } })) }
    }))
  };
}

function makeFakeDb(seed: FakeUser[]): { db: Db; users: FakeUser[]; sessions: FakeSession[]; audits: Record<string, unknown>[]; messages: Record<string, unknown>[] } {
  const users = seed.map((u) => ({ ...u }));
  const sessions: FakeSession[] = [];
  const audits: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];

  const fake = {
    user: {
      findFirst: async ({ where }: { where: { id?: number; username?: string; deletedAt?: Date | null } }) => {
        const u = users.find(
          (x) =>
            (where.id === undefined || x.id === where.id) &&
            (where.username === undefined || x.username === where.username) &&
            (where.deletedAt === undefined || x.deletedAt === where.deletedAt)
        );
        return u ? { ...u } : null;
      },
      findUnique: async ({ where }: { where: { id: number } }) => {
        const u = users.find((x) => x.id === where.id);
        return u ? { ...u } : null;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: number } }) => {
        const u = users.find((x) => x.id === where.id);
        if (!u) throw new Error('user not found');
        return withRoles(u);
      },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
        const u = users.find((x) => x.id === where.id);
        if (!u) throw new Error('user not found');
        applyData(u as unknown as Record<string, unknown>, data);
        return { ...u };
      },
      updateMany: async ({ where, data }: { where: { id: number; status?: { notIn?: string[] } }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const u of users) {
          if (u.id === where.id && statusOk(u.status, where.status?.notIn)) {
            applyData(u as unknown as Record<string, unknown>, data);
            count++;
          }
        }
        return { count };
      }
    },
    loginSession: {
      create: async ({ data }: { data: Partial<FakeSession> }) => {
        const s: FakeSession = {
          id: data.id!,
          userId: data.userId!,
          createdAt: data.createdAt ?? new Date(),
          expiresAt: data.expiresAt!,
          lastSeenAt: data.lastSeenAt ?? new Date(),
          deviceInfo: data.deviceInfo ?? null
        };
        sessions.push(s);
        return { ...s };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const s = sessions.find((x) => x.id === where.id);
        return s ? { ...s } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const s = sessions.find((x) => x.id === where.id);
        if (!s) throw new Error('session not found');
        applyData(s as unknown as Record<string, unknown>, data);
        return { ...s };
      },
      deleteMany: async ({ where }: { where: { id?: string | { not?: string }; userId?: number } }) => {
        const before = sessions.length;
        for (let i = sessions.length - 1; i >= 0; i--) {
          const s = sessions[i]!;
          const userMatch = where.userId === undefined || s.userId === where.userId;
          let idMatch = true;
          if (typeof where.id === 'string') idMatch = s.id === where.id;
          else if (where.id && typeof where.id === 'object' && 'not' in where.id) idMatch = s.id !== where.id.not;
          if (userMatch && idMatch) sessions.splice(i, 1);
        }
        return { count: before - sessions.length };
      },
      findMany: async ({ where }: { where: { expiresAt?: { gt: Date }; lastSeenAt?: { gt: Date } } }) => {
        const rows = sessions.filter(
          (s) =>
            (!where.expiresAt || s.expiresAt.getTime() > where.expiresAt.gt.getTime()) &&
            (!where.lastSeenAt || s.lastSeenAt.getTime() > where.lastSeenAt.gt.getTime())
        );
        // include user + orderBy createdAt desc
        return rows
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((s) => {
            const u = users.find((x) => x.id === s.userId);
            return { ...s, user: u ? { id: u.id, username: u.username, fullName: u.fullName } : null };
          });
      }
    },
    // Code thật chạy 3 câu SQL thô trên login_sessions (ghi phiên, chạm last_seen_at, đo thời gian ngồi không):
    // tầng ORM quy đổi timestamptz lệch 7 tiếng nên phải tính bằng now() của DB. Mẫu giả phải làm ĐÚNG 3 câu đó.
    $executeRawUnsafe: async (sql: string, ...args: unknown[]): Promise<number> => {
      if (/INSERT INTO login_sessions/i.test(sql)) {
        const [id, userId, ttl, deviceInfo, deviceId] = args as [string, number, string, string | null, string | null];
        const bayGio = new Date();
        sessions.push({
          id, userId, createdAt: bayGio, expiresAt: new Date(bayGio.getTime() + Number(ttl)),
          lastSeenAt: bayGio, deviceInfo: deviceInfo ?? null, deviceId: deviceId ?? null
        });
        return 1;
      }
      if (/UPDATE login_sessions SET last_seen_at/i.test(sql)) {
        const s = sessions.find((x) => x.id === (args[0] as string));
        if (!s) return 0;
        s.lastSeenAt = new Date();
        return 1;
      }
      throw new Error('mẫu giả CHƯA hỗ trợ câu SQL này, bổ sung đi (đừng để test xanh suông): ' + sql);
    },
    $queryRawUnsafe: async (sql: string, ...args: unknown[]): Promise<unknown[]> => {
      if (/EXTRACT\(EPOCH FROM \(now\(\) - last_seen_at\)\)/i.test(sql)) {
        const s = sessions.find((x) => x.id === (args[0] as string));
        return s ? [{ giay: Math.floor((Date.now() - s.lastSeenAt.getTime()) / 1000) }] : [];
      }
      // heartbeat: còn bao lâu nữa phiên tự đóng = cái NÀO ĐẾN TRƯỚC giữa "nghỉ quá lâu" và "trần 12h".
      if (/SELECT LEAST\(/i.test(sql) && /login_sessions/i.test(sql)) {
        const s = sessions.find((x) => x.id === (args[0] as string));
        if (!s) return [];
        const idlePhut = Number(args[1]);
        const bayGio = Date.now();
        const conNgoiKhong = (s.lastSeenAt.getTime() + idlePhut * 60_000 - bayGio) / 1000;
        const conTranPhien = (s.expiresAt.getTime() - bayGio) / 1000;
        return [{ giay: Math.trunc(Math.min(conNgoiKhong, conTranPhien)) }];
      }
      throw new Error('mẫu giả CHƯA hỗ trợ câu SQL này, bổ sung đi (đừng để test xanh suông): ' + sql);
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push({ ...data });
        return { ...data };
      }
    },
    message: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        messages.push({ ...data });
        return { ...data };
      }
    }
  };
  return { db: fake as unknown as Db, users, sessions, audits, messages };
}

const PASSWORD = 'CorrectPass1';
function seedUser(over: Partial<FakeUser> = {}): FakeUser {
  return {
    id: 1,
    username: 'alice',
    fullName: 'Alice Nguyen',
    passwordHash: hashPassword(PASSWORD),
    status: 'ACTIVE',
    forceChangePassword: false,
    failedAttempts: 0,
    lockedAt: null,
    lockReason: null,
    deletedAt: null,
    level2Hash: null,
    level2SetAt: null,
    roleCodes: [],
    permissions: [],
    ...over
  };
}

let ipCounter = 0;
let TEST_IP = '10.0.0.1';
beforeEach(() => {
  ipCounter++;
  TEST_IP = `10.9.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
});
afterEach(() => __setDbForTest(null));

async function loginCookie(app: ReturnType<typeof createApp>, username = 'alice', password = PASSWORD): Promise<string> {
  const res = await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).send({ username, password });
  expect(res.status).toBe(200);
  const setCookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
  return setCookie.split(';')[0]!;
}

// ───────────────────────── change-password ─────────────────────────
describe('POST /v1/auth/change-password', () => {
  it('mật khẩu cũ SAI → 409 WRONG_PASSWORD, hash không đổi', async () => {
    const { db, users } = makeFakeDb([seedUser()]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    const oldHash = users[0]!.passwordHash;
    const res = await request(app).post('/v1/auth/change-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ oldPassword: 'WrongOld9', newPassword: 'BrandNew123' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('WRONG_PASSWORD');
    expect(users[0]!.passwordHash).toBe(oldHash);
  });

  it('mật khẩu mới YẾU → 400 WEAK_PASSWORD', async () => {
    const { db } = makeFakeDb([seedUser()]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    const res = await request(app).post('/v1/auth/change-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ oldPassword: PASSWORD, newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('WEAK_PASSWORD');
  });

  it('mật khẩu mới TRÙNG mật khẩu cũ → 400 SAME_PASSWORD', async () => {
    const { db } = makeFakeDb([seedUser()]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    const res = await request(app).post('/v1/auth/change-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ oldPassword: PASSWORD, newPassword: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SAME_PASSWORD');
  });

  it('đúng → 200, hash MỚI khớp mật khẩu mới, forceChangePassword=false, THU HỒI phiên khác (giữ phiên hiện tại)', async () => {
    const { db, users, sessions } = makeFakeDb([seedUser({ forceChangePassword: true })]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    // Thêm 1 phiên KHÁC của cùng user (thiết bị khác) — phải bị thu hồi sau đổi mật khẩu.
    sessions.push({ id: 'other-device-sid', userId: 1, createdAt: new Date(), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date(), deviceInfo: 'other' });
    const res = await request(app).post('/v1/auth/change-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ oldPassword: PASSWORD, newPassword: 'BrandNew123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(verifyPassword('BrandNew123', users[0]!.passwordHash)).toBe(true);
    expect(users[0]!.forceChangePassword).toBe(false);
    // phiên khác bị xóa, phiên hiện tại còn.
    expect(sessions.some((s) => s.id === 'other-device-sid')).toBe(false);
    expect(sessions.length).toBe(1);
  });
});

// ───────────────────────── admin-reset-password ─────────────────────────
describe('POST /v1/auth/admin-reset-password', () => {
  function seedAdminAndTarget(): FakeUser[] {
    const admin = seedUser({ id: 1, username: 'admin', roleCodes: ['ADMIN'], permissions: ['USER_RESET_PASSWORD'] });
    const target = seedUser({ id: 2, username: 'bob', passwordHash: hashPassword('BobPass123'), status: 'LOCKED', lockReason: 'AUTH_FAILURE', lockedAt: new Date(), failedAttempts: 5 });
    return [admin, target];
  }

  it('KHÔNG quyền → 403 FORBIDDEN', async () => {
    const { db } = makeFakeDb([seedUser({ username: 'nobody', permissions: [] }), seedUser({ id: 2, username: 'bob' })]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app, 'nobody');
    const res = await request(app).post('/v1/auth/admin-reset-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ targetUserId: 2, newPassword: 'ResetPass123', actorPassword: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('mật khẩu actor SAI → 409 WRONG_PASSWORD, target không đổi', async () => {
    const { db, users } = makeFakeDb(seedAdminAndTarget());
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app, 'admin');
    const targetHash = users[1]!.passwordHash;
    const res = await request(app).post('/v1/auth/admin-reset-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ targetUserId: 2, newPassword: 'ResetPass123', actorPassword: 'WrongActor9' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('WRONG_PASSWORD');
    expect(users[1]!.passwordHash).toBe(targetHash);
  });

  it('đúng → 200, target hash mới + forceChangePassword=true + mở khóa AUTH_FAILURE', async () => {
    const { db, users } = makeFakeDb(seedAdminAndTarget());
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app, 'admin');
    const res = await request(app).post('/v1/auth/admin-reset-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ targetUserId: 2, newPassword: 'ResetPass123', actorPassword: PASSWORD });
    expect(res.status).toBe(200);
    expect(verifyPassword('ResetPass123', users[1]!.passwordHash)).toBe(true);
    expect(users[1]!.forceChangePassword).toBe(true);
    expect(users[1]!.status).toBe('ACTIVE');
    expect(users[1]!.lockReason).toBeNull();
  });

  it('target không tồn tại → 404 NOT_FOUND', async () => {
    const { db } = makeFakeDb([seedUser({ id: 1, username: 'admin', permissions: ['USER_RESET_PASSWORD'], roleCodes: ['ADMIN'] })]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app, 'admin');
    const res = await request(app).post('/v1/auth/admin-reset-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ targetUserId: 999, newPassword: 'ResetPass123', actorPassword: PASSWORD });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  // ── Chống leo-thang (privilege escalation): USER_RESET_PASSWORD do MANAGER cũng giữ → Manager KHÔNG được
  //    đặt lại (chiếm) mật khẩu tài khoản có quyền cao hơn mình. Cùng khuôn manager-containment updateUser dùng.
  const MANAGER_PERMS = ['USER_RESET_PASSWORD', 'USER_READ', 'USER_UPDATE'];

  it('MANAGER đặt lại mật khẩu ADMIN → 403 FORBIDDEN (chống leo-thang), target KHÔNG đổi + audit PERMISSION_DENIED', async () => {
    const manager = seedUser({ id: 1, username: 'manager', roleCodes: ['MANAGER'], permissions: MANAGER_PERMS });
    const admin = seedUser({ id: 2, username: 'bigboss', passwordHash: hashPassword('AdminPass123'), roleCodes: ['ADMIN'], permissions: [...MANAGER_PERMS, 'USER_CREATE', 'ROLE_ASSIGN'] });
    const { db, users, audits } = makeFakeDb([manager, admin]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app, 'manager');
    const targetHash = users[1]!.passwordHash;
    const res = await request(app).post('/v1/auth/admin-reset-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ targetUserId: 2, newPassword: 'ResetPass123', actorPassword: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(res.body.message).toBe('Không thể đặt lại mật khẩu tài khoản có quyền cao hơn bạn.');
    expect(users[1]!.passwordHash).toBe(targetHash); // KHÔNG bị chiếm
    expect(audits.some((a) => a['action'] === 'PERMISSION_DENIED' && JSON.parse((a['afterJson'] as string) ?? '{}').reason === 'TARGET_OUTRANKS_ACTOR')).toBe(true);
  });

  it('MANAGER đặt lại mật khẩu MANAGER ngang cấp (cùng quyền) → 200', async () => {
    const manager = seedUser({ id: 1, username: 'manager', roleCodes: ['MANAGER'], permissions: MANAGER_PERMS });
    const peer = seedUser({ id: 2, username: 'peer', passwordHash: hashPassword('PeerPass123'), roleCodes: ['MANAGER'], permissions: MANAGER_PERMS });
    const { db, users } = makeFakeDb([manager, peer]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app, 'manager');
    const res = await request(app).post('/v1/auth/admin-reset-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ targetUserId: 2, newPassword: 'ResetPass123', actorPassword: PASSWORD });
    expect(res.status).toBe(200);
    expect(verifyPassword('ResetPass123', users[1]!.passwordHash)).toBe(true);
  });

  it('MANAGER đặt lại mật khẩu nhân sự cấp thấp (quyền là tập con) → 200', async () => {
    const manager = seedUser({ id: 1, username: 'manager', roleCodes: ['MANAGER'], permissions: MANAGER_PERMS });
    const staff = seedUser({ id: 2, username: 'staff', passwordHash: hashPassword('StaffPass123'), roleCodes: ['STAFF'], permissions: ['USER_READ'] });
    const { db, users } = makeFakeDb([manager, staff]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app, 'manager');
    const res = await request(app).post('/v1/auth/admin-reset-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ targetUserId: 2, newPassword: 'ResetPass123', actorPassword: PASSWORD });
    expect(res.status).toBe(200);
    expect(verifyPassword('ResetPass123', users[1]!.passwordHash)).toBe(true);
  });
});

// ───────────────────────── level2 status / set / reset ─────────────────────────
describe('MẬT KHẨU CẤP 2 (level2)', () => {
  function seedL2User(over: Partial<FakeUser> = {}): FakeUser {
    return seedUser({ roleCodes: ['ADMIN'], permissions: ['LEVEL2_MANAGE'], ...over });
  }

  it('KHÔNG quyền LEVEL2_MANAGE → status 403', async () => {
    const { db } = makeFakeDb([seedUser({ permissions: [] })]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    const res = await request(app).get('/v1/auth/level2/status').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie);
    expect(res.status).toBe(403);
  });

  it('status chưa đặt → hasLevel2=false; SET đúng → 200; status sau đó → hasLevel2=true, hash khớp', async () => {
    const { db, users } = makeFakeDb([seedL2User()]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);

    const st0 = await request(app).get('/v1/auth/level2/status').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie);
    expect(st0.status).toBe(200);
    expect(st0.body.hasLevel2).toBe(false);

    const set = await request(app).post('/v1/auth/level2/set').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ level1: PASSWORD, newLevel2: 'Level2Pass9', confirmLevel2: 'Level2Pass9' });
    expect(set.status).toBe(200);
    expect(users[0]!.level2Hash).toBeTruthy();
    expect(verifyLevel2('Level2Pass9', users[0]!.level2Hash)).toBe(true);

    const st1 = await request(app).get('/v1/auth/level2/status').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie);
    expect(st1.body.hasLevel2).toBe(true);
  });

  it('SET với mật khẩu cấp 1 SAI → 409 WRONG_PASSWORD', async () => {
    const { db } = makeFakeDb([seedL2User()]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    const res = await request(app).post('/v1/auth/level2/set').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ level1: 'WrongLevel1', newLevel2: 'Level2Pass9', confirmLevel2: 'Level2Pass9' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('WRONG_PASSWORD');
  });

  it('SET khi ĐÃ có level2 → 400 ALREADY_SET', async () => {
    const { db } = makeFakeDb([seedL2User({ level2Hash: hashLevel2('Existing2Pass') })]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    const res = await request(app).post('/v1/auth/level2/set').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ level1: PASSWORD, newLevel2: 'Level2Pass9', confirmLevel2: 'Level2Pass9' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ALREADY_SET');
  });

  it('RESET: cấp 2 cũ SAI → 409 WRONG_LEVEL2', async () => {
    const { db } = makeFakeDb([seedL2User({ level2Hash: hashLevel2('OldLevel2Pass') })]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    const res = await request(app).post('/v1/auth/level2/reset').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ level1: PASSWORD, oldLevel2: 'WrongOldL2x', newLevel2: 'NewLevel2Pass9', confirmLevel2: 'NewLevel2Pass9' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('WRONG_LEVEL2');
  });

  it('RESET đúng → 200, hash cấp 2 đổi sang mới', async () => {
    const { db, users } = makeFakeDb([seedL2User({ level2Hash: hashLevel2('OldLevel2Pass') })]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    const res = await request(app).post('/v1/auth/level2/reset').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ level1: PASSWORD, oldLevel2: 'OldLevel2Pass', newLevel2: 'NewLevel2Pass9', confirmLevel2: 'NewLevel2Pass9' });
    expect(res.status).toBe(200);
    expect(verifyLevel2('NewLevel2Pass9', users[0]!.level2Hash)).toBe(true);
  });

  it('RESET khi CHƯA đặt level2 → 400 NOT_SET', async () => {
    const { db } = makeFakeDb([seedL2User()]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    const res = await request(app).post('/v1/auth/level2/reset').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ level1: PASSWORD, oldLevel2: 'x', newLevel2: 'NewLevel2Pass9', confirmLevel2: 'NewLevel2Pass9' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NOT_SET');
  });
});

// ───────────────────────── validate-password ─────────────────────────
describe('POST /v1/auth/validate-password', () => {
  it('mật khẩu đúng → 200 {ok:true}; sai → 200 {ok:false}', async () => {
    const { db } = makeFakeDb([seedUser()]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    const okRes = await request(app).post('/v1/auth/validate-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ password: PASSWORD });
    expect(okRes.status).toBe(200);
    expect(okRes.body.ok).toBe(true);
    const badRes = await request(app).post('/v1/auth/validate-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ password: 'nope' });
    expect(badRes.status).toBe(200);
    expect(badRes.body.ok).toBe(false);
  });
});

// ───────────────────────── B132 #1 brute-force (lockout re-auth + rate-limit 429) ─────────────────────────
describe('B132 #1 chống dò mật khẩu xác nhận thao tác (đóng CẢ LỚP)', () => {
  it('validate-password SAI liên tiếp → khóa tài khoản ở lần thứ MAX (AUTH_FAILURE); lần thứ 6 → 429 RATE_LIMITED', async () => {
    const { db, users } = makeFakeDb([seedUser()]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    // 5 lần sai (đúng ngưỡng MAX_FAILED_ATTEMPTS=5), trong hạn rate-limit 5/phút.
    for (let i = 1; i <= 5; i++) {
      const r = await request(app).post('/v1/auth/validate-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ password: 'WrongNope9' });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(false);
    }
    // Lần thứ 5 chạm ngưỡng → tài khoản bị khóa TẠM (feed lockout như login).
    expect(users[0]!.status).toBe('LOCKED');
    expect(users[0]!.lockReason).toBe('AUTH_FAILURE');
    // Lần thứ 6 vượt trần rate-limit 5/phút/phiên → 429 (lớp mạng độc lập với lockout tài khoản).
    const sixth = await request(app).post('/v1/auth/validate-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ password: 'WrongNope9' });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toBe('RATE_LIMITED');
  });

  // Admin Demo 13/11: "#58..#62: Bạn đã thử mật khẩu quá nhiều lần" khi DUYỆT HỦY HÀNG LOẠT — mỗi phiếu là 1 request
  // kèm mật khẩu ĐÚNG, quá 5 phiếu/phút là chết. Trần phải tính theo lần SAI, không phải mọi lần gọi.
  it('mật khẩu ĐÚNG 12 lần liên tiếp trong 1 phút → KHÔNG lần nào bị 429 (xoá/duyệt hàng loạt chạy được)', async () => {
    const { db, users } = makeFakeDb([seedUser()]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    for (let i = 1; i <= 12; i++) {
      const r = await request(app).post('/v1/auth/validate-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ password: PASSWORD });
      expect(`lần ${i}: status ${r.status}`).toBe(`lần ${i}: status 200`);
      expect(r.body.ok).toBe(true);
    }
    expect(users[0]!.failedAttempts).toBe(0);
    expect(users[0]!.status).toBe('ACTIVE');
  });

  // Đối chứng: xen kẽ SAI vẫn phải tính — 5 lần SAI là chặn, dù ở giữa có những lần ĐÚNG.
  it('xen kẽ ĐÚNG/SAI: đủ 5 lần SAI trong 1 phút → lần SAI thứ 6 vẫn 429 (vá KHÔNG mở toang dò mật khẩu)', async () => {
    const { db } = makeFakeDb([seedUser()]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    const goi = (mk: string) => request(app).post('/v1/auth/validate-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ password: mk });
    for (let i = 1; i <= 5; i++) {
      await goi(PASSWORD);              // đúng — không được tính vào trần
      const sai = await goi('WrongNope9');
      expect(`sai lần ${i}: ${sai.status}`).toBe(`sai lần ${i}: 200`);
    }
    const quaTran = await goi('WrongNope9');
    expect(quaTran.status).toBe(429);
    expect(quaTran.body.error).toBe('RATE_LIMITED');
  });

  it('change-password SAI mật khẩu cũ cũng feed lockout (verify verifyActorPassword-class đóng CẢ LỚP)', async () => {
    const { db, users } = makeFakeDb([seedUser()]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    // 4 lần sai (dưới trần rate-limit 5) → failedAttempts tăng dần, chưa khóa.
    for (let i = 1; i <= 4; i++) {
      const r = await request(app).post('/v1/auth/change-password').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie).send({ oldPassword: 'WrongOld9', newPassword: 'BrandNew123' });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('WRONG_PASSWORD');
    }
    expect(users[0]!.failedAttempts).toBe(4);
    expect(users[0]!.status).toBe('ACTIVE'); // chưa chạm ngưỡng
  });
});

// ───────────────────────── B132 #2 forceChangePassword gate ─────────────────────────
describe('B132 #2 forceChangePassword gate (chặn mọi route nghiệp vụ khi còn buộc đổi mật khẩu)', () => {
  it('phiên có cờ forceChangePassword → route nghiệp vụ 403 MUST_CHANGE_PASSWORD; /me vẫn 200 (allowlist)', async () => {
    const { db } = makeFakeDb([seedUser({ forceChangePassword: true })]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    // heartbeat = route nghiệp vụ (KHÔNG thuộc allowlist me/change-password/logout) → 403.
    const hb = await request(app).post('/v1/auth/heartbeat').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie);
    expect(hb.status).toBe(403);
    expect(hb.body.error).toBe('MUST_CHANGE_PASSWORD');
    // /me thuộc allowlist → vẫn xem được hồ sơ.
    const me = await request(app).get('/v1/auth/me').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('alice');
  });
});

// ───────────────────────── heartbeat + online-users ─────────────────────────
describe('heartbeat + online-users', () => {
  it('heartbeat với phiên hợp lệ → 200 {ok:true}; không cookie → 401', async () => {
    const { db } = makeFakeDb([seedUser()]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    const ok = await request(app).post('/v1/auth/heartbeat').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    const no = await request(app).post('/v1/auth/heartbeat').set('X-Forwarded-For', TEST_IP);
    expect(no.status).toBe(401);
  });

  it('online-users (USER_READ) → liệt kê user đang đăng nhập', async () => {
    const { db } = makeFakeDb([seedUser({ permissions: ['USER_READ'], roleCodes: ['ADMIN'] })]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    const res = await request(app).get('/v1/auth/online-users').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((u: { username: string }) => u.username === 'alice')).toBe(true);
  });

  it('online-users KHÔNG quyền USER_READ → 403', async () => {
    const { db } = makeFakeDb([seedUser({ permissions: [] })]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginCookie(app);
    const res = await request(app).get('/v1/auth/online-users').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie);
    expect(res.status).toBe(403);
  });
});
