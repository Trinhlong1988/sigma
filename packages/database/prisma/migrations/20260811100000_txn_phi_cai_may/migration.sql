-- NHÀ ĐẦU TƯ (Admin Demo 11/8) — PHÍ CÀI MÁY áp cho từng GD, chốt lúc tạo. Tất toán NĐT lấy tiền về THEO phí cài máy
-- của TID (per-transaction), không còn dùng %phí cài máy cấu hình ở tab nhà đầu tư. Additive, default 0, idempotent.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "phi_cai_may_milli" INT NOT NULL DEFAULT 0;
