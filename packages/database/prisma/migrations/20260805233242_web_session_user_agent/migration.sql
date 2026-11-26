-- 5/8 (Admin Demo "có tên thiết bị như Zalo") — thêm cột user_agent cho web_sessions để hiện tên thiết bị.
-- IF NOT EXISTS: production đã ALTER tay (5/8) nên đây no-op ở production; test/fresh DB thì thêm cột.
ALTER TABLE "web_sessions" ADD COLUMN IF NOT EXISTS "user_agent" TEXT;
