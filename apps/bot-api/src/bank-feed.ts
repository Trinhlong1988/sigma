// LẤY SAO KÊ TỰ ĐỘNG MB (Admin Demo 9/9) — thay vì tải file .xlsx rồi nạp tay, kéo thẳng lịch sử giao dịch MB về
// đúng luồng tra soát đang chạy.
//
// NGUỒN: sidecar `apps/mb-feed` (thư viện `mbbank` của CookieGMVN — KHÔNG chính thức, đăng nhập bằng tài khoản
// internet banking + tự giải captcha). Admin Demo chốt đi hướng này, BỎ HẲN GPM Pay/SePay (không dùng dịch vụ trả phí).
//   ⚠ Rủi ro đã biết (tác giả thư viện ghi rõ): tài khoản MB CÓ THỂ BỊ ĐÌNH CHỈ vì đăng nhập tự động.
//     → chạy tài khoản PHỤ, tần suất THẤP (bấm mới lấy / 1-2 lần/ngày), và LUÔN giữ đường nạp .xlsx dự phòng.
//   ⚠ Cách ly: thư viện chạy trong TIẾN TRÌNH RIÊNG (apps/mb-feed), user/pass MB chỉ nằm ở env của tiến trình đó;
//     bot-api chỉ gọi HTTP nội bộ kèm token — mã bên thứ 3 KHÔNG chạm được DB/khoá phiên.
//
// LUỒNG: sidecar → `BankFeedTxn` (chuẩn nội bộ) → `bankFeedToParsedStatement()` → CHÍNH `reconcileStatement`/
// `cacheStatementTxns` của màn tra soát ⇒ khớp đại lý/NĐT, chống trùng, xuất Excel dùng lại nguyên, KHÔNG đẻ
// nhánh tính tiền thứ 2.
//
// KHOÁ CHỐNG TRÙNG: `ref = MBLIB-<số TK>-<refNo>` — cùng quy ước đã áp cho sao kê ACB, nên file .xlsx nạp tay và
// bản kéo tự động KHÔNG đè nhau; kéo lại bao nhiêu lần cũng chỉ 1 dòng (statement_txn khoá theo ref).
import type { ParsedStatement, StatementTxn } from './statement-recon.js';
import { extractDescName } from './statement-recon.js';

export const KIEM_TRUOC_KHI_TIN =
  'Nguồn tự động (thư viện MB không chính thức): lần đầu hãy kéo 1 ngày ĐÃ CÓ file sao kê tay, đối chiếu tổng vào/ra khớp rồi mới dùng thay file.';

/** 1 giao dịch chuẩn NỘI BỘ sau khi chuẩn hoá từ nguồn. */
export interface BankFeedTxn {
  /** id giao dịch phía nguồn (MB: refNo) — thành phần khoá chống trùng. */
  providerTxnId: string;
  accountNumber: string;
  bankBrand: string | null;
  /** "YYYY-MM-DDTHH:MM:00" giờ ĐỊA PHƯƠNG (wall-clock) — cùng quy ước parser .xlsx, KHÔNG dịch múi giờ. */
  dateTime: string | null;
  /** Tiền VÀO tài khoản (báo có). */
  amountIn: number;
  /** Tiền RA khỏi tài khoản (ghi nợ). */
  amountOut: number;
  content: string | null;
  referenceNumber: string | null;
  counterName?: string | null;
  counterAccount?: string | null;
  counterBank?: string | null;
}

export type BankFeedProvider = 'MBLIB';

export interface BankFeedConfig {
  provider: BankFeedProvider;
  /** Token nói chuyện với sidecar mb-feed (KHÔNG phải mật khẩu ngân hàng). */
  apiKey: string;
  /** Địa chỉ sidecar; trống → http://127.0.0.1:8797. */
  baseUrl?: string;
}

/** Chuẩn hoá "2026-09-08 14:23:45" | "08/09/2026 14:23" | ISO → "YYYY-MM-DDTHH:MM:00" wall-clock. */
export function chuanHoaGio(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`;
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s);
  if (d) return `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}T${(d[4] ?? '00').padStart(2, '0')}:${d[5] ?? '00'}:00`;
  return null;
}

/** "1,234,000" | "1.234.000" | 1234000 → 1234000 (bỏ mọi ký tự ngăn cách). */
function soTien(v: unknown): number {
  const n = Number(String(v ?? '0').replace(/[^\d-]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * `TransactionInfo` của thư viện mbbank → chuẩn nội bộ.
 * Trường nguồn: postDate · transactionDate ("DD/MM/YYYY HH:mm:ss") · accountNumber · creditAmount · debitAmount ·
 * transactionDesc · refNo · toAccountName · toAccountNumber · toBank.
 */
export function mapMbLib(rows: unknown[]): BankFeedTxn[] {
  return rows
    .map((r) => {
      const x = r as Record<string, unknown>;
      return {
        providerTxnId: String(x.refNo ?? ''),
        accountNumber: String(x.accountNumber ?? '').trim(),
        bankBrand: 'MB',
        dateTime: chuanHoaGio(x.transactionDate as string),
        amountIn: soTien(x.creditAmount),
        amountOut: soTien(x.debitAmount),
        content: x.transactionDesc != null ? String(x.transactionDesc) : null,
        referenceNumber: x.refNo != null ? String(x.refNo) : null,
        counterName: x.toAccountName != null ? String(x.toAccountName) : null,
        counterAccount: x.toAccountNumber != null ? String(x.toAccountNumber) : null,
        counterBank: x.toBank != null ? String(x.toBank) : null
      };
    })
    .filter((t) => t.providerTxnId && (t.amountIn > 0 || t.amountOut > 0));
}

/**
 * Chuẩn nội bộ → `ParsedStatement` để đi TIẾP bằng chính luồng tra soát (reconcile + cache + xuất Excel).
 * `ref` gắn tiền tố nguồn + số TK ⇒ không đụng ref của file .xlsx nạp tay và không đè giữa 2 tài khoản.
 */
export function bankFeedToParsedStatement(
  txns: BankFeedTxn[],
  opts: { provider: BankFeedProvider; accountNumber: string; accountHolder?: string | null; bank?: string | null }
): ParsedStatement {
  const rows: StatementTxn[] = txns.map((t, i) => ({
    rowIndex: i + 1,
    dateTime: t.dateTime,
    ref: `${opts.provider}-${opts.accountNumber}-${t.providerTxnId}`,
    debit: t.amountOut,
    credit: t.amountIn,
    desc: t.content,
    cpName: t.counterName ?? null,
    cpAccount: t.counterAccount ?? null,
    cpBank: t.counterBank ?? null,
    descName: extractDescName(t.content)
  }));
  const warnings: string[] = [];
  const thieuDoiUng = rows.length > 0 && rows.every((r) => !r.cpName);
  if (thieuDoiUng) {
    warnings.push('Nguồn tự động KHÔNG trả "tên tài khoản đối ứng" — khớp đại lý/NĐT phải dựa vào NỘI DUNG giao dịch. Kiểm kỹ các dòng CHUYỂN RA trước khi chốt.');
  }
  return {
    accountHolder: opts.accountHolder ?? null,
    accountNumber: opts.accountNumber,
    accountBank: opts.bank ?? txns[0]?.bankBrand ?? null,
    txns: rows,
    warnings,
    thieuCotDoiUng: thieuDoiUng,
    soGdRa: rows.filter((r) => r.debit > 0).length
  };
}

/** Ngày "YYYY-MM-DD" theo giờ VN cho tham số lọc. */
export function ngayVN(d: Date): string {
  return new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** Gọi sidecar lấy giao dịch trong [from, to]. `fetchFn` tiêm được để test không cần mạng. */
export async function fetchBankFeed(
  cfg: BankFeedConfig,
  q: { accountNumber: string; from: Date; to: Date },
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true; txns: BankFeedTxn[] } | { ok: false; error: string; message: string }> {
  if (!cfg.apiKey) {
    return { ok: false, error: 'NO_API_KEY', message: 'Chưa cấu hình nguồn sao kê tự động (thiếu MB_FEED_TOKEN trên máy chủ).' };
  }
  // MB giới hạn lịch sử tối đa 90 ngày/lần — chặn sớm cho rõ lý do thay vì để sidecar ném.
  if ((q.to.getTime() - q.from.getTime()) / 86_400_000 > 90) {
    return { ok: false, error: 'RANGE_TOO_LONG', message: 'MB chỉ cho lấy tối đa 90 ngày mỗi lần — chia nhỏ kỳ.' };
  }
  const url = `${cfg.baseUrl ?? 'http://127.0.0.1:8797'}/transactions?account=${encodeURIComponent(q.accountNumber)}&from=${ngayVN(q.from)}&to=${ngayVN(q.to)}`;
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' } });
  } catch (e) {
    return { ok: false, error: 'NETWORK', message: `Không gọi được dịch vụ lấy sao kê MB (mb-feed): ${(e as Error).message}` };
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* để nhánh lỗi dưới xử */ }
  if (!res.ok) {
    const b = body as { message?: string; error?: string } | null;
    return { ok: false, error: b?.error ?? `HTTP_${res.status}`, message: b?.message ?? `mb-feed trả HTTP ${res.status} (kiểm token / đăng nhập MB / captcha).` };
  }
  const b = body as Record<string, unknown> | null;
  const rows = (Array.isArray(b?.transactions) ? b.transactions : Array.isArray(body) ? body : []) as unknown[];
  return { ok: true, txns: mapMbLib(rows) };
}

/** Cấu hình nguồn tự động từ biến môi trường (KHÔNG hardcode bí mật trong mã). */
export function bankFeedConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BankFeedConfig | null {
  if (env.MB_FEED_TOKEN) return { provider: 'MBLIB', apiKey: env.MB_FEED_TOKEN, baseUrl: env.MB_FEED_URL };
  return null;
}
