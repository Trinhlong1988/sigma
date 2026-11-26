import type { JSX } from 'react';
import { Eye, Fingerprint, KeyRound, Lock, ServerCog, ShieldCheck } from 'lucide-react';

const PILLARS = [
  {
    icon: Lock,
    title: 'Mã hoá đầu cuối',
    body: 'Tin nhắn, hình ảnh và file được mã hoá — chỉ người gửi và người nhận đọc được, không ai ở giữa xem trộm.'
  },
  {
    icon: Fingerprint,
    title: 'Đăng nhập an toàn',
    body: 'Xác thực qua Google và khoá thiết bị (Credential Manager). Không lưu mật khẩu thô, không lộ thông tin đăng nhập.'
  },
  {
    icon: ShieldCheck,
    title: 'Chống gian lận bill',
    body: 'OCR đọc bill kèm cờ cảnh báo nghi vấn (trùng mã, sửa số tiền) — bảo vệ dòng tiền của đại lý khỏi bill giả.'
  },
  {
    icon: KeyRound,
    title: 'Quyền theo vai trò',
    body: 'Chủ đại lý, kế toán, nhân viên thấy đúng phần việc của mình. Dữ liệu khách hàng phân quyền chặt chẽ.'
  },
  {
    icon: ServerCog,
    title: 'Dữ liệu của bạn ở lại với bạn',
    body: 'Máy chủ riêng cho đại lý, không bán dữ liệu, không quảng cáo. Thông tin khách hàng không rời khỏi tổ chức.'
  },
  {
    icon: Eye,
    title: 'Riêng tư mặc định',
    body: 'Trạng thái hoạt động, danh bạ và lịch sử giao dịch chỉ hiển thị cho người bạn cho phép.'
  }
];

export function Security(): JSX.Element {
  return (
    <section id="bao-mat" className="relative scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="reveal mx-auto max-w-2xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full bg-brand-tint px-3.5 py-1.5 text-xs font-semibold text-brand">
            <Lock className="h-3.5 w-3.5" /> Bảo mật là nền móng
          </span>
          <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-body sm:text-4xl">
            Khách hàng &amp; thông tin của bạn được <span className="text-gradient-brand">giữ kín</span>
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">
            SigMa được xây quanh một nguyên tắc: mọi cuộc trò chuyện và giao dịch phải riêng tư, an toàn và
            thuộc về chính bạn. Không đánh đổi tiện lợi lấy sự riêng tư.
          </p>
        </div>

        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map((p, i) => (
            <article
              key={p.title}
              className="reveal feature-card surface rounded-2xl p-6 shadow-soft"
              style={{ transitionDelay: `${(i % 3) * 70}ms` }}
            >
              <div className="icon-tile grid h-12 w-12 place-items-center rounded-xl shadow-soft">
                <p.icon className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-lg font-bold text-body">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{p.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
