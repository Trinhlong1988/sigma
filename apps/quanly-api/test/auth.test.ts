// AUDIT-VÁ security (4/8) — test khẳng định TỪNG lớp phòng thủ của 7 finding. KHÔNG cần Postgres thật: bơm 1
// Db GIẢ in-memory qua __setDbForTest (db.ts) + gọi createApp() thật qua supertest. Cạnh duy nhất bị giả là
// tầng Prisma (in-memory), toàn bộ middleware CORS/rate-limit/cookie + logic khóa/mở/timing/session-revoke chạy
// THẬT. (Timing enumeration #4 kiểm bằng tương đương HÀNH VI — độ trễ wall-clock không unit-test ổn định được.)
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rawPhienStub } from './_raw-phien.js';
import type { Db } from '@sigma/database';
import { hashPassword } from '@sigma/business-rules';
import { createApp } from '../src/app.js';
import { __setDbForTest } from '../src/db.js';

// ───────────────────────── Fake Prisma in-memory ─────────────────────────
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
  // B132 A1-1: loadAuthUser include roles→permissions — login/me giờ trả full AuthUser.
  roles: { role: { code: string; status: string; permissions: { permission: { code: string } }[] } }[];
}
interface FakeSession {
  id: string;
  userId: number;
  expiresAt: Date;
  lastSeenAt: Date;
  deviceInfo: string | null;
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

function makeFakeDb(seedUsers: FakeUser[]): { db: Db; users: FakeUser[]; sessions: FakeSession[]; audits: Record<string, unknown>[] } {
  const users = seedUsers.map((u) => ({ ...u }));
  const sessions: FakeSession[] = [];
  const audits: Record<string, unknown>[] = [];

  const fake = {
    // [13/11] auth.ts ghi/chạm/đo phiên bằng SQL THÔ (băm phiên 12/11) — thiếu stub là login nổ 500,
    // kéo cả file đỏ CÂM. Stub dùng chung, câu lạ thì NÉM LỖI chứ không trả rỗng.
    ...rawPhienStub(sessions),
    user: {
      findFirst: async ({ where }: { where: { username?: string; deletedAt?: Date | null } }) => {
        const u = users.find((x) => (where.username === undefined || x.username === where.username) && (where.deletedAt === undefined || x.deletedAt === where.deletedAt));
        return u ? { ...u } : null;
      },
      findUnique: async ({ where }: { where: { id: number } }) => {
        const u = users.find((x) => x.id === where.id);
        return u ? { ...u } : null;
      },
      // B132 A1-1: loadAuthUser dùng findUniqueOrThrow({include:{roles...}}) — trả user kèm roles.
      findUniqueOrThrow: async ({ where }: { where: { id: number } }) => {
        const u = users.find((x) => x.id === where.id);
        if (!u) throw new Error('user not found');
        return { ...u };
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
      create: async ({ data }: { data: FakeSession }) => {
        sessions.push({ ...data });
        return { ...data };
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
      // Khớp shape Prisma thật: where có thể là {id} HOẶC {userId, id:{not}} (B132 #3 single-session revoke).
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
      }
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push({ ...data });
        return { ...data };
      }
    }
  };
  return { db: fake as unknown as Db, users, sessions, audits };
}

const PASSWORD = 'CorrectPass1';
function seedActiveUser(): FakeUser {
  return { id: 1, username: 'alice', fullName: 'Alice Nguyễn', passwordHash: hashPassword(PASSWORD), status: 'ACTIVE', forceChangePassword: false, failedAttempts: 0, lockedAt: null, lockReason: null, deletedAt: null, roles: [{ role: { code: 'ADMIN', status: 'ACTIVE', permissions: [{ permission: { code: 'CUSTOMER_VIEW' } }] } }] };
}

// loginRateLimiter là store IN-MEMORY module-global (dùng chung mọi test). Cho MỖI test 1 IP client RIÊNG qua
// X-Forwarded-For (trust proxy=1 → req.ip đọc header này) để không test nào ăn trần rate-limit của test trước —
// ĐỒNG THỜI kiểm luôn `trust proxy` đọc đúng IP thật sau Cloudflare.
let ipCounter = 0;
let TEST_IP = '10.0.0.1';
beforeEach(() => {
  ipCounter++;
  TEST_IP = `10.0.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
});

afterEach(() => __setDbForTest(null));

// ───────────────────────── #1 CORS allowlist ─────────────────────────
describe('#1 CORS allowlist (không còn reflect-all)', () => {
  const app = createApp();
  it('origin domain thật → phản chiếu ACAO + Allow-Credentials true', async () => {
    const origin = 'https://alpha-quanly-api.example.com';
    const res = await request(app).get('/v1/health').set('Origin', origin);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
  it('origin loopback http (bản desktop 127.0.0.1:<cổng ngẫu nhiên>) → phản chiếu ACAO', async () => {
    const origin = 'http://127.0.0.1:49812';
    const res = await request(app).get('/v1/health').set('Origin', origin);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
  });
  it('origin LẠ → KHÔNG phản chiếu ACAO (bị chặn)', async () => {
    const res = await request(app).get('/v1/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('origin GIẢ DẠNG loopback (127.0.0.1.evil.com, regex neo $) → KHÔNG phản chiếu', async () => {
    const res = await request(app).get('/v1/health').set('Origin', 'http://127.0.0.1.evil.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// ───────────────────────── #6 cookie SameSite=None; Secure ─────────────────────────
describe('#6 login đúng → cookie ql_session SameSite=None; Secure; HttpOnly', () => {
  it('200 + Set-Cookie đầy đủ thuộc tính cross-site', async () => {
    __setDbForTest(makeFakeDb([seedActiveUser()]).db);
    const app = createApp();
    const res = await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).send({ username: 'alice', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, user: { id: 1, username: 'alice' } });
    const setCookie = (res.headers['set-cookie'] as unknown as string[]).join('; ');
    expect(setCookie).toContain('ql_session=');
    expect(setCookie).toMatch(/SameSite=None/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/HttpOnly/i);
  });
});

// ───────────────────────── #2b lockout theo tài khoản ─────────────────────────
describe('#2b sai mật khẩu N lần → tự khóa + lần kế bị chặn', () => {
  it('5 lần sai → lần 5 trả 423 STATUS_LOCKED, user LOCKED; correct sau đó vẫn 423 (đang khóa, chưa qua cooldown)', async () => {
    const { db, users } = makeFakeDb([seedActiveUser()]);
    __setDbForTest(db);
    const app = createApp();
    for (let i = 1; i <= 4; i++) {
      const r = await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).send({ username: 'alice', password: 'wrong' });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('INVALID_CREDENTIALS');
    }
    expect(users[0]!.failedAttempts).toBe(4);
    // Lần thứ 5 chạm ngưỡng → khóa.
    const fifth = await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).send({ username: 'alice', password: 'wrong' });
    expect(fifth.status).toBe(423);
    expect(fifth.body.error).toBe('STATUS_LOCKED');
    expect(users[0]!.status).toBe('LOCKED');
    expect(users[0]!.lockReason).toBe('AUTH_FAILURE');
    // Mật khẩu ĐÚNG ngay sau đó nhưng chưa qua cooldown 15' → decideLogin chặn (STATUS_LOCKED) → 423.
    const correct = await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).send({ username: 'alice', password: PASSWORD });
    expect(correct.status).toBe(423);
    expect(correct.body.error).toBe('STATUS_LOCKED');
  });

  it('auto-unlock: khóa AUTH_FAILURE quá cooldown + mật khẩu đúng → 200 (tự mở)', async () => {
    const locked = seedActiveUser();
    locked.status = 'LOCKED';
    locked.lockReason = 'AUTH_FAILURE';
    locked.lockedAt = new Date(Date.now() - 16 * 60 * 1000); // 16' trước > cooldown 15'
    locked.failedAttempts = 5;
    const { db, users } = makeFakeDb([locked]);
    __setDbForTest(db);
    const app = createApp();
    const res = await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).send({ username: 'alice', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(users[0]!.status).toBe('ACTIVE');
    expect(users[0]!.failedAttempts).toBe(0);
  });

  it('khóa TAY của admin (ADMIN_LOCK) KHÔNG tự mở dù mật khẩu đúng → 423', async () => {
    const locked = seedActiveUser();
    locked.status = 'LOCKED';
    locked.lockReason = 'ADMIN_LOCK';
    locked.lockedAt = new Date(Date.now() - 60 * 60 * 1000);
    const { db, users } = makeFakeDb([locked]);
    __setDbForTest(db);
    const app = createApp();
    const res = await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).send({ username: 'alice', password: PASSWORD });
    expect(res.status).toBe(423);
    expect(users[0]!.status).toBe('LOCKED');
  });
});

// ───────────────────────── #4 timing/username enumeration (tương đương hành vi) ─────────────────────────
describe('#4 user không tồn tại vs sai mật khẩu → phản hồi KHÔNG PHÂN BIỆT', () => {
  it('cả hai đều 401 INVALID_CREDENTIALS (không lộ user tồn tại hay không)', async () => {
    __setDbForTest(makeFakeDb([seedActiveUser()]).db);
    const app = createApp();
    const noUser = await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).send({ username: 'ghost', password: 'whatever' });
    const wrongPw = await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).send({ username: 'alice', password: 'wrong' });
    expect(noUser.status).toBe(401);
    expect(wrongPw.status).toBe(401);
    expect(noUser.body.error).toBe('INVALID_CREDENTIALS');
    expect(wrongPw.body.error).toBe('INVALID_CREDENTIALS');
    expect(noUser.body.message).toBe(wrongPw.body.message);
  });
});

// ───────────────────────── #3 session revoke khi user LOCKED/DISABLED/deleted ─────────────────────────
describe('#3 phiên bị thu hồi giữa chừng khi user không còn ACTIVE', () => {
  async function loginAndGetSid(app: ReturnType<typeof createApp>): Promise<string> {
    const res = await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).send({ username: 'alice', password: PASSWORD });
    expect(res.status).toBe(200);
    const setCookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    return setCookie.split(';')[0]!; // "ql_session=<id>"
  }

  it('phiên hợp lệ → /me 200; sau khi user bị LOCKED → /me 401 SESSION_REVOKED + phiên bị xóa', async () => {
    const { db, users, sessions } = makeFakeDb([seedActiveUser()]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginAndGetSid(app);

    const okMe = await request(app).get('/v1/auth/me').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie);
    expect(okMe.status).toBe(200);
    expect(okMe.body.user.username).toBe('alice');

    users[0]!.status = 'LOCKED'; // admin khóa giữa phiên
    const revoked = await request(app).get('/v1/auth/me').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error).toBe('SESSION_REVOKED');
    expect(sessions.length).toBe(0); // phiên đã bị revoke khỏi DB
  });

  it('user bị xóa mềm (deletedAt) giữa phiên → /me 401 SESSION_REVOKED', async () => {
    const { db, users } = makeFakeDb([seedActiveUser()]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginAndGetSid(app);
    users[0]!.deletedAt = new Date();
    const res = await request(app).get('/v1/auth/me').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('SESSION_REVOKED');
  });

  it('DISABLED giữa phiên → /me 401 SESSION_REVOKED', async () => {
    const { db, users } = makeFakeDb([seedActiveUser()]);
    __setDbForTest(db);
    const app = createApp();
    const cookie = await loginAndGetSid(app);
    users[0]!.status = 'DISABLED';
    const res = await request(app).get('/v1/auth/me').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('SESSION_REVOKED');
  });

  it('không cookie → /me 401 NO_SESSION', async () => {
    __setDbForTest(makeFakeDb([seedActiveUser()]).db);
    const app = createApp();
    const res = await request(app).get('/v1/auth/me').set('X-Forwarded-For', TEST_IP);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('NO_SESSION');
  });
});

// ───────────────────────── #2a rate-limit theo IP ─────────────────────────
describe('#2a rate-limit /v1/auth/login (10/phút/IP)', () => {
  it('quá 10 request/phút → 429 RATE_LIMITED', async () => {
    // Dùng user KHÔNG tồn tại để tách khỏi lockout theo-tài-khoản — chỉ đo trần rate-limit thuần.
    __setDbForTest(makeFakeDb([]).db);
    const app = createApp();
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).send({ username: 'ghost', password: 'x' });
      expect(r.status).toBe(401); // trong ngưỡng
    }
    const blocked = await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).send({ username: 'ghost', password: 'x' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('RATE_LIMITED');
  });
});

// ───────────────────────── B132 #3 single-session (R46) ─────────────────────────
describe('B132 #3 login mới THU HỒI mọi phiên khác của user (single-session R46)', () => {
  it('login lần 2 → phiên 1 bị xóa; /me bằng cookie phiên 1 → 401, cookie phiên 2 → 200', async () => {
    const { db, sessions } = makeFakeDb([seedActiveUser()]);
    __setDbForTest(db);
    const app = createApp();
    const r1 = await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).send({ username: 'alice', password: PASSWORD });
    expect(r1.status).toBe(200);
    const cookie1 = (r1.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    expect(sessions.length).toBe(1);

    const r2 = await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).send({ username: 'alice', password: PASSWORD });
    expect(r2.status).toBe(200);
    const cookie2 = (r2.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    // Phiên 1 bị thu hồi → chỉ còn đúng 1 phiên (phiên 2).
    expect(sessions.length).toBe(1);

    const me1 = await request(app).get('/v1/auth/me').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie1);
    expect(me1.status).toBe(401); // phiên 1 đã bị đá
    const me2 = await request(app).get('/v1/auth/me').set('X-Forwarded-For', TEST_IP).set('Cookie', cookie2);
    expect(me2.status).toBe(200);
    expect(me2.body.user.username).toBe('alice');
  });
});

// ───────────────────────── #5 audit log LOGIN_SUCCESS / LOGIN_FAILED ─────────────────────────
describe('#5 ghi audit LOGIN_SUCCESS / LOGIN_FAILED (username, IP, user-agent, reason)', () => {
  it('login đúng → audit LOGIN_SUCCESS; login sai → audit LOGIN_FAILED có reason + UA', async () => {
    const { db, audits } = makeFakeDb([seedActiveUser()]);
    __setDbForTest(db);
    const app = createApp();
    await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).set('User-Agent', 'JestUA/1.0').send({ username: 'alice', password: PASSWORD });
    await request(app).post('/v1/auth/login').set('X-Forwarded-For', TEST_IP).set('User-Agent', 'JestUA/1.0').send({ username: 'alice', password: 'wrong' });
    const success = audits.find((a) => a['action'] === 'LOGIN_SUCCESS');
    const failed = audits.find((a) => a['action'] === 'LOGIN_FAILED');
    expect(success).toBeTruthy();
    expect(failed).toBeTruthy();
    expect(success!['deviceInfo']).toBe('JestUA/1.0');
    expect(String(failed!['afterJson'])).toContain('INVALID_CREDENTIALS');
  });
});
