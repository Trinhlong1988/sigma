// Port nguyên từ quan-ly-glb/apps/desktop/src/renderer/src/components/Tabs.tsx (không đổi API).
import type { ReactNode, JSX } from 'react';

export function TabBar({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mb-4 inline-flex flex-wrap gap-1 rounded-full bg-brand/10 p-1">{children}</div>;
}

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
  // 5/8 (Admin Demo "tab active đồng nhất 1 tông brand") — tab đang chọn = CHÍNH var(--gradient-accent) chữ
  // trắng (CÙNG gradient brand với sidebar active + toggle-ON + chip), thay nền trắng-chữ-brand cũ (đảo tông,
  // lệch với các accent khác). Tab chưa chọn = brand nhạt, hover nền brand mờ.
  return (
    <button
      onClick={onClick}
      style={active ? { background: 'var(--gradient-accent)' } : undefined}
      className={
        'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition ' +
        (active ? 'text-white shadow-soft' : 'text-brand/70 hover:bg-white/60 hover:text-brand')
      }
    >
      {icon}
      {children}
    </button>
  );
}
