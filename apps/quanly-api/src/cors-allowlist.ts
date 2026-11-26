// AUDIT-VÁ #1 (HIGH, security-auditor 4/8) — CORS reflect-all + credentials.
// TRƯỚC: index.ts phản chiếu (reflect) MỌI Origin về Access-Control-Allow-Origin kèm Allow-Credentials:true
// (`origin: () => cb(null, true)`), tức bất kỳ website độc hại nào cũng đọc được phản hồi kèm cookie phiên
// `ql_session` của nạn nhân (CSRF đọc-được-phản-hồi). SAU: allowlist TƯỜNG MINH — chỉ domain thật + loopback
// http (bản desktop Electron phục vụ renderer từ http://127.0.0.1:<cổng ngẫu nhiên>) + Origin RỖNG (Electron
// file:// / client native). Origin CÓ mặt mà KHÔNG khớp → KHÔNG phản chiếu ACAO (trình duyệt tự chặn).
//
// Copy đúng pattern isAllowedOrigin của apps/bot-api/src/cors-allowlist.ts (1 nguồn sự thật duy nhất cho CORS).
// Thêm origin mới CHỈ sửa danh sách ở đây.
export const CORS_ALLOWED_ORIGINS = [
  // Domain thật qua Cloudflare (khi renderer chạy web trên chính domain API).
  'https://alpha-quanly-api.example.com'
];

// Bản desktop Electron phục vụ renderer từ http://127.0.0.1:<cổng NGẪU NHIÊN> (đổi mỗi lần chạy → KHÔNG liệt
// kê cứng cổng được). Regex NEO đầu-cuối (`^...$`) để `http://127.0.0.1.evil.com` KHÔNG khớp (chống origin giả
// dạng loopback). AN TOÀN: một trang web tấn công TỪ XA không bao giờ phát được origin loopback — chỉ ứng dụng
// chạy TRÊN CHÍNH máy người dùng mới phát origin này.
const LOOPBACK_HTTP_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/**
 * Origin rỗng/undefined (Electron file:// / client non-browser/native) → cho phép (KHÔNG phải vector CSRF-đọc:
 * request không-Origin không đến từ trang web cross-site trong trình duyệt). Có giá trị → phải khớp CHÍNH XÁC 1
 * origin allowlist HOẶC là origin loopback http (bản desktop). KHÔNG khớp → false → không phản chiếu ACAO (chặn).
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  // Bản desktop ĐÓNG GÓI load renderer bằng loadFile → trang chạy scheme `file://` → mọi fetch cross-origin
  // tới API phát Origin HEADER LÀ CHUỖI 'null' (không phải rỗng). Đây là app native của chính người dùng (KHÔNG
  // phải trang web tấn công từ xa), cần đọc được phản hồi → cho phép 'null' như origin-rỗng. An toàn thực tế:
  // cookie ql_session CHỈ tồn tại trong session của app desktop (không có trong trình duyệt nào) nên không có
  // "nạn nhân" CSRF trong trình duyệt để khai thác origin 'null'. (Bản dev load loopback http → nhánh dưới.)
  // LƯU Ý (SEC-FIX 12/8): nhánh 'null'→true DÙNG cho ĐỌC/CORS-reflection (an toàn: đọc phản hồi không đổi
  // trạng thái). ĐƯỜNG GHI (state-changing) KHÔNG dùng hàm này trực tiếp cho 'null' — xem isAllowedWriteOrigin.
  if (origin === 'null') return true;
  if (CORS_ALLOWED_ORIGINS.includes(origin)) return true;
  return LOOPBACK_HTTP_ORIGIN.test(origin);
}

// SEC-FIX 12/8 (bug TB — Origin:null bypass chống-CSRF-ghi). CORS "simple content types" (Fetch spec): 3 loại
// content-type DUY NHẤT mà một <form>/sandboxed-iframe cross-site phát được KHÔNG kích hoạt preflight. Một
// request GHI mang content-type "simple" + Origin lạ/opaque = vector CSRF-ghi (không bị preflight chặn).
const SIMPLE_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];

/**
 * True nếu content-type thuộc nhóm "simple" (KHÔNG buộc preflight) HOẶC rỗng/thiếu (mặc định coi như simple).
 * Một request buộc-preflight (vd application/json) KHÔNG thể bị giả mạo cross-site nếu server chỉ preflight-pass
 * cho origin hợp lệ — nên an toàn hơn nhóm simple.
 */
export function isSimpleRequestContentType(contentType: string | undefined): boolean {
  if (!contentType) return true;
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return SIMPLE_CONTENT_TYPES.includes(mediaType);
}

/**
 * Quyết định CHO PHÉP GHI (POST/PUT/PATCH/DELETE) theo Origin. Tách khỏi isAllowedOrigin để KHÔNG cho Origin
 * 'null' (opaque) đi qua đường GHI một cách vô điều kiện:
 *   - Origin 'null' HỢP LỆ duy nhất = bản desktop đóng gói (renderer file://) — httpCall LUÔN gửi
 *     `Content-Type: application/json` (buộc preflight) → KHÔNG phải content-type simple → CHO PHÉP (không phá app).
 *   - Origin 'null' + content-type SIMPLE = chỉ có thể đến từ <form>/sandboxed-iframe cross-site (CSRF-ghi
 *     không-preflight) → CHẶN.
 *   - Origin có giá trị khác → theo isAllowedOrigin (allowlist domain thật + loopback http).
 * LƯU Ý cho LEAD: vector CÒN LẠI = sandboxed-iframe chạy script gửi fetch application/json (Origin 'null',
 * preflight-pass vì CORS vẫn reflect 'null') KHÔNG đóng được TRONG CỤM NÀY nếu không đổi client — vì desktop
 * cũng dùng đúng null+json. Đóng triệt để cần custom-header đồng bộ preload+server (ngoài phạm vi, đề xuất riêng).
 */
export function isAllowedWriteOrigin(origin: string, contentType: string | undefined): boolean {
  if (origin === 'null') return !isSimpleRequestContentType(contentType);
  return isAllowedOrigin(origin);
}
