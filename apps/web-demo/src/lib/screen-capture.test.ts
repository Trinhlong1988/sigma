// SIGMA — Mục 23 "chụp màn hình gửi vào chat" THẬT (thay mock cũ). Test cho các hàm THUẦN của
// `screen-capture.ts` (feature-detect / dịch lỗi / sinh tên file) — KHÔNG test phần DOM thật (`<video>`/
// `<canvas>` bên trong `captureFrameToPngBlob()`, hàm nội bộ không export) vì repo CHƯA có jsdom/
// @testing-library/react (CÙNG lý do các file test khác trong thư mục này chỉ test phần thuần, xem comment
// đầu `voice-message-mapping.test.ts`) — phần DOM/`getDisplayMedia()` thật verify bằng Playwright browser
// thật (xem báo cáo đợt build này).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildScreenshotFileName, captureScreenshot, friendlyGetDisplayMediaError, isScreenCaptureSupported } from './screen-capture';

describe('isScreenCaptureSupported', () => {
  it('navigator.mediaDevices.getDisplayMedia là function → true (desktop Chrome/Edge/Firefox)', () => {
    expect(isScreenCaptureSupported({ mediaDevices: { getDisplayMedia: async () => ({}) as MediaStream } })).toBe(true);
  });

  it('mediaDevices undefined → false (KHÔNG throw) — CHÍNH nhánh sẽ xảy ra thật trên Android WebView theo BCD đã tra cứu (webview_android mirror chrome_android = false)', () => {
    expect(isScreenCaptureSupported({})).toBe(false);
  });

  it('mediaDevices tồn tại nhưng getDisplayMedia không phải function (vd undefined) → false', () => {
    expect(isScreenCaptureSupported({ mediaDevices: {} })).toBe(false);
  });

  it('nav là undefined (navigator không tồn tại, vd SSR) → false, KHÔNG throw', () => {
    expect(isScreenCaptureSupported(undefined)).toBe(false);
  });
});

describe('buildScreenshotFileName', () => {
  it('sinh đúng khuôn "chup-man-hinh-<timestamp>.png"', () => {
    expect(buildScreenshotFileName(1234567890)).toBe('chup-man-hinh-1234567890.png');
  });
});

describe('friendlyGetDisplayMediaError', () => {
  it('NotAllowedError (người dùng hủy dialog chọn màn hình, hoặc quyền bị từ chối) → thông báo tiếng Việt rõ ràng, giữ .name + .cause gốc', () => {
    const original = new DOMException('Permission denied', 'NotAllowedError');
    const wrapped = friendlyGetDisplayMediaError(original);
    expect(wrapped.message).toContain('hủy chọn màn hình');
    expect(wrapped.name).toBe('NotAllowedError');
    expect(wrapped.cause).toBe(original);
  });

  it('NotFoundError → thông báo "không tìm thấy màn hình/cửa sổ"', () => {
    const wrapped = friendlyGetDisplayMediaError(new DOMException('x', 'NotFoundError'));
    expect(wrapped.message).toContain('Không tìm thấy màn hình');
  });

  it('NotReadableError → thông báo không đọc được nội dung', () => {
    const wrapped = friendlyGetDisplayMediaError(new DOMException('x', 'NotReadableError'));
    expect(wrapped.message).toContain('Không đọc được nội dung');
  });

  it('lỗi không phải DOMException/mã lạ → thông báo mặc định chung, KHÔNG throw thêm', () => {
    const wrapped = friendlyGetDisplayMediaError(new Error('bug lạ'));
    expect(wrapped.message).toBe('Không thể chụp màn hình — vui lòng thử lại.');
    expect(wrapped.name).toBe('ScreenCaptureError');
  });

  it('nhận vào giá trị bất kỳ không phải Error (vd string/undefined) → vẫn trả về Error hợp lệ, KHÔNG throw', () => {
    expect(friendlyGetDisplayMediaError('chuỗi lạ').message).toBe('Không thể chụp màn hình — vui lòng thử lại.');
    expect(friendlyGetDisplayMediaError(undefined).message).toBe('Không thể chụp màn hình — vui lòng thử lại.');
  });
});

// captureScreenshot() cấp cao — chỉ test được nhánh feature-detect (KHÔNG DOM) trong environment 'node':
// navigator không có getDisplayMedia → throw đúng thông báo, KHÔNG gọi gì thêm. Nhánh gọi getDisplayMedia()
// thật + vẽ canvas cần DOM thật, verify bằng Playwright (xem báo cáo).
describe('captureScreenshot — nhánh feature-detect (KHÔNG DOM)', () => {
  // Node 21+ có sẵn global `navigator` (read-only getter, KHÔNG gán thẳng được như
  // `globalThis.navigator = ...` — ném "Cannot set property navigator of #<Object> which has only a getter").
  // `vi.stubGlobal()`/`vi.unstubAllGlobals()` là cơ chế CHUẨN của Vitest cho đúng trường hợp này (ghi đè global
  // qua Object.defineProperty nội bộ, tự khôi phục sau mỗi test — xem vitest.dev/api/vi.html#vi-stubglobal).
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('navigator.mediaDevices.getDisplayMedia không tồn tại → throw "không hỗ trợ chụp màn hình", KHÔNG crash', async () => {
    vi.stubGlobal('navigator', { mediaDevices: {} });
    await expect(captureScreenshot()).rejects.toThrow('không hỗ trợ chụp màn hình');
  });

  it('getDisplayMedia() reject NotAllowedError (người dùng bấm Hủy ở dialog) → throw lỗi tiếng Việt đã dịch, KHÔNG throw lỗi gốc thô', async () => {
    const getDisplayMedia = vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
    await expect(captureScreenshot()).rejects.toThrow('hủy chọn màn hình');
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true });
  });
});
