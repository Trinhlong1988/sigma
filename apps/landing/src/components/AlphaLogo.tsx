import type { JSX } from 'react';
import alphaLogoUrl from '../assets/sigma-logo.svg';

// NHÚNG ẢNH LOGO THẬT của app SigMa (apps/web-demo/src/assets/sigma-logo.svg) — KHÔNG vẽ lại vector
// khác (bài học B118: cấm tách rời asset demo khỏi app thật). Cùng file, cùng thương hiệu.
export function AlphaLogo({ className = 'h-9 w-9' }: { className?: string }): JSX.Element {
  return <img src={alphaLogoUrl} alt="SigMa" className={`${className} object-contain`} draggable={false} />;
}
