// FEATURE "QUÉT BILL GỬI" (menu SigMa, Admin Demo 30/8) — CORE service. Thay OCR-tự-động-trong-nhóm (đã dừng).
// Luồng: người bấm chọn ảnh bill (upload/camera/folder) → OCR Sonnet@2400 (đúng 100%, đã kiểm chứng nhóm Bảo) →
// tự nhận TID · đại lý · tiền · lô · giờ → REVIEW (người sửa/xác nhận) → GỬI: đăng ảnh+tóm tắt vào NHÓM ĐẠI LÝ
// (theo TID) + CC NHÓM NĐT.
//
// 2 ĐÍCH = 2 PHÍ (Admin Demo, money — cấm nhầm):
//   • Nhóm ĐẠI LÝ  → PHÍ BÁN (đại lý được xem). Fail-closed nếu chưa cấu hình / mơ hồ loại phí.
//   • Nhóm NĐT     → CHỈ PHÍ CÀI MÁY (resolveInstallFeeMilli). TUYỆT ĐỐI KHÔNG phí bán/%/net/doanh thu/tên khách.
//
// DEDUPE (Admin Demo): bill đã gửi → cảnh báo "đã gửi, gửi lại?"; vẫn gửi → đánh dấu TRÙNG. Khoá idempotent
// `ocrSendKey = VL|tid|lô|ngày` trên metadataJson tin ĐẠI LÝ.
//
// TÁI DÙNG (cấm viết lại): readBillForSend/fileToPng (zalo-watcher), resolveInstallFeeMilli (@sigma/services),
// resolveInvestorRoomForTid + ensureAlphaBotAgent (investor-crosspost-service), saveAttachment/sendMessage.
import { kiemTraSoLo, kiemTraNgayBill, type DayLoMay } from './lot-sanity.js';
import { createHash } from 'node:crypto';
import { resolveInstallFeeMilli, aggregateLotRevenue, resolveWeekendSellDeltaMilli, resolveQrFeeForTid, resolveQrDealerSellFee } from '@sigma/services';
import { ingestInvestorAdvance, recordInvestorRepayment } from './investor-advance-ingest.js';
import { resolveActualSellFee, pickEffectiveRate } from '@sigma/business-rules';
import { classifyCardType, pickDefaultCardTypeId, type CardOption } from './card-classify.js';
import { ensureSupportAlphaAgent } from './zalo-bill-support.js';
import { verifyBillEditPassword } from './bill-edit-password-service.js';
import type { getBotDb } from './db.js';
// OCR chạy Ở SERVICE RIÊNG dưới Administrator (Admin Demo 30/8) — bot-api (SYSTEM) KHÔNG nạp sharp/`claude -p`
// in-process (sharp DLOPEN fail + claude không đăng nhập theo SYSTEM). Gọi qua HTTP nội bộ 127.0.0.1. Xem
// apps/zalo-watcher/src/ocr-http-server.mjs. Fail-closed nếu thiếu token / service chết.
const OCR_HTTP_URL = process.env.OCR_HTTP_URL || 'http://127.0.0.1:8796';
const OCR_HTTP_TOKEN = process.env.OCR_HTTP_TOKEN || '';
// CẤM TÁI DIỄN (Admin Demo 31/8 "OCR đến bill 5/8 thì treo, kiểm tra sâu"): fetch KHÔNG timeout → nếu OCR service
// (Sonnet@2400) kẹt 1 ảnh (vision API stall) thì proxy treo VÔ HẠN → frontend spinner "Đang OCR bill X" mãi mãi,
// không recover. Timeout ĐỘNG (rộng cho Sonnet ảnh lớn) → AbortSignal.timeout ném TimeoutError → catch trả
// failed → route 502 → client BỎ QUA bill đó + sang bill kế (KHÔNG treo cả phiên quét). Xem BUGS_FIXED B142.
const OCR_HTTP_TIMEOUT_MS = Number(process.env.OCR_HTTP_TIMEOUT_MS) || 150_000;

/** CHUẨN HOÁ 1 bill về ĐÚNG 6 trường đồng nhất (Admin Demo "mọi trường OCR phải đồng nhất") — 1 nguồn định nghĩa,
 *  không tin partial JSON từ service. Trùng khớp parseBills (vision-ocr) + OcrBill + client mirror + VisionBill. */
export function normalizeBill(raw: unknown): OcrBill {
  const b = (raw ?? {}) as Record<string, unknown>;
  const s = (v: unknown): string | null => { const t = (v == null ? '' : String(v)).trim(); return t || null; };
  return {
    tid: s(b.tid),
    agencyName: s(b.agencyName),
    batchNumber: s(b.batchNumber),
    type: b.type === 'SETTLEMENT' ? 'SETTLEMENT' : 'SALE',
    totalAmount: Number(b.totalAmount) || 0,
    dateTime: s(b.dateTime),
    settlementCode: b.settlementCode ? String(b.settlementCode).replace(/[^0-9]/g, '') || null : null, // mã ĐÓNG(nn) — rủi ro hoàn tiền/hủy GD sau (Admin Demo)
    voidCount: Number(b.voidCount) || 0,   // [17/9] dòng "HỦY" trên tờ tổng kết
    voidAmount: Number(b.voidAmount) || 0
  };
}

/** [Phản biện 11/9 — BILL 95 RỚT CỜ Ở GỬI] Chuẩn hoá bill do CLIENT gửi lên /send (1 nguồn định nghĩa — route CẤM
 *  tự dựng tay từng field). Bug gốc: route /send tự dựng object và RƠI `settlementCode` (client cũng rơi) →
 *  bill95CaptionPrefix KHÔNG BAO GIỜ bắn trên tin gửi thật (cảnh báo ĐÓNG LÔ 95 = rủi ro hoàn/hủy GD chết câm ở
 *  đường LIVE dù test prefix xanh — đúng lớp R201 "hàm có mà lớp live không nối"). type mặc định SETTLEMENT
 *  (giữ hành vi /send cũ — gửi lô kết toán), KHÁC normalizeBill (mặc định SALE cho OCR thô). */
export function parseClientBill(b: Record<string, unknown>): OcrBill {
  const s = (v: unknown): string | null => { const t = (v == null ? '' : String(v)).trim(); return t || null; };
  return {
    tid: s(b.tid),
    agencyName: s(b.agencyName),
    batchNumber: s(b.batchNumber),
    type: b.type === 'SALE' ? 'SALE' : 'SETTLEMENT',
    totalAmount: Number(b.totalAmount) || 0,
    dateTime: s(b.dateTime),
    settlementCode: b.settlementCode ? String(b.settlementCode).replace(/[^0-9]/g, '') || null : null,
    voidCount: Number(b.voidCount) || 0,   // [17/9] client PHẢI gửi kèm, rơi field = mất phần trừ hủy
    voidAmount: Number(b.voidAmount) || 0
  };
}

/** Gọi OCR service (POST). body = Buffer (ảnh raw) HOẶC object (JSON). Trả {bills, failed, cached}. */
/** Kết quả OCR service. consensus = đối chứng 2 lần đọc field tiền (Admin Demo 3/9): ok=false → OCR đọc lệch (vd 0↔6) →
 *  reviewBills gắn CỜ ĐỎ "kiểm tay". null/singleRead = không đối chứng (UNKNOWN/failed) hoặc service cũ chưa trả. */
export type OcrConsensus = { ok: boolean; singleRead?: boolean; first?: string; second?: string } | null;
export type OcrServiceResult = { bills: OcrBill[]; transfers?: TransferRaw[]; qr?: QrRaw[]; kind?: 'POS' | 'TRANSFER' | 'QR' | 'UNKNOWN'; failed?: boolean; cached?: boolean; consensus?: OcrConsensus; failReason?: string | null; qrSource?: string | null; qrWarnings?: string[] };
async function ocrServiceCall(path: string, body: Buffer | object): Promise<OcrServiceResult> {
  if (!OCR_HTTP_TOKEN) { console.error('[ocr-send] OCR_HTTP_TOKEN chưa cấu hình — fail-closed.'); return { bills: [], failed: true }; }
  const isBuf = Buffer.isBuffer(body);
  try {
    const res = await fetch(`${OCR_HTTP_URL}${path}`, {
      method: 'POST',
      headers: { 'x-ocr-token': OCR_HTTP_TOKEN, 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json' },
      body: isBuf ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(OCR_HTTP_TIMEOUT_MS) // CHỐNG TREO: quá hạn → TimeoutError → catch → failed (client bỏ qua bill).
    });
    if (!res.ok) { console.error(`[ocr-send] OCR service ${path} HTTP ${res.status}`); return { bills: [], failed: true }; }
    // [Đợt 2 QR] Forward field `qr` từ OCR service (ocr-http-server.mjs → vision-ocr readBillOrTransfer kind='QR').
    const j = (await res.json()) as { bills?: unknown[]; transfers?: TransferRaw[]; qr?: QrRaw[]; kind?: 'POS' | 'TRANSFER' | 'QR' | 'UNKNOWN'; failed?: boolean; cached?: boolean; consensus?: OcrConsensus; failReason?: string | null; qrSource?: string | null; qrWarnings?: string[] };
    // [Admin Demo 8/9] Forward NGUỒN đọc bill QR (local/claude) + CẢNH BÁO của tầng OCR (tên HKD bị cắt, 2 lần đọc lệch…)
    // — R198: cảnh báo phải tới được người duyệt, không nuốt ở tầng trung gian.
    return { bills: (j.bills ?? []).map(normalizeBill), transfers: j.transfers ?? [], qr: j.qr ?? [], kind: j.kind ?? 'UNKNOWN', failed: j.failed, cached: j.cached, consensus: j.consensus ?? null, failReason: j.failReason ?? null, qrSource: j.qrSource ?? null, qrWarnings: j.qrWarnings ?? [] };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    console.error(`[ocr-send] OCR service ${path} ${timedOut ? `TIMEOUT (>${OCR_HTTP_TIMEOUT_MS}ms) — ảnh này bỏ qua, KHÔNG treo phiên quét` : 'lỗi kết nối (service Administrator chạy chưa?)'}:`, e);
    return { bills: [], failed: true };
  }
}

/** [Admin Demo 8/9] Ảnh bill được ĐỔI TÊN sau OCR ("1 - Đã thành công - …") → báo OCR service DỜI SỔ (đã đọc +
 *  FAILED) sang tên mới. Không dời thì: quét lại coi như ảnh mới (mất dấu "đã đọc") và sổ lỗi trỏ file không còn.
 *  Best-effort: hỏng KHÔNG chặn luồng (chỉ log) vì cache NỘI DUNG theo hash ảnh vẫn giữ (không tốn quota). */
export async function ocrRenameProcessed(oldPath: string, newPath: string): Promise<{ ok: boolean; processed?: boolean; failed?: boolean; error?: string }> {
  if (!OCR_HTTP_TOKEN) return { ok: false, error: 'OCR_HTTP_TOKEN chưa cấu hình' };
  try {
    const res = await fetch(`${OCR_HTTP_URL}/processed-rename`, {
      method: 'POST',
      headers: { 'x-ocr-token': OCR_HTTP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPath, newPath }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = (await res.json()) as { processed?: boolean; failed?: boolean };
    return { ok: true, processed: !!j.processed, failed: !!j.failed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ocr-send] dời sổ đổi tên ảnh lỗi: ${msg}`);
    return { ok: false, error: msg };
  }
}

/** [Admin Demo 8/9 — BILL AN BÌNH] OCR ẢNH CHỤP LỊCH SỬ GIAO DỊCH (bank không xuất sao kê: ABB…) → {account, txns[]}.
 *  1 ảnh nhiều GD. amount CÓ DẤU (âm=ra/ghi nợ, dương=vào/báo có). Fail-closed nếu thiếu token. */
export type BankHistoryTxn = { date: string | null; time: string | null; amount: number; cpName: string | null; cpBank: string | null };
export async function readBankHistory(image: Buffer, force = false): Promise<{ account: string | null; txns: BankHistoryTxn[]; failed: boolean; failReason?: string | null }> {
  if (!OCR_HTTP_TOKEN) { console.error('[ocr-send] OCR_HTTP_TOKEN chưa cấu hình — fail-closed (bank-history).'); return { account: null, txns: [], failed: true, failReason: 'OCR chưa cấu hình' }; }
  try {
    const res = await fetch(`${OCR_HTTP_URL}/ocr-bank-history${force ? '?force=1' : ''}`, {
      method: 'POST', headers: { 'x-ocr-token': OCR_HTTP_TOKEN, 'Content-Type': 'application/octet-stream' },
      body: image, signal: AbortSignal.timeout(OCR_HTTP_TIMEOUT_MS)
    });
    if (!res.ok) { console.error(`[ocr-send] /ocr-bank-history HTTP ${res.status}`); return { account: null, txns: [], failed: true, failReason: `HTTP ${res.status}` }; }
    const j = (await res.json()) as { account?: string | null; txns?: BankHistoryTxn[]; failed?: boolean; failReason?: string | null };
    return { account: j.account ?? null, txns: Array.isArray(j.txns) ? j.txns : [], failed: j.failed === true, failReason: j.failReason ?? null };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    console.error(`[ocr-send] /ocr-bank-history ${timedOut ? 'TIMEOUT' : 'lỗi kết nối'}:`, e);
    return { account: null, txns: [], failed: true, failReason: timedOut ? 'OCR quá hạn' : 'OCR lỗi kết nối' };
  }
}

/** CỜ ĐỎ khi OCR đọc 2 lần LỆCH field tiền (Admin Demo 3/9) — gắn vào MỌI review item của ảnh đó để người kiểm tay
 *  (KHÔNG tự chọn bên nào — cấm suy luận tiền). null nếu đồng thuận / không đối chứng. */
export function consensusWarning(consensus: OcrConsensus): string | null {
  if (!consensus || consensus.ok !== false) return null;
  return '⚠ OCR đọc 2 LẦN LỆCH nhau ở field quyết định tiền (TID/lô/số tiền) — KIỂM TAY kỹ trước khi gửi (số dễ nhầm: 0↔6, 1↔7...).';
}

/** Khoảng cách Levenshtein (giới hạn nhỏ) giữa 2 chuỗi TID — để tìm TID hợp lệ GẦN NHẤT khi OCR nhầm 1-2 số. */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99; // lệch độ dài quá xa → không phải nhầm số → bỏ nhanh
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

/** TID HỢP LỆ gần nhất (edit-distance ≤ maxDist) với chuỗi OCR đọc — bắt vụ 59930002↔59930062 khi tên HKD không suy
 *  được. Trả danh sách {tid, hkdName} sắp theo khoảng cách tăng dần (gần nhất trước). Rỗng nếu OCR TID rỗng/không gần. */
export function nearestValidTids(ocrTid: string, rows: { tid: string; hkdName: string | null }[], maxDist = 2, ocrHkdName: string | null = null): { tid: string; hkdName: string }[] {
  const t = (ocrTid ?? '').trim();
  if (!t) return [];
  // [Audit 3/9 #21] Ưu tiên TID CÙNG HỌ HKD (OCR đọc được tên) — trước đây chỉ sort theo edit-distance → TID của CHỦ
  // KHÁC (gần chuỗi) lên đầu → dễ snap nhầm máy (tiền vào sai chủ). Cùng họ trước, rồi mới đến gần-chuỗi.
  const base = ocrHkdName ? normalizeHkdKey(ocrHkdName).replace(/\d+$/, '') : '';
  return rows
    .map((r) => ({ tid: r.tid, hkdName: r.hkdName ?? '', d: editDistance(t, r.tid), fam: base && normalizeHkdKey(r.hkdName).replace(/\d+$/, '') === base ? 0 : 1 }))
    .filter((x) => x.d >= 1 && x.d <= maxDist)
    .sort((a, b) => a.fam - b.fam || a.d - b.d)
    .slice(0, 4)
    .map(({ tid, hkdName }) => ({ tid, hkdName }));
}

/** Kiểm file NÀO đã đọc (sổ file-đã-đọc ở OCR service) — cho /scan đánh dấu "bill mới" vs "đã quét, bỏ qua"
 *  (Admin Demo: tự nhận diện bill mới, không đốt quota). Trả {path: đãĐọc?}. Lỗi kết nối → coi như CHƯA đọc (an toàn:
 *  thà quét lại còn hơn bỏ sót; cache vẫn chặn đốt quota nếu thực ra đã đọc). */
export async function processedStatus(paths: string[]): Promise<Record<string, boolean>> {
  if (!OCR_HTTP_TOKEN || paths.length === 0) return {};
  try {
    const res = await fetch(`${OCR_HTTP_URL}/processed-status`, {
      method: 'POST', headers: { 'x-ocr-token': OCR_HTTP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ paths })
    });
    if (!res.ok) return {};
    return ((await res.json()) as { processed?: Record<string, boolean> }).processed ?? {};
  } catch { return {}; }
}
import { ensureAlphaBotAgent, resolveInvestorRoomForTid } from './investor-crosspost-service.js';
import { REFUND_MATCH_TOLERANCE_VND } from './refund-service.js';
import { loHienThi } from './lo-service.js'; // [16/9] số lô hiển thị "84(95)" khi bill đóng lô
import { classifyTransfer, loadAliases, recordAlias, loadCorrections, recordCorrection, normalizeVi as normVi, type ClassifyContext, type TransferDirection, type PartyType, type TransferCorrection } from './transfer-classify.js';
import { lookupSenderBank } from './sender-bank-alias.js';
// Dung sai ĐỐI SOÁT NGÀY (Admin Demo 31/8): tổng thừa/thiếu 1 ngày ≤ 50.000đ = "khớp/đủ" (KHÁC ±3.000đ mỗi CK).
const DAY_RECONCILE_TOLERANCE_VND = Number(process.env.DAY_RECONCILE_TOLERANCE_VND) || 50_000;
// File alias-HỌC append-only (phân loại tay → tự nhận lần sau). Ngoài repo scope, cạnh ocr-cache.
const TRANSFER_ALIAS_PATH = process.env.TRANSFER_ALIAS_PATH || '<REPO>/apps/zalo-watcher/transfer-alias.jsonl';
// [Admin Demo 4/9] Store SỬA-PHÂN-LOẠI-THEO-ẢNH (hướng ứng/hoàn + đối tác) — append-only, khôi phục khi re-OCR. Cache
// trong-process (save endpoint + OCR cùng 1 bot-api) — cập nhật cache khi ghi để khỏi đọc file mỗi bill.
const TRANSFER_CORRECTION_PATH = process.env.TRANSFER_CORRECTION_PATH || '<REPO>/apps/zalo-watcher/transfer-correction.jsonl';
let _corrCache: Map<string, TransferCorrection> | null = null;
function correctionsMap(): Map<string, TransferCorrection> { if (!_corrCache) _corrCache = loadCorrections(TRANSFER_CORRECTION_PATH); return _corrCache; }
/** LƯU bản sửa phân loại CK theo ảnh (từ buffer ảnh gốc → hash). Ghi file + cập nhật cache. */
export function saveTransferCorrectionByBuffer(imageBuffer: Buffer, corr: Omit<TransferCorrection, 'imageHash'>): { ok: boolean; imageHash: string } {
  const imageHash = ocrImageHashOf(imageBuffer);
  const e: TransferCorrection = { imageHash, ...corr };
  recordCorrection(TRANSFER_CORRECTION_PATH, e);
  correctionsMap().set(imageHash, e); // cập nhật cache ngay (không đọc lại file)
  return { ok: true, imageHash };
}
import { roomCustomerTidRows } from './services/chat-room-tid-service.js';
import { saveAttachment } from './chat-attachment-service.js';
import { sendMessage } from './services/chat-message-service.js';
import { broadcastToRoom } from './chat-realtime-hub.js';

type Db = ReturnType<typeof getBotDb>;

/** 1 bill đã OCR (chuẩn hoá từ readBillForSend). tid/agencyName có thể null nếu OCR không chắc (KHÔNG bịa). */
export interface OcrBill {
  tid: string | null;
  agencyName: string | null;
  batchNumber: string | null;
  type: 'SALE' | 'SETTLEMENT';
  totalAmount: number;
  dateTime: string | null;
  settlementCode?: string | null; // mã ĐÓNG(nn) — tín hiệu RỦI RO hoàn tiền/hủy GD sau khi nhận tiền (Admin Demo).
  /** [Admin Demo 17/9 — bill TỔNG KẾT có dòng HỦY] SỐ LƯỢNG + SỐ TIỀN giao dịch bị HỦY in trên tờ tổng kết
   *  (ABBank: "HỦY 1 VND11,000"). `totalAmount` giữ NGUYÊN số dòng "THANH TOÁN" (tổng quẹt) — tiền GHI NHẬN
   *  = totalAmount − voidAmount, tính bằng tienGhiNhan() để còn đối chiếu được, KHÔNG để OCR tự trừ. */
  voidCount?: number | null;
  voidAmount?: number | null;
}

/** [Admin Demo 17/9] TIỀN GHI NHẬN của 1 bill = tổng quẹt − tiền HỦY (ca thật lô 75 TID 67512202: 109.613.000 −
 *  11.000 = 109.602.000). Không có dòng hủy → bằng chính tổng quẹt. Kẹp ≥ 0 và KHÔNG cho hủy > tổng (OCR đọc
 *  lệch cột thì thà giữ nguyên tổng còn hơn ghi số âm/vô lý — chỗ đó có cờ cảnh báo riêng cho người kiểm). */
/**
 * CHUẨN HOÁ các dòng TÁCH THẺ khi bill có GIAO DỊCH HỦY.
 *
 * [Admin Demo 18/9] "nó là hủy gd khác với ghi nhận tách thẻ trong 1 lô" — người review khai tách thẻ theo ĐÚNG
 * SỐ IN TRÊN BILL (tổng = tổng quẹt), còn tiền hủy là khoản riêng của tờ tổng kết. Bắt người ta tự trừ hủy vào
 * một thẻ là sai việc, và đã gây lỗi CHẶN GỬI oan: "tổng tách thẻ (79.993.000) ≠ tổng bill (80.004.000)".
 *
 * Quy tắc ở đây: nhận cả HAI cách khai —
 *   • Σ dòng = tổng quẹt  → hệ TRỪ phần hủy khỏi dòng CÓ SỐ TIỀN LỚN NHẤT (giao dịch hủy gần như luôn nằm trong
 *     nhóm thẻ chạy nhiều nhất; tổng doanh số và tổng phí KHÔNG đổi dù đoán sai thẻ — chỉ phân bổ % giữa các thẻ
 *     xê dịch vài chục đồng). Trả kèm `ghiChu` để tầng trên NÓI RA cho người dùng biết đã trừ ở đâu.
 *   • Σ dòng = tổng quẹt − hủy → người dùng đã tự trừ, giữ nguyên.
 * Khác hai mức đó = khai sai thật → trả null để tầng trên chặn (fail-closed).
 */
export function chuanHoaSplitsTruHuy(
  splits: FeeSplitPart[] | undefined,
  bill: { totalAmount: number; voidAmount?: number | null }
): { splits: FeeSplitPart[] | undefined; ghiChu: string | null } | null {
  if (!splits || splits.length === 0) return { splits, ghiChu: null };
  const tong = splits.reduce((a, p) => a + Math.round(Number(p.amount) || 0), 0);
  const quet = Math.round(Number(bill.totalAmount) || 0);
  const ghi = tienGhiNhan(bill);
  const huy = quet - ghi;
  if (huy <= 0) return { splits, ghiChu: null };        // không có hủy → không đụng gì
  if (Math.abs(tong - ghi) <= 1) return { splits, ghiChu: null };  // người dùng đã tự trừ
  if (Math.abs(tong - quet) > 1) return null;            // khai lệch thật → tầng trên chặn

  const i = splits.reduce((mx, p, idx) => (Number(p.amount) > Number(splits[mx].amount) ? idx : mx), 0);
  if (Math.round(Number(splits[i].amount)) < huy) return null; // dòng lớn nhất còn nhỏ hơn tiền hủy → số vô lý
  const ra = splits.map((p, idx) => (idx === i ? { ...p, amount: Math.round(Number(p.amount)) - huy } : { ...p, amount: Math.round(Number(p.amount)) }));
  return { splits: ra, ghiChu: `Đã trừ tiền hủy ${huy.toLocaleString('vi-VN')}đ khỏi thẻ có số tiền lớn nhất (còn ${ra[i].amount.toLocaleString('vi-VN')}đ) — tổng ghi nhận ${ghi.toLocaleString('vi-VN')}đ.` };
}

export function tienGhiNhan(bill: { totalAmount: number; voidAmount?: number | null }): number {
  const tong = Math.round(Number(bill.totalAmount) || 0);
  const huy = Math.round(Number(bill.voidAmount) || 0);
  if (huy <= 0 || huy > tong) return tong;
  return tong - huy;
}

/** Đọc 1 ảnh bill UPLOAD — POS trước, không ra POS thì thử CHUYỂN KHOẢN (kind). */
export function ocrBillImage(imageBuffer: Buffer, force = false, opus = false, claude = false, preferQr = false): Promise<OcrServiceResult> {
  // [Admin Demo 4/9] opus → OCR service đọc lại bằng Opus (escalate bill nghi đọc sai ngày). force → bỏ cache.
  // [Admin Demo 8/9] claude → BỎ lượt OCR máy (local), đọc thẳng bằng Claude (nút "Đọc lại bằng Claude" trên thẻ).
  const q = [force ? 'force=1' : '', opus ? 'opus=1' : '', claude ? 'claude=1' : '', preferQr ? 'prefer=qr' : ''].filter(Boolean).join('&');
  return ocrServiceCall(q ? `/ocr?${q}` : '/ocr', imageBuffer);
}

/** Đọc 1 ảnh bill từ FILE (folder scan) — POS trước, không ra POS thì thử CHUYỂN KHOẢN (kind).
 *  [Admin Demo 3/9] force=true ("Quét lại ảnh này") → OCR service BỎ cache, ĐỌC LẠI từ đầu (chống trả cache sai/nhiễm). */
export function ocrBillFile(filePath: string, force = false, opus = false, claude = false, preferQr = false): Promise<OcrServiceResult> {
  return ocrServiceCall('/ocr-file', { path: filePath, force, opus, claude, preferKind: preferQr ? 'QR' : null }); // opus → Opus; claude → bỏ OCR máy; preferKind → ép nhánh.
}

// ── BILL CHUYỂN KHOẢN HOÀN TIỀN ĐẠI LÝ (Admin Demo 31/8) ────────────────────────────────────────────────────
/** [Đợt 2 QR] Bill QR bán hàng thô từ OCR service (readQrBillVision). Màn "Thanh toán thành công":
 *  hkdName = Nhà cung cấp (tên HKD), amount = Số tiền, ref = Số giao dịch (unique), date/time = Ngày thực hiện,
 *  fromCard = Từ (thẻ KHÁCH). KHÔNG có TID/lô/số thẻ máy POS. */
export interface QrRaw {
  hkdName?: string | null;
  amount?: number;
  date?: string | null;
  time?: string | null;
  ref?: string | null;
  fromCard?: string | null;
  /** [Admin Demo 10/9] Tên CHỦ THẺ đọc từ THÔNG BÁO GIAO DỊCH THẺ — dùng khớp `payer_name` của báo-có. */
  payerName?: string | null;
  /** Nơi quẹt in trên thông báo (vd "VIB QR PUSH") — chỉ để người duyệt đối chiếu, KHÔNG dùng khớp mã. */
  noticeMerchant?: string | null;
  /** true = ảnh là THÔNG BÁO GIAO DỊCH THẺ (email/SMS ngân hàng gửi chủ thẻ), KHÔNG phải bill bán hàng: không có
   *  tên HKD và không có Số giao dịch nên PHẢI khớp báo-có (tiền + giờ + tên người quẹt) mới biết mã QR/HKD. */
  noticeOnly?: boolean;
}
/** Transfer thô từ OCR service (readTransferVision). */
export interface TransferRaw {
  receiverName?: string | null; receiverAccount?: string | null; receiverBank?: string | null;
  senderName?: string | null; senderAccount?: string | null;
  amount?: number; date?: string | null; time?: string | null; ref?: string | null; content?: string | null;
  /** [Admin Demo 11/9] Dòng trạng thái nguyên văn trên biên lai ("Chuyển tiền thành công"…) — thiếu "thành công" → cờ ⚠ bắt kiểm. */
  statusText?: string | null;
  /** [Admin Demo 16/9 "bank khác nhau thì phải là GD khác nhau"] NGÂN HÀNG CỦA APP hiển thị biên lai (logo/chân trang —
   *  thường là bank BÊN GỬI). Dùng miễn chặn trùng giờ+tiền khi 2 bill là màn BÊN GỬI của 2 bank khác nhau. */
  appBank?: string | null;
}
/** Review 1 bill chuyển khoản (mirror client ocr-send-api.ts TransferReview). */
export interface TransferReview {
  senderName: string | null; senderIsAlpha: boolean; senderAccount: string | null;
  receiverName: string | null; receiverAccount: string | null; content: string | null;
  amount: number; bank: string | null; date: string | null; ref: string | null;
  /** [Admin Demo 8/9 "bill CK OCR thiếu giờ à?"] GIỜ trên biên lai. OCR (TRANSFER_PROMPT) VẪN đọc `time` nhưng
   *  tầng review trước đây KHÔNG mang theo → thẻ CK không có giờ và bill gửi đi cũng mất giờ (billDateTimeRaw
   *  chỉ có ngày) → bảng đối soát hoàn tiền sắp theo giờ bị rỗng. Nay giữ nguyên giờ đọc được. */
  time: string | null;
  /** NGÂN HÀNG NGƯỜI GỬI (Admin Demo 2/9) — OCR chỉ đọc bank bên NHẬN; senderBank học qua sender-bank-alias theo STK/tên
   *  người gửi (null nếu chưa học). CHỈ là nhãn attribution — KHÔNG ảnh hưởng amount/direction/ckTxnKey/dedup. */
  senderBank: string | null;
  matchedRoomId: string | null; matchedRoomName: string | null;
  // Phân-hướng 4 loại (transfer-classify): hướng + đối tác khớp (đại lý/NĐT). needsManualPick=true → dropdown bắt buộc.
  direction: TransferDirection; entityType: PartyType | null; entityId: number | null;
  needsManualPick: boolean; warnings: string[];
  /** Bill CK này ĐÃ GỬI vào phòng đích rồi (khớp ckTxnKey ref/nat) — cảnh báo TRƯỚC khi gửi (Admin Demo 1/9). Server vẫn
   *  dedup lúc gửi; cờ này để review báo sớm. undefined/false = chưa gửi hoặc không xác định được (thiếu ref/STK/phòng). */
  alreadySent?: boolean;
  /** [Admin Demo 3/9] id tin CK đã gửi (khớp ckTxnKey có ẢNH) — để nhận "đã gửi" chắc + KHÔI PHỤC kind (hoàn/ứng) đã chọn.
   *  Bill CK đã gửi loại ỨNG mà OCR lại phân loại HOÀN → augment đọc lại kind từ tin cũ → giữ ĐÚNG trạng thái đã sửa. */
  sentMessageId?: string | null;
  /** [Admin Demo 16/9] NGÂN HÀNG CỦA APP chụp bill (bên gửi) — OCR đọc logo/chân trang. Lưu vào metadata lúc gửi để
   *  miễn chặn trùng giờ+tiền khi 2 bill từ 2 bank gửi khác nhau (2 GD khác thật). */
  appBank?: string | null;
}
/** Tên/alias NĐT để khớp tạm ứng (investor_bank_accounts.account_holder + nickname + SEED Admin Demo — investor_bank_accounts
 *  hiện TRỐNG nên seed cứng Thông/Trung; alias-học file bổ sung). */
async function loadInvestorNames(db: Db): Promise<{ id: number; names: string[] }[]> {
  const invs = await db.investor.findMany({ where: { deletedAt: null }, select: { id: true, nickname: true, fullName: true } });
  const accts = await db.investorBankAccount.findMany({ select: { investorId: true, accountHolder: true } });
  const seed: Record<number, string[]> = { 15: ['Khach Demo A', 'Nguyen Thi Thao Giang'], 16: ['Nguyen Cam Dao'] }; // Thông(15)/Trung(16)
  return invs.map((iv) => {
    const names = new Set<string>();
    if (iv.nickname) names.add(iv.nickname);
    if (iv.fullName) names.add(iv.fullName);
    for (const a of accts) if (a.investorId === iv.id && a.accountHolder) names.add(a.accountHolder);
    for (const s of seed[iv.id] ?? []) names.add(s);
    return { id: iv.id, names: [...names] };
  });
}
/** Người SigMa đi hoàn tiền (sender) — SEED, cấu hình qua env SIGMA_REFUND_SENDERS (phẩy). Admin Demo: Nhân viên B,
 *  Nhân viên E, Nguoi Dung Demo. Dùng để XÁC NHẬN bill là hoàn SigMa (sender khớp → chắc chắn). */
const SIGMA_REFUND_SENDERS = (process.env.SIGMA_REFUND_SENDERS || 'Nhân viên B,Nhân viên E,Nguoi Dung Demo')
  .split(',').map((s) => normalizeVi(s)).filter(Boolean);
/** Chuẩn hóa tiếng Việt: bỏ dấu + thường + gọn khoảng trắng — cho khớp mờ tên. */
function normalizeVi(s: string | null | undefined): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Tùy chọn cho DROPDOWN phân-loại-tay (Admin Demo 31/8): danh sách đại lý (nhóm chat) + NĐT để user chọn khi bill CK
 *  chưa phân loại được. */
export async function classifyOptions(db: Db): Promise<{ dealers: { roomId: string; name: string; customerId?: number }[]; investors: { id: number; name: string }[] }> {
  // [Admin Demo 7/9] DROPDOWN đại lý (chọn TAY) = MỌI nhóm chat GROUP còn sống (trừ nhóm NĐT) → nhóm chat MỚI TẠO hiện
  // NGAY, không cần gán khách trước ("đại lý = khách = 1, tạo nhóm là gửi được"). KHÁC listDealerRooms (auto-classify
  // CK vẫn dùng bản HẸP = customer-linked, tránh mis-route bill CK vào nhóm chưa phải đại lý). Đây là danh sách CHỌN TAY
  // nên rộng an toàn — người gửi tự chọn đúng nhóm; gửi QR chỉ POST vào phòng đó (phí = mặc định của mã nếu chưa có override).
  const invGrps = await db.investorChatGroup.findMany({ where: { unassignedAt: null, roomId: { not: null } }, select: { roomId: true } });
  const invRoomIds = new Set(invGrps.map((g) => g.roomId));
  const rooms = await db.chatRoom.findMany({ where: { type: 'GROUP', deletedAt: null, name: { not: null } }, select: { id: true, name: true }, orderBy: { createdAt: 'desc' } });
  // [Admin Demo 7/9 — MƯỢN TID] gắn customerId (khách đang gán phòng) để client lọc dropdown MƯỢN chỉ phòng CÓ khách
  // (tránh chọn nhầm phòng trùng tên chưa gán khách → borrow 422). Phòng gửi thường vẫn dùng cả list (không cần khách).
  const roomIds = rooms.map((r) => r.id);
  const ccgs = roomIds.length ? await db.customerChatGroup.findMany({ where: { roomId: { in: roomIds }, unassignedAt: null }, select: { roomId: true, customerId: true } }) : [];
  const roomToCust = new Map(ccgs.map((g) => [g.roomId, g.customerId]));
  const dealers = rooms.filter((r) => !invRoomIds.has(r.id)).map((r) => ({ roomId: r.id, name: r.name as string, customerId: roomToCust.get(r.id) }));
  const invs = await db.investor.findMany({ where: { deletedAt: null }, select: { id: true, nickname: true, fullName: true } });
  return { dealers, investors: invs.map((iv) => ({ id: iv.id, name: iv.nickname || iv.fullName || `NĐT ${iv.id}` })) };
}
/** GHI alias-HỌC khi user phân-loại-tay (append-only, LAST-WINS → sửa được, chống khóa nhầm — Admin Demo 31/8). Ghi CẢ
 *  acct-key + name-key của ĐỐI TÁC (phía không-SigMa, frontend truyền `name`/`account` đúng phía theo loại đã chọn). */
export function recordClassifyAlias(input: { name: string | null; account: string | null; entityType: PartyType; entityId: number | null; roomId: string | null; label?: string }): { ok: boolean } {
  const label = (input.label ?? '').toString();
  const acct = (input.account ?? '').replace(/[\s*]/g, '').trim();
  const nm = normVi(input.name); // UPPER (đồng nhất transfer-classify.normalizeVi)
  if (acct) recordAlias(TRANSFER_ALIAS_PATH, { key: acct, kind: 'acct', entityType: input.entityType, entityId: input.entityId, roomId: input.roomId, label });
  if (nm) recordAlias(TRANSFER_ALIAS_PATH, { key: nm, kind: 'name', entityType: input.entityType, entityId: input.entityId, roomId: input.roomId, label });
  return { ok: !!(acct || nm) };
}
/** Danh sách nhóm ĐẠI LÝ (customer_chat_groups → chat_rooms.name) làm ứng viên khớp. */
async function listDealerRooms(db: Db): Promise<{ roomId: string; name: string }[]> {
  const grps = await db.customerChatGroup.findMany({ where: { unassignedAt: null, roomId: { not: null } }, select: { roomId: true } });
  const ids = [...new Set(grps.map((g) => g.roomId).filter((x): x is string => !!x))];
  if (ids.length === 0) return [];
  const rooms = await db.chatRoom.findMany({ where: { id: { in: ids }, deletedAt: null, name: { not: null } }, select: { id: true, name: true } });
  return rooms.map((r) => ({ roomId: r.id, name: r.name as string }));
}
/** Khớp {receiver, memo} với TÊN NHÓM đại lý (từ khóa chung, chuẩn hóa bỏ dấu). Trả nhóm điểm cao nhất nếu ĐỦ chắc
 *  (điểm ≥1 và duy nhất top). Không chắc → null (needsManualPick — cấm gửi nhầm nhóm). */
function matchDealerRoom(rooms: { roomId: string; name: string }[], receiver: string | null, content: string | null): { roomId: string; name: string } | null {
  const hay = normalizeVi(`${receiver ?? ''} ${content ?? ''}`);
  if (!hay) return null;
  const hayTokens = new Set(hay.split(' ').filter((t) => t.length >= 2));
  let best: { roomId: string; name: string; score: number } | null = null;
  let secondScore = 0;
  for (const r of rooms) {
    const nameTokens = normalizeVi(r.name).split(' ').filter((t) => t.length >= 2);
    let score = 0;
    for (const t of nameTokens) if (hayTokens.has(t)) score++;
    if (!best || score > best.score) { secondScore = best?.score ?? 0; best = { ...r, score }; }
    else if (score > secondScore) secondScore = score;
  }
  if (!best || best.score < 1 || best.score === secondScore) return null; // 0 khớp HOẶC hòa top → không chắc
  return { roomId: best.roomId, name: best.name };
}
// alphaNames chuẩn hoá theo normVi (UPPER — của transfer-classify) để khớp đúng trong classifyTransfer.
const SIGMA_NAMES_UPPER = (process.env.SIGMA_REFUND_SENDERS || 'Nhân viên B,Nhân viên E,Nguoi Dung Demo')
  .split(',').map((s) => normVi(s)).filter(Boolean);
/** Dựng review bill chuyển khoản: PHÂN-HƯỚNG 4 loại (classifyTransfer) — hoàn đại lý / hoàn thừa / tạm ứng NĐT /
 *  hoàn thừa tạm ứng — + khớp đối tác (đại lý room / NĐT id) qua alias-học→seed→fuzzy. Không khớp → needsManualPick. */
export async function reviewTransfers(db: Db, transfers: TransferRaw[]): Promise<TransferReview[]> {
  if (!transfers?.length) return [];
  const rooms = await listDealerRooms(db);
  const investors = await loadInvestorNames(db);
  const aliases = loadAliases(TRANSFER_ALIAS_PATH);
  const ctx: ClassifyContext = { alphaNames: SIGMA_NAMES_UPPER, investors, dealerGroups: rooms, aliases };
  const roomName = new Map(rooms.map((r) => [r.roomId, r.name]));
  const cksCuaPhong = new Map<string, DealerRefundCk[]>(); // memo listDealerRefundCks theo phòng (1 ảnh thường 1 CK)
  return Promise.all(transfers.map(async (t) => {
    const senderIsAlpha = SIGMA_NAMES_UPPER.some((a) => a && normVi(t.senderName).includes(a));
    const c = classifyTransfer({ senderName: t.senderName, senderAccount: t.senderAccount, receiverName: t.receiverName, receiverAccount: t.receiverAccount, content: t.content }, ctx);
    const matchedRoomId = c.entityType === 'DEALER' ? c.roomId : null;
    // CẢNH BÁO TRƯỚC KHI GỬI (Admin Demo 1/9 "gửi rồi OCR lại vẫn báo gửi được, không chặn"): check ckTxnKey (ref/nat —
    // KHÔNG cần ảnh) đã có trong phòng đích chưa. Server VẪN dedup lúc gửi (chống đăng trùng thật), đây là để REVIEW
    // báo SỚM cho người biết "đã gửi rồi" thay vì bấm gửi mới biết. Chỉ check được khi có phòng đích + có ref/STK.
    const reviewKey = ckTxnKeyForReview(t);
    let alreadySent = false;
    if (reviewKey && matchedRoomId) alreadySent = await ckAlreadySentInRoom(db, matchedRoomId, reviewKey);
    // [Phản biện 11/9 — LỖ HỔNG CK x2 HOÀN QUA 2 ẢNH] Cùng 1 giao dịch CK có thể tồn tại 2 ẢNH KHÁC NHAU (ảnh bên
    // gửi + ảnh bên nhận / chụp lại) và OCR đọc LỆCH ref 1 ký tự → cả ckTxnKey LẪN image-hash đều trượt → mọi tầng
    // dedup hiện có (marker + reserveSend + findDealerCkGlobal) đều KHÔNG bắt → hoàn ghi 2 LẦN. POS có tier-2
    // lô+tiền+ngày (findSentByLoAmount); CK chưa có gì → thêm CỜ ĐỎ tại review (KHÔNG chặn — 2 CK thật cùng tiền
    // cùng ngày vẫn có, người duyệt quyết): phòng đích ĐÃ có CK cùng |tiền| cùng NGÀY nhưng khoá khác → nghi trùng.
    let nghiTrungCk: string | null = null;
    if (matchedRoomId && !alreadySent && Number(t.amount) > 0) {
      const ngayCk = parseTransferDay(t.date ?? null);
      if (ngayCk) {
        try {
          let cks = cksCuaPhong.get(matchedRoomId);
          if (!cks) { cks = await listDealerRefundCks(db, matchedRoomId); cksCuaPhong.set(matchedRoomId, cks); }
          const tien = Math.round(Number(t.amount));
          // [Admin Demo 11/9 chính sách + vá phản biện] CẢ HAI bill đều đọc được MÃ GD THẬT (≥4 ký tự chữ-số, so sau
          // khi bỏ ký tự rác — ckBothRefDistinct) mà mã KHÁC nhau = 2 GD KHÁC THẬT (kể cả cùng giờ phút cùng tiền)
          // → KHÔNG nghi trùng, không chặn (nhưng vẫn cắm ℹ nhẹ bên dưới — người duyệt phải THẤY, không im lặng).
          // Thiếu mã 1 trong 2 / mã rác / mã chỉ khác dấu "-" → vẫn nghi như cũ.
          const giong = cks.find((e) => e.billDate === ngayCk && Math.abs(e.refundAmount) === tien && e.ckTxnKey !== reviewKey
            && !ckBothRefDistinct(reviewKey, e.ckTxnKey));
          // [Admin Demo 11/9] Trùng cả GIỜ:PHÚT → server SẼ CHẶN CỨNG (CK_TRUNG_GIO_TIEN) — báo trước ở review +
          // hướng dẫn đường thoát (sửa giờ). Khác giờ → cờ đỏ nhắc kiểm như cũ.
          const gioMoi = extractBillTime([t.date, t.time].filter(Boolean).join(' ') || null);
          if (giong) {
            // [Admin Demo 16/9 "bank khác nhau thì phải là GD khác nhau"] 2 bill đều là màn BÊN GỬI của 2 bank
            // KHÁC nhau (vd MBV ↔ MB, ca thật 15/9: 2 GD 100tr cùng 08:40 cùng người nhận) → 2 GD KHÁC THẬT,
            // không chặn — nhưng vẫn ℹ cho người duyệt THẤY (không im lặng). Thiếu bank → chặn như cũ.
            const bankKhac = ckBothAppBankDistinct(
              { appBank: t.appBank ?? null, receiverBank: t.receiverBank ?? null },
              { appBank: giong.appBank, receiverBank: giong.bank });
            nghiTrungCk = giong.billTime === gioMoi
              ? (bankKhac
                ? `ℹ Phòng này đã có bill CK cùng SỐ TIỀN ${fmtVnd(tien)}đ cùng GIỜ:PHÚT ${giong.billTime ?? ''} (tin ${giong.messageId}) nhưng 2 bill từ 2 NGÂN HÀNG GỬI khác nhau (${giong.appBank ?? '?'} ↔ ${t.appBank ?? '?'}) — hệ tính là 2 GD KHÁC THẬT (chính sách 16/9), cho gửi. Nghi ngờ thì kiểm ảnh gốc.`
                : `⛔ TRÙNG GIỜ:PHÚT + SỐ TIỀN với bill CK đã gửi (tin ${giong.messageId} · ${giong.billTime ?? 'không giờ'} · ${fmtVnd(tien)}đ · ${fmtDayDisplay(ngayCk)}) — SẼ BỊ CHẶN GỬI (nghi cùng 1 GD chụp 2 ảnh). Nếu là GD KHÁC thật: sửa GIỜ trên bill rồi gửi, hoặc chụp bill có MÃ GIAO DỊCH (mở "Xem thêm") rồi quét lại.`)
              : `⚠ NGHI TRÙNG: phòng này ĐÃ có bill CK cùng SỐ TIỀN ${fmtVnd(tien)}đ cùng NGÀY ${fmtDayDisplay(ngayCk)} (tin ${giong.messageId}) nhưng mã GD/ảnh KHÁC — có thể CÙNG 1 giao dịch chụp 2 ảnh hoặc OCR đọc lệch mã. KIỂM kỹ trước khi gửi (chống hoàn x2).`;
          } else {
            // [Phản biện 11/9 — CHỐNG IM LẶNG TUYỆT ĐỐI] Cặp được MIỄN theo chính sách (cả 2 có mã GD khác thật):
            // vẫn là ca "cùng tiền cùng ngày" — nếu OCR đọc LỆCH mã của CÙNG 1 GD (O↔0, thêm/bớt ký tự) thì mọi tầng
            // dedup đều trượt và hoàn ghi x2. Admin Demo chốt CHO GỬI (không chặn/không cờ đỏ) nhưng người duyệt phải
            // THẤY → ℹ thông tin nhẹ. Augment gỡ ℹ nếu hash ảnh khớp CHÍNH tin đó (re-scan cùng ảnh, không phải GD 2).
            const mien = cks.find((e) => e.billDate === ngayCk && Math.abs(e.refundAmount) === tien
              && e.ckTxnKey !== reviewKey && ckBothRefDistinct(reviewKey, e.ckTxnKey));
            if (mien) {
              nghiTrungCk = `ℹ Phòng này đã có bill CK cùng SỐ TIỀN ${fmtVnd(tien)}đ cùng NGÀY ${fmtDayDisplay(ngayCk)}${mien.billTime === gioMoi ? ` cùng GIỜ:PHÚT ${mien.billTime ?? ''}` : ''} (tin ${mien.messageId}) nhưng MÃ GD khác — hệ tính là 2 GD KHÁC THẬT (chính sách 11/9). Nếu nghi OCR đọc lệch mã của CÙNG 1 giao dịch, kiểm ảnh gốc trước khi gửi.`;
            }
          }
        } catch (e) { console.error('[reviewTransfers] check nghi-trùng CK lỗi (bỏ qua, không chặn):', e instanceof Error ? e.message : e); }
      }
    }
    // [C3 guard 2/9 — chống POS bị nhận nhầm CK → sót doanh số] Bill CK THẬT luôn có ÍT NHẤT người gửi HOẶC người nhận.
    // Thiếu CẢ HAI → nghi KHÔNG phải CK (có thể bill POS/khác đọc lỗi bị phân loại nhầm CK) → cờ kiểm tay, KHÔNG nuốt câm.
    const notCkSignal = !((t.senderName ?? '').trim()) && !((t.receiverName ?? '').trim());
    // [Admin Demo 11/9] Bill CK PHẢI có xác nhận "chuyển khoản/giao dịch THÀNH CÔNG" mới được coi là bill đúng.
    // OCR đọc statusText nguyên văn; thiếu chữ THÀNH CÔNG (hoặc OCR cũ chưa có field) → cờ ⚠ bắt người duyệt kiểm
    // ảnh gốc + tick xác nhận (khuôn money-gate — không chặn cứng vì bank có thể in khác chữ, người quyết).
    const statusOk = /THANH CONG|SUCCESS/.test(normVi(t.statusText ?? ''));
    const ckWarnings = [
      ...(!statusOk ? ['⚠ CHƯA thấy xác nhận "THÀNH CÔNG" trên biên lai CK (OCR đọc trạng thái: ' + ((t.statusText ?? '').trim() || 'không thấy') + ') — chỉ bill có xác nhận chuyển khoản THÀNH CÔNG mới được tính. KIỂM ảnh gốc trước khi gửi.'] : []),
      ...(notCkSignal ? ['⚠ NGHI KHÔNG PHẢI BILL CK (thiếu cả người gửi lẫn người nhận) — có thể bill POS/khác đọc lỗi bị nhận nhầm CK. KIỂM TAY, đừng bỏ (tránh sót doanh số).'] : []),
      ...(nghiTrungCk ? [nghiTrungCk] : []),
      ...c.warnings
    ];
    return {
      senderName: t.senderName ?? null, senderIsAlpha, senderAccount: t.senderAccount ?? null,
      receiverName: t.receiverName ?? null, receiverAccount: t.receiverAccount ?? null, content: t.content ?? null,
      amount: Number(t.amount) || 0, bank: t.receiverBank ?? null, date: t.date ?? null, time: t.time ?? null, ref: t.ref ?? null,
      // NGÂN HÀNG NGƯỜI GỬI (Admin Demo 2/9): tra alias-học theo STK→tên người gửi (ưu tiên STK). Chưa học → null → UI
      // cho khai báo. KHÔNG ảnh hưởng tiền/định tuyến.
      senderBank: lookupSenderBank({ account: t.senderAccount ?? null, name: t.senderName ?? null }),
      appBank: t.appBank ?? null, // [Admin Demo 16/9] bank của app chụp bill — theo review về client rồi quay lại lúc gửi
      matchedRoomId, matchedRoomName: matchedRoomId ? roomName.get(matchedRoomId) ?? null : null,
      direction: c.direction, entityType: c.entityType, entityId: c.entityId,
      needsManualPick: c.needsManualPick || notCkSignal, warnings: ckWarnings, alreadySent
    };
  }));
}

/** ckTxnKey CHO REVIEW (không có ảnh) — chỉ tier ref/nat (đủ ổn định để cảnh báo sớm); thiếu cả 2 → null (tier hash
 *  cần ảnh, bỏ qua ở review). ĐỒNG NHẤT logic tier với buildCkTxnKey để khớp key đã ghi lúc gửi. */
function ckTxnKeyForReview(t: { ref?: string | null; senderAccount?: string | null; receiverAccount?: string | null; amount?: number | null; date?: string | null }): string | null {
  const ref = normUpperNoSpace(t.ref);
  if (ref) return `ck|ref|${ref}`;
  const snd = normUpperNoSpace(t.senderAccount), rcv = normUpperNoSpace(t.receiverAccount);
  if (snd && rcv) return `ck|nat|${snd}|${rcv}|${Math.round(Number(t.amount) || 0)}|${(parseTransferDay(t.date ?? null) ?? '').replace(/-/g, '')}`;
  return null;
}

/** [Phản biện 11/9 — vá chính sách miễn-chặn] Rút MÃ GD "đáng tin để miễn" từ ckTxnKey: chỉ tier ref, BỎ ký tự
 *  không phải chữ/số (OCR hay chêm "-"/khoảng trắng → "FT-2609" với "FT2609" là CÙNG mã, không được coi là 2 GD),
 *  và PHẢI ≥4 ký tự (ref rác "1"/"OK" không đủ tư cách mã GD → không được dùng để lách chặn). CHỈ dùng cho quyết
 *  định MIỄN-CHẶN/cờ — TUYỆT ĐỐI không đổi buildCkTxnKey (khoá lịch sử đã ghi trong metadata phải giữ nguyên). */
/** [Admin Demo duyệt 12/9 — canon confusable] Chuẩn hoá MÃ GD cho QUYẾT ĐỊNH CHÍNH SÁCH: bỏ ký tự không chữ-số,
 *  quy các cặp OCR hay nhầm về 1 dạng (O→0, I→1, L→1, S→5) — "FT26O9" và "FT2609" là CÙNG mã, không được coi là
 *  2 GD khác. ≥4 ký tự mới đủ tư cách mã. Trả null = không có mã đáng tin. CHỈ dùng cho chính sách (miễn-chặn/
 *  dedup lưới), TUYỆT ĐỐI không dùng làm khoá lưu trữ. */
export function refForPolicy(raw: string | null | undefined): string | null {
  const r = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5');
  return r.length >= 4 ? r : null;
}
export function ckRefForPolicy(key: string | null | undefined): string | null {
  const m = /^ck\|ref\|(.+)$/.exec(key ?? '');
  return m ? refForPolicy(m[1]) : null;
}
/** [Admin Demo 11/9 chính sách + vá phản biện] CẢ HAI bill có MÃ GD THẬT (≥4 ký tự chữ-số) và mã KHÁC NHAU THẬT (sau
 *  khi bỏ ký tự rác) → được coi là 2 GD KHÁC → miễn chặn cứng/cờ đỏ. Mã rác/ngắn hoặc chỉ khác dấu "-"/space → KHÔNG miễn. */
export function ckBothRefDistinct(keyA: string | null | undefined, keyB: string | null | undefined): boolean {
  const a = ckRefForPolicy(keyA), b = ckRefForPolicy(keyB);
  return a != null && b != null && a !== b;
}

/** [Admin Demo 16/9] Chuẩn hoá tên bank cho CHÍNH SÁCH miễn-chặn: bỏ dấu + upper + bỏ ký tự không chữ-số; "MBBANK"→"MB"
 *  (cùng nhà — chân trang MB in "MBBank"); MBV GIỮ NGUYÊN (MBV ≠ MB — 2 ngân hàng khác). <2 ký tự = rác → null. */
export function canonBank(s: string | null | undefined): string | null {
  const c = normVi(String(s ?? '')).replace(/[^A-Z0-9]/g, '');
  if (c.length < 2) return null;
  return c === 'MBBANK' ? 'MB' : c;
}
/** [Admin Demo 16/9 "bank khác nhau thì phải là GD khác nhau" — có VÁ PHẢN BIỆN] 2 bill cùng tiền+giờ được coi là
 *  2 GD KHÁC THẬT khi CẢ HAI đều là màn BÊN GỬI (appBank đọc được VÀ ≠ bank bên nhận trên chính bill đó) và 2 app
 *  gửi KHÁC nhau (vd MBV ↔ MB). BẪY phải bịt: cùng 1 GD vẫn ra 2 ảnh 2 bank (ảnh bên gửi app MB + ảnh BÁO CÓ bên
 *  nhận app BIDV) — ảnh báo có thì appBank == bank nhận → điều kiện "màn bên gửi" loại nó. Thiếu bất kỳ dữ kiện
 *  nào → false (fail-closed, vẫn chặn như cũ). */
export function ckBothAppBankDistinct(
  a: { appBank: string | null | undefined; receiverBank: string | null | undefined },
  b: { appBank: string | null | undefined; receiverBank: string | null | undefined }
): boolean {
  const aApp = canonBank(a.appBank), bApp = canonBank(b.appBank);
  if (!aApp || !bApp) return false;
  const aRcv = canonBank(a.receiverBank), bRcv = canonBank(b.receiverBank);
  if (!aRcv || !bRcv) return false;
  if (aApp === aRcv || bApp === bRcv) return false; // app == bank nhận → nghi ảnh BÁO CÓ bên nhận, không miễn
  return aApp !== bApp;
}

/** Có tin CK nào trong phòng đã mang ckTxnKey này chưa (marker metadataJson) — dùng cảnh báo trùng TRƯỚC khi gửi. */
async function ckAlreadySentInRoom(db: Db, roomId: string, ckTxnKey: string): Promise<boolean> {
  const marker = `"ckTxnKey":${JSON.stringify(ckTxnKey)}`;
  const ex = await db.chatMessage.findFirst({ where: { roomId, metadataJson: { contains: marker }, deletedAt: null }, select: { id: true } });
  return ex != null;
}

/** Ảnh preview JPEG (downscale ≤1200px) qua OCR service (sharp ở đó). Ném lỗi → caller 500/404. */
export async function makePreviewJpeg(buffer: Buffer): Promise<Buffer> {
  if (!OCR_HTTP_TOKEN) throw new Error('OCR_HTTP_TOKEN chưa cấu hình');
  const res = await fetch(`${OCR_HTTP_URL}/preview`, { method: 'POST', headers: { 'x-ocr-token': OCR_HTTP_TOKEN, 'Content-Type': 'application/octet-stream' }, body: buffer });
  if (!res.ok) throw new Error(`preview HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Kết quả routing 1 TID → phòng đại lý + phòng NĐT (+ cảnh báo mắt-xích-đứt, KHÔNG nuốt câm R198). */
export interface BillRouting {
  tidRow: { id: number; tid: string; customerId: number | null; partnerId: number | null; bankId: number | null; hkdName: string | null } | null;
  dealerRoomId: string | null;
  investorRoomId: string | null;
  warnings: string[];
}

/** TID (chuỗi) → phòng ĐẠI LÝ (customer_chat_groups theo tid.customerId) + phòng NĐT (resolveInvestorRoomForTid).
 *  Fail-open cho routing (trả null + cảnh báo) — người review thấy cảnh báo, quyết định; KHÔNG tự gửi sai chỗ. */
/** Mã agent BOT (không tính là "người xem") — bot ghi + bot gửi. */
export const BOT_CODES = ['SIGMA_BOT', 'SUPPORT_ALPHA'];
/**
 * [Admin Demo 9/9 — chống tái diễn] Phòng đại lý phải có ÍT NHẤT 1 người thật; 0 người = bill gửi vào chỗ không ai đọc.
 * Hàm THUẦN để test khoá hành vi (R198). Trả null nếu bình thường.
 */
export function canhBaoPhongKhongNguoi(soNguoiThat: number): string | null {
  return soNguoiThat > 0
    ? null
    : '🔴 PHÒNG ĐẠI LÝ CHƯA CÓ NGƯỜI NÀO (chỉ có bot) — bill gửi vào sẽ KHÔNG AI THẤY. Thêm nhân sự vào phòng rồi gửi lại.';
}

export async function resolveBillRouting(db: Db, tidStr: string): Promise<BillRouting> {
  const warnings: string[] = [];
  const tid = (tidStr || '').trim();
  if (!tid) return { tidRow: null, dealerRoomId: null, investorRoomId: null, warnings: ['TID rỗng — OCR không đọc được.'] };

  const tidRow = await db.tid.findFirst({
    where: { tid, deletedAt: null },
    select: { id: true, tid: true, customerId: true, partnerId: true, bankId: true, hkdName: true }
  });
  if (!tidRow) {
    return { tidRow: null, dealerRoomId: null, investorRoomId: null, warnings: [`TID ${tid} không có trong hệ thống.`] };
  }

  // Phòng ĐẠI LÝ = nhóm chat của KHÁCH sở hữu TID (customer_chat_groups đang-gán có phòng).
  let dealerRoomId: string | null = null;
  if (tidRow.customerId == null) {
    warnings.push(`TID ${tid} chưa gán khách (customerId null) — không tìm được nhóm đại lý.`);
  } else {
    const grp = await db.customerChatGroup.findFirst({
      where: { customerId: tidRow.customerId, unassignedAt: null, roomId: { not: null } },
      select: { roomId: true },
      orderBy: { assignedFrom: 'desc' }
    });
    dealerRoomId = grp?.roomId ?? null;
    if (!dealerRoomId) warnings.push(`Khách của TID ${tid} chưa gán nhóm chat đại lý.`);
  }

  // [Admin Demo 9/9 — CHỐNG TÁI DIỄN, ca Khach Demo] Phòng đại lý CHỈ CÓ BOT (không nhân sự nào) ⇒ bot vẫn gửi bill + ghi
  // doanh số "thành công" nhưng KHÔNG AI NHÌN THẤY — anh Demo báo "vào doanh số mà không thấy gửi, ảnh bill cũng không
  // vào phòng chat". Lưới ở đây (đường CHUNG của review + gửi) để mọi bill đi qua đều bị bắt, không phụ thuộc màn nào.
  if (dealerRoomId) {
    const tv = await db.chatRoomMember.findMany({ where: { roomId: dealerRoomId, leftAt: null }, select: { agentId: true } });
    const nguoiThat = tv.length === 0 ? 0 : await db.agent.count({ where: { id: { in: tv.map((x) => x.agentId) }, code: { notIn: BOT_CODES } } });
    const w = canhBaoPhongKhongNguoi(nguoiThat);
    if (w) warnings.push(w);
  }

  // Phòng NĐT = resolveInvestorRoomForTid (cần sourceRoomId = phòng đại lý để check scope). Không có phòng đại lý
  // thì không route được NĐT (theo đúng hàng rào bảo mật scope B142).
  let investorRoomId: string | null = null;
  if (dealerRoomId) {
    investorRoomId = await resolveInvestorRoomForTid(db, dealerRoomId, tid);
    if (!investorRoomId) warnings.push(`TID ${tid} chưa uỷ NĐT / NĐT chưa gán nhóm — không cc được.`);
  }

  return { tidRow, dealerRoomId, investorRoomId, warnings };
}

/** Loại thẻ MẶC ĐỊNH để tính phí khi bill không ghi rõ thẻ — DÙNG CHUẨN SIGMA (Admin Demo 30/8): ưu tiên thẻ
 *  INTERNATIONAL (Visa-Master), vd máy MB → "Ngoài MB-Visa-Master", MBV/ABB → Visa. TÁI DÙNG `pickDefaultCardTypeId`
 *  + `classifyCardType` (card-classify.ts — CÙNG logic getTidCardOptions/fee-quote của app, KHÔNG tự chế). Chỉ xét
 *  thẻ có biểu phí HIỆU LỰC. Trả cardTypeId hoặc null. */
/** Thẻ CÓ BIỂU PHÍ hiệu lực CỦA ĐÚNG NGÂN HÀNG TID (Admin Demo 30/8: TID bank MBV KHÔNG được lấy thẻ của MB!).
 *  Lọc cardType.bankId == tidBankId — cùng ràng buộc CARD_BANK_MISMATCH của resolveFeeForTxn. */
async function effectiveBankCards(db: Db, partnerId: number, bankId: number | null, at: Date): Promise<{ id: number; name: string; bankId: number }[]> {
  const rates = await db.feeRate.findMany({ where: { partnerId, deletedAt: null }, orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }] });
  const byCard = new Map<number, typeof rates>();
  for (const r of rates) { const arr = byCard.get(r.cardTypeId) ?? []; arr.push(r); byCard.set(r.cardTypeId, arr); }
  const out: { id: number; name: string; bankId: number }[] = [];
  for (const [cid, arr] of byCard) {
    if (pickEffectiveRate(arr, at) == null) continue;
    const c = await db.cardType.findUnique({ where: { id: cid }, select: { name: true, bankId: true, deletedAt: true } });
    if (!c || c.deletedAt) continue;
    if (bankId != null && c.bankId !== bankId) continue; // CHỈ thẻ cùng ngân hàng TID
    out.push({ id: cid, name: c.name, bankId: c.bankId });
  }
  return out;
}

async function primaryCardTypeId(db: Db, partnerId: number, tidBankId: number | null, at: Date): Promise<number | null> {
  const cards = await effectiveBankCards(db, partnerId, tidBankId, at);
  if (cards.length === 0) return null;
  if (cards.length === 1) return cards[0].id;
  const cardOpts: CardOption[] = cards.map((c) => ({ id: c.id, name: c.name, klass: classifyCardType(c.name) }));
  return pickDefaultCardTypeId(cardOpts) ?? cards[0].id; // Visa-Master (INTERNATIONAL) — chuẩn SigMa
}

/** Loại thẻ MẶC ĐỊNH (Visa-Master INTERNATIONAL — chuẩn SigMa) để GHI DOANH SỐ khớp ĐÚNG với thẻ mà REVIEW dùng
 *  (Admin Demo 31/8 "máy MB mặc định phí thẻ ngoài mà sao lại MB"). Trước đây revenue KHÔNG truyền cardTypeId →
 *  quoteRow lấy "thẻ đầu id" = MB on-us (SAI phí bán). Nay route truyền chính thẻ này (= primaryCardTypeId) →
 *  phí bán doanh số = phí bán review. null = TID thiếu đối tác/không có thẻ hiệu lực (route để undefined, quoteRow
 *  tự xử "thẻ đầu id" như cũ — không vỡ). */
export async function defaultCardTypeIdForTid(db: Db, tidRow: BillRouting['tidRow'], at: Date): Promise<number | null> {
  if (!tidRow || tidRow.partnerId == null) return null;
  return primaryCardTypeId(db, tidRow.partnerId, tidRow.bankId, at);
}

/** Danh sách loại thẻ CÓ BIỂU PHÍ hiệu lực của TID (CÙNG BANK) — để UI chọn thẻ + tách thẻ. */
export async function listTidCardTypes(db: Db, tidRow: BillRouting['tidRow'], at: Date): Promise<{ id: number; name: string; bankId: number; isPrimary: boolean }[]> {
  if (!tidRow || tidRow.partnerId == null) return [];
  const cards = await effectiveBankCards(db, tidRow.partnerId, tidRow.bankId, at);
  const primary = await primaryCardTypeId(db, tidRow.partnerId, tidRow.bankId, at);
  return cards.map((c) => ({ id: c.id, name: c.name, bankId: c.bankId, isPrimary: c.id === primary }));
}

/** [Admin Demo 5/9 — RE-ROUTE theo TID] Người review sửa/chọn TID sang MÁY KHÁC (dropdown gợi ý hoặc gõ tay) → phải HỎI
 *  LẠI SERVER routing + loại thẻ + phòng đại lý/NĐT cho TID mới (KHÔNG để client bịa định tuyến/phí — money-safety).
 *  TÁI DÙNG NGUYÊN resolveBillRouting + listTidCardTypes + defaultCardTypeIdForTid (giống hệt reviewBills), chỉ gom lại
 *  để 1 endpoint gọi được khi TID đổi → mở khoá nút Gửi cho TID đúng. Bill gửi thật vẫn re-resolve ở route /send. */
export interface RerouteResult {
  dealerRoomId: string | null;
  dealerRoomName: string | null;
  investorRoomId: string | null;
  investorRoomName: string | null;
  availableCardTypes: { id: number; name: string; bankId: number; isPrimary: boolean }[];
  primaryCardTypeId: number | null;
  hkdName: string | null;
  bankName: string | null;
  warnings: string[];
}
export async function rerouteBillForTid(db: Db, tidStr: string, at: Date = new Date()): Promise<RerouteResult> {
  const routing = await resolveBillRouting(db, tidStr);
  const availableCardTypes = await listTidCardTypes(db, routing.tidRow, at);
  const primaryCardTypeId = await defaultCardTypeIdForTid(db, routing.tidRow, at);
  const bank = routing.tidRow?.bankId != null ? await db.bank.findUnique({ where: { id: routing.tidRow.bankId }, select: { name: true } }) : null;
  const [dealerRoom, investorRoom] = await Promise.all([
    routing.dealerRoomId ? db.chatRoom.findUnique({ where: { id: routing.dealerRoomId }, select: { name: true } }) : Promise.resolve(null),
    routing.investorRoomId ? db.chatRoom.findUnique({ where: { id: routing.investorRoomId }, select: { name: true } }) : Promise.resolve(null)
  ]);
  return {
    dealerRoomId: routing.dealerRoomId,
    dealerRoomName: dealerRoom?.name ?? null,
    investorRoomId: routing.investorRoomId,
    investorRoomName: investorRoom?.name ?? null,
    availableCardTypes,
    primaryCardTypeId,
    hkdName: routing.tidRow?.hkdName ?? null,
    bankName: bank?.name ?? null,
    warnings: routing.warnings
  };
}

/** 1 phần tách thẻ (Admin Demo 30/8): 1 loại thẻ + số tiền của phần đó. Tổng các phần = tổng bill. */
export interface FeeSplitPart { cardTypeId: number; amount: number; }

/** Kết quả 1 dòng phí để hiển thị. resolved=false → hiện `note` (vd "chưa cấu hình"), KHÔNG có số.
 *  breakdown chỉ có khi TÁCH ≥2 thẻ (để báo "gồm ..."). single-thẻ → milli là % thẻ đó. */
export interface FeeBreakdownPart { cardTypeId: number; cardName?: string; amount: number; milli: number; fee: number; }
export interface FeeLine {
  resolved: boolean;
  milli?: number; // %×1000 (single-thẻ)
  amount?: number; // tổng phí VND
  note?: string;
  breakdown?: FeeBreakdownPart[]; // khi tách nhiều thẻ
}

/** %phí CÀI MÁY (×1000) của 1 loại thẻ, hoặc null nếu chưa cấu hình. */
async function installMilliForCard(db: Db, tidRow: NonNullable<BillRouting['tidRow']>, cardTypeId: number, at: Date): Promise<number | null> {
  const r = await resolveInstallFeeMilli(db, { partnerId: tidRow.partnerId, bankId: tidRow.bankId }, cardTypeId, at);
  return r.ok ? r.phiCaiMayMilli : null;
}

/** %phí BÁN thực tế (×1000) của 1 loại thẻ, hoặc null. Bill không ghi loại phí → ƯU TIÊN loại phí có GIÁ BÁN THỰC
 *  TẾ (override TidSellFee) của TID — vì doanh số tính theo giá THỰC BÁN (Admin Demo). FIX 30/8: trước đây gom TẤT CẢ
 *  loại-phí niêm yết (FeeSellQuote nhiều loại phí) → size>1 → coi mơ hồ → bỏ (bug "phí bán chưa cấu hình" khi tách
 *  thẻ Ngoài-MB-VM dù đã có override 1.4%). Nay: nếu TID có override cho ĐÚNG 1 loại phí → lấy loại đó (dùng
 *  override, quotes cùng loại làm nền). Không override → chỉ nhận khi NIÊM YẾT cũng chỉ 1 loại phí. */
async function sellMilliForCard(db: Db, tidRow: NonNullable<BillRouting['tidRow']>, cardTypeId: number, at: Date): Promise<number | null> {
  const overrides = await db.tidSellFee.findMany({ where: { tidId: tidRow.id, cardTypeId, deletedAt: null } });
  const quotes = await db.feeSellQuote.findMany({ where: { partnerId: tidRow.partnerId!, cardTypeId, deletedAt: null } });
  const ovFeeTypes = [...new Set(overrides.map((o) => o.feeTypeId))];
  let feeTypeId: number | null = null;
  if (ovFeeTypes.length === 1) feeTypeId = ovFeeTypes[0]; // có giá bán thực tế đúng 1 loại phí → dùng loại đó
  else if (ovFeeTypes.length === 0) {
    const qFeeTypes = [...new Set(quotes.map((q) => q.feeTypeId))];
    if (qFeeTypes.length === 1) feeTypeId = qFeeTypes[0]; // chỉ niêm yết 1 loại phí
  }
  if (feeTypeId == null) return null; // >1 loại phí override HOẶC nhiều niêm yết không override → mơ hồ, KHÔNG đoán
  // CRITICAL-1 (phản biện 4/9): trừ giảm-phí-cuối-tuần MB/MBV tại NGÀY BILL `at` — CÙNG chỗ gốc resolveActualSellFee →
  // phí bán HIỂN THỊ cho đại lý (tin nhắn/ảnh card) KHỚP phí GHI doanh số. `at` đã là ngày bill (route truyền xuống).
  const weekendDelta = await resolveWeekendSellDeltaMilli(db, cardTypeId, at);
  const sell = resolveActualSellFee(overrides.filter((o) => o.feeTypeId === feeTypeId), quotes.filter((q) => q.feeTypeId === feeTypeId), at, { deltaMilli: weekendDelta });
  return sell.ok ? sell.phiBanMilli : null;
}

/** [Admin Demo 11/9 — bill THANH NAM 1 lô 143 báo "chưa có biểu phí tại 11/9/2025"] Doanh nghiệp CHỈ có dữ liệu +
 *  biểu phí từ 2026; bill năm < năm nay = gần như chắc chắn OCR đọc SAI NĂM (2026→2025). Trả gợi ý rõ để người
 *  duyệt sửa NGÀY thay vì tưởng thiếu cấu hình. Rỗng nếu năm bình thường. */
function goiYNamSai(at: Date): string {
  return at.getFullYear() < new Date().getFullYear()
    ? ` — ⚠ NGHI OCR ĐỌC SAI NĂM (đọc ${at.getFullYear()}); sửa lại NGÀY trên bill (thường là năm nay) rồi gửi`
    : '';
}

/** Tính 1 dòng phí (bán HOẶC cài) — mặc định CẢ TỔNG vào thẻ CHÍNH; nếu có `splits` (người chọn thẻ khác + điền
 *  số tiền) → phí trọng số Σ(phần×%thẻ) + breakdown để BÁO. Tổng các phần phải = tổng bill. */
async function computeFeeLine(
  db: Db, tidRow: BillRouting['tidRow'], billAmount: number, at: Date,
  perCardMilli: (cardTypeId: number) => Promise<number | null>,
  splits?: FeeSplitPart[]
): Promise<FeeLine> {
  if (!tidRow || tidRow.partnerId == null) return { resolved: false, note: 'chưa cấu hình (thiếu đối tác)' };
  let parts = splits && splits.length ? splits : null;
  if (!parts) {
    const primary = await primaryCardTypeId(db, tidRow.partnerId, tidRow.bankId, at);
    if (primary == null) return { resolved: false, note: `chưa cấu hình biểu phí${goiYNamSai(at)}` };
    parts = [{ cardTypeId: primary, amount: billAmount }];
  } else {
    const sum = parts.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    if (Math.abs(sum - billAmount) > 1) return { resolved: false, note: `tổng tách thẻ (${fmtVnd(sum)}) ≠ tổng bill (${fmtVnd(billAmount)})` };
    // FIX #5a audit (30/8) — CẤM TIN CLIENT: mỗi thẻ tách client gửi PHẢI thuộc ĐÚNG ngân hàng TID (không thì phí
    // tra theo biểu partner của bank KHÁC → phí/hoàn SAI). Server tái kiểm bằng effectiveBankCards (lọc bankId TID).
    const dsThe = await effectiveBankCards(db, tidRow.partnerId, tidRow.bankId, at);
    const allowed = new Set(dsThe.map((c) => c.id));
    for (const p of parts) {
      if (allowed.has(p.cardTypeId)) continue;
      // [Admin Demo 8/9 — "lỗi Phí bán: thẻ tách không thuộc ngân hàng của TID lô 102 Xuân Đoàn 3, fix triệt để"]
      // TRƯỚC ĐÂY 1 CÂU CHUNG cho 3 nguyên nhân KHÁC HẲN nhau → người duyệt không biết xử thế nào, người sửa code
      // cũng không truy được. NAY nói ĐÚNG nguyên nhân + log lại (R198: không nuốt, không nói mơ hồ).
      const the = await db.cardType.findUnique({ where: { id: p.cardTypeId }, select: { name: true, bankId: true, deletedAt: true } });
      const nganHangTid = tidRow.bankId != null ? await db.bank.findUnique({ where: { id: tidRow.bankId }, select: { name: true } }) : null;
      let note: string;
      if (!the || the.deletedAt) note = `loại thẻ #${p.cardTypeId} không còn tồn tại — chọn lại thẻ`;
      else if (tidRow.bankId != null && the.bankId !== tidRow.bankId) {
        const nhThe = await db.bank.findUnique({ where: { id: the.bankId }, select: { name: true } });
        note = `thẻ "${the.name}" thuộc ngân hàng ${nhThe?.name ?? the.bankId}, còn TID này thuộc ${nganHangTid?.name ?? tidRow.bankId} — chọn thẻ đúng ngân hàng`;
      } else if (dsThe.length === 0) {
        note = `đối tác của TID chưa có BIỂU PHÍ nào hiệu lực tại ngày bill (${at.toLocaleDateString('vi-VN')})${goiYNamSai(at) || ' — cấu hình biểu phí trước'}`;
      } else {
        note = `thẻ "${the.name}" chưa có BIỂU PHÍ hiệu lực tại ngày bill (${at.toLocaleDateString('vi-VN')}) — thẻ dùng được: ${dsThe.map((c) => c.name).join(', ')}`;
      }
      console.error(`[fee] thẻ tách không dùng được: tid=${tidRow.tid ?? '?'} bank=${tidRow.bankId} partner=${tidRow.partnerId} cardType=${p.cardTypeId} ngàyBill=${at.toISOString()} → ${note}`);
      return { resolved: false, note };
    }
  }
  const breakdown: FeeBreakdownPart[] = [];
  let totalFee = 0;
  for (const p of parts) {
    const milli = await perCardMilli(p.cardTypeId);
    if (milli == null) return { resolved: false, note: `thẻ chưa cấu hình phí${goiYNamSai(at)}` };
    const card = await db.cardType.findUnique({ where: { id: p.cardTypeId }, select: { name: true } });
    const fee = Math.round((p.amount * milli) / 100000);
    totalFee += fee;
    breakdown.push({ cardTypeId: p.cardTypeId, cardName: card?.name, amount: p.amount, milli, fee });
  }
  const single = breakdown.length === 1;
  return { resolved: true, milli: single ? breakdown[0].milli : undefined, amount: totalFee, breakdown: single ? undefined : breakdown };
}

/** PHÍ CÀI MÁY cho NĐT (chỉ đọc). Mặc định thẻ chính; hỗ trợ tách thẻ. */
export function computeInstallFeeLine(db: Db, tidRow: BillRouting['tidRow'], billAmount: number, at: Date, splits?: FeeSplitPart[]): Promise<FeeLine> {
  return computeFeeLine(db, tidRow, billAmount, at, (cid) => (tidRow ? installMilliForCard(db, tidRow, cid, at) : Promise.resolve(null)), splits);
}

/** PHÍ BÁN cho ĐẠI LÝ. Mặc định thẻ chính; hỗ trợ tách thẻ. */
export function computeSellFeeLine(db: Db, tidRow: BillRouting['tidRow'], billAmount: number, at: Date, splits?: FeeSplitPart[]): Promise<FeeLine> {
  return computeFeeLine(db, tidRow, billAmount, at, (cid) => (tidRow ? sellMilliForCard(db, tidRow, cid, at) : Promise.resolve(null)), splits);
}

// ═════════════════════════════════════════════════════════════════════════════
// BILL QR BÁN HÀNG (Đợt 2, Admin Demo 5/9) — màn "Thanh toán thành công": HKD (Nhà cung cấp) + Số tiền + Số giao dịch
// (ref) + Ngày thực hiện + Từ (thẻ khách). KHÔNG có TID/lô/số thẻ POS. Tiền vào TK HKD = DOANH SỐ (như POS).
// reviewQr = tra cứu + tính phí BÁN (qua resolveQrFeeForTid — ENGINE CÓ SẴN, KHÔNG viết lại math) + gắn cờ. GỬI +
// GHI DOANH SỐ + HOÀN nằm ở route /send-qr (xem CHƯA-CHẮC bridge doanh số QR — HỎI LEAD).
// ═════════════════════════════════════════════════════════════════════════════

/** 1 dòng review bill QR (trả UI trước khi gửi). Phí bán/refund CHỈ hiển thị (engine resolveQrFeeForTid). */
export interface QrReviewItem {
  qr: { hkdName: string | null; amount: number; ref: string | null; dateTime: string | null; fromCard: string | null;
        /** Tên chủ thẻ (chỉ ảnh THÔNG BÁO GIAO DỊCH THẺ mới có) — client điền sẵn ô "tên người quẹt". */
        payerName?: string | null; noticeMerchant?: string | null };
  /** [Admin Demo 10/9] Bill đến từ THÔNG BÁO GIAO DỊCH THẺ → thiếu HKD/số GD là BÌNH THƯỜNG (ảnh không in), phải
   *  khớp BÁO-CÓ mới gửi được. Client dùng cờ này để hiện đúng lời nhắc thay vì cảnh báo "OCR đọc hụt". */
  noticeOnly: boolean;
  tidId: number | null;          // dòng tids kind='QR' khớp HKD (null = không match)
  tidCode: string | null;
  hkdNameMatched: string | null; // tên HKD chuẩn trong DB (đối chiếu với OCR)
  partnerId: number | null;
  receiveAccountId: number | null; // TK nhận → suy uỷ NĐT (chạy y hệt POS ở bridge doanh số)
  industryId: number | null;
  sellFeeMilli: number | null;   // phí bán ×1000 tại NGÀY BILL — bậc CHỜ (mặc định); null = chưa cấu hình
  sellFeeMilliNhanh: number | null; // [Admin Demo 11/9] phí bán ×1000 bậc TIỀN NHANH; null = mã không có bậc nhanh (UI ẩn dropdown)
  refundAmountNhanh: number | null; // = amount − phí bán NHANH (số hoàn nếu chọn tiền nhanh)
  sellFeeAmount: number | null;  // phí bán VND
  partnerFeeMilli: number | null; // phí MUA (đối tác) ×1000 — cho ghi doanh số (partnerMargin) + hiển thị
  refundAmount: number | null;   // = amount − sellFeeAmount (số HOÀN đại lý dự kiến)
  investorReceiveAmount: number | null; // NĐT về = TRỌN amount (phí cài máy QR = 0) — hiển thị
  feeSource: 'MERCHANT' | 'PARTNER' | null; // nguồn giá MUA (mã / đối tác)
  sellFeeSource: 'DEALER' | 'DEFAULT' | null; // giá BÁN: đè theo đại lý (DEALER) hay mặc định mã (DEFAULT)
  isWeekend: boolean;
  dealerRoomId: string | null;   // đại lý HIỆU LỰC (chọn ?? folder-default) — dropdown liệt kê HẾT
  dealerRoomName: string | null;
  alreadySent: boolean;          // ref đã gửi (dedup qr_bill_sent)
  warnings: string[];            // cờ ĐỎ hiển thị (không match HKD / thiếu giá / đã gửi / thiếu ref)
  blocked: boolean;              // true = CHẶN nút gửi (route cũng fail-closed) — luôn kèm LÝ DO trong warnings (R198)
}

/** NGÀY GD của bill QR từ date "dd/mm/yyyy" (+ time "HH:MM") — dùng cho resolveQrFeeForTid (cuối tuần theo NGÀY BILL,
 *  Asia/Ho_Chi_Minh). Thiếu ngày → null (caller fallback now + cảnh báo). ĐỒNG NHẤT parse với resolveBillTxnDate route. */
export function parseQrBillDate(date: string | null | undefined, time?: string | null): Date | null {
  const md = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(date ?? '');
  if (!md) return null;
  const hm = /([01]?\d|2[0-3]):([0-5]\d)/.exec(time ?? '');
  const hh = hm ? Number(hm[1]) : 12, mm = hm ? Number(hm[2]) : 0; // thiếu giờ → 12:00 (giữa ngày, không lệch ngày HCM)
  // [deep-audit A2/P2] Dựng instant theo GIỜ HCM TƯỜNG MINH (UTC+7), KHÔNG new Date(local-components) = phụ thuộc TZ
  // process. isWeekendHCM/pickEffectiveRate cộng +7 → nếu ở đây dùng giờ process (server UTC/Docker) sẽ lệch NGÀY sát
  // nửa đêm (T6 23:30 HCM bị nhận weekend). Date.UTC(y,m,d,hh-7) = instant đúng cho wall-clock HCM, độc lập TZ máy.
  const d = new Date(Date.UTC(Number(md[3]), Number(md[2]) - 1, Number(md[1]), hh - 7, mm, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** [Admin Demo 14/9 — ca THẬT prod: bill QR quẹt 14/09/2026 nhưng OCR đọc "14/09/2025" → tra báo-có theo NĂM SAI
 *  → "KHÔNG tìm thấy trong báo có" dây chuyền] TỰ SỬA NĂM OCR: nếu năm ≠ năm nay nhưng thay bằng năm nay thì
 *  ngày chỉ cách hôm nay ≤ 10 ngày (đúng khung bill quét trong ngày/vài ngày) → dùng năm nay + CỜ để hiện ℹ.
 *  Không thoả → giữ nguyên (kiemTraNgayBill sẽ cảnh báo đỏ, người sửa tay — cấm sửa mù). */
export function suaNamOcr(date: string | null | undefined, now: Date = new Date()): { date: string | null; daSua: boolean; namGoc?: number } {
  const md = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(date ?? '');
  if (!md) return { date: date ?? null, daSua: false };
  const y = Number(md[3]);
  const nowHcm = new Date(now.getTime() + 7 * 3600_000);
  const namNay = nowHcm.getUTCFullYear();
  if (y === namNay) return { date: date ?? null, daSua: false };
  const thu = Date.UTC(namNay, Number(md[2]) - 1, Number(md[1]), 12 - 7, 0, 0);
  if (Number.isNaN(thu)) return { date: date ?? null, daSua: false };
  const lechNgay = Math.abs(now.getTime() - thu) / 86_400_000;
  if (lechNgay > 10) return { date: date ?? null, daSua: false };
  return { date: (date ?? '').replace(md[3], String(namNay)), daSua: true, namGoc: y };
}

/** Dòng tids kind='QR' (raw — cột `kind` NGOÀI Prisma client). */
interface QrTidRow { id: number; tid: string; hkd_name: string | null; partner_id: number | null; receive_account_id: number | null; industry_id: number | null; }

/** customerId của ĐẠI LÝ từ roomId (nhóm chat ĐANG gán) — đại lý=khách=1. Dùng để tra giá bán QR đè theo đại lý
 *  (qr_dealer_sell_fee khóa customer_id). null nếu phòng chưa gán khách. CÙNG cách resolveBillRouting map phòng→khách. */
async function qrDealerCustomerId(db: Db, roomId: string): Promise<number | null> {
  const g = await db.customerChatGroup.findFirst({
    where: { roomId, unassignedAt: null }, select: { customerId: true }, orderBy: { assignedFrom: 'desc' }
  });
  return g?.customerId ?? null;
}

// [Admin Demo 6/9 — HẠN MỨC QR/ngày] Lưu hạn mức theo MÃ vào app_settings key 'qr.dailyLimit' = JSON {tidId: vnd} (KHÔNG cần
// migration; set qua dashboard SigMa). Đọc để cảnh báo khi doanh số QR HÔM NAY của mã (gồm bill đang review) gần/vượt.
export const QR_DAILY_LIMIT_KEY = 'qr.dailyLimit';
export async function readQrDailyLimits(db: Db): Promise<Record<number, number>> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: QR_DAILY_LIMIT_KEY } });
    if (!row?.value) return {};
    const obj = JSON.parse(row.value) as Record<string, unknown>;
    const out: Record<number, number> = {};
    for (const [k, v] of Object.entries(obj)) { const id = Number(k); const n = Number(v); if (Number.isInteger(id) && Number.isFinite(n) && n > 0) out[id] = n; }
    return out;
  } catch { return {}; }
}
/** Tổng doanh số QR (transactions QR: card_type_id NULL) của 1 mã trong NGÀY (HCM) của `at`. */
async function qrTodayRevenue(db: Db, tidId: number, at: Date): Promise<number> {
  const HCM = 7 * 3600_000;
  const dayStart = new Date(Math.floor((at.getTime() + HCM) / 86400000) * 86400000 - HCM);
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const rows = await db.$queryRawUnsafe<Array<{ s: bigint | number | null }>>(
    `SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE tid_id = $1 AND card_type_id IS NULL AND deleted_at IS NULL AND txn_date >= $2 AND txn_date < $3`,
    tidId, dayStart, dayEnd);
  return Number(rows[0]?.s ?? 0);
}

/** REVIEW danh sách bill QR: match HKD → mã QR (tids.kind='QR') theo tên chuẩn-hoá (bỏ dấu/hoa-thường), tính phí BÁN
 *  qua resolveQrFeeForTid tại NGÀY BILL, dedup theo `ref`. Cờ ĐỎ (blocked) khi: không match HKD / >1 mã cùng HKD /
 *  thiếu giá QR / thiếu ref (không dedup được → chống doanh số x2) / đã gửi. `dealers` = MỌI đại lý cho dropdown;
 *  `folderHint` (tên folder/file) → default đại lý mà tên NẰM TRONG folder (substring chuẩn-hoá). KHÔNG suy tiền. */
export async function reviewQr(
  db: Db, qrRows: QrRaw[], now: Date, dealers: { roomId: string; name: string }[], folderHint?: string | null, selectedDealerRoomId?: string | null
): Promise<QrReviewItem[]> {
  if (!qrRows?.length) return [];
  // Nạp MỌI mã QR (kind='QR') 1 lần — volume nhỏ. Map tên-HKD-chuẩn → danh sách mã (bắt >1 cùng tên = mơ hồ).
  const qrTids = await db.$queryRawUnsafe<QrTidRow[]>(
    `SELECT id, tid, hkd_name, partner_id, receive_account_id, industry_id FROM tids WHERE kind = 'QR' AND deleted_at IS NULL`
  );
  const byHkd = new Map<string, QrTidRow[]>();
  for (const r of qrTids) {
    const k = normalizeHkdKey(r.hkd_name);
    if (!k) continue;
    const arr = byHkd.get(k) ?? []; arr.push(r); byHkd.set(k, arr);
  }
  // Default đại lý theo FOLDER: tên đại lý (chuẩn-hoá) NẰM TRONG tên folder → chọn; hoà/không có → null (dropdown chọn tay).
  const folderKey = normalizeVi(folderHint ?? '');
  const dealerDefault = ((): { roomId: string; name: string } | null => {
    if (!folderKey) return null;
    const hits = dealers.filter((d) => { const nk = normalizeVi(d.name); return nk && folderKey.includes(nk); });
    return hits.length === 1 ? hits[0] : null; // duy nhất mới auto (cấm gán nhầm)
  })();
  // ĐẠI LÝ HIỆU LỰC để tính PHÍ BÁN (Admin Demo 5/9 "phí bán tùy khách"): đại lý CHỌN (selectedDealerRoomId, tab review đổi
  // dropdown → tính lại) ĐÈ folder-default. phiBan = giá bán ĐÈ của đại lý (qr_dealer_sell_fee theo customerId) ?? giá
  // bán MẶC ĐỊNH của mã (resolveQrFeeForTid.phiBanMilli — hiện 1.05% cho tất cả). customerId suy từ room qua nhóm chat.
  const effectiveDealer = (selectedDealerRoomId && dealers.find((d) => d.roomId === selectedDealerRoomId)) || dealerDefault;
  const dealerCustomerId = effectiveDealer ? await qrDealerCustomerId(db, effectiveDealer.roomId) : null;
  const qrDailyLimits = await readQrDailyLimits(db); // [Admin Demo 6/9] hạn mức QR/ngày theo mã (app_settings).

  const out: QrReviewItem[] = [];
  for (let q of qrRows) {
    const warnings: string[] = [];
    const amount = Number(q.amount) || 0;
    const ref = (q.ref ?? '').trim() || null;
    // [Admin Demo 14/9] SỬA NĂM OCR sai (2025 thay 2026) TRƯỚC mọi bước tra — gốc chuỗi lỗi "không thấy báo có".
    const namFix = suaNamOcr(q.date);
    if (namFix.daSua) {
      q = { ...q, date: namFix.date };
      warnings.push(`ℹ OCR đọc NĂM ${namFix.namGoc} — đã tự sửa thành ${namFix.date} (bill quét trong khung 10 ngày). Kiểm ảnh nếu nghi ngờ.`);
    }
    const dateTime = [q.date, q.time].filter(Boolean).join(' ').trim() || q.date || null;
    // [Admin Demo 14/9] GATE NGÀY BILL cho luồng QR (trước chỉ POS có): ngày tương lai / lệch >10 ngày → cảnh báo đỏ.
    warnings.push(...kiemTraNgayBill(dateTime));
    // [Admin Demo 10/9] Ảnh THÔNG BÁO GIAO DỊCH THẺ: ảnh KHÔNG in tên HKD / Số giao dịch → cảnh báo "OCR không đọc
    // được" là SAI SỰ THẬT (không có gì để đọc). Nói đúng việc phải làm: khớp BÁO-CÓ để suy mã QR + Số GD.
    const laThongBaoThe = q.noticeOnly === true;
    if (laThongBaoThe) warnings.push('ℹ Ảnh là THÔNG BÁO GIAO DỊCH THẺ (ngân hàng gửi chủ thẻ) — không in tên HKD/Số giao dịch. Bấm "Tra báo có" để khớp mã QR + Số giao dịch theo số tiền + giờ + tên chủ thẻ, rồi XÁC NHẬN trước khi gửi.');
    const hkdKey = normalizeHkdKey(q.hkdName);
    let cand = hkdKey ? byHkd.get(hkdKey) : undefined;
    // [Admin Demo 6/9] NỚI KHỚP bỏ ĐỊA DANH đuôi: bill QR đọc tên HKD kèm địa danh (vd "KHACH HANG 70 HA NOI") KHÔNG
    // khớp exact tên mã đã tạo ("KHACH HANG 70"). Fallback: tên MÃ là TIỀN TỐ của tên OCR (OCR DƯ phần địa danh) →
    // khớp nếu DUY NHẤT + key mã đủ dài (≥6 ký tự, tránh khớp mảnh ngắn). CẮM CỜ "khớp rút gọn" để người xác nhận
    // (cấm suy tiền mù). Chỉ áp khi exact rỗng.
    let hkdFuzzy = false;
    if ((!cand || cand.length === 0) && hkdKey && hkdKey.length >= 6) {
      const pref = [...byHkd.entries()].filter(([k]) => k.length >= 6 && hkdKey.startsWith(k));
      if (pref.length > 0) {
        const maxLen = Math.max(...pref.map(([k]) => k.length));
        const top = pref.filter(([k]) => k.length === maxLen); // key dài nhất = sát nghĩa nhất
        if (top.length === 1) { cand = top[0][1]; hkdFuzzy = true; }
      }
    }
    // [Admin Demo 14/9 — ca THẬT "HKD DEMO 62" (app CẮT tên)] CHIỀU NGƯỢC (tên OCR thiếu đuôi = tiền tố key mã)
    // KHÔNG gán trực tiếp ở đây: guard 11/9 (A1) bắt buộc BẰNG CHỨNG BÁO-CÓ khi tên cắt/mờ — nhánh cứu bên dưới
    // đã phủ chiều ngược qua hkdKeyTuongThich (tidKey.includes(ocrKey)) nên ca Trà My thật vẫn nhận đúng mã.
    // [Admin Demo 11/9 "up ảnh Thủ công bị báo không khớp mã"] OCR đọc TÊN HKD cắt/mờ (prod: "KHACH HANG 25" thay vì
    // "NGUYỄN TRÀ MY") → exact + fuzzy tiền-tố đều trượt DÙ bill thật của mã trong hệ thống. BÁO-CÓ = bằng chứng
    // ngân hàng: Số GD (external_ref_no) khớp EXACT → nhận mã đó (cùng khuôn phân-mã 2-mã-cùng-tên đã duyệt);
    // không có ref → tiền + giờ ±10' khớp DUY NHẤT 1 mã. Cắm ℹ tường minh — người duyệt vẫn xác nhận trước gửi.
    if ((!cand || cand.length === 0) && hkdKey) {
      try {
        let hits: { source_tid_id: number }[] = [];
        let khopTheoRef = false;
        // [PHẢN BIỆN 11/9 — A2] Cứu theo ref PHẢI kèm SỐ TIỀN (ref OCR đọc lệch / đụng ref nguồn khác — PaySmart cùng
        // bảng — mà tiền lệch hẳn vẫn gán mã = doanh số sai chủ) + ref đủ dài ≥4 (chặn rác ''/'0'; Số GD ngân hàng luôn dài).
        if (ref && ref.length >= 4) {
          hits = amount > 0
            ? await db.$queryRawUnsafe<{ source_tid_id: number }[]>(
                `SELECT DISTINCT source_tid_id FROM digistore_baoco WHERE external_ref_no = $1 AND amount = $2 AND source_tid_id IS NOT NULL`,
                ref, Math.round(amount))
            : await db.$queryRawUnsafe<{ source_tid_id: number }[]>(
                `SELECT DISTINCT source_tid_id FROM digistore_baoco WHERE external_ref_no = $1 AND source_tid_id IS NOT NULL`, ref);
          khopTheoRef = hits.length === 1;
        }
        const atCut = parseQrBillDate(q.date, q.time);
        if (hits.length !== 1 && atCut && amount > 0) {
          // [PHẢN BIỆN 11/9 — A1 chống GÁN NHẦM] Fallback tiền+giờ trước đây tra TOÀN CỤC → bill của mã A (báo-có
          // chưa poll kịp / mã chưa có cred) bị mã B CÙNG TIỀN trong ±10' CƯỚP (doanh số sai chủ). Nay: tên OCR còn
          // TƯƠNG THÍCH ≥1 mã (tiền tố chung đủ dài — hkdKeyTuongThich) → CHỈ tra báo-có của các mã đó (cùng khuôn
          // ANY() của nhánh phân-mã 2-mã-cùng-tên); tên rác hoàn toàn → giữ tra toàn cục (thiết kế đã duyệt).
          const idTuongThich = qrTids.filter((r) => hkdKeyTuongThich(hkdKey, normalizeHkdKey(r.hkd_name))).map((r) => r.id);
          hits = idTuongThich.length > 0
            ? await db.$queryRawUnsafe<{ source_tid_id: number }[]>(
                `SELECT DISTINCT source_tid_id FROM digistore_baoco WHERE amount = $1 AND at_ms BETWEEN $2 AND $3 AND source_tid_id = ANY($4::int[])`,
                Math.round(amount), atCut.getTime() - 10 * 60_000, atCut.getTime() + 10 * 60_000, idTuongThich)
            : await db.$queryRawUnsafe<{ source_tid_id: number }[]>(
                `SELECT DISTINCT source_tid_id FROM digistore_baoco WHERE amount = $1 AND at_ms BETWEEN $2 AND $3 AND source_tid_id IS NOT NULL`,
                Math.round(amount), atCut.getTime() - 10 * 60_000, atCut.getTime() + 10 * 60_000);
        }
        if (hits.length === 1) {
          const t = qrTids.find((r) => r.id === Number(hits[0].source_tid_id));
          if (t) {
            cand = [t];
            // [PHẢN BIỆN 11/9 — A5] Nhãn bằng chứng theo NHÁNH THẬT đã khớp (khopTheoRef) — trước đây `ref && hits
            // .length===1` luôn true trong nhánh gán → khớp tiền+giờ mà báo "SỐ GIAO DỊCH" (người duyệt tưởng mạnh hơn thật).
            warnings.push(`ℹ Tên HKD trên bill đọc cắt/mờ ("${q.hkdName}") — đã NHẬN mã ${t.tid.slice(0, 28)}… (HKD ${t.hkd_name ?? '?'}) theo BÁO-CÓ khớp ${khopTheoRef ? 'SỐ GIAO DỊCH' : 'tiền+giờ'} (bằng chứng ngân hàng). Kiểm rồi xác nhận trước khi gửi.`);
          }
        }
      } catch (e) { console.error('[reviewQr] cứu mã theo báo-có (tên cắt/mờ) lỗi — rơi về kiểm tay:', e instanceof Error ? e.message : e); }
    }
    let tidRow: QrTidRow | null = null;
    if (!hkdKey && !laThongBaoThe) warnings.push('⚠ OCR không đọc được tên HKD (Nhà cung cấp) — không tra được mã QR. Kiểm tay.');
    else if (!hkdKey) { /* thông báo thẻ: đã có dòng ℹ ở trên, KHÔNG lặp cảnh báo giả */ }
    else if (!cand || cand.length === 0) warnings.push(`⚠ Không tìm thấy MÃ QR khớp HKD "${q.hkdName}" trong hệ thống (kind='QR'). Tạo mã QR hoặc kiểm tên.`);
    else if (cand.length > 1) {
      // [Admin Demo 11/9 — 2 MÃ CÙNG TÊN, vd Trà My cũ/mới] PHÂN MÃ BẰNG BÁO-CÓ per-VA: mỗi mã có cred/VA riêng,
      // poll nạp cache digistore_baoco kèm source_tid_id → bill (tiền + giờ ±10') khớp cache của DUY NHẤT 1 mã
      // ⇒ chính mã đó (bằng chứng ngân hàng, không suy). 0/≥2 khớp hoặc bill thiếu giờ → giữ kiểm tay.
      const atBill = parseQrBillDate(q.date, q.time);
      let chon: QrTidRow | null = null;
      if (atBill && Number.isFinite(Number(q.amount)) && Number(q.amount) > 0) {
        try {
          const ids = cand.map((c) => c.id);
          const hits = await db.$queryRawUnsafe<{ source_tid_id: number }[]>(
            `SELECT DISTINCT source_tid_id FROM digistore_baoco
             WHERE source_tid_id = ANY($1::int[]) AND amount = $2
               AND at_ms BETWEEN $3 AND $4`,
            ids, Math.round(Number(q.amount)), atBill.getTime() - 10 * 60_000, atBill.getTime() + 10 * 60_000);
          if (hits.length === 1) chon = cand.find((c) => c.id === hits[0].source_tid_id) ?? null;
          if (hits.length > 1) warnings.push(`⚠ Báo-có ${hits.length} mã cùng khớp tiền+giờ — hiếm, kiểm tay.`);
        } catch (e) { console.error('[reviewQr] phân-mã theo báo-có lỗi (rơi về kiểm tay):', e instanceof Error ? e.message : e); }
      }
      if (chon) {
        // [Admin Demo 12/9 "quét QR lỗi hệ thống"] CẤM tra lại byHkd.get(hkdKey)! ở đây: khi cand đến từ nhánh FUZZY
        // (tên bill DƯ địa danh → khớp tiền tố tên mã), hkdKey GỐC không có trong map → `!` nổ TypeError length
        // → 500 cả lượt quét. Dùng số đếm ĐÃ CÓ của chính cand trước khi thu về 1.
        const soCungTen = cand.length;
        cand = [chon];
        warnings.push(`ℹ Có ${soCungTen} mã QR cùng tên "${q.hkdName}" — đã NHẬN mã ${chon.tid.slice(0, 28)}… theo BÁO-CÓ khớp tiền+giờ (bằng chứng ngân hàng).`);
      } else {
        warnings.push(`⚠ Có ${cand.length} mã QR cùng tên HKD "${q.hkdName}" — không xác định được mã (báo-có chưa khớp được). Kiểm tay (cấm suy tiền).`);
      }
    }
    // [Admin Demo 6/9 — PA2] Khớp theo TIỀN TỐ = khớp SẠCH. [11/9] cand có thể vừa được PHÂN MÃ theo báo-có ở trên
    // (thu về 1 phần tử) → nhận luôn.
    if (!tidRow && cand && cand.length === 1) { tidRow = cand[0]; void hkdFuzzy; }

    // Phí BÁN tại NGÀY BILL (engine resolveQrFeeForTid — MÃ đè ĐỐI TÁC, cuối tuần chỉ đổi giá mua). Bill không ngày → now + cảnh báo.
    const at = parseQrBillDate(q.date, q.time) ?? now;
    if (!parseQrBillDate(q.date, q.time)) warnings.push('⚠ Bill QR không đọc được ngày — tính phí theo HÔM NAY (kiểm tay nếu cuối tuần).');
    let sellFeeMilli: number | null = null, sellFeeAmount: number | null = null, partnerFeeMilli: number | null = null, refundAmount: number | null = null, investorReceiveAmount: number | null = null, feeSource: 'MERCHANT' | 'PARTNER' | null = null, sellFeeSource: 'DEALER' | 'DEFAULT' | null = null, isWeekend = false;
    // [Admin Demo 11/9] Bậc giá bán TIỀN NHANH (nếu mã cấu hình phi_ban_nhanh) — client hiện dropdown chọn nhanh/chờ,
    // MẶC ĐỊNH chờ (= sellFeeMilli ở trên). null = mã không có bậc nhanh → UI ẩn dropdown, hành vi cũ nguyên.
    let sellFeeMilliNhanh: number | null = null, refundAmountNhanh: number | null = null;
    if (tidRow) {
      const fee = await resolveQrFeeForTid(db, { tidId: tidRow.id, partnerId: tidRow.partner_id }, at);
      if (fee.ok) {
        partnerFeeMilli = fee.phiMuaMilli; // giá MUA giữ theo mã/đối tác (weekend-aware).
        feeSource = fee.source;
        isWeekend = fee.isWeekend;
        // PHÍ BÁN = giá ĐÈ của đại lý (qr_dealer_sell_fee) ?? giá bán MẶC ĐỊNH của mã (fee.phiBanMilli). Chưa set đại lý
        // → dùng mặc định (1.05% cho tất cả). KHÔNG đổi cuối tuần cho phần bán.
        const dealerOverride = dealerCustomerId != null ? await resolveQrDealerSellFee(db, dealerCustomerId, at) : null;
        sellFeeMilli = dealerOverride ?? fee.phiBanMilli;
        sellFeeSource = dealerOverride != null ? 'DEALER' : 'DEFAULT';
        sellFeeAmount = Math.round((amount * sellFeeMilli) / 100000); // %×1000 → VND (đồng công thức computeFeeLine)
        refundAmount = amount - sellFeeAmount;
        // Bậc NHANH: giá bán riêng của mã (KHÔNG áp đè đại lý — đè đại lý chỉ cho bậc CHỜ mặc định).
        if (fee.phiBanNhanhMilli != null && fee.phiBanNhanhMilli > 0) {
          sellFeeMilliNhanh = fee.phiBanNhanhMilli;
          refundAmountNhanh = amount - Math.round((amount * sellFeeMilliNhanh) / 100000);
          // [PHẢN BIỆN 11/9 — B2] Spread âm BẬC NHANH: /send-qr sẽ chặn 422 (fail-closed) nhưng review trước đây hiện
          // refundAmountNhanh KHÔNG cờ gì → người duyệt chọn nhanh rồi mới bị chặn mù lý do. Cắm ⚠ tường minh (KHÔNG
          // block — bậc chờ vẫn hợp lệ; KHÔNG null-hoá bậc nhanh — giữ đường 422 fail-closed thay vì âm thầm rơi về chờ).
          if (sellFeeMilliNhanh < partnerFeeMilli) warnings.push(`⚠ Phí bán NHANH (${sellFeeMilliNhanh}) < phí mua (${partnerFeeMilli}) — spread âm bậc nhanh, cấu hình sai. Chọn "tiền nhanh" sẽ bị CHẶN lúc gửi tới khi sửa giá (bậc chờ vẫn gửi được).`);
        }
        // [Admin Demo 6/9] NCC (nhà cung cấp mã QR) HOÀN = số quẹt − % GIÁ MUA (phí mua/đối tác), KHÔNG phải trọn số.
        investorReceiveAmount = amount - Math.round((amount * partnerFeeMilli) / 100000);
        // Spread âm (phiBan < phiMua) = cấu hình sai → cờ đỏ, chặn (đồng nhất createQrTransactionSystem).
        if (sellFeeMilli < partnerFeeMilli) warnings.push(`⚠ Phí bán QR (${sellFeeMilli}) < phí mua (${partnerFeeMilli}) — spread âm, cấu hình sai. Không ghi doanh số tới khi sửa giá.`);
      } else {
        warnings.push(`⚠ ${fee.message}`); // NO_QR_FEE — chưa cấu hình giá QR (chặn gửi, fail-closed money).
      }
    }
    if (!ref && !laThongBaoThe) warnings.push('⚠ OCR không đọc được Số giao dịch (ref) — KHÔNG dedup được (rủi ro ghi doanh số x2). Kiểm tay/đọc lại.');
    else if (!ref) warnings.push('⚠ Chưa có Số giao dịch — lấy từ báo-có khớp (bấm "Tra báo có"). CHƯA có thì KHÔNG gửi được (chống ghi doanh số x2).');
    const alreadySent = ref ? await qrRefAlreadySent(db, ref, amount) : false;
    if (alreadySent) warnings.push('⚠ Bill QR này (theo Số giao dịch) ĐÃ GỬI rồi — không gửi lại (chống doanh số x2).');

    // [Admin Demo 6/9] HẠN MỨC QR/ngày: doanh số QR HÔM NAY của mã (gồm bill này) gần/vượt hạn mức → cảnh báo đổi mã QR khác.
    if (tidRow && qrDailyLimits[tidRow.id] != null && qrDailyLimits[tidRow.id] > 0) {
      const limit = qrDailyLimits[tidRow.id];
      const todayRev = await qrTodayRevenue(db, tidRow.id, at);
      const cumulative = todayRev + amount;
      const vnd = (n: number): string => n.toLocaleString('vi-VN');
      if (cumulative >= limit) warnings.push(`🔴 HẾT HẠN MỨC NGÀY mã QR: hôm nay ${vnd(todayRev)}đ + bill ${vnd(amount)}đ = ${vnd(cumulative)}đ ≥ hạn mức ${vnd(limit)}đ — ĐỔI mã QR khác để quẹt.`);
      else if (cumulative >= limit * 0.9) warnings.push(`🟡 GẦN HẠN MỨC NGÀY mã QR: ${vnd(cumulative)}đ / ${vnd(limit)}đ (${Math.round((cumulative / limit) * 100)}%) — sắp phải đổi mã QR khác.`);
    }
    const spreadNegative = sellFeeMilli != null && partnerFeeMilli != null && sellFeeMilli < partnerFeeMilli;
    const blocked = !tidRow || sellFeeMilli == null || !ref || alreadySent || spreadNegative;
    out.push({
      qr: { hkdName: q.hkdName ?? null, amount, ref, dateTime, fromCard: q.fromCard ?? null, payerName: q.payerName ?? null, noticeMerchant: q.noticeMerchant ?? null },
      noticeOnly: laThongBaoThe,
      tidId: tidRow?.id ?? null, tidCode: tidRow?.tid ?? null, hkdNameMatched: tidRow?.hkd_name ?? null,
      partnerId: tidRow?.partner_id ?? null, receiveAccountId: tidRow?.receive_account_id ?? null, industryId: tidRow?.industry_id ?? null,
      sellFeeMilli, sellFeeAmount, partnerFeeMilli, refundAmount, investorReceiveAmount, feeSource, sellFeeSource, isWeekend,
      sellFeeMilliNhanh, refundAmountNhanh,
      dealerRoomId: effectiveDealer?.roomId ?? null, dealerRoomName: effectiveDealer?.name ?? null,
      alreadySent, warnings, blocked
    });
  }
  return out;
}

// ── DEDUP GỬI BILL QR theo (ref, amount) — bảng qr_bill_sent (ensureAlphaExtraSchema). Nguyên tử qua UNIQUE(ref, amount).
//    Admin Demo 5/9 (MED phản biện): cùng ref KHÁC tiền = 2 bill thật (cho gửi); cùng ref+tiền = gửi lại (chặn). Amount
//    LÀ PHẦN của khóa → bill thiếu amount KHÔNG dedup được → route fail-closed. ── (đổi từ ref-only đợt trước.)
let _qrBillSentReady = false;
async function ensureQrBillSentReady(db: Db): Promise<void> {
  if (_qrBillSentReady) return;
  try {
    // Idempotent (parity ensureAlphaExtraSchema). Bỏ constraint ref cũ nếu có + unique index (ref, amount).
    await db.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS qr_bill_sent (id bigserial PRIMARY KEY, ref text NOT NULL, image_hash text, ' +
      'dealer_room_id text, amount bigint, sent_at timestamptz NOT NULL DEFAULT now())'
    );
    await db.$executeRawUnsafe('ALTER TABLE qr_bill_sent DROP CONSTRAINT IF EXISTS qr_bill_sent_ref_uq');
    await db.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS qr_bill_sent_ref_amount_uq ON qr_bill_sent (ref, amount)');
    // [deep-audit A3/P1] UNIQUE (partial) trên image_hash → dedup theo ẢNH thành NGUYÊN TỬ (2 phiên song song cùng ảnh
    // lệch tiền → 1 INSERT thắng, cái kia vi phạm unique → ném → reserveQrSend bắt & trả false). Đóng cửa sổ race của
    // lớp SELECT-pre-check. WHERE image_hash IS NOT NULL: dòng thiếu hash không bị chặn oan.
    await db.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS qr_bill_sent_image_hash_uq ON qr_bill_sent (image_hash) WHERE image_hash IS NOT NULL');
    _qrBillSentReady = true;
  } catch (e) {
    // [deep-audit P3/A4] KHÔNG nuốt câm (R198): DDL fail thật (quyền/disk) phải log; _qrBillSentReady giữ false → retry
    // lần sau; reserveQrSend INSERT vẫn fail-loud nếu index thiếu (không âm thầm x2).
    console.error('[qr-dedup] ensureQrBillSentReady lỗi tạo bảng/index qr_bill_sent (sẽ thử lại):', e);
  }
}
/** Bill QR (ref, amount) đã gửi chưa. true = đã gửi → chặn. Thiếu ref/amount → false (route xử riêng, không dedup mù). */
export async function qrRefAlreadySent(db: Db, ref: string, amount: number): Promise<boolean> {
  await ensureQrBillSentReady(db);
  const r = (ref ?? '').trim();
  if (!r || !(amount > 0)) return false;
  try {
    const rows = await db.$queryRawUnsafe<{ id: bigint }[]>('SELECT id FROM qr_bill_sent WHERE ref = $1 AND amount = $2 LIMIT 1', r, BigInt(Math.round(amount)));
    return Array.isArray(rows) && rows.length > 0;
  } catch { return false; }
}
/** [Admin Demo 11/9 — CẤM OCR lại ra thông số CŨ, nhánh QR] BỔ SUNG review QR theo HASH ẢNH: bill QR đã gửi mà người
 *  duyệt ĐÃ SỬA ref/tiền trước khi gửi → re-OCR trả số CŨ → qrRefAlreadySent(ref,amount) TRƯỢT → card tưởng "chưa
 *  gửi" (may còn lưới reserveQrSend image_hash lúc gửi, nhưng review đã SAI + không log đối chiếu). Tra qr_bill_sent
 *  theo image_hash → set alreadySent + blocked + ghi chú bản-gửi gần nhất (ref/tiền đã lưu) đối chiếu với số OCR.
 *  KHÔNG đè amount vào card (phí bán/hoàn đã tính theo amount OCR — đè số mà không tính lại phí = card lệch tiền câm);
 *  card bị chặn gửi nên ghi chú đối chiếu là tường minh đủ. */
export async function augmentQrReviewWithSent(db: Db, review: QrReviewItem[], imageBuffer: Buffer): Promise<void> {
  if (!review.length) return;
  await ensureQrBillSentReady(db);
  const hash = ocrImageHashOf(imageBuffer);
  let row: { ref: string; amount: bigint | null; sent_at: Date | null } | null = null;
  try {
    const rows = await db.$queryRawUnsafe<{ ref: string; amount: bigint | null; sent_at: Date | null }[]>(
      'SELECT ref, amount, sent_at FROM qr_bill_sent WHERE image_hash = $1 LIMIT 1', hash
    );
    row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch (e) { console.error('[qr-sent-by-image] tra qr_bill_sent theo image_hash lỗi (bỏ qua, còn lưới reserve lúc gửi):', e); return; }
  if (!row) return;
  const sentAmount = row.amount != null ? Number(row.amount) : null;
  for (const it of review) {
    if (it.alreadySent) continue; // ref+tiền đã khớp → cảnh báo cũ đã có, không lặp
    const ocrGoc: string[] = [];
    if ((it.qr.ref ?? '') !== row.ref) ocrGoc.push(`Số GD ${it.qr.ref ?? '—'}`);
    if (sentAmount != null && sentAmount > 0 && it.qr.amount !== sentAmount) ocrGoc.push(`tiền ${fmtVnd(it.qr.amount)}đ`);
    const sentDesc = `Số GD ${row.ref}${sentAmount != null && sentAmount > 0 ? ` · tiền ${fmtVnd(sentAmount)}đ` : ''}`;
    it.alreadySent = true;
    it.blocked = true; // fail-closed như alreadySent theo ref (route send-qr vẫn có reserveQrSend chặn tầng ghi)
    it.warnings = [
      ocrGoc.length > 0
        ? `ℹ Ảnh bill QR này ĐÃ GỬI với BẢN SỬA gần nhất (${sentDesc}) — OCR lần này đọc: ${ocrGoc.join(' · ')} (số CŨ, đừng tin). Không gửi lại (chống doanh số x2).`
        : `⚠ Ảnh bill QR này ĐÃ GỬI rồi (${sentDesc}) — không gửi lại (chống doanh số x2).`,
      ...it.warnings
    ];
  }
}

/** Đặt chỗ gửi QR (nguyên tử theo ref, amount). true = đặt được → tiếp tục gửi; false = ĐÃ có (song song thắng / đã
 *  gửi) → chặn trùng (LOG rõ, KHÔNG câm — R198). Thiếu ref/amount → false (route fail-closed, chống ghi không dedup). */
export async function reserveQrSend(db: Db, input: { ref: string; imageHash?: string | null; dealerRoomId?: string | null; amount?: number | null }): Promise<boolean> {
  await ensureQrBillSentReady(db);
  const r = (input.ref ?? '').trim();
  const amt = input.amount != null && Number.isFinite(input.amount) ? Math.round(input.amount) : null;
  if (!r || !(amt != null && amt > 0)) return false;
  // [LEAD money-safety] Lớp chặn PHỤ theo image_hash: ẢNH Y HỆT đã gửi (dù OCR đọc lệch TIỀN → (ref,amount) khác) →
  // chặn, chống x2 doanh số (money-risk #1 phản biện). Ảnh khác nhau = hash khác → 2 bill THẬT vẫn qua. Không nuốt câm.
  if (input.imageHash) {
    try {
      const dup = await db.$queryRawUnsafe<{ id: bigint }[]>('SELECT id FROM qr_bill_sent WHERE image_hash = $1 LIMIT 1', input.imageHash);
      if (Array.isArray(dup) && dup.length > 0) {
        console.warn(`[qr-dedup] reserve TRÙNG theo ẢNH (image_hash=${input.imageHash.slice(0, 12)}…, ref=${r}) — ảnh y hệt đã gửi (OCR có thể đọc lệch tiền) → chặn x2 doanh số.`);
        return false;
      }
    } catch { /* thiếu cột image_hash (bảng cũ) → bỏ lớp phụ, vẫn còn khóa (ref,amount) nguyên tử dưới */ }
  }
  let rows: { id: bigint }[];
  try {
    rows = await db.$queryRawUnsafe<{ id: bigint }[]>(
      'INSERT INTO qr_bill_sent (ref, image_hash, dealer_room_id, amount) VALUES ($1, $2, $3, $4) ' +
      'ON CONFLICT (ref, amount) DO NOTHING RETURNING id',
      r, input.imageHash ?? null, input.dealerRoomId ?? null, BigInt(amt)
    );
  } catch (e) {
    // [deep-audit A3] INSERT ném KHÁC (ref,amount) → nghi vi phạm UNIQUE image_hash (ảnh y hệt phiên song song vừa ghi).
    // Re-check: ảnh đã có → chặn (false, không x2); không phải dup ảnh → ném tiếp (fail-loud, không nuốt).
    if (input.imageHash) {
      const dup = await db.$queryRawUnsafe<{ id: bigint }[]>('SELECT id FROM qr_bill_sent WHERE image_hash = $1 LIMIT 1', input.imageHash).catch(() => [] as { id: bigint }[]);
      if (Array.isArray(dup) && dup.length > 0) {
        console.warn(`[qr-dedup] reserve TRÙNG theo ẢNH (race, image_hash=${input.imageHash.slice(0, 12)}…, ref=${r}) → chặn x2 doanh số.`);
        return false;
      }
    }
    throw e;
  }
  const ok = Array.isArray(rows) && rows.length > 0;
  if (!ok) console.warn(`[qr-dedup] reserve TRÙNG (ref=${r}, amount=${amt}) — bill QR này đã gửi (hoặc phiên song song vừa đặt) → chặn, KHÔNG ghi doanh số lần 2.`);
  return ok;
}
/** Nhả chỗ đã đặt (khi gửi/ghi LỖI) để lần sau còn thử lại. Theo (ref, amount). */
export async function releaseQrSend(db: Db, ref: string, amount: number): Promise<void> {
  const r = (ref ?? '').trim();
  if (!r || !(amount > 0)) return;
  try { await db.$executeRawUnsafe('DELETE FROM qr_bill_sent WHERE ref = $1 AND amount = $2', r, BigInt(Math.round(amount))); } catch { /* best-effort */ }
}

/** KHOÁ HOÀN QR = "QR:"+ref+":"+amount (RIÊNG, KHÔNG đụng ckTxnKey CK để KPI tách nhóm "hoàn QR"). [deep-audit A1]
 *  THÊM amount cho ĐỒNG NHẤT với dedup DOANH SỐ (ref, amount): 2 bill CÙNG ref KHÁC tiền = 2 bill thật → doanh số ghi
 *  cả 2 nhưng khoá hoàn chỉ-ref TRƯỚC ĐÂY gộp làm 1 → HOÀN THIẾU 1 bill. Nay khoá theo (ref, amount) → hoàn đủ. */
export function qrRefundKeyOf(ref: string, amount: number): string { return `QR:${(ref ?? '').trim()}:${Math.round(amount)}`; }

/** [Admin Demo 7/9 — GỐC bug "hoàn QR sửa ngày mà không ghi nhận"] Chuẩn hoá 1 ngày bill về ISO 'YYYY-MM-DD' cho
 *  metadata.billDate — MỌI đối soát/report nhóm ngày theo ISO (so chuỗi). Nhận dd/mm/yyyy, ISO, hoặc kèm giờ.
 *  KHÔNG parse được → null. Chốt chặn ở BIÊN LƯU (phòng mọi caller lỡ truyền dd/mm/yyyy như route send-qr cũ). */
export function toIsoBillDay(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = String(s).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return null;
}
/** Format 1 ngày bill về 'dd/mm/yyyy' cho CAPTION hiển thị (user VN đọc quen). Nhận ISO/dd-mm-yyyy; khác → giữ nguyên. */
export function fmtDayDisplay(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = String(s).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return t;
}

/** GỬI + GHI bill HOÀN đại lý cho QR (SigMa → đại lý CHỌN, số = amount − phíBán). RIÊNG với postDealerRefundCk:
 *  metadata `isQrRefundCk:true` (KHÔNG isDealerRefundCk) → KPI/report gom "hoàn QR" tách khỏi hoàn POS/CK (Admin Demo
 *  5/9). Idempotent theo qrRefundKey "QR:"+ref (reserveSend nguyên tử). dealerRoomId = đại lý CHỌN từ dropdown
 *  (KHÔNG tid.customerId). Tái dùng primitives (bot/attachment/sendMessage) — KHÔNG cài lại. */
export async function sendQrRefundToDealer(
  db: Db,
  input: { dealerRoomId: string; ref: string; amount: number; refundAmount: number; sellFeeMilli: number; billDate: string | null; hkdName: string | null; bank?: string | null; dateTime?: string | null; imageBuffer: Buffer; imageName: string }
): Promise<{ ok: boolean; messageId?: string; error?: string; deduped?: boolean }> {
  if (!input.dealerRoomId) return { ok: false, error: 'NO_ROOM_MATCH' };
  const key = qrRefundKeyOf(input.ref, input.amount);
  const bot = await ensureAlphaBotAgent(db);
  await ensureBotMember(db, input.dealerRoomId, bot.id);
  // Idempotent: đã có tin hoàn QR cùng key → không đăng lần 2.
  const marker = `"qrRefundKey":${JSON.stringify(key)}`;
  const exist = await db.chatMessage.findFirst({ where: { roomId: input.dealerRoomId, metadataJson: { contains: marker }, deletedAt: null }, select: { id: true } });
  if (exist) return { ok: true, messageId: String(exist.id), deduped: true };
  const reserved = await reserveSend(db, input.dealerRoomId, key).catch((e) => { console.error('[reserveSend] LỖI DB (fail-open — dedup tầng tin vẫn chặn):', e instanceof Error ? e.message : e); return true; });
  if (!reserved) return { ok: true, deduped: true };
  const att = await saveAttachment(db, input.imageBuffer, input.imageName, bot.id);
  if (!att.ok) { await releaseSend(db, input.dealerRoomId, key).catch(() => {}); return { ok: false, error: `ATT_FAIL:${att.reason}` }; }
  // [Admin Demo 7/9] billDate metadata = ISO (đối soát nhóm ngày); CAPTION + posBill.dateTime hiển thị dd/mm/yyyy (user VN).
  const billDateIso = toIsoBillDay(input.billDate);
  const billDateDisp = fmtDayDisplay(input.billDate);
  const caption = `💸 HOÀN TIỀN ĐẠI LÝ (QR) · ${fmtVnd(input.refundAmount)}đ${billDateDisp ? ` · ${billDateDisp}` : ''}`
    + `${input.hkdName ? `\n🏪 HKD: ${input.hkdName}` : ''}\n🔖 Số GD: ${input.ref}`;
  // [Admin Demo 7/9] isBillImage + posBill → client render CARD 2 cột (PosBillCard) GIỐNG bill POS/CK, KHÔNG còn ảnh-thô +
  // caption. GIỮ isTransferRefund/isQrRefundCk (đối soát "đã hoàn" đại lý đọc key này) — chỉ THÊM meta hiển thị.
  const feePct = input.sellFeeMilli != null ? input.sellFeeMilli / 1000 : null;
  const meta = { isTransferRefund: true, isQrRefundCk: true, isBillImage: true, refundAmount: input.refundAmount, qrRefundKey: key, qrRef: input.ref, sellFeeMilli: input.sellFeeMilli, ocrImageHash: ocrImageHashOf(input.imageBuffer), billDate: billDateIso, hkdName: input.hkdName,
    posBill: { tid: null, hkd: input.hkdName, bank: input.bank ?? null, dateTime: input.dateTime ?? billDateDisp ?? null, amount: input.amount, lo: null, feeLabel: 'Phí bán', feePct, netLabel: 'Phải hoàn', netAmount: input.refundAmount, ref: input.ref, title: 'Hoàn tiền đại lý (QR)', hideEdit: true } };
  const msg = await sendMessage(db, { roomId: input.dealerRoomId, senderId: bot.id, kind: 'IMAGE', body: caption, attachmentId: att.id, metadataJson: JSON.stringify(meta) });
  broadcastToRoom(input.dealerRoomId, { msg: 'new-message', roomId: input.dealerRoomId, message: msg });
  return { ok: true, messageId: String(msg.id) };
}

/** [Admin Demo 5/9] mã QR → TK nhận (receiveAccountId) → NĐT (investorId) → phòng NĐT đang-gán (investorChatGroup.roomId).
 *  CÙNG đường POS (resolveInvestorRoomForTid dùng receiveAccount→investorId), nhưng QR resolve THẲNG từ receiveAccountId
 *  của mã (item.receiveAccountId ở reviewQr) — QR tid KHÔNG gán customerId nên KHÔNG đi qua scope phòng đại lý. Chưa uỷ
 *  NĐT / TK xoá / NĐT chưa gán nhóm → null (route bỏ cc NĐT, KHÔNG chặn — như POS investorRoomId null). */
export async function resolveInvestorRoomByReceiveAccount(db: Db, receiveAccountId: number | null | undefined): Promise<string | null> {
  if (receiveAccountId == null) return null;
  const acct = await db.receiveAccount.findFirst({ where: { id: receiveAccountId, deletedAt: null }, select: { investorId: true } });
  if (!acct || acct.investorId == null) return null;
  return resolveInvestorRoomById(db, acct.investorId);
}

/** Khoá idempotent CC bill QR sang nhóm NĐT (ref + tiền). KHÁC hoàn đại lý (QR:) để không đụng nhau. */
export function qrInvestorKeyOf(ref: string, amount: number): string { return `QR-INV:${(ref ?? '').trim()}:${Math.round(amount)}`; }

/** [Admin Demo 5/9] ĐĂNG bill QR sang NHÓM NĐT (như POS cc) — CHỈ ẢNH bill + tóm tắt các trường ĐỌC-TRÊN-BILL (HKD · số
 *  tiền · ngày · Số GD). TUYỆT ĐỐI KHÔNG phí bán/%/tên đại lý (bảo mật 2 chiều, đồng nhất crossPostBillToInvestor). NĐT
 *  QR nhận TRỌN amount (phí cài máy=0) nên số tiền = doanh số = đã có trên bill. Idempotent theo qrInvestorKey (marker +
 *  reserveSend nguyên tử). BEST-EFFORT: KHÔNG là đường tiền (chỉ tin chat) → route gọi best-effort, lỗi báo rõ KHÔNG chặn. */
export async function sendQrToInvestor(
  db: Db,
  input: { investorRoomId: string; ref: string; amount: number; billDate: string | null; hkdName: string | null; bank?: string | null; dateTime?: string | null; imageBuffer: Buffer; imageName: string }
): Promise<{ ok: boolean; messageId?: string; error?: string; deduped?: boolean }> {
  if (!input.investorRoomId) return { ok: false, error: 'NO_INVESTOR_ROOM' };
  const key = qrInvestorKeyOf(input.ref, input.amount);
  const bot = await ensureAlphaBotAgent(db);
  await ensureBotMember(db, input.investorRoomId, bot.id);
  const marker = `"qrInvestorKey":${JSON.stringify(key)}`;
  const exist = await db.chatMessage.findFirst({ where: { roomId: input.investorRoomId, metadataJson: { contains: marker }, deletedAt: null }, select: { id: true } });
  if (exist) return { ok: true, messageId: String(exist.id), deduped: true };
  const reserved = await reserveSend(db, input.investorRoomId, key).catch((e) => { console.error('[reserveSend] LỖI DB (fail-open — dedup tầng tin vẫn chặn):', e instanceof Error ? e.message : e); return true; });
  if (!reserved) return { ok: true, deduped: true };
  const att = await saveAttachment(db, input.imageBuffer, input.imageName, bot.id);
  if (!att.ok) { await releaseSend(db, input.investorRoomId, key).catch(() => {}); return { ok: false, error: `ATT_FAIL:${att.reason}` }; }
  // [Admin Demo 7/9] billDate metadata = ISO (đối soát/report nhóm ngày); CAPTION + posBill.dateTime hiển thị dd/mm/yyyy.
  const billDateIso = toIsoBillDay(input.billDate);
  const billDateDisp = fmtDayDisplay(input.billDate);
  const caption = `🧾 Bill QR${input.hkdName ? ` · ${input.hkdName}` : ''} · ${fmtVnd(input.amount)}đ${billDateDisp ? ` · ${billDateDisp}` : ''}\n🔖 Số GD: ${input.ref}`;
  // isBillImage → client render khung bill; qrInvestorKey → dedupe. KHÔNG kèm phí/doanh thu nội bộ (chỉ trường trên bill).
  // [Admin Demo 7/9] posBill → CARD 2 cột GIỐNG POS/CK (thay ảnh-thô). NĐT: CHỈ Khách/Ngân hàng/Ngày giờ/Số tiền/Số GD —
  // TUYỆT ĐỐI KHÔNG phí bán/hoàn/tên đại lý (bảo mật, NĐT nhận trọn amount vì phí cài máy QR = 0).
  const meta = { isBillImage: true, isQrInvestorCc: true, qrInvestorKey: key, qrRef: input.ref, billAmount: input.amount, billDate: billDateIso, hkdName: input.hkdName, ocrImageHash: ocrImageHashOf(input.imageBuffer),
    posBill: { tid: null, hkd: input.hkdName, bank: input.bank ?? null, dateTime: input.dateTime ?? billDateDisp ?? null, amount: input.amount, lo: null, ref: input.ref, title: 'Bill QR (NĐT)', hideEdit: true } };
  const msg = await sendMessage(db, { roomId: input.investorRoomId, senderId: bot.id, kind: 'IMAGE', body: caption, attachmentId: att.id, metadataJson: JSON.stringify(meta) });
  broadcastToRoom(input.investorRoomId, { msg: 'new-message', roomId: input.investorRoomId, message: msg });
  return { ok: true, messageId: String(msg.id) };
}

/** Khoá idempotent gửi 1 bill. ngày = từ dateTime bill (dd/mm/yyyy) hoặc 'unknown'.
 *  BUG FIX 1/9 (Agent-A): lô KHÔNG-số-lô → 'amt:<tiền>[@giờ]' để 2 lô khác tiền có key KHÁC.
 *  [Admin Demo 2/9 — TRÙNG KHOÁ NUỐT BILL] 2 bill POS CÙNG tid+lô+ngày nhưng KHÁC TIỀN (nhiều SALE trong 1 lô) TRƯỚC ĐÂY
 *  ra CÙNG `VL|tid|lô|day` → bill thứ 2 bị chấm 'đã gửi' → auto-skip câm → SÓT. Nay THÊM 'amt:<tiền>' cả khi CÓ lô →
 *  mỗi bill khác tiền = key khác, hết nuốt. AN TOÀN double-count: dedup TIỀN nằm ở billKey (imageHash), độc lập key này. */
export function ocrSendKey(tid: string, batchNumber: string | null, dateTime: string | null, totalAmount?: number | null): string {
  // [A-L2 21/9] Nhận cả ngày 1 CHỮ SỐ "8/9/2026" (trước đòi \d{2} → day='unknown' → dedup xuyên ngày yếu với
  // bill cùng tiền). Pad 2 số để key đồng nhất "2026-09-08" như bill 2-số (không tách key theo cách OCR in ngày).
  const dm = dateTime ? /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(dateTime) : null;
  const day = dm ? `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}` : 'unknown';
  const hasBatch = batchNumber != null && String(batchNumber).trim() !== '' && batchNumber !== '?';
  const t = hasBatch ? '' : extractBillTime(dateTime);
  const lotKey = hasBatch ? batchNumber : (totalAmount != null && Number.isFinite(totalAmount) ? `amt:${Math.round(totalAmount)}${t ? `@${t}` : ''}` : '?');
  // Hậu tố phân biệt khi CÓ lô: gắn tiền → 2 bill cùng lô/ngày khác tiền có key KHÁC (chống trùng khoá nuốt bill).
  const uniq = hasBatch && totalAmount != null && Number.isFinite(totalAmount) ? `|amt:${Math.round(totalAmount)}` : '';
  return `VL|${tid}|${lotKey}|${day}${uniq}`;
}

/** Chuẩn hoá tên HKD để SO KHỚP suy-TID (bug lô 83 1/9): bỏ dấu tiếng Việt, đổi đ→d, bỏ mọi ký tự không phải
 *  chữ-số, uppercase → "HKD DEMO 6-1" == "HKD DEMO 6 1" == "hkdthanhnam1". Rỗng → '' (không khớp gì). */
export function normalizeHkdKey(s: string | null | undefined): string {
  if (!s) return '';
  const k = s.replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  // [Admin Demo 4/9] BỎ tiền tố "HKD" (Hộ Kinh Doanh — LOẠI HÌNH, không phải tên): hệ thống lưu "HKD DEMO 14"
  // nhưng OCR đọc trên bill KHÔNG có "HKD" ("KHACH HANG 56 1295 M5") → so khớp LỆCH GIẢ ("LỆCH TID↔HKD" báo nhầm mọi
  // bill). Strip prefix để 2 bên cùng chuẩn → khớp thật. Giữ nguyên nếu strip ra rỗng (tên chỉ là "HKD").
  return k.startsWith('HKD') && k.length > 3 ? k.slice(3) : k;
}

/** [Admin Demo 17/9 "không xử lý triệt để được à" — ca thật TID 67512202: hệ "HKD DEMO 27", OCR đọc "…MZ"]
 *  OCR NHẦM CHỮ ↔ SỐ NHÌN GIỐNG NHAU (Z↔2, O↔0, I/L↔1, S↔5, B↔8, G↔6) là lỗi THỊ GIÁC của mọi model khi ảnh mờ —
 *  siết prompt chỉ giảm chứ không diệt được. Nên chặn ở TẦNG SO KHỚP: quy các ký tự đó về DẠNG SỐ rồi mới so
 *  → "M2" ≡ "MZ" ⇒ hết cảnh báo đỏ oan (TID mới là khoá định danh, tên chỉ để kiểm chéo).
 *
 *  CỐ Ý KHÔNG dùng khoảng-cách-chuỗi (Levenshtein ≤1): hậu tố máy "M1" và "M2" LỆCH ĐÚNG 1 KÝ TỰ nhưng là HAI MÁY
 *  KHÁC NHAU THẬT — nhận nhầm là gửi tiền sai máy. Chỉ gộp đúng các cặp chữ-số ĐỒNG HÌNH, không gộp số với số. */
export function canonNhamKyTuOcr(key: string): string {
  return key.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/Z/g, '2').replace(/S/g, '5').replace(/B/g, '8').replace(/G/g, '6');
}

/** [Admin Demo 17/9 — ca thật TID 67512805] OCR đọc tên đại lý DÍNH LUÔN ĐỊA CHỈ in ngay dưới:
 *    hệ  : "HKD DEMO 14"
 *    OCR : "KHACH HANG 56 1295 M5 XOM 12 HONG QUANG HOA XA HA NOI"
 *  → so bằng chuỗi ra LỆCH, báo đỏ oan mỗi bill của máy đó. Prompt siết rồi nhưng bố cục bill mỗi bank mỗi khác
 *  nên vẫn lọt; chốt chặn ở TẦNG SO KHỚP: nếu tên OCR = tên hệ + phần dư MỞ ĐẦU BẰNG TỪ CHỈ ĐỊA CHỈ thì coi là
 *  CÙNG TÊN.
 *
 *  RANH GIỚI: chỉ chấp nhận khi phần dư bắt đầu bằng từ địa chỉ rõ ràng (XOM/THON/SO/DUONG/PHO/PHUONG/XA/QUAN/
 *  HUYEN/TP/TINH/KHU/AP/TO/NGO/NGACH/DUONG). KHÔNG chấp nhận phần dư là số/chữ bất kỳ — "…M5" vs "…M53" hay
 *  "…M5 2" phải VẪN LỆCH, vì đó có thể là MÁY KHÁC (nhận nhầm = gửi tiền sai máy). */
export function tenChiThemDiaChi(kOcr: string, kTid: string): boolean {
  if (!kOcr || !kTid || kOcr.length <= kTid.length) return false;
  if (!kOcr.startsWith(kTid)) return false;
  const du = kOcr.slice(kTid.length);
  return /^(XOM|THON|SO|DUONG|PHO|PHUONG|XA|QUAN|HUYEN|TP|THANHPHO|TINH|KHU|AP|TO|NGO|NGACH|KM|CUMCN|KCN)/.test(du);
}

/** [PHẢN BIỆN 11/9 — A1] Tên OCR (cắt/mờ, đã normalizeHkdKey) có TƯƠNG THÍCH tên 1 mã QR không: một bên CHỨA bên kia,
 *  hoặc TIỀN TỐ CHUNG đủ dài (≥ max(4, nửa key ngắn hơn) — vd prod "NGUYENTRH" vs "NGUYENTRAMY" chung 8 ký tự → khớp;
 *  "LEVANBINH" chung 0 → loại). Dùng THU HẸP cứu-mã-theo-báo-có: chặn mã tên-khác-hẳn cùng-tiền-cùng-giờ cướp bill.
 *  THUẦN — không DB. */
export function hkdKeyTuongThich(ocrKey: string, tidKey: string): boolean {
  // Key quá ngắn (<4) → KHÔNG kết luận tương thích (mảnh "NGH" nằm GIỮA "TRANGHIEM" sẽ khớp includes giả) — trả false
  // ⇒ compat set rỗng ⇒ rescue giữ tra toàn cục (hành vi đã duyệt), không thu hẹp sai.
  if (!ocrKey || !tidKey || ocrKey.length < 4 || tidKey.length < 4) return false;
  if (ocrKey.includes(tidKey) || tidKey.includes(ocrKey)) return true;
  const n = Math.min(ocrKey.length, tidKey.length);
  let p = 0;
  while (p < n && ocrKey[p] === tidKey[p]) p++;
  return p >= Math.max(4, Math.ceil(n / 2));
}

/** [PHẢN BIỆN 11/9 — B1] Chọn BẬC GIÁ BÁN QR lúc gửi (/send-qr) — THUẦN, route dùng CHÍNH hàm này (tách khỏi inline
 *  để test được). giaNhanhRequested nhưng mã KHÔNG có bậc nhanh (null/≤0) → rơi về CHỜ (fail-safe, không tự chế giá).
 *  spreadNegative = bậc ĐÃ CHỌN < giá mua → caller PHẢI chặn ghi (422, fail-closed money). Làm tròn Math.round đồng
 *  công thức computeFeeLine/reviewQr (từng đồng nhất quán chờ↔nhanh). */
export function chonBacGiaQr(input: { giaNhanhRequested: boolean; amount: number; sellFeeMilli: number; sellFeeMilliNhanh: number | null; partnerFeeMilli: number }): { giaNhanh: boolean; effSellFeeMilli: number; effSellFeeAmount: number; spreadNegative: boolean } {
  const giaNhanh = input.giaNhanhRequested === true && input.sellFeeMilliNhanh != null && input.sellFeeMilliNhanh > 0;
  const effSellFeeMilli = giaNhanh ? (input.sellFeeMilliNhanh as number) : input.sellFeeMilli;
  return {
    giaNhanh,
    effSellFeeMilli,
    effSellFeeAmount: Math.round((input.amount * effSellFeeMilli) / 100000),
    spreadNegative: effSellFeeMilli < input.partnerFeeMilli
  };
}

export type TidHkdVerdict = { note: string | null; severity: 'red' | 'amber' | null };

/** [H2 audit 2/9] Đối chiếu 2 chiều TID↔HKD cho 1 bill ĐÃ route. THUẦN (không DB) để test HÀNH VI khoá cứng (R198 —
 *  không grep nguồn). 3 tầng, KHÔNG chỉ "tên khác nhau":
 *   (a) OCR đọc tên & tên ≠ tên HKD chuẩn của TID → RED "LỆCH" (OCR nhầm số TID/tên → route SAI máy âm thầm).
 *   (b) HKD có >1 máy (TID anh em cùng tên) → AMBER: OCR nhầm sang máy CÙNG HKD sẽ KHÔNG lệch tên → bắt xác nhận.
 *   (c) 1 máy nhưng OCR mất tên (không đối chiếu được) → AMBER nhẹ.
 *   Khớp tên + 1 máy → null (đúng, "mặc định đúng" — không nhiễu). inferred/thiếu tên-TID → null (đã khớp/không đối chiếu).
 *  severity chỉ để TEST/đọc; UI phân đỏ-amber theo có chuỗi "LỆCH TID" trong note (đỏ) hay không (amber). */
export function classifyTidHkdMatch(args: {
  inferred: boolean;
  tid: string | null | undefined;
  tidHkdName: string | null | undefined;
  ocrAgencyName: string | null | undefined;
  siblingCount: number;
}): TidHkdVerdict {
  const { inferred, tid, tidHkdName, ocrAgencyName, siblingCount } = args;
  if (inferred) return { note: null, severity: null };
  const kTid = normalizeHkdKey(tidHkdName);
  const kOcr = ocrAgencyName ? normalizeHkdKey(ocrAgencyName) : '';
  // [Audit 3/9 #20] TID CHƯA có tên HKD trong DB → không đối chiếu được. TRƯỚC ĐÂY trả null (câm) NGAY CẢ khi OCR
  // đọc được tên khác → tiền có thể vào sai máy mà không cảnh báo. Nay: OCR có tên → cảnh báo amber (không nuốt câm).
  if (!tidHkdName) {
    return kOcr ? { severity: 'amber', note: `⚠ TID ${tid} CHƯA có tên HKD trong hệ thống — KHÔNG đối chiếu được với tên OCR "${ocrAgencyName}". Kiểm ĐÚNG máy trước khi gửi.` } : { note: null, severity: null };
  }
  // Lệch CHỈ do OCR nhầm chữ↔số đồng hình (Z/2, O/0, I,L/1, S/5, B/8, G/6) ⇒ CÙNG MỘT TÊN → KHÔNG báo đỏ oan.
  // Lệch thật (khác số máy M1/M2, khác tên) vẫn đỏ như cũ.
  const nhamKyTu = !!kOcr && !!kTid && kOcr !== kTid && canonNhamKyTuOcr(kOcr) === canonNhamKyTuOcr(kTid);
  if (nhamKyTu) console.error(`[tid-hkd] BỎ cảnh báo lệch GIẢ do OCR nhầm chữ↔số đồng hình: TID ${tid} hệ "${tidHkdName}" vs OCR "${ocrAgencyName}" — cùng tên sau khi quy chữ↔số.`);
  // OCR đọc dính ĐỊA CHỈ vào sau tên (ca thật 17/9 TID 67512805) → vẫn là CÙNG MÁY, không báo lệch.
  const dinhDiaChi = !!kOcr && !!kTid && (tenChiThemDiaChi(kOcr, kTid) || tenChiThemDiaChi(canonNhamKyTuOcr(kOcr), canonNhamKyTuOcr(kTid)));
  if (dinhDiaChi) console.error(`[tid-hkd] BỎ cảnh báo lệch GIẢ do OCR đọc DÍNH ĐỊA CHỈ: TID ${tid} hệ "${tidHkdName}" vs OCR "${ocrAgencyName}".`);
  if (kOcr && kTid && kOcr !== kTid && !nhamKyTu && !dinhDiaChi) {
    return { severity: 'red', note: `⚠ LỆCH TID↔HKD: TID ${tid} trong hệ thống là "${tidHkdName}" nhưng OCR đọc tên "${ocrAgencyName}" — OCR có thể NHẦM số TID hoặc tên. KIỂM TRA ĐÚNG MÁY trước khi gửi (tránh gửi + tính tiền SAI máy).` };
  }
  if (siblingCount > 1) {
    return { severity: 'amber', note: `⚠ HKD "${tidHkdName}" có ${siblingCount} máy (TID) — XÁC NHẬN đúng máy ${tid}${kOcr ? '' : ' (OCR KHÔNG đọc được tên HKD để đối chiếu)'} trước khi gửi (tránh nhầm sang máy khác CÙNG HKD → sai phí/NĐT).` };
  }
  if (!kOcr) {
    return { severity: 'amber', note: `⚠ OCR không đọc được tên HKD để đối chiếu với TID ${tid} — kiểm nhanh đúng máy trước khi gửi.` };
  }
  return { note: null, severity: null };
}

/** Đã gửi bill này vào phòng đại lý chưa? (tìm marker ocrSendKey trong metadataJson tin của phòng).
 *  [Admin Demo 2/9 — BACKWARD-COMPAT, cấm tái diễn double-send] Key MỚI thêm hậu tố `|amt:<tiền>` (chống trùng khoá).
 *  Bill gửi TRƯỚC 0.6.30 có marker format CŨ `VL|tid|lô|ngày` (KHÔNG amt) → nếu chỉ so key mới sẽ KHÔNG khớp → tưởng
 *  CHƯA gửi → gửi lại (rác nhóm + double-record). Nay so CẢ key mới LẪN key cũ (bỏ hậu tố amt). Key cũ có đóng `"`
 *  nên KHÔNG false-match marker mới (marker mới sau `ngày` là `|amt`, không phải `"`) → không phá fix chống-trùng-khoá. */
export async function alreadySent(db: Db, dealerRoomId: string, key: string): Promise<boolean> {
  const legacy = key.replace(/\|amt:\d+$/, ''); // format trước 2/9 (không có amt)
  const keys = legacy !== key ? [key, legacy] : [key];
  for (const k of keys) {
    const marker = `"ocrSendKey":${JSON.stringify(k)}`;
    // [A-M1 21/9] deletedAt:null — tin bill ĐÃ XOÁ (thu hồi gửi nhầm) mà vẫn tính "đã gửi" thì bill thật bị KHOÁ
    // gửi lại vĩnh viễn → SÓT doanh số câm (parity với findSentByImageHashGlobal đã lọc từ trước).
    const hit = await db.chatMessage.findFirst({ where: { roomId: dealerRoomId, deletedAt: null, metadataJson: { contains: marker } }, select: { id: true } });
    if (hit != null) return true;
  }
  return false;
}

/** HASH ẢNH BILL (sha256 hex) — định danh ỔN ĐỊNH của 1 ảnh bill, KHÔNG phụ thuộc OCR đọc số. Dùng nhận diện "đã
 *  gửi" theo ẢNH (chống double-send khi OCR đọc lệch tid/lô/tiền). */
export function ocrImageHashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
/** Marker tra metadataJson theo hash ảnh. */
export function imageSentMarker(hash: string): string {
  return `"ocrImageHash":${JSON.stringify(hash)}`;
}
/** [Audit 3/9 #1] TÌM tin đã gửi theo HASH ẢNH TRÊN TOÀN CỤC (mọi phòng đại lý) — chống lỗ hổng cross-phòng: OCR đọc
 *  lệch/sửa TID sang máy KHÁC PHÒNG → dò theo phòng-mới trượt bản gốc phòng-cũ → x2 doanh số + sai máy. 1 ẢNH = 1 bill
 *  = chỉ được gửi/ghi 1 lần BẤT KỂ phòng. Trả {messageId, roomId} tin cũ hoặc null. */
export async function findSentByImageHashGlobal(db: Db, imageHash: string): Promise<{ messageId: string; roomId: string } | null> {
  const row = await db.chatMessage.findFirst({
    where: { deletedAt: null, metadataJson: { contains: imageSentMarker(imageHash) } },
    select: { id: true, roomId: true }, orderBy: { createdAt: 'desc' }
  });
  return row ? { messageId: String(row.id), roomId: String(row.roomId) } : null;
}
/** [Agent-2 11/9 — CHẶN ẢNH LẠC LUỒNG, tái hiện bằng e2e-cross-flow-adversarial] 1 ảnh = 1 chứng từ = 1 LUỒNG tiền.
 *  Ảnh ĐÃ GỬI ở luồng POS (tin bill có `ocrSendKey`) hoặc QR (isQrRefundCk/isQrInvestorCc) mà OCR lần sau phân loại
 *  nhầm thành CHUYỂN KHOẢN (hoặc người duyệt chọn tay nhầm) → TRƯỚC ĐÂY đường CK không tra chéo → ghi thêm 1 khoản
 *  hoàn/ứng MA từ chính ảnh bill đã tính doanh số (đã-hoàn phồng câm). Trả luồng cũ để caller CHẶN fail-closed.
 *  Ảnh đã gửi ở CHÍNH luồng CK (isTransferRefund) KHÔNG tính — dedup CK hiện có xử tiếp (update/dedup). */
export async function findImageSentOtherFlowForCk(db: Db, imageHash: string): Promise<{ messageId: string; flow: 'POS' | 'QR' } | null> {
  const rows = await db.chatMessage.findMany({
    where: { deletedAt: null, metadataJson: { contains: imageSentMarker(imageHash) } },
    select: { id: true, metadataJson: true }
  });
  for (const r of rows) {
    let m: Record<string, unknown> = {};
    try { m = JSON.parse(r.metadataJson ?? '{}') as Record<string, unknown>; } catch { continue; }
    if (typeof m.ocrSendKey === 'string') return { messageId: String(r.id), flow: 'POS' };
    if (m.isQrRefundCk === true || m.isQrInvestorCc === true) return { messageId: String(r.id), flow: 'QR' };
  }
  // [Kiểm chứng độc lập 11/9 — VÁ LỖ ZALO-INGEST] Bill do watcher Zalo ingest (Support SigMa, zalo-bill-ingest.ts)
  // ĐÃ GHI DOANH SỐ (createLoFromBillTid) nhưng metadata chỉ mang `zaloBillHash` (KHÔNG ocrSendKey/ocrImageHash)
  // → lưới trên trượt → cùng ảnh đó vẫn ghi được thành CK hoàn/ứng MA. CHỈ chặn tin đã-ghi-tiền (isBillImage +
  // billAmount, KHÔNG needsManual); tin needsManual/isSettlement/isRefundTransfer của watcher KHÔNG ghi tiền →
  // không chặn (tránh chặn oan ảnh CK bị watcher đoán nhầm là bill rồi cắm cờ kiểm tay).
  const zrows = await db.chatMessage.findMany({
    where: { deletedAt: null, metadataJson: { contains: `"zaloBillHash":${JSON.stringify(imageHash)}` } },
    select: { id: true, metadataJson: true }
  });
  for (const r of zrows) {
    let m: Record<string, unknown> = {};
    try { m = JSON.parse(r.metadataJson ?? '{}') as Record<string, unknown>; } catch { continue; }
    if (m.isBillImage === true && m.needsManual !== true && m.billAmount != null) return { messageId: String(r.id), flow: 'POS' };
  }
  return null;
}
/** Thông báo chặn ảnh-lạc-luồng (dùng chung dealer + NĐT). */
function imageOtherFlowMsg(flow: 'POS' | 'QR'): string {
  return `Ảnh này ĐÃ GỬI ở luồng bill ${flow} (đã tính doanh số/hoàn ở luồng đó) — KHÔNG được ghi thành CK hoàn/ứng (1 ảnh = 1 chứng từ = 1 luồng tiền). Kiểm lại phân loại.`;
}

/** [Audit 3/9 #23] TÌM CK tạm-ứng/hoàn-thừa NĐT đã gửi trong phòng NĐT (khớp ckTxnKey HOẶC hash ảnh — chống OCR lệch). */
export async function findSentInvestorCk(db: Db, roomId: string, ckTxnKey: string, imgHash: string): Promise<string | null> {
  const rows = await db.chatMessage.findMany({
    where: { roomId, deletedAt: null, metadataJson: { contains: '"isTransferRefund"' } },
    select: { id: true, metadataJson: true }, orderBy: { createdAt: 'desc' }
  });
  for (const r of rows) {
    if (!r.metadataJson) continue;
    let m: { isInvestorAdvanceCk?: boolean; isInvestorRepaymentCk?: boolean; ckTxnKey?: string | null; ocrImageHash?: string | null };
    try { m = JSON.parse(r.metadataJson); } catch { continue; }
    if (!m.isInvestorAdvanceCk && !m.isInvestorRepaymentCk) continue;
    if (m.ckTxnKey === ckTxnKey || (!!m.ocrImageHash && m.ocrImageHash === imgHash)) return String(r.id);
  }
  return null;
}
/** [Dọn nợ 11/9 — audit #cross-room] TÌM CK hoàn/ứng ĐẠI LÝ đã gửi ở BẤT KỲ phòng nào (khớp ckTxnKey HOẶC hash
 *  ảnh). Dùng làm guard CHẶN 1 ảnh CK gửi vào 2 phòng khác nhau → aggregate dedup toàn cục sẽ nuốt câm 1 bên
 *  (đếm sai hoàn). Trả cả roomId để báo rõ đã gửi ở đâu. */
export async function findDealerCkGlobal(db: Db, ckTxnKey: string, imgHash: string): Promise<{ messageId: string; roomId: string } | null> {
  const rows = await db.chatMessage.findMany({
    where: { deletedAt: null, kind: 'IMAGE', metadataJson: { contains: '"isTransferRefund"' } },
    select: { id: true, roomId: true, metadataJson: true }, orderBy: { createdAt: 'desc' }
  });
  for (const r of rows) {
    if (!r.metadataJson) continue;
    let m: { isDealerRefundCk?: boolean; isDealerAdvanceCk?: boolean; ckTxnKey?: string | null; ocrImageHash?: string | null };
    try { m = JSON.parse(r.metadataJson); } catch { continue; }
    if (m.isDealerRefundCk !== true && m.isDealerAdvanceCk !== true) continue;
    if (m.ckTxnKey === ckTxnKey || (!!m.ocrImageHash && m.ocrImageHash === imgHash)) return { messageId: String(r.id), roomId: String(r.roomId) };
  }
  return null;
}

/** TÌM tin ĐÃ GỬI trong phòng đại lý theo HASH ẢNH (Admin Demo 3/9 "cấm gửi mới, phải cập nhật tin cũ"). Cùng ảnh = ĐÃ
 *  GỬI dù OCR đọc lệch số. Nếu nhiều tin cùng ảnh (ảnh nhiều lô) → ưu tiên tin có CÙNG lô; không có lô khớp → tin mới
 *  nhất cùng ảnh. Trả messageId hoặc null. */
export async function findSentByImageHash(db: Db, dealerRoomId: string, imageHash: string, lo: string | null): Promise<string | null> {
  const rows = await db.chatMessage.findMany({
    where: { roomId: dealerRoomId, metadataJson: { contains: imageSentMarker(imageHash) }, deletedAt: null },
    select: { id: true, metadataJson: true }, orderBy: { createdAt: 'desc' }
  });
  if (rows.length === 0) return null;
  if (lo != null && lo.trim() !== '') {
    const loMarker = `"ocrLo":${JSON.stringify(lo.trim())}`;
    const byLo = rows.find((r) => r.metadataJson?.includes(loMarker));
    if (byLo) return byLo.id;
  }
  return rows[0].id; // cùng ảnh, không phân biệt được lô → tin mới nhất
}

/** BỔ SUNG nhận diện "đã gửi" theo HASH ẢNH cho danh sách review (Admin Demo 3/9). Với item có phòng đại lý mà CHƯA nhận
 *  alreadySent/sentMessageId qua ocrSendKey (OCR đọc lệch → key miss), tra theo ẢNH → set. Kết quả: bill đã gửi LUÔN
 *  bị khóa gửi-mới + buộc "Cập nhật tin cũ" → KHÔNG thể tạo Lô mới (chống doanh số x2). Chạy ở ROUTE (nơi có ảnh). */
/** TÌM bill đã gửi theo (PHÒNG + LÔ + SỐ TIỀN) — KHÔNG phụ thuộc TID (thứ OCR hay đọc lệch). Bắt được bill gửi TRƯỚC
 *  0.6.35 (chưa có ocrImageHash) + ca TID sửa khác lúc gửi (Admin Demo 3/9 "THAI BINH 1 lô 5 vẫn gửi lại"). Lô + tiền
 *  trong 1 phòng đại lý gần như định danh 1 bill (lô tuần tự theo TID, tiền cụ thể) → khớp = ĐÃ GỬI. Parse ocrSendKey
 *  `VL|tid|lô|day|amt:X`. Trả messageId hoặc null. */
/** Ngày YYYY-MM-DD từ dateTime "dd/mm/yyyy ..." — KHỚP đúng cách ocrSendKey dựng `day`. null nếu không đọc được. */
function ocrDayOf(dateTime: string | null | undefined): string | null {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(dateTime ?? '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
export async function findSentByLoAmount(db: Db, dealerRoomId: string, lo: string | null, amount: number, billDateTime: string | null, tid?: string | null): Promise<string | null> {
  const loT = (lo ?? '').trim();
  const amt = Math.round(amount);
  const billDay = ocrDayOf(billDateTime);
  // [Audit 3/9 #7] BẮT BUỘC có NGÀY: lô CYCLE lại theo ngày (lô 5 hôm nay ≠ lô 5 hôm qua) + tiền tròn dễ trùng → thiếu
  // ngày = false 'đã gửi' XUYÊN NGÀY → khóa cứng bill ngày mới → SÓT doanh số. Không đủ (lô/tiền/ngày) → bỏ (không match).
  if (!loT || !(amt > 0) || !billDay) return null;
  // [BUG 2 fix — Admin Demo 5/9 stress-test POS] BẮT BUỘC khớp CẢ TID khi có: 1 phòng đại lý có NHIỀU MÁY POS (TID
  // anh em cùng HKD 1/2/3). Lô CYCLE theo TỪNG MÁY + số tiền tròn (10tr...) lặp nhiều → 2 MÁY khác nhau (TID khác)
  // cùng lô + cùng tiền + cùng ngày là chuyện THƯỜNG → nếu bỏ TID sẽ chấm bill máy-B (CHƯA gửi) = tin máy-A → false
  // "đã gửi" → ẨN nút Gửi (ngõ cụt) + SÓT doanh số. Tier-1 (hash ẢNH) đã lo ca "cùng ảnh, OCR đọc lệch TID" nên tier-2
  // này siết theo TID an toàn. Chỉ khi bill KHÔNG đọc được TID (tidT rỗng) mới nới về lô+tiền+ngày (hiếm, OCR mù TID).
  const tidT = (tid ?? '').trim();
  const rows = await db.chatMessage.findMany({
    where: { roomId: dealerRoomId, deletedAt: null, metadataJson: { contains: `amt:${amt}` } },
    select: { id: true, metadataJson: true }, orderBy: { createdAt: 'desc' }
  });
  for (const r of rows) {
    if (!r.metadataJson) continue;
    let m: { ocrSendKey?: string; ocrLo?: string | null };
    try { m = JSON.parse(r.metadataJson); } catch { continue; }
    if (!m.ocrSendKey) continue;
    const parts = m.ocrSendKey.split('|'); // VL|tid|lô|day|amt:X
    const keyTid = String(parts[1] ?? '').trim();
    const keyLo = String(m.ocrLo ?? parts[2] ?? '').trim();
    const keyDay = parts[3] ?? '';
    const amtM = /amt:(\d+)/.exec(m.ocrSendKey);
    const keyAmt = amtM ? Number(amtM[1]) : null;
    // cùng lô + tiền + NGÀY + (TID nếu đọc được) → ĐÃ GỬI. TID lệch = MÁY KHÁC = bill KHÁC → KHÔNG khớp.
    if (keyLo === loT && keyAmt === amt && keyDay === billDay && (!tidT || keyTid === tidT)) return String(r.id);
  }
  return null;
}

export async function augmentReviewWithImageHash(db: Db, review: ReviewItem[], imageBuffer: Buffer): Promise<void> {
  const hash = ocrImageHashOf(imageBuffer);
  for (const it of review) {
    if (!it.dealerRoomId || (it.alreadySent && it.sentMessageId)) continue;
    // TẦNG 1: hash ẢNH (ổn định nhất, bill gửi từ 0.6.35+). TẦNG 2: (lô+tiền) — bắt bill CŨ + TID đổi. Ưu tiên hash.
    let msgId = await findSentByImageHash(db, it.dealerRoomId, hash, it.bill.batchNumber ?? null);
    if (!msgId) msgId = await findSentByLoAmount(db, it.dealerRoomId, it.bill.batchNumber ?? null, it.bill.totalAmount, it.bill.dateTime ?? null, it.bill.tid ?? null);
    if (msgId) { it.alreadySent = true; it.sentMessageId = msgId; }
  }
}

/** [Admin Demo 11/9 — "sửa xong phải cập nhật ghi nhận mọi thông số mới, CẤM OCR lại ra thông số CŨ"] BẢN SỬA THEO ẢNH
 *  cho bill POS. Nguồn bản-sửa = CHÍNH metadata tin đã gửi (posBill) — editBillParams/update-sent/send-dup đều đồng bộ
 *  posBill nên đây là "log đã cập nhật" bền (DB, sống qua restart), key theo ocrImageHash (như transfer-correction).
 *  GỌI TRƯỚC reviewBills: đè tid/lô/tiền/ngày-giờ của bill OCR (cache trả số CŨ) bằng bản sửa gần nhất → routing/phí
 *  tính theo số ĐÚNG, và /send từ card này KHÔNG còn đè ngược bản sửa về số OCR cũ (revert câm — bug 11/9).
 *  KHÔNG âm thầm: trả warning "ℹ Đã áp bản sửa gần nhất (lúc HH:MM dd/mm) — OCR gốc: …" để người duyệt đối chiếu.
 *  Chỉ áp khi ảnh có ĐÚNG 1 bill (ảnh nhiều lô: 1 posBill không map an toàn từng lô → giữ OCR, đã có augment đánh
 *  dấu đã-gửi). Tin khớp hash nhưng KHÔNG phải bill POS (CK/QR cũng mang ocrImageHash) → bỏ qua (guard posBill.tid). */
export async function applyPosBillCorrectionByImage(db: Db, bills: OcrBill[], imageBuffer: Buffer): Promise<{ applied: boolean; warnings: string[] }> {
  const none = { applied: false, warnings: [] as string[] };
  if (bills.length !== 1) return none;
  const g = await findSentByImageHashGlobal(db, ocrImageHashOf(imageBuffer));
  if (!g) return none;
  const msg = await db.chatMessage.findUnique({ where: { id: g.messageId }, select: { metadataJson: true, editedAt: true, createdAt: true } });
  if (!msg?.metadataJson) return none;
  let meta: { posBill?: Record<string, unknown>; billEdited?: { at?: unknown }; ocrSendKey?: unknown } = {};
  try { meta = JSON.parse(msg.metadataJson); } catch { return none; }
  const pb = meta.posBill;
  const tidSent = pb && typeof pb.tid === 'string' && pb.tid.trim() ? pb.tid.trim() : null;
  // Guard: PHẢI là tin bill POS thật (posBill.tid có số + ocrSendKey) — QR refund/NĐT-cc có posBill nhưng tid=null.
  if (!pb || !tidSent || typeof meta.ocrSendKey !== 'string') return none;
  const bill = bills[0];
  const s = (v: unknown): string | null => { const t = (v == null ? '' : String(v)).trim(); return t || null; };
  const sent = { tid: tidSent, lo: s(pb.lo), amount: Number(pb.amount) || 0, dateTime: s(pb.dateTime) };
  const ocrGoc: string[] = []; // liệt kê TRƯỜNG LỆCH (giá trị OCR cũ) — log đối chiếu tường minh
  if ((bill.tid ?? '').trim() !== sent.tid) { ocrGoc.push(`TID ${(bill.tid ?? '—') || '—'}`); bill.tid = sent.tid; }
  if (s(bill.batchNumber) !== sent.lo) { ocrGoc.push(`lô ${s(bill.batchNumber) ?? '—'}`); bill.batchNumber = sent.lo; }
  if (sent.amount > 0 && bill.totalAmount !== sent.amount) { ocrGoc.push(`tiền ${fmtVnd(bill.totalAmount)}đ`); bill.totalAmount = sent.amount; }
  if (sent.dateTime && s(bill.dateTime) !== sent.dateTime) { ocrGoc.push(`ngày giờ ${s(bill.dateTime) ?? '—'}`); bill.dateTime = sent.dateTime; }
  if (ocrGoc.length === 0) return none; // OCR đọc trùng khớp bản sửa → không cần áp/ghi chú
  const editedAtRaw = typeof meta.billEdited?.at === 'string' ? new Date(meta.billEdited.at) : (msg.editedAt ?? msg.createdAt ?? null);
  const t = editedAtRaw && !Number.isNaN(new Date(editedAtRaw).getTime()) ? new Date(editedAtRaw) : null;
  const luc = t ? ` (lúc ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} ${String(t.getDate()).padStart(2, '0')}/${String(t.getMonth() + 1).padStart(2, '0')})` : '';
  return { applied: true, warnings: [`ℹ Đã áp BẢN SỬA gần nhất của bill này${luc} — OCR gốc: ${ocrGoc.join(' · ')}. Số trên card = bản sửa, KHÔNG phải số OCR.`] };
}

/** BỔ SUNG review CK: KHÔI PHỤC trạng thái ĐÃ SỬA + ĐÃ GỬI (Admin Demo 3/9 "cái nào đã sửa phải cập nhật đúng, ocr lại
 *  phải đúng"). classifyTransfer KHÔNG bao giờ tự đoán "ứng tiền" (luôn "hoàn") → CK đã gửi loại ỨNG, OCR lại ra HOÀN.
 *  Fix: khớp CK đã gửi theo ckTxnKey CÓ ẢNH (ổn định) → đọc lại `kind` (ADVANCE/REFUND) đã lưu ở tin cũ → set ĐÚNG
 *  direction + alreadySent + sentMessageId. Chạy ở ROUTE (nơi có ảnh). */
export async function augmentTransferReviewWithSentKind(db: Db, transfers: TransferReview[], imageBuffer: Buffer): Promise<void> {
  const imgHash = ocrImageHashOf(imageBuffer); // [#8/#10/#11] lưới hash ảnh — nhận "đã gửi" dù ref/nat/ngày OCR lệch.
  // [Admin Demo 4/9] KHÔI PHỤC BẢN SỬA PHÂN LOẠI TAY (theo ảnh) TRƯỚC — OCR luôn tính lại "hoàn tiền" (transfer-classify:124),
  // alias chỉ nhớ đối tác KHÔNG nhớ hướng → phải áp correction đè hướng/đối-tác đã sửa gần nhất. Chạy TRƯỚC dò-đã-gửi
  // để dùng đúng room/entity đã sửa. entityType khác → tính tay hoàn toàn, tin correction (last-wins theo ảnh).
  const corr = correctionsMap().get(imgHash);
  if (corr) for (const tr of transfers) {
    tr.direction = corr.direction; tr.entityType = corr.entityType; tr.entityId = corr.entityId;
    tr.matchedRoomId = corr.roomId; tr.matchedRoomName = corr.roomName; tr.needsManualPick = false;
    if (!tr.warnings.some((w) => w.includes('sửa tay trước'))) tr.warnings = ['✓ Đã khôi phục phân loại anh sửa tay trước đó (theo ảnh bill).', ...tr.warnings];
  }
  for (const tr of transfers) {
    const ckKey = buildCkTxnKey(tr, imageBuffer); // key ĐẦY ĐỦ (có tier hash ảnh) — khớp key lúc gửi
    // [Audit 3/9 #23] CK tạm-ứng/hoàn-thừa NĐT (không có matchedRoomId, đi theo entityId) → tra đã-gửi trong phòng NĐT.
    if (!tr.matchedRoomId) {
      if (tr.entityType === 'INVESTOR' && tr.entityId != null) {
        const invRoom = await resolveInvestorRoomById(db, tr.entityId);
        if (invRoom) { const mid = await findSentInvestorCk(db, invRoom, ckKey, imgHash); if (mid) { tr.alreadySent = true; tr.sentMessageId = mid; } }
      }
      continue;
    }
    const sent = await listDealerRefundCks(db, tr.matchedRoomId);
    const match = sent.find((e) => e.ckTxnKey === ckKey || (!!e.imageHash && e.imageHash === imgHash));
    if (!match) continue;
    tr.alreadySent = true;
    tr.sentMessageId = match.messageId;
    // [Kiểm chứng độc lập 11/9 — gỡ đối kháng chéo NGHI-TRÙNG × hash-match] reviewTransfers cắm cờ "NGHI TRÙNG …
    // (tin X) … mã GD/ảnh KHÁC" khi key trượt; nhưng nếu SAU ĐÓ hash ảnh khớp ĐÚNG tin X (cùng ảnh, chỉ OCR đọc
    // lệch ref) thì cờ đó SAI SỰ THẬT (ảnh KHÔNG khác) + thừa (card đã alreadySent/khóa gửi). Gỡ cờ trỏ vào CHÍNH
    // tin vừa khớp; cờ trỏ tin KHÁC (2 CK cùng tiền/ngày thật) GIỮ NGUYÊN.
    // Gỡ CẢ 3 loại cờ trùng (⚠ NGHI TRÙNG / ⛔ TRÙNG GIỜ:PHÚT / ℹ "2 GD KHÁC THẬT" — Admin Demo 11/9 + vá phản biện)
    // khi hash khớp CHÍNH tin đó: cùng ảnh = re-scan chứ không phải GD thứ 2, cờ nào cũng sai sự thật.
    tr.warnings = tr.warnings.filter((w) => !((w.includes('NGHI TRÙNG') || w.includes('TRÙNG GIỜ:PHÚT') || w.includes('2 GD KHÁC THẬT')) && w.includes(`(tin ${match.messageId}`)));
    // [Admin Demo 11/9 — CẤM OCR lại ra thông số CŨ] KHÔI PHỤC THAM SỐ đã sửa của CK đã gửi (editRefundBillParams /
    // nhánh dup postDealerRefundCk đều cập nhật metadata tin cũ = bản sửa gần nhất): tiền/ngày/giờ bản sửa ĐÈ số
    // OCR (cache trả số cũ) + log đối chiếu tường minh. KHÔNG đụng phân loại (đã xử lý ở corr/kind bên trên/dưới).
    const ocrGocCk: string[] = [];
    const tienSua = Math.abs(Number(match.refundAmount) || 0);
    if (tienSua > 0 && tr.amount !== tienSua) { ocrGocCk.push(`tiền ${fmtVnd(tr.amount)}đ`); tr.amount = tienSua; }
    const ngaySuaDisp = fmtDayDisplay(match.billDate); // ISO đã lưu → dd/mm/yyyy
    if (ngaySuaDisp && toIsoBillDay(tr.date) !== match.billDate) { ocrGocCk.push(`ngày ${tr.date ?? '—'}`); tr.date = ngaySuaDisp; }
    if (match.billTime && (tr.time ?? null) !== match.billTime) { ocrGocCk.push(`giờ ${tr.time ?? '—'}`); tr.time = match.billTime; }
    if (ocrGocCk.length > 0) {
      const tEd = match.createdAt instanceof Date && !Number.isNaN(match.createdAt.getTime()) ? match.createdAt : null;
      const lucCk = tEd ? ` (bill gửi ${String(tEd.getDate()).padStart(2, '0')}/${String(tEd.getMonth() + 1).padStart(2, '0')})` : '';
      tr.warnings = [`ℹ Đã áp BẢN SỬA gần nhất của bill CK này${lucCk} — OCR gốc: ${ocrGocCk.join(' · ')}. Số trên card = bản sửa, KHÔNG phải số OCR.`, ...tr.warnings];
    }
    // [Audit 3/9 #22] CHỈ khôi phục ADVANCE (ứng) — vì classifyTransfer KHÔNG BAO GIỜ tự đoán ứng (luôn hoàn) nên phải
    // nhớ lại. KHÔNG ép REFUND→SIGMA_TO_DEALER: kind='REFUND' gộp CẢ hoàn-tiền(dương) LẪN đại-lý-hoàn-thừa(âm,
    // DEALER_TO_ALPHA); ép cứng sang SIGMA_TO_DEALER làm "hoàn thừa" hiện SAI thành "hoàn tiền" (đảo chiều dấu tiền).
    // classifyTransfer đã xác định hoàn vs hoàn-thừa ĐÚNG theo người gửi/nhận (KHÔNG phụ thuộc OCR-số) → giữ nguyên.
    if (match.kind === 'ADVANCE') tr.direction = 'SIGMA_TO_DEALER_ADVANCE';
  }
}

// FIX #5b audit (30/8) — CHỐNG GỬI TRÙNG khi 2 nơi gửi ĐỒNG THỜI cùng 1 bill. `alreadySent` (đọc metadataJson)
// rồi mới gửi = đọc-xong-mới-ghi KHÔNG nguyên tử → 2 request song song cùng thấy "chưa gửi" → gửi 2 lần. Fix: bảng
// `ocr_bill_sent` + UNIQUE(dealer_room_id, ocr_send_key), gate bằng INSERT ... ON CONFLICT DO NOTHING (nguyên tử ở
// DB). Dùng RAW SQL (KHÔNG đụng schema.prisma/regenerate client → KHÔNG rủi ro phá server live). Bảng tạo IF NOT
// EXISTS (additive, idempotent, không đụng dữ liệu cũ).
let _ocrBillSentReady = false;
export async function ensureOcrBillSentTable(db: Db): Promise<void> {
  await db.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS ocr_bill_sent (' +
    'id bigserial PRIMARY KEY, dealer_room_id text NOT NULL, ocr_send_key text NOT NULL, ' +
    'sent_at timestamptz NOT NULL DEFAULT now(), ' +
    'CONSTRAINT ocr_bill_sent_uq UNIQUE (dealer_room_id, ocr_send_key))'
  );
  _ocrBillSentReady = true;
}
/** Đặt chỗ gửi (nguyên tử). true = đặt được → tiếp tục gửi; false = ĐÃ có (lần gửi song song thắng) → chặn trùng.
 *  [Dọn nợ 11/9 — RESERVATION MỒ CÔI] Đặt chỗ mà crash/lỗi giữa chừng (trước khi kịp releaseSend) → row treo VĨNH
 *  VIỄN, bill bị coi "đã gửi" mãi dù phòng KHÔNG có tin nào (đã bắt 19 row POS mồ côi trên prod). Self-heal ngay
 *  tại cổng: conflict + row CŨ >10' + phòng KHÔNG còn tin SỐNG mang key này → nhận là mồ côi, xoá + đặt lại 1 lần
 *  (log rõ, không im lặng). Tin sống còn đó → giữ nguyên luật chặn trùng. */
const STALE_RESERVATION_MS = 10 * 60 * 1000;
async function reserveSend(db: Db, dealerRoomId: string, key: string): Promise<boolean> {
  if (!_ocrBillSentReady) { try { await ensureOcrBillSentTable(db); } catch { /* lần đầu chưa có bảng — thử tạo */ } }
  const tryInsert = async (): Promise<boolean> => {
    const rows = await db.$queryRawUnsafe<{ id: bigint }[]>(
      'INSERT INTO ocr_bill_sent (dealer_room_id, ocr_send_key) VALUES ($1, $2) ' +
      'ON CONFLICT (dealer_room_id, ocr_send_key) DO NOTHING RETURNING id',
      dealerRoomId, key
    );
    return Array.isArray(rows) && rows.length > 0;
  };
  if (await tryInsert()) return true;
  // Conflict — kiểm mồ côi (best-effort; lỗi kiểm tra → coi như KHÔNG mồ côi, giữ fail-closed chặn trùng).
  try {
    // [B210 19/11 — Admin Demo "fix lỗi 7 tiếng"] Tuổi chỗ-giữ so bằng MỐC TRUYỀN TỪ CHƯƠNG TRÌNH, không so
    // với đồng hồ máy chủ nữa. Đo thật 19/11: `sent_at` ghi qua thư viện bị lưu SỚM 7 TIẾNG (thư viện gửi
    // giờ UTC không kèm múi giờ, máy chủ đặt Bangkok nên gán +07). Vì vậy phép so tuổi theo đồng hồ máy chủ
    // LUÔN cho kết quả "quá 10 phút" ⇒ mọi chỗ giữ chỗ đều bị coi là MỒ CÔI ⇒ chốt chống GỬI TRÙNG BILL mất
    // tác dụng (doanh số có thể đếm hai lần).
    // Cách chữa KHÔNG cắm cứng số 7: truyền mốc từ chương trình xuống — nó đi qua ĐÚNG đường ghi đó nên
    // cùng một hệ quy chiếu với `sent_at`, so sánh đúng. Khi nào sửa xong gốc múi giờ thì câu này VẪN đúng.
    const mocCu = new Date(Date.now() - 10 * 60 * 1000);
    const rsv = await db.$queryRawUnsafe<{ cu: boolean }[]>(
      `SELECT (sent_at < $3) AS cu FROM ocr_bill_sent WHERE dealer_room_id = $1 AND ocr_send_key = $2`, dealerRoomId, key, mocCu);
    if (rsv.length === 0) return await tryInsert(); // row vừa biến mất (phiên kia release) → thử lại
    if (rsv[0].cu !== true) return false; // còn tươi — nhường phiên song song
    const live = await db.chatMessage.findFirst({
      where: { roomId: dealerRoomId, deletedAt: null, metadataJson: { contains: JSON.stringify(key) } },
      select: { id: true }
    });
    if (live) return false; // tin sống còn mang key — reservation ĐÚNG, chặn trùng như cũ
    console.error(`[reserve-selfheal] reservation MỒ CÔI (>10' tuổi, phòng ${dealerRoomId} không còn tin sống mang key) → nhả + đặt lại: ${key.slice(0, 60)}`);
    // CÙNG hệ quy chiếu với câu kiểm ở trên — nếu để now() thì câu xoá rộng hơn câu kiểm (lệch 7 tiếng).
    await db.$executeRawUnsafe(`DELETE FROM ocr_bill_sent WHERE dealer_room_id = $1 AND ocr_send_key = $2 AND sent_at < $3`, dealerRoomId, key, mocCu);
    return await tryInsert();
  } catch (e) {
    console.error('[reserve-selfheal] kiểm mồ côi lỗi (giữ chặn trùng):', e instanceof Error ? e.message : e);
    return false;
  }
}
/** Nhả chỗ đã đặt (khi gửi LỖI) để lần sau còn thử lại được. */
async function releaseSend(db: Db, dealerRoomId: string, key: string): Promise<void> {
  await db.$executeRawUnsafe('DELETE FROM ocr_bill_sent WHERE dealer_room_id = $1 AND ocr_send_key = $2', dealerRoomId, key);
}

/** milli (×1000) → chuỗi % gọn: 1067 → "1.067%". */
function fmtPct(milli: number): string {
  return (milli / 1000).toFixed(3).replace(/\.?0+$/, '') + '%';
}
function fmtVnd(n: number): string {
  return Math.round(n).toLocaleString('en-US').replace(/,/g, '.');
}

/** Chuỗi 1 dòng phí. single-thẻ → "phí X% (=Yđ)". Tách thẻ → "phí Yđ (MB 100tr@1.067% + Napas 100tr@…)". */
function feeText(label: string, fee: FeeLine): string {
  if (!fee.resolved) return `${label}: ${fee.note}`;
  if (fee.breakdown && fee.breakdown.length) {
    const parts = fee.breakdown.map((b) => `${b.cardName ?? 'thẻ'} ${fmtVnd(b.amount)}@${fmtPct(b.milli)}`).join(' + ');
    return `${label} ${fmtVnd(fee.amount!)}đ (${parts})`;
  }
  return `${label} ${fmtPct(fee.milli!)} (=${fmtVnd(fee.amount!)}đ)`;
}

/** Gộp phí bán + cài theo TỪNG thẻ → dòng bảng cho tin gửi. Single-thẻ → 1 dòng (không tên thẻ). Tách → nhiều. */
interface TableRow { name: string | null; amount: number; refund: number | null; sellMilli: number | null; installMilli: number | null; }
function feeTableRows(bill: OcrBill, sell: FeeLine, install: FeeLine): TableRow[] {
  const sb = sell.breakdown ?? [];
  const ib = install.breakdown ?? [];
  if (sb.length || ib.length) {
    const base = ib.length ? ib : sb;
    return base.map((b) => {
      const s = sb.find((x) => x.cardTypeId === b.cardTypeId);
      const it = ib.find((x) => x.cardTypeId === b.cardTypeId);
      return { name: b.cardName ?? 'thẻ', amount: b.amount, refund: s ? b.amount - s.fee : null, sellMilli: s?.milli ?? null, installMilli: it?.milli ?? null };
    });
  }
  return [{ name: null, amount: bill.totalAmount, refund: sell.resolved && sell.amount != null ? bill.totalAmount - sell.amount : null, sellMilli: sell.resolved ? sell.milli ?? null : null, installMilli: install.resolved ? install.milli ?? null : null }];
}
// includeAgency: tin ĐẠI LÝ = true (kèm tên đại lý/HKD trên bill); tin NĐT = FALSE (bỏ tên đại lý — bảo mật,
// NĐT chỉ cần TID + tiền + phí cài, KHÔNG cần biết đại lý nào — Admin Demo 30/8 "NĐT bỏ cả thông tin đại lý").
function billHeaderLines(tid: string, bill: OcrBill, includeAgency: boolean): string[] {
  const l: string[] = [`📋 Bill TID ${tid}${includeAgency && bill.agencyName ? ` · ${bill.agencyName}` : ''}`];
  const sub: string[] = [];
  if (bill.batchNumber) sub.push(`lô ${bill.batchNumber}`);
  if (bill.dateTime) sub.push(bill.dateTime);
  if (sub.length) l.push(sub.join(' · '));
  if (bill.totalAmount > 0) l.push(`💵 Số tiền (trước phí): ${fmtVnd(bill.totalAmount)}đ`);
  return l;
}

/** Tin cho NHÓM ĐẠI LÝ — BẢNG đầy đủ: mỗi thẻ [trước phí · hoàn khách sau phí bán · phí bán% · phí cài%].
 *  KHÔNG kèm thông tin/tên NĐT (Admin Demo 30/8). */
export function buildDealerSummary(tid: string, bill: OcrBill, sell: FeeLine, install: FeeLine): string {
  const rows = feeTableRows(bill, sell, install);
  const lines = billHeaderLines(tid, bill, true);
  if (!sell.resolved) { lines.push(`⚠ phí bán: ${sell.note ?? 'chưa cấu hình'}`); return lines.join('\n'); }
  for (const r of rows) {
    const seg: string[] = [];
    seg.push(`trước phí ${fmtVnd(r.amount)}đ`);
    if (r.refund != null) seg.push(`hoàn khách ${fmtVnd(r.refund)}đ`);
    if (r.sellMilli != null) seg.push(`phí bán ${fmtPct(r.sellMilli)}`);
    if (r.installMilli != null) seg.push(`phí cài ${fmtPct(r.installMilli)}`);
    lines.push(`• ${r.name ? r.name + ': ' : ''}${seg.join(' · ')}`);
  }
  if (rows.length > 1 && sell.amount != null) lines.push(`➤ Tổng: trước phí ${fmtVnd(bill.totalAmount)}đ · hoàn khách ${fmtVnd(bill.totalAmount - sell.amount)}đ`);
  return lines.join('\n');
}

/** Tin cho NHÓM NĐT — CHỈ [trước phí · phí CÀI MÁY%] theo từng thẻ. TUYỆT ĐỐI KHÔNG phí bán, KHÔNG tiền hoàn
 *  (hoàn = trước phí − phí bán → lộ phí bán). */
export function buildInvestorSummary(tid: string, bill: OcrBill, install: FeeLine, hkdName?: string | null): string {
  // install-only: dùng feeTableRows với sell "rỗng" để KHÔNG có phí bán/hoàn lọt ra.
  const rows = feeTableRows(bill, { resolved: false }, install);
  const lines = billHeaderLines(tid, bill, false);
  // Tên HKD = tên máy POS NĐT đầu tư → NĐT ĐƯỢC xem (Admin Demo 31/8 "NĐT cũng phải có tên HKD như đại lý"). CHỈ
  // dùng hkdName THẬT từ DB (không mượn agencyName OCR) để KHÔNG lộ tên đại lý.
  if (hkdName && hkdName.trim()) lines.splice(1, 0, `🏪 HKD: ${hkdName.trim()}`);
  if (!install.resolved) { lines.push(`⚠ phí cài máy: ${install.note ?? 'chưa cấu hình'}`); return lines.join('\n'); }
  for (const r of rows) {
    const seg: string[] = [`trước phí ${fmtVnd(r.amount)}đ`];
    if (r.installMilli != null) seg.push(`phí cài máy ${fmtPct(r.installMilli)}`);
    lines.push(`• ${r.name ? r.name + ': ' : ''}${seg.join(' · ')}`);
  }
  return lines.join('\n');
}

/** 1 dòng review 1 bill (trả cho UI trước khi người bấm gửi). */
export interface ReviewItem {
  bill: OcrBill;
  dealerRoomId: string | null;
  dealerRoomName: string | null;
  investorRoomId: string | null;
  investorRoomName: string | null;
  sellFee: FeeLine | null; // phí bán (đại lý) — null nếu không có tid
  installFee: FeeLine | null; // phí cài (NĐT)
  alreadySent: boolean; // bill này đã từng gửi vào phòng đại lý
  sentMessageId?: string | null; // [Admin Demo 2/9] id tin đại lý ĐÃ GỬI → re-OCR sửa TẠI CHỖ (không gửi trùng). null nếu chưa gửi.
  tidSuggestions?: { tid: string; hkdName: string }[]; // [Admin Demo 2/9] gợi ý TID cùng HỌ HKD (1/2/3...) khi TID nghi ngờ.
  warnings: string[];
  dealerSummary: string | null; // preview đúng chuỗi sẽ gửi
  investorSummary: string | null;
  availableCardTypes: { id: number; name: string; bankId: number; isPrimary: boolean }[]; // >1 → UI cho tách thẻ
  hkdName: string | null; // tên HKD của TID (đối chiếu) — từ DB
  bankName: string | null; // ngân hàng của TID
  // [Admin Demo 8/9] MỞ BILL ĐÃ GHI để sửa: thẻ ĐANG GHI trên lô (và tách thẻ nếu có) — để card review hiện ĐÚNG thẻ
  // thực tế thay vì thẻ mặc định (nếu không, người sửa 1 thứ khác có thể vô tình đổi phí sang thẻ mặc định).
  currentCardTypeId?: number | null;
  currentSplits?: { cardTypeId: number; amount: number }[] | null;
}

/** Phí cho 1 (tid, tổng, thẻ|tách-thẻ) — client gọi khi người chọn thẻ/sửa tiền. sell=đại lý, install=NĐT. */
export async function computeFeesFor(db: Db, tidStr: string, amount: number, splits?: FeeSplitPart[]): Promise<{ sell: FeeLine; install: FeeLine; tidRow: BillRouting['tidRow'] }> {
  const routing = await resolveBillRouting(db, tidStr);
  const at = new Date();
  const sell = await computeSellFeeLine(db, routing.tidRow, amount, at, splits);
  const install = await computeInstallFeeLine(db, routing.tidRow, amount, at, splits);
  return { sell, install, tidRow: routing.tidRow };
}

/** Dựng review cho 1 danh sách bill (routing + phí + dedupe + preview). Dùng cho cả 2 chế độ. `at` = ngày tính
 *  phí (từ dateTime bill nếu có, else now truyền vào). */
/** GỬI bill CHUYỂN KHOẢN hoàn tiền → CHỈ nhóm đại lý khớp (transfer.matchedRoomId). TUYỆT ĐỐI KHÔNG gửi/cc NĐT
 *  (bảo mật — Admin Demo 31/8). Chưa khớp nhóm (matchedRoomId null) → CẤM gửi (chống gửi nhầm). */
export async function sendTransferToDealer(
  db: Db, input: { transfer: TransferReview; imageBuffer: Buffer; imageName: string; fileDate?: Date }
): Promise<{ ok: boolean; dealerMessageId?: string; error?: string; deduped?: boolean }> {
  const t = input.transfer;
  const caption = `💸 HOÀN TIỀN ĐẠI LÝ · ${fmtVnd(t.amount)}đ${t.date ? ` · ${t.date}` : ''}`
    + `${t.receiverName ? `\n👤 Người nhận: ${t.receiverName}` : ''}`
    + `${t.content ? `\n📝 Nội dung: ${t.content}` : ''}`
    + `${t.senderName ? `\n🏦 Người gửi: ${t.senderName}` : ''}`;
  // HƯỚNG-1: hoàn tiền đại lý → ghi ĐÃ HOÀN DƯƠNG (+) → buildDealerRefundReconcile CỘNG vào đã-hoàn.
  return postDealerRefundCk(db, { transfer: t, imageBuffer: input.imageBuffer, imageName: input.imageName, fileDate: input.fileDate, signedAmount: Math.abs(t.amount), caption });
}

/** LÕI GHI/GỬI 1 CK-hoàn vào NHÓM ĐẠI LÝ (dùng cho hướng-1 DƯƠNG + hướng-2 ÂM). signedAmount = số ghi metadata
 *  refundAmount (DƯƠNG hoàn tiền / ÂM hoàn-thừa-về-SigMa → buildDealerRefundReconcile TRỪ). CHỈ nhóm đại lý
 *  (matchedRoomId) — TUYỆT ĐỐI KHÔNG NĐT (bảo mật). Idempotent theo ckTxnKey (chống đếm đôi). */
/** [Admin Demo 26/9] Export để test khoá được luật "CK hoàn CHỈ vào nhóm đã gán khách" (nhóm doanh số thật). */
export async function postDealerRefundCk(
  db: Db, input: { transfer: TransferReview; imageBuffer: Buffer; imageName: string; fileDate?: Date; signedAmount: number; caption: string; kind?: 'REFUND' | 'ADVANCE' }
): Promise<{ ok: boolean; dealerMessageId?: string; error?: string; deduped?: boolean; dateUpdated?: boolean; amountUpdated?: boolean; kindUpdated?: boolean }> {
  const t = input.transfer;
  if (!t.matchedRoomId) return { ok: false, error: 'NO_ROOM_MATCH' }; // chưa khớp nhóm → cấm gửi (chọn tay)
  // [Admin Demo 26/9 "bill chuyển khoản sửa phân loại xong vẫn không ghi nhận doanh số"] FAIL-CLOSED PHÒNG ĐÍCH.
  // GỐC SỰ CỐ: dropdown chọn đại lý liệt kê MỌI nhóm chat (kể cả nhóm "QR - ..." CHƯA GÁN KHÁCH). Gửi CK hoàn vào
  // nhóm đó thì đối soát hoàn (listDealerRefundCks đọc CK THEO PHÒNG) KHÔNG BAO GIỜ thấy ⇒ tiền hoàn biến mất khỏi
  // sổ, mà không báo gì. Sửa phân loại lại cũng vô ích vì alias chỉ dạy cho LẦN SAU, không dời bill đã gửi.
  // Đo 26/9: 7 bill CK nằm ở nhóm không-gán-khách, 572.286.000đ. NAY: chặn ngay lúc gửi + nói rõ phải làm gì.
  {
    const coKhach = await db.customerChatGroup.count({ where: { roomId: t.matchedRoomId, unassignedAt: null } });
    if (coKhach === 0) {
      const p = await db.chatRoom.findUnique({ where: { id: t.matchedRoomId }, select: { name: true } });
      console.error(`[ocr-send] CHẶN gửi CK hoàn vào phòng "${p?.name ?? t.matchedRoomId}" — phòng này CHƯA GÁN KHÁCH nên không phải phòng doanh số.`);
      return { ok: false, error: 'ROOM_NO_CUSTOMER' };
    }
  }
  const bot = await ensureAlphaBotAgent(db);
  await ensureBotMember(db, t.matchedRoomId, bot.id);
  // GHI "ĐÃ HOÀN": lưu metadata để buildDealerRefundReconcile đối soát cần/đã hoàn theo NGÀY. billDate = NGÀY
  // TRÊN BILL CK (không phải giờ gửi). ckTxnKey bậc thang (Admin Demo 31/8 DUYỆT) — dedup 1 CK ghi 1 lần.
  const ckTxnKey = buildCkTxnKey(t, input.imageBuffer);
  // [Audit 3/9 #8/#10/#11] LƯỚI HASH ẢNH cho CK (như POS): ckTxnKey ưu tiên ref/nat (chứa số/ngày OCR đọc) → OCR lệch
  // (0↔6) hoặc SỬA NGÀY (nat-tier gồm ngày) đổi key → dedup trượt → x2 hoàn/tạm-ứng. Hash ảnh ổn định → dedup CẢ theo hash.
  const ckImgHash = ocrImageHashOf(input.imageBuffer);
  // [Agent-2 11/9 — CHẶN ẢNH LẠC LUỒNG] Ảnh đã gửi ở luồng POS/QR → CẤM ghi thành CK hoàn/ứng (hoàn MA từ chính
  // bill đã tính doanh số). Fail-closed TRƯỚC mọi ghi. Ảnh đã đi luồng CK thì rơi xuống dedup CK bên dưới như cũ.
  const lacLuong = await findImageSentOtherFlowForCk(db, ckImgHash);
  if (lacLuong) {
    console.error(`[ck-guard] CHẶN ghi CK từ ảnh đã gửi luồng ${lacLuong.flow} (msg ${lacLuong.messageId}, hash ${ckImgHash.slice(0, 12)}…) — chống hoàn/ứng ma.`);
    return { ok: false, error: `IMAGE_SENT_OTHER_FLOW:${lacLuong.flow}` };
  }
  // Ngày CK = ngày BIÊN LAI OCR (parseTransferDay) ELSE ngày TẢI FILE (mtime — Admin Demo: OCR không đọc được ngày
  // biên lai thì lấy ngày tải, KHÔNG lấy ngày bong bóng thông báo). Dùng cho settlement day-level.
  const billDate = parseTransferDay(t.date) ?? (input.fileDate ? fmtDayHcm(input.fileDate) : null);
  // Idempotent theo ckTxnKey: nhóm đã có CK-hoàn cùng khóa GD → KHÔNG ghi lần 2 (chống đếm đôi doanh số hoàn).
  const existing = await listDealerRefundCks(db, t.matchedRoomId);
  const dup = existing.find((e) => e.ckTxnKey === ckTxnKey || (!!e.imageHash && e.imageHash === ckImgHash)); // [#8/#10/#11] khớp key HOẶC hash ảnh
  if (dup) {
    // GÁN LẠI NGÀY THẮNG (Admin Demo 1/9 "đã OCR lại + gán lại ngày thì phải ghi nhận lần gán SAU CÙNG chứ?"): bill đã
    // gửi (dedup) + ngày MỚI KHÁC ngày cũ → CẬP NHẬT billDate/billDateTimeRaw của tin cũ (KHÔNG đăng tin trùng) →
    // reconcile theo ĐÚNG ngày mới. GỐC lỗi Bình: 9 CK của 30/8 gửi mù-ngày → billDate 01/09 SAI; sửa lại rồi gửi
    // lại thì trước đây dedup nuốt → ngày sai GIỮ NGUYÊN. Nay lần gán sau cùng thắng.
    // [Admin Demo 11/9 — mở màn REVIEW để sửa bill CK đã gửi] Nhánh trùng TRƯỚC ĐÂY chỉ cập nhật NGÀY: sửa SỐ TIỀN
    // hoặc đổi HƯỚNG (hoàn ↔ ứng ↔ đại lý trả về) rồi bấm Gửi thì bị nuốt im, UI vẫn báo thành công ⇒ đối soát giữ
    // số CŨ (đợt phản biện 10/9 chỉ ra: lệch tới 2× giá trị bill khi đảo dấu). NAY: cập nhật ĐỦ ngày + tiền + loại
    // + caption trên CHÍNH tin cũ, và báo rõ đã cập nhật cái gì (R198 — không im lặng).
    const rowDup = await db.chatMessage.findUnique({ where: { id: dup.messageId }, select: { metadataJson: true, body: true } });
    let doiNgay = false, doiTien = false, doiLoai = false;
    if (rowDup?.metadataJson) {
      try {
        const m = JSON.parse(rowDup.metadataJson) as Record<string, unknown>;
        const tienCu = Number(m['refundAmount'] ?? 0);
        const tienMoi = Number(input.signedAmount);
        const laUngCu = m['isDealerAdvanceCk'] === true;
        const laUngMoi = input.kind === 'ADVANCE';
        doiNgay = !!billDate && m['billDate'] !== billDate;
        doiTien = Number.isFinite(tienMoi) && tienMoi !== 0 && tienMoi !== tienCu;
        doiLoai = laUngCu !== laUngMoi;
        if (doiNgay || doiTien || doiLoai) {
          if (billDate) { m['billDate'] = billDate; m['billDateTimeRaw'] = t.date ?? (m['billDateTimeRaw'] ?? null); }
          if (doiTien) m['refundAmount'] = tienMoi;
          if (doiLoai) { m['isDealerAdvanceCk'] = laUngMoi; m['direction'] = laUngMoi ? 'SIGMA_TO_DEALER_ADVANCE' : (tienMoi < 0 ? 'DEALER_TO_ALPHA' : 'SIGMA_TO_DEALER'); }
          await db.chatMessage.update({
            where: { id: dup.messageId },
            data: { metadataJson: JSON.stringify(m), ...(doiTien || doiLoai ? { body: input.caption } : {}) }
          });
          // Dấu vết sửa tiền (R9 bằng chứng): ghi audit best-effort, hỏng KHÔNG chặn việc sửa.
          await db.$executeRawUnsafe(
            `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, created_at) VALUES (NULL, 'SIGMA_CK_BILL_EDITED', 'ChatMessage', $1, now())`,
            dup.messageId
          ).catch(() => {});
          console.error(`[ck-edit] sửa bill CK ${dup.messageId}: ${doiNgay ? `ngày→${billDate} ` : ''}${doiTien ? `tiền ${tienCu}→${tienMoi} ` : ''}${doiLoai ? `loại→${laUngMoi ? 'ỨNG' : 'HOÀN'}` : ''}`.trim());
        }
      } catch { /* meta hỏng → giữ nguyên, KHÔNG chặn (best-effort) */ }
    }
    return { ok: true, dealerMessageId: dup.messageId, deduped: true, dateUpdated: doiNgay, amountUpdated: doiTien, kindUpdated: doiLoai };
  }
  // [Dọn nợ 11/9 — audit #cross-room] CÙNG CK (key/hash) ĐÃ gửi ở PHÒNG KHÁC → CHẶN (fail-closed): aggregate dedup
  // ckTxnKey toàn cục sẽ chỉ tính 1 phòng, phòng kia mất hoàn CÂM (đã xảy ra dạng này với 3 CK DakLak 169.392tr).
  // Người dùng phải xoá/sửa tin ở phòng cũ trước, không cho hệ tự "chuyển phòng" một GD tiền.
  const gCk = await findDealerCkGlobal(db, ckTxnKey, ckImgHash);
  if (gCk && gCk.roomId !== t.matchedRoomId) {
    console.error(`[ck-guard] CHẶN gửi CK ${ckTxnKey.slice(0, 40)}… vào phòng ${t.matchedRoomId}: đã gửi ở phòng ${gCk.roomId} (msg ${gCk.messageId}) — 1 CK không được nằm 2 phòng.`);
    return { ok: false, error: `CK_SENT_OTHER_ROOM:${gCk.roomId}` };
  }
  // [Admin Demo 11/9 — CHẶN CỨNG] 2 GD CK cùng GIỜ:PHÚT + cùng SỐ TIỀN + cùng NGÀY trong cùng phòng (khoá + ảnh
  // KHÁC) = nghi CÙNG 1 giao dịch chụp 2 ảnh → CẤM gửi. Đường thoát DUY NHẤT: sửa GIỜ trên bill (2 GD khác thật
  // thì giờ phải khác) — user đổi giờ rồi gửi lại là qua. Cả hai cùng THIẾU giờ cũng chặn (ép nhập giờ —
  // null === null). 1 bên có giờ 1 bên không → không chắc → chỉ cờ đỏ ở review, không chặn oan.
  if (billDate != null) {
    const gioMoi = extractBillTime([t.date, t.time].filter(Boolean).join(' ') || null);
    const trungGioTien = existing.find((e) =>
      e.billDate === billDate &&
      Math.abs(e.refundAmount) === Math.abs(input.signedAmount) &&
      e.ckTxnKey !== ckTxnKey && (!e.imageHash || e.imageHash !== ckImgHash) &&
      e.billTime === gioMoi &&
      // [Admin Demo 11/9 chính sách + vá phản biện] cả 2 đều có MÃ GD THẬT (≥4 ký tự chữ-số) mà mã KHÁC NHAU THẬT
      // (so sau khi bỏ ký tự rác — "FT-2609" với "FT2609" là CÙNG mã) = 2 GD KHÁC THẬT → không chặn. Mã rác/ngắn
      // ("1"/"OK") hoặc chỉ khác dấu "-"/space → KHÔNG đủ tư cách miễn → vẫn chặn cứng như thiếu mã.
      !ckBothRefDistinct(ckTxnKey, e.ckTxnKey)
    );
    if (trungGioTien) {
      // [Admin Demo 16/9 "bank khác nhau thì phải là GD khác nhau"] MIỄN chặn khi CẢ 2 bill đều là màn BÊN GỬI của
      // 2 bank KHÁC nhau (ca thật 15/9: MBV ↔ MB, 2 GD 100tr cùng 08:40). Ảnh BÁO CÓ bên nhận (app == bank nhận)
      // hoặc thiếu bank → KHÔNG miễn, chặn như cũ (fail-closed — đây là khoá chống hoàn x2).
      const bankKhac = ckBothAppBankDistinct(
        { appBank: t.appBank ?? null, receiverBank: t.bank ?? null },
        { appBank: trungGioTien.appBank, receiverBank: trungGioTien.bank });
      if (bankKhac) {
        console.error(`[ck-guard] MIỄN chặn trùng giờ+tiền (tin cũ ${trungGioTien.messageId}): 2 bill là màn bên gửi của 2 bank KHÁC (${trungGioTien.appBank ?? '?'} ↔ ${t.appBank ?? '?'}) — 2 GD khác thật (chính sách Admin Demo 16/9).`);
      } else {
        console.error(`[ck-guard] CHẶN CỨNG CK cùng GIỜ:PHÚT + TIỀN: phòng ${t.matchedRoomId} đã có tin ${trungGioTien.messageId} (${trungGioTien.billTime ?? 'không giờ'} · ${fmtVnd(Math.abs(input.signedAmount))}đ · ${billDate}) mà khoá/ảnh KHÁC — yêu cầu sửa giờ nếu là GD khác thật.`);
        return { ok: false, error: `CK_TRUNG_GIO_TIEN:${trungGioTien.messageId}` };
      }
    }
  }
  // ATOMIC guard đa-user (Admin Demo 1/9 "2-3 user Zalo khác cùng gửi thì ngăn kiểu gì"): reserveSend(room, ckTxnKey) —
  // INSERT ON CONFLICT nguyên tử → 2 phiên cùng đăng 1 CK chỉ 1 thắng (đọc-rồi-ghi ở trên KHÔNG nguyên tử).
  const reserved = await reserveSend(db, t.matchedRoomId, ckTxnKey).catch((e) => { console.error('[reserveSend] LỖI DB (fail-open — dedup tầng tin vẫn chặn):', e instanceof Error ? e.message : e); return true; });
  if (!reserved) return { ok: true, deduped: true }; // phiên khác vừa đăng CK này — không đăng trùng
  const att = await saveAttachment(db, input.imageBuffer, input.imageName, bot.id);
  if (!att.ok) { await releaseSend(db, t.matchedRoomId, ckTxnKey).catch(() => {}); return { ok: false, error: `ATT_FAIL:${att.reason}` }; }
  // ĐẠI LÝ ỨNG TRƯỚC (Admin Demo 1/9): SigMa đưa đại lý tiền TRƯỚC → CÙNG pool waterfall (giảm cần-hoàn) như hoàn,
  // NHƯNG lưu cờ RIÊNG isDealerAdvanceCk để report tách "đã ứng" vs "đã hoàn". refundAmount DƯƠNG (SigMa đã trả).
  const isAdvance = input.kind === 'ADVANCE';
  // billDateTimeRaw = chuỗi ngày-giờ OCR THÔ (có thể kèm giờ "01/09/2026 14:22") — lưu để list bill hoàn sắp theo giờ
  // (Admin Demo 1/9). billDate vẫn là ngày-only cho reconcile. Bill CŨ không có field này → coi như "không giờ" (xếp đầu).
  // bank: NGÂN HÀNG chuyển (Admin Demo 1/9 "list CK thiếu tên người chuyển/nhận/ngân hàng") — lưu để list hiện đủ. Bill
  // CŨ không có field này → null (backward-additive, list hiện '—').
  // senderAcct (Admin Demo 2/9): lưu STK người gửi để report tra "NH gửi" qua sender-bank-alias (ưu tiên STK). Bill CŨ
  // không có field này → null (backward-additive). CHỈ là nhãn — KHÔNG đụng ckTxnKey/dedup/tiền.
  const meta = { isTransferRefund: true, isDealerRefundCk: !isAdvance, isDealerAdvanceCk: isAdvance, refundAmount: input.signedAmount, ckTxnKey, ocrImageHash: ckImgHash, billDate, billDateTimeRaw: [t.date, t.time].filter(Boolean).join(' ') || null, receiverAcct: t.receiverAccount, senderAcct: t.senderAccount ?? null, senderName: t.senderName, receiverName: t.receiverName, bank: t.bank ?? null, appBank: t.appBank ?? null };
  const msg = await sendMessage(db, { roomId: t.matchedRoomId, senderId: bot.id, kind: 'IMAGE', body: input.caption, attachmentId: att.id, metadataJson: JSON.stringify(meta) });
  broadcastToRoom(t.matchedRoomId, { msg: 'new-message', roomId: t.matchedRoomId, message: msg });
  return { ok: true, dealerMessageId: String(msg.id) };
}

/** investorId → phòng NĐT (investor_chat_groups đang-gán có phòng). >1 → cảnh báo, chọn gần nhất. null nếu chưa
 *  gán nhóm. DÙNG CHO gửi bill CK hướng NĐT — KHÔNG bao giờ dùng nhóm đại lý (bảo mật 2 chiều). */
async function resolveInvestorRoomById(db: Db, investorId: number): Promise<string | null> {
  const groups = await db.investorChatGroup.findMany({
    where: { investorId, unassignedAt: null, roomId: { not: null } },
    select: { roomId: true, assignedFrom: true },
    orderBy: { assignedFrom: 'desc' }
  });
  if (groups.length === 0) return null;
  if (groups.length > 1) console.error(`[ocr-send] investorId=${investorId} có ${groups.length} nhóm NĐT đang-gán có phòng (kỳ vọng 1) — chọn gần nhất.`);
  return groups[0].roomId ?? null;
}

/** GỬI 1 bill CK vào NHÓM NĐT (hướng-3 tạm ứng / hướng-4 hoàn thừa). CHỈ investor room (đã resolve từ investorId)
 *  — TUYỆT ĐỐI KHÔNG nhóm đại lý. Idempotent theo ckTxnKey trong CHÍNH phòng NĐT (chống đăng ảnh 2 lần). Bill CK
 *  có ẢNH đính kèm (Admin Demo). */
async function postInvestorTransferCk(
  db: Db, input: { roomId: string; imageBuffer: Buffer; imageName: string; caption: string; ckTxnKey: string; meta: Record<string, unknown> }
): Promise<{ ok: boolean; messageId?: string; error?: string; deduped?: boolean }> {
  const bot = await ensureAlphaBotAgent(db);
  await ensureBotMember(db, input.roomId, bot.id);
  const marker = `"ckTxnKey":${JSON.stringify(input.ckTxnKey)}`;
  const existing = await db.chatMessage.findFirst({ where: { roomId: input.roomId, metadataJson: { contains: marker }, deletedAt: null }, select: { id: true } });
  if (existing) return { ok: true, messageId: String(existing.id), deduped: true };
  // ATOMIC guard đa-user (đồng nhất đại lý): reserveSend(room, ckTxnKey) nguyên tử → 2 phiên cùng cc NĐT chỉ 1 thắng.
  const reserved = await reserveSend(db, input.roomId, input.ckTxnKey).catch(() => true);
  if (!reserved) return { ok: true, deduped: true };
  const att = await saveAttachment(db, input.imageBuffer, input.imageName, bot.id);
  if (!att.ok) { await releaseSend(db, input.roomId, input.ckTxnKey).catch(() => {}); return { ok: false, error: `ATT_FAIL:${att.reason}` }; }
  const msg = await sendMessage(db, { roomId: input.roomId, senderId: bot.id, kind: 'IMAGE', body: input.caption, attachmentId: att.id, metadataJson: JSON.stringify(input.meta) });
  broadcastToRoom(input.roomId, { msg: 'new-message', roomId: input.roomId, message: msg });
  return { ok: true, messageId: String(msg.id) };
}

/** Kết quả gửi bill CK theo hướng (4 hướng). target = nhóm đích (DEALER/INVESTOR) để UI/route hiển thị + grep
 *  chống-lộ-chéo. recorded = đã ghi kế toán (hoàn đại lý / tạm ứng / hoàn thừa). */
export interface SendTransferResult {
  ok: boolean;
  direction: TransferDirection;
  target: 'DEALER' | 'INVESTOR' | null;
  roomId?: string;
  messageId?: string;
  recorded?: boolean;
  deduped?: boolean;
  error?: string;
  message?: string;
}

/** PHÂN NHÁNH GỬI + GHI theo `review.direction` (4 hướng, Admin Demo 31/8). Bảo mật 2 chiều: DEALER → CHỈ nhóm đại lý
 *  (matchedRoomId); INVESTOR → CHỈ nhóm NĐT (investor_chat_groups theo entityId). Chưa khớp entity/room → CHẶN gửi.
 *  - SIGMA_TO_DEALER : hoàn tiền đại lý (+) → nhóm đại lý, refundAmount DƯƠNG.
 *  - DEALER_TO_ALPHA : đại lý hoàn thừa (−) → nhóm đại lý, refundAmount ÂM (reconcile TRỪ).
 *  - INVESTOR_TO_ALPHA: tạm ứng NĐT → nhóm NĐT, ghi recordInvestorAdvanceFromTransfer.
 *  - SIGMA_TO_INVESTOR: hoàn thừa tạm ứng → nhóm NĐT, ghi recordInvestorRepayment (source='REPAYMENT'). */
export async function sendTransferByDirection(
  db: Db, review: TransferReview, imageBuffer: Buffer, imageName: string, fileDate: Date
): Promise<SendTransferResult> {
  const dir = review.direction;
  const ckTxnKey = buildCkTxnKey(review, imageBuffer);
  const refM = /^ck\|ref\|(.+)$/.exec(ckTxnKey);
  const ref = refM ? refM[1] : null;
  // [Phản biện 11/9 — CAO-5] TRƯỚC rút hash từ CHUỖI KHOÁ (chỉ có khi khoá hash-tier) → khoá ref-tier thì
  // imageHash=null → 82/127 dòng investor_advances mất lưới hash → OCR đọc lệch ref 1 ký tự là ghi ứng 2 LẦN.
  // NAY: hash ảnh THẬT luôn có (độc lập với tầng khoá) — đồng nhất nhánh đại lý.
  const imageHash = ocrImageHashOf(imageBuffer);

  switch (dir) {
    case 'SIGMA_TO_DEALER': {
      const r = await sendTransferToDealer(db, { transfer: review, imageBuffer, imageName, fileDate });
      return { ok: r.ok, direction: dir, target: 'DEALER', roomId: review.matchedRoomId ?? undefined, messageId: r.dealerMessageId, recorded: r.ok, deduped: r.deduped, error: r.error, message: r.ok ? undefined : dealerErrMsg(r.error) };
    }
    case 'DEALER_TO_ALPHA': {
      if (!review.matchedRoomId) return { ok: false, direction: dir, target: 'DEALER', error: 'NO_ROOM_MATCH', message: 'Chưa khớp nhóm đại lý — chọn nhóm để gửi.' };
      const caption = `↩️ ĐẠI LÝ HOÀN THỪA VỀ SIGMA · ${fmtVnd(Math.abs(review.amount))}đ${review.date ? ` · ${review.date}` : ''}`
        + `${review.senderName ? `\n👤 Người gửi (đại lý): ${review.senderName}` : ''}`
        + `${review.content ? `\n📝 Nội dung: ${review.content}` : ''}`;
      const r = await postDealerRefundCk(db, { transfer: review, imageBuffer, imageName, fileDate, signedAmount: -Math.abs(review.amount), caption });
      return { ok: r.ok, direction: dir, target: 'DEALER', roomId: review.matchedRoomId, messageId: r.dealerMessageId, recorded: r.ok, deduped: r.deduped, error: r.error, message: r.ok ? undefined : dealerErrMsg(r.error) };
    }
    case 'SIGMA_TO_DEALER_ADVANCE': {
      // ĐẠI LÝ ỨNG TRƯỚC (Admin Demo 1/9): SigMa đưa đại lý tiền TRƯỚC → nhóm đại lý, ghi kind=ADVANCE (refundAmount
      // DƯƠNG, CÙNG pool waterfall giảm cần-hoàn, lưu cờ isDealerAdvanceCk để report tách). Chọn tay bắt buộc.
      if (!review.matchedRoomId) return { ok: false, direction: dir, target: 'DEALER', error: 'NO_ROOM_MATCH', message: 'Chưa khớp nhóm đại lý — chọn nhóm để gửi.' };
      const caption = `💵 ĐẠI LÝ ỨNG TRƯỚC (SigMa → đại lý) · ${fmtVnd(Math.abs(review.amount))}đ${review.date ? ` · ${review.date}` : ''}`
        + `${review.receiverName ? `\n👤 Đại lý nhận: ${review.receiverName}` : ''}`
        + `${review.content ? `\n📝 Nội dung: ${review.content}` : ''}`;
      const r = await postDealerRefundCk(db, { transfer: review, imageBuffer, imageName, fileDate, signedAmount: Math.abs(review.amount), caption, kind: 'ADVANCE' });
      return { ok: r.ok, direction: dir, target: 'DEALER', roomId: review.matchedRoomId, messageId: r.dealerMessageId, recorded: r.ok, deduped: r.deduped, error: r.error, message: r.ok ? undefined : dealerErrMsg(r.error) };
    }
    case 'INVESTOR_TO_ALPHA': {
      if (review.entityId == null) return { ok: false, direction: dir, target: 'INVESTOR', error: 'NO_INVESTOR', message: 'Chưa khớp NĐT — chọn NĐT để gửi.' };
      const roomId = await resolveInvestorRoomById(db, review.entityId);
      if (!roomId) return { ok: false, direction: dir, target: 'INVESTOR', error: 'NO_INVESTOR_ROOM', message: 'NĐT chưa gán nhóm chat — không gửi được (cấm gửi nhầm).' };
      // [Agent-2 11/9 — CHẶN ẢNH LẠC LUỒNG] Ảnh đã gửi luồng POS/QR → CẤM ghi tạm ứng NĐT từ ảnh đó (ứng MA).
      {
        const lac = await findImageSentOtherFlowForCk(db, imageHash);
        if (lac) return { ok: false, direction: dir, target: 'INVESTOR', roomId, error: `IMAGE_SENT_OTHER_FLOW:${lac.flow}`, message: imageOtherFlowMsg(lac.flow) };
      }
      // GHI TẠM ỨNG TRƯỚC (dedup ref/hash CHUNG với ingestion phòng chat) → rồi gửi ảnh vào NHÓM NĐT.
      const rec = await recordInvestorAdvanceFromTransfer(db, review, ckTxnKey, fileDate, imageHash); // [11/9] hash ảnh THẬT — lưới image_hash sống cả khi khoá ref-tier
      if (!rec.ok) return { ok: false, direction: dir, target: 'INVESTOR', roomId, error: rec.error, message: rec.message };
      const recDeduped = 'deduped' in rec ? rec.deduped === true : false;
      const caption = `💰 TẠM ỨNG NĐT · ${fmtVnd(review.amount)}đ${review.date ? ` · ${review.date}` : ''}`;
      const meta = { isTransferRefund: true, isInvestorAdvanceCk: true, direction: dir, advanceAmount: review.amount, ckTxnKey, ocrImageHash: ocrImageHashOf(imageBuffer), investorId: review.entityId, senderName: review.senderName, receiverName: review.receiverName }; // [#23] hash net
      const sent = await postInvestorTransferCk(db, { roomId, imageBuffer, imageName, caption, ckTxnKey, meta });
      if (!sent.ok) return { ok: false, direction: dir, target: 'INVESTOR', roomId, recorded: true, deduped: recDeduped || undefined, error: sent.error, message: `Đã ghi tạm ứng nhưng gửi nhóm NĐT lỗi (${sent.error}).` };
      return { ok: true, direction: dir, target: 'INVESTOR', roomId, messageId: sent.messageId, recorded: true, deduped: (recDeduped || sent.deduped) || undefined };
    }
    case 'SIGMA_TO_INVESTOR': {
      if (review.entityId == null) return { ok: false, direction: dir, target: 'INVESTOR', error: 'NO_INVESTOR', message: 'Chưa khớp NĐT — chọn NĐT để gửi.' };
      const roomId = await resolveInvestorRoomById(db, review.entityId);
      if (!roomId) return { ok: false, direction: dir, target: 'INVESTOR', error: 'NO_INVESTOR_ROOM', message: 'NĐT chưa gán nhóm chat — không gửi được (cấm gửi nhầm).' };
      // [Agent-2 11/9 — CHẶN ẢNH LẠC LUỒNG] Ảnh đã gửi luồng POS/QR → CẤM ghi hoàn thừa từ ảnh đó (hoàn MA).
      {
        const lac = await findImageSentOtherFlowForCk(db, imageHash);
        if (lac) return { ok: false, direction: dir, target: 'INVESTOR', roomId, error: `IMAGE_SENT_OTHER_FLOW:${lac.flow}`, message: imageOtherFlowMsg(lac.flow) };
      }
      // GHI HOÀN THỪA TẠM ỨNG TRƯỚC (recordInvestorRepayment — source='REPAYMENT', dedup ref/hash CHUNG) → gửi NHÓM NĐT.
      const advanceDateIso = vnDateToIso(review.date, fileDate.toISOString().slice(0, 10));
      const rec = await recordInvestorRepayment(db, {
        investorId: review.entityId, amount: review.amount, advanceDateIso, ref, imageHash,
        senderName: review.senderName, receiverName: review.receiverName, receiverAccountNumber: review.receiverAccount
      });
      if (rec.action === 'skip_invalid') return { ok: false, direction: dir, target: 'INVESTOR', roomId, error: 'REPAY_INVALID', message: `Không ghi được hoàn thừa tạm ứng (${rec.reason}).` };
      const recDeduped = rec.action === 'duplicate';
      // [A-H3 21/9] Cùng lớp fail-loud như tạm ứng: sửa tiền/ngày rồi gửi lại → dedup giữ số CŨ câm. Lệch → chặn.
      if (rec.action === 'duplicate') {
        const cu = (await db.$queryRawUnsafe<{ amount: number; ngay: string }[]>(
          `SELECT amount::float8 AS amount, to_char(advance_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS ngay
             FROM investor_advances WHERE id = $1`, rec.id))[0];
        const ngayMoi2 = advanceDateIso?.slice(0, 10) ?? null;
        if (cu && (Math.round(cu.amount) !== Math.round(review.amount) || (!!ngayMoi2 && cu.ngay !== ngayMoi2))) {
          return { ok: false, direction: dir, target: 'INVESTOR', roomId, error: 'CK_DA_GHI_THAM_SO_LECH', message: `Bill này ĐÃ GHI hoàn thừa trước đó (${Math.round(cu.amount).toLocaleString('vi-VN')}đ · ${cu.ngay}), khác thông số đang gửi (${Math.round(review.amount).toLocaleString('vi-VN')}đ${ngayMoi2 ? ` · ${ngayMoi2}` : ''}). Hệ KHÔNG tự ghi đè — sửa trên bảng Tạm ứng NĐT.` };
        }
      }
      const caption = `↩️ HOÀN THỪA TẠM ỨNG (SigMa → NĐT) · ${fmtVnd(review.amount)}đ${review.date ? ` · ${review.date}` : ''}`;
      const meta = { isTransferRefund: true, isInvestorRepaymentCk: true, direction: dir, repaymentAmount: review.amount, ckTxnKey, ocrImageHash: ocrImageHashOf(imageBuffer), investorId: review.entityId, senderName: review.senderName, receiverName: review.receiverName }; // [#23] hash net
      const sent = await postInvestorTransferCk(db, { roomId, imageBuffer, imageName, caption, ckTxnKey, meta });
      if (!sent.ok) return { ok: false, direction: dir, target: 'INVESTOR', roomId, recorded: true, deduped: recDeduped || undefined, error: sent.error, message: `Đã ghi hoàn thừa nhưng gửi nhóm NĐT lỗi (${sent.error}).` };
      return { ok: true, direction: dir, target: 'INVESTOR', roomId, messageId: sent.messageId, recorded: true, deduped: (recDeduped || sent.deduped) || undefined };
    }
    default:
      return { ok: false, direction: dir, target: null, error: 'UNKNOWN_DIRECTION', message: 'Chưa phân loại được hướng bill — chọn tay (loại + đại lý/NĐT) trước khi gửi.' };
  }
}

/** Map mã lỗi gửi nhóm đại lý → thông báo tiếng Việt. */
function dealerErrMsg(error?: string): string {
  if (error === 'NO_ROOM_MATCH') return 'Chưa khớp nhóm đại lý — chọn nhóm để gửi (cấm gửi nhầm).';
  // [Admin Demo 26/9] Nói RÕ phải làm gì, đừng để người gửi đoán (R198 — chặn thì phải chỉ đường).
  if (error === 'ROOM_NO_CUSTOMER') return 'CHẶN GỬI: nhóm bạn chọn CHƯA GÁN KHÁCH nên KHÔNG phải nhóm doanh số — gửi vào đây thì tiền hoàn sẽ KHÔNG vào đối soát. Chọn đúng nhóm "ĐL- …" của đại lý (nhóm "QR - …" chỉ để chat mã QR), hoặc gán khách cho nhóm này trước.';
  if (error?.startsWith('ATT_FAIL')) return 'Lưu ảnh bill thất bại — thử lại.';
  if (error?.startsWith('CK_SENT_OTHER_ROOM')) return 'Bill CK này ĐÃ GỬI ở nhóm KHÁC — 1 CK không được nằm 2 nhóm (đếm đôi hoàn). Xoá/sửa tin ở nhóm cũ trước.';
  if (error?.startsWith('CK_TRUNG_GIO_TIEN')) return 'CHẶN GỬI: nhóm này ĐÃ có bill CK cùng GIỜ:PHÚT + cùng SỐ TIỀN + cùng NGÀY (nghi cùng 1 giao dịch chụp 2 ảnh — chống hoàn x2). Nếu là GD KHÁC thật: sửa GIỜ trên bill cho đúng rồi gửi lại, HOẶC chụp lại bill có MÃ GIAO DỊCH (mở "Xem thêm") / rõ logo ngân hàng rồi quét lại — 2 mã GD khác hoặc 2 bank gửi khác là hệ tự cho qua.';
  if (error?.startsWith('IMAGE_SENT_OTHER_FLOW')) return imageOtherFlowMsg(error.endsWith('QR') ? 'QR' : 'POS');
  return 'Không gửi được bill vào nhóm đại lý.';
}

/** Parse ngày trên bill CK ("25/08/2026" hoặc "25/08/2026 14:10") → NGÀY "YYYY-MM-DD" (chuỗi, không timezone).
 *  Không đọc được → null. Dùng làm khóa nhóm ngày, khớp với to_char(...'YYYY-MM-DD') phía cần-hoàn. */
function parseTransferDay(s: string | null): string | null {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s ?? '');
  if (!m) return null;
  const dd = m[1].padStart(2, '0'), mm = m[2].padStart(2, '0');
  return `${m[3]}-${mm}-${dd}`;
}
/** Ngày HCM "YYYY-MM-DD" của 1 thời điểm (dùng cho ngày tải file fallback + biên kỳ). HCM = UTC+7. */
function fmtDayHcm(d: Date): string {
  const h = new Date(d.getTime() + 7 * 3600_000);
  return `${h.getUTCFullYear()}-${String(h.getUTCMonth() + 1).padStart(2, '0')}-${String(h.getUTCDate()).padStart(2, '0')}`;
}

/** KHÓA GIAO DỊCH CK bậc thang (Admin Demo 31/8 DUYỆT) — dedup "đã hoàn" chắc chắn: (1) mã GD bank chuẩn hoá mạnh nhất;
 *  (2) thiếu ref → STK gửi|STK nhận|số tiền|ngày; (3) thiếu STK → sha256 ảnh. Normalize UPPER + bỏ space. */
function normUpperNoSpace(s: string | null | undefined): string { return (s ?? '').toString().toUpperCase().replace(/\s+/g, ''); }
export function buildCkTxnKey(t: TransferReview, image: Buffer): string {
  const ref = normUpperNoSpace(t.ref);
  if (ref) return `ck|ref|${ref}`;
  const snd = normUpperNoSpace(t.senderAccount), rcv = normUpperNoSpace(t.receiverAccount);
  if (snd && rcv) return `ck|nat|${snd}|${rcv}|${Math.round(t.amount)}|${(parseTransferDay(t.date) ?? '').replace(/-/g, '')}`;
  return `ck|hash|${createHash('sha256').update(image).digest('hex')}`;
}

/** ĐỐI SOÁT HOÀN TIỀN ĐẠI LÝ theo NGÀY (phase-2 hướng-1, Admin Demo 31/8): mỗi ngày so CẦN HOÀN (Σ net los của TID
 *  đại lý, date theo bill_txn_date — đồng nhất doanh số) vs ĐÃ HOÀN (Σ bill CK SigMa→đại lý, date theo ngày bill CK,
 *  dedup mã CK). thuaThieu = đã hoàn − cần hoàn; trạng thái theo tolerance ±3.000đ. Tái dùng roomCustomerTidRows +
 *  listDealerRefundCks + REFUND_MATCH_TOLERANCE. */
export interface RefundReconcileDay { date: string; canHoan: number; daHoan: number; daUng: number; thuaThieu: number; status: 'match' | 'over' | 'partial' | 'none'; }
// (Đã xoá `closestSubsetIdx` — dead code sau khi reconcile chuyển per-day theo NGÀY CK, bỏ subset-sum. Agent-4 1/9.)
/** 1 bill hoàn/ứng trong kỳ (Admin Demo 1/9 "list thống kê theo bill hoàn"). billDate = ngày trên biên lai CK. */
export interface RefundBillItem { messageId: string; billDate: string | null; billTime: string | null; amount: number; kind: 'REFUND' | 'ADVANCE'; senderName: string | null; receiverName: string | null; bank: string | null;
  /** NGÂN HÀNG NGƯỜI GỬI (Admin Demo 2/9) — tra alias-học theo STK/tên người gửi. null nếu chưa học → cột "NH gửi" hiện '—'. */
  senderBank: string | null }
export interface RefundReconcileReport { from: string; to: string; days: RefundReconcileDay[]; totalCanHoan: number; totalDaHoan: number; totalThuaThieu: number; unmatchedDaHoan: number; totalDaUng: number;
  /** [Admin Demo 10/9 — KPI theo nhóm] Σ ỨNG SigMa đã đưa đại lý TRONG KỲ (chưa trừ phần đại lý trả lại). */
  totalUngGoc?: number;
  /** [Admin Demo 10/9] Σ tiền đại lý TRẢ LẠI được tính là HOÀN ỨNG (waterfall: trả về hạ ứng trước) — phần dư mới là hoàn thừa. */
  totalHoanUng?: number;
  /** DANH SÁCH bill hoàn/ứng THẬT trong kỳ [from,to) — để UI liệt kê từng bill khi mở tab ngày/kỳ. KHÁC `days` (tổng
   *  hợp) và reconcile-math (lũy kế <to): đây lọc CẢ 2 biên [from,to) theo billDate, dedup ckTxnKey. */
  bills: RefundBillItem[]; }
export async function buildDealerRefundReconcile(db: Db, roomId: string, from: Date, to: Date): Promise<RefundReconcileReport> {
  const tidRows = await roomCustomerTidRows(db, roomId);
  const tidIds = tidRows.map((t) => t.id);
  // [Admin Demo 12/9 "chuyển TID về nhà mượn — sau phí đúng nhưng CẦN HOÀN không nhảy"] CẦN HOÀN phải cùng LUẬT GÁN
  // với doanh số phòng (chat-room-tid-service): đại lý gán = los.borrowed_by_customer_id (nếu MƯỢN/GHIM) ELSE chủ
  // TID. Trước đây chỉ đếm lr.tid_id ∈ TID phòng → (a) lô MƯỢN-VÀO trên TID nhà khác KHÔNG được cộng (cần hoàn
  // đứng im); (b) lô TID phòng nhưng GHIM/mượn-RA cho khách khác vẫn bị cộng OAN.
  const roomCustGroups = await db.customerChatGroup.findMany({ where: { roomId, unassignedAt: null }, select: { customerId: true } });
  const roomCustomerIds = [...new Set(roomCustGroups.map((g) => g.customerId))];
  const canByDay = new Map<string, number>();
  if (tidIds.length > 0 || roomCustomerIds.length > 0) {
    // THEO KỲ TAB (Admin Demo 1/9 chốt "tab nào ra số đó theo doanh số, chuyển tab phải đổi số"): cần hoàn = doanh số
    // TRONG kỳ [from, to) (KHÔNG lũy kế từ đầu). Mỗi tab (hôm nay/hôm qua/7 ngày/tháng) ra số KHÁC nhau theo doanh số
    // kỳ đó. Đã hoàn (dưới) cũng lọc theo ngày CK trong kỳ. Chấp nhận ngày lẻ có thể thừa/thiếu "giả" (hoàn ngày này
    // cho bán ngày khác) — số dư ròng THẬT xem ở tab kỳ dài (7 ngày/tháng bao trọn).
    const rows = await db.$queryRawUnsafe<{ d: string; net: bigint }[]>(
      `SELECT to_char(COALESCE(l.bill_txn_date, lr.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') AS d,
              SUM(lr.amount_after_fee)::bigint AS net
       FROM lo_rows lr JOIN los l ON l.id = lr.lo_id
       WHERE ((lr.tid_id = ANY($1::int[]) AND l.borrowed_by_customer_id IS NULL)
              OR l.borrowed_by_customer_id = ANY($4::int[]))
         AND l.status <> 'CANCELLED'
         AND COALESCE(l.bill_txn_date, lr.created_at) >= $2::timestamptz
         AND COALESCE(l.bill_txn_date, lr.created_at) < $3::timestamptz
       GROUP BY d`, tidIds, from.toISOString(), to.toISOString(), roomCustomerIds);
    for (const r of rows) canByDay.set(r.d, Number(r.net));
  }
  const rawCks = await listDealerRefundCks(db, roomId);
  // [Admin Demo 29/9 "bill hoàn tiền đại lý này đã ocr nhưng không ghi nhận vào doanh số ngày 29/9"] BIÊN KỲ:
  // `to` KHÔNG phải lúc nào cũng là đầu-ngày-hôm-sau. Route /refund-reconcile mặc định `to = new Date()`
  // (BÂY GIỜ) và rooms-revenue-kpi dùng `ky?.to ?? now` ⇒ fmtDayHcm(to) ra CHÍNH HÔM NAY ⇒ lọc
  // `billDate < toDayExcl` gạt SẠCH mọi bill hôm nay. Đo thật phòng ĐL- Mr Nguyễn SG ngày 29/9:
  // gọi mặc định ra 886 bill nhưng KHÔNG có bill nào của hôm nay; gọi [đầu 29, đầu 30) ra đủ 32 bill.
  // NAY: ngày cuối THỰC = ngày của thời điểm ngay TRƯỚC `to`; biên loại-trừ = ngày kế tiếp của nó.
  const toDayIncl = fmtDayHcm(new Date(to.getTime() - 1));
  const toDayExcl = fmtDayHcm(new Date(Date.parse(`${toDayIncl}T12:00:00Z`) + 24 * 3600 * 1000));
  const report = computeRefundReconcileCore(canByDay, rawCks, toDayExcl, from.toISOString(), to.toISOString(), fmtDayHcm(from));
  // DANH SÁCH bill hoàn/ứng THẬT trong kỳ [from,to) (Admin Demo 1/9 "list thống kê theo bill hoàn, ngày giờ; không giờ
  // xếp đầu, rồi giờ tăng dần"). Lọc CẢ 2 biên theo billDate; dedup ckTxnKey. Sắp: KHÔNG-giờ trước → giờ tăng dần →
  // theo ngày. (KHÁC reconcile-math lũy kế <to.)
  const fromDay = fmtDayHcm(from), toDay = toDayExcl;   // dùng CHUNG biên đã sửa ở trên
  const seenB = new Set<string>();
  report.bills = rawCks
    .filter((c) => {
      if (c.ckTxnKey) { if (seenB.has(c.ckTxnKey)) return false; seenB.add(c.ckTxnKey); }
      return !!c.billDate && c.billDate >= fromDay && c.billDate < toDay;
    })
    .map((c) => ({ messageId: c.messageId, billDate: c.billDate, billTime: c.billTime, amount: c.refundAmount, kind: c.kind, senderName: c.senderName, receiverName: c.receiverName, bank: c.bank,
      // NGÂN HÀNG NGƯỜI GỬI (Admin Demo 2/9): tra alias-học theo STK→tên người gửi lưu ở metadata bill. Chưa học → null.
      senderBank: lookupSenderBank({ account: c.senderAccount, name: c.senderName }) }))
    .sort((a, b) => {
      if (a.billDate !== b.billDate) return (a.billDate ?? '') < (b.billDate ?? '') ? -1 : 1; // ngày tăng dần
      const at = a.billTime, bt = b.billTime;
      if (!at && !bt) return 0;
      if (!at) return -1; // KHÔNG-giờ xếp LÊN ĐẦU trong cùng ngày
      if (!bt) return 1;
      return at < bt ? -1 : at > bt ? 1 : 0; // rồi giờ TĂNG DẦN
    });
  return report;
}

/** LÕI THUẦN đối soát hoàn tiền (tách khỏi DB để test được). THEO KỲ TAB (Admin Demo 1/9 chốt period-bound qua
 *  AskUserQuestion — ĐẢO thiết kế lũy-kế cũ): CK lọc `[fromDayIncl, toDayExcl)`, doanh số `canByDay` TỰ clamp cùng
 *  cửa sổ (fail-safe TZ, KHÔNG tin caller). per-day đã-hoàn = Σ CK theo NGÀY CK (billDate) — bỏ subset-sum. `rawCks` =
 *  mọi CK hoàn/ứng của phòng (chưa lọc, hàm tự lọc). totalThuaThieu = (Σ hoàn + Σ ứng trong kỳ) − Σ cần trong kỳ.
 *  Ngày lẻ có thể thừa/thiếu "giả" (hoàn ngày này cho bán ngày khác) — số dư ròng THẬT xem tab kỳ dài bao trọn. */
export function computeRefundReconcileCore(
  canByDay: Map<string, number>,
  rawCks: { refundAmount: number; billDate: string | null; kind: 'REFUND' | 'ADVANCE'; ckTxnKey: string | null }[],
  toDayExcl: string,
  fromIso: string,
  toIso: string,
  fromDayIncl: string // Admin Demo 1/9 chốt "theo kỳ tab": chặn CẢ biên dưới → CK trong [fromDayIncl, toDayExcl).
): RefundReconcileReport {
  const seen = new Set<string>();
  // THEO KỲ TAB + per-day theo NGÀY CK (Admin Demo 1/9 chốt: "tab nào ra số đó theo doanh số; đã hoàn theo ngày CK"):
  // đã-hoàn per-day = Σ CK có billDate = ngày đó (KHÔNG subset-sum gán theo tiền nữa — đơn giản, khớp list bill hoàn).
  // Ngày lẻ có thể thừa/thiếu "giả" (hoàn ngày này cho bán ngày khác) — số dư ròng THẬT xem ở tab kỳ dài bao trọn.
  // [Admin Demo 4/9 — FIX "lỗi mù khoản tạm ứng"] TÁCH 3 dòng tiền THEO CHIỀU + WATERFALL (quan hệ 2 chiều SigMa↔đại lý):
  //   advOut = SigMa→đại lý ỨNG (kind ADVANCE, +) · refOut = SigMa→đại lý HOÀN (kind REFUND, +) · retIn = đại lý→SigMa
  //   TRẢ VỀ (kind REFUND, − → |.|). Tiền đại lý trả về HẠ "Đã ứng" TRƯỚC (hoàn ứng), DƯ mới hạ "Đã hoàn" (hoàn thừa).
  //   → ứng 200 + đại lý trả 200 = ứng 0, hoàn ĐỦ (không bị trừ oan). Đại lý CHƯA trả → ứng vẫn TREO (báo rõ, không mù).
  const advByDay = new Map<string, number>(), refOutByDay = new Map<string, number>(), retInByDay = new Map<string, number>();
  let totAdv = 0, totRefOut = 0, totRetIn = 0;
  for (const c of rawCks) {
    if (c.ckTxnKey) { if (seen.has(c.ckTxnKey)) continue; seen.add(c.ckTxnKey); }
    if (!c.billDate || c.billDate < fromDayIncl || c.billDate >= toDayExcl) continue; // CHỈ CK trong kỳ [from, to).
    if (c.kind === 'ADVANCE') { advByDay.set(c.billDate, (advByDay.get(c.billDate) ?? 0) + c.refundAmount); totAdv += c.refundAmount; }
    else if (c.refundAmount >= 0) { refOutByDay.set(c.billDate, (refOutByDay.get(c.billDate) ?? 0) + c.refundAmount); totRefOut += c.refundAmount; }
    else { const r = -c.refundAmount; retInByDay.set(c.billDate, (retInByDay.get(c.billDate) ?? 0) + r); totRetIn += r; } // đại lý→SigMa (trả về)
  }
  // FAIL-SAFE cửa sổ kỳ (Agent-1 1/9): tự CLAMP canByDay theo [fromDayIncl, toDayExcl). Đối xứng biên với CK → doanh
  // số + hoàn CÙNG hệ ngày HCM, không thừa/thiếu GIẢ do lệch TZ.
  const inWindow = (d: string): boolean => d >= fromDayIncl && d < toDayExcl;
  const allDays = [...new Set([...canByDay.keys(), ...advByDay.keys(), ...refOutByDay.keys(), ...retInByDay.keys()])].filter(inWindow).sort();
  // [Dọn nợ 11/9 — WATERFALL QUA NGÀY] TRƯỚC ĐÂY per-day chỉ khớp ứng↔trả-về TRONG CÙNG NGÀY: ứng ngày 1, đại lý
  // trả ngày 2 → ngày 1 vẫn treo ứng + ngày 2 "hoàn" ÂM, Σngày ≠ tổng kỳ (tổng tính min() cả kỳ riêng). NAY: fold
  // THEO THỨ TỰ NGÀY với CARRY ứng-còn-treo — tiền đại lý trả về hạ ứng TREO (kể cả của ngày trước) rồi dư mới là
  // hoàn-thừa; daUng ngày = BIẾN ĐỘNG ứng treo trong ngày (âm = trả ứng cho ngày trước). Tổng kỳ DẪN XUẤT từ chính
  // vòng ngày ⇒ Σdays = totals ĐÚNG THEO CẤU TRÚC (hết lệch 2 cách tính).
  let tCan = 0, ungTreo = 0, tRepayAdv = 0, tSurplus = 0, sumDaUng = 0, sumDaHoan = 0;
  const days: RefundReconcileDay[] = allDays.map((date) => {
    const canHoan = canByDay.get(date) ?? 0;
    const adv = advByDay.get(date) ?? 0, refOut = refOutByDay.get(date) ?? 0, retIn = retInByDay.get(date) ?? 0;
    ungTreo += adv;                                   // ứng mới phát sinh vào pool treo
    const repay = Math.min(retIn, ungTreo);           // trả về hạ ứng TREO trước (gồm carry ngày trước)
    ungTreo -= repay; tRepayAdv += repay;
    const surplus = retIn - repay;                     // phần dư = hoàn-thừa về SigMa
    tSurplus += surplus;
    const daUng = adv - repay;                         // biến động ứng treo NGÀY này (âm = trả ứng ngày trước)
    const daHoan = refOut - surplus;                   // hoàn ra − hoàn-thừa-về
    const daTra = daHoan + daUng;                      // SigMa đã trả RÒNG ngày đó
    const thuaThieu = daTra - canHoan;                 // THẬT (không cap) — dương=thừa, âm=thiếu
    tCan += canHoan; sumDaUng += daUng; sumDaHoan += daHoan;
    const status: RefundReconcileDay['status'] = daTra === 0 && canHoan > 0 ? 'none'
      : thuaThieu > DAY_RECONCILE_TOLERANCE_VND ? 'over'
      : thuaThieu < -DAY_RECONCILE_TOLERANCE_VND ? 'partial' : 'match';
    return { date, canHoan, daHoan, daUng, thuaThieu, status };
  });
  const totalDaUng = ungTreo;                          // ứng CÒN TREO cuối kỳ (≥0 theo cấu trúc fold)
  const totalDaHoanRefund = totRefOut - tSurplus;      // hoàn ra − Σ hoàn-thừa-về
  const repayAdvTotal = tRepayAdv;
  const unmatched = 0;
  // KHOÁ 2 — INVARIANT (R198: kiểm phải chạy, sai KHÔNG nuốt im): (a) ứng không âm; (b) tiền vào/ra CÂN theo chiều
  // (Σ SigMa→ĐL − Σ ĐL→SigMa = Đã hoàn + Đã ứng); (c) Σdays = totals (waterfall qua ngày phải cân sổ). Vỡ = code
  // hồi quy → LOG rõ (không throw để khỏi sập màn báo cáo).
  const netByDirection = (totAdv + totRefOut) - totRetIn;
  if (totalDaUng < 0 || netByDirection !== (totalDaHoanRefund + totalDaUng) || sumDaUng !== totalDaUng || sumDaHoan !== totalDaHoanRefund) {
    console.error(`[refund-reconcile] ⚠ INVARIANT VỠ: ứng=${totalDaUng} (Σngày=${sumDaUng}) hoàn=${totalDaHoanRefund} (Σngày=${sumDaHoan}) net-chiều=${netByDirection} (advOut=${totAdv} refOut=${totRefOut} retIn=${totRetIn}) — nghi bill đọc ngược/sót/nhân đôi.`);
  }
  // totalDaHoan/totalDaUng = số RÒNG theo chiều (waterfall); totalThuaThieu = (hoàn + ứng còn treo) − cần. Số THẬT cả kỳ.
  return { from: fromIso, to: toIso, days, totalCanHoan: tCan, totalDaHoan: totalDaHoanRefund, totalThuaThieu: (totalDaHoanRefund + totalDaUng) - tCan, unmatchedDaHoan: unmatched, totalDaUng, totalUngGoc: totAdv, totalHoanUng: repayAdvTotal, bills: [] };
}

/** HƯỚNG-3: NĐT→SigMa = TẠM ỨNG → ghi InvestorAdvance qua CHÍNH `ingestInvestorAdvance` (DÙNG CHUNG với ingestion
 *  phòng chat) → CHUNG DEDUP ref_number(mã GD)+image_hash → CHỐNG ĐẾM ĐÔI giữa 2 surface (Admin Demo 31/8 phản biện).
 *  ref/hash trích từ ckTxnKey (ck|ref|X hoặc ck|hash|X); nat → rơi dedup tier-C (amount+ngày±2'). advanceDate =
 *  ngày biên lai CK ELSE ngày tải file. Money — không tự tính. */
function vnDateToIso(d: string | null | undefined, fallbackIso: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec((d ?? '').trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : fallbackIso;
}
export async function recordInvestorAdvanceFromTransfer(
  db: Db, review: TransferReview, ckTxnKey: string, fileDate: Date, imageHash?: string | null
): Promise<{ ok: true; id?: number; deduped?: boolean } | { ok: false; error: string; message: string }> {
  if (review.direction !== 'INVESTOR_TO_ALPHA' || review.entityId == null)
    return { ok: false, error: 'NOT_ADVANCE', message: 'Bill không phải hướng tạm ứng NĐT (NĐT→SigMa).' };
  const refM = /^ck\|ref\|(.+)$/.exec(ckTxnKey);
  const hashM = /^ck\|hash\|(.+)$/.exec(ckTxnKey);
  const advanceDateIso = vnDateToIso(review.date, fileDate.toISOString().slice(0, 10));
  const out = await ingestInvestorAdvance(db, {
    investorId: review.entityId, // ƯU TIÊN investorId (đã khớp qua classify) — bỏ qua zaloGroupId
    receiverName: review.receiverName, receiverAccountNumber: review.receiverAccount, // = SigMa (INVESTOR_TO_ALPHA)
    senderName: review.senderName, senderAccountNumber: review.senderAccount,
    amount: review.amount, advanceDateIso,
    // [Kiểm chứng độc lập 11/9 — VÁ NỐT CAO-5] Fix INVADV-IMAGEHASH-NULL mới sửa nhánh HOÀN THỪA (repayment),
    // nhánh TẠM ỨNG này vẫn rút hash TỪ CHUỖI KHOÁ → khoá ref-tier ghi image_hash NULL, mất lưới chống ứng 2 LẦN
    // (chính ca 82/127 dòng trong claim). NAY caller truyền hash ảnh THẬT; fallback chuỗi khoá chỉ còn cho
    // caller cũ không có ảnh (hiện không có — giữ để không đổi hành vi nếu ai gọi thiếu).
    ref: refM ? refM[1] : null, imageHash: imageHash ?? (hashM ? hashM[1] : null)
  });
  if (out.action === 'recorded') return { ok: true, id: out.id };
  if (out.action === 'duplicate') {
    // [PHẢN BIỆN 21/9 — A-H3 CONFIRMED] SỬA bill CK tạm ứng NĐT (prepare-edit → đổi tiền/ngày → Gửi) rơi vào đây:
    // dedup ảnh/ref khớp bản cũ → trước trả ok:true deduped=true, investor_advances GIỮ SỐ CŨ, tin chat cũng dedup
    // theo ckTxnKey → user tưởng ĐÃ SỬA mà sổ tiền KHÔNG đổi (no-op CÂM — cùng lớp moneyEditNotApplied bên POS).
    // Fail-loud: tham số LỆCH bản đã ghi → CHẶN + chỉ đường sửa qua bảng tạm ứng (editInvestorAdvance có audit);
    // KHÔNG tự ghi đè tiền ở luồng gửi (luồng này còn chạy cho bill thường — OCR lệch mà tự đè là thảm hoạ).
    const cu = (await db.$queryRawUnsafe<{ amount: number; ngay: string }[]>(
      `SELECT amount::float8 AS amount, to_char(advance_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS ngay
         FROM investor_advances WHERE id = $1`, out.id))[0];
    const ngayMoi = vnDateToIso(review.date, fileDate.toISOString().slice(0, 10))?.slice(0, 10) ?? null;
    const lechTien = !!cu && Math.round(cu.amount) !== Math.round(review.amount);
    const lechNgay = !!cu && !!ngayMoi && cu.ngay !== ngayMoi;
    if (lechTien || lechNgay) {
      return {
        ok: false, error: 'CK_DA_GHI_THAM_SO_LECH',
        message: `Bill này ĐÃ GHI tạm ứng NĐT trước đó (${Math.round(cu.amount).toLocaleString('vi-VN')}đ · ${cu.ngay}), khác thông số đang gửi (${Math.round(review.amount).toLocaleString('vi-VN')}đ${ngayMoi ? ` · ${ngayMoi}` : ''}). Hệ KHÔNG tự ghi đè tiền — sửa bằng nút Sửa trên bảng Tạm ứng NĐT (báo cáo NĐT), tin chat sẽ đồng bộ theo.`
      };
    }
    return { ok: true, deduped: true };
  }
  return { ok: false, error: out.action, message: `Không ghi được tạm ứng (${out.action}).` };
}

/** Liệt kê CK-hoàn đại lý ĐÃ GHI trong 1 nhóm (metadata isDealerRefundCk) — cho dedup + đối soát. Đọc tin IMAGE
 *  của bot trong nhóm, parse metadata. Volume nhỏ (số CK/nhóm ít) → fetch + parse đủ nhanh. */
export interface DealerRefundCk { messageId: string; ckTxnKey: string | null; imageHash: string | null; refundAmount: number; billDate: string | null; billTime: string | null; createdAt: Date; kind: 'REFUND' | 'ADVANCE'; senderName: string | null; senderAccount: string | null; receiverName: string | null; bank: string | null; appBank: string | null; }
/** Rút GIỜ "HH:mm" từ chuỗi ngày-giờ OCR thô ("01/09/2026 14:22[:ss]"). Không có giờ → null (list xếp lên đầu). */
export function extractBillTime(raw: string | null | undefined): string | null {
  const m = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/.exec(raw ?? '');
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}
export async function listDealerRefundCks(db: Db, roomId: string): Promise<DealerRefundCk[]> {
  const rows = await db.chatMessage.findMany({
    // PERF (Agent-4/5 1/9): prefilter DB `contains "isTransferRefund"` — CHỈ tin CK (hoàn/ứng), KHÔNG quét MỌI ảnh
    // phòng (bill POS, ảnh chat) rồi parse JSON từng dòng. isTransferRefund có ở CẢ dealer refund + advance.
    where: { roomId, kind: 'IMAGE', deletedAt: null, metadataJson: { contains: '"isTransferRefund"' } },
    select: { id: true, metadataJson: true, createdAt: true }
  });
  const out: DealerRefundCk[] = [];
  for (const r of rows) {
    if (!r.metadataJson) continue;
    let p: { isDealerRefundCk?: boolean; isDealerAdvanceCk?: boolean; refundAmount?: number; ckTxnKey?: string | null; ocrImageHash?: string | null; billDate?: string | null; billDateTimeRaw?: string | null; senderName?: string | null; senderAcct?: string | null; receiverName?: string | null; bank?: string | null };
    try { p = JSON.parse(r.metadataJson); } catch { continue; }
    // GOM 2 loại CK SigMa↔đại lý (CÙNG pool đối soát, dedup CHUNG ckTxnKey): hoàn tiền (isDealerRefundCk) + ứng trước
    // (isDealerAdvanceCk, Admin Demo 1/9). refundAmount ÂM = hướng-2 hoàn-thừa (giảm). Loại 0/không hợp lệ.
    const isRefund = p.isDealerRefundCk === true, isAdvance = p.isDealerAdvanceCk === true;
    if ((!isRefund && !isAdvance) || typeof p.refundAmount !== 'number' || p.refundAmount === 0) continue;
    out.push({ messageId: String(r.id), ckTxnKey: p.ckTxnKey ?? null, imageHash: p.ocrImageHash ?? null, refundAmount: p.refundAmount, billDate: p.billDate ?? null, billTime: extractBillTime(p.billDateTimeRaw), createdAt: r.createdAt, kind: isAdvance ? 'ADVANCE' : 'REFUND', senderName: p.senderName ?? null, senderAccount: p.senderAcct ?? null, receiverName: p.receiverName ?? null, bank: p.bank ?? null, appBank: (p as Record<string, unknown>)['appBank'] as string | null ?? null });
  }
  return out;
}

/** [Admin Demo 7/9 — SỬA BILL HOÀN] Sửa tham số bill HOÀN/ỨNG (CK) trên bảng đối soát: ngày/giờ/số tiền. Cập nhật metadata
 *  (billDate ISO → reconcile nhóm ĐÚNG ngày · billDateTimeRaw → giờ · refundAmount → tiền, GIỮ dấu âm hoàn-thừa) +
 *  RE-KEY ckTxnKey nat-tier (amount/ngày trong khoá) để dedup không trượt + rebuild caption. Gate mật khẩu sửa
 *  (chỉ người SigMa). BEST-EFFORT broadcast. KHÔNG đụng QR (isQrRefundCk có đường riêng — bảng này chỉ CK/ứng). */
export async function editRefundBillParams(
  db: Db,
  input: { messageId: string; editPassword: string; patch: { billDate?: string; billTime?: string; amount?: number } }
): Promise<{ ok: true; messageId: string; billDate: string | null; amount: number } | { ok: false; error: string; message?: string }> {
  if (!(await verifyBillEditPassword(db, input.editPassword))) return { ok: false, error: 'BAD_PASSWORD', message: 'Sai mật khẩu sửa.' };
  const msg = await db.chatMessage.findUnique({ where: { id: input.messageId }, select: { id: true, roomId: true, body: true, metadataJson: true } });
  if (!msg?.metadataJson) return { ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy bill hoàn.' };
  let m: Record<string, unknown>;
  try { m = JSON.parse(msg.metadataJson); } catch { return { ok: false, error: 'META_BAD', message: 'Metadata bill hỏng.' }; }
  if (m.isTransferRefund !== true || (m.isDealerRefundCk !== true && m.isDealerAdvanceCk !== true)) {
    return { ok: false, error: 'NOT_REFUND', message: 'Tin này không phải bill hoàn/ứng CK (không sửa ở đây).' };
  }
  const p = input.patch;
  const ckKeyCu = typeof m.ckTxnKey === 'string' ? m.ckTxnKey : null; // [A-M3 21/9] chụp key TRƯỚC re-key để đồng bộ reservation
  const reKeyNat = (idx: number, val: string): void => {
    if (typeof m.ckTxnKey === 'string' && m.ckTxnKey.startsWith('ck|nat|')) {
      const parts = m.ckTxnKey.split('|'); // ck|nat|SND|RCV|AMT|YYYYMMDD
      if (parts.length >= 6) { parts[idx] = val; m.ckTxnKey = parts.join('|'); }
    }
  };
  // SỐ TIỀN — giữ DẤU (hoàn-thừa âm). Re-key nat AMT (đoạn 4). Validate nguyên > 0.
  if (p.amount != null) {
    if (!Number.isInteger(p.amount) || p.amount <= 0) return { ok: false, error: 'VALIDATION', message: 'Số tiền phải là số nguyên > 0.' };
    const sign = Number(m.refundAmount) < 0 ? -1 : 1;
    m.refundAmount = sign * p.amount;
    reKeyNat(4, String(p.amount));
  }
  // NGÀY — chuẩn ISO (reconcile nhóm theo ISO). Re-key nat ngày (đoạn 5 = YYYYMMDD).
  if (p.billDate) {
    const iso = toIsoBillDay(p.billDate);
    if (!iso) return { ok: false, error: 'VALIDATION', message: 'Ngày không hợp lệ.' };
    m.billDate = iso;
    reKeyNat(5, iso.replace(/-/g, ''));
  }
  // GIỜ — lưu billDateTimeRaw = "dd/mm/yyyy HH:MM" (extractBillTime đọc lại cho cột Giờ). Rỗng = bỏ giờ.
  if (p.billTime != null) {
    const disp = fmtDayDisplay(typeof m.billDate === 'string' ? m.billDate : null) ?? '';
    const t = p.billTime.trim();
    if (t && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(t)) return { ok: false, error: 'VALIDATION', message: 'Giờ không hợp lệ (HH:MM).' };
    m.billDateTimeRaw = t ? `${disp} ${t}`.trim() : (disp || null);
  }
  // REBUILD caption theo loại (hoàn / hoàn-thừa / ứng) — đồng bộ chat với số/ngày mới.
  const disp = fmtDayDisplay(typeof m.billDate === 'string' ? m.billDate : null);
  const amtNum = Number(m.refundAmount) || 0;
  const label = m.isDealerAdvanceCk === true ? '💰 ĐẠI LÝ ỨNG TRƯỚC' : amtNum < 0 ? '↩️ HOÀN THỪA (đại lý → SigMa)' : '💸 HOÀN TIỀN ĐẠI LÝ';
  const newBody = `${label} · ${fmtVnd(Math.abs(amtNum))}đ${disp ? ` · ${disp}` : ''}`;
  await db.chatMessage.update({ where: { id: msg.id }, data: { metadataJson: JSON.stringify(m), body: newBody } });
  // [A-M3 21/9 — parity với editBillParams POS (vụ lô 24 19/9)] Re-key nat đổi ckTxnKey trong META nhưng bảng
  // reservation ocr_bill_sent GIỮ KEY CŨ → key cũ thành mồ-côi-có-chủ (chặn oan GD thật trùng key cũ tới khi
  // self-heal 10'), key mới không giữ chỗ. Đồng bộ NGAY; lỗi PHẢI kêu (R198), không nuốt câm.
  if (ckKeyCu && typeof m.ckTxnKey === 'string' && m.ckTxnKey !== ckKeyCu) {
    try {
      await db.$executeRawUnsafe(
        `UPDATE ocr_bill_sent SET ocr_send_key = $1 WHERE dealer_room_id = $2 AND ocr_send_key = $3`,
        m.ckTxnKey, msg.roomId, ckKeyCu);
    } catch (e) {
      console.error(`[ck-edit] KHÔNG đổi được khoá dedup reservation ${ckKeyCu.slice(0, 40)}… → ${String(m.ckTxnKey).slice(0, 40)}… (phòng ${msg.roomId}):`, e instanceof Error ? e.message : e);
    }
  }
  try { broadcastToRoom(msg.roomId, { msg: 'message-updated', roomId: msg.roomId, messageId: msg.id }); } catch { /* best-effort */ }
  return { ok: true, messageId: msg.id, billDate: (typeof m.billDate === 'string' ? m.billDate : null), amount: amtNum };
}

/**
 * DÃY LÔ GẦN ĐÂY của MỌI máy CÙNG HỌ HKD (bỏ số máy cuối) — nguyên liệu cho gate `kiemTraSoLo`.
 * [Admin Demo 8/9] Cần vì 2 ca lọt: lô 500 (thật ra là SỐ HOÁ ĐƠN) và lô 101 gán nhầm XUÂN ĐOÀN 2 thay vì 3.
 * Lấy 30 ngày gần nhất; số lô đọc từ billKey dạng "nat|<tid>|<lô>|…" (khớp cách createLoFromBillTid ghi).
 */
export async function layDayLoCungHo(db: Db, tid: string): Promise<DayLoMay[]> {
  const me = await db.tid.findFirst({ where: { tid, deletedAt: null }, select: { id: true, tid: true, hkdName: true } });
  if (!me) return [];
  const base = normalizeHkdKey((me.hkdName ?? '').replace(/\s*\d+\s*$/, '')); // bỏ số máy cuối → "họ" HKD
  const all = await db.tid.findMany({ where: { deletedAt: null }, select: { id: true, tid: true, hkdName: true } });
  const cungHo = all.filter((t) => normalizeHkdKey((t.hkdName ?? '').replace(/\s*\d+\s*$/, '')) === base && base.length > 0);
  const ds = cungHo.length ? cungHo : [me];
  const out: DayLoMay[] = [];
  for (const t of ds) {
    const rows = (await db.$queryRawUnsafe(
      `SELECT l.bill_key AS "billKey" FROM los l JOIN lo_rows r ON r.lo_id = l.id
        WHERE r.tid_id = $1 AND l.status <> 'CANCELLED' AND l.created_at > $2
        GROUP BY l.id, l.bill_key ORDER BY l.id DESC LIMIT 60`,
      t.id,
      // [B210] mốc 30 ngày truyền từ chương trình xuống để CÙNG hệ quy chiếu với `created_at` (xem giải
      // thích ở hàm giữ chỗ gửi bill): dùng now() của máy chủ thì cửa sổ lệch 7 tiếng.
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    )) as Array<{ billKey: string | null }>;
    let maxLo = 0;
    const dsLo: number[] = [];
    for (const r of rows) {
      const m = /^nat\|[^|]*\|([0-9]+)(?:\([0-9]+\))?\|/.exec(String(r.billKey ?? '')); // [A-M6 21/9] nhận cả lô "84(95)" — trước mù lô đóng-95 → gate kêu thiếu lô oan
      const n = m ? Number(m[1]) : NaN;
      if (Number.isFinite(n) && n > 0 && n < 100000) {
        dsLo.push(n);
        if (n > maxLo) maxLo = n;
      }
    }
    out.push({ tidId: t.id, tid: t.tid, hkdName: t.hkdName, maxLo, dsLo });
  }
  return out;
}

export async function reviewBills(db: Db, bills: OcrBill[], now: Date): Promise<ReviewItem[]> {
  const out: ReviewItem[] = [];
  // GỘP THÀNH LÔ trước khi review (Admin Demo 30/8 "kèm bill lẻ hiện 2 nút gửi"): 1 ảnh có settlement + bill lẻ CÙNG
  // lô → TRƯỚC ĐÂY tạo 1 card/bill → user gửi từng cái → GỬI & GHI DOANH SỐ NHIỀU LẦN cùng 1 lô (đếm đôi nặng).
  // Nay dùng aggregateLotRevenue (settlement thắng, dedup sale) → 1 LÔ = 1 card = 1 lần gửi = 1 lần doanh số.
  // Bill KHÔNG đọc được TID → giữ nguyên từng cái (cần nhập tay, không gộp được).
  const withTid = bills.filter((b) => b.tid && b.tid.trim());
  const noTid = bills.filter((b) => !b.tid || !b.tid.trim());
  const agg = aggregateLotRevenue(withTid.map((b) => ({ tid: (b.tid ?? '').trim(), batchNumber: b.batchNumber, type: b.type, totalAmount: b.totalAmount, dateTime: b.dateTime })));
  const lotBills: OcrBill[] = agg.lots.map((l) => {
    const src = withTid.find((b) => (b.tid ?? '').trim() === l.tid); // agencyName ~ theo TID
    const batch = l.batchNumber.startsWith('amt:') ? null : l.batchNumber; // 'amt:<n>' = nhóm dự phòng khi thiếu lô
    // BUG FIX (Admin Demo 1/9 "đóng 95 không nhận diện được"): gộp lô TRƯỚC ĐÂY dựng lại bill mà KHÔNG copy
    // settlementCode → mã ĐÓNG(95) bị nuốt cho MỌI bill có TID → cảnh báo nghiêm trọng không bao giờ bắn. Giữ mã
    // rủi ro từ bill nguồn CÙNG lô (cùng TID + cùng số lô; 'amt:' dự phòng thì theo TID) — ưu tiên '95'.
    const lotSrc = withTid.filter((b) => (b.tid ?? '').trim() === l.tid && (batch == null || (b.batchNumber ?? null) === batch));
    const settlementCode = lotSrc.find((b) => b.settlementCode === '95')?.settlementCode ?? lotSrc.find((b) => b.settlementCode)?.settlementCode ?? null;
    return { tid: l.tid, agencyName: src?.agencyName ?? null, batchNumber: batch, type: l.source === 'settlement' ? 'SETTLEMENT' : 'SALE', totalAmount: l.amount, dateTime: l.dateTime, settlementCode };
  });
  const effectiveBills: OcrBill[] = [...lotBills, ...noTid];
  // Map tên-HKD-chuẩn-hoá → [TID active] để SUY TID khi OCR rớt TID nhưng ĐỌC được tên HKD (bug lô 83 Thành Nam 1/9:
  // settlement bill đọc rớt TID → tid null → "ID ⚠, HKD —" dù OCR có tên "HKD DEMO 6-1"). Chỉ suy khi khớp DUY
  // NHẤT 1 TID (cấm suy tiền mù: nhiều TID cùng tên → để nhập tay). Cắm cờ để người XÁC NHẬN trước khi gửi.
  const allTidHkd = await db.tid.findMany({ where: { deletedAt: null }, select: { tid: true, hkdName: true } });
  const hkdToTids = new Map<string, string[]>();
  // validTids: MỌI TID hợp lệ (đang sống) — để bắt trường hợp OCR đọc RA số TID nhưng SAI/không tồn tại (Admin Demo 2/9
  // KHACH HANG 61 "59530601" là OCR nhầm của 59930001) → suy lại theo tên HKD như khi rớt TID.
  const validTids = new Set(allTidHkd.map((r) => r.tid));
  for (const r of allTidHkd) {
    const k = normalizeHkdKey(r.hkdName);
    if (!k) continue;
    const arr = hkdToTids.get(k) ?? []; arr.push(r.tid); hkdToTids.set(k, arr);
  }
  // [Admin Demo 2/9 "gợi ý TID đúng theo họ HKD 1/2/3/4"] GOM TID theo BASE tên HKD (bỏ SỐ MÁY cuối): "HKD DEMO 5/2/3"
  // cùng base "HKDTHAIBINH". Khi OCR đọc được TÊN HKD mà TID nghi ngờ (suy/lệch) → dropdown các TID CÙNG HỌ để chọn
  // ĐÚNG máy (vẫn cho sửa tay). Áp 2 chiều (TID nghi hoặc HKD nghi).
  const baseToTids = new Map<string, { tid: string; hkdName: string }[]>();
  for (const r of allTidHkd) {
    if (!r.hkdName) continue;
    const bk = normalizeHkdKey(r.hkdName).replace(/\d+$/, '');
    if (!bk) continue;
    const arr = baseToTids.get(bk) ?? []; arr.push({ tid: r.tid, hkdName: r.hkdName }); baseToTids.set(bk, arr);
  }
  const suggestTidsByHkd = (hkdName: string | null | undefined): { tid: string; hkdName: string }[] => {
    const bk = normalizeHkdKey(hkdName).replace(/\d+$/, '');
    const fam = bk ? baseToTids.get(bk) : undefined;
    // Chỉ gợi ý khi HKD có ≥2 MÁY (dropdown vô nghĩa nếu 1 máy). Sắp theo tên (1/2/3...).
    return fam && fam.length >= 2 ? [...fam].sort((a, b) => a.hkdName.localeCompare(b.hkdName, 'vi')) : [];
  };
  // [Admin Demo 3/9 snap-2] GỢI Ý gộp: theo HỌ HKD + TID HỢP LỆ GẦN NHẤT chuỗi OCR (edit-distance ≤2) — bắt vụ nhầm
  // số 0↔6 (59930002↔59930062) kể cả khi KHÔNG suy được theo tên HKD. Dedup theo tid, giữ thứ tự (HKD trước, gần sau).
  const suggestTidsFor = (hkdName: string | null | undefined, ocrTid?: string | null, opts?: { fallbackToanBo?: boolean }): { tid: string; hkdName: string }[] => {
    const seen = new Set<string>(); const merged: { tid: string; hkdName: string }[] = [];
    for (const s of [...suggestTidsByHkd(hkdName), ...(ocrTid ? nearestValidTids(ocrTid, allTidHkd, 2, hkdName ?? null) : [])])
      if (!seen.has(s.tid)) { seen.add(s.tid); merged.push(s); }
    // [Admin Demo 18/9 "bill không đọc được tên HKD cũng không cho chọn tên HKD và bị khóa gửi luôn à?"] OCR mù CẢ
    // tên HKD lẫn TID → hai nguồn gợi ý trên đều RỖNG → dropdown không hiện → người review không có đường chọn
    // tay nào, nút Gửi kẹt câm vĩnh viễn. Fallback (CHỈ ở nhánh bill KHÔNG route được — bill thành công mà cũng
    // đổ toàn bộ danh sách thì mọi máy đơn lẻ đều hiện dropdown 60 máy = nhiễu): đưa TOÀN BỘ danh sách máy, người
    // nhìn ảnh bill bằng mắt vẫn biết máy nào, chỉ cần CÓ CHỖ để chọn. Vẫn qua reroute server nên không bịa phí/phòng.
    if (merged.length === 0 && opts?.fallbackToanBo) {
      return allTidHkd
        .filter((r) => r.hkdName)
        .map((r) => ({ tid: r.tid, hkdName: r.hkdName as string }))
        .sort((a, b) => a.hkdName.localeCompare(b.hkdName, 'vi'));
    }
    return merged;
  };
  for (const bill of effectiveBills) {
    const at = parseBillDate(bill.dateTime) ?? now;
    let inferNote: string | null = null; // cờ khi TID được SUY từ tên HKD (chèn vào warnings để người xác nhận).
    // TID cần suy khi: RỖNG, HOẶC đọc RA nhưng KHÔNG có trong hệ thống (OCR nhầm số — Admin Demo 2/9 KHACH HANG 61 59530601).
    const ocrTidRaw = (bill.tid ?? '').trim();
    const tidInvalid = !!ocrTidRaw && !validTids.has(ocrTidRaw);
    if (!bill.tid || tidInvalid) {
      // SUY TID từ tên HKD OCR (khớp duy nhất) — chống tái diễn lô 83 + OCR-nhầm-số (Admin Demo "cấm tái diễn").
      const hkdKey = normalizeHkdKey(bill.agencyName);
      const cand = hkdKey ? hkdToTids.get(hkdKey) : undefined;
      if (cand && cand.length === 1) {
        bill.tid = cand[0]; // suy được TID duy nhất → route bình thường, nhưng CẮM CỜ để người xác nhận (không nuốt câm).
        // [Admin Demo 10/9 "mã máy đúng mà" — bớt phiền, KHÔNG bớt an toàn] Phân biệt 2 ca:
        //  · OCR ĐỌC RA TID nhưng SAI (không có trong hệ) → có thể là máy khác thật → GIỮ ⚠ (client bắt tick xác nhận).
        //  · OCR KHÔNG đọc được TID (mực mờ/TID không in rõ — đo thật: HKD DEMO 37/62 bill = 58% không ra
        //    TID) mà tên HKD khớp DUY NHẤT 1 máy → đây là suy an toàn: hạ xuống mức THÔNG TIN (ℹ), không bắt tick.
        inferNote = tidInvalid
          ? `⚠ OCR đọc TID "${ocrTidRaw}" KHÔNG có trong hệ thống (nhầm số) — đã SUY từ tên HKD "${bill.agencyName}" → TID ${bill.tid}. XÁC NHẬN đúng máy trước khi gửi.`
          : `ℹ TID không in rõ trên bill — khớp theo tên HKD "${bill.agencyName}" → TID ${bill.tid} (tên này chỉ thuộc đúng 1 máy trong hệ).`;
      } else {
        // Không suy được (không tên HKD, hoặc tên khớp >1 / 0 TID) → cần nhập tay, NHƯNG vẫn HIỆN tên HKD OCR đọc được
        // (không để "—" gây hoang mang) + số TID candidate nếu có nhiều.
        const why = !hkdKey ? (tidInvalid ? `OCR đọc TID "${ocrTidRaw}" không có trong hệ thống + không đọc được tên HKD` : 'OCR không đọc được TID và không có tên HKD') : (cand && cand.length > 1 ? `tên HKD "${bill.agencyName}" khớp ${cand.length} TID` : `tên HKD "${bill.agencyName ?? ''}" không khớp TID nào`);
        const head = tidInvalid ? `⚠ TID "${ocrTidRaw}" OCR đọc KHÔNG có trong hệ thống` : '⚠ OCR không đọc được TID';
        out.push({ bill, dealerRoomId: null, dealerRoomName: null, investorRoomId: null, investorRoomName: null, sellFee: null, installFee: null, alreadySent: false, warnings: [
          // Cờ RỦI RO ĐÓNG LÔ 95 PHẢI sống kể cả khi TID chưa xác định (nhánh nhập-tay) — trước đây bị nuốt ở đây làm
          // cảnh báo 95 không bắn khi TID nghi ngờ (money-risk). Đặt ĐẦU (nghiêm trọng nhất).
          ...(bill.settlementCode === '95' ? ['⚠ BILL ĐÓNG LÔ 95 — RỦI RO HOÀN TIỀN/HỦY GD SAU KHI NHẬN TIỀN. Kiểm kỹ trước khi gửi!'] : []),
          `${head} (${why}) — CHỌN/NHẬP TID tay.`
        ], dealerSummary: null, investorSummary: null, availableCardTypes: [], hkdName: bill.agencyName ?? null, bankName: null, tidSuggestions: suggestTidsFor(bill.agencyName, ocrTidRaw, { fallbackToanBo: true }) });
        continue;
      }
    }
    const routing = await resolveBillRouting(db, bill.tid);
    // [QUAN HỆ 2 CHIỀU TID↔HKD — Admin Demo 2/9 "làm chặt chẽ, cấm tái diễn"] TID hợp lệ NHƯNG tên HKD chuẩn của TID ≠
    // tên HKD OCR đọc → OCR NHẦM (số TID hoặc tên) → có thể route/tính tiền SAI MÁY khác (âm thầm, nguy hơn 'chưa uỷ').
    // Cờ ĐỎ bắt xác nhận. Bỏ qua khi TID vừa được SUY từ HKD (inferNote — khi đó khớp sẵn) hoặc OCR không đọc tên.
    // [H2 audit 2/9 — chống tái diễn] Đối chiếu 2 chiều qua hàm THUẦN classifyTidHkdMatch (test hành vi, R198).
    const kTidHere = normalizeHkdKey(routing.tidRow?.hkdName);
    const hkdMismatchNote = classifyTidHkdMatch({
      inferred: !!inferNote,
      tid: bill.tid,
      tidHkdName: routing.tidRow?.hkdName ?? null,
      ocrAgencyName: bill.agencyName,
      siblingCount: kTidHere ? (hkdToTids.get(kTidHere)?.length ?? 0) : 0
    }).note;
    const bank = routing.tidRow?.bankId != null ? await db.bank.findUnique({ where: { id: routing.tidRow.bankId }, select: { name: true } }) : null;
    // [18/9] Phí hiển thị lúc REVIEW cũng phải theo số GHI NHẬN (quẹt − hủy), nếu không thì con số người dùng
    // nhìn thấy trước khi gửi khác con số server dùng lúc gửi (split-brain đúng phần tiền hủy).
    const tienTinhPhiReview = tienGhiNhan(bill);
    const sellFee = await computeSellFeeLine(db, routing.tidRow, tienTinhPhiReview, at);
    const installFee = await computeInstallFeeLine(db, routing.tidRow, tienTinhPhiReview, at);
    const availableCardTypes = await listTidCardTypes(db, routing.tidRow, at);
    const sendKey = ocrSendKey(bill.tid, loHienThi(bill.batchNumber, bill.settlementCode) || bill.batchNumber, bill.dateTime, bill.totalAmount);
    const alreadyS = routing.dealerRoomId ? await alreadySent(db, routing.dealerRoomId, sendKey) : false;
    // [Admin Demo 2/9 "bill đã gửi CHỈ cập nhật tại chỗ, không nhân đôi"] tin ĐẠI LÝ đã gửi → client re-OCR sửa TRÊN tin đó
    // (editBillParams) thay vì gửi trùng. Tìm marker key MỚI hoặc CŨ (bỏ đuôi amt — backward-compat).
    let sentMessageId: string | null = null;
    if (alreadyS && routing.dealerRoomId) {
      const legacyKey = sendKey.replace(/\|amt:\d+$/, '');
      const hit = await db.chatMessage.findFirst({
        where: { roomId: routing.dealerRoomId, deletedAt: null, OR: [ // [A-M1 21/9] tin xoá không phải "đã gửi"
          { metadataJson: { contains: `"ocrSendKey":${JSON.stringify(sendKey)}` } },
          ...(legacyKey !== sendKey ? [{ metadataJson: { contains: `"ocrSendKey":${JSON.stringify(legacyKey)}` } }] : [])
        ] },
        select: { id: true }, orderBy: { createdAt: 'desc' }
      });
      sentMessageId = hit?.id ?? null;
    }
    // [Admin Demo 8/9 — GATE SỐ LÔ] Đối chiếu số lô với DÃY LÔ THẬT của máy + các máy cùng họ HKD: bắt "lô nhảy vọt"
    // (nghi đọc nhầm SỐ HOÁ ĐƠN/TRACE — ca TUẤN ĐẠT 1: 65 → 500) và "gán nhầm máy" (ca lô 101 của XUÂN ĐOÀN 3 bị
    // gán XUÂN ĐOÀN 2). Lỗi truy vấn KHÔNG chặn luồng nhưng phải log (R198: không nuốt im).
    // [Admin Demo 8/9] GATE NGÀY BILL — ca thật lô 102 XUÂN ĐOÀN 3: quẹt 08/09 mà OCR đọc 08/05 (nhầm tháng).
    let canhBaoLo: string[] = kiemTraNgayBill(bill.dateTime, now);
    // [A-M2 21/9] TIỀN HỦY bất thường phải KÊU trên card (R198 — tienGhiNhan nuốt câm ca huy>tong bằng cách bỏ trừ):
    //   · huy > tổng quẹt = OCR đọc lệch số (hủy không thể vượt quẹt) → doanh số đang tính KHÔNG trừ hủy.
    //   · có tiền hủy mà 0 GD hủy = nghi OCR gán nhầm dòng — người review phải nhìn ảnh xác nhận trước khi gửi.
    {
      const huyRv = Math.round(Number(bill.voidAmount) || 0);
      const tongRv = Math.round(Number(bill.totalAmount) || 0);
      if (huyRv > 0 && huyRv > tongRv) canhBaoLo.push(`🔴 Tiền HỦY (${huyRv.toLocaleString('vi-VN')}đ) LỚN HƠN tổng quẹt (${tongRv.toLocaleString('vi-VN')}đ) — OCR đọc lệch, hệ TẠM KHÔNG trừ hủy. Sửa số hủy cho đúng trước khi gửi.`);
      else if (huyRv > 0 && (Number(bill.voidCount) || 0) === 0) canhBaoLo.push(`⚠ Có tiền HỦY ${huyRv.toLocaleString('vi-VN')}đ nhưng SỐ GD HỦY = 0 — nghi OCR gán nhầm dòng. Nhìn ảnh xác nhận trước khi gửi.`);
    }
    const soLoDoc = Number(String(bill.batchNumber ?? '').replace(/[^0-9]/g, ''));
    if (bill.tid && Number.isFinite(soLoDoc) && soLoDoc > 0) {
      try {
        const dayLo = await layDayLoCungHo(db, bill.tid.trim());
        const meTid = dayLo.find((m) => m.tid === bill.tid?.trim());
        if (meTid) canhBaoLo = [...canhBaoLo, ...kiemTraSoLo({ tidId: meTid.tidId, lo: soLoDoc }, dayLo).canhBao];
      } catch (err) {
        console.error('[ocr-send] gate số lô lỗi (không chặn gửi):', err);
      }
    }
    const [dealerRoom, investorRoom] = await Promise.all([
      routing.dealerRoomId ? db.chatRoom.findUnique({ where: { id: routing.dealerRoomId }, select: { name: true } }) : Promise.resolve(null),
      routing.investorRoomId ? db.chatRoom.findUnique({ where: { id: routing.investorRoomId }, select: { name: true } }) : Promise.resolve(null)
    ]);
    out.push({
      bill,
      dealerRoomId: routing.dealerRoomId,
      dealerRoomName: dealerRoom?.name ?? null,
      investorRoomId: routing.investorRoomId,
      investorRoomName: investorRoom?.name ?? null,
      sellFee,
      installFee,
      alreadySent: alreadyS,
      sentMessageId,
      // CẢNH BÁO NGHIÊM TRỌNG ĐÓNG LÔ 95 (Admin Demo, money) — mã ĐÓNG(95) = rủi ro hoàn tiền/hủy GD SAU khi nhận
      // tiền → đặt ĐẦU danh sách (mức cao nhất). UI hiện banner đỏ + bắt xác nhận trước khi gửi.
      warnings: [
        ...(bill.settlementCode === '95' ? ['⚠ BILL ĐÓNG LÔ 95 — RỦI RO HOÀN TIỀN/HỦY GD SAU KHI NHẬN TIỀN. Kiểm kỹ trước khi gửi!'] : []),
        ...(hkdMismatchNote ? [hkdMismatchNote] : []),
        ...(inferNote ? [inferNote] : []),
        ...canhBaoLo,
        ...routing.warnings
      ],
      // [Admin Demo 3/9 "HKD nhiều máy phải hiện dropdown chọn đúng máy"] LUÔN gợi ý các TID CÙNG HỌ HKD (1/2/3...) khi HKD
      // có ≥2 máy — KHÔNG chỉ khi nghi ngờ (để anh chủ động chọn/đổi đúng máy). Ưu tiên tên OCR; fallback tên TID route.
      // [Admin Demo 18/9 lần 2 — "chưa chọn được trong đối chiếu bill à?"] Bản đầu chỉ fallback khi bill KHÔNG route
      // được ⇒ bill đọc RA TID nhưng tên HKD mờ/cắt thì khối đối chiếu vẫn KHÔNG có chỗ chọn tên. Nay bill NÀO
      // cũng có danh sách đầy đủ để ĐỐI CHIẾU + đổi máy (dropdown hiển thị tên máy đang chọn, đổi = có chủ đích
      // qua reroute server — không bịa phí/phòng).
      tidSuggestions: suggestTidsFor(bill.agencyName ?? routing.tidRow?.hkdName ?? null, bill.tid, { fallbackToanBo: true }),
      dealerSummary: buildDealerSummary(bill.tid, bill, sellFee, installFee),
      investorSummary: routing.investorRoomId ? buildInvestorSummary(bill.tid, bill, installFee, routing.tidRow?.hkdName ?? null) : null,
      availableCardTypes,
      hkdName: routing.tidRow?.hkdName ?? bill.agencyName ?? null,
      bankName: bank?.name ?? null
    });
  }
  await ganTheDangGhi(db, out);
  return out;
}

/** [Admin Demo 28/9 "ảnh đã ocr rồi, đã chọn thẻ để sửa, ocr lại đúng ảnh đấy lô đấy phải ghi nhớ thẻ đã được sửa,
 *  đây là chọn lại mặc định là sai"] NHỚ THẺ ĐÃ SỬA.
 *
 *  LỖI: người quét bill → đổi loại thẻ cho đúng → ghi doanh số. Quét LẠI chính ảnh/lô đó thì card review lại
 *  hiện THẺ MẶC ĐỊNH (Visa-Master), xoá sạch lựa chọn cũ ⇒ bấm lưu là đổi phí câm sang thẻ sai.
 *  Trước đây chỉ đường "mở bill đã ghi để sửa" (route prepare-edit) mới tra lô để lấy thẻ đang ghi; đường QUÉT
 *  (thủ công / tự động / quét folder) KHÔNG đi qua đó nên luôn rơi về mặc định.
 *  NAY đặt ở CUỐI reviewBills — nơi MỌI đường quét đều đi qua — nên không đường nào sót.
 *
 *  Chỉ GỢI Ý lại thẻ đã ghi (currentCardTypeId/currentSplits), KHÔNG tự đổi phí: client vẫn hiển thị để người
 *  xác nhận. Lỗi tra lô → bỏ qua, không chặn review (nhưng ghi log rõ, không nuốt câm — R198). */
async function ganTheDangGhi(db: Db, items: ReviewItem[]): Promise<void> {
  const can = items.filter((it) => it.bill.tid && it.bill.batchNumber && it.currentCardTypeId == null && it.currentSplits == null);
  if (can.length === 0) return;
  try {
    const bot = await ensureSupportAlphaAgent(db);
    for (const it of can) {
      // GIỮ dạng lô "84(95)" — strip hết ký-tự-không-số làm key thành nat|tid|8495| không khớp billKey thật.
      const key = `nat|${it.bill.tid}|${String(it.bill.batchNumber).replace(/[^0-9()]/g, '')}|`;
      const lo = await db.lo.findFirst({
        where: { agentId: bot.id, billKey: { startsWith: key }, status: { not: 'CANCELLED' } },
        orderBy: { id: 'desc' }, select: { id: true }
      });
      if (!lo) continue;
      const rows = await db.loRow.findMany({ where: { loId: lo.id }, select: { cardTypeId: true, amountBeforeFee: true } });
      if (rows.length === 1) it.currentCardTypeId = rows[0]!.cardTypeId;
      else if (rows.length > 1) it.currentSplits = rows.map((r) => ({ cardTypeId: r.cardTypeId as number, amount: Number(r.amountBeforeFee) }));
    }
  } catch (err) {
    console.error('[review] KHÔNG tra được thẻ đang ghi của lô — card sẽ về thẻ mặc định:', err instanceof Error ? err.message : err);
  }
}

/** dd/mm/yyyy [HH:mm] → Date (local) hoặc null. */
function parseBillDate(dateTime: string | null): Date | null {
  if (!dateTime) return null;
  const m = /(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(dateTime);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] ?? 12), Number(m[5] ?? 0));
}

/** Bot SigMa là thành viên ADMIN đang-hoạt-động của phòng (gửi được cả khi readOnly). Idempotent. */
async function ensureBotMember(db: Db, roomId: string, botId: number): Promise<void> {
  await db.chatRoomMember.upsert({
    where: { roomId_agentId: { roomId, agentId: botId } },
    update: { leftAt: null, role: 'ADMIN' },
    create: { roomId, agentId: botId, role: 'ADMIN' }
  });
}

export interface SendBillInput {
  tid: string;
  bill: OcrBill;
  imageBuffer: Buffer; // ảnh bill THÔ (fallback nếu không có composite)
  imageName: string; // tên file gợi ý (đuôi để sniff)
  // Ảnh CARD (bill + bảng) render client-side (Admin Demo 31/8) — KHÁC nhau đại lý/NĐT (bảo mật). Thiếu → imageBuffer.
  dealerImageBuffer?: Buffer;
  investorImageBuffer?: Buffer;
  dealerRoomId: string;
  investorRoomId: string | null;
  sell: FeeLine;
  install: FeeLine;
  bankName?: string | null; // ngân hàng (cho posBill meta card — Admin Demo 1/9 "đủ params bank/ngày sang blog").
  allowDuplicate?: boolean; // true = người đã bấm "vẫn gửi" ở cảnh báo trùng
  actorAgentId?: number | null; // SEC-MED audit (deep-audit 1/9): agent NGƯỜI THẬT bấm gửi (tin gắn senderId=bot).
}
export interface SendBillResult {
  ok: boolean;
  duplicate: boolean; // đã tồn tại bill này ở phòng đại lý
  dealerMessageId?: string;
  investorMessageId?: string;
  investorSkippedReason?: string;
  completedPartial?: boolean; // gửi lại HOÀN TẤT bên còn thiếu (dealer đã gửi trước, NĐT vừa cc bổ sung) — KHÔNG phải trùng.
  error?: string;
}

/** GỬI 1 bill: đăng ảnh+tóm-tắt(phí BÁN) vào NHÓM ĐẠI LÝ + cc ảnh+tóm-tắt(phí CÀI) vào NHÓM NĐT. Idempotent theo
 *  ocrSendKey: đã gửi + !allowDuplicate → trả duplicate=true (KHÔNG gửi lại, caller cảnh báo). allowDuplicate=true
 *  → vẫn gửi + đánh dấu isDuplicate trong metadata (Admin Demo "vẫn gửi phải báo trùng"). */
/** LÕI QUYẾT ĐỊNH gửi bill POS (THUẦN, test được) — dedup THEO TỪNG ĐÍCH (đại lý/NĐT). `invSent` đã =true khi không
 *  có NĐT. Đã gửi ĐỦ (cả 2) + !allowDuplicate → trùng (chặn). Partial (dealer gửi, NĐT chưa) → chỉ gửi NĐT (hoàn tất,
 *  KHÔNG gửi lại dealer = không rác/đếm đôi). allowDuplicate → gửi lại cả 2. Admin Demo 1/9 "rớt mạng chưa gửi 1 trong 2". */
export function decideBillSendTargets(o: { dealerSent: boolean; invSent: boolean; hasInvestor: boolean; allowDuplicate: boolean }): { isDuplicate: boolean; doDealer: boolean; doInvestor: boolean } {
  // CHẶN CỨNG như bill CK (Admin Demo 1/9 "trùng bấm gửi VẪN KHÔNG gửi, cấm gửi trùng"): đã gửi ĐỦ cả 2 đích →
  // isDuplicate, KHÔNG post lại DÙ allowDuplicate (bỏ bypass "vẫn gửi" cũ). CHỈ HOÀN TẤT bên CHƯA gửi (partial rớt
  // mạng) — KHÔNG re-post bên đã gửi (chống rác/đếm đôi). Không bỏ sót (partial vẫn hoàn tất), không báo lỗi nhầm.
  if (o.dealerSent && o.invSent) return { isDuplicate: true, doDealer: false, doInvestor: false };
  return { isDuplicate: false, doDealer: !o.dealerSent, doInvestor: o.hasInvestor && !o.invSent };
}

/** [Admin Demo 4/9] Tiền tố cảnh báo caption khi BILL ĐÓNG LÔ 95 (rủi ro hoàn/hủy GD sau nhận tiền). Rỗng nếu không 95.
 *  THUẦN để test — ghim cảnh báo lên tin nhắn gửi kèm ảnh bill (cả phòng đại lý + NĐT). */
export function bill95CaptionPrefix(settlementCode: string | null | undefined): string {
  return String(settlementCode ?? '').replace(/[^0-9]/g, '') === '95' ? '⚠️ ĐÓNG LÔ 95 — RỦI RO HOÀN/HỦY GD · ' : '';
}

export async function sendBillToDealerAndInvestor(db: Db, input: SendBillInput): Promise<SendBillResult> {
  const key = ocrSendKey(input.tid, loHienThi(input.bill.batchNumber, input.bill.settlementCode) || input.bill.batchNumber, input.bill.dateTime, input.bill.totalAmount);
  // [Admin Demo 3/9] HASH ẢNH BILL (sha256) — ĐỊNH DANH ỔN ĐỊNH không phụ thuộc OCR đọc số (tid/lô/tiền chập chờn).
  // Lưu vào metadata tin gửi → review sau nhận diện "ĐÃ GỬI" theo ẢNH kể cả khi OCR đọc lệch → luôn buộc Cập nhật,
  // CẤM gửi mới (chống doanh số x2 khi billKey đổi theo TID sửa). Nối imageSentMarker/findSentByImageHash bên dưới.
  const imgHash = ocrImageHashOf(input.imageBuffer);
  // [Audit 3/9 #1 CRITICAL] CHỐNG x2 CROSS-PHÒNG (fail-closed): ảnh này ĐÃ GỬI cho phòng đại lý KHÁC (do OCR đọc lệch
  // TID hoặc user sửa TID sang máy KHÁC PHÒNG). Dedup theo-phòng (alreadySent/reserveSend) + billKey theo-tid đều
  // room/tid-scoped → phòng mới KHÔNG thấy bản gốc → tạo tin + Lô THỨ 2 (x2 doanh số + tiền vào SAI máy). 1 ẢNH = 1
  // bill = chỉ 1 phòng. Chặn CỨNG: đã gửi phòng khác → KHÔNG gửi mới, buộc "Cập nhật tin cũ" (đúng máy/phòng gốc).
  const gPrev = await findSentByImageHashGlobal(db, imgHash);
  if (gPrev && gPrev.roomId !== input.dealerRoomId) {
    return { ok: false, duplicate: true, error: 'IMAGE_SENT_OTHER_ROOM' };
  }
  // DEDUP THEO TỪNG ĐÍCH (Admin Demo 1/9 "rớt mạng chưa gửi 1 trong 2 NĐT/đại lý thì sao"): marker ocrSendKey ghi ở CẢ
  // phòng đại lý LẪN phòng NĐT → biết ĐÃ gửi đâu, CHƯA gửi đâu. Gửi lại (không allowDuplicate) = HOÀN TẤT bên THIẾU,
  // KHÔNG gửi lại bên đã gửi (chống rác + đếm đôi). Chỉ khi ĐÃ gửi ĐỦ cả 2 mới báo duplicate.
  const dealerSent = await alreadySent(db, input.dealerRoomId, key);
  const invSent = input.investorRoomId ? await alreadySent(db, input.investorRoomId, key) : true; // không có NĐT = coi như "đủ"
  const plan = decideBillSendTargets({ dealerSent, invSent, hasInvestor: !!input.investorRoomId, allowDuplicate: input.allowDuplicate === true });
  if (plan.isDuplicate) return { ok: false, duplicate: true }; // đã gửi ĐỦ (dealer + NĐT nếu có) → trùng thật
  const { doDealer, doInvestor } = plan;

  // FIX #5b — ĐẶT CHỖ nguyên tử TRƯỚC khi gửi DEALER (chống 2 phiên gửi dealer song song). Chỉ khi thực gửi dealer.
  let reserved = false;
  if (doDealer && !input.allowDuplicate) {
    try { reserved = await reserveSend(db, input.dealerRoomId, key); }
    catch { reserved = true; /* bảng lỗi → fail-open, còn dealerSent ở trên */ }
    if (!reserved) return { ok: false, duplicate: true }; // phiên song song đã đặt chỗ
  }
  const releaseIfReserved = async (): Promise<void> => { if (reserved) await releaseSend(db, input.dealerRoomId, key).catch(() => {}); };

  try {
    const bot = await ensureAlphaBotAgent(db);
    const result: SendBillResult = { ok: true, duplicate: dealerSent && invSent };
    // ── ĐẠI LÝ ──
    let dealerMsgId: string | undefined;
    if (doDealer) {
      await ensureBotMember(db, input.dealerRoomId, bot.id);
      // Admin Demo 1/9 "ảnh chỉ là bill, params sang blog ngang": đính ẢNH RAW (input.imageBuffer), KHÔNG composite
      // bill+bảng nữa — card đọc `posBill` meta hiện đủ Bank/HKD/TID/Ngày/Tiền/Lô/Phí. dealer = PHÍ BÁN.
      // [11/9] settlementCode LƯU vào posBill meta: prepare-edit đọc lại pb.settlementCode (trước đây LUÔN undefined
      // → mở sửa mất cờ 95 + type dựng sai) + bản-sửa-theo-ảnh giữ được cờ rủi ro.
      // [A-C1 21/9] posBill LƯU CẢ voidAmount/voidCount — thiếu thì mọi đường sửa/bản-sửa-theo-ảnh mất dấu tiền hủy.
      const posBase = { tid: input.tid, hkd: input.bill.agencyName ?? null, bank: input.bankName ?? null, dateTime: input.bill.dateTime ?? null, amount: input.bill.totalAmount, lo: input.bill.batchNumber ?? null, settlementCode: input.bill.settlementCode ?? null, voidAmount: input.bill.voidAmount ?? 0, voidCount: input.bill.voidCount ?? 0 };
      const dealerAtt = await saveAttachment(db, input.imageBuffer, input.imageName, bot.id);
      if (!dealerAtt.ok) { await releaseIfReserved(); return { ok: false, duplicate: false, error: `ATT_FAIL:${dealerAtt.reason}` }; }
      // netLabel/netAmount (Admin Demo 1/9 "card thiếu số tiền PHẢI HOÀN sau phí bán"): đại lý = tiền phải hoàn cho
      // khách = tổng − phí bán. Chỉ set khi phí resolved (có số phí thật) để không hiện số sai.
      // [A-H4 21/9] "Phải hoàn" = SỐ GHI NHẬN (quẹt − hủy) − phí — gross − phí là đòi đại lý THỪA đúng tiền hủy.
      const dealerNet = input.sell.resolved && input.sell.amount != null ? tienGhiNhan(input.bill) - input.sell.amount : null;
      const dealerMeta = JSON.stringify({ isBillImage: true, ocrSendKey: key, ocrImageHash: imgHash, ocrLo: input.bill.batchNumber ?? null, sentByAgentId: input.actorAgentId ?? null, isDuplicate: dealerSent && input.allowDuplicate ? true : undefined, posBill: { ...posBase, feeLabel: 'Phí bán', feePct: input.sell.resolved && input.sell.milli != null ? input.sell.milli / 1000 : null, netLabel: 'Phải hoàn', netAmount: dealerNet } });
      const dupPrefix = dealerSent && input.allowDuplicate ? '⚠️ [GỬI LẠI - TRÙNG] ' : '';
      // [Admin Demo 4/9] BILL ĐÓNG LÔ 95 = rủi ro hoàn/hủy GD sau khi nhận tiền → GHIM cảnh báo NGAY đầu caption tin nhắn
      // gửi kèm ảnh bill (đại lý + NĐT thấy liền, không sót). settlementCode chuẩn hoá chỉ-số ở normalizeBill.
      const warn95 = bill95CaptionPrefix(input.bill.settlementCode); // ghim 95 đầu caption đại lý
      const dealerBody = `${dupPrefix}${warn95}🧾 Bill ${input.tid}${input.bill.agencyName ? ` · ${input.bill.agencyName}` : ''} · ${fmtVnd(input.bill.totalAmount)}đ${input.bill.batchNumber ? ` · lô ${loHienThi(input.bill.batchNumber, input.bill.settlementCode)}` : ''}`;
      const dealerMsg = await sendMessage(db, { roomId: input.dealerRoomId, senderId: bot.id, kind: 'IMAGE', body: dealerBody, attachmentId: dealerAtt.id, metadataJson: dealerMeta });
      broadcastToRoom(input.dealerRoomId, { msg: 'new-message', roomId: input.dealerRoomId, message: dealerMsg });
      dealerMsgId = dealerMsg.id;
    } else {
      // Dealer ĐÃ gửi trước (partial) → KHÔNG gửi lại; lấy id tin cũ làm nguồn cross-post cho NĐT.
      const ex = await db.chatMessage.findFirst({ where: { roomId: input.dealerRoomId, metadataJson: { contains: `"ocrSendKey":${JSON.stringify(key)}` } }, select: { id: true }, orderBy: { createdAt: 'desc' } });
      dealerMsgId = ex?.id;
    }
    result.dealerMessageId = dealerMsgId;
    // ── NĐT (cc) ──
    if (doInvestor && input.investorRoomId) {
      // ATOMIC guard NĐT (Admin Demo 1/9 "2-3 user Zalo khác cùng OCR+gửi thì ngăn kiểu gì"): reserveSend(investorRoomId,
      // key) — INSERT ON CONFLICT nguyên tử, ĐỒNG NHẤT cơ chế đại lý → 2 phiên cùng cc NĐT chỉ 1 thắng. allowDuplicate bỏ gate.
      const invReserved = input.allowDuplicate ? true : await reserveSend(db, input.investorRoomId, key).catch((e) => { console.error('[reserveSend] LỖI DB (fail-open — dedup tầng tin vẫn chặn):', e instanceof Error ? e.message : e); return true; });
      if (!invReserved) {
        result.investorSkippedReason = 'CONCURRENT'; // phiên khác đang/đã cc NĐT — không gửi trùng
      } else {
        await ensureBotMember(db, input.investorRoomId, bot.id);
        const invAtt = await saveAttachment(db, input.imageBuffer, input.imageName, bot.id); // ẢNH RAW (như đại lý)
        if (invAtt.ok) {
          // Ghi ocrSendKey Ở PHÒNG NĐT → biết NĐT đã nhận (chống gửi lại NĐT). + nguồn cross-post. NĐT = PHÍ CÀI MÁY.
          // NĐT: tiền VỀ sau phí cài máy = tổng − phí cài (khác nhãn với đại lý). Chỉ set khi phí resolved.
          const invNet = input.install.resolved && input.install.amount != null ? tienGhiNhan(input.bill) - input.install.amount : null;
          const invMeta = JSON.stringify({ isBillImage: true, ocrSendKey: key, sentByAgentId: input.actorAgentId ?? null, alphaCrossPostSourceId: dealerMsgId, posBill: { tid: input.tid, hkd: input.bill.agencyName ?? null, bank: input.bankName ?? null, dateTime: input.bill.dateTime ?? null, amount: input.bill.totalAmount, lo: input.bill.batchNumber ?? null, settlementCode: input.bill.settlementCode ?? null, feeLabel: 'Phí cài máy', feePct: input.install.resolved && input.install.milli != null ? input.install.milli / 1000 : null, netLabel: 'Tiền về', netAmount: invNet } });
          const inv95 = bill95CaptionPrefix(input.bill.settlementCode); // ghim 95 caption NĐT
          const invBody = `${inv95}🧾 Bill ${input.tid} · ${fmtVnd(input.bill.totalAmount)}đ${input.bill.batchNumber ? ` · lô ${loHienThi(input.bill.batchNumber, input.bill.settlementCode)}` : ''}`;
          const invMsg = await sendMessage(db, { roomId: input.investorRoomId, senderId: bot.id, kind: 'IMAGE', body: invBody, attachmentId: invAtt.id, metadataJson: invMeta });
          broadcastToRoom(input.investorRoomId, { msg: 'new-message', roomId: input.investorRoomId, message: invMsg });
          result.investorMessageId = invMsg.id;
        } else {
          if (!input.allowDuplicate) await releaseSend(db, input.investorRoomId, key).catch(() => {}); // nhả chỗ NĐT để thử lại
          result.investorSkippedReason = `ATT_FAIL:${invAtt.reason}`;
        }
      }
    } else if (!input.investorRoomId) {
      result.investorSkippedReason = 'NO_INVESTOR_ROOM';
    } else {
      result.investorSkippedReason = 'ALREADY_SENT'; // NĐT đã nhận trước — không gửi lại (không trùng).
    }
    // partial VỪA HOÀN TẤT (dealer trước đó, NĐT vừa gửi) — báo caller để hiện "đã cc bổ sung NĐT", KHÔNG phải trùng.
    if (dealerSent && !invSent && result.investorMessageId) result.completedPartial = true;
    return result;
  } catch (e) {
    await releaseIfReserved(); // gửi ném lỗi → nhả chỗ, KHÔNG khoá vĩnh viễn bill này
    throw e;
  }
}
