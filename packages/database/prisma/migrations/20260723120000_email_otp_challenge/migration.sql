-- SIGMA Phase 1 (2026-07-23, CMD_BUILD): thử thách OTP qua email, bền qua restart process (Postgres,
-- KHÔNG in-memory Map). codeHash = SHA-256 mã 6 số, KHÔNG lưu plaintext. Additive thuần: 1 bảng mới,
-- KHÔNG đụng bảng cũ.

CREATE TABLE "email_otp_challenges" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_otp_challenges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "email_otp_challenges_email_idx" ON "email_otp_challenges" ("email");
