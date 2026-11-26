// Cài đặt thông báo GLOBAL per-device (item 2, Admin Demo chốt 6/8) — nguồn DUY NHẤT điều khiển:
//   - có/không NỔI toast tin nhắn khi app đang mở (notif-messages-enabled)
//   - có/không đổ chuông cuộc gọi đến (notif-calls-enabled)
//   - kiểu toast desktop: 'corner' (góc phải-dưới cạnh khay đồng hồ, MẶC ĐỊNH) | 'top-drop' (thả từ trên xuống)
//   - thời gian tự ẩn toast (giây) — ToastHost auto-ẩn = giá trị này + 1s (xem toast-store.ts).
//
// LƯU localStorage (per-device, KHÔNG đồng bộ server — Admin Demo chốt "GLOBAL per-device"). Key ĐẶT RIÊNG,
// KHÔNG bị xóa khi đăng xuất: performLogout() → clearSession() chỉ removeItem(SESSION_KEY) (xem session.ts +
// logout.ts), 4 key dưới đây KHÔNG nằm trong đó nên GIỮ NGUYÊN qua đăng xuất/đăng nhập lại — đúng ý "cài trên
// thiết bị này". CÙNG PATTERN audio-player.ts (isAudioEnabled qua localStorage).
//
// Reactivity: store nhỏ tự viết theo chuẩn useSyncExternalStore (subscribe + getSnapshot cache ổn định
// reference) — hook useNotificationSettings() cho UI (SettingsScreen), còn getter thuần (isMessageNotifEnabled/
// isCallNotifEnabled/...) cho nơi KHÔNG cần reactivity (AppShell handler, IncomingCallScreen) đọc THẲNG
// localStorage nên LUÔN mới nhất tức thì sau khi đổi ở màn Cài đặt (kể cả khi component chưa re-render).
import { useSyncExternalStore } from 'react';

export type ToastStyle = 'corner' | 'top-drop';

export interface NotificationSettings {
  messagesEnabled: boolean;
  callsEnabled: boolean;
  toastStyle: ToastStyle;
  toastDurationSec: number;
}

const KEY_MESSAGES = 'notif-messages-enabled';
const KEY_CALLS = 'notif-calls-enabled';
const KEY_STYLE = 'toast-style';
const KEY_DURATION = 'toast-duration-sec';

export const DEFAULT_TOAST_DURATION_SEC = 5;
export const TOAST_DURATION_MIN_SEC = 2;
export const TOAST_DURATION_MAX_SEC = 15;
/** Các mốc thời gian hiển thị cho segmented control ở SettingsScreen (giây). */
export const TOAST_DURATION_OPTIONS: readonly number[] = [3, 5, 8];

function hasWindow(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readBool(key: string, def: boolean): boolean {
  if (!hasWindow()) return def;
  const saved = window.localStorage.getItem(key);
  return saved === null ? def : saved === '1';
}

/** Đọc thời gian tự ẩn (giây) — kẹp về [MIN, MAX], giá trị hỏng/thiếu → mặc định. Hàm THUẦN hoá phần clamp để
 * test được (xem clampDurationSec). */
export function clampDurationSec(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_TOAST_DURATION_SEC;
  return Math.min(TOAST_DURATION_MAX_SEC, Math.max(TOAST_DURATION_MIN_SEC, Math.round(raw)));
}

// ---- getter thuần (luôn đọc mới nhất từ localStorage) ----
export function isMessageNotifEnabled(): boolean {
  return readBool(KEY_MESSAGES, true); // mặc định BẬT (như Zalo — có thông báo).
}
export function isCallNotifEnabled(): boolean {
  return readBool(KEY_CALLS, true); // mặc định BẬT.
}
export function getToastStyle(): ToastStyle {
  if (!hasWindow()) return 'corner';
  return window.localStorage.getItem(KEY_STYLE) === 'top-drop' ? 'top-drop' : 'corner'; // mặc định 'corner'.
}
export function getToastDurationSec(): number {
  if (!hasWindow()) return DEFAULT_TOAST_DURATION_SEC;
  const saved = window.localStorage.getItem(KEY_DURATION);
  if (saved === null) return DEFAULT_TOAST_DURATION_SEC;
  return clampDurationSec(Number(saved));
}

// ---- store (useSyncExternalStore-friendly) ----
const listeners = new Set<() => void>();
let cachedSnapshot: NotificationSettings | null = null;
let storageListenerInstalled = false;

function computeSnapshot(): NotificationSettings {
  return {
    messagesEnabled: isMessageNotifEnabled(),
    callsEnabled: isCallNotifEnabled(),
    toastStyle: getToastStyle(),
    toastDurationSec: getToastDurationSec()
  };
}

/** LUÔN trả CÙNG reference giữa 2 lần thay đổi (yêu cầu của useSyncExternalStore để KHÔNG lặp render vô hạn) —
 * chỉ tạo object mới khi có setter/`storage` event làm invalidate cache. */
function getSnapshot(): NotificationSettings {
  if (!cachedSnapshot) cachedSnapshot = computeSnapshot();
  return cachedSnapshot;
}

function invalidateAndEmit(): void {
  cachedSnapshot = null;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Đồng bộ đa-tab (đổi cài đặt ở tab khác) — cài 1 lần khi có subscriber đầu tiên.
  if (!storageListenerInstalled && hasWindow()) {
    storageListenerInstalled = true;
    window.addEventListener('storage', (e) => {
      if (e.key === KEY_MESSAGES || e.key === KEY_CALLS || e.key === KEY_STYLE || e.key === KEY_DURATION) {
        invalidateAndEmit();
      }
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

// ---- setter (ghi localStorage + invalidate + notify listener CÙNG tab) ----
function writeBool(key: string, on: boolean): void {
  if (!hasWindow()) return;
  window.localStorage.setItem(key, on ? '1' : '0');
  invalidateAndEmit();
}

export function setMessageNotifEnabled(on: boolean): void {
  writeBool(KEY_MESSAGES, on);
}
export function setCallNotifEnabled(on: boolean): void {
  writeBool(KEY_CALLS, on);
}
export function setToastStyle(style: ToastStyle): void {
  if (!hasWindow()) return;
  window.localStorage.setItem(KEY_STYLE, style);
  invalidateAndEmit();
}
export function setToastDurationSec(sec: number): void {
  if (!hasWindow()) return;
  window.localStorage.setItem(KEY_DURATION, String(clampDurationSec(sec)));
  invalidateAndEmit();
}

/** Hook cho UI (SettingsScreen + ToastHost) — trả settings hiện tại, tự re-render khi đổi. */
export function useNotificationSettings(): NotificationSettings {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Test hook (KHÔNG dùng trong sản phẩm) — reset cache để test cách ly.
export function __resetNotificationSettingsCacheForTest(): void {
  cachedSnapshot = null;
}
