// SIGMA Mobile Giai đoạn 1 (26/7) — cấu hình domain bot-api thật qua Cloudflare Tunnel (KHÔNG dùng
// localhost — emulator Android không tự resolve `localhost` về máy host, và web-demo/APK Capacitor trước đây
// đã verify domain công khai này hoạt động thật, ưu tiên dùng lại cho đơn giản đúng yêu cầu nhiệm vụ).
// Không có cơ chế biến môi trường kiểu Vite (`import.meta.env`) trong React Native — hardcode 1 hằng số DUY
// NHẤT ở đây, đổi khi cần trỏ máy dev khác (vd `http://10.0.2.2:8788` nếu test qua mạng nội bộ máy chủ).
export const BOT_API_BASE_URL = 'https://sigma-api.example.com';

// CSRF header bắt buộc — PHẢI khớp CHÍNH XÁC apps/bot-api/src/web-session-middleware.ts
// CSRF_HEADER_NAME/CSRF_HEADER_VALUE. Middleware đó check ĐÚNG GIÁ TRỊ 'web' (không chỉ check header có tồn
// tại hay không — đã đọc trực tiếp source xác nhận `req.header(CSRF_HEADER_NAME) !== CSRF_HEADER_VALUE`) nên
// app mobile GIỮ NGUYÊN gửi 'web' — bot-api KHÔNG phân biệt nguồn gọi web/mobile ở tầng CSRF, đơn giản nhất,
// không cần sửa bot-api (đúng phạm vi Giai đoạn 1: không đụng service khác nếu không bắt buộc).
export const CSRF_HEADER_NAME = 'x-sigma-client';
export const CSRF_HEADER_VALUE = 'web';

export const WEB_SESSION_COOKIE_NAME = 'sigma_ws';
