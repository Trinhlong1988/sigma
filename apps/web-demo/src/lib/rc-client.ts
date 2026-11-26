// SIGMA (26/7) — kiến trúc mới "bot-api làm trung gian TOÀN BỘ giao tiếp Rocket.Chat" (giải nợ B9/B11, xem
// BUGS_FIXED.md). TRƯỚC ĐÂY file này gọi THẲNG Rocket.Chat (`fetch(RC_BASE_URL + '/api/v1/login', ...)`) từ
// trình duyệt vì `credentials:'include'` KHÔNG dùng được (RC luôn trả `Access-Control-Allow-Origin:'*'` cho
// response thật của route login — spec CORS cấm `*` đi kèm credentials, xem B9 gốc trong BUGS_FIXED.md). GIỜ
// KHÔNG còn giới hạn đó nữa: `rcLogin()`/`rcLogout()` gọi bot-api (CÙNG origin/allowlist CORS đã cấu hình
// `credentials:true` + origin cụ thể ở app.ts, KHÔNG phải `*`) — bot-api tự gọi RC server-side (rc-client.ts
// phía bot-api), rồi set cookie httpOnly `sigma_ws` cho trình duyệt. Token RC thật (`authToken`) KHÔNG
// BAO GIỜ trả về đây nữa — `RcLoginResult.ok:true` KHÔNG còn field userId/authToken (xem session.ts: session
// cục bộ giờ chỉ giữ userId/agentName để hiển thị, KHÔNG dùng để authenticate).
//
// FIELD `code` cho 2FA-qua-email — CÙNG hành vi RC đã verify thật 24/7 (xem comment cũ, vẫn ĐÚNG vì bot-api
// forward y hệt xuống RC, xem apps/bot-api/src/rc-client.ts rcLogin() + apps/bot-api/src/routes/auth.ts
// /v1/auth/web-login/totp): route login RC đọc `code` trực tiếp từ JSON body.
import { PARSE_ERROR_VI, networkErrorMessage } from './error-i18n';
import { currentPlatform, PLATFORM_HEADER } from './platform';

function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

export interface RcLoginInput {
  /** email HOẶC username — RC field `user`/bot-api field `identifier` đều linh hoạt (xem comment cũ đã verify
   * thật, giữ nguyên tên `username` ở đây để KHÔNG phải sửa mọi call site LoginScreen.tsx/OtpScreen.tsx). */
  username: string;
  password: string;
  /** Mã 2FA-qua-email 6 số — CHỈ gửi kèm khi retry sau khi lần gọi trước trả về kind:'TOTP_REQUIRED'. */
  code?: string;
}

export type RcLoginResult =
  | { ok: true }
  | { ok: false; kind: 'TOTP_REQUIRED' }
  | { ok: false; kind: 'ERROR'; message: string };

interface WebLoginResponseBody {
  ok?: boolean;
  kind?: string;
  message?: string;
}

// 24/7 (Admin Demo: "yêu cầu không có chỗ nào tiếng Anh") — bot-api (routes/auth.ts) ĐÃ tự dịch mọi message lỗi
// đăng nhập sang tiếng Việt trước khi trả về (CÙNG bảng dịch/quyết định đã verify thật trước đây, giờ sống ở
// server thay vì client) — bảng RC_ERROR_VI này GIỮ LẠI vì rc-realtime.ts (chat lõi — xóa/thu hồi tin nhắn...)
// vẫn cần dịch message lỗi RC trả qua rc-proxy (bot-api pass-through NGUYÊN VĂN JSON của RC cho các endpoint
// đó, xem routes/rc-proxy.ts — KHÔNG tự dịch như route login/logout chuyên biệt).
export const RC_ERROR_VI: Record<string, string> = {
  Unauthorized: 'Sai email/số điện thoại hoặc mật khẩu.',
  'User not found': 'Không tìm thấy tài khoản.',
  'Invalid password': 'Sai mật khẩu.',
  'Invalid Email 2FA code': 'Mã xác thực không đúng, vui lòng nhập lại.',
  'Too many attempts': 'Đã thử quá nhiều lần, vui lòng thử lại sau.'
};

/** Dịch message lỗi RC sang tiếng Việt — khớp CHÍNH XÁC (RC message thường là hằng số cố định, không phải
 * câu tự do) thì dùng bảng dịch; KHÔNG khớp thì trả `fallback` (câu tiếng Việt do caller tự chọn theo ngữ
 * cảnh cụ thể, vd "Không gửi được tin nhắn."), TUYỆT ĐỐI không trả nguyên văn tiếng Anh ra ngoài (đúng yêu
 * cầu "không có chỗ nào tiếng Anh"). `raw` rỗng → trả thẳng fallback (không có gì để tra bảng). */
export function translateRcErrorMessage(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  return RC_ERROR_VI[raw] ?? fallback;
}

/** POST bot-api /v1/auth/web-login (hoặc /v1/auth/web-login/totp nếu có `code`) — đăng nhập qua bot-api thay
 * vì gọi thẳng Rocket.Chat (xem comment đầu file). KHÔNG throw — luôn trả 1 trong 3 outcome ở RcLoginResult.
 * `credentials:'include'` BẮT BUỘC — để trình duyệt LƯU cookie `Set-Cookie: sigma_ws=...httpOnly` bot-api
 * trả về khi đăng nhập thành công (fetch mặc định KHÔNG lưu cookie cross-origin nếu thiếu flag này). */
export async function rcLogin(input: RcLoginInput): Promise<RcLoginResult> {
  const body: Record<string, string> = { identifier: input.username, password: input.password };
  if (input.code) body.code = input.code;
  const path = input.code ? '/v1/auth/web-login/totp' : '/v1/auth/web-login';

  let res: Response;
  try {
    res = await fetch(`${botApiBaseUrl()}${path}`, {
      method: 'POST',
      credentials: 'include',
      // #3 (6/8) — gửi NỀN để server đá phiên cũ CÙNG NỀN (rcLogin dùng fetch thô, KHÔNG qua proxyFetch nên
      // phải tự gắn header ở đây — xem proxy-fetch.ts cho các đường khác).
      headers: { 'Content-Type': 'application/json', [PLATFORM_HEADER]: currentPlatform() },
      body: JSON.stringify(body)
    });
  } catch {
    return { ok: false, kind: 'ERROR', message: networkErrorMessage() };
  }

  let json: WebLoginResponseBody;
  try {
    json = (await res.json()) as WebLoginResponseBody;
  } catch {
    return { ok: false, kind: 'ERROR', message: PARSE_ERROR_VI };
  }

  if (json.ok === true) return { ok: true };
  if (json.kind === 'TOTP_REQUIRED') return { ok: false, kind: 'TOTP_REQUIRED' };
  return { ok: false, kind: 'ERROR', message: typeof json.message === 'string' ? json.message : `bot-api trả lỗi HTTP ${res.status}` };
}

/** POST bot-api /v1/auth/web-logout — revoke WebSession + token RC thật server-side (best-effort phía RC,
 * KHÔNG throw nếu RC tạm down — xem apps/bot-api/src/routes/auth.ts) + clear cookie `sigma_ws`. KHÔNG còn
 * nhận authToken/userId làm tham số (session cục bộ KHÔNG còn giữ 2 giá trị này, xem session.ts) — cookie tự
 * gửi kèm nhờ `credentials:'include'`. Best-effort ở TẦNG CLIENT NÀY (không throw) — caller (logout.ts) LUÔN
 * clearSession() cục bộ dù gọi bot-api thất bại, CÙNG nguyên tắc B11 (BUGS_FIXED.md) trước đây. */
export async function rcLogout(): Promise<void> {
  try {
    // Timeout ngắn 4s (fix kèm bug "đăng xuất KẸT" 11/9, harness-logout.ts ca server-treo): logout phía server
    // là BEST-EFFORT — server treo/không trả lời thì hủy request sau 4s thay vì giữ pending vô hạn (không chặn
    // UI vì caller không await, nhưng không để 1 fetch zombie giữ kết nối/cookie phiên cũ sau khi đã về /login).
    await fetch(`${botApiBaseUrl()}/v1/auth/web-logout`, { method: 'POST', credentials: 'include', signal: AbortSignal.timeout(4000) });
  } catch {
    // best-effort — caller vẫn xóa session cục bộ dù gọi bot-api thất bại (mất mạng, bot-api tạm down, timeout...).
  }
}

// SIGMA Phase 6 dọn RC-dead-code (30/7) — 3 hàm `getRcMyUsername`/`listMySessions`/`logoutMySession` (+
// helper riêng `formatSessionDevice`/`mapDeviceMgmtError`/`RcRawSession`/`ENTERPRISE_ONLY_MESSAGE_VI`/
// `RC_BASE_URL`/`RcSessionInfo`/`RcDeviceResult`) ĐÃ XÓA — file tự khai "dead code, chưa migrate qua proxy" từ
// 26/7, re-verify lại bằng grep tươi trước khi xóa (KHÔNG chỉ tin comment cũ, đúng yêu cầu R9): zero-caller
// thật trong toàn `apps/web-demo`/`apps/mobile`, xem BUGS_FIXED.md mục dọn RC-dead-code.
