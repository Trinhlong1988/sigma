-- SIGMA (24/7) — Ket ban (ke hoach muc 27): Rocket.Chat KHONG co khai niem "ban be" san, luu quan he o
-- LOP RIENG tren bot-api (bang moi, KHONG dung custom field RC). Additive thuan: 1 bang moi, KHONG dung bang/
-- cot cu.

CREATE TABLE "friend_requests" (
    "id" SERIAL NOT NULL,
    "from_agent_id" INTEGER NOT NULL,
    "to_agent_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    CONSTRAINT "friend_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "friend_requests_from_agent_id_idx" ON "friend_requests" ("from_agent_id");
CREATE INDEX "friend_requests_to_agent_id_idx" ON "friend_requests" ("to_agent_id");
CREATE INDEX "friend_requests_status_idx" ON "friend_requests" ("status");

-- Chan gui trung loi moi / ket ban trung: partial unique theo CAP KHONG PHAN BIET CHIEU (LEAST/GREATEST),
-- chi ap khi quan he dang SONG (PENDING/ACCEPTED) - cho phep ket ban lai sau khi da CANCELLED/REJECTED
-- (hang cu giu nguyen lam lich su, khong update de).
CREATE UNIQUE INDEX "friend_requests_pair_active_uq"
  ON "friend_requests" (LEAST("from_agent_id", "to_agent_id"), GREATEST("from_agent_id", "to_agent_id"))
  WHERE "status" IN ('PENDING', 'ACCEPTED');
