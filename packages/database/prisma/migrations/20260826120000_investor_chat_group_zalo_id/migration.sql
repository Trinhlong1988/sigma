-- BACKFILL DRIFT (Admin Demo 1/9): cột `zalo_group_id` trên `investor_chat_groups` (gID nhóm Zalo g<N> để watcher
-- định tuyến bill tạm ứng NĐT) đã thêm vào DB `sigma` production bằng raw ALTER + đã khai trong schema.prisma
-- (model InvestorChatGroup) nhưng THIẾU migration → guard schema-drift-guard báo drift. Lưu ý: migration
-- 20260825120000 chỉ thêm zalo_group_id cho customer_chat_groups (bảng KHÁC), KHÔNG phủ investor_chat_groups.
-- Codify raw-ALTER thành migration (bài học B113). IF NOT EXISTS → an toàn replay trên DB đã có cột.
ALTER TABLE "investor_chat_groups" ADD COLUMN IF NOT EXISTS "zalo_group_id" TEXT;
