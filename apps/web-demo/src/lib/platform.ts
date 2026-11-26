// #3 (6/8, Admin Demo "đăng nhập máy mới đá phiên CŨ CÙNG NỀN như Zalo") — phát hiện NỀN đang chạy để gửi kèm
// header `X-Sigma-Platform` lúc đăng nhập (server đọc để đá đúng phiên cùng nền, xem
// apps/bot-api/src/web-session-service.ts derivePlatform). 1 nguồn web/exe/apk (web-demo dùng chung cho cả 3).
import { Capacitor } from '@capacitor/core';

/** 3 giá trị NỀN — KHỚP CHÍNH XÁC ClientPlatform phía bot-api (web-session-service.ts). */
export type ClientPlatform = 'web' | 'exe' | 'apk';

/** Tên header client gửi lúc đăng nhập — KHỚP CHÍNH XÁC hằng server đọc (routes/auth.ts headerString đọc
 * `x-sigma-platform`, HTTP header không phân biệt hoa/thường). */
export const PLATFORM_HEADER = 'X-Sigma-Platform';

/** THUẦN (nhận cờ đã dò sẵn để test tất định) — Android native (Capacitor) → 'apk'; vỏ Electron → 'exe'; còn
 * lại (trình duyệt web) → 'web'. Thứ tự: kiểm apk (native android) TRƯỚC exe (Electron KHÔNG phải native
 * Capacitor) — 2 nền loại trừ nhau nên thứ tự chỉ để rõ ràng, không có ca chồng lấn thực tế. */
export function resolvePlatform(flags: { capacitorNative: boolean; capacitorPlatform: string; isElectron: boolean }): ClientPlatform {
  if (flags.capacitorNative && flags.capacitorPlatform === 'android') return 'apk';
  if (flags.isElectron) return 'exe';
  return 'web';
}

/** NỀN hiện tại (dò runtime). Bọc try/catch quanh Capacitor (ở vỏ Electron/web thuần plugin có thể ném) —
 * lỗi → coi như KHÔNG phải native. Electron: cờ `window.SigMaPC.isElectron` (preload, xem PcTitleBar.tsx). */
export function currentPlatform(): ClientPlatform {
  let capacitorNative = false;
  let capacitorPlatform = 'web';
  try {
    capacitorNative = Capacitor.isNativePlatform();
    capacitorPlatform = Capacitor.getPlatform();
  } catch {
    // Capacitor không sẵn / ném ở vỏ lạ → coi như không native (fallback web/exe theo cờ Electron dưới).
  }
  // `typeof window` — env test node (proxyFetch được test gián tiếp) KHÔNG có `window` → truy cập trực tiếp
  // sẽ ReferenceError (làm proxyFetch ném → caller hiểu nhầm NETWORK_ERROR). Guard để an toàn cả node lẫn trình duyệt.
  const isElectron =
    typeof window !== 'undefined' &&
    !!(window as unknown as { SigMaPC?: { isElectron?: boolean } }).SigMaPC?.isElectron;
  return resolvePlatform({ capacitorNative, capacitorPlatform, isElectron });
}
