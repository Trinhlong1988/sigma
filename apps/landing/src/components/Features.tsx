import type { JSX } from 'react';
import {
  Bell,
  FileText,
  Image as ImageIcon,
  MessageSquareText,
  MapPin,
  Mic,
  Phone,
  Users,
  UserPlus,
  Video
} from 'lucide-react';

// Bộ tính năng "đầy đủ như Zalo" — nhưng thương hiệu + nội dung riêng SigMa. Ô lớn nhấn mạnh nhắn tin.
const FEATURES = [
  {
    icon: MessageSquareText,
    title: 'Nhắn tin 1-1 & nhóm',
    body: 'Trò chuyện tức thời, tạo nhóm cho từng đại lý hay dự án, ghim tin quan trọng, thả cảm xúc và trả lời trích dẫn.',
    span: true
  },
  { icon: Phone, title: 'Gọi thoại', body: 'Gọi trong ứng dụng, rõ tiếng, tiết kiệm data.' },
  { icon: Video, title: 'Gọi video', body: 'Họp mặt trực tiếp với khách và đồng đội.' },
  { icon: ImageIcon, title: 'Gửi ảnh chất lượng cao', body: 'Chia sẻ hình ảnh, bill, ảnh sản phẩm nét căng.' },
  { icon: FileText, title: 'Gửi file & tài liệu', body: 'Hợp đồng, PDF, bảng tính — gửi nhanh, tải lại dễ.' },
  { icon: Mic, title: 'Tin nhắn thoại', body: 'Nhấn giữ để nói khi bận rộn, nghe lại bất cứ lúc nào.' },
  { icon: Users, title: 'Danh bạ đại lý', body: 'Quản lý liên hệ, phân nhóm khách và nhân sự gọn gàng.' },
  { icon: UserPlus, title: 'Kết bạn & lời mời', body: 'Thêm bạn qua mã/QR, duyệt lời mời kết nối an toàn.' },
  { icon: MapPin, title: 'Chia sẻ vị trí', body: 'Gửi vị trí điểm giao dịch ngay trong khung chat.' },
  { icon: Bell, title: 'Thông báo thông minh', body: 'Báo tin mới, cuộc gọi nhỡ và cảnh báo bill kịp thời.' }
];

export function Features(): JSX.Element {
  return (
    <section id="tinh-nang" className="relative scroll-mt-20 py-20 sm:py-28">
      <div className="absolute inset-0 -z-10 surface-sunken" aria-hidden />
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="reveal mx-auto max-w-2xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full bg-brand-tint px-3.5 py-1.5 text-xs font-semibold text-brand">
            <MessageSquareText className="h-3.5 w-3.5" /> Đầy đủ để làm việc mỗi ngày
          </span>
          <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-body sm:text-4xl">
            Mọi cách để <span className="text-gradient-brand">kết nối</span>
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">
            Tất cả tính năng nhắn tin quen thuộc, gói gọn trong một ứng dụng mượt mà, hiện đại — thiết kế riêng
            cho nhịp làm việc của đại lý.
          </p>
        </div>

        <div className="mt-14 grid auto-rows-fr grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <article
              key={f.title}
              className={`reveal feature-card surface rounded-2xl p-6 shadow-soft ${f.span ? 'sm:col-span-2' : ''}`}
              style={{ transitionDelay: `${(i % 3) * 60}ms` }}
            >
              <div className="icon-tile grid h-11 w-11 place-items-center rounded-xl shadow-soft">
                <f.icon className="h-[22px] w-[22px]" />
              </div>
              <h3 className="mt-4 text-lg font-bold text-body">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{f.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
