// Nút "Quay lại" DÙNG CHUNG toàn app (5/8, Admin Demo "nút quay lại rất xấu — thiết kế đúng brand đẹp, dễ chịu,
// dễ phân biệt, hiện đại"). TRƯỚC ĐÂY mỗi màn tự vẽ 1 kiểu (text xám `text-slate-500 hover:text-brand`, có màn
// icon-only trong header, có màn "← Quay lại" thuần chữ) → KHÔNG đồng nhất. Nay 1 NGUỒN DUY NHẤT: pill bo tròn
// nền brand-tint + viền brand nhẹ + chữ/icon brand, hover đậm hơn, chạm phản hồi (active:scale). Cỡ chạm ≥40px
// (min-h-10 / w-10 cho icon-only) đạt chuẩn touch. Đọc màu brand qua Tailwind @theme (var(--color-brand*)),
// KHÔNG bịa màu lạc tông.
//
// Hành vi điều hướng GIỮ NGUYÊN ở nơi gọi: truyền `onClick` (vd `() => navigate(-1)`, `onBack`,
// `() => window.history.back()`) HOẶC `to` (điều hướng route cố định qua <Link>). Chỉ phần RENDER nút được
// thống nhất, không đụng logic.
import type { JSX } from 'react';
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';

export type BackButtonVariant = 'default' | 'icon-only';

interface BaseProps {
  /** Nhãn cạnh icon (mặc định "Quay lại"). Bỏ qua khi variant='icon-only'. */
  label?: string;
  variant?: BackButtonVariant;
  /** aria-label cho nút (bắt buộc về mặt trợ năng khi icon-only — mặc định lấy theo label). */
  ariaLabel?: string;
  /** class bổ sung ở nơi gọi (vd `flex-1`, `w-full max-w-sm`, `mb-3`). */
  className?: string;
}

interface OnClickProps extends BaseProps {
  onClick: () => void;
  to?: undefined;
}
interface ToProps extends BaseProps {
  to: string;
  onClick?: () => void;
}

type Props = OnClickProps | ToProps;

// Pill brand đồng nhất — dùng cho CẢ 2 variant (icon-only chỉ đổi kích thước về hình tròn 40px).
const PILL_BASE =
  'inline-flex items-center justify-center rounded-full border border-brand/20 bg-brand-tint ' +
  'font-semibold text-brand transition hover:border-brand/40 hover:bg-brand/10 ' +
  'active:scale-[0.97] focus-visible:outline-none';

function classesFor(variant: BackButtonVariant, className: string): string {
  const size =
    variant === 'icon-only'
      ? 'h-10 w-10' // 40px tròn — cỡ chạm chuẩn
      : 'min-h-10 gap-1.5 px-3.5 text-sm';
  return PILL_BASE + ' ' + size + (className ? ' ' + className : '');
}

export function BackButton(props: Props): JSX.Element {
  const { label = 'Quay lại', variant = 'default', ariaLabel, className = '' } = props;
  const iconOnly = variant === 'icon-only';
  const cls = classesFor(variant, className);
  const content = (
    <>
      <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
      {!iconOnly && <span className="whitespace-nowrap">{label}</span>}
    </>
  );
  const aria = ariaLabel ?? label;

  if (props.to !== undefined) {
    return (
      <Link to={props.to} onClick={props.onClick} aria-label={aria} className={cls}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={props.onClick} aria-label={aria} className={cls}>
      {content}
    </button>
  );
}
