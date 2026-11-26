-- BRIDGE bill→doanh số SigMa (Admin Demo 24/8): Lô ghi từ bill tự tạo 1 Transaction để báo cáo Quản Lý
-- SigMa (đọc bảng transactions) thấy doanh số. Link 1-1 chống tạo GD trùng khi bill gửi-lại (dedup UPSERT cùng
-- Lô). Nullable + UNIQUE → best-effort (null nếu chưa/không tạo được GD, vd thiếu FeeRate).
ALTER TABLE "los" ADD COLUMN IF NOT EXISTS "transaction_id" INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS "los_transaction_id_key" ON "los"("transaction_id");
