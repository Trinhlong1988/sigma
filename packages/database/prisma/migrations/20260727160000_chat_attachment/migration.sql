-- SIGMA (27/7) — ChatAttachment: dinh kem anh/file THAT trong chat ("Phan 1" ke hoach dinh kem). Chat
-- message van di qua Rocket.Chat nhu truoc (KHONG doi) -- file vat ly luu RIENG o bot-api (CHAT_UPLOADS_DIR
-- tren dia), tin nhan RC chi chua 1 dong JSON marker tro toi attachment nay qua `id`. Additive thuan: 1 bang
-- moi, KHONG dung bang/cot cu. KHONG tu ap dung migration nay len DB production -- LEAD tu chay sau khi
-- review (quy tac cung du an, xem push_tokens migration cung khuon).

CREATE TABLE "chat_attachments" (
    "id" TEXT NOT NULL,
    "uploader_id" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "room_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_attachments_uploader_id_idx" ON "chat_attachments" ("uploader_id");
