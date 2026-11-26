// SIGMA "Quét bill gửi" (30/8) — client gọi bot-api /v1/ocr-send/* (apps/bot-api/src/routes/ocr-send.ts).
// CÙNG khuôn diary-api.ts (proxyFetch + AgentApiResult). Type mirror THỦ CÔNG DTO ocr-send-service.ts (2 app build
// riêng, KHÔNG import chéo — field PHẢI khớp chính xác, đổi 1 bên đổi bên kia tay).
import { PARSE_ERROR_VI, networkErrorMessage } from './error-i18n';
import { proxyFetch } from './proxy-fetch';
import { botApiBaseUrl, type AgentApiResult } from './diary-api';

// ── DTO (mirror ocr-send-service.ts) ─────────────────────────────────────────────────────────────────────
export interface OcrBill {
  tid: string | null;
  agencyName: string | null;
  batchNumber: string | null;
  type: 'SALE' | 'SETTLEMENT';
  totalAmount: number;
  dateTime: string | null;
  settlementCode?: string | null; // mã ĐÓNG(nn) — '95' = cảnh báo rủi ro hoàn/hủy GD sau (Admin Demo)
  /** [Admin Demo 17/9] Dòng "HỦY" trên tờ TỔNG KẾT (ABBank: "HỦY 1 VND11,000"). totalAmount vẫn là TỔNG QUẸT;
   *  tiền GHI NHẬN = totalAmount − voidAmount (tienGhiNhanBill) — hiện rõ trên mọi màn review. */
  voidCount?: number | null;
  voidAmount?: number | null;
}

/** Tiền GHI NHẬN của bill = tổng quẹt − tiền hủy. Hủy ≤ 0 hoặc > tổng (OCR lệch cột) → giữ nguyên tổng. */
export function tienGhiNhanBill(b: { totalAmount: number; voidAmount?: number | null }): number {
  const tong = Math.round(Number(b.totalAmount) || 0);
  const huy = Math.round(Number(b.voidAmount) || 0);
  return huy > 0 && huy <= tong ? tong - huy : tong;
}
export interface FeeBreakdownPart { cardTypeId: number; cardName?: string; amount: number; milli: number; fee: number; }
export interface FeeLine { resolved: boolean; milli?: number; amount?: number; note?: string; breakdown?: FeeBreakdownPart[]; }
export interface CardTypeOpt { id: number; name: string; bankId: number; isPrimary: boolean; }
export interface ReviewItem {
  bill: OcrBill;
  dealerRoomId: string | null;
  dealerRoomName: string | null;
  investorRoomId: string | null;
  investorRoomName: string | null;
  sellFee: FeeLine | null;
  installFee: FeeLine | null;
  alreadySent: boolean;
  sentMessageId?: string | null; // [Admin Demo 2/9] id tin đại lý đã gửi → re-OCR sửa TẠI CHỖ (không gửi trùng).
  tidSuggestions?: { tid: string; hkdName: string }[]; // [Admin Demo 2/9] gợi ý TID cùng họ HKD khi TID nghi ngờ.
  warnings: string[];
  dealerSummary: string | null;
  investorSummary: string | null;
  availableCardTypes: CardTypeOpt[];
  /** [Admin Demo 8/9] Thẻ ĐANG GHI trên lô khi mở bill cũ để sửa (mở đúng thẻ thực tế, không nhảy về thẻ mặc định). */
  currentCardTypeId?: number | null;
  currentSplits?: { cardTypeId: number; amount: number }[] | null;
  hkdName: string | null;
  bankName: string | null;
}
// BILL CHUYỂN KHOẢN HOÀN TIỀN ĐẠI LÝ (Admin Demo 31/8) — mirror ocr-send-service.ts TransferReview.
export interface TransferReview {
  senderName: string | null;   // người GỬI = nhân sự SigMa đi hoàn
  senderIsAlpha: boolean;       // sender khớp danh sách người SigMa đã biết → chắc chắn bill hoàn
  receiverName: string | null;  // người NHẬN (đại lý thụ hưởng)
  content: string | null;       // nội dung/memo (chứa tên đại lý)
  amount: number;
  bank: string | null;            // NGÂN HÀNG BÊN NHẬN (OCR đọc được)
  /** NGÂN HÀNG NGƯỜI GỬI (Admin Demo 2/9) — OCR KHÔNG đọc được; học qua sender-bank-alias theo STK/tên người gửi. null
   *  nếu chưa học → UI cho khai báo + ghi nhớ. */
  senderBank: string | null;
  /** [Admin Demo 16/9] NGÂN HÀNG CỦA APP chụp bill (OCR đọc logo/chân trang) — dùng miễn chặn trùng giờ+tiền khi 2 bill
   *  từ 2 bank gửi khác nhau. Client chỉ mang theo (passthrough), không sửa. */
  appBank?: string | null;
  date: string | null;
  /** [Admin Demo 8/9] GIỜ trên biên lai CK (OCR có đọc, trước đây bị rơi ở tầng review). */
  time: string | null;
  matchedRoomId: string | null;   // nhóm đại lý khớp (fuzzy tên nhóm) — null nếu chưa chắc
  matchedRoomName: string | null;
  needsManualPick: boolean;       // true → user phải chọn tay (cấm gửi nhầm)
  warnings: string[];
  senderAccount?: string | null;
  receiverAccount?: string | null;
  direction?: 'SIGMA_TO_DEALER' | 'SIGMA_TO_DEALER_ADVANCE' | 'DEALER_TO_ALPHA' | 'INVESTOR_TO_ALPHA' | 'SIGMA_TO_INVESTOR' | 'UNKNOWN';
  entityType?: 'DEALER' | 'INVESTOR' | null;
  entityId?: number | null;
  /** Bill CK này ĐÃ GỬI vào phòng đích rồi (khớp ckTxnKey ref/nat) — cảnh báo TRƯỚC khi gửi (Admin Demo 1/9). */
  alreadySent?: boolean;
  /** [Admin Demo 3/9] id tin CK đã gửi (khớp ckTxnKey có ảnh) — khôi phục kind ứng/hoàn đã chọn khi OCR lại. */
  sentMessageId?: string | null;
}
// BILL QR BÁN HÀNG (Đợt 2, Admin Demo 5/9) — mirror ocr-send-service.ts QrReviewItem. Màn "Thanh toán thành công":
// HKD (Nhà cung cấp) + Số tiền + Số giao dịch (ref) + Ngày thực hiện + Từ (thẻ khách). Tiền vào TK HKD = DOANH SỐ.
export interface QrReviewItem {
  qr: { hkdName: string | null; amount: number; ref: string | null; dateTime: string | null; fromCard: string | null;
        /** Tên chủ thẻ (chỉ ảnh THÔNG BÁO GIAO DỊCH THẺ) — điền sẵn ô "tên người quẹt" + thu hẹp gợi ý báo-có. */
        payerName?: string | null;
        /** Nơi quẹt in trên thông báo (vd "VIB QR PUSH") — chỉ để đối chiếu bằng mắt. */
        noticeMerchant?: string | null };
  /** [Admin Demo 10/9] Ảnh là THÔNG BÁO GIAO DỊCH THẺ (ngân hàng gửi chủ thẻ): KHÔNG in tên HKD/Số giao dịch → thiếu
   *  2 trường đó là bình thường, phải khớp BÁO-CÓ mới ra mã QR + Số GD rồi mới gửi được. */
  noticeOnly?: boolean;
  tidId: number | null;
  tidCode: string | null;
  hkdNameMatched: string | null;
  partnerId: number | null;
  receiveAccountId: number | null;
  industryId: number | null;
  sellFeeMilli: number | null;     // phí bán ×1000 — bậc CHỜ (mặc định)
  sellFeeMilliNhanh: number | null; // [Admin Demo 11/9] phí bán ×1000 bậc TIỀN NHANH; null = mã không có bậc nhanh
  refundAmountNhanh: number | null; // = amount − phí bán nhanh
  sellFeeAmount: number | null;    // phí bán VND
  partnerFeeMilli: number | null;  // phí mua (đối tác) ×1000
  refundAmount: number | null;     // = amount − phí bán (số HOÀN đại lý)
  investorReceiveAmount: number | null; // NĐT về = trọn amount (phí cài máy QR = 0)
  feeSource: 'MERCHANT' | 'PARTNER' | null;   // nguồn giá MUA (mã / đối tác)
  sellFeeSource: 'DEALER' | 'DEFAULT' | null; // giá BÁN: đè theo đại lý (DEALER) hay mặc định mã (DEFAULT)
  isWeekend: boolean;
  dealerRoomId: string | null;     // đại lý mặc định (folder-name) — dropdown liệt kê hết
  dealerRoomName: string | null;
  alreadySent: boolean;
  warnings: string[];
  blocked: boolean;                // true = chặn gửi (kèm lý do trong warnings, R198)
}
export interface QrSendResult {
  ok: boolean;
  transactionId?: number;
  dealerRoomId?: string;
  revenue?: { ok: boolean; amount: number; sellFeeMilli: number; sellFeeAmount: number; partnerFeeMilli: number; refundAmount: number; investorReceiveAmount: number; isWeekend: boolean; feeSource: 'MERCHANT' | 'PARTNER' | null };
  refund?: { ok: boolean; messageId?: string; deduped?: boolean; error?: string; message?: string };
}
/** GỬI + GHI DOANH SỐ + HOÀN bill QR. dealerId = roomId đại lý CHỌN từ dropdown. Server re-review + reserve + ghi + hoàn. */
export function sendQr(payload: { token: string; qr: { hkdName: string | null; ref: string | null; amount: number; dateTime: string | null }; dealerId: string; payerName?: string | null; giaNhanh?: boolean }): Promise<AgentApiResult<QrSendResult>> {
  return jsonCall('/v1/ocr-send/send-qr', payload);
}
/** [Admin Demo 5/9 phí bán tùy khách] ĐỔI đại lý (dropdown) → server TÍNH LẠI phí bán/hoàn theo giá bán của đại lý đó.
 *  [Admin Demo 11/9] token ảnh gửi kèm → server augment lại cờ "ĐÃ GỬI theo ẢNH" (không rơi cờ khi item bị thay mới). */
export function qrReviewForDealer(payload: { qr: { hkdName: string | null; ref: string | null; amount: number; dateTime: string | null }; dealerId: string; token?: string }): Promise<AgentApiResult<{ item: QrReviewItem | null }>> {
  return jsonCall('/v1/ocr-send/qr-review-dealer', payload);
}
/** [Admin Demo 8/9] Ảnh bill vừa được ĐỔI TÊN (sau OCR) → báo server dời SỔ "đã đọc"/"lỗi" sang tên mới, để lần quét
 *  sau KHÔNG coi là ảnh mới và sổ lỗi không trỏ file đã mất. Best-effort — hỏng chỉ ghi log, không chặn quét. */
export function renameProcessed(payload: { oldPath: string; newPath: string }): Promise<AgentApiResult<{ ok: boolean; processed?: boolean; failed?: boolean; error?: string }>> {
  return jsonCall('/v1/ocr-send/rename-processed', payload);
}
// [Admin Demo 8/9] BÁO CÁO FOLDER sau khi quét xong — bảng y hệt Báo cáo lô, đủ từng lô lỗi gì.
// Server dựng bằng CHÍNH hàm của báo cáo lô rồi lọc theo folder → số liệu không thể lệch.
export interface BillTrongFolder {
  tid: string | null; lo: string | null; roomId?: string | null; dateTime?: string | null;
  amount?: number | null; sent?: boolean; fileName?: string | null; idx?: number | null;
}
export interface DongBaoCaoFolder {
  idx: number | null; fileName: string | null; hkdName: string; bankName: string; tid: string; lo: string;
  date: string; time: string; truoc: number; fee: number; sau: number;
  trangThai: 'DA_GHI' | 'CHUA_GUI' | 'DOC_HUT'; loi: string[];
}
export interface BaoCaoFolder {
  rows: DongBaoCaoFolder[];
  tong: { soBill: number; daGhi: number; chuaGui: number; docHut: number; soLoi: number; tongTruoc: number; tongSau: number };
}
export function fetchFolderReport(bills: BillTrongFolder[]): Promise<AgentApiResult<BaoCaoFolder>> {
  return jsonCall('/v1/ocr-send/folder-report', { bills });
}

export interface ClassifyOptions { dealers: { roomId: string; name: string; customerId?: number }[]; investors: { id: number; name: string }[]; }
export function fetchClassifyOptions(): Promise<AgentApiResult<ClassifyOptions>> {
  return jsonCall('/v1/ocr-send/classify-options', {});
}
export function classifyAlias(payload: { name: string | null; account: string | null; entityType: 'DEALER' | 'INVESTOR'; entityId?: number | null; roomId?: string | null; label?: string }): Promise<AgentApiResult<{ ok: boolean }>> {
  return jsonCall('/v1/ocr-send/classify-alias', payload);
}
/** HỌC "NGÂN HÀNG NGƯỜI GỬI" bill CK (Admin Demo 2/9) — khai báo 1 lần → cache theo STK/tên người gửi → lần sau tự
 *  nhận. Cần bank + (account HOẶC name). senderBank CHỈ là nhãn attribution — KHÔNG đụng tiền/dedup. */
export function saveSenderBankAlias(payload: { account?: string | null; name?: string | null; bank: string }): Promise<AgentApiResult<{ ok: boolean }>> {
  return jsonCall('/v1/ocr-send/sender-bank-alias', payload);
}
/** [Admin Demo 4/9] LƯU bản sửa phân loại CK theo ẢNH (token) → re-OCR ảnh đó trả đúng "trạng thái sửa gần nhất" (mọi
 *  phiên/máy). Khác alias (chỉ nhớ đối tác), correction nhớ CẢ HƯỚNG (ứng/hoàn). */
export function saveTransferCorrection(payload: { token: string; direction: string; entityType: 'DEALER' | 'INVESTOR' | null; entityId: number | null; roomId: string | null; roomName: string | null }): Promise<AgentApiResult<{ ok: boolean }>> {
  return jsonCall('/v1/ocr-send/save-transfer-correction', payload);
}
export interface OcrResult { token: string; review: ReviewItem[]; cached?: boolean; kind?: 'POS' | 'TRANSFER' | 'QR' | 'CK' | 'UNKNOWN'; transferReview?: TransferReview[]; qrReview?: QrReviewItem[]; }
export interface ScanFile { path: string; name: string; mtime: number; size: number; alreadyOcr: boolean; }
export interface FeeSplitPart { cardTypeId: number; amount: number; }
export interface SendPayload {
  token: string;
  bill: OcrBill;
  /** Tên ngân hàng (OCR/khớp-TID) — server gắn vào posBill meta để card POS hiện Ô "Ngân hàng" (Admin Demo 1/9). */
  bankName?: string | null;
  splits?: FeeSplitPart[];
  allowDuplicate?: boolean;
  /** [Admin Demo 7/9 — MƯỢN TID] roomId nhóm ĐẠI LÝ MƯỢN (quẹt nhờ TID đại lý khác) → doanh số + tin bill về phòng NÀY,
   *  KHÔNG về phòng chủ TID. undefined = không mượn (về chủ TID như thường). */
  borrowedByRoomId?: string;
  /** Ảnh CARD (bill + bảng) render client-side, base64 dataURL. Đại lý ↔ NĐT khác nhau (bảo mật). Thiếu → server
   *  dùng ảnh bill thô (Admin Demo 31/8). */
  dealerImage?: string;
  investorImage?: string;
}
export interface SendResult {
  ok: boolean;
  duplicate: boolean;
  dealerMessageId?: string;
  investorMessageId?: string;
  investorSkippedReason?: string;
  /** Kết quả GHI DOANH SỐ (Admin Demo 30/8) — loId nếu ghi được, message nếu không (vd TID chưa có trong hệ thống). */
  revenue?: { ok: boolean; loId?: number; message?: string };
}

async function jsonCall<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<AgentApiResult<T>> {
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return { ok: false, error: 'ABORTED', message: 'Đã dừng OCR.' };
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) {
    const b = json as { error?: string; message?: string; duplicate?: boolean } | null;
    return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true, data: json as T };
}

/** THỦ CÔNG — upload 1 ảnh bill (multipart "file") → OCR + review. */
/** [Admin Demo 25/9 — "máy khác báo MẤT MẠNG khi OCR"] GỐC: máy ngoài đi qua Cloudflare Tunnel bị CẮT KẾT NỐI ở
 *  ~100 giây; Gemini nhanh (trung vị 3,8s) nên thường không sao, nhưng khi hết quota → Claude chạy tới 150s
 *  (log: 171 lần timeout) ⇒ đứt ⇒ hiện "Lỗi kết nối mạng". FIX: gọi đường CHẠY NỀN — server trả jobId ngay,
 *  client hỏi kết quả mỗi 2s (mỗi lượt hỏi chỉ vài mili-giây, tunnel không có gì để cắt).
 *  Server CŨ chưa có /ocr-async (404) → tự quay về đường đồng bộ cũ, không chặn việc. */
async function ocrChayNen(taoForm: () => FormData, qs: string, signal?: AbortSignal): Promise<AgentApiResult<OcrResult> | 'KHONG_HO_TRO'> {
  // [Admin Demo 25/9 — GỐC THẬT của "máy khác báo mất mạng": máy chủ KHỞI ĐỘNG LẠI (đưa bản mới lên) làm đường
  // truyền đứt 10-20 GIÂY; log tunnel trùng từng phút với lúc restart (24/9 10:28 · 25/9 09:09). Máy chủ dùng
  // tại chỗ không thấy gì, máy ngoài mất kết nối ngay giữa lượt OCR.] → TỰ THỬ LẠI 3 nhịp cách 4s: server lên
  // lại là chạy tiếp, nhân viên KHÔNG thấy lỗi. (Chỉ thử lại khi ĐỨT MẠNG — lỗi nghiệp vụ vẫn báo ngay.)
  let res: Response | null = null;
  for (let lan = 1; lan <= 3; lan++) {
    try {
      res = await proxyFetch(`${botApiBaseUrl()}/v1/ocr-send/ocr-async${qs ? '?' + qs : ''}`, { method: 'POST', body: taoForm(), signal });
      break;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return { ok: false, error: 'ABORTED', message: 'Đã dừng OCR.' };
      if (lan === 3) return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
      await new Promise((r) => setTimeout(r, 4000)); // máy chủ vừa khởi động lại → đợi rồi thử tiếp
    }
  }
  if (!res) return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  if (res.status === 404) return 'KHONG_HO_TRO'; // server cũ
  let j: { ok?: boolean; jobId?: string; error?: string; message?: string };
  try { j = await res.json() as typeof j; } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok || !j.jobId) return { ok: false, error: j.error ?? 'UNKNOWN', message: j.message ?? `HTTP ${res.status}` };

  const batDau = Date.now();
  const HET_HAN_MS = 6 * 60 * 1000; // OCR chậm nhất (Claude 150s + hàng đợi) vẫn thừa; quá hạn báo rõ, KHÔNG treo câm.
  for (;;) {
    if (signal?.aborted) return { ok: false, error: 'ABORTED', message: 'Đã dừng OCR.' };
    await new Promise((r2) => setTimeout(r2, 1500));
    let p: Response;
    try {
      p = await proxyFetch(`${botApiBaseUrl()}/v1/ocr-send/ocr-job/${encodeURIComponent(j.jobId)}`, { method: 'GET', signal });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return { ok: false, error: 'ABORTED', message: 'Đã dừng OCR.' };
      if (Date.now() - batDau > HET_HAN_MS) return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
      continue; // mạng chớp nháy 1 nhịp → hỏi lại, KHÔNG bỏ cuộc (trước đây đứt là mất luôn cả lượt OCR)
    }
    let b: { ok?: boolean; status?: string; ketQua?: unknown; error?: string; message?: string };
    try { b = await p.json() as typeof b; } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
    if (b.status === 'RUNNING') {
      if (Date.now() - batDau > HET_HAN_MS) return { ok: false, error: 'OCR_TIMEOUT', message: 'OCR chạy quá lâu (>6 phút) — thử quét lại ảnh này.' };
      continue;
    }
    if (b.status === 'DONE' && b.ketQua) return { ok: true, data: b.ketQua as OcrResult };
    return { ok: false, error: b.error ?? 'OCR_FAILED', message: b.message ?? 'OCR thất bại.' };
  }
}

export async function ocrUpload(file: File, signal?: AbortSignal, force = false, opus = false, claude = false, preferQr = false): Promise<AgentApiResult<OcrResult>> {
  const moiForm = (): FormData => { const f = new FormData(); f.append('file', file, file.name); return f; };
  {
    // FormData đã gửi 1 lần KHÔNG dùng lại được (body consumed) → nhánh dự phòng tạo form MỚI.
    const qs0 = [force ? 'force=1' : '', opus ? 'opus=1' : '', claude ? 'claude=1' : '', preferQr ? 'prefer=qr' : ''].filter(Boolean).join('&');
    const nen = await ocrChayNen(moiForm, qs0, signal);
    if (nen !== 'KHONG_HO_TRO') return nen;
  }
  const form = moiForm();
  let res: Response;
  try {
    // [Admin Demo 3/9] force ("Quét lại ảnh này") → query ?force=1 → server bỏ cache OCR, đọc lại.
    // [Admin Demo 8/9] claude=1 → server BỎ lượt OCR máy, đọc thẳng Claude (nút "Đọc lại bằng Claude").
    const qs = [force ? 'force=1' : '', opus ? 'opus=1' : '', claude ? 'claude=1' : '', preferQr ? 'prefer=qr' : ''].filter(Boolean).join('&');
    res = await proxyFetch(`${botApiBaseUrl()}/v1/ocr-send/ocr${qs ? '?' + qs : ''}`, { method: 'POST', body: form, signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return { ok: false, error: 'ABORTED', message: 'Đã dừng OCR.' };
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true, data: json as OcrResult };
}

/** TỰ ĐỘNG — quét folder → danh sách file ảnh bill (kèm alreadyOcr = đã quét trước) + newCount = số bill mới. */
export function scanFolder(folder: string): Promise<AgentApiResult<{ count: number; newCount: number; files: ScanFile[] }>> {
  return jsonCall('/v1/ocr-send/scan', { folder });
}

/** TỰ ĐỘNG — OCR 1 file trong folder → review. force ("Quét lại ảnh này") → bỏ cache, đọc lại. */
export function ocrFile(path: string, signal?: AbortSignal, force = false, opus = false, claude = false, preferQr = false): Promise<AgentApiResult<OcrResult>> {
  return jsonCall('/v1/ocr-send/ocr-file', { path, force, opus, claude, prefer: preferQr ? 'qr' : undefined }, signal);
}

/** GỬI + GHI bill CHUYỂN KHOẢN theo 4 HƯỚNG (Admin Demo 31/8). Bảo mật 2 chiều: DEALER → chỉ nhóm đại lý; INVESTOR
 *  → chỉ nhóm NĐT (server resolve từ entityId, không tin room client). transfer.direction quyết định nhánh. */
export function sendTransfer(payload: { token: string; transfer: TransferReview }): Promise<AgentApiResult<{ ok: boolean; direction?: string; target?: 'DEALER' | 'INVESTOR' | null; roomId?: string; messageId?: string; dealerMessageId?: string; recorded?: boolean; deduped?: boolean }>> {
  return jsonCall('/v1/ocr-send/send-transfer', payload);
}

/** URL ảnh preview theo token (dùng với fetchAttachmentObjectUrl để tải qua proxyFetch có CSRF). */
// [Admin Demo 7/9] MỞ bill đã gửi để SỬA bằng card review OCR (1 render gốc). prepare-edit trả {token, review} như OCR
// (nạp ảnh tin cũ, không OCR lại) → render BillReviewCard → "Gửi" = bug #1 tự cập nhật tin cũ. Gate mật khẩu sửa.
/** [Admin Demo 11/9] `kind:'CK'` + `transferReview` khi tin là bill CHUYỂN KHOẢN (hoàn/ứng) — mở TransferReviewCard. */
export function prepareEditBill(messageId: string, editPassword: string): Promise<AgentApiResult<OcrResult & { editMessageId?: string }>> {
  return jsonCall('/v1/ocr-send/prepare-edit', { messageId, editPassword });
}

// [Admin Demo 7/9] SỬA bill HOÀN/ỨNG (CK) trên bảng đối soát: ngày/giờ/số tiền. Gate mật khẩu sửa (mặc định 1111).
export function editRefundBill(messageId: string, editPassword: string, patch: { billDate?: string; billTime?: string; amount?: number }): Promise<AgentApiResult<{ messageId: string; billDate: string | null; amount: number }>> {
  return jsonCall('/v1/ocr-send/edit-refund-bill', { messageId, editPassword, patch });
}

// [Admin Demo 7/9] TRA SOÁT SAO KÊ — upload file sao kê ngân hàng (xlsx) → GD đã phân loại + khớp đại lý/NĐT + báo cáo.
export type StmtReconKind = 'DEALER_REFUND' | 'DEALER_ADVANCE' | 'DEALER_RETURN' | 'INVESTOR_REPAY' | 'INVESTOR_ADVANCE' | 'TRANSFER' | 'INTEREST' | 'CAPITAL' | 'OTHER' | 'UNKNOWN';
export interface StmtReconTxn {
  rowIndex: number; dateTime: string | null; ref: string | null; debit: number; credit: number;
  desc: string | null; cpName: string | null; cpAccount: string | null; cpBank: string | null; descName: string | null;
  direction: 'OUT' | 'IN'; kind: StmtReconKind; matchedName: string | null;
  matchedCustomerId: number | null; matchedInvestorId: number | null; matchType: 'account' | 'name' | null;
  edited: boolean; note: string | null; effectiveDate: string | null;
  srcAccount: string | null; srcBank: string | null; srcHolder: string | null;
}
export interface StmtReconResult {
  accountHolder: string | null; accountNumber: string | null; accountBank: string | null; txns: StmtReconTxn[];
  byDay: { date: string; hoanDaiLy: number; hoanLaiDaiLy: number; hoanUngNDT: number; tamUngNDT: number }[];
  byDealer: { name: string; customerId: number | null; account: string | null; bank: string | null; total: number; count: number }[];
  totals: { hoanDaiLy: number; hoanLaiDaiLy: number; hoanUngNDT: number; tamUngNDT: number; unmatchedOut: number; unmatchedIn: number };
  /** [Admin Demo 8/9] Cảnh báo khi đọc file (thiếu cột đối ứng, không rõ ngân hàng…) — hiện banner vàng trên màn. */
  warnings?: string[];
}
// [Admin Demo 7/9] Lưu SỬA TAY 1 giao dịch sao kê (nhớ cache theo ref) — loại/hoàn cho ai/ngày hiệu lực/ghi chú.
export function saveStatementOverride(payload: { ref: string; kind?: string | null; targetName?: string | null; effectiveDate?: string | null; note?: string | null }): Promise<AgentApiResult<Record<string, never>>> {
  return jsonCall('/v1/statement-recon/edit', payload);
}
// [Admin Demo 7/9] Load lại toàn bộ sao kê đã cache (mở màn không cần upload lại).
export function fetchCachedStatements(): Promise<AgentApiResult<{ txns: StmtReconTxn[] }>> {
  return jsonCall('/v1/statement-recon/cached', {});
}
// [Admin Demo 8/9] BÁO CÁO BILL THIẾU ẢNH OCR — GD hoàn sao kê không có bill OCR khớp (đích danh đại lý, chu kỳ).
export interface MissingBillRow { dateTime: string | null; amount: number; receiverName: string | null; receiverAccount: string | null; bank: string | null; dealerName: string | null; customerId: number | null; day: string; }
export function fetchMissingBills(from: string, to: string): Promise<AgentApiResult<{ rows: MissingBillRow[] }>> {
  return jsonCall('/v1/statement-recon/missing-bills', { from, to });
}
// [Admin Demo 12/9] ĐỐI CHIẾU SỐ DƯ CUỐI NGÀY: tổng số dư TK SigMa (cột "Số dư" sao kê) vs Σ phải hoàn NĐT + lãi công ty.
export interface BalanceAccountRow { account: string; bank: string | null; holder: string | null; balance: number; asOf: string | null; stale: boolean }
export interface BalanceInvestorRow { investorId: number; name: string; tamUng: number; tienVe: number; laiNdt: number; phaiHoan: number }
export interface BalanceQrRow { investorId: number; name: string; gross: number; phiMuaGiu: number; traAlpha: number; soBill: number }
export interface BalanceCheckData {
  day: string; accounts: BalanceAccountRow[]; tongSoDu: number; coSoDu: boolean;
  investors: BalanceInvestorRow[]; investorsQr?: BalanceQrRow[]; tongNdtQrTraVe?: number;
  tongPhaiHoanNdt: number; laiCongTy: number; phaiCo: number; lech: number;
}
// [Admin Demo 13/9] CHECK SAO KÊ BÁO CÓ nhóm NĐT — đối chiếu tiền về sau phí cài máy từng lô.
export interface BaocoRow { dateTime: string | null; amount: number; balance?: number | null; desc: string | null; matchedLo: string | null; matchedTid: string | null; goiY?: string | null }
export interface LoExpectRow { loId: number; billKey: string; tid: string; hkdName: string | null; billDate: string | null; amount: number; tienVe: number; matched: boolean; ca?: number | null; thucVe?: number }
export interface CaGroupRow { bo: string; soMay: number; tid: string; hkdName: string | null; ngay: string; ca: number; soLo: number; doanhSo: number; tienVe: number; thucVe: number; chenh: number; matched: boolean; choCaSau?: boolean }
export interface InvestorBaocoData {
  investorId: number; from: string; to: string;
  baoco: BaocoRow[]; baocoNgoaiKy?: { dateTime: string | null; amount: number; ngayDs: string }[]; nhomCa: CaGroupRow[]; los: LoExpectRow[];
  tongBaoco: number; tongTienVeKyVong: number; tongDaKhop: number; soLoChuaVe: number; soBaocoThua: number;
}
/** MB tự động: bỏ trống username/password = dùng đăng nhập đã lưu của NĐT. */
export function fetchInvestorBaoco(investorId: number, from: string, to: string, cred?: { username?: string; password?: string; accountNumber?: string; source?: 'CACHE' }): Promise<AgentApiResult<InvestorBaocoData>> {
  return jsonCall('/v1/investor-baoco/check', { investorId, from, to, ...cred });
}
/** MBV: tải file .xlsx. */
export async function uploadInvestorBaoco(investorId: number, from: string, to: string, file: File): Promise<AgentApiResult<InvestorBaocoData>> {
  const form = new FormData();
  form.append('file', file, file.name);
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/investor-baoco/upload?investorId=${investorId}&from=${from}&to=${to}`, { method: 'POST', body: form }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  const b = json as { ok?: boolean; data?: InvestorBaocoData; error?: string; message?: string };
  if (!res.ok || !b.ok || !b.data) return { ok: false, error: b.error ?? 'UNKNOWN', message: b.message ?? `HTTP ${res.status}` };
  return { ok: true, data: b.data };
}

/** [Admin Demo 13/9] Tải .xlsx BỐ CỤC SAO KÊ MB chuẩn từ cache (TK của NĐT, kỳ ngày bank). */
export async function exportInvestorSaoke(investorId: number, from: string, to: string, accountNumber?: string): Promise<AgentApiResult<Blob>> {
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/investor-baoco/export-saoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ investorId, from, to, accountNumber }) }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  if (!res.ok) { let m = `HTTP ${res.status}`; try { m = (await res.json()).message ?? m; } catch { /* ignore */ } return { ok: false, error: 'ERROR', message: m }; }
  return { ok: true, data: await res.blob() };
}

export function fetchBalanceCheck(day: string): Promise<AgentApiResult<BalanceCheckData>> {
  return jsonCall('/v1/statement-recon/balance-check', { day });
}
export async function uploadStatement(file: File): Promise<AgentApiResult<StmtReconResult>> {
  const form = new FormData();
  form.append('file', file, file.name);
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/statement-recon/upload`, { method: 'POST', body: form }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  const j = json as { ok?: boolean; data?: StmtReconResult; error?: string; message?: string };
  if (!res.ok || !j.ok || !j.data) return { ok: false, error: j.error ?? 'ERROR', message: j.message ?? 'Không xử lý được sao kê.' };
  return { ok: true, data: j.data };
}

// [Admin Demo 9/9] LẤY SAO KÊ TỰ ĐỘNG (MB qua GPM Pay) — kéo giao dịch từ nhà cung cấp về ĐÚNG luồng tra soát, khỏi
// tải file .xlsx rồi nạp tay. Server đọc khoá API từ biến môi trường; client chỉ gửi số TK + kỳ ngày.
export async function fetchAutoStatement(accountNumber: string, from: Date, to: Date): Promise<AgentApiResult<StmtReconResult>> {
  const r = await jsonCall<StmtReconResult | { ok?: boolean; data?: StmtReconResult }>('/v1/statement-recon/fetch-auto', {
    accountNumber, from: from.toISOString(), to: to.toISOString()
  });
  if (!r.ok) return r;
  const raw = r.data as { ok?: boolean; data?: StmtReconResult };
  return { ok: true, data: (raw?.data ?? (r.data as StmtReconResult)) };
}

// [Admin Demo 8/9 — BILL AN BÌNH] OCR ẢNH chụp lịch sử giao dịch (ABB) → GD phân loại + cache (gộp vào tab tra soát).
export async function uploadStatementImage(file: File): Promise<AgentApiResult<StmtReconResult>> {
  const form = new FormData();
  form.append('file', file, file.name);
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/statement-recon/ocr-image`, { method: 'POST', body: form }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  const j = json as { ok?: boolean; data?: StmtReconResult; error?: string; message?: string };
  if (!res.ok || !j.ok || !j.data) return { ok: false, error: j.error ?? 'ERROR', message: j.message ?? 'Không đọc được ảnh giao dịch.' };
  return { ok: true, data: j.data };
}

// [Admin Demo 8/9 — ABB REVIEW] Xác nhận nạp các GD đã review/sửa (OCR ảnh) → cache + hiện 2 tab tra soát.
export function commitOcrImageTxns(txns: StmtReconTxn[]): Promise<AgentApiResult<{ count: number }>> {
  return jsonCall('/v1/statement-recon/ocr-commit', { txns });
}

// [Admin Demo 8/9] Xuất Excel .xlsx THẬT (backend exceljs) — hết cảnh báo format. Trả Blob để tải.
export async function exportStatementXlsx(txns: StmtReconTxn[], periodLabel: string): Promise<AgentApiResult<Blob>> {
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/statement-recon/export-xlsx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txns, periodLabel }) }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  if (!res.ok) { let m = `HTTP ${res.status}`; try { m = (await res.json()).message ?? m; } catch { /* ignore */ } return { ok: false, error: 'ERROR', message: m }; }
  return { ok: true, data: await res.blob() };
}

export function ocrImageUrl(token: string): string {
  return `${botApiBaseUrl()}/v1/ocr-send/image?token=${encodeURIComponent(token)}`;
}

/** GỬI 1 bill (đã review) → nhóm đại lý + cc NĐT. duplicate:true + !allowDuplicate → trả lỗi DUPLICATE (409). */
export function sendBill(payload: SendPayload): Promise<AgentApiResult<SendResult>> {
  return jsonCall('/v1/ocr-send/send', payload);
}

/** [Admin Demo 2/9] CẬP NHẬT bill ĐÃ GỬI tại chỗ (re-OCR có sửa) — sửa TRÊN tin cũ (messageId) + note thay đổi + tính lại
 *  doanh số, KHÔNG post trùng. bill = thông số đã sửa (tid/batchNumber/totalAmount/dateTime). */
// [Admin Demo 8/9] + cardTypeId/splits: ĐỔI LOẠI THẺ (Visa ↔ JCB…) hoặc tách thẻ khi sửa bill đã ghi → server tính lại
// phí bán/phí cài + số phải hoàn theo thẻ mới (trước đây không gửi lên nên "sửa bill mà không sửa được phí").
export function updateSentBill(messageId: string, bill: { tid?: string | null; batchNumber?: string | null; totalAmount?: number | null; dateTime?: string | null; cardTypeId?: number | null; splits?: FeeSplitPart[]; voidAmount?: number | null; voidCount?: number | null }): Promise<AgentApiResult<{ updatedCount: number; oldAmount: number; newAmount: number; revenueUpdated: boolean }>> {
  return jsonCall('/v1/ocr-send/update-sent', { messageId, bill });
}

/** Phí theo (tid, tổng, thẻ|tách-thẻ) — gọi khi người chọn thẻ / sửa tiền / tách thẻ. sell=đại lý, install=NĐT. */
export function feePreview(tid: string, amount: number, splits?: FeeSplitPart[], voidAmount?: number): Promise<AgentApiResult<{ sell: FeeLine; install: FeeLine; ghiChuHuy?: string | null }>> {
  // amount = TỔNG QUẸT trên bill; voidAmount = tiền GD HỦY. Server tự trừ hủy rồi mới tính phí (cùng đường với
  // /send) — client KHÔNG tự trừ, để hai nơi không ra hai con số.
  return jsonCall('/v1/ocr-send/fee', { tid, amount, splits, voidAmount });
}

/** [Admin Demo 5/9] RE-ROUTE theo TID — gọi khi người review SỬA/CHỌN TID sang máy khác (dropdown gợi ý / gõ tay) → server
 *  re-resolve định tuyến (phòng đại lý/NĐT) + loại thẻ + thẻ mặc định + HKD/bank cho TID MỚI. Client cập nhật state để
 *  fee preview chạy lại + nút Gửi mở khoá. Định tuyến/phí LUÔN từ server (client KHÔNG bịa) — money-safety. */
export interface RerouteResult {
  dealerRoomId: string | null;
  dealerRoomName: string | null;
  investorRoomId: string | null;
  investorRoomName: string | null;
  availableCardTypes: CardTypeOpt[];
  primaryCardTypeId: number | null;
  hkdName: string | null;
  bankName: string | null;
  warnings: string[];
}
export function rerouteBill(tid: string): Promise<AgentApiResult<RerouteResult>> {
  return jsonCall('/v1/ocr-send/reroute', { tid });
}
