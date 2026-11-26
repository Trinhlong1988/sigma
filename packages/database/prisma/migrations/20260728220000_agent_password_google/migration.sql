-- SIGMA (28/7) -- Phase 1 "bo Rocket.Chat": mat khau noi bo (bcrypt) + Google OAuth that. RC VAN tiep tuc
-- lam backend chat (khong dung/doi WebSession.rc*, khong doi Agent.rcUserId/rcUsername). Additive thuan: 2 cot
-- moi NULLABLE tren agents, KHONG dung bang/cot cu. KHONG tu ap dung migration nay len DB production -- LEAD
-- tu chay sau khi review (quy tac cung du an).

ALTER TABLE "agents" ADD COLUMN "password_hash" TEXT;
ALTER TABLE "agents" ADD COLUMN "google_id" TEXT;

CREATE UNIQUE INDEX "agents_google_id_key" ON "agents"("google_id");
