// BÁO CÁO TỔNG GỘP SIGMA (Admin Demo 5/9) — CHỈ 3 chủ SigMa. Tổng doanh số POS+QR (TÁCH cột) + hoàn + LÃI, theo NĐT & Đại lý.
// LỚP LIVE = bot-api (8788). requireSession + requireAlphaOwner (403 nếu không phải chủ). KHÔNG desktop.
//
// NGUỒN (TÁI DÙNG attribution CHUẨN, KHÔNG viết lại công thức tiền):
//  • Doanh số: 1 NGUỒN = bảng `transactions` (POSTED, chưa xóa) — POS vs QR TÁCH theo `tids.kind` ('QR' vs còn lại).
//    - per-NĐT: tid.receive_account_id → receive_accounts.investor_id (Y HỆT investor-report.ts).
//    - per-đại-lý POS: tid.customer_id → customer_chat_groups(active) → room (Y HỆT getRoomRevenueReport room→khách→tid).
//    - per-đại-lý QR: transactions.qr_dealer_room_id (đại lý CHỌN lúc gửi — QR tid không gán customerId, invariant I3).
//    ⚠️ HỎI LEAD: em dùng `transactions` cho CẢ dealer-POS (thay vì lo_rows LEAD nêu) để byNĐT+byĐL+totals KHỚP tuyệt
//    đối (transaction.amount = Σ lo_row cho bill đã bridge; QR chỉ có transactions). ĐÁNH ĐỔI: Lô POS CHƯA bridge (lỗi
//    best-effort) nằm ở lo_rows mà chưa có transaction → bị THIẾU ở đây (nên chạy reconcileUnbridgedLos định kỳ). Nếu
//    LEAD muốn gồm cả unbridged → chuyển dealer-POS sang lo_rows (nhưng khi đó totals dealer≠investor khi có gap).
//  • Hoàn: tin chat metadata — hoàn đại lý POS/CK (`isDealerRefundCk`, refundAmount signed) + hoàn QR (`isQrRefundCk`).
//    Dedup theo ckTxnKey/qrRefundKey. Lọc theo billDate (ngày trên bill) trong kỳ. ADVANCE (ứng) KHÔNG tính là hoàn.
//    ⚠️ HỎI LEAD: byInvestor.hoan — NĐT KHÔNG nhận "hoàn tiền" như đại lý. Em diễn giải = HOÀN THỪA TẠM ỨNG
//    (investor_advances source='REPAYMENT', SigMa→NĐT — khái niệm có sẵn ở investor-report daHoanThua). Hiện thường 0.
//    Nếu LEAD muốn nghĩa khác (vd 0/không hiển thị) → chỉnh 1 dòng.
//  • NGÀY/kỳ theo Asia/Ho_Chi_Minh (floor nửa đêm HCM tường minh — chống incident NĐT underscount lệch TZ).
//
// LÃI (Admin Demo 5/9 — v2):
//  • Lãi Công ty = Σ revenue_sell (POS: CL_KH = phiBan−phiCaiMay; QR: spread = phiBan−phiMua). TÁCH POS/QR ở totals.
//  • Lãi NĐT:
//      - QR: = revenue_partner (= GIÁ MUA, NĐT giữ). Đã CHỐT sẵn trên GD → chỉ tổng SUM, KHÔNG tính lại.
//      - POS: = Σ per-txn laiForTxn(tienVe, effInvestFeeMilli) — TÁI DÙNG ĐÚNG công thức investor-report.ts
//        (tienVe = amount − phí cài máy; eff = tid.invest_fee_milli ?? investor.invest_fee_milli; 0.1% mặc định).
//        laiForTxn/tienVeForTxn EXPORT từ investor-report (1 nguồn công thức — KHÔNG viết lại, R "cấm suy luận money").
//    ⚠️ HỎI LEAD (money-semantics): lãi NĐT POS ở ĐÂY KHÔNG áp MỐC CHỐT (investor cutoffs) — nhất quán với doanh số
//    (doanh số cũng không trừ mốc chốt). Báo cáo tất toán NĐT (investor-report) MỚI áp cutoff. Nếu LEAD muốn Tổng gộp
//    cũng trừ mốc chốt → nói, em thêm loadInvestorCutoffs + isBeforeCutoff (đụng cả doanh số để nhất quán).
import { Router, type Request, type Response } from 'express';
import { requireSession } from '../session-middleware.js';
import { requireAlphaOwner } from '../alpha-owner.js';
import { getBotDb } from '../db.js';
import { asyncHandler } from '../async-handler.js';
import { laiForTxn, tienVeForTxn } from '@sigma/services';

export const alphaAggregateRouter = Router();

/** Nửa đêm 00:00 LOCAL Asia/Ho_Chi_Minh (UTC+7, không DST) của NGÀY chứa `d`. COPY chuẩn qr-fee-config/fee-config. */
function startOfDayLocalHCM(d: Date): Date {
  const HCM = 7 * 60 * 60 * 1000;
  const w = new Date(d.getTime() + HCM);
  return new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) - HCM);
}
/** Ngày HCM "YYYY-MM-DD" của 1 thời điểm. */
function hcmDay(d: Date): string {
  const h = new Date(d.getTime() + 7 * 3600_000);
  return `${h.getUTCFullYear()}-${String(h.getUTCMonth() + 1).padStart(2, '0')}-${String(h.getUTCDate()).padStart(2, '0')}`;
}
/** Parse 1 mốc: ISO instant HOẶC "YYYY-MM-DD" (→ nửa đêm HCM ngày đó). null nếu không hợp lệ. Export để test khẳng
 *  định mapping YYYY-MM-DD → nửa đêm HCM (preset Hôm nay/Hôm qua ở UI dựa vào quy ước này). */
export function parseBound(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (md) {
    // [deep-audit C3-agent3] round-trip validate: Date.UTC CUỘN TRÀN ngày lịch không hợp lệ (2026-02-31→03-02,
    // 2026-13-01→2027-01) → báo cáo tiền lệch KỲ ÂM THẦM. Khẳng định y/m/d khớp lại (như parseLocalDay investor-report).
    const y = Number(md[1]), mo = Number(md[2]), da = Number(md[3]);
    const u = new Date(Date.UTC(y, mo - 1, da, 12));
    if (u.getUTCFullYear() !== y || u.getUTCMonth() !== mo - 1 || u.getUTCDate() !== da) return null;
    return startOfDayLocalHCM(u);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** effInvestFeeMilli theo `??` (investor-report): override TID (kể cả 0) THẮNG mặc định NĐT; cả 2 null → 0. */
export function effInvestFee(tidFee: number | null, invFee: number | null): number {
  if (tidFee != null) return tidFee;
  if (invFee != null) return invFee;
  return 0;
}
/** Tiền về 1 GD POS (VND): lô đa-thẻ có install_fee_amount>0 → amount − cột (đúng từng đồng); else theo rate phí cài máy. */
export function tienVePos(amount: bigint, installFeeAmount: bigint, phiCaiMayMilli: number): bigint {
  return installFeeAmount > 0n ? amount - installFeeAmount : tienVeForTxn(amount, phiCaiMayMilli);
}

interface InvAgg { pos: number; qr: number; hoan: number; laiPos: number; laiQr: number; }
const emptyInvAgg = (): InvAgg => ({ pos: 0, qr: 0, hoan: 0, laiPos: 0, laiQr: 0 });
interface DealerAgg { pos: number; qr: number; hoan: number; }
const emptyDealerAgg = (): DealerAgg => ({ pos: 0, qr: 0, hoan: 0 });

export interface AlphaAggInvestorRow {
  investorId: number; name: string; doanhSoPos: number; doanhSoQr: number; tong: number; hoan: number;
  laiNdtPos: number; laiNdtQr: number; laiNdt: number;
}
export interface AlphaAggDealerRow {
  dealerId: string; name: string; doanhSoPos: number; doanhSoQr: number; tong: number; hoan: number;
}
export interface AlphaAggregateReport {
  from: string; to: string;
  byInvestor: AlphaAggInvestorRow[];
  byDealer: AlphaAggDealerRow[];
  // Hoàn TÁCH RÕ (Admin Demo 5/9): tongHoanDaiLy = Σ SigMa hoàn đại lý (POS/CK + QR); tongHoanNDT = Σ NĐT trả SigMa (QR).
  // LÃI: laiCongTy = Σ revenue_sell (biên SigMa giữ); laiNDT = Σ (QR giá mua + POS 0.1% tiền về). TÁCH POS/QR.
  totals: {
    doanhSoPos: number; doanhSoQr: number; tongDoanhSo: number; tongHoanDaiLy: number; tongHoanNDT: number;
    laiCongTyPos: number; laiCongTyQr: number; laiCongTy: number;
    laiNdtPos: number; laiNdtQr: number; laiNdt: number;
  };
  detail?: AlphaAggregateDetail; // CHỈ khi lọc 1 NĐT/đại lý (investorId | dealerId).
  /** [Nợ C4a 11/9 — R198 hết lệch câm] NĐT có MỐC CHỐT nằm TRONG kỳ xem: số ở đây là DÒNG TIỀN TRỌN KỲ (không cắt
   *  trước mốc — ngữ nghĩa cố ý), sẽ KHÁC báo cáo tất toán NĐT (đã cắt). Kêu to để người xem không so nhầm. */
  cutoffWarnings?: string[];
}

// ── CHI TIẾT (drill-down 1 entity) ─────────────────────────────────────────────────────────────────────
export interface AlphaAggregateDetailRow {
  txnDateIso: string; hkdName: string; kind: 'POS' | 'QR'; amount: number;
  // NĐT view (null cho POS ở cột QR-only): giaMua = revenue_partner (QR); ndtTraAlpha = amount − giá mua (QR).
  giaMua: number | null; ndtTraAlpha: number | null; laiNdt: number | null;
  // Đại lý view: phiBan = QR revenue_amount (=amount×phiBan/100000); daiLyHoan = amount − phiBan (QR). POS = null
  //   (hoàn POS/CK là theo TIN CHAT, không per-GD → xem `refunds`).
  phiBan: number | null; daiLyHoan: number | null;
}
export interface AlphaAggregateDetail {
  entityKind: 'investor' | 'dealer';
  entityId: string; // investorId (string hoá) hoặc roomId
  name: string;
  rows: AlphaAggregateDetailRow[];
  // Hoàn POS/CK theo TIN CHAT cho đại lý (POS không suy được per-GD) — để tổng hoàn detail KHỚP summary.
  refunds: { billDate: string; amount: number }[];
  totals: { amountPos: number; amountQr: number; amount: number; laiNdt: number; hoan: number };
}

/** Dựng báo cáo tổng gộp trong kỳ [from, to). Export để test gọi trực tiếp (không qua HTTP). */
export async function buildAlphaAggregate(from: Date, to: Date): Promise<AlphaAggregateReport> {
  const db = getBotDb();
  const fromIso = from.toISOString(), toIso = to.toISOString();

  // ── DOANH SỐ + Lãi NĐT QR per-NĐT (transactions → tid → receive_account.investor_id), TÁCH POS/QR theo tids.kind. ──
  const invRows = await db.$queryRawUnsafe<{ inv: number; kind: string | null; gross: bigint; rpartner: bigint }[]>(
    `SELECT ra.investor_id AS inv, td.kind AS kind, COALESCE(SUM(t.amount),0)::bigint AS gross,
            COALESCE(SUM(t.revenue_partner),0)::bigint AS rpartner
     FROM transactions t
     JOIN tids td ON td.id = t.tid_id
     JOIN receive_accounts ra ON ra.id = td.receive_account_id AND ra.deleted_at IS NULL AND ra.investor_id IS NOT NULL
     LEFT JOIN los l ON l.transaction_id = t.id
     WHERE t.status='POSTED' AND t.deleted_at IS NULL AND COALESCE(l.bill_txn_date, t.txn_date) >= $1::timestamptz AND COALESCE(l.bill_txn_date, t.txn_date) < $2::timestamptz
     GROUP BY ra.investor_id, td.kind`, fromIso, toIso);
  const byInv = new Map<number, InvAgg>();
  for (const r of invRows) {
    const a = byInv.get(r.inv) ?? emptyInvAgg(); byInv.set(r.inv, a);
    if (r.kind === 'QR') { a.qr += Number(r.gross); a.laiQr += Number(r.rpartner); } // Lãi NĐT QR = giá mua = revenue_partner
    else a.pos += Number(r.gross);
  }

  // ── Lãi NĐT POS per-GD (rounding từng GD → KHÔNG group SQL) — TÁI DÙNG laiForTxn/tienVeForTxn. ──
  const invPosLai = await db.$queryRawUnsafe<{ inv: number; amount: bigint; pcm: number | null; ifa: bigint | null; tidfee: number | null; invfee: number | null }[]>(
    `SELECT ra.investor_id AS inv, t.amount AS amount, t.phi_cai_may_milli AS pcm, t.install_fee_amount AS ifa,
            td.invest_fee_milli AS tidfee, iv.invest_fee_milli AS invfee
     FROM transactions t
     JOIN tids td ON td.id = t.tid_id AND (td.kind IS NULL OR td.kind <> 'QR')
     JOIN receive_accounts ra ON ra.id = td.receive_account_id AND ra.deleted_at IS NULL AND ra.investor_id IS NOT NULL
     JOIN investors iv ON iv.id = ra.investor_id
     LEFT JOIN los l ON l.transaction_id = t.id
     WHERE t.status='POSTED' AND t.deleted_at IS NULL AND COALESCE(l.bill_txn_date, t.txn_date) >= $1::timestamptz AND COALESCE(l.bill_txn_date, t.txn_date) < $2::timestamptz`, fromIso, toIso);
  for (const r of invPosLai) {
    const a = byInv.get(r.inv) ?? emptyInvAgg(); byInv.set(r.inv, a);
    const amount = BigInt(r.amount);
    const tv = tienVePos(amount, BigInt(r.ifa ?? 0), Number(r.pcm ?? 0));
    a.laiPos += Number(laiForTxn(tv, effInvestFee(r.tidfee, r.invfee)));
  }

  // ── DOANH SỐ POS per-đại-lý (transactions → tid.customer_id → customer_chat_groups(active) → room). ──
  // [deep-audit C1-agent3] CHỐNG ĐẾM ĐÔI: 1 khách gán ≥2 phòng active → JOIN sinh N dòng/GD → SUM cộng full amount cho
  // MỖI phòng (Σ byDealer > totals). Fix: CTE chọn ĐÚNG 1 phòng/khách (DISTINCT ON, deterministic theo room_id) → mỗi
  // khách chỉ đóng góp doanh số cho 1 phòng. (Khách=đại lý 1-1; ≥2 phòng là bất thường data — pick ổn định, Σ khớp totals.)
  const dealerPosRows = await db.$queryRawUnsafe<{ room: string; gross: bigint }[]>(
    `WITH cust_room AS (
       SELECT DISTINCT ON (customer_id) customer_id, room_id
       FROM customer_chat_groups WHERE unassigned_at IS NULL AND room_id IS NOT NULL
       ORDER BY customer_id, room_id
     )
     SELECT cr.room_id AS room, COALESCE(SUM(t.amount),0)::bigint AS gross
     FROM transactions t
     JOIN tids td ON td.id = t.tid_id AND (td.kind IS NULL OR td.kind <> 'QR') AND td.customer_id IS NOT NULL
     JOIN cust_room cr ON cr.customer_id = td.customer_id
     LEFT JOIN los l ON l.transaction_id = t.id
     WHERE t.status='POSTED' AND t.deleted_at IS NULL AND COALESCE(l.bill_txn_date, t.txn_date) >= $1::timestamptz AND COALESCE(l.bill_txn_date, t.txn_date) < $2::timestamptz
     GROUP BY cr.room_id`, fromIso, toIso);
  const byDealer = new Map<string, DealerAgg>();
  for (const r of dealerPosRows) { const a = byDealer.get(r.room) ?? emptyDealerAgg(); byDealer.set(r.room, a); a.pos += Number(r.gross); }

  // ── DOANH SỐ QR per-đại-lý (transactions.qr_dealer_room_id — đại lý chọn lúc gửi). ──
  const dealerQrRows = await db.$queryRawUnsafe<{ room: string; gross: bigint }[]>(
    `SELECT t.qr_dealer_room_id AS room, COALESCE(SUM(t.amount),0)::bigint AS gross
     FROM transactions t
     JOIN tids td ON td.id = t.tid_id AND td.kind = 'QR'
     LEFT JOIN los l ON l.transaction_id = t.id
     WHERE t.status='POSTED' AND t.deleted_at IS NULL AND t.qr_dealer_room_id IS NOT NULL
       AND COALESCE(l.bill_txn_date, t.txn_date) >= $1::timestamptz AND COALESCE(l.bill_txn_date, t.txn_date) < $2::timestamptz
     GROUP BY t.qr_dealer_room_id`, fromIso, toIso);
  for (const r of dealerQrRows) { const a = byDealer.get(r.room) ?? emptyDealerAgg(); byDealer.set(r.room, a); a.qr += Number(r.gross); }

  // ── HOÀN ĐẠI LÝ (SigMa → đại lý) ─────────────────────────────────────────────────────────────────────
  // (a) POS/CK: tin `isDealerRefundCk` (KHÔNG lấy isQrRefundCk ở đây — hoàn QR tính từ CHÍNH GD QR dưới, tránh đếm đôi
  //     + khớp doanh số tuyệt đối). Lọc billDate trong kỳ (HCM), dedup ckTxnKey. refundAmount signed (âm = đại lý hoàn thừa về).
  // [Admin Demo 29/9 "TẠI SAO CỨ ĐỂ LỖI LỌT?"] BIÊN KỲ: `to` có thể là GIỮA NGÀY — KPI SigMa truyền
  // `to = now` khi không có tham số, và client truyền 'YYYY-MM-DD' thì parseBound ra NỬA ĐÊM ngày đó.
  // Lấy thẳng hcmDay(to) rồi lọc `bd >= toDay` sẽ GẠT SẠCH bill hoàn của chính ngày cuối kỳ (cùng lớp
  // lỗi đã làm mất 32 bill / 2,73 tỷ ở đối soát hoàn đại lý). Ngày cuối THỰC = ngày ngay trước `to`.
  const fromDay = hcmDay(from), toDay = hcmDay(new Date(Math.max(from.getTime() + 1, to.getTime() - 1) + 86_400_000));
  const refundMsgs = await db.$queryRawUnsafe<{ room_id: string; metadata_json: string | null }[]>(
    `SELECT room_id, metadata_json FROM chat_messages
     WHERE deleted_at IS NULL AND kind='IMAGE' AND metadata_json LIKE '%"isDealerRefundCk":true%'`);
  // [Dọn nợ 11/9] key→phòng ĐẦU TIÊN: 1 ckTxnKey ở >1 phòng = dị thường dữ liệu (1 CK 2 phòng) — dedup toàn cục
  // nuốt câm phòng sau ⇒ PHẢI kêu to (R198), số liệu vẫn giữ luật cũ (phòng đầu thắng) chờ người gỡ tay.
  const seenRefund = new Map<string, string>();
  for (const m of refundMsgs) {
    if (!m.metadata_json) continue;
    let p: { isDealerRefundCk?: boolean; refundAmount?: number; billDate?: string | null; ckTxnKey?: string | null };
    try { p = JSON.parse(m.metadata_json); } catch { console.warn('[alpha-aggregate] metadata tin hoàn parse lỗi — bỏ 1 dòng (không tính vào hoàn):', m.metadata_json?.slice(0, 80)); continue; }
    if (!p.isDealerRefundCk || typeof p.refundAmount !== 'number' || p.refundAmount === 0) continue;
    const bd = p.billDate ?? null;
    if (!bd || bd < fromDay || bd >= toDay) continue; // lọc kỳ theo NGÀY BILL (HCM)
    const key = p.ckTxnKey ?? `${m.room_id}|${p.refundAmount}|${bd}`;
    const phongDau = seenRefund.get(key);
    if (phongDau !== undefined) {
      if (phongDau !== m.room_id) console.error(`[alpha-aggregate] ckTxnKey ${key.slice(0, 40)}… xuất hiện ở 2 PHÒNG (${phongDau} và ${m.room_id}) — 1 CK nằm 2 phòng, phòng sau bị bỏ khỏi hoàn: cần gỡ tay tin trùng.`);
      continue;
    }
    seenRefund.set(key, m.room_id);
    const a = byDealer.get(m.room_id) ?? emptyDealerAgg(); byDealer.set(m.room_id, a);
    a.hoan += p.refundAmount;
  }
  // (b) QR: SigMa hoàn đại lý = số quẹt − PHÍ BÁN = amount − revenue_amount (revenue_amount = amount×phiBan/100000). Tính
  //     TỪ CHÍNH GD QR (qr_dealer_room_id) — chính xác + khớp doanh số, KHÔNG phụ thuộc parse tin hoàn.
  const dealerQrHoan = await db.$queryRawUnsafe<{ room: string; hoan: bigint }[]>(
    `SELECT t.qr_dealer_room_id AS room, COALESCE(SUM(t.amount - t.revenue_amount),0)::bigint AS hoan
     FROM transactions t JOIN tids td ON td.id = t.tid_id AND td.kind = 'QR'
     LEFT JOIN los l ON l.transaction_id = t.id
     WHERE t.status='POSTED' AND t.deleted_at IS NULL AND t.qr_dealer_room_id IS NOT NULL
       AND COALESCE(l.bill_txn_date, t.txn_date) >= $1::timestamptz AND COALESCE(l.bill_txn_date, t.txn_date) < $2::timestamptz
     GROUP BY t.qr_dealer_room_id`, fromIso, toIso);
  for (const r of dealerQrHoan) { const a = byDealer.get(r.room) ?? emptyDealerAgg(); byDealer.set(r.room, a); a.hoan += Number(r.hoan); }

  // ── HOÀN NĐT (QR) = NĐT trả SigMa = số quẹt − GIÁ MUA = amount − revenue_partner (revenue_partner = amount×phiMua/100000,
  //    giá mua 0.85% thường / 0.9% cuối tuần đã chốt vào GD). POS KHÔNG trộn (tất toán NĐT POS ở báo cáo NĐT riêng). ──
  const invQrHoan = await db.$queryRawUnsafe<{ inv: number; hoan: bigint }[]>(
    `SELECT ra.investor_id AS inv, COALESCE(SUM(t.amount - t.revenue_partner),0)::bigint AS hoan
     FROM transactions t JOIN tids td ON td.id = t.tid_id AND td.kind = 'QR'
     JOIN receive_accounts ra ON ra.id = td.receive_account_id AND ra.investor_id IS NOT NULL AND ra.deleted_at IS NULL
     LEFT JOIN los l ON l.transaction_id = t.id
     WHERE t.status='POSTED' AND t.deleted_at IS NULL AND COALESCE(l.bill_txn_date, t.txn_date) >= $1::timestamptz AND COALESCE(l.bill_txn_date, t.txn_date) < $2::timestamptz
     GROUP BY ra.investor_id`, fromIso, toIso);
  for (const r of invQrHoan) { const a = byInv.get(r.inv) ?? emptyInvAgg(); byInv.set(r.inv, a); a.hoan += Number(r.hoan); }

  // ── TÊN NĐT + đại lý (batch). ──
  const invIds = [...byInv.keys()];
  const invs = invIds.length > 0 ? await db.investor.findMany({ where: { id: { in: invIds } }, select: { id: true, nickname: true, fullName: true } }) : [];
  const invName = new Map(invs.map((i) => [i.id, i.nickname || i.fullName || `NĐT ${i.id}`]));
  const roomIds = [...byDealer.keys()];
  const rooms = roomIds.length > 0 ? await db.chatRoom.findMany({ where: { id: { in: roomIds } }, select: { id: true, name: true } }) : [];
  const roomName = new Map(rooms.map((r) => [r.id, r.name || `Phòng ${r.id.slice(0, 6)}`]));

  const byInvestor: AlphaAggInvestorRow[] = [...byInv.entries()].map(([id, a]) => ({
    investorId: id, name: invName.get(id) ?? `NĐT ${id}`, doanhSoPos: a.pos, doanhSoQr: a.qr, tong: a.pos + a.qr, hoan: a.hoan,
    laiNdtPos: a.laiPos, laiNdtQr: a.laiQr, laiNdt: a.laiPos + a.laiQr
  })).sort((x, y) => y.tong - x.tong);
  const byDealerArr: AlphaAggDealerRow[] = [...byDealer.entries()].map(([id, a]) => ({
    dealerId: id, name: roomName.get(id) ?? `Phòng ${id.slice(0, 6)}`, doanhSoPos: a.pos, doanhSoQr: a.qr, tong: a.pos + a.qr, hoan: a.hoan
  })).sort((x, y) => y.tong - x.tong);

  // ── TOTALS từ NGUỒN transactions TRỰC TIẾP (không cộng byDealer — tránh lệch nếu 1 khách map 2 phòng). ──
  // Lãi Công ty = Σ revenue_sell (POS: CL_KH; QR: spread). TÁCH POS/QR theo kind.
  const totRows = await db.$queryRawUnsafe<{ kind: string | null; gross: bigint; rsell: bigint }[]>(
    `SELECT td.kind AS kind, COALESCE(SUM(t.amount),0)::bigint AS gross, COALESCE(SUM(t.revenue_sell),0)::bigint AS rsell
     FROM transactions t JOIN tids td ON td.id = t.tid_id
     LEFT JOIN los l ON l.transaction_id = t.id
     WHERE t.status='POSTED' AND t.deleted_at IS NULL AND COALESCE(l.bill_txn_date, t.txn_date) >= $1::timestamptz AND COALESCE(l.bill_txn_date, t.txn_date) < $2::timestamptz
     GROUP BY td.kind`, fromIso, toIso);
  let doanhSoPos = 0, doanhSoQr = 0, laiCongTyPos = 0, laiCongTyQr = 0;
  for (const r of totRows) {
    if (r.kind === 'QR') { doanhSoQr += Number(r.gross); laiCongTyQr += Number(r.rsell); }
    else { doanhSoPos += Number(r.gross); laiCongTyPos += Number(r.rsell); }
  }
  // Tổng hoàn/lãi TÁCH: Σ dòng từng bảng (khớp Σ dòng — trước totals chỉ cộng hoàn đại lý → lệch).
  const tongHoanDaiLy = byDealerArr.reduce((s, r) => s + r.hoan, 0);
  const tongHoanNDT = byInvestor.reduce((s, r) => s + r.hoan, 0);
  const laiNdtPos = byInvestor.reduce((s, r) => s + r.laiNdtPos, 0);
  const laiNdtQr = byInvestor.reduce((s, r) => s + r.laiNdtQr, 0);

  // [Nợ C4a 11/9] Cảnh báo mốc chốt trong kỳ (điều kiện đủ để tổng gộp ≠ tất toán NĐT). Lỗi tra cutoff không chặn báo cáo.
  const cutoffWarnings: string[] = [];
  try {
    const { loadInvestorCutoffs } = await import('@sigma/services');
    const cutoffs = await loadInvestorCutoffs(db);
    for (const [invId, moc] of cutoffs) {
      // [Agent-4 F6, LEAD duyệt 12/9] Đủ điều kiện lệch = mốc chốt SAU đầu kỳ (moc > from): kỳ có PHẦN nằm trước
      // mốc (kể cả kỳ TRỌN trước mốc — vd xem tháng 8 của NĐT chốt 30/8: aggregate đầy tiền, tất toán = 0). Điều
      // kiện cũ `moc < to` bỏ sót đúng ca kỳ-trọn-trước-mốc — người xem 2 màn thấy lệch mà không được cảnh báo.
      if (moc.getTime() > from.getTime()) {
        const tronKy = moc.getTime() >= to.getTime();
        cutoffWarnings.push(`⚠ NĐT #${invId} có MỐC CHỐT ${moc.toISOString().slice(0, 10)} ${tronKy ? 'SAU kỳ đang xem (toàn bộ kỳ đã tất toán)' : 'nằm trong kỳ'} — Tổng gộp tính DÒNG TIỀN TRỌN KỲ (không cắt), sẽ KHÁC báo cáo tất toán NĐT (đã cắt trước mốc).`);
      }
    }
  } catch (e) { console.error('[alpha-aggregate] tra mốc chốt lỗi (bỏ cảnh báo, không chặn):', e instanceof Error ? e.message : e); }

  return {
    from: fromIso, to: toIso,
    byInvestor, byDealer: byDealerArr,
    totals: {
      doanhSoPos, doanhSoQr, tongDoanhSo: doanhSoPos + doanhSoQr, tongHoanDaiLy, tongHoanNDT,
      laiCongTyPos, laiCongTyQr, laiCongTy: laiCongTyPos + laiCongTyQr,
      laiNdtPos, laiNdtQr, laiNdt: laiNdtPos + laiNdtQr
    },
    cutoffWarnings: cutoffWarnings.length > 0 ? cutoffWarnings : undefined
  };
}

/** CHI TIẾT 1 NĐT: từng GD (POS+QR) trong kỳ + lãi NĐT per-GD. Nguồn/attribution Y HỆT summary (tid→receive_account). */
export async function buildAlphaInvestorDetail(from: Date, to: Date, investorId: number): Promise<AlphaAggregateDetail> {
  const db = getBotDb();
  const fromIso = from.toISOString(), toIso = to.toISOString();
  // [deep-audit C2-agent3] KHÔNG lọc deletedAt (đồng bộ SUMMARY vốn hiện cả NĐT xóa mềm) → detail 1 NĐT xóa mềm vẫn
  // hiện đúng tên + lãi (RA lịch sử vẫn thật), tránh summary=100k vs detail=0 + mất tên.
  const inv = await db.investor.findFirst({ where: { id: investorId }, select: { nickname: true, fullName: true, investFeeMilli: true } });
  const name = inv ? (inv.nickname || inv.fullName || `NĐT ${investorId}`) : `NĐT ${investorId}`;
  const invDefault = inv ? Number(inv.investFeeMilli ?? 0) : 0;
  // [TZ 11/9 — Agent 4] bill_iso = giờ bill THẬT (los.bill_txn_date, raw-ISO ghi đúng instant; đọc to_char UTC text
  // né bẫy $queryRaw +7h). txn_date là cột Prisma ghi (prod trộn 2 quần thể: −7h từ ~6/9 và đúng trước đó) → CHỈ
  // fallback hiển thị cho GD không có lô (QR). LEFT JOIN los an toàn 1-1 (los.transaction_id UNIQUE).
  const rows = await db.$queryRawUnsafe<{ txn_iso: string; bill_iso: string | null; hkd: string | null; kind: string | null; amount: bigint; pcm: number | null; ifa: bigint | null; rpartner: bigint; tidfee: number | null }[]>(
    `SELECT to_char(t.txn_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS txn_iso, to_char(l.bill_txn_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS bill_iso,
            td.hkd_name AS hkd, td.kind AS kind, t.amount AS amount,
            t.phi_cai_may_milli AS pcm, t.install_fee_amount AS ifa, t.revenue_partner AS rpartner, td.invest_fee_milli AS tidfee
     FROM transactions t
     JOIN tids td ON td.id = t.tid_id
     JOIN receive_accounts ra ON ra.id = td.receive_account_id AND ra.investor_id = $1 AND ra.deleted_at IS NULL
     LEFT JOIN los l ON l.transaction_id = t.id
     WHERE t.status='POSTED' AND t.deleted_at IS NULL
       -- [Admin Demo 26/9 "lấy ngày trên bill làm chuẩn"] cùng mốc kỳ với bảng tổng phía trên (đã LEFT JOIN los 1-1).
       AND COALESCE(l.bill_txn_date, t.txn_date) >= $2::timestamptz AND COALESCE(l.bill_txn_date, t.txn_date) < $3::timestamptz
     ORDER BY COALESCE(l.bill_txn_date, t.txn_date)`, investorId, fromIso, toIso);
  const out: AlphaAggregateDetailRow[] = [];
  let amountPos = 0, amountQr = 0, laiSum = 0, hoanSum = 0;
  for (const r of rows) {
    const amount = Number(r.amount);
    const isQr = r.kind === 'QR';
    const txnDateIso = r.bill_iso ?? r.txn_iso /* [GÓI TZ 11/9] fallback cũng instant thật */;
    if (isQr) {
      const giaMua = Number(r.rpartner); // = lãi NĐT QR (giá mua)
      const ndtTra = amount - giaMua;    // NĐT trả SigMa
      out.push({ txnDateIso, hkdName: r.hkd || '', kind: 'QR', amount, giaMua, ndtTraAlpha: ndtTra, laiNdt: giaMua, phiBan: null, daiLyHoan: null });
      amountQr += amount; laiSum += giaMua; hoanSum += ndtTra;
    } else {
      const tv = tienVePos(BigInt(r.amount), BigInt(r.ifa ?? 0), Number(r.pcm ?? 0));
      const lai = Number(laiForTxn(tv, effInvestFee(r.tidfee, invDefault)));
      out.push({ txnDateIso, hkdName: r.hkd || '', kind: 'POS', amount, giaMua: null, ndtTraAlpha: null, laiNdt: lai, phiBan: null, daiLyHoan: null });
      amountPos += amount; laiSum += lai;
    }
  }
  return { entityKind: 'investor', entityId: String(investorId), name, rows: out, refunds: [], totals: { amountPos, amountQr, amount: amountPos + amountQr, laiNdt: laiSum, hoan: hoanSum } };
}

/** CHI TIẾT 1 ĐẠI LÝ (phòng): từng GD POS (customer→room) + QR (qr_dealer_room_id) + hoàn POS/CK theo tin chat. */
export async function buildAlphaDealerDetail(from: Date, to: Date, roomId: string): Promise<AlphaAggregateDetail> {
  const db = getBotDb();
  const fromIso = from.toISOString(), toIso = to.toISOString();
  const room = await db.chatRoom.findUnique({ where: { id: roomId }, select: { name: true } });
  const name = room?.name || `Phòng ${roomId.slice(0, 6)}`;

  // [deep-audit C1-agent3] KHỚP summary: chỉ hiện GD POS của khách mà PHÒNG ĐƯỢC CHỌN (DISTINCT ON) = roomId này —
  // tránh 1 khách 2 phòng hiện full GD ở cả 2 phòng (chi tiết phải nhất quán với bảng tóm tắt).
  // [TZ 11/9 — Agent 4] bill_iso: xem chú thích buildAlphaInvestorDetail (giờ bill thật; fallback txn_date cho GD không lô).
  const posRows = await db.$queryRawUnsafe<{ txn_iso: string; bill_iso: string | null; hkd: string | null; amount: bigint }[]>(
    `WITH cust_room AS (
       SELECT DISTINCT ON (customer_id) customer_id, room_id
       FROM customer_chat_groups WHERE unassigned_at IS NULL AND room_id IS NOT NULL
       ORDER BY customer_id, room_id
     )
     SELECT to_char(t.txn_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS txn_iso, to_char(l.bill_txn_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS bill_iso, td.hkd_name AS hkd, t.amount AS amount
     FROM transactions t
     JOIN tids td ON td.id = t.tid_id AND (td.kind IS NULL OR td.kind <> 'QR') AND td.customer_id IS NOT NULL
     JOIN cust_room cr ON cr.customer_id = td.customer_id AND cr.room_id = $1
     LEFT JOIN los l ON l.transaction_id = t.id
     WHERE t.status='POSTED' AND t.deleted_at IS NULL
       -- [Admin Demo 26/9 "lấy ngày trên bill làm chuẩn"] cùng mốc kỳ với bảng tổng phía trên (đã LEFT JOIN los 1-1).
       AND COALESCE(l.bill_txn_date, t.txn_date) >= $2::timestamptz AND COALESCE(l.bill_txn_date, t.txn_date) < $3::timestamptz
     ORDER BY COALESCE(l.bill_txn_date, t.txn_date)`, roomId, fromIso, toIso);
  const qrRows = await db.$queryRawUnsafe<{ txn_iso: string; bill_iso: string | null; hkd: string | null; amount: bigint; ramount: bigint }[]>(
    `SELECT to_char(t.txn_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS txn_iso, to_char(l.bill_txn_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS bill_iso, td.hkd_name AS hkd, t.amount AS amount, t.revenue_amount AS ramount
     FROM transactions t JOIN tids td ON td.id = t.tid_id AND td.kind = 'QR'
     LEFT JOIN los l ON l.transaction_id = t.id
     WHERE t.status='POSTED' AND t.deleted_at IS NULL AND t.qr_dealer_room_id = $1
       AND t.txn_date >= $2::timestamptz AND t.txn_date < $3::timestamptz
     ORDER BY COALESCE(l.bill_txn_date, t.txn_date)`, roomId, fromIso, toIso);

  const out: AlphaAggregateDetailRow[] = [];
  let amountPos = 0, amountQr = 0, hoanSum = 0;
  for (const r of posRows) {
    const amount = Number(r.amount);
    // POS: phí bán / hoàn KHÔNG suy được per-GD (hoàn POS/CK là theo tin chat) → null; hoàn gộp ở `refunds`.
    out.push({ txnDateIso: r.bill_iso ?? r.txn_iso /* [GÓI TZ 11/9] fallback cũng instant thật */, hkdName: r.hkd || '', kind: 'POS', amount, giaMua: null, ndtTraAlpha: null, laiNdt: null, phiBan: null, daiLyHoan: null });
    amountPos += amount;
  }
  for (const r of qrRows) {
    const amount = Number(r.amount);
    const phiBan = Number(r.ramount);      // SigMa thu = amount×phiBan/100000
    const daiLyHoan = amount - phiBan;     // SigMa hoàn đại lý QR
    out.push({ txnDateIso: r.bill_iso ?? r.txn_iso /* [GÓI TZ 11/9] fallback cũng instant thật */, hkdName: r.hkd || '', kind: 'QR', amount, giaMua: null, ndtTraAlpha: null, laiNdt: null, phiBan, daiLyHoan });
    amountQr += amount; hoanSum += daiLyHoan;
  }
  out.sort((a, b) => a.txnDateIso.localeCompare(b.txnDateIso));

  // Hoàn POS/CK theo tin chat cho phòng này (KHỚP summary: billDate trong kỳ HCM, dedup ckTxnKey).
  // [Admin Demo 29/9 "TẠI SAO CỨ ĐỂ LỖI LỌT?"] BIÊN KỲ: `to` có thể là GIỮA NGÀY — KPI SigMa truyền
  // `to = now` khi không có tham số, và client truyền 'YYYY-MM-DD' thì parseBound ra NỬA ĐÊM ngày đó.
  // Lấy thẳng hcmDay(to) rồi lọc `bd >= toDay` sẽ GẠT SẠCH bill hoàn của chính ngày cuối kỳ (cùng lớp
  // lỗi đã làm mất 32 bill / 2,73 tỷ ở đối soát hoàn đại lý). Ngày cuối THỰC = ngày ngay trước `to`.
  const fromDay = hcmDay(from), toDay = hcmDay(new Date(Math.max(from.getTime() + 1, to.getTime() - 1) + 86_400_000));
  const refundMsgs = await db.$queryRawUnsafe<{ metadata_json: string | null }[]>(
    `SELECT metadata_json FROM chat_messages
     WHERE deleted_at IS NULL AND kind='IMAGE' AND room_id = $1 AND metadata_json LIKE '%"isDealerRefundCk":true%'`, roomId);
  const seen = new Set<string>();
  const refunds: { billDate: string; amount: number }[] = [];
  for (const m of refundMsgs) {
    if (!m.metadata_json) continue;
    let p: { isDealerRefundCk?: boolean; refundAmount?: number; billDate?: string | null; ckTxnKey?: string | null };
    try { p = JSON.parse(m.metadata_json); } catch { console.warn('[alpha-aggregate] metadata tin hoàn parse lỗi — bỏ 1 dòng (không tính vào hoàn):', m.metadata_json?.slice(0, 80)); continue; }
    if (!p.isDealerRefundCk || typeof p.refundAmount !== 'number' || p.refundAmount === 0) continue;
    const bd = p.billDate ?? null;
    if (!bd || bd < fromDay || bd >= toDay) continue;
    const key = p.ckTxnKey ?? `${roomId}|${p.refundAmount}|${bd}`;
    if (seen.has(key)) continue; seen.add(key);
    refunds.push({ billDate: bd, amount: p.refundAmount });
    hoanSum += p.refundAmount;
  }
  refunds.sort((a, b) => a.billDate.localeCompare(b.billDate));

  return { entityKind: 'dealer', entityId: roomId, name, rows: out, refunds, totals: { amountPos, amountQr, amount: amountPos + amountQr, laiNdt: 0, hoan: hoanSum } };
}

// GET /v1/alpha-aggregate/report?from=&to=&investorId=&dealerId= — from/to = ISO instant HOẶC YYYY-MM-DD (nửa đêm HCM).
// Mặc định 30 ngày gần nhất. investorId | dealerId (KHÔNG cả hai) → kèm `detail` chi tiết entity đó.
alphaAggregateRouter.get(
  '/v1/alpha-aggregate/report',
  asyncHandler(requireSession),
  requireAlphaOwner,
  asyncHandler(async (req: Request, res: Response) => {
    // [deep-audit C4-agent3] Default `to` = NỬA ĐÊM HCM NGÀY MAI (không new Date() giữa ngày): doanh số lọc txn_date<to
    // và hoàn lọc billDate<hcmDay(to) mới CÙNG gồm trọn hôm nay → hết "net đẹp giả" do hoàn hôm nay bị loại.
    const to = parseBound(req.query.to) ?? startOfDayLocalHCM(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const from = parseBound(req.query.from) ?? new Date(to.getTime() - 31 * 24 * 60 * 60 * 1000);
    if (from.getTime() >= to.getTime()) { res.status(400).json({ error: 'VALIDATION', message: 'from phải nhỏ hơn to.' }); return; }

    // Lọc entity (loại trừ): investorId (số nguyên dương) HOẶC dealerId (roomId chuỗi). Cấm cả hai.
    const rawInv = req.query.investorId, rawDealer = req.query.dealerId;
    const hasInv = typeof rawInv === 'string' && rawInv.trim() !== '';
    const hasDealer = typeof rawDealer === 'string' && rawDealer.trim() !== '';
    if (hasInv && hasDealer) { res.status(400).json({ error: 'VALIDATION', message: 'Chỉ được lọc 1 loại: investorId HOẶC dealerId.' }); return; }

    const report = await buildAlphaAggregate(from, to);
    if (hasInv) {
      const investorId = Number((rawInv as string).trim());
      if (!Number.isInteger(investorId) || investorId <= 0) { res.status(400).json({ error: 'VALIDATION', message: 'investorId không hợp lệ.' }); return; }
      report.detail = await buildAlphaInvestorDetail(from, to, investorId);
    } else if (hasDealer) {
      const dealerId = (rawDealer as string).trim();
      if (dealerId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(dealerId)) { res.status(400).json({ error: 'VALIDATION', message: 'dealerId không hợp lệ.' }); return; }
      report.detail = await buildAlphaDealerDetail(from, to, dealerId);
    }
    res.json(report);
  })
);
