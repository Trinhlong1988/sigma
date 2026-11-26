// Giao dịch / Doanh thu (Nhóm B). Pure logic — không DB, không Electron.
// Phí lưu Int = phần trăm × 1000 (milli), khớp fee-config (SCALE=1000).
//
// LEAD 9/7 — Doanh thu BÓC 2 khoản chênh rồi CỘNG GỘP:
//   • CL_NCC (chênh đối tác) = phiMua − phiCaiMay  → khoản đối soát/thu từ đối tác
//   • CL_KH  (chênh bán)     = phiBan − phiCaiMay  → khoản thu từ khách
//   Doanh thu = số tiền × (CL_NCC% + CL_KH%). CẢ 2 khoản = công nợ thu về.

/**
 * Quy đổi 1 khoản chênh (milli %) trên số tiền → VND. Làm tròn về đồng.
 * marginMilli = phần trăm × 1000. amount × (marginMilli/1000)/100 = amount × marginMilli / 100000.
 */
export function marginToAmount(amount: number, marginMilli: number): number {
  if (!Number.isFinite(amount) || amount < 0) return 0;
  if (!Number.isFinite(marginMilli)) return 0;
  const prod = amount * marginMilli;
  // Money-3 (audit 20/8): số cực lớn (amount×marginMilli > 2⁵³) → float MẤT ĐỘ CHÍNH XÁC (đồng lẻ sai). VND là số
  // NGUYÊN → dùng BigInt cho phép nhân+chia CHÍNH XÁC khi vượt ngưỡng an toàn, làm tròn "nửa lên" như Math.round.
  if (!Number.isSafeInteger(prod)) {
    const a = BigInt(Math.round(amount)), m = BigInt(Math.round(marginMilli)), D = 100000n;
    const num = a * m; // chính xác tuyệt đối
    const q = num / D, r = num % D; // làm tròn nửa-lên: |r|*2 ≥ D → +1 (theo dấu)
    const rounded = (r < 0n ? -r : r) * 2n >= D ? q + (num < 0n ? -1n : 1n) : q;
    return Number(rounded);
  }
  return Math.round(prod / 100000);
}

/**
 * Bóc doanh thu 1 giao dịch thành 2 khoản chênh + tổng.
 *   partnerMarginMilli = CL_NCC = phiMua − phiCaiMay (×1000)
 *   sellMarginMilli    = CL_KH  = phiBan − phiCaiMay (×1000)
 * Trả về { revenuePartner, revenueSell, revenueAmount } (VND).
 * revenueAmount = revenuePartner + revenueSell (doanh thu tổng = tổng công nợ thu về).
 */
export function computeRevenue(
  amount: number,
  partnerMarginMilli: number,
  sellMarginMilli: number
): { revenuePartner: number; revenueSell: number; revenueAmount: number } {
  const revenuePartner = marginToAmount(amount, partnerMarginMilli || 0);
  const revenueSell = marginToAmount(amount, sellMarginMilli || 0);
  return { revenuePartner, revenueSell, revenueAmount: revenuePartner + revenueSell };
}

// ── P1.1 GIÁ THEO KỲ ─────────────────────────────────────────────────────────
/**
 * Chọn KỲ giá đang hiệu lực tại mốc `at` trong danh sách kỳ của CÙNG 1 tổ hợp
 * (đối tác × loại thẻ, đã lọc còn sống). Trả về kỳ có `effectiveFrom` ≤ `at` LỚN NHẤT,
 * hoặc `null` nếu không có kỳ nào bắt đầu ≤ `at` (KHÔNG lấy đại kỳ tương lai — I-P3).
 * Hàm THUẦN: không DB, không side-effect. `effectiveFrom` nhận Date hoặc ISO string.
 */
export function pickEffectiveRate<T extends { effectiveFrom: Date | string }>(rows: T[], at: Date): T | null {
  const atMs = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (Number.isNaN(atMs)) return null;
  let best: T | null = null;
  let bestMs = -Infinity;
  for (const r of rows) {
    const ef = r.effectiveFrom instanceof Date ? r.effectiveFrom : new Date(r.effectiveFrom);
    const efMs = ef.getTime();
    if (Number.isNaN(efMs)) continue;
    if (efMs <= atMs && efMs > bestMs) {
      best = r;
      bestMs = efMs;
    }
  }
  return best;
}

// ── [Admin Demo 4/9] GIÁ CUỐI TUẦN (weekend pricing) ─────────────────────────────
/**
 * Cuối tuần = Thứ 7 + Chủ nhật theo giờ VN (Asia/Ho_Chi_Minh, UTC+7 CỐ ĐỊNH, không DST — VN không đổi giờ).
 * Xét theo NGÀY GIAO DỊCH trên bill (txnDate), KHÔNG theo lúc quét/gửi — nếu không sẽ lệch hiển thị vs ghi (mìn #1).
 * THUẦN. `at` nhận Date hoặc ISO string.
 */
export function isWeekendHCM(at: Date | string): boolean {
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (Number.isNaN(ms)) return false;
  const dow = new Date(ms + 7 * 60 * 60 * 1000).getUTCDay(); // 0=CN .. 6=T7 theo giờ VN
  return dow === 0 || dow === 6;
}

// ── SIGMA Tier 1 (2026-07-22) — trích XUẤT THUẦN từ resolveFeeForTxn (apps/desktop/src/main/
// transaction-service.ts, phần "phí bán THỰC TẾ"). Công thức: phí bán THỰC TẾ = TidSellFee override ĐÈ phí bán
// NIÊM YẾT (FeeSellQuote). Hàm THUẦN — không đụng Prisma/DB; caller (transaction-service.ts VÀ apps/bot-api) tự
// fetch `overrides`/`quotes` rồi gọi hàm này để đảm bảo CHỈ 1 nơi cài đặt công thức "override đè niêm yết".
//
// P1 (nền phí hiệu-lực-theo-kỳ) — ĐỔI HÀNH VI CÓ CHỦ ĐÍCH: override nay CŨNG có nhiều KỲ (TidSellFee thêm
// effectiveFrom) và ĐƯỢC CHỌN THEO KỲ hiệu lực tại `at` qua `pickEffectiveRate(overrides, at)` — KHÔNG còn "có
// override → dùng thẳng bỏ qua at". Hệ quả: KỲ override bắt đầu SAU `at` (tương lai) KHÔNG che niêm yết hiện
// hành → caller PHẢI luôn fetch `quotes` (không còn tối ưu "có override thì bỏ quotes"). GD trước ngày
// effectiveFrom của override lấy NIÊM YẾT; GD từ ngày đó trở đi lấy OVERRIDE.
export interface SellFeeOverrideRow {
  phiBan: number; // milli % (×1000), khớp TidSellFee.phiBan
  effectiveFrom: Date | string; // KỲ hiệu lực của override, khớp TidSellFee.effectiveFrom
  // [Admin Demo 25/9 — GIÁ BÁN THEO ĐẠI LÝ] null/undefined = giá CHUNG của máy (mọi đại lý). Có số = giá RIÊNG chỉ
  // áp khi ĐẠI LÝ ĐÓ đang cầm/mượn máy. Dùng cho ca "Tuyên mượn máy nhà Trường Thiện, riêng Tuyên 1,25%".
  customerId?: number | null;
}
export interface SellQuoteRow {
  phiBan: number; // milli %, khớp FeeSellQuote.phiBan
  effectiveFrom: Date | string;
}
export type ResolveSellFeeResult =
  | { ok: true; phiBanMilli: number; source: 'OVERRIDE' | 'QUOTE'; weekendDeltaApplied?: number }
  | { ok: false; error: 'NO_SELL_QUOTE' };

/**
 * Chọn phí bán THỰC TẾ (milli %) cho 1 (tid × loại thẻ × loại phí) tại mốc `at`:
 *   - có KỲ `overrides` (TidSellFee còn sống) hiệu lực tại `at` (pickEffectiveRate) → dùng KỲ override đó.
 *   - không có KỲ override nào ≤ `at` → chọn kỳ FeeSellQuote hiệu lực tại `at`; không có kỳ nào → lỗi.
 * Caller chịu trách nhiệm fetch đúng `overrides`/`quotes` theo đúng khóa (tidId/partnerId × cardTypeId ×
 * feeTypeId, deletedAt: null) — hàm này không biết Prisma, chỉ áp công thức trên dữ liệu đã có. Vì KỲ override
 * tương lai có thể không hiệu lực tại `at`, caller LUÔN phải cấp `quotes` (không được bỏ qua khi có override).
 *
 * [Admin Demo 4/9 + KM 12/9] GIẢM GIÁ BÁN (POS): trừ `weekend.deltaMilli` SAU khi chọn kỳ giá. Nhét vào ĐÂY = chỗ
 * GỐC duy nhất để mọi caller (resolveFeeForTxn/quoteRow/recalc) kế thừa nhất quán (mìn #2). [ĐỔI HỢP ĐỒNG 12/9 —
 * khuyến mại T9 áp MỌI NGÀY]: hàm này KHÔNG tự xét lịch nữa — CALLER (resolveWeekendSellDeltaMilli) pre-gate theo
 * lịch (cuối tuần / cửa sổ khuyến mại) rồi truyền delta CUỐI CÙNG; delta > 0 là trừ thẳng. Phí không âm.
 */
export function resolveActualSellFee(
  overrides: SellFeeOverrideRow[],
  quotes: SellQuoteRow[],
  at: Date,
  weekend?: { deltaMilli: number; dealerCustomerId?: number | null }
): ResolveSellFeeResult {
  // [Admin Demo 25/9] ƯU TIÊN GIÁ RIÊNG CỦA ĐẠI LÝ ĐANG CẦM MÁY, không có mới dùng giá CHUNG.
  // "giá đã áp dụng ở đại lý khác thì giữ nguyên" ⇒ dòng giá riêng của nhà A KHÔNG được lọt sang nhà B:
  // lọc bỏ mọi dòng có customerId khác đại lý hiện tại TRƯỚC khi chọn kỳ hiệu lực.
  const dealer = weekend?.dealerCustomerId ?? null;
  const rieng = dealer == null ? [] : overrides.filter((o) => o.customerId === dealer);
  const chung = overrides.filter((o) => o.customerId == null);
  const override = pickEffectiveRate(rieng, at) ?? pickEffectiveRate(chung, at);
  const base: { phiBanMilli: number; source: 'OVERRIDE' | 'QUOTE' } | null = override
    ? { phiBanMilli: override.phiBan, source: 'OVERRIDE' }
    : (() => {
        const quote = pickEffectiveRate(quotes, at);
        return quote ? { phiBanMilli: quote.phiBan, source: 'QUOTE' as const } : null;
      })();
  if (!base) return { ok: false, error: 'NO_SELL_QUOTE' };
  const delta = weekend && weekend.deltaMilli > 0 ? weekend.deltaMilli : 0; // pre-gated bởi caller (xem docstring 12/9)
  const phiBanMilli = Math.max(0, base.phiBanMilli - delta);
  return delta > 0
    ? { ok: true, phiBanMilli, source: base.source, weekendDeltaApplied: delta }
    : { ok: true, phiBanMilli, source: base.source };
}

// ── [Admin Demo 4/9] PHÍ QR (per HKD) ────────────────────────────────────────────
// QR không có loại thẻ. Phí theo TỪNG HKD (dòng QrFeeRate gắn qrTidId). Giá MUA đổi theo thứ (cuối tuần TĂNG);
// giá BÁN cố định. THUẦN — caller fetch các kỳ QrFeeRate (deletedAt null) rồi gọi hàm này.
export interface QrFeeRateRow {
  phiMuaThuong: number; // milli %, giá mua ngày thường (vd 850 = 0.85%)
  phiMuaCuoiTuan: number; // milli %, giá mua T7/CN (vd 900 = 0.9%)
  phiBan: number; // milli %, giá bán (không đổi cuối tuần, vd 1050 = 1.05%)
  effectiveFrom: Date | string;
}
export type ResolveQrFeeResult =
  | { ok: true; phiMuaMilli: number; phiBanMilli: number; isWeekend: boolean }
  | { ok: false; error: 'NO_QR_FEE' };
/** Chọn phí QR hiệu lực tại `at` (theo kỳ) rồi chọn giá mua theo thứ (cuối tuần → phiMuaCuoiTuan). */
export function resolveQrFee(rows: QrFeeRateRow[], at: Date): ResolveQrFeeResult {
  const row = pickEffectiveRate(rows, at);
  if (!row) return { ok: false, error: 'NO_QR_FEE' };
  const wk = isWeekendHCM(at);
  return { ok: true, phiMuaMilli: wk ? row.phiMuaCuoiTuan : row.phiMuaThuong, phiBanMilli: row.phiBan, isWeekend: wk };
}
