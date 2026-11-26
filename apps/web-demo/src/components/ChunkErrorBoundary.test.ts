// Regression #16 (8/8) — GỐC "Xem nhật ký ra trang trắng": chunk lazy (DiaryScreen) tải LỖI mà KHÔNG có
// ErrorBoundary → React unmount cả cây → trắng xoá. isChunkLoadError PHẢI nhận đúng lỗi tải-chunk của MỌI trình
// duyệt (để boundary tự reload) và KHÔNG nhầm lỗi logic-render trong màn (để boundary hiện fallback, không reload
// loop che mất bug thật). Test này khoá lại tập thông điệp đã biết — thêm engine/trình duyệt mới thì bổ sung ở đây.
import { describe, it, expect } from 'vitest';
import { isChunkLoadError } from './ChunkErrorBoundary';

describe('isChunkLoadError', () => {
  // Lỗi TẢI CHUNK thật — từng trình duyệt phát thông điệp khác nhau (bắt được ở tái hiện thật: Chromium).
  const chunkErrors = [
    new Error('Failed to fetch dynamically imported module: https://x/assets/DiaryScreen-abc.js'), // Chrome/Vite (tái hiện được)
    new Error('error loading dynamically imported module: https://x/assets/DiaryScreen-abc.js'), // Firefox
    new Error('Importing a module script failed.'), // Safari/WebKit
    Object.assign(new Error('Loading chunk 42 failed.'), { name: 'ChunkLoadError' }), // webpack cũ (message)
    Object.assign(new Error('boom'), { name: 'ChunkLoadError' }) // webpack cũ (chỉ name)
  ];
  for (const err of chunkErrors) {
    it(`NHẬN lỗi tải-chunk: ${err.name}: ${err.message.slice(0, 40)}`, () => {
      expect(isChunkLoadError(err)).toBe(true);
    });
  }

  // Lỗi KHÔNG phải tải-chunk (bug logic trong màn) — KHÔNG được coi là chunk error (nếu không, boundary reload
  // vô ích/lặp và che mất bug thật thay vì hiện fallback).
  const otherErrors = [
    new TypeError("Cannot read properties of undefined (reading 'length')"),
    new Error('Network request failed'),
    new Error('Phiên đăng nhập đã hết hạn.'),
    'chuỗi lỗi lạ',
    null,
    undefined
  ];
  for (const err of otherErrors) {
    it(`KHÔNG nhận nhầm lỗi khác: ${String(err instanceof Error ? err.message : err).slice(0, 40)}`, () => {
      expect(isChunkLoadError(err)).toBe(false);
    });
  }
});
