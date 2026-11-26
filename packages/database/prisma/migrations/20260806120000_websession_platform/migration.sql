-- #3 (6/8, Admin Demo "đăng nhập máy mới đá phiên CŨ CÙNG NỀN như Zalo") — thêm cột platform cho web_sessions.
-- Giá trị 'web' | 'exe' | 'apk' (client gửi header X-Sigma-Platform lúc đăng nhập; thiếu → server tự suy
-- từ User-Agent qua derivePlatform, xem apps/bot-api/src/web-session-service.ts). Dùng để đá phiên CŨ CÙNG NỀN
-- khi đăng nhập máy mới (revokeOtherSessionsSamePlatform) — các nền khác KHÔNG bị đá.
-- IF NOT EXISTS: idempotent (LEAD sẽ ALTER production tay; test/fresh DB thì thêm cột). ADDITIVE nullable —
-- KHÔNG phá phiên cũ (platform = null → effective platform suy từ user_agent).
ALTER TABLE "web_sessions" ADD COLUMN IF NOT EXISTS "platform" TEXT;
