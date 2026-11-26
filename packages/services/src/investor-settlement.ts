// NHÀ ĐẦU TƯ — TẤT TOÁN NGÀY (Phase C-2b, Admin Demo 10/8; đổi phí cài máy theo TID 11/8). LÕI THUẦN ctx-based, CHỈ ĐỌC.
// Mỗi NĐT trong kỳ:
//   • doanhThu (Σ Transaction.amount POSTED của TID uỷ NĐT) + laiNDT (Σ per-txn FLOOR(tienVe_txn×effInvestFeeMilli/
//     100000) — LÃI TRÊN TIỀN VỀ, KHÔNG trên gross, Admin Demo 31/8)
//     + tienVe (Σ per-txn FLOOR(amount×(100000−txn.phiCaiMayMilli)/100000)) → TÁI DÙNG investorDailyReport (KHÔNG
//     viết lại join/lãi/tiền-về; report gom 1 lần TID→GD, tính cả 3 đại lượng — KHÔNG N+1).
//   • tamUng (Σ InvestorAdvance.amount trong kỳ, EXCLUDE source='REPAYMENT' → giữ GROSS) → sumAdvancesByInvestors.
//   • daHoan (Σ InvestorAdvance.amount source='REPAYMENT' trong kỳ = SigMa hoàn thừa tạm ứng) → sumRepaymentsByInvestors.
//   • tienVe (VND) = PHÍ CÀI MÁY THEO TID (Admin Demo 11/8) — chốt trên TỪNG GD lúc tạo (Transaction.phiCaiMayMilli),
//     KHÔNG còn lấy %phí cài máy cấu hình ở tab nhà đầu tư (Investor.settleFeeMilli đã BỎ dùng, cột DB giữ nguyên).
//   • phaiTra/ngày = (tamUng − tienVe) + laiNDT − daHoan. GIỮ NGUYÊN DẤU (có thể ÂM nếu tiền về+lãi+đã hoàn > tạm ứng
//     — KHÔNG kẹp 0). "Đã hoàn" (hướng-4, Admin Demo 31/8 phương án B) TRỪ phải-trả, KHÔNG trừ tạm ứng gross.
//
// BIGINT xuyên suốt biên tính tiền (doanhThu/laiNDT là số nguyên VND < 2^53 → BigInt(...) tái dựng CHÍNH XÁC; amount
// tạm ứng vốn là BigInt gốc). Chỉ Number() ở BIÊN DTO.
//
// PERMISSION (Phase D — phân quyền + data-scope, khớp investor-report):
//   • Staff nội bộ: gate `REVENUE_VIEW` → xem tất toán TẤT CẢ NĐT / lọc theo investorId.
//   • User NĐT (role R_INVESTOR): gate `INVESTOR_SELF_VIEW` → CHỈ tất toán CỦA MÌNH. Scope ép qua investorDailyReport
//     bên trong (nó GHI ĐÈ investorId về NĐT gắn userId); repRows đã scoped → mọi query sau (settleFee/tạm ứng) chỉ
//     chạm NĐT của user → KHÔNG rò NĐT khác. Chưa gắn NĐT → report trả rỗng → tất toán rỗng (không lỗi).
import { hasPermission } from '@sigma/shared';
import type { ServiceCtx } from './customer.js';
import type { CaTien } from './ca-tien.js';
import { investorDailyReport } from './investor-report.js';
import { sumAdvancesByInvestors, sumRepaymentsByInvestors } from './investor-advance.js';

const VIEW_ALL = 'REVENUE_VIEW';
const SELF_VIEW = 'INVESTOR_SELF_VIEW';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

export interface InvestorSettlementRow {
  investorId: number;
  code: string;
  investorName: string; // nickname || fullName
  doanhThu: number; // Σ doanh thu POSTED trong kỳ (VND)
  laiNDT: number; // Σ lãi làm tròn nửa-lên (VND)
  tamUng: number; // Σ tạm ứng vốn trong kỳ (VND)
  tienVe: number; // Σ per-txn FLOOR(amount×(100000−phiCaiMayMilli)/100000) — phí cài máy theo TID (Admin Demo 11/8)
  daHoan: number; // Σ SigMa ĐÃ HOÀN THỪA tạm ứng về NĐT (source='REPAYMENT') — TRỪ vào phải-trả (Admin Demo 31/8 pa B)
  phaiTra: number; // (tamUng − tienVe) + laiNDT − daHoan — GIỮ DẤU (âm cho phép)
}
export interface InvestorDailySettlementInput {
  investorId?: number; // có → 1 NĐT; không → mọi NĐT ACTIVE (khớp report)
  from: string; // 'YYYY-MM-DD' (bao gồm)
  to: string; // 'YYYY-MM-DD' (bao gồm)
  // ── BỘ LỌC (Admin Demo 11/8) — TÁI DÙNG bộ lọc của report: CHỈ thu hẹp doanhThu/lãi/tiền về (theo tập TID lọc).
  //   "Đã ứng" (tamUng) là vốn theo NĐT, KHÔNG theo TID → KHÔNG bị các filter này lọc (xem chú thích dưới). ──
  receiveAccountId?: number;
  bankId?: number;
  tidId?: number;
  hkdName?: string;
  // [Agent-4 11/9 — FIX nuốt câm filter] CA TIỀN 1/2/3 (giờ tổng kết bill + bảng mốc ngân hàng, ca-tien.ts).
  // Route /v1/me/investor-settlement vốn ĐÃ truyền `ca` (parseFilters) nhưng input này thiếu field → bị DROP câm
  // → cùng màn InvestorRevenueScreen: report lọc ca còn tất toán KHÔNG lọc (2 số mâu thuẫn). Forward xuống report.
  ca?: CaTien;
}
export interface InvestorDailySettlementResult {
  ok: boolean;
  error?: string;
  message?: string;
  data?: InvestorSettlementRow[];
  from?: string;
  to?: string;
}

/**
 * REVENUE_VIEW (staff) HOẶC INVESTOR_SELF_VIEW (user NĐT, ép scope về mình) — tất toán ngày cho NĐT trong kỳ [from, to].
 * Tái dùng: (1) investorDailyReport → doanhThu + laiNDT + tienVe (join + lãi + tiền-về per-txn theo phí cài máy TID,
 * KHÔNG N+1); (2) sumAdvancesByInvestors → tamUng GOM 1 query. Chỉ 1 query phụ trội ngoài report → KHÔNG N+1.
 */
export async function investorDailySettlement(ctx: ServiceCtx, input: InvestorDailySettlementInput): Promise<InvestorDailySettlementResult> {
  if (!hasPermission(ctx.user, VIEW_ALL) && !hasPermission(ctx.user, SELF_VIEW)) {
    return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  }

  // (1) doanhThu + laiNDT + tienVe (tái dùng report — cũng validate kỳ + gate REVENUE_VIEW/INVESTOR_SELF_VIEW + ÉP
  //     data-scope cho user tự-xem). Lỗi → propagate. repRows ĐÃ scoped → query tạm ứng bên dưới chỉ chạm NĐT hợp lệ.
  // Bộ lọc TID (receiveAccountId/bankId/tidId/hkdName) truyền THẲNG xuống report → CHỈ ảnh hưởng doanhThu/lãi/tiền về.
  const rep = await investorDailyReport(ctx, {
    investorId: input.investorId, from: input.from, to: input.to,
    receiveAccountId: input.receiveAccountId, bankId: input.bankId, tidId: input.tidId, hkdName: input.hkdName,
    ca: input.ca // [Agent-4 11/9] forward lọc CA — thiếu dòng này = filter bị nuốt câm (report lọc, tất toán không)
  });
  if (!rep.ok || !rep.data) return { ok: rep.ok, error: rep.error, message: rep.message };
  const repRows = rep.data;
  if (repRows.length === 0) return { ok: true, data: [], from: rep.from, to: rep.to };
  const ids = repRows.map((r) => r.investorId);

  // (2) tamUng mỗi NĐT — 1 query gom (KHÔNG N+1). tienVe/lãi/doanhThu đã do report tính (per-txn theo phí cài máy TID).
  //     LƯU Ý: tạm ứng vốn là theo NĐT (không gắn TID) → CỐ Ý KHÔNG áp bộ lọc TID vào đây (chỉ lọc theo NĐT + kỳ).
  //     Nếu áp filter TID cho "Đã ứng" sẽ SAI bản chất (vốn NĐT bơm vào không phụ thuộc TID nào quẹt).
  const adv = await sumAdvancesByInvestors(ctx, { investorIds: ids, from: input.from, to: input.to });
  if (!adv.ok || !adv.totals) return { ok: false, error: adv.error, message: adv.message };
  // (3) ĐÃ HOÀN — SigMa hoàn thừa tạm ứng về NĐT (source='REPAYMENT') — TRỪ vào phải-trả (Admin Demo 31/8 phương án B).
  const repay = await sumRepaymentsByInvestors(ctx, { investorIds: ids, from: input.from, to: input.to });
  if (!repay.ok || !repay.totals) return { ok: false, error: repay.error, message: repay.message };

  const data: InvestorSettlementRow[] = repRows.map((r) => {
    const laiBig = BigInt(r.laiNDT); // số nguyên VND ≥ 0
    const tamUngBig = adv.totals!.get(r.investorId) ?? 0n; // GROSS (đã loại REPAYMENT)
    const daHoanBig = repay.totals!.get(r.investorId) ?? 0n; // SigMa đã hoàn về NĐT
    const tienVeBig = BigInt(r.tienVe); // Σ tiền về per-txn (report đã FLOOR từng GD theo phí cài máy của TID)
    const phaiTraBig = (tamUngBig - tienVeBig) + laiBig - daHoanBig; // GIỮ DẤU (âm hợp lệ)
    return {
      investorId: r.investorId,
      code: r.code,
      investorName: r.investorName,
      doanhThu: r.doanhThu,
      laiNDT: r.laiNDT,
      tamUng: Number(tamUngBig),
      tienVe: r.tienVe,
      daHoan: Number(daHoanBig),
      phaiTra: Number(phaiTraBig)
    };
  });

  return { ok: true, data, from: rep.from, to: rep.to };
}
