-- BACKFILL DRIFT (Admin Demo 1/9): cột `ref_number` (mã GD/số TT trên bill, nguồn OCR — dedup 1 (investor, ref) 1
-- lần) đã được thêm vào DB `sigma` production bằng raw ALTER + đã khai trong schema.prisma (model
-- InvestorAdvance) nhưng THIẾU migration → guard schema-drift-guard báo drift. Codify raw-ALTER thành migration
-- (bài học B113 — schema PHẢI khớp migrations). IF NOT EXISTS → an toàn replay trên DB đã có cột.
ALTER TABLE "investor_advances" ADD COLUMN IF NOT EXISTS "ref_number" TEXT;
