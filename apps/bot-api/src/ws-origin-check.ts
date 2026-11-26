// LANE A Vòng 2 (3/8) — CSWSH (Cross-Site WebSocket Hijacking) defense dùng CHUNG cho MỌI endpoint WebSocket
// của bot-api. Kiểm `Origin` header ở bước HTTP upgrade so với CÙNG allowlist mà CORS đang dùng
// (CORS_ALLOWED_ORIGINS, app.ts — 1 NGUỒN SỰ THẬT DUY NHẤT, thêm origin mới chỉ sửa 1 chỗ ở app.ts).
//
// TẠI SAO CẦN: trình duyệt KHÔNG áp same-origin/CORS cho WebSocket như với fetch/XHR — 1 trang web độc hại mà
// người dùng ĐÃ đăng nhập lỡ mở có thể mở `new WebSocket()` tới server này; trình duyệt TỰ ĐỘNG gửi kèm cookie
// phiên nên kết nối xác thực thành công và kẻ tấn công điều khiển được (CSWSH). Server PHẢI tự kiểm Origin.
//
// QUYẾT ĐỊNH ca native/Capacitor + non-browser (ghi rõ cho LEAD):
//   - App Android Capacitor phục vụ nội dung từ origin `https://localhost` — ĐÃ có trong CORS_ALLOWED_ORIGINS
//     (app.ts, B31) → được chấp nhận qua allowlist. Nếu về sau ship scheme native khác (vd iOS
//     `capacitor://localhost`), THÊM vào CORS_ALLOWED_ORIGINS — KHÔNG hard-code riêng ở đây (giữ 1 nguồn).
//   - Client KHÔNG phải trình duyệt (thư viện HTTP native, công cụ server-side) có thể KHÔNG gửi Origin nào cả.
//     Origin RỖNG/thiếu KHÔNG phải vector CSWSH: chỉ TRÌNH DUYỆT mới vừa tự đính kèm cookie phiên của nạn nhân
//     VỪA BỊ BUỘC gửi Origin trung thực (WHATWG Fetch) — 1 trang tấn công LUÔN lộ Origin thật của nó ở đây và
//     bị chặn. Vì vậy CHO PHÉP Origin rỗng/thiếu (không phá app native), CHỈ TỪ CHỐI Origin CÓ mặt mà không
//     nằm trong allowlist.

import { isAllowedOrigin } from './cors-allowlist.js';

/** true nếu `Origin` được phép mở WebSocket. Rỗng/undefined → cho phép (non-browser, không phải CSWSH). Có
 * giá trị → phải KHỚP CHÍNH XÁC 1 origin trong allowlist HOẶC là origin loopback http (bản PC Electron
 * 127.0.0.1:<cổng ngẫu nhiên>) — xem isAllowedOrigin. So khớp CHÍNH XÁC/regex neo `$`, KHÔNG prefix/startsWith
 * (`http://localhost:5173.evil.com` KHÔNG lọt). Dùng CHUNG 1 nguồn với CORS (app.ts). */
export function isAllowedWsOrigin(origin: string | undefined): boolean {
  return isAllowedOrigin(origin);
}
