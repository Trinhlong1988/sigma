-- FIX-PERF (4/8) — index tăng tốc truy vấn tin nhắn chat, ĐO bằng EXPLAIN ANALYZE trên throwaway seed 500k tin
-- (50 phòng × 10k). KHÔNG qua `prisma migrate dev` (cấm trên DB thật, xem memory) — viết TAY, `migrate deploy`.
--
-- CONCURRENTLY + NGOÀI transaction: tạo index trên bảng chat_messages ĐANG CHẠY production KHÔNG khóa ghi
-- (INSERT tin nhắn mới vẫn diễn ra trong lúc build index). CREATE INDEX CONCURRENTLY KHÔNG chạy được trong
-- transaction block — Prisma migrate deploy chạy từng câu lệnh của file migration TUẦN TỰ, KHÔNG bọc transaction
-- (đã kiểm THẬT: deploy file này trên DB fresh + DB đã có sẵn bảng đều thành công, xem báo cáo FIX-PERF).
--
-- (1) (room_id, created_at DESC, id DESC): phục vụ "top-1 tin mới nhất mỗi phòng" (CROSS JOIN LATERAL ở
-- lastMessagesForRooms / markAllRead) — thay Sort external-merge tràn đĩa (~1400ms) bằng Index Scan LIMIT 1
-- (~2ms). Thứ tự DESC,DESC khớp ĐÚNG tie-break [{createdAt:'desc'},{id:'desc'}] dùng khắp service.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_messages_room_created_id_desc_idx"
  ON "chat_messages" ("room_id", "created_at" DESC, "id" DESC);

-- (2) partial (room_id, created_at DESC) WHERE có đính kèm & chưa xóa: phục vụ listRoomAttachments — tránh
-- quét+lọc toàn bộ tin của phòng để nhặt tin có attachment (phòng 10k tin, 0 đính kèm: 29ms → 0.3ms).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_messages_room_attachment_idx"
  ON "chat_messages" ("room_id", "created_at" DESC)
  WHERE "attachment_id" IS NOT NULL AND "deleted_at" IS NULL;
