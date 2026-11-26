// #3 (6/8, Admin Demo "đăng nhập máy mới đá phiên CŨ CÙNG NỀN như Zalo") — test resolvePlatform (THUẦN, nhận cờ
// đã dò sẵn nên KHÔNG cần mock Capacitor/window — cùng lớp "pure-logic test" root vitest.config.ts).
import { describe, expect, it } from 'vitest';
import { resolvePlatform, PLATFORM_HEADER } from './platform';

describe('resolvePlatform — Android native→apk; Electron→exe; còn lại→web', () => {
  it('Capacitor native + platform android → apk', () => {
    expect(resolvePlatform({ capacitorNative: true, capacitorPlatform: 'android', isElectron: false })).toBe('apk');
  });

  it('vỏ Electron (isElectron) → exe', () => {
    expect(resolvePlatform({ capacitorNative: false, capacitorPlatform: 'web', isElectron: true })).toBe('exe');
  });

  it('trình duyệt web thường → web', () => {
    expect(resolvePlatform({ capacitorNative: false, capacitorPlatform: 'web', isElectron: false })).toBe('web');
  });

  it('apk (native android) ưu tiên TRƯỚC exe khi cả 2 cờ cùng bật (không có ca thực tế, chỉ khẳng định thứ tự)', () => {
    expect(resolvePlatform({ capacitorNative: true, capacitorPlatform: 'android', isElectron: true })).toBe('apk');
  });

  it('Capacitor native nhưng KHÔNG phải android (vd ios) → KHÔNG apk (rơi xuống web/exe theo cờ Electron)', () => {
    expect(resolvePlatform({ capacitorNative: true, capacitorPlatform: 'ios', isElectron: false })).toBe('web');
    expect(resolvePlatform({ capacitorNative: true, capacitorPlatform: 'ios', isElectron: true })).toBe('exe');
  });

  it('tên header KHỚP hằng server đọc (routes/auth.ts x-sigma-platform)', () => {
    expect(PLATFORM_HEADER.toLowerCase()).toBe('x-sigma-platform');
  });
});
