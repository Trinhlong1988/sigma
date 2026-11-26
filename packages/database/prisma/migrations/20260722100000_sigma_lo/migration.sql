-- SIGMA (2026-07-22, CMD_BUILD): nền "Lô"/"Hóa đơn" cho bot chat kết toán POS (Rocket.Chat wiring
-- KHÔNG có trong task này). Additive thuần: 4 bảng mới (los/lo_rows/lo_bills/bank_fraud_rules), KHÔNG đụng
-- bảng cũ. Scalar id links (không hard FK), khuôn asset tables đã có (xem comment đầu schema.prisma).

CREATE TABLE "los" (
    "id" SERIAL NOT NULL,
    "agent_id" INTEGER NOT NULL,
    "bank_reported_lo_number" INTEGER,
    "expected_total_amount" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "los_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "los_agent_id_idx" ON "los" ("agent_id");
CREATE INDEX "los_status_idx" ON "los" ("status");
CREATE INDEX "los_agent_id_bank_reported_lo_number_idx" ON "los" ("agent_id", "bank_reported_lo_number");

CREATE TABLE "lo_rows" (
    "id" SERIAL NOT NULL,
    "lo_id" INTEGER NOT NULL,
    "tid_id" INTEGER NOT NULL,
    "card_type_id" INTEGER NOT NULL,
    "fee_type_id" INTEGER NOT NULL,
    "amount_before_fee" BIGINT NOT NULL,
    "fee_applied" BIGINT NOT NULL,
    "amount_after_fee" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lo_rows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lo_rows_lo_id_idx" ON "lo_rows" ("lo_id");

CREATE TABLE "lo_bills" (
    "id" SERIAL NOT NULL,
    "lo_id" INTEGER NOT NULL,
    "receipt_number" INTEGER,
    "ocr_amount" BIGINT NOT NULL,
    "swipe_at" TIMESTAMPTZ(3) NOT NULL,
    "card_last4" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lo_bills_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lo_bills_lo_id_idx" ON "lo_bills" ("lo_id");
CREATE INDEX "lo_bills_card_last4_idx" ON "lo_bills" ("card_last4");

CREATE TABLE "bank_fraud_rules" (
    "id" SERIAL NOT NULL,
    "bank_id" INTEGER NOT NULL,
    "max_amount_per_swipe" BIGINT,
    "max_swipes_per_day_per_card" INTEGER,
    "min_gap_minutes_between_swipes" INTEGER,
    "disallow_round_amounts" BOOLEAN NOT NULL DEFAULT false,
    "disallow_repeated_amount_nearby" BOOLEAN NOT NULL DEFAULT false,
    "repeated_amount_window_minutes" INTEGER,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_by" INTEGER,
    CONSTRAINT "bank_fraud_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "bank_fraud_rules_bank_id_idx" ON "bank_fraud_rules" ("bank_id");
