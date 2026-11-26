// SIGMA Phase 1 "bỏ Rocket.Chat" (28/7) — verify ID token Google (Google Identity Services JS SDK phía
// client → gửi credential/idToken lên server → server verify chữ ký + audience qua google-auth-library,
// KHÔNG cần Client Secret/redirect URI, phù hợp luồng SPA). Field payload (sub/email/email_verified/name) đã
// xác nhận đúng shape thật qua đọc node_modules/google-auth-library/build/src/auth/loginticket.d.ts.
import { OAuth2Client } from 'google-auth-library';

export interface GoogleVerifiedIdentity {
  googleId: string; // claim "sub" — định danh vĩnh viễn, KHÔNG đổi khi email đổi
  email: string;
  emailVerified: boolean;
  name: string;
}

export type GoogleVerifyResult =
  | { ok: true; data: GoogleVerifiedIdentity }
  | { ok: false; kind: 'CONFIG_MISSING'; message: string }
  | { ok: false; kind: 'INVALID_TOKEN'; message: string };

// Đọc process.env LÚC GỌI (không cache OAuth2Client theo GOOGLE_CLIENT_ID lúc import) — cùng nguyên tắc
// rc-client.ts/email-service.ts, để test đổi env trước khi gọi vẫn ăn đúng giá trị mới.
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleVerifyResult> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return { ok: false, kind: 'CONFIG_MISSING', message: 'Thiếu GOOGLE_CLIENT_ID trong biến môi trường.' };
  }

  const client = new OAuth2Client(clientId);
  let ticket;
  try {
    ticket = await client.verifyIdToken({ idToken, audience: clientId });
  } catch (err) {
    return { ok: false, kind: 'INVALID_TOKEN', message: err instanceof Error ? err.message : String(err) };
  }

  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    return { ok: false, kind: 'INVALID_TOKEN', message: 'ID token Google thiếu thông tin bắt buộc.' };
  }

  return {
    ok: true,
    data: {
      googleId: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true,
      name: payload.name ?? payload.email
    }
  };
}

// ── Native cho vỏ EXE (Electron): luồng Authorization Code phía SERVER (6/8) ──────────────────────────────────
// Vỏ exe chạy origin 127.0.0.1:<cổng ngẫu nhiên> → GIS token-flow bị origin_mismatch. Thay bằng: Electron mở
// cửa sổ Google → redirect về /v1/auth/google/callback (server) → server ĐỔI code lấy id_token bằng
// GOOGLE_CLIENT_SECRET (CHỈ ở server, KHÔNG lộ ra client) → verifyGoogleIdToken như luồng web. redirectUri PHẢI
// khớp URI đã đăng ký trong Google Console (Authorized redirect URIs).
export type GoogleCodeExchangeResult =
  | { ok: true; idToken: string }
  | { ok: false; kind: 'CONFIG_MISSING'; message: string }
  | { ok: false; kind: 'INVALID_CODE'; message: string };

export async function exchangeGoogleAuthCode(code: string, redirectUri: string): Promise<GoogleCodeExchangeResult> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { ok: false, kind: 'CONFIG_MISSING', message: 'Thiếu GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.' };
  }
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  try {
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) {
      return { ok: false, kind: 'INVALID_CODE', message: 'Google không trả id_token.' };
    }
    return { ok: true, idToken: tokens.id_token };
  } catch (err) {
    return { ok: false, kind: 'INVALID_CODE', message: err instanceof Error ? err.message : String(err) };
  }
}
