import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOtpEmailContent, sendOtpEmail, OtpSmtpNotConfiguredError } from '../src/email-service.js';

describe('email-service — buildOtpEmailContent', () => {
  it('subject đúng "Mã xác thực SigMa", chứa mã 6 số + "hết hạn sau 10 phút" trong text lẫn html', () => {
    const c = buildOtpEmailContent('123456');
    expect(c.subject).toBe('Mã xác thực SigMa');
    expect(c.text).toContain('123456');
    expect(c.text).toContain('hết hạn sau 10 phút');
    expect(c.html).toContain('123456');
    expect(c.html).toContain('SigMa');
  });

  it('cho phép đổi số phút hết hạn', () => {
    const c = buildOtpEmailContent('654321', 5);
    expect(c.text).toContain('hết hạn sau 5 phút');
  });
});

describe('email-service — sendOtpEmail', () => {
  afterEach(() => {
    delete process.env.OTP_SMTP_USER;
    delete process.env.OTP_SMTP_APP_PASSWORD;
  });

  it('gọi transporter.sendMail với to/subject/mã đúng (mock transporter, KHÔNG gọi Gmail thật)', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'test' });
    await sendOtpEmail('agent@example.com', '999888', { transporterOverride: { sendMail } });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const call = sendMail.mock.calls[0][0];
    expect(call.to).toBe('agent@example.com');
    expect(call.subject).toBe('Mã xác thực SigMa');
    expect(call.text).toContain('999888');
  });

  it('thiếu OTP_SMTP_USER/OTP_SMTP_APP_PASSWORD (không truyền override) → throw OtpSmtpNotConfiguredError, fail-closed', async () => {
    delete process.env.OTP_SMTP_USER;
    delete process.env.OTP_SMTP_APP_PASSWORD;
    await expect(sendOtpEmail('agent@example.com', '111222')).rejects.toBeInstanceOf(OtpSmtpNotConfiguredError);
  });
});
