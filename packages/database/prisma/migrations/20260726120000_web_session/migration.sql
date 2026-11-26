-- SIGMA (26/7) — WebSession: cookie-session server-side cho luong bot-api lam trung gian toan bo
-- Rocket.Chat REST+WebSocket (giai no B9/B11 — token RC KHONG con luu localStorage/tra ve client).
-- Additive thuan: 1 bang moi, KHONG dung bang/cot cu.

CREATE TABLE "web_sessions" (
    "id" TEXT NOT NULL,
    "rc_user_id" TEXT NOT NULL,
    "rc_username" TEXT,
    "rc_auth_token" TEXT NOT NULL,
    "agent_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "web_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "web_sessions_agent_id_idx" ON "web_sessions" ("agent_id");
