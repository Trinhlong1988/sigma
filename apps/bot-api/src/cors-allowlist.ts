// LANE A Vòng 2 (3/8) — allowlist origin dùng CHUNG cho CORS (app.ts) VÀ kiểm Origin WebSocket chống CSWSH
// (ws-origin-check.ts). Tách ra 1 MODULE LÁ (không import gì khác trong dự án) để 2 nơi dùng chung 1 NGUỒN SỰ
// THẬT DUY NHẤT mà KHÔNG tạo import vòng: nếu ws-origin-check.ts import thẳng app.ts thì kéo theo toàn bộ đồ
// thị router của app vào các module WebSocket → gây circular import làm `new WebSocketServer` văng
// "not a constructor" (đã tự bắt được khi chạy test). Thêm origin mới CHỈ sửa danh sách ở đây.
//
// (24/7, web-demo nối bot-api thật lần đầu — trước đây KHÔNG có CORS nên trình duyệt tự chặn mọi fetch()
// cross-origin từ Vite dev server sang :8788). Allowlist CỐ ĐỊNH cho môi trường dev/LAN hiện tại (KHÔNG dùng
// `origin: '*'` — route auth về sau còn dùng cookie/credentials nên origin phải khai rõ, `*` không tương thích
// với credentials theo spec CORS).
export const CORS_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  // 25/7 — domain thật qua Cloudflare Tunnel (giống GLB), web-demo build production trỏ vào đây.
  'https://sigma.example.com',
  // 4/8 — B (Admin Demo báo "bản web cũng lỗi đường truyền"): domain WEB APP CHAT thật = chat.example.com
  // (→ 57903 serve-webapp web-demo dist, xem infra/web-static/run-webapp.cmd). TRƯỚC đây allowlist chỉ có
  // sigma.example.com (LANDING, 57902) → web app tại sigma-chat gọi sigma-api bị CORS chặn hết
  // (đăng nhập/mọi fetch báo "Lỗi kết nối mạng"). Bổ sung để web app đăng nhập được.
  'https://chat.example.com',
  // 26/7 — B26: thiếu origin LAN cổng static production (SigMa_WebStatic, 57902) — Admin Demo mở qua
  // http://127.0.0.1:57902 bị CORS chặn fetch tới bot-api ("Lỗi kết nối mạng"). Thêm cả localhost lẫn LAN IP.
  'http://localhost:57902',
  'http://127.0.0.1:57902',
  // 26/7 — B31: APK Android đóng gói qua Capacitor (apps/web-demo/android) — WebView Capacitor mặc định phục
  // vụ nội dung từ origin `https://localhost` (KHÔNG cấu hình server.androidScheme khác trong
  // capacitor.config.ts, xem file đó) — thiếu origin này khiến app cài trên điện thoại KHÔNG gọi được bot-api
  // (đăng nhập/mọi API đều bị chặn CORS). Xác nhận qua logcat thật lúc verify APK trên emulator.
  'https://localhost'
];

// 4/8 — B (fixperf-tiếp): SigMa PC (Electron, apps/sigma-pc/src/main.js) phục vụ renderer từ
// `http://127.0.0.1:<cổng NGẪU NHIÊN>` (server.listen(0,'127.0.0.1') — cổng đổi mỗi lần chạy nên KHÔNG liệt kê
// cứng được). Thiếu origin này → bot-api chặn CORS mọi fetch (đăng nhập báo "Lỗi kết nối mạng") VÀ chặn Origin
// WebSocket (mất realtime/gọi) trên bản PC. Cho phép MỌI origin loopback http (127.0.0.1 / localhost, mọi cổng).
// AN TOÀN với CSWSH: một trang web tấn công TỪ XA KHÔNG BAO GIỜ có origin loopback (origin của nó là domain thật
// của kẻ tấn công) — chỉ ứng dụng chạy TRÊN CHÍNH máy người dùng mới phát origin này.
const LOOPBACK_HTTP_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/** Nguồn sự thật DUY NHẤT cho cả CORS (app.ts) lẫn kiểm Origin WebSocket (ws-origin-check.ts). Origin rỗng/
 * undefined (client non-browser/native) → cho phép (KHÔNG phải vector CSWSH). Có giá trị → phải khớp CHÍNH XÁC
 * 1 origin trong allowlist HOẶC là origin loopback http (bản PC Electron). */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  if (CORS_ALLOWED_ORIGINS.includes(origin)) return true;
  return LOOPBACK_HTTP_ORIGIN.test(origin);
}
