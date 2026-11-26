-- SIGMA (1/8) — Anh dai dien + anh bia (muc 39 mo rong, ProfileScreen.tsx), thay Phase 0 mock doi
-- mau/gradient cuc bo (khong luu, mat khi reload). Additive thuan tren bang agents da co (KHONG doi kieu
-- cot nao cu) — CUNG tien le qr_image/qr_image_mime/qr_updated_at da co san (BLOB thang trong hang Agent,
-- xem comment schema.prisma). Gia tri hop le mime validate o TANG SERVICE (agent-media-service.ts, magic-bytes
-- qua fileTypeFromBuffer) — KHONG CHECK constraint DB, giong qr_image_mime cung bang.
--
-- CHUA AP LEN DB `sigma` luc tao file nay — LEAD (Admin Demo) tu chay `prisma migrate deploy` + `prisma
-- generate` khi san sang (dung thu tu: migrate TRUOC, generate SAU — xem BUGS_FIXED.md B37/B42/B74 cho ly
-- do). Test tu dong (vitest) chay tren DB throwaway rieng (global-setup.ts tu tao/huy toan bo migration nay
-- cung cac migration khac) — KHONG dung DB `sigma`.

ALTER TABLE "agents" ADD COLUMN "avatar_image" BYTEA;
ALTER TABLE "agents" ADD COLUMN "avatar_image_mime" TEXT;
ALTER TABLE "agents" ADD COLUMN "avatar_updated_at" TIMESTAMPTZ(3);
ALTER TABLE "agents" ADD COLUMN "cover_image" BYTEA;
ALTER TABLE "agents" ADD COLUMN "cover_image_mime" TEXT;
ALTER TABLE "agents" ADD COLUMN "cover_updated_at" TIMESTAMPTZ(3);
