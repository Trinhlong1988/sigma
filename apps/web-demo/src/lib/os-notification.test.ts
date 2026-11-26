// Việc #24 Part B (6/8) — test THUẦN cho gate quyết định gọi native cancel notification (shouldAttemptNativeClear,
// os-notification.ts). CHỈ test phần logic thuần (không mock Capacitor/native): native + roomId hợp lệ → true;
// web/exe HOẶC roomId rỗng/sai kiểu → false. Chạy env 'node' (KHÔNG DOM/native — registerPlugin lúc load trả proxy vô hại).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldAttemptNativeClear, isAppInBackground } from './os-notification';

describe('shouldAttemptNativeClear — gate hủy notification native theo phòng', () => {
  it('native (APK) + roomId hợp lệ → true (được phép cancel)', () => {
    expect(shouldAttemptNativeClear(true, 'room-abc123')).toBe(true);
  });

  it('KHÔNG native (web/exe) → false dù roomId hợp lệ (no-op, badge do sidebar/taskbar lo)', () => {
    expect(shouldAttemptNativeClear(false, 'room-abc123')).toBe(false);
  });

  it('native nhưng roomId rỗng/khoảng trắng/không phải string → false (không gọi native vô nghĩa)', () => {
    expect(shouldAttemptNativeClear(true, '')).toBe(false);
    expect(shouldAttemptNativeClear(true, '   ')).toBe(false);
    expect(shouldAttemptNativeClear(true, undefined)).toBe(false);
    expect(shouldAttemptNativeClear(true, null)).toBe(false);
    expect(shouldAttemptNativeClear(true, 123)).toBe(false);
  });
});

// Regression (Admin Demo 7/8 "PC gửi sang web không push, mà web app không cần quyền vẫn push được") — WEB coi là
// "ở nền" (đẩy sang OS Notification cần quyền) CHỈ khi THẬT SỰ ẨN (document.hidden = minimize/đổi tab). Nằm SAU
// LƯNG app khác (hidden=false, dù mất focus) → KHÔNG nền → vẫn hiện toast trong-app + chuông (KHÔNG cần quyền).
// GỐC bug cũ: dùng !document.hasFocus() → web sau lưng bị coi nền → im ru. KHÓA để không tái diễn.
describe('isAppInBackground — WEB chỉ coi là nền khi thật sự ẩn (document.hidden), KHÔNG theo focus', () => {
  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  let savedWin: unknown;
  let savedDoc: unknown;
  beforeEach(() => {
    savedWin = g.window;
    savedDoc = g.document;
    g.window = {}; // KHÔNG có SigMaPC → nhánh WEB (không phải EXE).
  });
  afterEach(() => {
    g.window = savedWin;
    g.document = savedDoc;
  });

  it('web nằm SAU LƯNG app khác (hidden=false, mất focus) → KHÔNG nền → toast+chuông không cần quyền', () => {
    g.document = { hidden: false, hasFocus: () => false };
    expect(isAppInBackground()).toBe(false);
  });

  it('web minimize/đổi tab (hidden=true) → nền → nhánh OS Notification (cần quyền)', () => {
    g.document = { hidden: true, hasFocus: () => false };
    expect(isAppInBackground()).toBe(true);
  });

  it('web đang focus (hidden=false, hasFocus=true) → KHÔNG nền', () => {
    g.document = { hidden: false, hasFocus: () => true };
    expect(isAppInBackground()).toBe(false);
  });
});
