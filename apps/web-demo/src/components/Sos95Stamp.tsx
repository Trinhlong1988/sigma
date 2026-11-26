// [Admin Demo 16/9 khuya] CON DẤU "SOS" ĐÓNG LÔ 95 — cảnh báo cũ (1 dòng chữ + ô tick) QUÁ NHẸ so với rủi ro:
// bill đóng lô 95 = khách có thể HOÀN/HỦY giao dịch SAU KHI SigMa đã chuyển tiền ⇒ mất tiền thật. Nay đóng
// DẤU TRÒN ĐỎ "SOS" cỡ lớn vào khoảng trống thẻ review + dấu ✕ gạch chéo (ý: DỪNG, đừng đi tiền) để không
// ai lướt qua được. Thuần SVG (không ảnh, không font ngoài) → chạy y hệt trên web/EXE/APK.
import type { JSX } from 'react';

export function Sos95Stamp({ size = 132, note = true }: { size?: number; note?: boolean }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-1" data-testid="sos95-stamp">
      <svg width={size} height={size} viewBox="0 0 132 132" role="img" aria-label="Cảnh báo đóng lô 95 — dừng chuyển tiền">
        {/* vòng tròn dấu: 2 lớp viền như con dấu mực đỏ, hơi nghiêng cho giống dấu đóng tay */}
        <g transform="rotate(-12 66 66)">
          <circle cx="66" cy="66" r="60" fill="none" stroke="#dc2626" strokeWidth="5" opacity="0.95" />
          <circle cx="66" cy="66" r="51" fill="none" stroke="#dc2626" strokeWidth="2.5" opacity="0.85" />
          <text x="66" y="60" textAnchor="middle" fontSize="34" fontWeight="900" fill="#dc2626" letterSpacing="2">SOS</text>
          <text x="66" y="84" textAnchor="middle" fontSize="15" fontWeight="800" fill="#dc2626" letterSpacing="1">LÔ 95</text>
          <text x="66" y="100" textAnchor="middle" fontSize="10.5" fontWeight="700" fill="#dc2626">DỪNG ĐI TIỀN</text>
        </g>
        {/* dấu ✕ gạch chéo đè lên — nghĩa "chặn/không được" */}
        <line x1="20" y1="20" x2="112" y2="112" stroke="#dc2626" strokeWidth="6" strokeLinecap="round" opacity="0.55" />
        <line x1="112" y1="20" x2="20" y2="112" stroke="#dc2626" strokeWidth="6" strokeLinecap="round" opacity="0.55" />
      </svg>
      {note && <div className="max-w-[190px] text-center text-[11px] font-bold leading-tight text-danger">Bill ĐÓNG LÔ 95 — khách có thể hoàn/hủy GD sau khi đã nhận tiền</div>}
    </div>
  );
}
