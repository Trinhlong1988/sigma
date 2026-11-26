import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Centered modal with backdrop. Esc + backdrop click close (via onClose).
 * onSubmit (tùy chọn, FIX 5): nếu truyền, nhấn Enter trong modal sẽ gọi onSubmit —
 * BỎ QUA khi focus đang ở <textarea> hoặc <select> (đang chọn dropdown) hoặc ô contentEditable.
 *
 * B84 (Admin Demo báo 22/7, ảnh modal "Thêm đối tác" bị che cả đầu lẫn cuối): `.page-enter` (hiệu ứng
 * 3D chuyển trang, styles.css) khai `will-change: transform` — theo spec CSS, will-change:transform
 * trên 1 phần tử biến nó thành CONTAINING BLOCK cho MỌI hậu duệ `position:fixed`. Modal này vốn định
 * `fixed inset-0` để phủ TOÀN cửa sổ, nhưng vì luôn được mở từ bên trong 1 trang bọc `.page-enter`,
 * nó bị "nhốt" khung tọa độ vào bên trong khối `.page-enter` (nhỏ hơn viewport, nằm dưới TitleBar +
 * topbar) rồi bị `overflow-hidden` của tổ tiên cắt cụt — modal cao hơn khung đó thì cả đầu (tiêu đề +
 * nút đóng) lẫn cuối (nút Lưu/Hủy) đều mất, y hệt ảnh chụp. Fix: `createPortal` ra thẳng
 * `document.body` — thoát khỏi MỌI containing-block của cây trang, modal luôn phủ đúng viewport thật
 * dù trang cha có hiệu ứng transform/will-change gì đi nữa (miễn nhiễm vĩnh viễn, không chỉ vá `.page-enter`).
 */
export function Modal({
  title,
  onClose,
  children,
  // [Admin Demo 15/11] KHỔ CHUẨN cho MỌI hộp thoại thao tác: rộng + cao để không phải cuộn. Hộp nào thật sự
  // bé (xác nhận 1 dòng) vẫn tự co vì nội dung ngắn — `max-w` chỉ là TRẦN, không ép giãn.
  // [đo thật 16/11, 1600×950] khổ 5xl (1024px) làm hộp "Gán máy POS" còn thừa 124px phải cuộn.
  // 6xl (1152px) + 90vh ⇒ 2 cột rộng hơn, nội dung thấp xuống, hết cuộn.
  width = 'max-w-6xl',
  bodyMaxH = 'max-h-[90vh]',
  fullHeight = false,
  // [B207 19/11] Cho phép hộp thoại DÀI (vd "Thêm Bill") thu lề trong để vừa màn 768px mà không phải cuộn.
  bodyPad = 'p-5',
  headerExtra,
  dongMauDo,
  onSubmit
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  /** Chiều cao tối đa vùng nội dung (optional) — màn cần bảng nổi cao hơn thì truyền vd 'max-h-[84vh]'. */
  bodyMaxH?: string;
  /** [B263] khung cao cố định ~100vh, thân cuộn trong — cho màn nhập bill full chiều cao. */
  fullHeight?: boolean;
  bodyPad?: string;
  /** Nút phụ cắm cạnh nút đóng (vd "thu nhỏ") — optional. */
  headerExtra?: ReactNode;
  /** Nút ✕ tô ĐỎ (optional). */
  dongMauDo?: boolean;
  onSubmit?: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // FE-07 (Codex 15/7): chốt chống Enter kép — 2 lần Enter nhanh trước khi nút disabled re-render sẽ gọi
  // onSubmit 2 lần (double-submit destructive). Ref latch chặn lần thứ 2 trong 600ms.
  const submitLock = useRef(false);
  const guardedSubmit = (): void => {
    if (submitLock.current) return;
    submitLock.current = true;
    onSubmit?.();
    setTimeout(() => { submitLock.current = false; }, 600);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        // [B263 lần 3 — Admin Demo "chiều cao màn nhập bill FULL chiều cao màn hình"] fullHeight: khung CAO
        // CỐ ĐỊNH gần hết màn (không phụ thuộc nội dung — max-h chỉ là TRẦN nên hộp ít nội dung vẫn lùn),
        // thân cuộn bên trong. 32px = đệm p-4 của lớp phủ hai đầu.
        className={`w-full ${width} rounded-xl border border-line bg-white shadow-2xl` + (fullHeight ? ' flex h-[calc(100vh-32px)] flex-col' : '')}
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
          <div className="flex items-center gap-1">
            {headerExtra}
            <button
              type="button"
              title="Đóng"
              onClick={onClose}
              className={'rounded p-1 ' + (dongMauDo ? 'text-danger hover:bg-danger/10' : 'text-slate-400 hover:bg-appbg hover:text-slate-600')}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className={(fullHeight ? 'min-h-0 flex-1' : bodyMaxH) + ' overflow-auto ' + bodyPad}>{children}</div>
      </div>
    </div>,
    document.body
  );
}
