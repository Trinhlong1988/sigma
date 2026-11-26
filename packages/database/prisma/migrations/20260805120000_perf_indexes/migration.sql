-- FIX-PERF (5/8, finding hiệu năng QA 5-agent B132) — index tăng tốc list/count/dashboard cho Customer, Tid,
-- AuditLog (3 bảng trước đây THIẾU index cho các cột lọc nóng). Viết TAY (CẤM `prisma migrate dev` trên DB thật
-- `sigma` — xem memory feedback_no_prisma_migrate_dev_on_real_db), apply bằng `prisma migrate deploy`.
--
-- CONCURRENTLY + NGOÀI transaction: tạo index trên bảng ĐANG CHẠY production KHÔNG khóa ghi (INSERT/UPDATE vẫn
-- diễn ra trong lúc build index). CREATE INDEX CONCURRENTLY KHÔNG chạy được trong transaction block — Prisma
-- migrate deploy chạy TỪNG câu lệnh của file migration TUẦN TỰ, KHÔNG bọc transaction (đã dùng đúng khuôn này ở
-- 20260804120000_chat_message_perf_indexes). Tên index = ĐÚNG tên Prisma mặc định (<table>_<cols>_idx) để
-- `@@index` trong schema.prisma KHỚP, không sinh drift ở lần diff/migrate sau.
--
-- LƯU Ý: file này CHƯA được apply lên production tại thời điểm commit — LEAD chạy `prisma migrate deploy` trong
-- cửa sổ bảo trì (mỗi CONCURRENTLY 1 index; nếu lỡ tạo index INVALID do gián đoạn, DROP rồi chạy lại — IF NOT
-- EXISTS bỏ qua index đã tạo xong).

-- (1) Customer — list/count/dashboard lọc theo (deleted_at, status). Trước đây customers 0 index → seq-scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "customers_deleted_at_status_idx"
  ON "customers" ("deleted_at", "status");

-- (2) Customer — lọc + groupBy theo đại lý (agent_id): list?agentId= + countCustomers.byAgent + dashboard.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "customers_agent_id_idx"
  ON "customers" ("agent_id");

-- (3) Tid — list/undelivered/"khách đang giữ" lọc theo (deleted_at, status, delivered_at).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tids_deleted_at_status_delivered_at_idx"
  ON "tids" ("deleted_at", "status", "delivered_at");

-- (4) Tid — "khách đang giữ TID" + guard xóa khách (customer_id) + resolve theo khách.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tids_customer_id_idx"
  ON "tids" ("customer_id");

-- (5) AuditLog — storage/status đếm theo cutoff created_at (>= / <) trên bảng nhật ký phình liên tục.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_created_at_idx"
  ON "audit_logs" ("created_at");
