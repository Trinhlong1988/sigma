import type { JSX } from 'react';
import { ShieldCheck } from 'lucide-react';
import { AlphaLogo } from './AlphaLogo';

const COLS = [
  {
    title: 'Sản phẩm',
    links: [
      { label: 'Bảo mật', href: '#bao-mat' },
      { label: 'Tính năng', href: '#tinh-nang' },
      { label: 'Nghiệp vụ đại lý', href: '#nghiep-vu' },
      { label: 'Tải về', href: '#tai-ve' }
    ]
  },
  {
    title: 'Nền tảng',
    links: [
      { label: 'iOS (sắp có)', href: '#tai-ve' },
      { label: 'Android', href: '#tai-ve' },
      { label: 'PC — Windows', href: '#tai-ve' },
      { label: 'Web', href: '#tai-ve' }
    ]
  },
  {
    title: 'Pháp lý',
    links: [
      { label: 'Điều khoản sử dụng', href: '#' },
      { label: 'Chính sách bảo mật', href: '#' },
      { label: 'Liên hệ hỗ trợ', href: '#' }
    ]
  }
];

export function Footer(): JSX.Element {
  return (
    <footer className="border-t border-hair surface">
      <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <a href="#top" className="flex items-center gap-2.5">
              <AlphaLogo className="h-9 w-9 logo-glow" />
              <span className="text-lg font-extrabold tracking-tight text-body">SigMa</span>
            </a>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted">
              Nền tảng nhắn tin an toàn cho đại lý — trò chuyện, quét bill, tính phí bán TID và đối chiếu hoàn
              tiền, với bảo mật đặt lên hàng đầu.
            </p>
            <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand">
              <ShieldCheck className="h-3.5 w-3.5" /> Mã hoá đầu cuối
            </div>
          </div>

          {COLS.map((col) => (
            <div key={col.title}>
              <h4 className="text-sm font-bold text-body">{col.title}</h4>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a href={l.href} className="text-sm text-muted transition hover:text-brand">
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-hair pt-6 text-xs text-muted sm:flex-row">
          <p>© {new Date().getFullYear()} SigMa. Bảo lưu mọi quyền.</p>
          <p>Kết nối an toàn cho đại lý.</p>
        </div>
      </div>
    </footer>
  );
}
