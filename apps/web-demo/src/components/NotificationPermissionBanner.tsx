// Banner nhắc BẬT QUYỀN THÔNG BÁO trình duyệt (7/8, Admin Demo "không trong phòng chat vẫn không nhận push") —
// GỐC: desktop notification trên WEB (khi tab SigMa chạy NỀN / người dùng ở tab khác) BẮT BUỘC cần
// `Notification.permission === 'granted'`. ensureWebNotificationPermission() chỉ tự hỏi 1 lần lúc mount (không có
// user-gesture nên Chrome thường bỏ qua/không hiện prompt) → nếu người dùng lỡ bỏ qua thì KHÔNG bao giờ nhận
// thông báo desktop và KHÔNG có chỗ bật lại. Banner này:
//   - CHỈ hiện trên WEB (exe dùng OS Notification qua Electron; apk dùng FCM native — cả 2 KHÔNG cần quyền này).
//   - 'default' → nút "Bật thông báo" gọi requestPermission() TRONG click (user-gesture → prompt hiện chắc chắn).
//   - 'denied' → hướng dẫn bật lại trong cài đặt trình duyệt (không thể prompt lại bằng code).
//   - 'granted' → ẩn hẳn.
//   - Đóng được (nhớ localStorage) để không làm phiền; nhưng nếu 'denied' vẫn cho đóng.
import { useEffect, useState, type JSX } from 'react';
import { Bell, X } from 'lucide-react';

const DISMISS_KEY = 'notif-perm-banner-dismissed';

function isWeb(): boolean {
  // exe có bridge SigMaPC; apk là Capacitor native. Cả 2 → KHÔNG phải web thuần → ẩn banner.
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { SigMaPC?: unknown; Capacitor?: { isNativePlatform?: () => boolean } };
  if (w.SigMaPC) return false;
  try {
    if (w.Capacitor?.isNativePlatform?.()) return false;
  } catch {
    /* ignore */
  }
  return 'Notification' in window;
}

export function NotificationPermissionBanner(): JSX.Element | null {
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return Notification.permission;
  });
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  // Re-check quyền khi quay lại tab (người dùng có thể vừa đổi ở thanh địa chỉ trình duyệt).
  useEffect(() => {
    const onVis = (): void => {
      if (typeof window !== 'undefined' && 'Notification' in window) setPerm(Notification.permission);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  if (!isWeb()) return null;
  if (perm === 'unsupported' || perm === 'granted') return null;
  if (dismissed) return null;

  const denied = perm === 'denied';

  async function enable(): Promise<void> {
    try {
      const res = await Notification.requestPermission();
      setPerm(res);
      if (res === 'granted') {
        try {
          localStorage.removeItem(DISMISS_KEY);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* trình duyệt chặn / ngoài secure context — bỏ qua, banner giữ nguyên */
    }
  }

  function dismiss(): void {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
      <Bell className="h-5 w-5 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        {denied ? (
          <span>
            Thông báo đang bị <b>chặn</b> — để nhận tin khi ở tab/ứng dụng khác, hãy bật lại: bấm biểu tượng ổ khóa
            🔒 cạnh địa chỉ web → <b>Thông báo</b> → <b>Cho phép</b>, rồi tải lại trang.
          </span>
        ) : (
          <span>
            <b>Bật thông báo</b> để nhận tin nhắn ngay cả khi anh đang ở tab hoặc ứng dụng khác (như Zalo/Messenger).
          </span>
        )}
      </div>
      {!denied && (
        <button
          onClick={enable}
          className="shrink-0 rounded-full bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-600"
        >
          Bật thông báo
        </button>
      )}
      <button onClick={dismiss} aria-label="Đóng" className="shrink-0 rounded-full p-1 text-amber-600 transition hover:bg-amber-100">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
