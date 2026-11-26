// Health-check (5/8, dọn nợ P2) — cloudflared/monitor/Playwright cần 1 endpoint KHÔNG auth để biết bot-api
// sống. Test bằng supertest (không cần DB, giống cors.test.ts): xác nhận /health + /healthz trả 200
// {ok:true,service:'bot-api'} KHÔNG cần cookie/Bearer, và KHÔNG lộ thông tin nhạy cảm (version/env/DB/path).
// Nếu ai lỡ gắn nhầm middleware auth trước health hoặc đổi shape → test đỏ ngay.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('Health-check /health + /healthz (app.ts)', () => {
  const app = createApp();

  for (const path of ['/health', '/healthz']) {
    it(`GET ${path} → 200 {ok:true,service:'bot-api'} KHÔNG cần auth`, async () => {
      const res = await request(app).get(path); // KHÔNG set cookie/Authorization
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, service: 'bot-api' });
    });

    it(`GET ${path} → KHÔNG lộ thông tin nhạy cảm (chỉ ĐÚNG 2 khóa ok/service)`, async () => {
      const res = await request(app).get(path);
      // Đúng contract cố định — thừa khóa nào (version/env/db/uptime/path...) là rò rỉ, đỏ ngay.
      expect(Object.keys(res.body).sort()).toEqual(['ok', 'service']);
    });

    it(`HEAD ${path} → 200 (Express tự map GET→HEAD)`, async () => {
      const res = await request(app).head(path);
      expect(res.status).toBe(200);
    });
  }

  it('POST /health → KHÔNG khớp (chỉ GET/HEAD) → 404 NOT_FOUND (không nuốt thành 200)', async () => {
    const res = await request(app).post('/health');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Route không tồn tại.' });
  });
});
