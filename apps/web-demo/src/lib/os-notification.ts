// Thông báo cấp HỆ ĐIỀU HÀNH khi app Ở NỀN/không focus (item 3, Admin Demo chốt 6/8) — bổ trợ cho toast tự vẽ
// (ToastHost) chỉ thấy được khi app đang focus:
//   - EXE (Electron): gọi bridge window.SigMaPC.notify() → main.js dựng `new Notification` OS Windows (góc
//     phải-dưới cạnh đồng hồ). Main TỰ kiểm `!win.isFocused()` nên khi đang focus là no-op (banner lo phần đó).
//   - WEB: dùng Notification API trình duyệt khi document ẩn. Cần quyền — ensureWebNotificationPermission().
//   - APK: giữ FCM native (push-notifications.ts) — file NÀY no-op trên native (Capacitor), không đụng.
//
// Quyết định "đang ở nền" do CALLER (AppShell) tính (document.hidden || !document.hasFocus()) — file này chỉ lo
// PHÁT thông báo OS. Mọi nhánh best-effort: lỗi/không hỗ trợ → im lặng bỏ qua (thông báo là UX phụ, KHÔNG chặn
// luồng chính, CÙNG tinh thần audio-player/permission-priming).
import { Capacitor, registerPlugin } from '@capacitor/core';

// Việc #24 Part B (6/8, Admin Demo) — plugin native HỦY notification theo phòng khi ĐỌC (xem
// RoomNotificationsPlugin.java). CHỈ có ý nghĩa trên APK (native); web/exe no-op. registerPlugin lúc load trả về
// proxy vô hại trên web (không gọi native tới khi có lời gọi method).
interface RoomNotificationsPlugin {
  cancel(options: { roomId: string }): Promise<void>;
  cancelAll(): Promise<void>;
  // #8-tiếp (8/8, Admin Demo "icon APK đơ 62 vs 21") — đặt badge launcher = TỔNG chưa đọc THẬT do WebView tính
  // (unread-badge.ts), gồm cả tin nhận qua WebSocket khi app đang MỞ (đường FCM foreground return sớm, KHÔNG
  // chạm badge native → badge kẹt tới khi có push nền mới). `seq` = số thứ tự tăng đơn điệu để native BỎ QUA lời
  // gọi CŨ đến trễ (2 lời gọi sát nhau chạy trên thread-pool native có thể đảo thứ tự notify → off-by-one).
  // Xem SigMaMessagingService.setBadgeFromJs.
  setBadge(options: { count: number; seq: number }): Promise<void>;
}
const RoomNotifications = registerPlugin<RoomNotificationsPlugin>('RoomNotifications');

/** Hàm THUẦN (test được) — có nên gọi native cancel không: CHỈ khi đang chạy native (APK) VÀ roomId hợp lệ.
 * web/exe → false (no-op, badge do sidebar/taskbar lo). Tách để unit-test logic gate KHÔNG cần mock Capacitor. */
export function shouldAttemptNativeClear(isNative: boolean, roomId: unknown): boolean {
  return isNative && typeof roomId === 'string' && roomId.trim().length > 0;
}

function isNativePlatform(): boolean {
  try {
    return typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** Việc #24 Part B — hủy notification hệ thống của phòng `roomId` khi người dùng ĐỌC phòng đó (in-app) → nhiều
 * launcher Android đếm badge theo số notification treo, hủy đi thì badge giảm/về 0. APK-only, best-effort (nuốt
 * lỗi im). web/exe: no-op (badge do sidebar/taskbar EXE lo, xem setPcUnreadBadge). */
export function clearRoomNotification(roomId: string): void {
  if (!shouldAttemptNativeClear(isNativePlatform(), roomId)) return;
  RoomNotifications.cancel({ roomId }).catch(() => {
    /* best-effort — badge là UX phụ, không chặn luồng chính */
  });
}

/** Hủy MỌI notification tin nhắn (vd "Đọc tất cả") → badge launcher về 0. APK-only, best-effort. */
export function clearAllRoomNotifications(): void {
  if (!isNativePlatform()) return;
  RoomNotifications.cancelAll().catch(() => {
    /* best-effort */
  });
}

/** #8-tiếp (8/8, Admin Demo "số chưa đọc mở app 62 nhưng ICON 21 — bộ đếm đơ, chỉ push mới mới cộng") — đồng bộ
 * TỔNG chưa đọc THẬT (WebView tự tính realtime qua WS + đọc phòng) lên badge launcher APK. GỐC đơ: badge native
 * chỉ do FCM (SigMaMessagingService) đặt khi app Ở NỀN; tin nhận qua WebSocket lúc app đang MỞ KHÔNG chạm
 * badge → kẹt số cũ tới khi có push nền. Cầu này (song song setPcUnreadBadge của EXE) đẩy tổng JS xuống native
 * mỗi khi tổng đổi (mount/tin mới/đọc phòng). count<=0 → badge về 0. APK-only, best-effort (nuốt lỗi, badge phụ). */
// seq đơn điệu tăng, NỀN = Date.now() (mốc thời gian) để CÒN tăng qua cả WebView reload — nếu dùng bộ đếm thuần
// 0,1,2… thì reload đưa seq về 0 trong khi LAST_BADGE_SEQ (static Java, sống theo tiến trình app) còn cao → mọi
// lời gọi mới bị guard bỏ qua → badge KẸT. Date.now() luôn vượt giá trị cũ; +1 khi trùng ms để đảm bảo strict tăng.
let lastBadgeSeq = 0;
function nextBadgeSeq(): number {
  const now = Date.now();
  lastBadgeSeq = now > lastBadgeSeq ? now : lastBadgeSeq + 1;
  return lastBadgeSeq;
}
export function setNativeAppBadge(total: number): void {
  if (!isNativePlatform()) return;
  const count = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  // native chỉ áp lời gọi seq LỚN NHẤT (chống đảo thứ tự thread-pool → off-by-one).
  RoomNotifications.setBadge({ count, seq: nextBadgeSeq() }).catch(() => {
    /* best-effort — badge là UX phụ, không chặn luồng chính */
  });
}

interface SigMaPcNotifyBridge {
  notify?: (payload: { title: string; body: string; roomId: string; iconDataUrl?: string; playSound?: boolean }) => Promise<unknown>;
  onNotifyClicked?: (cb: (payload: { roomId?: string }) => void) => () => void;
  /** BUG#8b (6/8) — đặt TỔNG số tin chưa đọc lên icon taskbar/dock EXE. Chỉ có trên bản Electron. */
  setUnreadBadge?: (n: number) => Promise<unknown>;
  /** 7/8 — main đẩy trạng thái foreground THẬT (focus+visible+!minimize) mỗi khi đổi. */
  onForegroundChanged?: (cb: (fg: boolean) => void) => () => void;
}

// Trạng thái foreground THẬT của cửa sổ EXE (main đẩy xuống). Mặc định true tới khi main báo khác. GỐC bug "exe
// không có push" (Admin Demo 7/8): document.hasFocus() KHÔNG tin cậy trong Electron → renderer tưởng "ở nền" lúc
// đang foreground → đi nhánh OS-toast → main chặn (isFocused) → rớt sạch. Dùng cờ này thay hasFocus cho exe.
let pcForeground = true;

/** Đăng ký nhận foreground THẬT từ main (EXE). Gọi 1 lần lúc vào AppShell. WEB/APK: no-op. Trả hàm huỷ. */
export function wireForegroundTracking(): () => void {
  const pc = pcBridge();
  if (!pc?.onForegroundChanged) return () => {};
  return pc.onForegroundChanged((fg) => {
    pcForeground = fg;
  });
}

/** App có ĐANG Ở NỀN không (quyết định OS-toast desktop vs toast trong app). EXE: dùng foreground THẬT từ main
 * (document.hasFocus không tin cậy trong Electron). WEB/APK: document.hidden || !document.hasFocus(). */
export function isAppInBackground(): boolean {
  const docHidden = typeof document !== 'undefined' && document.hidden;
  // EXE: ở nền nếu cửa sổ ẩn/minimize (document.hidden — TIN CẬY trong Electron) HOẶC mất focus/sau lưng app khác
  // (foreground THẬT từ main; document.hasFocus KHÔNG tin cậy nên KHÔNG dùng). Dùng CẢ 2 để chắc: minimize/tray
  // vẫn bắn OS-toast kể cả khi sự kiện cầu foreground chưa kịp tới.
  if (isElectron()) return docHidden || !pcForeground;
  // WEB (Admin Demo 7/8 "PC gửi sang web không push, mà web app không cần quyền vẫn push được"): GỐC bug — TRƯỚC
  // dùng `!document.hasFocus()` nên khi cửa sổ web CÒN MỞ nhưng nằm SAU LƯNG app khác (không minimize) →
  // hasFocus=false → bị coi là "nền" → đẩy sang nhánh OS Notification (CẦN QUYỀN Chrome) → im ru không chuông.
  // Nhưng toast trong-app + chuông KHÔNG cần quyền và VẪN hiện/nghe được khi cửa sổ còn trên màn. Nên WEB chỉ coi
  // là "nền" khi THẬT SỰ ẨN (`document.hidden` = minimize / đổi sang tab khác): lúc đó mới cần OS Notification.
  // Còn nằm sau lưng (hidden=false) → nhánh foreground → toast + chuông (không cần quyền) → PC→web CÓ chuông ngay.
  return docHidden;
}

function pcBridge(): SigMaPcNotifyBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { SigMaPC?: SigMaPcNotifyBridge }).SigMaPC;
}

function isElectron(): boolean {
  return !!pcBridge()?.notify;
}

/** EXE (Electron) đang chạy hay không — export để AppShell quyết định CHUÔNG nền: EXE nền đã có popup tự-vẽ tự
 * kêu (notification.html) nên renderer KHÔNG kêu lại (tránh đôi); WEB nền không có nguồn âm nào khác nên renderer
 * PHẢI tự phát chuông. GỐC bug "web ở nền mất chuông" (Admin Demo 7/8). */
export function isElectronRuntime(): boolean {
  return isElectron();
}

function webNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

// #25 (Admin Demo 8/8 "thông báo desktop phải là toggle bật/tắt") — cờ per-device (localStorage) bật/tắt popup
// desktop OS trên WEB. Trình duyệt KHÔNG cho code thu hồi quyền Notification, nên "tắt" = app NGỪNG bắn OS
// Notification (dù quyền còn granted). Mặc định BẬT (null → true) để giữ hành vi cũ (đã granted thì hiện).
const DESKTOP_OS_NOTIF_KEY = 'sigma-desktop-notif-enabled';

export function isDesktopOsNotifEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(DESKTOP_OS_NOTIF_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setDesktopOsNotifEnabled(on: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DESKTOP_OS_NOTIF_KEY, on ? '1' : '0');
  } catch {
    /* localStorage chặn — bỏ qua */
  }
}

/** Xin quyền Notification trình duyệt (WEB) 1 lượt nếu người dùng CHƯA quyết định — gọi khi vào app (AppShell,
 * chỉ web, KHÔNG native/không EXE). EXE/native KHÔNG cần (EXE dùng OS Notification qua Electron, native dùng
 * FCM). Best-effort, nuốt lỗi im (1 số trình duyệt chặn nếu không do user-gesture). */
export async function ensureWebNotificationPermission(): Promise<void> {
  if (isElectron()) return; // EXE không dùng Web Notification.
  if (!webNotificationSupported()) return;
  try {
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  } catch {
    // bỏ qua — thiếu quyền chỉ mất OS toast lúc app ở nền, không phá app.
  }
}

/** Phát 1 thông báo OS (app đang ở NỀN). `onClick` chạy khi người dùng bấm vào thông báo (EXE: main gửi lại
 * renderer sự kiện click qua onNotifyClicked — xem wireOsNotificationClick; WEB: gắn trực tiếp notification.onclick).
 *
 * `iconDataUrl` (item 12, 6/8) — avatar người gửi (DIRECT) / avatar nhóm (GROUP) đã được caller (AppShell) tải sẵn
 * thành data URL (fetchAttachmentDataUrl). Có → dùng làm icon thông báo (WEB: field `icon`; EXE: main.js
 * nativeImage.createFromDataURL). KHÔNG có (nhóm chưa đặt ảnh / tải lỗi) → GIỮ NGUYÊN như cũ (WEB: không icon;
 * EXE: main.js dùng icon app mặc định). */
export function notifyOsBackground(
  payload: { title: string; body: string; roomId: string; iconDataUrl?: string; playSound?: boolean },
  onClick?: () => void
): void {
  const pc = pcBridge();
  if (pc?.notify) {
    // EXE — main.js tự kiểm focus + dựng Notification; click do wireOsNotificationClick() điều hướng. iconDataUrl
    // (nếu có) đi kèm để main dựng nativeImage làm icon avatar.
    pc.notify(payload).catch(() => {
      /* best-effort */
    });
    return;
  }
  if (!webNotificationSupported()) return;
  try {
    if (Notification.permission !== 'granted') return;
    if (!isDesktopOsNotifEnabled()) return; // #25 — toggle "Thông báo desktop" đang TẮT → không bắn popup OS.
    const n = new Notification(payload.title, {
      body: payload.body,
      tag: `sigma-room-${payload.roomId}`,
      // WEB Notification `icon` nhận data URL trực tiếp — avatar người gửi/nhóm. Không có → bỏ field (như cũ).
      ...(payload.iconDataUrl ? { icon: payload.iconDataUrl } : {})
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* bỏ qua */
      }
      n.close();
      onClick?.();
    };
  } catch {
    // Notification API có thể ném (vd ngoài secure context) — bỏ qua.
  }
}

/** BUG#8b (6/8, Admin Demo "badge trên ICON app desktop") — đẩy TỔNG số tin chưa đọc lên icon taskbar/dock của
 * bản EXE (Electron). Gọi mỗi khi tổng unread đổi (AppShell). WEB/APK: no-op (không có bridge) — web dùng
 * badge trong sidebar, APK dùng badge FCM/launcher riêng. Best-effort, nuốt lỗi im. */
export function setPcUnreadBadge(total: number): void {
  const pc = pcBridge();
  if (!pc?.setUnreadBadge) return;
  pc.setUnreadBadge(Math.max(0, Math.floor(total) || 0)).catch(() => {
    /* best-effort — badge icon là UX phụ, không chặn luồng chính */
  });
}

/** EXE — đăng ký nhận sự kiện click OS Notification từ main.js (điều hướng vào phòng). Trả hàm huỷ (hoặc no-op
 * nếu không phải EXE). WEB xử lý click trực tiếp trong notifyOsBackground(). */
export function wireOsNotificationClick(onNavigateRoom: (roomId: string) => void): () => void {
  const pc = pcBridge();
  if (!pc?.onNotifyClicked) return () => {};
  return pc.onNotifyClicked((p) => {
    if (p && typeof p.roomId === 'string' && p.roomId) onNavigateRoom(p.roomId);
  });
}
