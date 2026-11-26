// [Admin Demo 13/9 "tách riêng QR — NĐT này trả tiền theo phí bán mua của NĐT, không tạm ứng"]
// NĐT mã QR KHÔNG theo mô hình tạm ứng POS: tiền quẹt về TK NĐT trọn, NĐT GIỮ PHÍ MUA (0.85% thường / 0.9% cuối
// tuần — revenue_partner đã chốt vào GD) và TRẢ SIGMA phần còn lại = amount − revenue_partner (đúng luật
// alpha-aggregate "HOÀN NĐT (QR)"). Helper này tách phần QR per-NĐT để:
//   • TRỪ khỏi tổng settlement (investorDailyReport cộng TID QR vào tienVe/lãi y như POS → công thức tạm ứng
//     bị âm oan — ca Anh Quốc −224.985.000). tvTrongReport/laiTrongReport tính per-GD Y HỆT investor-report
//     (ifa>0 ? amount−ifa : tienVeForTxn; laiForTxn(tv, effFee)) → trừ đúng từng đồng, kể cả NĐT HỖN HỢP
//     (NĐT 2: 1 TID QR + 35 POS).
//   • Hiện khối QR riêng: quẹt / giữ phí mua / trả về SigMa.
import { laiForTxn, tienVeForTxn } from '@sigma/services';
import { effInvestFee } from './routes/alpha-aggregate.js';
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

export interface QrInvestorSplit {
  investorId: number;
  name: string;
  gross: number;          // Σ số quẹt QR trong kỳ
  partner: number;        // Σ revenue_partner = phí mua NĐT GIỮ (0.85/0.9 đã chốt per-GD)
  traAlpha: number;       // gross − partner = NĐT PHẢI TRẢ SigMa
  soBill: number;
  tvTrongReport: number;  // phần tiền-về mà investorDailyReport ĐÃ cộng cho các GD QR này (để trừ ra)
  laiTrongReport: number; // phần lãi report ĐÃ cộng cho các GD QR này (để trừ ra)
}

/** Tách phần QR per-NĐT trong cửa sổ [from, to) — from/to là INSTANT (đã quy đổi biên ngày HCM ở caller). */
export async function qrSplitByInvestor(db: Db, from: Date, to: Date): Promise<Map<number, QrInvestorSplit>> {
  const rows = await db.$queryRawUnsafe<{ inv: number; name: string | null; amount: bigint; rp: bigint; pcm: number | null; ifa: bigint | null; tidfee: number | null; invfee: number | null }[]>(
    `SELECT ra.investor_id AS inv, COALESCE(NULLIF(iv.nickname,''), iv.full_name) AS name,
            t.amount AS amount, COALESCE(t.revenue_partner, 0) AS rp,
            t.phi_cai_may_milli AS pcm, t.install_fee_amount AS ifa,
            td.invest_fee_milli AS tidfee, iv.invest_fee_milli AS invfee
       FROM transactions t
       JOIN tids td ON td.id = t.tid_id AND td.kind = 'QR'
       JOIN receive_accounts ra ON ra.id = td.receive_account_id AND ra.deleted_at IS NULL AND ra.investor_id IS NOT NULL
       JOIN investors iv ON iv.id = ra.investor_id
       LEFT JOIN los l ON l.transaction_id = t.id
      WHERE t.status = 'POSTED' AND t.deleted_at IS NULL
        -- [Admin Demo 26/9 "lấy ngày trên bill làm chuẩn"] PHẢI cùng mốc kỳ với investorDailyReport: số của hàm
        -- này bị TRỪ khỏi số đó (tvTrongReport/laiTrongReport). Lệch mốc ⇒ trừ nhầm GD ⇒ sai CẢ HAI CHIỀU
        -- (GD bill-hôm-sau bị report bỏ nhưng vẫn bị trừ, và ngược lại). Xem test bao-cao-ndt-theo-ngay-bill.
        AND COALESCE(l.bill_txn_date, t.txn_date) >= $1::timestamptz
        AND COALESCE(l.bill_txn_date, t.txn_date) < $2::timestamptz`,
    from.toISOString(), to.toISOString());
  const out = new Map<number, QrInvestorSplit>();
  for (const r of rows) {
    const cur = out.get(r.inv) ?? { investorId: r.inv, name: r.name ?? `NĐT ${r.inv}`, gross: 0, partner: 0, traAlpha: 0, soBill: 0, tvTrongReport: 0, laiTrongReport: 0 };
    out.set(r.inv, cur);
    const amount = BigInt(r.amount);
    cur.gross += Number(amount);
    cur.partner += Number(r.rp);
    cur.soBill += 1;
    const ifa = BigInt(r.ifa ?? 0);
    const tv = ifa > 0n ? amount - ifa : tienVeForTxn(amount, Number(r.pcm ?? 0));
    cur.tvTrongReport += Number(tv);
    cur.laiTrongReport += Number(laiForTxn(tv, effInvestFee(r.tidfee, r.invfee)));
  }
  for (const v of out.values()) v.traAlpha = v.gross - v.partner;
  return out;
}
