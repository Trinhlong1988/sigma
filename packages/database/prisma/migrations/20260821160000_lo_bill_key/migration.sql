-- Nối bill→doanh số (Admin Demo 21/8): khóa BILL tự nhiên trên los để gửi-lại/SỬA cùng bill = UPSERT cùng Lô
-- (chống Lô trùng + sửa bill cập nhật số tiền). Nullable → Lô "Bán TID" thủ công không ảnh hưởng.
ALTER TABLE "los" ADD COLUMN IF NOT EXISTS "bill_key" TEXT;
CREATE INDEX IF NOT EXISTS "los_agent_id_bill_key_idx" ON "los"("agent_id", "bill_key");
