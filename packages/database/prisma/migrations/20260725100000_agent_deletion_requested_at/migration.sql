-- SIGMA (25/7, Admin Demo yeu cau) - Xoa tai khoan co 48h an han: dai ly bam "Xoa tai khoan" -> set cot
-- nay = thoi diem bam (KHONG xoa ngay) -> trong 48h van dang nhap/huy yeu cau binh thuong -> sau DUNG 48h,
-- lan dang nhap ke tiep moi thuc su xoa (tai dung deleted_at/deleted_by da co san, KHONG them cot xoa moi).
-- Additive thuan: 1 cot moi nullable, KHONG dung bang/cot cu.

ALTER TABLE "agents" ADD COLUMN "deletion_requested_at" TIMESTAMPTZ(3);
