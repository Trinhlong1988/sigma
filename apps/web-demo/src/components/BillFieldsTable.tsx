// B112 (2/8) — TÁCH RA từ OcrBillPreview.tsx (nơi 2 khối JSX này ban đầu viết inline) thành component DÙNG
// CHUNG — EditBillMessageModal.tsx (panel "Sửa" bill đã gửi, mới) cần render CÙNG bảng/cảnh báo NÀY, giữ ĐÚNG
// "cùng độ nổi bật" Admin Demo yêu cầu tường minh cho hàng Số tiền/Hoàn tiền — tránh 2 nơi vẽ khác nhau rồi lệch
// dần theo thời gian (đúng bài học B106 retro "sửa 1 nơi quên nơi khác"). KHÔNG đổi 1 className/cấu trúc nào so
// với bản gốc trong OcrBillPreview.tsx — thuần di chuyển code, hành vi/hiển thị giữ nguyên 100%.
import type { JSX } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { OcrBillPreview } from '../lib/agent-api-client';
import { buildBillFieldDisplayRows, describeTidMatchWarning } from '../lib/ocr-bill-fields-display';

/** Cảnh báo mã đóng lô rủi ro (1/8, Admin Demo "đóng (95) là... cảnh báo rủi ro hoàn tiền sau", "báo đỏ, mức cảnh
 * báo cao nhất") — hoặc dòng "Bill hợp lệ" khi không phát hiện. `billFields` đọc text OCR THÔ do chính đại lý
 * tự chụp/tải lên (attacker-influenceable) — message hiển thị TEXT THUẦN, TUYỆT ĐỐI KHÔNG dangerouslySetInnerHTML. */
export function BillSettlementRiskBanner({ billFields }: { billFields: OcrBillPreview }): JSX.Element {
  if (billFields.settlementRisk) {
    return (
      <div className="flex items-start gap-1.5 rounded-lg-mac border-2 border-danger bg-danger/10 p-2.5 text-xs font-semibold text-danger">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>{billFields.settlementRisk.message}</span>
      </div>
    );
  }
  return <p className="flex items-center gap-1 text-xs font-medium text-success">Bill hợp lệ — không phát hiện mã rủi ro đóng lô.</p>;
}

// B121 (2/8, "Phương án B — Lưới ô vuông", Admin Demo yêu cầu trực tiếp đổi từ bảng 1-cột-8-hàng sang lưới ô
// vuông) — hàng "Số tiền"/"Hoàn tiền" GIỮ NGUYÊN full-width nền màu đậm nổi bật nhất (không đổi). "Tên Pos
// (HKD)" tách 1 ô full-width riêng (tên đại lý thường dài). 6 field còn lại (Ngân hàng/TID/Ngày/Giờ/Số lô/Số
// hóa đơn) xếp LƯỚI 2 CỘT, mỗi ô nhãn nhỏ HOA phía trên + giá trị to phía dưới — dùng `grid-cols-2 gap-px
// bg-line` (thủ thuật CSS: nền `bg-line` lộ ra qua khe hở 1px giữa các ô làm viền lưới mảnh, mỗi ô con nền
// trắng che phần còn lại) thay vì border từng ô riêng — ít mã hơn, viền đều tăm tắp mọi hướng. CANVAS ảnh ghép
// gửi đi (`bill-table-image.ts` composeBillImage()) vẽ theo CÙNG bố cục này (hero full-width → full-width HKD
// → lưới 2 cột), giữ đồng bộ trực quan màn hình/ảnh gửi (đúng bài học B106 retro "sửa 1 nơi quên nơi khác").
const GRID_LABEL_CLS = 'text-[10px] font-semibold uppercase tracking-wide text-slate-500';

/** Bảng LƯỚI Ô VUÔNG — hàng "Số tiền" nổi bật nền brand đầu bảng, hàng "Hoàn tiền" (B111, nếu có) nổi bật nền
 * success NGAY DƯỚI (2 hàng này GIỮ NGUYÊN full-width như bản cũ) — "Tên Pos (HKD)" full-width riêng, 6 field
 * còn lại xếp lưới 2 cột đều nhau. `amountDisplay` ĐÃ format sẵn (caller tự tính — cho phép caller quyết định
 * fallback "—" hay giá trị khác lúc chưa nhập). CHỈ HIỂN THỊ (không cho sửa tay), text THUẦN TUYỆT ĐỐI KHÔNG
 * dangerouslySetInnerHTML (dữ liệu OCR đọc từ ảnh đại lý tự chụp, attacker-influenceable). */
export function BillFieldsTable({
  billFields,
  amountDisplay,
  refundText
}: {
  billFields: OcrBillPreview;
  amountDisplay: string;
  refundText: string | null;
}): JSX.Element {
  const rows = buildBillFieldDisplayRows(billFields);
  const hkdRow = rows.find((r) => r.key === 'hkdName');
  const gridFieldRows = rows.filter((r) => r.key !== 'hkdName');

  return (
    <div className="overflow-hidden rounded-lg-mac border border-line text-xs">
      <div className="flex items-center justify-between bg-gradient-to-r from-brand to-brand-teal px-3 py-2.5 font-semibold text-white">
        <span>Số tiền</span>
        <span className="text-sm">{amountDisplay}</span>
      </div>
      {refundText && (
        <div className="flex items-center justify-between bg-success px-3 py-2.5 font-semibold text-white">
          <span>Hoàn tiền</span>
          <span className="text-sm">{refundText}</span>
        </div>
      )}
      <div className="grid grid-cols-2 gap-px bg-line">
        {hkdRow && (
          <div className="col-span-2 flex flex-col gap-0.5 bg-white px-3 py-2">
            <span className={GRID_LABEL_CLS}>{hkdRow.label}</span>
            <span className={hkdRow.muted ? 'text-slate-400' : 'font-medium text-slate-700'}>{hkdRow.text}</span>
          </div>
        )}
        {gridFieldRows.map((row) => (
          <div key={row.key} className="flex flex-col gap-0.5 bg-white px-3 py-2">
            <span className={GRID_LABEL_CLS}>{row.label}</span>
            <span className={row.muted ? 'text-slate-400' : 'font-medium text-slate-700'}>{row.text}</span>
          </div>
        ))}
      </div>
      {describeTidMatchWarning(billFields) && (
        <p className="flex items-center gap-1 border-t border-line bg-amber-50 px-2.5 py-1.5 text-amber-600">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {describeTidMatchWarning(billFields)}
        </p>
      )}
    </div>
  );
}
