-- SIGMA (2026-07-22, CMD_BUILD): Rule F — tổng số tiền quẹt/ngày cho 1 TID (LEAD chốt, khác chiều Rule A
-- đơn-lệnh / Rule B số-lệnh). Additive thuần: 1 cột nullable mới trên bank_fraud_rules, KHÔNG đụng cột cũ.

ALTER TABLE "bank_fraud_rules" ADD COLUMN "max_daily_total_per_tid" BIGINT;
