// SIGMA Mobile Giai đoạn 1 (26/7) — CÂU HỎI KIẾN TRÚC CỐT LÕI của đợt này, ĐÃ TỰ KIỂM CHỨNG THẬT (không
// suy đoán, xem báo cáo cuối): giả thuyết ban đầu (tài liệu cộng đồng RN các bản cũ) là `fetch()` Android
// KHÔNG tự lưu/gửi lại `Set-Cookie`/`Cookie` do OkHttp không có CookieJar mặc định. ĐÃ TỰ TEST ĐỐI CHỨNG THẬT
// 2 LẦN (kể cả uninstall+cài sạch lại để loại trừ cache) bằng cách tắt hẳn cờ `MANUAL_COOKIE_STORE_ENABLED`
// bên dưới (không đọc/không gắn Cookie header thủ công) rồi chạy lại round-trip đăng ký thật → KẾT QUẢ NGƯỢC
// GIẢ THUYẾT: app vẫn đăng nhập được, `GET /v1/rc/subscriptions.get` (đòi cookie thật) vẫn trả dữ liệu thật
// (kênh "general") — chứng tỏ RN 0.86 fetch trên Android 14 (emulator API 34, RN 0.86.0) THỰC SỰ tự quản lý
// cookie theo domain, ÍT NHẤT trên tổ hợp phiên bản này. Giữ NGUYÊN lớp thủ công này làm cờ dự phòng (KHÔNG
// gỡ bỏ) vì: (1) hành vi tự động này KHÔNG có trong tài liệu chính thức React Native, có thể là hành vi ngầm
// định của phiên bản OkHttp/React Native cụ thể, KHÔNG đảm bảo giữ nguyên qua các bản RN/Android khác hoặc
// thiết bị thật khác emulator; (2) tường minh luôn an toàn hơn phụ thuộc ngầm định nền tảng không tài liệu
// hoá. Layer này vô hại khi cookie đã tự có sẵn (đọc/ghi giá trị giống hệt nhau, không xung đột).
//
// QUYẾT ĐỊNH KỸ THUẬT (đổi hướng so với dự tính ban đầu — LEAD nên biết): thử phương án (a) trong nhiệm vụ
// (`@react-native-cookies/cookies`) TRƯỚC — BUILD THẬT THẤT BẠI: package.android build.gradle của thư viện
// này gọi `jcenter()` (repo đã đóng cửa từ lâu, Gradle 9.x/AGP hiện tại KHÔNG còn hỗ trợ DSL method này nữa)
// → `Could not find method jcenter()`. Đúng như cảnh báo `npm warn deprecated` lúc cài — thư viện này KHÔNG
// còn tương thích toolchain hiện tại (Gradle 9.3.1 do RN 0.86 template kéo về). KHÔNG cần cài lib thay thế
// (`@preeternal/react-native-cookie-manager`/`react-native-nitro-cookies`) vì bot-api CHỈ set ĐÚNG 1 cookie
// (`sigma_ws`, xem web-session-service.ts) — không cần 1 cookie jar tổng quát quản lý nhiều domain/nhiều
// cookie như trình duyệt. Giải pháp ĐƠN GIẢN HƠN, THUẦN JS, KHÔNG cần module native TỰ VIẾT nào: tự đọc header
// `set-cookie` từ response (RN fetch CÓ expose header này qua `Response.headers.get()` — verify thật bằng
// log kết quả round-trip login thật, xem báo cáo), tách lấy giá trị, tự gắn `Cookie: sigma_ws=<value>`
// cho mọi request cần cookie sau đó.
//
// B33 audit độc lập (finding MEDIUM, xem BUGS_FIXED.md) — TRƯỚC ĐÂY lưu giá trị cookie (bearer-token DUY NHẤT
// cho toàn quyền REST tài khoản RC, xem B29 — mất giá trị này = mất quyền truy cập) qua `AsyncStorage`
// (SharedPreferences Android KHÔNG mã hoá mặc định) — khác chuẩn app native "tốt" (dùng Keychain/Keystore cho
// token phiên). Audit đánh giá MEDIUM cho Giai đoạn 1 nội bộ nhưng PHẢI sửa trước khi ship/phát hành cho đại
// lý thật. Đổi sang `react-native-keychain` (Android Keystore-backed EncryptedSharedPreferences, iOS Keychain
// — mã hoá phần cứng khi thiết bị hỗ trợ) — đã tự verify build THẬT không lặp lại lỗi jcenter() của thư viện
// cookie cũ (`assembleDebug` BUILD SUCCESSFUL sau khi thêm dependency). `session.ts` (userId/tên hiển thị,
// KHÔNG phải bí mật) VẪN giữ AsyncStorage — chỉ đổi riêng giá trị cookie phiên.
import * as Keychain from 'react-native-keychain';
import { WEB_SESSION_COOKIE_NAME } from './config';

/** `service` định danh mục Keychain riêng cho cookie phiên — tách khỏi mọi mục Keychain khác app có thể dùng
 * sau này (tránh xung đột nếu Giai đoạn sau cần lưu thêm bí mật khác). Keychain lưu theo cặp
 * username+password — dùng `username` cố định làm placeholder (không mang ý nghĩa thật), giá trị cookie thật
 * nằm ở `password`. */
const KEYCHAIN_SERVICE = 'com.sigma.app.session_cookie';
const KEYCHAIN_USERNAME_PLACEHOLDER = 'sigma_ws';

/** Cờ bật/tắt lớp quản lý cookie thủ công — mặc định `true` (ship với giá trị này). ĐÃ TỰ KIỂM CHỨNG THẬT 2
 * lần (kể cả uninstall+cài sạch) rằng RN 0.86 fetch trên Android emulator API 34 THỰC SỰ tự lưu/gửi cookie
 * ngay cả khi tắt cờ này — xem giải thích đầy đủ ở đầu file + báo cáo cuối. Giữ `true` làm lớp an toàn tường
 * minh KHÔNG phụ thuộc hành vi ngầm định nền tảng chưa được tài liệu hoá chính thức. */
export const MANUAL_COOKIE_STORE_ENABLED = true;

/** Tách giá trị `<cookieName>=<value>` khỏi 1 header `set-cookie` thô (bỏ qua các attribute
 * `; HttpOnly; Secure; SameSite=None; Path=/...` phía sau) — PURE FUNCTION, tách riêng để unit-test không
 * cần mock AsyncStorage/native module (xem __tests__/cookie-jar.test.ts).
 *
 * Audit độc lập 26/7 (finding MEDIUM, xem BUGS_FIXED.md): regex TRƯỚC ĐÂY không neo đầu tên cookie — khớp
 * theo SUBSTRING bất kỳ vị trí nào, nên input kiểu `xsigma_ws=SAI; sigma_ws=dung` sẽ khớp NHẦM giá
 * trị "SAI" (là substring hợp lệ bắt đầu từ ký tự thứ 2 của "xsigma_ws"). SỬA: neo bằng
 * `(?:^|;\s*)` — tên cookie chỉ được khớp khi đứng ở ĐẦU chuỗi hoặc ngay sau dấu `;` (ranh giới cookie thật
 * theo RFC 6265), không khớp giữa 1 tên cookie khác. */
export function extractCookieValue(rawSetCookieHeader: string, cookieName: string): string | null {
  const match = rawSetCookieHeader.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
  return match ? match[1] : null;
}

let memoryCache: string | null | undefined; // undefined = chưa đọc Keychain lần nào trong phiên chạy app này.

async function readFromDisk(): Promise<string | null> {
  if (memoryCache !== undefined) return memoryCache;
  const result = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
  memoryCache = result ? result.password : null;
  return memoryCache;
}

/** Trả header `Cookie: sigma_ws=<value>` đầy đủ (hoặc null nếu chưa đăng nhập/chưa có cookie lưu). */
export async function getSessionCookieHeader(): Promise<string | null> {
  if (!MANUAL_COOKIE_STORE_ENABLED) return null;
  const value = await readFromDisk();
  if (!value) return null;
  return `${WEB_SESSION_COOKIE_NAME}=${value}`;
}

/** Đọc header `set-cookie` thô từ response (nếu có) → tách giá trị `sigma_ws=...` → lưu lại (Keychain —
 * mã hoá qua Android Keystore/iOS Keychain, xem giải thích quyết định kỹ thuật đầu file). Bỏ qua êm nếu
 * response không set cookie mới (đa số request không set) HOẶC nếu tắt cờ (test đối chứng). */
export async function persistSetCookieHeader(res: Response): Promise<void> {
  if (!MANUAL_COOKIE_STORE_ENABLED) return;
  const raw = res.headers.get('set-cookie') ?? res.headers.get('Set-Cookie');
  if (!raw) return;
  const value = extractCookieValue(raw, WEB_SESSION_COOKIE_NAME);
  if (!value) return;
  memoryCache = value;
  await Keychain.setGenericPassword(KEYCHAIN_USERNAME_PLACEHOLDER, value, { service: KEYCHAIN_SERVICE });
}

/** Xoá cookie phiên cục bộ — dùng khi đăng xuất hoặc khi phát hiện phiên hết hạn (401 WEB_SESSION_INVALID). */
export async function clearSessionCookie(): Promise<void> {
  memoryCache = null;
  await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
}
