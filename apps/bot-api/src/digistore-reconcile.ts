// ĐỐI SOÁT "BÁO CÓ" DIGISTORE (BVBank) — Admin Demo 5/9. Hai luồng dùng CHUNG 1 lõi so khớp thuần:
//   1) POLL 30' (worker nền bot-api): duyệt MỌI mã QR (tids kind='QR') CÓ creds → fetch báo-có TỪNG merchant bằng
//      creds MÃ ĐÓ → UPSERT cache digistore_baoco (kèm source_tid_id) → ĐỐI SOÁT mỗi báo-có với bill QR ĐÃ GHI. Mã
//      chưa cấu hình creds → BỎ QUA + log rõ. Fail 1 mã → tiếp mã khác + gom vào errors (R198, không dừng cả lượt).
//   2) CHECK ON-DEMAND (route /v1/digistore/check-baoco, tab review): 1 bill QR → resolve MÃ QR → creds mã đó → fetch
//      LIVE báo-có quanh giờ bill → so khớp → MATCHED / DUPLICATE / NOT_FOUND / AMBIGUOUS / CANNOT_CHECK.
//
// GHÉP (Admin Demo 5/9): ưu tiên EXACT theo external_ref_no (báo-có) ↔ Số-giao-dịch bill OCR (chuẩn-hoá bỏ khoảng
// trắng/hoa-thường); không có → fallback HKD+tiền+giờ±2'+tên (như cũ).
//
// THUẦN + Dependency Injection (cùng khuôn holiday-push.ts): mọi so khớp là HÀM THUẦN (test 100% không cần mạng/DB);
// I/O (fetch báo-có / đọc-ghi cache / liệt kê bill đã ghi / đọc creds) tách thành deps → orchestration test bằng stub/mock.
//
// TÁI DÙNG (KHÔNG viết lại): normalizeHkdKey + editDistance (ocr-send-service.ts) cho chuẩn-hoá-bỏ-dấu HKD & sai-chính-tả.
import { normalizeHkdKey, editDistance } from './ocr-send-service.js';
import {
  fetchBaoCo,
  DigistoreError,
  type BaoCoTxn,
  type DigistoreCreds
} from './digistore-adapter.js';
import { encryptSecret, decryptSecret } from './digistore-secret.js';
import type { Db } from '@sigma/database';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PHẦN 0 — HẰNG SỐ + KIỂU
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Dung sai thời gian khớp báo-có ↔ bill (±2 phút, Admin Demo chốt). */
export const RECONCILE_TIME_WINDOW_MS = 2 * 60 * 1000;
/** Ngưỡng sai-chính-tả tên người quẹt để coi là "cùng người" (edit-distance ≤ 2 trên tên đã chuẩn-hoá-bỏ-dấu). */
export const PAYER_TYPO_MAX_DIST = 2;

/** 1 bill QR ĐÃ GHI trong hệ thống (nguồn đối soát cho poll). payerName THƯỜNG null (transactions không lưu tên người
 *  quẹt) → poll khớp theo HKD + tiền + giờ (payer là tín hiệu phụ nếu có). ref = Số giao dịch (nếu có nguồn) → ghép
 *  EXACT với external_ref_no báo-có. */
export interface RecordedQrBill {
  billKey: string;            // định danh bill đã ghi (vd mã GD 'GD00001') → matched_bill_key
  hkdName: string | null;
  amount: number;
  atMs: number | null;
  payerName?: string | null;
  ref?: string | null;        // Số giao dịch (external_ref_no bill OCR) — ghép EXACT nếu có.
}

/** Ứng viên báo-có (đã chuẩn hoá qua BaoCoTxn) + trạng thái đối soát trong cache (cho phát hiện DUPLICATE). */
export interface BaoCoCandidate extends BaoCoTxn {
  reconcileStatus?: string | null; // 'MATCHED' trong cache = báo-có đã được đối soát/gán bill trước → DUPLICATE.
}

/** 1 dòng báo-có dùng làm GỢI Ý mã QR/tên HKD khi OCR không đọc được tên. */
export interface BaoCoSuggestion {
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

/** 1 bill cần CHECK on-demand (từ tab review). */
export interface BillToCheck {
  hkdName: string | null;
  amount: number;
  atMs: number | null;     // giờ trên bill (ms). null = không có giờ → không lọc theo giờ (rủi ro, cảnh báo ở UI).
  payerName?: string | null;
  ref?: string | null;     // Số giao dịch bill OCR — ghép EXACT với external_ref_no báo-có (ưu tiên).
  /** [Admin Demo 10/9 — bắt bởi đợt phản biện] true = số giao dịch KHÔNG đọc từ ảnh mà LẤY TỪ chính dòng báo-có người
   *  duyệt bấm (bill "thông báo giao dịch thẻ"). Khi đó khớp-theo-ref KHÔNG còn là bằng chứng độc lập — nó chỉ xác
   *  nhận lại lựa chọn của người bấm — nên phải đòi thêm bằng chứng thật: TÊN NGƯỜI QUẸT + GIỜ. */
  refTuBaoCo?: boolean;
}

export type CheckStatus = 'MATCHED' | 'DUPLICATE' | 'NOT_FOUND' | 'AMBIGUOUS' | 'CANNOT_CHECK';

export interface CheckResult {
  status: CheckStatus;
  /** Ứng viên khớp (MATCHED = 1; AMBIGUOUS = nhiều/tên-lệch để UI cho người xem chọn). */
  candidates: BaoCoCandidate[];
  /** Chỉ có khi CANNOT_CHECK — lý do TRUNG THỰC (fetch lỗi/chặn/logout). */
  error?: string;
  message?: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PHẦN 1 — HÀM THUẦN SO KHỚP (không I/O)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Chuẩn-hoá SỐ GIAO DỊCH (ref) để so EXACT: bỏ MỌI khoảng trắng + HOA. Rỗng/null → ''. */
export function normalizeRef(s: string | null | undefined): string {
  if (!s) return '';
  return String(s).replace(/\s+/g, '').toUpperCase();
}

/** Chuẩn-hoá TÊN NGƯỜI QUẸT để so khớp: bỏ dấu tiếng Việt, đổi đ→d, HOA, gộp khoảng trắng. GIỮ khoảng trắng (khác
 *  normalizeHkdKey) để so nhiều-từ + tính edit-distance sát nghĩa. Rỗng/null → ''. */
export function normalizePayerName(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 2 tên người quẹt có phải CÙNG người (chấp nhận sai chính tả nhẹ). Cả 2 rỗng → false (không đủ căn cứ khẳng định). */
export function payerNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizePayerName(a);
  const nb = normalizePayerName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return editDistance(na, nb) <= PAYER_TYPO_MAX_DIST;
}

/** HKD có khớp không (chuẩn-hoá-bỏ-dấu, bỏ tiền tố "HKD"). Cả 2 rỗng → false. */
export function hkdNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = normalizeHkdKey(a);
  const kb = normalizeHkdKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // [Admin Demo 8/9 — ca THẬT bill 17.831.000] Tên HKD ở 2 nguồn KHÔNG bao giờ giống hệt:
  //   mã QR/bill: "HKD DEMO 35 Ha Noi" → NGUYENTRIBAOHANOI
  //   báo-có bank: "HKD NGUYỄN TRÍ BẢO"       → NGUYENTRIBAO   (bank cắt đuôi địa danh)
  // So BẰNG trượt → dù CHỈ 1 giao dịch trùng tiền+giờ vẫn bị gắn "mơ hồ" → chặn gửi oan.
  // Chấp nhận quan hệ TIỀN TỐ (đúng quy tắc "bill dư đuôi địa danh" đã chốt 6/9 cho khớp mã QR), ngưỡng 8 ký tự
  // để không khớp bừa tên quá ngắn. Các khoá còn lại (tiền tuyệt đối + giờ + duy nhất) vẫn giữ nguyên.
  const MIN_TIEN_TO = 8;
  const [ngan, dai] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return ngan.length >= MIN_TIEN_TO && dai.startsWith(ngan);
}

/** 2 mốc thời gian trong dung sai (±window). Thiếu 1 trong 2 → KHÔNG khẳng định khớp giờ (trả false ở nơi cần giờ). */
export function withinTimeWindow(aMs: number | null | undefined, bMs: number | null | undefined, windowMs = RECONCILE_TIME_WINDOW_MS): boolean {
  if (aMs == null || bMs == null) return false;
  return Math.abs(aMs - bMs) <= windowMs;
}

/** POLL — khớp 1 BÁO-CÓ với danh sách bill QR ĐÃ GHI.
 *  ƯU TIÊN EXACT theo Số giao dịch (external_ref_no ↔ bill.ref) — CÙNG namespace ngân hàng → định danh chắc chắn.
 *  Không có ref khớp → khoá cứng HKD + tiền (chính xác) + giờ (±window). Đúng 1 → MATCHED; 0 → UNRECONCILED; >1 →
 *  phá hoà bằng tên người quẹt; vẫn mơ hồ → UNRECONCILED + reason. */
export function reconcileBaoCoToBills(
  baoco: BaoCoTxn,
  bills: RecordedQrBill[],
  opts: { windowMs?: number } = {}
): { status: 'MATCHED' | 'UNRECONCILED'; matchedBillKey: string | null; reason?: string } {
  const windowMs = opts.windowMs ?? RECONCILE_TIME_WINDOW_MS;
  // (0) EXACT theo Số giao dịch — ưu tiên tuyệt đối. Báo-có là SỰ THẬT ngân hàng → ref trùng = cùng giao dịch.
  const bref = normalizeRef(baoco.externalRefNo);
  if (bref) {
    const byRef = bills.filter((b) => normalizeRef(b.ref) === bref);
    if (byRef.length === 1) return { status: 'MATCHED', matchedBillKey: byRef[0].billKey, reason: 'khớp Số giao dịch (external_ref_no)' };
    if (byRef.length > 1) return { status: 'UNRECONCILED', matchedBillKey: null, reason: `${byRef.length} bill QR trùng Số giao dịch — mơ hồ, chờ đối soát tay.` };
    // byRef.length === 0 → rơi xuống khớp mềm (bill chưa lưu ref / ref lệch).
  }
  const hard = bills.filter(
    (b) =>
      b.amount === baoco.amount &&
      hkdNamesMatch(b.hkdName, baoco.hkdName) &&
      withinTimeWindow(b.atMs, baoco.atMs, windowMs)
  );
  if (hard.length === 0) return { status: 'UNRECONCILED', matchedBillKey: null };
  if (hard.length === 1) return { status: 'MATCHED', matchedBillKey: hard[0].billKey };
  // >1 khớp cứng (cùng HKD+tiền+giờ) → thử phá hoà bằng tên người quẹt (nếu bill có ghi tên).
  const byPayer = hard.filter((b) => payerNamesMatch(b.payerName, baoco.payerName));
  if (byPayer.length === 1) return { status: 'MATCHED', matchedBillKey: byPayer[0].billKey };
  return { status: 'UNRECONCILED', matchedBillKey: null, reason: `${hard.length} bill QR đã ghi cùng HKD+tiền+giờ — mơ hồ, chờ đối soát tay.` };
}

/** CHECK ON-DEMAND — 1 bill QR khớp với danh sách BÁO-CÓ (fetch live/cache). Quy tắc (an toàn tiền, KHÔNG tự-báo-xanh
 *  khi tên lệch):
 *   - ƯU TIÊN EXACT theo Số giao dịch (bill.ref ↔ external_ref_no): đúng 1 → MATCHED (hoặc DUPLICATE); ≥2 → AMBIGUOUS.
 *   - Không có ref khớp → lọc theo TIỀN (chính xác) + GIỜ (±window; bill thiếu giờ → bỏ lọc giờ) → `pool`.
 *   - pool rỗng → NOT_FOUND (🔴).
 *   - Trong pool, "khớp đầy đủ" = HKD khớp AND (tên người quẹt khớp NẾU bill có tên; bill không có tên → chỉ cần HKD).
 *       • đúng 1 khớp đầy đủ → MATCHED (hoặc DUPLICATE nếu báo-có đó đã reconcile_status='MATCHED' trong cache).
 *       • ≥2 khớp đầy đủ → AMBIGUOUS (trả hết ứng viên).
 *   - Không có khớp đầy đủ nhưng pool có phần tử (cùng tiền+giờ, HKD/tên lệch — nghi sai chính tả/OCR) → AMBIGUOUS. */
export function checkBillAgainstBaoCo(
  bill: BillToCheck,
  baoCoList: BaoCoCandidate[],
  opts: { windowMs?: number } = {}
): CheckResult {
  const windowMs = opts.windowMs ?? RECONCILE_TIME_WINDOW_MS;
  // (0) EXACT theo Số giao dịch — ưu tiên tuyệt đối.
  const bref = normalizeRef(bill.ref);
  if (bref) {
    const byRef = baoCoList.filter((b) => normalizeRef(b.externalRefNo) === bref);
    if (byRef.length === 1) {
      const only = byRef[0];
      // [Admin Demo 10/9 — bắt bởi đợt phản biện] Bill "thông báo giao dịch thẻ" lấy ref TỪ CHÍNH dòng báo-có người
      // duyệt bấm ⇒ khớp-theo-ref lúc đó chỉ là xác nhận lại lựa chọn của họ, KHÔNG phải kiểm độc lập ⇒ bấm nhầm
      // dòng là ghi doanh số cho HKD sai + "đốt" số GD của giao dịch thật. Với ref kiểu đó, ĐÒI bằng chứng THẬT:
      // tên người quẹt (ảnh thông báo thẻ luôn in tên chủ thẻ) và giờ trong cửa sổ. Ref ĐỌC TỪ ẢNH giữ nguyên hành
      // vi cũ (ref là khoá mạnh nhất — đã có test khoá).
      if (bill.refTuBaoCo) {
        if (bill.payerName && !payerNamesMatch(only.payerName, bill.payerName)) return { status: 'AMBIGUOUS', candidates: [only] };
        if (bill.atMs != null && only.atMs != null && !withinTimeWindow(only.atMs, bill.atMs, windowMs)) return { status: 'AMBIGUOUS', candidates: [only] };
        if (only.amount !== bill.amount) return { status: 'AMBIGUOUS', candidates: [only] };
      }
      if (only.reconcileStatus === 'MATCHED') return { status: 'DUPLICATE', candidates: [only] };
      return { status: 'MATCHED', candidates: [only] };
    }
    if (byRef.length >= 2) return { status: 'AMBIGUOUS', candidates: byRef };
    // byRef.length === 0 → rơi xuống khớp mềm.
  }
  const pool = baoCoList.filter((b) => {
    if (b.amount !== bill.amount) return false;
    if (bill.atMs != null) return withinTimeWindow(b.atMs, bill.atMs, windowMs);
    return true; // bill không có giờ → không lọc theo giờ (đã cảnh báo ở tầng trên)
  });
  if (pool.length === 0) return { status: 'NOT_FOUND', candidates: [] };

  // [Admin Demo 8/9 — "1 bill mà vẫn báo MƠ HỒ, chặn gửi"] Bill QR bị app ngân hàng CẮT/mất TÊN HKD → trước đây
  // `hkdNamesMatch(b.hkdName, '')` = false (rỗng luôn false) → `full` = 0 → trả AMBIGUOUS **dù pool chỉ có ĐÚNG 1
  // giao dịch** trùng tiền + trong cửa sổ giờ → gate chặn gửi oan, bill đứng chết.
  // SỬA: KHÔNG có tên HKD thì KHÔNG lấy tên làm điều kiện loại (không thể so cái mình không đọc được) — vẫn giữ
  // các khoá chắc chắn: SỐ TIỀN đúng tuyệt đối + GIỜ trong cửa sổ + TÊN NGƯỜI QUẸT (nếu đã điền) + DUY NHẤT 1
  // ứng viên. Nhiều ứng viên vẫn AMBIGUOUS như cũ (không đoán bừa — đây là TIỀN).
  const coTenHkd = !!normalizeHkdKey(bill.hkdName);
  const full = pool.filter((b) => {
    if (coTenHkd && !hkdNamesMatch(b.hkdName, bill.hkdName)) return false;
    if (bill.payerName) return payerNamesMatch(b.payerName, bill.payerName);
    return true;
  });
  if (full.length === 1) {
    const only = full[0];
    if (only.reconcileStatus === 'MATCHED') return { status: 'DUPLICATE', candidates: [only] };
    return { status: 'MATCHED', candidates: [only] };
  }
  if (full.length >= 2) return { status: 'AMBIGUOUS', candidates: full };
  // full === 0: cùng tiền+giờ nhưng HKD/tên lệch → mơ hồ, để người xem quyết.
  return { status: 'AMBIGUOUS', candidates: pool };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PHẦN 2 — ORCHESTRATION POLL (best-effort, R198 loud). DI deps → test bằng stub.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Lỗi kéo báo-có của 1 MÃ QR (phân loại) — gom lại để refresh/UI hiển thị rõ mã nào lỗi vì sao. */
export interface BaoCoFetchError {
  tid: string;
  code: string;   // NO_CRED / AUTH_FAILED / NETWORK / BAD_SHAPE / UNKNOWN
  reason: string;
}

/** Kết quả kéo báo-có 1 lượt (đa mã): txns gộp + errors per-mã + số mã đã cấu hình creds. */
export interface BaoCoFetchResult {
  txns: BaoCoTxn[];
  errors: BaoCoFetchError[];
  configuredCount: number;
}

export interface BaoCoPollDeps {
  /** Kéo báo-có gần đây (mặc định 24h) THEO TỪNG MÃ QR có creds. NÉM chỉ khi lỗi hệ thống (DB liệt kê mã, v.v.); lỗi
   *  từng mã (login/fetch) gom vào errors, KHÔNG ném (R198 — không dừng cả lượt). */
  fetchRecent: () => Promise<BaoCoFetchResult>;
  /** UPSERT báo-có vào cache theo bill_id (ON CONFLICT — không nhân đôi khi poll lại). */
  upsertBaoCo: (txns: BaoCoTxn[]) => Promise<void>;
  /** Bill QR ĐÃ GHI trong [fromMs,toMs] (nguồn đối soát). */
  listRecordedQrBills: (fromMs: number, toMs: number) => Promise<RecordedQrBill[]>;
  /** Ghi kết quả đối soát 1 báo-có vào cache. */
  markReconcile: (billId: string, status: 'MATCHED' | 'UNRECONCILED', matchedBillKey: string | null) => Promise<void>;
  now?: () => Date;
}

export interface BaoCoPollResult {
  ok: boolean;
  reason?: string;      // chỉ khi ok=false (lỗi hệ thống) — cache CŨ được giữ nguyên.
  fetched: number;
  matched: number;
  unreconciled: number;
  errors: BaoCoFetchError[]; // lỗi per-mã (login/fetch) — luôn có (rỗng nếu không mã nào lỗi).
}

/** 1 lượt POLL. Best-effort no-throw. Lỗi hệ thống (fetchRecent/upsert/list ném) → LOG RÕ + GIỮ cache cũ (ok:false).
 *  Lỗi TỪNG MÃ → nằm trong result.errors (KHÔNG làm hỏng cả lượt). */
export async function runBaoCoPoll(deps: BaoCoPollDeps, opts: { windowMs?: number } = {}): Promise<BaoCoPollResult> {
  let fetchRes: BaoCoFetchResult;
  try {
    fetchRes = await deps.fetchRecent();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // R198: KHÔNG nuốt câm — báo RÕ không cập nhật được, GIỮ cache cũ.
    // eslint-disable-next-line no-console
    console.error(`[digistore] ⚠ POLL: KHÔNG cập nhật được báo-có (giữ cache cũ): ${reason}`);
    return { ok: false, reason, fetched: 0, matched: 0, unreconciled: 0, errors: [] };
  }
  const txns = fetchRes.txns;
  const errors = fetchRes.errors;

  try {
    await deps.upsertBaoCo(txns);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[digistore] ⚠ POLL: UPSERT cache báo-có lỗi (giữ nguyên phần đã có):', err instanceof Error ? err.message : err);
    return { ok: false, reason: 'upsert_failed', fetched: txns.length, matched: 0, unreconciled: 0, errors };
  }

  // Khoảng đối soát = min..max giờ báo-có (nới ±window để không hụt bill sát biên). Không có giờ → dùng 24h quanh now.
  const now = (deps.now ?? (() => new Date()))().getTime();
  const windowMs = opts.windowMs ?? RECONCILE_TIME_WINDOW_MS;
  const times = txns.map((t) => t.atMs).filter((t): t is number => t != null);
  const fromMs = (times.length ? Math.min(...times) : now - 24 * 60 * 60 * 1000) - windowMs;
  const toMs = (times.length ? Math.max(...times) : now) + windowMs;

  let bills: RecordedQrBill[];
  try {
    bills = await deps.listRecordedQrBills(fromMs, toMs);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[digistore] ⚠ POLL: liệt kê bill QR đã ghi lỗi (không đối soát lượt này, cache báo-có ĐÃ cập nhật):', err instanceof Error ? err.message : err);
    return { ok: false, reason: 'list_bills_failed', fetched: txns.length, matched: 0, unreconciled: 0, errors };
  }

  let matched = 0;
  let unreconciled = 0;
  for (const t of txns) {
    if (!t.billId) continue; // không có định danh → không ghi đối soát (đã vào cache raw nếu upsert xử lý).
    const r = reconcileBaoCoToBills(t, bills, { windowMs });
    try {
      await deps.markReconcile(t.billId, r.status, r.matchedBillKey);
      if (r.status === 'MATCHED') matched += 1;
      else unreconciled += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[digistore] ⚠ POLL: ghi reconcile bill_id=${t.billId} lỗi (best-effort, tiếp tục):`, err instanceof Error ? err.message : err);
    }
  }
  return { ok: true, fetched: txns.length, matched, unreconciled, errors };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PHẦN 3 — WORKER NỀN 30' (cùng khuôn holiday-push/startDeletionSweepWorker: tick-lúc-start + setInterval + unref)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const BAOCO_POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 phút (Admin Demo chốt).

export function startBaoCoPollWorker(deps: BaoCoPollDeps, options: { intervalMs?: number } = {}): { stop: () => void } {
  const intervalMs = options.intervalMs ?? BAOCO_POLL_INTERVAL_MS;
  const tick = (): void => {
    runBaoCoPoll(deps)
      .then((r) => {
        if (r.ok) {
          // eslint-disable-next-line no-console
          console.log(`[digistore] ✓ POLL báo-có: kéo ${r.fetched}, khớp ${r.matched}, chưa đối soát ${r.unreconciled}${r.errors.length ? `, ${r.errors.length} mã lỗi` : ''}.`);
        }
        for (const e of r.errors) {
          // eslint-disable-next-line no-console
          console.error(`[digistore] ⚠ POLL mã ${e.tid} lỗi [${e.code}]: ${e.reason}`);
        }
      })
      .catch((err) => console.error('[digistore] ⚠ POLL tick lỗi (best-effort):', err instanceof Error ? err.message : err));
  };
  tick(); // chạy ngay lúc start
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PHẦN 4 — ADAPTER DB THẬT (glue mỏng, không thuần). Wire ở index.ts (worker) + route (check).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** UPSERT 1 lô báo-có vào cache digistore_baoco theo bill_id (ON CONFLICT). GIỮ reconcile_status/matched_bill_key CŨ
 *  (chỉ cập nhật dữ liệu raw + source_tid_id + fetched_at) — poll sau ghi reconcile riêng qua markBaoCoReconcile.
 *  Bỏ record thiếu bill_id. */
export async function upsertBaoCoRows(db: Db, txns: BaoCoTxn[]): Promise<void> {
  for (const t of txns) {
    if (!t.billId) continue;
    await db.$executeRawUnsafe(
      `INSERT INTO digistore_baoco (bill_id, qr_code, hkd_name, amount, payer_name, external_ref_no, description, at_ms, status, source_tid_id, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (bill_id) DO UPDATE SET
         qr_code = EXCLUDED.qr_code, hkd_name = EXCLUDED.hkd_name, amount = EXCLUDED.amount,
         payer_name = EXCLUDED.payer_name, external_ref_no = EXCLUDED.external_ref_no, description = EXCLUDED.description,
         at_ms = EXCLUDED.at_ms, status = EXCLUDED.status, source_tid_id = EXCLUDED.source_tid_id, fetched_at = now()`,
      t.billId,
      t.qrCode,
      t.hkdName,
      t.amount,
      t.payerName,
      t.externalRefNo,
      t.description,
      t.atMs,
      t.status,
      t.sourceTidId ?? null
    );
  }
}

/** I/O của lượt CHECK báo-có (tách deps để test bằng fake, không cần mạng/DB — cùng lối runBaoCoPoll). */
export interface BaoCoCheckDeps {
  /** Tải danh sách báo-có trong cửa sổ [fromMs,toMs] (1 mã, hoặc gộp MỌI mã khi chưa biết mã). */
  fetchWindow: (fromMs: number, toMs: number) => Promise<BaoCoCandidate[]>;
  /** Đọc trạng thái đối soát đã lưu (phát hiện DUPLICATE). Lỗi → coi như chưa đối soát (không chặn check). */
  loadStatuses?: (billIds: string[]) => Promise<Map<string, string | null>>;
  /** Nạp danh sách vừa tải vào cache digistore_baoco — "check" cũng chính là "tải danh sách" (Admin Demo 8/9). */
  saveRows?: (rows: BaoCoCandidate[]) => Promise<void>;
  /** Chờ giữa 2 lượt tải (test truyền hàm không chờ). */
  delay?: (ms: number) => Promise<void>;
}

export interface BaoCoCheckOutcome {
  result: CheckResult;
  attempts: number;          // số lượt ĐÃ tải danh sách (1 hoặc 2)
  fetched: number;           // số dòng báo-có của lượt cuối
  saveError?: string;        // R198: nạp cache hỏng phải HIỆN, không nuốt im
}

/**
 * CHECK 1 bill với báo-có, **tự tải danh sách tới 2 lượt** (Admin Demo 8/9 "tự tải danh sách 1 2 lần rồi check cho
 * đảm bảo"): báo-có ngân hàng hay về TRỄ vài giây so với lúc quẹt → lượt 1 chưa thấy là chuyện thường, kết luận
 * "KHÔNG tìm thấy" ngay là SAI (người dùng lại tưởng bill hỏng).
 *
 * LƯỚI AN TOÀN: CHỈ tải lại khi lượt trước ra NOT_FOUND. Đã MATCHED/DUPLICATE/AMBIGUOUS thì DỪNG NGAY — không
 * đăng nhập ngân hàng thừa (chống khoá tài khoản). Mỗi lượt tải đều nạp vào cache để báo cáo/gợi ý dùng lại.
 */
export async function checkBillWithRetry(
  deps: BaoCoCheckDeps,
  bill: BillToCheck,
  opts: { fromMs: number; toMs: number; windowMs?: number; maxAttempts?: number; retryDelayMs?: number }
): Promise<BaoCoCheckOutcome> {
  const maxAttempts = Math.max(1, Math.min(3, opts.maxAttempts ?? 2));
  const retryDelayMs = opts.retryDelayMs ?? 1500;
  const wait = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: CheckResult = { status: 'NOT_FOUND', candidates: [] };
  let attempts = 0;
  let fetched = 0;
  let saveError: string | undefined;

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await wait(retryDelayMs);
    attempts++;
    const rows = await deps.fetchWindow(opts.fromMs, opts.toMs);
    fetched = rows.length;
    if (deps.saveRows && rows.length) {
      try { await deps.saveRows(rows); } catch (err) { saveError = err instanceof Error ? err.message : String(err); }
    }
    if (deps.loadStatuses) {
      try {
        const st = await deps.loadStatuses(rows.map((r) => r.billId).filter((id) => !!id));
        for (const r of rows) r.reconcileStatus = st.get(r.billId) ?? null;
      } catch { for (const r of rows) r.reconcileStatus = null; }
    }
    last = checkBillAgainstBaoCo(bill, rows, { windowMs: opts.windowMs ?? RECONCILE_TIME_WINDOW_MS });
    if (last.status !== 'NOT_FOUND') break; // đã kết luận được → KHÔNG tải thêm lượt nào
  }
  return { result: last, attempts, fetched, saveError };
}

/** GỢI Ý MÃ QR / TÊN HKD cho bill mà OCR KHÔNG đọc được tên (Admin Demo 8/9: "không OCR ra tên HKD thì cho khớp
 *  tương tự tên gợi ý — đúng số tiền, giờ, ngày").
 *
 *  Tra CACHE báo-có `digistore_baoco` (worker poll 30' + mỗi lần check ghi vào) — KHÔNG login thêm ngân hàng
 *  (chống spam đăng nhập/khoá tài khoản). Thứ tự chắc chắn giảm dần:
 *    1) SỐ GIAO DỊCH khớp EXACT (cùng namespace ngân hàng) → gợi ý CHẮC (exact).
 *    2) SỐ TIỀN đúng tuyệt đối + giờ trong ±window → gợi ý theo tiền + ngày giờ.
 *  Bill KHÔNG có giờ → chỉ khớp theo tiền trong 24h gần nhất, đánh dấu `weak` để UI cảnh báo.
 *  Trả DANH SÁCH (nhiều = mơ hồ, để NGƯỜI chọn) — KHÔNG tự gán, vì đây là TIỀN. */
/** [Admin Demo 10/9 — ảnh THÔNG BÁO GIAO DỊCH THẺ] Có tên CHỦ THẺ trên ảnh thì dùng nó THU HẸP danh sách gợi ý:
 *  cùng số tiền + cùng khung giờ mà KHÁC người quẹt thì gần như chắc chắn là giao dịch của cửa hàng khác.
 *  Quy tắc AN TOÀN TIỀN: chỉ thu hẹp khi CÓ ứng viên khớp tên; không ai khớp → GIỮ NGUYÊN cả danh sách (không giấu
 *  dữ liệu của người duyệt) và báo `thuHep=false`. Hàm THUẦN → test không cần DB. */
export function locUngVienTheoNguoiQuet<T extends { payerName: string | null }>(
  candidates: T[], payerName: string | null | undefined
): { candidates: T[]; thuHep: boolean } {
  const ds = Array.isArray(candidates) ? candidates : [];
  if (!payerName || ds.length <= 1) return { candidates: ds, thuHep: false };
  const khop = ds.filter((c) => payerNamesMatch(c.payerName, payerName));
  return khop.length > 0 ? { candidates: khop, thuHep: khop.length < ds.length } : { candidates: ds, thuHep: false };
}

export async function suggestHkdFromBaoCo(
  db: Db,
  input: { amount: number; atMs: number | null; ref?: string | null; windowMs?: number; payerName?: string | null }
): Promise<{ exact: boolean; weak: boolean; candidates: BaoCoSuggestion[] }> {
  const amount = Number(input.amount) || 0;
  if (!(amount > 0)) return { exact: false, weak: false, candidates: [] };
  const windowMs = input.windowMs ?? RECONCILE_TIME_WINDOW_MS;
  const SELECT = `SELECT bill_id AS "billId", qr_code AS "qrCode", hkd_name AS "hkdName", payer_name AS "payerName",
                         amount AS "amount", at_ms AS "atMs", external_ref_no AS "externalRefNo",
                         source_tid_id AS "sourceTidId", reconcile_status AS "reconcileStatus"
                  FROM digistore_baoco`;
  const norm = (rows: BaoCoSuggestion[]): BaoCoSuggestion[] =>
    rows.map((r) => ({ ...r, amount: Number(r.amount), atMs: r.atMs == null ? null : Number(r.atMs) }));

  // 1) Số giao dịch khớp EXACT — chắc nhất, không cần giờ.
  const refKey = normalizeRef(input.ref);
  if (refKey) {
    const rows = (await db.$queryRawUnsafe(
      `${SELECT} WHERE upper(replace(coalesce(external_ref_no, ''), ' ', '')) = $1 LIMIT 10`,
      refKey
    )) as BaoCoSuggestion[];
    if (rows.length > 0) return { exact: true, weak: false, candidates: norm(rows) };
  }

  // 2) Tiền ĐÚNG TUYỆT ĐỐI + giờ trong ±window (bill có giờ) / 24h gần nhất (bill không giờ → weak).
  const atMs = input.atMs;
  const fromMs = atMs != null ? atMs - windowMs : Date.now() - 24 * 60 * 60 * 1000;
  const toMs = atMs != null ? atMs + windowMs : Date.now();
  const rows = (await db.$queryRawUnsafe(
    `${SELECT} WHERE amount = $1 AND at_ms BETWEEN $2 AND $3 ORDER BY at_ms DESC LIMIT 10`,
    amount, fromMs, toMs
  )) as BaoCoSuggestion[];
  // Có tên chủ thẻ (ảnh thông báo giao dịch thẻ) → ưu tiên ứng viên CÙNG người quẹt (xem locUngVienTheoNguoiQuet).
  const loc = locUngVienTheoNguoiQuet(norm(rows), input.payerName);
  return { exact: false, weak: atMs == null, candidates: loc.candidates };
}

/** Ghi kết quả đối soát 1 báo-có vào cache. */
export async function markBaoCoReconcile(db: Db, billId: string, status: 'MATCHED' | 'UNRECONCILED', matchedBillKey: string | null): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE digistore_baoco SET reconcile_status = $2, matched_bill_key = $3 WHERE bill_id = $1`,
    billId,
    status,
    matchedBillKey
  );
}

/** LIỆT KÊ bill QR ĐÃ GHI trong [fromMs,toMs] từ transactions (kind='QR' qua tids) — nguồn đối soát cho poll.
 *  billKey = mã GD (transactions.code); hkdName = tids.hkd_name; amount = transactions.amount; atMs = txn_date.
 *  ref = transactions.qr_ref (Số giao dịch, set lúc /send-qr — Admin Demo 5/9) → poll GHÉP EXACT với external_ref_no
 *  báo-có (ưu tiên tuyệt đối trong reconcileBaoCoToBills). Bill cũ chưa có qr_ref → ref=null → poll fallback HKD+tiền+giờ.
 *  payerName = transactions.qr_payer_name (tín hiệu phá hoà tên người quẹt khi >1 khớp cứng). CHECK on-demand ĐÃ ghép ref. */
export async function listRecordedQrBillsFromDb(db: Db, fromMs: number, toMs: number): Promise<RecordedQrBill[]> {
  // [GÓI TZ 11/9] txn_date trong DB nay là INSTANT THẬT (gói chuẩn hoá + đường ghi raw-ISO) → hết trò "2 bẫy
  // triệt tiêu" cũ (Date param −7h + Date read +7h trên data −7h). Bound bằng ISO ::timestamptz + atMs bằng
  // EXTRACT(EPOCH) — epoch của timestamptz là tuyệt đối, KHÔNG phụ thuộc session TZ, so thẳng với at_ms báo-có.
  const rows = (await db.$queryRawUnsafe(
    `SELECT t.code AS "billKey", ti.hkd_name AS "hkdName", t.amount AS "amount",
            (EXTRACT(EPOCH FROM t.txn_date) * 1000)::float8 AS "atMsRaw",
            t.qr_ref AS "ref", t.qr_payer_name AS "payerName"
       FROM transactions t
       JOIN tids ti ON ti.id = t.tid_id
      WHERE ti.kind = 'QR'
        AND t.deleted_at IS NULL
        AND t.txn_date >= $1::timestamptz
        AND t.txn_date <= $2::timestamptz`,
    new Date(fromMs).toISOString(),
    new Date(toMs).toISOString()
  )) as Array<{ billKey: string | null; hkdName: string | null; amount: bigint | number | null; atMsRaw: number | null; ref: string | null; payerName: string | null }>;
  return rows.map((r) => ({
    billKey: r.billKey ?? '',
    hkdName: r.hkdName,
    amount: r.amount == null ? 0 : Number(r.amount),
    atMs: r.atMsRaw == null ? null : Math.round(r.atMsRaw),
    ref: r.ref ?? null,
    payerName: r.payerName ?? null
  }));
}

/** Đọc reconcile_status trong cache cho danh sách bill_id (cho phát hiện DUPLICATE ở check on-demand). */
export async function readBaoCoReconcileStatuses(db: Db, billIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (billIds.length === 0) return out;
  const rows = (await db.$queryRawUnsafe(
    `SELECT bill_id AS "billId", reconcile_status AS "reconcileStatus" FROM digistore_baoco WHERE bill_id = ANY($1)`,
    billIds
  )) as Array<{ billId: string; reconcileStatus: string | null }>;
  for (const r of rows) out.set(r.billId, r.reconcileStatus);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PHẦN 5 — CREDS PER-MÃ (mã hoá) + resolver. Bảng qr_digistore_cred (ensureAlphaExtraSchema). Base optional (mặc
// định BVBank chung); chỉ username + password_enc bắt buộc per mã.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** LƯU/CẬP NHẬT creds DigiStore cho 1 MÃ QR (mã hoá password). base rỗng → NULL (resolver dùng default chung). Thiếu
 *  DIGISTORE_ENC_KEY → encryptSecret NÉM (R198 — KHÔNG lưu plaintext). Idempotent theo tid_id (UNIQUE). */
export async function setDigistoreCred(
  db: Db,
  input: { tidId: number; base?: string | null; username: string; password: string }
): Promise<void> {
  const passwordEnc = encryptSecret(input.password); // ném DigistoreSecretError nếu thiếu/khoá sai
  const base = input.base && input.base.trim() ? input.base.trim() : null;
  await db.$executeRawUnsafe(
    `INSERT INTO qr_digistore_cred (tid_id, base, username, password_enc, updated_at)
       VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tid_id) DO UPDATE SET
       base = EXCLUDED.base, username = EXCLUDED.username, password_enc = EXCLUDED.password_enc, updated_at = now()`,
    input.tidId,
    base,
    input.username,
    passwordEnc
  );
}

/** RESOLVER — creds đã GIẢI MÃ cho 1 MÃ QR (tids.id). Chưa cấu hình → null. Giải mã lỗi (thiếu khoá/hỏng) → NÉM
 *  DigistoreSecretError (R198 — không nuốt câm). base rỗng → default chung; label = mã TID cho thông điệp lỗi. */
export async function digistoreCredForTid(db: Db, tidId: number): Promise<DigistoreCreds | null> {
  const rows = (await db.$queryRawUnsafe(
    `SELECT c.base AS "base", c.username AS "username", c.password_enc AS "passwordEnc", t.tid AS "tid"
       FROM qr_digistore_cred c JOIN tids t ON t.id = c.tid_id
      WHERE c.tid_id = $1 LIMIT 1`,
    tidId
  )) as Array<{ base: string | null; username: string; passwordEnc: string; tid: string | null }>;
  if (!rows.length) return null;
  const row = rows[0];
  const password = decryptSecret(row.passwordEnc); // ném nếu khoá sai/hỏng
  return {
    tidId,
    base: row.base && row.base.trim() ? row.base.trim() : null,
    email: row.username,
    password,
    label: row.tid ?? String(tidId)
  };
}

/** DUYỆT MỌI mã QR (tids kind='QR', chưa xoá) kèm creds (đã giải mã) nếu có — cho POLL per-mã. Mã chưa cấu hình →
 *  creds:null (poll bỏ qua + log). Giải mã 1 mã lỗi → creds:null + decryptError (poll gom vào errors, KHÔNG chết cả
 *  lượt — R198 loud, không nuốt câm). base rỗng → default chung. */
export async function listQrTidsForPoll(
  db: Db
): Promise<Array<{ tidId: number; tid: string; hkdName: string | null; creds: DigistoreCreds | null; decryptError?: string }>> {
  const rows = (await db.$queryRawUnsafe(
    `SELECT t.id AS "tidId", t.tid AS "tid", t.hkd_name AS "hkdName",
            c.base AS "base", c.username AS "username", c.password_enc AS "passwordEnc"
       FROM tids t LEFT JOIN qr_digistore_cred c ON c.tid_id = t.id
      WHERE t.kind = 'QR' AND t.deleted_at IS NULL
      ORDER BY t.id`
  )) as Array<{ tidId: number; tid: string; hkdName: string | null; base: string | null; username: string | null; passwordEnc: string | null }>;
  return rows.map((r) => {
    if (!r.username || !r.passwordEnc) return { tidId: r.tidId, tid: r.tid, hkdName: r.hkdName, creds: null };
    try {
      const password = decryptSecret(r.passwordEnc);
      return {
        tidId: r.tidId,
        tid: r.tid,
        hkdName: r.hkdName,
        creds: { tidId: r.tidId, base: r.base && r.base.trim() ? r.base.trim() : null, email: r.username, password, label: r.tid }
      };
    } catch (err) {
      return { tidId: r.tidId, tid: r.tid, hkdName: r.hkdName, creds: null, decryptError: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** RESOLVE mã QR của 1 bill để CHECK on-demand: ưu tiên tidId (nếu UI gửi); nếu không có → suy theo tên HKD (khớp
 *  chuẩn-hoá). Ambiguous (≥2 mã cùng tên HKD) / không tìm thấy → null (route rơi về .env fallback + cảnh báo). */
export async function resolveQrTidForBill(
  db: Db,
  input: { tidId?: number | null; hkdName?: string | null }
): Promise<{ tidId: number; tid: string; hkdName: string | null } | null> {
  if (input.tidId != null && Number.isFinite(input.tidId)) {
    const rows = (await db.$queryRawUnsafe(
      `SELECT id AS "tidId", tid AS "tid", hkd_name AS "hkdName" FROM tids WHERE id = $1 AND kind = 'QR' AND deleted_at IS NULL LIMIT 1`,
      input.tidId
    )) as Array<{ tidId: number; tid: string; hkdName: string | null }>;
    return rows[0] ?? null;
  }
  const key = normalizeHkdKey(input.hkdName);
  if (!key) return null;
  const rows = (await db.$queryRawUnsafe(
    `SELECT id AS "tidId", tid AS "tid", hkd_name AS "hkdName" FROM tids WHERE kind = 'QR' AND deleted_at IS NULL`
  )) as Array<{ tidId: number; tid: string; hkdName: string | null }>;
  const matches = rows.filter((r) => normalizeHkdKey(r.hkdName) === key);
  if (matches.length === 1) return matches[0];
  // [Admin Demo 8/9] App ngân hàng CẮT CỤT tên trên bill ("HKD DEMO 40 Ha..." thay vì "...Ha Noi") → so BẰNG
  // trượt hết. Chấp nhận khớp TIỀN TỐ khi tên đọc được đủ dài (≥10 ký tự sau chuẩn hoá) VÀ chỉ đúng 1 mã bắt đầu
  // bằng nó — nhiều mã cùng tiền tố = mơ hồ → trả null (thà không đoán còn hơn gán nhầm mã, đây là TIỀN).
  if (key.length >= 10) {
    const prefix = rows.filter((r) => {
      const k = normalizeHkdKey(r.hkdName);
      return k.length > key.length && k.startsWith(key);
    });
    if (prefix.length === 1) return prefix[0];
  }
  return null;
}

/** Dựng deps POLL THẬT từ Db production. fetchRecent = duyệt MỌI mã QR có creds → fetchBaoCo(creds, now−24h, now) per
 *  mã → gộp txns + gom errors per-mã. Mã chưa cấu hình → BỎ QUA + log. Fail 1 mã → tiếp mã khác (R198). */
/** [Admin Demo 24/9] `chiMa` = danh sách tid_id CHỈ ĐỊNH (tích chọn nhiều mã ở màn Báo cáo QR) → chỉ kéo báo-có của
 *  các mã đó ("kéo báo có riêng"). Bỏ trống = kéo TẤT CẢ mã như cũ (worker nền luôn gọi không tham số). */
export function buildBaoCoPollDeps(db: Db, chiMa?: number[]): BaoCoPollDeps {
  return {
    fetchRecent: async (): Promise<BaoCoFetchResult> => {
      const to = Date.now();
      const fromMacDinh = to - 24 * 60 * 60 * 1000;
      const tatCa = await listQrTidsForPoll(db); // ném nếu DB lỗi → runBaoCoPoll → ok:false (giữ cache cũ).
      const loc = chiMa && chiMa.length ? new Set(chiMa) : null;
      const tids = loc ? tatCa.filter((t) => loc.has(t.tidId)) : tatCa;
      if (loc) console.error(`[digistore] POLL theo YÊU CẦU: ${tids.length}/${tatCa.length} mã được chọn (${tids.map((t) => t.tid).join(', ') || 'không mã nào khớp'}).`);
      // [Admin Demo 16/9 — "áp cache như CQR" + "không mượt"] 2 tối ưu:
      //  (1) INCREMENTAL: dữ liệu cũ ĐÃ nằm bền trong digistore_baoco (upsert) → mỗi mã chỉ kéo TỪ mốc báo-có
      //      MỚI NHẤT đã có − 30' đệm (bill về muộn), không kéo lại cả 24h mỗi lần.
      //  (2) SONG SONG các mã (trước tuần tự → 4 mã 6.2s; mỗi mã 1 tài khoản bank riêng nên song song an toàn,
      //      CQR đã chạy song song 13 mã ổn định).
      let mocMoiNhat = new Map<number, number>();
      try {
        const rows = (await db.$queryRawUnsafe(
          `SELECT source_tid_id AS tid_id, MAX(at_ms) AS max_ms FROM digistore_baoco WHERE source_tid_id IS NOT NULL GROUP BY source_tid_id`
        )) as Array<{ tid_id: number; max_ms: bigint | number | null }>;
        mocMoiNhat = new Map(rows.map((r) => [Number(r.tid_id), Number(r.max_ms ?? 0)]));
      } catch { /* không đọc được mốc → kéo 24h như cũ */ }
      const out: BaoCoTxn[] = [];
      const errors: BaoCoFetchError[] = [];
      let configuredCount = 0;
      const daCauHinh = tids.filter((t) => {
        if (t.creds) return true;
        if (t.decryptError) {
          // eslint-disable-next-line no-console
          console.error(`[digistore] ⚠ POLL: mã ${t.tid} (tid_id=${t.tidId}) GIẢI MÃ creds lỗi: ${t.decryptError} — bỏ qua.`);
          errors.push({ tid: t.tid, code: 'DECRYPT_FAILED', reason: t.decryptError });
        } else {
          // eslint-disable-next-line no-console
          console.warn(`[digistore] POLL: mã ${t.tid} (tid_id=${t.tidId}) chưa cấu hình DigiStore — bỏ qua.`);
        }
        return false;
      });
      configuredCount = daCauHinh.length;
      await Promise.all(daCauHinh.map(async (t) => {
        const moc = mocMoiNhat.get(t.tidId) ?? 0;
        const from = moc > 0 ? Math.max(fromMacDinh, moc - 30 * 60_000) : fromMacDinh;
        try {
          const txns = await fetchBaoCo(t.creds!, from, to);
          for (const x of txns) { x.sourceTidId = t.tidId; out.push(x); }
        } catch (err) {
          const code = err instanceof DigistoreError ? err.code : 'UNKNOWN';
          const reason = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error(`[digistore] ⚠ POLL: kéo báo-có mã ${t.tid} lỗi [${code}]: ${reason} — bỏ qua mã này, tiếp tục.`);
          errors.push({ tid: t.tid, code, reason });
        }
      }));
      if (configuredCount === 0) {
        // eslint-disable-next-line no-console
        console.warn('[digistore] ⚠ POLL: KHÔNG có mã QR nào cấu hình DigiStore — không kéo được báo-có nào.');
      }
      return { txns: out, errors, configuredCount };
    },
    upsertBaoCo: (txns) => upsertBaoCoRows(db, txns),
    listRecordedQrBills: (fromMs, toMs) => listRecordedQrBillsFromDb(db, fromMs, toMs),
    markReconcile: (billId, status, key) => markBaoCoReconcile(db, billId, status, key)
  };
}
