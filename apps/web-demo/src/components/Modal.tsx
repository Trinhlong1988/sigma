// Port từ quan-ly-glb/apps/desktop/src/renderer/src/components/Modal.tsx — giữ nguyên hành vi
// (createPortal ra document.body để tránh containing-block của .page-enter, Esc để đóng, onSubmit
// qua Enter có latch chống double-submit). Chỉ đổi import path .js -> không cần vì cùng thư mục.
import { useEffect, useRef, type ReactNode, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useBackIntercept } from '../lib/back-intercept';

export function Modal({
  title,
  onClose,
  children,
  width = 'max-w-lg',
  onSubmit
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  onSubmit?: () => void;
}): JSX.Element {
  // Nút back (cứng Android) khi modal MỞ → đóng modal (lùi đúng 1 bước), không lùi route/minimize app (Admin Demo
  // 18/8 "back chỉ được lùi 1 bước"). Modal chỉ mount khi hiển thị nên active=true. CÙNG hành vi Esc bên dưới.
  useBackIntercept(true, onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submitLock = useRef(false);
  const guardedSubmit = (): void => {
    if (submitLock.current) return;
    submitLock.current = true;
    onSubmit?.();
    setTimeout(() => {
      submitLock.current = false;
    }, 600);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`w-full ${width} rounded-xl border border-line bg-white shadow-2xl`}
        onKeyDown={
          onSubmit
            ? (e) => {
                if (e.key !== 'Enter' || e.shiftKey) return;
                const t = e.target as HTMLElement;
                if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
                e.preventDefault();
                guardedSubmit();
              }
            : undefined
        }
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h3 className="text-base font-semibold text-slate-800">{title}</h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-appbg hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-auto p-5">{children}</div>
      </div>
    </div>,
    document.body
  );
}
