-- SIGMA (1/8) — "Doanh so theo nhom chat": lien ket TID <-> phong chat khach hang, GAN TAY (Admin Demo xac
-- nhan truc tiep: nhan vien tu gan tay tren phan mem quan ly SigMa hoac SigMa, KHONG tu dong khop theo ten
-- HKD). Additive thuan, bang MOI hoan toan, KHONG doi bang nao cu.
--
-- CHUA AP LEN DB `sigma` luc tao file nay — LEAD (Admin Demo) tu chay `prisma migrate deploy` + `prisma
-- generate` khi san sang (migrate TRUOC, generate SAU). Test tu dong (vitest) chay tren DB throwaway rieng
-- (global-setup.ts tu tao/huy toan bo migration nay cung cac migration khac) — KHONG dung DB `sigma`.

-- CreateTable
CREATE TABLE "chat_room_tids" (
    "id" SERIAL NOT NULL,
    "room_id" TEXT NOT NULL,
    "tid_id" INTEGER NOT NULL,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_room_tids_pkey" PRIMARY KEY ("id")
);

-- 1 TID chi gan duoc 1 phong tai 1 thoi diem (tranh doanh so bi chia doi/dem trung neu gan nham 2 nhom).
CREATE UNIQUE INDEX "chat_room_tids_tid_id_key" ON "chat_room_tids"("tid_id");

CREATE INDEX "chat_room_tids_room_id_idx" ON "chat_room_tids"("room_id");

-- AddForeignKey (CASCADE ca 2 chieu — xoa phong hoac xoa TID thi lien ket tu don don, khong mo côi)
ALTER TABLE "chat_room_tids" ADD CONSTRAINT "chat_room_tids_room_id_fkey"
  FOREIGN KEY ("room_id") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_room_tids" ADD CONSTRAINT "chat_room_tids_tid_id_fkey"
  FOREIGN KEY ("tid_id") REFERENCES "tids"("id") ON DELETE CASCADE ON UPDATE CASCADE;
