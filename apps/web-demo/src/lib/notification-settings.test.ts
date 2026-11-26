// Item 2 (6/8) — test store cài đặt thông báo GLOBAL per-device (notification-settings.ts): clamp thời gian,
// getter mặc định, setter ghi localStorage đúng + đọc lại đúng. Chạy environment 'node' — giả lập window.localStorage.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  clampDurationSec,
  isMessageNotifEnabled,
  isCallNotifEnabled,
  getToastStyle,
  getToastDurationSec,
  setMessageNotifEnabled,
  setCallNotifEnabled,
  setToastStyle,
  setToastDurationSec,
  DEFAULT_TOAST_DURATION_SEC,
  TOAST_DURATION_MIN_SEC,
  TOAST_DURATION_MAX_SEC,
  __resetNotificationSettingsCacheForTest
} from './notification-settings';

const store = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string) => {
    store.set(k, String(v));
  },
  removeItem: (k: string) => {
    store.delete(k);
  }
};

beforeEach(() => {
  store.clear();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: fakeLocalStorage,
    addEventListener: () => {}
  };
  __resetNotificationSettingsCacheForTest();
});
afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('clampDurationSec', () => {
  it('NaN/Infinity → mặc định', () => {
    expect(clampDurationSec(Number.NaN)).toBe(DEFAULT_TOAST_DURATION_SEC);
    expect(clampDurationSec(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TOAST_DURATION_SEC);
  });
  it('kẹp về [MIN, MAX] + làm tròn', () => {
    expect(clampDurationSec(0)).toBe(TOAST_DURATION_MIN_SEC);
    expect(clampDurationSec(999)).toBe(TOAST_DURATION_MAX_SEC);
    expect(clampDurationSec(5.6)).toBe(6);
  });
});

describe('getter mặc định (chưa lưu gì)', () => {
  it('thông báo tin nhắn/cuộc gọi mặc định BẬT', () => {
    expect(isMessageNotifEnabled()).toBe(true);
    expect(isCallNotifEnabled()).toBe(true);
  });
  it('kiểu toast mặc định corner, thời gian mặc định', () => {
    expect(getToastStyle()).toBe('corner');
    expect(getToastDurationSec()).toBe(DEFAULT_TOAST_DURATION_SEC);
  });
});

describe('setter ghi localStorage + đọc lại đúng', () => {
  it('tắt thông báo tin nhắn', () => {
    setMessageNotifEnabled(false);
    expect(store.get('notif-messages-enabled')).toBe('0');
    expect(isMessageNotifEnabled()).toBe(false);
    setMessageNotifEnabled(true);
    expect(isMessageNotifEnabled()).toBe(true);
  });
  it('tắt thông báo cuộc gọi', () => {
    setCallNotifEnabled(false);
    expect(store.get('notif-calls-enabled')).toBe('0');
    expect(isCallNotifEnabled()).toBe(false);
  });
  it('đổi kiểu toast top-drop rồi corner', () => {
    setToastStyle('top-drop');
    expect(store.get('toast-style')).toBe('top-drop');
    expect(getToastStyle()).toBe('top-drop');
    setToastStyle('corner');
    expect(getToastStyle()).toBe('corner');
  });
  it('giá trị kiểu toast lạ trong localStorage → về corner', () => {
    store.set('toast-style', 'banana');
    expect(getToastStyle()).toBe('corner');
  });
  it('đổi thời gian + tự kẹp khi ngoài biên', () => {
    setToastDurationSec(8);
    expect(store.get('toast-duration-sec')).toBe('8');
    expect(getToastDurationSec()).toBe(8);
    setToastDurationSec(999);
    expect(getToastDurationSec()).toBe(TOAST_DURATION_MAX_SEC);
  });
  it('thời gian hỏng trong localStorage → mặc định', () => {
    store.set('toast-duration-sec', 'abc');
    expect(getToastDurationSec()).toBe(DEFAULT_TOAST_DURATION_SEC);
  });
});
