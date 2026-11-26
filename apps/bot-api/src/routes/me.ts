// SIGMA Phase 3 (24/7) — 4 endpoint nghiệp vụ SigMa (TID/quote/Lô/QR) dùng RC-auth MỚI (`requireSession`),
// SONG SONG route Bearer cũ (routes/agents.ts + routes/lo.ts, :agentCode trong URL — GIỮ NGUYÊN, KHÔNG đụng,
// tương thích ngược cho caller cũ + không phá test B1-B8 hiện có). Route ở đây KHÔNG có :agentCode trong URL
// vì "đại lý" = CHÍNH người đang gọi — agentId lấy TỪ req.agent!.id (đã xác thực Rocket.Chat + map Agent
// trong middleware requireSession, xem rc-auth-middleware.ts). Đây chính là bước "nối SellTidModal vào bot-api
// với RC-auth mới" theo kế hoạch mục D.3 (curried-plotting-hippo.md).
//
// TÁI DÙNG NGUYÊN business logic đã có (findAliveAgentByCode kiểu tương đương đã nằm trong requireSession,
// listAgentTidsWithCardTypeOptions/buildAgentQrResult từ agents.ts, quoteRows từ fee-quote.ts, createLo từ
// lo-service.ts) — file này CHỈ là wrapper route, KHÔNG cài lại công thức/quy tắc nào.
import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireSession } from '../session-middleware.js';
import { getBotDb } from '../db.js';
import { listWebSessionsForAgent, revokeWebSessionByIdForAgent, revokeOtherWebSessionsForAgent, describeDevice, WEB_SESSION_COOKIE_NAME } from '../web-session-service.js';
import { broadcastToAgent } from '../chat-realtime-hub.js';
import { listAgentTidsWithCardTypeOptions, buildAgentQrResult, type TidWithCardTypeOptions } from './agents.js';
import { quoteRows, previewSellFeeForTid, tidCardOptionsForBill, type QuoteRowInput } from '../fee-quote.js';
import { detectCardFromOcr } from '../card-classify.js';
import { createLo, createLoFromBillTid, buildBillKey, reconcileLo, type ReconcileBody } from '../lo-service.js';
import { asyncHandler } from '../async-handler.js';
import { createHash } from 'node:crypto';
import {
  acceptFriendRequest,
  blockFriend,
  listFriends,
  lookupAgentByCode,
  lookupAgentByEmailOrPhone,
  rejectFriendRequest,
  sendFriendRequest,
  setFriendCategory,
  setFriendNickname,
  unblockFriend,
  unfriend,
  type FriendCategory
} from '../friend-service.js';
import { computeDeletionDeadline } from '../deletion-service.js';
import { parseSingleFileUpload } from '../multipart-upload.js';
import { callOcrService, buildBillPreview, buildBillPreviewMultiScale, buildRefundReceiptPreview, callSonnetOcr, sonnetTransferToRefundPreview, sonnetBillToBillPreview, sonnetCardDetection, type OcrBillPreview, type RefundReceiptPreview } from '../ocr-bridge.js';
import { matchRefundRecipient, computeRefundAggregate, listRefundConfirmationsForMessage } from '../refund-service.js';
import { checkRefundDuplicateForAgent } from '../refund-dedup.js';
import { ChatServiceError } from '../services/chat-room-service.js';
import { getAgentMedia, getAgentDisplayName, saveAgentMedia, MAX_AGENT_MEDIA_SIZE_BYTES, type AgentMediaKind } from '../agent-media-service.js';
import { renderFallbackAvatarPng } from '../fallback-avatar.js';
import { listMyNotifications, markAllNotificationsRead, notifyFriendsOfMediaUpdate } from '../notification-service.js';
import { assignRoomCategory, createCategory, deleteCategory, listCategories, updateCategory } from '../chat-category-service.js';
import { createOtpChallenge, verifyOtpChallenge, finalizeOtpChallenge, releaseOtpChallenge } from '../otp-service.js';
import { sendOtpEmail, OtpSmtpNotConfiguredError } from '../email-service.js';
import { verifyPasswordHash } from '../password-service.js';
import { sendOtpSms, EsmsNotConfiguredError } from '../esms-service.js';
import {
  getMyProfile,
  updateMyProfile,
  validateNewEmailFormat,
  isEmailTakenByOtherAgent,
  applyEmailChange,
  validateNewPhoneFormat,
  applyPhoneChange
} from '../services/profile-service.js';
import { DriveBackupError, encryptRefreshToken, exchangeAuthorizationCode, runAgentDriveBackup } from '../drive-backup-service.js';

export const meRouter = Router();
// B12 (24/7, phát hiện NGAY khi viết test cho chính router này) — KHÔNG dùng `meRouter.use(requireSession)`
// (blanket, không path): vì meRouter mount ở app.ts bằng `app.use(meRouter)` (không prefix), 1 middleware gắn
// kiểu router-level sẽ chạy cho MỌI request lọt vào router theo THỨ TỰ mount — kể cả path không khớp route
// nào của meRouter (chặn nhầm những request lẽ ra phải rơi xuống router/404-handler PHÍA SAU). Gắn
// requireSession TRỰC TIẾP vào TỪNG route bên dưới (route-level middleware) — CÙNG pattern an toàn routes/kpi.ts
// đã dùng (`kpiRouter.get(path, asyncHandler(requireSession), handler)`). Xem BUGS_FIXED.md B12 (cùng gốc bug
// với agentsRouter.use/loRouter.use đã sửa trong đợt này).
//
// requireSession cũng async (gọi rcGetMe + db.agent.findFirst) — bọc asyncHandler() để lỗi bên trong middleware
// (vd Rocket.Chat network down) đi đúng đường next(err) → errorHandler tập trung (app.ts), CÙNG cách
// routes/auth.ts GET /v1/auth/me đã làm.

// GET /v1/me/tids — TID còn sống của ĐÚNG đại lý đang đăng nhập (agentId từ req.agent, KHÔNG nhận tham số
// URL nào khác — loại bỏ hẳn khả năng 1 đại lý xem nhầm/dò TID của đại lý khác qua đổi :agentCode, khác với
// route Bearer cũ vốn tin agentCode client tự truyền).
meRouter.get('/v1/me/tids', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  res.json(await listAgentTidsWithCardTypeOptions(db, req.agent!.id));
}));

interface QuoteRequestBody {
  rows?: QuoteRowInput[];
}

// POST /v1/me/quote — báo giá phí bán cho danh sách dòng, CÙNG shape request/response route Bearer cũ
// (/v1/agents/:agentCode/quote). quoteRows (fee-quote.ts) đã tự chặn tidId không thuộc agentId gọi
// (TID_NOT_IN_AGENT_SCOPE) — ranh giới bảo mật GIỮ NGUYÊN, chỉ đổi nguồn agentId (từ token RC, không phải
// URL client tự khai).
meRouter.post('/v1/me/quote', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const body = req.body as QuoteRequestBody;
  if (!body || !Array.isArray(body.rows) || body.rows.length === 0) {
    res.status(400).json({ error: 'VALIDATION', message: 'rows phải là mảng khác rỗng.' });
    return;
  }
  const r = await quoteRows(db, req.agent!.id, body.rows);
  if (!r.ok) {
    // ABORT toàn phiếu nếu 1 dòng sai (khớp quy ước /v1/agents/:agentCode/quote).
    res.status(400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

// GET /v1/me/fee-preview?tid=<chuỗi>&amount=<số> — B107-tiếp (2/8): xem trước "Hoàn tiền sau phí" cho bảng
// kết quả quét OCR bill, TRƯỚC KHI tạo Lô thật (KHÁC /v1/me/quote — route đó cần tidId THẬT + báo lỗi rõ
// ràng khi thiếu cấu hình, đúng cho luồng tạo Lô; route NÀY nhận TID dạng chuỗi từ OCR, KHÔNG BAO GIỜ lỗi vì
// thiếu cấu hình — mặc định 0%, xem previewSellFeeForTid() fee-quote.ts).
meRouter.get('/v1/me/fee-preview', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const tid = typeof req.query.tid === 'string' ? req.query.tid : '';
  const amount = Number(req.query.amount);
  // cardTypeId TÙY CHỌN (Admin Demo 21/8) — ô "Loại thẻ" trên bill. Bỏ trống → mặc định Visa-Master (INTERNATIONAL).
  const cardTypeIdRaw = typeof req.query.cardTypeId === 'string' ? Number(req.query.cardTypeId) : NaN;
  const cardTypeId = Number.isInteger(cardTypeIdRaw) && cardTypeIdRaw > 0 ? cardTypeIdRaw : undefined;
  const r = await previewSellFeeForTid(db, req.agent!.id, tid, amount, cardTypeId);
  if (!r.ok) {
    res.status(400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

// GET /v1/me/tid-card-options?tid=<chuỗi>&scheme=<INTERNATIONAL|DOMESTIC>&bin=<6 số> — Admin Demo 21/8 ("thêm tùy
// chọn thẻ kèm giá bán"): danh sách LOẠI THẺ của TID + GIÁ BÁN thực tế mỗi thẻ + thẻ MẶC ĐỊNH (Visa-Master) +
// thẻ NHẬN DIỆN từ bill (scheme/bin do client lấy từ ocr-preview truyền vào). KHÔNG lỗi vì thiếu cấu hình (TID
// ngoài scope/không tồn tại → rỗng), CÙNG triết lý /fee-preview.
meRouter.get('/v1/me/tid-card-options', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const tid = typeof req.query.tid === 'string' ? req.query.tid : '';
  const schemeRaw = typeof req.query.scheme === 'string' ? req.query.scheme.toUpperCase() : '';
  const scheme = schemeRaw === 'INTERNATIONAL' || schemeRaw === 'DOMESTIC' ? (schemeRaw as 'INTERNATIONAL' | 'DOMESTIC') : null;
  const bin = typeof req.query.bin === 'string' && /^\d{6}$/.test(req.query.bin) ? req.query.bin : null;
  const detection = scheme || bin ? { scheme, bin6: bin } : undefined;
  const r = await tidCardOptionsForBill(db, req.agent!.id, tid, detection);
  res.json(r);
}));

interface CreateLoRequestBody {
  rows?: QuoteRowInput[];
}

// POST /v1/me/lo — tạo Lô (PENDING) thật, CÙNG shape request route Bearer cũ (/v1/agents/:agentCode/lo).
// createLo (lo-service.ts) gọi lại quoteRow cho từng dòng nội bộ — KHÔNG tính hai lần/lệch công thức với
// bước quote ở trên (route riêng, client tự gọi /quote xem trước rồi /lo xác nhận, giống UX SellTidModal).
meRouter.post('/v1/me/lo', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const body = req.body as CreateLoRequestBody;
  if (!body || !Array.isArray(body.rows) || body.rows.length === 0) {
    res.status(400).json({ error: 'VALIDATION', message: 'rows phải là mảng khác rỗng.' });
    return;
  }
  const r = await createLo(db, req.agent!.id, body.rows);
  if (!r.ok) {
    res.status(400).json({ error: r.error, message: r.message });
    return;
  }
  res.status(201).json(r.data);
}));

// POST /v1/me/lo/from-bill — NỐI BILL → DOANH SỐ (Admin Demo 21/8): khi đại lý gửi bill trong nhóm chat có TID
// khớp + số tiền + loại thẻ đã chọn → tạo Lô 1-dòng ghi doanh số ngay (createLoFromBillTid). NO_ACTUAL_SELL_FEE
// (TID chưa cấu hình giá bán) → 409 (bill vẫn gửi, chỉ chưa ghi doanh số — client báo đại lý đi set giá).
meRouter.post('/v1/me/lo/from-bill', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const body = (req.body ?? {}) as {
    tid?: string;
    cardTypeId?: number;
    amountBeforeFee?: number;
    batchNumber?: string | null;
    invoiceNumber?: string | null;
    billImageHash?: string | null;
    allowDuplicate?: boolean;
  };
  const cardTypeId = Number.isInteger(body.cardTypeId) && (body.cardTypeId as number) > 0 ? body.cardTypeId : undefined;
  const tidStr = typeof body.tid === 'string' ? body.tid : '';
  // KHÓA BILL nhiều tầng (KHÔNG gồm số tiền) → gửi-lại/SỬA cùng bill = UPSERT cùng Lô (chống Lô trùng + cập nhật):
  // tầng 1 số lô/số HĐ, tầng 2 hash ảnh (billImageHash do /ocr-preview trả về, không phụ thuộc OCR). Thiếu cả 2 →
  // null → service dò "nghi trùng" cùng tid+tiền+ngày (tầng 3, DUP_SUSPECT) để đại lý xác nhận trước khi ghi thêm.
  const billKey = tidStr
    ? buildBillKey({ tid: tidStr, batchNumber: body.batchNumber ?? null, invoiceNumber: body.invoiceNumber ?? null, imageHash: body.billImageHash ?? null })
    : null;
  const r = await createLoFromBillTid(db, req.agent!.id, {
    tidString: tidStr,
    cardTypeId,
    amountBeforeFee: Number(body.amountBeforeFee),
    billKey,
    allowDuplicate: body.allowDuplicate === true
  });
  if (!r.ok) {
    // DUP_SUSPECT (409): trả kèm loId + thời điểm Lô nghi trùng để client cảnh báo đại lý (bấm xác nhận → gọi lại
    // allowDuplicate=true). NO_ACTUAL_SELL_FEE cũng 409 (TID chưa set giá). Còn lại 400.
    if (r.error === 'DUP_SUSPECT') {
      res.status(409).json({ error: r.error, message: r.message, existingLoId: r.existingLoId, existingAt: r.existingAt });
      return;
    }
    res.status(r.error === 'NO_ACTUAL_SELL_FEE' ? 409 : 400).json({ error: r.error, message: r.message });
    return;
  }
  res.status(201).json(r.data);
}));

// GET /v1/me/qr — QR nhận tiền của đại lý đang đăng nhập. req.agent (từ middleware) CHỈ mang id/code/name/
// rcUserId/rcUsername (AuthenticatedAgent, xem rc-auth-middleware.ts) — KHÔNG có qrImage/qrImageMime/... nên
// phải truy lại DB 1 lần theo id để lấy đủ cột QR, rồi tái dùng buildAgentQrResult (agents.ts) — KHÔNG cài
// lại điều kiện "qrImage rỗng → 501" lần 2.
meRouter.get('/v1/me/qr', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const agent = await db.agent.findUnique({ where: { id: req.agent!.id } });
  // req.agent đã qua requireSession (agent còn sống lúc middleware chạy) — nhưng phòng trường hợp hiếm agent
  // bị xóa mềm NGAY GIỮA request (race), kiểm null tường minh thay vì `!` để không crash truy cập field sau.
  if (!agent) {
    res.status(404).json({ error: 'AGENT_NOT_FOUND', message: 'Đại lý không tồn tại.' });
    return;
  }
  const r = buildAgentQrResult(agent);
  if (!r.ok) {
    res.status(501).json({ error: 'QR_NOT_CONFIGURED_YET' });
    return;
  }
  res.json(r.data);
}));

// ── Avatar + ảnh bìa (1/8, mục 39 mở rộng — "Hồ sơ của tôi", thay Phase 0 mock đổi màu/gradient cục bộ ở
// ProfileScreen.tsx). Business logic (validate cỡ/magic-bytes + đọc/ghi cột BLOB) sống trong
// agent-media-service.ts, route ở đây CHỈ wrap HTTP (CÙNG khuôn "Kết bạn"/"Phân loại nhóm chat" phía dưới).
//
// GET đọc THEO :id TRONG URL (KHÔNG theo req.agent!.id của người gọi) — khác hẳn mọi route /v1/me/* còn lại
// trong file này: avatar/ảnh bìa PHẢI xem được bởi NGƯỜI KHÁC (bạn bè/thành viên nhóm chat), không chỉ chủ sở
// hữu, giống hệt cách qrImage KHÔNG hoạt động (GET /v1/me/qr chỉ CHÍNH MÌNH xem — đó là QR NHẬN TIỀN, thông
// tin nhạy cảm). Avatar/bìa là thông tin công khai trong app này giống các trường name/code đã public sẵn ở
// route lookup (GET /v1/me/friends/lookup) — vẫn gate `requireSession` để chặn truy cập ẩn danh hoàn toàn,
// KHÔNG thêm kiểm tra bạn-bè/thành-viên-nhóm nào khác (spec rõ ràng không cần, đúng CẤM SUY LUẬN thêm ràng
// buộc ngoài yêu cầu).
// PERF (Admin Demo 15/8 "vào cài đặt avatar giựt + load danh sách chat chậm") — GỐC: URL avatar đã kèm
// `?v=avatarUpdatedAt` (đổi ảnh ⇒ ?v mới ⇒ URL mới) nên nội dung MỖI URL là BẤT BIẾN, nhưng server ép
// `max-age=0, must-revalidate` → trình duyệt tải LẠI avatar mỗi lần vào danh sách chat/cài đặt (N ảnh × round-trip
// qua tunnel = chậm + giựt). FIX: có ?v → `immutable` cache DÀI (trình duyệt khỏi tải lại; ảnh đổi vẫn hiện ngay
// nhờ ?v mới). KHÔNG ?v (caller cũ chưa gắn version) → giữ must-revalidate (an toàn, không phục vụ ảnh cũ). `private`
// = không để CDN/proxy dùng chung (avatar gate session).
function cacheControlForMedia(versioned: boolean): string {
  return versioned ? 'private, max-age=604800, immutable' : 'private, max-age=0, must-revalidate';
}
function isVersionedReq(req: Request): boolean {
  const v = req.query['v'];
  return typeof v === 'string' && v !== '';
}
function agentMediaContentTypeHeader(res: Response, mimeType: string, versioned: boolean): void {
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', cacheControlForMedia(versioned));
}

async function handleUploadAgentMedia(req: Request, res: Response, kind: AgentMediaKind): Promise<void> {
  const parsed = await parseSingleFileUpload(req);
  if (!parsed.ok) {
    if (parsed.reason === 'TOO_LARGE') {
      res.status(413).json({ error: 'FILE_TOO_LARGE', message: `Ảnh vượt quá giới hạn ${MAX_AGENT_MEDIA_SIZE_BYTES / (1024 * 1024)}MB.` });
      return;
    }
    res.status(400).json({ error: 'NO_FILE', message: 'Thiếu ảnh trong yêu cầu.' });
    return;
  }

  const db = getBotDb();
  const r = await saveAgentMedia(db, req.agent!.id, kind, parsed.buffer);
  if (!r.ok) {
    if (r.reason === 'FILE_TOO_LARGE') {
      res.status(413).json({ error: 'FILE_TOO_LARGE', message: `Ảnh vượt quá giới hạn ${MAX_AGENT_MEDIA_SIZE_BYTES / (1024 * 1024)}MB.` });
      return;
    }
    if (r.reason === 'EMPTY_FILE') {
      res.status(400).json({ error: 'EMPTY_FILE', message: 'Ảnh rỗng, vui lòng chọn ảnh khác.' });
      return;
    }
    res.status(400).json({ error: 'MIME_NOT_ALLOWED', message: 'Ảnh không đúng định dạng jpeg/png/webp — vui lòng chọn ảnh khác.' });
    return;
  }
  // B113 (2/8, Admin Demo yêu cầu trực tiếp "bạn bè phải có thông báo khi đổi avatar") — gọi SAU khi ảnh đã lưu
  // THÀNH CÔNG (r.ok true ở trên). `await` trực tiếp — notifyFriendsOfMediaUpdate() TỰ bọc try/catch nội bộ,
  // KHÔNG BAO GIỜ throw (xem docstring notification-service.ts), nên await ở đây an toàn, không cần fire-and-
  // forget. Ghi thông báo là INSERT nhanh (createMany 1 lần, tối đa 2000 hàng theo FRIEND_LIMIT friend-
  // service.ts) — không đáng lo timeout.
  await notifyFriendsOfMediaUpdate(db, req.agent!.id, kind);
  res.json({ ok: true });
}

async function handleReadAgentMedia(req: Request, res: Response, kind: AgentMediaKind): Promise<void> {
  const agentId = Number(req.params.id);
  if (!Number.isInteger(agentId)) {
    res.status(400).json({ error: 'VALIDATION', message: 'id phải là số nguyên.' });
    return;
  }
  const db = getBotDb();
  const media = await getAgentMedia(db, agentId, kind);
  if (!media) {
    // AVATAR chưa đặt → trả PNG fallback (màu + chữ cái đầu theo agentId, KHỚP web avatar-color.ts) THAY VÌ 404,
    // để MỌI nền (web/Android largeIcon/popup EXE) hiển thị CÙNG 1 avatar (Admin Demo 8/8 "avatar phải đồng nhất").
    // COVER (ảnh bìa) KHÔNG có khái niệm fallback → giữ 404 như cũ.
    if (kind === 'avatar') {
      const name = await getAgentDisplayName(db, agentId);
      const png = await renderFallbackAvatarPng(String(agentId), agentId, name ?? '');
      res.setHeader('Content-Type', 'image/png');
      // Fallback đổi khi agent upload ảnh THẬT → ?v=avatarUpdatedAt đổi ⇒ URL mới. Có ?v → cache DÀI immutable
      // (khỏi render PNG lại mỗi 5 phút/agent — CPU + round-trip); không ?v → cache ngắn an toàn.
      res.setHeader('Cache-Control', isVersionedReq(req) ? cacheControlForMedia(true) : 'private, max-age=300');
      res.send(png);
      return;
    }
    res.status(404).json({ error: 'NOT_FOUND', message: 'Đại lý chưa có ảnh bìa.' });
    return;
  }
  agentMediaContentTypeHeader(res, media.mimeType, isVersionedReq(req));
  res.send(media.buffer);
}

// POST /v1/me/avatar — multipart field "file". Ghi avatarImage/avatarImageMime/avatarUpdatedAt của đại lý
// đang đăng nhập (req.agent!.id — KHÔNG bao giờ nhận agentId từ body/URL client tự khai, đúng ranh giới bảo
// mật chung của meRouter).
meRouter.post('/v1/me/avatar', asyncHandler(requireSession), asyncHandler((req, res) => handleUploadAgentMedia(req, res, 'avatar')));

// GET /v1/agents/:id/avatar — avatar CỦA BẤT KỲ agent nào (xem comment khối trên cho lý do :id thay vì /me).
meRouter.get('/v1/agents/:id/avatar', asyncHandler(requireSession), asyncHandler((req, res) => handleReadAgentMedia(req, res, 'avatar')));

// POST /v1/me/cover — TƯƠNG TỰ /v1/me/avatar, ghi coverImage/coverImageMime/coverUpdatedAt.
meRouter.post('/v1/me/cover', asyncHandler(requireSession), asyncHandler((req, res) => handleUploadAgentMedia(req, res, 'cover')));

// GET /v1/agents/:id/cover — TƯƠNG TỰ /v1/agents/:id/avatar.
meRouter.get('/v1/agents/:id/cover', asyncHandler(requireSession), asyncHandler((req, res) => handleReadAgentMedia(req, res, 'cover')));

// ── Thông báo trong-app (B113, 2/8, Admin Demo yêu cầu trực tiếp) — chuông NotificationBell.tsx (TopBar) đã có
// SẴN cho lễ/Tết + sinh nhật bạn bè (tính toán thuần client-side) — 2 route dưới đây NỐI THÊM nguồn thứ 3
// (đổi avatar/cover của bạn bè, LƯU server-side qua model AgentNotification). Xem notification-service.ts cho
// business logic đầy đủ, ở đây CHỈ wrap HTTP (cùng khuôn mọi route khác trong file này).
meRouter.get(
  '/v1/me/notifications',
  asyncHandler(requireSession),
  asyncHandler(async (req: Request, res: Response) => {
    const db = getBotDb();
    const result = await listMyNotifications(db, req.agent!.id);
    res.json(result);
  })
);

meRouter.post(
  '/v1/me/notifications/mark-read',
  asyncHandler(requireSession),
  asyncHandler(async (req: Request, res: Response) => {
    const db = getBotDb();
    const result = await markAllNotificationsRead(db, req.agent!.id);
    res.json({ ok: true, ...result });
  })
);

// ── Xóa tài khoản, 48h ân hạn (25/7, Admin Demo yêu cầu nguyên văn) ────────────────────────────────────────
// 3 endpoint: request-deletion (bắt đầu đếm 48h) / cancel-deletion (hủy, còn trong 48h) / deletion-status
// (đọc trạng thái hiện tại — dùng khi mở lại màn "Tài khoản & bảo mật", không phụ thuộc lúc request mới trả
// về). Việc THỰC SỰ xóa (soft-delete + rcDeleteUser) KHÔNG nằm ở đây — xảy ra LAZY ở requireSession
// (rc-auth-middleware.ts) khi Agent cố đăng nhập tiếp SAU khi đã quá 48h, xem deletion-service.ts cho lý do
// thiết kế đầy đủ (không có cron trong dự án).

interface DeletionStatusDto {
  deletionRequestedAt: string | null;
  deleteAt: string | null;
}

function toDeletionStatusDto(deletionRequestedAt: Date | null): DeletionStatusDto {
  if (!deletionRequestedAt) return { deletionRequestedAt: null, deleteAt: null };
  return {
    deletionRequestedAt: deletionRequestedAt.toISOString(),
    deleteAt: computeDeletionDeadline(deletionRequestedAt).toISOString()
  };
}

// GET /v1/me/deletion-status — trạng thái yêu cầu xóa hiện tại của đại lý đang đăng nhập (null/null nếu
// không có yêu cầu nào đang treo). Tách riêng khỏi GET /v1/auth/me (AuthenticatedAgent, rc-auth-middleware.ts)
// vì field này KHÔNG thuộc shape đó — thêm vào đó sẽ phải sửa type dùng chung cho MỌI route RC-auth, trong
// khi chỉ màn "Tài khoản & bảo mật" cần đọc field này.
meRouter.get('/v1/me/deletion-status', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const agent = await db.agent.findUnique({ where: { id: req.agent!.id } });
  if (!agent) {
    res.status(404).json({ error: 'AGENT_NOT_FOUND', message: 'Đại lý không tồn tại.' });
    return;
  }
  res.json(toDeletionStatusDto(agent.deletionRequestedAt));
}));

// ── BẢO MẬT (Admin Demo 6/8) — xóa tài khoản PHẢI qua 2 bước xác thực: mật khẩu + OTP email + mã xác nhận 2 số.
// TRƯỚC ĐÂY: POST /v1/me/request-deletion CHỈ requireSession là set deletionRequestedAt NGAY (không mật khẩu,
// không OTP) — bấm nhầm/double-click 1 cái là tài khoản vào diện xóa 48h. NAY luồng đó bị KHOÁ (trả 410), thay
// bằng 2 endpoint dưới. GIỮ NGUYÊN cancel-deletion/deletion-status (hủy/đọc trạng thái không nhạy cảm như
// hành-động-xóa nên không cần xác thực thêm — hủy chỉ đưa tài khoản về bình thường, an toàn hơn).
const ACCOUNT_DELETION_PURPOSE = 'ACCOUNT_DELETION';

// Rate-limit gửi OTP xóa tài khoản — CÙNG khuôn ocrPreviewLimiter/friendLookupLimiter (key theo agentId, KHÔNG
// theo IP: agent đã đăng nhập mới gọi được, nhiều đại lý chung NAT/mạng công ty làm IP vô nghĩa). 5 lần/giờ:
// đủ cho luồng thật (nhập mật khẩu → nhận mã), đồng thời chặn brute-force mật khẩu qua bước này (mỗi lần gửi
// buộc verify mật khẩu trong handler nên sai-mật-khẩu cũng tiêu 1 slot).
const deletionOtpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.agent?.id ?? 'unknown'),
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu mã xóa tài khoản, vui lòng thử lại sau.' }
});

// CÙNG khuôn emailChangeOtpOutcomeMessage()/phoneChangeOtpOutcomeMessage() — duplicate 1 switch nhỏ chấp nhận được.
function deletionOtpOutcomeMessage(outcome: 'EXPIRED' | 'WRONG_CODE' | 'TOO_MANY_ATTEMPTS' | 'NOT_FOUND' | 'IN_PROGRESS'): string {
  switch (outcome) {
    case 'EXPIRED':
      return 'Mã OTP đã hết hạn, vui lòng yêu cầu mã mới.';
    case 'WRONG_CODE':
      return 'Mã OTP không đúng.';
    case 'TOO_MANY_ATTEMPTS':
      return 'Đã nhập sai quá số lần cho phép, vui lòng yêu cầu mã mới.';
    case 'NOT_FOUND':
      return 'Không tìm thấy yêu cầu xóa tài khoản, vui lòng yêu cầu mã mới.';
    case 'IN_PROGRESS':
      return 'Yêu cầu xóa với mã này đang được xử lý, vui lòng thử lại sau vài giây.';
  }
}

// POST /v1/me/request-deletion — LUỒNG CŨ 1-BƯỚC (KHÔNG xác thực) ĐÃ BỊ KHOÁ. Giữ endpoint lại CHỈ để trả 410
// tường minh cho client cũ còn gọi — KHÔNG còn set deletionRequestedAt, đóng hoàn toàn đường xóa không xác thực.
meRouter.post('/v1/me/request-deletion', asyncHandler(requireSession), asyncHandler(async (_req, res) => {
  res.status(410).json({
    error: 'DELETION_FLOW_CHANGED',
    message: 'Luồng xóa tài khoản đã đổi: cần xác thực mật khẩu + OTP. Vui lòng cập nhật ứng dụng và thử lại.'
  });
}));

interface RequestDeletionSendOtpBody {
  password?: string;
}

// POST /v1/me/request-deletion/send-otp — BƯỚC 1: {password} → verify mật khẩu CỦA CHÍNH agent (sai → 401) →
// nếu tài khoản không có email thì 400 (cần email để nhận OTP) → tạo challenge OTP purpose=ACCOUNT_DELETION gửi
// tới EMAIL tài khoản. CHƯA set deletionRequestedAt (chỉ gửi mã). CÙNG khuôn email-change/phone OTP request.
meRouter.post(
  '/v1/me/request-deletion/send-otp',
  asyncHandler(requireSession),
  deletionOtpLimiter,
  asyncHandler(async (req, res) => {
    const body = req.body as RequestDeletionSendOtpBody;
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!password) {
      res.status(400).json({ error: 'VALIDATION', message: 'Thiếu mật khẩu.' });
      return;
    }
    const db = getBotDb();
    const agent = await db.agent.findUnique({ where: { id: req.agent!.id } });
    if (!agent) {
      res.status(404).json({ error: 'AGENT_NOT_FOUND', message: 'Đại lý không tồn tại.' });
      return;
    }
    const passwordOk = await verifyPasswordHash(password, agent.passwordHash);
    if (!passwordOk) {
      res.status(401).json({ error: 'WRONG_PASSWORD', message: 'Mật khẩu không đúng.' });
      return;
    }
    const email = typeof agent.email === 'string' ? agent.email.trim() : '';
    if (!email) {
      res.status(400).json({ error: 'NO_EMAIL', message: 'Tài khoản chưa có email — cần email để xác thực xóa tài khoản.' });
      return;
    }
    const challenge = await createOtpChallenge(db, email, ACCOUNT_DELETION_PURPOSE);
    try {
      await sendOtpEmail(email, challenge.code);
    } catch (err) {
      if (err instanceof OtpSmtpNotConfiguredError) {
        res.status(500).json({ error: 'OTP_SMTP_NOT_CONFIGURED', message: err.message });
        return;
      }
      res.status(500).json({ error: 'OTP_SEND_FAILED', message: 'Gửi email mã xác thực thất bại, vui lòng thử lại sau.' });
      return;
    }
    res.json({ ok: true });
  })
);

interface RequestDeletionConfirmBody {
  code?: string;
  confirmNumber?: string;
}

// POST /v1/me/request-deletion/confirm — BƯỚC 2: {code, confirmNumber} → verify OTP (đã gửi tới email ở bước 1,
// chỉ có được sau khi mật khẩu ĐÚNG) → sai OTP 400 (429 nếu quá số lần) → set deletionRequestedAt (GIỮ idempotent
// 48h cũ: không reset mốc gốc nếu đã có yêu cầu treo). `confirmNumber` = mã 2 số hiển thị ngẫu nhiên trên FE
// ("Nhập số 47 để xác nhận xóa") — FE bật nút "Xác nhận xóa" CHỈ khi người dùng gõ đúng số hiển thị; BE thêm 1
// lớp chặn hình thức (PHẢI đúng 2 chữ số) để không cho confirm "trống", KHÔNG thay thế gate FE. Không re-verify
// mật khẩu ở bước này: sở hữu OTP (gửi qua email) đã chứng minh chuỗi mật-khẩu→email→OTP, tương đương/mạnh hơn
// luồng email-change/phone hiện có.
meRouter.post(
  '/v1/me/request-deletion/confirm',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const body = req.body as RequestDeletionConfirmBody;
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const confirmNumber = typeof body?.confirmNumber === 'string' ? body.confirmNumber.trim() : '';
    if (!code) {
      res.status(400).json({ error: 'VALIDATION', message: 'Thiếu mã OTP.' });
      return;
    }
    if (!/^\d{2}$/.test(confirmNumber)) {
      res.status(400).json({ error: 'CONFIRM_NUMBER_INVALID', message: 'Thiếu mã xác nhận 2 số hoặc mã không hợp lệ.' });
      return;
    }
    const db = getBotDb();
    const agentId = req.agent!.id;
    const agent = await db.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      res.status(404).json({ error: 'AGENT_NOT_FOUND', message: 'Đại lý không tồn tại.' });
      return;
    }
    const email = typeof agent.email === 'string' ? agent.email.trim() : '';
    if (!email) {
      res.status(400).json({ error: 'NO_EMAIL', message: 'Tài khoản chưa có email — cần email để xác thực xóa tài khoản.' });
      return;
    }
    const verify = await verifyOtpChallenge(db, email, ACCOUNT_DELETION_PURPOSE, code);
    if (verify.outcome !== 'OK') {
      const status = verify.outcome === 'TOO_MANY_ATTEMPTS' ? 429 : verify.outcome === 'IN_PROGRESS' ? 409 : 400;
      res.status(status).json({ error: `OTP_${verify.outcome}`, message: deletionOtpOutcomeMessage(verify.outcome) });
      return;
    }
    if (verify.challengeId == null) {
      res.status(500).json({ error: 'OTP_INTERNAL', message: 'Xác minh OTP thiếu challengeId nội bộ — báo lỗi hệ thống.' });
      return;
    }
    await finalizeOtpChallenge(db, verify.challengeId);

    const deletionRequestedAt = agent.deletionRequestedAt ?? new Date();
    if (!agent.deletionRequestedAt) {
      await db.agent.update({ where: { id: agentId }, data: { deletionRequestedAt } });
    }
    res.json(toDeletionStatusDto(deletionRequestedAt));
  })
);

// POST /v1/me/cancel-deletion — hủy yêu cầu xóa đang treo (còn trong 48h ân hạn). IDEMPOTENT: gọi khi KHÔNG
// có yêu cầu nào đang treo vẫn trả 200 (deletionRequestedAt/deleteAt null) thay vì báo lỗi — hủy 1 thứ vốn đã
// không tồn tại không phải lỗi nghiệp vụ cần chặn.
meRouter.post('/v1/me/cancel-deletion', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const agentId = req.agent!.id;
  const agent = await db.agent.findUnique({ where: { id: agentId } });
  if (!agent) {
    res.status(404).json({ error: 'AGENT_NOT_FOUND', message: 'Đại lý không tồn tại.' });
    return;
  }
  if (agent.deletionRequestedAt) {
    await db.agent.update({ where: { id: agentId }, data: { deletionRequestedAt: null } });
  }
  res.json(toDeletionStatusDto(null));
}));

// ── Thiết bị / phiên đang đăng nhập (5/8, Admin Demo "màn Bảo mật chưa show thiết bị đang đăng nhập realtime")
// ─── kiểu "Thiết bị đăng nhập" của Zalo/Facebook. Nguồn sự thật DUY NHẤT = bảng web_sessions (mỗi phiên
// web/app còn hạn của agent này). 5/8 (Admin Demo DUYỆT): cột `user_agent` (text nullable) đã có trên DB +
// schema (LEAD ALTER + prisma generate) → nhãn thiết bị suy từ User-Agent (parseDeviceLabel: "Chrome ·
// Windows", "Safari · iPhone"...); phiên cũ/không có UA → "Thiết bị web/app". Realtime: revoke phát broadcastToAgent {msg:'sessions-updated'}
// tới MỌI kết nối WS của agent (kể cả chính thiết bị vừa bị đăng xuất — nó refetch → 401 → tự về /login), và
// mỗi lần đăng nhập thiết bị mới (routes/auth.ts) cũng phát cùng sự kiện để danh sách các thiết bị KHÁC tự làm
// mới. CHỈ đọc/xóa web_sessions của CHÍNH agent đang gọi (agentId từ req.agent, KHÔNG nhận từ client).

interface SessionDto {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  /** true nếu chính là phiên đang dùng để gọi request này (so id với cookie `sigma_ws`) — client KHÔNG
   * hiện nút "Đăng xuất" cho phiên hiện tại (dùng nút Đăng xuất thường), giống Zalo đánh dấu "Thiết bị này". */
  current: boolean;
  /** Nhãn thiết bị hiển thị kiểu Zalo — describeDevice: app native → "Ứng dụng SigMa (Máy tính)/(Android)";
   * trình duyệt → "Chrome · Windows"...; UA rỗng (phiên cũ) → "Thiết bị web/app". */
  deviceLabel: string;
  /** Loại form-factor để client chọn icon: 'pc' → Monitor, 'mobile' → Smartphone (kiểu Zalo phân biệt máy
   * tính/điện thoại). Suy từ platform (exe/apk) rồi fallback User-Agent — parseDeviceKind. */
  kind: 'pc' | 'mobile';
}

// GET /v1/me/sessions — danh sách phiên CÒN HẠN của đại lý đang đăng nhập, mới-hoạt-động-nhất trước.
meRouter.get('/v1/me/sessions', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const currentSessionId = (req.cookies?.[WEB_SESSION_COOKIE_NAME] as string | undefined) ?? '';
  const sessions = await listWebSessionsForAgent(db, { agentId: req.agent!.id, rcUserId: req.agent!.rcUserId });
  const items: SessionDto[] = sessions.map((s) => {
    const d = describeDevice(s.userAgent, s.platform);
    return {
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      current: s.id === currentSessionId,
      deviceLabel: d.label,
      kind: d.kind
    };
  });
  res.json({ items });
}));

// POST /v1/me/sessions/:id/revoke — đăng xuất 1 thiết bị KHÁC. CẤM revoke phiên HIỆN TẠI qua đây (dùng nút
// Đăng xuất thường — tránh người dùng tự khóa mình ra khỏi màn đang thao tác một cách khó hiểu). Phiên không
// thuộc agent này (hoặc đã bị xóa) → 404 (revokeWebSessionByIdForAgent tự giới hạn theo agentId∪rcUserId,
// KHÔNG cho xóa chéo agent). Thành công → broadcast sessions-updated cho MỌI kết nối của agent (best-effort,
// broadcastToAgent KHÔNG BAO GIỜ throw — xem chat-realtime-hub.ts).
meRouter.post('/v1/me/sessions/:id/revoke', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const targetId = req.params.id;
  const currentSessionId = (req.cookies?.[WEB_SESSION_COOKIE_NAME] as string | undefined) ?? '';
  if (targetId && targetId === currentSessionId) {
    res.status(400).json({ error: 'CANNOT_REVOKE_CURRENT', message: 'Không thể đăng xuất phiên hiện tại từ đây — hãy dùng nút Đăng xuất thường.' });
    return;
  }
  const count = await revokeWebSessionByIdForAgent(db, targetId, { agentId: req.agent!.id, rcUserId: req.agent!.rcUserId });
  if (count === 0) {
    res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Phiên không tồn tại hoặc đã đăng xuất.' });
    return;
  }
  broadcastToAgent(req.agent!.id, { msg: 'sessions-updated' });
  res.json({ ok: true });
}));

// POST /v1/me/sessions/revoke-others — 8/8 (Admin Demo "đăng xuất khỏi thiết bị... như Zalo"): đăng xuất TẤT CẢ
// thiết bị KHÁC, GIỮ phiên hiện tại (so cookie sigma_ws). Trả số phiên đã đăng xuất (để client hiện toast).
// Thành công (kể cả count 0 — không có thiết bị khác) → broadcast sessions-updated để mọi thiết bị bị đá tự về
// /login. Không có cookie phiên hiện tại (bất thường) → revokeOtherWebSessionsForAgent tự trả [] fail-safe.
meRouter.post('/v1/me/sessions/revoke-others', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const currentSessionId = (req.cookies?.[WEB_SESSION_COOKIE_NAME] as string | undefined) ?? '';
  const revoked = await revokeOtherWebSessionsForAgent(db, { agentId: req.agent!.id, rcUserId: req.agent!.rcUserId }, currentSessionId);
  if (revoked.length > 0) broadcastToAgent(req.agent!.id, { msg: 'sessions-updated' });
  res.json({ ok: true, revokedCount: revoked.length });
}));

// ── Bước 4 (24/7) — Lịch sử Lô + Đối soát, đúng kế hoạch mục D.4. TÁI DÙNG reconcileLo (lo-service.ts),
// CHỈ thêm kiểm tra ownership (lo.agentId === req.agent!.id) mà route Bearer cũ /v1/lo/:loId/reconcile
// KHÔNG có (route cũ tin caller nội bộ khai loId trực tiếp) — ở đây client là đại lý tự gọi, PHẢI chặn
// đại lý A xem/đối soát Lô của đại lý B.

interface LoListItem {
  id: number;
  bankReportedLoNumber: number | null;
  expectedTotalAmount: string;
  status: string;
  createdAt: Date;
  rowCount: number;
}

// GET /v1/me/lo?status=&limit=&offset= — danh sách Lô của đại lý đang đăng nhập, mới nhất trước.
meRouter.get('/v1/me/lo', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const agentId = req.agent!.id;

  // AUDIT 24/7 (LOW): `req.query.status` là ARRAY (không phải string) khi client gửi key trùng lặp
  // (?status=A&status=B) — `typeof statusRaw === 'string'` khi đó là false, bỏ qua toàn bộ validate NGẦM
  // thay vì 400, khiến filter status bị bỏ qua âm thầm. Chặn tường minh non-string TRƯỚC, không để lọt.
  const statusRaw = req.query.status;
  if (statusRaw !== undefined && typeof statusRaw !== 'string') {
    res.status(400).json({ error: 'VALIDATION', message: 'status phải là 1 giá trị duy nhất (không lặp lại tham số).' });
    return;
  }
  const ALLOWED_STATUS = new Set(['PENDING', 'CONFIRMED', 'MISMATCH', 'CANCELLED']);
  let status: string | undefined;
  if (typeof statusRaw === 'string' && statusRaw.length > 0) {
    if (!ALLOWED_STATUS.has(statusRaw)) {
      res.status(400).json({ error: 'VALIDATION', message: 'status phải là PENDING/CONFIRMED/MISMATCH/CANCELLED.' });
      return;
    }
    status = statusRaw;
  }

  const limitRaw = req.query.limit;
  const limit = typeof limitRaw === 'string' && Number.isInteger(Number(limitRaw)) && Number(limitRaw) > 0 ? Math.min(Number(limitRaw), 100) : 20;
  const offsetRaw = req.query.offset;
  const offset = typeof offsetRaw === 'string' && Number.isInteger(Number(offsetRaw)) && Number(offsetRaw) >= 0 ? Number(offsetRaw) : 0;

  const where = { agentId, ...(status ? { status } : {}) };
  const [los, total] = await Promise.all([
    db.lo.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
    db.lo.count({ where })
  ]);
  const loIds = los.map((l) => l.id);
  const rowCounts = loIds.length > 0 ? await db.loRow.groupBy({ by: ['loId'], where: { loId: { in: loIds } }, _count: { id: true } }) : [];
  const countByLoId = new Map(rowCounts.map((r) => [r.loId, r._count.id]));

  const items: LoListItem[] = los.map((l) => ({
    id: l.id,
    bankReportedLoNumber: l.bankReportedLoNumber,
    expectedTotalAmount: l.expectedTotalAmount.toString(),
    status: l.status,
    createdAt: l.createdAt,
    rowCount: countByLoId.get(l.id) ?? 0
  }));

  // AUDIT 24/7 (LOW): thêm total + hasMore — không có 2 field này client không dựng được "trang X/Y"/"tải
  // thêm" mà không đoán mò.
  res.json({ items, limit, offset, total, hasMore: offset + items.length < total });
}));

// GET /v1/me/lo/:loId — chi tiết 1 Lô CỦA CHÍNH đại lý đang gọi. Lô KHÔNG thuộc agent này → 404 (KHÔNG
// 403 — tránh xác nhận sự tồn tại của loId thuộc đại lý khác, cùng nguyên tắc TID_NOT_IN_AGENT_SCOPE trả
// lỗi không tiết lộ dữ liệu chéo đại lý).
meRouter.get('/v1/me/lo/:loId', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const agentId = req.agent!.id;
  const loId = Number(req.params.loId);
  if (!Number.isInteger(loId)) {
    res.status(400).json({ error: 'VALIDATION', message: 'loId phải là số nguyên.' });
    return;
  }
  const lo = await db.lo.findUnique({ where: { id: loId } });
  if (!lo || lo.agentId !== agentId) {
    res.status(404).json({ error: 'NOT_FOUND', message: `Lô id=${loId} không tồn tại.` });
    return;
  }
  const rows = await db.loRow.findMany({ where: { loId }, orderBy: { id: 'asc' } });
  const bills = await db.loBill.findMany({ where: { loId }, orderBy: { id: 'asc' } });
  // AUDIT 24/7 (MEDIUM): reconcileLo() có thể set MISMATCH THUẦN vì lệch tam giác (triangulation.blame !==
  // 'NONE') hoặc trùng số lô, KHÔNG kèm bất kỳ RuleViolationEntry nào (0 dòng SIGMA_LO_RULE_VIOLATION).
  // Bản trước CHỈ đọc action đó → GET chi tiết trả violations:[] cho 1 Lô MISMATCH mà KHÔNG giải thích lý do
  // gì — vô dụng cho đúng mục đích màn "Lô & Đối soát". Đọc THÊM 2 action còn lại (đã ghi sẵn trong
  // reconcileLo, xem lo-service.ts dòng auditRows), lấy bản GHI NHẬN GẦN NHẤT (id desc, take 1) — nếu Lô
  // từng đối soát nhiều lần, chỉ lần GẦN NHẤT còn phản ánh đúng trạng thái status hiện tại.
  const [violationAudits, triangulationAudit, loNumberReuseAudit] = await Promise.all([
    db.auditLog.findMany({ where: { targetType: 'Lo', targetId: String(loId), action: 'SIGMA_LO_RULE_VIOLATION' }, orderBy: { id: 'asc' } }),
    db.auditLog.findFirst({
      where: { targetType: 'Lo', targetId: String(loId), action: 'SIGMA_LO_TRIANGULATION_MISMATCH' },
      orderBy: { id: 'desc' }
    }),
    db.auditLog.findFirst({ where: { targetType: 'Lo', targetId: String(loId), action: 'SIGMA_LO_NUMBER_REUSE' }, orderBy: { id: 'desc' } })
  ]);

  // AUDIT 24/7 (LOW): afterJson lưu kèm `agentId` (xem reconcileLo() dòng auditRows) — KHÔNG phải 1 phần
  // shape RuleViolationEntry thật, rò rỉ field thừa ra response nếu trả thẳng. Bóc `agentId` ra trước khi trả.
  const violations = violationAudits.map((a) => {
    const { agentId: _agentId, ...rest } = JSON.parse(a.afterJson ?? '{}') as Record<string, unknown>;
    return rest;
  });
  const triangulation = triangulationAudit ? (JSON.parse(triangulationAudit.afterJson ?? '{}') as { agentId?: unknown }) : null;
  const loNumberReuse = loNumberReuseAudit ? (JSON.parse(loNumberReuseAudit.afterJson ?? '{}') as { agentId?: unknown }) : null;
  if (triangulation) delete triangulation.agentId;
  if (loNumberReuse) delete loNumberReuse.agentId;

  res.json({
    id: lo.id,
    agentId: lo.agentId,
    bankReportedLoNumber: lo.bankReportedLoNumber,
    expectedTotalAmount: lo.expectedTotalAmount.toString(),
    status: lo.status,
    cancelReason: lo.cancelReason,
    createdAt: lo.createdAt,
    rows: rows.map((r) => ({
      id: r.id,
      tidId: r.tidId,
      cardTypeId: r.cardTypeId,
      feeTypeId: r.feeTypeId,
      amountBeforeFee: r.amountBeforeFee.toString(),
      feeApplied: r.feeApplied.toString(),
      amountAfterFee: r.amountAfterFee.toString()
    })),
    bills: bills.map((b) => ({
      id: b.id,
      receiptNumber: b.receiptNumber,
      ocrAmount: b.ocrAmount.toString(),
      swipeAt: b.swipeAt,
      cardLast4: b.cardLast4
    })),
    violations,
    triangulation,
    loNumberReuse
  });
}));

// POST /v1/me/lo/:loId/reconcile — wrapper RC-auth cho reconcileLo (lo-service.ts), THÊM kiểm tra
// ownership TRƯỚC KHI gọi (route Bearer cũ /v1/lo/:loId/reconcile KHÔNG kiểm — chấp nhận được vì caller
// nội bộ, nhưng ở đây client là đại lý tự gọi trực tiếp qua UI nên BẮT BUỘC chặn).
meRouter.post('/v1/me/lo/:loId/reconcile', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const agentId = req.agent!.id;
  const loId = Number(req.params.loId);
  if (!Number.isInteger(loId)) {
    res.status(400).json({ error: 'VALIDATION', message: 'loId phải là số nguyên.' });
    return;
  }
  const lo = await db.lo.findUnique({ where: { id: loId } });
  if (!lo || lo.agentId !== agentId) {
    res.status(404).json({ error: 'NOT_FOUND', message: `Lô id=${loId} không tồn tại.` });
    return;
  }
  const r = await reconcileLo(db, loId, req.body as ReconcileBody);
  if (!r.ok) {
    const status = r.error === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

// So khớp TID OCR đọc được với danh sách TID ĐÃ CẤU HÌNH của CHÍNH đại lý đang đăng nhập (Admin Demo 1/8) — TID
// là dãy SỐ, đáng tin hơn nhiều so với chữ (hkdName/bankName) OCR đọc tự do trên bill (dễ nhầm mặt chữ hơn
// nhiều so với đọc số). `agentTids` PHẢI lấy qua listAgentTidsWithCardTypeOptions(db, req.agent!.id) — hàm đó
// đã TỰ giới hạn ĐÚNG agentId đang gọi, KHÔNG thêm điều kiện agentId nào khác ở đây (tránh dò TID đại lý
// khác). Hàm THUẦN (không đụng DB trực tiếp) để test được bằng mảng `agentTids` giả lập, không cần throwaway
// Postgres cho riêng logic so khớp này (route mới cần Postgres thật để verify listAgentTidsWithCardTypeOptions
// trả đúng, xem test/me.test.ts).
//
// Khớp CHÍNH XÁC (===) trên tid.value. Khớp được → ưu tiên hkdName/bankName TỪ DB (đáng tin hơn text OCR),
// CHỈ fallback về giá trị OCR đọc trực tiếp nếu DB không có (null, vd TID có cấu hình nhưng chưa điền tên
// HKD). KHÔNG khớp (hoặc OCR không đọc ra TID nào) → tidMatched:false, GIỮ NGUYÊN hkdName/bankName đọc trực
// tiếp từ OCR làm fallback hiển thị — đây là CẢNH BÁO kiểu "cần xem lại" (CÙNG triết lý needsManualReview của
// số tiền), KHÔNG chặn luồng/không throw, client vẫn được gửi/tiếp tục bình thường.
export function matchBillTidWithAgentTids(
  preview: OcrBillPreview,
  agentTids: TidWithCardTypeOptions[]
): OcrBillPreview & { tidMatched: boolean } {
  const matched = preview.tid ? agentTids.find((t) => t.tid === preview.tid!.value) : undefined;
  if (!matched) {
    return { ...preview, tidMatched: false };
  }
  return {
    ...preview,
    hkdName: matched.hkdName != null ? { value: matched.hkdName, uncertain: false } : preview.hkdName,
    bankName: matched.bankName != null ? { value: matched.bankName, uncertain: false } : preview.bankName,
    tidMatched: true
  };
}

// B122 (2/8, audit đối kháng "route tốn tài nguyên đã có rate-limit đủ chưa" — Admin Demo yêu cầu trực tiếp) —
// route NÀY gọi OCR microservice Python (ocr-bridge.ts → GPU RTX 5060 Ti, xem B104 BUGS_FIXED.md) cho MỖI
// request, đắt hơn HẲN mọi route khác trong file (không chỉ 1 query DB rẻ như friendLookupLimiter phía dưới
// bảo vệ) — TRƯỚC ĐỢT NÀY hoàn toàn KHÔNG rate-limit, dù friendLookupLimiter (route lookup mã/email/SĐT, CHỈ
// đọc DB) đã có từ 31/7. 1 agent (hoặc client lỗi tự động retry vòng lặp) gọi liên tục có thể chiếm dụng GPU
// OCR DÙNG CHUNG cho MỌI đại lý khác — CÙNG LỚP rủi ro overload đã ghi nhận ở friendLookupLimiter, mở rộng
// cùng khuôn (scope theo agentId, KHÔNG theo IP — lý do y hệt: nhiều đại lý dùng chung NAT/mạng công ty).
// Ngân sách 15 lần/phút — THẤP HƠN friendLookupLimiter (20/phút) có chủ đích: mỗi request tốn hẳn 1 lượt GPU
// inference thật, KHÔNG phải chỉ 1 SELECT rẻ; luồng thật (chụp 1 bill → xem preview → gửi) hiếm khi cần quét
// lại quá vài lần/phút, kể cả retry tay khi ảnh mờ.
const ocrPreviewLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.agent?.id ?? 'unknown'),
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều lượt quét bill trong 1 phút, vui lòng thử lại sau.' }
});

// ── OCR preview số tiền + 6 trường bill (31/7 B71 phần 2, mở rộng 1/8) — route này CHỈ xem trước/gợi ý điền
// form giúp đại lý đối chiếu nhanh, KHÔNG tự động ghi Lô/đối soát nào (reconcileLo ở trên GIỮ NGUYÊN 100%,
// không đổi hành vi). Luồng: client upload multipart 1 ảnh → parseSingleFileUpload (multipart-upload.ts, giới
// hạn 10MB riêng cho ảnh bill) → callOcrService (ocr-bridge.ts, gọi OCR microservice Python nội bộ, CHỈ 1 LẦN)
// → buildBillPreview (ocr-bridge.ts, gộp buildAmountPreview số tiền KHÔNG ĐỔI + extractBillFields 6 trường
// mới TRÊN CÙNG mảng lines đã fetch) → matchBillTidWithAgentTids (đối chiếu TID với dữ liệu Tid đã cấu hình,
// CHỈ SELECT, không UPDATE/INSERT gì) → trả thẳng preview cho client, KHÔNG bọc thêm {ok:true,data:...} (khớp
// convention res.json(r.data) trực tiếp của /v1/me/quote ở trên).
meRouter.post('/v1/me/lo/ocr-preview', asyncHandler(requireSession), ocrPreviewLimiter, asyncHandler(async (req, res) => {
  const parsed = await parseSingleFileUpload(req);
  if (!parsed.ok) {
    if (parsed.reason === 'TOO_LARGE') {
      res.status(413).json({ error: 'FILE_TOO_LARGE', message: 'Ảnh vượt quá giới hạn 10MB.' });
      return;
    }
    res.status(400).json({ error: 'NO_FILE', message: 'Thiếu ảnh bill trong yêu cầu.' });
    return;
  }

  // MIGRATE OCR-in-chat lô (Admin Demo 31/8 "phòng chat đồng nhất OCR thủ công"): đọc bill POS bằng SONNET@2400
  // (readBillForSend qua 8796 — đồng nhất 2 tab Quét-bill-gửi + chính xác hơn Python 8799 cũ). cardScheme/BIN +
  // settlementCode(đóng-lô-95) đọc THẲNG từ Sonnet (thay detectCardFromOcr(lines)). Python FALLBACK nếu Sonnet
  // lỗi/không ra bill POS dùng được (an toàn — KHÔNG phá subsystem, GIỮ card-detect + đa-độ-phân-giải cũ).
  let billPreview: OcrBillPreview;
  let det: { scheme: 'INTERNATIONAL' | 'DOMESTIC' | null; bin6: string | null };
  const sonnet = await callSonnetOcr(parsed.buffer);
  const sBill = sonnet?.bills?.[0];
  if (sBill && (sBill.tid || sBill.agencyName) && (Number(sBill.totalAmount) || 0) > 0) {
    billPreview = sonnetBillToBillPreview(sBill);
    det = sonnetCardDetection(sBill);
  } else {
    // FALLBACK Python đa-độ-phân-giải (Admin Demo 21/8) — 2 lượt (res cao TID/chữ + ~1000px logo bank) rồi gộp.
    const ocrResult = await buildBillPreviewMultiScale(parsed.buffer, parsed.fileName);
    if (!ocrResult.ok) {
      if (ocrResult.reason === 'EMPTY_FILE' || ocrResult.reason === 'MIME_NOT_ALLOWED') {
        res.status(400).json({
          error: ocrResult.reason,
          message: ocrResult.reason === 'EMPTY_FILE' ? 'Ảnh rỗng, không đọc được nội dung.' : 'Ảnh không đúng định dạng jpeg/png/webp — vui lòng chụp lại.'
        });
        return;
      }
      res.status(502).json({ error: ocrResult.reason, message: 'Không gọi được dịch vụ OCR — vui lòng nhập tay.' });
      return;
    }
    billPreview = ocrResult.preview;
    det = detectCardFromOcr(ocrResult.lines);
  }

  // agentTids: CHỈ query khi OCR có đọc ra TID (tránh round-trip DB vô ích) — listAgentTidsWithCardTypeOptions() tự
  // giới hạn ĐÚNG agentId đang gọi (req.agent!.id, đã xác thực qua requireSession), KHÔNG điều kiện agentId khác.
  const agentTids = billPreview.tid ? await listAgentTidsWithCardTypeOptions(getBotDb(), req.agent!.id) : [];
  const preview = matchBillTidWithAgentTids(billPreview, agentTids);
  // HASH ẢNH bill (sha256 file gốc) — client chuyển tiếp sang /v1/me/lo/from-bill làm KHÓA DEDUP tầng 2 (Admin Demo
  // 21/8): bill KHÔNG đọc được số lô/số HĐ (vd bill MB) → gửi lại ĐÚNG file ảnh vẫn gộp CÙNG Lô, không tách doanh
  // số. Tính server-side để thuật toán/định dạng hash nhất quán (client chỉ cầm chuỗi opaque). Dùng buffer GỐC
  // (parsed.buffer) — KHÔNG phải bản resize lượt OCR — để hash ổn định theo đúng file đại lý gửi.
  const billImageHash = createHash('sha256').update(parsed.buffer).digest('hex');
  res.json({ ...preview, detectedCardScheme: det.scheme, detectedBin6: det.bin6, billImageHash });
}));

// POST /v1/me/refund/ocr-preview?originalTid=<chuỗi> — SIGMA (2/8, tính năng "Hoàn tiền" MỚI) — xem trước
// OCR 1 ảnh biên lai CHUYỂN KHOẢN hoàn tiền (KHÁC bill quẹt thẻ gốc ở route trên — định dạng OCR khác hẳn, xem
// ocr-bridge.ts buildRefundReceiptPreview()). `originalTid` (query, KHÔNG phải multipart field — CÙNG cách
// /v1/me/fee-preview nhận tid qua query, tránh sửa multipart-upload.ts chỉ để thêm 1 field text) = TID đọc từ
// bill GỐC (client đã có sẵn trong billMeta của tin nhắn đang trả lời) — dùng để tra `ReceiveAccount` đã cấu
// hình cho TID đó (matchRefundRecipient(), refund-service.ts) đối chiếu tên/STK "Người nhận" đọc từ OCR. Thiếu
// originalTid vẫn trả preview bình thường (chỉ recipientMatch='no_tid', KHÔNG chặn luồng — CÙNG triết lý mọi
// field mở rộng khác trong hệ OCR bill).
// CÙNG lý do B122 (đọc comment ocrPreviewLimiter trên) — route này CŨNG gọi OCR microservice GPU dùng chung,
// gắn ĐÚNG limiter đó (KHÔNG khai limiter thứ 2 trùng lặp — 15 lần/phút theo agentId).
meRouter.post('/v1/me/refund/ocr-preview', asyncHandler(requireSession), ocrPreviewLimiter, asyncHandler(async (req, res) => {
  const parsed = await parseSingleFileUpload(req);
  if (!parsed.ok) {
    if (parsed.reason === 'TOO_LARGE') {
      res.status(413).json({ error: 'FILE_TOO_LARGE', message: 'Ảnh vượt quá giới hạn 10MB.' });
      return;
    }
    res.status(400).json({ error: 'NO_FILE', message: 'Thiếu ảnh biên lai hoàn tiền trong yêu cầu.' });
    return;
  }

  // MIGRATE OCR-in-chat (Admin Demo 31/8 "phòng chat đồng nhất OCR thủ công"): bill hoàn tiền = CHUYỂN KHOẢN → đọc
  // bằng SONNET@2400 (readTransferVision, ĐÚNG loại — chính xác hơn hẳn engine Python 8799 cũ/mù MBV, đồng nhất
  // 2 tab Quét-bill-gửi). Python FALLBACK nếu Sonnet lỗi/không nhận ra transfer (an toàn, không phá subsystem).
  let refundPreview: RefundReceiptPreview;
  const sonnet = await callSonnetOcr(parsed.buffer);
  if (sonnet && sonnet.transfers.length > 0) {
    refundPreview = sonnetTransferToRefundPreview(sonnet.transfers[0]);
  } else {
    const ocrResult = await callOcrService(parsed.buffer, parsed.fileName);
    if (!ocrResult.ok) {
      if (ocrResult.reason === 'EMPTY_FILE' || ocrResult.reason === 'MIME_NOT_ALLOWED') {
        res.status(400).json({
          error: ocrResult.reason,
          message: ocrResult.reason === 'EMPTY_FILE' ? 'Ảnh rỗng, không đọc được nội dung.' : 'Ảnh không đúng định dạng jpeg/png/webp — vui lòng chụp lại.'
        });
        return;
      }
      res.status(502).json({ error: ocrResult.reason, message: 'Không gọi được dịch vụ OCR — vui lòng nhập tay.' });
      return;
    }
    refundPreview = buildRefundReceiptPreview(ocrResult.lines);
  }
  const originalTid = typeof req.query.originalTid === 'string' ? req.query.originalTid : '';
  const recipientMatch = await matchRefundRecipient(
    getBotDb(),
    req.agent!.id,
    originalTid,
    refundPreview.recipientName?.value ?? null,
    refundPreview.recipientAccountNumber?.value ?? null,
    refundPreview.recipientAccountVietQR != null // #4 — ô tài khoản là mã VietQR → chỉ so TÊN.
  );
  // #5 (3/8) — khóa dedup (chống hoàn TRÙNG) rút GỌN từ chính OCR server: client LƯU nguyên `refundDedup` vào
  // metadataJson khi gửi tin hoàn tiền, và truyền lại vào /v1/me/refund/dedup-check để đối chiếu. recipientAccount
  // ưu tiên dãy số thuần, fallback mã VietQR (định danh bên nhận). Giá trị nào KHÔNG đọc được → null (dedup tự
  // hạ mức xuống "không đủ dữ liệu, kiểm tay").
  const refundDedup = {
    transferCode: refundPreview.transferCode,
    amount: refundPreview.parsedAmount,
    recipientAccount: refundPreview.recipientAccountNumber?.value ?? refundPreview.recipientAccountVietQR ?? null,
    dateTime: refundPreview.dateTime?.value ?? null
  };
  res.json({ ...refundPreview, recipientMatch, refundDedup });
}));

// GET /v1/me/refund/aggregate?originalMessageId=&requiredAmount= — SIGMA (2/8) — tính TRẠNG THÁI CỘNG DỒN
// (Admin Demo: "cho phép hoàn tiền NHIỀU LẦN cho 1 bill") của bill gốc `originalMessageId`: tổng mọi lần hoàn
// ĐÃ XÁC NHẬN (listRefundConfirmationsForMessage) so với `requiredAmount` (client tự tính qua /fee-preview,
// route này KHÔNG tính lại phí). Dùng để hiện "Đã hoàn: X/Y" lúc mở panel "Hoàn tiền" MỚI (client tự cộng
// thêm số đang xem trước, CHƯA lưu) và lúc "Sửa" 1 lần cụ thể (client tự loại trừ + cộng lại giá trị mới).
meRouter.get('/v1/me/refund/aggregate', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const originalMessageId = typeof req.query.originalMessageId === 'string' ? req.query.originalMessageId : '';
  const requiredAmount = Number(req.query.requiredAmount);
  if (!originalMessageId || !Number.isFinite(requiredAmount) || requiredAmount < 0) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu originalMessageId hoặc requiredAmount không hợp lệ.' });
    return;
  }
  try {
    const confirmations = await listRefundConfirmationsForMessage(getBotDb(), req.agent!.id, originalMessageId);
    const totalConfirmed = confirmations.reduce((sum, c) => sum + c.amount, 0);
    const aggregate = computeRefundAggregate(requiredAmount, totalConfirmed);
    res.json({ confirmations, aggregate });
  } catch (err) {
    if (err instanceof ChatServiceError) {
      res.status(err.code === 'MESSAGE_NOT_FOUND' ? 404 : err.code === 'NOT_MEMBER' ? 403 : 400).json({ error: err.code, message: err.message });
      return;
    }
    throw err;
  }
}));

// GET /v1/me/refund/dedup-check — SIGMA LANE B Vòng 2 (#5, 3/8) — CHỐNG HOÀN TIỀN TRÙNG. Client gọi TRƯỚC
// khi xác nhận 1 lần hoàn tiền, truyền các trường đã đọc từ /v1/me/refund/ocr-preview (server OCR): mã chuyển
// tiền (transferCode = KHÓA MẠNH) + số tiền + STK nhận + ngày giờ. Server so với MỌI lần hoàn tiền ĐÃ ghi của
// CHÍNH đại lý (cách ly theo agentId — refund-dedup.ts) → trả cảnh báo trùng ("cách đây X") / nghi trùng /
// không đủ dữ liệu. `excludeMessageId` (tùy chọn) để lúc SỬA 1 lần hoàn tiền không tự khớp chính nó.
meRouter.get('/v1/me/refund/dedup-check', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const q = req.query;
  const transferCode = typeof q.transferCode === 'string' && q.transferCode.trim() ? q.transferCode.trim() : null;
  const recipientAccount = typeof q.recipientAccount === 'string' && q.recipientAccount.trim() ? q.recipientAccount.trim() : null;
  const dateTime = typeof q.dateTime === 'string' && q.dateTime.trim() ? q.dateTime.trim() : null;
  const amountRaw = Number(q.amount);
  const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : null;
  const excludeMessageId = typeof q.excludeMessageId === 'string' && q.excludeMessageId.trim() ? q.excludeMessageId.trim() : undefined;
  const result = await checkRefundDuplicateForAgent(getBotDb(), req.agent!.id, { transferCode, amount, recipientAccount, dateTime }, new Date(), { excludeMessageId });
  res.json(result);
}));

// ── Kết bạn (24/7, kế hoạch mục 27) — 5 endpoint, business logic sống trong friend-service.ts, route ở
// đây CHỈ wrap HTTP + map lỗi sang status code. Ranh giới bảo mật: agentId luôn lấy từ req.agent!.id (RC-auth
// đã xác thực), KHÔNG bao giờ nhận agentId của "mình" từ body/URL client tự khai.

const FRIEND_ERROR_STATUS: Record<string, number> = {
  VALIDATION: 400,
  SELF_FRIEND_REQUEST: 400,
  AGENT_NOT_FOUND: 404,
  ALREADY_FRIENDS: 409,
  REQUEST_ALREADY_SENT: 409,
  NOT_FOUND: 404,
  NO_ACTIVE_RELATION: 404,
  FRIEND_LIMIT_REACHED: 400
};

// SECURITY AUDIT FIX (MEDIUM, phản biện độc lập 31/7) — 2 route tra cứu ngay dưới đây ('lookup' theo mã đại
// lý + 'lookup-by-contact' theo email/SĐT, B73) TRƯỚC ĐÂY KHÔNG rate-limit — bất kỳ agent nào đã đăng nhập có
// thể gọi lặp lại để dò xem 1 email/SĐT/mã có thuộc về đại lý thật nào không (PII enumeration), khác hẳn
// routes/auth.ts đã áp rate-limit cho MỌI route tra cứu tương tự (request-otp/forgot-password/resolve-phone).
// Scope theo agentId (req.agent!.id — CÓ SẴN vì cả 2 route đều đã qua requireSession trước limiter này),
// KHÔNG theo IP: agent PHẢI đăng nhập mới gọi được route này, nhiều agent dùng chung NAT/mạng công ty sẽ
// khiến IP không đủ ý nghĩa để phân biệt ai đang dò quét — CÙNG lý do deviceTokenIssueLimiter (routes/auth.ts)
// đã chọn scope agentId thay vì IP. Áp route-level cho ĐÚNG 2 route này (KHÔNG router-level blanket — đúng
// bài học B12 đã ghi khắp file này: `meRouter.use()` sẽ áp nhầm rate-limit cho MỌI route khác của meRouter).
// Ngân sách 20 lần/phút — TENTATIVE, Admin Demo CHƯA chốt số cuối, đây là số mặc định hợp lý (đủ dùng bình
// thường: tìm bạn/tra vài mã trong 1 phút, đủ chặn dò quét hàng loạt).
const friendLookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.agent?.id ?? 'unknown'),
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều lượt tra cứu trong 1 phút, vui lòng thử lại sau.' }
});

// GET /v1/me/friends/lookup?agentCode=XXX — tra cứu CHÍNH XÁC 1 mã đại lý, làm căn cứ gửi lời mời (xem
// quyết định thiết kế trong friend-service.ts lookupAgentByCode — KHÔNG phải "Danh bạ nội bộ" tìm kiếm mờ
// theo tên/email, mục đó còn treo riêng). Đặt TRƯỚC route '/v1/me/friends/:friendAgentId/unfriend' về mặt
// khai báo không quan trọng (Express match theo path literal 'lookup' không đụng path-param 'request' ở
// route khác — 'lookup' và 'request' là 2 segment cố định riêng biệt, không phải :param).
meRouter.get('/v1/me/friends/lookup', asyncHandler(requireSession), friendLookupLimiter, asyncHandler(async (req, res) => {
  const db = getBotDb();
  const codeRaw = req.query.agentCode;
  if (typeof codeRaw !== 'string' || codeRaw.length === 0) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu tham số agentCode.' });
    return;
  }
  const r = await lookupAgentByCode(db, req.agent!.id, codeRaw);
  if (!r.ok) {
    res.status(FRIEND_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

// GET /v1/me/friends/lookup-by-contact?q=XXX — tra cứu đại lý theo EMAIL (khớp CHÍNH XÁC, email UNIQUE →
// đúng 1 kết quả) HOẶC SĐT (khớp CHÍNH XÁC sau chuẩn hoá, phone KHÔNG UNIQUE → MẢNG) — căn cứ tìm bạn THỨ 2
// bên cạnh mã đại lý (route 'lookup' ở trên, GIỮ NGUYÊN không đổi). Phân biệt email/SĐT bằng ký tự '@' (xem
// quyết định thiết kế đầy đủ ở lookupAgentByEmailOrPhone, friend-service.ts). CÙNG convention response "trả
// THẲNG dữ liệu (object hoặc mảng), KHÔNG bọc {ok:true,...}" như route 'lookup' phía trên — client
// (agentApiFetch, agent-api-client.ts) tự bọc thành AgentApiResult dựa vào status HTTP, không phải bot-api
// tự bọc sẵn.
meRouter.get('/v1/me/friends/lookup-by-contact', asyncHandler(requireSession), friendLookupLimiter, asyncHandler(async (req, res) => {
  const db = getBotDb();
  const qRaw = req.query.q;
  if (typeof qRaw !== 'string' || qRaw.length === 0) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu tham số q.' });
    return;
  }
  const r = await lookupAgentByEmailOrPhone(db, req.agent!.id, qRaw);
  if (!r.ok) {
    res.status(FRIEND_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

interface FriendRequestBody {
  toAgentId?: number;
}

// POST /v1/me/friends/request — gửi lời mời kết bạn tới agentId khác. Nếu chiều ngược lại đã có PENDING
// (người kia mời mình trước) → tự động chấp nhận (xem quyết định thiết kế #2 đầu friend-service.ts),
// response kèm `autoAccepted` để frontend hiện đúng thông báo.
meRouter.post('/v1/me/friends/request', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const body = req.body as FriendRequestBody;
  const toAgentId = Number(body?.toAgentId);
  const r = await sendFriendRequest(db, req.agent!.id, toAgentId);
  if (!r.ok) {
    res.status(FRIEND_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.status(201).json({ ...r.data, autoAccepted: r.autoAccepted });
}));

// POST /v1/me/friends/:requestId/accept — CHỈ người NHẬN lời mời (toAgentId === req.agent.id) chấp nhận
// được — agent khác gọi hộ → 404 (KHÔNG tiết lộ request tồn tại, cùng nguyên tắc Lô ở trên).
meRouter.post('/v1/me/friends/:requestId/accept', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const requestId = Number(req.params.requestId);
  if (!Number.isInteger(requestId)) {
    res.status(400).json({ error: 'VALIDATION', message: 'requestId phải là số nguyên.' });
    return;
  }
  const r = await acceptFriendRequest(db, req.agent!.id, requestId);
  if (!r.ok) {
    res.status(FRIEND_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

// POST /v1/me/friends/:requestId/reject — CHỈ người NHẬN lời mời từ chối được.
meRouter.post('/v1/me/friends/:requestId/reject', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const requestId = Number(req.params.requestId);
  if (!Number.isInteger(requestId)) {
    res.status(400).json({ error: 'VALIDATION', message: 'requestId phải là số nguyên.' });
    return;
  }
  const r = await rejectFriendRequest(db, req.agent!.id, requestId);
  if (!r.ok) {
    res.status(FRIEND_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

// POST /v1/me/friends/:friendAgentId/unfriend — hủy kết bạn (ACCEPTED) HOẶC thu hồi lời mời CHÍNH MÌNH đã
// gửi (PENDING) — xem quyết định thiết kế #1 đầu friend-service.ts.
meRouter.post('/v1/me/friends/:friendAgentId/unfriend', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const friendAgentId = Number(req.params.friendAgentId);
  if (!Number.isInteger(friendAgentId)) {
    res.status(400).json({ error: 'VALIDATION', message: 'friendAgentId phải là số nguyên.' });
    return;
  }
  const r = await unfriend(db, req.agent!.id, friendAgentId);
  if (!r.ok) {
    res.status(FRIEND_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

// GET /v1/me/friends — bạn bè (ACCEPTED) + lời mời đang chờ (gửi đi + nhận về) của đại lý đang đăng nhập.
meRouter.get('/v1/me/friends', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const r = await listFriends(db, req.agent!.id);
  res.json(r);
}));

// ── Biệt danh (25/7, Admin Demo yêu cầu) — đặt/xóa biệt danh MÀ MÌNH đặt CHO 1 người bạn (1 CHIỀU, xem
// friend-service.ts setFriendNickname). ─────────────────────────────────────────────────────────────────

interface NicknameRequestBody {
  nickname?: string | null;
}

// POST /v1/me/friends/:friendAgentId/nickname — {nickname: string|null}. Thiếu hẳn field nickname trong body
// (KHÔNG phân biệt được với null qua JSON) → coi là lỗi client rõ ràng (400), KHÔNG âm thầm suy đoán null —
// buộc caller khai rõ ý định xóa bằng cách gửi `nickname: null` tường minh.
meRouter.post('/v1/me/friends/:friendAgentId/nickname', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const friendAgentId = Number(req.params.friendAgentId);
  if (!Number.isInteger(friendAgentId)) {
    res.status(400).json({ error: 'VALIDATION', message: 'friendAgentId phải là số nguyên.' });
    return;
  }
  const body = req.body as NicknameRequestBody;
  if (body?.nickname === undefined) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu trường nickname (chuỗi hoặc null).' });
    return;
  }
  const r = await setFriendNickname(db, req.agent!.id, friendAgentId, body.nickname);
  if (!r.ok) {
    res.status(FRIEND_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

// ── Chặn cuộc gọi/tin nhắn (25/7, Admin Demo yêu cầu) — 1 CHIỀU (MÌNH chặn HỌ), KHÔNG xóa quan hệ bạn bè. ─────

// POST /v1/me/friends/:friendAgentId/block
meRouter.post('/v1/me/friends/:friendAgentId/block', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const friendAgentId = Number(req.params.friendAgentId);
  if (!Number.isInteger(friendAgentId)) {
    res.status(400).json({ error: 'VALIDATION', message: 'friendAgentId phải là số nguyên.' });
    return;
  }
  const r = await blockFriend(db, req.agent!.id, friendAgentId);
  if (!r.ok) {
    res.status(FRIEND_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

// POST /v1/me/friends/:friendAgentId/unblock
meRouter.post('/v1/me/friends/:friendAgentId/unblock', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const friendAgentId = Number(req.params.friendAgentId);
  if (!Number.isInteger(friendAgentId)) {
    res.status(400).json({ error: 'VALIDATION', message: 'friendAgentId phải là số nguyên.' });
    return;
  }
  const r = await unblockFriend(db, req.agent!.id, friendAgentId);
  if (!r.ok) {
    res.status(FRIEND_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

// ── Phân loại bạn bè (31/7, Admin Demo yêu cầu "Gia đình"/"Công việc") — CÙNG khuôn biệt danh/chặn ở trên, 1
// CHIỀU (MÌNH phân loại HỌ, xem friend-service.ts setFriendCategory). ───────────────────────────────────────

interface CategoryRequestBody {
  category?: FriendCategory;
}

// PATCH /v1/me/friends/:friendAgentId/category — {category: 'FAMILY'|'WORK'|null}. CÙNG quy tắc nickname:
// thiếu hẳn field category trong body (KHÔNG phân biệt được với null qua JSON) → 400 rõ ràng, buộc caller
// khai rõ ý định gỡ phân loại bằng cách gửi `category: null` tường minh.
meRouter.patch('/v1/me/friends/:friendAgentId/category', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const friendAgentId = Number(req.params.friendAgentId);
  if (!Number.isInteger(friendAgentId)) {
    res.status(400).json({ error: 'VALIDATION', message: 'friendAgentId phải là số nguyên.' });
    return;
  }
  const body = req.body as CategoryRequestBody;
  if (body?.category === undefined) {
    res.status(400).json({ error: 'VALIDATION', message: "Thiếu trường category ('FAMILY'|'WORK'|null)." });
    return;
  }
  const r = await setFriendCategory(db, req.agent!.id, friendAgentId, body.category);
  if (!r.ok) {
    res.status(FRIEND_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

// ── Push notification kiểu Zalo (26/7, FCM) — đăng ký token thiết bị. ───────────────────────────────────

const ALLOWED_PUSH_PLATFORMS = new Set(['android']); // iOS ngoài phạm vi đợt này (spec).

interface PushTokenRequestBody {
  token?: string;
  platform?: string;
}

// POST /v1/me/push-token — {token, platform:'android'}. UPSERT theo `token` UNIQUE (schema.prisma): thiết bị
// gỡ-cài-lại/đổi tài khoản trên CÙNG máy vẫn cùng 1 token vật lý FCM → ghi đè agentId/lastUsedAt thay vì lỗi
// trùng khóa. KHÔNG cho phép 1 request đăng ký token CHO agent khác agentId đang gọi (agentId LUÔN lấy từ
// req.agent!.id đã qua requireSession, KHÔNG nhận từ body — đúng ranh giới bảo mật chung của meRouter).
meRouter.post('/v1/me/push-token', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const body = req.body as PushTokenRequestBody;
  if (typeof body?.token !== 'string' || body.token.length === 0) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu trường token (chuỗi khác rỗng).' });
    return;
  }
  if (typeof body?.platform !== 'string' || !ALLOWED_PUSH_PLATFORMS.has(body.platform)) {
    res.status(400).json({ error: 'VALIDATION', message: 'platform phải là "android".' });
    return;
  }
  const agentId = req.agent!.id;
  await db.pushToken.upsert({
    where: { token: body.token },
    create: { agentId, token: body.token, platform: body.platform },
    update: { agentId, lastUsedAt: new Date() }
  });
  res.status(200).json({ ok: true });
}));

// ── Phân loại nhóm chat (mục 21, việc #4, 31/7) — thay Phase 0 mock-only (mock-data/categories.ts +
// CategoryManagerModal.tsx). Business logic sống trong chat-category-service.ts, route ở đây CHỈ wrap HTTP +
// map lỗi sang status code (CÙNG khuôn khối "Kết bạn" ở trên). agentId luôn lấy từ req.agent!.id.

const CHAT_CATEGORY_ERROR_STATUS: Record<string, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  NOT_MEMBER: 403
};

// GET /v1/me/categories — toàn bộ phân loại của đại lý đang đăng nhập, kèm roomIds đang gán.
meRouter.get('/v1/me/categories', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const r = await listCategories(db, req.agent!.id);
  res.json(r.data);
}));

interface CreateCategoryRequestBody {
  name?: string;
  color?: string;
}

// POST /v1/me/categories — tạo phân loại mới {name, color}.
meRouter.post('/v1/me/categories', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const body = req.body as CreateCategoryRequestBody;
  const r = await createCategory(db, req.agent!.id, body?.name as string, body?.color as string);
  if (!r.ok) {
    res.status(CHAT_CATEGORY_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.status(201).json(r.data);
}));

interface UpdateCategoryRequestBody {
  name?: string;
  color?: string;
}

// PATCH /v1/me/categories/:categoryId — đổi tên/màu {name?, color?}. CHỈ chủ sở hữu sửa được (404 nếu
// không phải/không tồn tại — KHÔNG tiết lộ category thuộc người khác, xem comment chat-category-service.ts).
meRouter.patch('/v1/me/categories/:categoryId', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const body = req.body as UpdateCategoryRequestBody;
  const r = await updateCategory(db, req.agent!.id, req.params.categoryId, { name: body?.name, color: body?.color });
  if (!r.ok) {
    res.status(CHAT_CATEGORY_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

// DELETE /v1/me/categories/:categoryId — xóa phân loại. ChatRoomMember.categoryId liên quan tự về null
// (onDelete: SetNull, schema.prisma) — phòng chat đang gán KHÔNG bị xóa, chỉ về "chưa phân loại".
meRouter.delete('/v1/me/categories/:categoryId', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const r = await deleteCategory(db, req.agent!.id, req.params.categoryId);
  if (!r.ok) {
    res.status(CHAT_CATEGORY_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

interface AssignRoomCategoryRequestBody {
  categoryId?: string | null;
}

// PATCH /v1/me/chat-rooms/:roomId/category — {categoryId: string|null}. Thiếu hẳn field categoryId trong
// body (KHÔNG phân biệt được với null qua JSON) → 400 rõ ràng, CÙNG quy tắc nickname/category bạn bè —
// buộc caller khai rõ ý định gỡ phân loại bằng cách gửi `categoryId: null` tường minh.
meRouter.patch('/v1/me/chat-rooms/:roomId/category', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const body = req.body as AssignRoomCategoryRequestBody;
  if (body?.categoryId === undefined) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu trường categoryId (chuỗi hoặc null).' });
    return;
  }
  const r = await assignRoomCategory(db, req.agent!.id, req.params.roomId, body.categoryId);
  if (!r.ok) {
    res.status(CHAT_CATEGORY_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

// ── Hồ sơ cá nhân (1/8, Admin Demo yêu cầu "hiện + sửa được ngày sinh/giới tính/email/SĐT", thay ProfileScreen.tsx
// Phase 0 mock hoàn toàn — trước đây CHỈ có state cục bộ Tên hiển thị/Trạng thái, KHÔNG gọi API nào). Business
// logic sống trong services/profile-service.ts, route ở đây CHỈ wrap HTTP + map lỗi (CÙNG khuôn khối "Kết
// bạn"/"Phân loại nhóm chat" ở trên).
//
// SỬA GẤP GIỮA CHỪNG (Admin Demo, xem BUGS_FIXED.md) — 3 field KHÔNG cùng 1 cơ chế:
//   - name/gender/dateOfBirth: sửa TRỰC TIẾP qua PATCH /v1/me/profile dưới đây, không cần xác nhận gì thêm.
//   - email: BẮT BUỘC qua luồng OTP gửi tới email MỚI (kiểu Zalo) — PATCH /v1/me/profile TỪ CHỐI RÕ RÀNG 400
//     nếu body chứa field `email` (KHÔNG âm thầm bỏ qua — đúng nguyên tắc "check phải chạy, không nuốt lỗi
//     im", tránh client tưởng đã đổi thành công qua route sai). Đường đúng là 2 route
//     POST /v1/me/email-change/request-otp + /confirm ngay dưới, CÙNG khuôn routes/auth.ts forgot-password
//     (dùng lại NGUYÊN otp-service.ts/email-service.ts, KHÔNG viết lại cơ chế OTP mới).
//   - phone: CHƯA xây — repo KHÔNG có hạ tầng gửi OTP qua SMS nào (đã grep xác nhận toàn apps/bot-api/src, 0
//     kết quả 'sms'/'Twilio'/'ZNS'). PATCH /v1/me/profile CŨNG TỪ CHỐI RÕ RÀNG 400 nếu body chứa field `phone`
//     — CẦN LEAD hỏi Admin Demo chọn nhà cung cấp SMS trước khi xây (xem BUGS_FIXED.md mục "chưa làm").

const PROFILE_ERROR_STATUS: Record<string, number> = {
  VALIDATION: 400,
  AGENT_NOT_FOUND: 404,
  EMAIL_ALREADY_REGISTERED: 409
};

// GET /v1/me/profile — hồ sơ CỦA CHÍNH đại lý đang đăng nhập.
meRouter.get('/v1/me/profile', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const r = await getMyProfile(db, req.agent!.id);
  if (!r.ok) {
    res.status(PROFILE_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

interface UpdateProfileRequestBody {
  name?: string;
  gender?: string;
  dateOfBirth?: string;
  email?: unknown; // CHỈ dùng để PHÁT HIỆN + TỪ CHỐI — đường đổi email THẬT là 2 route email-change/* dưới đây.
  phone?: unknown; // CHỈ dùng để PHÁT HIỆN + TỪ CHỐI — CHƯA có hạ tầng SMS, xem comment đầu profile-service.ts.
}

// PATCH /v1/me/profile — {name?, gender?, dateOfBirth?}. Partial update (field vắng mặt = giữ nguyên).
meRouter.patch('/v1/me/profile', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const body = req.body as UpdateProfileRequestBody;
  if (body?.email !== undefined) {
    res.status(400).json({
      error: 'VALIDATION',
      message: 'Đổi email phải qua POST /v1/me/email-change/request-otp rồi /confirm, không sửa trực tiếp qua route này.'
    });
    return;
  }
  if (body?.phone !== undefined) {
    res.status(400).json({ error: 'VALIDATION', message: 'Đổi số điện thoại chưa hỗ trợ — hệ thống chưa có hạ tầng gửi OTP qua SMS.' });
    return;
  }
  const db = getBotDb();
  const r = await updateMyProfile(db, req.agent!.id, { name: body?.name, gender: body?.gender, dateOfBirth: body?.dateOfBirth });
  if (!r.ok) {
    res.status(PROFILE_ERROR_STATUS[r.error] ?? 400).json({ error: r.error, message: r.message });
    return;
  }
  res.json(r.data);
}));

// ── Đổi email liên kết — OTP gửi tới email MỚI (1/8, kiểu Zalo) ─────────────────────────────────────────────
const EMAIL_CHANGE_PURPOSE = 'EMAIL_CHANGE';

// Rate-limit CÙNG khuôn routes/auth.ts requestOtpIpLimiter/requestOtpEmailLimiter — bucket RIÊNG (key theo
// `newEmail`, KHÔNG share với REGISTER_PURPOSE/PASSWORD_RESET_PURPOSE) — đúng lý do auth.ts đã tách bucket
// forgotPassword khỏi register: 1 email vừa đăng ký vừa đổi email trong cùng giờ không nên đụng trần của nhau.
const emailChangeIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu từ địa chỉ IP này, vui lòng thử lại sau.' }
});
const emailChangeEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const newEmail = (req.body as { newEmail?: string } | undefined)?.newEmail;
    return typeof newEmail === 'string' && newEmail.trim() ? newEmail.trim().toLowerCase() : 'unknown';
  },
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu mã OTP cho email này, vui lòng thử lại sau.' }
});

// CÙNG khuôn otpOutcomeMessage() private của routes/auth.ts (không export chéo giữa 2 route file độc lập —
// duplicate 1 hàm switch nhỏ chấp nhận được).
function emailChangeOtpOutcomeMessage(outcome: 'EXPIRED' | 'WRONG_CODE' | 'TOO_MANY_ATTEMPTS' | 'NOT_FOUND' | 'IN_PROGRESS'): string {
  switch (outcome) {
    case 'EXPIRED':
      return 'Mã OTP đã hết hạn, vui lòng yêu cầu mã mới.';
    case 'WRONG_CODE':
      return 'Mã OTP không đúng.';
    case 'TOO_MANY_ATTEMPTS':
      return 'Đã nhập sai quá số lần cho phép, vui lòng yêu cầu mã mới.';
    case 'NOT_FOUND':
      return 'Không tìm thấy yêu cầu đổi email, vui lòng yêu cầu mã mới.';
    case 'IN_PROGRESS':
      return 'Yêu cầu đổi email với mã này đang được xử lý, vui lòng thử lại sau vài giây.';
  }
}

interface EmailChangeRequestOtpBody {
  newEmail?: string;
}

// POST /v1/me/email-change/request-otp — {newEmail} → validate định dạng + CHƯA trùng agent khác → tạo
// challenge OTP + gửi mail tới newEmail (KHÔNG phải email cũ). CÙNG khuôn routes/auth.ts register/request-otp,
// khác 1 điểm: route này CẦN session (đổi email của CHÍNH MÌNH) nên KHÔNG cần "luôn trả ok:true để chống dò
// email" như request-otp đăng ký — agent đã đăng nhập rồi, 409 EMAIL_ALREADY_REGISTERED không lộ thêm gì mới.
meRouter.post(
  '/v1/me/email-change/request-otp',
  asyncHandler(requireSession),
  emailChangeIpLimiter,
  emailChangeEmailLimiter,
  asyncHandler(async (req, res) => {
    const body = req.body as EmailChangeRequestOtpBody;
    const check = validateNewEmailFormat(typeof body?.newEmail === 'string' ? body.newEmail : '');
    if (!check.ok) {
      res.status(400).json({ error: 'VALIDATION', message: check.message });
      return;
    }
    const newEmail = check.email;
    const db = getBotDb();
    const agentId = req.agent!.id;

    const taken = await isEmailTakenByOtherAgent(db, agentId, newEmail);
    if (taken) {
      res.status(409).json({ error: 'EMAIL_ALREADY_REGISTERED', message: 'Email này đã được dùng bởi tài khoản khác.' });
      return;
    }

    const challenge = await createOtpChallenge(db, newEmail, EMAIL_CHANGE_PURPOSE);
    try {
      await sendOtpEmail(newEmail, challenge.code);
    } catch (err) {
      if (err instanceof OtpSmtpNotConfiguredError) {
        res.status(500).json({ error: 'OTP_SMTP_NOT_CONFIGURED', message: err.message });
        return;
      }
      res.status(500).json({ error: 'OTP_SEND_FAILED', message: 'Gửi email mã xác thực thất bại, vui lòng thử lại sau.' });
      return;
    }
    res.json({ ok: true });
  })
);

interface EmailChangeConfirmBody {
  newEmail?: string;
  code?: string;
}

// POST /v1/me/email-change/confirm — {newEmail, code} → verify OTP ĐÚNG newEmail này → ghi THẬT Agent.email.
// Kiểm trùng LẦN 2 (CÙNG isEmailTakenByOtherAgent ở request-otp) — phòng race 1 agent khác giành mất newEmail
// này GIỮA lúc OTP đang chờ nhập (request-otp → confirm có thể cách nhau tới 10 phút, đủ thời gian cho race).
meRouter.post(
  '/v1/me/email-change/confirm',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const body = req.body as EmailChangeConfirmBody;
    const check = validateNewEmailFormat(typeof body?.newEmail === 'string' ? body.newEmail : '');
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!check.ok || !code) {
      res.status(400).json({ error: 'VALIDATION', message: !check.ok ? check.message : 'Thiếu mã OTP.' });
      return;
    }
    const newEmail = check.email;
    const db = getBotDb();
    const agentId = req.agent!.id;

    const taken = await isEmailTakenByOtherAgent(db, agentId, newEmail);
    if (taken) {
      res.status(409).json({ error: 'EMAIL_ALREADY_REGISTERED', message: 'Email này đã được dùng bởi tài khoản khác.' });
      return;
    }

    const verify = await verifyOtpChallenge(db, newEmail, EMAIL_CHANGE_PURPOSE, code);
    if (verify.outcome !== 'OK') {
      const status = verify.outcome === 'TOO_MANY_ATTEMPTS' ? 429 : verify.outcome === 'IN_PROGRESS' ? 409 : 400;
      res.status(status).json({ error: `OTP_${verify.outcome}`, message: emailChangeOtpOutcomeMessage(verify.outcome) });
      return;
    }
    if (verify.challengeId == null) {
      res.status(500).json({ error: 'OTP_INTERNAL', message: 'Xác minh OTP thiếu challengeId nội bộ — báo lỗi hệ thống.' });
      return;
    }
    const challengeId = verify.challengeId;

    const applied = await applyEmailChange(db, agentId, newEmail);
    if (!applied.ok) {
      // Ghi thất bại (race P2002) — NHẢ claim, CÙNG cách routes/auth.ts register/verify-otp nhả claim khi
      // rcCreateUser thất bại (mã OTP đúng không nên bị đốt oan vì lỗi KHÔNG do người dùng gõ sai).
      await releaseOtpChallenge(db, challengeId);
      res.status(PROFILE_ERROR_STATUS[applied.error] ?? 400).json({ error: applied.error, message: applied.message });
      return;
    }
    await finalizeOtpChallenge(db, challengeId);
    res.json(applied.data);
  })
);

// ── Thêm/đổi SĐT xác thực — OTP qua SMS eSMS.vn (4/8, CMD_BUILD, Admin Demo chốt nhà cung cấp eSMS.vn) ──────────
// ĐỐI XỨNG khối "Đổi email liên kết" ngay trên (nhập SĐT mới → gửi mã tới SĐT MỚI qua SMS → nhập đúng mã → LÚC
// ĐÓ mới ghi Agent.phone). TÁI DÙNG NGUYÊN otp-service.ts (createOtpChallenge/verifyOtpChallenge/finalize/
// release) — "định danh" truyền vào là SĐT dạng 84xxxxxxxxx thay email, purpose='PHONE_CHANGE' (namespace
// riêng, KHÔNG đụng EMAIL_CHANGE/REGISTER). SMS gửi qua esms-service.ts (fail-closed nếu thiếu env — KHÔNG cho
// lưu phone, R198). Đường PATCH /v1/me/profile trực tiếp VẪN từ chối field phone thô (chỉ 2 route dưới ghi được).
const PHONE_CHANGE_PURPOSE = 'PHONE_CHANGE';

// Rate-limit CÙNG khuôn emailChange* — bucket RIÊNG (key theo SĐT dạng 84, KHÔNG share với email/register). IP
// 20 lần/15p; mỗi SĐT 5 lần/giờ (chặn spam gửi SMS tốn tiền tới 1 số cụ thể — tin brandname eSMS mất phí thật).
const phoneChangeIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu từ địa chỉ IP này, vui lòng thử lại sau.' }
});
const phoneChangePhoneLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Key theo SĐT ĐÃ CHUẨN HOÁ (84...) — "0912..."/"+84912..."/"84912..." của CÙNG 1 số phải đụng CÙNG bucket,
    // không cho lách trần bằng cách đổi tiền tố. SĐT sai định dạng → 'unknown' (route sẽ trả 400 ngay sau đó).
    const raw = (req.body as { phone?: string } | undefined)?.phone;
    const check = typeof raw === 'string' ? validateNewPhoneFormat(raw) : ({ ok: false } as const);
    return check.ok ? check.phone84 : 'unknown';
  },
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu mã OTP cho số điện thoại này, vui lòng thử lại sau.' }
});

// CÙNG khuôn emailChangeOtpOutcomeMessage() — duplicate 1 hàm switch nhỏ chấp nhận được (2 khối route độc lập).
function phoneChangeOtpOutcomeMessage(outcome: 'EXPIRED' | 'WRONG_CODE' | 'TOO_MANY_ATTEMPTS' | 'NOT_FOUND' | 'IN_PROGRESS'): string {
  switch (outcome) {
    case 'EXPIRED':
      return 'Mã xác thực đã hết hạn, vui lòng yêu cầu mã mới.';
    case 'WRONG_CODE':
      return 'Mã xác thực không đúng.';
    case 'TOO_MANY_ATTEMPTS':
      return 'Đã nhập sai quá số lần cho phép, vui lòng yêu cầu mã mới.';
    case 'NOT_FOUND':
      return 'Không tìm thấy yêu cầu đổi số điện thoại, vui lòng yêu cầu mã mới.';
    case 'IN_PROGRESS':
      return 'Yêu cầu đổi số điện thoại với mã này đang được xử lý, vui lòng thử lại sau vài giây.';
  }
}

interface PhoneOtpRequestBody {
  phone?: string;
}

// POST /v1/me/phone/otp/request — {phone} → validate định dạng SĐT VN → tạo challenge OTP (key theo SĐT 84) →
// gửi SMS tới SĐT MỚI qua eSMS. Fail-closed nếu SMS chưa cấu hình (500 SMS_NOT_CONFIGURED — KHÔNG nuốt lỗi, KHÔNG
// tạo challenge sống mồ côi mà không gửi được mã). CHƯA ghi Agent.phone (chỉ gửi mã).
meRouter.post(
  '/v1/me/phone/otp/request',
  asyncHandler(requireSession),
  phoneChangeIpLimiter,
  phoneChangePhoneLimiter,
  asyncHandler(async (req, res) => {
    const body = req.body as PhoneOtpRequestBody;
    const check = validateNewPhoneFormat(typeof body?.phone === 'string' ? body.phone : '');
    if (!check.ok) {
      res.status(400).json({ error: 'VALIDATION', message: check.message });
      return;
    }
    const db = getBotDb();
    const challenge = await createOtpChallenge(db, check.phone84, PHONE_CHANGE_PURPOSE);
    try {
      await sendOtpSms(check.phone84, challenge.code);
    } catch (err) {
      if (err instanceof EsmsNotConfiguredError) {
        // Fail-closed rõ ràng — SMS chưa cấu hình, KHÔNG cho lưu phone (R198). Challenge vừa tạo tự hết hạn.
        res.status(500).json({ error: 'SMS_NOT_CONFIGURED', message: 'Hệ thống SMS chưa được cấu hình, không gửi được mã xác thực. Vui lòng liên hệ quản trị.' });
        return;
      }
      res.status(500).json({ error: 'OTP_SEND_FAILED', message: 'Gửi tin nhắn mã xác thực thất bại, vui lòng thử lại sau.' });
      return;
    }
    res.json({ ok: true });
  })
);

interface PhoneOtpVerifyBody {
  phone?: string;
  code?: string;
}

// POST /v1/me/phone/otp/verify — {phone, code} → verify OTP ĐÚNG SĐT này → ghi THẬT Agent.phone (dạng 0xxxxxxxxx).
// Đây là ĐƯỜNG DUY NHẤT ghi được phone (PATCH /v1/me/profile vẫn từ chối phone thô chưa xác thực).
meRouter.post(
  '/v1/me/phone/otp/verify',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const body = req.body as PhoneOtpVerifyBody;
    const check = validateNewPhoneFormat(typeof body?.phone === 'string' ? body.phone : '');
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!check.ok || !code) {
      res.status(400).json({ error: 'VALIDATION', message: !check.ok ? check.message : 'Thiếu mã xác thực.' });
      return;
    }
    const db = getBotDb();
    const agentId = req.agent!.id;

    const verify = await verifyOtpChallenge(db, check.phone84, PHONE_CHANGE_PURPOSE, code);
    if (verify.outcome !== 'OK') {
      const status = verify.outcome === 'TOO_MANY_ATTEMPTS' ? 429 : verify.outcome === 'IN_PROGRESS' ? 409 : 400;
      res.status(status).json({ error: `OTP_${verify.outcome}`, message: phoneChangeOtpOutcomeMessage(verify.outcome) });
      return;
    }
    if (verify.challengeId == null) {
      res.status(500).json({ error: 'OTP_INTERNAL', message: 'Xác minh OTP thiếu challengeId nội bộ — báo lỗi hệ thống.' });
      return;
    }
    const challengeId = verify.challengeId;

    const applied = await applyPhoneChange(db, agentId, check.phone);
    if (!applied.ok) {
      // Ghi thất bại (vd agent vừa bị xoá) — NHẢ claim, CÙNG cách đổi email: mã đúng KHÔNG bị đốt oan vì lỗi
      // KHÔNG do người dùng gõ sai.
      await releaseOtpChallenge(db, challengeId);
      res.status(PROFILE_ERROR_STATUS[applied.error] ?? 400).json({ error: applied.error, message: applied.message });
      return;
    }
    await finalizeOtpChallenge(db, challengeId);
    res.json(applied.data);
  })
);

// ── Sao lưu Google Drive (1/8, mục 32 "Đồng bộ & Sao lưu") — Admin Demo chốt hướng KHÁC Zalo: server ĐÃ lưu vĩnh
// viễn mọi tin nhắn, đây CHỈ xuất lịch sử chat CỦA MÌNH ra 1 file JSON rồi đẩy lên Google Drive CÁ NHÂN của họ
// (bản sao độc lập ngoài app, KHÔNG phải disaster-recovery — xem comment đầu drive-backup-service.ts). Business
// logic (mã hoá/OAuth/build JSON/upload Drive) sống HẾT ở drive-backup-service.ts, route ở đây CHỈ wrap HTTP +
// map lỗi (CÙNG khuôn mọi khối khác trong file này). agentId LUÔN lấy từ req.agent!.id — KHÔNG bao giờ nhận từ
// body/URL client tự khai (CÙNG ranh giới bảo mật chung của meRouter).

const DRIVE_BACKUP_ERROR_STATUS: Record<string, number> = {
  VALIDATION: 400,
  CONFIG_MISSING: 500,
  INVALID_CODE: 400,
  NO_REFRESH_TOKEN: 400,
  NOT_CONNECTED: 400,
  DRIVE_TOKEN_REFRESH_FAILED: 401,
  DECRYPT_FAILED: 500,
  DRIVE_UPLOAD_FAILED: 502
};

interface DriveBackupConnectRequestBody {
  code?: string;
}

// POST /v1/me/drive-backup/connect — {code} (authorization code frontend lấy được từ popup
// `google.accounts.oauth2.initCodeClient`, xem lib/google-drive-backup.ts phía web-demo). Đổi code lấy
// refresh_token thật (KHÔNG BAO GIỜ nhận/lưu access_token — access_token hết hạn nhanh, không có giá trị lưu
// lâu dài) → MÃ HOÁ trước khi ghi DB (encryptRefreshToken, AES-256-GCM) → response TUYỆT ĐỐI KHÔNG chứa bất kỳ
// dạng nào của token (chỉ {ok:true, connected:true}).
meRouter.post('/v1/me/drive-backup/connect', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const body = req.body as DriveBackupConnectRequestBody;
  if (typeof body?.code !== 'string' || body.code.length === 0) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu trường code (authorization code từ Google).' });
    return;
  }

  const exchange = await exchangeAuthorizationCode(body.code);
  if (!exchange.ok) {
    res.status(DRIVE_BACKUP_ERROR_STATUS[exchange.kind] ?? 400).json({ error: exchange.kind, message: exchange.message });
    return;
  }

  let encrypted: string;
  try {
    encrypted = encryptRefreshToken(exchange.refreshToken);
  } catch (err) {
    if (err instanceof DriveBackupError) {
      res.status(DRIVE_BACKUP_ERROR_STATUS[err.code] ?? 500).json({ error: err.code, message: err.message });
      return;
    }
    throw err;
  }

  const db = getBotDb();
  await db.agent.update({ where: { id: req.agent!.id }, data: { googleDriveRefreshToken: encrypted } });
  res.json({ ok: true, connected: true });
}));

// GET /v1/me/drive-backup/status — trạng thái đã kết nối Drive chưa (`connected`, KHÔNG BAO GIỜ trả
// refresh_token dù đã mã hoá hay chưa) + lần backup gần nhất.
meRouter.get('/v1/me/drive-backup/status', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const agent = await db.agent.findUnique({
    where: { id: req.agent!.id },
    select: { googleDriveRefreshToken: true, googleDriveLastBackupAt: true }
  });
  if (!agent) {
    res.status(404).json({ error: 'AGENT_NOT_FOUND', message: 'Đại lý không tồn tại.' });
    return;
  }
  res.json({
    connected: agent.googleDriveRefreshToken !== null,
    lastBackupAt: agent.googleDriveLastBackupAt ? agent.googleDriveLastBackupAt.toISOString() : null
  });
}));

// POST /v1/me/drive-backup/run — chạy 1 lượt backup THẬT: build JSON lịch sử chat của đại lý đang đăng nhập →
// upload Google Drive của CHÍNH HỌ (đã kết nối qua /connect ở trên) → ghi googleDriveLastBackupAt=now() SAU KHI
// upload thành công (KHÔNG ghi trước — nếu upload lỗi giữa chừng, "lần backup gần nhất" không nên đổi).
meRouter.post('/v1/me/drive-backup/run', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const agentId = req.agent!.id;
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, name: true, googleDriveRefreshToken: true } });
  if (!agent) {
    res.status(404).json({ error: 'AGENT_NOT_FOUND', message: 'Đại lý không tồn tại.' });
    return;
  }
  if (!agent.googleDriveRefreshToken) {
    res.status(400).json({ error: 'NOT_CONNECTED', message: 'Chưa kết nối Google Drive — vui lòng bấm "Kết nối Google Drive" trước.' });
    return;
  }

  let result: Awaited<ReturnType<typeof runAgentDriveBackup>>;
  try {
    result = await runAgentDriveBackup(db, { id: agent.id, name: agent.name }, agent.googleDriveRefreshToken);
  } catch (err) {
    if (err instanceof DriveBackupError) {
      res.status(DRIVE_BACKUP_ERROR_STATUS[err.code] ?? 500).json({ error: err.code, message: err.message });
      return;
    }
    throw err;
  }

  await db.agent.update({ where: { id: agentId }, data: { googleDriveLastBackupAt: new Date(result.uploadedAt) } });
  res.json(result);
}));
