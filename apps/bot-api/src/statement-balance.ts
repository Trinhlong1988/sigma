// [Admin Demo 12/9 — TRA SOÁT SỐ DƯ] "tra soát sao kê phải có tổng số dư cuối ngày, số dư từng tài khoản của alpha,
// số tổng này phải khớp = số tiền phải hoàn lại NĐT (bao gồm lãi NĐT, tiền sau phí cài máy) của tất cả các NĐT
// + lãi của công ty. thừa hay thiếu phải có ô báo số thừa, thiếu chi tiết để tìm tiền."
//
// Nguồn SỐ DƯ: cột "Số dư" (running balance) của sao kê đã nạp (statement_txn.balance) — số dư CUỐI NGÀY của 1 TK
// = balance của GD CUỐI CÙNG ≤ 23:59 ngày đó (date_time text ISO wall-clock → so sánh chuỗi đúng thứ tự thời gian).
// Nguồn PHẢI CÓ (kỳ vọng): công thức CHÍNH CHỦ Admin Demo — Σ_NĐT(tiền về sau phí cài máy + lãi NĐT) + lãi công ty
// (Σ revenue_sell POS+QR). TÁI DÙNG tienVePos/laiForTxn/effInvestFee (per-GD rounding, y hệt alpha-aggregate —
// CẤM chép công thức mới). Lệch = tổng số dư − phải có; kèm chi tiết từng NĐT để tìm tiền.
import { investorDailySettlement } from '@sigma/services';
import { qrSplitByInvestor, type QrInvestorSplit } from './investor-qr-split.js';
import type { AuthUser } from '@sigma/shared';
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

export interface BalanceAccountRow {
  account: string; bank: string | null; holder: string | null;
  balance: number;        // số dư cuối ngày (VND)
  asOf: string | null;    // thời điểm GD cuối có số dư (ISO wall-clock) — stale (< ngày chọn) để người xem tự thấy
  stale: boolean;         // true = GD cuối KHÔNG thuộc ngày chọn (số dư mang từ ngày trước — sao kê ngày đó chưa nạp)
}
export interface BalanceInvestorRow { investorId: number; name: string; tamUng: number; tienVe: number; laiNdt: number; phaiHoan: number }
/** [Admin Demo 13/9 "tách riêng QR"] NĐT mã QR: trả SigMa theo phí mua, KHÔNG tạm ứng. */
export interface BalanceQrRow { investorId: number; name: string; gross: number; phiMuaGiu: number; traAlpha: number; soBill: number }
export interface BalanceCheckResult {
  day: string;
  accounts: BalanceAccountRow[];
  tongSoDu: number;
  coSoDu: boolean;             // false = chưa có TK nào có cột số dư trong cache (file cũ / thiếu cột)
  investors: BalanceInvestorRow[];
  /** NĐT QR tách riêng: quẹt / giữ phí mua / TRẢ VỀ SigMa (không cộng vào tongPhaiHoanNdt). */
  investorsQr: BalanceQrRow[];
  tongNdtQrTraVe: number;      // Σ NĐT QR phải trả về SigMa (= quẹt − phí mua)
  tongPhaiHoanNdt: number;     // Σ (tạm ứng − tiền về POS sau phí cài máy + lãi POS) — CHỈ POS, QR đã tách
  laiCongTy: number;           // Σ revenue_sell POS+QR trong ngày
  phaiCo: number;              // tongPhaiHoanNdt + laiCongTy
  lech: number;                // tongSoDu − phaiCo (>0 thừa, <0 thiếu)
}

const HCM_MS = 7 * 60 * 60 * 1000;

/** Đối chiếu số dư cuối ngày `day` (YYYY-MM-DD, ngày HCM) vs Σ phải hoàn NĐT + lãi công ty của CHÍNH ngày đó. */
export async function buildBalanceCheck(db: Db, day: string): Promise<BalanceCheckResult> {
  // ── (1) SỐ DƯ CUỐI NGÀY từng TK: GD cuối cùng có balance ≤ hết ngày (date_time ISO text → so chuỗi). ──
  const accRows = await db.$queryRawUnsafe<{ account: string; bank: string | null; holder: string | null; balance: bigint; as_of: string | null }[]>(
    `SELECT DISTINCT ON (src_account) src_account AS account, src_bank AS bank, src_holder AS holder,
            balance, date_time AS as_of
       FROM statement_txn
      WHERE balance IS NOT NULL AND src_account IS NOT NULL AND date_time IS NOT NULL AND date_time <= $1
      ORDER BY src_account, date_time DESC, updated_at DESC`, `${day}T23:59:59`);
  const byAcc = new Map<string, BalanceAccountRow>();
  for (const r of accRows) {
    byAcc.set(r.account, {
      account: r.account, bank: r.bank, holder: r.holder,
      balance: Number(r.balance), asOf: r.as_of,
      stale: (r.as_of ?? '').slice(0, 10) !== day
    });
  }
  // [Admin Demo 13/9 "tra soát chưa có số dư cuối kì"] NGUỒN 2: số dư CUỐI KỲ mức tài khoản (dòng tổng "Số dư cuối
  // kỳ" của file — file không có cột Số dư per-GD vẫn ra số). Per-txn thắng khi ngày của nó MỚI HƠN HOẶC BẰNG.
  try {
    const accLevel = await db.$queryRawUnsafe<{ account: string; bank: string | null; holder: string | null; closing: bigint; as_of_day: string }[]>(
      `SELECT account, bank, holder, closing, as_of_day FROM statement_account_balance WHERE as_of_day <= $1`, day);
    for (const r of accLevel) {
      const cu = byAcc.get(r.account);
      if (cu && (cu.asOf ?? '').slice(0, 10) >= r.as_of_day) continue; // per-txn mới hơn/bằng → giữ
      byAcc.set(r.account, {
        account: r.account, bank: r.bank, holder: r.holder,
        balance: Number(r.closing), asOf: `${r.as_of_day}T23:59:00`,
        stale: r.as_of_day !== day
      });
    }
  } catch (e) { console.error('[balance-check] đọc số dư cuối kỳ mức TK lỗi (bỏ nguồn 2, không chặn):', e instanceof Error ? e.message : e); }
  const accounts = [...byAcc.values()].sort((a, b) => b.balance - a.balance);
  const tongSoDu = accounts.reduce((s, a) => s + a.balance, 0);

  // ── (2) PHẢI HOÀN NĐT trong ngày — [Admin Demo 13/9 "là số đã tạm ứng − sau phí cm + lãi chứ"] TÁI DÙNG
  //    investorDailySettlement (nguồn DUY NHẤT: tamUng gộp + tienVe/lãi per-GD + cutoff — CẤM chép công thức).
  //    phaiHoan = tạm ứng − tiền về (sau phí cài máy) + lãi NĐT, GIỮ DẤU (không trừ đã-hoàn — ô đối chiếu số dư
  //    xem tổng nghĩa vụ; đã-hoàn nằm trong biến động số dư). ──
  const from = new Date(Date.parse(`${day}T00:00:00.000Z`) - HCM_MS);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  const SYS_USER: AuthUser = { id: 0, username: 'sigma', fullName: 'SigMa', status: 'ACTIVE', forceChangePassword: false, roles: [], permissions: ['REVENUE_VIEW', 'INVESTOR_VIEW'] };
  const st = await investorDailySettlement({ db, user: SYS_USER }, { from: day, to: day });
  if (!st.ok) throw new Error(st.message ?? st.error ?? 'Không tính được tất toán NĐT');
  // [Admin Demo 13/9 "tách riêng QR — trả theo phí bán mua, không tạm ứng"] settlement cộng TID QR như POS →
  // TRỪ phần QR per-GD (đúng từng đồng, kể cả NĐT hỗn hợp) rồi mới áp công thức tạm ứng. QR hiện khối riêng.
  const qr = await qrSplitByInvestor(db, from, to);
  const investors: BalanceInvestorRow[] = (st.data ?? [])
    .map((r) => {
      const q = qr.get(r.investorId);
      const tienVePos = r.tienVe - (q?.tvTrongReport ?? 0);
      const laiPos = r.laiNDT - (q?.laiTrongReport ?? 0);
      return { investorId: r.investorId, name: r.investorName, tamUng: r.tamUng, tienVe: tienVePos, laiNdt: laiPos, phaiHoan: r.tamUng - tienVePos + laiPos };
    })
    .filter((r) => r.tamUng !== 0 || r.tienVe !== 0 || r.laiNdt !== 0)
    .sort((a, b) => b.phaiHoan - a.phaiHoan);
  const tongPhaiHoanNdt = investors.reduce((s, r) => s + r.phaiHoan, 0);
  const investorsQr: BalanceQrRow[] = [...qr.values()]
    .map((q: QrInvestorSplit) => ({ investorId: q.investorId, name: q.name, gross: q.gross, phiMuaGiu: q.partner, traAlpha: q.traAlpha, soBill: q.soBill }))
    .sort((a, b) => b.traAlpha - a.traAlpha);
  const tongNdtQrTraVe = investorsQr.reduce((s, r) => s + r.traAlpha, 0);

  // ── (3) LÃI CÔNG TY trong ngày = Σ revenue_sell (POS: bán−càiMáy; QR: bán−mua weekend-đã-chốt). ──
  const lct = await db.$queryRawUnsafe<{ rs: bigint | null }[]>(
    `SELECT COALESCE(SUM(t.revenue_sell),0)::bigint AS rs FROM transactions t
      WHERE t.status='POSTED' AND t.deleted_at IS NULL AND t.txn_date >= $1::timestamptz AND t.txn_date < $2::timestamptz`,
    from.toISOString(), to.toISOString());
  const laiCongTy = Number(lct[0]?.rs ?? 0);

  const phaiCo = tongPhaiHoanNdt + laiCongTy;
  return {
    day, accounts, tongSoDu, coSoDu: accounts.length > 0,
    investors, investorsQr, tongNdtQrTraVe, tongPhaiHoanNdt, laiCongTy, phaiCo,
    lech: tongSoDu - phaiCo
  };
}
