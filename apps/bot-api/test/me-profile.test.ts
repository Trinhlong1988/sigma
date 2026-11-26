// SIGMA "Hồ sơ cá nhân" (1/8) — test route GET/PATCH /v1/me/profile + POST /v1/me/email-change/request-otp
// + /confirm (routes/me.ts). CÙNG khuôn me-categories.test.ts (session cookie qua createWebSession + CSRF
// header) + auth-routes.test.ts (mock sendOtpEmail — không gửi Gmail thật trong test tự động, đọc lại mã OTP
// PLAINTEXT từ chính call-args của mock thay vì gọi thẳng otp-service, mô phỏng đúng góc nhìn client thật).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/email-service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/email-service.js')>('../src/email-service.js');
  return { ...actual, sendOtpEmail: vi.fn() };
});

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { sendOtpEmail } from '../src/email-service.js';
import { makeAgent } from './fixtures.js';

let rcCounter = 0;
function nextRcUserId(): string {
  rcCounter += 1;
  return `rc-me-profile-test-${Date.now()}-${rcCounter}`;
}

async function linkAgentToRc(agentId: number): Promise<{ headers: Record<string, string> }> {
  const db = getBotDb();
  const rcUserId = nextRcUserId();
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: rcUserId } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: 'test-tok', agentId });
  return { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } };
}

function uniqEmail(): string {
  return `me_profile_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`;
}

describe('GET/PATCH /v1/me/profile — Hồ sơ cá nhân (1/8)', () => {
  const app = createApp();

  it('thiếu session → 401 cho cả GET và PATCH', async () => {
    const csrf = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
    expect((await request(app).get('/v1/me/profile').set(csrf)).status).toBe(401);
    expect((await request(app).patch('/v1/me/profile').set(csrf).send({ name: 'X' })).status).toBe(401);
  });

  it('GET trả đúng hồ sơ đại lý đang đăng nhập', async () => {
    const email = uniqEmail();
    const a = await makeAgent(undefined, { name: 'Đại Lý Test', email, phone: '0909000111', dateOfBirth: new Date('1992-07-04') });
    const { headers } = await linkAgentToRc(a.id);

    const res = await request(app).get('/v1/me/profile').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'Đại Lý Test', email, gender: null, dateOfBirth: '1992-07-04', phone: '0909000111' });
  });

  it('PATCH happy path đổi name/gender/dateOfBirth → 200, GET phản ánh đúng', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);

    const patchRes = await request(app).patch('/v1/me/profile').set(headers).send({ name: 'Tên Mới', gender: 'MALE', dateOfBirth: '1999-12-25' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.name).toBe('Tên Mới');
    expect(patchRes.body.gender).toBe('MALE');
    expect(patchRes.body.dateOfBirth).toBe('1999-12-25');

    const getRes = await request(app).get('/v1/me/profile').set(headers);
    expect(getRes.body.name).toBe('Tên Mới');
  });

  it('PATCH gender sai giá trị → 400 VALIDATION', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const res = await request(app).patch('/v1/me/profile').set(headers).send({ gender: 'ROBOT' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('PATCH body chứa field email → 400 VALIDATION, KHÔNG đổi gì (phải qua route email-change riêng)', async () => {
    const email = uniqEmail();
    const a = await makeAgent(undefined, { email });
    const { headers } = await linkAgentToRc(a.id);
    const res = await request(app).patch('/v1/me/profile').set(headers).send({ email: 'hacked@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');

    const check = await getBotDb().agent.findUnique({ where: { id: a.id } });
    expect(check?.email).toBe(email); // KHÔNG bị đổi
  });

  it('PATCH body chứa field phone → 400 VALIDATION (chưa có hạ tầng SMS)', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const res = await request(app).patch('/v1/me/profile').set(headers).send({ phone: '0999999999' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });
});

describe('POST /v1/me/email-change/request-otp + /confirm — đổi email liên kết (1/8, OTP kiểu Zalo)', () => {
  const app = createApp();

  beforeEach(() => {
    vi.mocked(sendOtpEmail).mockReset();
    vi.mocked(sendOtpEmail).mockResolvedValue(undefined);
  });

  it('thiếu session → 401 cho cả request-otp và confirm', async () => {
    const csrf = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
    expect((await request(app).post('/v1/me/email-change/request-otp').set(csrf).send({ newEmail: uniqEmail() })).status).toBe(401);
    expect((await request(app).post('/v1/me/email-change/confirm').set(csrf).send({ newEmail: uniqEmail(), code: '000000' })).status).toBe(401);
  });

  it('request-otp: newEmail sai định dạng → 400 VALIDATION, KHÔNG gửi mail', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const res = await request(app).post('/v1/me/email-change/request-otp').set(headers).send({ newEmail: 'khong-hop-le' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  it('request-otp: newEmail đã thuộc agent khác → 409 EMAIL_ALREADY_REGISTERED, KHÔNG gửi mail', async () => {
    const takenEmail = uniqEmail();
    await makeAgent(undefined, { email: takenEmail });
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);

    const res = await request(app).post('/v1/me/email-change/request-otp').set(headers).send({ newEmail: takenEmail });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('EMAIL_ALREADY_REGISTERED');
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  it('request-otp thành công → 200 {ok:true}, sendOtpEmail gọi ĐÚNG 1 lần TỚI EMAIL MỚI (không phải email cũ)', async () => {
    const oldEmail = uniqEmail();
    const newEmail = uniqEmail();
    const a = await makeAgent(undefined, { email: oldEmail });
    const { headers } = await linkAgentToRc(a.id);

    const res = await request(app).post('/v1/me/email-change/request-otp').set(headers).send({ newEmail });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sendOtpEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendOtpEmail).mock.calls[0][0]).toBe(newEmail);

    // Chưa confirm → Agent.email CHƯA đổi (chỉ gửi mã, chưa ghi DB thật).
    const check = await getBotDb().agent.findUnique({ where: { id: a.id } });
    expect(check?.email).toBe(oldEmail);
  });

  it('confirm: sai mã OTP → 400 OTP_WRONG_CODE, email KHÔNG đổi', async () => {
    const oldEmail = uniqEmail();
    const newEmail = uniqEmail();
    const a = await makeAgent(undefined, { email: oldEmail });
    const { headers } = await linkAgentToRc(a.id);

    await request(app).post('/v1/me/email-change/request-otp').set(headers).send({ newEmail });

    const res = await request(app).post('/v1/me/email-change/confirm').set(headers).send({ newEmail, code: '000000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('OTP_WRONG_CODE');

    const check = await getBotDb().agent.findUnique({ where: { id: a.id } });
    expect(check?.email).toBe(oldEmail);
  });

  it('confirm: thiếu code → 400 VALIDATION', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const res = await request(app).post('/v1/me/email-change/confirm').set(headers).send({ newEmail: uniqEmail() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('confirm: mã ĐÚNG → 200, Agent.email đổi thật, GET /v1/me/profile phản ánh email mới', async () => {
    const oldEmail = uniqEmail();
    const newEmail = uniqEmail();
    const a = await makeAgent(undefined, { email: oldEmail });
    const { headers } = await linkAgentToRc(a.id);

    await request(app).post('/v1/me/email-change/request-otp').set(headers).send({ newEmail });
    const sentCode = vi.mocked(sendOtpEmail).mock.calls[0][1];

    const confirmRes = await request(app).post('/v1/me/email-change/confirm').set(headers).send({ newEmail, code: sentCode });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.email).toBe(newEmail);

    const getRes = await request(app).get('/v1/me/profile').set(headers);
    expect(getRes.body.email).toBe(newEmail);
  });

  it('confirm: newEmail bị agent KHÁC giành mất GIỮA lúc request-otp và confirm → 409, mã OTP không bị đốt oan', async () => {
    const oldEmail = uniqEmail();
    const newEmail = uniqEmail();
    const a = await makeAgent(undefined, { email: oldEmail });
    const { headers } = await linkAgentToRc(a.id);

    await request(app).post('/v1/me/email-change/request-otp').set(headers).send({ newEmail });
    const sentCode = vi.mocked(sendOtpEmail).mock.calls[0][1];

    // 1 agent khác kịp đăng ký/đổi sang ĐÚNG newEmail này trước khi confirm.
    await makeAgent(undefined, { email: newEmail });

    const confirmRes = await request(app).post('/v1/me/email-change/confirm').set(headers).send({ newEmail, code: sentCode });
    expect(confirmRes.status).toBe(409);
    expect(confirmRes.body.error).toBe('EMAIL_ALREADY_REGISTERED');

    const check = await getBotDb().agent.findUnique({ where: { id: a.id } });
    expect(check?.email).toBe(oldEmail); // KHÔNG đổi
  });

  it('confirm: dùng lại CÙNG mã sau khi đã confirm thành công lần 1 → outcome NOT_FOUND/consumed (không đổi email lần 2 sai giá trị)', async () => {
    const oldEmail = uniqEmail();
    const newEmail = uniqEmail();
    const a = await makeAgent(undefined, { email: oldEmail });
    const { headers } = await linkAgentToRc(a.id);

    await request(app).post('/v1/me/email-change/request-otp').set(headers).send({ newEmail });
    const sentCode = vi.mocked(sendOtpEmail).mock.calls[0][1];

    const first = await request(app).post('/v1/me/email-change/confirm').set(headers).send({ newEmail, code: sentCode });
    expect(first.status).toBe(200);

    const second = await request(app).post('/v1/me/email-change/confirm').set(headers).send({ newEmail, code: sentCode });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('OTP_NOT_FOUND');
  });
});
