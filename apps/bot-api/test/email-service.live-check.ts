// Script CHẠY TAY để gửi OTP email THẬT qua Gmail SMTP — KHÔNG phải file *.test.ts nên KHÔNG bị vitest
// include, KHÔNG chạy trong `npm test`/CI. Chạy bằng:
//   npm run test:email-live --workspace @sigma/bot-api
// Cần OTP_SMTP_USER + OTP_SMTP_APP_PASSWORD thật trong .env. Gửi tới chính OTP_SMTP_USER (send-to-self)
// để xác nhận SMTP hoạt động thật mà không cần biết trước một địa chỉ nhận nào khác.
import 'dotenv/config';
import { sendOtpEmail } from '../src/email-service.js';

async function main(): Promise<void> {
  const to = process.env.OTP_SMTP_USER;
  if (!to) {
    console.log('[email-live-check] thiếu OTP_SMTP_USER trong env — bỏ qua (không phải lỗi, đây là script chạy tay).');
    return;
  }
  const testCode = String(Math.floor(100000 + Math.random() * 900000));
  console.log(`[email-live-check] gửi OTP thật tới ${to} (mã test: ${testCode})...`);
  await sendOtpEmail(to, testCode, { expiresMinutes: 10 });
  console.log('[email-live-check] sendMail() không throw — Gmail SMTP đã chấp nhận email để gửi. Kiểm hộp thư để xác nhận nhận được thật.');
}

main().catch((err) => {
  console.error('[email-live-check] LỖI (SMTP auth/kết nối thất bại):', err);
  process.exitCode = 1;
});
