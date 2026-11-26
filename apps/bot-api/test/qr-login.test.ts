// SIGMA (3/8) — Test bảo mật đăng nhập bằng quét QR động (routes/qr-login.ts + qr-login-service.ts) qua
// createApp() thật + DB throwaway thật. 4/8 hoàn tất LOẠI RC — luồng QR mint phiên ĐỘC LẬP RC nên KHÔNG còn
// chạm rc-client (không cần mock). Mọi ràng buộc threat-model được ASSERT GIÁ TRỊ THẬT (không chỉ ok:true).
//
// Ca bắt buộc: (a) token hết hạn → từ chối; (b) sai/thiếu pollSecret → KHÔNG claim được phiên; (c) approve khi
// chưa auth → 401; (d) phiên cấp đúng agent ĐÃ DUYỆT (không phải input); (e) 1-lần-dùng; (f) rate-limit;
// (g) token thô KHÔNG nằm trong DB (chỉ hash); (h) approve sai code → từ chối; (i) sai code 3 lần → hủy;
// (j) matchCode KHÔNG lộ qua /info.
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

// 4/8 hoàn tất LOẠI RC khỏi auth — phiên đăng nhập QR mint ĐỘC LẬP RC (rcAuthToken null), route KHÔNG còn gọi
// rcCreateLoginTokenForUser (hàm đã bị gỡ export). KHÔNG mock rc-client — luồng QR không chạm rc-client nữa.
import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { createChallenge, cleanupExpired, CHALLENGE_TTL_MS, MAX_APPROVE_ATTEMPTS } from '../src/qr-login-service.js';
import { __resetLockoutStateForTest } from '../src/qr-approve-lockout.js';
import { createHash } from 'node:crypto';
import { makeAgent } from './fixtures.js';

const app = createApp();

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const QR_COOKIE = '__Host-sigma_qr';

/** Lấy cookie pollSecret (__Host-sigma_qr) từ Set-Cookie của response create. */
function extractQrCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const c = (raw ?? []).find((x) => x.startsWith(`${QR_COOKIE}=`));
  if (!c) throw new Error(`Không tìm thấy cookie ${QR_COOKIE} trong response create`);
  return c.split(';')[0]; // "__Host-sigma_qr=<value>"
}

/** Giá trị pollSecret thô trong cookie header "__Host-sigma_qr=<value>". */
function cookieValue(cookie: string): string {
  return cookie.slice(cookie.indexOf('=') + 1);
}

/** Tạo 1 phiên điện thoại đã đăng nhập (WebSession thật cho 1 agent) → trả cookie header dùng cho request auth. */
async function makePhoneSession(): Promise<{ agentId: number; cookie: string; rcUserId: string }> {
  const db = getBotDb();
  const rcUserId = `rc-phone-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const agent = await makeAgent(undefined, { rcUsername: `phone_${Date.now()}`, name: 'Điện thoại chủ' });
  await db.agent.update({ where: { id: agent.id }, data: { rcUserId } });
  // #3 (6/8) — điện thoại DUYỆT QR là nền 'apk' (đúng mô hình Zalo: quét bằng ĐIỆN THOẠI để đăng nhập MÁY
  // KHÁC web/exe). Đặt platform='apk' để phiên điện thoại KHÔNG bị đá bởi phiên /status mint (nền 'web' qua
  // supertest) — single-session-per-platform CHỈ đá cùng nền, nền khác giữ nguyên. Thiếu cột này (null) →
  // effective platform suy từ userAgent null = 'web' → sẽ TRÙNG nền máy /status → điện thoại bị đá oan.
  const ws = await createWebSession(db, { rcUserId, rcUsername: agent.rcUsername, rcAuthToken: 'phone-rc-token', agentId: agent.id, platform: 'apk' });
  return { agentId: agent.id, cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, rcUserId };
}

function authHeaders(cookie: string): Record<string, string> {
  return { Cookie: cookie, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
}

describe('QR login — create + status (máy tạo QR)', () => {
  beforeEach(() => {
    __resetLockoutStateForTest(); // tránh lockout in-memory dồn giữa các ca (dù agentId thường unique).
  });

  it('create → trả token + matchCode 2 chữ số, set cookie pollSecret httpOnly; status ban đầu = pending', async () => {
    const res = await request(app).post('/v1/auth/qr/create').send({});
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(20);
    expect(res.body.matchCode).toMatch(/^\d{2}$/);
    const setCookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(setCookie).toContain('__Host-sigma_qr='); // AUDIT-vá #2: tiền tố __Host- (host-only, chống fixation)
    expect(setCookie).toMatch(/HttpOnly/i);
    // FIX 6/8 (đồng bộ với routes/qr-login.ts) — cookie QR ĐÃ đổi Strict→None để chạy được từ vỏ exe (127.0.0.1)
    // / APK (capacitor) cross-site với api.example.com (xem chú thích setPollSecretCookie). Test cũ còn assert
    // Strict → ĐÃ LỖI SẴN trên base trước task #3 này; sửa cho khớp hành vi thật (KHÔNG liên quan đá-phiên).
    expect(setCookie).toMatch(/SameSite=None/i);
    expect(setCookie).toMatch(/Secure/i); // __Host- BẮT BUỘC Secure

    const cookie = extractQrCookie(res);
    const status = await request(app).get('/v1/auth/qr/status').set('Cookie', cookie);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('pending');
  });

  // (g) token thô KHÔNG nằm trong DB — chỉ hash.
  it('(g) token thô KHÔNG lưu DB — chỉ tokenHash (sha256); pollSecret cũng chỉ lưu hash', async () => {
    const res = await request(app).post('/v1/auth/qr/create').send({});
    const token: string = res.body.token;
    const cookie = extractQrCookie(res);
    const pollSecret = cookieValue(cookie);

    const db = getBotDb();
    const rowByRaw = await db.qrLoginChallenge.findFirst({ where: { tokenHash: token } });
    expect(rowByRaw).toBeNull(); // token THÔ không phải là giá trị lưu
    const rowByHash = await db.qrLoginChallenge.findUnique({ where: { tokenHash: sha256(token) } });
    expect(rowByHash).not.toBeNull();
    // pollSecret thô cũng không xuất hiện dạng thô trong DB
    const anyRawPoll = await db.qrLoginChallenge.findFirst({ where: { pollSecretHash: pollSecret } });
    expect(anyRawPoll).toBeNull();
    expect(rowByHash!.pollSecretHash).toBe(sha256(pollSecret));
  });

  // (b) sai/thiếu pollSecret → KHÔNG claim được phiên.
  it('(b) status KHÔNG có cookie pollSecret → expired, KHÔNG cấp cookie phiên; sai pollSecret cũng vậy', async () => {
    // Dựng 1 challenge đã APPROVED cho pollSecret P, nhưng gọi status KHÔNG kèm cookie / kèm cookie SAI.
    const phone = await makePhoneSession();
    const created = await request(app).post('/v1/auth/qr/create').send({});
    const token: string = created.body.token;
    const code: string = created.body.matchCode;
    await request(app).post('/v1/auth/qr/approve').set(authHeaders(phone.cookie)).send({ token, code });

    // KHÔNG cookie → expired (không tìm thấy hàng nào theo hash rỗng).
    const noCookie = await request(app).get('/v1/auth/qr/status');
    expect(noCookie.body.status).toBe('expired');
    expect(noCookie.headers['set-cookie']).toBeUndefined();

    // Cookie SAI (giá trị bịa) → expired, KHÔNG set cookie phiên sigma_ws.
    const wrong = await request(app).get('/v1/auth/qr/status').set('Cookie', `${QR_COOKIE}=khong-phai-poll-secret-that`);
    expect(wrong.body.status).toBe('expired');
    const sc = (wrong.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    expect(sc.some((c) => c.startsWith(`${WEB_SESSION_COOKIE_NAME}=`))).toBe(false);
  });

  // (a) token hết hạn → từ chối (approve + info + status pending không nhận).
  it('(a) token hết hạn → approve từ chối 410, info 410', async () => {
    const phone = await makePhoneSession();
    const db = getBotDb();
    const created = await createChallenge(db, {});
    // Ép hết hạn: đẩy expiresAt về quá khứ.
    await db.qrLoginChallenge.updateMany({ where: { tokenHash: sha256(created.token) }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const info = await request(app).get('/v1/auth/qr/info').query({ token: created.token }).set(authHeaders(phone.cookie));
    expect(info.status).toBe(410);
    expect(info.body.error).toBe('QR_EXPIRED');

    const appr = await request(app).post('/v1/auth/qr/approve').set(authHeaders(phone.cookie)).send({ token: created.token, code: created.matchCode });
    expect(appr.status).toBe(410);
    expect(appr.body.error).toBe('QR_EXPIRED');
  });

  // (d) phiên cấp ra đúng agent đã duyệt (không phải input) + (e) 1-lần-dùng.
  it('(d)(e) approve→status: phiên cấp đúng agent đã duyệt; consume 1-lần-dùng (status lần 2 KHÔNG cấp lại)', async () => {
    const phone = await makePhoneSession();

    const created = await request(app).post('/v1/auth/qr/create').send({});
    const cookie = extractQrCookie(created);
    const token: string = created.body.token;
    const code: string = created.body.matchCode;

    // Điện thoại (đã auth) duyệt — KHÔNG truyền agentId trong body (server lấy từ phiên).
    const appr = await request(app).post('/v1/auth/qr/approve').set(authHeaders(phone.cookie)).send({ token, code, agentId: 999999 });
    expect(appr.status).toBe(200);
    expect(appr.body.ok).toBe(true);

    // Máy tạo QR poll status → approved + set cookie phiên sigma_ws.
    const status1 = await request(app).get('/v1/auth/qr/status').set('Cookie', cookie);
    expect(status1.body.status).toBe('approved');
    const sc = status1.headers['set-cookie'] as unknown as string[];
    const wsCookie = sc.find((c) => c.startsWith(`${WEB_SESSION_COOKIE_NAME}=`));
    expect(wsCookie).toBeDefined();

    // 4/8 LOẠI RC — phiên QR mint ĐỘC LẬP RC (session rcAuthToken null, khẳng định bên dưới).

    // Phiên vừa cấp phải trỏ đúng agentId đã duyệt (không phải agentId input 999999) + độc lập RC.
    const db = getBotDb();
    const wsId = wsCookie!.split('=')[1].split(';')[0];
    const wsRow = await db.webSession.findUnique({ where: { id: wsId } });
    expect(wsRow).not.toBeNull();
    expect(wsRow!.agentId).toBe(phone.agentId);
    expect(wsRow!.rcAuthToken).toBeNull();

    // (e) 1-lần-dùng: challenge đã CONSUMED; poll status lần 2 KHÔNG cấp phiên nữa (không set sigma_ws).
    const status2 = await request(app).get('/v1/auth/qr/status').set('Cookie', cookie);
    expect(status2.body.status).toBe('expired');
    const sc2 = (status2.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    expect(sc2.some((c) => c.startsWith(`${WEB_SESSION_COOKIE_NAME}=`))).toBe(false);
    const chRow = await db.qrLoginChallenge.findUnique({ where: { tokenHash: sha256(token) } });
    expect(chRow!.status).toBe('CONSUMED');
  });

  it('nhật ký sự kiện (item 8): sau đăng nhập QR, /v1/auth/qr/events trả 1 sự kiện với IP/UA/time', async () => {
    const phone = await makePhoneSession();
    const created = await request(app).post('/v1/auth/qr/create').set('User-Agent', 'JestUA/1.0').send({});
    const cookie = extractQrCookie(created);
    await request(app).post('/v1/auth/qr/approve').set(authHeaders(phone.cookie)).send({ token: created.body.token, code: created.body.matchCode });
    await request(app).get('/v1/auth/qr/status').set('Cookie', cookie);

    const events = await request(app).get('/v1/auth/qr/events').set(authHeaders(phone.cookie));
    expect(events.status).toBe(200);
    expect(Array.isArray(events.body.events)).toBe(true);
    expect(events.body.events.length).toBeGreaterThanOrEqual(1);
    expect(events.body.events[0]).toHaveProperty('consumedAt');
    expect(events.body.events[0]).toHaveProperty('approxLocation');
  });
});

describe('QR login — auth guards + matchCode', () => {
  // (c) approve/info khi CHƯA auth → 401.
  it('(c) approve khi chưa auth (không cookie phiên) → 401', async () => {
    const created = await createChallenge(getBotDb(), {});
    // Thiếu cả CSRF header lẫn cookie phiên.
    const appr = await request(app).post('/v1/auth/qr/approve').send({ token: created.token, code: created.matchCode });
    expect([401, 403]).toContain(appr.status); // 403 nếu chặn CSRF trước, 401 nếu thiếu phiên
    // Có CSRF nhưng KHÔNG cookie phiên → 401 SESSION_INVALID.
    const appr2 = await request(app).post('/v1/auth/qr/approve').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE).send({ token: created.token, code: created.matchCode });
    expect(appr2.status).toBe(401);
    // Challenge vẫn PENDING (không bị duyệt).
    const row = await getBotDb().qrLoginChallenge.findUnique({ where: { tokenHash: sha256(created.token) } });
    expect(row!.status).toBe('PENDING');
  });

  it('(c) info khi chưa auth → 401', async () => {
    const created = await createChallenge(getBotDb(), {});
    const info = await request(app).get('/v1/auth/qr/info').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE).query({ token: created.token });
    expect(info.status).toBe(401);
  });

  // (h) approve sai code → từ chối, không cấp phiên; challenge vẫn PENDING (còn thử được).
  it('(h) approve sai matchCode → 400 QR_WRONG_CODE, challenge KHÔNG được duyệt', async () => {
    const phone = await makePhoneSession();
    const created = await createChallenge(getBotDb(), {});
    const wrong = String((Number(created.matchCode) + 1) % 100).padStart(2, '0');
    const appr = await request(app).post('/v1/auth/qr/approve').set(authHeaders(phone.cookie)).send({ token: created.token, code: wrong });
    expect(appr.status).toBe(400);
    expect(appr.body.error).toBe('QR_WRONG_CODE');
    expect(appr.body.attemptsRemaining).toBe(MAX_APPROVE_ATTEMPTS - 1);
    const row = await getBotDb().qrLoginChallenge.findUnique({ where: { tokenHash: sha256(created.token) } });
    expect(row!.status).toBe('PENDING');
    expect(row!.agentId).toBeNull();
  });

  // (i) sai code đủ ngưỡng (MAX_APPROVE_ATTEMPTS=5) → challenge HỦY + agent bị TẠM KHÓA (Admin Demo "như Zalo");
  // code đúng sau đó bị 423 QR_LOCKED (tính năng tạm khóa), KHÔNG chỉ 409 của challenge.
  it('(i) sai matchCode đủ ngưỡng → CANCELLED + agent tạm khóa; code ĐÚNG sau đó bị 423 QR_LOCKED', async () => {
    const phone = await makePhoneSession();
    const created = await createChallenge(getBotDb(), {});
    const wrong = String((Number(created.matchCode) + 1) % 100).padStart(2, '0');
    // MAX-1 lần đầu → WRONG_CODE
    for (let i = 1; i < MAX_APPROVE_ATTEMPTS; i++) {
      const r = await request(app).post('/v1/auth/qr/approve').set(authHeaders(phone.cookie)).send({ token: created.token, code: wrong });
      expect(r.body.error, `lần sai ${i}`).toBe('QR_WRONG_CODE');
    }
    // lần thứ MAX → CANCELLED (challenge hủy)
    const rLast = await request(app).post('/v1/auth/qr/approve').set(authHeaders(phone.cookie)).send({ token: created.token, code: wrong });
    expect(rLast.status).toBe(409);
    expect(rLast.body.error).toBe('QR_CANCELLED');
    const row = await getBotDb().qrLoginChallenge.findUnique({ where: { tokenHash: sha256(created.token) } });
    expect(row!.status).toBe('CANCELLED');

    // Agent GIỜ bị tạm khóa → mọi approve tiếp theo (kể cả code đúng) → 423 QR_LOCKED kèm retryAfterMs.
    const rGood = await request(app).post('/v1/auth/qr/approve').set(authHeaders(phone.cookie)).send({ token: created.token, code: created.matchCode });
    expect(rGood.status).toBe(423);
    expect(rGood.body.error).toBe('QR_LOCKED');
    expect(rGood.body.retryAfterMs).toBeGreaterThan(0);
    const row2 = await getBotDb().qrLoginChallenge.findUnique({ where: { tokenHash: sha256(created.token) } });
    expect(row2!.status).toBe('CANCELLED');
    expect(row2!.agentId).toBeNull();
  });

  // (j) matchCode KHÔNG lộ qua /info.
  it('(j) /info KHÔNG trả matchCode (buộc đọc trên PC)', async () => {
    const phone = await makePhoneSession();
    const created = await createChallenge(getBotDb(), { requesterIp: '127.0.0.1', requesterUa: 'PC-Chrome' });
    const info = await request(app).get('/v1/auth/qr/info').query({ token: created.token }).set(authHeaders(phone.cookie));
    expect(info.status).toBe(200);
    expect(info.body).not.toHaveProperty('matchCode');
    expect(JSON.stringify(info.body)).not.toContain(created.matchCode === '00' ? '"00"' : `"${created.matchCode}"`);
    // Có trả IP/UA/vị trí gần đúng cho màn xác nhận.
    expect(info.body.requesterIp).toBe('127.0.0.1');
    expect(info.body.requesterUa).toBe('PC-Chrome');
    expect(info.body.approxLocation).toBe('Mạng nội bộ (LAN)');
  });
});

// ── AUDIT-vá 4 finding (security-audit độc lập 3/8) ─────────────────────────────────────────────────────────
// ĐẶT TRƯỚC describe 'rate-limit' (describe đó CỐ Ý tiêu cạn ngân sách create 60/IP của process — nếu để sau,
// mọi POST /create ở đây sẽ 429). Cumulative create ở đây nhỏ (~6), tổng cả file vẫn < 60.
describe('QR login — audit hardening (vá 4 finding)', () => {
  // #1 [MEDIUM] cleanupExpired KHÔNG được xoá hàng CONSUMED (nhật ký đăng nhập-qua-QR, mục 8) — trước vá bị
  // deleteMany xoá luôn sau ~120s → /qr/events luôn rỗng.
  it('#1 cleanupExpired giữ nhật ký CONSUMED dù challenge đã quá TTL (/qr/events vẫn còn)', async () => {
    const phone = await makePhoneSession();
    const created = await request(app).post('/v1/auth/qr/create').send({});
    const cookie = extractQrCookie(created);
    await request(app).post('/v1/auth/qr/approve').set(authHeaders(phone.cookie)).send({ token: created.body.token, code: created.body.matchCode });
    await request(app).get('/v1/auth/qr/status').set('Cookie', cookie); // consume → CONSUMED

    const db = getBotDb();
    // Mô phỏng trôi qua TTL 120s: đẩy expiresAt của hàng CONSUMED về QUÁ KHỨ (consumedAt giữ gần đây).
    await db.qrLoginChallenge.updateMany({ where: { tokenHash: sha256(created.body.token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await cleanupExpired(db); // TRƯỚC vá: xoá luôn hàng CONSUMED này → /qr/events rỗng.

    const events = await request(app).get('/v1/auth/qr/events').set(authHeaders(phone.cookie));
    expect(events.status).toBe(200);
    expect(events.body.events.length).toBeGreaterThanOrEqual(1); // nhật ký PHẢI còn
  });

  // #2 [MEDIUM] chống session-fixation: pollSecret LẠ (không sở hữu challenge sống) bị THAY bằng secret mới.
  it('#2 /create với pollSecret bị ghim (không có challenge sống) → server sinh pollSecret MỚI, không echo lại', async () => {
    const planted = 'attacker-planted-poll-secret-abc123';
    const res = await request(app).post('/v1/auth/qr/create').set('Cookie', `${QR_COOKIE}=${planted}`).send({});
    expect(res.status).toBe(200);
    expect(cookieValue(extractQrCookie(res))).not.toBe(planted); // KHÔNG ngồi lên secret bị ghim
    // status với chính secret bị ghim → KHÔNG claim được gì (server đã dùng secret mới, khác planted).
    const status = await request(app).get('/v1/auth/qr/status').set('Cookie', `${QR_COOKIE}=${planted}`);
    expect(status.body.status).toBe('expired');
  });

  // #2 mặt tích cực: pollSecret ĐANG sở hữu challenge sống → tái dùng (xoay token giữ nguyên máy + matchCode).
  it('#2 /create tái dùng pollSecret khi đang sở hữu challenge sống (xoay token, giữ matchCode)', async () => {
    const first = await request(app).post('/v1/auth/qr/create').send({});
    const cookie = extractQrCookie(first);
    const second = await request(app).post('/v1/auth/qr/create').set('Cookie', cookie).send({});
    expect(cookieValue(extractQrCookie(second))).toBe(cookieValue(cookie)); // GIỮ pollSecret
    expect(second.body.matchCode).toBe(first.body.matchCode); // GIỮ mã người dùng đang đọc
    expect(second.body.token).not.toBe(first.body.token); // token XOAY (mới)
  });

  // #3 [LOW] ngân sách đoán matchCode đếm theo NHÓM pollSecret — xoay token KHÔNG reset về 0.
  it('#3 sai (MAX-1) lần → xoay token → sai lần MAX vẫn CANCELLED (ngân sách theo nhóm pollSecret, không reset khi xoay)', async () => {
    const phone = await makePhoneSession();
    const first = await request(app).post('/v1/auth/qr/create').send({});
    const cookie = extractQrCookie(first);
    const token1: string = first.body.token;
    const matchCode: string = first.body.matchCode;
    const wrong = String((Number(matchCode) + 1) % 100).padStart(2, '0');

    // Sai (MAX-1) lần trên token1 → luôn WRONG_CODE, ngân sách nhóm tăng dần.
    for (let i = 1; i < MAX_APPROVE_ATTEMPTS; i++) {
      const r = await request(app).post('/v1/auth/qr/approve').set(authHeaders(phone.cookie)).send({ token: token1, code: wrong });
      expect(r.body.error, `lần sai ${i}`).toBe('QR_WRONG_CODE');
      expect(r.body.attemptsRemaining).toBe(MAX_APPROVE_ATTEMPTS - i);
    }

    // XOAY token: create lại CÙNG cookie → token2 mới, cùng pollSecret + matchCode.
    const second = await request(app).post('/v1/auth/qr/create').set('Cookie', cookie).send({});
    const token2: string = second.body.token;
    expect(second.body.matchCode).toBe(matchCode);
    expect(token2).not.toBe(token1);

    // Sai lần MAX trên TOKEN MỚI → ngân sách nhóm = MAX → CANCELLED (KHÔNG được reset nhờ xoay token).
    const rMax = await request(app).post('/v1/auth/qr/approve').set(authHeaders(phone.cookie)).send({ token: token2, code: wrong });
    expect(rMax.status).toBe(409);
    expect(rMax.body.error).toBe('QR_CANCELLED');

    // Token CŨ cũng bị hủy theo nhóm; ngoài ra agent giờ đã tạm khóa → mã ĐÚNG trên token cũ → 423 QR_LOCKED.
    const rGood = await request(app).post('/v1/auth/qr/approve').set(authHeaders(phone.cookie)).send({ token: token1, code: matchCode });
    expect(rGood.status).toBe(423);
    expect(rGood.body.error).toBe('QR_LOCKED');
  });

  // #4 [LOW] /qr/events có rate-limit theo agent.
  it('#4 /qr/events vượt trần theo agent → 429', async () => {
    const rlApp = createApp();
    const phone = await makePhoneSession(); // agent MỚI (id duy nhất) → ngân sách events tươi 60/15p
    for (let i = 0; i < 60; i++) {
      const r = await request(rlApp).get('/v1/auth/qr/events').set(authHeaders(phone.cookie));
      expect(r.status).toBe(200);
    }
    const over = await request(rlApp).get('/v1/auth/qr/events').set(authHeaders(phone.cookie));
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('RATE_LIMITED');
  });
});

// (f) rate-limit create/approve — dùng app RIÊNG để bộ đếm limiter (module-level, theo process) không bị test
// khác ăn mòn. create khóa theo IP; approve khóa theo agent.
describe('QR login — rate-limit', () => {
  it('(f) create vượt trần theo IP → 429', async () => {
    const rlApp = createApp();
    // createLimiter là MODULE-LEVEL (đếm theo process, KHÓA theo IP 127.0.0.1 — dùng chung mọi app instance +
    // các test create ở describe trên đã tiêu 1 phần budget 60/15p). KHÔNG đòi đúng 60 lần đầu 200; thay vào đó
    // bắn tối đa 65 lần và khẳng định: (1) ít nhất lần đầu 200 (limiter chưa chặn ngay), (2) CÓ xuất hiện 429
    // với đúng error RATE_LIMITED (trần được thực thi theo IP).
    let firstStatus = 0;
    let saw429 = false;
    let body429: { error?: string } | null = null;
    for (let i = 0; i < 65; i++) {
      const r = await request(rlApp).post('/v1/auth/qr/create').send({});
      if (i === 0) firstStatus = r.status;
      if (r.status === 429) {
        saw429 = true;
        body429 = r.body;
        break;
      }
      expect(r.status).toBe(200);
    }
    expect(firstStatus).toBe(200);
    expect(saw429).toBe(true);
    expect(body429?.error).toBe('RATE_LIMITED');
  });

  it('(f) approve vượt trần theo agent → 429', async () => {
    const rlApp = createApp();
    const phone = await makePhoneSession();
    // limit 30/15p — bắn 30 approve (token bịa → 404 vẫn tính vào limiter) rồi lần 31 = 429.
    for (let i = 0; i < 30; i++) {
      const r = await request(rlApp).post('/v1/auth/qr/approve').set(authHeaders(phone.cookie)).send({ token: `khong-ton-tai-${i}`, code: '00' });
      expect(r.status).toBe(404);
    }
    const over = await request(rlApp).post('/v1/auth/qr/approve').set(authHeaders(phone.cookie)).send({ token: 'x', code: '00' });
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('RATE_LIMITED');
  });
});
