-- Admin Demo 21/8: bill giải trình có thể dùng TÊN HKD của TID (Tid.hkdName) thay vì Hồ sơ HKD → dossier_id nullable.
ALTER TABLE "bill_explains" ALTER COLUMN "dossier_id" DROP NOT NULL;
