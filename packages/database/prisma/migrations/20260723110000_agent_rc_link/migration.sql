-- SIGMA Phase 1 (2026-07-23, CMD_BUILD): link tài khoản Rocket.Chat của đại lý (kế hoạch mục A —
-- đăng nhập qua RC trước, bot-api xác minh token qua GET /api/v1/me rồi map sang Agent). Additive thuần:
-- 2 cột nullable + unique mới trên agents, KHÔNG đụng cột cũ / dữ liệu hiện có.

ALTER TABLE "agents" ADD COLUMN "rc_user_id" TEXT;
ALTER TABLE "agents" ADD COLUMN "rc_username" TEXT;

CREATE UNIQUE INDEX "agents_rc_user_id_key" ON "agents" ("rc_user_id");
CREATE UNIQUE INDEX "agents_rc_username_key" ON "agents" ("rc_username");
