-- NHÀ ĐẦU TƯ Phase C-2a (Admin Demo 10/8) — Sổ TẠM ỨNG vốn + TK CK "đi tiền tạm ứng" của NĐT.
-- ADDITIVE, idempotent (CREATE TABLE/INDEX IF NOT EXISTS): khớp self-heal ensureCriticalSchema (client .exe không
-- có migrate engine). amount BIGINT (int8, tiền VND không giới hạn) như transactions.amount. timestamptz(3).

-- Sổ tạm ứng vốn NĐT (nhiều lần/ngày).
CREATE TABLE IF NOT EXISTS "investor_advances" (
  "id" SERIAL NOT NULL,
  "investor_id" INTEGER NOT NULL,
  "amount" BIGINT NOT NULL,
  "advance_date" TIMESTAMPTZ(3) NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "note" TEXT,
  "created_by" INTEGER,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(3),
  "deleted_by" INTEGER,
  CONSTRAINT "investor_advances_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "investor_advances_investor_id_idx" ON "investor_advances" ("investor_id");
CREATE INDEX IF NOT EXISTS "investor_advances_advance_date_idx" ON "investor_advances" ("advance_date");

-- TK CK NĐT chuyển tiền ứng (để sau OCR khớp — giờ chỉ lưu cấu hình).
CREATE TABLE IF NOT EXISTS "investor_bank_accounts" (
  "id" SERIAL NOT NULL,
  "investor_id" INTEGER NOT NULL,
  "bank_name" TEXT,
  "account_number" TEXT NOT NULL,
  "account_holder" TEXT,
  "note" TEXT,
  "created_by" INTEGER,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(3),
  "deleted_by" INTEGER,
  CONSTRAINT "investor_bank_accounts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "investor_bank_accounts_investor_id_idx" ON "investor_bank_accounts" ("investor_id");
