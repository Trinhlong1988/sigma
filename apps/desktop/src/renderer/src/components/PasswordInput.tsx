import { useState } from 'react';
import type { InputHTMLAttributes, Ref } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { inputCls } from './Field.js';

/**
 * Ô nhập mật khẩu dùng chung — có nút con mắt hiện/ẩn (R_UI_STANDARD).
 * Mặc định ẩn (type=password); bấm mắt → hiện (type=text). Dùng CHUNG cho MỌI ô
 * mật khẩu toàn app để nút con mắt đồng nhất mọi nơi (không mỗi chỗ một kiểu).
 *
 * - `className` mặc định = `inputCls` (chuẩn design system); truyền vào để thêm
 *   trạng thái lỗi (vd viền đỏ khi xác nhận chưa khớp).
 * - Mọi prop input khác (value/onChange/placeholder/disabled/autoFocus/onKeyDown…)
 *   được truyền thẳng xuống <input>.
 * - `inputRef` (TÙY CHỌN, thêm 12/11 cho màn Đăng nhập): lấy tay cầm tới chính thẻ <input> bên trong để
 *   gọi focus()/select() từ trang cha (vd đăng nhập sai → đưa con trỏ về ô mật khẩu). Thành phần này là
 *   function component nên `ref` thường KHÔNG tới được <input>; không truyền thì hành vi y như trước.
 */
export function PasswordInput({
  className,
  inputRef,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { inputRef?: Ref<HTMLInputElement> }): JSX.Element {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input {...props} ref={inputRef} type={show ? 'text' : 'password'} className={(className ?? inputCls) + ' w-full pr-10'} />
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
