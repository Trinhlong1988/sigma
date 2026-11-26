// BẢO MẬT (Admin Demo 6/8) — xóa tài khoản 2 BƯỚC có xác thực: POST /v1/me/request-deletion/send-otp (mật khẩu →
// gửi OTP email) + POST /v1/me/request-deletion/confirm (OTP 6 số + mã xác nhận 2 số) → mới set
// deletionRequestedAt. TÁI HIỆN LỖI CŨ (endpoint 1-bước /v1/me/request-deletion nay bị KHOÁ 410, KHÔNG còn set)
// + TÁI HIỆN ĐÃ FIX (confirm không qua send-otp/sai mật khẩu/sai OTP đều bị chặn, deletionRequestedAt vẫn null).
//
// CÙNG khuôn me-phone.test.ts: session cookie qua createWebSession + CSRF header, MOCK sendOtpEmail (KHÔNG gọi
// SMTP thật), đọc lại mã OTP PLAINTEXT TỪ call-args của mock (mô phỏng đúng góc nhìn người dùng đọc email).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/email-service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/email-service.js')>('../src/email-service.js');
  return { ...actual, sendOtpEmail: vi.fn() }; // GIỮ OtpSmtpNotConfiguredError thật, CHỈ mock việc gửi SMTP.
});

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { sendOtpEmail } from '../src/email-service.js';
import { hashPassword } from '../src/password-service.js';
import { makeAgent } from './fixtures.js';

const PASSWORD = 'Secret123!';

let seq = 0;
function uniqEmail(): string {
  seq += 1;
  return `del-secure-${Date.now()}-${seq}@example.com`;
}
function nextRcUserId(): string {
  seq += 1;
  return `rc-del-secure-${Date.now()}-${seq}`;
}

async function linkAgentToRc(agentId: number): Promise<{ headers: Record<string, string> }> {
  const db = getBotDb();
  const rcUserId = nextRcUserId();
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: rcUserId } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: 'test-tok', agentId });
  return { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } };
}

/** Agent có passwordHash (đăng nhập nội bộ) + email (nhận OTP) + session headers. withEmail=false → email null. */
async function makeLoginAgent(opts: { withEmail?: boolean } = {}): Promise<{ agentId: number; headers: Record<string, string>; email: string | undefined }> {
  const email = opts.withEmail === false ? undefined : uniqEmail();
  const a = await makeAgent(undefined, { email });
  const db = getBotDb();
  await db.agent.update({ where: { id: a.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
  const { headers } = await linkAgentToRc(a.id);
  return { agentId: a.id, headers, email };
}

describe('Xóa tài khoản 2 bước có xác thực — /v1/me/request-deletion/send-otp + /confirm (bảo mật 6/8)', () => {
  const app = createApp();

  beforeEach(() => {
    vi.mocked(sendOtpEmail).mockReset();
    vi.mocked(sendOtpEmail).mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof sendOtpEmail>>);
  });

  it('thiếu session → 401 cho cả send-otp và confirm', async () => {
    const csrf = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
    expect((await request(app).post('/v1/me/request-deletion/send-otp').set(csrf).send({ password: PASSWORD })).status).toBe(401);
    expect((await request(app).post('/v1/me/request-deletion/confirm').set(csrf).send({ code: '000000', confirmNumber: '42' })).status).toBe(401);
  });

  // ── TÁI HIỆN LỖI CŨ (before): endpoint 1-bước KHÔNG xác thực nay bị KHOÁ, KHÔNG set deletionRequestedAt. ──
  it('[gate d] endpoint xóa 1-BƯỚC cũ /v1/me/request-deletion → 410, KHÔNG set deletionRequestedAt (đường xóa không xác thực bị đóng)', async () => {
    const { agentId, headers } = await makeLoginAgent();
    const res = await request(app).post('/v1/me/request-deletion').set(headers);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('DELETION_FLOW_CHANGED');
    const row = await getBotDb().agent.findUnique({ where: { id: agentId } });
    expect(row?.deletionRequestedAt).toBeNull(); // "bấm 1 cái là xóa" KHÔNG còn xảy ra.
  });

  it('confirm mà KHÔNG qua send-otp (không có challenge) → 400 OTP_NOT_FOUND, deletionRequestedAt vẫn null', async () => {
    const { agentId, headers } = await makeLoginAgent();
    const res = await request(app).post('/v1/me/request-deletion/confirm').set(headers).send({ code: '123456', confirmNumber: '42' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('OTP_NOT_FOUND');
    const row = await getBotDb().agent.findUnique({ where: { id: agentId } });
    expect(row?.deletionRequestedAt).toBeNull();
  });

  // ── (a) send-otp sai mật khẩu → 401 ──
  it('[gate a] send-otp SAI mật khẩu → 401 WRONG_PASSWORD, KHÔNG gửi email, deletionRequestedAt vẫn null', async () => {
    const { agentId, headers } = await makeLoginAgent();
    const res = await request(app).post('/v1/me/request-deletion/send-otp').set(headers).send({ password: 'SaiMatKhau!' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('WRONG_PASSWORD');
    expect(sendOtpEmail).not.toHaveBeenCalled();
    const row = await getBotDb().agent.findUnique({ where: { id: agentId } });
    expect(row?.deletionRequestedAt).toBeNull();
  });

  it('send-otp thiếu mật khẩu → 400 VALIDATION, KHÔNG gửi email', async () => {
    const { headers } = await makeLoginAgent();
    const res = await request(app).post('/v1/me/request-deletion/send-otp').set(headers).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  it('send-otp: đúng mật khẩu nhưng tài khoản KHÔNG có email → 400 NO_EMAIL, KHÔNG gửi email', async () => {
    const { headers } = await makeLoginAgent({ withEmail: false });
    const res = await request(app).post('/v1/me/request-deletion/send-otp').set(headers).send({ password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_EMAIL');
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  it('send-otp: đúng mật khẩu + có email → 200 {ok:true}, sendOtpEmail gọi ĐÚNG 1 lần với email + code 6 số, CHƯA set deletionRequestedAt', async () => {
    const { agentId, headers, email } = await makeLoginAgent();
    const res = await request(app).post('/v1/me/request-deletion/send-otp').set(headers).send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(sendOtpEmail).toHaveBeenCalledTimes(1);
    const [sentEmail, sentCode] = vi.mocked(sendOtpEmail).mock.calls[0];
    expect(sentEmail).toBe(email);
    expect(sentCode).toMatch(/^\d{6}$/);

    const row = await getBotDb().agent.findUnique({ where: { id: agentId } });
    expect(row?.deletionRequestedAt).toBeNull(); // gửi mã KHÔNG set trạng thái xóa.
  });

  // ── (b) confirm sai OTP → 400 ──
  it('[gate b] confirm SAI OTP → 400 OTP_WRONG_CODE, deletionRequestedAt vẫn null', async () => {
    const { agentId, headers } = await makeLoginAgent();
    await request(app).post('/v1/me/request-deletion/send-otp').set(headers).send({ password: PASSWORD });

    const res = await request(app).post('/v1/me/request-deletion/confirm').set(headers).send({ code: '000000', confirmNumber: '42' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('OTP_WRONG_CODE');
    const row = await getBotDb().agent.findUnique({ where: { id: agentId } });
    expect(row?.deletionRequestedAt).toBeNull();
  });

  it('confirm thiếu code → 400 VALIDATION; mã 2 số thiếu/không hợp lệ → 400 CONFIRM_NUMBER_INVALID', async () => {
    const { headers } = await makeLoginAgent();
    await request(app).post('/v1/me/request-deletion/send-otp').set(headers).send({ password: PASSWORD });
    const sentCode = vi.mocked(sendOtpEmail).mock.calls[0][1];

    const noCode = await request(app).post('/v1/me/request-deletion/confirm').set(headers).send({ confirmNumber: '42' });
    expect(noCode.status).toBe(400);
    expect(noCode.body.error).toBe('VALIDATION');

    const badConfirm = await request(app).post('/v1/me/request-deletion/confirm').set(headers).send({ code: sentCode, confirmNumber: '4' });
    expect(badConfirm.status).toBe(400);
    expect(badConfirm.body.error).toBe('CONFIRM_NUMBER_INVALID');
  });

  // ── (c) confirm đúng → set deletionRequestedAt ──
  it('[gate c] confirm đúng OTP + mã 2 số → 200, set deletionRequestedAt + deleteAt=+48h, DB ghi thật', async () => {
    const { agentId, headers } = await makeLoginAgent();
    const before = Date.now();
    await request(app).post('/v1/me/request-deletion/send-otp').set(headers).send({ password: PASSWORD });
    const sentCode = vi.mocked(sendOtpEmail).mock.calls[0][1];

    const res = await request(app).post('/v1/me/request-deletion/confirm').set(headers).send({ code: sentCode, confirmNumber: '42' });
    const after = Date.now();
    expect(res.status).toBe(200);
    expect(res.body.deletionRequestedAt).not.toBeNull();
    expect(res.body.deleteAt).not.toBeNull();

    const requestedAtMs = new Date(res.body.deletionRequestedAt).getTime();
    const deleteAtMs = new Date(res.body.deleteAt).getTime();
    expect(requestedAtMs).toBeGreaterThanOrEqual(before);
    expect(requestedAtMs).toBeLessThanOrEqual(after);
    expect(deleteAtMs - requestedAtMs).toBe(48 * 60 * 60 * 1000);

    const row = await getBotDb().agent.findUnique({ where: { id: agentId } });
    expect(row?.deletionRequestedAt?.getTime()).toBe(requestedAtMs);
  });

  it('confirm idempotent: send-otp lần 2 + confirm lần 2 KHÔNG reset mốc 48h gốc', async () => {
    const { headers } = await makeLoginAgent();
    await request(app).post('/v1/me/request-deletion/send-otp').set(headers).send({ password: PASSWORD });
    const code1 = vi.mocked(sendOtpEmail).mock.calls[0][1];
    const first = await request(app).post('/v1/me/request-deletion/confirm').set(headers).send({ code: code1, confirmNumber: '42' });
    expect(first.status).toBe(200);

    await new Promise((r) => setTimeout(r, 30));
    await request(app).post('/v1/me/request-deletion/send-otp').set(headers).send({ password: PASSWORD });
    const code2 = vi.mocked(sendOtpEmail).mock.calls[1][1];
    const second = await request(app).post('/v1/me/request-deletion/confirm').set(headers).send({ code: code2, confirmNumber: '42' });
    expect(second.status).toBe(200);
    expect(second.body.deletionRequestedAt).toBe(first.body.deletionRequestedAt); // giữ mốc gốc, không reset.
  });

  it('rate-limit send-otp: 5 lần/giờ cho CÙNG agent → lần 6 = 429 (sai mật khẩu cũng tiêu slot, chặn brute-force)', async () => {
    const { headers } = await makeLoginAgent();
    for (let i = 0; i < 5; i += 1) {
      const r = await request(app).post('/v1/me/request-deletion/send-otp').set(headers).send({ password: 'SaiMatKhau!' });
      expect(r.status).toBe(401); // sai mật khẩu nhưng vẫn tiêu 1 slot limiter.
    }
    const sixth = await request(app).post('/v1/me/request-deletion/send-otp').set(headers).send({ password: PASSWORD });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toBe('RATE_LIMITED');
  });
});
