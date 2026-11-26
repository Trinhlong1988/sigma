-- NHÀ ĐẦU TƯ Phase C-2b (Admin Demo 10/8) — % phí cài máy TẤT TOÁN (×1000; 1.06% = 1060). ADDITIVE, idempotent.
-- tiềnVề = doanhThu × (1 − settle_fee_milli/100000). Migration TAY (KHÔNG migrate dev) + self-heal db.ts mỗi boot.
ALTER TABLE "investors" ADD COLUMN IF NOT EXISTS "settle_fee_milli" INT NOT NULL DEFAULT 0;
