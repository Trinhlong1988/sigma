-- Phase B (Admin Demo 9/8) — UỶ qua "tài khoản nhận tiền", MODEL 2-field (tái dùng customerId sẵn có).
-- ReceiveAccount thêm investor_id; UỶ (Khách/NĐT/Nội bộ) SUY RA từ (customerId, investorId) ở service — KHÔNG lưu owyType.
-- TID gắn 1 tài khoản nhận tiền ⇒ suy uỷ qua đó. Máy POS đi theo TID (KHÔNG field). TID thêm invest_fee_milli (×1000).
-- ADDITIVE nullable + index. Viết TAY (KHÔNG `prisma migrate dev` trên DB thật — bài học B113/B27). Idempotent.

ALTER TABLE "receive_accounts" ADD COLUMN IF NOT EXISTS "investor_id" INT;

ALTER TABLE "tids" ADD COLUMN IF NOT EXISTS "receive_account_id" INT;
ALTER TABLE "tids" ADD COLUMN IF NOT EXISTS "invest_fee_milli" INT;

CREATE INDEX IF NOT EXISTS "tids_receive_account_id_idx" ON "tids" ("receive_account_id");
