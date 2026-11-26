// ĐỐI SOÁT "BÁO CÓ" DIGISTORE (BVBank) — client gọi bot-api /v1/digistore/*.
// (1) check-baoco: đối chiếu 1 bill QR (đang review) với báo-có ngân hàng → khớp/không/trùng/mập mờ/không-check-được.
// (2) baoco-report: bảng báo cáo báo-có theo kỳ + lọc, kèm dòng CHƯA ĐỐI SOÁT (báo-có ngân hàng chưa có bill OCR khớp).
// CÙNG khuôn diary-api/ocr-send-api: proxyFetch + AgentApiResult. Backend do agent khác + LEAD làm (KHÔNG đụng bot-api).
// jsonCall bọc {ok, data}: HTTP body = data trực tiếp (client đọc r.data) — mock harness trả BODY thẳng, khớp cách này.
import { PARSE_ERROR_VI, networkErrorMessage } from './error-i18n';
import { proxyFetch } from './proxy-fetch';
import { botApiBaseUrl, type AgentApiResult } from './diary-api';

// ── (1) CHECK BÁO CÓ ────────────────────────────────────────────────────────────────────────────────────
export type BaoCoStatus = 'MATCHED' | 'NOT_FOUND' | 'DUPLICATE' | 'AMBIGUOUS' | 'CANNOT_CHECK';
/** Giao dịch báo-có ngân hàng KHỚP bill (khi MATCHED). */
export interface BaoCoMatch {
  billId: string;
  hkdName: string;
  amount: number;
  payerName: string | null; // tên người quẹt (ngân hàng ghi nhận)
  atMs: number;             // thời điểm giao dịch (epoch ms)
  status: string;
}
/** Ứng viên báo-có (khi AMBIGUOUS: nhiều GD trùng số tiền + giờ, tên lệch → người xem tự chọn). */
export interface BaoCoCandidate {
  billId: string;
  amount: number;
  payerName: string | null;
  atMs: number;
  status: string;
}
export interface CheckBaoCoResult {
  status: BaoCoStatus;
  match?: BaoCoMatch;             // MATCHED
  candidates?: BaoCoCandidate[];  // AMBIGUOUS
  message?: string;               // CANNOT_CHECK (lý do TRUNG THỰC) / ghi chú khác
}

/** Đối chiếu 1 bill QR đang review với "báo có" ngân hàng. Check là BỔ TRỢ — KHÔNG chặn nút Gửi. */
export function checkBaoCo(payload: {
  hkdName: string | null;
  amount: number;
  dateTime: string | null;
  payerName: string | null;
}): Promise<AgentApiResult<CheckBaoCoResult>> {
  return jsonPost('/v1/digistore/check-baoco', payload);
}

// [Admin Demo 8/9] GỢI Ý mã QR / tên HKD khi OCR KHÔNG đọc được tên trên bill (app ngân hàng cắt cụt / ảnh mờ).
// Server tra báo-có theo SỐ GIAO DỊCH (exact) hoặc SỐ TIỀN + NGÀY GIỜ (±window) → trả danh sách để NGƯỜI chọn.
export interface HkdSuggestion {
  billId: string;
  qrCode: string | null;
  hkdName: string | null;
  payerName: string | null;
  amount: number;
  atMs: number | null;
  externalRefNo: string | null;
  sourceTidId: number | null;
  reconcileStatus: string | null;
}
export interface SuggestHkdResult {
  exact: boolean;      // khớp theo SỐ GIAO DỊCH → chắc chắn
  weak: boolean;       // bill không có giờ → chỉ khớp tiền trong 24h (yếu, phải soi kỹ)
  refreshed?: boolean; // đã tải báo-có mới trước khi tra
  warning?: string;    // R198: lý do không tải được dữ liệu mới (nếu có) — KHÔNG nuốt im
  candidates: HkdSuggestion[];
}
/** `payerName` (Admin Demo 10/9) = tên CHỦ THẺ đọc từ ảnh THÔNG BÁO GIAO DỊCH THẺ → server thu hẹp ứng viên báo-có
 *  theo người quẹt (cùng tiền + giờ mà khác người = giao dịch cửa hàng khác). Bill QR thường: bỏ trống. */
export function suggestHkd(payload: { amount: number; dateTime: string | null; ref: string | null; payerName?: string | null }): Promise<AgentApiResult<SuggestHkdResult>> {
  return jsonPost('/v1/digistore/suggest-hkd', payload);
}

// [Admin Demo 6/9 — HẠN MỨC QR/ngày] get danh sách mã + hạn mức hiện tại; set 1 mã (limit<=0 = xoá). CHỈ chủ SigMa (server gác).
export interface QrMaLite { tidId: number; tid: string; hkdName: string | null }
export interface QrDailyLimitData { limits: Record<string, number>; ma: QrMaLite[] }
export async function getQrDailyLimit(): Promise<AgentApiResult<QrDailyLimitData>> {
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/qr-daily-limit`, { method: 'GET' }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) { const b = json as { error?: string; message?: string } | null; return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` }; }
  return { ok: true, data: json as QrDailyLimitData };
}
export function setQrDailyLimit(tidId: number, limit: number): Promise<AgentApiResult<{ limits: Record<string, number> }>> {
  return jsonPost('/v1/qr-daily-limit', { tidId, limit });
}

// ── (2) BÁO CÁO BÁO-CÓ ──────────────────────────────────────────────────────────────────────────────────
export type BaoCoReconcileStatus = 'MATCHED' | 'UNRECONCILED';
export interface BaoCoReportRow {
  stt: number;
  dateIso: string;               // thời điểm báo-có (ISO instant)
  hkdName: string;
  amount: number;
  payerName: string | null;      // MÔ TẢ = tên người quẹt
  billId: string;                // mã hóa đơn
  sauPhiBan: number | null;      // số sau phí bán (đại lý)
  sauPhiMua: number | null;      // số sau phí mua (đối tác)
  loiNhuanAlpha: number | null;  // lợi nhuận SigMa
  dealerName: string | null;
  reconcileStatus: BaoCoReconcileStatus; // UNRECONCILED = báo-có CHƯA có bill OCR khớp (doanh thu cần truy)
  nguon: string | null; // [Admin Demo 11/9] ngân hàng của MÃ QR nguồn (SmartPay=DEMOMAY/PaySmart · BVBank/ACB=DigiStore) → tô màu
  // [Admin Demo 14/9 — full chức năng CQR] Đối soát TAY + đại lý gán tay + chủ mã (mặc định cột đại lý). Server cũ
  // thiếu field → undefined (backward-compat, UI coi như chưa gán).
  manualDs?: boolean | null;
  manualDealer?: string | null;
  maChuName?: string | null;
  sourceTidId?: number | null;
  /** [Admin Demo 16/9 — VietQR] ĐÃ HOÀN tiền (xác nhận tay sau khi quét QR chuyển). XANH chỉ khi đối soát + hoàn. */
  refundDone?: boolean | null;
  /** [16/9 tối] Loại phí bán bill chưa khớp GD: 'cho' (tiền chờ — mặc định) | 'nhanh' (SmartPay 1.15%…). */
  feeType?: 'cho' | 'nhanh';
  /** Mã nguồn có giá tiền nhanh → UI mới hiện dropdown chọn. */
  coPhiNhanh?: boolean;
}
/** KPI 1 NGÀY (giờ HCM) — bảng "KPI theo ngày" trên đầu báo cáo. day = "YYYY-MM-DD" (ngày HCM). */
export interface BaoCoDayKpi {
  day: string;              // YYYY-MM-DD (ngày HCM)
  doanhSo: number;          // tổng số tiền báo-có trong ngày
  count: number;            // số giao dịch
  countUnreconciled: number;// số CHƯA đối soát
  loiNhuan: number;         // lợi nhuận SigMa trong ngày
}
export interface BaoCoReport {
  rows: BaoCoReportRow[];
  totals: { amount: number; loiNhuanAlpha: number; count: number; countUnreconciled: number };
  byDay: BaoCoDayKpi[];     // KPI theo NGÀY (server trả — sắp tăng dần theo ngày). Thiếu → coi như [].
  /** [14/9 — CQR] Mã vượt HẠN MỨC/ngày trong kỳ → banner ĐỎ. Server cũ thiếu → []. */
  limitWarnings: Array<{ tidId: number; hkdName: string | null; day: string; doanhSo: number; limit: number }>;
  from: string;
  to: string;
}
/** filter: 'all' = tất cả · 'reconciled' = đã đối soát · 'unreconciled' = chưa đối soát (báo-có chưa có bill OCR). */
export type BaoCoReportFilter = 'all' | 'reconciled' | 'unreconciled';

// ── (3) TẢI LẠI GIAO DỊCH BÁO-CÓ MỚI NHẤT ───────────────────────────────────────────────────────────────
/** 1 lỗi kéo báo-có theo TID (cổng Digistore từng HKD). code = mã lỗi máy; reason = lý do đọc-được (VI). */
export interface BaoCoRefreshError {
  tid: string;              // định danh TID/HKD gặp lỗi
  code: string;             // mã lỗi: AUTH / NOT_CONFIGURED / NETWORK / UNKNOWN...
  reason: string;           // lý do người-đọc-được (sai user/pass, chưa cấu hình, mạng...)
}
/** Kết quả tải lại: kéo N giao dịch, khớp M bill, còn K chưa đối soát; errors = TID kéo lỗi (nếu có). */
export interface BaoCoRefreshResult {
  fetched: number;
  matched: number;
  unreconciled: number;
  errors: BaoCoRefreshError[];
  /** [Agent-3 11/9 — R198 client nuốt câm] Kết quả kéo PaySmart (mã DEMOMAY) trong cùng nút. Thiếu field (server cũ)
   *  → undefined → banner không nói gì về PaySmart (backward-compat). */
  // [14/10] Nhiều mã PaySmart: banner phải gọi ĐÚNG TÊN mã nào thiếu dữ liệu (trước đây viết cứng "DEMOMAY" —
  // thêm mã thứ hai là câu đó nói sai nhà). soMa/soOk = tổng mã thử / số mã chạy được; loiMa = từng mã lỗi.
  paysmart?: {
    ok: boolean;
    naped: number;
    soMa?: number | null;
    soOk?: number | null;
    loiMa?: Array<{ tidId: number; tenHkd: string | null; ly: string }>;
    error?: string;
  };
}
/** POST /v1/digistore/refresh — kéo giao dịch báo-có mới nhất từ cổng ngân hàng (Digistore/BVBank) rồi đối soát.
 *  Server là lớp chặn quyền thật (403 nếu không phải chủ SigMa). Sau khi gọi xong, màn TỰ nạp lại báo cáo. */
export function refreshBaoCo(tidIds?: number[]): Promise<AgentApiResult<BaoCoRefreshResult>> {
  // [Admin Demo 24/9] "kéo báo có RIÊNG" cho các mã đang tích chọn; không chọn mã nào → kéo tất cả như cũ.
  return jsonPost('/v1/digistore/refresh', tidIds && tidIds.length ? { tidIds } : undefined);
}

/** 1 mã QR (cho dropdown lọc báo cáo — như dropdown TID POS). */
export interface QrMaItem { tidId: number; tid: string; hkdName: string | null }
/** Liệt kê mã QR (owner-gated /creds) để đổ dropdown lọc báo cáo theo mã. */
export async function listQrMa(): Promise<AgentApiResult<QrMaItem[]>> {
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/digistore/creds`, { method: 'GET' }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` };
  }
  const items = ((json as { items?: Array<{ tidId: number; tid: string; hkdName: string | null }> }).items ?? [])
    .map((r) => ({ tidId: r.tidId, tid: r.tid, hkdName: r.hkdName }));
  return { ok: true, data: items };
}

/** from/to = "YYYY-MM-DD" (nửa đêm HCM) hoặc ISO instant. filters: trạng thái đối soát + HKD + đại lý + mã QR (tid). */
/** [Admin Demo 14/10 "thêm xuất excel báo có của phần này"] URL tải .xlsx — DÙNG CHUNG đúng bộ lọc với
 *  fetchBaoCoReport để file tải về khớp từng dòng với bảng đang xem (không được là đường tính thứ hai). */
export function urlBaoCoXlsx(
  from: string, to: string, filters?: { filter?: BaoCoReportFilter; hkd?: string; dealer?: string; tidIds?: number[] | null }
): string {
  const q = new URLSearchParams();
  q.set('from', from);
  q.set('to', to);
  if (filters?.filter && filters.filter !== 'all') q.set('filter', filters.filter);
  if (filters?.hkd) q.set('hkd', filters.hkd);
  if (filters?.dealer) q.set('dealer', filters.dealer);
  if (filters?.tidIds && filters.tidIds.length) q.set('tidIds', filters.tidIds.join(','));
  return `${botApiBaseUrl()}/v1/digistore/baoco-export?${q.toString()}`;
}

export async function fetchBaoCoReport(
  from: string, to: string, filters?: { filter?: BaoCoReportFilter; hkd?: string; dealer?: string; tid?: number | null; tidIds?: number[] | null }
): Promise<AgentApiResult<BaoCoReport>> {
  const q = new URLSearchParams();
  q.set('from', from);
  q.set('to', to);
  if (filters?.filter && filters.filter !== 'all') q.set('filter', filters.filter);
  if (filters?.hkd) q.set('hkd', filters.hkd);
  if (filters?.dealer) q.set('dealer', filters.dealer);
  // [Admin Demo 24/9] tích chọn NHIỀU mã → tidIds; giữ tid 1-mã cho tương thích.
  if (filters?.tidIds && filters.tidIds.length) q.set('tidIds', filters.tidIds.join(','));
  else if (filters?.tid != null && filters.tid > 0) q.set('tid', String(filters.tid));
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/digistore/baoco-report?${q.toString()}`, { method: 'GET' });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` };
  }
  const data = json as BaoCoReport;
  // byDay là hợp đồng mới — bản server cũ có thể chưa trả → chuẩn hóa về [] để UI không vỡ.
  if (!Array.isArray(data.byDay)) data.byDay = [];
  if (!Array.isArray(data.limitWarnings)) data.limitWarnings = [];
  return { ok: true, data };
}

// ── [Admin Demo 14/9 — Báo cáo QR full chức năng CQR] ĐỐI SOÁT TAY + GÁN ĐẠI LÝ + DANH MỤC ĐẠI LÝ ──
/** Tick nhiều GD → xác nhận đã đối soát (kèm đại lý) / bỏ đối soát (giữ đại lý). */
export function setBaocoRecon(billIds: string[], daDoiSoat: boolean, dealer?: string): Promise<AgentApiResult<{ message: string }>> {
  return jsonPost('/v1/digistore/baoco-recon', { billIds, daDoiSoat, dealer: dealer || undefined });
}
/** Gán/bỏ gán đại lý cho 1 GD (dropdown trong bảng) — không đổi trạng thái đối soát. */
export function setBaocoDealer(billId: string, dealer: string | null): Promise<AgentApiResult<{ message: string }>> {
  return jsonPost('/v1/digistore/baoco-recon-dealer', { billId, dealer: dealer || undefined });
}
/** Danh mục đại lý (khách SigMa) cho dropdown gán/đối soát. */
export async function listDealerNames(): Promise<AgentApiResult<string[]>> {
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/digistore/dealer-names`, { method: 'GET' }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true, data: ((json as { dealers?: string[] }).dealers ?? []).filter((x) => typeof x === 'string') };
}

// ── [Admin Demo 16/9 — VIETQR HOÀN ĐẠI LÝ] TK nhận hoàn + đánh dấu đã hoàn + ảnh QR (proxy server, fetch blob có phiên) ──
export interface DealerRefundAccount { bankCode: string; accountNo: string; accountName: string; dealer: string; isDefault?: boolean }
/** LÀM TRÒN XUỐNG NGHÌN (lệnh 16/9: "999đ tròn dưới, không tròn trên") — số tiền hoàn in trên QR. Mirror server. */
export function lamTronNghinXuong(n: number): number { return Math.max(0, Math.floor(n / 1000) * 1000); }

export async function getDealerRefundAccount(dealer: string): Promise<AgentApiResult<DealerRefundAccount | null>> {
  const r = await getDealerRefundAccounts(dealer);
  return r.ok ? { ok: true, data: r.data[0] ?? null } : r;
}
/** [Admin Demo 16/9 tối "1 đại lý có nhiều TK"] DANH SÁCH TK của đại lý — TK mặc định đứng đầu. */
export async function getDealerRefundAccounts(dealer: string): Promise<AgentApiResult<DealerRefundAccount[]>> {
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/digistore/dealer-refund-account?dealer=${encodeURIComponent(dealer)}`, { method: 'GET' }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) { const b = json as { error?: string; message?: string } | null; return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` }; }
  const j = json as { accounts?: DealerRefundAccount[]; account?: DealerRefundAccount | null };
  return { ok: true, data: Array.isArray(j.accounts) ? j.accounts : (j.account ? [j.account] : []) };
}
/** Thêm/sửa 1 TK (isDefault=true → thành mặc định) · setDefaultAccountNo → đổi mặc định · deleteAccountNo → xoá 1 TK. */
export function setDealerRefundAccount(body: { dealer: string; bankCode?: string; accountNo?: string; accountName?: string; isDefault?: boolean; setDefaultAccountNo?: string; deleteAccountNo?: string }): Promise<AgentApiResult<{ message: string }>> {
  return jsonPost('/v1/digistore/dealer-refund-account', body);
}
export function postRefundDone(billIds: string[], dealer: string, amount: number): Promise<AgentApiResult<{ message: string }>> {
  return jsonPost('/v1/digistore/refund-done', { billIds, dealer, amount });
}
export function postRefundUndo(billIds: string[]): Promise<AgentApiResult<{ message: string }>> {
  return jsonPost('/v1/digistore/refund-undo', { billIds });
}
/** Ảnh VietQR (server proxy, đủ logo bank + STK + tên + tiền + note) — fetch BLOB kèm phiên (img tag trần không có
 *  header auth) → objectURL cho <img>/canvas (same-origin, không taint). Caller tự revokeObjectURL khi xong. */
/** [Admin Demo 17/9] NỘI DUNG CHUYỂN KHOẢN trên VietQR = CHỈ TÊN ĐẠI LÝ kèm tiền tố nguồn tiền:
 *  bill hoàn QR → "QR a Bình SG"; bill hoàn nhanh/lô POS → "ĐL a Bình SG". Không kèm chữ "SigMa hoan…", không
 *  kèm số lô/ngày — đại lý nhìn nội dung là biết ngay tiền của nhà nào, nguồn nào.
 *  BỎ DẤU tiếng Việt: nội dung CK đi qua hệ thống liên ngân hàng, dấu hay bị cắt/lỗi ký tự → "QR a Binh SG".
 *  Tên đại lý đã mang sẵn tiền tố QR/ĐL/DL (vd nhóm "QR - ĐL Thông") thì KHÔNG nhân đôi tiền tố. */
export function noiDungChuyenKhoanQr(nguon: 'QR' | 'DL', dealer: string): string {
  const boDau = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
  let ten = boDau(String(dealer ?? '')).replace(/\s+/g, ' ').trim();
  const bocTienTo = /^(?:QR|DL)(?![A-Za-z0-9])[\s.\-–]*/i; // (?!chữ-số) = ranh giới từ, tránh cắt nhầm "DLY BINH"
  ten = ten.replace(bocTienTo, '').replace(bocTienTo, '').trim(); // lặp 2 lần: "QR - ĐL Thông" → "Thông"
  return `${nguon} ${ten}`.trim();
}

export async function fetchVietQrPngUrl(dealer: string, amount: number, info?: string, accountNo?: string): Promise<AgentApiResult<string>> {
  let res: Response;
  const q = new URLSearchParams({ dealer, amount: String(amount) });
  if (info) q.set('info', info);
  if (accountNo) q.set('accountNo', accountNo);
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/digistore/vietqr-png?${q.toString()}`, { method: 'GET' }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  if (!res.ok) {
    let b: { error?: string; message?: string } | null = null;
    try { b = await res.json() as { error?: string; message?: string }; } catch { /* body không phải json */ }
    return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` };
  }
  const blob = await res.blob();
  return { ok: true, data: URL.createObjectURL(blob) };
}

// ── [Admin Demo 22/9 — YÊU CẦU NĐT HOÀN] TK SigMa nhận hoàn từ NĐT + ảnh VietQR TK đó ──
export interface NdtQrAccount { bankCode: string; accountNo: string; accountName: string }
export async function getNdtQrAccount(): Promise<AgentApiResult<NdtQrAccount>> {
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/digistore/ndt-qr-account`, { method: 'GET' }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) { const b = json as { error?: string; message?: string } | null; return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` }; }
  return { ok: true, data: (json as { account: NdtQrAccount }).account };
}
export async function fetchNdtVietQrPngUrl(amount: number, info?: string): Promise<AgentApiResult<string>> {
  let res: Response;
  const q = new URLSearchParams({ amount: String(amount) });
  if (info) q.set('info', info);
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/digistore/ndt-vietqr-png?${q.toString()}`, { method: 'GET' }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  if (!res.ok) {
    let b: { error?: string; message?: string } | null = null;
    try { b = await res.json() as { error?: string; message?: string }; } catch { /* body không phải json */ }
    return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` };
  }
  const blob = await res.blob();
  return { ok: true, data: URL.createObjectURL(blob) };
}

// ── [Admin Demo 23/9] YCHT — mỗi lần tạo yêu cầu hoàn từ NĐT = 1 mã (nội dung CK + tên file ảnh) ──
export interface YchtDto {
  id: number; code: string; amount: number; billIds: string[];
  bankCode: string | null; accountNo: string | null; accountName: string | null; status: string; createdAtIso: string;
  /** GD đang nằm trong YCHT cũ — cảnh báo, KHÔNG chặn (Admin Demo 23/9). */
  trungYchtCu?: Array<{ billId: string; code: string }>;
}
export async function taoYchtNdt(payload: { billIds: string[]; amount: number; bankCode?: string | null; accountNo?: string | null; accountName?: string | null }): Promise<AgentApiResult<YchtDto>> {
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/ndt-refund-request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) { const b = json as { error?: string; message?: string } | null; return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` }; }
  return { ok: true, data: (json as { ycht: YchtDto }).ycht };
}

// ── [Admin Demo 16/9 tối — ĐỐI SOÁT + HOÀN per LÔ POS (màn Doanh số phòng)] ──
export async function getPosLotRecon(lotIds: number[]): Promise<AgentApiResult<Record<string, { ds: boolean; refundDone: boolean; note?: string | null }>>> {
  if (lotIds.length === 0) return { ok: true, data: {} };
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/pos-lot/recon?lotIds=${lotIds.join(',')}`, { method: 'GET' }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) { const b = json as { error?: string; message?: string } | null; return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` }; }
  return { ok: true, data: (json as { recon?: Record<string, { ds: boolean; refundDone: boolean; note?: string | null }> }).recon ?? {} };
}
// ── YÊU CẦU HOÀN TIỀN (YC) — gộp nhiều lô thành 1 lệnh chuyển (Admin Demo 17/9) ───────────────────────────────
export interface YeuCauHoan {
  id: number; code: string; dealerKey: string; dealerLabel: string | null; nguon: 'DL' | 'QR';
  amount: number; lotIds: number[]; bankCode: string | null; accountNo: string | null; accountName: string | null;
  status: 'MOI' | 'DA_CHUYEN'; paidAtIso: string | null; paidRef: string | null; createdAtIso: string;
}

/** Mã YC hiển thị + ĐƯA VÀO NỘI DUNG CK: Admin Demo chốt dạng "YC 001" (chỉ mã, KHÔNG kèm tên đại lý).
 *  Lưu trong DB là "YC001" (liền, làm khoá cho chắc) — tách nhóm số khi hiện ra cho người đọc. */
export function maYcHienThi(code: string | null | undefined): string {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(code ?? '').trim());
  return m ? `${m[1].toUpperCase()} ${m[2]}` : String(code ?? '').trim();
}

/** Tra mã YC của từng lô — bảng doanh số hiện cột "Mã YC" cạnh tiền hoàn sau phí. */
export async function getYcTheoLo(lotIds: number[]): Promise<AgentApiResult<Record<string, { code: string; status: string; amount: number }>>> {
  if (lotIds.length === 0) return { ok: true, data: {} };
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/refund-request?lotIds=${lotIds.join(',')}`, { method: 'GET' }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) { const b = json as { error?: string; message?: string } | null; return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` }; }
  return { ok: true, data: (json as { yc?: Record<string, { code: string; status: string; amount: number }> }).yc ?? {} };
}

/** SỔ YC: đại lý nào đi với mã YC nào, bao nhiêu tiền, đã chuyển chưa. */
export async function getDanhSachYc(dealer?: string, status?: 'MOI' | 'DA_CHUYEN'): Promise<AgentApiResult<YeuCauHoan[]>> {
  const q = new URLSearchParams();
  if (dealer) q.set('dealer', dealer);
  if (status) q.set('status', status);
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/refund-request/list?${q.toString()}`, { method: 'GET' }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) { const b = json as { error?: string; message?: string } | null; return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` }; }
  return { ok: true, data: (json as { items?: YeuCauHoan[] }).items ?? [] };
}

// ── SỔ TIỀN ĐẠI LÝ ĐANG CẦM (Admin Demo 17/9) ─────────────────────────────────────────────────────────────────
export interface LoCongNo {
  loId: number; soLo: string; ngay: string; gio: string; tid: string; hkdName: string; bankName: string;
  truocPhi: number; phaiHoan: number; trangThai: 'chua' | 'choHoan'; maYc: string | null; borrowed: boolean;
  note?: string | null; // [21/9] ghi chú per-lô đồng nhất
}
export interface CongNoDaiLy {
  customerId: number; dealerName: string; roomId: string | null;
  soLo: number; soLoChua: number; soLoChoHoan: number;
  tongTruocPhi: number; tongPhaiHoan: number; tongChuaDoiSoat: number; tongChoHoan: number; lots: LoCongNo[];
}
export async function getCongNoDaiLy(from: string, to: string): Promise<AgentApiResult<{ dealers: CongNoDaiLy[]; tongChuaDoiSoat: number; tongChoHoan: number }>> {
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/pos-lot/cong-no?from=${from}&to=${to}`, { method: 'GET' }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) { const b = json as { error?: string; message?: string } | null; return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` }; }
  const d = json as { dealers?: CongNoDaiLy[]; tongChuaDoiSoat?: number; tongChoHoan?: number };
  return { ok: true, data: { dealers: d.dealers ?? [], tongChuaDoiSoat: d.tongChuaDoiSoat ?? 0, tongChoHoan: d.tongChoHoan ?? 0 } };
}

export function taoYc(payload: { dealerKey: string; dealerLabel?: string | null; nguon?: 'DL' | 'QR'; lotIds: number[]; amount: number; bankCode?: string | null; accountNo?: string | null; accountName?: string | null }): Promise<AgentApiResult<{ data: YeuCauHoan; message: string }>> {
  return jsonPost('/v1/refund-request', payload);
}
export function xacNhanYcDaChuyen(code: string, paidRef?: string | null): Promise<AgentApiResult<{ message: string }>> {
  return jsonPost('/v1/refund-request/paid', { code, paidRef: paidRef ?? null });
}
export function huyYc(code: string): Promise<AgentApiResult<{ message: string }>> {
  return jsonPost('/v1/refund-request/cancel', { code });
}

export function setBaocoFeeType(billId: string, feeType: 'cho' | 'nhanh'): Promise<AgentApiResult<{ message: string }>> {
  return jsonPost('/v1/digistore/baoco-fee-type', { billId, feeType });
}
export function postPosLotRecon(lotIds: number[], ds: boolean): Promise<AgentApiResult<{ message: string }>> {
  return jsonPost('/v1/pos-lot/recon', { lotIds, ds });
}
/** [Admin Demo 21/9] GHI CHÚ per-lô — một nguồn pos_lot_recon.note, hiện đồng nhất bảng lô ĐL/NĐT/hoàn tiền. */
export function postLotNote(lotId: number, note: string): Promise<AgentApiResult<{ message: string }>> {
  return jsonPost('/v1/pos-lot/note', { lotId, note });
}
export function postLotRefundDone(lotIds: number[], dealer: string, amount: number): Promise<AgentApiResult<{ message: string }>> {
  return jsonPost('/v1/pos-lot/refund-done', { lotIds, dealer, amount });
}
export function postLotRefundUndo(lotIds: number[]): Promise<AgentApiResult<{ message: string }>> {
  return jsonPost('/v1/pos-lot/refund-undo', { lotIds });
}

async function jsonPost<T>(path: string, body?: unknown): Promise<AgentApiResult<T>> {
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true, data: json as T };
}
