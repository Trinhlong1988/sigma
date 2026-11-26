// FEATURE "QUÉT BILL GỬI" (menu SigMa, Admin Demo 30/8) — HTTP route wrapper cho ocr-send-service.
// 2 chế độ: THỦ CÔNG (upload/camera 1 ảnh) + TỰ ĐỘNG (quét FOLDER bill tải về, OCR lần lượt). MỖI bill: OCR →
// REVIEW (người xem/sửa/xác nhận) → GỬI nhóm đại lý + cc NĐT. requireSession route-level (bài học B12, KHÔNG
// router.use blanket). "Mọi người đều bấm được" (Admin Demo) — chỉ cần đăng nhập, không giới hạn role.
import { Router, type Request, type Response } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseBillDateTimeMs } from '@sigma/services';
import { evaluateQrBaoCoStatus } from './digistore.js'; // [Admin Demo 6/9 — C] gate báo-có SERVER lúc gửi QR.
import { markBaoCoReconcile } from '../digistore-reconcile.js'; // [Admin Demo 7/9] gửi xong → đánh dấu báo-có ĐÃ đối soát ngay.
import { requireSession } from '../session-middleware.js';
import { getBotDb } from '../db.js';
import { createLoFromBillTid, buildBillKey } from '../lo-service.js';
import { ensureSupportAlphaAgent } from '../zalo-bill-support.js';
import { editBillParams } from '../bill-edit-service.js';
import { verifyBillEditPassword } from '../bill-edit-password-service.js';
import { getAttachmentFile } from '../chat-attachment-service.js';
import { findLotGaps } from '../lot-reconcile-service.js';
import { setBillEditPassword, isBillEditPasswordSet, BILL_EDIT_PW_CHANGER_EMAILS } from '../bill-edit-password-service.js';
import { recordSenderBankAlias } from '../sender-bank-alias.js';
import { asyncHandler } from '../async-handler.js';
import { parseSingleFileUpload } from '../multipart-upload.js';
import { parseMbStatement, reconcileStatement, saveStatementOverride, cacheStatementTxns, cacheClosingBalance, cacheReconciledTxns, loadCachedReconciled, bankHistoryToParsedStatement, findMissingOcrBills } from '../statement-recon.js';
import { buildBalanceCheck } from '../statement-balance.js';
import { doiChieuBaocoNdt } from '../investor-baoco-check.js';
import { buildSaoKeXlsx } from '../saoke-export.js';
import { agentScopeInvestorIds } from '../agent-tid-scope.js';
import { encryptSecret, decryptSecret } from '../digistore-secret.js';
import { buildStatementReconXlsx, type XlsxTxn } from '../statement-recon-xlsx.js';
import { fetchBankFeed, bankFeedToParsedStatement, bankFeedConfigFromEnv, mapMbLib, ngayVN, KIEM_TRUOC_KHI_TIN } from '../bank-feed.js';
import { requireAlphaOwner } from '../alpha-owner.js';
import { buildFolderReport, type BillTrongFolder } from '../folder-report-service.js';
import { taoOcrJob, layOcrJob } from '../ocr-job-store.js';
import {
  ocrBillImage,
  ocrBillFile,
  ocrRenameProcessed,
  layDayLoCungHo,
  reviewBills,
  consensusWarning,
  augmentReviewWithImageHash,
  augmentTransferReviewWithSentKind,
  applyPosBillCorrectionByImage,
  augmentQrReviewWithSent,
  parseClientBill,
  resolveBillRouting,
  rerouteBillForTid,
  computeSellFeeLine,
  computeInstallFeeLine,
  defaultCardTypeIdForTid,
  sendBillToDealerAndInvestor,
  findSentByImageHashGlobal,
  findSentByLoAmount,
  makePreviewJpeg,
  processedStatus,
  computeFeesFor,
  reviewTransfers,
  sendTransferByDirection,
  classifyOptions,
  recordClassifyAlias,
  saveTransferCorrectionByBuffer,
  reviewQr,
  chonBacGiaQr,
  qrRefAlreadySent,
  reserveQrSend,
  releaseQrSend,
  sendQrRefundToDealer,
  resolveInvestorRoomByReceiveAccount,
  sendQrToInvestor,
  editRefundBillParams,
  readBankHistory,
  type OcrBill,
  tienGhiNhan,
  chuanHoaSplitsTruHuy,
  type FeeSplitPart,
  type TransferReview,
  type QrReviewItem
} from '../ocr-send-service.js';
import { createQrTransactionSystem } from '@sigma/services';

function parseSplits(raw: unknown): FeeSplitPart[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const s = raw.map((x: { cardTypeId: unknown; amount: unknown }) => ({ cardTypeId: Number(x.cardTypeId), amount: Number(x.amount) || 0 })).filter((x: { cardTypeId: number }) => Number.isInteger(x.cardTypeId));
  return s.length ? s : undefined;
}

/** NGÀY GIAO DỊCH từ chuỗi ngày-giờ trên bill (Date | undefined). parseBillDateTimeMs cần GIỜ → thiếu giờ rơi về
 *  dd/mm/yyyy = 12:00 ngày đó. DÙNG CHUNG cho tính phí HIỂN THỊ và txnDate GHI (CRITICAL-1: hết split-brain cuối tuần).
 *  KHÔNG default hôm nay khi bill có ngày. */
function resolveBillTxnDate(dateTime: string | null | undefined): Date | undefined {
  const ms = parseBillDateTimeMs(dateTime);
  if (ms != null) return new Date(ms);
  if (dateTime) {
    const md = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(dateTime);
    if (md) {
      const d = new Date(Number(md[3]), Number(md[2]) - 1, Number(md[1]), 12, 0, 0);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return undefined;
}

export const ocrSendRouter = Router();

// [Admin Demo 14/9 "ngoài team alpha không xem được chức năng nội bộ"] TOÀN BỘ /v1/ocr-send/* (quét bill, review,
// gửi, sửa, folder-report, tra CK…) = CHỈ TEAM SIGMA — server chặn 403, không chỉ ẩn menu. NGOẠI LỆ duy nhất:
// /v1/ocr-send/image (token-based, phục vụ hiển thị ảnh bill đã gửi trong phòng chat của mọi thành viên).
ocrSendRouter.use('/v1/ocr-send', (req, res, next) => {
  if (req.path === '/image' || req.path.startsWith('/image/')) { next(); return; }
  void (async () => {
    await new Promise<void>((resolve) => { void asyncHandler(requireSession)(req, res, () => resolve()); });
    if (res.headersSent) return;
    requireAlphaOwner(req, res, next);
  })();
});

// ── Kho ẢNH TẠM theo token (client khỏi phải gửi lại ảnh lúc bấm Gửi) ────────────────────────────────────────
// [Admin Demo 8/9 — "sao hay báo ảnh hết hạn quét lại?"] TRƯỚC ĐÂY: giữ trong RAM, TTL 15 PHÚT.
//   → duyệt/đối soát lâu hơn 15' là mất ảnh;
//   → và MỖI LẦN bot-api KHỞI ĐỘNG LẠI (deploy/watchdog/sửa lỗi) là bay sạch → cả loạt bill đang xem báo
//     "Ảnh hết hạn — quét lại" dù người dùng chẳng làm gì sai.
// NAY: ghi ẢNH RA ĐĨA (data/ocr-pending) + TTL 6 GIỜ → sống qua restart, dọn theo hạn. RAM chỉ còn là lớp đệm.
interface Pending { buffer: Buffer; imageName: string; expiresAt: number; }
const pending = new Map<string, Pending>();
const TOKEN_TTL_MS = Number(process.env.OCR_TOKEN_TTL_MS) || 6 * 60 * 60 * 1000; // 6 giờ
const PENDING_DIR = path.join(process.cwd(), 'data', 'ocr-pending');
function ensurePendingDir(): void { try { fs.mkdirSync(PENDING_DIR, { recursive: true }); } catch { /* best-effort */ } }
function pendingPaths(token: string): { bin: string; meta: string } {
  return { bin: path.join(PENDING_DIR, `${token}.bin`), meta: path.join(PENDING_DIR, `${token}.json`) };
}
/** [Phản biện 11/9 — lớp path-traversal, cùng họ bug B2 Electron save-file] Token pending do CLIENT gửi lên
 *  (query/body) mà đi THẲNG vào path.join(PENDING_DIR, token + '.bin') → token "..\\..\\x" trỏ ra NGOÀI thư mục
 *  pending. putPending chỉ phát randomUUID → token hợp lệ DUY NHẤT là dạng UUID; mọi thứ khác chặn TRƯỚC khi chạm
 *  đĩa (fail-closed, export để test khoá 2 chiều). */
export function laOcrTokenHopLe(token: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
}
/** Dọn file quá hạn (best-effort, chạy thưa — mỗi lần put). Ảnh ~200KB nên hết hạn phải xoá, không để phình đĩa. */
function donPendingCu(): void {
  try {
    for (const f of fs.readdirSync(PENDING_DIR)) {
      if (!f.endsWith('.json')) continue;
      const meta = path.join(PENDING_DIR, f);
      try {
        const m = JSON.parse(fs.readFileSync(meta, 'utf8')) as { expiresAt?: number };
        if ((m.expiresAt ?? 0) >= Date.now()) continue;
        fs.rmSync(meta, { force: true });
        fs.rmSync(meta.replace(/\.json$/, '.bin'), { force: true });
      } catch { fs.rmSync(meta, { force: true }); }
    }
  } catch { /* thư mục chưa có / lỗi đọc — bỏ qua */ }
}
function putPending(buffer: Buffer, imageName: string): string {
  const token = randomUUID();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  pending.set(token, { buffer, imageName, expiresAt });
  for (const [k, v] of pending) if (v.expiresAt < Date.now()) pending.delete(k); // dọn RAM
  ensurePendingDir();
  const { bin, meta } = pendingPaths(token);
  try {
    fs.writeFileSync(bin, buffer);
    fs.writeFileSync(meta, JSON.stringify({ imageName, expiresAt }), 'utf8');
  } catch (err) {
    // Ghi đĩa hỏng KHÔNG chặn luồng (vẫn còn bản RAM) nhưng phải LOG — R198 cấm nuốt im.
    console.error('[ocr-send] không ghi được ảnh tạm ra đĩa (ảnh sẽ mất nếu restart):', err);
  }
  donPendingCu();
  return token;
}
function getPending(token: string): Pending | null {
  if (!laOcrTokenHopLe(token)) return null; // token lạ (kể cả "../..") → coi như hết hạn, KHÔNG chạm đĩa
  const p = pending.get(token);
  if (p && p.expiresAt >= Date.now()) return p;
  if (p) pending.delete(token);
  // RAM không có (vd vừa restart) → lấy lại từ ĐĨA.
  const { bin, meta } = pendingPaths(token);
  try {
    if (!fs.existsSync(bin) || !fs.existsSync(meta)) return null;
    const m = JSON.parse(fs.readFileSync(meta, 'utf8')) as { imageName?: string; expiresAt?: number };
    if ((m.expiresAt ?? 0) < Date.now()) { fs.rmSync(bin, { force: true }); fs.rmSync(meta, { force: true }); return null; }
    const rec: Pending = { buffer: fs.readFileSync(bin), imageName: m.imageName ?? 'bill.jpg', expiresAt: m.expiresAt ?? 0 };
    pending.set(token, rec);
    return rec;
  } catch { return null; }
}

// ── Guard path folder-scan. Admin Demo 30/8: BỎ GIỚI HẠN — cho quét MỌI thư mục TỒN TẠI (bill tải tay để đâu tuỳ
// anh). Vẫn chặn: chỉ nhận thư mục thật (không file/không tồn tại), chỉ đọc ẢNH, endpoint requireSession. Muốn
// siết lại: đặt env OCR_SEND_SCAN_ROOT=<gốc> → chỉ quét trong đó.
const SCAN_ROOT = process.env.OCR_SEND_SCAN_ROOT || '';
function isAllowedDir(target: string): boolean {
  try {
    const rp = fs.realpathSync(target);
    if (!fs.statSync(rp).isDirectory()) return false;
    if (!SCAN_ROOT) return true; // không cấu hình gốc → cho phép mọi thư mục tồn tại
    const rel = path.relative(fs.realpathSync(SCAN_ROOT), rp);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch { return false; }
}
const IMG_RE = /\.(jxl|jpg|jpeg|png|webp)$/i;
const SUSPECT_RE = /\.(heic|heif|pdf|bmp|tif|tiff|gif|jfif|avif)$/i;

// [Admin Demo 2/9 "cấm sót bill trong thư mục con"] QUÉT ĐỆ QUY folder (bill hay để trong thư mục con theo ngày/đại lý) —
// TRƯỚC ĐÂY chỉ đọc 1 cấp (readdirSync) → bill trong subfolder SÓT CÂM. Nay duyệt tới maxDepth cấp, bỏ thư mục ẩn/hệ
// thống. name = ĐƯỜNG DẪN TƯƠNG ĐỐI từ gốc (hiện rõ subfolder cho user). suspects = file đuôi lạ (nghi bill) mọi cấp.
export function walkFolderForBills(root: string, maxDepth = 5): { images: { path: string; name: string; mtime: number; size: number; alreadyOcr: boolean }[]; suspects: string[] } {
  const images: { path: string; name: string; mtime: number; size: number; alreadyOcr: boolean }[] = [];
  const suspects: string[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  const seen = new Set<string>(); // chống vòng lặp symlink
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth >= maxDepth || e.name.startsWith('.') || e.name === 'node_modules' || e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') continue;
        let real: string; try { real = fs.realpathSync(p); } catch { continue; }
        if (seen.has(real)) continue; seen.add(real);
        stack.push({ dir: p, depth: depth + 1 });
      } else if (e.isFile()) {
        if (IMG_RE.test(e.name)) {
          try { const st = fs.statSync(p); images.push({ path: p, name: path.relative(root, p), mtime: st.mtimeMs, size: st.size, alreadyOcr: false }); } catch { /* bỏ file lỗi stat */ }
        } else if (SUSPECT_RE.test(e.name)) {
          suspects.push(path.relative(root, p));
        }
      }
    }
  }
  return { images, suspects };
}

// POST /v1/ocr-send/ocr — THỦ CÔNG: multipart field "file" → OCR Sonnet@2400 → review. Trả {token, review}.
/** Dịch mã cảnh báo OCR bill QR (do qr-local-parse.mjs sinh) sang câu tiếng Việt cho người duyệt. */
function qrWarningsVi(codes: string[]): string[] {
  const MAP: Record<string, string> = {
    TEN_HKD_BI_CAT: '\u26a0 T\u00ean HKD tr\u00ean bill b\u1ecb app ng\u00e2n h\u00e0ng C\u1eaeT C\u1ee4T \u2014 \u0111\u1ed1i chi\u1ebfu m\u00e3 QR b\u1eb1ng "Check b\u00e1o c\u00f3" tr\u01b0\u1edbc khi g\u1eedi.',
    THIEU_TEN_HKD: '\u26a0 OCR kh\u00f4ng \u0111\u1ecdc \u0111\u01b0\u1ee3c T\u00caN HKD \u2014 b\u1ea5m "T\u00ecm m\u00e3 QR t\u1eeb b\u00e1o c\u00f3" \u0111\u1ec3 kh\u1edbp theo s\u1ed1 ti\u1ec1n + ng\u00e0y gi\u1edd.',
    SO_TIEN_DOC_KHONG_CHAC: '\ud83d\udd34 S\u1ed0 TI\u1ec0N \u0111\u1ecdc kh\u00f4ng ch\u1eafc \u2014 soi k\u1ef9 tr\u01b0\u1edbc khi g\u1eedi.',
    SO_TIEN_LE_BAT_THUONG: '\ud83d\udd34 S\u1ed0 TI\u1ec0N kh\u00f4ng tr\u00f2n ngh\u00ecn \u2014 nghi \u0111\u1ecdc l\u1ec7ch ch\u1eef s\u1ed1.',
    NGAY_GIO_DOC_KHONG_CHAC: '\u26a0 Ng\u00e0y/gi\u1edd \u0111\u1ecdc kh\u00f4ng ch\u1eafc \u2014 \u0111\u1ed1i chi\u1ebfu b\u00e1o c\u00f3.',
    SO_GIAO_DICH_SAI_DANG: '\ud83d\udd34 S\u1ed0 GIAO D\u1ecaCH sai \u0111\u1ecbnh d\u1ea1ng \u2014 nghi \u0111\u1ecdc l\u1ec7ch k\u00fd t\u1ef1.',
    SO_GIAO_DICH_DOC_KHONG_CHAC: '\u26a0 S\u1ed1 giao d\u1ecbch \u0111\u1ecdc kh\u00f4ng ch\u1eafc \u2014 \u0111\u1ed1i chi\u1ebfu b\u00e1o c\u00f3.',
    CLAUDE_KHONG_DOC_DUOC_BILL_QR: '\u26a0 L\u1ea7n \u0111\u1ecdc th\u1ee9 2 (Claude) kh\u00f4ng ra bill \u2014 \u0111ang d\u00f9ng k\u1ebft qu\u1ea3 OCR m\u00e1y, soi k\u1ef9.'
  };
  const out: string[] = [];
  for (const c of codes) {
    if (MAP[c]) { out.push(MAP[c]); continue; }
    if (c.startsWith('LECH_2_LAN_DOC')) out.push('\ud83d\udd34 HAI L\u1ea6N \u0110\u1eccC L\u1ec6CH NHAU (' + c.replace(/^LECH_2_LAN_DOC:\s*/, '') + ') \u2014 ki\u1ec3m tay.');
  }
  return out;
}

// POST /v1/ocr-send/rename-processed — [Admin Demo 8/9] app PC đổi tên ảnh sau OCR ("1 - Đã thành công - …") thì SỔ
// của OCR service (đã đọc + FAILED) phải dời theo, nếu không: quét lại tưởng ảnh mới, và sổ lỗi trỏ file đã mất.
// Best-effort (hỏng không chặn quét) nhưng KHÔNG nuốt im: trả rõ ok/false + lý do cho client ghi log.
ocrSendRouter.post('/v1/ocr-send/rename-processed', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { oldPath?: unknown; newPath?: unknown };
  const oldPath = String(b.oldPath ?? '').trim();
  const newPath = String(b.newPath ?? '').trim();
  if (!oldPath || !newPath) { res.status(400).json({ error: 'NO_PATH', message: 'Thiếu đường dẫn cũ/mới.' }); return; }
  const r = await ocrRenameProcessed(oldPath, newPath);
  res.json(r);
}));

// POST /v1/ocr-send/folder-report — [Admin Demo 8/9] QUÉT XONG FOLDER → bảng báo cáo NHƯ báo cáo lô, đủ từng lô lỗi gì.
// Số liệu lấy từ CHÍNH getRoomRevenueReport rồi lọc theo folder (không tự tính lại → không thể lệch báo cáo lô).
ocrSendRouter.post('/v1/ocr-send/folder-report', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const bills = Array.isArray(req.body?.bills) ? (req.body.bills as BillTrongFolder[]) : null;
  if (!bills || bills.length === 0) { res.status(400).json({ error: 'NO_BILLS', message: 'Chưa có bill nào để lên báo cáo.' }); return; }
  if (bills.length > 500) { res.status(400).json({ error: 'TOO_MANY', message: 'Quá 500 bill trong 1 lần — chia nhỏ folder.' }); return; }
  const rep = await buildFolderReport(getBotDb(), bills, layDayLoCungHo, new Date());
  res.json(rep);
}));

/** [Admin Demo 25/9] THÂN XỬ LÝ OCR 1 ẢNH — tách ra để DÙNG CHUNG cho đường đồng bộ (client cũ) và đường CHẠY NỀN
 *  (/ocr-async, chống Cloudflare cắt 100s ở máy ngoài). Trả payload y hệt nhau ⇒ client xử lý 1 kiểu. */
async function xuLyOcrAnh(
  buffer: Buffer,
  o: { force: boolean; opus: boolean; claude: boolean; preferQr: boolean }
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string; message: string }> {
  const r = await ocrBillImage(buffer, o.force, o.opus, o.claude, o.preferQr);
  if (r.failed) return { ok: false, status: 502, error: 'OCR_FAILED', message: r.failReason || 'OCR ảnh thất bại (thử lại).' };
  const token = putPending(buffer, 'bill.jpg');
  if (r.kind === 'TRANSFER') {
    const transferReview = await reviewTransfers(getBotDb(), r.transfers ?? []);
    await augmentTransferReviewWithSentKind(getBotDb(), transferReview, buffer);
    const cwT = consensusWarning(r.consensus ?? null);
    if (cwT) for (const it of transferReview) it.warnings = [cwT, ...it.warnings];
    return { ok: true, body: { ok: true, token, review: [], kind: 'TRANSFER', transferReview, cached: r.cached === true } };
  }
  if (r.kind === 'QR') {
    const { dealers } = await classifyOptions(getBotDb());
    const qrReview = await reviewQr(getBotDb(), r.qr ?? [], new Date(), dealers, 'bill.jpg');
    await augmentQrReviewWithSent(getBotDb(), qrReview, buffer);
    const cwQ = consensusWarning(r.consensus ?? null);
    if (cwQ) for (const it of qrReview) it.warnings = [cwQ, ...it.warnings];
    for (const w of qrWarningsVi(r.qrWarnings ?? [])) for (const it of qrReview) it.warnings = [...it.warnings, w];
    return { ok: true, body: { ok: true, token, review: [], kind: 'QR', qrReview, cached: r.cached === true } };
  }
  const posCorr = await applyPosBillCorrectionByImage(getBotDb(), r.bills, buffer);
  const review = await reviewBills(getBotDb(), r.bills, new Date());
  await augmentReviewWithImageHash(getBotDb(), review, buffer);
  if (posCorr.applied) for (const it of review) it.warnings = [...posCorr.warnings, ...it.warnings];
  const cw = consensusWarning(r.consensus ?? null);
  if (cw) for (const it of review) it.warnings = [cw, ...it.warnings];
  return { ok: true, body: { ok: true, token, review, kind: r.kind ?? 'POS', cached: r.cached === true } };
}

// POST /v1/ocr-send/ocr-async — TRẢ NGAY jobId (<1s), OCR chạy NỀN. Máy ngoài KHÔNG còn dính Cloudflare cắt 100s
// (ca thật: Gemini hết quota → Claude chạy 150s → 171 lần timeout → user báo "mất mạng").
ocrSendRouter.post('/v1/ocr-send/ocr-async', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const parsed = await parseSingleFileUpload(req);
  if (!parsed.ok) { res.status(400).json({ error: 'NO_FILE', message: 'Thiếu ảnh bill.' }); return; }
  const o = {
    force: req.query?.force === '1' || req.query?.force === 'true',
    opus: req.query?.opus === '1' || req.query?.opus === 'true',
    claude: req.query?.claude === '1' || req.query?.claude === 'true',
    preferQr: String(req.query?.prefer ?? '').toLowerCase() === 'qr'
  };
  const buf = parsed.buffer;
  const jobId = taoOcrJob(async () => {
    const kq = await xuLyOcrAnh(buf, o);
    if (!kq.ok) throw new Error(kq.message);
    return kq.body;
  });
  res.json({ ok: true, jobId });
}));

// GET /v1/ocr-send/ocr-job/:id — hỏi kết quả (trả trong mili-giây): RUNNING | DONE (kèm payload) | ERROR.
ocrSendRouter.get('/v1/ocr-send/ocr-job/:id', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const job = layOcrJob(String(req.params.id ?? ''));
  if (!job) { res.status(404).json({ error: 'JOB_NOT_FOUND', message: 'Phiên OCR đã hết hạn (quá 15 phút) — quét lại ảnh.' }); return; }
  if (job.status === 'RUNNING') { res.json({ ok: true, status: 'RUNNING', chayMs: Date.now() - job.taoLucMs }); return; }
  if (job.status === 'ERROR') { res.status(502).json({ status: 'ERROR', ...(job.loi ?? { error: 'OCR_FAILED', message: 'OCR thất bại.' }) }); return; }
  res.json({ ok: true, status: 'DONE', ketQua: job.ketQua });
}));

ocrSendRouter.post('/v1/ocr-send/ocr', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const parsed = await parseSingleFileUpload(req);
  if (!parsed.ok) { res.status(400).json({ error: 'NO_FILE', message: 'Thiếu ảnh bill.' }); return; }
  const forceImg = req.query?.force === '1' || req.query?.force === 'true'; // [Admin Demo 3/9] "Quét lại" → bỏ cache.
  const opusImg = req.query?.opus === '1' || req.query?.opus === 'true'; // [Admin Demo 4/9] escalate Opus (bill nghi đọc sai ngày).
  const claudeImg = req.query?.claude === '1' || req.query?.claude === 'true'; // [Admin Demo 8/9] "Đọc lại bằng Claude".
  const preferQrImg = String(req.query?.prefer ?? '').toLowerCase() === 'qr'; // tab "Quét QR" → ép nhánh QR
  const r = await ocrBillImage(parsed.buffer, forceImg, opusImg, claudeImg, preferQrImg);
  if (r.failed) { res.status(502).json({ error: 'OCR_FAILED', message: r.failReason || 'OCR ảnh thất bại (thử lại).' }); return; }
  const token = putPending(parsed.buffer, 'bill.jpg');
  if (r.kind === 'TRANSFER') { // BILL CHUYỂN KHOẢN HOÀN TIỀN ĐẠI LÝ → review riêng (không cần TID), gửi CHỈ đại lý.
    const transferReview = await reviewTransfers(getBotDb(), r.transfers ?? []);
    await augmentTransferReviewWithSentKind(getBotDb(), transferReview, parsed.buffer); // [Admin Demo 3/9] khôi phục kind (ứng/hoàn) đã gửi
    const cwT = consensusWarning(r.consensus ?? null);
    if (cwT) for (const it of transferReview) it.warnings = [cwT, ...it.warnings];
    res.json({ ok: true, token, review: [], kind: 'TRANSFER', transferReview, cached: r.cached === true });
    return;
  }
  if (r.kind === 'QR') { // [Đợt 2] BILL QR bán hàng ("Thanh toán thành công") → review riêng (match HKD, phí bán, dedup ref).
    const { dealers } = await classifyOptions(getBotDb());
    const qrReview = await reviewQr(getBotDb(), r.qr ?? [], new Date(), dealers, 'bill.jpg');
    await augmentQrReviewWithSent(getBotDb(), qrReview, parsed.buffer); // [Admin Demo 11/9] đã gửi theo ẢNH (kể cả ref/tiền đã sửa) → khoá + log đối chiếu
    const cwQ = consensusWarning(r.consensus ?? null);
    if (cwQ) for (const it of qrReview) it.warnings = [cwQ, ...it.warnings];
    // [Admin Demo 8/9] Cảnh báo của tầng OCR (tên HKD bị app cắt, số tiền/số GD đọc không chắc, 2 lần đọc lệch…)
    // PHẢI lên tới thẻ review — R198 cấm nuốt. Nguồn 'local' = OCR máy (0 quota), 'claude' = đã đọc lại lần 2.
    for (const w of qrWarningsVi(r.qrWarnings ?? [])) for (const it of qrReview) it.warnings = [...it.warnings, w];
    res.json({ ok: true, token, review: [], kind: 'QR', qrReview, cached: r.cached === true });
    return;
  }
  // [Admin Demo 11/9 "CẤM OCR lại ra thông số CŨ"] Áp BẢN SỬA gần nhất theo ẢNH (posBill tin đã gửi) TRƯỚC reviewBills
  // → routing/phí tính theo số ĐÚNG; card mang ghi chú đối chiếu "OCR gốc: …" (không âm thầm).
  const posCorr = await applyPosBillCorrectionByImage(getBotDb(), r.bills, parsed.buffer);
  const review = await reviewBills(getBotDb(), r.bills, new Date());
  await augmentReviewWithImageHash(getBotDb(), review, parsed.buffer); // [Admin Demo 3/9] nhận "đã gửi" theo ẢNH → khóa gửi-mới
  if (posCorr.applied) for (const it of review) it.warnings = [...posCorr.warnings, ...it.warnings];
  const cw = consensusWarning(r.consensus ?? null); // đọc 2 lần lệch → cờ đỏ mọi bill của ảnh này
  if (cw) for (const it of review) it.warnings = [cw, ...it.warnings];
  res.json({ ok: true, token, review, kind: r.kind ?? 'POS', cached: r.cached === true });
}));

// GET /v1/ocr-send/lot-gaps?days=N — [Admin Demo 2/9] ĐỐI SOÁT LÔ SÓT trên DB `los` (LƯỚI CUỐI, độc lập đường nạp):
// mỗi TID+ngày có lô nhảy số → trả về để UI cảnh báo đỏ. Bắt lô 94-kiểu-sót dù lọt ở app-scan/watcher/recovery.
// GET /v1/ocr-send/tid-list — [Admin Demo 18/9 "gợi ý trong màn sửa chưa?"] DANH SÁCH TOÀN BỘ máy {tid, hkdName}
// cho dropdown chọn TÊN HKD ở màn SỬA BILL (BillParamEditModal) — bill OCR mù cả TID lẫn tên vẫn sửa được bằng
// cách chọn tên máy. Session-gate như mọi route ocr-send; chỉ đọc, không lộ gì ngoài tên máy nội bộ.
ocrSendRouter.get('/v1/ocr-send/tid-list', asyncHandler(requireSession), asyncHandler(async (_req: Request, res: Response) => {
  const db = getBotDb();
  const rows = await db.tid.findMany({ where: { deletedAt: null }, select: { tid: true, hkdName: true } });
  const list = rows
    .filter((r) => r.hkdName)
    .map((r) => ({ tid: r.tid, hkdName: r.hkdName as string }))
    .sort((a, b) => a.hkdName.localeCompare(b.hkdName, 'vi'));
  res.json({ ok: true, list });
}));

ocrSendRouter.get('/v1/ocr-send/lot-gaps', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  // [Admin Demo 7/9] Ưu tiên from/to ISO (để panel báo cáo khớp ĐÚNG kỳ đang xem, kể cả quá khứ); fallback days-từ-nay.
  const days = Math.min(31, Math.max(1, Number(req.query.days) || 3));
  const qFrom = req.query.from ? new Date(String(req.query.from)) : null;
  const qTo = req.query.to ? new Date(String(req.query.to)) : null;
  const to = qTo && !Number.isNaN(qTo.getTime()) ? qTo : new Date();
  const from = qFrom && !Number.isNaN(qFrom.getTime()) ? qFrom : new Date(to.getTime() - days * 86_400_000);
  const gaps = await findLotGaps(getBotDb(), { from, to });
  res.json({ ok: true, data: { days, gaps } });
}));

// POST /v1/ocr-send/scan — TỰ ĐỘNG: body {folder} → danh sách file ảnh bill trong folder (mới nhất trước).
ocrSendRouter.post('/v1/ocr-send/scan', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const folder = String((req.body?.folder ?? '')).trim();
  if (!folder) { res.status(400).json({ error: 'NO_FOLDER', message: 'Thiếu đường dẫn folder.' }); return; }
  if (!isAllowedDir(folder)) { res.status(403).json({ error: 'FOLDER_NOT_ALLOWED', message: SCAN_ROOT ? `Chỉ quét trong ${SCAN_ROOT}.` : 'Folder không tồn tại hoặc không phải thư mục.' }); return; }
  let walked: ReturnType<typeof walkFolderForBills>;
  try { walked = walkFolderForBills(folder); } catch { res.status(400).json({ error: 'FOLDER_READ', message: 'Không đọc được folder.' }); return; }
  const files = walked.images.sort((a, b) => b.mtime - a.mtime);
  // [Admin Demo 2/9] File đuôi lạ (heic/pdf/bmp...) nghi bill — MỌI CẤP (đệ quy) → cảnh báo, chống lọt đếm câm.
  const suspectBillFiles = walked.suspects;
  // ĐÁNH DẤU file ĐÃ ĐỌC (sổ file-đã-đọc ở OCR service) → "bill mới" = chưa đọc. Bill mới lên ĐẦU (xử trước).
  const proc = await processedStatus(files.map((f) => f.path));
  for (const f of files) f.alreadyOcr = proc[f.path] === true;
  files.sort((a, b) => (a.alreadyOcr === b.alreadyOcr ? b.mtime - a.mtime : a.alreadyOcr ? 1 : -1));
  const newCount = files.filter((f) => !f.alreadyOcr).length;
  res.json({ ok: true, count: files.length, newCount, files, suspectBillCount: suspectBillFiles.length, suspectBillFiles: suspectBillFiles.slice(0, 50) });
}));

// POST /v1/ocr-send/ocr-file — TỰ ĐỘNG: body {path} → OCR 1 file trong folder → {token, review}.
ocrSendRouter.post('/v1/ocr-send/ocr-file', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const filePath = String((req.body?.path ?? '')).trim();
  if (!filePath || !isAllowedDir(path.dirname(filePath))) { res.status(403).json({ error: 'PATH_NOT_ALLOWED', message: 'Đường dẫn không hợp lệ.' }); return; }
  if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'NOT_FOUND', message: 'File không tồn tại.' }); return; }
  const force = req.body?.force === true || req.body?.force === 'true'; // [Admin Demo 3/9] "Quét lại ảnh này" → đọc lại, bỏ cache.
  const opus = req.body?.opus === true || req.body?.opus === 'true'; // [Admin Demo 4/9] escalate Opus.
  const claude = req.body?.claude === true || req.body?.claude === 'true'; // [Admin Demo 8/9] "Đọc lại bằng Claude".
  const preferQr = String(req.body?.prefer ?? '').toLowerCase() === 'qr';
  const r = await ocrBillFile(filePath, force, opus, claude, preferQr);
  if (r.failed) { res.status(502).json({ error: 'OCR_FAILED', message: r.failReason || 'OCR file thất bại.' }); return; }
  const fileBuf = fs.readFileSync(filePath); // dùng CHUNG cho token pending + hash ảnh (khớp hash lúc gửi)
  const token = putPending(fileBuf, path.basename(filePath));
  if (r.kind === 'TRANSFER') {
    const transferReview = await reviewTransfers(getBotDb(), r.transfers ?? []);
    await augmentTransferReviewWithSentKind(getBotDb(), transferReview, fileBuf); // [Admin Demo 3/9] khôi phục kind (ứng/hoàn) đã gửi
    const cwT = consensusWarning(r.consensus ?? null);
    if (cwT) for (const it of transferReview) it.warnings = [cwT, ...it.warnings];
    res.json({ ok: true, token, review: [], kind: 'TRANSFER', transferReview, cached: r.cached === true });
    return;
  }
  if (r.kind === 'QR') { // [Đợt 2] BILL QR bán hàng → review riêng. folderHint = filePath → default đại lý theo tên folder.
    const { dealers } = await classifyOptions(getBotDb());
    const qrReview = await reviewQr(getBotDb(), r.qr ?? [], new Date(), dealers, filePath);
    await augmentQrReviewWithSent(getBotDb(), qrReview, fileBuf); // [Admin Demo 11/9] đã gửi theo ẢNH (kể cả ref/tiền đã sửa) → khoá + log đối chiếu
    const cwQ = consensusWarning(r.consensus ?? null);
    if (cwQ) for (const it of qrReview) it.warnings = [cwQ, ...it.warnings];
    // [Admin Demo 8/9] Cảnh báo của tầng OCR (tên HKD bị app cắt, số tiền/số GD đọc không chắc, 2 lần đọc lệch…)
    // PHẢI lên tới thẻ review — R198 cấm nuốt. Nguồn 'local' = OCR máy (0 quota), 'claude' = đã đọc lại lần 2.
    for (const w of qrWarningsVi(r.qrWarnings ?? [])) for (const it of qrReview) it.warnings = [...it.warnings, w];
    res.json({ ok: true, token, review: [], kind: 'QR', qrReview, cached: r.cached === true });
    return;
  }
  // [Admin Demo 11/9 "CẤM OCR lại ra thông số CŨ"] Áp BẢN SỬA gần nhất theo ẢNH (posBill tin đã gửi) TRƯỚC reviewBills
  // → routing/phí theo số ĐÚNG; card mang ghi chú đối chiếu "OCR gốc: …" — đây chính là ca "quét lại folder" của bug.
  const posCorr = await applyPosBillCorrectionByImage(getBotDb(), r.bills, fileBuf);
  const review = await reviewBills(getBotDb(), r.bills, new Date());
  await augmentReviewWithImageHash(getBotDb(), review, fileBuf); // [Admin Demo 3/9] nhận "đã gửi" theo ẢNH → khóa gửi-mới
  if (posCorr.applied) for (const it of review) it.warnings = [...posCorr.warnings, ...it.warnings];
  const cw = consensusWarning(r.consensus ?? null);
  if (cw) for (const it of review) it.warnings = [cw, ...it.warnings];
  res.json({ ok: true, token, review, kind: r.kind ?? 'POS', cached: r.cached === true });
}));

// POST /v1/ocr-send/prepare-edit — [Admin Demo 7/9] MỞ bill ĐÃ GỬI để SỬA bằng ĐÚNG card review OCR (1 render gốc). Nạp
// ẢNH tin cũ → token (KHÔNG OCR lại, giữ đúng ảnh → cùng hash) + review item từ bill ĐÃ LƯU (posBill) → client render
// BillReviewCard y hệt OCR. Sửa xong "Gửi" → sendBill(token) → bug #1 (findSentByImageHashGlobal khớp hash) tự CẬP NHẬT
// tin cũ + ghi lại doanh số + sổ (KHÔNG tạo mới). Gate mật khẩu sửa (chỉ người SigMa mở được).
ocrSendRouter.post('/v1/ocr-send/prepare-edit', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const db = getBotDb();
  const b = (req.body ?? {}) as { messageId?: string; editPassword?: string };
  if (!b.messageId) { res.status(400).json({ error: 'VALIDATION', message: 'Thiếu messageId.' }); return; }
  if (!(await verifyBillEditPassword(db, String(b.editPassword ?? '')))) { res.status(403).json({ error: 'BAD_PASSWORD', message: 'Sai mật khẩu sửa.' }); return; }
  const msg = await db.chatMessage.findUnique({ where: { id: String(b.messageId) }, select: { id: true, body: true, metadataJson: true, attachmentId: true, roomId: true } });
  if (!msg) { res.status(404).json({ error: 'NOT_FOUND', message: 'Không tìm thấy tin bill.' }); return; }
  // Resolve về tin GỐC đại lý (nếu mở từ mirror NĐT) — sửa từ tin gốc để cascade đúng (như editBillParams).
  let meta: { posBill?: Record<string, unknown>; alphaCrossPostSourceId?: unknown } = {};
  try { meta = JSON.parse(msg.metadataJson ?? '{}'); } catch { /* meta hỏng */ }
  let source = msg;
  if (meta.alphaCrossPostSourceId) {
    const s = await db.chatMessage.findUnique({ where: { id: String(meta.alphaCrossPostSourceId) }, select: { id: true, body: true, metadataJson: true, attachmentId: true, roomId: true } });
    if (s) { source = s; try { meta = JSON.parse(s.metadataJson ?? '{}'); } catch { /* */ } }
  }
  // [Admin Demo 11/9 — "nút Sửa ở giao dịch hoàn tiền bill CK không ra màn review như bill POS"] Bill CHUYỂN KHOẢN
  // (hoàn đại lý / ứng trước / đại lý trả về / tạm ứng NĐT / hoàn thừa NĐT) cũng phải mở ĐÚNG card review CK.
  // Dữ liệu dựng TỪ METADATA đã lưu lúc gửi (không OCR lại, giữ nguyên ảnh gốc → cùng hash → gửi lại = CẬP NHẬT).
  const mck = meta as Record<string, unknown>;
  if (mck['isTransferRefund'] === true) {
    if (!source.attachmentId) { res.status(404).json({ error: 'NO_IMAGE', message: 'Bill CK này không có ảnh gốc — không mở sửa bằng review được.' }); return; }
    const attCk = await getAttachmentFile(db, source.attachmentId);
    if (!attCk) { res.status(404).json({ error: 'NO_IMAGE', message: 'Ảnh bill CK không còn trên đĩa.' }); return; }
    let bufCk: Buffer;
    try { bufCk = fs.readFileSync(attCk.filePath); } catch { res.status(404).json({ error: 'NO_IMAGE', message: 'Không đọc được ảnh bill CK.' }); return; }
    const soTien = Math.abs(Number(mck['refundAmount'] ?? mck['advanceAmount'] ?? mck['repaymentAmount'] ?? 0)) || 0;
    const ngayIso = typeof mck['billDate'] === 'string' ? String(mck['billDate']) : null; // YYYY-MM-DD
    const ngayDmy = ngayIso && /^\d{4}-\d{2}-\d{2}$/.test(ngayIso) ? `${ngayIso.slice(8, 10)}/${ngayIso.slice(5, 7)}/${ngayIso.slice(0, 4)}` : null;
    const gio = typeof mck['billTime'] === 'string' ? String(mck['billTime']) : null;
    const huong = typeof mck['direction'] === 'string' ? String(mck['direction']) : (mck['isDealerAdvanceCk'] === true ? 'SIGMA_TO_DEALER_ADVANCE' : Number(mck['refundAmount'] ?? 0) < 0 ? 'DEALER_TO_ALPHA' : 'SIGMA_TO_DEALER');
    const laNdt = mck['isInvestorAdvanceCk'] === true || mck['isInvestorRepaymentCk'] === true;
    const phong = await db.chatRoom.findUnique({ where: { id: source.roomId ?? '' }, select: { id: true, name: true } }).catch(() => null);
    const trReview = {
      senderName: typeof mck['senderName'] === 'string' ? String(mck['senderName']) : null,
      senderIsAlpha: huong.startsWith('SIGMA_TO_'),
      senderAccount: null,
      receiverName: typeof mck['receiverName'] === 'string' ? String(mck['receiverName']) : null,
      receiverAccount: null,
      content: null,
      amount: soTien,
      bank: null,
      senderBank: null,
      date: ngayDmy,
      time: gio,
      matchedRoomId: phong?.id ?? null,
      matchedRoomName: phong?.name ?? null,
      needsManualPick: false,
      warnings: ['ℹ Đang SỬA bill CK đã gửi — sửa xong bấm Gửi để CẬP NHẬT chính tin cũ (không đăng trùng).'],
      direction: huong as 'SIGMA_TO_DEALER' | 'SIGMA_TO_DEALER_ADVANCE' | 'DEALER_TO_ALPHA' | 'INVESTOR_TO_ALPHA' | 'SIGMA_TO_INVESTOR',
      entityType: (laNdt ? 'INVESTOR' : 'DEALER') as 'INVESTOR' | 'DEALER',
      entityId: laNdt && mck['investorId'] != null ? Number(mck['investorId']) : null,
      alreadySent: true,
      ckTxnKey: typeof mck['ckTxnKey'] === 'string' ? String(mck['ckTxnKey']) : null
    };
    const tokenCk = putPending(bufCk, attCk.fileName);
    res.json({ ok: true, token: tokenCk, review: [], transferReview: [trReview], kind: 'CK', editMessageId: source.id });
    return;
  }
  const pb = (meta.posBill ?? {}) as { tid?: unknown; hkd?: unknown; lo?: unknown; amount?: unknown; dateTime?: unknown; settlementCode?: unknown };
  if (!source.attachmentId) { res.status(404).json({ error: 'NO_IMAGE', message: 'Bill này không có ảnh gốc — không mở sửa bằng review được (dùng nút sửa nhanh).' }); return; }
  const att = await getAttachmentFile(db, source.attachmentId);
  if (!att) { res.status(404).json({ error: 'NO_IMAGE', message: 'Ảnh bill không còn trên đĩa.' }); return; }
  let buf: Buffer;
  try { buf = fs.readFileSync(att.filePath); } catch { res.status(404).json({ error: 'NO_IMAGE', message: 'Không đọc được ảnh bill.' }); return; }
  const token = putPending(buf, att.fileName);
  const bill = {
    tid: pb.tid != null ? String(pb.tid) : null,
    agencyName: pb.hkd != null ? String(pb.hkd) : null,
    batchNumber: pb.lo != null ? String(pb.lo) : null,
    type: (String(pb.settlementCode ?? '') === '95' ? 'SETTLEMENT' : 'SALE') as 'SALE' | 'SETTLEMENT',
    totalAmount: Number(pb.amount) || 0,
    dateTime: pb.dateTime != null ? String(pb.dateTime) : null,
    settlementCode: pb.settlementCode != null ? String(pb.settlementCode) : null
  };
  const review = await reviewBills(db, [bill], new Date());
  await augmentReviewWithImageHash(db, review, buf); // đánh dấu "đã gửi" (đúng — để card hiện trạng thái + gửi = cập nhật)
  // [Admin Demo 8/9] Gắn THẺ ĐANG GHI của lô (và tách thẻ) → card review mở đúng thẻ thực tế, không nhảy về thẻ mặc
  // định (sửa ngày/giờ mà vô tình đổi phí sang thẻ khác = sai tiền câm). Lỗi tra lô → bỏ qua (card về mặc định như cũ).
  try {
    if (bill.tid && bill.batchNumber && review[0]) {
      const bot = await ensureSupportAlphaAgent(db);
      // [A-M7 21/9] GIỮ dạng lô "84(95)" — strip hết ký-tự-không-số làm key thành nat|tid|8495| không khớp
      // billKey thật → card mở sửa rơi về thẻ mặc định (người lưu là đổi phí câm). Chỉ bỏ khoảng trắng.
      const key = `nat|${bill.tid}|${String(bill.batchNumber).replace(/[^0-9()]/g, '')}|`;
      const lo = await db.lo.findFirst({ where: { agentId: bot.id, billKey: { startsWith: key }, status: { not: 'CANCELLED' } }, orderBy: { id: 'desc' }, select: { id: true } });
      if (lo) {
        const rows = await db.loRow.findMany({ where: { loId: lo.id }, select: { cardTypeId: true, amountBeforeFee: true } });
        if (rows.length === 1) review[0].currentCardTypeId = rows[0].cardTypeId;
        else if (rows.length > 1) review[0].currentSplits = rows.map((r) => ({ cardTypeId: r.cardTypeId as number, amount: Number(r.amountBeforeFee) }));
      }
    }
  } catch (err) { console.error('[prepare-edit] không đọc được thẻ đang ghi của lô:', err); }
  res.json({ ok: true, token, review, kind: 'POS', editMessageId: source.id });
}));

// POST /v1/ocr-send/send-transfer — GỬI + GHI bill CHUYỂN KHOẢN theo 4 HƯỚNG (Admin Demo 31/8). BẢO MẬT 2 CHIỀU:
// DEALER → CHỈ nhóm đại lý (matchedRoomId); INVESTOR → CHỈ nhóm NĐT (investor_chat_groups theo entityId). Server
// tự phân nhánh theo transfer.direction — KHÔNG tin room client cho phía NĐT (resolve lại từ entityId).
ocrSendRouter.post('/v1/ocr-send/send-transfer', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { token?: string; transfer?: TransferReview };
  const p = body.token ? getPending(body.token) : null;
  if (!p) { res.status(404).json({ error: 'EXPIRED', message: 'Ảnh bill hết hạn — quét lại.' }); return; }
  const t = body.transfer;
  if (!t || !t.direction || t.direction === 'UNKNOWN') { res.status(400).json({ error: 'NO_DIRECTION', message: 'Chưa phân loại hướng bill — chọn tay (loại + đại lý/NĐT) trước khi gửi.' }); return; }
  const r = await sendTransferByDirection(getBotDb(), t, p.buffer, p.imageName, new Date());
  if (!r.ok) {
    // Chưa khớp entity/room (chọn tay) → 400; lỗi gửi/ghi thật → 502.
    const clientErr = r.error === 'NO_ROOM_MATCH' || r.error === 'NO_INVESTOR' || r.error === 'NO_INVESTOR_ROOM' || r.error === 'UNKNOWN_DIRECTION' || r.error === 'NOT_ADVANCE';
    res.status(clientErr ? 400 : 502).json({ error: r.error ?? 'SEND_FAIL', message: r.message ?? 'Không gửi được bill.' });
    return;
  }
  // dealerMessageId giữ cho tương thích client cũ; thêm target/roomId/messageId/recorded cho 4 hướng.
  res.json({ ok: true, direction: r.direction, target: r.target, roomId: r.roomId, messageId: r.messageId, dealerMessageId: r.target === 'DEALER' ? r.messageId : undefined, recorded: r.recorded === true, deduped: r.deduped === true });
}));

// POST /v1/ocr-send/classify-options — danh sách đại lý + NĐT cho DROPDOWN phân-loại-tay bill CK (Admin Demo 31/8).
ocrSendRouter.post('/v1/ocr-send/classify-options', asyncHandler(requireSession), asyncHandler(async (_req: Request, res: Response) => {
  res.json(await classifyOptions(getBotDb())); // trả {dealers,investors} TRỰC TIẾP (jsonCall client tự bọc {ok,data} — tránh double-wrap).
}));

// POST /v1/ocr-send/classify-alias — user phân-loại-tay 1 bill CK → GHI alias-HỌC (last-wins, sửa được) → lần sau
// tự nhận. body: {name, account, entityType:'DEALER'|'INVESTOR', entityId?, roomId?}. name/account = ĐỐI TÁC (phía
// không-SigMa, frontend truyền đúng phía theo LOẠI đã chọn). Trả direction để frontend cập nhật review.
ocrSendRouter.post('/v1/ocr-send/classify-alias', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { name?: string; account?: string; entityType?: string; entityId?: number; roomId?: string; label?: string; direction?: string };
  if (b.entityType !== 'DEALER' && b.entityType !== 'INVESTOR') { res.status(400).json({ error: 'VALIDATION', message: 'entityType phải DEALER hoặc INVESTOR.' }); return; }
  if (b.entityType === 'DEALER' && !b.roomId) { res.status(400).json({ error: 'VALIDATION', message: 'Chọn nhóm đại lý.' }); return; }
  if (b.entityType === 'INVESTOR' && b.entityId == null) { res.status(400).json({ error: 'VALIDATION', message: 'Chọn NĐT.' }); return; }
  if (!b.name && !b.account) { res.status(400).json({ error: 'VALIDATION', message: 'Thiếu tên/STK đối tác để học.' }); return; }
  const r = recordClassifyAlias({ name: b.name ?? null, account: b.account ?? null, entityType: b.entityType, entityId: b.entityId ?? null, roomId: b.roomId ?? null, label: b.label });
  res.json({ ok: r.ok });
}));

// POST /v1/ocr-send/save-transfer-correction — [Admin Demo 4/9 "đã sửa tay thì re-OCR phải trả trạng thái sửa gần nhất"]
// LƯU bản sửa phân loại CK (hướng ứng/hoàn + đối tác) THEO ẢNH (hash từ buffer token) → augment khôi phục khi OCR lại,
// mọi phiên/máy (alias chỉ nhớ đối tác, KHÔNG nhớ hướng). body {token, direction, entityType, entityId?, roomId?, roomName?}.
ocrSendRouter.post('/v1/ocr-send/save-transfer-correction', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { token?: string; direction?: string; entityType?: string; entityId?: number | null; roomId?: string | null; roomName?: string | null };
  const p = b.token ? getPending(b.token) : null;
  if (!p) { res.status(404).json({ error: 'EXPIRED', message: 'Ảnh hết hạn — quét lại rồi sửa phân loại.' }); return; }
  if (!b.direction) { res.status(400).json({ error: 'VALIDATION', message: 'Thiếu hướng phân loại.' }); return; }
  const entityType = b.entityType === 'DEALER' || b.entityType === 'INVESTOR' ? b.entityType : null;
  const r = saveTransferCorrectionByBuffer(p.buffer, { direction: b.direction as TransferReview['direction'], entityType, entityId: b.entityId ?? null, roomId: b.roomId ?? null, roomName: b.roomName ?? null });
  res.json({ ok: r.ok });
}));

// POST /v1/ocr-send/sender-bank-alias — HỌC "NGÂN HÀNG NGƯỜI GỬI" bill CK (Admin Demo 2/9). OCR chỉ đọc bank bên
// NHẬN → user khai báo bank người GỬI 1 lần → cache theo STK+tên → lần sau tự nhận (cột "NH gửi"). body {account?,
// name?, bank}. Cần bank + (account HOẶC name). senderBank CHỈ là nhãn — KHÔNG đụng tiền/dedup.
ocrSendRouter.post('/v1/ocr-send/sender-bank-alias', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { account?: string; name?: string; bank?: string };
  const bank = (b.bank ?? '').toString().trim();
  if (!bank) { res.status(400).json({ error: 'VALIDATION', message: 'Thiếu tên ngân hàng người gửi.' }); return; }
  if (!b.account && !b.name) { res.status(400).json({ error: 'VALIDATION', message: 'Thiếu STK/tên người gửi để ghi nhớ.' }); return; }
  const r = recordSenderBankAlias({ account: b.account ?? null, name: b.name ?? null, bank });
  if (!r.ok) { res.status(400).json({ error: 'VALIDATION', message: 'Không ghi được ghi nhớ (thiếu dữ liệu hợp lệ).' }); return; }
  res.json({ ok: true });
}));

// GET /v1/ocr-send/image?token= — ảnh preview (jpeg downscale) của token (cho UI hiện). Hết hạn → 404.
ocrSendRouter.get('/v1/ocr-send/image', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const p = getPending(String(req.query.token ?? ''));
  if (!p) { res.status(404).json({ error: 'EXPIRED', message: 'Ảnh hết hạn — quét lại.' }); return; }
  try {
    const jpg = await makePreviewJpeg(p.buffer);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(jpg);
  } catch { res.status(500).json({ error: 'IMG_FAIL', message: 'Không dựng được ảnh preview.' }); }
}));

// POST /v1/ocr-send/fee — phí theo (tid, tổng, thẻ|tách-thẻ). Client gọi khi người chọn thẻ / sửa tiền / tách thẻ.
// Trả {sell, install} (FeeLine). splits = [{cardTypeId, amount}] (thẻ chính + thẻ khác); không có → thẻ mặc định.
ocrSendRouter.post('/v1/ocr-send/fee', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const tid = String(req.body?.tid ?? '').trim();
  const amount = Number(req.body?.amount) || 0;   // TỔNG QUẸT trên bill
  const voidAmount = Number(req.body?.voidAmount) || 0; // tiền GD HỦY (nếu có)
  if (!tid || !(amount > 0)) { res.status(400).json({ error: 'BAD', message: 'Thiếu TID hoặc số tiền.' }); return; }
  // [18/9] Xem-trước phí phải đi CÙNG ĐƯỜNG với lúc gửi: cùng chuanHoaSplitsTruHuy, cùng tienGhiNhan. Nếu không,
  // số hiện trên màn review khác số server ghi lúc /send đúng phần tiền hủy (split-brain).
  const billLike = { totalAmount: amount, voidAmount };
  const chuan = chuanHoaSplitsTruHuy(parseSplits(req.body?.splits), billLike);
  if (!chuan) { res.status(400).json({ error: 'SPLIT_SUM_MISMATCH', message: 'Tổng các dòng tách thẻ không khớp tổng bill.' }); return; }
  const r = await computeFeesFor(getBotDb(), tid, tienGhiNhan(billLike), chuan.splits);
  res.json({ ok: true, sell: r.sell, install: r.install, ghiChuHuy: chuan.ghiChu });
}));

// POST /v1/ocr-send/reroute — [Admin Demo 5/9] TID sửa/chọn sang máy KHÁC trên card review → RE-RESOLVE routing (phòng
// đại lý/NĐT) + loại thẻ + thẻ mặc định + HKD/bank cho TID MỚI. Client cập nhật state → nút Gửi mở khoá được cho TID
// đúng (trước đây chọn TID gợi ý chỉ đổi text, availableCardTypes/dealerRoomId vẫn rỗng → Gửi kẹt câm mãi). Định tuyến
// LUÔN từ server (KHÔNG để client bịa phí/phòng — money-safety); bill gửi thật vẫn re-resolve lại ở /send.
ocrSendRouter.post('/v1/ocr-send/reroute', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const tid = String(req.body?.tid ?? '').trim();
  if (!tid) { res.status(400).json({ error: 'BAD', message: 'Thiếu TID.' }); return; }
  const r = await rerouteBillForTid(getBotDb(), tid);
  res.json({ ok: true, ...r });
}));

// POST /v1/ocr-send/send — GỬI 1 bill (đã review/sửa). Body {token, bill:{tid,batchNumber,dateTime,totalAmount,
// agencyName,type}, allowDuplicate}. ROUTING + PHÍ tra LẠI ở SERVER theo tid (KHÔNG tin room/phí client gửi).
ocrSendRouter.post('/v1/ocr-send/send', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const db = getBotDb();
  const token = String(req.body?.token ?? '');
  const p = getPending(token);
  if (!p) { res.status(410).json({ error: 'EXPIRED', message: 'Ảnh hết hạn — quét lại rồi gửi.' }); return; }
  // [Phản biện 11/9 — BILL 95 RỚT CỜ Ở GỬI] Dùng parseClientBill (1 nguồn định nghĩa) thay vì tự dựng tay từng
  // field: bản dựng-tay cũ RƠI `settlementCode` → cảnh báo ĐÓNG LÔ 95 không bao giờ ghim lên tin gửi thật.
  const bill: OcrBill = parseClientBill((req.body?.bill ?? {}) as Record<string, unknown>);
  if (!bill.tid) { res.status(400).json({ error: 'NO_TID', message: 'Thiếu TID — nhập tay trước khi gửi.' }); return; }
  if (!(bill.totalAmount > 0)) { res.status(400).json({ error: 'NO_AMOUNT', message: 'Thiếu số tiền.' }); return; }

  const routing = await resolveBillRouting(db, bill.tid);
  if (!routing.dealerRoomId) { res.status(422).json({ error: 'NO_DEALER_ROOM', message: routing.warnings.join(' ') || 'Không tìm được nhóm đại lý cho TID này.' }); return; }
  // [Admin Demo 7/9 — MƯỢN TID] Đại lý A quẹt nhờ TID của B → doanh số + TIN BILL về A (người mượn), CẤM gửi phòng B (chủ
  // TID cho mượn). Client tích "Mượn TID" + chọn đại lý mượn (dropdown = roomId). Resolve customerId (customer_chat_groups
  // active). GỬI ĐÚNG PHÒNG A: dealerRoomId = phòng mượn (thay phòng chủ TID). Fail-closed: phòng mượn không có khách → 422.
  let dealerRoomId: string = routing.dealerRoomId; // phòng GỬI + ghi doanh số (mặc định = chủ TID; override khi MƯỢN)
  let borrowedByCustomerId: number | undefined;
  const borrowedRoomId = typeof req.body?.borrowedByRoomId === 'string' && req.body.borrowedByRoomId.trim() ? req.body.borrowedByRoomId.trim() : null;
  if (borrowedRoomId) {
    const g = await db.customerChatGroup.findFirst({ where: { roomId: borrowedRoomId, unassignedAt: null }, select: { customerId: true } });
    if (!g) { res.status(422).json({ error: 'BORROW_ROOM_INVALID', message: 'Phòng đại lý MƯỢN không hợp lệ (không có khách đang gán).' }); return; }
    borrowedByCustomerId = g.customerId;
    dealerRoomId = borrowedRoomId; // GỬI + ghi doanh số vào phòng ĐẠI LÝ MƯỢN (KHÔNG phòng chủ TID).
  }
  // CRITICAL-1 (phản biện 4/9): phí HIỂN THỊ (đại lý/NĐT) PHẢI tính ở NGÀY TRÊN BILL — GIỐNG lúc GHI doanh số bên dưới
  // — để giảm-phí-cuối-tuần MB/MBV hiển thị == phí thực ghi (hết split-brain). `billTxn` dùng CHUNG cho tính phí + txnDate.
  const billTxn = resolveBillTxnDate(bill.dateTime);
  const at = billTxn ?? new Date();
  // Tách thẻ (tuỳ chọn) — người review chọn thẻ (chính + khác) + điền số tiền. Không có → mặc định cả tổng vào 1 thẻ.
  const splits = parseSplits(req.body?.splits);
  // [Admin Demo 18/9] PHÍ tính trên SỐ GHI NHẬN (tổng quẹt − tiền HỦY), KHÔNG phải tổng quẹt: doanh số ghi đã trừ
  // hủy mà phí tính trên số chưa trừ thì phí bị tính dư → hoàn đại lý THIẾU.
  // Tách thẻ: người review khai theo SỐ IN TRÊN BILL (tổng = tổng quẹt) — "hủy GD khác với tách thẻ trong 1 lô".
  // Hệ tự trừ phần hủy khỏi dòng lớn nhất thay vì bắt người ta tính tay (trước đây chặn gửi oan).
  const chuan = chuanHoaSplitsTruHuy(splits, bill);
  if (!chuan) {
    const quet = Math.round(bill.totalAmount); const ghi = tienGhiNhan(bill);
    res.status(422).json({ error: 'SPLIT_SUM_MISMATCH', message: `Tổng các dòng tách thẻ phải bằng tổng bill (${quet.toLocaleString('vi-VN')}đ)${ghi !== quet ? ` hoặc số đã trừ hủy (${ghi.toLocaleString('vi-VN')}đ)` : ''} — kiểm lại số từng thẻ.` });
    return;
  }
  const splitsTinh = chuan.splits;
  const tienTinhPhi = tienGhiNhan(bill);
  if (chuan.ghiChu) console.error(`[ocr-send] TÁCH THẺ + HỦY: TID ${bill.tid} lô ${bill.batchNumber} · ${chuan.ghiChu}`);
  const sell = await computeSellFeeLine(db, routing.tidRow, tienTinhPhi, at, splitsTinh);
  const install = await computeInstallFeeLine(db, routing.tidRow, tienTinhPhi, at, splitsTinh);
  // Phí không tính được (mơ hồ/chưa cấu hình/tổng-tách-lệch) → CHẶN gửi, báo rõ (fail-closed money).
  if (!sell.resolved) { res.status(422).json({ error: 'FEE_UNRESOLVED', message: `Phí bán: ${sell.note}` }); return; }
  if (routing.investorRoomId && !install.resolved) { res.status(422).json({ error: 'FEE_UNRESOLVED', message: `Phí cài máy: ${install.note}` }); return; }
  // Ảnh CARD (bill + bảng) render client-side (Admin Demo 31/8) — base64 dataURL → Buffer. Đại lý/NĐT KHÁC ảnh (bảo
  // mật: NĐT không hoàn/phí bán/tên đại lý). Thiếu → fallback ảnh bill thô (p.buffer). bot-api SYSTEM không sharp.
  const dataUrlToBuf = (s: unknown): Buffer | null => {
    if (typeof s !== 'string') return null;
    const m = /^data:[^;]+;base64,(.+)$/s.exec(s);
    if (!m) return null;
    try { return Buffer.from(m[1], 'base64'); } catch { return null; }
  };
  const dealerImageBuffer = dataUrlToBuf(req.body?.dealerImage) ?? p.buffer;
  const investorImageBuffer = dataUrlToBuf(req.body?.investorImage) ?? p.buffer;
  // [Admin Demo 6/9 — HARDENING "ghi-trước-gửi-sau", gốc bug lô 116 sent-không-doanh-số] Thứ tự MỚI: PRE-CHECK dedup
  // (read-only, KHÔNG side-effect) → GHI DOANH SỐ → GỬI. Bill đã gửi (cùng phòng=trùng / khác phòng=sai máy) → DỪNG,
  // không ghi/không gửi. Revenue fail/DUP_SUSPECT → DỪNG, KHÔNG gửi/đánh dấu. → KHÔNG BAO GIỜ "đã gửi mà sót doanh số".
  // Pre-check dùng ĐÚNG hàm dò của send (findSentByImageHashGlobal ⊇ IMAGE_SENT_OTHER_ROOM + trùng-phòng; findSentByLoAmount
  // bắt ca OCR đọc lệch ảnh) → qua pre-check ⟹ send chắc chắn post được (không kẹt "ghi rồi mà send từ chối").
  const imageHash = createHash('sha256').update(p.buffer).digest('hex');
  if (req.body?.allowDuplicate !== true) {
    // [Admin Demo 7/9 — BẢN CHẤT: gửi lại KHÔNG phải dupe, mà là XÁC NHẬN CẬP NHẬT tin cũ + ghi lại doanh số bản sửa]
    // Ảnh này ĐÃ gửi (cùng phòng = sửa tại chỗ; khác phòng = OCR đọc sai HKD/máy, gửi nhầm đại lý) → KHÔNG chặn câm 409,
    // mà SỬA CHÍNH tin cũ (n-1) theo OCR MỚI qua editBillParams (rekey Lô, chuyển TID nếu đổi, recompute doanh số, ghi
    // sổ sửa). Data giống nhau (retry mạng) → patch không đổi → idempotent, KHÔNG x2. Chống-x2 giữ (không tạo tin/Lô mới).
    const g = await findSentByImageHashGlobal(db, imageHash);
    if (g && g.roomId !== dealerRoomId) {
      // [Admin Demo 7/9 — MƯỢN TID DI CHUYỂN PHÒNG] Bill đã gửi ở phòng KHÁC phòng ĐÍCH (khai/đổi mượn, mượn nhầm đại lý
      // khác, hay OCR gửi nhầm) → DI CHUYỂN CHÍNH thẻ bill sang phòng ĐÚNG (đổi roomId) + editBillParams rekey CÙNG lô +
      // gán borrowed_by (dời sang mượn = customerId; dời VỀ chủ TID = null để GỠ mượn). KHÔNG tạo tin/lô mới (không mồ
      // côi lô, không dupe). Mirror NĐT GIỮ (TID→NĐT không đổi). Bot member CẢ 2 phòng cho AUTHZ + hiển thị.
      const bot = await ensureSupportAlphaAgent(db);
      // [Agent-2 11/9] + phòng CHỦ TID (routing.dealerRoomId): editBillParams → createLoFromBillTid → quoteRow gate
      // scope theo khách CHỦ TID — di chuyển giữa 2 phòng mượn mà bot chưa từng vào phòng chủ thì recompute chết câm.
      for (const rid of [...new Set([g.roomId, dealerRoomId, ...(routing.dealerRoomId ? [routing.dealerRoomId] : [])])]) {
        await db.chatRoomMember.upsert({ where: { roomId_agentId: { roomId: rid, agentId: bot.id } }, update: { leftAt: null }, create: { roomId: rid, agentId: bot.id, role: 'MEMBER' } });
      }
      const dtM = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(bill.dateTime ?? '');
      const billDate = dtM ? `${dtM[3]}-${dtM[2].padStart(2, '0')}-${dtM[1].padStart(2, '0')}` : undefined;
      const billTime = dtM && dtM[4] ? `${dtM[4].padStart(2, '0')}:${dtM[5]}` : undefined;
      const upd = await editBillParams(db, {
        messageId: g.messageId, actorAgentId: bot.id, editPassword: '', skipPassword: true,
        // [PHẢN BIỆN 21/9 — A-C1 CONFIRMED] patch amount PHẢI là SỐ GHI NHẬN (quẹt − hủy): đường update này từng
        // truyền GROSS → bill có GD hủy quét lại là lô/GD bị ĐÈ NGƯỢC về gross ⇒ doanh số tự phồng lại đúng tiền
        // hủy, đảo câm bản fix 18/9.
        patch: { amount: tienGhiNhan(bill), lo: bill.batchNumber ?? null, tid: bill.tid, ...(billDate ? { billDate } : {}), ...(billTime ? { billTime } : {}) },
        borrowedByCustomerId: borrowedByCustomerId ?? null // dời sang mượn = số; dời về chủ TID = null (gỡ mượn cũ)
      });
      if (!upd.ok) {
        const status = upd.error === 'NON_PENDING_LO' ? 409 : 422;
        res.status(status).json({ error: upd.error, message: upd.error === 'NON_PENDING_LO' ? 'Lô của bill cũ ĐÃ tất toán — không sửa ngầm được, kiểm tay.' : 'Không cập nhật được tin bill cũ — kiểm tay.' }); return;
      }
      await db.chatMessage.update({ where: { id: g.messageId }, data: { roomId: dealerRoomId } }); // DI CHUYỂN thẻ sang phòng đúng
      // [A-M4 21/9] Forward cờ moneyEditNotApplied (R198): editBillParams có thể ok:true mà TIỀN CHƯA áp (lô đa-thẻ
      // đổi tiền không splits / không tìm ra Lô) — trước nuốt câm, client vẫn báo "đã ghi lại doanh số".
      const canhTien1 = upd.moneyEditNotApplied === true ? ' ⚠ LƯU Ý: DOANH SỐ CHƯA CẬP NHẬT theo bản sửa (không suy được cách chia thẻ/không tìm ra lô) — sửa qua màn tách thẻ hoặc kiểm tay.' : '';
      res.json({ ok: true, updated: true, moved: true, revenue: { ok: true }, revenueUpdated: upd.revenueUpdated, moneyEditNotApplied: upd.moneyEditNotApplied === true || undefined, dealerMessageId: g.messageId, message: (borrowedByCustomerId != null ? 'Đã CHUYỂN bill sang phòng đại lý MƯỢN + ghi lại doanh số (xóa khỏi phòng cũ).' : 'Đã CHUYỂN bill về phòng chủ TID + gỡ mượn + ghi lại doanh số.') + canhTien1 }); return;
    } else if (g) {
      const bot = await ensureSupportAlphaAgent(db); // actor = bot → qua AUTHZ per-room + skip password
      // Bot PHẢI là thành viên phòng chứa tin cũ (g.roomId) để editBillParams qua AUTHZ (tin cũ có thể ở phòng KHÁC do OCR
      // đọc sai HKD). Self-heal tại chỗ (idempotent, leftAt=null đủ) — không drift lại.
      await db.chatRoomMember.upsert({
        where: { roomId_agentId: { roomId: g.roomId, agentId: bot.id } },
        update: { leftAt: null },
        create: { roomId: g.roomId, agentId: bot.id, role: 'MEMBER' }
      });
      const dtM = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(bill.dateTime ?? '');
      const billDate = dtM ? `${dtM[3]}-${dtM[2].padStart(2, '0')}-${dtM[1].padStart(2, '0')}` : undefined;
      const billTime = dtM && dtM[4] ? `${dtM[4].padStart(2, '0')}:${dtM[5]}` : undefined;
      const upd = await editBillParams(db, {
        messageId: g.messageId, actorAgentId: bot.id, editPassword: '', skipPassword: true,
        patch: { amount: tienGhiNhan(bill), lo: bill.batchNumber ?? null, tid: bill.tid, ...(billDate ? { billDate } : {}), ...(billTime ? { billTime } : {}) }, // [A-C1] NET, không phải gross
        // [MƯỢN TID] parity Sửa lô: khai mượn khi cập nhật bill đã gửi → gán borrowed_by lên lô (doanh số về người mượn).
        ...(borrowedByCustomerId !== undefined ? { borrowedByCustomerId } : {})
      });
      if (!upd.ok) {
        const status = upd.error === 'NON_PENDING_LO' ? 409 : 422;
        res.status(status).json({ error: upd.error, message: upd.error === 'NON_PENDING_LO' ? 'Lô của bill cũ ĐÃ tất toán — không sửa ngầm được, kiểm tay.' : 'Không cập nhật được tin bill cũ — kiểm tay.' }); return;
      }
      const canhTien2 = upd.moneyEditNotApplied === true ? ' ⚠ LƯU Ý: DOANH SỐ CHƯA CẬP NHẬT theo bản sửa (không suy được cách chia thẻ/không tìm ra lô) — sửa qua màn tách thẻ hoặc kiểm tay.' : ''; // [A-M4 21/9]
      res.json({ ok: true, updated: true, revenue: { ok: true }, revenueUpdated: upd.revenueUpdated, moneyEditNotApplied: upd.moneyEditNotApplied === true || undefined, oldAmount: upd.oldAmount, newAmount: upd.newAmount, dealerMessageId: g.messageId, message: 'Đã CẬP NHẬT tin bill đã gửi + ghi nhận doanh số theo bản sửa (không tạo mới, không nhân đôi).' + canhTien2 }); return;
    }
    // Ảnh KHÁC nhưng lô+tiền trùng (nghi cùng bill chụp lại / bill thật khác) → vẫn hỏi, KHÔNG tự cập nhật (không chắc cùng bill).
    const byLoAmt = await findSentByLoAmount(db, dealerRoomId, bill.batchNumber ?? null, bill.totalAmount, bill.dateTime ?? null, bill.tid ?? null);
    if (byLoAmt) { res.status(409).json({ error: 'DUPLICATE', message: 'Bill này đã gửi rồi (theo lô + số tiền). Gửi lại?', duplicate: true }); return; }
  }

  // GHI DOANH SỐ TRƯỚC — createLo fail/DUP_SUSPECT → DỪNG (KHÔNG gửi, KHÔNG đánh dấu "đã gửi"). Idempotent theo billKey
  // (nat|tid|lô|hđ). Thẻ ghi = KHỚP review (splits 1 thẻ → thẻ đó; else thẻ mặc định Visa-Master = defaultCardTypeIdForTid).
  let revenue: { ok: boolean; loId?: number; message?: string } = { ok: false };
  try {
    const supportBot = await ensureSupportAlphaAgent(db);
    // [Admin Demo 6/9 — GỐC bug 4 đại lý (Lộc SG/Mạnh HN/Quỳnh SG/Hoài SG) sót doanh số CÂM] Bot GHI doanh số
    // (SupportAlpha 413) KHÁC bot GỬI (SIGMA_BOT 412). Send tự thêm SIGMA_BOT vào nhóm (ensureBotMember) nhưng
    // SupportAlpha CHỈ được thêm qua đường zalo-watcher → đại lý nào bill vào bằng menu OCR-send mà KHÔNG qua watcher
    // thì SupportAlpha VẮNG nhóm → agentScopeCustomerIds() rỗng → quoteRow chặn TID_NOT_IN_AGENT_SCOPE → createLo fail.
    // VÁ TẬN GỐC (self-heal mỗi lần gửi): đảm bảo SupportAlpha là thành viên nhóm đại lý NGAY tại chỗ ghi doanh số.
    // leftAt=null là đủ cho scope (agent-tid-scope.ts:16 chỉ lọc leftAt). Idempotent. Không bao giờ drift lại cho send.
    // [Agent-2 11/9 — BUG MƯỢN TID, tái hiện bằng e2e-cross-flow-adversarial (E)] Khi MƯỢN, dealerRoomId = phòng
    // MƯỢN nhưng quoteRow gate scope theo KHÁCH CHỦ TID (tid.customerId) → bot phải là thành viên phòng CHỦ TID
    // (routing.dealerRoomId) nữa, nếu không bill mượn ĐẦU TIÊN của TID (bot chưa từng vào phòng chủ) chết 422
    // TID_NOT_IN_AGENT_SCOPE. Self-heal CẢ HAI phòng (idempotent, cùng lớp incident "bot GHI vắng nhóm" 6/9).
    const phongCanScope = [...new Set([dealerRoomId, ...(routing.dealerRoomId ? [routing.dealerRoomId] : [])])];
    for (const rid of phongCanScope) {
      await db.chatRoomMember.upsert({
        where: { roomId_agentId: { roomId: rid, agentId: supportBot.id } },
        update: { leftAt: null },
        create: { roomId: rid, agentId: supportBot.id, role: 'MEMBER' }
      });
    }
    // [Admin Demo 6/9] billDate=billTxn → khóa `nat|tid|lô|` KÈM NGÀY (lô ngân hàng reset mỗi ngày) → lô-trùng-khác-ngày
    // KHÔNG gộp nhầm. billTxn null (bill thiếu ngày) → giữ format cũ (imageHash trong dedup ảnh vẫn chặn trùng thật).
    // [Admin Demo 16/9 khuya] mã ĐÓNG LÔ vào khóa → lô "84" và lô "84(95)" là HAI lô riêng (trước bị gộp = mất tiền).
    const billKey = buildBillKey({ tid: bill.tid, batchNumber: bill.batchNumber, invoiceNumber: null, imageHash, billDate: billTxn, settlementCode: bill.settlementCode ?? null });
    const defaultCardTypeId = await defaultCardTypeIdForTid(db, routing.tidRow, at);
    const revenueCardTypeId = splits && splits.length === 1 ? splits[0].cardTypeId : (defaultCardTypeId ?? undefined);
    const revenueLines = splitsTinh && splitsTinh.length > 1 ? splitsTinh.map((s) => ({ cardTypeId: s.cardTypeId, amountBeforeFee: s.amount })) : undefined;
    // [MƯỢN TID] borrowedByCustomerId đã resolve ở trên (từ borrowedByRoomId) + dealerRoomId đã trỏ phòng mượn.
    // [Admin Demo 17/9] DOANH SỐ ghi = tổng quẹt − tiền HỦY trên tờ tổng kết (ABB in dòng "HỦY"). Không trừ thì
    // ghi thừa đúng bằng số đã hủy (ca thật lô 75: thừa 11.000đ) và NĐT nhận sai. splits (tách thẻ) tự cộng
    // đúng phần của chúng nên chỉ trừ ở nhánh KHÔNG tách.
    const tienGhi = tienGhiNhan(bill);
    // BẤT BIẾN sau chuẩn hoá: Σ dòng tách PHẢI bằng doanh số ghi. Lệch ở đây là lỗi lập trình (chuanHoaSplitsTruHuy
    // sai), không phải lỗi người nhập → chặn fail-closed để không ghi tiền sai, và nói rõ là lỗi hệ thống.
    if (revenueLines) {
      const tongDong = revenueLines.reduce((a, x) => a + Math.round(Number(x.amountBeforeFee) || 0), 0);
      if (Math.abs(tongDong - tienGhi) > 1) { // [A-L1] dung sai ±1đ khớp chuanHoaSplitsTruHuy — lệch 1đ là validation chứ không phải lỗi hệ thống
        console.error(`[ocr-send] BẤT BIẾN VỠ: Σ dòng ${tongDong} ≠ ghi nhận ${tienGhi} (TID ${bill.tid} lô ${bill.batchNumber})`);
        res.status(500).json({ error: 'SPLIT_INVARIANT', message: `Lỗi hệ thống khi phân bổ tiền hủy vào các thẻ (Σ dòng ${tongDong.toLocaleString('vi-VN')}đ ≠ ghi nhận ${tienGhi.toLocaleString('vi-VN')}đ) — CHƯA gửi, báo kỹ thuật.` });
        return;
      }
    }
    if (tienGhi !== bill.totalAmount) console.error(`[ocr-send] TRỪ HỦY: bill TID ${bill.tid} lô ${bill.batchNumber} · quẹt ${bill.totalAmount.toLocaleString('vi-VN')} − hủy ${(bill.voidAmount ?? 0).toLocaleString('vi-VN')} (${bill.voidCount ?? 0} GD) = ghi ${tienGhi.toLocaleString('vi-VN')}đ`);
    const lo = await createLoFromBillTid(db, supportBot.id, {
      tidString: bill.tid, cardTypeId: revenueCardTypeId, amountBeforeFee: tienGhi, lines: revenueLines, billKey,
      txnDate: billTxn, allowDuplicate: req.body?.allowDuplicate === true, borrowedByCustomerId,
      settlementCode: bill.settlementCode ?? null // [16/9] mã ĐÓNG LÔ → lô hiện "84(95)" ở bảng doanh số/Excel/ảnh
    });
    if (!lo.ok) {
      // DUP_SUSPECT = nghi trùng doanh số (đại lý xác nhận allowDuplicate nếu khác) → KHÔNG gửi. Khác → 422, KHÔNG gửi.
      if (lo.error === 'DUP_SUSPECT') { res.status(409).json({ error: 'DUP_SUSPECT', message: lo.message, duplicate: true }); return; }
      res.status(422).json({ error: 'REVENUE_FAILED', message: lo.message || 'Không ghi được doanh số — CHƯA gửi.' }); return;
    }
    revenue = { ok: true, loId: lo.data.id, message: billTxn ? undefined : '⚠ Bill KHÔNG có ngày → doanh số ghi hôm nay (kiểm tay).' };
  } catch (e) {
    res.status(500).json({ error: 'REVENUE_ERROR', message: 'Lỗi ghi doanh số (CHƯA gửi, an toàn — thử lại): ' + ((e as Error)?.message ?? 'unknown') }); return;
  }

  // GỬI SAU KHI ĐÃ GHI DOANH SỐ. Pre-check ⊇ check của send nên hiếm khi send từ chối; nếu có (race), revenue idempotent
  // theo billKey → gửi lại KHÔNG nhân đôi. Báo rõ revenue đã ghi.
  const result = await sendBillToDealerAndInvestor(db, {
    tid: bill.tid, bill, imageBuffer: p.buffer, imageName: p.imageName,
    dealerImageBuffer, investorImageBuffer,
    dealerRoomId: dealerRoomId, investorRoomId: routing.investorRoomId,
    sell, install, bankName: typeof req.body?.bankName === 'string' ? req.body.bankName : null, allowDuplicate: req.body?.allowDuplicate === true,
    actorAgentId: req.agent?.id ?? null // SEC-MED audit: agent người thật bấm gửi (tin gắn senderId=bot)
  });
  if (!result.ok && result.error === 'IMAGE_SENT_OTHER_ROOM') { res.status(409).json({ error: 'IMAGE_SENT_OTHER_ROOM', message: '⚠ Ảnh bill này ĐÃ GỬI cho đại lý/máy KHÁC — kiểm ĐÚNG máy, dùng "Cập nhật" trên tin cũ. (Doanh số vừa ghi đã idempotent theo bill.)', duplicate: true }); return; }
  if (!result.ok && result.duplicate) { res.status(409).json({ error: 'DUPLICATE', message: 'Bill này đã gửi rồi. Gửi lại? (Doanh số đã ghi — gửi lại không nhân đôi.)', duplicate: true }); return; }
  if (!result.ok) { res.status(500).json({ error: 'SEND_FAILED', message: (result.error || 'Gửi thất bại.') + ' — Doanh số ĐÃ ghi (Lô #' + revenue.loId + '), gửi lại KHÔNG nhân đôi.' }); return; }
  res.json({ ...result, revenue });
}));

// POST /v1/ocr-send/send-qr — [Đợt 2, Admin Demo 5/9 DUYỆT đường tiền] GỬI + GHI DOANH SỐ + HOÀN bill QR bán hàng.
// Body {token, qr:{hkdName, ref, amount, dateTime}, dealerId (roomId đại lý CHỌN từ dropdown)}. requireSession.
// Luồng (money-safe, R198/R_SUPREME): re-review SERVER-SIDE (match HKD + phí — KHÔNG tin client) → reserveQrSend(ref)
// nguyên tử → createQrTransactionSystem (doanh số: phiCaiMay=0 → NĐT về trọn amount; sellMargin=phiBan−phiMua) → hoàn
// đại lý (amount − phíBán, khoá "QR:"+ref, nhóm hoàn QR riêng). GHI doanh số LỖI → releaseQrSend (retry sạch). HOÀN lỗi
// SAU khi doanh số đã ghi → GIỮ dedup (KHÔNG double doanh số) + báo rõ để hoàn tay (hoàn có dedup riêng "QR:"+ref).
ocrSendRouter.post('/v1/ocr-send/send-qr', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const db = getBotDb();
  const token = String(req.body?.token ?? '');
  const p = getPending(token);
  if (!p) { res.status(410).json({ error: 'EXPIRED', message: 'Ảnh hết hạn — quét lại rồi gửi.' }); return; }
  const q = (req.body?.qr ?? {}) as { hkdName?: unknown; ref?: unknown; amount?: unknown; dateTime?: unknown; payerName?: unknown };
  const dealerId = String(req.body?.dealerId ?? '').trim();
  const ref = q.ref != null ? String(q.ref).trim() : '';
  const amount = Number(q.amount) || 0;
  // Tên người quẹt đọc trên bill QR (từ/thẻ khách) — nhãn báo cáo/đối soát (KHÔNG đụng tiền). Ưu tiên qr.payerName,
  // fallback body.payerName (client cũ). Rỗng → null (không lưu '').
  const payerName = (q.payerName != null ? String(q.payerName) : req.body?.payerName != null ? String(req.body.payerName) : '').trim() || null;
  if (!ref) { res.status(400).json({ error: 'NO_REF', message: 'Thiếu Số giao dịch (ref) — không dedup được, không gửi (chống doanh số x2).' }); return; }
  if (!(amount > 0)) { res.status(400).json({ error: 'NO_AMOUNT', message: 'Thiếu số tiền QR.' }); return; }
  if (!dealerId) { res.status(400).json({ error: 'NO_DEALER', message: 'Chưa chọn đại lý (dropdown) để hoàn tiền.' }); return; }
  if (await qrRefAlreadySent(db, ref, amount)) { res.status(409).json({ error: 'ALREADY_SENT', message: 'Bill QR này (Số giao dịch + số tiền) đã gửi rồi.', duplicate: true }); return; }
  // Re-review SERVER-SIDE (match HKD + phí bán/mua canonical qua resolveQrFeeForTid — KHÔNG tin số client).
  const { dealers } = await classifyOptions(db);
  // [PHẢN BIỆN HIGH#3] dealerId = roomId client gửi → PHẢI là phòng đại lý HỢP LỆ (customerChatGroup active). Không
  // validate → gom doanh số QR về phòng sai + bot bơm tin "HOÀN TIỀN" giả vào phòng bất kỳ. Chặn trước khi dùng.
  if (!dealers.some((d) => d.roomId === dealerId)) {
    res.status(400).json({ error: 'BAD_DEALER', message: 'Đại lý được chọn không hợp lệ (không phải phòng đại lý đang hoạt động).' });
    return;
  }
  const dt = q.dateTime != null ? String(q.dateTime) : null;
  const dm = dt ? /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(dt) : null;
  const tm = dt ? /([01]?\d|2[0-3]):([0-5]\d)/.exec(dt) : null;
  const dateStr = dm ? `${dm[1]}/${dm[2]}/${dm[3]}` : null;
  // [Admin Demo 7/9 — GỐC bug "hoàn QR sửa ngày mà không ghi nhận"]: metadata.billDate PHẢI ISO YYYY-MM-DD (mọi đối
  // soát/report nhóm ngày theo ISO). TRƯỚC ĐÂY truyền thẳng dateStr dd/mm/yyyy → '05/09/2026' >= '2026-09-05' SAI →
  // bill rơi sai/ mất ngày. dateStr (dd/mm/yyyy) CHỈ dùng cho reviewQr (parse dd/mm/yyyy); billDate lưu = ISO.
  const dateStrIso = dm ? `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}` : null;
  const timeStr = tm ? `${tm[1]}:${tm[2]}` : null;
  // [Admin Demo 5/9 phí bán tùy khách] dealerId là ĐẠI LÝ CHỌN → truyền selectedDealerRoomId (param 6) để phiBan = giá bán
  // ĐÈ của đại lý đó (qr_dealer_sell_fee) ?? mặc định mã. folderHint (param 5) = null ở send (đã có lựa chọn tường minh).
  const reviewed = await reviewQr(db, [{ hkdName: q.hkdName != null ? String(q.hkdName) : null, amount, ref, date: dateStr, time: timeStr }], new Date(), dealers, null, dealerId);
  const item: QrReviewItem | undefined = reviewed[0];
  if (!item || item.blocked) { res.status(422).json({ error: 'QR_REVIEW_BLOCKED', message: item ? item.warnings.join(' ') : 'Không review được bill QR.' }); return; }
  if (item.tidId == null || item.partnerFeeMilli == null || item.sellFeeMilli == null || item.sellFeeAmount == null) {
    res.status(422).json({ error: 'QR_FEE_UNRESOLVED', message: 'Chưa tra được phí QR (mua/bán) — không ghi doanh số.' }); return;
  }
  // [Admin Demo 11/9] BẬC GIÁ BÁN: mặc định CHỜ (item.sellFeeMilli). Client tích "tiền nhanh" → giaNhanh=true → dùng
  // sellFeeMilliNhanh (nếu mã có). Mã không có bậc nhanh mà client gửi giaNhanh → GIỮ chờ (fail-safe, không tự chế giá).
  // [PHẢN BIỆN 11/9 — B1] Logic chọn bậc tách ra chonBacGiaQr (ocr-send-service, THUẦN) để test được — hành vi giữ NGUYÊN.
  const { giaNhanh, effSellFeeMilli, effSellFeeAmount, spreadNegative } = chonBacGiaQr({
    giaNhanhRequested: req.body?.giaNhanh === true, amount,
    sellFeeMilli: item.sellFeeMilli, sellFeeMilliNhanh: item.sellFeeMilliNhanh, partnerFeeMilli: item.partnerFeeMilli
  });
  // spread âm với bậc đã chọn (nhanh cũng phải ≥ giá mua) — chặn ghi.
  if (spreadNegative) {
    res.status(422).json({ error: 'SPREAD_NEGATIVE', message: `Phí bán ${giaNhanh ? 'nhanh' : 'chờ'} (${effSellFeeMilli}) < phí mua (${item.partnerFeeMilli}) — cấu hình sai, không ghi.` }); return;
  }
  // [Admin Demo 6/9 — C] GATE BÁO-CÓ SERVER (lớp 2, sau client MATCHED-only): server tự đối soát báo-có ngân hàng. CHỈ
  // 'MATCHED' mới cho ghi. FAIL-OPEN 'CANNOT_CHECK' (creds thiếu / bank lỗi / không resolve mã) → KHÔNG chặn (chống chặn
  // oan do hạ tầng — client đã gác). NOT_FOUND/AMBIGUOUS/DUPLICATE = ngân hàng RÕ chưa khớp DUY NHẤT → CHẶN ghi doanh số.
  let matchedBaoCoBillId: string | null = null; // [Admin Demo 7/9] giữ billId báo-có khớp → đánh dấu ĐÃ đối soát sau khi ghi.
  {
    // [10/9 — phản biện] `refTuBaoCo` do client báo: số GD này KHÔNG đọc từ ảnh mà LẤY TỪ dòng báo-có người duyệt
    // bấm (bill thông báo giao dịch thẻ) ⇒ cổng dưới đòi thêm bằng chứng thật (tên người quẹt + giờ), không cho
    // khớp-ref tự xác nhận chính lựa chọn của người bấm.
    const refTuBaoCo = (req.body?.qr as { refTuBaoCo?: unknown } | undefined)?.refTuBaoCo === true;
    const bc = await evaluateQrBaoCoStatus(db, { hkdName: q.hkdName != null ? String(q.hkdName) : null, amount, atMs: parseBillDateTimeMs(dt), payerName, ref, refTuBaoCo }, item.tidId);
    if (bc.status !== 'MATCHED' && bc.status !== 'CANNOT_CHECK') {
      res.status(422).json({ error: 'BAOCO_NOT_MATCHED', message: `Báo-có ngân hàng CHƯA khớp DUY NHẤT (trạng thái ${bc.status}) — KHÔNG ghi doanh số. Bấm "Check báo có", đối soát khớp rồi gửi lại.` });
      return;
    }
    if (bc.status === 'MATCHED' && bc.candidates[0]?.billId) matchedBaoCoBillId = bc.candidates[0].billId;
  }
  // txnDate = NGÀY TRÊN BILL (cuối tuần theo ngày bill). Thiếu ngày → now (đã cảnh báo ở review).
  const txnDate = resolveBillTxnDate(dateStr ? `${dateStr}${timeStr ? ' ' + timeStr : ''}` : null) ?? new Date();
  // reserveQrSend TRƯỚC khi ghi (nguyên tử, chống 2 phiên song song x2 — money-risk #4).
  const reserved = await reserveQrSend(db, { ref, imageHash: createHash('sha256').update(p.buffer).digest('hex'), dealerRoomId: dealerId, amount });
  if (!reserved) { res.status(409).json({ error: 'ALREADY_SENT', message: 'Bill QR này vừa được gửi ở phiên khác (Số giao dịch trùng).', duplicate: true }); return; }
  // GHI DOANH SỐ QR (chứng từ Transaction; phiCaiMay=0). Lỗi → release (retry sạch, chưa ghi gì).
  // [PHẢN BIỆN CRITICAL] actorUserId PHẢI = null (GD hệ thống, đồng nhất POS lo-service.ts). req.agent.id là id bảng
  // AGENTS (3 chủ = 270/381/399) — KHÔNG có trong users (verify DB: rỗng) → FK audit_logs.actor_user_id→users(id) vỡ
  // → writeAuditStrict NÉM trong $transaction → doanh số QR THROW + reserve kẹt. Dấu vết người gửi giữ ở note.
  let rev: Awaited<ReturnType<typeof createQrTransactionSystem>>;
  try {
    rev = await createQrTransactionSystem(db, {
      tidId: item.tidId, amount, phiMuaMilli: item.partnerFeeMilli, phiBanMilli: effSellFeeMilli,
      txnDate, receiveAccountId: item.receiveAccountId, dealerRoomId: dealerId, actorUserId: null,
      ref, payerName, // Số GD → qr_ref (poll ghép báo-có); tên người quẹt → qr_payer_name (nhãn báo cáo).
      note: `QR bán hàng · ref ${ref} · tiền ${giaNhanh ? 'NHANH' : 'chờ'}${item.hkdNameMatched ? ' · ' + item.hkdNameMatched : ''}${req.agent?.code ? ' · gửi bởi ' + req.agent.code : ''}`
    });
  } catch (e) {
    // [PHẢN BIỆN HIGH#1] createQrTransactionSystem nhiều await có thể THROW (DB blip, FK, deadlock) → PHẢI release
    // reserve, nếu không ref kẹt vĩnh viễn trong qr_bill_sent → mọi retry 409 "đã gửi" → doanh số mất CÂM.
    await releaseQrSend(db, ref, amount).catch((re) => console.error('[send-qr] release reserve sau throw lỗi:', re));
    throw e;
  }
  if (!rev.ok) {
    await releaseQrSend(db, ref, amount);
    res.status(500).json({ error: rev.error ?? 'QR_REVENUE_FAILED', message: rev.message || 'Không ghi được doanh số QR.' }); return;
  }
  // [Admin Demo 7/9] GỬI XONG → ĐÁNH DẤU BÁO-CÓ ĐÃ ĐỐI SOÁT NGAY (không chờ poll 30'). matched_bill_key = code GD của
  // giao dịch vừa ghi (poll dùng cùng khoá). BEST-EFFORT (R198 loud-not-block): doanh số đã ghi ở trên — lỗi mark chỉ
  // hoãn hiển thị "đã đối soát" tới lần poll kế, KHÔNG double/không release.
  if (matchedBaoCoBillId) {
    try { await markBaoCoReconcile(db, matchedBaoCoBillId, 'MATCHED', 'GD' + String(rev.id).padStart(5, '0')); }
    catch (e) { console.error('[send-qr] markBaoCoReconcile lỗi (best-effort, poll sẽ ghép lại):', e instanceof Error ? e.message : e); }
  }
  // HOÀN đại lý (amount − phíBán) vào nhóm ĐÃ CHỌN. Lỗi SAU khi doanh số đã ghi → GIỮ dedup (không double doanh số),
  // báo rõ để hoàn tay (hoàn có dedup riêng "QR:"+ref nên không double). KHÔNG release (release = mở đường ghi x2).
  const refundAmount = amount - effSellFeeAmount;
  const refund = await sendQrRefundToDealer(db, {
    dealerRoomId: dealerId, ref, amount, refundAmount, sellFeeMilli: effSellFeeMilli,
    billDate: dateStrIso, hkdName: item.hkdNameMatched, dateTime: dt, imageBuffer: p.buffer, imageName: p.imageName
  });
  // CC NĐT (Admin Demo 5/9) — như POS cc: đăng THÊM ảnh bill QR + tóm tắt (HKD·tiền·ngày·Số GD, KHÔNG phí/tên đại lý) vào
  // nhóm NĐT (mã QR → receiveAccountId → investor → phòng NĐT). BEST-EFFORT (R198 loud-not-block): đây là tin chat,
  // KHÔNG là đường tiền — doanh số + hoàn đã xong ở trên; lỗi cc chỉ báo rõ, KHÔNG chặn/không release/không double.
  let investor: { ok: boolean; roomId?: string; messageId?: string; deduped?: boolean; skipped?: boolean; reason?: string; error?: string } = { ok: false, skipped: true, reason: 'NO_INVESTOR_ROOM' };
  try {
    const invRoom = await resolveInvestorRoomByReceiveAccount(db, item.receiveAccountId);
    if (!invRoom) {
      investor = { ok: false, skipped: true, reason: 'NO_INVESTOR_ROOM' }; // chưa uỷ NĐT / NĐT chưa gán nhóm → không cc (không lỗi).
    } else {
      const r = await sendQrToInvestor(db, { investorRoomId: invRoom, ref, amount, billDate: dateStrIso, hkdName: item.hkdNameMatched, dateTime: dt, imageBuffer: p.buffer, imageName: p.imageName });
      investor = r.ok ? { ok: true, roomId: invRoom, messageId: r.messageId, deduped: r.deduped === true } : { ok: false, roomId: invRoom, error: r.error };
      if (!r.ok) console.error(`[send-qr] CC NĐT phòng ${invRoom} lỗi (${r.error}) — doanh số/hoàn KHÔNG ảnh hưởng, cc lại tay nếu cần.`);
    }
  } catch (e) {
    investor = { ok: false, error: 'CC_INVESTOR_THROW' };
    console.error('[send-qr] CC NĐT ném (best-effort, KHÔNG chặn):', e instanceof Error ? e.message : e);
  }
  res.json({
    ok: true, transactionId: rev.id, dealerRoomId: dealerId,
    revenue: { ok: true, amount, giaNhanh, sellFeeMilli: effSellFeeMilli, sellFeeAmount: effSellFeeAmount, partnerFeeMilli: item.partnerFeeMilli, refundAmount, investorReceiveAmount: amount - Math.round((amount * (item.partnerFeeMilli ?? 0)) / 100000), isWeekend: item.isWeekend, feeSource: item.feeSource },
    refund: refund.ok ? { ok: true, messageId: refund.messageId, deduped: refund.deduped === true } : { ok: false, error: refund.error, message: `Doanh số ĐÃ GHI nhưng HOÀN đại lý lỗi (${refund.error}) — hoàn lại tay (doanh số KHÔNG bị double).` },
    investor
  });
}));

// POST /v1/ocr-send/qr-review-dealer — [Admin Demo 5/9 phí bán tùy khách] người review ĐỔI đại lý (dropdown) → TÍNH LẠI
// phí bán/hoàn theo GIÁ BÁN của đại lý đó (server canonical, KHÔNG để client bịa). Body {qr:{hkdName,amount,ref,dateTime}, dealerId}.
ocrSendRouter.post('/v1/ocr-send/qr-review-dealer', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const db = getBotDb();
  // [Admin Demo 10/9 — bắt bởi đợt phản biện] PHẢI nhận + trả lại ĐỦ các trường của bill THÔNG BÁO GIAO DỊCH THẺ.
  // Trước đây route chỉ đọc {hkdName,ref,amount,dateTime} nên sau lần tính-lại-theo-đại-lý ĐẦU TIÊN là thẻ rụng mất
  // payerName/fromCard/noticeOnly → mất badge "THÔNG BÁO GIAO DỊCH THẺ", mất tên chủ thẻ, ô "Từ (thẻ khách)" thành "—".
  const q = (req.body?.qr ?? {}) as { hkdName?: unknown; ref?: unknown; amount?: unknown; dateTime?: unknown; payerName?: unknown; noticeMerchant?: unknown; noticeOnly?: unknown; fromCard?: unknown };
  const dealerId = String(req.body?.dealerId ?? '').trim();
  const amount = Number(q.amount) || 0;
  if (!(amount > 0)) { res.status(400).json({ error: 'NO_AMOUNT', message: 'Thiếu số tiền QR.' }); return; }
  const { dealers } = await classifyOptions(db);
  if (dealerId && !dealers.some((d) => d.roomId === dealerId)) { res.status(400).json({ error: 'BAD_DEALER', message: 'Đại lý được chọn không hợp lệ.' }); return; }
  const dt = q.dateTime != null ? String(q.dateTime) : null;
  const dm = dt ? /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(dt) : null;
  const tm = dt ? /([01]?\d|2[0-3]):([0-5]\d)/.exec(dt) : null;
  const reviewed = await reviewQr(db, [{
    hkdName: q.hkdName != null ? String(q.hkdName) : null,
    amount,
    ref: q.ref != null ? String(q.ref) : null,
    date: dm ? `${dm[1]}/${dm[2]}/${dm[3]}` : null,
    time: tm ? `${tm[1]}:${tm[2]}` : null,
    fromCard: q.fromCard != null ? String(q.fromCard) : null,
    payerName: q.payerName != null ? String(q.payerName) : null,
    noticeMerchant: q.noticeMerchant != null ? String(q.noticeMerchant) : null,
    noticeOnly: q.noticeOnly === true
  }], new Date(), dealers, null, dealerId || null);
  // [Admin Demo 11/9 — CẤM rơi cờ "đã gửi theo ẢNH"] Client setLive() THAY CẢ item khi đổi đại lý/sửa HKD-ref → cờ
  // alreadySent/blocked theo image_hash (augmentQrReviewWithSent lúc OCR) sẽ MẤT nếu không augment lại ở đây.
  // Client gửi kèm token ảnh (có sẵn trên card) → tra lại qr_bill_sent theo hash. Không token/hết hạn → bỏ qua
  // (lưới cuối reserveQrSend theo image_hash lúc gửi vẫn chặn tiền).
  const tokenQr = String(req.body?.token ?? '').trim();
  const pQr = tokenQr ? getPending(tokenQr) : null;
  if (pQr) await augmentQrReviewWithSent(db, reviewed, pQr.buffer);
  res.json({ ok: true, item: reviewed[0] ?? null });
}));

// POST /v1/ocr-send/update-sent — [Admin Demo 2/9 "bill đã gửi CHỈ cập nhật tại chỗ, không nhân đôi"] re-OCR sửa thông số
// bill ĐÃ GỬI → sửa TRÊN chính tin cũ (editBillParams: đổi tiền/lô/tid/ngày + note thay đổi + tính lại doanh số),
// KHÔNG post tin mới. Actor = bot Support SigMa (thành viên phòng đã gửi) + skipPassword (luồng đã đăng nhập, trusted).
ocrSendRouter.post('/v1/ocr-send/update-sent', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { messageId?: string; bill?: { totalAmount?: unknown; batchNumber?: unknown; tid?: unknown; dateTime?: unknown; cardTypeId?: unknown; splits?: unknown; voidAmount?: unknown; voidCount?: unknown } };
  const messageId = String(b.messageId ?? '').trim();
  if (!messageId) { res.status(400).json({ error: 'NO_MESSAGE', message: 'Thiếu tin bill để cập nhật.' }); return; }
  const src = b.bill ?? {};
  // Ngày dd/mm/yyyy từ dateTime (chỉ lấy phần ngày) cho patch.billDate.
  const dtRaw = src.dateTime != null ? String(src.dateTime).trim() : '';
  const dmy = /(\d{1,2}\/\d{1,2}\/\d{4})/.exec(dtRaw)?.[1];
  // [Admin Demo 8/9] GIỜ cũng phải đi theo (trước đây route này BỎ giờ → sửa giờ trên card "đã gửi" không tới báo cáo lô).
  const hhmm = /(\d{1,2}):(\d{2})(?::\d{2})?/.exec(dtRaw);
  const patch: { amount?: number; lo?: string | null; tid?: string; billDate?: string; billTime?: string; cardTypeId?: number; splits?: { cardTypeId: number; amount: number }[]; voidAmount?: number; voidCount?: number } = {};
  const amt = Number(src.totalAmount); if (Number.isInteger(amt) && amt > 0) patch.amount = amt;
  // [Admin Demo 25/9 "OCR phải tự ra luôn vì trên bill có số tiền hủy"] OCR ĐÃ đọc được hủy (kiểm 4/4 bill khớp
  // nguyên văn số trên ảnh) — chỗ hở là route SỬA này VỨT trường hủy đi ⇒ lô ghi lại theo TỔNG QUẸT ⇒ doanh số
  // phồng đúng bằng tiền hủy (ca thật lô 115 TID 67512202: dư 10.863đ). Nay mang hủy xuống cùng số tiền.
  const huy = Number(src.voidAmount); if (Number.isFinite(huy) && huy >= 0) patch.voidAmount = Math.round(huy);
  const soHuy = Number(src.voidCount); if (Number.isFinite(soHuy) && soHuy >= 0) patch.voidCount = Math.round(soHuy);
  if (src.batchNumber != null && String(src.batchNumber).trim() !== '') patch.lo = String(src.batchNumber).trim();
  if (src.tid != null && /^\d+$/.test(String(src.tid).trim())) patch.tid = String(src.tid).trim();
  if (dmy) patch.billDate = dmy;
  if (hhmm) patch.billTime = `${hhmm[1].padStart(2, '0')}:${hhmm[2]}`;
  const db = getBotDb();
  const bot = await ensureSupportAlphaAgent(db);

  // [Admin Demo 8/9 "sửa bill mà không cho sửa phí / không đổi được thẻ Visa↔JCB"] ĐỔI THẺ khi cập nhật bill đã gửi.
  // MONEY-SAFETY (fail-closed): thẻ phải THUỘC ĐÚNG ngân hàng của TID + CÓ biểu phí hiệu lực — dùng CHÍNH nguồn thẻ
  // mà card review dùng (rerouteBillForTid → listTidCardTypes). Sai/không hợp lệ ⇒ TỪ CHỐI, không âm thầm bỏ qua.
  const splitsIn = parseSplits(src.splits);
  const cardIn = Number(src.cardTypeId);
  if (splitsIn || Number.isInteger(cardIn)) {
    let tidCho = patch.tid ?? '';
    if (!tidCho) {
      const m0 = await db.chatMessage.findUnique({ where: { id: messageId }, select: { metadataJson: true } });
      try { tidCho = String((JSON.parse(m0?.metadataJson ?? '{}') as { posBill?: { tid?: unknown } })?.posBill?.tid ?? ''); } catch { tidCho = ''; }
    }
    if (!tidCho) { res.status(400).json({ error: 'NO_TID', message: 'Không xác định được TID của bill để kiểm loại thẻ — sửa TID trước.' }); return; }
    const rr = await rerouteBillForTid(db, tidCho.trim());
    const hopLe = new Set(rr.availableCardTypes.map((c) => c.id));
    const canKiem = splitsIn ? splitsIn.map((x) => x.cardTypeId) : [cardIn];
    const sai = canKiem.filter((id) => !hopLe.has(id));
    if (sai.length > 0) {
      res.status(400).json({ error: 'CARD_BANK_MISMATCH', message: `Loại thẻ không thuộc ngân hàng của TID ${tidCho} (hoặc chưa có biểu phí). Thẻ dùng được: ${rr.availableCardTypes.map((c) => c.name).join(', ') || 'không có'}.` });
      return;
    }
    if (splitsIn) {
      const tong = splitsIn.reduce((sum, x) => sum + x.amount, 0);
      const tienBill = patch.amount ?? 0;
      if (tienBill > 0 && tong !== tienBill) { res.status(400).json({ error: 'SPLIT_SUM', message: `Tổng tách thẻ (${tong.toLocaleString('vi-VN')}) khác số tiền bill (${tienBill.toLocaleString('vi-VN')}).` }); return; }
      patch.splits = splitsIn;
    } else patch.cardTypeId = cardIn;
  }
  if (Object.keys(patch).length === 0) { res.status(400).json({ error: 'NO_CHANGE', message: 'Không có thay đổi để cập nhật.' }); return; }
  const r = await editBillParams(db, { messageId, actorAgentId: bot.id, editPassword: '', skipPassword: true, patch });
  if (!r.ok) { res.status(r.error === 'NOT_FOUND' ? 404 : 400).json({ error: r.error ?? 'UPDATE_FAIL', message: 'Không cập nhật được bill: ' + (r.error ?? '') }); return; }
  // Note thay đổi ĐÃ ghi vào meta bill (editStamp trong editBillParams). Trả số cũ/mới + số tin đã cập nhật cho client báo.
  // [Admin Demo 25/9] PHẢI forward cờ: trước đây route này NUỐT moneyEditNotApplied/revenueError ⇒ client không có cách
  // nào biết doanh số chưa ghi ⇒ modal báo thành công trong khi tiền đứng im.
  res.json({ ok: true, updatedCount: r.updatedMessageIds.length, oldAmount: r.oldAmount, newAmount: r.newAmount,
    revenueUpdated: r.revenueUpdated === true,
    moneyEditNotApplied: r.moneyEditNotApplied === true || undefined,
    revenueError: r.revenueError });
}));

// ── SỬA THAM SỐ BILL trên card + mật khẩu sửa (Admin Demo 1/9) ─────────────────────────────────────────────────
// Trạng thái mật khẩu sửa: đã set chưa (còn mặc định 1111?) + user hiện tại có quyền ĐỔI không (allowlist email).
ocrSendRouter.get('/v1/ocr-send/bill-edit-password/status', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const db = getBotDb();
  const agent = await db.agent.findUnique({ where: { id: req.agent!.id }, select: { email: true } });
  const canChange = !!agent?.email && BILL_EDIT_PW_CHANGER_EMAILS.includes(agent.email.trim().toLowerCase());
  res.json({ isSet: await isBillEditPasswordSet(db), canChange });
}));

// Đổi/setup mật khẩu sửa (chỉ allowlist email + đúng mật khẩu hiện tại).
ocrSendRouter.post('/v1/ocr-send/bill-edit-password/change', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const db = getBotDb();
  const agent = await db.agent.findUnique({ where: { id: req.agent!.id }, select: { email: true } });
  const b = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
  const r = await setBillEditPassword(db, agent?.email ?? null, String(b.currentPassword ?? ''), String(b.newPassword ?? ''));
  if (!r.ok) { res.status(r.error === 'FORBIDDEN' ? 403 : 400).json(r); return; }
  res.json({ ok: true });
}));

// Sửa tham số bill trên card (tiền/lô/mã bill) — password-gated, đồng bộ chéo đại lý↔NĐT, recompute doanh thu.
ocrSendRouter.post('/v1/ocr-send/edit-bill-params', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const db = getBotDb();
  const b = (req.body ?? {}) as { messageId?: string; editPassword?: string; patch?: { amount?: number; lo?: string | null; tid?: string; billDate?: string; billTime?: string } };
  if (!b.messageId || !b.patch) { res.status(400).json({ ok: false, error: 'VALIDATION' }); return; }
  const r = await editBillParams(db, { messageId: String(b.messageId), actorAgentId: req.agent!.id, editPassword: String(b.editPassword ?? ''), patch: b.patch });
  if (!r.ok) {
    // SEC-HIGH (1/9): LOCKED (dò mật khẩu) → 429; FORBIDDEN (không thành viên phòng) / BAD_PASSWORD → 403; còn lại 400.
    const status = r.error === 'LOCKED' ? 429 : (r.error === 'FORBIDDEN' || r.error === 'BAD_PASSWORD') ? 403 : 400;
    res.status(status).json(r); return;
  }
  res.json(r);
}));

// [Admin Demo 7/9 — TRA SOÁT SAO KÊ] Upload file sao kê ngân hàng (xlsx) → parse + khớp đại lý/NĐT → trả danh sách GD đã
// phân loại (hoàn đại lý / hoàn ứng NĐT / tạm ứng NĐT) + báo cáo theo ngày + tổng từng đại lý. Multipart field "file".
ocrSendRouter.post('/v1/statement-recon/upload', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const parsed = await parseSingleFileUpload(req);
  if (!parsed.ok || !parsed.buffer.length) { res.status(400).json({ ok: false, error: 'NO_FILE', message: 'Chưa chọn file sao kê (hoặc file quá lớn).' }); return; }
  let statement;
  try { statement = await parseMbStatement(parsed.buffer); }
  catch (e) { res.status(400).json({ ok: false, error: 'PARSE_FAIL', message: 'Không đọc được file sao kê (.xlsx MB/MBV/ACB): ' + ((e as Error)?.message ?? 'lỗi') }); return; }
  // [Admin Demo 8/9 — ACB] BÁO ĐÚNG LÝ DO thay vì đổ tại "không phải file MB/MBV" (R198: check hụt phải nói hụt ở đâu).
  if (statement.txns.length === 0) {
    const ly = (statement.warnings ?? []).join(' ');
    res.status(400).json({ ok: false, error: 'NO_TXN', message: 'Không đọc được giao dịch nào trong file. ' + (ly || 'Hỗ trợ sao kê .xlsx của MB / MBV / ACB.') });
    return;
  }
  // [Admin Demo 8/9 — "tránh nhầm người gửi/người nhận"] FAIL-CLOSED: file KHÔNG có cột đối ứng mà LẠI CÓ lệnh chuyển RA
  // ⇒ không biết người NHẬN. Sao kê ACB để tên CHÍNH CHỦ ở nội dung mọi lệnh chuyển đi ⇒ nạp vào sẽ thành "chuyển giữa
  // TK" hết, hoàn đại lý = 0 mà KHÔNG ai biết (đã tái hiện bằng chính file bản rút gọn của anh: 40 lệnh ra → 0đ hoàn).
  // CHẶN ngay, không cache, và nói rõ phải tải lại bản nào.
  if (statement.thieuCotDoiUng && (statement.soGdRa ?? 0) > 0) {
    res.status(400).json({
      ok: false, error: 'NO_COUNTERPARTY_COL',
      message: `File thiếu cột "Tên tài khoản đối ứng" nhưng có ${statement.soGdRa} giao dịch chuyển RA — không xác định được NGƯỜI NHẬN (nạp vào sẽ bị hiểu nhầm là chuyển nội bộ, hoàn đại lý = 0). Tải lại sao kê có đủ cột "Tên tài khoản đối ứng / Tài khoản đối ứng / Ngân hàng đối ứng" rồi nạp lại.`
    });
    return;
  }
  const recon = await reconcileStatement(getBotDb(), statement);
  await cacheStatementTxns(getBotDb(), statement); // [Admin Demo 7/9] lưu bền → mở lại màn không cần upload lại (best-effort)
  await cacheClosingBalance(getBotDb(), statement); // [Admin Demo 13/9] lưu số dư cuối kỳ mức TK (best-effort)
  // uploadStatement client dùng PARSER RIÊNG (đọc j.ok/j.data, KHÔNG qua jsonCall) → GIỮ wrapper {ok,data}. Chỉ /cached
  // (đi qua jsonCall tự bọc) mới trả phẳng. KHÔNG đổi cái này (đổi = hỏng upload).
  res.json({ ok: true, data: { ...recon, warnings: statement.warnings ?? [] } });
}));

// POST /v1/statement-recon/fetch-auto — [Admin Demo 9/9] LẤY SAO KÊ MB TỰ ĐỘNG qua sidecar mb-feed (thư viện mbbank).
// Kéo giao dịch từ nhà cung cấp → ĐI TIẾP bằng CHÍNH luồng tra soát (reconcile + cache) như file .xlsx nạp tay:
// khớp đại lý/NĐT, chống trùng theo `ref` (đã gắn tiền tố provider+số TK), xuất Excel… dùng lại nguyên.
ocrSendRouter.post('/v1/statement-recon/fetch-auto', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { accountNumber?: unknown; from?: unknown; to?: unknown };
  const acct = String(b.accountNumber ?? '').trim();
  const from = b.from ? new Date(String(b.from)) : null;
  const to = b.to ? new Date(String(b.to)) : null;
  if (!acct) { res.status(400).json({ ok: false, error: 'NO_ACCOUNT', message: 'Chưa chọn số tài khoản cần lấy sao kê.' }); return; }
  if (!from || !to || isNaN(from.getTime()) || isNaN(to.getTime()) || from.getTime() > to.getTime()) {
    res.status(400).json({ ok: false, error: 'BAD_RANGE', message: 'Khoảng ngày không hợp lệ.' }); return;
  }
  const cfg = bankFeedConfigFromEnv();
  if (!cfg) {
    res.status(400).json({ ok: false, error: 'NO_PROVIDER', message: 'Chưa cấu hình nguồn sao kê tự động (thiếu MB_FEED_TOKEN trên máy chủ / dịch vụ mb-feed chưa chạy).' });
    return;
  }
  // [Admin Demo 15/9 — "kéo sao kê lỗi mạng"] GỐC: đường GET dùng TÀI KHOẢN ĐĂNG NHẬP MB Ở ENV sidecar — env đó là
  // user KHÁC chủ TK → MB trả GW300 "Source Account is not belong customer". FIX: nếu ĐÃ CÓ cred MB lưu (AES,
  // investor_feed_creds) khớp đúng SỐ TK cần kéo → đăng nhập PER-REQUEST bằng cred đó (cùng khuôn luồng NĐT đang
  // chạy tốt); không có cred khớp → giữ đường env cũ (tài khoản mặc định của máy chủ).
  let r: Awaited<ReturnType<typeof fetchBankFeed>>;
  const credKhop = await getBotDb().$queryRawUnsafe<{ username: string; password_enc: string }[]>(
    `SELECT username, password_enc FROM investor_feed_creds WHERE bank = 'MB' AND replace(account_number, ' ', '') = $1 ORDER BY updated_at DESC LIMIT 1`,
    acct.replace(/ /g, ''));
  if (credKhop[0]) {
    let matKhau = '';
    try { matKhau = decryptSecret(credKhop[0].password_enc); } catch { /* giải mã hỏng → rơi về đường env */ }
    if (matKhau) {
      let sideRes: globalThis.Response | null = null;
      try {
        // BIEN-KY-BO-QUA: `to` ở route này KHÔNG phải mốc nửa-mở. Màn Tra soát sao kê gửi lên
        // `hi = new Date(`${pr.hi}T23:59:59`)` (StatementReconScreen.tsx:258) = CUỐI ngày cuối, và sidecar
        // mb-feed nhận khoảng ĐÓNG [from, to] theo NGÀY (bank-feed.ts: "lấy giao dịch trong [from, to]").
        // Lùi 1ms ở đây sẽ CẮT MẤT ngày cuối — ngược hẳn lỗi mà cổng đang đi tìm. Đã đối chiếu cả 2 đầu.
        sideRes = await fetch(`${cfg.baseUrl ?? 'http://127.0.0.1:8797'}/transactions`, {
          method: 'POST', headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          // BIEN-KY-BO-QUA: `to` là CUỐI ngày cuối (23:59:59), khoảng ĐÓNG — lùi 1ms sẽ cắt mất ngày cuối.
          body: JSON.stringify({ username: credKhop[0].username, password: matKhau, account: acct, from: ngayVN(from), to: ngayVN(to) })
        });
      } catch { sideRes = null; }
      const side = sideRes ? ((await sideRes.json().catch(() => null)) as { transactions?: unknown[]; error?: string; message?: string } | null) : null;
      if (sideRes?.ok && side && Array.isArray(side.transactions)) r = { ok: true, txns: mapMbLib(side.transactions) };
      else r = { ok: false, error: side?.error ?? 'MB_FAIL', message: side?.message ?? 'Không gọi được dịch vụ lấy sao kê MB (mb-feed).' };
    } else r = await fetchBankFeed(cfg, { accountNumber: acct, from, to });
  } else {
    r = await fetchBankFeed(cfg, { accountNumber: acct, from, to });
  }
  if (!r.ok) { res.status(400).json({ ok: false, error: r.error, message: r.message }); return; }
  if (r.txns.length === 0) {
    res.status(400).json({ ok: false, error: 'NO_TXN', message: `Không có giao dịch nào cho TK ${acct} trong kỳ đã chọn (nguồn tự động MB).` });
    return;
  }
  const statement = bankFeedToParsedStatement(r.txns, { provider: cfg.provider, accountNumber: acct });
  const recon = await reconcileStatement(getBotDb(), statement);
  await cacheStatementTxns(getBotDb(), statement);
  res.json({ ok: true, data: { ...recon, warnings: [...(statement.warnings ?? []), `Nguồn: MB tự động (mb-feed). ${KIEM_TRUOC_KHI_TIN}`] } });
}));

// [Admin Demo 13/9] CHECK SAO KÊ BÁO CÓ trong NHÓM NĐT — đối chiếu tiền về sau phí cài máy từng lô của NĐT.
// PREFIX RIÊNG /v1/investor-baoco/* (KHÔNG /v1/statement-recon/* — nhóm đó guard CHỈ-CHỦ-SIGMA khoá cứng; check
// báo có NĐT mở cho THÀNH VIÊN NHÓM, scope chặt agentScopeInvestorIds bên dưới — 403 người ngoài nhóm).
// MB: đăng nhập tự động (user + mật khẩu → sidecar mb-feed per-request; cred lưu AES investor_feed_creds, lần sau
// bỏ trống = dùng cred đã lưu). MBV: tải file .xlsx (/investor-baoco-upload). Scope: NĐT phải thuộc nhóm người gọi.
ocrSendRouter.post('/v1/investor-baoco/check', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const db = getBotDb();
  const b = (req.body ?? {}) as { investorId?: unknown; from?: unknown; to?: unknown; username?: unknown; password?: unknown; accountNumber?: unknown; source?: unknown };
  const investorId = Number(b.investorId);
  const fromDay = String(b.from ?? ''), toDay = String(b.to ?? '');
  if (!Number.isInteger(investorId) || investorId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay)) {
    res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Cần investorId + from/to (YYYY-MM-DD).' }); return;
  }
  const scoped = await agentScopeInvestorIds(db, req.agent!.id);
  if (!scoped.includes(investorId)) { res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'Không có quyền xem NĐT này.' }); return; }
  // [Admin Demo 13/9 "xem nội dung sao kê các ngày trước"] source='CACHE': đọc statement_txn ĐÃ LƯU (kéo MB/tải file
  // trước đó) theo các TK nhận tiền của NĐT — không gọi MB, xem lại kỳ nào cũng được.
  if (String(b.source ?? '') === 'CACHE') {
    const raAccts = await db.$queryRawUnsafe<{ acct: string }[]>(
      `SELECT replace(account_number, ' ', '') AS acct FROM receive_accounts WHERE investor_id = $1 AND deleted_at IS NULL`, investorId);
    const accts = raAccts.map((r) => r.acct).filter(Boolean);
    if (accts.length === 0) { res.status(400).json({ ok: false, error: 'NO_ACCOUNT', message: 'NĐT chưa có tài khoản nhận tiền nào.' }); return; }
    const cached = await db.$queryRawUnsafe<{ ref: string; date_time: string | null; debit: bigint; credit: bigint; balance: bigint | null; desc_name: string | null; cp_name: string | null; src_account: string | null }[]>(
      `SELECT ref, date_time, debit, credit, balance, COALESCE(descr, desc_name) AS desc_name, cp_name, src_account FROM statement_txn
        WHERE replace(COALESCE(src_account,''), ' ', '') = ANY($1::text[]) AND day >= $2 AND day <= $3
        ORDER BY date_time`, accts, fromDay, new Date(Date.parse(`${toDay}T12:00:00Z`) + 24 * 3600 * 1000).toISOString().slice(0, 10)); // + sáng T+1 (ca 3)
    if (cached.length === 0) { res.status(400).json({ ok: false, error: 'NO_CACHE', message: 'Chưa có sao kê nào lưu cho kỳ này — kéo MB hoặc tải file trước.' }); return; }
    const txnsCache = cached.map((r, i) => ({
      rowIndex: i + 1, ref: r.ref, dateTime: r.date_time, debit: Number(r.debit), credit: Number(r.credit),
      balance: r.balance != null ? Number(r.balance) : null,
      desc: r.desc_name ?? r.cp_name, cpName: r.cp_name, cpAccount: null, cpBank: null, descName: r.desc_name
    }));
    const rc = await doiChieuBaocoNdt(db, investorId, fromDay, toDay, txnsCache, String(b.accountNumber ?? '').trim() || null);
    res.json(rc); return;
  }
  let username = String(b.username ?? '').trim();
  let password = String(b.password ?? '');
  let account = String(b.accountNumber ?? '').trim();
  // Bỏ trống → cred đã lưu của NĐT (MB).
  if (!username || !password) {
    const cred = await db.$queryRawUnsafe<{ username: string; password_enc: string; account_number: string }[]>(
      `SELECT username, password_enc, account_number FROM investor_feed_creds WHERE investor_id = $1 AND bank = 'MB'`, investorId);
    if (!cred[0]) { res.status(400).json({ ok: false, error: 'NO_CRED', message: 'Chưa có đăng nhập MB lưu cho NĐT này — nhập user + mật khẩu (+ số TK) lần đầu.' }); return; }
    username = cred[0].username;
    try { password = decryptSecret(cred[0].password_enc); }
    catch { res.status(400).json({ ok: false, error: 'CRED_DECRYPT', message: 'Không giải mã được mật khẩu đã lưu — nhập lại user + mật khẩu.' }); return; }
    if (!account) account = cred[0].account_number;
  }
  if (!account) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu số tài khoản sao kê.' }); return; }
  const token = process.env.MB_FEED_TOKEN ?? '';
  if (!token) { res.status(503).json({ ok: false, error: 'NO_PROVIDER', message: 'Máy chủ chưa cấu hình MB_FEED_TOKEN (sidecar mb-feed).' }); return; }
  let sideRes: globalThis.Response;
  try {
    sideRes = await fetch(`${process.env.MB_FEED_URL ?? 'http://127.0.0.1:8797'}/transactions`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // [Admin Demo 13/9] kéo THÊM ngày T+1: ca 3 của ngày cuối kỳ về sáng hôm sau mới có báo có.
      body: JSON.stringify({ username, password, account, from: fromDay, to: new Date(Date.parse(`${toDay}T12:00:00Z`) + 24 * 3600 * 1000).toISOString().slice(0, 10) })
    });
  } catch { res.status(502).json({ ok: false, error: 'FEED_DOWN', message: 'Không gọi được dịch vụ lấy sao kê MB (mb-feed chưa chạy?).' }); return; }
  const side = (await sideRes.json().catch(() => null)) as { transactions?: unknown[]; error?: string; message?: string } | null;
  if (!sideRes.ok || !side || !Array.isArray(side.transactions)) {
    res.status(400).json({ ok: false, error: side?.error ?? 'MB_FAIL', message: side?.message ?? `MB trả lỗi HTTP ${sideRes.status}.` }); return;
  }
  const parsed = bankFeedToParsedStatement(mapMbLib(side.transactions), { provider: 'MBLIB', accountNumber: account, bank: 'MB' });
  // [Admin Demo 13/9 "sao kê về phải lưu cache như tra soát"] lưu bền statement_txn (khoá ref, upsert) —
  // xem lại ngày trước KHÔNG cần kéo MB lại (tab "Đã lưu"), màn Tra soát (owner) cũng thấy chung nguồn.
  await cacheStatementTxns(db, parsed);
  // Kéo THÀNH CÔNG → lưu cred (AES) cho lần sau. Best-effort, KHÔNG log mật khẩu.
  if (String(b.username ?? '').trim()) {
    try {
      await db.$executeRawUnsafe(
        `INSERT INTO investor_feed_creds (investor_id, bank, username, password_enc, account_number, updated_at) VALUES ($1,'MB',$2,$3,$4,now())
         ON CONFLICT (investor_id, bank) DO UPDATE SET username=$2, password_enc=$3, account_number=$4, updated_at=now()`,
        investorId, username, encryptSecret(password), account);
    } catch (e) { console.error('[investor-baoco] lưu cred lỗi (không chặn):', e instanceof Error ? e.message : e); }
  }
  const r = await doiChieuBaocoNdt(db, investorId, fromDay, toDay, parsed.txns, account);
  res.json(r); // TRẢ PHẲNG — client jsonCall tự bọc
}));

// [Admin Demo 13/9 "thêm nút tải sao kê — đúng định dạng"] TẢI .xlsx bố cục SAO KÊ MB chuẩn từ cache (đã kéo MB/
// tải file) theo TK của NĐT trong kỳ (ngày bank). Scope thành viên nhóm như /check.
ocrSendRouter.post('/v1/investor-baoco/export-saoke', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const db = getBotDb();
  const b = (req.body ?? {}) as { investorId?: unknown; from?: unknown; to?: unknown; accountNumber?: unknown };
  const investorId = Number(b.investorId);
  const fromDay = String(b.from ?? ''), toDay = String(b.to ?? '');
  if (!Number.isInteger(investorId) || investorId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay)) {
    res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Cần investorId + from/to (YYYY-MM-DD).' }); return;
  }
  const scoped = await agentScopeInvestorIds(db, req.agent!.id);
  if (!scoped.includes(investorId)) { res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'Không có quyền xem NĐT này.' }); return; }
  const raAccts = await db.$queryRawUnsafe<{ acct: string; holder: string | null }[]>(
    `SELECT replace(account_number, ' ', '') AS acct, account_name AS holder FROM receive_accounts WHERE investor_id = $1 AND deleted_at IS NULL`, investorId);
  const acctFilter = String(b.accountNumber ?? '').replace(/\s/g, '');
  const accts = (acctFilter ? raAccts.filter((r) => r.acct === acctFilter) : raAccts).map((r) => r.acct).filter(Boolean);
  if (accts.length === 0) { res.status(400).json({ ok: false, error: 'NO_ACCOUNT', message: 'Không có tài khoản phù hợp.' }); return; }
  const rows = await db.$queryRawUnsafe<{ ref: string; date_time: string | null; debit: bigint; credit: bigint; balance: bigint | null; desc_name: string | null; cp_name: string | null; cp_account: string | null; cp_bank: string | null; src_account: string | null; src_bank: string | null }[]>(
    `SELECT ref, date_time, debit, credit, balance, COALESCE(descr, desc_name) AS desc_name, cp_name, cp_account, cp_bank, src_account, src_bank FROM statement_txn
      WHERE replace(COALESCE(src_account,''), ' ', '') = ANY($1::text[]) AND day >= $2 AND day <= $3 ORDER BY date_time`, accts, fromDay, toDay);
  if (rows.length === 0) { res.status(400).json({ ok: false, error: 'NO_CACHE', message: 'Chưa có sao kê lưu cho kỳ này — kéo MB hoặc tải file trước.' }); return; }
  const buf = await buildSaoKeXlsx(
    rows.map((r) => ({ dateTime: r.date_time, ref: r.ref, debit: Number(r.debit), credit: Number(r.credit), balance: r.balance != null ? Number(r.balance) : null, desc: r.desc_name, cpName: r.cp_name, cpAccount: r.cp_account, cpBank: r.cp_bank })),
    { accountNumber: rows[0].src_account ?? accts[0], accountHolder: null, bank: rows[0].src_bank ?? 'MB', from: fromDay, to: toDay });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="SaoKe_${accts[0]}_${fromDay.replace(/-/g, '')}_${toDay.replace(/-/g, '')}.xlsx"`);
  res.send(buf);
}));

// MBV: tải file sao kê .xlsx — multipart "file"; investorId/from/to ở QUERY.
ocrSendRouter.post('/v1/investor-baoco/upload', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const db = getBotDb();
  const investorId = Number(req.query.investorId);
  const fromDay = String(req.query.from ?? ''), toDay = String(req.query.to ?? '');
  if (!Number.isInteger(investorId) || investorId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay)) {
    res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Cần investorId + from/to (YYYY-MM-DD) ở query.' }); return;
  }
  const scoped = await agentScopeInvestorIds(db, req.agent!.id);
  if (!scoped.includes(investorId)) { res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'Không có quyền xem NĐT này.' }); return; }
  const up = await parseSingleFileUpload(req);
  if (!up.ok || !up.buffer.length) { res.status(400).json({ ok: false, error: 'NO_FILE', message: 'Chưa chọn file sao kê (.xlsx MBV/MB).' }); return; }
  let statement;
  try { statement = await parseMbStatement(up.buffer); }
  catch (e) { res.status(400).json({ ok: false, error: 'PARSE_FAIL', message: 'Không đọc được file sao kê: ' + ((e as Error)?.message ?? 'lỗi') }); return; }
  if (statement.txns.length === 0) {
    res.status(400).json({ ok: false, error: 'NO_TXN', message: 'Không đọc được giao dịch nào trong file. ' + (statement.warnings ?? []).join(' ') }); return;
  }
  await cacheStatementTxns(db, statement); // [Admin Demo 13/9] lưu cache như tra soát — xem lại không cần tải lại file
  const r = await doiChieuBaocoNdt(db, investorId, fromDay, toDay, statement.txns, statement.accountNumber);
  res.json({ ok: true, data: r }); // upload client parser đọc {ok,data} (như /upload)
}));

// [Admin Demo 12/9] ĐỐI CHIẾU SỐ DƯ CUỐI NGÀY: tổng số dư các TK SigMa (từ cột "Số dư" sao kê đã nạp) PHẢI KHỚP
// = Σ phải hoàn NĐT (tiền về sau phí cài máy + lãi NĐT) + lãi công ty. Lệch → trả số thừa/thiếu + chi tiết từng
// NĐT/TK để tìm tiền. Owner-gate. Body {day?: YYYY-MM-DD} (mặc định hôm nay HCM).
ocrSendRouter.post('/v1/statement-recon/balance-check', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { day?: unknown };
  const dayRaw = typeof b.day === 'string' && b.day ? b.day : new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayRaw)) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'day phải là YYYY-MM-DD.' }); return; }
  const r = await buildBalanceCheck(getBotDb(), dayRaw);
  res.json(r); // TRẢ PHẲNG — client jsonCall tự bọc {ok,data} (như /cached), KHÔNG bọc thêm

}));

// [Admin Demo 7/9] LOAD lại toàn bộ sao kê đã cache (mở màn → tự có, như báo cáo doanh số). Owner-gate.
ocrSendRouter.post('/v1/statement-recon/cached', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (_req: Request, res: Response) => {
  const r = await loadCachedReconciled(getBotDb());
  res.json(r); // [Admin Demo 8/9 — SỬA GỐC "mất cache"] TRẢ TRỰC TIẾP {txns} (jsonCall tự bọc {ok,data}) — KHÔNG bọc thêm.
}));

// [Admin Demo 8/9] BÁO CÁO BILL THIẾU ẢNH OCR — đối chiếu chéo GD hoàn sao kê vs bill hoàn OCR; GD không có bill khớp
// (đại lý+ngày+tiền ±3k, dung sai hoàn dư ≤10k/ngày) → thiếu bill, đích danh đại lý. Owner-gate. from/to = YYYY-MM-DD.
ocrSendRouter.post('/v1/statement-recon/missing-bills', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const from = typeof req.body?.from === 'string' ? req.body.from.slice(0, 10) : '2000-01-01';
  const to = typeof req.body?.to === 'string' ? req.body.to.slice(0, 10) : '2999-12-31';
  const r = await findMissingOcrBills(getBotDb(), from, to);
  res.json(r); // {rows} — client jsonCall tự bọc {ok,data}
}));

// [Admin Demo 8/9] XUẤT EXCEL .xlsx THẬT (exceljs) — hết cảnh báo "format and extension don't match" của SpreadsheetML .xls.
// Client gửi txns ĐANG LỌC + nhãn chu kỳ → trả file .xlsx binary. Owner-gate.
ocrSendRouter.post('/v1/statement-recon/export-xlsx', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const txns = Array.isArray(req.body?.txns) ? (req.body.txns as XlsxTxn[]) : null;
  const periodLabel = typeof req.body?.periodLabel === 'string' ? req.body.periodLabel : '';
  if (!txns) { res.status(400).json({ ok: false, error: 'NO_TXN', message: 'Không có dữ liệu để xuất.' }); return; }
  const buf = await buildStatementReconXlsx(txns, periodLabel);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="TraSoatSaoKe.xlsx"');
  res.send(buf);
}));

// [Admin Demo 8/9 — BILL AN BÌNH] OCR ẢNH CHỤP lịch sử giao dịch (ABB không xuất sao kê) → GD phân loại + khớp đại lý/NĐT
// + CACHE (như sao kê xlsx) để gộp vào 2 tab tra soát. Multipart field "file" (1 ảnh, nhiều GD). Owner-gate.
// srcAccount/srcBank optional (client truyền khi biết TK ABB); mặc định ABB, TK lấy từ ảnh.
ocrSendRouter.post('/v1/statement-recon/ocr-image', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const parsed = await parseSingleFileUpload(req);
  if (!parsed.ok || !parsed.buffer.length) { res.status(400).json({ ok: false, error: 'NO_FILE', message: 'Chưa chọn ảnh giao dịch (hoặc ảnh quá lớn).' }); return; }
  const force = req.query.force === '1' || req.query.force === 'true';
  const ocr = await readBankHistory(parsed.buffer, force);
  if (ocr.failed) { res.status(400).json({ ok: false, error: 'OCR_FAIL', message: 'Không đọc được ảnh giao dịch: ' + (ocr.failReason ?? 'lỗi OCR') }); return; }
  if (ocr.txns.length === 0) { res.status(400).json({ ok: false, error: 'NO_TXN', message: 'Ảnh không có giao dịch nào đọc được (kiểm tra đúng ảnh chụp lịch sử giao dịch).' }); return; }
  const srcAccount = typeof req.body?.srcAccount === 'string' ? req.body.srcAccount : null;
  const srcBank = typeof req.body?.srcBank === 'string' ? req.body.srcBank : 'ABB';
  const statement = bankHistoryToParsedStatement(ocr, { srcAccount, srcBank });
  const recon = await reconcileStatement(getBotDb(), statement);
  // [Admin Demo 8/9] PREVIEW: KHÔNG cache ở đây — trả review cho user SỬA + "Xác nhận" mới nạp (qua /ocr-commit). Như quét bill gửi.
  res.json({ ok: true, data: recon }); // client uploadStatementImage dùng parser riêng như uploadStatement → wrapper {ok,data}
}));

// [Admin Demo 8/9 — ABB REVIEW] XÁC NHẬN nạp các GD đã review/sửa từ OCR ảnh → cache (raw + override) → hiện ở 2 tab tra soát.
ocrSendRouter.post('/v1/statement-recon/ocr-commit', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const txns = Array.isArray(req.body?.txns) ? req.body.txns : null;
  if (!txns || txns.length === 0) { res.status(400).json({ ok: false, error: 'NO_TXN', message: 'Không có giao dịch nào để nạp.' }); return; }
  await cacheReconciledTxns(getBotDb(), txns);
  res.json({ ok: true, data: { count: txns.length } });
}));

// [Admin Demo 7/9] SỬA TAY 1 giao dịch sao kê (loại/hoàn cho ai/ngày hiệu lực/ghi chú) — nhớ CACHE theo Mã Tham Chiếu (ref)
// để re-upload sao kê vẫn áp lần sửa gần nhất. Owner-gate (sao kê nhạy cảm).
ocrSendRouter.post('/v1/statement-recon/edit', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { ref?: string; kind?: string | null; targetName?: string | null; effectiveDate?: string | null; note?: string | null };
  if (!b.ref) { res.status(400).json({ ok: false, error: 'NO_REF', message: 'Giao dịch không có Mã Tham Chiếu — không lưu sửa được.' }); return; }
  const r = await saveStatementOverride(getBotDb(), { ref: String(b.ref), kind: b.kind, targetName: b.targetName, effectiveDate: b.effectiveDate, note: b.note });
  if (!r.ok) { res.status(400).json({ ok: false, error: r.error }); return; }
  res.json({ ok: true });
}));

// [Admin Demo 7/9 — SỬA BILL HOÀN] Sửa ngày/giờ/tiền bill HOÀN/ỨNG (CK) trên bảng đối soát hoàn tiền — password-gated.
// Cập nhật metadata (billDate ISO → reconcile đúng ngày · refundAmount · billDateTimeRaw) + re-key ckTxnKey + caption.
ocrSendRouter.post('/v1/ocr-send/edit-refund-bill', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const db = getBotDb();
  const b = (req.body ?? {}) as { messageId?: string; editPassword?: string; patch?: { billDate?: string; billTime?: string; amount?: number } };
  if (!b.messageId || !b.patch) { res.status(400).json({ ok: false, error: 'VALIDATION' }); return; }
  const r = await editRefundBillParams(db, { messageId: String(b.messageId), editPassword: String(b.editPassword ?? ''), patch: b.patch });
  if (!r.ok) { res.status(r.error === 'BAD_PASSWORD' ? 403 : r.error === 'NOT_FOUND' || r.error === 'NOT_REFUND' ? 404 : 400).json(r); return; }
  res.json(r);
}));
