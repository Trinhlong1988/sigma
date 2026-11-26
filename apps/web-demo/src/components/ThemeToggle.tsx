// Nút chuyển sáng/tối — set data-theme trên <html>, lưu localStorage để giữ khi reload. MỚI cho web-demo.
import { useEffect, useState, type JSX } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Switch } from './Switch';

const STORAGE_KEY = 'sigma-demo-theme';

export function useTheme(): { theme: 'light' | 'dark'; toggle: () => void } {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light';
    // Lane D vòng 2 (3/8) — LẦN ĐẦU (chưa có lựa chọn đã lưu) tôn trọng cài đặt hệ điều hành qua
    // `prefers-color-scheme` thay vì mặc định cứng 'light': máy đang ở chế độ tối mở app ra thấy ngay giao diện
    // tối, đỡ chói. Sau khi người dùng tự bấm đổi 1 lần, lựa chọn lưu localStorage sẽ luôn được ưu tiên.
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return { theme, toggle: () => setTheme((t) => (t === 'light' ? 'dark' : 'light')) };
}

// 5/8 (Admin Demo "button trượt bật/tắt vẫn cũ") — ĐỒNG NHẤT: dùng nút gạt CHUNG <Switch> (toggle-3d, bật =
// brand cyan) thay pill nhãn cũ, kèm icon Mặt trăng/Mặt trời chỉ rõ chế độ hiện tại. on = chế độ TỐI.
export function ThemeToggle({ theme, onToggle }: { theme: 'light' | 'dark'; onToggle: () => void }): JSX.Element {
  const isDark = theme === 'dark';
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-slate-500">{isDark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}</span>
      <Switch on={isDark} onChange={onToggle} label={isDark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'} />
    </div>
  );
}
