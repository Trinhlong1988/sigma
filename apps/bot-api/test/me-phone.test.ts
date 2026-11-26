// SIGMA "Thêm/đổi SĐT xác thực qua OTP SMS eSMS.vn" (4/8, CMD_BUILD) — test route
// POST /v1/me/phone/otp/request + /verify (routes/me.ts). CÙNG khuôn me-profile.test.ts (session cookie qua
// createWebSession + CSRF header) nhưng mock `sendOtpSms` thay `sendOtpEmail` — KHÔNG gọi eSMS thật trong test
// tự động, đọc lại mã OTP PLAINTEXT + SĐT đã chuẩn hoá TỪ CHÍNH call-args của mock (mô phỏng đúng góc nhìn
// client thật). Assert GIÁ TRỊ THẬT: Phone=84…, code, ghi đúng Agent.phone.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/esms-service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/esms-service.js')>('../src/esms-service.js');
  return { ...actual, sendOtpSms: vi.fn() }; // GIỮ normalize* + Error classes thật, CHỈ mock việc gửi HTTP.
});

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { sendOtpSms, EsmsNotConfiguredError } from '../src/esms-service.js';
import { makeAgent } from './fixtures.js';

let rcCounter = 0;
function nextRcUserId(): string {
  rcCounter += 1;
  return `rc-me-phone-test-${Date.now()}-${rcCounter}`;
}

async function linkAgentToRc(agentId: number): Promise<{ headers: Record<string, string> }> {
  const db = getBotDb();
  const rcUserId = nextRcUserId();
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: rcUserId } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: 'test-tok', agentId });
  return { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } };
}

// SĐT ngẫu nhiên hợp lệ (đầu 09 + 8 số) — tránh 2 test đụng cùng bucket rate-limit theo SĐT.
function uniqPhone(): string {
  const n = String(Math.floor(10_000_000 + Math.random() * 89_999_999));
  return `09${n}`;
}

describe('POST /v1/me/phone/otp/request + /verify — thêm/đổi SĐT (4/8, OTP SMS eSMS.vn)', () => {
  const app = createApp();

  beforeEach(() => {
    vi.mocked(sendOtpSms).mockReset();
    vi.mocked(sendOtpSms).mockResolvedValue({ smsId: 'test-sms-id' });
  });

  it('thiếu session → 401 cho cả request và verify', async () => {
    const csrf = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
    expect((await request(app).post('/v1/me/phone/otp/request').set(csrf).send({ phone: uniqPhone() })).status).toBe(401);
    expect((await request(app).post('/v1/me/phone/otp/verify').set(csrf).send({ phone: uniqPhone(), code: '000000' })).status).toBe(401);
  });

  it('request: SĐT sai định dạng → 400 VALIDATION, KHÔNG gửi SMS', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const res = await request(app).post('/v1/me/phone/otp/request').set(headers).send({ phone: '12345' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
    expect(sendOtpSms).not.toHaveBeenCalled();
  });

  it('request thành công → 200 {ok:true}, sendOtpSms gọi ĐÚNG 1 lần với Phone=84… + code 6 số, CHƯA ghi Agent.phone', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const phone = uniqPhone(); // "09xxxxxxxx"

    const res = await request(app).post('/v1/me/phone/otp/request').set(headers).send({ phone });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(sendOtpSms).toHaveBeenCalledTimes(1);
    const [sentPhone, sentCode] = vi.mocked(sendOtpSms).mock.calls[0];
    // Gửi tới dạng 84… (KHÔNG phải 0…): "0912345678" → "84912345678".
    expect(sentPhone).toBe(`84${phone.slice(1)}`);
    expect(sentPhone).toMatch(/^84\d{9}$/);
    expect(sentCode).toMatch(/^\d{6}$/);

    // Chưa verify → Agent.phone CHƯA đổi.
    const check = await getBotDb().agent.findUnique({ where: { id: a.id } });
    expect(check?.phone).toBeNull();
  });

  it('request: SMS chưa cấu hình (EsmsNotConfiguredError) → 500 SMS_NOT_CONFIGURED, fail-closed', async () => {
    vi.mocked(sendOtpSms).mockRejectedValueOnce(new EsmsNotConfiguredError('ESMS_API_KEY'));
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);

    const res = await request(app).post('/v1/me/phone/otp/request').set(headers).send({ phone: uniqPhone() });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('SMS_NOT_CONFIGURED');
  });

  it('verify: sai mã OTP → 400 OTP_WRONG_CODE, Agent.phone KHÔNG đổi', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const phone = uniqPhone();

    await request(app).post('/v1/me/phone/otp/request').set(headers).send({ phone });

    const res = await request(app).post('/v1/me/phone/otp/verify').set(headers).send({ phone, code: '000000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('OTP_WRONG_CODE');

    const check = await getBotDb().agent.findUnique({ where: { id: a.id } });
    expect(check?.phone).toBeNull();
  });

  it('verify: thiếu code → 400 VALIDATION', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const res = await request(app).post('/v1/me/phone/otp/verify').set(headers).send({ phone: uniqPhone() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('verify: mã ĐÚNG → 200, Agent.phone ghi thật (dạng 0…), GET /v1/me/profile phản ánh SĐT mới', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const phone = uniqPhone();

    await request(app).post('/v1/me/phone/otp/request').set(headers).send({ phone });
    const sentCode = vi.mocked(sendOtpSms).mock.calls[0][1];

    const verifyRes = await request(app).post('/v1/me/phone/otp/verify').set(headers).send({ phone, code: sentCode });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.phone).toBe(phone); // lưu dạng 0xxxxxxxxx

    const getRes = await request(app).get('/v1/me/profile').set(headers);
    expect(getRes.body.phone).toBe(phone);

    const check = await getBotDb().agent.findUnique({ where: { id: a.id } });
    expect(check?.phone).toBe(phone);
  });

  it('verify: chấp nhận SĐT gõ dạng +84 nhưng lưu dạng 0… (chuẩn hoá 1 quy ước)', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const local = uniqPhone(); // 0xxxxxxxxx
    const plus84 = `+84${local.slice(1)}`;

    await request(app).post('/v1/me/phone/otp/request').set(headers).send({ phone: plus84 });
    const sentCode = vi.mocked(sendOtpSms).mock.calls[0][1];

    // Verify gõ dạng KHÁC (0…) cùng số → cùng challenge (key theo 84…) → OK.
    const verifyRes = await request(app).post('/v1/me/phone/otp/verify').set(headers).send({ phone: local, code: sentCode });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.phone).toBe(local);
  });

  it('verify: dùng lại CÙNG mã sau khi đã verify thành công lần 1 → 400 OTP_NOT_FOUND (mã đã tiêu dùng)', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const phone = uniqPhone();

    await request(app).post('/v1/me/phone/otp/request').set(headers).send({ phone });
    const sentCode = vi.mocked(sendOtpSms).mock.calls[0][1];

    const first = await request(app).post('/v1/me/phone/otp/verify').set(headers).send({ phone, code: sentCode });
    expect(first.status).toBe(200);

    const second = await request(app).post('/v1/me/phone/otp/verify').set(headers).send({ phone, code: sentCode });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('OTP_NOT_FOUND');
  });

  it('rate-limit: quá 5 lần request cho CÙNG 1 SĐT trong 1 giờ → 429', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const phone = uniqPhone();

    for (let i = 0; i < 5; i += 1) {
      const ok = await request(app).post('/v1/me/phone/otp/request').set(headers).send({ phone });
      expect(ok.status).toBe(200);
    }
    const blocked = await request(app).post('/v1/me/phone/otp/request').set(headers).send({ phone });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('RATE_LIMITED');
  });
});
