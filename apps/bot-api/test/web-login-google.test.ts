// SIGMA Phase 1 "bỏ Rocket.Chat" (28/7) — test POST /v1/auth/web-login/google. Mock CẢ rc-client.js (không
// gọi Rocket.Chat thật) LẪN google-oauth-service.js (không verify ID token Google thật — đã có unit test riêng
// google-oauth-service.test.ts cho phần đó, ở đây chỉ test route/DB orchestration).
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 4/8 hoàn tất LOẠI RC khỏi auth — mock CHỈ các hàm rc-client CÒN export (rcLogin/rcLogout/
// rcGetUserTotpEnabled/rcCreateLoginTokenForUser đã bị gỡ export). Đăng nhập Google mint phiên ĐỘC LẬP RC,
// KHÔNG gọi hàm RC nào.
vi.mock('../src/rc-client.js', () => ({
  rcGetMe: vi.fn(),
  rcCreateUser: vi.fn(),
  rcDeleteUser: vi.fn(),
  rcSetUserPassword: vi.fn(),
  resetRcAdminAuthCache: vi.fn()
}));
vi.mock('../src/google-oauth-service.js', () => ({ verifyGoogleIdToken: vi.fn() }));

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { rcCreateUser } from '../src/rc-client.js';
import { verifyGoogleIdToken } from '../src/google-oauth-service.js';
import { getWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { USERNAME_REGEX } from '@sigma/shared';

function cookieValue(setCookieHeader: unknown, name: string): string | undefined {
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [String(setCookieHeader)] : [];
  for (const c of arr) {
    const m = c.match(new RegExp(`${name}=([^;]+)`));
    if (m) return m[1];
  }
  return undefined;
}

function uniqEmail(): string {
  return `google_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`;
}

describe('POST /v1/auth/web-login/google', () => {
  const app = createApp();

  beforeEach(() => {
    vi.mocked(verifyGoogleIdToken).mockReset();
    vi.mocked(rcCreateUser).mockReset();
  });

  it('thiếu idToken → 400 VALIDATION, KHÔNG gọi verifyGoogleIdToken', async () => {
    const res = await request(app).post('/v1/auth/web-login/google').send({});
    expect(res.status).toBe(400);
    expect(verifyGoogleIdToken).not.toHaveBeenCalled();
  });

  it('verifyGoogleIdToken CONFIG_MISSING → 500 GOOGLE_CLIENT_ID_NOT_CONFIGURED', async () => {
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ ok: false, kind: 'CONFIG_MISSING', message: 'Thiếu GOOGLE_CLIENT_ID.' });
    const res = await request(app).post('/v1/auth/web-login/google').send({ idToken: 'bat-ky' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('GOOGLE_CLIENT_ID_NOT_CONFIGURED');
  });

  it('verifyGoogleIdToken INVALID_TOKEN → 401 GOOGLE_TOKEN_INVALID', async () => {
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ ok: false, kind: 'INVALID_TOKEN', message: 'het han' });
    const res = await request(app).post('/v1/auth/web-login/google').send({ idToken: 'token-gia' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('GOOGLE_TOKEN_INVALID');
  });

  it('email_verified:false → 401 GOOGLE_EMAIL_NOT_VERIFIED, KHÔNG tạo Agent', async () => {
    const db = getBotDb();
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ ok: true, data: { googleId: 'g-unverified-1', email: 'chuaverify@example.com', emailVerified: false, name: 'Chua Verify' } });
    const res = await request(app).post('/v1/auth/web-login/google').send({ idToken: 'token-chua-verify' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('GOOGLE_EMAIL_NOT_VERIFIED');
    expect(await db.agent.count({ where: { googleId: 'g-unverified-1' } })).toBe(0);
  });

  // 4/8 LOẠI RC — tạo Agent Google MỚI ĐỘC LẬP RC: KHÔNG gọi rcCreateUser, rcUserId null, passwordHash null.
  it('googleId + email đều CHƯA có Agent nào → tạo Agent MỚI độc lập RC (KHÔNG rcCreateUser, rcUserId null, passwordHash null), isNewAccount:true, set cookie', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ ok: true, data: { googleId: 'g-new-1', email, emailVerified: true, name: 'Nguoi Dung Moi' } });

    const res = await request(app).post('/v1/auth/web-login/google').send({ idToken: 'token-hop-le' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, isNewAccount: true });
    expect(rcCreateUser).not.toHaveBeenCalled();
    const agent = await db.agent.findFirstOrThrow({ where: { googleId: 'g-new-1' } });
    expect(agent.email).toBe(email);
    expect(agent.rcUserId).toBeNull();
    expect(agent.passwordHash).toBeNull(); // Agent Google-only — KHÔNG có mật khẩu nội bộ

    const sid = cookieValue(res.headers['set-cookie'], WEB_SESSION_COOKIE_NAME);
    const session = await getWebSession(db, sid!);
    expect(session!.agentId).toBe(agent.id);
    expect(session!.rcAuthToken).toBeNull(); // phiên độc lập RC
  });

  it('email ĐÃ có Agent cũ (đăng ký local trước đó, googleId chưa set) → AUTO-LINK (set googleId), KHÔNG tạo Agent mới/KHÔNG gọi rcCreateUser', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const existing = await db.agent.create({ data: { name: 'Da Dang Ky Truoc', email, rcUserId: 'rc-existing-1', rcUsername: 'daexisting1' } });
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ ok: true, data: { googleId: 'g-link-1', email, emailVerified: true, name: 'Da Dang Ky Truoc' } });

    const res = await request(app).post('/v1/auth/web-login/google').send({ idToken: 'token-hop-le' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, isNewAccount: false });
    expect(rcCreateUser).not.toHaveBeenCalled();
    const updated = await db.agent.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.googleId).toBe('g-link-1');
  });

  // AUDIT FIX (MEDIUM, độc lập 28/7) — race 2 request auto-link CÙNG email đồng thời (Agent cũ đã tồn tại,
  // chưa link googleId) từng thiếu try/catch P2002, có thể văng 500 cho request thua thay vì phục hồi.
  it('race 2 request auto-link đồng thời CÙNG email Agent cũ → cả 2 vẫn 200, googleId chỉ set 1 lần đúng', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const existing = await db.agent.create({ data: { name: 'Agent Cu Race', email, rcUserId: 'rc-race-link-1', rcUsername: 'racelink1' } });
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ ok: true, data: { googleId: 'g-race-link-1', email, emailVerified: true, name: 'Agent Cu Race' } });

    const [res1, res2] = await Promise.all([
      request(app).post('/v1/auth/web-login/google').send({ idToken: 'token-hop-le' }),
      request(app).post('/v1/auth/web-login/google').send({ idToken: 'token-hop-le' })
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const updated = await db.agent.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.googleId).toBe('g-race-link-1');
    expect(rcCreateUser).not.toHaveBeenCalled(); // KHÔNG tạo Agent mới, chỉ auto-link cái cũ
  });

  it('googleId ĐÃ có Agent (đã từng login Google trước đó) → login thẳng, KHÔNG gọi rcCreateUser, KHÔNG update gì thêm', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const existing = await db.agent.create({ data: { name: 'Google User Cu', email, rcUserId: 'rc-google-old-1', rcUsername: 'googleold1', googleId: 'g-old-1' } });
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ ok: true, data: { googleId: 'g-old-1', email, emailVerified: true, name: 'Google User Cu' } });

    const res = await request(app).post('/v1/auth/web-login/google').send({ idToken: 'token-hop-le' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, isNewAccount: false });
    expect(rcCreateUser).not.toHaveBeenCalled();
    const sid = cookieValue(res.headers['set-cookie'], WEB_SESSION_COOKIE_NAME);
    const session = await getWebSession(db, sid!);
    expect(session!.agentId).toBe(existing.id);
  });

  // 4/8 LOẠI RC — thay test cũ "rcCreateUser thất bại": giờ đăng nhập Google KHÔNG gọi rcCreateUser. Test auto-
  // link cho Agent ĐỘC LẬP RC (rcUserId null, vd đăng ký local sau 4/8) → login Google gán googleId + phiên độc lập.
  it('email ĐÃ có Agent độc lập RC (rcUserId null) → AUTO-LINK googleId, 200 phiên độc lập RC (KHÔNG rcCreateUser)', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const existing = await db.agent.create({ data: { name: 'Local Doc Lap', email, rcUsername: `local_${Date.now()}_${Math.random().toString(36).slice(2)}` } });
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ ok: true, data: { googleId: 'g-link-independent-1', email, emailVerified: true, name: 'Local Doc Lap' } });

    const res = await request(app).post('/v1/auth/web-login/google').send({ idToken: 'token-hop-le' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, isNewAccount: false });
    expect(rcCreateUser).not.toHaveBeenCalled();
    const updated = await db.agent.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.googleId).toBe('g-link-independent-1');
    const sid = cookieValue(res.headers['set-cookie'], WEB_SESSION_COOKIE_NAME);
    const session = await getWebSession(db, sid!);
    expect(session!.agentId).toBe(existing.id);
    expect(session!.rcAuthToken).toBeNull();
  });

  // 4/8 LOẠI RC — rcUserId null giờ là trạng thái BÌNH THƯỜNG (tài khoản tạo độc lập RC) — KHÔNG còn 500
  // AGENT_RC_LINK_MISSING; đăng nhập Google mint phiên độc lập RC (rcAuthToken null).
  it('Agent tồn tại CHƯA có rcUserId (tài khoản độc lập RC) → 200 + phiên độc lập RC (KHÔNG còn 500 AGENT_RC_LINK_MISSING)', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const existing = await db.agent.create({ data: { name: 'Khong RC Link', email, googleId: 'g-no-rc-1' } });
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ ok: true, data: { googleId: 'g-no-rc-1', email, emailVerified: true, name: 'Khong RC Link' } });

    const res = await request(app).post('/v1/auth/web-login/google').send({ idToken: 'token-hop-le' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, isNewAccount: false });
    const sid = cookieValue(res.headers['set-cookie'], WEB_SESSION_COOKIE_NAME);
    const session = await getWebSession(db, sid!);
    expect(session!.agentId).toBe(existing.id);
    expect(session!.rcAuthToken).toBeNull();
  });

  // 4/8 LOẠI RC — race tạo Agent Google MỚI: KHÔNG còn rcCreateUser. Phục hồi P2002 nằm ở agent.create
  // (createAgentViaGoogle) — đúng 1 Agent được tạo, request thua dùng lại hàng thắng.
  it('race 2 request đồng thời CÙNG email/googleId MỚI → chỉ đúng 1 Agent được tạo, request thua vẫn 200 (dùng lại Agent thắng)', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ ok: true, data: { googleId: 'g-race-1', email, emailVerified: true, name: 'Race Case' } });

    const [res1, res2] = await Promise.all([
      request(app).post('/v1/auth/web-login/google').send({ idToken: 'token-hop-le' }),
      request(app).post('/v1/auth/web-login/google').send({ idToken: 'token-hop-le' })
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(rcCreateUser).not.toHaveBeenCalled();
    const count = await db.agent.count({ where: { googleId: 'g-race-1' } });
    expect(count).toBe(1); // đúng 1 Agent được tạo dù 2 request cùng chạy
  });

  // BUG 14/8 (Admin Demo "đăng nhập lần đầu bằng gmail, xem QR báo chưa liên kết, không có QR") — tài khoản Google
  // PHẢI được cấp rcUsername (@handle) để có QR/hồ sơ/tag. Trước fix rcUsername=null → 3 tính năng chết.
  it('tài khoản Google MỚI → được cấp rcUsername hợp lệ (USERNAME_REGEX) để tạo được QR/hồ sơ/tag', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ ok: true, data: { googleId: 'g-handle-new-1', email, emailVerified: true, name: 'Nguyễn Văn Ánh' } });

    const res = await request(app).post('/v1/auth/web-login/google').send({ idToken: 'token-hop-le' });

    expect(res.status).toBe(200);
    const agent = await db.agent.findFirstOrThrow({ where: { googleId: 'g-handle-new-1' } });
    expect(agent.rcUsername).toBeTruthy();
    expect(USERNAME_REGEX.test(agent.rcUsername!)).toBe(true); // [A-Za-z0-9]{8,} — dùng làm /app/u/:username cho QR
    expect(agent.rcUsername!.startsWith('nguyenvananh')).toBe(true); // sinh từ tên đã bỏ dấu
  });

  it('tài khoản Google CŨ đang rcUsername=null → BACKFILL @handle ngay lần đăng nhập kế (self-heal, không cần script)', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const existing = await db.agent.create({ data: { name: 'Le Thi Bồ Câu', email, googleId: 'g-backfill-1' } }); // rcUsername NULL
    expect(existing.rcUsername).toBeNull();
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ ok: true, data: { googleId: 'g-backfill-1', email, emailVerified: true, name: 'Le Thi Bồ Câu' } });

    const res = await request(app).post('/v1/auth/web-login/google').send({ idToken: 'token-hop-le' });

    expect(res.status).toBe(200);
    const healed = await db.agent.findUniqueOrThrow({ where: { id: existing.id } });
    expect(healed.rcUsername).toBeTruthy();
    expect(USERNAME_REGEX.test(healed.rcUsername!)).toBe(true);
  });

  it('2 tài khoản Google TRÙNG tên → @handle KHÁC nhau (né trùng bằng hậu tố, không vỡ @unique)', async () => {
    const db = getBotDb();
    const e1 = uniqEmail(), e2 = uniqEmail();
    vi.mocked(verifyGoogleIdToken).mockResolvedValueOnce({ ok: true, data: { googleId: 'g-dup-a', email: e1, emailVerified: true, name: 'Trung Ten' } });
    await request(app).post('/v1/auth/web-login/google').send({ idToken: 't1' });
    vi.mocked(verifyGoogleIdToken).mockResolvedValueOnce({ ok: true, data: { googleId: 'g-dup-b', email: e2, emailVerified: true, name: 'Trung Ten' } });
    await request(app).post('/v1/auth/web-login/google').send({ idToken: 't2' });

    const a = await db.agent.findFirstOrThrow({ where: { googleId: 'g-dup-a' } });
    const b = await db.agent.findFirstOrThrow({ where: { googleId: 'g-dup-b' } });
    expect(a.rcUsername).toBeTruthy();
    expect(b.rcUsername).toBeTruthy();
    expect(a.rcUsername).not.toBe(b.rcUsername); // @unique giữ, handle thứ 2 có hậu tố
  });
});
