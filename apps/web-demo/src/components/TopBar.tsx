// Header phong cách macOS cho app shell (thay TitleBar.tsx của GLB desktop — bản đó điều khiển cửa
// sổ Electron thật qua IPC, web-demo không có Electron nên chỉ giữ PHONG CÁCH trực quan: 3 chấm tròn
// trang trí + tiêu đề + ThemeToggle + nút menu mobile). Hiện ở desktop-width; mobile dùng nút hamburger.
import { Menu } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { NotificationBell } from './NotificationBell';

import type { JSX } from "react";

export function TopBar({
  title,
  theme,
  onToggleTheme,
  onOpenMobileMenu,
  onOpenCalendar
}: {
  title: string;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onOpenMobileMenu: () => void;
  onOpenCalendar: () => void;
}): JSX.Element {
  return (
    // z-20 + relative (25/7, tự phát hiện khi chụp ảnh Playwright verify NotificationBell): `backdrop-blur`
    // ở đây tạo stacking context ẩn cho TopBar — nếu TopBar không tự có z-index dương, dropdown chuông
    // thông báo (position:absolute, z-50, nằm TRONG stacking context này) bị nội dung màn CHÍNH (sibling
    // phía dưới, đến SAU trong DOM, thuộc luồng bình thường) đè kín — vẫn đúng vị trí/kích thước trong
    // DOM (Playwright query "visible") nhưng KHÔNG THẤY BẰNG MẮT trên ảnh chụp thật. z-50 nội bộ vô nghĩa
    // nếu bản thân TopBar không có z-index để so sánh với sibling bên ngoài — thêm relative z-20 ở ĐÂY để
    // cả khối TopBar (kèm dropdown) luôn nổi trên nội dung màn chính.
    // SigMa (27/7, Admin Demo test thật — tiêu đề dài như "Lô & Đối soát" wrap 2 dòng đè lên status bar trên
    // máy màn hẹp) — h-12 CỐ ĐỊNH trước đây không chặn wrap, chữ tràn ra ngoài khung. pt-[env(safe-area-inset-top)] chừa chỗ
    // status bar (edge-to-edge Android 15+, xem LoginScreen.tsx), min-h-12 (không còn h-12 cứng) cho phép
    // header cao thêm đúng phần safe-area mà không ép nội dung co lại.
    <div className="relative z-20 flex min-h-12 shrink-0 items-center gap-3 border-b border-line bg-appbg/90 px-4 pt-[env(safe-area-inset-top)] backdrop-blur">
      <button type="button" onClick={onOpenMobileMenu} className="rounded p-1.5 text-slate-500 hover:bg-white lg:hidden">
        <Menu className="h-5 w-5" />
      </button>
      {/* 7/8 (Admin Demo "thừa") — BỎ 3 chấm Mac trang trí: trên exe TRÙNG với 3 nút thật ở PcTitleBar; trên web
          vô nghĩa (không phải cửa sổ macOS). Tiêu đề căn trái luôn cho gọn. */}
      {/* truncate — chặn wrap 2 dòng (bug thật 27/7): tiêu đề dài trên màn hẹp giờ cắt "..." thay vì xuống dòng. */}
      <span className="flex-1 truncate text-center text-sm font-semibold text-slate-600 lg:text-left lg:pl-1">{title}</span>
      {/* Chuông thông báo (mục Nhật ký/chuông — xem quyết định vị trí trong NotificationBell.tsx). */}
      <NotificationBell onOpenCalendar={onOpenCalendar} />
      <ThemeToggle theme={theme} onToggle={onToggleTheme} />
    </div>
  );
}
