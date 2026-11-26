import type { JSX } from 'react';
import { CheckCheck, Phone, ScanLine, ShieldCheck, Video } from 'lucide-react';
import { AlphaLogo } from './AlphaLogo';

// Khung điện thoại mô phỏng cuộc trò chuyện SigMa — dữ liệu MẪU (tiếng Việt), dựng để showcase giao
// diện chat + hoá đơn OCR bằng đúng brand token (bong bóng "của mình" dùng gradient brand giống app thật).
export function PhoneMock(): JSX.Element {
  return (
    <div className="relative mx-auto w-[264px] shrink-0 sm:w-[300px]">
      {/* Thân máy */}
      <div className="relative overflow-hidden rounded-[2.6rem] border border-hair bg-black p-2 shadow-card">
        <div className="overflow-hidden rounded-[2.1rem] surface">
          {/* Thanh trên cùng cuộc trò chuyện */}
          <div className="bg-gradient-brand px-4 pb-3 pt-5 text-white">
            <div className="mx-auto mb-3 h-1 w-16 rounded-full bg-white/40" />
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-full bg-white/20 text-sm font-bold">
                HK
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">Hồng Kông Đại Lý</p>
                <p className="flex items-center gap-1 text-[11px] text-white/80">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300" />
                  Đang hoạt động
                </p>
              </div>
              <Phone className="h-[18px] w-[18px] opacity-90" />
              <Video className="h-[18px] w-[18px] opacity-90" />
            </div>
          </div>

          {/* Khung tin nhắn */}
          <div className="surface-sunken space-y-2.5 px-3 py-4">
            <div className="mx-auto w-fit rounded-full bg-black/5 px-2.5 py-0.5 text-[10px] text-muted dark:bg-white/10">
              Hôm nay
            </div>

            {/* Tin của đối phương */}
            <div className="flex justify-start">
              <div className="max-w-[78%] rounded-2xl rounded-bl-md surface px-3 py-2 text-[13px] text-body shadow-soft">
                Anh gửi em bill chuyển khoản với nhé
              </div>
            </div>

            {/* Ảnh bill của mình */}
            <div className="flex justify-end">
              <div className="max-w-[82%] space-y-1.5 rounded-2xl rounded-br-md bg-white/70 p-1.5 shadow-soft">
                <div className="overflow-hidden rounded-xl border border-hair bg-white">
                  <div className="flex items-center gap-1.5 border-b border-hair bg-brand-tint px-2.5 py-1.5 text-[11px] font-semibold text-brand">
                    <ScanLine className="h-3.5 w-3.5" /> Đã quét OCR
                  </div>
                  <div className="space-y-1 px-2.5 py-2 text-[11px]">
                    <Row label="Ngân hàng" value="Vietcombank" />
                    <Row label="Số tiền" value="12.500.000đ" strong />
                    <Row label="Nội dung" value="TT TID 0123" />
                  </div>
                </div>
              </div>
            </div>

            {/* Thẻ phí bán TID */}
            <div className="flex justify-end">
              <div className="chat-bubble-mine max-w-[82%] rounded-2xl rounded-br-md px-3 py-2 text-[13px] text-white">
                <p className="font-semibold">Phí bán TID: 250.000đ</p>
                <p className="text-[11px] text-white/85">2 thẻ × 125.000đ · đã đối chiếu ✓</p>
                <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-white/80">
                  09:24 <CheckCheck className="h-3 w-3" />
                </div>
              </div>
            </div>

            {/* Đang nhập */}
            <div className="flex justify-start">
              <div className="flex items-center gap-1 rounded-2xl rounded-bl-md surface px-3 py-2.5 shadow-soft">
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-brand" />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-brand" style={{ animationDelay: '0.15s' }} />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-brand" style={{ animationDelay: '0.3s' }} />
              </div>
            </div>
          </div>

          {/* Ô soạn tin */}
          <div className="flex items-center gap-2 border-t border-hair surface px-3 py-2.5">
            <div className="flex-1 rounded-full surface-sunken px-3 py-2 text-[12px] text-muted">Nhắn tin…</div>
            <div className="grid h-8 w-8 place-items-center rounded-full bg-gradient-brand text-white">
              <ScanLine className="h-4 w-4" />
            </div>
          </div>
        </div>
      </div>

      {/* Huy hiệu mã hoá nổi góc */}
      <div className="absolute -left-5 bottom-16 hidden items-center gap-2 rounded-2xl border border-hair surface px-3 py-2 shadow-card sm:flex">
        <ShieldCheck className="h-5 w-5 text-success" />
        <div className="text-[11px] leading-tight">
          <p className="font-semibold text-body">Mã hoá đầu cuối</p>
          <p className="text-muted">Chỉ 2 bên đọc được</p>
        </div>
      </div>

      {/* Logo nổi góc trên */}
      <div className="absolute -right-4 -top-4 grid h-14 w-14 place-items-center">
        <AlphaLogo className="h-14 w-14 logo-glow" />
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className={strong ? 'font-bold text-brand' : 'font-medium text-body'}>{value}</span>
    </div>
  );
}
