// Gốc: port từ quan-ly-glb/apps/desktop/src/renderer/src/components/Button.tsx — giữ đúng 5 variant
// (R_BUTTON_SEMANTICS): confirm=xanh, edit=vàng, danger=đỏ, soft=xanh nhạt, neutral=xám viền.
// 24/7 (Admin Demo chốt phương án "B — Glass Depth" trong 4 phương án cho xem thử qua Artifact) — đổi
// CÁCH THỂ HIỆN thị giác (gradient kính + ánh sáng hắt + nổi khỏi nền khi hover), KHÔNG đổi props/API
// hay bảng màu 5 vai trò — mọi nơi gọi <Button variant .../> hiện có KHÔNG cần sửa gì. Style thật ở
// styles.css (.btn-glass*), màu gốc mỗi vai trò gán qua CSS var --btn-c (color-mix() cần biết màu gốc).
import type { ButtonHTMLAttributes, ReactNode, JSX } from 'react';
import type { CSSProperties } from 'react';

export type ButtonVariant = 'confirm' | 'edit' | 'danger' | 'soft' | 'neutral';
// 5/8 (Admin Demo "nút Tạo nhóm/Phân loại xấu, không đồng bộ") — thêm `size` để các nút HÀNH ĐỘNG nhỏ trên
// thanh header (trước viết tay `px-3 py-1.5 rounded-lg`, KHÔNG 3D) dùng CHUNG component này mà vẫn gọn, thay
// vì cỡ `md` mặc định to hơn. KHÔNG đổi 5 vai trò màu / API cũ — 52 nơi đang gọi <Button variant .../> giữ
// nguyên (mặc định size='md' = padding cũ y hệt).
export type ButtonSize = 'sm' | 'md';

// 5/8 (áp brand mới glass — PILL đã duyệt) — Admin Demo chốt design nút = PILL glass cyan (.btn-primary /
// .btn-teal / .btn-soft brand.css, border-radius 999px). Dùng `rounded-full` cho MỌI size để: (1) mọi nút
// pill đồng nhất; (2) selector `.btn-primary.rounded-full{border-radius:9999px}` (styles.css, specificity
// 0,2,0) THẮNG chắc chắn utility rounded-* → không bị 16px của brand.css/tailwind ăn mất. Giữ padding/cỡ
// chữ như cũ → cùng chiều cao. sm = nút hành động nhỏ trên header (padding gọn hơn), md = mặc định.
const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'gap-1.5 rounded-full px-3 py-1.5 text-sm',
  md: 'gap-2 rounded-full px-4 py-2.5 text-sm'
};

const VARIANT_COLOR: Record<ButtonVariant, string> = {
  confirm: 'var(--color-brand)',
  edit: 'var(--color-warning)',
  danger: 'var(--color-danger)',
  soft: 'var(--color-brand)',
  neutral: '#94a3b8'
};

// 3/8 (AGENT web-brand-sync) — TÔNG THỨ 2 của gradient 135° (đồng bộ desktop `.btn-primary` brand→teal, hết
// "xanh mono"). confirm = teal; edit/danger = tông đậm hơn cùng hue (giữ ngữ nghĩa vàng/đỏ). soft/neutral
// dùng nền sáng riêng (không đọc --btn-c2). Xem `.btn-glass` trong styles.css.
const VARIANT_COLOR2: Record<ButtonVariant, string> = {
  confirm: 'var(--color-brand-teal)',
  edit: '#d97706',
  danger: '#b91c1c',
  soft: 'var(--color-brand)',
  neutral: '#94a3b8'
};

// 5/8 (Admin Demo duyệt PILL glass cyan + "Thu hồi/Xóa/Đăng xuất CÙNG TONE ĐỎ") — map vai trò → class glass ĐÃ
// DUYỆT (brand.css, KHÓA), MỌI variant nay là PILL glass đồng nhất:
//   confirm (hành động chính: Đăng nhập/Lưu/Xác nhận/Tạo nhóm) → .btn-primary (pill CYAN đã duyệt).
//   danger (phá hủy/thoát: Thu hồi/Xóa/Đăng xuất) → .btn-danger (pill ĐỎ glass ĐÃ DUYỆT brand.css — TRƯỚC
//     dùng .btn-glass đọc --btn-c nên đỏ "phẳng" lệch tông với pill khác; nay CÙNG ngôn ngữ pill glass đỏ).
//   soft + neutral (phụ/hủy/đóng/Google/QR/Sửa) → .btn-soft (pill trắng-xanh, viền rim cyan).
// GIỮ ngữ nghĩa màu vai trò cảnh báo edit=vàng (chưa có pill riêng) dùng .btn-glass — nay cũng PILL nhờ
// rounded-full ở SIZE_CLASS → đồng nhất hình dạng với .btn-primary/.btn-soft/.btn-danger.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  confirm: 'btn-primary text-white',
  edit: 'btn-glass text-white',
  danger: 'btn-danger text-white',
  soft: 'btn-soft',
  neutral: 'btn-soft'
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  children: ReactNode;
  /**
   * 7/8 (Admin Demo — Fold 4 cover 344px: header "Trò chuyện"/"Danh bạ" tràn vì nút CÓ CHỮ) — chế độ ICON-ONLY
   * RESPONSIVE: trên màn HẸP chỉ hiện `icon` (chữ ẩn, GIỮ trong DOM để screen-reader đọc + `aria-label`), tới
   * breakpoint `lg` (≥1024px, EXE/desktop) hiện lại icon+chữ. KHÔNG đổi brand/variant/hiệu ứng 3D — chỉ ẩn/hiện
   * nhãn theo bề rộng. BẮT BUỘC truyền `aria-label` (hoặc `title`) khi bật để nút icon vẫn có tên. Khi bật,
   * nút thu về ô vuông cạnh chạm ≥36px trên màn hẹp (đủ tiêu chuẩn touch).
   */
  collapseLabel?: boolean;
}

export function Button({ variant = 'confirm', size = 'md', icon, children, className = '', disabled, style, collapseLabel = false, ...rest }: Props): JSX.Element {
  return (
    <button
      {...rest}
      disabled={disabled}
      style={{ '--btn-c': VARIANT_COLOR[variant], '--btn-c2': VARIANT_COLOR2[variant], ...style } as CSSProperties}
      className={
        // 4/8 (Admin Demo "button tràn chữ xuống 2 dòng xấu") — whitespace-nowrap: nhãn LUÔN 1 dòng (nút không tự
        // cao gấp đôi khi chữ dài trên màn hẹp APK). Chữ quá dài co theo min-w-0 + gap không đổi.
        // font-bold = 700, khớp .btn-primary/.btn-teal/.btn-soft (brand.css) → cùng độ đậm chữ toàn app.
        'relative inline-flex min-w-0 items-center justify-center whitespace-nowrap font-bold transition ' +
        SIZE_CLASS[size] + ' ' +
        // collapseLabel: màn hẹp = ô vuông chạm ≥36px (chỉ icon); lg+ trả padding chuẩn về (px của SIZE_CLASS
        // vẫn còn hiệu lực bên trên, chỉ THÊM tối thiểu vuông cho trạng thái thu gọn).
        (collapseLabel ? 'min-h-[38px] min-w-[38px] px-2 lg:px-4 ' : '') +
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 ' +
        VARIANT_CLASS[variant] +
        (className ? ' ' + className : '')
      }
    >
      <span className="relative z-10 inline-flex items-center gap-2">
        {icon}
        {/* collapseLabel: nhãn ẩn dưới lg (display:none → KHÔNG chiếm chỗ, gap flex bỏ qua item ẩn) nhưng vẫn
            trong DOM cho a11y. Không bật → hiện bình thường. */}
        {collapseLabel ? <span className="hidden lg:inline">{children}</span> : children}
      </span>
    </button>
  );
}
