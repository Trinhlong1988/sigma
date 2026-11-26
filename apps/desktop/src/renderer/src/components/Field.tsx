import type { ReactNode } from 'react';

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

// Ô nhập chuẩn design-system (brand mới): CÙNG chiều cao (py-2.5) + bo góc brand (rounded-xl) + nền trắng,
// focus viền/vòng brand. Dùng chung cho input/select/ô nhập tiền toàn app → đồng nhất tuyệt đối.
export const inputCls =
  'rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/25';
