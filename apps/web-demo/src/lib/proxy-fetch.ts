// SIGMA (26/7, sau audit độc lập finding HIGH) — wrapper fetch() DÙNG CHUNG cho MỌI request tới bot-api
// cần cookie phiên `sigma_ws` (rc-realtime.ts/rc-client.ts/agent-api-client.ts/kpi-client.ts/
// bot-api-client.ts). Tự động gắn `credentials:'include'` (gửi cookie cross-subdomain) + header CSRF bắt buộc
// (`x-sigma-client: web` — xem apps/bot-api/src/web-session-middleware.ts CSRF_HEADER_NAME/VALUE, PHẢI
// khớp CHÍNH XÁC 2 hằng số đó). KHÔNG dùng helper này cho `GET /v1/rc-file` (điều hướng `<a href>` trực tiếp,
// không phải fetch() — không gắn header tùy ý được, xem rc-proxy.ts phía server dùng Sec-Fetch-Site thay).
import { currentPlatform, PLATFORM_HEADER } from './platform';

export function proxyFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-sigma-client', 'web');
  // #3 (6/8) — gắn NỀN hiện tại (web/exe/apk) vào MỌI request bot-api. Server chỉ đọc ở endpoint đăng nhập/QR
  // (đá phiên cũ cùng nền); các endpoint khác bỏ qua → an toàn để đặt chung 1 chỗ, không phải rải từng call.
  headers.set(PLATFORM_HEADER, currentPlatform());
  return fetch(url, { ...init, credentials: 'include', headers });
}
