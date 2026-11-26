// SigMa (1/8) — icon loading DÙNG CHUNG toàn app, thay `<Loader2 className="animate-spin" />` (lucide,
// vòng xoay xám đơn điệu) đã dùng rải rác ~45 chỗ trước đây. Admin Demo duyệt qua demo Artifact "Hiệu ứng Loading
// & mở lại app" — chọn phương án "🅱️ 3 chấm nhún (dùng brand)" cho MỌI chỗ đang tải dữ liệu trong app (câu
// tường minh: "loading đã chốt áp dụng cho tất cả trường hợp nếu có loading dữ liệu").
//
// `size` khớp ĐÚNG 3 cỡ Loader2 cũ hay dùng nhất trong app (h-3.5/h-4/h-5/h-6/h-8 rải rác) — quy về 3 mốc
// sm/md/lg cho nhất quán, mỗi mốc tự tính cỡ chấm+khoảng cách tỉ lệ (không cố định 1 cỡ rồi css scale, tránh
// chấm bị mờ ở cỡ nhỏ). `color` mặc định brand — TRỪ những chỗ Loader2 cũ tô trắng (nền tối/ảnh, VD MyQrScreen
// overlay quét QR) truyền `color="white"` để giữ tương phản, KHÔNG đổi ý nghĩa thị giác so với bản cũ ở đó.
import type { JSX } from 'react';

export type DotsLoaderSize = 'sm' | 'md' | 'lg';

const SIZE_PX: Record<DotsLoaderSize, number> = { sm: 5, md: 6, lg: 9 };
const GAP_PX: Record<DotsLoaderSize, number> = { sm: 3, md: 4, lg: 6 };

export function DotsLoader({
  size = 'md',
  color = 'brand',
  className
}: {
  size?: DotsLoaderSize;
  /** 'brand' (mặc định, khớp CHỐT của Admin Demo "3 chấm nhún dùng brand") hoặc 'white' (nền tối/ảnh — giữ tương
   * phản, CÙNG các chỗ Loader2 cũ đã tô trắng thủ công qua className). */
  color?: 'brand' | 'white';
  className?: string;
}): JSX.Element {
  const dot = SIZE_PX[size];
  const gap = GAP_PX[size];
  return (
    <span
      role="status"
      aria-label="Đang tải"
      className={'inline-flex items-center' + (className ? ' ' + className : '')}
      style={{ gap }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block animate-dots-bounce rounded-full"
          style={{
            width: dot,
            height: dot,
            backgroundColor: color === 'white' ? '#ffffff' : 'var(--color-brand)',
            animationDelay: `${i * 0.15}s`
          }}
        />
      ))}
    </span>
  );
}
