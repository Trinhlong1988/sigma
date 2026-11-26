// ToastHost (item 3, Admin Demo chốt 6/8) — render STACK toast tin nhắn kiểu Zalo tự vẽ (chung 3 nền web/PC/APK).
// Đọc toast từ toast-store (useSyncExternalStore) + kiểu/thời-gian từ notification-settings.
//   - 2 kiểu desktop: 'corner' (góc phải-dưới cạnh khay đồng hồ, MẶC ĐỊNH) | 'top-drop' (thả từ trên xuống).
//   - Mobile (APK native) ÉP 'top-drop' foreground (Admin Demo chốt) — hợp ngón tay/không đè khay đồng hồ điện thoại.
//   - Bấm vào toast → mở đúng phòng; nút × đóng. Animation brand (transform+opacity, GPU) qua .chat-toast-* (styles.css).
//   - 8/8 (Admin Demo "web toast bỏ trả lời nhanh + thiết kế Y HỆT popup EXE"): GỠ quick-reply inline; card vẽ giống
//     hệt notification.html của EXE (nền đặc trắng/tối, avatar 40px, tiêu đề 13.5px đậm, nội dung 12.5px 2 dòng,
//     nút × tròn góc). 1 kiểu thông báo đồng nhất web ⇄ exe.
import { useEffect, useState, useSyncExternalStore, type JSX } from 'react';
import { useNavigate } from 'react-router';
import { X } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { subscribeToasts, getToastsSnapshot, removeToast, type ToastItem } from '../../lib/toast-store';
import { useNotificationSettings } from '../../lib/notification-settings';
import { fetchAttachmentObjectUrl } from '../../lib/attachment-blob';
import { ROUTES } from '../../routes';

/** Avatar tròn của toast (item 12, 6/8) — hiển thị ẢNH THẬT nếu có `avatarUrl` (DIRECT=người gửi, GROUP=nhóm),
 * KHÔNG có / tải lỗi (404 chưa đặt ảnh) → fallback ô màu + chữ cái Y HỆT hành vi cũ (avatarColor+avatarLabel).
 *
 * Tải blob qua `fetchAttachmentObjectUrl` (proxyFetch + credentials + header CSRF `x-sigma-client:web` — endpoint
 * avatar đòi header này nên KHÔNG dùng URL trần trong <img> được, xem attachment-blob.ts). CACHE THEO URL nằm ở
 * attachment-blob (object URL sống theo vòng đời tab, DÙNG CHUNG với AgentAvatar) → avatar toast NHẤT QUÁN với
 * avatar cùng người ở Danh bạ/khung chat, và hiện NGAY từ cache nếu đã tải trước đó (không nháy).
 *
 * KHÔNG revoke object URL khi toast gỡ: URL do CACHE của attachment-blob sở hữu (1 URL/đối tượng, KHÔNG phải 1
 * URL/toast) và dùng lại ở AgentAvatar + các toast sau — revoke ở đây sẽ phá ảnh của những nơi đó (blob URL đã
 * revoke = ảnh vỡ). Không rò rỉ theo-toast vì URL bị chặn theo số đối tượng (bounded), không theo số lần hiện toast. */
function ToastAvatar({ toast }: { toast: ToastItem }): JSX.Element {
  const [imgUrl, setImgUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!toast.avatarUrl) {
      setImgUrl(null);
      return;
    }
    let active = true;
    fetchAttachmentObjectUrl(toast.avatarUrl)
      .then((url) => {
        if (active) setImgUrl(url);
      })
      .catch(() => {
        // 404 (chưa đặt ảnh) / lỗi mạng → giữ null → fallback ô màu+chữ. R198: avatar là điểm tô thêm, được phép
        // fallback im (đúng ngoại lệ (c) trong brief) — nhưng vẫn log 1 dòng cảnh báo để debug được.
        if (active) setImgUrl(null);
        // eslint-disable-next-line no-console
        console.warn('[toast] tải avatar thông báo thất bại, dùng ô màu+chữ:', toast.avatarUrl);
      });
    return () => {
      active = false;
    };
  }, [toast.avatarUrl]);

  if (imgUrl) {
    return <img src={imgUrl} alt={toast.title} className="h-full w-full rounded-full object-cover" />;
  }
  return <span className="text-sm font-semibold text-white">{toast.avatarLabel}</span>;
}

function ToastCard({ toast, enterClass }: { toast: ToastItem; enterClass: string }): JSX.Element {
  const navigate = useNavigate();

  function openRoom(): void {
    navigate(ROUTES.chatRoom(toast.roomId));
    removeToast(toast.id);
  }

  // Card Y HỆT popup EXE (notification.html): nền đặc trắng/tối (KHÔNG glass), bo 14px, đổ bóng sâu, click cả
  // thẻ để mở phòng, avatar 40px, tiêu đề 13.5px đậm, nội dung 12.5px 2 dòng, nút × tròn góc phải.
  return (
    <div
      onClick={openRoom}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openRoom();
        }
      }}
      aria-label={`Mở trò chuyện với ${toast.title}`}
      className={`flex w-full cursor-pointer items-start gap-[11px] rounded-[14px] border border-black/[0.06] bg-white px-3.5 py-3 text-left shadow-[0_8px_28px_rgba(15,23,42,0.28),0_2px_6px_rgba(15,23,42,0.12)] dark:border-white/[0.06] dark:bg-slate-800 ${enterClass}`}
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full text-[15px] font-bold text-white"
        style={{ backgroundColor: toast.avatarColor }}
      >
        <ToastAvatar toast={toast} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-bold text-slate-900 dark:text-slate-100">{toast.title}</div>
        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-slate-600 dark:text-slate-300">{toast.body}</p>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          removeToast(toast.id);
        }}
        aria-label="Đóng thông báo"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[15px] leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function ToastHost(): JSX.Element | null {
  const toasts = useSyncExternalStore(subscribeToasts, getToastsSnapshot, getToastsSnapshot);
  const settings = useNotificationSettings();

  if (toasts.length === 0) return null;

  // Mobile native (APK) ÉP top-drop foreground (Admin Demo chốt). Còn lại theo cài đặt (mặc định corner).
  const isMobile = Capacitor.isNativePlatform();
  const style = isMobile ? 'top-drop' : settings.toastStyle;
  const isTop = style === 'top-drop';

  // 8/8 (Admin Demo "pushinapp apk đẩy nhiều lần tràn xuống màn — chỉ cuộn dồn 1 lần như outapp"): trên MOBILE
  // native, nhiều tin dồn → CHỈ hiện toast MỚI NHẤT (dồn về 1, y như thông báo out-app gộp 1 con), KHÔNG xếp
  // chồng N thẻ tràn màn. Nếu còn toast khác đang chờ → gắn badge "+N" cho biết còn n tin (giống native gộp).
  const visible = isMobile ? toasts.slice(-1) : toasts;
  const hiddenCount = isMobile ? toasts.length - visible.length : 0;

  // 7/8 (Admin Demo "web toast cuộn lên nhiều như điện thoại") — GIỚI HẠN chiều cao cụm toast + overflow ẩn để KHÔNG
  // trào quá màn hình (điện thoại/màn ngắn xếp nhiều toast). Corner: neo góc phải-DƯỚI, mới nhất ở dưới (justify-end).
  // Admin Demo 18/8 ("toast tràn lệch không như Zalo trên màn nhỏ") — TRỪ safe-area: top-drop nằm DƯỚI status
  // bar/notch (trước `top-4` cứng đè lên tai thỏ/khay trạng thái); corner trừ gesture bar dưới. Class max-width
  // calc(100vw − 2rem) đã chặn tràn ngang (giữ). Dùng inline style vì Tailwind không có class env(safe-area) sẵn.
  const containerClass = isTop
    ? 'fixed left-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-[22rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-2 overflow-hidden'
    : 'fixed z-50 flex max-h-[calc(100vh-2rem)] w-[22rem] max-w-[calc(100vw-2rem)] flex-col justify-end gap-2 overflow-hidden';
  const containerStyle = isTop
    ? { top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }
    : { bottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)', right: '1rem' };
  const enterClass = isTop ? 'chat-toast-enter-top' : 'chat-toast-enter-corner';

  return (
    <div className={containerClass} style={containerStyle} data-toast-style={style} data-testid="toast-host">
      {visible.map((t) => (
        <ToastCard key={t.id} toast={t} enterClass={enterClass} />
      ))}
      {hiddenCount > 0 && (
        <div
          data-testid="toast-more-count"
          className="mx-auto rounded-full bg-slate-900/80 px-2.5 py-0.5 text-[11px] font-semibold text-white shadow dark:bg-slate-100/85 dark:text-slate-900"
        >
          +{hiddenCount} tin nhắn khác
        </div>
      )}
    </div>
  );
}
