-- SIGMA "MENU HOI THOAI" (nhan giu 1 dong danh sach chat, kieu Zalo — 7/8, Admin Demo) — cac hanh dong cap
-- hoi-thoai PER-AGENT (Tat/bat thong bao, Ghim hoi thoai, Danh dau chua doc, An, Xoa hoi thoai phia minh, Bao xau).
--
-- Additive thuan — chi THEM 3 cot nullable vao chat_room_members + 1 bang MOI chat_reports. KHONG doi/xoa cot/
-- bang nao cu (DB `glb`/`sigma` dung chung — moi migration o day chi additive, xem comment schema.prisma).
--
-- CHUA AP LEN DB `sigma` san xuat luc tao file nay — LEAD (Admin Demo) tu chay `prisma migrate deploy` +
-- `prisma generate` khi san sang (migrate TRUOC, generate SAU). Test tu dong (vitest apps/bot-api) chay tren DB
-- throwaway rieng (global-setup.ts tu tao/huy qua `prisma migrate deploy`) — KHONG dung DB san xuat.

-- ── 3 cot trang thai CA NHAN per-agent per-room tren chat_room_members ──
--   pinned_at  — GHIM hoi thoai len dau danh sach (khac pinned_messages = ghim TIN trong phong).
--   hidden_at  — AN hoi thoai (KHONG tu hien lai khi co tin moi).
--   removed_at — XOA hoi thoai phia minh (tin VAN con) — TU clear khi phong co TIN MOI (xem sendMessage()).
ALTER TABLE "chat_room_members" ADD COLUMN IF NOT EXISTS "pinned_at" TIMESTAMPTZ(3);
ALTER TABLE "chat_room_members" ADD COLUMN IF NOT EXISTS "hidden_at" TIMESTAMPTZ(3);
ALTER TABLE "chat_room_members" ADD COLUMN IF NOT EXISTS "removed_at" TIMESTAMPTZ(3);

-- ── Bang MOI chat_reports — "Bao xau" (1 hang = 1 lan agent bao xau 1 phong) ──
-- KHONG FK cung (bolt-on scalar join, cung convention pinned_messages/chat_room_tids) — index room_id + reporter du.
CREATE TABLE IF NOT EXISTS "chat_reports" (
    "id" TEXT NOT NULL,
    "reporter_agent_id" INTEGER NOT NULL,
    "room_id" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "chat_reports_room_id_idx" ON "chat_reports"("room_id");
CREATE INDEX IF NOT EXISTS "chat_reports_reporter_agent_id_idx" ON "chat_reports"("reporter_agent_id");
