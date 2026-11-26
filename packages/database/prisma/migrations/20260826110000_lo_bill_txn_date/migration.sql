-- BACKFILL DRIFT (Admin Demo 1/9): cột `bill_txn_date` (NGÀY BILL THẬT — giờ quẹt OCR, lưu lúc /send để reconcile/
-- redate rơi ĐÚNG NGÀY bill thay created_at) đã thêm vào DB `sigma` production bằng raw ALTER (lo-service
-- persistLoBillTxnDate/readLoBillTxnDate) + đã khai trong schema.prisma (model Lo) nhưng THIẾU migration → guard
-- schema-drift-guard báo drift. Codify raw-ALTER thành migration (bài học B113). IF NOT EXISTS → an toàn replay.
ALTER TABLE "los" ADD COLUMN IF NOT EXISTS "bill_txn_date" TIMESTAMPTZ(3);
