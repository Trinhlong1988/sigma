-- PHA 1 — NỀN "phí hiệu-lực-theo-kỳ + lịch sử doanh số". 3 việc: (1) tid_sell_fees đổi "1 override active" →
-- "nhiều KỲ override" (giống fee_sell_quotes) + thêm effective_from; (2) bảng revenue_recalc_logs (lịch sử
-- doanh số, engine ghi ở PHA 2); (3) tids.default_fee_type_id (loại phí mặc định theo TID — quyết định 2A).
-- KHÔNG có engine recalc + KHÔNG đụng flow giao TID ở PHA 1 (đó là PHA 2).
--
-- VIẾT TAY (CẤM `prisma migrate dev` trên DB thật `sigma` — memory feedback_no_prisma_migrate_dev_on_real_db
-- / bài học B113). CHƯA apply — LEAD chạy `prisma migrate deploy` trong cửa sổ bảo trì.
--
-- KHÔNG dùng CREATE INDEX CONCURRENTLY ở đây (khác 20260805120000_perf_indexes): bước DROP + CREATE UNIQUE
-- INDEX là ĐỔI RÀNG BUỘC uniqueness — cần nguyên tử (không để cửa sổ mất backstop), và CONCURRENTLY không chạy
-- được trong transaction Prisma bọc quanh migration. tid_sell_fees là bảng NHỎ (production gần như rỗng) nên
-- swap index đồng bộ không đáng ngại. CÙNG khuôn swap ở 20260712240000_fee_type_dimension (cũng không CONCURRENTLY).

-- ═══ (1) tid_sell_fees: thêm KỲ hiệu lực ═══
-- effective_from NOT NULL DEFAULT CURRENT_TIMESTAMP: hàng CŨ backfill = thời điểm migrate (kỳ áp dụng từ khi có);
-- hàng MỚI không truyền lấy now() (khớp @default(now()) trong schema.prisma). Service setTidSellFees LUÔN ghi
-- startOfDayLocal tường minh. CURRENT_TIMESTAMP là STABLE → 1 giá trị/ALTER → PG11+ thêm cột nhanh (không rewrite).
ALTER TABLE "tid_sell_fees" ADD COLUMN "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Partial-unique CŨ = 1 phí còn sống / (tid × thẻ × loại phí). MỚI = thêm chiều KỲ THEO NGÀY.
-- "THEO NGÀY" tính theo LOCAL Asia/Ho_Chi_Minh (khớp startOfDayLocal của service — tránh lệch +7h ranh giới ngày
-- trên máy chủ chạy UTC: user nhập 05/08 nhưng floor UTC-day có thể rơi 04/08). Biểu thức
-- (ts AT TIME ZONE 'Asia/Ho_Chi_Minh')::date là IMMUTABLE (zone literal) nên hợp lệ trong index — đã kiểm chứng
-- thật trên Postgres 16 (CREATE INDEX chấp nhận + 2 hàng cùng NGÀY-local va chạm, khác NGÀY-local thì không).
-- Cho phép nhiều KỲ khác NGÀY của cùng (tid × thẻ × loại phí) cùng tồn tại (lịch sử phí bán thực tế).
--
-- Dedupe phòng vệ (fail-safe): ràng buộc CŨ đã đảm bảo ≤1 hàng còn sống/(tid×thẻ×loại phí) nên sau backfill KHÔNG
-- thể có 2 hàng cùng (tổ hợp + NGÀY); giữ khối này để nếu lỡ có thì soft-delete hàng id nhỏ, không vỡ CREATE INDEX.
UPDATE "tid_sell_fees" t SET "deleted_at" = now()
 WHERE t."deleted_at" IS NULL AND EXISTS (
   SELECT 1 FROM "tid_sell_fees" t2
    WHERE t2."tid_id" = t."tid_id" AND t2."card_type_id" = t."card_type_id" AND t2."fee_type_id" = t."fee_type_id"
      AND t2."deleted_at" IS NULL AND t2."id" > t."id"
      AND (t2."effective_from" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
        = (t."effective_from" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date);

DROP INDEX IF EXISTS "tid_sell_fees_active_uq";
CREATE UNIQUE INDEX "tid_sell_fees_active_uq"
  ON "tid_sell_fees" ("tid_id", "card_type_id", "fee_type_id", ((("effective_from" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)))
  WHERE "deleted_at" IS NULL;

-- ═══ (2) revenue_recalc_logs — LỊCH SỬ DOANH SỐ (before→after). Cột tiền int8 (BigInt). ═══
CREATE TABLE "revenue_recalc_logs" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "fee_effective_from" TIMESTAMPTZ(3) NOT NULL,
    "before_partner_margin" INTEGER NOT NULL,
    "before_sell_margin" INTEGER NOT NULL,
    "before_revenue_amount" BIGINT NOT NULL,
    "after_partner_margin" INTEGER NOT NULL,
    "after_sell_margin" INTEGER NOT NULL,
    "after_revenue_amount" BIGINT NOT NULL,
    "reason" TEXT,
    "actor_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_recalc_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "revenue_recalc_logs_transaction_id_idx" ON "revenue_recalc_logs"("transaction_id");

-- ═══ (3) tids.default_fee_type_id — loại phí mặc định theo TID (quyết định 2A). Nullable thuần. ═══
ALTER TABLE "tids" ADD COLUMN "default_fee_type_id" INTEGER;
