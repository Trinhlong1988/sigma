// SIGMA (3/8) — Client cho đăng nhập bằng quét QR động (kiểu Zalo/WhatsApp Web). Gọi bot-api
// (apps/bot-api/src/routes/qr-login.ts). Dùng proxyFetch (credentials:'include' + header CSRF) để trình duyệt
// gửi/nhận cookie cross-subdomain:
//   - Máy TẠO QR (PC/web): cookie httpOnly `sigma_qr` (pollSecret) do /create cấp, /status tự gửi lại.
//   - Điện thoại (đã đăng nhập): cookie phiên chính `sigma_ws` cho /info và /approve (cần requireSession).
// KHÔNG bịa field/endpoint ngoài routes/qr-login.ts. discriminated-union giống bot-api-client.ts (không throw).
import { PARSE_ERROR_VI, networkErrorMessage } from './error-i18n';
import { proxyFetch } from './proxy-fetch';

export type QrApiResult<T> = { ok: true; data: T } | { ok: false; error: string; message: string };

/** Định dạng payload QR — điện thoại CHỈ chấp nhận đúng dạng này (chống QR độc). v1 = version, cho phép nâng cấp. */
export const QR_LOGIN_PREFIX = 'sigma-login:v1:';

/** Bọc token thô thành payload để web-demo encode vào ảnh QR. */
export function encodeQrPayload(token: string): string {
  return `${QR_LOGIN_PREFIX}${token}`;
}

/** Trích token từ payload QR đã quét — trả null nếu KHÔNG đúng định dạng (từ chối mọi QR khác, chống QR độc). */
export function parseQrPayload(raw: string): string | null {
  if (typeof raw !== 'string' || !raw.startsWith(QR_LOGIN_PREFIX)) return null;
  const token = raw.slice(QR_LOGIN_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

async function readJson<T>(res: Response): Promise<QrApiResult<T>> {
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

export interface QrCreateResult {
  token: string;
  matchCode: string;
  expiresIn: number;
  rotateIn: number;
}

/** POST /v1/auth/qr/create — máy tạo QR: tạo challenge + nhận token/matchCode; server set cookie pollSecret. */
export async function qrCreate(fresh = false): Promise<QrApiResult<QrCreateResult>> {
  let res: Response;
  try {
    // fresh=true (user bấm "làm mới" khi hết hạn) → server bỏ pollSecret cũ, cấp mã MỚI (Admin Demo 6/8).
    res = await proxyFetch(`${botApiBaseUrl()}/v1/auth/qr/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fresh }) });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  return readJson<QrCreateResult>(res);
}

export type QrStatus = 'pending' | 'approved' | 'expired';

/** GET /v1/auth/qr/status — máy tạo QR poll (cookie pollSecret tự gửi). 'approved' = server ĐÃ set cookie phiên. */
export async function qrStatus(): Promise<QrApiResult<{ status: QrStatus }>> {
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/auth/qr/status`, { method: 'GET' });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  return readJson<{ status: QrStatus }>(res);
}

export interface QrRequesterInfo {
  requesterIp: string | null;
  requesterUa: string | null;
  approxLocation: string;
  createdAt: string;
  expiresAt: string;
}

/** GET /v1/auth/qr/info?token= — điện thoại đã auth: thông tin bên-yêu-cầu cho màn xác nhận (KHÔNG có matchCode). */
export async function qrInfo(token: string): Promise<QrApiResult<QrRequesterInfo>> {
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/auth/qr/info?token=${encodeURIComponent(token)}`, { method: 'GET' });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  return readJson<QrRequesterInfo>(res);
}

/** POST /v1/auth/qr/approve — điện thoại đã auth: {token, code}. Server lấy agentId TỪ phiên (không tin input). */
export async function qrApprove(token: string, code: string): Promise<QrApiResult<{ ok: true }>> {
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/auth/qr/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, code })
    });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  return readJson<{ ok: true }>(res);
}
