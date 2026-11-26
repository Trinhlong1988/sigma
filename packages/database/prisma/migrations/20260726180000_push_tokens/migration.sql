-- SIGMA (26/7) — PushToken: luu token thiet bi (FCM) de gui push notification kieu Zalo khi co tin
-- nhan moi, ngay ca khi app da tat/chay nen. Additive thuan: 1 bang moi, KHONG dung bang/cot cu.
-- KHONG tu ap dung migration nay len DB production — LEAD tu chay sau khi review (quy tac cung du an).

CREATE TABLE "push_tokens" (
    "id" TEXT NOT NULL,
    "agent_id" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_tokens_token_key" ON "push_tokens" ("token");
CREATE INDEX "push_tokens_agent_id_idx" ON "push_tokens" ("agent_id");
