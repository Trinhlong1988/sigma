// CHI TIẾT DOANH SỐ NĐT — BẢNG CHIA CỘT kiểu Excel (Admin Demo 2/9 "bảng chia cột rõ như file Excel: STT · NĐT ·
// Đại lý · Ngày · Giờ · TID · Lô · Tiền trước phí · Tiền sau phí, zebra + hover 3D"). DÙNG CHUNG RevenueLotTable
// với báo cáo đại lý. Ngày+Giờ suy từ txn_date (timestamptz có giờ THẬT) theo giờ VN. Cột "Đại lý" (Admin Demo 2/9):
// backend resolve tên đại lý per-lô (TID→khách→phòng chat đang hoạt động, CHỈ khi 1-1); không 1-1 → '' hiện '—'.
import { type JSX } from 'react';
import { postLotNote } from '../lib/digistore-client';
import { compareBankTidLo } from '../lib/bank-visual';
import { RevenueLotTable } from './RevenueLotTable';
import { isoToLocalParts, INVESTOR_DETAIL_COLUMNS, type RevenueLotRow } from '../lib/revenue-lot-xls';
import type { InvestorDetailBill } from '../lib/investor-report-client';

/** Số lô hiện: số lô trên bill → '(nội bộ)'. Đồng nhất đại lý. */
function loLabel(b: InvestorDetailBill): string {
  return b.soLo || b.billLoNumber || '(nội bộ)';
}

/** 1 bill NĐT → 1 hàng bảng. amount=trước phí, sauPhi=tiền về (sau phí cài máy), lai=lợi nhuận NĐT.
 *  [Admin Demo 4/9] BỎ cột NĐT/Đại lý — hiển thị GIỐNG đại lý: HKD · Bank · TID · Lô · Ngày · Giờ · Trước phí · % phí cài
 *  · Tiền về · % lợi nhuận (đã mặc định NĐT nên không cần cột NĐT/Đại lý nữa). */
export function investorBillToRow(b: InvestorDetailBill, investorName: string): RevenueLotRow {
  const { date, time } = isoToLocalParts(b.txnDateIso);
  return {
    ndt: investorName, // giữ trong data (không hiện cột) — phòng khi cần
    daiLy: b.agentName,
    date,
    time,
    tid: b.tid,
    lo: loLabel(b),
    truoc: b.amount,
    sau: b.sauPhi,
    bankName: b.bankName,
    hkdName: b.hkdName,   // cột Tên HKD (như đại lý)
    lai: b.lai,           // cột % lợi nhuận (lai/gross)
    loId: b.loId ?? null, // [21/9] ghi chú per-lô đồng nhất với bảng đại lý
    note: b.note ?? null
  };
}

export function InvestorDetailLots({ bills, investorName = '', onNoteSaved }: { bills: InvestorDetailBill[]; investorName?: string; onNoteSaved?: () => void }): JSX.Element {
  const sorted = [...bills].sort((a, b) =>
    compareBankTidLo(
      { bankName: a.bankName, tid: a.tid, lo: a.soLo || a.billLoNumber },
      { bankName: b.bankName, tid: b.tid, lo: b.soLo || b.billLoNumber }
    )
  );
  const rows = sorted.map((b) => investorBillToRow(b, investorName));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between px-0.5 text-[10.5px] font-bold uppercase tracking-wide text-slate-400">
        <span>Chi tiết theo Lô</span>
        <span>Trước phí · % phí cài · Tiền về · % lợi nhuận</span>
      </div>
      <RevenueLotTable rows={rows} columns={INVESTOR_DETAIL_COLUMNS} labelSau="Tiền về"
        onNoteSave={(loId, note) => { void postLotNote(loId, note).then(() => onNoteSaved?.()); }} />
    </div>
  );
}
