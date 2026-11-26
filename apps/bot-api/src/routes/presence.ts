// SIGMA PRESENCE endpoints (6/8, Admin Demo: online real-time kiểu Zalo/PC) — "nhịp sống" cho ca thiết-bị-còn-
// mạng-nhưng-không-có-WS-thường-trực (chủ yếu app Android bị KILL được FCM-ping đánh thức → POST /ping) + client
// chủ động báo mất mạng/đăng xuất (POST /offline). WS-sống vẫn là nguồn presence CHÍNH (agentHasOpenConnection),
// 2 endpoint này BỔ SUNG cho ca không có WS. Mỗi endpoint requireSession (cookie + CSRF header chuẩn) → chỉ phiên
// CÒN ĐĂNG NHẬP mới ghi được nhịp sống (phiên đã logout bị requireSession chặn → không ping được → offline đúng).
//
// Mỗi lần đổi trạng thái (offline→online ở /ping, online→offline ở /offline) → broadcastPresenceUpdate() phát
// realtime cho người liên quan (presence-service.ts), 0 độ trễ.
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Request } from 'express';
import { asyncHandler } from '../async-handler.js';
import { requireSession } from '../session-middleware.js';
import { getBotDb } from '../db.js';
import { agentPresenceOnline, markAgentSeen, markAgentOffline, agentHasOpenConnection, getAgentLastSeen } from '../chat-realtime-hub.js';
import { broadcastPresenceUpdate, planPresencePings } from '../presence-service.js';
import { sendPresencePingToAgent } from '../push-notification-service.js';

/** Số agentId tối đa 1 lượt /v1/presence/check (client gửi danh sách người đang HIỂN THỊ trên màn presence). */
const MAX_CHECK_AGENT_IDS = 50;

/** ISO của mốc last-seen (epoch ms) hoặc null — dùng chung cho snapshot presence. */
function lastSeenIso(agentId: number): string | null {
  const ms = getAgentLastSeen(agentId);
  return ms != null ? new Date(ms).toISOString() : null;
}

export const presenceRouter = Router();

// Chống gọi dồn dập (DevTools/script) — scope theo agentId (nhiều đại lý chung NAT không phân biệt qua IP, CÙNG
// lý do friendLookupLimiter/chatSearchLimiter). Ngân sách RỘNG: client heartbeat ping ~15s/lần (FIX 11/8, trước
// là 45s — xem PRESENCE_PING_INTERVAL_MS) = ~4/phút + vài lần lúc online/visible lại; 60/phút vẫn thừa cho hành
// vi hợp lệ, vẫn chặn spam. Nhẹ (chỉ Map.set + 1 lượt broadcast) nên không cần siết chặt hơn.
const presenceLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => String(req.agent?.id ?? 'unknown'),
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều nhịp presence trong 1 phút.' }
});

// POST /v1/presence/ping — cập nhật lastSeen=now. Nếu agent TRƯỚC ĐÓ chưa online (không WS + lastSeen cũ/không có)
// → vừa chuyển ONLINE → phát presence-update online realtime.
presenceRouter.post(
  '/v1/presence/ping',
  asyncHandler(requireSession),
  presenceLimiter,
  asyncHandler(async (req, res) => {
    const agentId = req.agent!.id;
    const wasOnline = agentPresenceOnline(agentId);
    markAgentSeen(agentId);
    if (!wasOnline) {
      await broadcastPresenceUpdate(getBotDb(), agentId, true);
    }
    res.json({ ok: true });
  })
);

// POST /v1/presence/offline — client chủ động báo mất mạng/đăng xuất → markAgentOffline (xóa lastSeen + set cờ
// offline-tường-minh + HỦY grace-timer nếu có). BỎ QUA grace 10s (mất mạng/máy bay/logout là CHẮC CHẮN — đây là
// điểm giúp airplane/logout offline NHANH, phương án 1 điểm 3). Nếu sau đó agent KHÔNG còn WS nào → phát
// presence-offline realtime NGAY. Cờ offline-tường-minh chống đua: WS đóng sau lời gọi này sẽ KHÔNG re-online.
presenceRouter.post(
  '/v1/presence/offline',
  asyncHandler(requireSession),
  presenceLimiter,
  asyncHandler(async (req, res) => {
    const agentId = req.agent!.id;
    markAgentOffline(agentId);
    if (!agentPresenceOnline(agentId)) {
      await broadcastPresenceUpdate(getBotDb(), agentId, false);
    }
    res.json({ ok: true });
  })
);

// POST /v1/presence/check — body {agentIds:number[]} (≤50) = danh sách người ĐANG HIỂN THỊ presence trên màn của
// người gọi. Với mỗi target KHÔNG có WS sống → gửi FCM data presence_ping "gõ cửa" (throttle 1 ping/agent/30s qua
// planPresencePings) để app-đã-kill-nhưng-còn-mạng tự báo online lại (Java → POST /v1/presence/ping). Trả về
// SNAPSHOT presence hiện tại (online + lastSeenAt) cho đúng các id đó để client vẽ ngay, không đợi realtime.
presenceRouter.post(
  '/v1/presence/check',
  asyncHandler(requireSession),
  presenceLimiter,
  asyncHandler(async (req, res) => {
    const raw = req.body?.agentIds;
    if (!Array.isArray(raw)) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'agentIds phải là mảng số nguyên dương.' });
      return;
    }
    const agentIds = [...new Set(raw.map((v: unknown) => Number(v)).filter((n: number) => Number.isInteger(n) && n > 0))].slice(0, MAX_CHECK_AGENT_IDS);
    const db = getBotDb();
    // Gửi FCM ping best-effort cho các target reachable-cần-đánh-thức (planPresencePings tự bỏ target có WS +
    // throttle). sendPresencePingToAgent KHÔNG BAO GIỜ throw (best-effort) — "fire and forget", KHÔNG chặn response.
    const pingTargets = planPresencePings(agentIds, agentHasOpenConnection);
    for (const id of pingTargets) void sendPresencePingToAgent(db, id);
    // Snapshot hiện tại (đọc SAU khi lên kế hoạch ping — ping là bất đồng bộ, snapshot phản ánh trạng thái ngay
    // lúc này; client sẽ nhận presence-update realtime nếu target phản hồi ping sau đó).
    const now = Date.now();
    const data = agentIds.map((id) => ({ agentId: id, online: agentPresenceOnline(id, now), lastSeenAt: lastSeenIso(id) }));
    res.json({ ok: true, data });
  })
);
