-- SIGMA Phase 2 (29/7) — chat lõi tự xây, thay Rocket.Chat. Additive thuần, KHÔNG đụng bảng GLB nào khác
-- (DB glb dùng chung với GLB gốc). Đặt tên "chat_*" để không đụng bảng "messages" (thư nội bộ) đã có.

CREATE TABLE "chat_rooms" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT,
    "avatar_color" TEXT,
    "avatar_url" TEXT,
    "direct_pair_key" TEXT,
    "pinned_message_id" TEXT,
    "legacy_rc_room_id" TEXT,
    "last_message_at" TIMESTAMPTZ(3),
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "chat_rooms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_rooms_last_message_at_idx" ON "chat_rooms"("last_message_at");
CREATE INDEX "chat_rooms_legacy_rc_room_id_idx" ON "chat_rooms"("legacy_rc_room_id");

-- Chống trùng phòng DIRECT cho 1 cặp agent — Prisma schema không diễn đạt được UNIQUE có điều kiện.
CREATE UNIQUE INDEX "chat_rooms_direct_pair_key_unique"
  ON "chat_rooms" ("direct_pair_key") WHERE "type" = 'DIRECT' AND "deleted_at" IS NULL;

CREATE TABLE "chat_room_members" (
    "id" SERIAL NOT NULL,
    "room_id" TEXT NOT NULL,
    "agent_id" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(3),
    "last_read_message_id" TEXT,
    "muted_until" TIMESTAMPTZ(3),

    CONSTRAINT "chat_room_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_room_members_room_id_agent_id_key" ON "chat_room_members"("room_id", "agent_id");
CREATE INDEX "chat_room_members_agent_id_idx" ON "chat_room_members"("agent_id");

ALTER TABLE "chat_room_members" ADD CONSTRAINT "chat_room_members_room_id_fkey"
  FOREIGN KEY ("room_id") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "sender_id" INTEGER,
    "kind" TEXT NOT NULL DEFAULT 'TEXT',
    "body" TEXT,
    "attachment_id" TEXT,
    "metadata_json" TEXT,
    "reply_to_message_id" TEXT,
    "forwarded_from_message_id" TEXT,
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_messages_room_id_created_at_idx" ON "chat_messages"("room_id", "created_at");
CREATE INDEX "chat_messages_sender_id_idx" ON "chat_messages"("sender_id");

ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_room_id_fkey"
  FOREIGN KEY ("room_id") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "chat_message_reactions" (
    "id" SERIAL NOT NULL,
    "message_id" TEXT NOT NULL,
    "agent_id" INTEGER NOT NULL,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_message_reactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_message_reactions_message_id_agent_id_key" ON "chat_message_reactions"("message_id", "agent_id");
CREATE INDEX "chat_message_reactions_message_id_idx" ON "chat_message_reactions"("message_id");

-- Audit độc lập 29/7 (LOW) — thiếu FK so với 2 quan hệ khác cùng migration, thêm cho nhất quán.
ALTER TABLE "chat_message_reactions" ADD CONSTRAINT "chat_message_reactions_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
