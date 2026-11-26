// Mock global fetch — KHÔNG gọi Rocket.Chat thật trong suite tự động (xem test/rc-client.live-check.ts cho
// script gọi RC thật chạy tay riêng, ngoài `npm test`).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rcCreateUser, rcDeleteUser, rcGetMe, resetRcAdminAuthCache } from '../src/rc-client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('rc-client', () => {
  const originalFetch = global.fetch;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    resetRcAdminAuthCache();
    process.env.RC_BASE_URL = 'https://rc-test.local';
    // Xóa tường minh biến admin thật (KHÔNG dựa vào savedEnv/môi trường ngoài không có sẵn biến này) — phát
    // hiện 24/7: có `.env` thật cho live-check (RC_ADMIN_USERNAME=...) làm case "thiếu MỌI cấu hình admin"
    // fail giả vì `savedEnv` snapshot lúc module load ĐÃ có sẵn biến thật từ .env, suite không nên phụ thuộc
    // môi trường ngoài có/không .env cục bộ.
    delete process.env.RC_ADMIN_AUTH_TOKEN;
    delete process.env.RC_ADMIN_USER_ID;
    delete process.env.RC_ADMIN_USERNAME;
    delete process.env.RC_ADMIN_PASSWORD;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...savedEnv };
  });

  describe('rcGetMe', () => {
    it('gửi đúng header X-Auth-Token/X-User-Id, 200 → trả user info', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { _id: 'u1', username: 'agent1' }));
      const r = await rcGetMe('tok1', 'u1');
      expect(r.ok).toBe(true);
      const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect((init.headers as Record<string, string>)['X-Auth-Token']).toBe('tok1');
      expect((init.headers as Record<string, string>)['X-User-Id']).toBe('u1');
    });

    it('token hết hạn → ok:false HTTP 401', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'You must be logged in to do this.' }));
      const r = await rcGetMe('badtok', 'u1');
      expect(r.ok).toBe(false);
    });
  });

  describe('rcCreateUser', () => {
    it('có RC_ADMIN_AUTH_TOKEN/RC_ADMIN_USER_ID tĩnh → dùng thẳng, KHÔNG gọi /login trước', async () => {
      process.env.RC_ADMIN_AUTH_TOKEN = 'admin-tok';
      process.env.RC_ADMIN_USER_ID = 'admin-id';
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { user: { _id: 'new1', username: 'newagent' } }));
      const r = await rcCreateUser({ username: 'newagent', email: 'a@example.com', name: 'A', password: 'Secret123' });
      expect(global.fetch).toHaveBeenCalledTimes(1); // chỉ 1 lần gọi users.create, không có lượt /login riêng
      expect(r.ok).toBe(true);
      // Regression 24/7 — bug thật trên production: response RC thật lồng trong `user:{...}`, code cũ trả
      // thẳng chưa unwrap → _id/username rơi mất (undefined), agent.rcUserId/rcUsername lưu null dù RC user
      // đã tạo thật. Assert tường minh giá trị unwrap đúng, không chỉ check `ok:true`.
      if (r.ok) expect(r.data).toEqual({ _id: 'new1', username: 'newagent' });
    });

    it('KHÔNG có admin token tĩnh, có username/password → tự login lấy token trước, cache lại cho lần sau', async () => {
      process.env.RC_ADMIN_USERNAME = 'admin';
      process.env.RC_ADMIN_PASSWORD = 'adminpass';
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { status: 'success', data: { userId: 'admin-id', authToken: 'admin-tok' } }))
        .mockResolvedValueOnce(jsonResponse(200, { user: { _id: 'new1', username: 'newagent' } }))
        .mockResolvedValueOnce(jsonResponse(200, { user: { _id: 'new2', username: 'newagent2' } }));
      global.fetch = fetchMock;

      const r1 = await rcCreateUser({ username: 'newagent', email: 'a@example.com', name: 'A', password: 'Secret123' });
      expect(r1.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2); // login + users.create
      if (r1.ok) expect(r1.data).toEqual({ _id: 'new1', username: 'newagent' });

      const r2 = await rcCreateUser({ username: 'newagent2', email: 'b@example.com', name: 'B', password: 'Secret123' });
      expect(r2.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3); // KHÔNG login lại lần 2 (dùng cache) — chỉ +1 users.create
      if (r2.ok) expect(r2.data).toEqual({ _id: 'new2', username: 'newagent2' });
    });

    it('thiếu MỌI cấu hình admin → ok:false, KHÔNG gọi fetch', async () => {
      global.fetch = vi.fn();
      const r = await rcCreateUser({ username: 'x', email: 'x@example.com', name: 'X', password: 'Secret123' });
      expect(r.ok).toBe(false);
      if (!r.ok && r.kind === 'HTTP') expect(r.errorCode).toBe('RC_ADMIN_CREDENTIALS_NOT_CONFIGURED');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('username trùng (RC trả 400) → ok:false HTTP, không throw', async () => {
      process.env.RC_ADMIN_AUTH_TOKEN = 'admin-tok';
      process.env.RC_ADMIN_USER_ID = 'admin-id';
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'Username is already in use', errorType: 'error-field-unavailable' }));
      const r = await rcCreateUser({ username: 'dup', email: 'dup@example.com', name: 'Dup', password: 'Secret123' });
      expect(r.ok).toBe(false);
      if (!r.ok && r.kind === 'HTTP') {
        expect(r.status).toBe(400);
        expect(r.errorCode).toBe('error-field-unavailable');
      }
    });
  });

  describe('rcDeleteUser', () => {
    // Regression 24/7: dọn tài khoản test tự động (thay dòng nhắc tay cũ không ai làm theo — xem
    // rc-client.live-check.ts) — user test sót lại thật trên production từng gây nhầm lẫn round-trip.
    it('200 success:true → ok:true, gọi đúng users.delete với username', async () => {
      process.env.RC_ADMIN_AUTH_TOKEN = 'admin-tok';
      process.env.RC_ADMIN_USER_ID = 'admin-id';
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { success: true }));
      const r = await rcDeleteUser('sigma_live_check_123');
      expect(r.ok).toBe(true);
      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://rc-test.local/api/v1/users.delete');
      expect(JSON.parse((init.body as string))).toEqual({ username: 'sigma_live_check_123' });
    });

    it('user không tồn tại (RC trả lỗi) → ok:false HTTP, không throw', async () => {
      process.env.RC_ADMIN_AUTH_TOKEN = 'admin-tok';
      process.env.RC_ADMIN_USER_ID = 'admin-id';
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'User not found', errorType: 'error-invalid-user' }));
      const r = await rcDeleteUser('khong-ton-tai');
      expect(r.ok).toBe(false);
      if (!r.ok && r.kind === 'HTTP') expect(r.errorCode).toBe('error-invalid-user');
    });

    it('thiếu cấu hình admin → ok:false, KHÔNG gọi fetch', async () => {
      global.fetch = vi.fn();
      const r = await rcDeleteUser('x');
      expect(r.ok).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
