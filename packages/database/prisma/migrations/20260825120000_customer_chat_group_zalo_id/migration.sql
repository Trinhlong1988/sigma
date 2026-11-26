-- ZALO groupId ↔ nhóm khách SigMa (Admin Demo 25/8): tên nhóm Zalo KHÁC tên phòng SigMa (mã GB vs KH) →
-- không khớp tự động → admin dán groupId Zalo. Watcher lấy bill nhóm Zalo này → phòng + doanh số của khách.
ALTER TABLE "customer_chat_groups" ADD COLUMN IF NOT EXISTS "zalo_group_id" TEXT;
CREATE INDEX IF NOT EXISTS "customer_chat_groups_zalo_group_id_idx" ON "customer_chat_groups"("zalo_group_id") WHERE "zalo_group_id" IS NOT NULL;
