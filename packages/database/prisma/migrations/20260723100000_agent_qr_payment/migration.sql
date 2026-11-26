-- SIGMA (2026-07-23, CMD_BUILD): QR nhận tiền của đại lý — Tier 2. Additive thuần: 4 cột nullable mới
-- trên agents, KHÔNG đụng cột cũ. Ảnh lưu BLOB trực tiếp trên hàng Agent (không theo quy ước file-đĩa cục bộ
-- FILE_UPLOAD_CONVENTION.md — apps/bot-api là service riêng cần đọc được, có thể khác máy với Electron client).

ALTER TABLE "agents" ADD COLUMN "qr_image" BYTEA;
ALTER TABLE "agents" ADD COLUMN "qr_image_mime" TEXT;
ALTER TABLE "agents" ADD COLUMN "bank_account_label" TEXT;
ALTER TABLE "agents" ADD COLUMN "qr_updated_at" TIMESTAMPTZ(3);
