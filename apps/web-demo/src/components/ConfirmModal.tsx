// [Admin Demo 16/9 "xác nhận hoàn tiền hiện log ra sai brand xấu"] window.confirm = hộp thoại HỆ THỐNG (hiện URL,
// không brand) → modal xác nhận CHUẨN BRAND dùng chung: overlay tối + panel glass + header gradient brand SigMa
// + nút pill. Dùng cho mọi xác nhận nguy hiểm (tiền/sửa/xoá) thay window.confirm.
import type { JSX, ReactNode } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button } from './Button';

export function ConfirmModal({ open, title, message, confirmLabel = 'Xác nhận', danger = false, busy = false, onConfirm, onClose }: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}): JSX.Element | null {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={onClose} data-testid="confirm-modal">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 text-white" style={{ background: 'linear-gradient(120deg, #0f1a24 0%, #1877d6 55%, #3bc3d0 100%)' }}>
          {danger ? <AlertTriangle className="h-5 w-5 text-amber-300" /> : <CheckCircle2 className="h-5 w-5 text-emerald-300" />}
          <div className="text-sm font-extrabold">{title}</div>
        </div>
        <div className="px-4 py-4 text-sm text-slate-700">{message}</div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <Button variant="soft" size="sm" onClick={onClose} disabled={busy}>Huỷ</Button>
          <Button variant={danger ? 'danger' : 'confirm'} size="sm" onClick={onConfirm} disabled={busy} data-testid="confirm-modal-ok">{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
