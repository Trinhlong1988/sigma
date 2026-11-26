import type { JSX } from "react";
import alphaLogoUrl from '../assets/sigma-logo.svg';

// SigMa (5/8) — icon THẬT glass "bong bóng chat + dải ruy băng chữ A" resize LANCZOS TỪ master duy nhất
// assets/brand/alpha-icon-master.png (đã bo góc tròn + trong suốt 4 góc — KHÔNG vẽ lại/tách nền). Đồng bộ CÙNG
// thiết kế icon mới với SigMa (Admin Demo 5/8). Icon trong suốt góc + bo tròn sẵn nên KHÔNG cần bọc hộp nền
// trắng ở call-site. Dùng ẢNH THẬT, KHÔNG vẽ lại vector (bài học B118: sửa demo/vector tách rời app thật = vô nghĩa).
export function AlphaLogo({ className = 'h-7 w-7' }: { className?: string }): JSX.Element {
  return <img src={alphaLogoUrl} alt="SigMa" className={`${className} object-contain`} />;
}
