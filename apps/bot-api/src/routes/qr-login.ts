// SIGMA (3/8) — Đăng nhập bằng quét QR động (kiểu Zalo/WhatsApp Web). 4+1 endpoint, LÕI ở
// qr-login-service.ts (threat-model đã duyệt — xem comment đầu file service). Mount qua app.use(qrLoginRouter)
// trong app.ts. Route-level middleware (KHÔNG router-level — đúng bug class B12 đã ghi BUGS_FIXED.md).
//
//  POST /v1/auth/qr/create   (public, rate-limit theo IP): tạo challenge, set cookie pollSecret httpOnly, trả
//                            {token, matchCode, expiresIn, rotateIn}. Web encode `sigma-login:v1:<token>`.
//  GET  /v1/auth/qr/status   (cần cookie pollSecret): pending | approved(+mint phion như login thường, consume)
//                            | expired. Người KHÔNG có cookie này KHÔNG BAO GIỜ claim được phiên.
//  GET  /v1/auth/qr/info     (điện thoại đã auth): thông tin bên-yêu-cầu (IP/vị trí/UA/time). KHÔNG trả matchCode.
//  POST /v1/auth/qr/approve  (điện thoại đã auth): {token, code} → gán agentId=req.agent.id, APPROVED. Ghi log.
//  GET  /v1/auth/qr/events   (điện thoại đã auth): nhật ký đăng nhập-qua-QR gần đây của chính mình (item 8).
import { Router } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { getBotDb } from '../db.js';
import { asyncHandler } from '../async-handler.js';
import { requireSession } from '../session-middleware.js';
import { finalizeLoginSession, setWebSessionCookie } from '../web-session-service.js';
import {
  createChallenge,
  consumeIfApproved,
  getRequesterInfo,
  approveChallenge,
  listQrLoginEvents,
  CHALLENGE_TTL_MS
} from '../qr-login-service.js';
import { getLockStatus, recordFailure, clearFailures } from '../qr-approve-lockout.js';

export const qrLoginRouter = Router();

// Cookie pollSecret THÔ cho MÁY TẠO QR — httpOnly (JS không đọc được) + Secure + SameSite=None.
//
// FIX 6/8 (Admin Demo "mã QR làm mới vẫn hết hạn" trên exe/điện thoại) — TÁI HIỆN THẬT (Playwright): từ origin
// same-site (chat.example.com) cookie Strict round-trip OK → status 'pending'; NHƯNG từ origin 127.0.0.1 (bản
// EXE) / localhost-capacitor (APK) — CROSS-SITE với api.example.com — trình duyệt KHÔNG lưu/gửi cookie
// SameSite=Strict → MỌI /status trả 'expired', làm mới bao nhiêu cũng vô ích (challenge mới, cookie mới vẫn
// không được lưu). Đây CHÍNH là lý do phiên chính `sigma_ws` phải dùng SameSite=None để chạy được từ vỏ
// exe/app. => Đổi cookie QR sang None cho ĐỒNG NHẤT. CSRF vẫn được chặn bởi header `x-sigma-client` (proxyFetch)
// + pollSecret entropy cao httpOnly; giữ `__Host-` (Secure+Path=/+no-Domain, chống session-fixation) — chỉ nới SameSite.
const QR_POLL_COOKIE_NAME = '__Host-sigma_qr';

function setPollSecretCookie(res: import('express').Response, pollSecret: string): void {
  res.cookie(QR_POLL_COOKIE_NAME, pollSecret, {
    httpOnly: true,
    secure: true,
    sameSite: 'none', // cross-site: exe (127.0.0.1) + APK (capacitor/localhost) → api.example.com (xem chú thích trên)
    path: '/',
    maxAge: CHALLENGE_TTL_MS
  });
}

/** IP client tốt-nhất-có-thể: X-Forwarded-For trái nhất (khi sau reverse-proxy/cloudflared) → req.ip →
 * socket.remoteAddress. LƯU Ý bảo mật: XFF do client GỬI nên có thể GIẢ khi KHÔNG có trust-proxy cấu hình đúng
 * — giá trị này CHỈ dùng để HIỂN THỊ cho người dùng ở màn xác nhận + ghi nhật ký (không dùng để enforce quyền),
 * nên rủi ro giả mạo ở đây là hiển thị sai IP, KHÔNG phải leo thang quyền. Production nên set app `trust proxy`. */
function clientIp(req: import('express').Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.ip ?? req.socket.remoteAddress ?? null;
}

// ── Rate-limit ──────────────────────────────────────────────────────────────────────────────────────────
// create: theo IP — chặn 1 IP bơm vô hạn challenge (DoS/phình bảng). 60/15p đủ cho người dùng thật (mỗi lần vào
// màn + xoay token mỗi 60s trong 1 phiên đăng nhập vài phút).
const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu tạo mã QR, vui lòng thử lại sau.' }
});

// status: poll liên tục (mỗi ~2-3s trong 120s) là BÌNH THƯỜNG → hạn mức CAO, khóa theo cookie pollSecret (mỗi
// máy tạo QR 1 bucket riêng) để 1 máy poll nhiều KHÔNG ăn mòn hạn mức máy khác. Không có cookie → khóa theo IP.
const statusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const secret = (req.cookies?.[QR_POLL_COOKIE_NAME] as string | undefined) ?? '';
    // Không log/khóa theo pollSecret THÔ (nhạy cảm) — nhưng key rate-limit chỉ ở RAM, không ghi đĩa; dùng thẳng
    // giá trị cookie làm khóa là an toàn ở tầng này. Rỗng → theo IP. BẮT BUỘC dùng ipKeyGenerator() cho phần IP
    // (express-rate-limit v8 CHẶN keyGenerator tự trả IP thô — IPv6 /64 phải gộp subnet, nếu không ném
    // ERR_ERL_KEY_GEN_IPV6 lúc client IPv6 gọi, làm hỏng cả endpoint).
    return secret || ipKeyGenerator(req.ip ?? 'unknown');
  },
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu kiểm tra trạng thái, vui lòng thử lại sau.' }
});

// approve: theo agent (điện thoại đã auth) — chặn 1 tài khoản duyệt hàng loạt (dò matchCode qua nhiều challenge).
// Đặt SAU requireSession để có req.agent. 30/15p đủ cho người dùng thật (mỗi lần đăng nhập QR chỉ 1 approve).
const approveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.agent?.id ?? 'unknown'),
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều lần xác nhận đăng nhập, vui lòng thử lại sau.' }
});
const infoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.agent?.id ?? 'unknown'),
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu, vui lòng thử lại sau.' }
});
// AUDIT-vá LOW #4: /qr/events cần rate-limit (trước đây thiếu) — theo agent (đọc SAU requireSession). 60/15p đủ
// cho việc xem nhật ký, chặn 1 tài khoản spam đọc.
const eventsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.agent?.id ?? 'unknown'),
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu, vui lòng thử lại sau.' }
});

// POST /v1/auth/qr/create — tạo challenge + set cookie pollSecret. Public (chưa auth — máy tạo QR CHƯA đăng nhập).
qrLoginRouter.post('/v1/auth/qr/create', createLimiter, asyncHandler(async (req, res) => {
  const db = getBotDb();
  // FIX 6/8 (Admin Demo "hết hạn bấm không đổi mã mới"): matchCode CỐ ĐỊNH theo pollSecret (thiết kế cũ để xoay
  // token không đổi mã đang đọc). Nhưng khi mã HẾT HẠN + user chủ động "làm mới" → phải cấp mã MỚI (số mới).
  // body {fresh:true} → BỎ QUA cookie pollSecret cũ (existingPollSecret=null) → sinh pollSecret + matchCode MỚI.
  const fresh = (req.body as { fresh?: boolean } | undefined)?.fresh === true;
  const existingPollSecret = fresh ? null : ((req.cookies?.[QR_POLL_COOKIE_NAME] as string | undefined) ?? null);
  const created = await createChallenge(db, {
    existingPollSecret,
    requesterIp: clientIp(req),
    requesterUa: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null
  });
  // Set/refresh cookie mỗi lần (kể cả reuse) để gia hạn maxAge theo nhịp xoay — cookie luôn phản ánh pollSecret
  // đang dùng. pollSecretIsNew chỉ để biết có sinh mới hay không (không đổi hành vi set — luôn set lại an toàn).
  setPollSecretCookie(res, created.pollSecret);
  res.json({
    token: created.token,
    matchCode: created.matchCode,
    expiresIn: created.expiresInSeconds,
    rotateIn: created.rotateInSeconds
  });
}));

// GET /v1/auth/qr/status — MÁY TẠO QR poll trạng thái (cần cookie pollSecret). APPROVED → mint phiên như login
// thường (rcCreateLoginTokenForUser + createWebSession + set cookie sigma_ws) rồi trả {status:'approved'}.
qrLoginRouter.get('/v1/auth/qr/status', statusLimiter, asyncHandler(async (req, res) => {
  const db = getBotDb();
  const pollSecret = (req.cookies?.[QR_POLL_COOKIE_NAME] as string | undefined) ?? '';
  const result = await consumeIfApproved(db, pollSecret);

  if (result.outcome === 'PENDING') {
    res.json({ status: 'pending' });
    return;
  }
  if (result.outcome === 'EXPIRED') {
    res.json({ status: 'expired' });
    return;
  }

  // APPROVED + đã consume atomic — mint phiên cho agentId đã duyệt. agentId luôn có khi APPROVED (approve set nó).
  if (result.agentId == null) {
    console.error('[bot-api] qr/status: challenge APPROVED nhưng thiếu agentId — dữ liệu bất thường.');
    res.status(500).json({ error: 'QR_INTERNAL', message: 'Lỗi nội bộ khi cấp phiên, vui lòng thử lại.' });
    return;
  }
  const agent = await db.agent.findFirst({ where: { id: result.agentId, deletedAt: null } });
  if (!agent) {
    console.error(`[bot-api] qr/status: agentId=${result.agentId} không còn hợp lệ khi mint phiên QR.`);
    res.status(401).json({ error: 'AGENT_NOT_FOUND', message: 'Tài khoản duyệt không còn hợp lệ.' });
    return;
  }

  // 4/8 LOẠI RC — mint phiên ĐỘC LẬP RC (giống web-login/device-bypass): KHÔNG gọi rcCreateLoginTokenForUser
  // (chỗ trước đây văng 502 khi RC chết dù QR đã duyệt hợp lệ). rcUserId đọc từ agent (null tài khoản mới),
  // rcAuthToken=null. Bỏ đòi agent.rcUserId (tài khoản độc lập RC vẫn duyệt QR đăng nhập được).
  console.log(`[bot-api] qr/status: cấp phiên ĐỘC LẬP RC qua QR-login cho agentId=${agent.id} (challengeId=${result.challengeId}).`);
  // #3 (6/8) — /status chạy trên MÁY QUÉT-QR (máy MỚI đang đăng nhập) poll → NỀN suy từ request NÀY (header
  // X-Sigma-Platform proxyFetch gửi + fallback User-Agent). Tạo phiên + ĐÁ phiên cũ CÙNG NỀN của agent.
  const newSessionId = await finalizeLoginSession(
    db,
    { rcUserId: agent.rcUserId ?? null, rcUsername: agent.rcUsername, agentId: agent.id },
    {
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
      platformHeader: typeof req.headers['x-sigma-platform'] === 'string' ? (req.headers['x-sigma-platform'] as string) : undefined
    }
  );
  setWebSessionCookie(res, newSessionId);
  res.json({ status: 'approved' });
}));

// GET /v1/auth/qr/info?token= — điện thoại đã auth: thông tin bên-yêu-cầu cho màn xác nhận. KHÔNG lộ matchCode.
qrLoginRouter.get('/v1/auth/qr/info', asyncHandler(requireSession), infoLimiter, asyncHandler(async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu token.' });
    return;
  }
  const db = getBotDb();
  const result = await getRequesterInfo(db, token);
  if (result.outcome === 'NOT_FOUND') {
    res.status(404).json({ error: 'QR_NOT_FOUND', message: 'Mã QR không hợp lệ hoặc đã được dùng.' });
    return;
  }
  if (result.outcome === 'EXPIRED') {
    res.status(410).json({ error: 'QR_EXPIRED', message: 'Mã QR đã hết hạn, vui lòng làm mới trên máy tính.' });
    return;
  }
  res.json({
    requesterIp: result.info.requesterIp,
    requesterUa: result.info.requesterUa,
    approxLocation: result.info.approxLocation,
    createdAt: result.info.createdAt.toISOString(),
    expiresAt: result.info.expiresAt.toISOString()
  });
}));

// POST /v1/auth/qr/approve — điện thoại đã auth: {token, code}. agentId LẤY TỪ phiên (req.agent.id), KHÔNG tin input.
qrLoginRouter.post('/v1/auth/qr/approve', asyncHandler(requireSession), approveLimiter, asyncHandler(async (req, res) => {
  const body = req.body as { token?: string; code?: string };
  const token = typeof body?.token === 'string' ? body.token : '';
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  if (!token || !code) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu token hoặc mã xác nhận.' });
    return;
  }

  const db = getBotDb();
  const agentId = req.agent!.id; // TỪ requireSession — KHÔNG tin input.

  // TẠM KHÓA THEO AGENT (Admin Demo 4/8, "như Zalo") — nếu tài khoản này đã nhập sai quá ngưỡng gần đây, CHẶN NGAY
  // trước khi chạm DB (423 Locked), kèm retry-after để UI đếm ngược. Xem qr-approve-lockout.ts.
  const preLock = getLockStatus(agentId);
  if (preLock.locked) {
    const mins = Math.ceil(preLock.retryAfterMs / 60000);
    res.setHeader('Retry-After', String(Math.ceil(preLock.retryAfterMs / 1000)));
    res.status(423).json({
      error: 'QR_LOCKED',
      message: `Bạn đã nhập sai mã quá nhiều lần. Tính năng đăng nhập bằng QR tạm khóa, vui lòng thử lại sau ${mins} phút.`,
      retryAfterMs: preLock.retryAfterMs
    });
    return;
  }

  const result = await approveChallenge(db, token, code, agentId);

  switch (result.outcome) {
    case 'OK':
      clearFailures(agentId); // đăng nhập hợp lệ → xoá "nợ" sai cũ.
      console.log(`[bot-api] qr/approve: agentId=${agentId} đã duyệt 1 đăng nhập QR (token hợp lệ, mã đúng).`);
      res.json({ ok: true });
      return;
    case 'WRONG_CODE': {
      const lock = recordFailure(agentId);
      if (lock.locked) {
        const mins = Math.ceil(lock.retryAfterMs / 60000);
        res.setHeader('Retry-After', String(Math.ceil(lock.retryAfterMs / 1000)));
        res.status(423).json({
          error: 'QR_LOCKED',
          message: `Bạn đã nhập sai mã quá nhiều lần. Tính năng đăng nhập bằng QR tạm khóa, vui lòng thử lại sau ${mins} phút.`,
          retryAfterMs: lock.retryAfterMs
        });
        return;
      }
      res.status(400).json({ error: 'QR_WRONG_CODE', message: 'Mã xác nhận không đúng.', attemptsRemaining: result.attemptsRemaining });
      return;
    }
    case 'CANCELLED': {
      recordFailure(agentId); // hủy do sai mã cũng tính vào "nợ" sai theo agent.
      res.status(409).json({ error: 'QR_CANCELLED', message: 'Yêu cầu đăng nhập đã bị hủy (nhập sai mã quá số lần cho phép). Vui lòng làm mới mã QR trên máy tính.' });
      return;
    }
    case 'EXPIRED':
      res.status(410).json({ error: 'QR_EXPIRED', message: 'Mã QR đã hết hạn, vui lòng làm mới trên máy tính.' });
      return;
    case 'NOT_FOUND':
    default:
      res.status(404).json({ error: 'QR_NOT_FOUND', message: 'Mã QR không hợp lệ hoặc đã được dùng.' });
      return;
  }
}));

// GET /v1/auth/qr/events — nhật ký đăng nhập-qua-QR của chính mình (item 8: người dùng thấy device/IP/time).
qrLoginRouter.get('/v1/auth/qr/events', asyncHandler(requireSession), eventsLimiter, asyncHandler(async (req, res) => {
  const db = getBotDb();
  const events = await listQrLoginEvents(db, req.agent!.id);
  res.json({ events });
}));
