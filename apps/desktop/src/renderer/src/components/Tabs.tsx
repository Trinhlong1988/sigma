// Dải tab dùng chung (R15/R16, Admin Demo 11/7): nền dải XANH BRAND đậm (bg-brand/20) — đậm hơn nút "Xóa lọc"
// (bg-brand/10) và "Làm mới", KHÔNG phải màu ghi.
// Admin Demo 3/8 — ĐỒNG BỘ BRAND: tab đang chọn = "viên" GRADIENT brand→teal (giống nút menu sidebar active),
// KHÔNG còn viên trắng, để trạng-thái-chọn toàn app cùng 1 ngôn ngữ màu thương hiệu.
// Áp cho MỌI trang nhiều tab.
import type { ReactNode } from 'react';

/** Bọc nhóm tab: dải nền xanh brand đậm bo góc. */
export function TabBar({ children }: { children: ReactNode }): JSX.Element {
  // flex (KHÔNG inline) + flex-wrap → tab TỰ XUỐNG DÒNG khi cửa sổ hẹp, không bị cắt (Admin Demo 11/8).
  // data-tab-bar: dấu để CỔNG ĐO phân biệt "nút tab" với "nút thanh công cụ" — tab tên "Tạo bill",
  // "Thêm sản phẩm"… trông giống nút hành động nên cổng từng báo nhầm là nút quên gắn brand (12/11).
  return <div data-tab-bar className="mb-4 flex flex-wrap gap-1 rounded-xl bg-brand/20 p-1">{children}</div>;
}

/** 1 nút tab dạng "viên". active = nền trắng + bóng + chữ brand; ngược lại chữ brand mờ, hover nền trắng mờ. */
export function TabButton({
  active,
  onClick,
  icon,
  children
}: {
  active: boolean;
  onClick: () => void;
  icon?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={
        'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition ' +
        (active
          ? 'brand-accent text-[#0d4a7a] shadow-sm'
          : 'text-[#0d4a7a]/70 hover:bg-white/60 hover:text-[#0d4a7a]')
      }
    >
      {icon}
      {children}
    </button>
  );
}
