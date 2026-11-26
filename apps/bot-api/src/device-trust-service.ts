// SIGMA Phase 3 (25/7, Admin Demo chốt "thiết bị mới → OTP; thiết bị cũ đã đăng nhập rồi → chỉ cần mật
// khẩu") — cấp/kiểm "vé nhớ máy" (bảng TrustedDevice, xem comment schema.prisma). CÙNG khuôn otp-service.ts:
// token ngẫu nhiên CSPRNG (`crypto.randomBytes`, KHÔNG Math.random), CHỈ lưu HASH SHA-256 — plaintext chỉ
// tồn tại trong bộ nhớ tạm để trả về client 1 LẦN DUY NHẤT lúc cấp, không bao giờ ghi xuống DB/log lại.
import { createHash, randomBytes } from 'node:crypto';
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

const TOKEN_BYTES = 32; // 32 byte ngẫu nhiên → 64 ký tự hex, đủ entropy cho vé dài hạn (khác OTP 6 số ngắn hạn).
const EXPIRES_DAYS = 90; // khớp TTL authToken Rocket.Chat đã biết trước đó (xem VERSION.md 24/7) — KHÔNG có
// spec riêng từ Admin Demo cho việc này, chọn mặc định kỹ thuật hợp lý, không phải business rule.

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedDeviceToken {
  token: string; // PLAINTEXT — CHỈ dùng để trả về client NGAY sau khi gọi hàm này, KHÔNG lưu lại nơi khác.
  expiresAt: Date;
}

/** Cấp 1 vé nhớ máy MỚI cho agentId — gọi SAU khi agent đã qua đủ xác thực thật (2FA-email lúc đăng nhập,
 * hoặc verify-otp lúc đăng ký) trên đúng thiết bị này. KHÔNG thu hồi vé cũ (1 agent có thể có nhiều thiết bị
 * tin cậy song song — máy tính + điện thoại), đúng bản chất "trusted devices" số nhiều. */
export async function issueDeviceToken(db: Db, agentId: number, label?: string): Promise<IssuedDeviceToken> {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + EXPIRES_DAYS * 24 * 60 * 60 * 1000);
  await db.trustedDevice.create({
    data: { agentId, tokenHash: hashToken(token), label: label?.slice(0, 200) || null, expiresAt }
  });
  return { token, expiresAt };
}

/** Kiểm vé nhớ máy: token PHẢI khớp hash lưu sẵn CHO ĐÚNG agentId (email đăng nhập phải trùng chủ vé — vé
 * lấy được từ tài khoản A không dùng bypass được cho tài khoản B trên cùng máy) VÀ chưa hết hạn. Valid →
 * cập nhật lastUsedAt (theo dõi, KHÔNG ảnh hưởng logic) rồi trả true. KHÔNG throw — sai/hết hạn là kết quả
 * hợp lệ (client tự fallback về luồng OTP thường), không phải lỗi hệ thống. */
export async function validateAndTouchDeviceToken(db: Db, agentId: number, rawToken: string): Promise<boolean> {
  if (!rawToken) return false;
  const row = await db.trustedDevice.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!row || row.agentId !== agentId) return false;
  if (row.expiresAt.getTime() < Date.now()) return false;
  await db.trustedDevice.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  return true;
}
