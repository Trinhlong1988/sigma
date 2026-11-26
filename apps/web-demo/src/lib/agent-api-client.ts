// SIGMA Phase 3 (24/7) — client gọi bot-api thật cho nghiệp vụ "Bán TID" (apps/bot-api/src/routes/me.ts,
// RC-auth MỚI — KHÔNG dùng Bearer key tĩnh của routes/agents.ts/lo.ts cũ).
// SIGMA (26/7) — kiến trúc mới "bot-api làm trung gian TOÀN BỘ giao tiếp RC": session cục bộ KHÔNG còn giữ
// authToken (xem session.ts) — KHÔNG còn header x-rc-auth-token/x-rc-user-id tự gắn tay, dùng
// `credentials:'include'` để cookie httpOnly `sigma_ws` tự gửi kèm, bot-api (requireRcAuth, đã thêm
// fallback đọc cookie — xem rc-auth-middleware.ts) tự suy ra agentId từ đó. CÙNG convention discriminated
// union AgentApiResult<T> với bot-api-client.ts (2 endpoint đăng ký OTP) — tách file riêng vì 2 nhóm endpoint
// khác mối quan tâm (auth công khai, KHÔNG cần session, vs nghiệp vụ đại lý CẦN session), gộp chung sẽ lẫn 2
// concern khác nhau.
import { handleSessionExpired } from './session';
import { PARSE_ERROR_VI, networkErrorMessage } from './error-i18n';
import { proxyFetch } from './proxy-fetch';

export type AgentApiResult<T> = { ok: true; data: T } | { ok: false; error: string; message: string };

function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Gói fetch chung tới /v1/me/* — bắt lỗi mạng (NETWORK)/parse JSON (PARSE)/map non-2xx sang body lỗi thật của
 * bot-api, CÙNG khuôn botApiFetch (bot-api-client.ts). SIGMA (26/7) — ĐƠN GIẢN HÓA: KHÔNG còn tự check
 * "đã đăng nhập chưa" trước khi gọi (trước đây dựa vào session.authToken có/không — giá trị đó không còn tồn
 * tại ở client) — cứ gọi thẳng, bot-api tự trả 401 RC_TOKEN_INVALID/WEB_SESSION_INVALID nếu chưa đăng nhập,
 * xử lý qua nhánh `!res.ok` bên dưới như mọi lỗi khác.
 *
 * SIGMA (27/7, Admin Demo báo "vào QR/hồ sơ báo hết phiên" dù vừa đăng nhập — điều tra sâu tìm ra: RC (Rocket.
 * Chat) THẬT tự nghẽn/rate-limit khi bot-api gọi `rcGetMe` dồn dập trong `requireRcAuth` — mỗi request `/v1/me/*`
 * ĐỀU gọi RC thật, không có gì lạ nếu vài request liên tiếp có 1 cái bị RC từ chối tạm thời. Verify thật bằng
 * script Playwright: tài khoản B xem hồ sơ tài khoản A → 2 request đầu 200, request thứ 3 401 RC_TOKEN_INVALID
 * — KHÔNG phải phiên thật sự hết hạn, chỉ là RC chập chờn thoáng qua. TRƯỚC ĐÂY 1 lần 401 RC_TOKEN_INVALID BẤT
 * KỲ = đá thẳng về /login ngay — sai, xóa mất phiên hợp lệ chỉ vì RC nghẽn 1 nhịp. Sửa: RETRY 1 LẦN sau 1.5s
 * trước khi kết luận hết phiên — nếu RC chỉ nghẽn thoáng qua, lần thử lại gần như chắc chắn qua; nếu phiên THẬT
 * SỰ đã thu hồi/hết hạn, lần thử lại vẫn 401 y hệt, hành vi cũ (về /login) mới áp dụng. Đây là giảm chấn NGẮN
 * HẠN — gốc rễ thật (gọi RC thật mỗi request) sẽ hết hẳn khi Phase 1-4 "bỏ Rocket.Chat" (B37) hoàn tất. */
// SIGMA (27/7) — điều tra sâu theo yêu cầu Admin Demo: viết script cô lập chỉ gọi 4 request /v1/me/friends +
// /v1/rc/users.info liên tiếp bằng 1 tài khoản MỚI ĐĂNG KÝ (không qua UI/component nào) — request thứ 4 401
// NGAY LẬP TỨC dù request 1-3 đều 200. Xác nhận đây là rate-limit THẬT của chính Rocket.Chat áp cho token tài
// khoản mới (KHÔNG phải lỗi code, admin token gọi 8 lần liên tiếp vẫn 200 hết — verify riêng). Ngưỡng thấp
// (~3-4 request) nghĩa là 1.5s/1 lần thử lại là CHƯA ĐỦ — tăng lên 2 lần thử, giãn cách dài hơn.
const RETRY_DELAYS_MS = [3000, 6000];

async function agentApiFetch<T>(path: string, init?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown }, retryCount = 0): Promise<AgentApiResult<T>> {
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}${path}`, {
      method: init?.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
    });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI };
  }

  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    if (b?.error === 'RC_TOKEN_INVALID') {
      if (retryCount < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[retryCount]);
        return agentApiFetch<T>(path, init, retryCount + 1);
      }
      // 24/7 (task "duy trì đăng nhập 24/24") — vẫn 401 sau khi đã thử lại đủ số lần → coi là hết phiên thật,
      // dọn phiên + báo App.tsx điều hướng /login, KHÔNG để riêng luồng "Bán TID"/Lô/đối soát/kết bạn bị đơ.
      handleSessionExpired();
    }
    return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: json as T };
}

// ── GET /v1/me/tids ─────────────────────────────────────────────────────────────────────────────────────
export interface MyTidRow {
  id: number;
  tid: string;
  mid: string | null;
  status: string;
  hkdName: string | null;
  bankName: string | null;
  cardTypeOptions: { id: number; name: string }[];
}

/** Danh sách TID còn sống của đại lý ĐANG ĐĂNG NHẬP — khớp mục A0 kế hoạch (số TID/tên HKD/ngân hàng). */
export async function listMyTids(): Promise<AgentApiResult<MyTidRow[]>> {
  return agentApiFetch<MyTidRow[]>('/v1/me/tids');
}

// ── POST /v1/me/quote ────────────────────────────────────────────────────────────────────────────────────
export interface MyQuoteRowInput {
  tidId: number;
  cardTypeId?: number;
  feeTypeId?: number;
  amountBeforeFee: number;
}

export interface MyQuoteResult {
  tidId: number;
  cardTypeId: number;
  feeTypeId: number;
  amountBeforeFee: number;
  // feeApplied = "Giá bán" hiển thị cho khách; amountAfterFee = "Số tiền phải hoàn khách" — ĐÚNG 2 nhãn mục A0
  // kế hoạch (curried-plotting-hippo.md), KHÔNG dùng nhãn mơ hồ "phí"/"tổng cộng" như bản demo Phase 0 cũ.
  feeApplied: number;
  amountAfterFee: number;
}

/** Báo giá TỪNG dòng (tid × số tiền), ABORT cả phiếu nếu 1 dòng sai — khớp quy ước fee-quote.ts. */
export async function quoteMyRows(rows: MyQuoteRowInput[]): Promise<AgentApiResult<MyQuoteResult[]>> {
  return agentApiFetch<MyQuoteResult[]>('/v1/me/quote', { method: 'POST', body: { rows } });
}

// ── POST /v1/me/lo ───────────────────────────────────────────────────────────────────────────────────────
export interface MyLoResult {
  id: number;
  agentId: number;
  bankReportedLoNumber: number | null;
  expectedTotalAmount: string; // BigInt → string qua JSON, khớp CreateLoResult (lo-service.ts)
  status: string;
  createdAt: string;
  rows: {
    id: number;
    tidId: number;
    cardTypeId: number;
    feeTypeId: number;
    amountBeforeFee: string;
    feeApplied: string;
    amountAfterFee: string;
  }[];
}

/** Tạo Lô THẬT (PENDING) — CÙNG shape rows với quoteMyRows (client tự gọi /quote xem trước rồi /lo xác nhận). */
export async function createMyLo(rows: MyQuoteRowInput[]): Promise<AgentApiResult<MyLoResult>> {
  return agentApiFetch<MyLoResult>('/v1/me/lo', { method: 'POST', body: { rows } });
}

/** Kết quả recordBillSale — union RIÊNG (không dùng AgentApiResult chung) vì nhánh DUP_SUSPECT phải mang thêm
 * existingLoId/existingAt để caller cảnh báo đại lý "giống Lô đã ghi lúc HH:MM". */
export type RecordBillSaleResult =
  | { ok: true; data: MyLoResult }
  | { ok: false; error: 'DUP_SUSPECT'; message: string; existingLoId: number; existingAt: string }
  | { ok: false; error: string; message: string };

/** NỐI BILL → DOANH SỐ (Admin Demo 21/8): ghi Lô doanh số 1-dòng từ 1 bill vừa gửi (TID chuỗi OCR + số tiền + loại
 * thẻ đã chọn). error='NO_ACTUAL_SELL_FEE' (409) = TID chưa cấu hình giá bán → bill vẫn gửi, chỉ CHƯA ghi doanh
 * số. error='DUP_SUSPECT' (409) = nghi trùng giao dịch (cùng tid+tiền trong ngày, không khớp khóa bill) → CHƯA
 * ghi, caller hỏi đại lý; đúng giao dịch khác thì gọi lại `allowDuplicate:true`. KHÔNG bao giờ ném (bắt lỗi mạng).
 * Tự xử lý RC_TOKEN_INVALID (retry + hết phiên) GIỐNG agentApiFetch — KHÔNG dùng chung được vì cần giữ field phụ. */
export async function recordBillSale(
  input: {
    tid: string;
    amountBeforeFee: number;
    cardTypeId?: number;
    // Định danh bill → server dựng billKey nhiều tầng: số lô/số HĐ (tầng 1) hoặc hash ảnh (tầng 2, billImageHash
    // từ previewLoOcr). Thiếu cả → server dò "nghi trùng" cùng tid+tiền+ngày (tầng 3) → DUP_SUSPECT.
    batchNumber?: string | null;
    invoiceNumber?: string | null;
    billImageHash?: string | null;
    // true = đại lý ĐÃ xác nhận "đúng giao dịch khác" → bỏ qua dò nghi trùng, ghi Lô mới.
    allowDuplicate?: boolean;
  },
  retryCount = 0
): Promise<RecordBillSaleResult> {
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/me/lo/from-bill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI };
  }
  if (!res.ok) {
    const b = json as { error?: string; message?: string; existingLoId?: number; existingAt?: string } | null;
    if (b?.error === 'RC_TOKEN_INVALID') {
      if (retryCount < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[retryCount]);
        return recordBillSale(input, retryCount + 1);
      }
      handleSessionExpired();
    }
    if (b?.error === 'DUP_SUSPECT' && typeof b.existingLoId === 'number') {
      return { ok: false, error: 'DUP_SUSPECT', message: b.message ?? '', existingLoId: b.existingLoId, existingAt: b.existingAt ?? '' };
    }
    return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: json as MyLoResult };
}

/** Ghi doanh số bill KÈM CHỐT NGHI TRÙNG (tầng 3): gọi recordBillSale; nếu server trả DUP_SUSPECT (cùng tid+tiền
 * trong ngày, không khớp khóa bill) → HỎI đại lý bằng hộp xác nhận. Đồng ý "giao dịch khác" → gọi lại
 * allowDuplicate=true (ghi Lô thứ 2 thật). Từ chối → KHÔNG ghi trùng. Dùng window.confirm (imperative — chạy
 * được cả khi panel xem-trước đã đóng, không phụ thuộc cây React). Best-effort, KHÔNG bao giờ ném. */
export async function recordBillSaleWithDupGuard(input: {
  tid: string;
  amountBeforeFee: number;
  cardTypeId?: number;
  batchNumber?: string | null;
  invoiceNumber?: string | null;
  billImageHash?: string | null;
}): Promise<RecordBillSaleResult> {
  const r = await recordBillSale(input);
  // Narrow bằng `in` (union có error:string chồng lấn nên so === 'DUP_SUSPECT' không thu hẹp được kiểu).
  if (r.ok || !('existingLoId' in r)) return r;
  const at = r.existingAt ? new Date(r.existingAt) : null;
  const hhmm = at && !Number.isNaN(at.getTime()) ? ` lúc ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : '';
  const ask = `Doanh số bill này GIỐNG một Lô đã ghi${hhmm} hôm nay (cùng máy + cùng số tiền).\n\nNếu đây là GIAO DỊCH KHÁC, bấm OK để ghi thêm doanh số. Nếu là bill gửi lại, bấm Huỷ.`;
  const confirmFn = typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm.bind(window) : (): boolean => false;
  if (!confirmFn(ask)) return r; // đại lý xác nhận là bill gửi lại → GIỮ 1 Lô, không đếm trùng
  return recordBillSale({ ...input, allowDuplicate: true });
}

// ── GET /v1/me/qr ────────────────────────────────────────────────────────────────────────────────────────
export interface MyQrData {
  agentCode: string | null;
  imageBase64: string;
  mime: string;
  bankAccountLabel: string | null;
  qrUpdatedAt: string | null;
}

/** QR nhận tiền của đại lý đang đăng nhập. error === 'QR_NOT_CONFIGURED_YET' (bot-api trả 501) — caller PHẢI
 * xử lý riêng nhánh này bằng thông báo rõ ràng (KHÔNG coi là lỗi vỡ UI), xem SellTidModal.tsx bước 3. */
export async function getMyQr(): Promise<AgentApiResult<MyQrData>> {
  return agentApiFetch<MyQrData>('/v1/me/qr');
}

// ── GET /v1/me/fee-preview (Hoàn tiền sau phí, bảng OCR bill) ───────────────────────────────────────────────
export interface FeePreviewData {
  feeApplied: number;
  amountAfterFee: number;
  resolved: boolean;
  /** true = TID khớp đúng đại lý nhưng CHƯA cấu hình giá bán thực tế (Admin Demo 20/8: niêm yết chỉ tham khảo, KHÔNG
   * mượn) → UI hiện "chưa cấu hình giá bán" thay vì "phí 0%". */
  noActualFee?: boolean;
  /** Tỷ lệ phí bán THỰC TẾ backend đã áp (milli-%, % × 1000 — 1100 = 1.1%) — CHỈ có khi resolved:true. Dòng
   * "Hoàn tiền" hiển thị ĐÚNG tỷ lệ này (KHÔNG suy ngược feeApplied/amount → tránh lệch làm tròn/phí bậc thang). */
  phiBanMilli?: number;
  /** Loại thẻ backend đã áp để tính phí (21/8, tính năng "chọn loại thẻ + giá bán") — echo lại cardTypeId đã
   * dùng (nếu client gửi lên), hoặc loại thẻ mặc định (Visa-Master) backend tự chọn khi client bỏ trống. */
  cardTypeId?: number;
}

/** Xem trước phí bán + số tiền hoàn sau phí cho 1 TID — CHỈ HIỂN THỊ, không bao giờ lỗi (KHÔNG dùng cho luồng
 * Bán TID/tạo Lô thật, xem quoteMyRows/createMyLo). resolved:false khi TID/phí chưa cấu hình → caller hiển thị
 * phí 0% thay vì chặn luồng, xem OcrBillPreview.tsx. */
export async function getFeePreview(tid: string, amountBeforeFee: number, cardTypeId?: number): Promise<AgentApiResult<FeePreviewData>> {
  const qs = new URLSearchParams({ tid, amount: String(amountBeforeFee) });
  // cardTypeId TÙY CHỌN (21/8) — chỉ gửi khi > 0; bỏ trống → backend tự mặc định Visa-Master (xem hợp đồng API).
  if (cardTypeId != null && cardTypeId > 0) qs.set('cardTypeId', String(cardTypeId));
  return agentApiFetch<FeePreviewData>(`/v1/me/fee-preview?${qs.toString()}`);
}

// ── GET /v1/me/tid-card-options (chọn loại thẻ + giá bán, 21/8) ─────────────────────────────────────────────
// Backend nhận diện sơ bộ loại thẻ từ OCR (scheme quốc tế/nội địa + BIN 6 số đầu) rồi trả danh sách thẻ khả dụng
// cho 1 TID kèm giá bán từng loại. Type mirror THỦ CÔNG của response bot-api — field PHẢI khớp CHÍNH XÁC, đổi 1
// bên phải đổi bên kia tay (CÙNG quy ước OcrBillPreview/FeePreviewData ở trên). TID ngoài scope → mọi field
// null/rỗng (KHÔNG lỗi) → caller ẩn ô chọn thẻ.
export interface TidCardOption {
  cardTypeId: number;
  code: string | null;
  name: string;
  klass: 'INTERNATIONAL' | 'NAPAS' | 'ONUS' | 'OTHER';
  /** Giá bán (phí) THỰC TẾ của loại thẻ này (milli-%, % × 1000). null = chưa cấu hình giá bán cho loại thẻ đó. */
  phiBanMilli: number | null;
}
export interface TidCardOptions {
  bankId: number | null;
  bankCode: string | null;
  /** cardTypeId mặc định (Visa-Master) khi client không chọn/không nhận diện được. */
  defaultCardTypeId: number | null;
  /** cardTypeId backend nhận diện sơ bộ từ OCR (scheme/bin) — dùng để PRE-chọn ô thẻ. null nếu không nhận ra. */
  detectedCardTypeId: number | null;
  cards: TidCardOption[];
}

/** Danh sách loại thẻ + giá bán khả dụng cho 1 TID — CHỈ HIỂN THỊ (không bao giờ lỗi nghiệp vụ; TID ngoài scope
 * → field null/rỗng). `scheme`/`bin` TÙY CHỌN, dùng để backend PRE-chọn `detectedCardTypeId` (bin chỉ gửi khi
 * khớp 6 chữ số). Theo ĐÚNG khuôn getFeePreview ở trên. */
export async function getTidCardOptions(
  tid: string,
  scheme?: 'INTERNATIONAL' | 'DOMESTIC' | null,
  bin?: string | null
): Promise<AgentApiResult<TidCardOptions>> {
  const qs = new URLSearchParams({ tid });
  if (scheme) qs.set('scheme', scheme);
  if (bin && /^\d{6}$/.test(bin)) qs.set('bin', bin);
  return agentApiFetch<TidCardOptions>(`/v1/me/tid-card-options?${qs.toString()}`);
}

// ── Hồ sơ cá nhân (1/8, mục 39 — thay ProfileScreen.tsx Phase 0 mock hoàn toàn) — apps/bot-api/src/routes/
// me.ts + services/profile-service.ts. SỬA GẤP giữa chừng (Admin Demo): name/gender/dateOfBirth sửa TRỰC TIẾP
// qua updateMyProfile(); email PHẢI qua 2 hàm OTP riêng (requestEmailChangeOtp/confirmEmailChange, kiểu Zalo
// — OTP gửi tới email MỚI, KHÔNG phải email cũ); phone CHƯA hỗ trợ (repo chưa có hạ tầng SMS — KHÔNG có hàm
// đổi SĐT nào ở đây, ProfileScreen.tsx giữ ô SĐT read-only).

export interface AgentProfileDto {
  name: string;
  email: string | null;
  gender: string | null;
  /** ISO "YYYY-MM-DD" hoặc null nếu chưa khai. */
  dateOfBirth: string | null;
  phone: string | null;
}

/** Hồ sơ CỦA CHÍNH đại lý đang đăng nhập. */
export async function getMyProfile(): Promise<AgentApiResult<AgentProfileDto>> {
  return agentApiFetch<AgentProfileDto>('/v1/me/profile');
}

export interface UpdateProfileInput {
  name?: string;
  gender?: string;
  dateOfBirth?: string; // ISO "YYYY-MM-DD"
}

/** Sửa name/gender/dateOfBirth — partial update (field vắng mặt giữ nguyên). KHÔNG nhận email/phone (route
 * bot-api từ chối rõ ràng nếu body chứa 2 field đó — xem comment routes/me.ts). */
export async function updateMyProfile(input: UpdateProfileInput): Promise<AgentApiResult<AgentProfileDto>> {
  return agentApiFetch<AgentProfileDto>('/v1/me/profile', { method: 'PATCH', body: input });
}

/** Bước 1 đổi email — gửi OTP tới `newEmail` (KHÔNG phải email hiện tại). error==='EMAIL_ALREADY_REGISTERED'
 * (409) nếu email đã thuộc tài khoản khác — caller hiện lỗi rõ ràng. */
export async function requestEmailChangeOtp(newEmail: string): Promise<AgentApiResult<{ ok: true }>> {
  return agentApiFetch<{ ok: true }>('/v1/me/email-change/request-otp', { method: 'POST', body: { newEmail } });
}

/** Bước 2 đổi email — xác nhận mã OTP vừa gửi tới `newEmail` → ghi THẬT nếu đúng. error kiểu 'OTP_WRONG_CODE'/
 * 'OTP_EXPIRED'/'OTP_TOO_MANY_ATTEMPTS'/'EMAIL_ALREADY_REGISTERED' (race) — caller hiện đúng thông báo. */
export async function confirmEmailChange(newEmail: string, code: string): Promise<AgentApiResult<AgentProfileDto>> {
  return agentApiFetch<AgentProfileDto>('/v1/me/email-change/confirm', { method: 'POST', body: { newEmail, code } });
}

/** Bước 1 thêm/đổi SĐT — gửi OTP qua SMS (eSMS.vn) tới `phone` (SĐT MỚI). error==='SMS_NOT_CONFIGURED' (500)
 * nếu hệ thống SMS chưa cấu hình; 'OTP_SEND_FAILED' nếu nhà cung cấp lỗi — caller hiện thông báo rõ. */
export async function requestPhoneChangeOtp(phone: string): Promise<AgentApiResult<{ ok: true }>> {
  return agentApiFetch<{ ok: true }>('/v1/me/phone/otp/request', { method: 'POST', body: { phone } });
}

/** Bước 2 thêm/đổi SĐT — xác nhận mã OTP vừa gửi tới `phone` → ghi THẬT Agent.phone nếu đúng. error kiểu
 * 'OTP_WRONG_CODE'/'OTP_EXPIRED'/'OTP_TOO_MANY_ATTEMPTS' — caller hiện đúng thông báo. */
export async function confirmPhoneChange(phone: string, code: string): Promise<AgentApiResult<AgentProfileDto>> {
  return agentApiFetch<AgentProfileDto>('/v1/me/phone/otp/verify', { method: 'POST', body: { phone, code } });
}

// ── Bước 4 (24/7) — Lịch sử Lô + Đối soát (apps/bot-api/src/routes/me.ts, cùng RC-auth) ────────────────────

export interface MyLoListItem {
  id: number;
  bankReportedLoNumber: number | null;
  expectedTotalAmount: string;
  status: string;
  createdAt: string;
  rowCount: number;
}

/** Danh sách Lô CỦA CHÍNH đại lý đang đăng nhập, mới nhất trước — status optional lọc PENDING/CONFIRMED/
 * MISMATCH/CANCELLED (giá trị THẬT của Lo.status, KHÁC mã tiếng Việt mock DANG_XU_LY/... — xem
 * mock-data/status-options.ts đã thêm song song 2 bộ mã). */
export async function listMyLo(opts: { status?: string; limit?: number; offset?: number } = {}): Promise<
  AgentApiResult<{ items: MyLoListItem[]; limit: number; offset: number; total: number; hasMore: boolean }>
> {
  const qs = new URLSearchParams();
  if (opts.status) qs.set('status', opts.status);
  if (opts.limit != null) qs.set('limit', String(opts.limit));
  if (opts.offset != null) qs.set('offset', String(opts.offset));
  const q = qs.toString();
  return agentApiFetch(`/v1/me/lo${q ? `?${q}` : ''}`);
}

export interface MyLoRowDetail {
  id: number;
  tidId: number;
  cardTypeId: number;
  feeTypeId: number;
  amountBeforeFee: string;
  feeApplied: string;
  amountAfterFee: string;
}
export interface MyLoBillDetail {
  id: number;
  receiptNumber: number | null;
  ocrAmount: string;
  swipeAt: string;
  cardLast4: string | null;
}
// Mã Rule THẬT (khớp lo-service.ts RuleViolationEntry) — khác chữ cái đơn A-F của mock-data/types.ts, cần
// map ở component hiển thị (xem ReconcileDetailScreen.tsx).
export interface MyLoViolation {
  rule: 'A_MAX_AMOUNT' | 'B_MAX_SWIPES_PER_DAY' | 'C_ROUND_AMOUNT' | 'D_MIN_GAP' | 'E_REPEATED_AMOUNT_NEARBY' | 'F_DAILY_TOTAL_PER_TID';
  billIndex?: number;
  cardLast4?: string | null;
  tidId?: number;
  message: string;
}
export interface MyLoDetail {
  id: number;
  agentId: number;
  bankReportedLoNumber: number | null;
  expectedTotalAmount: string;
  status: string;
  cancelReason: string | null;
  createdAt: string;
  rows: MyLoRowDetail[];
  bills: MyLoBillDetail[];
  violations: MyLoViolation[];
  // AUDIT 24/7 (MEDIUM, đã fix): MISMATCH có thể do lệch tam giác/trùng số lô mà KHÔNG kèm violations[]
  // nào — 2 field này giải thích lý do đó (null nếu Lô chưa từng đối soát/không gặp trường hợp này).
  triangulation: { blame: string; message: string } | null;
  loNumberReuse: { violated: boolean; message: string } | null;
}

/** Chi tiết 1 Lô — 404 nếu Lô KHÔNG thuộc đại lý đang đăng nhập (ranh giới bảo mật, xem me.ts). */
export async function getMyLoDetail(loId: number): Promise<AgentApiResult<MyLoDetail>> {
  return agentApiFetch<MyLoDetail>(`/v1/me/lo/${loId}`);
}

export interface ReconcileIndividualBillInput {
  amount: number;
  receiptNumber?: number | null;
  cardLast4?: string | null;
  swipeAt: string; // ISO
}
export interface ReconcileRequestBody {
  summaryOcr: { amount: number; receiptNumber?: number | null; bankReportedLoNumber?: number | null };
  individualBills: ReconcileIndividualBillInput[];
}
export interface ReconcileResultDto {
  loId: number;
  status: string;
  eligibleForTransactionCreation: boolean;
  triangulation: { blame: string; message: string };
  loNumberReuse: { violated: boolean; message: string };
  violations: MyLoViolation[];
}

/** Đối soát 1 Lô — CHƯA có pipeline OCR thật (đúng phạm vi kế hoạch mục D.4, "input coi như đã OCR sẵn"),
 * client nhập tay summary + bill lẻ qua form (xem ReconcileDetailScreen.tsx). */
export async function reconcileMyLo(loId: number, body: ReconcileRequestBody): Promise<AgentApiResult<ReconcileResultDto>> {
  return agentApiFetch<ReconcileResultDto>(`/v1/me/lo/${loId}/reconcile`, { method: 'POST', body });
}

// ── OCR preview số tiền bill (31/7 tiếp B71-part2) — nối POST /v1/me/lo/ocr-preview (apps/bot-api/src/
// routes/me.ts, xem ocr-bridge.ts) vào form nhập tay ReconcileDetailScreen.tsx. Route CHỈ xem trước/gợi ý
// điền field "Tổng tiền OCR (bill tổng kết)" — KHÔNG tự ghi Lô/đối soát nào, reconcileMyLo() ở trên GIỮ
// NGUYÊN 100%.
//
// Type mirror THỦ CÔNG của OcrAmountPreview (apps/bot-api/src/ocr-bridge.ts) — web-demo và bot-api là 2 app
// build riêng, KHÔNG import chéo qua ranh giới app (CÙNG cách MyLoViolation ở trên mirror RuleViolationEntry
// của lo-service.ts) — field PHẢI khớp CHÍNH XÁC, đổi 1 bên phải đổi bên kia tay.
export interface OcrAmountPreview {
  found: boolean;
  rawText: string | null;
  parsedAmount: number | null;
  needsManualReview: boolean;
  // AUDIT độc lập B71-part2 (31/7): rawText/reasons[] là dữ liệu OCR đọc từ ảnh do CHÍNH đại lý tự chụp/tải
  // lên — "attacker-influenceable". Nơi render 2 field này (ReconcileDetailScreen.tsx) BẮT BUỘC hiển thị dạng
  // TEXT THUẦN, TUYỆT ĐỐI KHÔNG dangerouslySetInnerHTML.
  reasons: string[];
}

// ── Mở rộng 6 trường bill (1/8, theo yêu cầu Admin Demo) — Type mirror THỦ CÔNG của OcrBillFieldValue/
// OcrBillPreview + `tidMatched` (apps/bot-api/src/ocr-bridge.ts + routes/me.ts, matchBillTidWithAgentTids) —
// field PHẢI khớp CHÍNH XÁC, đổi 1 bên phải đổi bên kia tay. `OcrBillPreview` MỞ RỘNG `OcrAmountPreview` thay
// vì sửa trực tiếp interface đó — ocr-preview-ui.ts/ocr-preview-ui.test.ts CHỈ cần biết 5 field số tiền cũ,
// giữ NGUYÊN không đổi (test hiện có dùng object literal 5-field, thêm field bắt buộc vào OcrAmountPreview sẽ
// vỡ tsc ở đó).
export interface OcrBillFieldValue {
  value: string;
  /** true = "gợi ý, chưa chắc chắn" (confidence dòng OCR thấp) — hiển thị KHÁC mức tin tưởng field đã đọc
   * chắc, CÙNG nguyên tắc rawText/reasons[] ở trên: dữ liệu do đại lý tự chụp ảnh, hiển thị TEXT THUẦN. */
  uncertain: boolean;
}

// Type mirror THỦ CÔNG của SettlementRiskWarning (apps/bot-api/src/ocr-bridge.ts, 1/8 — rule cảnh báo mã đóng
// lô rủi ro ĐÓNG(95) đọc được trên bill OCR) — field PHẢI khớp CHÍNH XÁC, đổi 1 bên phải đổi bên kia tay.
export interface SettlementRiskWarning {
  code: string;
  message: string;
}

export interface OcrBillPreview extends OcrAmountPreview {
  tid: OcrBillFieldValue | null;
  hkdName: OcrBillFieldValue | null;
  dateTime: OcrBillFieldValue | null;
  batchNumber: OcrBillFieldValue | null;
  invoiceNumber: OcrBillFieldValue | null;
  bankName: OcrBillFieldValue | null;
  /** true nếu `tid` đọc được KHỚP CHÍNH XÁC 1 TID đã cấu hình của đại lý đang đăng nhập — khi true, hkdName/
   * bankName TRẢ VỀ TỪ DỮ LIỆU ĐÃ CẤU HÌNH (đáng tin hơn text OCR đọc chữ), KHÔNG PHẢI text OCR thô nữa. */
  tidMatched: boolean;
  /** khác null = bill có mã đóng lô rủi ro (vd ĐÓNG(95)) đọc được trong OCR — hiển thị cảnh báo ĐỎ, mức cao
   * nhất, NGAY khi quét ra. null = không phát hiện mã rủi ro đã biết (hiển thị "Hợp lệ"). */
  settlementRisk: SettlementRiskWarning | null;
  /** Loại thẻ nhận diện SƠ BỘ từ OCR (21/8) — 'INTERNATIONAL' (Visa/Master) / 'DOMESTIC' (Napas nội địa) /
   * null nếu không đủ tin. Dùng làm gợi ý `scheme` cho getTidCardOptions() → backend PRE-chọn loại thẻ. */
  detectedCardScheme?: 'INTERNATIONAL' | 'DOMESTIC' | null;
  /** 6 chữ số đầu (BIN) đọc được từ số thẻ trên bill (21/8) — dùng làm gợi ý `bin` cho getTidCardOptions().
   * null nếu không đọc được. */
  detectedBin6?: string | null;
  /** HASH (sha256) của ẢNH bill gốc (21/8) — server tính, client chuyển tiếp sang recordBillSale làm KHÓA DEDUP
   * TẦNG 2: bill không đọc được số lô/số HĐ (vd bill MB) nhưng gửi lại CÙNG file ảnh → gộp cùng Lô, KHÔNG tách
   * doanh số. Chuỗi opaque, client KHÔNG diễn giải. */
  billImageHash?: string | null;
}

/** Xem trước số tiền OCR từ 1 ảnh bill (multipart, field "image") — KHÔNG dùng agentApiFetch() ở trên vì hàm
 * đó LUÔN set `Content-Type: application/json`, sẽ phá vỡ boundary multipart (trình duyệt phải tự set
 * Content-Type kèm boundary khi body là FormData, không được set tay). Viết fetch riêng ở đây nhưng giữ CÙNG
 * cách xử lý lỗi/retry RC_TOKEN_INVALID với agentApiFetch để hành vi nhất quán toàn app (phiên hết hạn đúng
 * lúc đang chụp ảnh vẫn được xử lý đúng, không vỡ UI).
 *
 * `loId` hiện KHÔNG được gửi trong request (route bot-api `/v1/me/lo/ocr-preview` CHƯA scope theo loId cụ thể
 * — CHỈ xem trước số tiền chung, không gắn với 1 Lô nào) — giữ tham số này ở chữ ký hàm để khớp call-site
 * (ReconcileDetailScreen.tsx đang ở trong context 1 Lô cụ thể) và để không phải đổi chữ ký nếu route sau này
 * đổi sang scope theo loId — KHÔNG tự suy diễn thêm hành vi nào từ tham số chưa dùng này. */
export async function previewLoOcr(loId: number, file: File, retryCount = 0): Promise<AgentApiResult<OcrBillPreview>> {
  void loId; // xem chú thích trên — route hiện chưa dùng loId, giữ tham số cho tương lai/khớp call-site.

  const form = new FormData();
  form.append('image', file, file.name);

  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/me/lo/ocr-preview`, { method: 'POST', body: form });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI };
  }

  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    if (b?.error === 'RC_TOKEN_INVALID') {
      if (retryCount < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[retryCount]);
        return previewLoOcr(loId, file, retryCount + 1);
      }
      handleSessionExpired();
    }
    return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: json as OcrBillPreview };
}

// ── "Hoàn tiền" (2/8, tính năng MỚI, Admin Demo yêu cầu trực tiếp) — biên lai chuyển khoản HOÀN TIỀN, KHÁC hẳn
// bill quẹt thẻ gốc ở trên (định dạng OCR khác — xem apps/bot-api/src/ocr-bridge.ts buildRefundReceiptPreview()
// + đối chiếu "Người nhận" refund-service.ts matchRefundRecipient()). Type mirror THỦ CÔNG — field PHẢI khớp
// CHÍNH XÁC 2 phía, đổi 1 bên phải đổi bên kia tay (CÙNG quy ước OcrBillPreview/FeePreviewData ở trên).
export type RecipientMatchStatus = 'matched' | 'mismatched' | 'not_configured' | 'no_tid' | 'unread';

export interface RecipientMatchResult {
  status: RecipientMatchStatus;
  configuredAccountName: string | null;
  configuredAccountNumber: string | null;
  message: string;
}

export interface RefundReceiptPreview extends OcrAmountPreview {
  bankName: OcrBillFieldValue | null;
  senderName: OcrBillFieldValue | null;
  recipientName: OcrBillFieldValue | null;
  recipientAccountNumber: OcrBillFieldValue | null;
  dateTime: OcrBillFieldValue | null;
  recipientMatch: RecipientMatchResult;
}

/** Xem trước OCR 1 ảnh biên lai chuyển khoản hoàn tiền — CÙNG khuôn multipart `previewLoOcr()` trên (retry
 * RC_TOKEN_INVALID giống hệt). `originalTid` (TID đọc từ bill GỐC, lấy từ `billMeta.billFields.tid?.value` của
 * tin nhắn đang trả lời) — dùng để đối chiếu "Người nhận" với `ReceiveAccount` đã cấu hình cho TID đó, BỎ TRỐNG
 * vẫn hợp lệ (server trả `recipientMatch.status='no_tid'`, KHÔNG lỗi/không chặn luồng). */
export async function previewRefundOcr(file: File, originalTid: string | undefined, retryCount = 0): Promise<AgentApiResult<RefundReceiptPreview>> {
  const form = new FormData();
  form.append('image', file, file.name);
  const qs = originalTid ? `?originalTid=${encodeURIComponent(originalTid)}` : '';

  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/me/refund/ocr-preview${qs}`, { method: 'POST', body: form });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI };
  }

  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    if (b?.error === 'RC_TOKEN_INVALID') {
      if (retryCount < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[retryCount]);
        return previewRefundOcr(file, originalTid, retryCount + 1);
      }
      handleSessionExpired();
    }
    return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: json as RefundReceiptPreview };
}

export interface RefundConfirmationSummary {
  messageId: string;
  amount: number;
  createdAt: string;
  editedAt: string | null;
}

export type RefundAggregateStatus = 'none' | 'partial' | 'matched' | 'over';

export interface RefundAggregateResult {
  status: RefundAggregateStatus;
  diff: number;
  totalConfirmed: number;
  requiredAmount: number;
}

/** Trạng thái cộng dồn (Admin Demo: cho phép hoàn tiền NHIỀU LẦN cho 1 bill) — GET /v1/me/refund/aggregate.
 * `excludeMessageId` (dùng lúc "Sửa" 1 lần hoàn tiền cụ thể, KHÔNG gửi lên server — server KHÔNG biết khái
 * niệm "loại trừ", client tự lọc `confirmations` trả về TRƯỚC khi tính lại nếu cần, xem EditRefundMessageModal.tsx). */
export async function getRefundAggregate(originalMessageId: string, requiredAmount: number): Promise<AgentApiResult<{ confirmations: RefundConfirmationSummary[]; aggregate: RefundAggregateResult }>> {
  const qs = new URLSearchParams({ originalMessageId, requiredAmount: String(requiredAmount) });
  return agentApiFetch(`/v1/me/refund/aggregate?${qs.toString()}`);
}

// ── Kết bạn (24/7, mục 27 kế hoạch) — apps/bot-api/src/routes/me.ts, business logic friend-service.ts ─────

export interface FriendRequestDto {
  id: number;
  fromAgentId: number;
  toAgentId: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
}
export interface FriendRequestSendResult extends FriendRequestDto {
  /** true nếu chiều ngược lại ĐÃ có lời mời PENDING trước, được tự động chấp nhận thay vì tạo lời mời mới
   * (xem quyết định thiết kế friend-service.ts) — frontend nên hiện thông báo "Đã thành bạn bè!" thay vì
   * "Đã gửi lời mời" khi cờ này bật. */
  autoAccepted: boolean;
}
export interface FriendListItem {
  requestId: number;
  agentId: number;
  agentCode: string | null;
  agentName: string;
  acceptedAt: string | null;
  /** Trạng thái online kiểu Zalo (BUG#10, 6/8 — Admin Demo) — NAY NỐI THẬT: bot-api trả `boolean` theo presence
   * hub WS (agentHasOpenConnection, xem friend-service.ts listFriends). `null` chỉ còn cho dữ liệu cũ/thiếu
   * field. FE: chấm XANH=online / ĐỎ=offline + dòng "Đang hoạt động"/"Ngoại tuyến" (ContactsScreen.tsx). */
  online: boolean | null;
  /** Presence "Hoạt động X phút trước" kiểu Zalo (6/8) — ISO thời điểm hoạt động cuối (offline) hoặc null. Server
   * (presence agent) đính kèm; FE seed vào presence-store + hiện qua formatLastSeen (ContactsScreen). */
  lastSeenAt?: string | null;
  /** 25/7 (mục "Lịch" — thông báo sinh nhật) — ISO date "YYYY-MM-DD" (qua JSON.stringify của Date phía
   * bot-api) hoặc null nếu bạn bè chưa khai ngày sinh. Dùng ở lib/birthday-notify.ts. */
  dateOfBirth: string | null;
  /** 4/8 — giới tính bạn bè để hiện trong hồ sơ mini danh bạ. "MALE"|"FEMALE"|"OTHER"|null (chưa khai). */
  gender: string | null;
  /** username Rocket.Chat của bạn bè — cần để tạo/lấy phòng chat 1-1 (im.create) khi gửi tin chúc mừng sinh
   * nhật tự động. null nếu bạn bè chưa link RC. */
  rcUsername: string | null;
  /** Biệt danh MÌNH đặt cho người bạn này (25/7) — null = chưa đặt, hiện tên thật. */
  nickname: string | null;
  /** 25/7 — MÌNH có chặn người này không (dùng hiện đúng trạng thái nút "Chặn"/"Bỏ chặn"). */
  blockedByMe: boolean;
  /** 25/7 — người NÀY có chặn MÌNH không. CHỈ dùng để enforce (ẩn/disable Nhắn tin/Gọi) — KHÔNG hiện chi
   * tiết "họ đã chặn bạn" ra UI (xem ContactsScreen.tsx). */
  blockedThem: boolean;
  /** 31/7 — phân loại MÀ MÌNH gán CHO người bạn này ('FAMILY'|'WORK'|null = chưa phân loại), 1 chiều — xem
   * setFriendCategory bot-api. */
  category: FriendCategory;
  /** 5/8 — bạn đã VÔ HIỆU HÓA (đang chờ xóa/đã xóa). FE ẩn trạng thái online + chặn nhắn tin. */
  deactivated: boolean;
}
export interface FriendRequestListItem {
  requestId: number;
  agentId: number;
  agentCode: string | null;
  agentName: string;
  createdAt: string;
}
export interface FriendListResult {
  friends: FriendListItem[];
  incomingRequests: FriendRequestListItem[];
  outgoingRequests: FriendRequestListItem[];
}

/** Ngưỡng hiện badge "Bạn mới" — B107-tiếp (2/8) Admin Demo CHỐT LẠI TRỰC TIẾP "60 phút" (SỬA ngưỡng cũ "5 ngày"
 * 24/7 — đó là quyết định TỰ CHỌN của phiên trước, chưa từng được Admin Demo xác nhận, nay đã có chỉ đạo rõ ràng
 * thay thế). Đổi ở ĐÚNG 1 chỗ này. */
export const NEW_FRIEND_BADGE_THRESHOLD_MINUTES = 60;

/** true nếu `acceptedAt` nằm trong ngưỡng "bạn mới" — dùng ở ContactsScreen.tsx để hiện badge. */
export function isRecentlyAcceptedFriend(acceptedAt: string | null): boolean {
  if (!acceptedAt) return false;
  const ms = Date.now() - new Date(acceptedAt).getTime();
  return ms >= 0 && ms <= NEW_FRIEND_BADGE_THRESHOLD_MINUTES * 60 * 1000;
}

/** Gửi lời mời kết bạn tới agentId khác — CÓ THỂ trả `autoAccepted:true` (xem FriendRequestSendResult). */
export async function sendFriendRequest(toAgentId: number): Promise<AgentApiResult<FriendRequestSendResult>> {
  return agentApiFetch<FriendRequestSendResult>('/v1/me/friends/request', { method: 'POST', body: { toAgentId } });
}

/** Chấp nhận lời mời kết bạn ĐANG CHỜ mình trả lời (requestId từ incomingRequests). */
export async function acceptFriendRequest(requestId: number): Promise<AgentApiResult<FriendRequestDto>> {
  return agentApiFetch<FriendRequestDto>(`/v1/me/friends/${requestId}/accept`, { method: 'POST' });
}

/** Từ chối lời mời kết bạn ĐANG CHỜ mình trả lời. */
export async function rejectFriendRequest(requestId: number): Promise<AgentApiResult<FriendRequestDto>> {
  return agentApiFetch<FriendRequestDto>(`/v1/me/friends/${requestId}/reject`, { method: 'POST' });
}

/** Hủy kết bạn (đã ACCEPTED) HOẶC thu hồi lời mời mình đã gửi (PENDING) — cùng 1 endpoint, xem
 * friend-service.ts quyết định thiết kế #1. friendAgentId = id đại lý bên kia (KHÔNG phải requestId). */
export async function unfriend(friendAgentId: number): Promise<AgentApiResult<FriendRequestDto>> {
  return agentApiFetch<FriendRequestDto>(`/v1/me/friends/${friendAgentId}/unfriend`, { method: 'POST' });
}

/** Bạn bè (ACCEPTED) + lời mời đang chờ (gửi đi + nhận về) của đại lý đang đăng nhập. */
export async function listMyFriends(): Promise<AgentApiResult<FriendListResult>> {
  return agentApiFetch<FriendListResult>('/v1/me/friends');
}

export interface AgentLookupResult {
  id: number;
  code: string | null;
  name: string;
}

/** Tra cứu CHÍNH XÁC 1 mã đại lý để làm căn cứ gửi lời mời kết bạn (KHÔNG phải tìm kiếm Danh bạ nội bộ đầy
 * đủ — mục đó còn treo riêng, xem VERSION.md). Dùng cho ô "Thêm bạn qua mã đại lý" ở ContactsScreen. */
export async function lookupAgentByCode(agentCode: string): Promise<AgentApiResult<AgentLookupResult>> {
  return agentApiFetch<AgentLookupResult>(`/v1/me/friends/lookup?agentCode=${encodeURIComponent(agentCode)}`);
}

/** 31/7 — căn cứ tìm bạn THỨ 2 bên cạnh mã đại lý (lookupAgentByCode ở trên, GIỮ NGUYÊN): tra theo EMAIL
 * (chứa '@', khớp CHÍNH XÁC → data là 1 `AgentLookupResult`) hoặc SĐT (khớp CHÍNH XÁC sau chuẩn hoá bỏ
 * khoảng trắng/gạch ngang → data là MẢNG `AgentLookupResult[]`, có thể rỗng nếu không tìm thấy — KHÔNG phải
 * lỗi, xem lookupAgentByEmailOrPhone bot-api). Dùng cho ô "Hoặc tìm theo email/SĐT" ở ContactsScreen. */
export async function lookupAgentByContact(query: string): Promise<AgentApiResult<AgentLookupResult | AgentLookupResult[]>> {
  return agentApiFetch<AgentLookupResult | AgentLookupResult[]>(`/v1/me/friends/lookup-by-contact?q=${encodeURIComponent(query)}`);
}

// ── Biệt danh + Chặn (25/7, Admin Demo yêu cầu) ────────────────────────────────────────────────────────────

export interface SetNicknameResult {
  friendAgentId: number;
  nickname: string | null;
}

/** Đặt/xóa biệt danh MÀ MÌNH đặt CHO friendAgentId (1 chiều, KHÔNG đổi tên thật/không ảnh hưởng người kia).
 * nickname=null → xóa (về lại tên thật). */
export async function setFriendNickname(friendAgentId: number, nickname: string | null): Promise<AgentApiResult<SetNicknameResult>> {
  return agentApiFetch<SetNicknameResult>(`/v1/me/friends/${friendAgentId}/nickname`, { method: 'POST', body: { nickname } });
}

export interface SetBlockResult {
  friendAgentId: number;
  blockedByMe: boolean;
}

/** Chặn 1 người bạn (voice/video call + nhắn tin) — 1 chiều, KHÔNG hủy kết bạn. */
export async function blockFriend(friendAgentId: number): Promise<AgentApiResult<SetBlockResult>> {
  return agentApiFetch<SetBlockResult>(`/v1/me/friends/${friendAgentId}/block`, { method: 'POST' });
}

/** Bỏ chặn 1 người bạn. */
export async function unblockFriend(friendAgentId: number): Promise<AgentApiResult<SetBlockResult>> {
  return agentApiFetch<SetBlockResult>(`/v1/me/friends/${friendAgentId}/unblock`, { method: 'POST' });
}

// ── Phân loại bạn bè (31/7, Admin Demo yêu cầu "Gia đình"/"Công việc") ─────────────────────────────────────────

export type FriendCategory = 'FAMILY' | 'WORK' | null;

export interface SetCategoryResult {
  friendAgentId: number;
  category: FriendCategory;
}

/** Đặt/xóa phân loại MÀ MÌNH gán CHO friendAgentId ('FAMILY'|'WORK'|null — 1 chiều, KHÔNG ảnh hưởng người
 * kia). category=null → gỡ phân loại (về "Không phân loại"). */
export async function setFriendCategory(friendAgentId: number, category: FriendCategory): Promise<AgentApiResult<SetCategoryResult>> {
  return agentApiFetch<SetCategoryResult>(`/v1/me/friends/${friendAgentId}/category`, { method: 'PATCH', body: { category } });
}

// ── Xóa tài khoản, 48h ân hạn (25/7, Admin Demo yêu cầu) — apps/bot-api/src/routes/me.ts ───────────────────────
export interface DeletionStatus {
  /** ISO string lúc bấm "Xóa tài khoản", null = không có yêu cầu nào đang treo. */
  deletionRequestedAt: string | null;
  /** ISO string thời điểm sẽ bị xóa THẬT (= deletionRequestedAt + 48h), null nếu không có yêu cầu. */
  deleteAt: string | null;
}

/** Trạng thái yêu cầu xóa hiện tại — gọi lúc mở màn "Tài khoản & bảo mật" để hiện đúng trạng thái dù tải lại trang. */
export async function getDeletionStatus(): Promise<AgentApiResult<DeletionStatus>> {
  return agentApiFetch<DeletionStatus>('/v1/me/deletion-status');
}

/** BƯỚC 1 xóa tài khoản (bảo mật 6/8) — gửi OTP tới email tài khoản SAU KHI xác thực mật khẩu. Sai mật khẩu →
 * server trả 401 (WRONG_PASSWORD); tài khoản không có email → 400 (NO_EMAIL). Thành công → {ok:true} (mã gửi qua
 * email, KHÔNG trả về client). */
export async function sendAccountDeletionOtp(password: string): Promise<AgentApiResult<{ ok: true }>> {
  return agentApiFetch<{ ok: true }>('/v1/me/request-deletion/send-otp', { method: 'POST', body: { password } });
}

/** BƯỚC 2 xóa tài khoản — xác nhận bằng mã OTP (6 số email) + mã xác nhận 2 số hiển thị trên màn. Đúng cả hai →
 * bắt đầu đếm 48h ân hạn (IDEMPOTENT: gọi lại không reset đồng hồ). Sai OTP → 400; mã 2 số không hợp lệ → 400. */
export async function confirmAccountDeletion(code: string, confirmNumber: string): Promise<AgentApiResult<DeletionStatus>> {
  return agentApiFetch<DeletionStatus>('/v1/me/request-deletion/confirm', { method: 'POST', body: { code, confirmNumber } });
}

/** Hủy yêu cầu xóa đang treo (còn trong 48h ân hạn) — tài khoản trở lại bình thường ngay. */
export async function cancelAccountDeletion(): Promise<AgentApiResult<DeletionStatus>> {
  return agentApiFetch<DeletionStatus>('/v1/me/cancel-deletion', { method: 'POST' });
}

// ── Thiết bị / phiên đang đăng nhập (5/8) — apps/bot-api/src/routes/me.ts (GET /v1/me/sessions +
// POST /v1/me/sessions/:id/revoke) — danh sách thiết bị kiểu Zalo/Facebook cho màn "Tài khoản & bảo mật". ─────
export interface MySessionItem {
  id: string;
  /** ISO string lúc tạo phiên (đăng nhập trên thiết bị đó). */
  createdAt: string;
  /** ISO string lần cuối thiết bị đó gọi request (server tự cập nhật mỗi request). */
  lastUsedAt: string;
  /** true = chính thiết bị đang xem màn này (đánh dấu "Thiết bị này", KHÔNG hiện nút đăng xuất riêng). */
  current: boolean;
  /** Nhãn thiết bị hiển thị kiểu Zalo: app native → "Ứng dụng SigMa (Máy tính)/(Android)"; trình duyệt →
   * "Chrome · Windows", "Safari · iPhone"...; phiên cũ/không có UA → "Thiết bị web/app". */
  deviceLabel: string;
  /** Loại thiết bị để chọn icon: 'pc' → biểu tượng máy tính, 'mobile' → biểu tượng điện thoại. */
  kind: 'pc' | 'mobile';
}

/** Danh sách phiên/thiết bị CÒN HẠN của đại lý đang đăng nhập, mới-hoạt-động-nhất trước. Bóc `items` ra khỏi
 * lớp bọc `{items}` của server để caller dùng thẳng mảng (cùng cách các hàm list khác trong file này). */
export async function listMySessions(): Promise<AgentApiResult<MySessionItem[]>> {
  const r = await agentApiFetch<{ items: MySessionItem[] }>('/v1/me/sessions');
  if (!r.ok) return r;
  return { ok: true, data: r.data.items };
}

/** Đăng xuất 1 thiết bị KHÁC theo id phiên. Server chặn revoke phiên hiện tại (trả 400 CANNOT_REVOKE_CURRENT)
 * — UI đã ẩn nút cho phiên `current` nên trường hợp đó không xảy ra bình thường. */
export async function revokeMySession(sessionId: string): Promise<AgentApiResult<{ ok: true }>> {
  return agentApiFetch<{ ok: true }>(`/v1/me/sessions/${encodeURIComponent(sessionId)}/revoke`, { method: 'POST' });
}

/** Đăng xuất TẤT CẢ thiết bị KHÁC (giữ phiên hiện tại) — kiểu Zalo. Trả về revokedCount để UI hiện toast số
 * thiết bị đã đăng xuất. Server tự loại phiên hiện tại theo cookie (client không cần gửi id). */
export async function revokeOtherSessions(): Promise<AgentApiResult<{ ok: true; revokedCount: number }>> {
  return agentApiFetch<{ ok: true; revokedCount: number }>('/v1/me/sessions/revoke-others', { method: 'POST' });
}

// ── Link cá nhân → hồ sơ công khai (25/7, mục 24/34) — apps/bot-api/src/routes/profile.ts (file MỚI, tách
// riêng khỏi me.ts đang có agent khác sửa song song) ─────────────────────────────────────────────────────
export interface PublicAgentLookup {
  agentId: number;
  agentCode: string | null;
  agentName: string;
}

/** Tra 1 username Rocket.Chat ra agentId SigMa (nếu có liên kết) — dùng ở PublicProfileScreen.tsx để nút
 * "Kết bạn" gọi tiếp được `sendFriendRequest(agentId)` đã có sẵn. 404 (KHÔNG tìm thấy) là kết quả HỢP LỆ —
 * caller tự hiện thông báo phù hợp, không phải lỗi hệ thống. */
export async function getAgentByRcUsername(username: string): Promise<AgentApiResult<PublicAgentLookup>> {
  return agentApiFetch<PublicAgentLookup>(`/v1/profile/by-rc-username/${encodeURIComponent(username)}`);
}

// ── Phase 3 (25/7) — thiết bị tin cậy ("thiết bị mới → OTP; thiết bị cũ đã đăng nhập rồi → chỉ cần mật khẩu") ──

export interface IssuedDeviceToken {
  token: string;
  expiresAt: string;
}

/** POST /v1/auth/device-token/issue — gọi SAU KHI đã có phiên hợp lệ (đăng nhập vừa qua đủ OTP, hoặc vừa
 * đăng ký) để cấp vé nhớ máy cho lần đăng nhập KẾ TIẾP trên CÙNG máy — xem LoginScreen.tsx/session.ts. */
export async function issueDeviceToken(label?: string): Promise<AgentApiResult<IssuedDeviceToken>> {
  return agentApiFetch<IssuedDeviceToken>('/v1/auth/device-token/issue', { method: 'POST', body: { label } });
}

// ── Push notification kiểu Zalo (26/7, FCM) — apps/bot-api/src/routes/me.ts POST /v1/me/push-token ────────

/** Đăng ký token FCM của thiết bị này với bot-api (UPSERT theo token — gọi lại nhiều lần AN TOÀN, vd mỗi lần
 * mở app sau đăng nhập, xem lib/push-notifications.ts). `platform` hiện CHỈ 'android' (iOS ngoài phạm vi). */
export async function registerPushToken(token: string, platform: 'android'): Promise<AgentApiResult<{ ok: true }>> {
  return agentApiFetch<{ ok: true }>('/v1/me/push-token', { method: 'POST', body: { token, platform } });
}

// ── Phân loại nhóm chat (mục 21, việc #4, 31/7) — apps/bot-api/src/routes/me.ts, business logic
// chat-category-service.ts. Thay Phase 0 mock-only (mock-data/categories.ts + CategoryManagerModal.tsx sửa
// thẳng mảng client, mất khi reload) — dữ liệu nay sống thật ở bảng ChatCategory + cột
// ChatRoomMember.categoryId (schema.prisma). CHỜ LEAD `prisma migrate deploy` + `prisma generate` lên
// `sigma` trước khi các hàm này gọi được thật (xem BUGS_FIXED.md).

export interface ChatCategoryDto {
  id: string;
  agentId: number;
  name: string;
  color: string;
  createdAt: string;
  /** roomId CỦA CHÍNH đại lý đang đăng nhập đang gán vào phân loại này (KHÔNG phải của agent khác). */
  roomIds: string[];
}

/** Toàn bộ phân loại của đại lý đang đăng nhập (CHỈ agent tạo ra mới thấy — không dùng chung giữa nhiều agent). */
export async function listChatCategories(): Promise<AgentApiResult<ChatCategoryDto[]>> {
  return agentApiFetch<ChatCategoryDto[]>('/v1/me/categories');
}

/** Tạo phân loại mới. `color` là hex "#rrggbb" — gợi ý từ CATEGORY_SWATCHES (mock-data/categories.ts), backend
 * KHÔNG validate hex, chỉ cần chuỗi khác rỗng. */
export async function createChatCategory(name: string, color: string): Promise<AgentApiResult<ChatCategoryDto>> {
  return agentApiFetch<ChatCategoryDto>('/v1/me/categories', { method: 'POST', body: { name, color } });
}

/** Đổi tên/màu 1 phân loại — CHỈ chủ sở hữu (404 NOT_FOUND nếu không phải/không tồn tại). */
export async function updateChatCategory(categoryId: string, input: { name?: string; color?: string }): Promise<AgentApiResult<ChatCategoryDto>> {
  return agentApiFetch<ChatCategoryDto>(`/v1/me/categories/${encodeURIComponent(categoryId)}`, { method: 'PATCH', body: input });
}

/** Xóa 1 phân loại — phòng chat đang gán tự về "chưa phân loại" (KHÔNG xóa phòng, xem chat-category-service.ts). */
export async function deleteChatCategory(categoryId: string): Promise<AgentApiResult<{ id: string }>> {
  return agentApiFetch<{ id: string }>(`/v1/me/categories/${encodeURIComponent(categoryId)}`, { method: 'DELETE' });
}

/** Gán/gỡ phân loại cho 1 phòng chat CỦA CHÍNH đại lý đang đăng nhập. `categoryId: null` → gỡ (về "chưa phân
 * loại"). 403 NOT_MEMBER nếu không còn là thành viên đang hoạt động của phòng; 404 NOT_FOUND nếu categoryId
 * không thuộc chính agent này (IDOR — không cho gán phân loại của người khác). */
export async function assignChatRoomCategory(
  roomId: string,
  categoryId: string | null
): Promise<AgentApiResult<{ roomId: string; categoryId: string | null }>> {
  return agentApiFetch<{ roomId: string; categoryId: string | null }>(`/v1/me/chat-rooms/${encodeURIComponent(roomId)}/category`, {
    method: 'PATCH',
    body: { categoryId }
  });
}

// Pub-sub nhỏ (CÙNG Ý TƯỞNG notifyCategoriesChanged() cũ của mock-data/categories.ts, Phase 0 — nhưng bus MỚI
// RIÊNG cho dữ liệu THẬT, KHÔNG còn import bus mock đó vào CategoryManagerModal.tsx nữa) — CategoryManagerModal
// (sibling của Sidebar/ChatListScreen dưới AppShell, KHÔNG share state React) gọi notifyChatCategoriesChanged()
// NGAY SAU mỗi lần tạo/sửa/xóa phân loại thành công, để 2 nơi kia tự refetch danh sách qua API thật thay vì
// đợi tới lúc tự remount/điều hướng lại mới thấy dữ liệu mới.
const chatCategoryListeners = new Set<() => void>();
export function subscribeChatCategoriesChanged(cb: () => void): () => void {
  chatCategoryListeners.add(cb);
  return () => chatCategoryListeners.delete(cb);
}
export function notifyChatCategoriesChanged(): void {
  for (const cb of chatCategoryListeners) cb();
}

// ── Sao lưu Google Drive (1/8, mục 32 "Đồng bộ & Sao lưu") — apps/bot-api/src/routes/me.ts, business logic
// drive-backup-service.ts. `code` gửi lên /connect lấy được từ lib/google-drive-backup.ts
// (requestDriveBackupAuthorizationCode(), luồng OAuth Authorization Code — KHÁC HẲN luồng đăng nhập ID-token
// của google-signin.ts). CHỜ LEAD `prisma migrate deploy` + `prisma generate` (thêm cột google_drive_
// refresh_token/google_drive_last_backup_at lên bảng agents) trước khi các hàm này gọi được thật.

export interface DriveBackupStatusDto {
  connected: boolean;
  lastBackupAt: string | null;
}

/** POST /v1/me/drive-backup/connect — đổi authorization code lấy refresh_token thật, lưu MÃ HOÁ phía server.
 * Response CHỈ {ok:true, connected:true} — KHÔNG BAO GIỜ trả token dạng nào ra ngoài. */
export async function connectGoogleDriveBackup(code: string): Promise<AgentApiResult<{ ok: true; connected: true }>> {
  return agentApiFetch<{ ok: true; connected: true }>('/v1/me/drive-backup/connect', { method: 'POST', body: { code } });
}

/** GET /v1/me/drive-backup/status — đã kết nối Drive chưa + lần backup gần nhất (null nếu chưa từng backup). */
export async function getGoogleDriveBackupStatus(): Promise<AgentApiResult<DriveBackupStatusDto>> {
  return agentApiFetch<DriveBackupStatusDto>('/v1/me/drive-backup/status');
}

export interface DriveBackupRunResultDto {
  fileId: string;
  fileName: string;
  uploadedAt: string;
}

/** POST /v1/me/drive-backup/run — chạy 1 lượt backup THẬT (build JSON lịch sử chat → upload Drive của chính
 * đại lý đang đăng nhập). 400 NOT_CONNECTED nếu chưa từng /connect; 401 DRIVE_TOKEN_REFRESH_FAILED nếu quyền
 * đã bị thu hồi phía Google (SettingsScreen.tsx nên gợi ý kết nối lại khi gặp lỗi này). */
export async function runGoogleDriveBackupNow(): Promise<AgentApiResult<DriveBackupRunResultDto>> {
  return agentApiFetch<DriveBackupRunResultDto>('/v1/me/drive-backup/run', { method: 'POST' });
}

// ── Thông báo bạn bè đổi avatar/ảnh bìa (B113, 2/8, Admin Demo yêu cầu trực tiếp) ─────────────────────────────
// Nguồn thứ 3 cho chuông NotificationBell.tsx (bên cạnh lễ/Tết + sinh nhật đã có, xem lib/notifications.ts) —
// LƯU server-side qua model AgentNotification (khác 2 nguồn kia TÍNH TOÁN THUẦN client-side).
// 6/8 — thêm 2 loại Nhật ký: DIARY_COMMENT ("X bình luận bài viết của bạn"), DIARY_REACTION ("X thả cảm xúc
// bài viết của bạn"). Cụm #29 (6/8) — DIARY_POST ("X vừa đăng nhật ký mới", báo bạn bè có bài mới).
// Mirror bot-api notification-service.ts AgentNotificationType (đổi 1 bên đổi bên kia tay).
// Việc #31 (6/8) — thêm BIRTHDAY/ANNIVERSARY (chuông sự kiện lịch do worker nền bot-api holiday-push.ts sinh ra).
// Mirror bot-api notification-service.ts AgentNotificationType (đổi 1 bên đổi bên kia tay).
// 8/8 (Admin Demo "đồng bộ hóa mọi push event số đếm") — thêm 3 sự kiện KẾT NỐI (kết bạn/nhóm) vào CÙNG chuông:
// FRIEND_REQUEST/FRIEND_ACCEPT (postId=null → click về Danh bạ) + GROUP_ADDED (postId=roomId → click mở đúng nhóm).
export type AgentNotificationType =
  | 'AVATAR_UPDATED'
  | 'COVER_UPDATED'
  | 'DIARY_COMMENT'
  | 'DIARY_REACTION'
  | 'DIARY_POST'
  | 'DIARY_COMMENT_FRIEND'
  | 'DIARY_REACTION_FRIEND'
  | 'BIRTHDAY'
  | 'ANNIVERSARY'
  | 'FRIEND_REQUEST'
  | 'FRIEND_ACCEPT'
  | 'GROUP_ADDED'
  // Tag @ mention kiểu Zalo (13/8) — được nhắc (@) trong 1 tin nhắn nhóm. postId=roomId (click mở đúng phòng).
  | 'MENTION';

export interface AgentNotificationItem {
  id: number;
  type: AgentNotificationType;
  actorAgentId: number;
  actorAgentName: string;
  postId: string | null; // #26 — id bài Nhật ký (DIARY_*) để click TRỎ ĐÚNG bài + highlight; null cho loại khác.
  createdAt: string;
  readAt: string | null;
}

export interface AgentNotificationFeed {
  notifications: AgentNotificationItem[];
  unreadCount: number;
}

/** GET /v1/me/notifications — 50 gần nhất + đếm chưa đọc TOÀN BỘ (badge chuông). */
export async function listMyAgentNotifications(): Promise<AgentApiResult<AgentNotificationFeed>> {
  return agentApiFetch<AgentNotificationFeed>('/v1/me/notifications');
}

/** POST /v1/me/notifications/mark-read — đánh dấu TOÀN BỘ thông báo chưa đọc thành đã đọc (bấm mở chuông). */
export async function markMyAgentNotificationsRead(): Promise<AgentApiResult<{ ok: true; updatedCount: number }>> {
  return agentApiFetch<{ ok: true; updatedCount: number }>('/v1/me/notifications/mark-read', { method: 'POST' });
}
