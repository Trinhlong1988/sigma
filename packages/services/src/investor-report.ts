// Báo cáo doanh thu & lãi NHÀ ĐẦU TƯ theo kỳ (Phase C-1) — LÕI THUẦN ctx-based, CHỈ ĐỌC (không đổi schema, không
// bảng mới). Nhà đầu tư bỏ tiền đối ứng → hưởng lãi = doanh số quẹt (gross) × %phí đầu tư. TID "uỷ NĐT" = TID có
// receiveAccountId trỏ ReceiveAccount.investorId = NĐT đó. Join: Transaction → Tid(receiveAccountId) →
// ReceiveAccount(investorId) → Investor. Gom theo NĐT ở JS bằng ĐÚNG 4 query (không N+1).
//
// CÔNG THỨC (Admin Demo chốt — KHÔNG đổi):
//   • doanhThu (VND) = Σ Transaction.amount (POSTED, deletedAt null, txnDate trong kỳ) của các TID uỷ NĐT.
//   • soBill        = COUNT các transaction đó.
//   • effInvestFeeMilli(mỗi GD) = tid.investFeeMilli ?? investor.investFeeMilli (override theo TID, fallback NĐT).
//   • laiNDT (VND)  = Σ per-transaction round(amount × effInvestFeeMilli / 100000). (×1000 của % rồi /100 = /100000.)
//                     Làm tròn NỬA LÊN tới VND TỪNG GIAO DỊCH rồi cộng. VD: amount=100_000_000, fee=100(0.1%) → 100_000đ.
//   • Tách "đã hoàn" (settled=true) vs "chưa hoàn" (settled=false): mỗi nhóm doanhThu+soBill+laiNDT riêng; tổng = cả hai.
//
// BIGINT xuyên suốt biên tính tiền: amount là BigInt (int8, GD không giới hạn giá trị) → cộng/nhân/chia bằng BigInt
// (KHÔNG Number trung gian → chống mất chữ số/tràn). Chỉ Number() ở BIÊN DTO (VND < 2^53 an toàn precision, khớp DTO
// tiền hiện có: transaction.ts trả Number(amount)). Không có BigInt rời service nên không cần bigint-json shim ở đây.
//
// PERMISSION (Phase D — phân quyền + data-scope):
//   • Staff nội bộ: gate `REVENUE_VIEW` (như RevenuePage) → xem TẤT CẢ NĐT / lọc theo investorId param.
//   • User NĐT (role R_INVESTOR): gate `INVESTOR_SELF_VIEW` → CHỈ xem báo cáo CỦA MÌNH. Data-scope BẮT BUỘC ép
//     investorId về NĐT gắn userId (resolveOwnInvestorId), GHI ĐÈ mọi investorId client gửi (chống xem NĐT khác).
//     Chưa gắn NĐT → trả rỗng data:[], KHÔNG lỗi. Có CẢ REVENUE_VIEW lẫn INVESTOR_SELF_VIEW → REVENUE_VIEW thắng (staff).
import { hasPermission } from '@sigma/shared';
import { pickEffectiveRate } from '@sigma/business-rules';
import type { Db } from '@sigma/database';
import type { ServiceCtx } from './customer.js';
import { resolveOwnInvestorId, resolveScopeInvestorId } from './investor-scope.js';
import { loadInvestorCutoffs, isBeforeCutoff } from './investor-clear.js';
import { caCuaPhut, khoaBankCaTu, type CaTien } from './ca-tien.js';
import { nhanBank } from './nhan-bank.js';
import { idsTheoTxnDate, txnIsoMap } from './transaction.js';
// TÌM KIẾM hoa/thường: DB collation "C" → Prisma mode:'insensitive' (ILIKE) KHÔNG gập chữ tiếng Việt có dấu
// (đo thật trên sổ thật: ILIKE '%nguyễn%' = 0 dòng / ILIKE '%NGUYỄN%' = 10 dòng). Xem tim-kiem-hoa-thuong.ts.
import { dieuKienTimKiem } from './tim-kiem-hoa-thuong.js';

const VIEW_ALL = 'REVENUE_VIEW'; // staff xem TẤT CẢ.
const SELF_VIEW = 'INVESTOR_SELF_VIEW'; // user NĐT xem CỦA MÌNH (ép scope).
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';
const FEE_DIVISOR = 100_000n; // %×1000 (milli) / 100 = /100_000 để ra hệ số nhân doanh thu.
const HALF = FEE_DIVISOR / 2n; // 50_000 — cộng trước khi chia floor = làm tròn NỬA LÊN (amount,fee ≥ 0).
const SETTLE_DIVISOR = 100_000n; // phí cài máy ×1000 → hệ số (100000 − phí)/100000 cho tiền về (Admin Demo 11/8).

/** 1 nhóm số liệu (đã hoàn / chưa hoàn / tổng). VND ở dạng number (BIÊN DTO — đã cộng bằng BigInt bên trong). */
export interface InvestorReportBucket {
  doanhThu: number; // Σ amount (VND)
  soBill: number; // số giao dịch
  laiNDT: number; // Σ lãi làm tròn từng GD (VND)
}
export interface InvestorReportRow {
  investorId: number;
  code: string;
  investorName: string; // nickname || fullName (khớp receive-account.ts)
  doanhThu: number; // = daHoan.doanhThu + chuaHoan.doanhThu
  soBill: number; // = daHoan.soBill + chuaHoan.soBill
  laiNDT: number; // = daHoan.laiNDT + chuaHoan.laiNDT
  // Tiền về NĐT theo PHÍ CÀI MÁY của TID (Admin Demo 11/8): Σ per-txn FLOOR(amount×(100000−txn.phiCaiMayMilli)/100000).
  // Tất toán NĐT (investor-settlement) đọc trực tiếp cột này (KHÔNG dùng %phí cài máy cấu hình ở tab NĐT nữa).
  tienVe: number;
  daHoan: InvestorReportBucket; // settled = true
  chuaHoan: InvestorReportBucket; // settled = false
}
export interface InvestorDailyReportInput {
  investorId?: number; // có → chỉ 1 NĐT; không → mọi NĐT ACTIVE
  from: string; // 'YYYY-MM-DD' (bao gồm cả ngày này)
  to: string; // 'YYYY-MM-DD' (bao gồm cả ngày này)
  // ── BỘ LỌC (Admin Demo 11/8) — THU HẸP tập TID uỷ NĐT (KHÔNG phá scope Phase D: user NĐT vẫn bị ép investorId của
  //   mình, filter chỉ lọc TRONG phạm vi họ). Filter làm rỗng tập → doanhThu/lãi/tiền về = 0 (KHÔNG lỗi). ──
  receiveAccountId?: number; // chỉ TID gắn TK nhận tiền này (phải nằm trong tập uỷ NĐT → giữ scope)
  bankId?: number; // chỉ TID thuộc ngân hàng này (Tid.bankId)
  tidId?: number; // chỉ đúng 1 TID (Tid.id)
  hkdName?: string; // tên HKD của TID chứa chuỗi này (không phân biệt hoa/thường)
  // [Admin Demo 27/8, làm 11/9] CA TIỀN VỀ 1/2/3 theo GIỜ TỔNG KẾT BILL (txn_date, giờ HCM) + ngân hàng của TID —
  // mốc chính chủ ở ca-tien.ts. Bank ngoài bảng mốc (không MB/MBB/ABB/MBV) → không thuộc ca nào → lọc ca loại ra.
  ca?: CaTien;
}
export interface InvestorDailyReportResult {
  ok: boolean;
  error?: string;
  message?: string;
  data?: InvestorReportRow[];
  from?: string;
  to?: string;
}

/** Parse 'YYYY-MM-DD' → nửa đêm LOCAL (new Date(y,m-1,d)) — CÙNG quy ước half-open local như dashboard.ts
 *  (bound txnDate theo NGÀY local, so INSTANT tuyệt đối timestamptz, không phụ thuộc session-TZ Postgres). null nếu sai. */
function parseLocalDay(s: string | undefined): Date | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(y, mo - 1, d); // nửa đêm LOCAL
  // Chống JS cuộn âm thầm (vd 2026-02-31): các thành phần phải khớp lại.
  if (dt.getFullYear() !== y || dt.getMonth() + 1 !== mo || dt.getDate() !== d) return null;
  return dt;
}
/** Nửa đêm local của NGÀY KẾ (chặn trên nửa-mở [start, end)). */
function nextLocalDay(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
}
const emptyBucket = (): InvestorReportBucket => ({ doanhThu: 0, soBill: 0, laiNDT: 0 });

/** Lãi 1 GD (VND) = effInvestFeeMilli% × BASE, làm tròn NỬA LÊN, BigInt xuyên suốt. base,fee ≥ 0.
 *  Admin Demo 31/8: BASE = TIỀN VỀ (amount − phí cài máy), KHÔNG phải gross. Caller PHẢI truyền tiền về
 *  (tienVeForTxn) — tên tham số `base` nhắc rõ điều đó.
 *  EXPORT (Admin Demo 5/9): báo cáo Tổng gộp SigMa (alpha-aggregate) tái dùng ĐÚNG công thức lãi NĐT POS này,
 *  KHÔNG viết lại — 1 nguồn công thức duy nhất. */
export function laiForTxn(base: bigint, effInvestFeeMilli: number): bigint {
  if (effInvestFeeMilli <= 0) return 0n;
  return (base * BigInt(effInvestFeeMilli) + HALF) / FEE_DIVISOR;
}
/** Tiền về 1 GD (VND) theo phí cài máy của TID (Admin Demo 11/8): FLOOR(amount × (100000 − phiCaiMayMilli)/100000).
 *  phiCaiMayMilli kẹp [0,100000] (an toàn — snapshot lúc tạo đã hợp lệ); amount ≥ 0 → FLOOR đơn thuần.
 *  EXPORT (Admin Demo 5/9): tái dùng ở alpha-aggregate (tiền về POS) — KHÔNG viết lại. */
export function tienVeForTxn(amount: bigint, phiCaiMayMilli: number): bigint {
  const pcm = phiCaiMayMilli <= 0 ? 0 : (phiCaiMayMilli >= 100_000 ? 100_000 : phiCaiMayMilli);
  return (amount * BigInt(100_000 - pcm)) / SETTLE_DIVISOR;
}

/**
 * Báo cáo doanh thu + lãi NĐT trong kỳ [from, to] (cả 2 đầu bao gồm; bound local half-open).
 * Phân quyền + data-scope (Phase D): staff REVENUE_VIEW xem tất cả / lọc theo investorId; user NĐT INVESTOR_SELF_VIEW
 *   bị ÉP scope về NĐT của mình (ghi đè investorId client), chưa gắn NĐT → rỗng.
 * `effectiveInvestorId` có → 1 NĐT (bất kỳ trạng thái, còn sống); không → mọi NĐT ACTIVE (kể cả doanh thu 0 → UI đủ khung).
 * 4 query, KHÔNG N+1: (1) investors, (2) receiveAccounts uỷ NĐT, (3) tids gắn TK đó, (4) transactions của các tid trong kỳ.
 * (+1 query scope resolve CHỈ khi user tự-xem, KHÔNG N+1.)
 */
export async function investorDailyReport(ctx: ServiceCtx, input: InvestorDailyReportInput): Promise<InvestorDailyReportResult> {
  const canViewAll = hasPermission(ctx.user, VIEW_ALL);
  const canSelf = hasPermission(ctx.user, SELF_VIEW);
  if (!canViewAll && !canSelf) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db: Db = ctx.db;

  const fromDay = parseLocalDay(input.from);
  const toDay = parseLocalDay(input.to);
  if (!fromDay || !toDay) return { ok: false, error: 'VALIDATION', message: 'Kỳ báo cáo không hợp lệ (định dạng YYYY-MM-DD).' };
  if (toDay.getTime() < fromDay.getTime()) return { ok: false, error: 'VALIDATION', message: 'Ngày "đến" phải ≥ ngày "từ".' };
  const start = fromDay; // nửa đêm local ngày from
  const end = nextLocalDay(toDay); // nửa đêm local ngày (to + 1) — chặn trên nửa-mở

  // DATA-SCOPE: staff (REVENUE_VIEW) dùng investorId client gửi; user NĐT (chỉ INVESTOR_SELF_VIEW) BỊ ÉP về NĐT của
  // mình — GHI ĐÈ investorId client (chống xem NĐT khác). Chưa gắn NĐT → rỗng (hợp lệ, không lỗi).
  let effectiveInvestorId = input.investorId;
  // [KẾ TOÁN NĐT 24/11] DATA-SCOPE CỨNG: nếu user bị khóa phạm vi (users.scope_investor_id), ÉP về đúng NĐT đó —
  // GHI ĐÈ cả tham số client LẪN quyền xem-tất (REVENUE_VIEW). Đây là lý do scope phải ĐỘC LẬP permission: vai
  // Kế toán NĐT có REVENUE_VIEW để vào màn Doanh Số, nhưng KHÔNG được xem NĐT khác.
  const scopeId = await resolveScopeInvestorId(ctx);
  if (scopeId != null) {
    effectiveInvestorId = scopeId;
  } else if (!canViewAll) {
    const ownId = await resolveOwnInvestorId(ctx);
    if (ownId == null) return { ok: true, data: [], from: input.from, to: input.to };
    effectiveInvestorId = ownId;
  }

  // (1) NĐT trong phạm vi: 1 NĐT chỉ định (còn sống) hoặc mọi NĐT ACTIVE.
  const investors = await db.investor.findMany({
    where: effectiveInvestorId != null
      ? { id: effectiveInvestorId, deletedAt: null }
      : { status: 'ACTIVE', deletedAt: null },
    select: { id: true, code: true, nickname: true, fullName: true, investFeeMilli: true },
    orderBy: { code: 'asc' }
  });
  if (investors.length === 0) return { ok: true, data: [], from: input.from, to: input.to };
  const investorIds = investors.map((v) => v.id);
  const investorById = new Map(investors.map((v) => [v.id, v]));

  // (2) TK nhận tiền uỷ các NĐT này (deletedAt null = uỷ hiện hành). raId → investorId.
  const rcvAccts = await db.receiveAccount.findMany({
    where: { investorId: { in: investorIds }, deletedAt: null },
    select: { id: true, investorId: true }
  });
  const raToInvestor = new Map<number, number>();
  for (const ra of rcvAccts) if (ra.investorId != null) raToInvestor.set(ra.id, ra.investorId);

  // (3) TID gắn các TK đó. KHÔNG lọc tid.deletedAt (khớp transaction.ts: GD tham chiếu TID theo id; TID xóa mềm
  //     về sau vẫn phải tổng hợp ĐÚNG doanh thu quá khứ — tránh lệch tổng). tid.investFeeMilli = override theo TID.
  const raIds = [...raToInvestor.keys()];
  const initRow = (v: { id: number; code: string; nickname: string; fullName: string }): InvestorReportRow => ({
    investorId: v.id,
    code: v.code,
    investorName: v.nickname || v.fullName,
    doanhThu: 0, soBill: 0, laiNDT: 0, tienVe: 0,
    daHoan: emptyBucket(), chuaHoan: emptyBucket()
  });
  const rows = new Map<number, InvestorReportRow>();
  for (const v of investors) rows.set(v.id, initRow(v)); // mọi NĐT hiện khung (kể cả 0 doanh thu)

  if (raIds.length > 0) {
    // BỘ LỌC — thu hẹp tập TID TRONG phạm vi uỷ NĐT (giữ scope Phase D):
    //  • receiveAccountId: chỉ giữ TK nhận tiền đó NẾU nó thuộc tập uỷ NĐT hợp lệ (raIds); ngoài phạm vi → rỗng → 0.
    //  • bankId / tidId / hkdName: điều kiện thêm trên chính bảng Tid (AND với receiveAccountId ∈ effRaIds).
    const effRaIds = input.receiveAccountId != null ? raIds.filter((id) => id === input.receiveAccountId) : raIds;
    const hkdNeedle = typeof input.hkdName === 'string' ? input.hkdName.trim() : '';
    const tids = await db.tid.findMany({
      where: {
        receiveAccountId: { in: effRaIds },
        ...(input.bankId != null ? { bankId: input.bankId } : {}),
        ...(input.tidId != null ? { id: input.tidId } : {}),
        // Lọc tên HKD — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts).
        ...(hkdNeedle !== '' ? { AND: await dieuKienTimKiem(db, 'tids', { hkdName: 'hkd_name' }, hkdNeedle) } : {})
      },
      select: { id: true, receiveAccountId: true, investFeeMilli: true, bankId: true }
    });
    // tidId → { investorId, effInvestFeeMilli } (override TID nếu có, else của NĐT).
    const tidMeta = new Map<number, { investorId: number; feeMilli: number }>();
    for (const t of tids) {
      if (t.receiveAccountId == null) continue;
      const invId = raToInvestor.get(t.receiveAccountId);
      if (invId == null) continue;
      const inv = investorById.get(invId);
      if (!inv) continue;
      const feeMilli = t.investFeeMilli ?? inv.investFeeMilli; // override theo TID THẮNG mặc định NĐT
      tidMeta.set(t.id, { investorId: invId, feeMilli });
    }

    // [Lọc CA 11/9] tid → tên ngân hàng (chỉ tra khi có input.ca — caCuaPhut cần bank để tra bảng mốc).
    const bankNameByTid = new Map<number, string>();
    if (input.ca != null) {
      const bankIds = [...new Set(tids.map((t) => t.bankId).filter((x): x is number => x != null))];
      const banks = bankIds.length > 0 ? await db.bank.findMany({ where: { id: { in: bankIds } }, select: { id: true, code: true, name: true } }) : [];
      // [B174b 16/11] KHOÁ TRA CA, không phải nhãn hiển thị: mã trước, mã không ra khoá thì tên.
      const nm = new Map(banks.map((b) => [b.id, khoaBankCaTu(b.code, b.name) ?? '']));
      for (const t of tids) if (t.bankId != null) bankNameByTid.set(t.id, nm.get(t.bankId) ?? '');
    }

    // (4) Giao dịch POSTED, còn sống, trong kỳ, của các TID uỷ. BigInt amount giữ nguyên (không Number trung gian).
    const tidIds = [...tidMeta.keys()];
    if (tidIds.length > 0) {
      // BUG AUDIT 27/8 (nghiêm trọng): Prisma `txnDate:{gte:Date,lt:Date}` qua driver-adapter serialize mốc LỆCH
      // múi giờ → CẮT MẤT GD buổi tối (17h–24h local) → thẻ báo THIẾU doanh số so Excel/manual. DÙNG raw SQL với biên
      // ISO ::timestamptz Y HỆT investorReportDetail (đã khớp 89 bill/manual). start/end = parseLocalDay (nửa-mở local).
      const txns = await db.$queryRawUnsafe<{ tidId: number; amount: bigint; settled: boolean; phiCaiMayMilli: number | null; txnDate: Date | string | null; txnIso: string; installFeeAmount: bigint | number | null; phutHcm: number }[]>(
        `SELECT t.tid_id AS "tidId", t.amount, t.settled, t.phi_cai_may_milli AS "phiCaiMayMilli", t.txn_date AS "txnDate",
                to_char(t.txn_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "txnIso", t.install_fee_amount AS "installFeeAmount",
                (CASE WHEN l.bill_txn_date IS NULL THEN -1 ELSE
                  EXTRACT(HOUR FROM l.bill_txn_date AT TIME ZONE 'Asia/Ho_Chi_Minh') * 60 + EXTRACT(MINUTE FROM l.bill_txn_date AT TIME ZONE 'Asia/Ho_Chi_Minh') END)::int AS "phutHcm"
         FROM transactions t
         LEFT JOIN los l ON l.transaction_id = t.id
         WHERE t.tid_id = ANY($1) AND t.status='POSTED' AND t.deleted_at IS NULL
           -- [Admin Demo 26/9 CHỐT "lấy ngày trên bill làm chuẩn"] Kỳ báo cáo tính theo NGÀY TRÊN BILL, không phải
           -- ngày ghi GD. Bill quẹt tối hôm trước mà sáng hôm sau mới OCR thì txn_date là hôm trước, bill_txn_date
           -- là hôm sau — lệch tới 14 tiếng (đo thật 25→26/9: 9 GD, 625.714.000đ của NĐT NĐT 1).
           -- Bill chưa có giờ bill (bill_txn_date null) → rơi về txn_date, không để GD rớt khỏi mọi kỳ.
           AND COALESCE(l.bill_txn_date, t.txn_date) >= $2::timestamptz
           AND COALESCE(l.bill_txn_date, t.txn_date) < $3::timestamptz`,
        tidIds, start.toISOString(), end.toISOString()
      );
      // MỐC CHỐT/CLEAR (Admin Demo 1/9): loại GD phát sinh TRƯỚC ngày chốt của NĐT khỏi doanh thu/lãi/tiền về hiện tại.
      const cutoffs = await loadInvestorCutoffs(db);
      // Tích lũy BigInt theo NĐT + nhóm settled; chỉ Number() ở BIÊN cuối. `tv` = tiền về (per-txn theo phí cài máy
      // của TID) — chỉ cần tổng ở `all` (tất toán không tách đã/chưa hoàn cho tiền về).
      type Acc = { dt: bigint; bill: number; lai: bigint; tv: bigint };
      const mk = (): Acc => ({ dt: 0n, bill: 0, lai: 0n, tv: 0n });
      const acc = new Map<number, { all: Acc; done: Acc; open: Acc }>();
      for (const inv of investors) acc.set(inv.id, { all: mk(), done: mk(), open: mk() });
      for (const tx of txns) {
        const meta = tidMeta.get(tx.tidId);
        if (!meta) continue;
        // [GÓI TZ 11/9] So cutoff bằng ISO THẬT (raw-read Date lệch +7h trên txn_date instant-thật sau chuẩn hoá).
        if (isBeforeCutoff(cutoffs, meta.investorId, new Date(tx.txnIso))) continue; // trước mốc chốt → không tính
        // [Lọc CA 11/9] Ca theo GIỜ BILL THẬT los.bill_txn_date (raw-SQL ghi đúng giờ HCM) — KHÔNG dùng txn_date
        // (Prisma ghi lệch −7h, bằng chứng prod 10/9). Không có bill_txn_date (phutHcm=-1) → ca null → lọc ca loại.
        if (input.ca != null && caCuaPhut(bankNameByTid.get(tx.tidId), tx.phutHcm) !== input.ca) continue;
        const bucketSet = acc.get(meta.investorId);
        if (!bucketSet) continue;
        const amount = BigInt(tx.amount as unknown as string | number | bigint); // raw int8 (bigint/string) → bigint an toàn
        // TIỀN VỀ: nếu GD có install_fee_amount TUYỆT ĐỐI (>0, lô đa-thẻ ghi Σ phí cài per-thẻ ĐÚNG) → tiền về = amount −
        // cột đó (100% đúng từng đồng). Else (1-thẻ/legacy, cột=0) → dùng RATE phi_cai_may_milli như cũ.
        const ifa = BigInt(tx.installFeeAmount ?? 0);
        const tv = ifa > 0n ? amount - ifa : tienVeForTxn(amount, Number(tx.phiCaiMayMilli ?? 0));
        const lai = laiForTxn(tv, meta.feeMilli); // Admin Demo 31/8: lãi NĐT 0.1% TRÊN TIỀN VỀ (amount − phí cài máy), KHÔNG trên gross.
        const add = (a: Acc): void => { a.dt += amount; a.bill += 1; a.lai += lai; a.tv += tv; };
        add(bucketSet.all);
        add(tx.settled ? bucketSet.done : bucketSet.open);
      }
      for (const [invId, a] of acc) {
        const row = rows.get(invId);
        if (!row) continue;
        row.doanhThu = Number(a.all.dt); row.soBill = a.all.bill; row.laiNDT = Number(a.all.lai); row.tienVe = Number(a.all.tv);
        row.daHoan = { doanhThu: Number(a.done.dt), soBill: a.done.bill, laiNDT: Number(a.done.lai) };
        row.chuaHoan = { doanhThu: Number(a.open.dt), soBill: a.open.bill, laiNDT: Number(a.open.lai) };
      }
    }
  }

  return { ok: true, data: investors.map((v) => rows.get(v.id)!), from: input.from, to: input.to };
}

// ─────────────────────────────────────────────────────────────────────────────
// CẢNH BÁO BACKFILL PHÍ CÀI MÁY (Money-F4, Admin Demo) — CHỈ ĐỌC, KHÔNG đổi công thức tiền về.
// Bối cảnh: tienVeForTxn dùng Transaction.phiCaiMayMilli snapshot. GD lịch sử tạo TRƯỚC 11/8 có phiCaiMayMilli=0
// (default) trong khi FeeRate hiệu lực của TID thực chất >0 → tiền về NĐT bị tính = FULL amount (thổi tiền về, tất
// toán sai). Hiện DB 0 GD nên chưa cắn, nhưng phải CẢNH BÁO để backfill trước khi cắn. Hàm này đếm ĐỘNG (không
// hard-code) số GD POSTED uỷ-NĐT còn phiCaiMayMilli=0 mà FeeRate hiệu lực (theo partner của TID × cardType tại
// txnDate) có phiCaiMay>0 (needsBackfill) — tách khỏi số GD phí=0 "thật" (FeeRate cũng 0). CẤM nuốt lỗi (R198):
// lỗi truy vấn ném ra ngoài (route sẽ thành finding), KHÔNG trả "count=0" giả.
// ─────────────────────────────────────────────────────────────────────────────
export interface ZeroPhiCaiMayWarn {
  ok: boolean;
  error?: string;
  message?: string;
  zeroFeeCount?: number;      // tổng GD POSTED uỷ-NĐT có phiCaiMayMilli=0 (kể cả phí thật=0)
  needsBackfill?: number;     // trong đó: FeeRate hiệu lực có phiCaiMay>0 ⇒ CẦN backfill (tiền về đang sai)
  noRateCount?: number;       // không tra được FeeRate hiệu lực (thiếu biểu phí) — cần rà soát riêng
}

/** REVENUE_VIEW (staff) — đếm GD uỷ-NĐT còn phiCaiMayMilli=0 cần backfill. input.from/to (YYYY-MM-DD) tùy chọn giới
 *  hạn kỳ; bỏ trống = toàn bộ lịch sử. KHÔNG N+1: 1 query TK uỷ + 1 TID + 1 GD + 1 FeeRate gom theo partner. */
export async function countZeroPhiCaiMayInvestorTxns(
  ctx: ServiceCtx,
  input: { from?: string; to?: string } = {}
): Promise<ZeroPhiCaiMayWarn> {
  if (!hasPermission(ctx.user, VIEW_ALL)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };

  // Kỳ (tùy chọn) — cùng quy ước local half-open như report. Sai định dạng → lỗi (không nuốt).
  let start: Date | undefined, end: Date | undefined;
  if (input.from != null) { const d = parseLocalDay(input.from); if (!d) return { ok: false, error: 'VALIDATION', message: 'Ngày "từ" không hợp lệ (YYYY-MM-DD).' }; start = d; }
  if (input.to != null) { const d = parseLocalDay(input.to); if (!d) return { ok: false, error: 'VALIDATION', message: 'Ngày "đến" không hợp lệ (YYYY-MM-DD).' }; end = nextLocalDay(d); }
  const r = await scanZeroPhiCaiMayCore(ctx.db, start, end);
  return { ok: true, ...r };
}

/** L1 (đối kháng 12/8) — CORE quét (db-only, KHÔNG permission check) để wire được vào health-scan (collectFindings
 *  chỉ có `db`, không có ctx.user). Wrapper countZeroPhiCaiMayInvestorTxns bọc permission; health.ts gọi trực tiếp. */
export async function scanZeroPhiCaiMayCore(db: Db, start?: Date, end?: Date): Promise<{ zeroFeeCount: number; needsBackfill: number; noRateCount: number }> {
  const ZERO = { zeroFeeCount: 0, needsBackfill: 0, noRateCount: 0 };
  // (1) TK nhận tiền uỷ NĐT (deletedAt null) → tập raIds.
  const rcvAccts = await db.receiveAccount.findMany({ where: { investorId: { not: null }, deletedAt: null }, select: { id: true } });
  const raIds = rcvAccts.map((r) => r.id);
  if (raIds.length === 0) return ZERO;

  // (2) TID gắn các TK đó → partnerId theo TID (để tra FeeRate). KHÔNG lọc tid.deletedAt (khớp report — GD quá khứ).
  const tids = await db.tid.findMany({ where: { receiveAccountId: { in: raIds } }, select: { id: true, partnerId: true } });
  const partnerByTid = new Map<number, number | null>();
  for (const t of tids) partnerByTid.set(t.id, t.partnerId);
  const tidIds = tids.map((t) => t.id);
  if (tidIds.length === 0) return ZERO;

  // (3) GD POSTED, còn sống, phiCaiMayMilli=0, trong kỳ (nếu có). Cần cardTypeId + txnDate để tra FeeRate hiệu lực.
  // [GÓI TZ 11/9] bound + instant qua raw (Prisma bound −7h / ORM-read +7h đều sai trên txn_date instant-thật).
  const idsKyHealth = (start || end) ? await idsTheoTxnDate(db, { gte: start ?? undefined, lt: end ?? undefined }) : null;
  const txns = await db.transaction.findMany({
    where: { tidId: { in: tidIds }, status: 'POSTED', deletedAt: null, phiCaiMayMilli: 0, ...(idsKyHealth ? { id: { in: idsKyHealth } } : {}) },
    select: { id: true, tidId: true, cardTypeId: true, txnDate: true }
  });
  const zeroFeeCount = txns.length;
  if (zeroFeeCount === 0) return ZERO;
  const isoHealth = await txnIsoMap(db, txns.map((t) => t.id)); // [GÓI TZ 11/9] instant thật cho pickEffectiveRate

  // (4) FeeRate cho tất cả partner liên quan (1 query gom) → nhóm theo `partnerId|cardTypeId`; pickEffectiveRate(txnDate).
  const partnerIds = [...new Set(tids.map((t) => t.partnerId).filter((x): x is number => x != null))];
  const rates = partnerIds.length > 0
    ? await db.feeRate.findMany({ where: { partnerId: { in: partnerIds }, deletedAt: null }, select: { partnerId: true, cardTypeId: true, phiCaiMay: true, effectiveFrom: true } })
    : [];
  const rateGroups = new Map<string, { phiCaiMay: number; effectiveFrom: Date }[]>();
  for (const r of rates) {
    const key = `${r.partnerId}|${r.cardTypeId}`;
    let g = rateGroups.get(key);
    if (!g) { g = []; rateGroups.set(key, g); }
    g.push({ phiCaiMay: r.phiCaiMay, effectiveFrom: r.effectiveFrom as Date });
  }

  let needsBackfill = 0, noRateCount = 0;
  for (const t of txns) {
    const partnerId = partnerByTid.get(t.tidId) ?? null;
    if (partnerId == null || t.cardTypeId == null) { noRateCount++; continue; }
    const group = rateGroups.get(`${partnerId}|${t.cardTypeId}`);
    if (!group) { noRateCount++; continue; }
    const rate = pickEffectiveRate(group, new Date(isoHealth.get(t.id) ?? (t.txnDate as Date).toISOString()));
    if (!rate) { noRateCount++; continue; }
    if (rate.phiCaiMay > 0) needsBackfill++; // phí hiệu lực >0 nhưng snapshot=0 ⇒ tiền về đang sai → cần backfill
  }
  return { zeroFeeCount, needsBackfill, noRateCount };
}

// ── BÁO CÁO CHI TIẾT NĐT (Admin Demo 26/8) — trả JSON per-bill + tổng-từng-TID + lãi/tạm ứng cho desktop dựng Excel.
// Sắp theo NGÂN HÀNG rồi TID. Công thức khớp laiForTxn/tienVeForTxn ở trên.
// TÊN ĐẠI LÝ per-lô (Admin Demo 2/9 "lấp cột Đại lý ở báo cáo NĐT"): resolve TID → tid.customer_id →
// customer_chat_groups(unassigned_at IS NULL) → chat_rooms.name. NĐT xem được đại lý bán các lô của mình.
// Nếu 1 TID (qua customer) map ĐÚNG 1 phòng đang hoạt động → tên phòng; 0 hoặc >1 phòng (không 1-1) → '' (render '—',
// KHÔNG bịa). KHÔNG trả tên KHÁCH nào khác ngoài đại lý-bán này.
export interface InvestorDetailBill {
  tid: string; bankName: string; hkdName: string; soLo: string; txnDateIso: string;
  amount: number; phiMilli: number; sauPhi: number; effMilli: number; lai: number;
  // Số lô TRÊN BILL (từ billKey `nat|tid|LÔ|hđ` / `VL|tid|LÔ|ngày`) — để hiện số lô khi CHƯA đối soát bank
  // (bank_reported_lo_number còn null cho bill Support SigMa). Đồng nhất với màn đại lý (Admin Demo 31/8).
  billLoNumber: string;
  // [Admin Demo 21/9] loId + GHI CHÚ per-lô (pos_lot_recon.note) — đồng nhất bảng lô ĐL / NĐT / danh sách hoàn tiền.
  loId: number | null;
  note: string | null;
  // Tên ĐẠI LÝ bán lô (tên phòng chat gắn khách sở hữu TID) — '' nếu không resolve 1-1 (render '—').
  agentName: string;
}
export interface InvestorDetailTidSum { bank: string; tid: string; hkd: string; n: number; truoc: number; sau: number; lai: number; }
export interface InvestorReportDetailResult {
  ok: boolean; error?: string; message?: string;
  data?: {
    investorId: number; investorName: string; from: string; to: string;
    bills: InvestorDetailBill[]; tidSummary: InvestorDetailTidSum[];
    advances: { advanceDateIso: string; senderName: string; receiverName: string; amount: number; source: string }[];
    totals: { truoc: number; sau: number; lai: number; tienVe: number; daNhan: number; thuaThieu: number };
  };
}

export async function investorReportDetail(ctx: ServiceCtx, input: { investorId: number; from: string; to: string; bankId?: number; tidId?: number; hkdName?: string; ca?: CaTien }): Promise<InvestorReportDetailResult> {
  const canViewAll = hasPermission(ctx.user, VIEW_ALL);
  const canSelf = hasPermission(ctx.user, SELF_VIEW);
  if (!canViewAll && !canSelf) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  let investorId = input.investorId;
  if (!canViewAll && canSelf) {
    const own = await resolveOwnInvestorId(ctx);
    if (own == null) return { ok: true, data: undefined };
    investorId = own; // ép scope
  }
  // [KẾ TOÁN NĐT 24/11] DATA-SCOPE CỨNG: khóa phạm vi thì ÉP investorId = NĐT scope — GHI ĐÈ cả tham số LẪN quyền
  // xem-tất (phòng thủ lớp service, dù route đã ép). Chi tiết + Excel đều chỉ của NĐT mình.
  const scopeId = await resolveScopeInvestorId(ctx);
  if (scopeId != null) investorId = scopeId;
  const from = parseLocalDay(input.from), to = parseLocalDay(input.to);
  if (!from || !to) return { ok: false, error: 'VALIDATION', message: 'Ngày không hợp lệ (YYYY-MM-DD).' };
  const db = ctx.db;
  const inv = await db.investor.findFirst({ where: { id: investorId, deletedAt: null }, select: { fullName: true, nickname: true, investFeeMilli: true } });
  if (!inv) return { ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy nhà đầu tư.' };
  const invDefault = Number(inv.investFeeMilli ?? 0);
  // MỐC CHỐT (Agent-A 1/9): báo cáo CHI TIẾT phải LOẠI dữ liệu trước mốc chốt Y HỆT investorDailyReport/Settlement —
  // nếu không, NĐT đã clear (vd inv15: 43 tạm ứng = 15,69 tỷ trước 30/8) bị CỘNG LẠI vào daNhan/thuaThieu → Excel chi
  // tiết MÂU THUẪN với tất toán. Áp cho CẢ giao dịch (tienVe) LẪN tạm ứng (daNhan) để thuaThieu nhất quán.
  const cutoffs = await loadInvestorCutoffs(db);
  const start = from.toISOString(); const end = nextLocalDay(to).toISOString();
  // BỘ LỌC (Admin Demo 27/8): TID / ngân hàng / tên HKD (tên POS) — thu hẹp TRONG phạm vi uỷ NĐT (ra.investor_id=$1 giữ
  // scope, filter chỉ AND thêm trên bảng Tid). Tham số động $4+ để tránh SQL injection.
  const params: unknown[] = [investorId, start, end];
  const conds: string[] = [];
  if (Number.isInteger(input.bankId) && (input.bankId as number) > 0) { params.push(input.bankId); conds.push(`td.bank_id = $${params.length}`); }
  if (Number.isInteger(input.tidId) && (input.tidId as number) > 0) { params.push(input.tidId); conds.push(`td.id = $${params.length}`); }
  const hkdNeedle = typeof input.hkdName === 'string' ? input.hkdName.trim() : '';
  if (hkdNeedle !== '') { params.push(`%${hkdNeedle}%`); conds.push(`td.hkd_name ILIKE $${params.length}`); }
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT t.amount, t.phi_cai_may_milli, t.install_fee_amount, t.txn_date,
            to_char(l.bill_txn_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS bill_iso,
            to_char(t.txn_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS txn_iso,
            (CASE WHEN l.bill_txn_date IS NULL THEN -1 ELSE
              EXTRACT(HOUR FROM l.bill_txn_date AT TIME ZONE 'Asia/Ho_Chi_Minh') * 60 + EXTRACT(MINUTE FROM l.bill_txn_date AT TIME ZONE 'Asia/Ho_Chi_Minh') END)::int AS phut_hcm,
            td.tid, td.customer_id, td.invest_fee_milli tid_fee, td.hkd_name,
            COALESCE(NULLIF(bk.code, ''), bk.name) bank_name, bk.code AS bank_code, bk.name AS bank_ten_dai,
            l.bank_reported_lo_number so_lo, l.bill_key,
            l.id AS lo_id, plr.note AS lo_note
     FROM transactions t
     JOIN tids td ON td.id=t.tid_id
     JOIN receive_accounts ra ON ra.id=td.receive_account_id AND ra.investor_id=$1 AND ra.deleted_at IS NULL
     LEFT JOIN banks bk ON bk.id=td.bank_id
     LEFT JOIN los l ON l.transaction_id=t.id
     LEFT JOIN pos_lot_recon plr ON plr.lot_id = l.id
     WHERE t.status='POSTED' AND t.deleted_at IS NULL
       -- [Admin Demo 26/9 CHỐT] CÙNG MỐC với investorDailyReport = NGÀY TRÊN BILL. Trước đây màn này lọc theo
       -- txn_date nhưng cột ngày in bill_txn_date ⇒ chọn "hôm nay" vẫn thấy dòng đề ngày hôm qua.
       AND COALESCE(l.bill_txn_date, t.txn_date) >= $2::timestamptz
       AND COALESCE(l.bill_txn_date, t.txn_date) < $3::timestamptz${conds.length ? ' AND ' + conds.join(' AND ') : ''}
     ORDER BY bk.name, td.tid, t.txn_date`, ...params);
  // TÊN ĐẠI LÝ per-khách (Admin Demo 2/9): customer_id của TID → phòng chat ĐANG hoạt động (customer_chat_groups
  // unassigned_at IS NULL) → chat_rooms.name. CHỈ nhận khi khách map ĐÚNG 1 phòng (1-1); 0 hoặc >1 phòng → '' ('—').
  // Batch 2 query (KHÔNG N+1), gom theo customerId đã xuất hiện trong rows.
  const custIds = [...new Set(rows.map((r) => r.customer_id).filter((x: unknown): x is number => typeof x === 'number'))];
  const agentByCust = new Map<number, string>();
  if (custIds.length > 0) {
    const ccgs = await db.customerChatGroup.findMany({ where: { customerId: { in: custIds }, unassignedAt: null }, select: { customerId: true, roomId: true } });
    const roomsByCust = new Map<number, string[]>();
    for (const g of ccgs) { if (g.roomId == null) continue; const a = roomsByCust.get(g.customerId) ?? []; a.push(g.roomId); roomsByCust.set(g.customerId, a); }
    const roomIds = [...new Set(ccgs.map((g) => g.roomId).filter((x): x is string => x != null))];
    const rooms = roomIds.length > 0 ? await db.chatRoom.findMany({ where: { id: { in: roomIds } }, select: { id: true, name: true } }) : [];
    const roomName = new Map(rooms.map((r) => [r.id, r.name]));
    for (const [cid, rids] of roomsByCust) {
      if (rids.length === 1) { const nm = roomName.get(rids[0]!); if (nm) agentByCust.set(cid, nm); } // ĐÚNG 1 phòng → tên đại lý; else để trống
    }
  }
  // Số lô trên BILL = đoạn thứ 3 của billKey (đồng nhất billLoOf ở chat-room-tid-service). '?'/rỗng/amt: → ''.
  const billLoOf = (billKey: string | null): string => {
    const m = /^(?:nat|VL)\|[^|]*\|([^|]*)\|/.exec(billKey ?? '');
    const b = m?.[1]?.trim();
    return b && b !== '?' && !b.startsWith('amt:') ? b : '';
  };
  const bills: InvestorDetailBill[] = [];
  const tidMap = new Map<string, InvestorDetailTidSum>();
  let tTruoc = 0, tSau = 0, tLai = 0, tTienVe = 0;
  for (const r of rows) {
    // [GÓI TZ 11/9] cutoff + fallback display dùng txn_iso THẬT (raw-read Date lệch +7h trên cột instant-thật).
    if (isBeforeCutoff(cutoffs, investorId, r.txn_iso ? new Date(r.txn_iso) : null)) continue; // trước mốc chốt → không tính
    // [Lọc CA 11/9] ca theo GIỜ BILL THẬT (los.bill_txn_date, phut_hcm=-1 nếu thiếu → loại); bank ngoài bảng mốc → loại.
    // [B174 16/11] HIỂN THỊ dùng mã viết tắt, nhưng KHOÁ TRA CA phải thử MÃ rồi mới tới TÊN:
    //  - sổ thật: `bk.name` là tên pháp nhân ("NH TMCP Quân đội MB") ⇒ khoaBankCa(name) = null cho CẢ BA
    //    ngân hàng ⇒ lọc ca loại sạch giao dịch (lỗi CÂM, đo thật 16/11);
    //  - bản ghi/bộ dựng khác: mã là chuỗi sinh tự động, dấu hiệu ngân hàng nằm ở TÊN ("MBV …").
    //  Chỉ 1 trong 2 là không đủ ⇒ `khoaBankCaTu`. Bank ngoài bảng mốc vẫn null ⇒ vẫn loại (không gán ca bừa).
    if (input.ca != null && caCuaPhut(khoaBankCaTu(r.bank_code, r.bank_ten_dai), Number(r.phut_hcm)) !== input.ca) continue;
    const amount = Number(r.amount);
    // Admin Demo 26/8: "Phí CM" = PHÍ CÀI MÁY (không phải phí bán); "Sau phí CM" = tiền về (amount − phí cài máy, floor).
    const pcm = Math.min(100000, Number(r.phi_cai_may_milli || 0));
    const phiMilli = pcm;
    // install_fee_amount >0 (lô đa-thẻ, Σ phí cài per-thẻ ĐÚNG) → tiền về = amount − cột (100% đúng đồng); else rate cũ.
    const ifa = BigInt(r.install_fee_amount ?? 0);
    const sauPhi = ifa > 0n ? amount - Number(ifa) : Number(tienVeForTxn(BigInt(amount), pcm));
    const eff = Number(r.tid_fee ?? invDefault);
    const lai = Number(laiForTxn(BigInt(sauPhi), eff)); // Admin Demo 31/8: lãi NĐT 0.1% TRÊN TIỀN VỀ (sauPhi = amount − phí cài máy), KHÔNG trên gross.
    tTienVe += sauPhi;
    const tid = String(r.tid);
    const agentName = typeof r.customer_id === 'number' ? (agentByCust.get(r.customer_id) ?? '') : '';
    // [TZ 11/9 — Agent 4] GIỜ hiển thị bill = los.bill_txn_date (raw-ISO ghi ĐÚNG instant, đọc qua to_char UTC text
    // để né bẫy $queryRaw đọc timestamptz lệch +7h). txn_date là cột Prisma ghi (bệnh −7h, prod trộn 2 quần thể
    // −7h/đúng) → CHỈ fallback khi GD không có lô (QR/thủ công) — giữ nguyên hành vi cũ cho nhóm đó.
    const txnDateIso = (r.bill_iso as string | null) ?? (r.txn_iso as string);
    bills.push({ tid, bankName: r.bank_name || '', hkdName: r.hkd_name || '', soLo: r.so_lo != null ? String(r.so_lo) : '', billLoNumber: billLoOf(r.bill_key ?? null), loId: r.lo_id != null ? Number(r.lo_id) : null, note: (r.lo_note as string | null) ?? null, txnDateIso, amount, phiMilli, sauPhi, effMilli: eff, lai, agentName });
    let s = tidMap.get(tid); if (!s) { s = { bank: r.bank_name || '', tid, hkd: r.hkd_name || '', n: 0, truoc: 0, sau: 0, lai: 0 }; tidMap.set(tid, s); }
    s.n++; s.truoc += amount; s.sau += sauPhi; s.lai += lai;
    tTruoc += amount; tSau += sauPhi; tLai += lai;
  }
  // Danh sách tạm ứng (để bảng "ĐÃ ỨNG" kiểm soát) + tổng đã nhận.
  // [TZ 11/9 — Agent 4] advance_iso = to_char UTC text (instant LƯU THẬT trong DB — với hàng nhập tay date-only /
  // OCR ingest, stored = đúng nửa đêm HCM ngày ứng) → hiển thị đúng NGÀY. Đường cũ new Date(advance_date) dính bẫy
  // $queryRaw đọc +7h → hàng có GIỜ tối (≥17:00) hiển thị lệch sang NGÀY HÔM SAU. Cutoff so bằng advance_date đọc
  // raw (+7h trên stored) — GIỮ NGUYÊN hành vi cũ cho cutoff (đổi đồng bộ ở lượt chuẩn hoá TZ, không đổi lẻ ở đây).
  const advList = await db.$queryRawUnsafe<{ advance_date: Date; advance_iso: string; sender_name: string | null; receiver_name: string | null; amount: bigint; source: string }[]>(
    `SELECT advance_date, to_char(advance_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS advance_iso, sender_name, receiver_name, amount, source FROM investor_advances WHERE investor_id=$1 AND deleted_at IS NULL AND advance_date >= $2::timestamptz AND advance_date < $3::timestamptz ORDER BY advance_date`, investorId, start, end);
  const advances = advList
    .filter((a) => !isBeforeCutoff(cutoffs, investorId, a.advance_iso ? new Date(a.advance_iso) : null)) // loại tạm ứng trước mốc chốt — [GÓI TZ] so bằng ISO thật
    .map((a) => ({ advanceDateIso: a.advance_iso ?? new Date(a.advance_date).toISOString(), senderName: a.sender_name ?? '', receiverName: a.receiver_name ?? '', amount: Number(a.amount), source: a.source }));
  // HIGH-2 FIX (Agent-6 1/9): daNhan = CHỈ tạm ứng (NĐT→SigMa); REPAYMENT (SigMa→NĐT hoàn thừa) NGƯỢC CHIỀU → KHÔNG
  // gộp vào daNhan mà TRỪ ở thuaThieu (đồng nhất settlement phaiTra = tamUng − tienVe − daHoan). Trước đây gộp REPAYMENT
  // (amount dương) → daNhan phồng + thuaThieu sai dấu khi có hoàn thừa. (Hiện 0 dòng REPAYMENT — latent.)
  const daNhan = advances.filter((a) => a.source !== 'REPAYMENT').reduce((s, a) => s + a.amount, 0);
  const daHoanThua = advances.filter((a) => a.source === 'REPAYMENT').reduce((s, a) => s + a.amount, 0);
  return { ok: true, data: { investorId, investorName: inv.nickname || inv.fullName, from: input.from, to: input.to, bills, tidSummary: [...tidMap.values()], advances, totals: { truoc: tTruoc, sau: tSau, lai: tLai, tienVe: tTienVe, daNhan, thuaThieu: (daNhan - daHoanThua) - tTienVe } } };
}
