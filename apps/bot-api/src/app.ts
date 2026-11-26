// SigMa Tier 1 — Express app factory (tách khỏi index.ts để test import được KHÔNG cần bind port thật).
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { authRouter } from './routes/auth.js';
import { kpiRouter } from './routes/kpi.js';
import { meInvestorReportRouter } from './routes/me-investor-report.js';
import { meRouter } from './routes/me.js';
import { diaryRouter } from './routes/diary.js';
import { profileRouter } from './routes/profile.js';
import { chatAttachmentsRouter } from './routes/chat-attachments.js';
import { chatRouter } from './routes/chat.js';
import { callRouter } from './routes/call.js';
import { qrLoginRouter } from './routes/qr-login.js';
import { presenceRouter } from './routes/presence.js';
import { internalIngestRouter } from './routes/internal-ingest.js';
import { ocrSendRouter } from './routes/ocr-send.js';
import { alphaAggregateRouter } from './routes/alpha-aggregate.js';
import { digistoreRouter } from './routes/digistore.js';
import { binCheckRouter } from './routes/bin-check.js';
import { promoProgramsRouter } from './routes/promo-programs.js';
import { getBotDb } from './db.js';
import { kiemTraDb, phanLoaiLoiDb } from './db-health.js';

// CORS — allowlist origin dời sang module lá `cors-allowlist.ts` (LANE A Vòng 2, 3/8) để dùng CHUNG với kiểm
// Origin WebSocket chống CSWSH (ws-origin-check.ts) mà KHÔNG gây import vòng (xem cors-allowlist.ts). Re-export
// giữ nguyên tên `CORS_ALLOWED_ORIGINS` cho mọi nơi đang import từ app.ts (cors.test.ts...).
export { CORS_ALLOWED_ORIGINS } from './cors-allowlist.js';
import { CORS_ALLOWED_ORIGINS, isAllowedOrigin } from './cors-allowlist.js';

// BUG THẬT đêm 23→24/7 (xem async-handler.ts): 1 lỗi async không bắt trong route handler từng CRASH CẢ
// TIẾN TRÌNH. Middleware lỗi 4-tham-số này PHẢI đứng CUỐI CÙNG (đúng quy ước Express — middleware nhận
// (err, req, res, next) chỉ được Express nhận diện là error-handler nếu có ĐỦ 4 tham số) — mọi next(err)
// từ asyncHandler() ở các router phía trên đều đổ về đây. KHÔNG lộ stack trace/chi tiết nội bộ (message
// Prisma/đường dẫn file...) ra response — chỉ log ra console phía server, client chỉ nhận message an toàn
// ngắn gọn. KHÔNG nuốt lỗi câm lặng — console.error LUÔN chạy trước khi trả response (R198).
//
// AUDIT FIX (MEDIUM, security-auditor 24/7) — pattern Express khuyến cáo tường minh: nếu response ĐÃ bắt
// đầu ghi (vd streaming/res.write một phần) TRƯỚC KHI lỗi xảy ra, gọi res.status()/res.json() lần 2 ở đây
// sẽ tự throw ERR_HTTP_HEADERS_SENT ĐỒNG BỘ — và vì đây là middleware lỗi CUỐI CÙNG trong chuỗi, lỗi đồng bộ
// đó lại quay về ĐÚNG lớp bug "unhandled exception crash cả process" mà patch này sinh ra để diệt. Hiện tại
// KHÔNG route nào ghi response từng phần trước khi lỗi (chưa bị khai thác được) — đây là gap phòng thủ theo
// chiều sâu cho tương lai, không phải lỗi đang xảy ra. Theo đúng khuyến cáo Express: nếu headersSent, PHẢI
// return next(err) để Express default error handler tự đóng kết nối, KHÔNG được tự ghi response lần 2.
//
// Export RIÊNG (không khai báo inline trong createApp()) để test mount được trực tiếp lên 1 app/route giả lập
// (vd res.write() một phần rồi mới lỗi) mà KHÔNG cần dựng lại toàn bộ router thật — test/error-handling.test.ts.
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  console.error('[bot-api] Lỗi không bắt được trong route handler:', err);
  if (res.headersSent) {
    next(err);
    return;
  }
  // body-parser (B6, đối kháng 12/8): JSON quá cỡ (>100kb) → 413 (KHÔNG 500 hệ thống); JSON sai cú pháp → 400.
  const e = err as { type?: string };
  if (e?.type === 'entity.too.large') { res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'Nội dung gửi lên quá lớn.' }); return; }
  if ((err instanceof SyntaxError && 'body' in (err as object)) || e?.type === 'entity.parse.failed') { res.status(400).json({ error: 'BAD_JSON', message: 'Dữ liệu gửi lên không phải JSON hợp lệ.' }); return; }
  // DB CHƯA SẴN SÀNG (30/9, Admin Demo duyệt) — sự cố thật: máy tắt đột ngột 19:06 → PostgreSQL crash-recovery →
  // Prisma ném `57P03 the database system is starting up`. Trước đây rơi vào 500 INTERNAL_ERROR chung, client
  // hiện "Lỗi kết nối mạng, kiểm tra đường truyền" → SAI BẢN CHẤT, người dùng đi soi modem trong khi chỉ cần
  // đợi DB dậy. NAY trả 503 + mã riêng để client nói đúng việc cần làm (xem db-health.ts). Vẫn KHÔNG lộ chi
  // tiết nội bộ (không kèm stack/SQLSTATE/đường dẫn) — chỉ 1 câu tiếng Việt + mã ổn định cho client.
  const loaiDb = phanLoaiLoiDb(err);
  if (loaiDb === 'starting') {
    res.status(503).json({ error: 'DB_STARTING', message: 'Máy chủ đang khởi động lại, vui lòng thử lại sau khoảng một phút.' });
    return;
  }
  if (loaiDb === 'down') {
    res.status(503).json({ error: 'DB_UNAVAILABLE', message: 'Máy chủ dữ liệu đang tạm ngưng, vui lòng thử lại sau ít phút.' });
    return;
  }
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Đã xảy ra lỗi hệ thống, vui lòng thử lại sau.' });
}

export function createApp(): Express {
  const app = express();
  // AUDIT ĐỐI KHÁNG 12/8 (B1/B3/B4) — đồng bộ quanly-api. Sau Cloudflare tunnel, IP thật ở X-Forwarded-For →
  // `trust proxy = 1` (tin ĐÚNG 1 hop cloudflared, KHÔNG `true` mù) để req.ip = IP client thật → rate-limiter
  // per-IP KHÔNG sụp thành 1 bucket toàn cục (1 kẻ trip → 429 cho tất cả). AN TOÀN vì bot-api nay bind loopback
  // (index.ts) → cloudflared là client DUY NHẤT tới origin, không ai spoof XFF xuyên tunnel được.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    cors({
      // Dùng hàm matcher (allowlist + loopback http cho bản PC Electron 127.0.0.1:<cổng ngẫu nhiên>) —
      // xem isAllowedOrigin trong cors-allowlist.ts. Origin không hợp lệ → không phản chiếu ACAO (bị chặn).
      origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
      credentials: true
    })
  );
  // AUDIT-vá MEDIUM #2c (QR-login hardening, 3/8) — HSTS includeSubDomains: buộc trình duyệt LUÔN dùng HTTPS cho
  // example.com + MỌI subdomain → cookie Secure/`__Host-` (pollSecret QR, sigma_ws) không bị lột qua SSL-strip
  // trên bất kỳ subdomain nào. CHỈ set khi kết nối đã là HTTPS (req.secure hoặc x-forwarded-proto=https do
  // cloudflared đặt) — trình duyệt BỎ QUA header HSTS nhận qua http/localhost nên set thừa cũng vô hại; kiểm điều
  // kiện để không phát header nhiễu trên http thuần. KHÔNG dùng helmet (dự án chưa có) — 1 header đơn, additive.
  app.use((req, res, next) => {
    // Security headers (B4, đồng bộ quanly-api) — nosniff/X-Frame/Referrer LUÔN (additive, không phá route file);
    // HSTS chỉ khi HTTPS (cloudflared đặt x-forwarded-proto).
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  // limit body JSON có ĐIỀU KIỆN (deep-audit 1/9 LOW — chống DoS bộ nhớ): mặc định 512kb cho MỌI route; CHỈ path
  // /v1/ocr-send/* (gửi 2 ẢNH CARD base64 ~1-2MB) mới 16mb. Phải điều-kiện Ở ĐÂY vì global express.json chạy TRƯỚC
  // router → nếu để 512kb global thì ocr-send 16mb bị 413 trước khi tới router.
  const _jsonLarge = express.json({ limit: '16mb' });
  const _jsonSmall = express.json({ limit: '512kb' });
  app.use((req, res, next) => (req.path.startsWith('/v1/ocr-send/') ? _jsonLarge : _jsonSmall)(req, res, next));
  // SIGMA (26/7) — cookie-parser TRƯỚC mọi router dùng requireWebSession/cookie fallback của requireRcAuth
  // (rc-auth-middleware.ts) — cần req.cookies đã parse sẵn. KHÔNG cấu hình secret (không dùng cookie ký/mã
  // hoá — WebSession.id vốn đã là cuid ngẫu nhiên không đoán được, xem web-session-service.ts).
  app.use(cookieParser());
  // Health-check KHÔNG auth (đặt SỚM, trước mọi router nghiệp vụ) — cloudflared/monitor/Playwright ping để biết
  // bot-api sống. CHỈ trả trạng thái tĩnh {ok, service} — KHÔNG lộ version/env/DB/đường dẫn/thông tin nhạy cảm.
  // 2 alias (/health + /healthz) cho khớp cả quy ước cloudflared lẫn k8s-style healthz. GET (+ HEAD tự động).
  const health = (_req: Request, res: Response): void => {
    res.status(200).json({ ok: true, service: 'bot-api' });
  };
  app.get('/health', health);
  app.get('/healthz', health);
  // HEALTH SÂU (30/9) — `/health` ở trên CỐ Ý giữ nguyên hợp đồng tĩnh {ok,service} cho cloudflared/Playwright
  // và KHÔNG lộ gì ra Internet. Nhưng chính vì tĩnh nên watchdog từng ghi "OK health 200" suốt trong lúc app
  // chết vì DB (sự cố 30/9). Endpoint này chạm DB THẬT (SELECT 1) và CHỈ phục vụ máy cục bộ:
  //   - `x-forwarded-for` có mặt ⇒ request đi qua cloudflared từ Internet ⇒ TỪ CHỐI (404, không lộ tồn tại).
  //   - req.ip phải là loopback. (Không dùng req.socket.remoteAddress: bot-api bind loopback nên peer LUÔN là
  //     127.0.0.1 kể cả request từ tunnel — dùng nó sẽ mở toang endpoint này ra ngoài.)
  // Trả 200 khi db='up', 503 khi 'starting'/'down' → watchdog phân biệt được và xử lý ĐÚNG (xem
  // infra/bot-api-service/watchdog-bot-api.ps1: DB chưa lên thì CẢNH BÁO chứ KHÔNG giết bot-api, vì giết
  // tiến trình không làm DB dậy nhanh hơn — chỉ đứt thêm WebSocket của người đang dùng).
  app.get('/health/deep', (req: Request, res: Response): void => {
    const ip = req.ip ?? '';
    const cucBo = !req.headers['x-forwarded-for'] && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
    if (!cucBo) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Không tìm thấy.' });
      return;
    }
    // KHÔNG nuốt lỗi câm (R198): kiemTraDb() không throw, lỗi lạ → 'down' (fail-closed) chứ không báo xanh.
    void kiemTraDb(getBotDb()).then((db) => {
      res.status(db === 'up' ? 200 : 503).json({ ok: db === 'up', service: 'bot-api', db });
    });
  });
  // Endpoint NỘI BỘ (watcher Zalo → ingest bill) — guard bằng bí mật chia sẻ ở route-level (fail-closed, KHÔNG
  // dùng requireSession/RC auth). Đặt SỚM, trước router nghiệp vụ; middleware token gắn trực tiếp route (đúng B12).
  app.use(internalIngestRouter);
  app.use(authRouter);
  // Báo cáo/KPI (kế hoạch mục D.6) — router RIÊNG (kpiRouter, path /v1/me/kpi). Middleware requireRcAuth gắn
  // TRỰC TIẾP vào route (`kpiRouter.get(path, asyncHandler(requireRcAuth), handler)`, xem routes/kpi.ts) —
  // KHÔNG dùng `kpiRouter.use(requireRcAuth)` router-level — đúng bug class B12 (xem BUGS_FIXED.md: router-
  // level `.use(middleware)` không kèm path áp cho MỌI request đi qua router đó, kể cả request không khớp bất
  // kỳ route nào khai trong router — phát hiện lúc build kpiRouter, meRouter cùng lỗi đã được sửa CÙNG PHẠM VI
  // B12). Vì kpiRouter chỉ dùng route-level middleware, thứ tự mount ở đây với meRouter KHÔNG còn quan trọng
  // (không router nào còn `.use()` chặn toàn cục nữa).
  app.use(kpiRouter);
  app.use(meInvestorReportRouter);
  // Báo cáo TỔNG GỘP SIGMA (Admin Demo 5/9) — CHỈ 3 chủ SigMa (requireAlphaOwner gắn route-level, đúng B12). Path /v1/alpha-aggregate/*.
  app.use(alphaAggregateRouter);
  // SIGMA — route nghiệp vụ SigMa theo đại lý dùng RC-auth (/v1/me/*), agentId suy TỪ phiên đăng nhập.
  // BOLA fix (20/8): các route Bearer-token cũ (agentsRouter /v1/agents/:agentCode/*, loRouter /v1/lo/:loId/* +
  // /v1/agents/:agentCode/lo*) ĐÃ GỠ hoàn toàn — khóa Bearer TĨNH dùng-chung không mang danh tính đại lý nên
  // cho phép thao tác chéo mọi :agentCode qua URL (broken object-level authorization). Bề mặt LIVE giữ lại là
  // /v1/me/* (đã có kiểm tra sở hữu lo.agentId === req.agent.id). Xem routes/me.ts.
  app.use(meRouter);
  // SIGMA "Nhật ký"/Newsfeed (3/8) — đăng bài/cảm xúc/bình luận, path /v1/diary/* (không giao /v1/me/*),
  // route-level requireSession (KHÔNG router-level — bài học B12), xem routes/diary.ts + services/diary-service.ts.
  app.use(diaryRouter);
  // 25/7 — tra cứu công khai tối thiểu theo username (link cá nhân), file riêng routes/profile.ts.
  app.use(profileRouter);
  // LOẠI SẠCH Rocket.Chat (4/8) — ĐÃ GỠ mount reverse-proxy `/v1/rc/*` + `/v1/rc-file` và webhook
  // `/v1/rc-events/message` (RC gọi vào): RC đã bị loại hoàn toàn, không client nào còn gọi `/v1/rc/*`
  // (getRcUserInfoByUsername/getRoomReadOnly ở web-demo/src/lib/rc-realtime.ts đã cutover sang endpoint nội
  // bộ) và không có RC server nào gọi webhook nữa. 2 file router tương ứng đã XÓA khỏi repo (dead code + bỏ
  // luôn bề mặt tấn công public của webhook).
  // SIGMA (27/7) — đính kèm ảnh/file chat THẬT (lưu vật lý ở bot-api, xem
  // comment đầu routes/chat-attachments.ts). Middleware requireSession gắn TRỰC TIẾP từng route (route-level,
  // KHÔNG router-level — đúng bug class B12), thứ tự mount ở đây không quan trọng.
  app.use(chatAttachmentsRouter);
  // SIGMA "Quét bill gửi" (30/8) — menu OCR bill (thủ công + tự động folder-scan) → gửi nhóm đại lý + cc NĐT.
  // Route-level requireSession (KHÔNG router-level — B12). Xem routes/ocr-send.ts + ocr-send-service.ts.
  app.use(ocrSendRouter); // body 16mb đã áp có điều kiện ở parser global (path /v1/ocr-send/*).
  // ĐỐI SOÁT "BÁO CÓ" DIGISTORE (5/9) — CHECK on-demand cho tab review (/v1/digistore/check-baoco). Route-level
  // requireSession (KHÔNG router-level — B12). Poll nền wire ở index.ts. Xem routes/digistore.ts + digistore-reconcile.ts.
  app.use(digistoreRouter);
  app.use(binCheckRouter); // [Admin Demo 12/9] tra BIN thẻ — SigMa dùng (owner-gated trong router)
  app.use(promoProgramsRouter); // [Admin Demo 12/9] KM trên SigMa — owner-gated
  // SIGMA Phase 2 "chat lõi" (29/7) — REST routes chat tự xây (phòng/tin nhắn/reaction/thành viên), xem
  // comment đầu routes/chat.ts. Middleware requireSession gắn TRỰC TIẾP từng route (route-level, KHÔNG
  // router-level — đúng bug class B12), thứ tự mount ở đây không quan trọng.
  app.use(chatRouter);
  // SIGMA Phase 4 (30/7) — gọi thoại/video WebRTC tự xây, xem comment đầu routes/call.ts. Middleware
  // requireSession gắn TRỰC TIẾP route (route-level, KHÔNG router-level — đúng bug class B12), thứ tự mount
  // ở đây không quan trọng.
  app.use(callRouter);
  // SIGMA (3/8) — Đăng nhập bằng quét QR động (kiểu Zalo/WhatsApp Web), path /v1/auth/qr/* (không giao
  // /v1/auth/* register/login của authRouter). Route-level middleware (requireSession gắn TRỰC TIẾP từng route
  // cần auth — info/approve/events; create/status public — KHÔNG router-level, đúng bug class B12), thứ tự mount
  // ở đây không quan trọng. Xem routes/qr-login.ts + qr-login-service.ts.
  app.use(qrLoginRouter);
  // SIGMA PRESENCE realtime (6/8) — nhịp sống presence (/v1/presence/ping|offline), route-level requireSession
  // (KHÔNG router-level — đúng bug class B12), thứ tự mount không quan trọng (path /v1/presence/* không giao route
  // khác). Xem routes/presence.ts + presence-service.ts + chat-realtime-hub.ts agentPresenceOnline().
  app.use(presenceRouter);
  // 404 mặc định cho route không khớp (JSON, không HTML mặc định của Express).
  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Route không tồn tại.' });
  });
  app.use(errorHandler);

  return app;
}
