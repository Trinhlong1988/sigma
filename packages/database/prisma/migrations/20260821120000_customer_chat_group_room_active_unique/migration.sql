-- BOT-3 defense-in-depth (audit 21/8) — PARTIAL UNIQUE tren customer_chat_groups(room_id) WHERE unassigned_at
-- IS NULL: MOI phong chat chi duoc gan TOI DA 1 khach ACTIVE tai 1 thoi diem. Nham dong lo hong "1 room tro >=2
-- khach active" (C1 trong agent-tid-scope.ts) — neu xay ra thi MOI thanh vien room do thay/khop/bao-gia TID cua
-- CA HAI khach (ro ri pham vi tai chinh cheo dai-ly). Comment trong agent-tid-scope.ts da de xuat chinh index nay.
--
-- ⚠️ CHUA AP LEN DB `sigma` — LEAD (Admin Demo) PHAI verify TRUOC khi chay:
--   SELECT room_id, COUNT(*) FROM customer_chat_groups
--   WHERE unassigned_at IS NULL AND room_id IS NOT NULL
--   GROUP BY room_id HAVING COUNT(*) > 1;
-- Ket qua PHAI rong (0 hang vi pham). Audit truoc do ghi nhan C1 hien = 0 nhung phai KHANG DINH lai tren DB THAT
-- ngay truoc khi apply (du lieu co the doi). Neu co vi pham -> dong bot ky trung (set unassigned_at) TRUOC, roi
-- moi chay migrate. `prisma migrate deploy` + `prisma generate` (migrate TRUOC, generate SAU). Idempotent
-- (IF NOT EXISTS) — khop self-heal apps/desktop/src/main/db.ts.
--
-- Luu y: room_id la NULLable; partial-unique tren cot NULLable KHONG khoa cac hang room_id IS NULL (nhieu ky
-- active chua gan phong deu room_id=NULL van hop le — Postgres coi moi NULL la khac nhau trong unique index).

CREATE UNIQUE INDEX IF NOT EXISTS "customer_chat_groups_room_id_active_unique"
  ON "customer_chat_groups"("room_id") WHERE "unassigned_at" IS NULL AND "room_id" IS NOT NULL;
