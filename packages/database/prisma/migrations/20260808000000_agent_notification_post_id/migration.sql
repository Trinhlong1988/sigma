-- #26 (Admin Demo 8/8) — thêm cột post_id cho agent_notifications để thông báo Nhật ký (DIARY_COMMENT/REACTION/POST)
-- click TRỎ ĐÚNG bài + highlight. Cột NULLABLE, additive, không đụng dữ liệu cũ (an toàn cho DB production).
ALTER TABLE "agent_notifications" ADD COLUMN "post_id" TEXT;
