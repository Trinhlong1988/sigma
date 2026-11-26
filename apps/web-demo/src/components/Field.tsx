// Port nguyên từ quan-ly-glb/apps/desktop/src/renderer/src/components/Field.tsx (không đổi API).
import type { ReactNode, JSX } from 'react';

export function Field({
  label,
  required,
  children,
  hint
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
  hint?: string;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
      {hint && <span className="text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

// 5/8 (áp brand mới glass) — chuẩn field DÙNG CHUNG: cùng chiều cao (px-3.5 py-2.5 text-sm), cùng bo góc brand
// (rounded-xl = 12px), viền nhạt + bóng mềm 1 lớp cho cảm giác "nổi" nhất quán, focus ring brand. Mọi input/
// select nên dùng class này để không chỗ cao chỗ thấp.
export const inputCls =
  'rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.05)] outline-none transition placeholder:text-slate-400 focus:border-brand focus:ring-2 focus:ring-brand/20';
