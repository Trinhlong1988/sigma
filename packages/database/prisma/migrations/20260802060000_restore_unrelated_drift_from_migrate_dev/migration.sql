-- SIGMA B113 (2/8) — KHOI PHUC drift NGOAI Y MUON tu migration truoc (20260802051934_agent_notifications).
-- Boi canh: chay `prisma migrate dev` (thay vi viet tay migration.sql + `prisma migrate deploy` dung quy uoc
-- du an nay) de tao bang agent_notifications moi cho B113 — lenh nay tu dong DIFF toan bo schema.prisma voi DB
-- that va gom LUON 4 thay doi KHONG LIEN QUAN vao CUNG 1 file migration, vi drift co san TRUOC do giua
-- schema.prisma (model ChatRoomTid KHONG khai bao @relation, dung convention "bolt-on table") va DB that (co
-- FK CUNG cot do vi migration 20260801160000_chat_room_tid viet tay THEM FK truc tiep bang raw SQL). Prisma
-- migrate dev coi FK/index/default khong khop schema.prisma la "drift can xoa de dong bo" — DA XOA NHAM 4 thu
-- sau tren DB `sigma` THAT luc apply migration truoc (KHONG lien quan nghiep vu B113 avatar/notification):
--   1) FK chat_room_tids_room_id_fkey / chat_room_tids_tid_id_fkey (CASCADE xoa phong/TID -> tu dong don lien
--      ket, tranh mo coi — xem comment goc migration 20260801160000_chat_room_tid)
--   2) Index pos_devices_warehouse_id_idx (loc may theo kho — migration 20260712230000_pos_warehouse)
--   3) Default CURRENT_TIMESTAMP cho status_options.updated_at (migration 20260711170000_status_catalog)
--   4) Default CURRENT_TIMESTAMP cho tid_sell_fees.updated_at (migration 20260711190000_tid_sell_fee)
-- Migration nay KHOI PHUC LAI DUNG trang thai vat ly nhu TRUOC khi chay migrate dev — KHONG doi gi ve nghiep vu
-- B113 (avatar/notification). Bai hoc quy trinh (ghi vao BUGS_FIXED.md B113): KHONG dung `prisma migrate dev`
-- (auto-diff+auto-apply) tren DB that cua du an nay nua — CHI viet tay migration.sql + `prisma migrate deploy`
-- (dung quy uoc du an, tranh lap lai drift ngoai y muon nay).

-- Khoi phuc FK chat_room_tids (bi drop nham)
ALTER TABLE "chat_room_tids" ADD CONSTRAINT "chat_room_tids_room_id_fkey"
  FOREIGN KEY ("room_id") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_room_tids" ADD CONSTRAINT "chat_room_tids_tid_id_fkey"
  FOREIGN KEY ("tid_id") REFERENCES "tids"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Khoi phuc index pos_devices (bi drop nham)
CREATE INDEX "pos_devices_warehouse_id_idx" ON "pos_devices" ("warehouse_id");

-- Khoi phuc default updated_at (bi drop nham)
ALTER TABLE "status_options" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "tid_sell_fees" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
