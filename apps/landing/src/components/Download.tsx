import { useEffect, useState, type JSX } from 'react';
import { Apple, Building2, Clock, Download as DownloadIcon, Globe, Monitor, QrCode, Smartphone } from 'lucide-react';
import { AlphaLogo } from './AlphaLogo';

/*
 * KHU TẢI VỀ — 4 nền tảng. Link hiện là PLACEHOLDER, Admin Demo gắn bản build thật sau (xem README):
 *   • iOS     → nút "Sắp có", DISABLED (không phải link chết).
 *   • Android → APK: href /downloads/sigma-latest.apk (đặt file thật vào apps/landing/public/downloads/).
 *   • PC      → Windows: /downloads/sigma-setup.exe (placeholder).
 *   • Web     → Mở bản Web: href '#' placeholder (thay bằng URL bản web thật).
 * Khi thay link thật: sửa `href` trong mảng PLATFORMS dưới đây.
 */

// PHIÊN BẢN HIỂN THỊ — ĐỌC ĐỘNG từ `/downloads/versions.json` (same-origin, do publish scripts tự ghi MỖI lần
// ship) để KHÔNG BAO GIỜ stale + KHÔNG cần bump tay/rebuild landing (Admin Demo 15/8 "cấm tái diễn" sau khi landing
// kẹt 0.4.65/0.2.95). Hằng dưới chỉ là FALLBACK khi fetch lỗi/chưa có file.
const APP_VERSION_FALLBACK = '0.4.71';
const MGMT_VERSION_FALLBACK = '0.2.96';

type Platform = {
  key: string;
  icon: typeof Apple;
  name: string;
  sub: string;
  cta: string;
  href?: string;
  download?: boolean;
  external?: boolean;
  note?: string;
  comingSoon?: boolean;
};

function makePlatforms(APP_VERSION: string): Platform[] {
  return [
  {
    key: 'ios',
    icon: Apple,
    name: 'iOS',
    sub: 'iPhone & iPad',
    cta: 'Sắp có',
    comingSoon: true,
    note: 'Bản App Store đang hoàn thiện.'
  },
  {
    key: 'android',
    icon: Smartphone,
    name: 'Android',
    sub: 'Điện thoại & máy tính bảng',
    cta: 'Tải APK',
    href: '/downloads/sigma-latest.apk',
    download: true,
    note: `Bản ${APP_VERSION} · Android 7.0 trở lên · đã ký số.`
  },
  {
    key: 'pc',
    icon: Monitor,
    name: 'PC — Windows',
    sub: 'Bản desktop cho máy tính',
    cta: 'Tải bản Windows',
    href: '/downloads/sigma-latest-setup.exe',
    download: true,
    note: `Bản ${APP_VERSION} · Windows 10/11 (64-bit).`
  },
  {
    key: 'web',
    icon: Globe,
    name: 'Web',
    sub: 'Dùng ngay trên trình duyệt',
    cta: 'Mở bản Web',
    href: 'https://chat.example.com',
    external: true,
    note: 'Dùng ngay trên trình duyệt, không cần cài đặt.'
  }
  ];
}

export function Download(): JSX.Element {
  // Đọc version thật từ manifest same-origin (publish tự ghi). Lỗi/chưa có → giữ fallback. KHÔNG chặn render.
  const [appVersion, setAppVersion] = useState(APP_VERSION_FALLBACK);
  const [mgmtVersion, setMgmtVersion] = useState(MGMT_VERSION_FALLBACK);
  const [cqrVersion, setCqrVersion] = useState('1.0.0');
  useEffect(() => {
    let alive = true;
    // APK: đọc thẳng từ sigma-version.json — file MỌI lần publish APK đều ghi (versionName) → LUÔN đúng, không
    // phụ thuộc ai nhớ cập nhật. mgmt (SigMa desktop): từ versions.json do publish-quanly-alpha ghi.
    fetch('/downloads/sigma-version.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { versionName?: string } | null) => { if (alive && j?.versionName) setAppVersion(j.versionName); })
      .catch(() => { /* giữ fallback */ });
    fetch('/downloads/versions.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { mgmt?: string; cqr?: string } | null) => {
        if (alive && j?.mgmt) setMgmtVersion(j.mgmt);
        if (alive && j?.cqr) setCqrVersion(j.cqr);
      })
      .catch(() => { /* giữ fallback */ });
    return () => { alive = false; };
  }, []);
  const PLATFORMS = makePlatforms(appVersion);
  const MGMT_VERSION = mgmtVersion;
  return (
    <section id="tai-ve" className="relative scroll-mt-20 overflow-hidden py-20 sm:py-28">
      <div className="absolute inset-0 -z-10 surface-sunken" aria-hidden />
      <div
        className="aurora drift-slow -z-10 left-1/2 top-0 h-[360px] w-[360px] -translate-x-1/2"
        style={{ background: 'radial-gradient(circle, #3bc3d0 0%, transparent 70%)' }}
        aria-hidden
      />

      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="reveal mx-auto max-w-2xl text-center">
          {/* 5/8 — logo master mới đã là tile kính bo góc + trong suốt 4 góc → BỎ hộp trắng/viền/shadow bọc
              ngoài (Admin Demo: "nền vuông trắng + viền khác màu"). Giữ animation logo-glow. */}
          <div className="mx-auto mb-5 grid h-16 w-16 place-items-center">
            <AlphaLogo className="h-16 w-16 logo-glow" />
          </div>
          <h2 className="text-3xl font-extrabold tracking-tight text-body sm:text-4xl">
            Tải <span className="text-gradient-brand">SigMa</span> ngay
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">
            Có mặt trên mọi thiết bị bạn dùng. Chọn nền tảng để bắt đầu kết nối an toàn.
          </p>
        </div>

        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {PLATFORMS.map((p, i) => (
            <PlatformCard key={p.key} platform={p} index={i} />
          ))}
        </div>

        {/* SigMa = phần mềm QUẢN LÝ nội bộ (khác app chat SigMa) — khối riêng, nhãn "Nội bộ". */}
        <a
          href="/downloads/alpha-latest-setup.exe"
          download=""
          className="reveal feature-card surface mt-6 flex flex-col items-center gap-4 rounded-2xl p-6 text-center shadow-soft sm:flex-row sm:justify-between sm:text-left"
        >
          <div className="flex items-center gap-4">
            <div className="icon-tile grid h-12 w-12 shrink-0 place-items-center rounded-xl shadow-soft">
              <Building2 className="h-6 w-6" />
            </div>
            <div>
              <h3 className="flex items-center gap-2 text-base font-bold text-body">
                SigMa
                <span className="rounded-full bg-brand-tint px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
                  Nội bộ
                </span>
              </h3>
              <p className="mt-0.5 text-sm text-muted">
                Phần mềm quản lý dành cho nhân sự · Windows 10/11 · Bản {MGMT_VERSION}
              </p>
            </div>
          </div>
          <span className="btn-primary inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full px-5 py-2.5 text-sm font-semibold">
            <DownloadIcon className="h-4 w-4" /> Tải SigMa
          </span>
        </a>

        {/* CQR — app ĐỘC LẬP check báo có QR Bản Việt (Admin Demo 14/9: landing phải có giới thiệu + nút tải CQR).
            Zip vì exe ~106MB; người dùng tự cài chạy local, dữ liệu tại máy họ. */}
        <a
          href="/downloads/CQR-Setup-1.0.0.zip"
          download=""
          className="reveal feature-card surface mt-6 flex flex-col items-center gap-4 rounded-2xl p-6 text-center shadow-soft sm:flex-row sm:justify-between sm:text-left"
        >
          <div className="flex items-center gap-4">
            <div className="icon-tile grid h-12 w-12 shrink-0 place-items-center rounded-xl shadow-soft">
              <QrCode className="h-6 w-6" />
            </div>
            <div>
              <h3 className="flex items-center gap-2 text-base font-bold text-body">
                CQR — Check báo có QR Bản Việt
                <span className="rounded-full bg-brand-tint px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
                  Độc lập
                </span>
              </h3>
              <p className="mt-0.5 text-sm text-muted">
                Theo dõi báo có QR nhiều tài khoản: cảnh báo ngưỡng doanh số, đối soát giao dịch theo đại lý,
                phí bán &amp; hoàn tiền, xuất ảnh báo cáo gửi khách. Chạy độc lập trên máy bạn, dữ liệu lưu tại máy ·
                Windows 10/11 · Bản {cqrVersion} (zip, giải nén rồi chạy Setup)
              </p>
            </div>
          </div>
          <span className="btn-primary inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full px-5 py-2.5 text-sm font-semibold">
            <DownloadIcon className="h-4 w-4" /> Tải CQR
          </span>
        </a>

        <p className="reveal mt-10 text-center text-xs text-muted">
          Bằng việc tải, bạn đồng ý với Điều khoản sử dụng &amp; Chính sách bảo mật của SigMa.
        </p>
      </div>
    </section>
  );
}

function PlatformCard({ platform: p, index }: { platform: Platform; index: number }): JSX.Element {
  const Icon = p.icon;

  const inner = (
    <>
      {/* 5/8 (Admin Demo "MỌI icon-tile cùng 1 gradient ĐẬM, kể cả Apple/iOS") — mọi ô icon nền tảng dùng
          .icon-tile (gradient brand đậm, chữ trắng), kể cả iOS "Sắp có" — đồng nhất tuyệt đối, hết chỗ
          teal-nhạt chỗ xanh-đậm. Trạng thái "sắp có" thể hiện ở NÚT bên dưới (muted), không ở ô icon. */}
      <div className="icon-tile grid h-14 w-14 place-items-center rounded-2xl shadow-soft">
        <Icon className="h-7 w-7" />
      </div>
      <div className="mt-4">
        <h3 className="text-lg font-bold text-body">{p.name}</h3>
        <p className="text-sm text-muted">{p.sub}</p>
      </div>

      <div className="mt-5">
        {p.comingSoon ? (
          <span className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-hair surface-sunken px-4 py-2.5 text-sm font-semibold text-muted">
            <Clock className="h-4 w-4" /> {p.cta}
          </span>
        ) : (
          <span className="btn-primary inline-flex w-full items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold">
            <DownloadIcon className="h-4 w-4" /> {p.cta}
          </span>
        )}
      </div>

      {p.note && <p className="mt-3 text-[11px] leading-snug text-muted">{p.note}</p>}
    </>
  );

  const cardClass =
    'reveal feature-card surface flex flex-col rounded-2xl p-6 text-left shadow-soft';
  const style = { transitionDelay: `${index * 70}ms` } as const;

  // iOS: nút disabled thật sự (không phải link chết) — render <div aria-disabled>, không có href.
  if (p.comingSoon) {
    return (
      <div className={`${cardClass} opacity-95`} style={style} aria-disabled="true">
        {inner}
      </div>
    );
  }

  // Android/PC: tải file (download). Web: mở link (external).
  return (
    <a
      className={cardClass}
      style={style}
      href={p.href}
      {...(p.download ? { download: '' } : {})}
      {...(p.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {inner}
    </a>
  );
}
