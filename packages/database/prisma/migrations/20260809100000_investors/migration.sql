-- NHÀ ĐẦU TƯ (Admin Demo 9/8, Phase A) — bảng investors (mirror customers) + %phí đầu tư (invest_fee_milli ×1000).
-- SEC/DEPLOY-FIX 12/8: IF NOT EXISTS cho CREATE TABLE + 2 INDEX để KHỚP self-heal ensureCriticalSchema (db.ts
-- tạo bảng investors + 2 index này lúc boot client .exe không có migrate engine). TRƯỚC: bare CREATE → `migrate
-- deploy` trên DB đã self-heal FAIL "relation already exists". NGỮ NGHĨA schema KHÔNG đổi (chỉ thêm IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS "investors" (
  "id" SERIAL NOT NULL,
  "code" TEXT NOT NULL,
  "full_name" TEXT NOT NULL,
  "nickname" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "phone" TEXT, "email" TEXT, "address" TEXT,
  "invest_fee_milli" INTEGER NOT NULL DEFAULT 0,
  "user_id" INTEGER,
  "note" TEXT,
  "created_by" INTEGER,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(3), "deleted_by" INTEGER,
  CONSTRAINT "investors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "investors_code_key" ON "investors" ("code");
CREATE INDEX IF NOT EXISTS "investors_deleted_at_status_idx" ON "investors" ("deleted_at", "status");
