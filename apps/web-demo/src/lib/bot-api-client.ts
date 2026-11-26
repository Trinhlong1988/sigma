// Client gọi bot-api thật (apps/bot-api, port 8788 dev) — 2 endpoint đăng ký OTP (xem
// apps/bot-api/src/routes/auth.ts, KHÔNG bịa field/endpoint ngoài file đó). Base URL đọc từ biến môi trường
// Vite VITE_BOT_API_URL (xem .env.example cùng thư mục web-demo), mặc định localhost:8788 nếu chưa set.
//
// Convention discriminated union — TÁI DÙNG Ý TƯỞNG của ApiCallResult trong apps/bot-api/src/rc-client.ts
// (KHÔNG import chéo được, đây là 2 package/repo tách biệt): mọi hàm ở đây KHÔNG BAO GIỜ throw, luôn trả
// {ok:true, data} hoặc {ok:false, error, message} để UI tự quyết định hiển thị gì mà không cần try/catch.
import { PARSE_ERROR_VI, networkErrorMessage } from './error-i18n';
import { proxyFetch } from './proxy-fetch';

export type BotApiResult<T> = { ok: true; data: T } | { ok: false; error: string; message: string };

function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

/** Gói fetch chung tới bot-api: bắt lỗi mạng (NETWORK) + lỗi parse JSON (PARSE) + map non-2xx sang body lỗi
 * thật của bot-api. `credentials:'include'` (26/7) — verify-otp/device-bypass giờ set cookie httpOnly
 * `sigma_ws` thay vì trả token trong body (kiến trúc mới, xem session.ts) — cần flag này để trình duyệt
 * LƯU cookie cross-origin đó (mặc định fetch KHÔNG lưu nếu thiếu). */
async function botApiFetch<T>(path: string, body: unknown): Promise<BotApiResult<T>> {
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI };
  }

  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: json as T };
}

/** POST /v1/auth/register/request-otp — {email} → gửi mã OTP qua Gmail thật. */
export async function requestOtp(email: string): Promise<BotApiResult<{ ok: true }>> {
  return botApiFetch<{ ok: true }>('/v1/auth/register/request-otp', { email });
}

export interface VerifyOtpInput {
  email: string;
  code: string;
  username: string;
  password: string;
  name: string;
  // Hồ sơ mở rộng (24/7) — optional, khớp routes/auth.ts.
  gender?: string;
  dateOfBirth?: string;
  phone?: string;
}

export interface VerifyOtpAgent {
  id: string;
  code: string;
  name: string;
  rcUserId: string;
  rcUsername: string;
}

/** 25/7 — sửa "2 lần OTP khi đăng ký": bot-api giờ cấp thẳng session ở bước này (rcCreateLoginTokenForUser,
 * KHÔNG qua đăng nhập-bằng-mật-khẩu nên KHÔNG bị RC bắt 2FA-qua-email lần 2).
 * SIGMA (26/7) — kiến trúc mới: KHÔNG còn field `session:{userId,authToken}` trong response — bot-api tự
 * set cookie httpOnly `sigma_ws` (nhờ `credentials:'include'` ở botApiFetch), client chỉ nhận
 * `sessionReady:boolean` để biết có set cookie thành công không. `sessionReady:false` = trường hợp hiếm cấu
 * hình secret sai phía server (đã log lỗi ở bot-api, KHÔNG nuốt câm) — OtpScreen.tsx tự fallback gọi
 * rcLogin() như luồng cũ khi gặp giá trị này, KHÔNG throw/crash. */

/** POST /v1/auth/register/verify-otp — xác thực OTP + tạo user Rocket.Chat thật + link Agent + session sẵn
 * dùng (qua cookie) + vé nhớ máy (25/7, Phase 3 — máy vừa đăng ký được coi là thiết bị tin cậy luôn, lần
 * ĐĂNG NHẬP kế tiếp trên máy này khỏi OTP). `deviceToken:null` cùng lý do hiếm như `sessionReady:false` —
 * không chặn đăng ký. */
export async function verifyOtp(
  input: VerifyOtpInput
): Promise<BotApiResult<{ ok: true; agent: VerifyOtpAgent; sessionReady: boolean; deviceToken: string | null }>> {
  return botApiFetch<{ ok: true; agent: VerifyOtpAgent; sessionReady: boolean; deviceToken: string | null }>('/v1/auth/register/verify-otp', input);
}

// ── Quên mật khẩu (24/7) ─────────────────────────────────────────────────────────────────────────────────

/** POST /v1/auth/forgot-password/request-otp — {email} → gửi mã OTP THẬT nếu email có tài khoản (LUÔN trả
 * {ok:true} kể cả không có, chống dò email — xem routes/auth.ts). */
export async function requestForgotPasswordOtp(email: string): Promise<BotApiResult<{ ok: true }>> {
  return botApiFetch<{ ok: true }>('/v1/auth/forgot-password/request-otp', { email });
}

/** POST /v1/auth/forgot-password/reset — {email, code, newPassword} → verify OTP thật + đổi mật khẩu RC thật. */
export async function resetForgotPassword(input: { email: string; code: string; newPassword: string }): Promise<BotApiResult<{ ok: true }>> {
  return botApiFetch<{ ok: true }>('/v1/auth/forgot-password/reset', input);
}

// ── Phase 3 (25/7) — thiết bị tin cậy ("thiết bị mới → OTP; thiết bị cũ đã đăng nhập rồi → chỉ cần mật khẩu") ──

/** POST /v1/auth/login/device-bypass — {email, password, deviceToken}. THÀNH CÔNG (200 + cookie set) = bỏ qua
 * hẳn bước OTP RC cho thiết bị này (vẫn CẦN đúng mật khẩu — xem routes/auth.ts). 401 là kết quả HỢP LỆ (vé
 * hết hạn/sai/chưa từng có) — LoginScreen.tsx tự fallback về luồng rcLogin() thường khi gặp lỗi này, KHÔNG
 * hiện lỗi cho người dùng thấy (họ không biết/không cần biết khái niệm "vé nhớ máy" này).
 * SIGMA (26/7) — KHÔNG còn field `session:{userId,authToken}` trong response (kiến trúc mới, cookie tự
 * set qua `credentials:'include'` ở botApiFetch) — thành công chỉ cần biết `ok:true`.
 */
export async function loginWithDeviceBypass(email: string, password: string, deviceToken: string): Promise<BotApiResult<{ ok: true }>> {
  return botApiFetch<{ ok: true }>('/v1/auth/login/device-bypass', { email, password, deviceToken });
}

// ── SIGMA Phase 1 "bỏ Rocket.Chat" (28/7) — đăng nhập Google OAuth thật ─────────────────────────────────
/** POST /v1/auth/web-login/google — {idToken} (ID token thật từ Google Identity Services, xem google-signin.ts).
 * Thành công → set cookie `sigma_ws` (cùng cơ chế web-login/device-bypass). `isNewAccount` để UI có thể
 * hiện thông báo khác nhau (tài khoản mới vs đăng nhập lại) nếu muốn, KHÔNG bắt buộc dùng. */
export async function loginWithGoogle(idToken: string): Promise<BotApiResult<{ ok: true; isNewAccount?: boolean }>> {
  return botApiFetch<{ ok: true; isNewAccount?: boolean }>('/v1/auth/web-login/google', { idToken });
}

// ── SIGMA (26/7) — GET /v1/auth/me (route ĐÃ CÓ SẴN từ trước, KHÔNG phải endpoint mới) ─────────────────
//
// QUYẾT ĐỊNH KỸ THUẬT TỰ CHỌN (LEAD review lại — tài liệu nhiệm vụ KHÔNG nói rõ): `POST /v1/auth/web-login` +
// `/web-login/totp` + `POST /v1/auth/login/device-bypass` giờ chỉ trả `{ok:true}` (KHÔNG còn userId/authToken
// trong body, đúng kiến trúc mới) — nhưng `saveSession({userId, agentName})` (session.ts) vẫn cần 2 giá trị
// đó để UI hiển thị/so khớp "tin nhắn của mình" (rc-realtime.ts mapRcMessage)/vai trò (GroupInfoPanel.tsx).
// Dùng LẠI route `GET /v1/auth/me` (ĐÃ CÓ SẴN từ Phase 1, requireRcAuth — giờ CŨNG chấp nhận cookie
// `sigma_ws` nhờ fallback mới ở rc-auth-middleware.ts) NGAY SAU khi đăng nhập thành công để lấy
// `agent.rcUserId`/`agent.name` — KHÔNG bịa endpoint mới, tái dùng đúng route đã verify thật từ trước.
export interface AuthenticatedAgentDto {
  id: number;
  code: string | null;
  name: string;
  rcUserId: string;
  rcUsername: string | null;
}

// P1 (6/8, tối ưu tốc độ mở khung chat) — SWR cache cho danh tính chính mình (`GET /v1/auth/me`). Danh tính
// (agentId số + tên) ỔN ĐỊNH suốt phiên đăng nhập nên KHÔNG cần gọi lại mỗi lần mở phòng. TRƯỚC ĐÂY
// ConversationScreen.tsx gọi `fetchAuthenticatedAgent()` MỖI LẦN mount (đổi phòng) VÀ CHẶN tải tin nhắn tới khi
// nó xong (`identityReady`) → thêm 1 hop ~150ms nối tiếp vào thời gian mở mỗi phòng (đo thật research). Cache
// write-through ở đây + getter đồng bộ `getCachedAgentId()` cho phép ConversationScreen seed myAgentId NGAY
// (0 hop) khi cache ấm → tải tin bắt đầu tức thì lúc mount, không chờ /auth/me.
//
// AN TOÀN ĐA-TÀI-KHOẢN: cache PHẢI bị xóa lúc đăng xuất (performLogout → clearAuthenticatedAgentCache) để phiên
// kế tiếp trên cùng tab KHÔNG dùng nhầm agentId người trước (cùng lớp lo ngại clearSession/clearMessagesCache).
// PERF (15/8, Admin Demo "mở Cài đặt profile tên/user/avatar load chậm giật mới hiện") — persist danh tính sang
// sessionStorage để getCachedAuthenticatedAgent()/getCachedAgentId() ĐỌC ĐỒNG BỘ được NGAY cả sau reload/resume
// WebView (không chỉ trong 1 vòng đời module) → Settings/Conversation seed tên+username+agentId tức thời, avatar
// (AgentAvatar persist-cache) hiện luôn. Vẫn write-through + luôn revalidate; xóa lúc đăng xuất (đa-tài-khoản).
const AUTH_ME_KEY = 'sigma_auth_me_v1';
function hydrateCachedAgent(): AuthenticatedAgentDto | null {
  try { const raw = sessionStorage.getItem(AUTH_ME_KEY); return raw ? (JSON.parse(raw) as AuthenticatedAgentDto) : null; } catch { return null; }
}
let cachedAgent: AuthenticatedAgentDto | null = hydrateCachedAgent();
// Dedupe request đang bay (AppShell prime + ConversationScreen cold cùng gọi lúc mở app/F5 → chỉ 1 /auth/me).
let authInFlight: Promise<BotApiResult<{ agent: AuthenticatedAgentDto }>> | null = null;

/** agentId (số) của chính mình nếu ĐÃ có trong cache phiên này, ngược lại `null` (chưa gọi /auth/me lần nào).
 * ĐỒNG BỘ — dùng để seed state myAgentId ngay lúc mount mà KHÔNG cần await (xem ConversationScreen.tsx). */
export function getCachedAgentId(): number | null {
  return cachedAgent?.id ?? null;
}

/** Bản đầy đủ danh tính chính mình đã cache (hoặc null). */
export function getCachedAuthenticatedAgent(): AuthenticatedAgentDto | null {
  return cachedAgent;
}

/** Xóa cache danh tính — BẮT BUỘC gọi lúc đăng xuất (chống dùng nhầm agentId giữa 2 tài khoản trên cùng tab). */
export function clearAuthenticatedAgentCache(): void {
  cachedAgent = null;
  authInFlight = null;
  try { sessionStorage.removeItem(AUTH_ME_KEY); } catch { /* bỏ qua */ }
}

/** GET /v1/auth/me — cần cookie `sigma_ws` hợp lệ (đã đăng nhập). Gọi SAU khi web-login/device-bypass
 * thành công để lấy đủ dữ liệu cho saveSession(). Lỗi ở đây (hiếm — vd tài khoản RC hợp lệ nhưng chưa link
 * Agent nào) KHÔNG nên chặn đăng nhập đã thành công phía RC; caller tự quyết định fallback hợp lý.
 * P1 (6/8) — write-through cache `cachedAgent` khi thành công + dedupe request đang bay. LƯU Ý: KHÔNG trả cache
 * cũ thay cho network (mỗi lần gọi vẫn xác nhận lại với server) — chỉ GHI cache để `getCachedAgentId()` đọc
 * đồng bộ; nơi muốn né hẳn hop thì đọc `getCachedAgentId()` trước, chỉ gọi hàm này khi cache nguội. */
export async function fetchAuthenticatedAgent(): Promise<BotApiResult<{ agent: AuthenticatedAgentDto }>> {
  if (authInFlight) return authInFlight;
  authInFlight = (async () => {
    let res: Response;
    try {
      res = await proxyFetch(`${botApiBaseUrl()}/v1/auth/me`);
    } catch {
      return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI };
    }
    if (!res.ok) {
      const b = json as { error?: string; message?: string } | null;
      return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
    }
    const data = json as { agent: AuthenticatedAgentDto };
    cachedAgent = data.agent;
    try { sessionStorage.setItem(AUTH_ME_KEY, JSON.stringify(data.agent)); } catch { /* quota/priv — vẫn còn memory */ }
    return { ok: true, data };
  })();
  try {
    return await authInFlight;
  } finally {
    authInFlight = null;
  }
}

/** GET /v1/auth/resolve-phone?phone= — tra email ứng với SĐT (đăng nhập bằng SĐT nếu có, RC không hỗ trợ
 * đăng nhập bằng SĐT trực tiếp nên phải tự tra ra email trước khi gọi rcLogin). */
export async function resolvePhoneToEmail(phone: string): Promise<BotApiResult<{ email: string }>> {
  const base = import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
  let res: Response;
  try {
    res = await fetch(`${base}/v1/auth/resolve-phone?phone=${encodeURIComponent(phone)}`);
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI };
  }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: json as { email: string } };
}
