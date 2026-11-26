// SIGMA Phase 6 dọn RC-dead-code (30/7) — `parseCookieHeader`/`SESSION_EXPIRED_CLOSE_CODE` trước đây sống
// ở rc-realtime-proxy.ts (relay DDP browser⇄Rocket.Chat, file đó ĐÃ XÓA — `attachRcRealtimeProxy` xác nhận
// zero-caller thật: không client nào (web-demo/mobile) còn mở kết nối `/v1/rc-realtime-proxy`, xem BUGS_FIXED.md
// mục dọn RC-dead-code). 2 export này VẪN LÀ CODE SỐNG THẬT — dùng bởi call-signaling-server.ts VÀ
// chat-realtime-proxy.ts (2 relay WebSocket khác, KHÔNG liên quan Rocket.Chat) để parse cookie thô từ upgrade
// request + đóng socket với đúng close-code khi phiên hết hạn — dời sang file trung lập này thay vì xóa theo
// rc-realtime-proxy.ts.

/** Parse tay đơn giản header `Cookie:` thô (raw HTTP upgrade request KHÔNG đi qua Express middleware chain
 * bình thường — cookie-parser không chạy ở đây). Đủ dùng cho 1 cookie tên biết trước, KHÔNG cần thêm
 * dependency `cookie` cho việc này. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/** Đóng clientWs với code này khi phiên WebSession không hợp lệ (thiếu/hết hạn), để client tự nhận biết KHÔNG
 * phải mất mạng thường mà cần điều hướng /login. Dải 4000-4999 dành riêng cho ứng dụng (RFC 6455 §7.4.2). */
export const SESSION_EXPIRED_CLOSE_CODE = 4401;

/** #3 (6/8) — đóng clientWs với code này khi phiên bị ĐÁ do đăng nhập trên thiết bị KHÁC CÙNG NỀN (kiểu Zalo).
 * KHÁC SESSION_EXPIRED_CLOSE_CODE để client hiện thông báo RIÊNG ("vừa đăng nhập trên thiết bị khác") thay vì
 * "phiên hết hạn" chung. Dải 4000-4999 dành riêng cho ứng dụng (RFC 6455 §7.4.2). */
export const SESSION_REVOKED_CLOSE_CODE = 4409;
