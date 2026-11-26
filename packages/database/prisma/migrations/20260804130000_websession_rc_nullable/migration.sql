-- SIGMA (4/8) — LOẠI RC khỏi auth: phiên đăng nhập KHÔNG còn bắt buộc token/user Rocket.Chat.
-- web_sessions.rc_auth_token + rc_user_id → NULLABLE (phiên độc lập RC chỉ cần agent_id). Additive/nới lỏng
-- ràng buộc, KHÔNG xoá dữ liệu. Viết TAY (KHÔNG prisma migrate dev trên DB thật).
ALTER TABLE "web_sessions" ALTER COLUMN "rc_auth_token" DROP NOT NULL;
ALTER TABLE "web_sessions" ALTER COLUMN "rc_user_id" DROP NOT NULL;
