// SIGMA Phase 4 (30/7) — gọi thoại/video WebRTC tự xây. Route DUY NHẤT ở đây: cấp credential TURN ngắn
// hạn cho agent đang đăng nhập (ICE server config để trình duyệt/app tự thử P2P trước, rồi relay qua TURN nếu
// NAT chặn trực tiếp — xem turn-credential-service.ts). Middleware requireSession gắn TRỰC TIẾP vào route
// (route-level, KHÔNG `callRouter.use(...)` — ĐÚNG bug class B12 đã sửa ở agentsRouter/loRouter/meRouter/
// kpiRouter, xem BUGS_FIXED.md — router-level `.use()` áp cho MỌI request lọt vào router theo thứ tự mount,
// kể cả path không khớp route nào trong router đó).
import { Router } from 'express';
import { requireSession } from '../session-middleware.js';
import { asyncHandler } from '../async-handler.js';
import { generateTurnCredentials, TurnConfigError } from '../turn-credential-service.js';

export const callRouter = Router();

// GET /v1/call/turn-credentials — trả {username, credential, ttl, uris} dùng làm RTCIceServer.credential cho
// WebRTC (apps/web-demo/src/lib/webrtc-call.ts gọi endpoint này TRƯỚC khi new RTCPeerConnection()).
callRouter.get('/v1/call/turn-credentials', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  try {
    const creds = generateTurnCredentials(req.agent!.id);
    res.json(creds);
  } catch (err) {
    if (err instanceof TurnConfigError) {
      // Hạ tầng TURN CHƯA được LEAD deploy/cấu hình biến môi trường thật (xem docker-compose.yml/
      // turnserver.conf mẫu ở <REPO>\tools\sigma-coturn) — trả lỗi RÕ RÀNG (R198: không nuốt im),
      // KHÔNG crash cả request khác.
      res.status(500).json({ error: err.code, message: err.message });
      return;
    }
    throw err;
  }
}));
