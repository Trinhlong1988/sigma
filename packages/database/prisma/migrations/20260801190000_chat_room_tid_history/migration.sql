-- SIGMA (1/8, fix theo review doc lap B97-B101) — chat_room_tids GIU LICH SU gan/go thay vi xoa cung khi
-- go, de getRoomRevenueReport() tinh doanh so THEO MOC THOI GIAN gan/go thuc te, khong con bug "TID chuyen
-- phong cuop doanh so cu cua phong truoc" (bao cao chi nhin trang thai gan HIEN TAI, khong biet lich su).
--
-- unlinked_at NULL = dang gan (active). Unlink giu nguyen hang, chi SET unlinked_at (KHONG xoa nua).
-- Rang buoc "1 TID chi active o 1 phong" chuyen tu UNIQUE thuong sang PARTIAL UNIQUE INDEX (chi ap voi hang
-- dang active) vi Prisma schema khong ho tro WHERE tren @@unique.

-- AlterTable
ALTER TABLE "chat_room_tids" ADD COLUMN "unlinked_at" TIMESTAMPTZ(3);
ALTER TABLE "chat_room_tids" ADD COLUMN "unlinked_by" INTEGER;

-- DropIndex (unique cu ap cho MOI hang, kho gan lai TID sau khi go)
DROP INDEX "chat_room_tids_tid_id_key";

-- CreateIndex (partial unique — chi 1 hang ACTIVE moi tid_id tai 1 thoi diem)
CREATE UNIQUE INDEX "chat_room_tids_tid_id_active_key" ON "chat_room_tids"("tid_id") WHERE "unlinked_at" IS NULL;

CREATE INDEX "chat_room_tids_tid_id_idx" ON "chat_room_tids"("tid_id");
