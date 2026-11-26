import type { JSX } from 'react';
import { Apple, ArrowRight, Lock, ShieldCheck, Smartphone } from 'lucide-react';
import { PhoneMock } from './PhoneMock';

const TRUST = [
  { icon: Lock, label: 'Mã hoá đầu cuối' },
  { icon: ShieldCheck, label: 'Chống gian lận bill' },
  { icon: Smartphone, label: 'iOS · Android · PC · Web' }
];

export function Hero(): JSX.Element {
  return (
    <section id="top" className="relative overflow-hidden pt-28 pb-16 sm:pt-32 lg:pb-24">
      {/* Nền: đốm aurora brand + lưới chấm mờ */}
      <div className="absolute inset-0 -z-10 dot-grid" aria-hidden />
      <div
        className="aurora drift-slow -z-10 left-[-10%] top-[-8%] h-[420px] w-[420px]"
        style={{ background: 'radial-gradient(circle, #1877d6 0%, transparent 70%)' }}
        aria-hidden
      />
      <div
        className="aurora drift-slower -z-10 right-[-8%] top-[10%] h-[380px] w-[380px]"
        style={{ background: 'radial-gradient(circle, #3bc3d0 0%, transparent 70%)' }}
        aria-hidden
      />

      <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 sm:px-8 lg:grid-cols-[1.05fr_0.95fr]">
        {/* Cột chữ */}
        <div className="reveal">
          <span className="inline-flex items-center gap-2 rounded-full border border-hair surface px-3.5 py-1.5 text-xs font-semibold text-brand shadow-soft">
            <ShieldCheck className="h-3.5 w-3.5" />
            Kết nối an toàn cho đại lý
          </span>

          <h1 className="mt-5 text-4xl font-extrabold leading-[1.08] tracking-tight text-body sm:text-5xl lg:text-6xl">
            Trò chuyện, giao dịch —<br />
            <span className="text-gradient-brand">bảo mật lên hàng đầu.</span>
          </h1>

          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
            SigMa là nền tảng nhắn tin dành cho đại lý: nhắn tin, gọi thoại/video, gửi ảnh &amp; file,
            quét bill OCR tính phí bán TID và đối chiếu hoàn tiền — tất cả trong một ứng dụng
            <span className="font-semibold text-body"> đặt bảo mật khách hàng &amp; thông tin lên trước tiên.</span>
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a href="#tai-ve" className="btn-primary inline-flex items-center gap-2 rounded-full px-6 py-3.5 text-sm font-semibold">
              Tải SigMa
              <ArrowRight className="h-4 w-4" />
            </a>
            <a href="#bao-mat" className="btn-soft inline-flex items-center gap-2 rounded-full px-6 py-3.5 text-sm font-semibold">
              Vì sao an toàn?
            </a>
          </div>

          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3">
            {TRUST.map((t) => (
              <div key={t.label} className="flex items-center gap-2 text-sm text-muted">
                <t.icon className="h-4 w-4 text-brand" />
                {t.label}
              </div>
            ))}
          </div>

          <p className="mt-6 flex items-center gap-1.5 text-xs text-muted">
            <Apple className="h-3.5 w-3.5" /> Bản iOS sắp có · Android/PC/Web tải ngay bên dưới
          </p>
        </div>

        {/* Cột hình: halo + logo lớn + điện thoại */}
        <div className="reveal relative flex items-center justify-center">
          <div
            className="halo-pulse absolute h-[340px] w-[340px] rounded-full"
            style={{ background: 'radial-gradient(circle, rgba(5,121,204,0.35) 0%, rgba(19,183,195,0.18) 45%, transparent 70%)' }}
            aria-hidden
          />
          <PhoneMock />
        </div>
      </div>
    </section>
  );
}
