// SIGMA — test 3 route đăng nhập/đăng xuất qua bot-api: web-login / web-login/totp / web-logout.
// 4/8 hoàn tất LOẠI RC khỏi luồng ĐĂNG NHẬP agent: xác thực mật khẩu đi ĐƯỜNG NỘI BỘ (bcrypt, password-service)
// — Agent PHẢI có `passwordHash` thật (seed bằng hashPassword, KHÔNG mock rcLogin). Thành công → mint phiên ĐỘC
// LẬP RC (WebSession, rcAuthToken = null) + set cookie httpOnly `sigma_ws`. KHÔNG còn TOTP_REQUIRED (RC cắt
// hẳn) và KHÔNG còn 502-hạ-tầng-RC. web-logout chỉ revoke WebSession nội bộ + clear cookie (KHÔNG gọi rcLogout).
//
// rc-client.js được mock CHỈ với các hàm CÒN export (rcLogin/rcLogout/rcGetUserTotpEnabled/
// rcCreateLoginTokenForUser đã bị gỡ) — các luồng test dưới đây KHÔNG chạm hàm RC nào; mock chỉ để chặn mọi
// khả năng gọi Rocket.Chat thật qua các route khác được wire trong createApp().
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/rc-client.js', () => ({
  rcGetMe: vi.fn(),
  rcCreateUser: vi.fn(),
  rcDeleteUser: vi.fn(),
  rcSetUserPassword: vi.fn(),
  resetRcAdminAuthCache: vi.fn()
}));

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, getWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { hashPassword } from '../src/password-service.js';

function cookieValue(setCookieHeader: unknown, name: string): string | undefined {
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [String(setCookieHeader)] : [];
  for (const c of arr) {
    const m = c.match(new RegExp(`${name}=([^;]+)`));
    if (m) return m[1];
  }
  return undefined;
}

// Email/username DUY NHẤT TOÀN CỤC — email @unique + rcUsername @unique trên throwaway DB dùng chung cả suite;
// sinh ngẫu nhiên để KHÔNG đụng unique constraint giữa các ca/giữa các file (tránh tự gây "DB pollution").
function uniqEmail(): string {
  return `weblogin_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`;
}
function uniqUsername(): string {
  return `wl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

const PASSWORD = 'MatKhauNoiBo123!'; // ≥8 ký tự, hợp lệ theo validator đăng ký.

/** Seed 1 Agent CÓ passwordHash thật (đường nội bộ checkAgentPassword khớp). */
async function seedAgentWithPassword(opts: { rcUserId?: string | null } = {}) {
  const db = getBotDb();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return db.agent.create({
    data: {
      name: 'Web Login Agent',
      email: uniqEmail(),
      rcUserId: opts.rcUserId ?? `rc-wl-${suffix}`,
      rcUsername: uniqUsername(),
      passwordHash: await hashPassword(PASSWORD)
    }
  });
}

describe('POST /v1/auth/web-login', () => {
  const app = createApp();

  it('mật khẩu ĐÚNG (Agent có passwordHash) → 200 {ok:true}, set cookie sigma_ws httpOnly, phiên ĐỘC LẬP RC (rcAuthToken null), agentId đúng', async () => {
    const db = getBotDb();
    const agent = await seedAgentWithPassword({ rcUserId: 'rc-web-1' });

    const res = await request(app).post('/v1/auth/web-login').send({ identifier: agent.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true }); // KHÔNG lộ authToken/hash/userId trong body
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toMatch(/sigma_ws=/);
    expect(String(setCookie)).toMatch(/HttpOnly/i);

    const sid = cookieValue(setCookie, WEB_SESSION_COOKIE_NAME);
    const session = await getWebSession(db, sid!);
    expect(session).not.toBeNull();
    expect(session!.agentId).toBe(agent.id);
    expect(session!.rcAuthToken).toBeNull(); // phiên độc lập RC
    expect(session!.rcUserId).toBe('rc-web-1'); // đọc thẳng từ agent (giữ link cũ nếu có), KHÔNG round-trip RC
  });

  it('SAI mật khẩu → 401 {ok:false, kind:"ERROR"} + message tiếng Việt, KHÔNG set cookie', async () => {
    const agent = await seedAgentWithPassword();

    const res = await request(app).post('/v1/auth/web-login').send({ identifier: agent.email, password: 'SaiMatKhau999!' });

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.kind).toBe('ERROR');
    expect(res.body.message).toBe('Sai email/số điện thoại hoặc mật khẩu.');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('email KHÔNG tồn tại Agent nào → 401 {ok:false, kind:"ERROR"} (dummy bcrypt cân bằng timing), KHÔNG set cookie', async () => {
    const res = await request(app).post('/v1/auth/web-login').send({ identifier: uniqEmail(), password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.kind).toBe('ERROR');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('Agent tồn tại nhưng CHƯA có passwordHash (Google-only/legacy) → 401 (không có đường mật khẩu nội bộ), KHÔNG set cookie', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    await db.agent.create({ data: { name: 'No Password Agent', email, rcUsername: uniqUsername(), passwordHash: null } });

    const res = await request(app).post('/v1/auth/web-login').send({ identifier: email, password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.kind).toBe('ERROR');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('thiếu identifier/password → 400 VALIDATION', async () => {
    const res = await request(app).post('/v1/auth/web-login').send({ identifier: uniqEmail() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });
});

// POST /v1/auth/web-login/totp — GIỮ để tương thích client CŨ (trước đây gọi sau khi web-login trả TOTP_REQUIRED).
// 4/8 LOẠI RC — không còn 2FA-qua-RC; route chỉ còn xác thực identifier+password NỘI BỘ (field `code` client cũ
// gửi kèm bị BỎ QUA), hành xử y hệt web-login. Test khẳng định: gửi kèm `code` vẫn 200 khi mật khẩu đúng, và
// route KHÔNG còn đòi `code` (thiếu code vẫn qua được, chỉ cần identifier+password).
describe('POST /v1/auth/web-login/totp (tương thích client cũ — bỏ qua code)', () => {
  const app = createApp();

  it('mật khẩu ĐÚNG (gửi kèm code cũ) → 200 {ok:true} + set cookie; code bị bỏ qua', async () => {
    const agent = await seedAgentWithPassword();

    const res = await request(app).post('/v1/auth/web-login/totp').send({ identifier: agent.email, password: PASSWORD, code: '123456' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(String(res.headers['set-cookie'])).toMatch(/sigma_ws=/);
  });

  it('mật khẩu ĐÚNG, KHÔNG gửi code → vẫn 200 {ok:true} (route không còn đòi code)', async () => {
    const agent = await seedAgentWithPassword();

    const res = await request(app).post('/v1/auth/web-login/totp').send({ identifier: agent.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(String(res.headers['set-cookie'])).toMatch(/sigma_ws=/);
  });

  it('SAI mật khẩu → 401 {ok:false, kind:"ERROR"}, KHÔNG set cookie', async () => {
    const agent = await seedAgentWithPassword();

    const res = await request(app).post('/v1/auth/web-login/totp').send({ identifier: agent.email, password: 'SaiRoi999!', code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.kind).toBe('ERROR');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('thiếu identifier/password → 400 VALIDATION', async () => {
    const res = await request(app).post('/v1/auth/web-login/totp').send({ identifier: uniqEmail() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });
});

describe('POST /v1/auth/web-logout', () => {
  const app = createApp();

  it('có cookie session hợp lệ → 200 {ok:true}, revoke WebSession trong DB + clear cookie (KHÔNG gọi rcLogout)', async () => {
    const db = getBotDb();
    const agent = await seedAgentWithPassword();
    // Phiên ĐỘC LẬP RC (rcAuthToken null) — đúng hình dạng phiên sau 4/8.
    const created = await createWebSession(db, { rcUserId: agent.rcUserId, rcUsername: agent.rcUsername, rcAuthToken: null, agentId: agent.id });

    const res = await request(app).post('/v1/auth/web-logout').set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${created.id}`).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await getWebSession(db, created.id)).toBeNull(); // đã revoke thật trong DB
    expect(String(res.headers['set-cookie'])).toMatch(new RegExp(`${WEB_SESSION_COOKIE_NAME}=;`)); // clearCookie
  });

  it('KHÔNG có cookie nào → vẫn 200 {ok:true} (idempotent)', async () => {
    const res = await request(app).post('/v1/auth/web-logout').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('cookie trỏ tới session KHÔNG tồn tại (đã hết hạn/thu hồi từ trước) → vẫn 200 {ok:true}', async () => {
    const res = await request(app).post('/v1/auth/web-logout').set('Cookie', `${WEB_SESSION_COOKIE_NAME}=khong-ton-tai`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
