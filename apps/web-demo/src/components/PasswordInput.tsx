// Port nguyên từ quan-ly-glb/apps/desktop/src/renderer/src/components/PasswordInput.tsx (không đổi API).
import { useState, type JSX } from 'react';
import type { InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { inputCls } from './Field';

export function PasswordInput({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>): JSX.Element {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={show ? 'text' : 'password'} className={(className ?? inputCls) + ' w-full pr-10'} />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-brand"
      >
        {show ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
      </button>
    </div>
  );
}
