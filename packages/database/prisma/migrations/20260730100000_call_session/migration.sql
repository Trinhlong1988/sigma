-- SIGMA Phase 4 (30/7) — gọi thoại/video WebRTC tự xây, thay Rocket.Chat. Additive thuần, KHÔNG đụng bảng
-- nào khác (DB glb/sigma dùng chung — xem CLAUDE.md). Bảng bolt-on (không FK tới Agent, CÙNG convention
-- chat_rooms/chat_messages — xem migration 20260729100000_chat_core).
--
-- SOẠN SẴN cho worktree phase4-webrtc + throwaway test DB CỦA WORKTREE NÀY — KHÔNG tự áp lên DB production
-- `sigma`/`glb` thật (LEAD/Admin Demo tự chạy `prisma migrate deploy` khi merge, xem báo cáo build).

CREATE TABLE "call_sessions" (
    "id" TEXT NOT NULL,
    "caller_id" INTEGER NOT NULL,
    "callee_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RINGING',
    "end_reason" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "duration_sec" INTEGER,

    CONSTRAINT "call_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "call_sessions_caller_id_idx" ON "call_sessions"("caller_id");
CREATE INDEX "call_sessions_callee_id_idx" ON "call_sessions"("callee_id");
CREATE INDEX "call_sessions_status_idx" ON "call_sessions"("status");
