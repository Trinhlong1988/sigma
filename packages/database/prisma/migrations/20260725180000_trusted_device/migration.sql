-- SIGMA (25/7) — Thiet bi tin cay (Phase 3: "thiet bi moi -> OTP; thiet bi cu da dang nhap roi -> chi
-- can mat khau"). Additive thuan: 1 bang moi, KHONG dung bang/cot cu.

CREATE TABLE "trusted_devices" (
    "id" SERIAL NOT NULL,
    "agent_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trusted_devices_token_hash_key" ON "trusted_devices" ("token_hash");
CREATE INDEX "trusted_devices_agent_id_idx" ON "trusted_devices" ("agent_id");
