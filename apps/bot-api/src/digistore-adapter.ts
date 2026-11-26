// DIGISTORE (BVBank) ADAPTER — kéo giao dịch "báo có" QR REALTIME (Admin Demo 5/9). Server tự-login bằng tài khoản
// merchant → JWT → GET /v1/portal/transaction/va?status=success. KHÔNG dùng data tĩnh; mỗi lần gọi là fetch LIVE.
//
// PER-MÃ CREDS (Admin Demo 5/9): host API là MẶC ĐỊNH CHUNG cho mọi mã QR Bản Việt
// (https://api-outscope-pos.bvbank.net.vn); mỗi MÃ QR (merchant) có username + password RIÊNG. `fetchBaoCo(creds,…)`
// nhận creds THAM SỐ; gọi không creds → fallback .env (DIGISTORE_EMAIL/PASSWORD) để tương thích. Token cache THEO email.
//
// R198 — PHÂN LOẠI LỖI ĐẦY ĐỦ (Admin Demo "log báo lỗi tất cả trường hợp"), KHÔNG gộp chung "lỗi", KHÔNG nuốt câm:
//   NO_CRED      — chưa cấu hình tài khoản (creds rỗng và .env cũng trống).
//   AUTH_FAILED  — login 401/403 / sai msg / không trả access_token / token hỏng sau re-login.
//   NETWORK      — fetch ném (timeout/DNS/mất kết nối) hoặc 5xx.
//   BAD_SHAPE    — body không phải JSON, hoặc cấu trúc transaction/va lạ (không tìm được mảng giao dịch) → log RAW head.
const DEFAULT_BASE = 'https://api-outscope-pos.bvbank.net.vn';

/** Base API DigiStore mặc định (đọc env LÚC GỌI). Per-mã KHÔNG cần điền base — chỉ user+pass. */
export function digistoreDefaultBase(): string {
  return process.env.DIGISTORE_BASE || DEFAULT_BASE;
}

export type DigistoreErrorCode = 'NO_CRED' | 'AUTH_FAILED' | 'NETWORK' | 'BAD_SHAPE';

/** Lỗi DigiStore ĐÃ PHÂN LOẠI — tầng gọi (poll/check) đọc `.code` để hiển thị đúng thông điệp + đúng trạng thái. */
export class DigistoreError extends Error {
  code: DigistoreErrorCode;
  httpStatus?: number;
  constructor(code: DigistoreErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'DigistoreError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Tài khoản DigiStore của 1 MÃ QR (merchant). base rỗng → dùng digistoreDefaultBase(). label = mã TID để nhét vào
 *  thông điệp lỗi ("(mã <tid>)"). tidId = nguồn để gắn source_tid_id vào cache khi poll. */
export interface DigistoreCreds {
  tidId?: number | null;
  base?: string | null;
  email: string;
  password: string;
  label?: string | null;
}

export interface BaoCoTxn {
  billId: string;          // mã hóa đơn merchant (UUID) — định danh DigiStore
  qrCode: string | null;   // mã QR = va_account_receiver (99MPC...)
  hkdName: string | null;  // store_name/merchant_name
  amount: number;          // VND
  payerName: string | null; // from_acc_name (tên người quẹt — field riêng, chuẩn hơn parse mô tả)
  externalRefNo: string | null; // external_ref_no (6248VNIB024… = CÙNG namespace Số-giao-dịch bill OCR khách → ghép trực tiếp)
  description: string | null;
  atMs: number | null;     // created_at → ms
  status: string | null;   // "success"
  sourceTidId?: number | null; // MÃ QR (tids.id) đã kéo ra báo-có này (per-mã poll) — ghi vào cache để truy nguồn.
  raw?: unknown;           // giữ bản gốc (debug)
}

/** Creds từ .env (fallback CHUNG khi không có per-mã). Thiếu email/password → null (→ NO_CRED ở fetchBaoCo). */
export function envCreds(): DigistoreCreds | null {
  const email = process.env.DIGISTORE_EMAIL || '';
  const password = process.env.DIGISTORE_PASSWORD || '';
  if (!email || !password) return null;
  return { base: process.env.DIGISTORE_BASE || null, email, password, label: '(chung .env)' };
}

// Token cache THEO base|email (audit 5/9 LOW: 2 mã cùng email khác base/password không tái dùng nhầm token).
const _tokens = new Map<string, { token: string; exp: number }>();

/** Reset cache token (test) — không dùng ở production. */
export function _resetTokenCacheForTest(): void { _tokens.clear(); }

function jwtExpMs(tok: string): number {
  try { const p = JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString('utf8')); return typeof p.exp === 'number' ? p.exp * 1000 : 0; } catch { return 0; }
}

function labelOf(creds: DigistoreCreds): string {
  return creds.label ? ` (mã ${creds.label})` : '';
}

/** Login lấy access_token (cache theo email tới trước hết hạn 60s). PHÂN LOẠI lỗi rõ (R198). */
async function getToken(creds: DigistoreCreds, force = false): Promise<string> {
  const email = creds.email;
  const password = creds.password;
  const label = labelOf(creds);
  if (!email || !password) throw new DigistoreError('NO_CRED', `Chưa cấu hình tài khoản DigiStore${label}.`);
  const base = creds.base || digistoreDefaultBase();
  const cacheKey = `${base}|${email}`;
  const cached = _tokens.get(cacheKey);
  if (!force && cached && Date.now() < cached.exp - 60_000) return cached.token;
  let r: Response;
  try {
    r = await fetch(`${base}/v1/portal/user/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
  } catch (err) {
    // fetch ném = timeout/DNS/mất kết nối (KHÔNG phải sai mật khẩu) → NETWORK.
    throw new DigistoreError('NETWORK', `Không kết nối được DigiStore${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const j = (await r.json().catch(() => null)) as { data?: { access_token?: string }; msg?: string } | null;
  const tok = j?.data?.access_token;
  if (r.status === 401 || r.status === 403) {
    throw new DigistoreError('AUTH_FAILED', `Sai tài khoản/mật khẩu DigiStore${label} (http=${r.status}, msg=${j?.msg ?? ''}).`, r.status);
  }
  if (!r.ok) {
    if (r.status >= 500) throw new DigistoreError('NETWORK', `DigiStore lỗi máy chủ khi đăng nhập (http=${r.status})${label}.`, r.status);
    throw new DigistoreError('AUTH_FAILED', `Đăng nhập DigiStore thất bại (http=${r.status}, msg=${j?.msg ?? ''})${label}.`, r.status);
  }
  if (!tok) throw new DigistoreError('AUTH_FAILED', `DigiStore không trả access_token${label} (msg=${j?.msg ?? ''}).`);
  _tokens.set(cacheKey, { token: tok, exp: jwtExpMs(tok) || (Date.now() + 5 * 60_000) });
  return tok;
}

let _shapeLogged = false;
/** Bóc tên người quẹt từ mô tả: "KHACH HANG 08 thanh toan QR - 99MPC..." → "KHACH HANG 08". */
export function parsePayerName(desc: string | null | undefined): string | null {
  if (!desc) return null;
  const m = /^(.*?)\s+thanh\s*toan\b/i.exec(desc.trim());
  return m ? m[1].trim() : null;
}
function num(v: unknown): number { const n = typeof v === 'string' ? Number(v.replace(/[^\d.-]/g, '')) : Number(v); return Number.isFinite(n) ? n : 0; }
function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000; // epoch s hoặc ms
  const s = String(v).trim();
  // "YYYY-MM-DD HH:MM:SS" (created_at DigiStore, KHÔNG có TZ) = giờ HCM → dựng instant HCM tường minh (Date.UTC −7h),
  // độc lập TZ server (bài học TZ 7h). Có TZ/ISO → Date.parse.
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 7, +m[5], +(m[6] ?? 0));
  const t = Date.parse(s); return Number.isNaN(t) ? null : t;
}
function normalize(rec: Record<string, unknown>): BaoCoTxn {
  // Field CHÍNH XÁC (đã chốt từ log server thật 5/9); giữ vài fallback + raw để phòng biến thể.
  const g = (...keys: string[]): unknown => { for (const k of keys) if (rec[k] != null) return rec[k]; return null; };
  const desc = (g('description', 'content', 'note') as string | null) ?? null;
  return {
    billId: String(g('bill_id', 'billId', 'id') ?? ''),
    qrCode: (g('va_account_receiver', 'qr_code', 'merchant_id_qr') as string | null) ?? null,
    hkdName: (g('store_name', 'merchant_name', 'hkd_name') as string | null) ?? null,
    amount: num(g('amount', 'credit_amount', 'total_amount')),
    payerName: parsePayerName(desc) ?? (g('from_acc_name', 'payer_name', 'sender_name') as string | null) ?? null, // mô tả có TÊN ĐẦY ĐỦ; from_acc_name bị bank viết tắt
    externalRefNo: (g('external_ref_no', 'externalRefNo', 'trn_ref_no') as string | null) ?? null,
    description: desc,
    atMs: toMs(g('created_at', 'credit_datetime', 'transaction_time')),
    status: (g('status', 'transaction_status') as string | null) ?? null,
    raw: rec
  };
}

/** Trích MẢNG giao dịch bền: j.data mảng, hoặc lồng j.data.{items|list|records|rows|content|data}, hoặc j.{items|list}.
 *  matched=false = KHÔNG tìm được mảng nào (dùng để phát hiện BAD_SHAPE, phân biệt với "mảng rỗng hợp lệ"). */
function extractArray(j: Record<string, unknown>): { arr: Record<string, unknown>[]; matched: boolean } {
  const pick = (v: unknown): Record<string, unknown>[] | null => (Array.isArray(v) ? (v as Record<string, unknown>[]) : null);
  const d = j.data as Record<string, unknown> | unknown[] | undefined;
  const dObj = (d && typeof d === 'object' && !Array.isArray(d)) ? (d as Record<string, unknown>) : undefined;
  const arr =
    pick(d) ??
    (dObj ? pick(dObj.items) ?? pick(dObj.list) ?? pick(dObj.records) ?? pick(dObj.rows) ?? pick(dObj.content) ?? pick(dObj.data) : null) ??
    pick(j.items) ??
    pick(j.list);
  return arr ? { arr, matched: true } : { arr: [], matched: false };
}

/** KÉO báo-có REALTIME trong [fromMs, toMs] bằng creds MỘT MÃ QR. Phân trang tới hết. status=success.
 *  creds null/undefined → fallback .env (tương thích poll chung + test cũ). PHÂN LOẠI lỗi qua DigistoreError. */
export async function fetchBaoCo(
  creds: DigistoreCreds | null | undefined,
  fromMs: number,
  toMs: number,
  opts?: { pageSize?: number; maxPages?: number }
): Promise<BaoCoTxn[]> {
  const eff = creds ?? envCreds();
  if (!eff) throw new DigistoreError('NO_CRED', 'Chưa cấu hình tài khoản DigiStore (không có creds per-mã và .env cũng trống).');
  const base = eff.base || digistoreDefaultBase();
  const label = labelOf(eff);
  const pageSize = opts?.pageSize ?? 80, maxPages = opts?.maxPages ?? 50;
  const startS = Math.floor(fromMs / 1000), endS = Math.floor(toMs / 1000);
  const out: BaoCoTxn[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const tok = await getToken(eff);
    const url = `${base}/v1/portal/transaction/va?status=success&start_time=${startS}&end_time=${endS}&page=${page}&page_size=${pageSize}&bill_id=&customer_id=`;
    let r: Response;
    try {
      r = await fetch(url, { headers: { authorization: 'Bearer ' + tok } });
    } catch (err) {
      throw new DigistoreError('NETWORK', `Không kết nối được DigiStore${label} (transaction/va page=${page}): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (r.status === 401 || r.status === 403) {
      // token hỏng → re-login 1 lần (getToken force — tự phân loại NO_CRED/AUTH_FAILED/NETWORK).
      const tok2 = await getToken(eff, true);
      try {
        r = await fetch(url, { headers: { authorization: 'Bearer ' + tok2 } });
      } catch (err) {
        throw new DigistoreError('NETWORK', `Không kết nối được DigiStore${label} (transaction/va retry page=${page}): ${err instanceof Error ? err.message : String(err)}`);
      }
      if (r.status === 401 || r.status === 403) {
        throw new DigistoreError('AUTH_FAILED', `Token DigiStore không hợp lệ sau khi đăng nhập lại${label} (http=${r.status}, page=${page}).`, r.status);
      }
    }
    if (!r.ok) throw new DigistoreError('NETWORK', `Gọi transaction/va lỗi http=${r.status} page=${page}${label}.`, r.status);
    let j: Record<string, unknown>;
    try {
      j = (await r.json()) as Record<string, unknown>;
    } catch (err) {
      throw new DigistoreError('BAD_SHAPE', `DigiStore trả body không phải JSON${label} (page=${page}): ${err instanceof Error ? err.message : String(err)}`);
    }
    // LOG CẤU TRÚC (keys) 1 lần để LEAD chốt shape — audit 5/9 LOW: KHÔNG dump GIÁ TRỊ (tên khách/số tiền = PII/tài
    // chính). Chỉ in danh sách keys top + data.* + keys của 1 record mẫu + độ dài mảng.
    if (!_shapeLogged) {
      _shapeLogged = true;
      const dtype = Array.isArray(j.data) ? `array(${(j.data as unknown[]).length})` : typeof j.data;
      // eslint-disable-next-line no-console
      console.log('[digistore] RAW top keys:', Object.keys(j).join(', '), '| data type:', dtype);
      if (j.data && typeof j.data === 'object' && !Array.isArray(j.data)) console.log('[digistore] data.* keys:', Object.keys(j.data as object).join(', '));
      const { arr: sniff } = extractArray(j);
      const rec0 = sniff.find((x) => x && typeof x === 'object') as Record<string, unknown> | undefined;
      // eslint-disable-next-line no-console
      console.log('[digistore] record keys:', rec0 ? Object.keys(rec0).join(', ') : '(mảng rỗng)', '| count:', sniff.length);
    }
    const { arr, matched } = extractArray(j);
    if (!matched) {
      // KHÔNG tìm được mảng nào. Phân biệt "rỗng hợp lệ" (data null / [] / object không có mảng con nhưng cũng
      // không có gì) với "shape lạ thật" (data là object/giá trị KHÁC rỗng mà không tách được mảng).
      const d = j.data;
      const emptyLegit = d == null || (Array.isArray(d) && d.length === 0);
      if (!emptyLegit) {
        // audit 5/9 LOW: log KEYS để debug shape lạ, KHÔNG dump giá trị (PII/tài chính).
        const dkeys = j.data && typeof j.data === 'object' ? Object.keys(j.data as object).join(', ') : `(${typeof j.data})`;
        // eslint-disable-next-line no-console
        console.error(`[digistore] ⚠ BAD_SHAPE${label} (page=${page}) top keys: ${Object.keys(j).join(', ')} | data.*: ${dkeys}`);
        throw new DigistoreError('BAD_SHAPE', `Cấu trúc phản hồi transaction/va lạ (không tìm được mảng giao dịch)${label} (page=${page}).`);
      }
      break; // rỗng hợp lệ → hết dữ liệu.
    }
    for (const rec of arr) {
      const t = normalize(rec);
      t.sourceTidId = eff.tidId ?? null;
      out.push(t);
    }
    const pageMeta = (typeof j.data === 'object' && !Array.isArray(j.data)) ? (j.data as Record<string, unknown>) : j;
    const totalPage = Number(pageMeta.total_page ?? pageMeta.totalPage ?? pageMeta.total_pages ?? j.total_page ?? 0);
    if (arr.length < pageSize || (totalPage && page >= totalPage)) break;
  }
  return out;
}
