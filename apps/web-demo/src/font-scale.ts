// Cỡ chữ toàn app (mục 22 — như Zalo, Admin Demo bổ sung 23/7): 4 mức Nhỏ/Vừa/Lớn/Rất lớn.
// Wire THẬT qua font-size của <html> (px) — mọi text class Tailwind dùng rem nên đổi root là cả app
// đổi ngay lập tức. Lưu localStorage để giữ khi reload. main.tsx gọi initFontLevel() lúc mount.
export type FontLevel = 'nho' | 'vua' | 'lon' | 'rat-lon';

// Giá trị gốc (mức "Vừa" = scale 1) của root font-size. Admin Demo 24/7: tăng +2px so với trước
// (16px trình duyệt mặc định → 18px) để chữ toàn app to hơn dễ đọc; các mức khác vẫn nhân theo
// đúng tỉ lệ scale cũ trên nền base mới nên cơ chế 4 mức không đổi, chỉ đổi điểm gốc.
const BASE_PX = 18;

export const FONT_LEVELS: Array<{ level: FontLevel; label: string; scale: number }> = [
  { level: 'nho', label: 'Nhỏ', scale: 0.875 },
  { level: 'vua', label: 'Vừa', scale: 1 },
  { level: 'lon', label: 'Lớn', scale: 1.125 },
  { level: 'rat-lon', label: 'Rất lớn', scale: 1.25 }
];

const STORAGE_KEY = 'sigma-demo-fontsize';

export function currentFontLevel(): FontLevel {
  if (typeof window === 'undefined') return 'vua';
  const saved = window.localStorage.getItem(STORAGE_KEY);
  return FONT_LEVELS.some((f) => f.level === saved) ? (saved as FontLevel) : 'vua';
}

export function applyFontLevel(level: FontLevel): void {
  const entry = FONT_LEVELS.find((f) => f.level === level) ?? FONT_LEVELS[1];
  // px tuyệt đối (không phải %) — % trên chính root <html> luôn quy chiếu về giá trị mặc định của
  // trình duyệt (thường 16px) bất kể CSS nào khác đặt trên html, nên không thể dùng % để dịch điểm
  // gốc lên 18px. Nhân trực tiếp scale * BASE_PX để vừa dịch gốc +2px vừa giữ đúng tỉ lệ 4 mức.
  document.documentElement.style.fontSize = `${entry.scale * BASE_PX}px`;
  window.localStorage.setItem(STORAGE_KEY, entry.level);
}

export function initFontLevel(): void {
  applyFontLevel(currentFontLevel());
}
