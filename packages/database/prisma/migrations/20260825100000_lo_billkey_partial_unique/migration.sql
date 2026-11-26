-- Fix audit #2 (25/8): chống ĐẾM ĐÔI doanh số khi 2 request /from-bill CÙNG billKey chạy song song (TOCTOU:
-- find-rồi-create không nguyên tử). UNIQUE 1 phần trên (agent_id, bill_key) CHỈ khi bill_key NOT NULL → 2 Lô
-- cùng billKey không thể cùng tồn tại; request thua race nhận lỗi unique → service tự hủy Lô thừa + trả Lô thắng.
-- (bill_key NULL vẫn cho nhiều Lô — bill không đủ định danh, dedup rơi sang tầng 3 DUP_SUSPECT.)
CREATE UNIQUE INDEX IF NOT EXISTS "los_agent_id_bill_key_unique" ON "los"("agent_id", "bill_key") WHERE "bill_key" IS NOT NULL;
