-- SIGMA Vòng 2.5 (3/8) — QUY MÔ LỚN: tăng tốc tab "File" của phòng chat (listRoomAttachments).
-- migration.sql TÙY CHỌN (performance-only) — VIẾT TAY, KHÔNG qua `prisma migrate dev`, KHÔNG tự áp DB thật.
-- LEAD tự quyết deploy (đặt NGOÀI prisma/migrations để harness test/migrate deploy KHÔNG tự chạy).
--
-- BỐI CẢNH: listRoomAttachments() (chat-message-service.ts) chạy:
--   SELECT id, attachment_id FROM chat_messages
--   WHERE room_id = $1 AND deleted_at IS NULL AND attachment_id IS NOT NULL
--   ORDER BY created_at DESC, id DESC;
-- Index hiện có `chat_messages(room_id, created_at)` PHỦ được room_id + thứ tự created_at, nhưng phải QUÉT MỌI
-- tin của phòng rồi LỌC RESIDUAL `attachment_id IS NOT NULL`/`deleted_at IS NULL`. Ở phòng 30k+ tin mà chỉ vài %
-- có đính kèm, phần lớn hàng quét bị loại — index riêng dưới đây chỉ chứa ĐÚNG các tin CÓ FILE còn sống.
--
-- ĐO THẬT (test/chat-scale-listmessages.test.ts, throwaway PG, KHÔNG áp index này): 3.000 file → listRoomAttachments
-- ~80ms (tải HẾT vào RAM). Tuyến tính theo số file — chục nghìn file sẽ chậm + tốn RAM (hàm KHÔNG phân trang).
-- Index này giảm chi phí QUÉT; giới hạn RAM/số dòng vẫn cần fix Ở TẦNG CODE (thêm cursor pagination — xem
-- BUGS_FIXED B_scale). Hai việc BỔ SUNG nhau, không thay thế nhau.
--
-- CẢNH BÁO trước khi áp (LEAD kiểm):
--   1. Dùng CREATE INDEX CONCURRENTLY để KHÔNG khóa bảng trên production đang chạy (phải chạy NGOÀI transaction).
--   2. Additive thuần (chỉ THÊM index) — an toàn với DB `glb`/`sigma` dùng chung, KHÔNG đổi bảng/cột.

-- Partial index: chỉ index tin CÓ đính kèm và CHƯA xóa mềm, sắp theo (room_id, created_at DESC) khớp ORDER BY.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_room_attachments_active
  ON chat_messages (room_id, created_at DESC)
  WHERE attachment_id IS NOT NULL AND deleted_at IS NULL;
