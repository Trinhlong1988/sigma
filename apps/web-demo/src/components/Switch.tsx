// NGUỒN DUY NHẤT của nút gạt bật/tắt (toggle trượt) toàn app (5/8, Admin Demo: "button trượt bật/tắt vẫn cũ").
// TRƯỚC ĐÂY mỗi nơi tự viết 1 kiểu: SettingsScreen dùng .toggle-3d, GroupInfoPanel viết tay
// `relative h-6 w-11 bg-brand/bg-slate-300` + knob absolute — 2 kiểu khác nhau, lệch nhau. Nay CHUNG 1
// component dùng .toggle-3d (styles.css): bật = gradient brand CYAN mới, tắt = xám nhạt, knob nổi 3D.
// API tối giản `on/onChange`, có `disabled` + `label` (aria) — mọi toggle (Settings, GroupInfo, ThemeToggle)
// dùng nó, KHÔNG viết raw nữa.
import type { JSX } from 'react';

export function Switch({
  on,
  onChange,
  disabled,
  label,
  testId
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  testId?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="toggle-3d"
      data-on={on}
    >
      <span className="toggle-3d-knob" />
    </button>
  );
}
