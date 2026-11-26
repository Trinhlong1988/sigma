-- Chi tiết TẠM ỨNG nhà đầu tư (Admin Demo 11/8): sổ tạm ứng lưu thêm thông tin người ứng + người nhận
-- (STK/tên/ngân hàng). Nguồn OCR bill hoặc nhập tay. 6 cột TEXT nullable additive — bản ghi cũ vẫn hợp lệ.
-- IF NOT EXISTS → idempotent (chạy lại/self-heal db.ts không lỗi).
ALTER TABLE "investor_advances" ADD COLUMN IF NOT EXISTS "sender_account_number" TEXT;
ALTER TABLE "investor_advances" ADD COLUMN IF NOT EXISTS "sender_name" TEXT;
ALTER TABLE "investor_advances" ADD COLUMN IF NOT EXISTS "sender_bank" TEXT;
ALTER TABLE "investor_advances" ADD COLUMN IF NOT EXISTS "receiver_account_number" TEXT;
ALTER TABLE "investor_advances" ADD COLUMN IF NOT EXISTS "receiver_name" TEXT;
ALTER TABLE "investor_advances" ADD COLUMN IF NOT EXISTS "receiver_bank" TEXT;
