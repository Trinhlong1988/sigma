// Lightbox (5/8) — lớp phủ toàn màn nền tối để xem 1 ẢNH phóng to được (pinch/lăn chuột/double-tap), dùng chung
// cho các nơi mở 1 ảnh: ảnh bìa, ảnh đại diện (ProfileScreen/PublicProfileScreen), avatar nhóm (GroupInfoPanel).
// Bọc <img> trong ZoomableImage (cơ chế zoom bằng JS — index.html khóa pinch trình duyệt toàn app). Tap nền đóng
// CHỈ khi CHƯA zoom (tránh đóng nhầm lúc đang xem chi tiết). Có nút X + Esc để đóng. Ảnh chat nhiều-ảnh có
// gallery điều hướng riêng ở ConversationScreen (cũng dùng ZoomableImage), KHÔNG dùng lớp phủ này.
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { ZoomableImage } from './ZoomableImage';
import { useBackIntercept } from '../lib/back-intercept';

export function Lightbox({
  src,
  alt,
  title,
  onClose,
  children
}: {
  /** URL ảnh (bỏ qua nếu truyền `children` để tự dựng nội dung ảnh, vd AttachmentImage). */
  src?: string;
  alt?: string;
  title?: string;
  onClose: () => void;
  /** Nội dung ảnh tuỳ biến thay cho <img src>. */
  children?: ReactNode;
}): JSX.Element {
  const [zoomed, setZoomed] = useState(false);
  // Back (cứng Android) khi đang xem ảnh phóng to → đóng lightbox (lùi 1 bước), không lùi route (Admin Demo 18/8).
  useBackIntercept(true, onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      // Tap NỀN đóng — chỉ khi chưa zoom (ZoomableImage đã stopPropagation click trên vùng ảnh, nên chỉ nền mới tới đây).
      onClick={() => {
        if (!zoomed) onClose();
      }}
      data-testid="lightbox"
    >
      {title && (
        <div className="pointer-events-none absolute left-0 right-0 top-4 z-10 text-center text-sm font-medium text-white/85">
          {title}
        </div>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Đóng"
        className="absolute right-4 top-4 z-10 rounded-full bg-black/40 p-2 text-white hover:bg-black/60"
      >
        <X className="h-6 w-6" />
      </button>
      <ZoomableImage resetKey={src ?? 'node'} onZoomChange={setZoomed}>
        {children ?? (
          <img
            src={src}
            alt={alt ?? ''}
            draggable={false}
            className="max-h-[92vh] max-w-[96vw] select-none object-contain"
          />
        )}
      </ZoomableImage>
    </div>,
    document.body
  );
}
