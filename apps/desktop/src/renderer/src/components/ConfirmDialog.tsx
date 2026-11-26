import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Modal } from './Modal.js';
import { PasswordInput } from './PasswordInput.js';
import { Button } from './Button.js';

/**
 * Confirmation dialog (IMS_SPEC §14). ALWAYS has a Hủy (cancel) button.
 * When `requirePassword` is set, a password field is shown and passed to onConfirm — used for
 * xóa user / xóa role (nhập lại mật khẩu).
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Đồng ý',
  danger = false,
  requirePassword = false,
  requireReason = false,
  reasonLabel = 'Lý do',
  reasonPlaceholder,
  onCancel,
  onConfirm
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  requirePassword?: boolean;
  /** [B186 19/11] Hỏi LÝ DO (chữ thường, nhìn thấy được) thay vì mật khẩu — dùng cho yêu cầu hủy bill:
   *  máy chủ KHÔNG kiểm mật khẩu ở đường này, nhưng người DUYỆT cần đọc được lý do. */
  requireReason?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  onCancel: () => void;
  onConfirm: (giaTri?: string) => Promise<void> | void;
}): JSX.Element {
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    if (requirePassword && !password) return;
    if (requireReason && reason.trim().length < 4) return;
    setBusy(true);
    try {
      await onConfirm(requireReason ? reason : requirePassword ? password : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onCancel} width="max-w-md">
      <div className="flex gap-3">
        <div
          className={
            'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ' +
            (danger ? 'bg-danger/10 text-danger' : 'bg-brand-tint text-brand')
          }
        >
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <p className="whitespace-pre-line text-sm leading-relaxed text-slate-600">{message}</p>
          {requireReason && (
            <label className="mt-4 flex flex-col gap-1.5">
              <span className="text-sm font-medium text-slate-700">{reasonLabel}</span>
              <input
                className="rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/25"
                value={reason}
                autoFocus
                data-kiem="o-ly-do"
                placeholder={reasonPlaceholder}
                onChange={(e) => setReason(e.target.value)}
              />
              {reason.trim().length > 0 && reason.trim().length < 4 && (
                <span className="text-xs text-danger">Lý do phải từ 4 ký tự — người duyệt cần đọc hiểu được.</span>
              )}
            </label>
          )}
          {requirePassword && (
            <label className="mt-4 flex flex-col gap-1.5">
              <span className="text-sm font-medium text-slate-700">Nhập lại mật khẩu để xác nhận</span>
              <PasswordInput
                value={password}
                autoFocus
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && run()}
                placeholder="Mật khẩu của bạn"
              />
            </label>
          )}
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="soft" onClick={onCancel}>Hủy</Button>
        <Button
          variant={danger ? 'danger' : 'confirm'}
          onClick={run}
          disabled={busy || (requirePassword && !password)}
          icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
