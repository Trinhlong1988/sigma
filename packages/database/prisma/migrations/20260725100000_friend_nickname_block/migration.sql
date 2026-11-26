-- SIGMA (25/7) — Biet danh (muc "dat ten goi nho cho ban be") + Chan cuoc goi/tin nhan (muc "chan").
-- Additive thuan tren bang friend_requests da co (KHONG dung bang/cot cu, KHONG doi kieu cot nao).
-- 2 cap cot theo VAI TRO (from/to) tren CUNG 1 hang, dung 1 CHIEU tuyet doi cho ca biet danh lan chan — xem
-- comment schema.prisma model FriendRequest.

ALTER TABLE "friend_requests" ADD COLUMN "nickname_by_from" TEXT;
ALTER TABLE "friend_requests" ADD COLUMN "nickname_by_to" TEXT;
ALTER TABLE "friend_requests" ADD COLUMN "blocked_by_from" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "friend_requests" ADD COLUMN "blocked_by_to" BOOLEAN NOT NULL DEFAULT false;
