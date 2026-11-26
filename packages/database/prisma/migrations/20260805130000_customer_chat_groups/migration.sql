-- SIGMA (5/8) — "Nhom chat theo loai phi cua khach hang" (cau hinh co so, Admin Demo chot): 1 khach hang co
-- toi da N nhom chat, MOI nhom ung DUNG 1 LOAI PHI (FeeType). Nhom = phong NOI BO SigMa (room_id ->
-- chat_rooms), luu kem link + QR de hien thi. Additive thuan, bang MOI hoan toan, KHONG doi bang nao cu.
--
-- MO HINH KY (Admin Demo 5/8) — moi hang = 1 KY gan (khach x loai phi), KHONG phai soft-delete don thuan:
--   assigned_from = moc bat dau gan (default now); unassigned_at = moc ket thuc (NULL = dang gan / active).
-- Huy gan = set unassigned_at = now; Doi nhom = dong ky cu (unassigned_at) + mo ky moi (hang moi). MIRROR
-- chat_room_tids.created_at/unlinked_at + tid_sell_fees hieu-luc-theo-ky — doanh so/OCR/TID quy ve DUNG nhom
-- dang gan TAI THOI DIEM phat sinh (attribution theo ky).
--
-- CHUA AP LEN DB `sigma` luc tao file nay — LEAD (Admin Demo) tu chay `prisma migrate deploy` + `prisma
-- generate` khi san sang (migrate TRUOC, generate SAU). Test tu dong (vitest) chay tren fake db in-memory /
-- DB throwaway rieng — KHONG dung DB `sigma`.

-- CreateTable
CREATE TABLE "customer_chat_groups" (
    "id" SERIAL NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "fee_type_id" INTEGER NOT NULL,
    "room_id" TEXT,
    "link" TEXT,
    "qr" TEXT,
    "note" TEXT,
    "assigned_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassigned_at" TIMESTAMPTZ(3),
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_chat_groups_pkey" PRIMARY KEY ("id")
);

-- 1 nhom ACTIVE / loai phi / khach — PARTIAL UNIQUE chi tinh KY DANG GAN (unassigned_at IS NULL). Nho vay huy
-- gan roi gan lai CUNG loai phi KHONG bi chan sai (unique thuong se chan). Prisma schema khong dien dat duoc
-- WHERE nen khai TAY o day (cung cach ChatRoom.direct_pair_key / ChatRoomTid / tid_sell_fees partial-unique).
CREATE UNIQUE INDEX "customer_chat_groups_customer_id_fee_type_id_active_key"
  ON "customer_chat_groups"("customer_id", "fee_type_id") WHERE "unassigned_at" IS NULL;

-- Loc nhanh theo khach (list nhom chat cua 1 khach).
CREATE INDEX "customer_chat_groups_customer_id_idx" ON "customer_chat_groups"("customer_id");

-- Picker "nhom nao CHUA gan khach nao": tra phong GROUP KHONG duoc KY ACTIVE nao tro toi. Index tren room_id chi
-- cho KY dang gan de tra loi nhanh "room_id nay dang duoc gan?" (loai khoi danh sach gan-moi).
CREATE INDEX "customer_chat_groups_room_id_active_idx"
  ON "customer_chat_groups"("room_id") WHERE "unassigned_at" IS NULL;
