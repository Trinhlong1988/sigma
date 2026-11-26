import { useEffect, useState, type JSX } from 'react';
import { Menu, X } from 'lucide-react';
import { AlphaLogo } from './AlphaLogo';
import { ThemeToggle } from './ThemeToggle';

const LINKS = [
  { href: '#bao-mat', label: 'Bảo mật' },
  { href: '#tinh-nang', label: 'Tính năng' },
  { href: '#nghiep-vu', label: 'Nghiệp vụ đại lý' },
  { href: '#tai-ve', label: 'Tải về' }
];

export function Nav(): JSX.Element {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${
        scrolled ? 'glass border-b border-hair shadow-soft' : 'border-b border-transparent'
      }`}
    >
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
        <a href="#top" className="flex items-center gap-2.5" aria-label="SigMa — về đầu trang">
          <AlphaLogo className="h-9 w-9 logo-glow" />
          <span className="text-lg font-extrabold tracking-tight text-body">SigMa</span>
        </a>

        <div className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="rounded-full px-3.5 py-2 text-sm font-medium text-muted transition hover:bg-brand-tint hover:text-brand"
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <a href="#tai-ve" className="btn-primary hidden rounded-full px-5 py-2.5 text-sm font-semibold sm:inline-flex">
            Tải SigMa
          </a>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Đóng menu' : 'Mở menu'}
            aria-expanded={open}
            className="grid h-10 w-10 place-items-center rounded-full border border-hair surface text-body md:hidden"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </nav>

      {/* Menu di động */}
      {open && (
        <div className="glass border-t border-hair px-5 py-3 md:hidden">
          <div className="flex flex-col gap-1">
            {LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-xl px-4 py-3 text-sm font-medium text-body transition hover:bg-brand-tint hover:text-brand"
              >
                {l.label}
              </a>
            ))}
            <a
              href="#tai-ve"
              onClick={() => setOpen(false)}
              className="btn-primary mt-1 px-4 py-3 text-center text-sm font-semibold"
            >
              Tải SigMa
            </a>
          </div>
        </div>
      )}
    </header>
  );
}
