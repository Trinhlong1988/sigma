// SigMa — Express app factory (tách khỏi index.ts để test import được KHÔNG cần bind port thật, cùng
// khuôn apps/bot-api/src/app.ts). Deploy sau qua Cloudflare: alpha-quanly-api.example.com → localhost:PORT.
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { isAllowedOrigin, isAllowedWriteOrigin } from './cors-allowlist.js';
import { authRouter } from './routes/auth.js';
import { customerRouter } from './routes/customer.js';
import { investorsRouter } from './routes/investors.js';
import { investorRouter } from './routes/investor.js';
import { investorAdvanceRouter } from './routes/investor-advance.js';
import { industryRouter } from './routes/industry.js';
import { cashCategoryRouter } from './routes/cash-category.js';
import { settingsRouter } from './routes/settings.js';
import { statusOptionRouter } from './routes/status-option.js';
import { bankConfigRouter } from './routes/bank-config.js';
import { feeConfigRouter } from './routes/fee-config.js';
import { qrFeeConfigRouter } from './routes/qr-fee-config.js';
import { qrDigistoreRouter } from './routes/qr-digistore.js';
import { tidConfigRouter } from './routes/tid-config.js';
import { posSupplyRouter } from './routes/pos-supply.js';
import { warehouseRouter } from './routes/warehouse.js';
import { handoverRouter } from './routes/handover.js';
import { fundRouter } from './routes/fund.js';
import { tidSellFeeRouter } from './routes/tid-sell-fee.js';
import { roleRouter } from './routes/role.js';
import { userRouter } from './routes/user.js';
import { auditRouter } from './routes/audit.js';
import { dashboardRouter } from './routes/dashboard.js';
import { searchRouter } from './routes/search.js';
import { messageRouter } from './routes/message.js';
import { tidRouter } from './routes/tid.js';
import { transactionRouter } from './routes/transaction.js';
import { posRouter } from './routes/pos.js';
import { cashEntryRouter } from './routes/cash-entry.js';
import { depositRouter } from './routes/deposit.js';
import { deviceSaleRouter } from './routes/device-sale.js';
import { approvalRouter } from './routes/approval.js';
import { entityCancelRouter } from './routes/entity-cancel.js';
import { exportRequestRouter } from './routes/export-request.js';
import { trashRouter } from './routes/trash.js';
import { realtimeRouter } from './routes/realtime.js';
import { notificationRouter } from './routes/notification.js';
import { authExtrasRouter } from './routes/auth-extras.js';
import { dossierRouter } from './routes/dossier.js';
import { receiveAccountRouter } from './routes/receive-account.js';
import { billExplainRouter } from './routes/bill-explain.js';
import { importRouter } from './routes/import.js';
import { storageRouter } from './routes/storage.js';
import { healthScanRouter } from './routes/health.js';
import { backupRouter } from './routes/backup.js';
import { billManualRouter } from './routes/bill-manual.js';
import { kpiRouter } from './routes/kpi.js';
import { tienChoRouter } from './routes/tien-cho.js';

// AUDIT-VÁ #7 (LOW) — error-handler 4-tham-số ĐỨNG CUỐI chuỗi. Mọi next(err) từ asyncHandler() đổ về đây.
// KHÔNG lộ stack/chi tiết nội bộ (message Prisma/đường dẫn) ra response — chỉ log console phía server (R198:
// KHÔNG nuốt lỗi câm lặng, console.error LUÔN chạy). Nếu response đã ghi dở → return next(err) cho Express
// default handler tự đóng (tránh ERR_HTTP_HEADERS_SENT quay lại thành unhandled exception crash tiến trình).
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  // eslint-disable-next-line no-console
  console.error('[quanly-api] Lỗi không bắt được trong route handler:', err);
  if (res.headersSent) {
    next(err);
    return;
  }
  // AUDIT-VÁ #10 (LOW, E2E finding B132) — JSON hỏng ở body-parser (express.json) ném SyntaxError với
  // `type === 'entity.parse.failed'`. TRƯỚC: rơi vào generic 500 (lỗi hệ thống) — sai ngữ nghĩa (đây là lỗi
  // client gửi dữ liệu sai, không phải lỗi server). SAU: nhận diện tường minh → 400 BAD_JSON. Đặt TRƯỚC nhánh
  // 500 để không bị nuốt thành "lỗi hệ thống".
  const parseErr = err as { type?: string };
  // B6 (đối kháng 12/8) — body quá cỡ (>limit) → 413 (KHÔNG 500 hệ thống), đặt TRƯỚC nhánh 500.
  if (parseErr?.type === 'entity.too.large') {
    res.status(413).json({ ok: false, error: 'PAYLOAD_TOO_LARGE', message: 'Nội dung gửi lên quá lớn.' });
    return;
  }
  if ((err instanceof SyntaxError && 'body' in (err as object)) || parseErr?.type === 'entity.parse.failed') {
    res
      .status(400)
      .json({ ok: false, error: 'BAD_JSON', message: 'Dữ liệu gửi lên không hợp lệ (JSON sai định dạng).' });
    return;
  }
  res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: 'Đã xảy ra lỗi hệ thống, vui lòng thử lại sau.' });
}

// AUDIT-VÁ #8 (LOW, B132) — security headers thủ công (KHÔNG thêm dep helmet để tránh npm install). Áp cho MỌI
// response — kể cả route tải attachment stream bytes user (nosniff chặn MIME-sniffing → trình duyệt không đoán
// nhầm HTML/JS từ file người dùng tải lên). HSTS chỉ set khi kết nối HTTPS thật (req.secure phản ánh
// X-Forwarded-Proto nhờ trust proxy=1 — traffic chỉ qua Cloudflare tunnel HTTPS).
function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// AUDIT-VÁ #9 (MED CSRF, B132) — origin-reject cho request state-changing. CORS reflect-ACAO chỉ chặn ĐỌC phản
// hồi cross-site, KHÔNG chặn GHI: upload multipart (Content-Type simple → KHÔNG preflight) từ trang độc hại vẫn
// tới được handler và thực thi ghi (CSRF write). Middleware này chặn TẠI SERVER: nếu request MANG header Origin
// VÀ method là state-changing VÀ origin KHÔNG hợp lệ → 403. JSON đã an toàn nhờ preflight (Content-Type
// application/json = non-simple); middleware này phủ CẢ multipart lẫn mọi content-type simple tương lai.
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// CSRF-HARDEN (audit 20/8, API-4) — vector CÒN LẠI sau SEC-FIX 12/8: sandboxed-iframe gửi fetch application/json
// (Origin 'null', preflight-pass vì CORS vẫn reflect 'null') CÓ THỂ drive 1 mutation cho user bản WEB (không đọc
// được phản hồi nhưng ghi vẫn xảy ra). Đóng bằng header TÙY BIẾN bắt buộc: X-SigMa-Client (client preload/web set
// sẵn — xem preload/index.ts). Header non-simple buộc preflight + KHÔNG giả mạo được cross-site.
//
// ⚠️ GATED (mặc định TẮT) qua SIGMA_ENFORCE_CLIENT_HEADER=1. LÝ DO chưa bật cứng: (1) chỉ MỚI xác nhận 1 client
// write-path (desktop preload httpCall) gửi header; client WEB (nếu deploy) PHẢI được xác nhận gửi header TRƯỚC khi
// bật, nếu không MỌI ghi từ web sẽ vỡ. (2) Để đóng TRIỆT ĐỂ còn cần siết CORS: KHÔNG cấp preflight
// (Access-Control-Allow-Headers) cho Origin 'null'/foreign — nếu không, iframe có thể preflight rồi vẫn gửi header.
// => Bật là thao tác PHỐI HỢP: verify tất cả client gửi header + siết CORS preflight cho null. Xem báo cáo audit.
const ENFORCE_CLIENT_HEADER = process.env['SIGMA_ENFORCE_CLIENT_HEADER'] === '1';
function requireClientHeader(req: Request, res: Response, next: NextFunction): void {
  if (ENFORCE_CLIENT_HEADER && STATE_CHANGING.has(req.method) && req.headers['x-alpha-client'] !== '1') {
    res.status(403).json({ ok: false, error: 'FORBIDDEN_CLIENT', message: 'Yêu cầu thiếu định danh client hợp lệ.' });
    return;
  }
  next();
}

function rejectForeignOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  // SEC-FIX 12/8 — dùng isAllowedWriteOrigin (KHÔNG isAllowedOrigin) cho ĐƯỜNG GHI: Origin 'null' opaque chỉ
  // được qua nếu content-type buộc-preflight (application/json của bản desktop) — chặn null + content-type simple
  // (vector CSRF-ghi <form>/sandboxed-iframe không-preflight). Origin hợp lệ (domain thật/loopback) vẫn qua.
  if (typeof origin === 'string' && STATE_CHANGING.has(req.method) && !isAllowedWriteOrigin(origin, req.headers['content-type'])) {
    res.status(403).json({ ok: false, error: 'FORBIDDEN_ORIGIN', message: 'Nguồn gửi không hợp lệ.' });
    return;
  }
  next();
}

export function createApp(): Express {
  const app = express();
  // AUDIT-VÁ #8 (LOW, B132) — KHÔNG lộ Express qua header X-Powered-By (giảm fingerprint stack).
  app.disable('x-powered-by');
  // AUDIT-VÁ #2a — sau Cloudflare, IP thật nằm ở X-Forwarded-For. `trust proxy` = 1 (chỉ tin 1 hop proxy ngay
  // trước — Cloudflare/cloudflared) để req.ip + express-rate-limit key theo IP client THẬT, không phải IP proxy.
  // Dùng số 1 (KHÔNG `true` permissive) — express-rate-limit v8 cảnh báo/chặn cấu hình trust proxy quá rộng.
  app.set('trust proxy', 1);
  // AUDIT-VÁ #8 — security headers áp SỚM nhất (trước cả CORS/router) để MỌI response, kể cả 403/404 và stream
  // attachment, đều mang nosniff/X-Frame-Options/Referrer-Policy.
  app.use(securityHeaders);
  // AUDIT-VÁ #1 — CORS allowlist tường minh (isAllowedOrigin) thay reflect-all. Origin không hợp lệ → không
  // phản chiếu ACAO (trình duyệt tự chặn). credentials:true để cookie ql_session đi kèm (cross-site, xem #6).
  app.use(
    cors({
      origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
      credentials: true
    })
  );
  // AUDIT-VÁ #9 (MED CSRF) — chặn origin lạ cho request GHI NGAY SAU cors (để preflight OPTIONS vẫn do cors xử
  // lý), TRƯỚC body-parser/router (không phí công parse body của request đã bị từ chối).
  app.use(rejectForeignOrigin);
  // CSRF-HARDEN (audit 20/8) — bắt buộc header X-SigMa-Client cho đường GHI (GATED, mặc định TẮT — xem
  // requireClientHeader). Đặt ngay sau rejectForeignOrigin, trước body-parser.
  app.use(requireClientHeader);
  // FIX (audit 20/8) — HÒA GIẢI trần body vs trần dòng import. Route /v1/import/* nhận `rows` tới MAX_IMPORT_ROWS
  // (2000) — một payload 2000 dòng JSON VƯỢT 100kb → 413 TRƯỚC khi cap dòng chạy (cap không bao giờ tới được). Mount
  // parser JSON LỚN HƠN (8mb, đủ 2000 dòng của entity rộng nhất) RIÊNG cho /v1/import, ĐẶT TRƯỚC parser 100kb toàn
  // cục. express.json bỏ qua nếu req._body đã set → import parse 1 lần bằng 8mb, request khác vẫn kẹp 100kb. Trần
  // dòng thật do service (MAX_IMPORT_ROWS) giữ; 8mb chỉ để 2000 dòng hợp lệ không bị 413 oan.
  app.use('/v1/import', express.json({ limit: '8mb' }));
  // AUDIT-VÁ #10 (LOW) — giới hạn kích thước JSON body 100kb (chống payload phình bộ nhớ). Body vượt hạn ném
  // 'entity.too.large'; JSON sai cú pháp ném 'entity.parse.failed' → errorHandler map sang 400 BAD_JSON.
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // [Admin Demo 10/9 — bản clone SigMa TN] /health NÓI RÕ ĐANG NỐI DB NÀO (chỉ TÊN database, không lộ user/mật khẩu).
  // Lý do: dựng bản clone "trắng" mà API lỡ nối DB production thì nhìn bề ngoài y hệt — phải soi được bằng 1 lệnh.
  app.get('/v1/health', (req, res) => {
    let db = '';
    try { db = new URL(process.env['DATABASE_URL'] ?? '').pathname.replace(/^\//, ''); } catch { db = ''; }
    // [Bảo mật 7/11] TÊN DATABASE chỉ trả cho CLIENT CỦA NHÀ (desktop + bản web đều gửi `X-SigMa-Client`)
    // hoặc gọi từ chính máy chủ. Người lạ trên Internet gọi /v1/health chỉ thấy "sống hay chết", KHÔNG biết
    // đang nối DB nào — trước đây lộ thẳng tên `sigma` mà không cần đăng nhập.
    // VẪN GIỮ tên DB cho client nhà vì badge nguồn ở MÀN ĐĂNG NHẬP phải hiện đúng DB (luật Admin Demo 11/8:
    // dựng bản clone mà API lỡ nối DB thật thì nhìn bề ngoài y hệt — phải soi được bằng 1 lệnh).
    // CẨN THẬN: KHÔNG được miễn trừ theo "gọi từ loopback". Lưu lượng Internet đi qua cloudflared cũng
    // tới máy chủ từ 127.0.0.1 ⇒ miễn trừ loopback là lộ tên DB cho đúng người lạ mình muốn chặn.
    // Chỉ dựa vào header của client nhà. Đây là cổng NHẸ: chặn dò tình cờ, KHÔNG chặn được kẻ cố ý
    // (ai cũng tự đặt header được) — phần gác thật là Cloudflare Access, nằm ở kế hoạch riêng.
    const laClientNha = typeof req.headers['x-alpha-client'] === 'string' && req.headers['x-alpha-client'] !== '';
    res.json({ ok: true, service: 'quanly-api', db: laClientNha ? db : '' });
  });
  app.use(authRouter);
  app.use(billManualRouter); // nhập bill lẻ thủ công — màn Doanh Số
  app.use(kpiRouter); // KPI Doanh Số (tab full-view màn Doanh Số)
  app.use(tienChoRouter); // Doanh số tiền chờ / công nợ phải thu ỦY QUYỀN (nhập tổng/tháng + báo cáo)
  app.use(customerRouter);
  app.use(investorsRouter);
  app.use(investorRouter);
  app.use(investorAdvanceRouter);
  app.use(industryRouter);
  app.use(cashCategoryRouter);
  app.use(settingsRouter);
  app.use(statusOptionRouter);
  app.use(bankConfigRouter);
  app.use(feeConfigRouter);
  app.use(qrFeeConfigRouter);
  app.use(qrDigistoreRouter);
  app.use(tidConfigRouter);
  app.use(posSupplyRouter);
  app.use(warehouseRouter);
  app.use(handoverRouter);
  app.use(fundRouter);
  app.use(tidSellFeeRouter);
  app.use(roleRouter);
  app.use(userRouter);
  app.use(auditRouter);
  app.use(dashboardRouter);
  app.use(searchRouter);
  app.use(messageRouter);
  app.use(tidRouter);
  app.use(transactionRouter);
  app.use(posRouter);
  app.use(cashEntryRouter);
  app.use(depositRouter);
  app.use(deviceSaleRouter);
  app.use(approvalRouter);
  app.use(entityCancelRouter);
  app.use(exportRequestRouter);
  app.use(trashRouter);
  app.use(realtimeRouter);
  app.use(notificationRouter);
  app.use(authExtrasRouter);
  app.use(dossierRouter);
  app.use(receiveAccountRouter);
  app.use(billExplainRouter);
  app.use(importRouter);
  app.use(storageRouter);
  app.use(healthScanRouter);
  app.use(backupRouter);

  app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Route không tồn tại.' }));
  app.use(errorHandler);

  return app;
}
