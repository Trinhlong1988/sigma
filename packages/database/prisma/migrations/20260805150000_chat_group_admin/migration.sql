-- SIGMA "nhom chat day du nhu Zalo" (5/8, Admin Demo) — 5 tinh nang quan tri nhom:
--   1. GHIM KHONG GIOI HAN / "Bang tin"     -> bang MOI pinned_messages (thay 1 pinned_message_id duy nhat).
--   2. DUYET THANH VIEN                      -> bang MOI chat_room_join_requests + co chat_rooms.require_approval.
--   3. GIOI HAN SO THANH VIEN                -> cot chat_rooms.max_members (null = khong gioi han).
--   4. AVATAR NHOM (upload anh THAT)         -> 3 cot BLOB chat_rooms.avatar_image/_mime/_updated_at (nhu agents).
--   5. THANG/GIANG/CHUYEN OWNER              -> DA CO san (changeMemberRole, khong doi schema).
--
-- Additive thuan — chi THEM cot nullable/co default an toan + bang MOI hoan toan. KHONG doi/xoa cot/bang nao cu
-- (DB `glb`/`sigma` dung chung, moi migration o day chi additive — xem comment schema.prisma ChatRoom).
--
-- CHUA AP LEN DB `sigma` luc tao file nay — LEAD (Admin Demo) tu chay `prisma migrate deploy` + `prisma
-- generate` khi san sang (migrate TRUOC, generate SAU). Test tu dong (vitest) chay tren DB throwaway rieng
-- (global-setup.ts tu tao/huy) — KHONG dung DB `sigma` san xuat.

-- ── 2+3: co duyet + gioi han so thanh vien tren bang chat_rooms da co ──
-- require_approval NOT NULL DEFAULT false — Postgres backfill default cho moi hang hien co trong cung cau lenh.
ALTER TABLE "chat_rooms" ADD COLUMN "require_approval" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "chat_rooms" ADD COLUMN "max_members" INTEGER;

-- ── 4: avatar nhom (BLOB thang trong hang, CUNG kieu agents.avatar_image) ──
ALTER TABLE "chat_rooms" ADD COLUMN "avatar_image" BYTEA;
ALTER TABLE "chat_rooms" ADD COLUMN "avatar_image_mime" TEXT;
ALTER TABLE "chat_rooms" ADD COLUMN "avatar_updated_at" TIMESTAMPTZ(3);

-- ── 1: GHIM KHONG GIOI HAN / "Bang tin" ──
CREATE TABLE "pinned_messages" (
    "id" SERIAL NOT NULL,
    "room_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "pinned_by_agent_id" INTEGER NOT NULL,
    "pinned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pinned_messages_pkey" PRIMARY KEY ("id")
);

-- 1 tin chi ghim 1 lan / phong (ghim lai = idempotent, khong tao hang trung).
CREATE UNIQUE INDEX "pinned_messages_room_id_message_id_key" ON "pinned_messages"("room_id", "message_id");
-- Doc "Bang tin" sap theo thoi gian ghim (moi nhat truoc, xem listPinnedMessages).
CREATE INDEX "pinned_messages_room_id_pinned_at_idx" ON "pinned_messages"("room_id", "pinned_at");

-- Xoa phong -> don luon danh sach ghim (khop ChatRoomTid/ChatRoomJoinRequest CASCADE).
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_room_id_fkey"
  FOREIGN KEY ("room_id") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2: DUYET THANH VIEN ──
CREATE TABLE "chat_room_join_requests" (
    "id" SERIAL NOT NULL,
    "room_id" TEXT NOT NULL,
    "agent_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" INTEGER,
    "decided_at" TIMESTAMPTZ(3),

    CONSTRAINT "chat_room_join_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_room_join_requests_room_id_status_idx" ON "chat_room_join_requests"("room_id", "status");
CREATE INDEX "chat_room_join_requests_agent_id_idx" ON "chat_room_join_requests"("agent_id");

-- 1 yeu cau DANG cho / (phong x agent) — partial unique WHERE status='PENDING' (cho xin lai sau khi da
-- REJECTED/APPROVED, giu hang cu lam lich su). Prisma khong dien dat duoc WHERE nen khai TAY (cung cach
-- friend_requests_pair_active_uq / customer_chat_groups_..._active_key).
CREATE UNIQUE INDEX "chat_room_join_requests_room_agent_pending_uq"
  ON "chat_room_join_requests"("room_id", "agent_id") WHERE "status" = 'PENDING';

-- Xoa phong -> don luon cac yeu cau vao phong do.
ALTER TABLE "chat_room_join_requests" ADD CONSTRAINT "chat_room_join_requests_room_id_fkey"
  FOREIGN KEY ("room_id") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
