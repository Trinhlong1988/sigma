import type { ButtonHTMLAttributes, ReactNode } from 'react';

// Quy ước màu button theo ngữ nghĩa (R_BUTTON_SEMANTICS, LEAD lock 9/7):
//   confirm = xanh brand glass (thực hiện / xác nhận / lưu / thêm mới / xuất Excel / lọc)
//   teal    = xanh ngọc (nhấn phụ cùng hệ brand — hiếm dùng)
//   edit    = vàng (sửa / chỉnh sửa)
//   danger  = đỏ (xóa / hủy phiếu / đăng xuất)
//   soft    = xanh nhạt glass (phụ: làm mới / xóa lọc / hủy / import-export mẫu / mở thư mục)
//   neutral = alias của soft (giữ tương thích ngược — mọi nút "Hủy" cùng 1 kiểu soft)
export type ButtonVariant = 'confirm' | 'teal' | 'edit' | 'danger' | 'soft' | 'neutral';
// Kích thước đồng nhất: md = nút chính (thanh công cụ), sm = nút trong hàng/cụm nhỏ, xs = nút micro trong ô.
export type ButtonSize = 'xs' | 'sm' | 'md';

// R_UI_HOVER (Admin Demo chốt 10/7): hover nút = "sáng nhẹ" (brightness) đồng nhất mọi variant, GIỮ NGUYÊN
// màu nền. Admin Demo 3/8 — 100% button đồng bộ 3D (gradient theo hue + bóng đổ + lún active + dải sáng kính).
// Mỗi variant map tới 1 class glass trong brand.css/styles.css (1 nguồn); GIỮ ĐÚNG ngữ nghĩa màu.
// Admin Demo 11/8: chữ nút GLASS SÁNG (confirm/teal/soft/edit) = 1 màu TỐI ĐỒNG NHẤT (#0d4a7a) cho dễ đọc
// (trước dùng text-white → mờ trên nền glass sáng). GIỮ NGUYÊN màu nền nút. Chỉ nút ĐỎ (danger) giữ chữ trắng
// (nền đỏ đậm đọc rõ). `!` để thắng màu `color` trong brand.css.
const GLASS_TEXT = 'text-[#0d4a7a]';
const VARIANT: Record<ButtonVariant, string> = {
  confirm: 'btn-primary ' + GLASS_TEXT,
  teal: 'btn-teal ' + GLASS_TEXT,
  edit: 'btn-edit ' + GLASS_TEXT,
  danger: 'btn-danger text-white',
  soft: 'btn-soft ' + GLASS_TEXT,
  neutral: 'btn-soft ' + GLASS_TEXT
};

const SIZE: Record<ButtonSize, string> = {
  xs: 'gap-1 px-2.5 py-1.5 text-xs',
  sm: 'gap-1.5 px-3 py-1.5 text-sm',
  md: 'gap-2 px-4 py-2.5 text-sm'
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  children: ReactNode;
}

export function Button({ variant = 'confirm', size = 'md', icon, children, className = '', disabled, ...rest }: Props): JSX.Element {
  return (
    <button
      {...rest}
      disabled={disabled}
      className={
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-lg font-semibold transition ' +
        'enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 ' +
        SIZE[size] + ' ' +
        VARIANT[variant] +
        (className ? ' ' + className : '')
      }
    >
      {icon}
      {children}
    </button>
  );
}
