-- SIGMA "Nhật ký" / Newsfeed kiểu Facebook (3/8) — 4 bảng MỚI additive (posts / post_images /
-- post_reactions / post_comments). Viết TAY (KHÔNG `prisma migrate dev` — bài học B113: migrate dev gộp drift
-- lạ khi target là DB đã có nhiều bảng). CHỈ chứa DDL của đúng tính năng này, KHÔNG đụng bảng cũ nào.

-- CreateTable
CREATE TABLE "posts" (
    "id" TEXT NOT NULL,
    "author_agent_id" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_images" (
    "id" TEXT NOT NULL,
    "post_id" TEXT,
    "author_agent_id" INTEGER NOT NULL,
    "ord" INTEGER NOT NULL DEFAULT 0,
    "image" BYTEA NOT NULL,
    "image_mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_reactions" (
    "id" SERIAL NOT NULL,
    "post_id" TEXT NOT NULL,
    "agent_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_comments" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "agent_id" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "post_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "posts_author_agent_id_created_at_idx" ON "posts"("author_agent_id", "created_at");

-- CreateIndex
CREATE INDEX "posts_created_at_idx" ON "posts"("created_at");

-- CreateIndex
CREATE INDEX "post_images_post_id_idx" ON "post_images"("post_id");

-- CreateIndex
CREATE INDEX "post_images_author_agent_id_idx" ON "post_images"("author_agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_reactions_post_id_agent_id_key" ON "post_reactions"("post_id", "agent_id");

-- CreateIndex
CREATE INDEX "post_reactions_post_id_idx" ON "post_reactions"("post_id");

-- CreateIndex
CREATE INDEX "post_comments_post_id_created_at_idx" ON "post_comments"("post_id", "created_at");

-- AddForeignKey
ALTER TABLE "post_images" ADD CONSTRAINT "post_images_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_reactions" ADD CONSTRAINT "post_reactions_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
