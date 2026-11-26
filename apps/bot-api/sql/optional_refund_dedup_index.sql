-- SIGMA LANE B Vòng 2 (#5, 3/8) — CHỐNG HOÀN TIỀN TRÙNG.
-- migration.sql TÙY CHỌN (performance-only) — VIẾT TAY, KHÔNG qua `prisma migrate dev`, KHÔNG tự áp DB thật.
-- LEAD tự quyết có deploy hay không (đặt NGOÀI prisma/migrations để harness test/migrate deploy KHÔNG tự chạy).
--
-- TÍNH NĂNG #5 KHÔNG CẦN thay đổi schema: khóa dedup (transferCode/recipientAccount/dateTime) lưu trong
-- `chat_messages.metadata_json` (cột `String?`/text ĐÃ CÓ SẴN), tại nhánh JSON `refundDedup`. Logic dedup
-- (refund-dedup.ts) quét ở TẦNG ỨNG DỤNG theo senderId — CHẠY ĐÚNG mà KHÔNG cần index này (khối lượng tin
-- hoàn tiền / 1 đại lý hiện nhỏ). Index dưới đây CHỈ để TĂNG TỐC tra cứu khi 1 đại lý tích lũy RẤT NHIỀU tin.
--
-- CẢNH BÁO trước khi áp (LEAD kiểm):
--   1. `metadata_json` là TEXT tự do — biểu thức index cast `::jsonb`. Nếu tồn tại hàng metadata_json KHÔNG
--      phải JSON hợp lệ, lệnh CREATE INDEX sẽ THẤT BẠI lúc build. Chạy truy vấn kiểm TRƯỚC:
--        SELECT count(*) FROM chat_messages
--        WHERE metadata_json IS NOT NULL AND NOT (metadata_json ~ '^\s*[\[{]');  -- ước lượng thô hàng phi-JSON
--      (hoặc thử ép jsonb trong khối kiểm soát lỗi trên bản sao trước).
--   2. Dùng CREATE INDEX CONCURRENTLY để KHÔNG khóa bảng trên production đang chạy (phải chạy NGOÀI transaction).
--
-- Index biểu thức trên mã chuyển tiền (khóa mạnh) của các tin HOÀN TIỀN:
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_refund_dedup_code
  ON chat_messages ((( (metadata_json)::jsonb -> 'refundDedup' ->> 'transferCode' )))
  WHERE deleted_at IS NULL
    AND kind = 'IMAGE'
    AND metadata_json IS NOT NULL
    AND (metadata_json)::jsonb ->> 'isRefundImage' = 'true';

-- ROLLBACK:
-- DROP INDEX CONCURRENTLY IF EXISTS idx_chat_messages_refund_dedup_code;
