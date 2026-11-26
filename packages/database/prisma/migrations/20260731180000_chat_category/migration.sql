-- SIGMA (31/7, CMD_BUILD viec #4) — "Phan loai" (muc 21), thay Phase 0 mock-only
-- (mock-data/categories.ts + CategoryManagerModal.tsx sua thang mang client, mat khi reload). Additive
-- thuan tren DB `sigma` da tach rieng (khong dung chung GLB) — bang MOI + 1 cot nullable moi tren
-- chat_room_members da co (KHONG doi kieu cot nao cu).
--
-- CHUA AP LEN DB `sigma` luc tao file nay — LEAD (Admin Demo) tu chay `prisma migrate deploy` + `prisma
-- generate` khi san sang (dung thu tu: migrate TRUOC, generate SAU — xem BUGS_FIXED.md B37/B42/B74 cho ly
-- do). Test tu dong (vitest) chay tren DB throwaway rieng (global-setup.ts tu tao/huy toan bo migration nay
-- cung cac migration khac) — KHONG dung DB `sigma`.

-- CreateTable
CREATE TABLE "chat_categories" (
    "id" TEXT NOT NULL,
    "agent_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_categories_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_categories_agent_id_idx" ON "chat_categories"("agent_id");

-- AlterTable
ALTER TABLE "chat_room_members" ADD COLUMN "category_id" TEXT;

CREATE INDEX "chat_room_members_category_id_idx" ON "chat_room_members"("category_id");

-- AddForeignKey (SetNull — xoa 1 phan loai thi phong dang gan ve "chua phan loai", KHONG xoa thanh vien/phong)
ALTER TABLE "chat_room_members" ADD CONSTRAINT "chat_room_members_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "chat_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
