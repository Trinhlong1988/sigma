-- SIGMA debt-chat-gaps (31/7) — "chỉ trưởng/phó nhóm được gửi tin" cho phòng chat lõi tự xây (Việc 4 danh
-- sách nợ Phase 3, xem comment schema.prisma ChatRoom.readOnly + GroupInfoPanel.tsx). Additive thuần, KHÔNG
-- đụng bảng/cột nào khác — 1 cột mới NOT NULL với DEFAULT false nên áp được lên bảng chat_rooms đã có dữ liệu
-- (Postgres backfill giá trị default cho mọi hàng hiện có trong cùng câu lệnh, KHÔNG cần bước UPDATE riêng).
--
-- SOẠN SẴN cho worktree debt-chat-gaps + throwaway test DB CỦA WORKTREE NÀY — KHÔNG tự áp lên DB production
-- `sigma`/`glb` thật (LEAD/Admin Demo tự chạy `prisma migrate deploy` sau khi audit, xem báo cáo build).

ALTER TABLE "chat_rooms" ADD COLUMN "read_only" BOOLEAN NOT NULL DEFAULT false;
