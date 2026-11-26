import type { ReactNode } from 'react';

// Nút thao tác CHỈ-ICON dùng chung cho cột "Thao tác" của MỌI bảng (R_BUTTON_SEMANTICS).
// Thay cho ~15 bản `IconBtn`/`IconAction` tự viết trùng nhau ở từng trang → 1 nguồn, đồng nhất tuyệt đối.
//   view    = xem/mở/liên kết (brand)
//   neutral = phụ trung tính (xám → brand khi hover) — mặc định
//   edit    = sửa (vàng)
//   danger  = xóa / hủy / từ chối (đỏ)
//   success = duyệt / xác nhận (xanh lá)
export type IconTone = 'view' | 'neutral' | 'edit' | 'danger' | 'success';

const TONE: Record<IconTone, string> = {
  view: 'text-brand hover:bg-brand-tint',
  neutral: 'text-slate-400 hover:bg-brand-tint hover:text-brand',
  edit: 'text-warning hover:bg-warning/10',
  danger: 'text-danger hover:bg-danger/10',
  success: 'text-success hover:bg-success/10'
};

export function IconButton({
  title,
  tone = 'neutral',
  onClick,
  disabled,
  children
}: {
  title: string;
  tone?: IconTone;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={'rounded-md p-1.5 transition disabled:cursor-not-allowed disabled:opacity-30 ' + TONE[tone]}
    >
      {children}
    </button>
  );
}
