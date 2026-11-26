-- Fix audit #5b (25/8): bất biến "1 phòng = 1 NĐT active" bị race (assertRoomAssignable check-then-insert không
-- khóa) → 2 admin gán CÙNG phòng cho 2 NĐT đồng thời đều qua dup-check. UNIQUE 1 phần trên room_id CHỈ khi kỳ
-- đang gán (unassigned_at NULL) + room_id NOT NULL → chặn ở DB; service map lỗi unique về thông báo cũ.
CREATE UNIQUE INDEX IF NOT EXISTS "investor_chat_groups_room_active_unique" ON "investor_chat_groups"("room_id") WHERE "unassigned_at" IS NULL AND "room_id" IS NOT NULL;
