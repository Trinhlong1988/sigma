// Test tích hợp 3 route mới (routes/auth.ts) qua createApp() thật + DB throwaway thật (otp-service chạy thật
// trên DB). CHỈ mock 2 cạnh ngoài mạng: email-service.sendOtpEmail (không gửi Gmail thật) + rc-client
// (không gọi Rocket.Chat thật) — đúng khuôn "mock fetch/http, không gọi RC/SMTP thật trong test tự động".
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/email-service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/email-service.js')>('../src/email-service.js');
  return { ...actual, sendOtpEmail: vi.fn() };
});
// 4/8 hoàn tất LOẠI RC khỏi auth — mock CHỈ các hàm rc-client CÒN export (rcLogin/rcCreateLoginTokenForUser/
// rcGetUserTotpEnabled đã bị gỡ). Đăng ký/đăng nhập/device-bypass mint phiên ĐỘC LẬP RC, xác thực mật khẩu đi
// đường NỘI BỘ (bcrypt, password-service) — KHÔNG gọi hàm RC nào ở các luồng này.
vi.mock('../src/rc-client.js', () => ({
  rcGetMe: vi.fn(),
  rcCreateUser: vi.fn(),
  rcDeleteUser: vi.fn(),
  rcSetUserPassword: vi.fn(),
  resetRcAdminAuthCache: vi.fn()
}));

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createOtpChallenge } from '../src/otp-service.js';
import { issueDeviceToken } from '../src/device-trust-service.js';
import { sendOtpEmail, OtpSmtpNotConfiguredError } from '../src/email-service.js';
import { rcCreateUser, rcSetUserPassword } from '../src/rc-client.js';
import type { RcCreateUserInput } from '../src/rc-client.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { hashPassword, verifyPasswordHash } from '../src/password-service.js';

function uniqEmail(): string {
  return `route_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`;
}

// 4/8 LOẠI RC — tên đăng nhập giờ lưu thẳng vào Agent.rcUsername (@unique THẬT trên DB throwaway dùng chung cả
// suite), KHÔNG còn qua RC (RC mock không có ràng buộc unique). Sinh tên đăng nhập DUY NHẤT TOÀN CỤC để tránh
// va chạm unique constraint giữa các test/giữa các file.
function uniqUsername(): string {
  return `u_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

describe('POST /v1/auth/register/request-otp', () => {
  const app = createApp();

  beforeEach(() => {
    vi.mocked(sendOtpEmail).mockReset();
  });

  it('email hợp lệ, gửi mail OK → 200 {ok:true}, không lộ có/không có tài khoản trước đó', async () => {
    vi.mocked(sendOtpEmail).mockResolvedValue(undefined);
    const res = await request(app).post('/v1/auth/register/request-otp').send({ email: uniqEmail() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sendOtpEmail).toHaveBeenCalledTimes(1);
  });

  it('email sai định dạng → 400 VALIDATION, KHÔNG tạo challenge/gửi mail', async () => {
    const res = await request(app).post('/v1/auth/register/request-otp').send({ email: 'khong-hop-le' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  it('thiếu OTP_SMTP config (sendOtpEmail throw OtpSmtpNotConfiguredError) → 500 rõ ràng, KHÔNG báo ok:true giả', async () => {
    vi.mocked(sendOtpEmail).mockRejectedValue(new OtpSmtpNotConfiguredError());
    const res = await request(app).post('/v1/auth/register/request-otp').send({ email: uniqEmail() });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('OTP_SMTP_NOT_CONFIGURED');
  });

  // SECURITY AUDIT FIX (HIGH) — request-otp trước đây KHÔNG rate limit → 1 caller spam gửi mail OTP tới
  // cùng 1 email (email-bomb nạn nhân + tiêu quota Gmail SMTP dùng chung). Test dùng RIÊNG 1 app mới (không
  // dùng biến `app` module-level ở trên) để limiter (khởi tạo module-level trong routes/auth.ts, đếm theo
  // process, KHÔNG reset giữa các it()) không bị "ăn" bởi các test khác đã gọi cùng route trước đó — cô lập
  // hoàn toàn bằng 1 email riêng, chỉ dùng trong describe block này.
  it('vượt giới hạn per-email (5 request/giờ) cho CÙNG 1 email → request thứ 6 trả 429 RATE_LIMITED, các request trước vẫn 200', async () => {
    const rateLimitApp = createApp();
    vi.mocked(sendOtpEmail).mockResolvedValue(undefined);
    const email = uniqEmail();

    for (let i = 0; i < 5; i++) {
      const res = await request(rateLimitApp).post('/v1/auth/register/request-otp').send({ email });
      expect(res.status).toBe(200);
    }

    const sixth = await request(rateLimitApp).post('/v1/auth/register/request-otp').send({ email });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toBe('RATE_LIMITED');

    // Email KHÁC, cùng app/cùng IP → limiter per-email không chặn (chỉ per-IP limiter còn dư hạn mức 20/15p
    // mới cho qua) — chứng minh khóa giới hạn đúng là theo email, không phải khóa cứng theo app instance.
    const otherEmail = uniqEmail();
    const otherRes = await request(rateLimitApp).post('/v1/auth/register/request-otp').send({ email: otherEmail });
    expect(otherRes.status).toBe(200);
  });
});

describe('POST /v1/auth/register/verify-otp', () => {
  const app = createApp();

  beforeEach(() => {
    // 4/8 LOẠI RC — đăng ký tạo Agent NỘI BỘ (passwordHash bcrypt) + mint phiên độc lập RC, KHÔNG gọi
    // rcCreateUser/rcCreateLoginTokenForUser. Chỉ reset rcCreateUser để assert `not.toHaveBeenCalled()` sạch.
    vi.mocked(rcCreateUser).mockReset();
  });

  // 4/8 LOẠI RC — đăng ký tạo Agent NỘI BỘ (passwordHash bcrypt), KHÔNG gọi rcCreateUser, rcUserId = null.
  it('OTP đúng → 200 {ok:true, agent}, Agent tạo NỘI BỘ có passwordHash, KHÔNG gọi rcCreateUser, rcUserId null', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const username = uniqUsername();
    const challenge = await createOtpChallenge(db, email, 'AGENT_REGISTER');

    const res = await request(app)
      .post('/v1/auth/register/verify-otp')
      .send({ email, code: challenge.code, username, password: 'Secret123!', name: 'Đại lý Mới' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(rcCreateUser).not.toHaveBeenCalled();
    expect(res.body.agent.rcUserId).toBeNull();
    expect(res.body.agent.rcUsername).toBe(username);

    const agentRow = await db.agent.findUnique({ where: { id: res.body.agent.id } });
    expect(agentRow).not.toBeNull();
    expect(agentRow!.name).toBe('Đại lý Mới');
    expect(agentRow!.passwordHash).not.toBeNull();
    expect(await verifyPasswordHash('Secret123!', agentRow!.passwordHash)).toBe(true);
  });

  // 4/8 LOẠI RC — mint phiên ĐỘC LẬP RC ngay sau đăng ký (KHÔNG gọi rcCreateLoginTokenForUser): sessionReady
  // LUÔN true, cookie httpOnly `sigma_ws` set ngay, session.rcAuthToken = null (không phụ thuộc RC sống/chết).
  it('session — mint phiên ĐỘC LẬP RC: sessionReady:true + cookie httpOnly, session.rcAuthToken null, KHÔNG gọi rcCreateLoginTokenForUser', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const username = uniqUsername();
    const challenge = await createOtpChallenge(db, email, 'AGENT_REGISTER');

    const res = await request(app)
      .post('/v1/auth/register/verify-otp')
      .send({ email, code: challenge.code, username, password: 'Secret123!', name: 'Sess User' });

    expect(res.status).toBe(200);
    expect(res.body.sessionReady).toBe(true);
    expect(res.body.session).toBeUndefined(); // KHÔNG có field session/authToken lộ ra body
    expect(rcCreateUser).not.toHaveBeenCalled(); // 4/8 LOẠI RC — mint phiên độc lập, KHÔNG tạo user RC nền
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toMatch(/sigma_ws=/);
    expect(String(setCookie)).toMatch(/HttpOnly/i);

    const webSessionId = String(setCookie).match(/sigma_ws=([^;]+)/)?.[1];
    const row = await db.webSession.findUnique({ where: { id: webSessionId } });
    expect(row).not.toBeNull();
    expect(row!.rcAuthToken).toBeNull(); // phiên độc lập RC
    expect(row!.rcUserId).toBeNull();
    expect(row!.agentId).toBe(res.body.agent.id);
  });

  it('OTP sai → 400 OTP_WRONG_CODE, KHÔNG tạo Agent nào', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const challenge = await createOtpChallenge(db, email, 'AGENT_REGISTER');
    const wrongCode = challenge.code === '111111' ? '222222' : '111111';
    const before = await db.agent.count();

    const res = await request(app)
      .post('/v1/auth/register/verify-otp')
      .send({ email, code: wrongCode, username: uniqUsername(), password: 'Secret123!', name: 'X' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('OTP_WRONG_CODE');
    expect(rcCreateUser).not.toHaveBeenCalled();
    expect(await db.agent.count()).toBe(before);
  });

  // 4/8 LOẠI RC — tính duy nhất tên đăng nhập giờ do cột Agent.rcUsername (@unique) đảm bảo (RC không còn tham
  // gia). Trùng tên đăng nhập → agent.create ném P2002 → 400 USERNAME_OR_EMAIL_TAKEN, KHÔNG tạo Agent rác, OTP nhả.
  it('OTP đúng nhưng tên đăng nhập ĐÃ tồn tại → 400 USERNAME_OR_EMAIL_TAKEN, KHÔNG tạo Agent, OTP được NHẢ (dùng lại được)', async () => {
    const db = getBotDb();
    const takenUsername = uniqUsername();
    await db.agent.create({ data: { name: 'Owner', email: uniqEmail(), rcUsername: takenUsername } });
    const email = uniqEmail();
    const challenge = await createOtpChallenge(db, email, 'AGENT_REGISTER');

    const before = await db.agent.count();
    const res = await request(app)
      .post('/v1/auth/register/verify-otp')
      .send({ email, code: challenge.code, username: takenUsername, password: 'Secret123!', name: 'Dup' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('USERNAME_OR_EMAIL_TAKEN');
    expect(await db.agent.count()).toBe(before); // không tạo Agent rác
    const row = await db.emailOtpChallenge.findUnique({ where: { id: challenge.challengeId } });
    expect(row!.consumedAt).toBeNull(); // OTP KHÔNG bị đốt oan
    expect(row!.verifiedAt).toBeNull(); // claim đã nhả — mã đúng này verify lại được
  });

  // B2 fix (24/7, CMD_AUDIT 23/7) — tạo Agent thất bại giữa chừng (giờ là trùng tên đăng nhập, thay cho
  // rcCreateUser lỗi trước đây) KHÔNG được "đốt" OTP: CÙNG mã đó phải verify lại được ở lần gọi TIẾP THEO khi
  // user đổi tên đăng nhập rồi bấm "Thử lại" — KHÔNG xin mã OTP mới.
  it('B2: tên đăng nhập trùng → verify-otp lần 2 CÙNG mã OTP (đổi username) → 200 thành công, KHÔNG bị OTP_NOT_FOUND/OTP_TOO_MANY_ATTEMPTS', async () => {
    const db = getBotDb();
    const takenUsername = uniqUsername();
    await db.agent.create({ data: { name: 'Owner2', email: uniqEmail(), rcUsername: takenUsername } });
    const email = uniqEmail();
    const challenge = await createOtpChallenge(db, email, 'AGENT_REGISTER');

    const failRes = await request(app)
      .post('/v1/auth/register/verify-otp')
      .send({ email, code: challenge.code, username: takenUsername, password: 'Secret123!', name: 'Dup2' });
    expect(failRes.status).toBe(400);
    expect(failRes.body.error).toBe('USERNAME_OR_EMAIL_TAKEN');

    const fixedUsername = uniqUsername();
    const retryRes = await request(app)
      .post('/v1/auth/register/verify-otp')
      .send({ email, code: challenge.code, username: fixedUsername, password: 'Secret123!', name: 'Dup2 Fixed' });

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.ok).toBe(true);
    expect(retryRes.body.agent.rcUsername).toBe(fixedUsername);

    const row = await db.emailOtpChallenge.findUnique({ where: { id: challenge.challengeId } });
    expect(row!.consumedAt).not.toBeNull(); // tiêu dùng thật SAU KHI tạo Agent thành công ở lần retry.
  });

  // B1/B2 fix — 2 request verify-otp SONG SONG cùng mã đúng: chỉ 1 request được tạo Agent/RC user, request
  // kia phải bị CHẶN — KHÔNG được cả 2 cùng gọi rcCreateUser (2 Agent/2 RC user khác nhau cho cùng 1 mã OTP,
  // đúng yêu cầu "chỉ 1 được thắng" trong finding CMD_AUDIT).
  // Lưu ý outcome của bên THUA: tùy thời điểm chính xác request 2 chạm được khóa row so với lúc request 1
  // hoàn tất finalizeOtpChallenge (rcCreateUser mock ở đây trả về gần như tức thời, không có độ trễ mạng
  // thật) — có thể là 409 OTP_IN_PROGRESS (chạm khóa TRONG LÚC request 1 đang xử lý, verifiedAt đã set
  // nhưng consumedAt CHƯA) hoặc 400 OTP_NOT_FOUND (chạm khóa SAU KHI request 1 đã finalize xong,
  // consumedAt đã set). CẢ HAI đều là bằng chứng đúng của việc "bị chặn, không lọt qua" — bất biến cốt lõi
  // cần assert là: đúng 1 winner 200, bên còn lại KHÔNG PHẢI 200, rcCreateUser CHỈ được gọi đúng 1 lần, và
  // DB chỉ có đúng 1 Agent mới — không phải status code cụ thể của bên thua.
  it('B2 concurrency (route): 2 request verify-otp song song CÙNG mã đúng → CHỈ ĐÚNG 1 request tạo Agent, request kia bị chặn', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const username = uniqUsername();
    const challenge = await createOtpChallenge(db, email, 'AGENT_REGISTER');

    const before = await db.agent.count();
    const [resA, resB] = await Promise.all([
      request(app)
        .post('/v1/auth/register/verify-otp')
        .send({ email, code: challenge.code, username, password: 'Secret123!', name: 'Race A' }),
      request(app)
        .post('/v1/auth/register/verify-otp')
        .send({ email, code: challenge.code, username, password: 'Secret123!', name: 'Race B' })
    ]);

    const okResponses = [resA, resB].filter((r) => r.status === 200);
    const blockedResponses = [resA, resB].filter((r) => r.status !== 200);
    expect(okResponses).toHaveLength(1);
    expect(blockedResponses).toHaveLength(1);
    expect(okResponses[0]!.body.ok).toBe(true);
    // Bên thua bị chặn ở 1 trong các outcome hợp lệ tùy thời điểm interleave: OTP (IN_PROGRESS/NOT_FOUND),
    // check email-trùng SỚM (EMAIL_ALREADY_REGISTERED), hoặc agent.create trùng tên đăng nhập
    // (USERNAME_OR_EMAIL_TAKEN) — mọi outcome đều giữ ĐÚNG bất biến cốt lõi: đúng 1 winner, đúng 1 Agent.
    expect(['OTP_IN_PROGRESS', 'OTP_NOT_FOUND', 'EMAIL_ALREADY_REGISTERED', 'USERNAME_OR_EMAIL_TAKEN']).toContain(blockedResponses[0]!.body.error);
    expect(rcCreateUser).not.toHaveBeenCalled(); // 4/8 LOẠI RC — không còn tạo user RC.

    const after = await db.agent.count();
    expect(after).toBe(before + 1); // đúng 1 Agent được tạo, không phải 2.
  });

  // B58 (30/7) — TRƯỚC ĐÂY agent.create ở verify-otp KHÔNG bao giờ set `code` → Agent tự đăng ký có
  // Agent.code=null vĩnh viễn, khiến "Thêm bạn qua mã đại lý" (routes/agents.ts findAliveAgentByCode, đòi
  // khớp code khác null tuyệt đối) KHÔNG BAO GIỜ hoạt động giữa 2 đại lý tự đăng ký. Fix dùng ĐÚNG cơ chế
  // mint-mã atomic dùng chung toàn bộ codebase (@sigma/database nextCode() → bảng code_counters, CÙNG cơ chế
  // NV/KH/NGH/... ở apps/desktop, đã có bằng chứng race-safe độc lập ở
  // apps/desktop/src/main/selftest-concurrency.ts), prefix 'DL' (Đại Lý). 3 test dưới đây chứng minh: định
  // dạng đúng, không tái dùng số cũ giữa 2 lần đăng ký liên tiếp, và không đụng số khi 2 request THẬT chạy
  // song song qua route HTTP (không chỉ ở mức unit nextCode() đơn lẻ).
  it('B58: verify-otp gán Agent.code THẬT dạng DL## (không còn null) — dùng nextCode()/@sigma/database', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const challenge = await createOtpChallenge(db, email, 'AGENT_REGISTER');
    vi.mocked(rcCreateUser).mockResolvedValue({ ok: true, data: { _id: 'rc-code-1', username: 'codeuser1' } });

    const res = await request(app)
      .post('/v1/auth/register/verify-otp')
      .send({ email, code: challenge.code, username: 'codeuser1', password: 'Secret123!', name: 'Code User 1' });

    expect(res.status).toBe(200);
    expect(res.body.agent.code).toEqual(expect.stringMatching(/^DL\d{2,}$/));
    const agentRow = await db.agent.findUnique({ where: { id: res.body.agent.id } });
    expect(agentRow).not.toBeNull();
    expect(agentRow!.code).toBe(res.body.agent.code); // đúng giá trị đã lưu DB, không phải field khác đội lốt.
  });

  it('B58: 2 lần đăng ký KHÁC NHAU liên tiếp (tuần tự) → 2 Agent.code KHÁC NHAU (bộ đếm tăng dần, không lặp số cũ)', async () => {
    const db = getBotDb();
    vi.mocked(rcCreateUser).mockResolvedValueOnce({ ok: true, data: { _id: 'rc-code-2a', username: 'codeuser2a' } });
    const email1 = uniqEmail();
    const challenge1 = await createOtpChallenge(db, email1, 'AGENT_REGISTER');
    const res1 = await request(app)
      .post('/v1/auth/register/verify-otp')
      .send({ email: email1, code: challenge1.code, username: 'codeuser2a', password: 'Secret123!', name: 'Code User 2a' });
    expect(res1.status).toBe(200);

    vi.mocked(rcCreateUser).mockResolvedValueOnce({ ok: true, data: { _id: 'rc-code-2b', username: 'codeuser2b' } });
    const email2 = uniqEmail();
    const challenge2 = await createOtpChallenge(db, email2, 'AGENT_REGISTER');
    const res2 = await request(app)
      .post('/v1/auth/register/verify-otp')
      .send({ email: email2, code: challenge2.code, username: 'codeuser2b', password: 'Secret123!', name: 'Code User 2b' });
    expect(res2.status).toBe(200);

    expect(res1.body.agent.code).toEqual(expect.stringMatching(/^DL\d{2,}$/));
    expect(res2.body.agent.code).toEqual(expect.stringMatching(/^DL\d{2,}$/));
    expect(res1.body.agent.code).not.toBe(res2.body.agent.code);
  });

  it('B58 concurrency: 2 request verify-otp SONG SONG THẬT (email/OTP khác nhau, không tranh nhau ở tầng OTP) → cả 2 tạo Agent thành công, Agent.code PHÂN BIỆT (nextCode() race-safe qua Postgres upsert atomic, KHÔNG cần cơ chế retry-khi-đụng)', async () => {
    const db = getBotDb();
    const emailA = uniqEmail();
    const emailB = uniqEmail();
    const challengeA = await createOtpChallenge(db, emailA, 'AGENT_REGISTER');
    const challengeB = await createOtpChallenge(db, emailB, 'AGENT_REGISTER');
    // rcCreateUser trả kết quả KHÁC NHAU tùy `username` gọi tới — an toàn dù Promise.all resolve KHÔNG theo
    // đúng thứ tự gọi (mockResolvedValueOnce phụ thuộc thứ tự GỌI thật của event loop, không dùng được chắc
    // chắn cho 2 request chạy song song thật ở đây).
    vi.mocked(rcCreateUser).mockImplementation(async (input: RcCreateUserInput) => {
      if (input.username === 'concurA') return { ok: true, data: { _id: 'rc-concur-a', username: 'concurA' } };
      if (input.username === 'concurB') return { ok: true, data: { _id: 'rc-concur-b', username: 'concurB' } };
      throw new Error(`unexpected username in mock: ${input.username}`);
    });

    const [resA, resB] = await Promise.all([
      request(app)
        .post('/v1/auth/register/verify-otp')
        .send({ email: emailA, code: challengeA.code, username: 'concurA', password: 'Secret123!', name: 'Concur A' }),
      request(app)
        .post('/v1/auth/register/verify-otp')
        .send({ email: emailB, code: challengeB.code, username: 'concurB', password: 'Secret123!', name: 'Concur B' })
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body.agent.code).toEqual(expect.stringMatching(/^DL\d{2,}$/));
    expect(resB.body.agent.code).toEqual(expect.stringMatching(/^DL\d{2,}$/));
    // Bất biến cốt lõi: KHÔNG BAO GIỜ trùng, dù 2 request chạy đồng thời thật (không phải mock đơn luồng).
    expect(resA.body.agent.code).not.toBe(resB.body.agent.code);

    const agentA = await db.agent.findUnique({ where: { id: resA.body.agent.id } });
    const agentB = await db.agent.findUnique({ where: { id: resB.body.agent.id } });
    expect(agentA!.code).not.toBe(agentB!.code);
  });

  it('thiếu field bắt buộc → 400 VALIDATION', async () => {
    const res = await request(app).post('/v1/auth/register/verify-otp').send({ email: uniqEmail() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  // SECURITY AUDIT FIX (LOW) — trước đây KHÔNG có ràng buộc độ mạnh mật khẩu trước khi tạo user Rocket.Chat
  // thật. Test mã OTP ĐÚNG (để chứng minh route chặn RIÊNG vì password yếu, không phải vì OTP sai) nhưng
  // password chỉ 6 ký tự → phải bị chặn 400 TRƯỚC khi gọi rcCreateUser (không tạo user RC rác/không tiêu OTP).
  it('mật khẩu ngắn hơn 8 ký tự → 400 VALIDATION, KHÔNG gọi rcCreateUser, OTP KHÔNG bị tiêu', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const challenge = await createOtpChallenge(db, email, 'AGENT_REGISTER');

    const res = await request(app)
      .post('/v1/auth/register/verify-otp')
      .send({ email, code: challenge.code, username: 'weakpw', password: 'short1', name: 'Weak Pw' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
    expect(rcCreateUser).not.toHaveBeenCalled();

    const row = await db.emailOtpChallenge.findUnique({ where: { id: challenge.challengeId } });
    expect(row!.consumedAt).toBeNull();
    expect(row!.verifiedAt).toBeNull();
  });

  // 24/7 (Admin Demo yêu cầu mở rộng hồ sơ đăng ký) — email giờ UNIQUE trên Agent, dùng làm định danh đăng
  // nhập chính (LoginScreen tab "Đăng nhập" gọi thẳng rcLogin với email).
  it('email ĐÃ đăng ký trước đó → 400 EMAIL_ALREADY_REGISTERED, KHÔNG gọi rcCreateUser lần 2, OTP mới KHÔNG bị tiêu', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    vi.mocked(rcCreateUser).mockResolvedValue({ ok: true, data: { _id: 'rc-dup-1', username: 'dupuser' } });

    const first = await createOtpChallenge(db, email, 'AGENT_REGISTER');
    const firstRes = await request(app)
      .post('/v1/auth/register/verify-otp')
      .send({ email, code: first.code, username: 'dupuser', password: 'Secret123!', name: 'First' });
    expect(firstRes.status).toBe(200);

    vi.mocked(rcCreateUser).mockClear();
    const second = await createOtpChallenge(db, email, 'AGENT_REGISTER');
    const secondRes = await request(app)
      .post('/v1/auth/register/verify-otp')
      .send({ email, code: second.code, username: 'dupuser2', password: 'Secret123!', name: 'Second' });

    expect(secondRes.status).toBe(400);
    expect(secondRes.body.error).toBe('EMAIL_ALREADY_REGISTERED');
    expect(rcCreateUser).not.toHaveBeenCalled();

    const row = await db.emailOtpChallenge.findUnique({ where: { id: second.challengeId } });
    expect(row!.consumedAt).toBeNull(); // mã OTP thứ 2 vẫn CÒN NGUYÊN, không bị đốt oan vì lỗi email trùng.
  });

  it('gender/dateOfBirth/phone gửi kèm → lưu ĐÚNG vào Agent; KHÔNG gửi (optional) → lưu null, KHÔNG lỗi', async () => {
    const db = getBotDb();
    vi.mocked(rcCreateUser).mockResolvedValue({ ok: true, data: { _id: 'rc-profile-1', username: 'profileuser' } });

    const email = uniqEmail();
    const challenge = await createOtpChallenge(db, email, 'AGENT_REGISTER');
    const res = await request(app).post('/v1/auth/register/verify-otp').send({
      email,
      code: challenge.code,
      username: 'profileuser',
      password: 'Secret123!',
      name: 'Full Profile',
      gender: 'female',
      dateOfBirth: '1995-06-15',
      phone: '0912345678'
    });
    expect(res.status).toBe(200);

    const agent = await db.agent.findUnique({ where: { id: res.body.agent.id } });
    expect(agent!.email).toBe(email);
    expect(agent!.gender).toBe('FEMALE'); // uppercase hóa
    expect(agent!.dateOfBirth?.toISOString().slice(0, 10)).toBe('1995-06-15');
    expect(agent!.phone).toBe('0912345678');

    // Đăng ký khác KHÔNG gửi 3 field optional — phải qua được, lưu null, không lỗi.
    const email2 = uniqEmail();
    const challenge2 = await createOtpChallenge(db, email2, 'AGENT_REGISTER');
    vi.mocked(rcCreateUser).mockResolvedValue({ ok: true, data: { _id: 'rc-profile-2', username: 'noprofileuser' } });
    const res2 = await request(app)
      .post('/v1/auth/register/verify-otp')
      .send({ email: email2, code: challenge2.code, username: 'noprofileuser', password: 'Secret123!', name: 'No Profile' });
    expect(res2.status).toBe(200);
    const agent2 = await db.agent.findUnique({ where: { id: res2.body.agent.id } });
    expect(agent2!.gender).toBeNull();
    expect(agent2!.dateOfBirth).toBeNull();
    expect(agent2!.phone).toBeNull();
  });

  it('gender không hợp lệ → 400 VALIDATION, KHÔNG gọi rcCreateUser, OTP KHÔNG bị tiêu', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const challenge = await createOtpChallenge(db, email, 'AGENT_REGISTER');
    const res = await request(app).post('/v1/auth/register/verify-otp').send({
      email,
      code: challenge.code,
      username: 'badgender',
      password: 'Secret123!',
      name: 'Bad Gender',
      gender: 'ROBOT'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
    expect(rcCreateUser).not.toHaveBeenCalled();
    const row = await db.emailOtpChallenge.findUnique({ where: { id: challenge.challengeId } });
    expect(row!.consumedAt).toBeNull();
  });
});

describe('POST /v1/auth/forgot-password/request-otp + reset — 24/7', () => {
  const app = createApp();
  beforeEach(() => {
    vi.mocked(sendOtpEmail).mockReset();
    vi.mocked(rcSetUserPassword).mockReset();
  });

  async function makeAgentWithEmail(email: string): Promise<number> {
    const db = getBotDb();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const agent = await db.agent.create({ data: { name: 'Forgot Pw Test', email, rcUserId: `rc-fp-${suffix}`, rcUsername: `fp_test_${suffix}` } });
    return agent.id;
  }

  it('request-otp cho email CÓ tài khoản → gửi mail thật, {ok:true}', async () => {
    vi.mocked(sendOtpEmail).mockResolvedValue(undefined);
    const email = uniqEmail();
    await makeAgentWithEmail(email);
    const res = await request(app).post('/v1/auth/forgot-password/request-otp').send({ email });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sendOtpEmail).toHaveBeenCalledTimes(1);
  });

  it('request-otp cho email KHÔNG có tài khoản → VẪN {ok:true} (chống dò email), KHÔNG gửi mail', async () => {
    const res = await request(app).post('/v1/auth/forgot-password/request-otp').send({ email: uniqEmail() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  // 4/8 LOẠI RC — reset đổi passwordHash NỘI BỘ, KHÔNG còn đồng bộ rcSetUserPassword sang Rocket.Chat.
  it('reset mật khẩu THẬT: OTP đúng + agent tồn tại → đổi passwordHash nội bộ, KHÔNG gọi rcSetUserPassword, OTP bị tiêu thật', async () => {
    vi.mocked(sendOtpEmail).mockResolvedValue(undefined);
    const db = getBotDb();
    const email = uniqEmail();
    const agentId = await makeAgentWithEmail(email);

    const challenge = await createOtpChallenge(db, email, 'PASSWORD_RESET');
    const res = await request(app).post('/v1/auth/forgot-password/reset').send({ email, code: challenge.code, newPassword: 'NewSecret123!' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(rcSetUserPassword).not.toHaveBeenCalled();

    const updated = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(await verifyPasswordHash('NewSecret123!', updated.passwordHash)).toBe(true);

    const row = await db.emailOtpChallenge.findUnique({ where: { id: challenge.challengeId } });
    expect(row!.consumedAt).not.toBeNull();
  });

  // 4/8 LOẠI RC — tài khoản ĐỘC LẬP RC (rcUserId null, vd đăng ký/Google sau 4/8) VẪN "Quên mật khẩu" được:
  // request-otp gửi mã (không còn đòi rcUserId).
  it('tài khoản độc lập RC (rcUserId null) → request-otp VẪN gửi mail (không còn đòi rcUserId)', async () => {
    vi.mocked(sendOtpEmail).mockResolvedValue(undefined);
    const db = getBotDb();
    const email = uniqEmail();
    await db.agent.create({ data: { name: 'Independent', email, rcUsername: uniqUsername(), passwordHash: null } });

    const reqRes = await request(app).post('/v1/auth/forgot-password/request-otp').send({ email });
    expect(reqRes.status).toBe(200);
    expect(sendOtpEmail).toHaveBeenCalledTimes(1); // ĐÃ gửi mã dù agent KHÔNG có rcUserId
  });

  // 4/8 LOẠI RC — reset đổi passwordHash nội bộ thành công cho tài khoản độc lập RC (rcUserId null).
  it('tài khoản độc lập RC (rcUserId null) → reset đổi passwordHash thành công', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const agent = await db.agent.create({ data: { name: 'Independent 2', email, rcUsername: uniqUsername(), passwordHash: null } });

    const challenge = await createOtpChallenge(db, email, 'PASSWORD_RESET');
    const res = await request(app).post('/v1/auth/forgot-password/reset').send({ email, code: challenge.code, newPassword: 'IndepNew123!' });
    expect(res.status).toBe(200);
    const updated = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(await verifyPasswordHash('IndepNew123!', updated.passwordHash)).toBe(true);
  });

  it('mật khẩu mới ngắn hơn 8 ký tự → 400 VALIDATION, KHÔNG gọi rcSetUserPassword, OTP KHÔNG bị tiêu', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    await makeAgentWithEmail(email);
    const challenge = await createOtpChallenge(db, email, 'PASSWORD_RESET');
    const res = await request(app).post('/v1/auth/forgot-password/reset').send({ email, code: challenge.code, newPassword: 'short1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
    expect(rcSetUserPassword).not.toHaveBeenCalled();
    const row = await db.emailOtpChallenge.findUnique({ where: { id: challenge.challengeId } });
    expect(row!.consumedAt).toBeNull();
  });

  it('mã OTP sai → 400 OTP_WRONG_CODE, KHÔNG gọi rcSetUserPassword', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    await makeAgentWithEmail(email);
    await createOtpChallenge(db, email, 'PASSWORD_RESET');
    const res = await request(app).post('/v1/auth/forgot-password/reset').send({ email, code: '000000', newPassword: 'NewSecret123!' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('OTP_WRONG_CODE');
    expect(rcSetUserPassword).not.toHaveBeenCalled();
  });

  it('OTP đúng nhưng KHÔNG tìm thấy Agent ứng với email (đã xóa giữa chừng) → 404 AGENT_NOT_FOUND, OTP được NHẢ (verify lại được)', async () => {
    const db = getBotDb();
    const email = uniqEmail(); // KHÔNG tạo Agent nào cho email này
    const challenge = await createOtpChallenge(db, email, 'PASSWORD_RESET');
    const res = await request(app).post('/v1/auth/forgot-password/reset').send({ email, code: challenge.code, newPassword: 'NewSecret123!' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('AGENT_NOT_FOUND');
    expect(rcSetUserPassword).not.toHaveBeenCalled();

    const row = await db.emailOtpChallenge.findUnique({ where: { id: challenge.challengeId } });
    expect(row!.verifiedAt).toBeNull(); // claim đã nhả — mã đúng này verify lại được
    expect(row!.consumedAt).toBeNull();
  });

  // SIGMA Phase 1 "bỏ Rocket.Chat" (28/7) — passwordHash nội bộ giờ là NGUỒN THẬT quyết định đăng nhập
  // (xem checkAgentPassword() routes/auth.ts), rcSetUserPassword chỉ còn ĐỒNG BỘ BEST-EFFORT — RC lỗi KHÔNG
  // còn chặn response (đổi hành vi có chủ đích so với trước 28/7, xem BUGS_FIXED.md B47).
  it('rcSetUserPassword thất bại (RC lỗi) → VẪN 200 (passwordHash nội bộ đã đổi thành công, RC chỉ đồng bộ phòng hờ), OTP vẫn được tiêu thật', async () => {
    vi.mocked(rcSetUserPassword).mockResolvedValue({ ok: false, kind: 'HTTP', status: 500, message: 'RC internal error' });
    const db = getBotDb();
    const email = uniqEmail();
    const agentId = await makeAgentWithEmail(email);
    const challenge = await createOtpChallenge(db, email, 'PASSWORD_RESET');
    const res = await request(app).post('/v1/auth/forgot-password/reset').send({ email, code: challenge.code, newPassword: 'NewSecret123!' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const updated = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(updated.passwordHash).not.toBeNull();
    expect(await verifyPasswordHash('NewSecret123!', updated.passwordHash)).toBe(true);

    const row = await db.emailOtpChallenge.findUnique({ where: { id: challenge.challengeId } });
    expect(row!.consumedAt).not.toBeNull(); // OTP tiêu thật — bước blocking (đổi passwordHash) đã thành công
  });

  it('reset thành công (RC đồng bộ OK) → passwordHash nội bộ khớp mật khẩu mới, mật khẩu cũ không còn dùng được', async () => {
    vi.mocked(rcSetUserPassword).mockResolvedValue({ ok: true, data: { success: true } });
    const db = getBotDb();
    const email = uniqEmail();
    const agentId = await makeAgentWithEmail(email);
    const challenge = await createOtpChallenge(db, email, 'PASSWORD_RESET');
    const res = await request(app).post('/v1/auth/forgot-password/reset').send({ email, code: challenge.code, newPassword: 'BrandNew456!' });
    expect(res.status).toBe(200);

    const updated = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(await verifyPasswordHash('BrandNew456!', updated.passwordHash)).toBe(true);
    expect(await verifyPasswordHash('SaiMatKhau', updated.passwordHash)).toBe(false);
  });

  // SECURITY AUDIT FIX (HIGH, Vòng 2.5 AUTH hardening 3/8) — TRƯỚC ĐÂY forgot-password/reset đổi passwordHash
  // nhưng KHÔNG thu hồi các WebSession đang sống của agent. Kịch bản tấn công: kẻ gian đánh cắp 1 cookie phiên
  // (XSS/máy dùng chung) → nạn nhân nghi ngờ, dùng "Quên mật khẩu" đặt lại mật khẩu để giành lại quyền kiểm
  // soát → phiên bị đánh cắp VẪN sống 30 ngày, việc đặt lại mật khẩu KHÔNG cắt được quyền truy cập của kẻ gian.
  // Reset PHẢI vô hiệu hóa MỌI phiên hiện có (người dùng vốn không đăng nhập khi quên mật khẩu — họ sẽ đăng
  // nhập lại tạo phiên mới; mọi phiên khác đang sống bị cắt là hành vi ĐÚNG cho 1 lần reset vì lý do bảo mật).
  it('SECURITY: reset mật khẩu → THU HỒI toàn bộ WebSession đang sống của agent (phiên bị đánh cắp KHÔNG còn dùng được sau khi đổi mật khẩu)', async () => {
    vi.mocked(sendOtpEmail).mockResolvedValue(undefined);
    vi.mocked(rcSetUserPassword).mockResolvedValue({ ok: true, data: { success: true } });
    const db = getBotDb();
    const email = uniqEmail();
    const agentId = await makeAgentWithEmail(email);
    const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });

    // 1 phiên đang sống (mô phỏng thiết bị khác HOẶC phiên bị kẻ gian đánh cắp).
    const stolen = await createWebSession(db, {
      rcUserId: agent.rcUserId!,
      rcUsername: agent.rcUsername,
      rcAuthToken: 'stolen-tok',
      agentId
    });
    const stolenHeaders = { Cookie: `${WEB_SESSION_COOKIE_NAME}=${stolen.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };

    // Phiên hoạt động bình thường TRƯỚC khi reset.
    const before = await request(app).get('/v1/auth/me').set(stolenHeaders);
    expect(before.status).toBe(200);

    // Đặt lại mật khẩu qua OTP hợp lệ.
    const challenge = await createOtpChallenge(db, email, 'PASSWORD_RESET');
    const res = await request(app).post('/v1/auth/forgot-password/reset').send({ email, code: challenge.code, newPassword: 'BrandNew456!' });
    expect(res.status).toBe(200);

    // Phiên cũ PHẢI hết hiệu lực ngay sau reset — cả ở tầng route (401) lẫn trong DB (đã xóa hàng).
    const after = await request(app).get('/v1/auth/me').set(stolenHeaders);
    expect(after.status).toBe(401);
    expect(await db.webSession.count({ where: { agentId } })).toBe(0);
  });

  // Bảo đảm phạm vi thu hồi ĐÚNG agent — reset của agent A KHÔNG được cắt phiên của agent B khác (tránh sửa
  // lỗ này thành 1 lỗ DoS "reset mật khẩu người khác = đá văng phiên mình" hoặc xóa nhầm toàn bảng).
  it('SECURITY: reset mật khẩu chỉ thu hồi phiên của CHÍNH agent đó, KHÔNG đụng phiên agent khác', async () => {
    vi.mocked(sendOtpEmail).mockResolvedValue(undefined);
    vi.mocked(rcSetUserPassword).mockResolvedValue({ ok: true, data: { success: true } });
    const db = getBotDb();
    const emailA = uniqEmail();
    const agentAId = await makeAgentWithEmail(emailA);
    const agentA = await db.agent.findUniqueOrThrow({ where: { id: agentAId } });
    await createWebSession(db, { rcUserId: agentA.rcUserId!, rcUsername: agentA.rcUsername, rcAuthToken: 'a-tok', agentId: agentAId });
    const otherAgentId = await makeAgentWithEmail(uniqEmail());
    const other = await db.agent.findUniqueOrThrow({ where: { id: otherAgentId } });
    await createWebSession(db, { rcUserId: other.rcUserId!, rcUsername: other.rcUsername, rcAuthToken: 'other-tok', agentId: otherAgentId });

    const challenge = await createOtpChallenge(db, emailA, 'PASSWORD_RESET');
    const res = await request(app).post('/v1/auth/forgot-password/reset').send({ email: emailA, code: challenge.code, newPassword: 'BrandNew456!' });
    expect(res.status).toBe(200);

    expect(await db.webSession.count({ where: { agentId: agentAId } })).toBe(0);
    expect(await db.webSession.count({ where: { agentId: otherAgentId } })).toBe(1); // KHÔNG bị đụng
  });
});

describe('GET /v1/auth/resolve-phone — 24/7 (đăng nhập bằng SĐT nếu có)', () => {
  const app = createApp();

  it('SĐT tồn tại → trả đúng email của Agent đó', async () => {
    const db = getBotDb();
    const phone = `09${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 14);
    const email = uniqEmail();
    await db.agent.create({ data: { name: 'Phone Login Test', phone, email } });
    const res = await request(app).get(`/v1/auth/resolve-phone?phone=${phone}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email });
  });

  it('SĐT không tồn tại → 404 NOT_FOUND', async () => {
    const res = await request(app).get('/v1/auth/resolve-phone?phone=0900000000000');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('thiếu tham số phone → 400 VALIDATION', async () => {
    const res = await request(app).get('/v1/auth/resolve-phone');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });
});

// 25/7 — Phase 3 "thiết bị tin cậy" (B18 tiếp theo, sửa "đăng nhập vẫn báo thiết bị mới đòi OTP").
// 4/8 hoàn tất LOẠI RC — device-bypass giờ xác thực mật khẩu HOÀN TOÀN NỘI BỘ (bcrypt qua checkAgentPassword),
// KHÔNG còn round-trip rcLogin. THÀNH CÔNG cần: Agent tồn tại (tra theo email) + passwordHash khớp + deviceToken
// hợp lệ đúng agent đó. Phiên cấp ra ĐỘC LẬP RC (rcAuthToken null). Seed Agent với passwordHash THẬT (hashPassword).
describe('POST /v1/auth/login/device-bypass — 25/7 (thiết bị tin cậy)', () => {
  const app = createApp();

  // Mật khẩu THẬT của agent test (≥8 ký tự, hợp lệ theo validator đăng ký) — hash bằng hashPassword để đường
  // nội bộ checkAgentPassword() verify khớp, KHÔNG mock gì.
  const DEVICE_PASSWORD = 'Verify#Pass123';

  async function makeAgentWithDevice(): Promise<{ agentId: number; email: string; deviceToken: string }> {
    const db = getBotDb();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const email = uniqEmail();
    const agent = await db.agent.create({
      data: { name: 'Device Bypass Test', email, rcUserId: `rc-db-${suffix}`, rcUsername: `db_test_${suffix}`, passwordHash: await hashPassword(DEVICE_PASSWORD) }
    });
    const issued = await issueDeviceToken(db, agent.id);
    return { agentId: agent.id, email, deviceToken: issued.token };
  }

  it('email/password/deviceToken đều ĐÚNG → 200 + set cookie ĐỘC LẬP RC (rcAuthToken null), agentId đúng', async () => {
    const db = getBotDb();
    const { agentId, email, deviceToken } = await makeAgentWithDevice();

    const res = await request(app).post('/v1/auth/login/device-bypass').send({ email, password: DEVICE_PASSWORD, deviceToken });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toMatch(/sigma_ws=/);
    const webSessionId = String(setCookie).match(/sigma_ws=([^;]+)/)?.[1];
    const row = await db.webSession.findUnique({ where: { id: webSessionId } });
    expect(row).not.toBeNull();
    expect(row!.rcAuthToken).toBeNull(); // phiên độc lập RC
    expect(row!.agentId).toBe(agentId);
  });

  it('SAI mật khẩu (passwordHash không khớp) → 401 UNAUTHORIZED, KHÔNG set cookie (deviceToken đúng KHÔNG thay thế được mật khẩu)', async () => {
    const { email, deviceToken } = await makeAgentWithDevice();

    const res = await request(app).post('/v1/auth/login/device-bypass').send({ email, password: 'SaiMatKhau999!', deviceToken });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('mật khẩu ĐÚNG nhưng deviceToken SAI/không tồn tại → 401, KHÔNG set cookie', async () => {
    const { email } = await makeAgentWithDevice();

    const res = await request(app).post('/v1/auth/login/device-bypass').send({ email, password: DEVICE_PASSWORD, deviceToken: 'token-bia-dat-khong-ton-tai' });

    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('mật khẩu ĐÚNG + deviceToken ĐÚNG nhưng CỦA AGENT KHÁC (vé đánh cắp từ tài khoản khác) → 401 — CHẶN đúng theo agentId, không chỉ theo tồn tại token', async () => {
    const { email } = await makeAgentWithDevice(); // agent A — dùng email này để login
    const { deviceToken: tokenOfOtherAgent } = await makeAgentWithDevice(); // agent B — vé của người khác

    const res = await request(app).post('/v1/auth/login/device-bypass').send({ email, password: DEVICE_PASSWORD, deviceToken: tokenOfOtherAgent });

    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  // 4/8 LOẠI RC — email không tồn tại: checkAgentPassword(agent=null) VẪN chạy 1 bcrypt GIẢ (DUMMY_TIMING_HASH)
  // để cân bằng thời gian phản hồi (chống dò email tồn tại/không qua timing) rồi trả FAILED → 401. Không còn
  // gọi rcLogin để assert; bất biến kiểm được ở tầng route: LUÔN 401 UNAUTHORIZED chung chung, KHÔNG set cookie.
  it('email không tồn tại Agent nào → 401 UNAUTHORIZED, KHÔNG set cookie', async () => {
    const email = uniqEmail();
    const res = await request(app).post('/v1/auth/login/device-bypass').send({ email, password: 'BatKy123!', deviceToken: 'khong-quan-trong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  // BUG THẬT 25/7 (Admin Demo tự phát hiện qua test thật với tài khoản CŨ đã có sẵn): Agent tạo TRƯỚC luồng đăng
  // ký mới (rcUserId set nhưng email NULL) không bao giờ redeem được device-bypass, vì tra Agent CHỈ theo email
  // — email null thì KHÔNG khớp bất kỳ chuỗi nào user gõ. Test khóa lại hành vi ĐÚNG (agent thiếu email → tra
  // theo email không thấy → 401 rõ ràng, KHÔNG crash) để nếu sau này có đường code nào lại tạo Agent thiếu
  // email, bug tương tự bị bắt ngay ở đây.
  it('Agent CÓ rcUserId nhưng email NULL (dữ liệu cũ trước luồng đăng ký mới) → device-bypass 401 rõ ràng, KHÔNG lỗi 500/crash', async () => {
    const db = getBotDb();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const agent = await db.agent.create({ data: { name: 'Legacy No Email', rcUserId: `rc-legacy-${suffix}`, rcUsername: `legacy_${suffix}`, email: null, passwordHash: await hashPassword(DEVICE_PASSWORD) } });
    await issueDeviceToken(db, agent.id);

    const res = await request(app).post('/v1/auth/login/device-bypass').send({ email: 'bat-ky-email-nao@example.com', password: DEVICE_PASSWORD, deviceToken: 'khong-quan-trong' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('thiếu field bắt buộc → 400 VALIDATION', async () => {
    const res = await request(app).post('/v1/auth/login/device-bypass').send({ email: uniqEmail() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });
});

describe('POST /v1/auth/device-token/issue + revoke-all — 25/7 (thiết bị tin cậy)', () => {
  const app = createApp();

  // B39 (27/7) — requireSession KHÔNG còn gọi rcGetMe (xem BUGS_FIXED.md B39) — tạo WebSession thật thay mock.
  async function makeAuthedAgent(): Promise<{ agentId: number; headers: Record<string, string> }> {
    const db = getBotDb();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const rcUserId = `rc-issue-${suffix}`;
    const agent = await db.agent.create({ data: { name: 'Device Issue Test', rcUserId, rcUsername: `issue_test_${suffix}` } });
    const ws = await createWebSession(db, { rcUserId, rcAuthToken: 'test-tok', agentId: agent.id });
    return { agentId: agent.id, headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } };
  }

  it('cần requireSession — không có cookie → 401', async () => {
    const res = await request(app).post('/v1/auth/device-token/issue').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE).send({});
    expect(res.status).toBe(401);
  });

  it('có session hợp lệ → 200, cấp token thật lưu đúng agentId trong DB', async () => {
    const db = getBotDb();
    const { agentId, headers } = await makeAuthedAgent();
    const res = await request(app).post('/v1/auth/device-token/issue').set(headers).send({ label: 'test device' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    const row = await db.trustedDevice.findFirst({ where: { agentId } });
    expect(row).not.toBeNull();
    expect(row!.label).toBe('test device');
  });

  // AUDIT FIX (HIGH, phản biện độc lập 25/7) — TRƯỚC ĐÂY route này KHÔNG rate-limit, session bị đánh cắp có
  // thể phát hành vô hạn vé 90 ngày. Test xác nhận limiter THẬT SỰ chặn (không chỉ khai báo cho có).
  it('vượt giới hạn 10 vé/giờ cho CÙNG 1 agent → request thứ 11 trả 429 RATE_LIMITED', async () => {
    const { headers } = await makeAuthedAgent();
    const rateLimitApp = createApp(); // app riêng — limiter module-level không bị test khác trong describe này ăn hết
    for (let i = 0; i < 10; i++) {
      const res = await request(rateLimitApp).post('/v1/auth/device-token/issue').set(headers).send({});
      expect(res.status).toBe(200);
    }
    const eleventh = await request(rateLimitApp).post('/v1/auth/device-token/issue').set(headers).send({});
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error).toBe('RATE_LIMITED');
  });

  it('revoke-all — cần requireSession, không có cookie → 401', async () => {
    const res = await request(app).post('/v1/auth/device-token/revoke-all').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE).send({});
    expect(res.status).toBe(401);
  });

  it('revoke-all — xóa ĐÚNG vé của agent hiện tại, KHÔNG đụng vé của agent khác', async () => {
    const db = getBotDb();
    const { agentId, headers } = await makeAuthedAgent();
    const { agentId: otherAgentId } = await makeAuthedAgent();
    await issueDeviceToken(db, agentId);
    await issueDeviceToken(db, agentId);
    await issueDeviceToken(db, otherAgentId);

    const res = await request(app).post('/v1/auth/device-token/revoke-all').set(headers).send({});
    expect(res.status).toBe(200);
    expect(res.body.revokedCount).toBe(2);

    expect(await db.trustedDevice.count({ where: { agentId } })).toBe(0);
    expect(await db.trustedDevice.count({ where: { agentId: otherAgentId } })).toBe(1); // KHÔNG bị đụng
  });
});
