-- LOẠI GIAO — ĐẶT CỌC độc lập (Admin Demo 9/8): thêm cột has_deposit (bool, default false) cho handover_types.
-- Tách CỌC khỏi money_kind loại-trừ cũ → Cho thuê/Mượn/Đối ứng kèm cọc TÙY CHỌN, Bán không cọc.
-- Nullable-safe: default false; backfill builtin ở seed (seedBuiltinHandoverTypes) khi boot, KHÔNG set ở đây
-- (tránh phụ thuộc tên tiếng Việt trong migration). migrate deploy trên DB production sau khi Admin Demo duyệt.
ALTER TABLE "handover_types" ADD COLUMN "has_deposit" BOOLEAN NOT NULL DEFAULT false;
