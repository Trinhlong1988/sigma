-- SIGMA (1/8, muc 32 "Sao luu, dong bo") -- Ket noi Google Drive ca nhan de xuat lich su chat CUA MINH ra
-- 1 file JSON roi day len Drive CA NHAN cua ho (KHONG phai disaster-recovery -- server DA luu vinh vien moi
-- tin nhan, xem comment schema.prisma model Agent). Additive thuan tren bang agents da co (KHONG doi kieu cot
-- nao cu) -- CUNG tien le avatar_image/cover_image/qr_image da co san (BLOB/cot rieng thang trong hang Agent).
--
-- google_drive_refresh_token luu MA HOA (AES-256-GCM, xem encryptRefreshToken()/decryptRefreshToken() o
-- apps/bot-api/src/drive-backup-service.ts) -- KHONG BAO GIO plaintext, KHONG BAO GIO tra ra ngoai qua API
-- (route GET /v1/me/drive-backup/status CHI tra boolean connected).
--
-- CHUA AP LEN DB `sigma` luc tao file nay -- LEAD (Admin Demo) tu chay `prisma migrate deploy` + `prisma
-- generate` khi san sang (dung thu tu: migrate TRUOC, generate SAU -- xem BUGS_FIXED.md B37/B42/B74 cho ly do).
-- Test tu dong (vitest) chay tren DB throwaway rieng (global-setup.ts tu tao/huy toan bo migration nay cung
-- cac migration khac) -- KHONG dung DB `sigma`.

ALTER TABLE "agents" ADD COLUMN "google_drive_refresh_token" TEXT;
ALTER TABLE "agents" ADD COLUMN "google_drive_last_backup_at" TIMESTAMPTZ(3);
