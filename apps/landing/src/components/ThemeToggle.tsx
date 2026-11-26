import { useEffect, useState, type JSX } from 'react';
import { Moon, Sun } from 'lucide-react';

type Theme = 'light' | 'dark';

// Chuyển sáng/tối, lưu localStorage (khớp key khởi tạo ở main.tsx). Đặt data-theme trên <html> —
// CÙNG cơ chế app thật (ThemeToggle.tsx trong web-demo).
export function ThemeToggle({ className = '' }: { className?: string }): JSX.Element {
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.dataset.theme as Theme) ?? 'light'
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('sigma-theme', theme);
  }, [theme]);

  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
      title={theme === 'dark' ? 'Giao diện sáng' : 'Giao diện tối'}
      className={`grid h-10 w-10 place-items-center rounded-full border border-hair surface text-body shadow-soft transition hover:text-brand ${className}`}
    >
      {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
  );
}
