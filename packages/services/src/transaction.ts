// Doanh thu & Công nợ — LÕI THUẦN ctx-based. PORT nghiệp vụ từ apps/desktop/src/main/transaction-service.ts.
// Mỗi giao dịch = 1 lần quẹt/rút qua 1 TID cho 1 khách. Doanh thu BÓC 2 khoản chênh rồi CỘNG GỘP:
//   • CL_NCC (chênh đối tác) = phiMua − phiCaiMay  → khoản đối soát/thu từ đối tác
//   • CL_KH  (chênh bán)     = phiBan − phiCaiMay  → khoản thu từ khách
// Biểu phí tra theo (Đối tác của TID × Loại thẻ) → snapshot vào GD (×1000). Thay requirePermission(current-user)
// bằng ctx = { db, user }; mỗi hàm tự hasPermission(ctx.user, ...). GIỮ NGUYÊN TỪNG BƯỚC transaction/FOR UPDATE/
// optimistic-lock/công nợ. XÁC NHẬN MẬT KHẨU (§14) do ADAPTER kiểm TRƯỚC khi gọi lõi (khớp customer.ts) — lõi
// KHÔNG kiểm password. MutationResult/ServiceCtx từ customer.js (KHÔNG khai lại / KHÔNG re-export).
import { isWeekendHCM, auditSnapshot, computeRevenue, pickEffectiveRate, resolveActualSellFee } from '@sigma/business-rules';
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit, type AuditInput } from './audit.js';
import { nextCode } from './code.js';
import { type ServiceCtx, type MutationResult } from './customer.js';
// TÌM KIẾM hoa/thường: DB collation "C" → Prisma mode:'insensitive' (ILIKE) KHÔNG gập chữ tiếng Việt có dấu
// (đo thật trên sổ thật: ILIKE '%nguyễn%' = 0 dòng / ILIKE '%NGUYỄN%' = 10 dòng). Xem tim-kiem-hoa-thuong.ts.
import { dieuKienTimKiem } from './tim-kiem-hoa-thuong.js';
import { nhanBank } from './nhan-bank.js';

const VIEW = 'REVENUE_VIEW';
const MANAGE = 'REVENUE_MANAGE';
const DEBT_VIEW = 'DEBT_VIEW';
// H5: DEBT_SETTLE (toggle tay) đã vô hiệu — settled chỉ đổi qua phiếu Thu công nợ.
const DEBT_CLASSIFY = 'DEBT_CLASSIFY';
const DEBT_WRITEOFF = 'DEBT_WRITEOFF';
/** 3 mức chất lượng công nợ: GOOD Dễ thu hồi | HARD Khó thu hồi | BAD Không thu hồi. */
const DEBT_QUALITIES = new Set(['GOOD', 'HARD', 'BAD']);
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

/** tx client trong $transaction (đủ model delegate + $queryRaw/$queryRawUnsafe). */
type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

// ── audit helper NGHIÊM (G1) — tách bản THUẦN cho @sigma/services (audit.ts services chưa export writeAuditStrict/
//    bumpChangeToken). writeAuditStrict PHẢI gọi TRONG $transaction: audit fail → NÉM → tx rollback (invariant #5,
//    không mutation tiền nào commit mà thiếu dấu vết). SIGMA_AUDIT_FAULT=1 = chốt fault-injection selftest. ──
async function writeAuditStrict(txc: Tx, input: AuditInput): Promise<void> {
  if (process.env['SIGMA_AUDIT_FAULT'] === '1') throw new Error('[audit] injected fault (SIGMA_AUDIT_FAULT=1)');
  await txc.auditLog.create({
    data: {
      actorUserId: input.actorUserId ?? undefined,
      action: input.action,
      targetType: input.targetType ?? undefined,
      targetId: input.targetId ?? undefined,
      beforeJson: input.before === undefined ? undefined : JSON.stringify(input.before),
      afterJson: input.after === undefined ? undefined : JSON.stringify(input.after),
      ipAddress: input.ip ?? undefined,
      deviceInfo: input.deviceInfo ?? undefined
    }
  });
}
/** Best-effort realtime "đồng hồ thay đổi" — TÁCH khỏi tx tiền (lỗi bump KHÔNG rollback nghiệp vụ). */
async function bumpChangeToken(db: Pick<Db, 'changeToken'>, targetType?: string | null): Promise<void> {
  try {
    const domain = targetType ?? 'GLOBAL';
    await db.changeToken.upsert({ where: { domain }, create: { domain, version: 1 }, update: { version: { increment: 1 } } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[changeToken] bump failed', targetType, err);
  }
}

async function resolveUserNames(db: Db, ids: (number | null | undefined)[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids.filter((x): x is number => typeof x === 'number'))];
  const map = new Map<number, string>();
  if (uniq.length === 0) return map;
  const users = await db.user.findMany({ where: { id: { in: uniq } }, select: { id: true, fullName: true, username: true } });
  for (const u of users) map.set(u.id, u.fullName || u.username);
  return map;
}
/** ISO string / Date → Date hợp lệ, hoặc null. P1-05: chuỗi 'YYYY-MM-DD' phải là ngày CÓ THẬT (chống JS cuộn âm thầm). */
function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(s);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
    const isUtc = s.length === 10 || /[zZ]$/.test(s) || !/T/.test(s);
    if (isUtc && (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== mo || d.getUTCDate() !== da)) return null;
  }
  return d;
}
/** Số tiền VND: số nguyên ≥ 0, ≤ MAX_SAFE_INTEGER (chống mất chính xác Number/BigInt round-trip). */
function parseAmount(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  // B2 (đối kháng 12/8): thêm chặn > MAX_SAFE_INTEGER — đồng bộ cash-entry/investor-advance/export-request.
  // TRƯỚC: số >2^53 (Number.isInteger vẫn true) lọt → mất chính xác ở path tiền LÕI (giao dịch, lưu BigInt ×1000).
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n) || n > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

// ═════════════════════════════════════════════════════════════════════════════
// DTO
// ═════════════════════════════════════════════════════════════════════════════
export interface TransactionDto {
  id: number;
  code: string | null;
  tidId: number;
  tid: string | null;
  mid: string | null;
  hkdName: string | null;
  bankId: number | null;
  bankName: string | null;
  partnerId: number | null;
  partnerName: string | null;
  customerId: number | null;
  customerName: string | null;
  cardTypeId: number | null;
  cardTypeName: string | null;
  feeTypeId: number | null;
  feeTypeName: string | null;
  amount: number;
  partnerMarginPct: number; // CL_NCC %
  sellMarginPct: number; // CL_KH %
  revenuePartner: number; // VND
  revenueSell: number; // VND
  revenueAmount: number; // VND (tổng)
  settled: boolean;
  settledAt: string | null;
  status: string; // POSTED | CANCEL_PENDING | CANCELLED
  txnDate: string;
  note: string | null;
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
}

export interface TransactionFilter {
  tidId?: number;
  code?: string;
  mid?: string;
  hkdName?: string;
  partnerId?: number;
  bankId?: number;
  customerId?: number;
  cardTypeId?: number;
  feeTypeId?: number;
  dateFrom?: string;
  dateTo?: string;
  settled?: boolean;
  page?: number;
  pageSize?: number;
}

export interface RevenueSummary {
  count: number;
  totalAmount: number;
  totalRevenuePartner: number;
  totalRevenueSell: number;
  totalRevenue: number;
}

export interface DebtSummary {
  count: number;
  debtPartner: number;
  debtSell: number;
  debtTotal: number;
}

export interface DebtOpenTxnDto {
  id: number;
  code: string | null;
  txnDate: string;
  tid: string | null;
  mid: string | null;
  hkdName: string | null;
  customerId: number | null;
  customerName: string | null;
  partnerId: number | null;
  partnerName: string | null;
  revenuePartner: number;
  revenueSell: number;
  remainingPartner: number;
  remainingSell: number;
  settled: boolean;
  debtQuality: string | null;
}

export interface DebtOpenResult {
  ok: boolean;
  error?: string;
  message?: string;
  data?: DebtOpenTxnDto[];
}

const SCALE = 1000;
const milliToPct = (m: number): number => m / SCALE;

export interface ResolvedFee {
  partnerMarginMilli: number;
  sellMarginMilli: number;
  phiCaiMayMilli: number; // PHÍ CÀI MÁY (×1000) hiệu lực tại ngày GD — snapshot vào Transaction để tất toán NĐT theo TID (Admin Demo 11/8)
  bankId: number | null;
  partnerId: number | null;
}

// PHA 2 (engine RECALC) — resolveFeeForTxn CHỈ ĐỌC 4 model phí. Đánh KIỂU CẤU TRÚC (không nguyên `Db`) để CẢ
// Db LẪN tx-client ($transaction) đều truyền được → engine revenue-recalc.ts tái dùng CÙNG 1 công thức phí (không
// nhân bản resolveActualSellFee/pickEffectiveRate) khi tính lại trong CÙNG $transaction với lệnh đổi phí.
export type FeeResolveClient = Pick<Db, 'cardType' | 'feeRate' | 'tidSellFee' | 'feeSellQuote' | '$queryRawUnsafe'>;

/** [Admin Demo 4/9] Delta GIẢM phí bán cuối tuần (milli) cho 1 loại thẻ tại NGÀY GD `at`, từ bảng phụ
 *  `weekend_sell_adjust` (global, KHÔNG theo partner; admin cấu hình cho MB/MBV). Chọn kỳ hiệu lực effective_from ≤ at.
 *  Không có → 0 (thẻ không giảm cuối tuần). Raw SQL (bảng additive — cố ý KHÔNG đưa vào Prisma client để tránh
 *  regenerate phá server 24/24; đồng bộ cách repo dùng los.bill_txn_date / ocr_bill_sent). Bảng được đảm bảo tồn
 *  tại bởi ensureAlphaExtraSchema lúc boot → nếu thiếu, query NÉM LỖI fail-loud (không nuốt, R198). */
/** [Admin Demo 12/9] Ngày HCM 'YYYY-MM-DD' của instant `at` (+7 cố định, không DST). */
export function hcmDayStr(at: Date): string {
  return new Date(at.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}
/** [Admin Demo 12/9] Delta khuyến mại LỚN NHẤT trong các dòng đã lọc kênh+cửa sổ, xét LỊCH: RANGE=mọi ngày ·
 *  WEEKEND=chỉ T7/CN (HCM) · DATES=chỉ các ngày liệt kê trong ngay_cu_the (JSON ["YYYY-MM-DD"]). Dòng lịch hỏng → bỏ. */
export function maxPromoDeltaTheoLich(rows: Array<{ delta_milli: number; lich: string; ngay_cu_the: string | null }>, at: Date): number {
  let best = 0;
  const day = hcmDayStr(at);
  for (const r of rows) {
    const d = typeof r.delta_milli === 'number' ? r.delta_milli : Number(r.delta_milli);
    if (!(d > 0)) continue;
    if (r.lich === 'WEEKEND' && !isWeekendHCM(at)) continue;
    if (r.lich === 'DATES') {
      try {
        const ds = JSON.parse(r.ngay_cu_the ?? '[]') as unknown;
        if (!Array.isArray(ds) || !ds.includes(day)) continue;
      } catch { continue; }
    } else if (r.lich !== 'RANGE' && r.lich !== 'WEEKEND') continue;
    if (d > best) best = d;
  }
  return best;
}

export async function resolveWeekendSellDeltaMilli(db: Pick<Db, '$queryRawUnsafe'>, cardTypeId: number, at: Date): Promise<number> {
  // HIGH-3 (phản biện 4/9): hàm này chạy TRONG resolveFeeForTxn = đường GHI DOANH SỐ cốt lõi. Nếu ném lỗi (bảng
  // chưa tạo lúc boot-race, hoặc DDL fail) → createTransactionSystem ném → bridge nuốt best-effort → bill có los
  // NHƯNG KHÔNG có Transaction → NĐT/SigMa SÓT doanh số CÂM (đúng lớp sự cố Huy Daklak). Giảm-phí-cuối-tuần
  // là PERK phụ, KHÔNG được phép giết đường tiền → fail-SAFE về 0 (giá ngày thường, không thiệt SigMa) + LOG RÕ
  // (không nuốt câm — admin thấy để sửa). Bảng có thật (ensureAlphaExtraSchema boot) → nhánh catch chỉ là lưới an toàn.
  try {
    // [ĐỔI HỢP ĐỒNG 12/9] Hàm trả delta ĐÃ PRE-GATE theo lịch (resolveActualSellFee không tự xét lịch nữa):
    //   • cuối tuần: dòng weekend_sell_adjust (chỉ khi isWeekendHCM(at)).
    //   • KHUYẾN MẠI (Admin Demo 12/9 "MB/MBV giảm 0.02 trọn tháng 9"): dòng promo_sell_adjust có from_date ≤ at < to_date
    //     — áp MỌI NGÀY trong cửa sổ. 2 mức KHÔNG cộng dồn: lấy MAX (khuyến mại là mức trần giảm, tránh trừ kép).
    let wk = 0;
    if (isWeekendHCM(at)) {
      const rows = await db.$queryRawUnsafe<Array<{ delta_milli: number }>>(
        `SELECT delta_milli FROM weekend_sell_adjust WHERE card_type_id = $1 AND deleted_at IS NULL AND effective_from <= $2 ORDER BY effective_from DESC, id DESC LIMIT 1`,
        cardTypeId,
        at
      );
      const d = rows[0]?.delta_milli;
      wk = typeof d === 'number' && d > 0 ? d : 0;
    }
    // [Admin Demo 12/9 "chỉ cần chọn ngân hàng"] Dòng KM POS khớp khi: đúng LOẠI THẺ, HOẶC dòng theo-NGÂN-HÀNG
    // (card_type_id NULL + bank_id = bank của loại thẻ đang tính) → áp mọi loại thẻ của bank đó.
    const promo = await db.$queryRawUnsafe<Array<{ delta_milli: number; lich: string; ngay_cu_the: string | null }>>(
      `SELECT p.delta_milli, p.lich, p.ngay_cu_the FROM promo_sell_adjust p
        WHERE p.kenh = 'POS' AND p.enabled AND p.deleted_at IS NULL
          AND (p.card_type_id = $1
               OR (p.card_type_id IS NULL AND p.bank_id = (SELECT bank_id FROM card_types WHERE id = $1)))
          AND p.from_date <= $2 AND p.to_date > $2 ORDER BY p.from_date DESC, p.id DESC`,
      cardTypeId,
      at
    );
    const km = maxPromoDeltaTheoLich(promo, at);
    return Math.max(wk, km);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[weekend-sell-adjust] KHÔNG đọc được giảm-phí-cuối-tuần (dùng giá ngày thường = 0) — kiểm bảng weekend_sell_adjust:', e instanceof Error ? e.message : e);
    return 0;
  }
}

/** Tra biểu phí cho 1 GD trên (TID × Loại thẻ) tại NGÀY GIAO DỊCH `at` (P1.1). EXPORT để engine recalc (PHA 2) tái dùng. */
export async function resolveFeeForTxn(
  db: FeeResolveClient,
  tidRow: { id: number; partnerId: number | null; bankId: number | null },
  cardTypeId: number,
  feeTypeId: number,
  at: Date,
  // [Admin Demo 25/9 — GIÁ BÁN THEO ĐẠI LÝ] đại lý ĐANG CẦM máy cho GD này (mượn thì là NHÀ MƯỢN, không mượn là chủ
  // máy). Có giá riêng của nhà đó → ăn giá riêng; không có → giá chung của máy (hành vi cũ y nguyên).
  dealerCustomerId?: number | null
): Promise<{ ok: true; fee: ResolvedFee } | { ok: false; error: string; message: string }> {
  if (tidRow.partnerId == null)
    return { ok: false, error: 'NO_PARTNER', message: 'TID này chưa gán Đối tác nên không tra được biểu phí. Hãy cấu hình TID trước.' };
  const card = await db.cardType.findUnique({ where: { id: cardTypeId } });
  if (!card || card.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại thẻ không tồn tại.' };
  if (tidRow.bankId != null && card.bankId !== tidRow.bankId)
    return { ok: false, error: 'CARD_BANK_MISMATCH', message: 'Loại thẻ không thuộc ngân hàng của TID này.' };
  // FEE_MODEL — phí MUA + phí CÀI MÁY là CỐ ĐỊNH ở FeeRate (Đối tác × Loại thẻ), KHÔNG theo loại phí.
  // L3 (đối kháng 12/8): orderBy tất định — FeeRate KHÔNG có partial-unique (khác TidSellFee), nếu tồn tại dupe
  // legacy cùng effectiveFrom thì pickEffectiveRate (tie-break "first-in-array") sẽ BẤT ĐỊNH nếu không sắp thứ tự.
  // Sắp effectiveFrom desc + id desc → tie chọn id LỚN NHẤT (khớp bảng hiển thị "bản mới nhất").
  const rates = await db.feeRate.findMany({ where: { partnerId: tidRow.partnerId, cardTypeId, deletedAt: null }, orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }] });
  const rate = pickEffectiveRate(rates, at);
  if (!rate)
    return {
      ok: false,
      error: 'NO_FEE_RATE',
      message: 'Chưa có biểu phí (phí mua/cài máy) hiệu lực tại ngày giao dịch. Hãy cấu hình biểu phí có ngày hiệu lực ≤ ngày GD.'
    };
  // FEE_MODEL — LOẠI PHÍ chỉ đổi PHÍ BÁN. Phí bán THỰC TẾ = override TID nếu có, else niêm yết (FeeSellQuote).
  // P1 (nhiều KỲ override) — fetch TẤT CẢ kỳ override còn sống + TẤT CẢ kỳ niêm yết; resolveActualSellFee chọn
  // kỳ hiệu lực tại `at`. KHÔNG còn tối ưu "có override thì bỏ quotes": KỲ override tương lai không hiệu lực tại
  // `at` phải rơi về niêm yết, nên LUÔN cần quotes sẵn.
  // Đọc RAW để lấy cả cột customer_id — cột này thêm bằng schema-ensure, CỐ Ý không đưa vào Prisma client
  // (regenerate cây chung sẽ phá server 24/24 — cùng cách repo làm với los.bill_txn_date).
  const overridesRaw = await db.$queryRawUnsafe<Array<{ phi_ban: number; effective_from: string; customer_id: number | null }>>(
    `SELECT phi_ban, customer_id,
            -- BẮT BUỘC ::text + offset: driver Prisma đọc timestamptz qua $queryRaw LỆCH +7h (0h VN hoá 7h VN)
            -- ⇒ bill trước 7h sáng trượt override, báo "chưa cấu hình giá bán". Xem test gia-ban-hieu-luc-0h.test.ts.
            to_char(effective_from AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00' AS effective_from
       FROM tid_sell_fees
      WHERE tid_id = $1 AND card_type_id = $2 AND fee_type_id = $3 AND deleted_at IS NULL`,
    tidRow.id, cardTypeId, feeTypeId);
  const overrides = overridesRaw.map((r) => ({ phiBan: Number(r.phi_ban), effectiveFrom: r.effective_from, customerId: r.customer_id }));
  const quotes = await db.feeSellQuote.findMany({ where: { partnerId: tidRow.partnerId, cardTypeId, feeTypeId, deletedAt: null }, orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }] });
  // [Admin Demo 4/9] GIÁ BÁN CUỐI TUẦN (POS MB/MBV −0.02%): trừ delta tại chỗ GỐC resolveActualSellFee theo NGÀY GD `at`
  // → chạy đúng cả lúc GHI (createTransactionSystem) LẪN recalc (mỗi GD tính lại ở txnDate riêng → snapshot nhất quán).
  const weekendDeltaMilli = await resolveWeekendSellDeltaMilli(db, cardTypeId, at);
  const resolvedSellFee = resolveActualSellFee(overrides, quotes, at, { deltaMilli: weekendDeltaMilli, dealerCustomerId: dealerCustomerId ?? null });
  if (!resolvedSellFee.ok)
    return {
      ok: false,
      error: 'NO_SELL_QUOTE',
      message: 'Chưa có phí bán niêm yết hiệu lực tại ngày giao dịch cho loại phí này. Hãy cấu hình phí bán niêm yết (đúng loại phí) có ngày hiệu lực ≤ ngày GD, hoặc đặt phí bán thực tế cho TID.'
    };
  // P5 (Admin Demo 20/8, spec POS_TID_CASHFLOW dòng 124 "doanh số tính theo GIÁ THỰC BÁN, không phải niêm yết"; chốt
  // option 1 = CHẶN): doanh số CHỈ dùng phí bán THỰC TẾ (override TID). Nếu chỉ có niêm yết (source≠OVERRIDE) →
  // KHÔNG mượn niêm yết, chặn ghi GD với "chưa cấu hình giá bán". Đồng bộ với bot (fee-quote NO_ACTUAL_SELL_FEE).
  // AN TOÀN recalc: revenue-recalc gom vào failed[] + skip (không nuốt, không hỏng GD cũ đã POSTED) — GD cũ ghi
  // bằng niêm yết trước đây được grandfathered, chỉ báo failed để caller biết. Phí MUA/CÀI (rate) vẫn niêm yết.
  if (resolvedSellFee.source !== 'OVERRIDE')
    return {
      ok: false,
      error: 'NO_ACTUAL_SELL_FEE',
      message: 'TID này chưa cấu hình giá bán thực tế cho khách (chỉ có giá niêm yết) — doanh số không dùng giá niêm yết. Hãy đặt phí bán thực tế cho TID (khi giao hoặc sửa sau) rồi ghi lại.'
    };
  const phiBanActual = resolvedSellFee.phiBanMilli;
  return {
    ok: true,
    fee: {
      partnerMarginMilli: rate.phiMua - rate.phiCaiMay, // CL_NCC (giống nhau mọi loại phí)
      sellMarginMilli: phiBanActual - rate.phiCaiMay, // CL_KH = phí bán thực tế/niêm yết − phí cài máy
      phiCaiMayMilli: rate.phiCaiMay, // snapshot phí cài máy hiệu lực (×1000) → lưu vào GD cho tất toán NĐT theo TID
      bankId: tidRow.bankId,
      partnerId: tidRow.partnerId
    }
  };
}

/** PHÍ CÀI MÁY (×1000) hiệu lực tại ngày `at` cho 1 TID — SLICE của resolveFeeForTxn KHÔNG phụ thuộc phí bán.
 *  (Feature "Quét bill gửi" Admin Demo 30/8: tin cc NĐT CHỈ hiển thị phí cài máy; resolveFeeForTxn CHẶN khi TID
 *  thiếu phí bán thực tế → không dùng được cho mục đích chỉ-đọc-phí-cài.) Nguồn CANONICAL Y HỆT resolveFeeForTxn:
 *  FeeRate (Đối tác × Loại thẻ) + pickEffectiveRate — KHÔNG viết lại logic ngày-hiệu-lực. Fail-closed: thiếu cấu
 *  hình → {ok:false} (caller hiện "chưa cấu hình", KHÔNG bịa số — R: cấm suy luận money). */
export async function resolveInstallFeeMilli(
  db: FeeResolveClient,
  tidRow: { partnerId: number | null; bankId: number | null },
  cardTypeId: number,
  at: Date
): Promise<{ ok: true; phiCaiMayMilli: number } | { ok: false; error: string; message: string }> {
  if (tidRow.partnerId == null)
    return { ok: false, error: 'NO_PARTNER', message: 'TID chưa gán Đối tác nên không tra được phí cài máy.' };
  const card = await db.cardType.findUnique({ where: { id: cardTypeId } });
  if (!card || card.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại thẻ không tồn tại.' };
  if (tidRow.bankId != null && card.bankId !== tidRow.bankId)
    return { ok: false, error: 'CARD_BANK_MISMATCH', message: 'Loại thẻ không thuộc ngân hàng của TID này.' };
  const rates = await db.feeRate.findMany({ where: { partnerId: tidRow.partnerId, cardTypeId, deletedAt: null }, orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }] });
  const rate = pickEffectiveRate(rates, at);
  if (!rate) return { ok: false, error: 'NO_FEE_RATE', message: 'Chưa có biểu phí (phí cài máy) hiệu lực tại ngày GD.' };
  return { ok: true, phiCaiMayMilli: rate.phiCaiMay };
}

export interface CreateTransactionInput {
  tidId: number;
  cardTypeId: number;
  feeTypeId: number;
  amount: number;
  txnDate: string; // ISO
  customerId?: number | null; // mặc định lấy theo TID
  note?: string;
}

export async function createTransaction(ctx: ServiceCtx, input: CreateTransactionInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const txnDate = parseDate(input.txnDate);
  if (!txnDate) return { ok: false, error: 'VALIDATION', message: 'Ngày giao dịch không hợp lệ.' };
  // Adapter đã kiểm quyền → uỷ LÕI cho createTransactionSystem (CÙNG công thức phí/doanh thu, 1 nguồn duy nhất),
  // actorUserId = user thao tác thật.
  return createTransactionSystem(ctx.db, {
    tidId: input.tidId,
    cardTypeId: input.cardTypeId,
    feeTypeId: input.feeTypeId,
    amount: input.amount,
    txnDate,
    customerId: input.customerId,
    note: input.note,
    actorUserId: ctx.user.id
  });
}

export interface SystemTransactionInput {
  tidId: number;
  cardTypeId: number;
  feeTypeId: number;
  amount: number;
  txnDate: Date;
  customerId?: number | null; // mặc định lấy theo TID
  note?: string;
  actorUserId?: number | null; // null = GD tạo TỰ ĐỘNG (hệ thống, vd bridge bill→doanh số)
  // MULTI-CARD (Admin Demo 1/9): lô nhiều loại thẻ khác phí → GD TỔNG mang phí BÌNH QUÂN GIA QUYỀN (phiCaiMay) +
  // doanh thu Σ per-thẻ ĐÚNG TUYỆT ĐỐI (revenueSell/partner). Bridge tính sẵn per-thẻ rồi truyền vào → createTxn
  // KHÔNG resolve lại 1 thẻ (đó là gốc lệch của bản "thẻ đại diện"). Bỏ trống = đường 1-thẻ CŨ (resolve như cũ).
  feeOverride?: { partnerMarginMilli: number; sellMarginMilli: number; phiCaiMayMilli: number; bankId: number | null; partnerId: number | null; revenuePartner: number; revenueSell: number; revenueAmount: number };
}

/** LÕI tạo Giao dịch KHÔNG guard quyền — dùng bởi: (a) createTransaction sau khi adapter đã kiểm quyền, (b) BRIDGE
 * TỰ ĐỘNG bill→doanh số (Admin Demo 24/8: bill ghi doanh số bên SigMa → tự tạo GD để SigMa thấy). CÙNG
 * công thức phí (resolveFeeForTxn) + doanh thu (computeRevenue) — KHÔNG nhân bản. Trả NGUYÊN lỗi phí (NO_FEE_RATE/
 * NO_ACTUAL_SELL_FEE...) để caller tự-động xử best-effort (không tạo GD, KHÔNG chặn luồng bill). */
/** MULTI-CARD (Admin Demo 1/9 "đúng từng đồng, không cần cột"): 1 GD TỔNG cho lô nhiều loại thẻ khác phí. Mỗi thẻ áp
 *  ĐÚNG giá thực tế của nó (resolveFeeForTxn per-thẻ) → doanh thu bán/đối tác = Σ per-thẻ TUYỆT ĐỐI; phí cài máy GD
 *  tổng = BÌNH QUÂN GIA QUYỀN theo tiền (tiền về NĐT sát đúng, lệch tối đa ~vài đồng do FLOOR — TRONG dung sai, thay
 *  bản "thẻ đại diện" lệch tới ~5k). Thiếu phí 1 loại thẻ → CHẶN fail-closed (không bịa). Đường 1-thẻ vẫn dùng
 *  createTransactionSystem thường. */
export async function createTransactionSystemMultiCard(
  db: Db,
  input: { tidId: number; feeTypeId: number; txnDate: Date; actorUserId?: number | null; note?: string; customerId?: number | null; lines: { cardTypeId: number; amountBeforeFee: number }[] }
): Promise<MutationResult> {
  const lines = input.lines.filter((l) => l.cardTypeId && l.amountBeforeFee > 0);
  if (lines.length === 0) return { ok: false, error: 'VALIDATION', message: 'Lô không có dòng thẻ hợp lệ để tạo GD.' };
  const total = lines.reduce((s, l) => s + l.amountBeforeFee, 0);
  const tid = await db.tid.findUnique({ where: { id: input.tidId } });
  if (!tid || tid.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'TID không tồn tại.' };
  let wPhi = 0, wPart = 0, wSell = 0, sumRP = 0, sumRS = 0;
  let sumTienVe = 0n; // Σ TIỀN VỀ per-thẻ ĐÚNG (FLOOR như tienVeForTxn) → phí cài tuyệt đối = total − Σ (100% đúng đồng).
  let repBankId: number | null = null, repPartnerId: number | null = null;
  // [Admin Demo 25/9] ĐẠI LÝ ĐANG CẦM máy cho GD này = customerId caller truyền (bridge lô MƯỢN truyền NHÀ MƯỢN),
  // không truyền thì là chủ máy. Dùng để chọn GIÁ BÁN RIÊNG của nhà đó nếu có.
  const dealerGd = input.customerId === undefined ? tid.customerId : input.customerId;
  for (const l of lines) {
    const f = await resolveFeeForTxn(db, tid, l.cardTypeId, input.feeTypeId, input.txnDate, dealerGd);
    if (!f.ok) return f; // thiếu giá 1 loại thẻ → CHẶN (fail-closed, đúng bất biến "cấm bịa phí")
    const rv = computeRevenue(l.amountBeforeFee, f.fee.partnerMarginMilli, f.fee.sellMarginMilli);
    const pcm = f.fee.phiCaiMayMilli <= 0 ? 0 : (f.fee.phiCaiMayMilli >= 100000 ? 100000 : f.fee.phiCaiMayMilli);
    sumTienVe += (BigInt(l.amountBeforeFee) * BigInt(100000 - pcm)) / 100000n; // FLOOR KHỚP tienVeForTxn (investor-report)
    wPhi += l.amountBeforeFee * f.fee.phiCaiMayMilli;
    wPart += l.amountBeforeFee * f.fee.partnerMarginMilli;
    wSell += l.amountBeforeFee * f.fee.sellMarginMilli;
    sumRP += rv.revenuePartner; sumRS += rv.revenueSell;
    if (repBankId === null) repBankId = f.fee.bankId;
    if (repPartnerId === null) repPartnerId = f.fee.partnerId;
  }
  const r = await createTransactionSystem(db, {
    tidId: input.tidId, cardTypeId: lines[0].cardTypeId, feeTypeId: input.feeTypeId, amount: total,
    txnDate: input.txnDate, actorUserId: input.actorUserId ?? null, note: input.note, customerId: input.customerId,
    feeOverride: {
      phiCaiMayMilli: Math.round(wPhi / total), partnerMarginMilli: Math.round(wPart / total), sellMarginMilli: Math.round(wSell / total),
      bankId: repBankId, partnerId: repPartnerId, revenuePartner: sumRP, revenueSell: sumRS, revenueAmount: sumRP + sumRS
    }
  });
  // 100% ĐÚNG TỪNG ĐỒNG (Admin Demo 1/9): ghi phí cài máy TUYỆT ĐỐI = total − Σ tiền về per-thẻ vào cột install_fee_amount
  // (thêm ngoài prisma schema → dùng raw UPDATE). investor-report/settlement đọc cột này khi >0 → tiền về = amount − cột
  // = Σ tiền về per-thẻ CHÍNH XÁC (không còn lệch ~vài đồng của rate bình quân). Cột=0 (1-thẻ/legacy) → dùng rate cũ.
  if (r.ok && r.id != null) {
    const installFeeAmount = BigInt(total) - sumTienVe; // = Σ phí cài per-thẻ ĐÚNG
    // Cột install_fee_amount thêm NGOÀI prisma schema (raw ALTER) → có thể VẮNG ở DB chưa migrate (throwaway test).
    // Fail-MỀM: vắng cột → read tự fallback rate bình quân (vẫn trong dung sai). KHÔNG nuốt câm (R198): log rõ.
    try {
      await db.$executeRawUnsafe('UPDATE transactions SET install_fee_amount = $1 WHERE id = $2', installFeeAmount, r.id);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[multicard] GD ${r.id}: ghi install_fee_amount thất bại (cột chưa có? → tiền về dùng rate bình quân, lệch ~vài đồng):`, e instanceof Error ? e.message : e);
    }
  }
  return r;
}

export async function createTransactionSystem(db: Db, input: SystemTransactionInput): Promise<MutationResult> {
  const amount = parseAmount(input.amount);
  if (amount === null) return { ok: false, error: 'VALIDATION', message: 'Số tiền không hợp lệ (số nguyên ≥ 0).' };
  if (!input.cardTypeId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn loại thẻ.' };
  if (!input.feeTypeId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn loại phí.' };

  const tid = await db.tid.findUnique({ where: { id: input.tidId } });
  if (!tid || tid.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'TID không tồn tại.' };
  const feeType = await db.feeType.findUnique({ where: { id: input.feeTypeId } });
  if (!feeType || feeType.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại phí không tồn tại.' };

  // MULTI-CARD: dùng phí+doanh thu bridge tính sẵn (bình quân gia quyền + Σ per-thẻ ĐÚNG); else resolve 1 thẻ như cũ.
  // [Admin Demo 25/9] tính ĐẠI LÝ trước khi tra phí — giá bán có thể RIÊNG theo đại lý đang cầm máy (mượn TID).
  const dealerGd = input.customerId === undefined ? tid.customerId : input.customerId;
  const fee = input.feeOverride
    ? ({ ok: true as const, fee: input.feeOverride })
    : await resolveFeeForTxn(db, tid, input.cardTypeId, input.feeTypeId, input.txnDate, dealerGd);
  if (!fee.ok) return fee;

  const rev = input.feeOverride
    ? { revenuePartner: input.feeOverride.revenuePartner, revenueSell: input.feeOverride.revenueSell, revenueAmount: input.feeOverride.revenueAmount }
    : computeRevenue(amount, fee.fee.partnerMarginMilli, fee.fee.sellMarginMilli);
  const customerId = dealerGd;

  // R2/R48 — khách "Đã khóa"/"Đã hủy"/đã xóa mềm → CHẶN giao dịch mới (vẫn xem được lịch sử).
  if (customerId != null) {
    const cust = await db.customer.findUnique({ where: { id: customerId }, select: { status: true, deletedAt: true } });
    if (!cust || cust.deletedAt != null) {
      return { ok: false, error: 'CUSTOMER_INACTIVE', message: 'Khách hàng không tồn tại hoặc đã bị hủy khỏi hệ thống — không thể tạo giao dịch mới.' };
    }
    if (cust.status === 'LOCKED' || cust.status === 'CANCELLED') {
      return { ok: false, error: 'CUSTOMER_INACTIVE', message: `Khách hàng đang ở trạng thái "${cust.status === 'LOCKED' ? 'Đã khóa' : 'Đã hủy'}" — không thể tạo giao dịch mới.` };
    }
  }

  // R48 Pha 3 — create + gán mã + audit ATOMIC trong 1 transaction. Mã = GD + id (id unique → mã unique).
  const created = await db.$transaction(async (tx) => {
    const c = await tx.transaction.create({
      data: {
        tidId: tid.id,
        customerId: customerId ?? null,
        cardTypeId: input.cardTypeId,
        feeTypeId: input.feeTypeId,
        amount,
        partnerMarginMilli: fee.fee.partnerMarginMilli,
        sellMarginMilli: fee.fee.sellMarginMilli,
        phiCaiMayMilli: fee.fee.phiCaiMayMilli, // PHÍ CÀI MÁY chốt tại ngày GD → tất toán NĐT theo TID (Admin Demo 11/8)
        revenuePartner: rev.revenuePartner,
        revenueSell: rev.revenueSell,
        revenueAmount: rev.revenueAmount,
        txnDate: input.txnDate,
        note: input.note?.trim() || null,
        createdBy: input.actorUserId ?? null
      }
    });
    const code = 'GD' + String(c.id).padStart(5, '0');
    await tx.transaction.update({ where: { id: c.id }, data: { code } });
    // [GÓI TZ 11/9 — Admin Demo duyệt] Adapter Prisma serialize Date GHI timestamptz lệch −7h (bằng chứng prod 10/9:
    // txn_date = giờ bill − 7h). Ép lại NGAY trong cùng $transaction bằng raw ISO → txn_date trong DB luôn là
    // INSTANT THẬT. Mọi chỗ đọc/bound txn_date đã chuyển raw-ISO cùng gói (dashboard/ranking/list/recalc/report).
    await tx.$executeRawUnsafe(`UPDATE transactions SET txn_date = $1::timestamptz WHERE id = $2`, input.txnDate.toISOString(), c.id);
    // G1: audit NGHIÊM trong tx (tier-1 tiền) → audit fail thì rollback cả giao dịch. actorUserId null = GD tự động.
    await writeAuditStrict(tx, {
      actorUserId: input.actorUserId ?? null,
      action: 'TRANSACTION_CREATED',
      targetType: 'Transaction',
      targetId: String(c.id),
      after: auditSnapshot({ code, tidId: tid.id, cardTypeId: input.cardTypeId, feeTypeId: input.feeTypeId, amount, revenueAmount: rev.revenueAmount })
    });
    return c;
  });
  await bumpChangeToken(db, 'Transaction');
  return { ok: true, id: created.id };
}

// ═════════════════════════════════════════════════════════════════════════════
// GD DOANH SỐ QR BÁN HÀNG (Đợt 2, Admin Demo 5/9 DUYỆT) — QR KHÔNG có loại thẻ / loại phí / phí cài máy.
//   • phiCaiMayMilli = 0 → NĐT (receiveAccountId) tiền về = TRỌN amount (tienVeForTxn(amount,0)=amount).
//   • partnerMarginMilli = phiMuaMilli (giá MUA đối tác, weekend đã đổi ở resolveQrFeeForTid trước khi truyền vào).
//   • sellMarginMilli = phiBanMilli − phiMuaMilli (biên bán QR = SPREAD, KHÔNG phải phiBan — KHÁC POS!).
//   • revenuePartner = amount×phiMua/100000 ; revenueSell = amount×(phiBan−phiMua)/100000 (computeRevenue 2 margin trên).
// KHÔNG reuse createTransactionSystem (nó ép cardTypeId+feeTypeId ở dòng 420-421). cardTypeId/feeTypeId để NULL
// (schema nullable) — investor-report/settlement đọc theo tid_id + phi_cai_may_milli, KHÔNG đọc cardTypeId (đã trace).
// ═════════════════════════════════════════════════════════════════════════════
export interface QrTransactionInput {
  tidId: number;
  amount: number;
  phiMuaMilli: number; // giá MUA (đối tác) ×1000 — ĐÃ resolve tại NGÀY BILL (weekend) qua resolveQrFeeForTid ở caller.
  phiBanMilli: number; // giá BÁN ×1000 — như trên.
  txnDate: Date;
  receiveAccountId?: number | null; // nhãn/audit (NĐT thực resolve qua tid.receiveAccountId; snapshot để đối chiếu).
  dealerRoomId?: string | null; // ĐẠI LÝ chọn từ dropdown lúc gửi → link QR→đại lý cho báo cáo tổng gộp (qr_dealer_room_id).
  ref?: string | null; // Số giao dịch (ref) bill QR OCR → lưu transactions.qr_ref → poll ghép EXACT external_ref_no báo-có.
  payerName?: string | null; // tên người quẹt đọc trên bill QR → lưu transactions.qr_payer_name (nhãn báo cáo/đối soát).
  actorUserId?: number | null;
  note?: string;
}
export async function createQrTransactionSystem(db: Db, input: QrTransactionInput): Promise<MutationResult> {
  const amount = parseAmount(input.amount);
  if (amount === null) return { ok: false, error: 'VALIDATION', message: 'Số tiền QR không hợp lệ (số nguyên ≥ 0).' };
  if (!Number.isFinite(input.phiMuaMilli) || !Number.isFinite(input.phiBanMilli) || input.phiMuaMilli < 0 || input.phiBanMilli < 0)
    return { ok: false, error: 'QR_FEE_INVALID', message: 'Phí QR (mua/bán) không hợp lệ.' };
  // Biên bán QR = phiBan − phiMua. Âm = phiBan < phiMua (cấu hình sai / nhập ngược) → fail-closed (cấm ghi biên âm).
  const sellMargin = input.phiBanMilli - input.phiMuaMilli;
  if (sellMargin < 0)
    return { ok: false, error: 'QR_FEE_INVALID', message: `Phí bán QR (${input.phiBanMilli}) nhỏ hơn phí mua (${input.phiMuaMilli}) — spread âm, cấu hình sai, không ghi doanh số.` };
  if (!input.txnDate || isNaN(input.txnDate.getTime())) return { ok: false, error: 'VALIDATION', message: 'Ngày giao dịch QR không hợp lệ.' };
  const tid = await db.tid.findUnique({ where: { id: input.tidId } });
  if (!tid || tid.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'TID (mã QR) không tồn tại.' };
  // revenuePartner = amount×phiMua/100000 ; revenueSell = amount×(phiBan−phiMua)/100000 (Admin Demo ví dụ 10tr: 85k + 20k).
  const rev = computeRevenue(amount, input.phiMuaMilli, sellMargin);
  const created = await db.$transaction(async (tx) => {
    const c = await tx.transaction.create({
      data: {
        tidId: tid.id,
        customerId: tid.customerId ?? null, // QR tid không gán customer (invariant I3) → null; NĐT resolve qua receiveAccountId
        cardTypeId: null, // QR: không loại thẻ
        feeTypeId: null,  // QR: không loại phí (dùng qr_fee_rates/qr_partner_fee)
        amount,
        partnerMarginMilli: input.phiMuaMilli,
        sellMarginMilli: sellMargin,
        phiCaiMayMilli: 0, // QR KHÔNG có phí cài máy → NĐT tiền về = trọn amount
        revenuePartner: rev.revenuePartner,
        revenueSell: rev.revenueSell,
        revenueAmount: rev.revenueAmount,
        txnDate: input.txnDate,
        note: input.note?.trim() || null,
        createdBy: input.actorUserId ?? null
      }
    });
    const code = 'GD' + String(c.id).padStart(5, '0');
    await tx.transaction.update({ where: { id: c.id }, data: { code } });
    // [GÓI TZ 11/9] Ép txn_date raw ISO như nhánh POS — adapter Prisma ghi lệch −7h.
    await tx.$executeRawUnsafe(`UPDATE transactions SET txn_date = $1::timestamptz WHERE id = $2`, input.txnDate.toISOString(), c.id);
    await writeAuditStrict(tx, {
      actorUserId: input.actorUserId ?? null,
      action: 'TRANSACTION_CREATED',
      targetType: 'Transaction',
      targetId: String(c.id),
      after: auditSnapshot({ code, kind: 'QR', tidId: tid.id, amount, phiMuaMilli: input.phiMuaMilli, phiBanMilli: input.phiBanMilli, revenuePartner: rev.revenuePartner, revenueSell: rev.revenueSell, revenueAmount: rev.revenueAmount, receiveAccountId: input.receiveAccountId ?? tid.receiveAccountId ?? null })
    });
    return c;
  });
  // Attribution đại lý QR (raw — cột qr_dealer_room_id ngoài Prisma client). BEST-EFFORT (R198): cột chưa migrate →
  // log rõ, KHÔNG chặn (doanh số vẫn ghi; báo cáo tổng gộp per-đại-lý-QR sẽ thiếu dòng này → admin thấy log để ensure).
  if (input.dealerRoomId) {
    try {
      await db.$executeRawUnsafe('UPDATE transactions SET qr_dealer_room_id = $1 WHERE id = $2', input.dealerRoomId, created.id);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[qr-txn] GD ${created.id}: ghi qr_dealer_room_id thất bại (cột chưa có? → báo cáo đại lý-QR thiếu dòng này):`, e instanceof Error ? e.message : e);
    }
  }
  // GHÉP ĐỐI SOÁT BÁO-CÓ + BÁO CÁO (Admin Demo 5/9) — lưu Số giao dịch (ref) + tên người quẹt vào cột RAW (ngoài Prisma
  // client, như qr_dealer_room_id). BEST-EFFORT (R198): cột chưa migrate → log RÕ, KHÔNG chặn (doanh số vẫn ghi; chỉ
  // mất ghép EXACT ở poll cho GD này → poll fallback HKD+tiền+giờ). Chuẩn-hoá ref: trim (rỗng → NULL, không lưu '').
  const qrRef = input.ref != null && String(input.ref).trim() ? String(input.ref).trim() : null;
  const qrPayer = input.payerName != null && String(input.payerName).trim() ? String(input.payerName).trim() : null;
  if (qrRef != null || qrPayer != null) {
    try {
      await db.$executeRawUnsafe('UPDATE transactions SET qr_ref = $1, qr_payer_name = $2 WHERE id = $3', qrRef, qrPayer, created.id);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[qr-txn] GD ${created.id}: ghi qr_ref/qr_payer_name thất bại (cột chưa có? → poll mất ghép EXACT, dùng HKD+tiền+giờ):`, e instanceof Error ? e.message : e);
    }
  }
  await bumpChangeToken(db, 'Transaction');
  return { ok: true, id: created.id };
}

export interface UpdateTransactionInput {
  cardTypeId?: number;
  amount?: number;
  txnDate?: string;
  customerId?: number | null;
  note?: string;
}

/** P1.2 — BILL BẤT BIẾN (STUB port nguyên): bill KHÔNG sửa được. Sai thì tạo yêu cầu hủy → duyệt → tạo bill mới.
 *  Giữ permission-guard: thao tác trái phép vẫn FORBIDDEN. KHÔNG wire IPC/route (desktop cũng không expose). */
export async function updateTransaction(ctx: ServiceCtx, _id: number, _input: UpdateTransactionInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  return { ok: false, error: 'BILL_IMMUTABLE', message: 'Bill bất biến — không sửa được. Hãy tạo yêu cầu hủy rồi tạo bill mới.' };
}

/**
 * REVENUE_MANAGE — xóa mềm 1..n GD → thùng rác. XÁC NHẬN MẬT KHẨU (§14) do ADAPTER kiểm TRƯỚC khi gọi (khuôn
 * customer.ts: lõi KHÔNG kiểm password — không truy cập session/hash). Route verifyActorPassword rồi mới gọi.
 */
export async function deleteTransactions(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn giao dịch để xóa.' };
  let deleted = 0;
  for (const id of ids) {
    const row = await db.transaction.findUnique({ where: { id } });
    if (!row || row.deletedAt) continue;
    // [B-M5 21/9] GUARD: GD đã có PHIẾU THU CÔNG NỢ (cashDebtSettlement) mà xoá mềm thì phiếu thành mồ côi —
    // tiền ĐÃ THU trên sổ trỏ vào GD biến mất → công nợ khách lệch câm. Chặn, chỉ đường gỡ phiếu trước.
    const soPhieu = await db.cashDebtSettlement.count({ where: { transactionId: id } });
    if (soPhieu > 0) {
      return { ok: false, error: 'TXN_HAS_SETTLEMENT', deleted, message: `GD ${row.code ?? id} đã có ${soPhieu} dòng thu công nợ gắn vào — xoá GD sẽ làm sổ thu mồ côi. Gỡ/huỷ phiếu thu của GD này trước rồi mới xoá.` };
    }
    // [B322/F3 24/11 — agent phản biện] Xoá mềm GD PHẢI kèm status='CANCELLED' để giữ bất biến
    // "deleted_at IS NOT NULL ⇒ CANCELLED" — trước đây để nguyên status (thường POSTED) ⇒ sinh GD
    // "POSTED mà deleted", báo cáo nào lọc theo mỗi status là cộng nhầm (sổ thật tồn 27 GD = 1,35 tỷ).
    await db.transaction.update({ where: { id }, data: { deletedAt: new Date(), status: 'CANCELLED', cancelledAt: new Date(), cancelReason: row.cancelReason ?? 'Xoá giao dịch (màn Doanh Thu)', updatedBy: user.id, deletedBy: user.id } });
    await writeAudit(db, { actorUserId: user.id, action: 'TRANSACTION_DELETED', targetType: 'Transaction', targetId: String(id), before: auditSnapshot({ code: row.code, amount: row.amount, revenueAmount: row.revenueAmount }) });
    deleted++;
  }
  // [B-M5 21/9] bump change-token như create/update/cancel (530/625/1154) — thiếu thì client cache giữ GD đã xoá.
  if (deleted > 0) await bumpChangeToken(db, 'Transaction');
  return { ok: true, deleted };
}

/**
 * H5 — VÔ HIỆU HÓA toggle `settled` thủ công (STUB port nguyên). `settled` chỉ còn đổi qua phiếu Thu công nợ.
 * Giữ chữ ký để không vỡ import cũ; IPC handler `transaction:settle` đã GỠ (KHÔNG expose route).
 */
export async function settleTransactions(_ctx: ServiceCtx, _ids: number[], _settled: boolean): Promise<MutationResult & { changed?: number }> {
  return {
    ok: false,
    error: 'DEBT_SETTLE_DISABLED',
    message: 'Đối soát công nợ nay thực hiện qua phiếu Thu công nợ (chọn số tiền thu từng khoản). Không đánh dấu đã thu thủ công.'
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Lọc + đọc
// ═════════════════════════════════════════════════════════════════════════════
/** Dựng where-clause Prisma cho transaction từ filter (đã resolve tidIds nếu cần). */
async function buildWhere(db: Db, filter: TransactionFilter): Promise<Record<string, unknown> | null> {
  const where: Record<string, unknown> = { deletedAt: null };
  // Lọc theo thuộc tính của TID (mid/hkd/partner/bank) → resolve ra danh sách tidId. KHÔNG lọc deletedAt của TID:
  // GD tham chiếu TID theo id; TID xóa mềm sau này vẫn phải tổng hợp ĐÚNG (tránh lệch tổng toàn cục).
  const tidWhere: Record<string, unknown> = {};
  let hasTidFilter = false;
  if (filter.tidId) { tidWhere.id = filter.tidId; hasTidFilter = true; }
  // Lọc mid / tên HKD — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts). Mỗi bộ lọc là 1 mệnh
  // đề riêng trong `AND` (KHÔNG ghi đè `tidWhere.id` mà filter.tidId có thể đã dùng).
  const tidAnd: Array<Record<string, unknown>> = [];
  if (filter.mid?.trim()) { tidAnd.push(...((await dieuKienTimKiem(db, 'tids', { mid: 'mid' }, filter.mid)) ?? [])); hasTidFilter = true; }
  if (filter.hkdName?.trim()) { tidAnd.push(...((await dieuKienTimKiem(db, 'tids', { hkdName: 'hkd_name' }, filter.hkdName)) ?? [])); hasTidFilter = true; }
  if (tidAnd.length > 0) tidWhere.AND = tidAnd;
  if (filter.partnerId) { tidWhere.partnerId = filter.partnerId; hasTidFilter = true; }
  if (filter.bankId) { tidWhere.bankId = filter.bankId; hasTidFilter = true; }
  if (hasTidFilter) {
    const tids = await db.tid.findMany({ where: tidWhere, select: { id: true } });
    if (tids.length === 0) return null; // không TID nào khớp → không giao dịch nào
    where.tidId = { in: tids.map((t) => t.id) };
  }
  if (filter.customerId) where.customerId = filter.customerId;
  // Lọc MÃ giao dịch — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts). Đặt vào `AND` để
  // không đụng `where.id` mà bộ lọc theo NGÀY ở dưới sẽ gán.
  if (filter.code?.trim()) {
    const dkMa = await dieuKienTimKiem(db, 'transactions', { code: 'code' }, filter.code);
    if (dkMa) where.AND = [...((where.AND as Array<Record<string, unknown>> | undefined) ?? []), ...dkMa];
  }
  if (filter.cardTypeId) where.cardTypeId = filter.cardTypeId;
  if (filter.feeTypeId) where.feeTypeId = filter.feeTypeId;
  if (filter.settled !== undefined) where.settled = filter.settled;
  const from = parseDate(filter.dateFrom);
  const to = parseDate(filter.dateTo);
  if (from || to) {
    // [GÓI TZ 11/9] bound raw-ISO qua prefilter id (Prisma bound Date lệch −7h trên txn_date instant-thật).
    where.id = { in: await idsTheoTxnDate(db, { gte: from ?? undefined, lte: to ?? undefined }) };
  }
  return where;
}

/** [GÓI TZ 11/9] txn_date trong DB nay là INSTANT THẬT (ghi raw-ISO) → Prisma bound Date (serialize −7h) và
 *  ORM-read (+7h) đều KHÔNG dùng được cho cột này nữa. 2 helper raw: lọc id theo cửa sổ + map id→ISO thật. */
export async function idsTheoTxnDate(db: Db, r: { gte?: Date; lt?: Date; lte?: Date }, scope?: { tidIds?: number[] }): Promise<number[]> {
  const conds: string[] = []; const params: unknown[] = [];
  if (r.gte) { params.push(r.gte.toISOString()); conds.push(`txn_date >= $${params.length}::timestamptz`); }
  if (r.lt) { params.push(r.lt.toISOString()); conds.push(`txn_date < $${params.length}::timestamptz`); }
  if (r.lte) { params.push(r.lte.toISOString()); conds.push(`txn_date <= $${params.length}::timestamptz`); }
  // [B333/FINDING-1 24/11 — agent nhồi] LỌC tid_id NGAY TRONG SQL bằng `= ANY($n::int[])` (MỘT param
  // mảng, KHÔNG phải IN(32k param)) — để recalc đổi-phí không kéo MỌI GD cả sổ từ mốc rồi nhồi vào
  // `findMany({ id: { in: [32k+] } })` → `RangeError: Maximum call stack` ở ~32.767 (bom hẹn giờ khi sổ
  // thật tích đủ GD). Có scope.tidIds thì tập id trả về chỉ của các TID đó (nhỏ).
  if (scope?.tidIds) { params.push(scope.tidIds); conds.push(`tid_id = ANY($${params.length}::int[])`); }
  if (conds.length === 0) return [];
  const rows = await db.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM transactions WHERE ${conds.join(' AND ')}`, ...params);
  return rows.map((x) => x.id);
}
export async function txnIsoMap(db: Db, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRawUnsafe<{ id: number; iso: string }[]>(
    `SELECT id, to_char(txn_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS iso FROM transactions WHERE id = ANY($1::int[])`, ids);
  return new Map(rows.map((x) => [x.id, x.iso]));
}

export interface ListTransactionsResult {
  ok: boolean;
  error?: string;
  message?: string;
  data?: TransactionDto[];
  total?: number;
  page?: number;
  pageSize?: number;
  summary?: RevenueSummary;
}

export async function listTransactions(ctx: ServiceCtx, filter: TransactionFilter = {}): Promise<ListTransactionsResult> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const where = await buildWhere(db, filter);
  if (where === null) {
    return { ok: true, data: [], total: 0, page: 1, pageSize: filter.pageSize ?? 50, summary: emptySummary() };
  }

  const total = await db.transaction.count({ where });
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, filter.pageSize ?? 50));

  // Summary trên TOÀN BỘ dòng khớp (aggregate ở DB). P1.2: LOẠI bill đã HỦY (status CANCELLED) khỏi tổng.
  const revenueWhere = { ...where, status: { not: 'CANCELLED' } };
  const agg = await db.transaction.aggregate({
    where: revenueWhere,
    _sum: { amount: true, revenuePartner: true, revenueSell: true, revenueAmount: true },
    _count: true
  });
  const summary: RevenueSummary = {
    count: agg._count,
    totalAmount: Number(agg._sum.amount ?? 0),
    totalRevenuePartner: Number(agg._sum.revenuePartner ?? 0),
    totalRevenueSell: Number(agg._sum.revenueSell ?? 0),
    totalRevenue: Number(agg._sum.revenueAmount ?? 0)
  };

  const rows = await db.transaction.findMany({
    where,
    orderBy: [{ txnDate: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * pageSize,
    take: pageSize
  });

  const tidIds = [...new Set(rows.map((r) => r.tidId))];
  const tidMap = new Map(
    (await db.tid.findMany({ where: { id: { in: tidIds } }, select: { id: true, tid: true, mid: true, hkdName: true, bankId: true, partnerId: true } })).map((t) => [t.id, t])
  );
  const bankIds = [...new Set([...tidMap.values()].map((t) => t.bankId).filter((x): x is number => x != null))];
  const partnerIds = [...new Set([...tidMap.values()].map((t) => t.partnerId).filter((x): x is number => x != null))];
  const custIds = [...new Set(rows.map((r) => r.customerId).filter((x): x is number => x != null))];
  const cardIds = [...new Set(rows.map((r) => r.cardTypeId).filter((x): x is number => x != null))];
  const feeTypeIds = [...new Set(rows.map((r) => r.feeTypeId).filter((x): x is number => x != null))];
  const bankMap = new Map((await db.bank.findMany({ where: { id: { in: bankIds } }, select: { id: true, code: true, name: true } })).map((b) => [b.id, nhanBank(b) ?? '']));
  const partnerMap = new Map((await db.partner.findMany({ where: { id: { in: partnerIds } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  const custMap = new Map((await db.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, fullName: true } })).map((c) => [c.id, c.fullName]));
  const cardMap = new Map((await db.cardType.findMany({ where: { id: { in: cardIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const feeTypeMap = new Map((await db.feeType.findMany({ where: { id: { in: feeTypeIds } }, select: { id: true, name: true } })).map((f) => [f.id, f.name]));
  const isoMap = await txnIsoMap(db, rows.map((r) => r.id)); // [GÓI TZ 11/9] ISO thật cho display (ORM-read +7h)
  const names = await resolveUserNames(db, rows.map((r) => r.createdBy));

  const data: TransactionDto[] = rows.map((r) => {
    const t = tidMap.get(r.tidId);
    return {
      id: r.id,
      code: r.code,
      tidId: r.tidId,
      tid: t?.tid ?? null,
      mid: t?.mid ?? null,
      hkdName: t?.hkdName ?? null,
      bankId: t?.bankId ?? null,
      bankName: t?.bankId != null ? bankMap.get(t.bankId) ?? null : null,
      partnerId: t?.partnerId ?? null,
      partnerName: t?.partnerId != null ? partnerMap.get(t.partnerId) ?? null : null,
      customerId: r.customerId,
      customerName: r.customerId != null ? custMap.get(r.customerId) ?? null : null,
      cardTypeId: r.cardTypeId,
      cardTypeName: r.cardTypeId != null ? cardMap.get(r.cardTypeId) ?? null : null,
      feeTypeId: r.feeTypeId,
      feeTypeName: r.feeTypeId != null ? feeTypeMap.get(r.feeTypeId) ?? null : null,
      amount: Number(r.amount),
      partnerMarginPct: milliToPct(r.partnerMarginMilli),
      sellMarginPct: milliToPct(r.sellMarginMilli),
      revenuePartner: Number(r.revenuePartner),
      revenueSell: Number(r.revenueSell),
      revenueAmount: Number(r.revenueAmount),
      settled: r.settled,
      settledAt: r.settledAt ? r.settledAt.toISOString() : null,
      status: r.status,
      txnDate: isoMap.get(r.id) ?? r.txnDate.toISOString(), // fallback ORM khi map thiếu (fake-db test)
      note: r.note,
      createdBy: r.createdBy,
      createdByName: r.createdBy != null ? names.get(r.createdBy) ?? null : null,
      createdAt: r.createdAt.toISOString()
    };
  });
  return { ok: true, data, total, page, pageSize, summary };
}

function emptySummary(): RevenueSummary {
  return { count: 0, totalAmount: 0, totalRevenuePartner: 0, totalRevenueSell: 0, totalRevenue: 0 };
}

// ═════════════════════════════════════════════════════════════════════════════
// FEE_TYPE — BÁO CÁO DOANH THU TÁCH THEO LOẠI PHÍ
// ═════════════════════════════════════════════════════════════════════════════
export interface RevenueByFeeTypeRow {
  feeTypeId: number | null;
  feeTypeName: string | null;
  count: number;
  totalAmount: number;
  totalRevenuePartner: number;
  totalRevenueSell: number;
  totalRevenue: number;
}
export interface RevenueByFeeTypeResult {
  ok: boolean;
  error?: string;
  message?: string;
  data?: RevenueByFeeTypeRow[];
}

/** REVENUE_VIEW — doanh thu NHÓM theo LOẠI PHÍ trong phạm vi lọc (dùng CHUNG buildWhere). LOẠI bill CANCELLED. */
export async function revenueByFeeType(ctx: ServiceCtx, filter: TransactionFilter = {}): Promise<RevenueByFeeTypeResult> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const where = await buildWhere(db, filter);
  if (where === null) return { ok: true, data: [] };
  const revenueWhere = { ...where, status: { not: 'CANCELLED' } };
  const groups = await db.transaction.groupBy({
    by: ['feeTypeId'],
    where: revenueWhere,
    _sum: { amount: true, revenuePartner: true, revenueSell: true, revenueAmount: true },
    _count: true
  });
  const ftIds = groups.map((gr) => gr.feeTypeId).filter((x): x is number => x != null);
  const ftMap = new Map((await db.feeType.findMany({ where: { id: { in: ftIds } }, select: { id: true, name: true } })).map((f) => [f.id, f.name]));
  const data: RevenueByFeeTypeRow[] = groups.map((gr) => ({
    feeTypeId: gr.feeTypeId,
    feeTypeName: gr.feeTypeId != null ? ftMap.get(gr.feeTypeId) ?? null : '(Chưa gán loại phí)',
    count: gr._count,
    totalAmount: Number(gr._sum.amount ?? 0),
    totalRevenuePartner: Number(gr._sum.revenuePartner ?? 0),
    totalRevenueSell: Number(gr._sum.revenueSell ?? 0),
    totalRevenue: Number(gr._sum.revenueAmount ?? 0)
  }));
  data.sort((a, b) => {
    if (a.feeTypeId == null) return 1;
    if (b.feeTypeId == null) return -1;
    return b.totalRevenue - a.totalRevenue;
  });
  return { ok: true, data };
}

/** H4 — Σ số tiền ĐÃ tất toán theo (transactionId, side) từ CashDebtSettlement (net-of-settlement). 1 group-by. */
async function settledByTxnSide(db: Db, txnIds: number[]): Promise<Map<string, number>> {
  const paid = new Map<string, number>();
  if (txnIds.length === 0) return paid;
  const rows = await db.cashDebtSettlement.groupBy({
    by: ['transactionId', 'side'],
    where: { transactionId: { in: txnIds } },
    _sum: { amount: true }
  });
  for (const r of rows) paid.set(`${r.transactionId}:${r.side}`, Number(r._sum.amount ?? 0));
  return paid;
}

/** Công nợ thu về = tổng công nợ CÒN LẠI (NET-OF-SETTLEMENT, H4/I#2) trong phạm vi lọc. */
export async function debtSummary(ctx: ServiceCtx, filter: TransactionFilter = {}): Promise<{ ok: boolean; error?: string; message?: string; data?: DebtSummary }> {
  if (!hasPermission(ctx.user, DEBT_VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const where = await buildWhere(db, filter); // KHÔNG ép settled — tính theo net
  if (where === null) return { ok: true, data: { count: 0, debtPartner: 0, debtSell: 0, debtTotal: 0 } };
  where.status = { not: 'CANCELLED' }; // P1.2: bill đã hủy không còn là công nợ
  where.writtenOffAt = null; // H2b: GD đã ghi giảm nợ xấu rớt khỏi công nợ
  const txns = await db.transaction.findMany({ where, select: { id: true, revenuePartner: true, revenueSell: true } });
  const paid = await settledByTxnSide(db, txns.map((t) => t.id));
  let debtPartner = 0, debtSell = 0, count = 0;
  for (const t of txns) {
    const rp = Math.max(0, Number(t.revenuePartner) - (paid.get(`${t.id}:PARTNER`) ?? 0));
    const rs = Math.max(0, Number(t.revenueSell) - (paid.get(`${t.id}:SELL`) ?? 0));
    if (rp > 0 || rs > 0) { count++; debtPartner += rp; debtSell += rs; }
  }
  return { ok: true, data: { count, debtPartner, debtSell, debtTotal: debtPartner + debtSell } };
}

/** DEBT_VIEW — danh sách GD CÒN NỢ net (per-side remaining) trong phạm vi lọc — nguồn cho DebtPage + Thu công nợ. */
export async function debtOpenTransactions(ctx: ServiceCtx, filter: TransactionFilter = {}): Promise<DebtOpenResult> {
  if (!hasPermission(ctx.user, DEBT_VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const where = await buildWhere(db, filter);
  if (where === null) return { ok: true, data: [] };
  where.status = { not: 'CANCELLED' };
  where.writtenOffAt = null; // H2b: GD đã ghi giảm nợ xấu rớt khỏi công nợ
  const rows = await db.transaction.findMany({ where, orderBy: [{ txnDate: 'asc' }, { id: 'asc' }] });
  const paid = await settledByTxnSide(db, rows.map((r) => r.id));
  const isoMapNo = await txnIsoMap(db, rows.map((r) => r.id)); // [GÓI TZ 11/9]

  const tidIds = [...new Set(rows.map((r) => r.tidId))];
  const tidMap = new Map(
    (await db.tid.findMany({ where: { id: { in: tidIds } }, select: { id: true, tid: true, mid: true, hkdName: true, partnerId: true } })).map((t) => [t.id, t])
  );
  const partnerIds = [...new Set([...tidMap.values()].map((t) => t.partnerId).filter((x): x is number => x != null))];
  const custIds = [...new Set(rows.map((r) => r.customerId).filter((x): x is number => x != null))];
  const partnerMap = new Map((await db.partner.findMany({ where: { id: { in: partnerIds } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  const custMap = new Map((await db.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, fullName: true, nickname: true } })).map((c) => [c.id, c.nickname || c.fullName]));

  const data: DebtOpenTxnDto[] = [];
  for (const r of rows) {
    const remainingPartner = Math.max(0, Number(r.revenuePartner) - (paid.get(`${r.id}:PARTNER`) ?? 0));
    const remainingSell = Math.max(0, Number(r.revenueSell) - (paid.get(`${r.id}:SELL`) ?? 0));
    if (remainingPartner <= 0 && remainingSell <= 0) continue;
    const t = tidMap.get(r.tidId);
    data.push({
      id: r.id,
      code: r.code,
      txnDate: isoMapNo.get(r.id) ?? r.txnDate.toISOString(),
      tid: t?.tid ?? null,
      mid: t?.mid ?? null,
      hkdName: t?.hkdName ?? null,
      customerId: r.customerId,
      customerName: r.customerId != null ? custMap.get(r.customerId) ?? null : null,
      partnerId: t?.partnerId ?? null,
      partnerName: t?.partnerId != null ? partnerMap.get(t.partnerId) ?? null : null,
      revenuePartner: Number(r.revenuePartner),
      revenueSell: Number(r.revenueSell),
      remainingPartner,
      remainingSell,
      settled: r.settled,
      debtQuality: r.debtQuality
    });
  }
  return { ok: true, data };
}

// ═════════════════════════════════════════════════════════════════════════════
// H2b — PHÂN LOẠI CHẤT LƯỢNG CÔNG NỢ + GHI GIẢM NỢ XẤU (§2.8/§5b/§0 Q-C/Q-F)
// ═════════════════════════════════════════════════════════════════════════════

/** Chuyển trạng thái nguyên tử THUA trong $transaction → ném ra ngoài. */
class TxGuardError extends Error {
  constructor(public readonly code: string, public readonly userMessage: string) {
    super(code);
    this.name = 'TxGuardError';
  }
}

/** Nợ CÒN LẠI net từng side của 1 GD (revenue − Σ settlement), dùng cho classify/write-off. */
function netRemaining(t: { revenuePartner: number; revenueSell: number }, paid: Map<string, number>, id: number): { partner: number; sell: number; total: number } {
  const partner = Math.max(0, t.revenuePartner - (paid.get(`${id}:PARTNER`) ?? 0));
  const sell = Math.max(0, t.revenueSell - (paid.get(`${id}:SELL`) ?? 0));
  return { partner, sell, total: partner + sell };
}

export interface DebtQualityStat {
  count: number;
  debtPartner: number;
  debtSell: number;
  debtTotal: number;
}
export interface DebtByQualityResult {
  GOOD: DebtQualityStat;
  HARD: DebtQualityStat;
  BAD: DebtQualityStat;
  UNCLASSIFIED: DebtQualityStat;
}
function emptyQualityStat(): DebtQualityStat {
  return { count: 0, debtPartner: 0, debtSell: 0, debtTotal: 0 };
}

export interface DebtQualityLogDto {
  id: number;
  fromQuality: string | null;
  toQuality: string;
  reason: string | null;
  actorUserId: number;
  actorName: string | null;
  createdAt: string;
}

/** DEBT_CLASSIFY — đổi phân loại chất lượng công nợ của 1 GD (GOOD|HARD|BAD). CHỈ cho GD CÒN NỢ net & CHƯA ghi giảm. */
export async function classifyDebt(ctx: ServiceCtx, transactionId: number, quality: string, reason?: string): Promise<MutationResult> {
  if (!hasPermission(ctx.user, DEBT_CLASSIFY)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const q = (quality ?? '').trim().toUpperCase();
  if (!DEBT_QUALITIES.has(q)) return { ok: false, error: 'VALIDATION', message: 'Mức chất lượng công nợ phải là GOOD (Dễ), HARD (Khó) hoặc BAD (Không thu hồi).' };

  const t = await db.transaction.findUnique({ where: { id: transactionId }, select: { id: true, deletedAt: true, status: true, revenuePartner: true, revenueSell: true, debtQuality: true, writtenOffAt: true } });
  if (!t || t.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Giao dịch không tồn tại.' };
  if (t.status === 'CANCELLED') return { ok: false, error: 'TXN_CANCELLED', message: 'Giao dịch đã hủy — không phải công nợ.' };
  if (t.writtenOffAt) return { ok: false, error: 'ALREADY_WRITTEN_OFF', message: 'Giao dịch đã ghi giảm nợ xấu — không phân loại lại.' };

  const paid = await settledByTxnSide(db, [transactionId]);
  const net = netRemaining({ revenuePartner: Number(t.revenuePartner), revenueSell: Number(t.revenueSell) }, paid, transactionId);
  if (net.total <= 0) return { ok: false, error: 'DEBT_FULLY_PAID', message: 'Giao dịch đã thu đủ — không còn là công nợ để phân loại.' };

  const from = t.debtQuality;
  if (from === q) return { ok: true, id: transactionId, message: 'Mức phân loại không đổi.' };

  await db.$transaction(async (tx) => {
    await tx.debtQualityLog.create({ data: { transactionId, fromQuality: from, toQuality: q, reason: reason?.trim() || null, actorUserId: user.id } });
    await tx.transaction.update({ where: { id: transactionId }, data: { debtQuality: q, updatedBy: user.id } });
  });
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'DEBT_CLASSIFIED',
    targetType: 'Transaction',
    targetId: String(transactionId),
    before: auditSnapshot({ debtQuality: from }),
    after: auditSnapshot({ debtQuality: q, reason: reason?.trim() || null, remainingNet: net.total })
  });
  return { ok: true, id: transactionId };
}

/** DEBT_VIEW — lịch sử đổi phân loại của 1 GD (mới nhất trước). */
export async function debtQualityHistory(ctx: ServiceCtx, transactionId: number): Promise<{ ok: boolean; error?: string; message?: string; data?: DebtQualityLogDto[] }> {
  if (!hasPermission(ctx.user, DEBT_VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.debtQualityLog.findMany({ where: { transactionId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const names = await resolveUserNames(db, rows.map((r) => r.actorUserId));
  const data: DebtQualityLogDto[] = rows.map((r) => ({
    id: r.id,
    fromQuality: r.fromQuality,
    toQuality: r.toQuality,
    reason: r.reason,
    actorUserId: r.actorUserId,
    actorName: names.get(r.actorUserId) ?? null,
    createdAt: r.createdAt.toISOString()
  }));
  return { ok: true, data };
}

/** DEBT_VIEW — tổng công nợ CÒN LẠI net theo TỪNG mức chất lượng (GOOD/HARD/BAD/UNCLASSIFIED) trong phạm vi lọc. */
export async function debtByQuality(ctx: ServiceCtx, filter: TransactionFilter = {}): Promise<{ ok: boolean; error?: string; message?: string; data?: DebtByQualityResult }> {
  if (!hasPermission(ctx.user, DEBT_VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const empty: DebtByQualityResult = { GOOD: emptyQualityStat(), HARD: emptyQualityStat(), BAD: emptyQualityStat(), UNCLASSIFIED: emptyQualityStat() };
  const where = await buildWhere(db, filter);
  if (where === null) return { ok: true, data: empty };
  where.status = { not: 'CANCELLED' };
  where.writtenOffAt = null;
  const txns = await db.transaction.findMany({ where, select: { id: true, revenuePartner: true, revenueSell: true, debtQuality: true } });
  const paid = await settledByTxnSide(db, txns.map((t) => t.id));
  for (const t of txns) {
    const net = netRemaining({ revenuePartner: Number(t.revenuePartner), revenueSell: Number(t.revenueSell) }, paid, t.id);
    if (net.total <= 0) continue;
    const bucket = t.debtQuality && DEBT_QUALITIES.has(t.debtQuality) ? (t.debtQuality as 'GOOD' | 'HARD' | 'BAD') : 'UNCLASSIFIED';
    const s = empty[bucket];
    s.count++;
    s.debtPartner += net.partner;
    s.debtSell += net.sell;
    s.debtTotal += net.total;
  }
  return { ok: true, data: empty };
}

/**
 * DEBT_WRITEOFF — Ghi giảm nợ xấu (write-off, Q-F=B). Perm CAO. XÁC NHẬN MẬT KHẨU (§14) do ADAPTER kiểm TRƯỚC khi
 * gọi lõi (khuôn customer.ts). CHỈ áp GD debtQuality=BAD, còn nợ net > 0, CHƯA ghi giảm. Trong 1 $transaction:
 *  • FOR UPDATE hàng GD cha (FIX 1 TOCTOU write-off ⨯ thu công nợ) → tính net TRONG khóa;
 *  • sinh 1 CashEntry CHI danh mục "Chi phí nợ xấu" (sourceKind=BAD_DEBT, affectsPnl=true), amount = nợ net,
 *    fundId=null (bút toán PHI TIỀN MẶT), sourceType=BAD_DEBT + sourceId=transactionId, entryDate=now;
 *  • set Transaction.writtenOffAt/By → GD rớt khỏi công nợ. affectsPnl=true → getMonthlyProfit tự trừ.
 */
export async function writeOffBadDebt(ctx: ServiceCtx, transactionId: number): Promise<MutationResult> {
  if (!hasPermission(ctx.user, DEBT_WRITEOFF)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  // Pre-check NHANH ngoài khóa (fail sớm) — KHÔNG tính số tiền ở đây: net + kiểm net>0 tính TRONG khóa (FIX 1 TOCTOU).
  const pre = await db.transaction.findUnique({ where: { id: transactionId }, select: { id: true, deletedAt: true, status: true, debtQuality: true, writtenOffAt: true } });
  if (!pre || pre.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Giao dịch không tồn tại.' };
  if (pre.status === 'CANCELLED') return { ok: false, error: 'TXN_CANCELLED', message: 'Giao dịch đã hủy — không phải công nợ.' };
  if (pre.writtenOffAt) return { ok: false, error: 'ALREADY_WRITTEN_OFF', message: 'Giao dịch này đã được ghi giảm nợ xấu rồi.' };
  if (pre.debtQuality !== 'BAD') return { ok: false, error: 'NOT_BAD_DEBT', message: 'Chỉ ghi giảm được công nợ đã phân loại "Không thu hồi (BAD)".' };

  const badCat = await db.cashCategory.findFirst({ where: { kind: 'CHI', sourceKind: 'BAD_DEBT', deletedAt: null }, select: { id: true } });
  if (!badCat) return { ok: false, error: 'BAD_DEBT_CATEGORY_MISSING', message: 'Chưa có danh mục hệ thống "Chi phí nợ xấu". Khởi động lại máy chủ để seed danh mục.' };

  const now = new Date();
  let result: { entryId: number; net: { partner: number; sell: number; total: number } };
  try {
    result = await db.$transaction(async (tx) => {
      // FIX 1 (TOCTOU write-off ⨯ thu công nợ) — KHÓA HÀNG GD cha TRƯỚC khi đọc settlement/tính net.
      await tx.$queryRawUnsafe('SELECT id FROM transactions WHERE id = $1 FOR UPDATE', transactionId);

      const t = await tx.transaction.findUnique({ where: { id: transactionId }, select: { id: true, deletedAt: true, status: true, revenuePartner: true, revenueSell: true, debtQuality: true, writtenOffAt: true } });
      if (!t || t.deletedAt) throw new TxGuardError('NOT_FOUND', 'Giao dịch không tồn tại.');
      if (t.status === 'CANCELLED') throw new TxGuardError('TXN_CANCELLED', 'Giao dịch đã hủy — không phải công nợ.');
      if (t.writtenOffAt) throw new TxGuardError('ALREADY_WRITTEN_OFF', 'Giao dịch này đã được ghi giảm nợ xấu rồi.');
      if (t.debtQuality !== 'BAD') throw new TxGuardError('NOT_BAD_DEBT', 'Chỉ ghi giảm được công nợ đã phân loại "Không thu hồi (BAD)".');

      const agg = await tx.cashDebtSettlement.groupBy({ by: ['side'], where: { transactionId }, _sum: { amount: true } });
      const paid = new Map<string, number>();
      for (const a of agg) paid.set(`${transactionId}:${a.side}`, Number(a._sum.amount ?? 0));
      const net = netRemaining({ revenuePartner: Number(t.revenuePartner), revenueSell: Number(t.revenueSell) }, paid, transactionId);
      if (net.total <= 0) throw new TxGuardError('DEBT_FULLY_PAID', 'Giao dịch đã thu đủ — không còn nợ để ghi giảm.');

      // Idempotent nguyên tử: chỉ ghi giảm khi CHƯA writtenOff (đã khóa hàng nên moved luôn = 1; giữ như phòng vệ).
      const moved = await tx.transaction.updateMany({
        where: { id: transactionId, writtenOffAt: null, deletedAt: null, status: { not: 'CANCELLED' } },
        data: { writtenOffAt: now, writtenOffBy: user.id, updatedBy: user.id }
      });
      if (moved.count === 0) throw new TxGuardError('ALREADY_WRITTEN_OFF', 'Giao dịch này đã được ghi giảm nợ xấu rồi.');
      const code = await nextCode(tx, 'PC');
      const entry = await tx.cashEntry.create({
        data: {
          code, kind: 'CHI', categoryId: badCat.id, fundId: null, amount: net.total, method: 'CASH', entryDate: now,
          payerUserId: user.id, sourceType: 'BAD_DEBT', sourceId: transactionId,
          note: `Ghi giảm nợ xấu GD #${transactionId} (nợ còn lại net ${net.total}đ)`, status: 'POSTED', createdBy: user.id
        }
      });
      // G1: audit NGHIÊM trong transaction (tier-1 tiền: write-off + phiếu chi) — audit fail → rollback.
      await writeAuditStrict(tx, {
        actorUserId: user.id,
        action: 'DEBT_WRITTEN_OFF',
        targetType: 'Transaction',
        targetId: String(transactionId),
        after: auditSnapshot({ cashEntryId: entry.id, amountNet: net.total, partner: net.partner, sell: net.sell, categoryId: badCat.id })
      });
      return { entryId: entry.id, net };
    });
  } catch (e) {
    if (e instanceof TxGuardError) return { ok: false, error: e.code, message: e.userMessage };
    throw e;
  }
  await bumpChangeToken(db, 'Transaction');
  return { ok: true, id: result.entryId };
}

// ═════════════════════════════════════════════════════════════════════════════
// BACKFILL — phí cài máy cho GD CŨ (Admin Demo 11/8)
// ═════════════════════════════════════════════════════════════════════════════
// GD tạo TRƯỚC bản này có phi_cai_may_milli = 0 (default cột). Tất toán NĐT giờ lấy tiền về THEO phí cài máy của TID
// (per-txn) → phải backfill giá trị đúng cho GD cũ. Với mỗi GD POSTED, chưa xóa, phi_cai_may_milli = 0: tra LẠI biểu
// phí FeeRate(partnerId của TID × cardType) hiệu lực tại txnDate (pickEffectiveRate) → set phiCaiMayMilli = rate.phiCaiMay.
//
// CHỐNG N+1: (1) load 1 lần các GD cần vá; (2) load 1 lần TID → partnerId; (3) load 1 lần FeeRate cho TẤT CẢ partner
// liên quan rồi GOM theo (partnerId|cardTypeId) trong bộ nhớ; (4) mỗi GD chọn kỳ hiệu lực theo txnDate từ nhóm đã gom
// (không query trong vòng lặp). Ghi: GOM theo GIÁ TRỊ phí rồi updateMany theo lô id (ít lệnh ghi, không update từng dòng).
//
// Idempotent: phí = 0 (đúng) giữ nguyên (bỏ qua, không ghi); chạy lại chỉ đụng GD còn 0 mà có phí > 0 hiệu lực.
// CÁCH CHẠY (LEAD, 1 lần trên sigma — KHÔNG tự apply): xem ghi chú cuối hàm.
export interface BackfillPhiCaiMayResult {
  scanned: number; // số GD POSTED, chưa xóa, phi_cai_may_milli = 0 đã quét
  updated: number; // số GD được set phí cài máy > 0
  skippedZeroRate: number; // có biểu phí hiệu lực nhưng phiCaiMay = 0 → giữ 0 (đúng, không ghi)
  skippedNoPartner: number; // TID không có partnerId hoặc GD thiếu cardTypeId → không tra được
  skippedNoRate: number; // không có FeeRate hiệu lực tại txnDate → không tra được (GD lịch sử thiếu biểu phí)
}
export async function backfillTxnPhiCaiMay(db: Db): Promise<BackfillPhiCaiMayResult> {
  // (1) GD cần vá — CHỈ POSTED, chưa xóa, phí cài máy còn 0 (default). Lấy tối thiểu trường cần.
  const txns = await db.transaction.findMany({
    where: { phiCaiMayMilli: 0, status: 'POSTED', deletedAt: null },
    select: { id: true, tidId: true, cardTypeId: true, txnDate: true }
  });
  const res: BackfillPhiCaiMayResult = { scanned: txns.length, updated: 0, skippedZeroRate: 0, skippedNoPartner: 0, skippedNoRate: 0 };
  if (txns.length === 0) return res;
  const isoBackfill = await txnIsoMap(db, txns.map((t) => t.id)); // [GÓI TZ 11/9] instant thật cho pickEffectiveRate

  // (2) TID → partnerId (1 query gom).
  const tidIds = [...new Set(txns.map((t) => t.tidId))];
  const tids = await db.tid.findMany({ where: { id: { in: tidIds } }, select: { id: true, partnerId: true } });
  const partnerByTid = new Map<number, number | null>();
  for (const t of tids) partnerByTid.set(t.id, t.partnerId);

  // (3) FeeRate cho TẤT CẢ partner liên quan (1 query gom) → nhóm theo `partnerId|cardTypeId`.
  const partnerIds = [...new Set(tids.map((t) => t.partnerId).filter((x): x is number => x != null))];
  const rates = partnerIds.length > 0
    ? await db.feeRate.findMany({
        where: { partnerId: { in: partnerIds }, deletedAt: null },
        select: { partnerId: true, cardTypeId: true, phiCaiMay: true, effectiveFrom: true }
      })
    : [];
  const rateGroups = new Map<string, { phiCaiMay: number; effectiveFrom: Date }[]>();
  for (const r of rates) {
    const key = `${r.partnerId}|${r.cardTypeId}`;
    let g = rateGroups.get(key);
    if (!g) { g = []; rateGroups.set(key, g); }
    g.push({ phiCaiMay: r.phiCaiMay, effectiveFrom: r.effectiveFrom as Date });
  }

  // (4) Mỗi GD chọn kỳ hiệu lực theo txnDate (pickEffectiveRate — dùng CHUNG với createTransaction/recalc). GOM id
  //     theo GIÁ TRỊ phí để updateMany theo lô (không ghi từng dòng).
  const idsByValue = new Map<number, number[]>();
  for (const t of txns) {
    const partnerId = partnerByTid.get(t.tidId) ?? null;
    if (partnerId == null || t.cardTypeId == null) { res.skippedNoPartner++; continue; }
    const group = rateGroups.get(`${partnerId}|${t.cardTypeId}`);
    if (!group) { res.skippedNoRate++; continue; }
    const rate = pickEffectiveRate(group, new Date(isoBackfill.get(t.id) ?? (t.txnDate as Date).toISOString()));
    if (!rate) { res.skippedNoRate++; continue; }
    if (rate.phiCaiMay === 0) { res.skippedZeroRate++; continue; } // đã đúng (0), không cần ghi
    let arr = idsByValue.get(rate.phiCaiMay);
    if (!arr) { arr = []; idsByValue.set(rate.phiCaiMay, arr); }
    arr.push(t.id);
  }

  // Ghi theo lô: mỗi giá trị phí 1..n updateMany (chunk 1000 id/lệnh — tránh câu IN quá dài).
  const CHUNK = 1000;
  for (const [phiCaiMay, ids] of idsByValue) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const r = await db.transaction.updateMany({ where: { id: { in: chunk } }, data: { phiCaiMayMilli: phiCaiMay } });
      res.updated += r.count;
    }
  }
  return res;
}
