-- SIGMA Phase 1 CMD_BUILD fix (2026-07-24) — Bug 2 tìm thấy bởi CMD_AUDIT 23/7: OTP đúng bị "đốt"
-- (consumed_at set) NGAY khi verify, TRƯỚC khi rcCreateUser chạy — nếu rcCreateUser thất bại giữa chừng,
-- user phải xin mã mới dù lỗi không do họ. Tách "xác minh mã đúng" (verified_at = CLAIM tạm) khỏi "tiêu
-- dùng thật" (consumed_at = terminal, set SAU KHI rcCreateUser thành công). Nếu downstream fail →
-- verified_at reset null (releaseOtpChallenge) → mã verify lại được. Đồng thời verified_at chặn 2 request
-- verify song song cùng mã đúng cùng lúc claim (xem otp-service.ts verifyOtpChallenge). Additive thuần:
-- 1 cột mới nullable, KHÔNG đụng cột/bảng cũ, KHÔNG cần backfill (NULL = hành vi cũ "chưa claim").

ALTER TABLE "email_otp_challenges" ADD COLUMN "verified_at" TIMESTAMPTZ(3);
