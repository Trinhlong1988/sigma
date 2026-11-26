-- SIGMA (31/7) — Phan loai ban be (muc "Gia dinh"/"Cong viec"). Additive thuan tren bang
-- friend_requests da co (KHONG doi kieu cot nao cu). 2 cot theo VAI TRO (from/to) tren CUNG 1 hang, dung
-- 1 CHIEU tuyet doi, CUNG khuon nickname_by_from/nickname_by_to + blocked_by_from/blocked_by_to da co (xem
-- comment schema.prisma model FriendRequest). Gia tri hop le 'FAMILY'|'WORK'|null validate o TANG SERVICE
-- (friend-service.ts setFriendCategory) — KHONG CHECK constraint DB, giong cot status cung bang.
--
-- CHUA AP LEN DB production `sigma` luc tao file nay — LEAD (Admin Demo) tu chay `prisma migrate deploy`
-- khi san sang. Test tu dong (vitest) chay tren DB throwaway rieng (global-setup.ts tu tao/huy), tu ap
-- migration nay cung toan bo cac migration khac — KHONG dung DB `sigma`.

ALTER TABLE "friend_requests" ADD COLUMN "category_by_from" TEXT;
ALTER TABLE "friend_requests" ADD COLUMN "category_by_to" TEXT;
