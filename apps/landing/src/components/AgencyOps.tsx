import type { JSX } from 'react';
import { AlertTriangle, CheckCircle2, Coins, QrCode, ReceiptText, RotateCcw, ScanLine } from 'lucide-react';

export function AgencyOps(): JSX.Element {
  return (
    <section id="nghiep-vu" className="relative scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="reveal mx-auto max-w-2xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full bg-brand-tint px-3.5 py-1.5 text-xs font-semibold text-brand">
            <ReceiptText className="h-3.5 w-3.5" /> Dành riêng cho đại lý
          </span>
          <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-body sm:text-4xl">
            Nghiệp vụ bán TID &amp; hoàn tiền, <span className="text-gradient-brand">ngay trong khung chat</span>
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">
            Không cần rời ứng dụng hay mở bảng tính. Quét bill, tính phí và đối chiếu hoàn tiền diễn ra ngay tại
            nơi bạn trò chuyện với khách.
          </p>
        </div>

        {/* Hàng 1: OCR + phí bán TID */}
        <div className="mt-16 grid items-center gap-10 lg:grid-cols-2">
          <div className="reveal order-2 lg:order-1">
            <div className="inline-flex items-center gap-2 rounded-full bg-brand-tint px-3 py-1 text-xs font-semibold text-brand">
              <ScanLine className="h-3.5 w-3.5" /> Quét bill OCR
            </div>
            <h3 className="mt-4 text-2xl font-bold text-body">Chụp bill — hệ thống tự đọc &amp; tính phí</h3>
            <p className="mt-3 text-base leading-relaxed text-muted">
              Gửi ảnh bill chuyển khoản, OCR bóc tách ngân hàng, số tiền và nội dung. Phí bán TID được tính tự
              động theo số thẻ, kèm cờ cảnh báo nếu phát hiện bill nghi vấn gian lận.
            </p>
            <ul className="mt-5 space-y-2.5">
              {[
                'Đọc chính xác số tiền, ngân hàng, nội dung chuyển khoản',
                'Tự tính phí bán TID theo số thẻ và biểu phí',
                'Cờ cảnh báo bill trùng, sửa số tiền, sai nội dung'
              ].map((t) => (
                <li key={t} className="flex items-start gap-2.5 text-sm text-body">
                  <CheckCircle2 className="mt-0.5 h-4.5 w-4.5 shrink-0 text-success" />
                  {t}
                </li>
              ))}
            </ul>
          </div>

          {/* Mock: thẻ bill OCR */}
          <div className="reveal order-1 flex justify-center lg:order-2">
            <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-hair surface shadow-card">
              <div className="flex items-center justify-between bg-gradient-brand px-4 py-3 text-white">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <ScanLine className="h-4 w-4" /> Kết quả OCR
                </span>
                <span className="rounded-full bg-white/20 px-2 py-0.5 text-[11px]">Độ tin cậy 98%</span>
              </div>
              <div className="space-y-3 p-5">
                <BillRow icon={ReceiptText} label="Ngân hàng" value="Vietcombank" />
                <BillRow icon={Coins} label="Số tiền" value="12.500.000đ" strong />
                <BillRow icon={QrCode} label="Nội dung" value="TT TID 0123" />
                <div className="rounded-xl bg-brand-tint p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-brand">Phí bán TID</span>
                    <span className="text-lg font-extrabold text-brand">250.000đ</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">2 thẻ × 125.000đ · đã đối chiếu với niêm yết</p>
                </div>
                <div className="flex items-center gap-2 rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  Chống gian lận: đã kiểm tra trùng mã giao dịch — an toàn.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Hàng 2: đối chiếu hoàn tiền */}
        <div className="mt-20 grid items-center gap-10 lg:grid-cols-2">
          {/* Mock: dòng đối chiếu hoàn tiền */}
          <div className="reveal flex justify-center">
            <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-hair surface shadow-card">
              <div className="flex items-center gap-2 border-b border-hair px-4 py-3 text-sm font-semibold text-body">
                <RotateCcw className="h-4 w-4 text-brand" /> Đối chiếu hoàn tiền
              </div>
              <ul className="divide-y divide-[color:var(--color-line)]">
                {[
                  { name: 'Hoàn KH Nguyễn A', amount: '1.200.000đ', ok: true },
                  { name: 'Hoàn KH Trần B', amount: '850.000đ', ok: true },
                  { name: 'Hoàn KH Lê C', amount: '2.000.000đ', ok: false }
                ].map((r) => (
                  <li key={r.name} className="flex items-center justify-between px-4 py-3 text-sm">
                    <span className="text-body">{r.name}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-semibold text-body">{r.amount}</span>
                      {r.ok ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-success dark:bg-emerald-500/10">
                          <CheckCircle2 className="h-3 w-3" /> Khớp
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                          <AlertTriangle className="h-3 w-3" /> Chờ
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="reveal">
            <div className="inline-flex items-center gap-2 rounded-full bg-brand-tint px-3 py-1 text-xs font-semibold text-brand">
              <RotateCcw className="h-3.5 w-3.5" /> Đối chiếu hoàn tiền
            </div>
            <h3 className="mt-4 text-2xl font-bold text-body">Hoàn tiền minh bạch, khớp từng đồng</h3>
            <p className="mt-3 text-base leading-relaxed text-muted">
              Ghi nhận yêu cầu hoàn tiền của khách, đối chiếu với bill đã quét và tự đánh dấu khoản nào đã khớp,
              khoản nào còn chờ. Mọi thứ có dấu vết rõ ràng để hai bên cùng yên tâm.
            </p>
            <ul className="mt-5 space-y-2.5">
              {[
                'Tạo phiếu hoàn tiền ngay trong cuộc trò chuyện',
                'Tự động so khớp với giao dịch đã ghi nhận',
                'Trạng thái rõ ràng: đã khớp / còn chờ xử lý'
              ].map((t) => (
                <li key={t} className="flex items-start gap-2.5 text-sm text-body">
                  <CheckCircle2 className="mt-0.5 h-4.5 w-4.5 shrink-0 text-success" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function BillRow({
  icon: Icon,
  label,
  value,
  strong
}: {
  icon: typeof ReceiptText;
  label: string;
  value: string;
  strong?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-sm text-muted">
        <Icon className="h-4 w-4 text-brand" /> {label}
      </span>
      <span className={strong ? 'text-base font-bold text-body' : 'text-sm font-medium text-body'}>{value}</span>
    </div>
  );
}
