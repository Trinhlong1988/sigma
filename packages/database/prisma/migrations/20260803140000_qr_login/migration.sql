-- SIGMA (3/8) — QrLoginChallenge: dang nhap bang quet QR dong (kieu Zalo/WhatsApp Web).
-- Additive thuan: 1 bang moi, KHONG dung/sua bang/cot cu nao. Viet TAY (KHONG prisma migrate dev tren DB that).

CREATE TABLE "qr_login_challenges" (
    "id" SERIAL NOT NULL,
    "token_hash" TEXT NOT NULL,
    "poll_secret_hash" TEXT NOT NULL,
    "match_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requester_ip" TEXT,
    "requester_ua" TEXT,
    "approve_attempts" INTEGER NOT NULL DEFAULT 0,
    "agent_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "approved_at" TIMESTAMPTZ(3),
    "consumed_at" TIMESTAMPTZ(3),
    CONSTRAINT "qr_login_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "qr_login_challenges_token_hash_key" ON "qr_login_challenges" ("token_hash");
CREATE INDEX "qr_login_challenges_poll_secret_hash_idx" ON "qr_login_challenges" ("poll_secret_hash");
CREATE INDEX "qr_login_challenges_agent_id_idx" ON "qr_login_challenges" ("agent_id");
CREATE INDEX "qr_login_challenges_expires_at_idx" ON "qr_login_challenges" ("expires_at");
