// SIGMA Phase 1 (23/7, CMD_BUILD) — gửi OTP qua Gmail SMTP (Nodemailer). Đọc OTP_SMTP_USER/
// OTP_SMTP_APP_PASSWORD LÚC GỌI (không cache lúc import — ĐÚNG pattern db.ts, để test đổi env giữa các case
// vẫn ăn đúng, và để process khởi động được ngay cả khi .env chưa điền — chỉ throw lúc THỰC SỰ gửi mail).
// Fail-closed: thiếu biến môi trường → throw OTP_SMTP_NOT_CONFIGURED rõ ràng, KHÔNG âm thầm bỏ qua việc gửi.
import nodemailer, { type Transporter } from 'nodemailer';

export interface OtpEmailContent {
  subject: string;
  text: string;
  html: string;
}

const BRAND = 'SigMa';

/** Build nội dung email OTP (tách riêng khỏi việc gửi thật để test được không cần mock transporter). */
export function buildOtpEmailContent(code: string, expiresMinutes = 10): OtpEmailContent {
  const subject = 'Mã xác thực SigMa';
  const text = `${BRAND} — Mã xác thực của bạn là: ${code}\n\nMã này hết hạn sau ${expiresMinutes} phút. Nếu bạn không yêu cầu mã này, vui lòng bỏ qua email này.`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">
      <h2 style="color:#1657d0;">${BRAND}</h2>
      <p>Mã xác thực của bạn là:</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:4px;color:#1657d0;">${code}</p>
      <p>Mã này hết hạn sau <strong>${expiresMinutes} phút</strong>.</p>
      <p style="color:#666;font-size:13px;">Nếu bạn không yêu cầu mã này, vui lòng bỏ qua email này.</p>
    </div>`;
  return { subject, text, html };
}

class OtpSmtpNotConfiguredError extends Error {
  constructor() {
    super('OTP_SMTP_NOT_CONFIGURED: thiếu OTP_SMTP_USER hoặc OTP_SMTP_APP_PASSWORD trong biến môi trường.');
    this.name = 'OtpSmtpNotConfiguredError';
  }
}

function buildTransporter(): Transporter {
  const user = process.env.OTP_SMTP_USER;
  const pass = process.env.OTP_SMTP_APP_PASSWORD;
  if (!user || !pass) {
    throw new OtpSmtpNotConfiguredError();
  }
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass }
  });
}

/**
 * Gửi email OTP thật qua Gmail SMTP. Cho phép truyền `transporterOverride` để test mock (KHÔNG gọi Gmail
 * thật trong vitest tự động) — tham số này CHỈ dùng cho test, code sản xuất luôn gọi buildTransporter() thật.
 */
export async function sendOtpEmail(
  to: string,
  code: string,
  opts: { expiresMinutes?: number; transporterOverride?: Pick<Transporter, 'sendMail'> } = {}
): Promise<void> {
  const transporter = opts.transporterOverride ?? buildTransporter();
  const content = buildOtpEmailContent(code, opts.expiresMinutes ?? 10);
  const from = process.env.OTP_SMTP_USER ?? 'no-reply@sigma.local';
  await transporter.sendMail({
    from: `"${BRAND}" <${from}>`,
    to,
    subject: content.subject,
    text: content.text,
    html: content.html
  });
}

export { OtpSmtpNotConfiguredError };
