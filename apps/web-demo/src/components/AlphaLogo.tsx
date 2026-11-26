import type { JSX } from "react";
import alphaLogoUrl from '../assets/sigma-logo.svg';

// SigMa (2/8) — logo THẬT (ảnh 3D "dải ruy băng chữ A + vòng vô cực + quả cầu thuỷ tinh + bong bóng chat",
// Admin Demo tự gửi, duyệt qua artifact xem trước bản 3c) — THAY HẲN logo SVG "điện thoại lồng chữ A" cũ (B36,
// 27/7). Dùng ẢNH THẬT (không vẽ lại vector — bản vẽ lại B36/B111 từng bị chê "quá xấu không đúng bản gửi").
// Nguồn: cắt trực tiếp từ ảnh JPEG gốc Admin Demo gửi (KHÔNG phải frame video — nguồn nén gây lem viền đã gặp ở
// artifact demo, xem BUGS_FIXED.md B117-đính-chính), giữ NGUYÊN margin an toàn ~13% quanh 4 cạnh ngay trong
// ảnh (không cắt cụt khi thu nhỏ icon/bo góc). KHÔNG cần cắt nền trong suốt (chroma-key) — nền trắng gần trùng
// `bg-white`/`bg-appbg` của app nên hiển thị liền mạch không cần alpha.
export function AlphaLogo({ className = 'h-7 w-7' }: { className?: string }): JSX.Element {
  return <img src={alphaLogoUrl} alt="SigMa" className={`${className} object-contain`} />;
}
