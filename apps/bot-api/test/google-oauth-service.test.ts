// Mock google-auth-library — KHÔNG gọi Google thật trong test tự động. Shape payload (sub/email/email_verified/
// name) khớp ĐÚNG `TokenPayload` thật (xác nhận qua đọc google-auth-library/build/src/auth/loginticket.d.ts
// trước khi viết mock — không bịa field).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock() bị hoist lên đầu file BỞI vitest — biến tham chiếu trong factory PHẢI khai qua vi.hoisted() để
// tránh lỗi TDZ (factory chạy trước khi `const` thường được khởi tạo).
const { verifyIdTokenMock } = vi.hoisted(() => ({ verifyIdTokenMock: vi.fn() }));
vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken(...args: unknown[]) {
      return verifyIdTokenMock(...args);
    }
  }
}));

import { verifyGoogleIdToken } from '../src/google-oauth-service.js';

describe('google-oauth-service', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    verifyIdTokenMock.mockReset();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('thiếu GOOGLE_CLIENT_ID → CONFIG_MISSING, KHÔNG gọi verifyIdToken', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const result = await verifyGoogleIdToken('bat-ky-token-nao');
    expect(result).toEqual({ ok: false, kind: 'CONFIG_MISSING', message: expect.any(String) });
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it('token hợp lệ, email_verified:true → ok:true, data đúng field (googleId=sub)', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-12345',
        email: 'Test.User@Example.com',
        email_verified: true,
        name: 'Test User',
        aud: 'test-client-id.apps.googleusercontent.com',
        iss: 'https://accounts.google.com',
        iat: 1000,
        exp: 2000
      })
    });

    const result = await verifyGoogleIdToken('token-hop-le');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.googleId).toBe('google-sub-12345');
      expect(result.data.email).toBe('test.user@example.com'); // lowercase hóa
      expect(result.data.emailVerified).toBe(true);
      expect(result.data.name).toBe('Test User');
    }
    expect(verifyIdTokenMock).toHaveBeenCalledWith({ idToken: 'token-hop-le', audience: 'test-client-id.apps.googleusercontent.com' });
  });

  it('email_verified:false → vẫn trả ok:true (caller route tự quyết định chặn), emailVerified=false đúng', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ sub: 'google-sub-999', email: 'chuaverify@example.com', email_verified: false, name: 'Chua Verify' })
    });

    const result = await verifyGoogleIdToken('token-chua-verify');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.emailVerified).toBe(false);
  });

  it('verifyIdToken throw (chữ ký sai/hết hạn/audience sai) → INVALID_TOKEN, không crash', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    verifyIdTokenMock.mockRejectedValue(new Error('Token used too late'));

    const result = await verifyGoogleIdToken('token-het-han');
    expect(result).toEqual({ ok: false, kind: 'INVALID_TOKEN', message: expect.stringContaining('Token used too late') });
  });

  it('payload thiếu email → INVALID_TOKEN, KHÔNG crash truy cập undefined.toLowerCase()', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    verifyIdTokenMock.mockResolvedValue({ getPayload: () => ({ sub: 'google-sub-no-email', email_verified: true, name: 'No Email' }) });

    const result = await verifyGoogleIdToken('token-thieu-email');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('INVALID_TOKEN');
  });

  it('getPayload() trả null/undefined → INVALID_TOKEN, không crash', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    verifyIdTokenMock.mockResolvedValue({ getPayload: () => undefined });

    const result = await verifyGoogleIdToken('token-payload-rong');
    expect(result).toEqual({ ok: false, kind: 'INVALID_TOKEN', message: expect.any(String) });
  });
});
