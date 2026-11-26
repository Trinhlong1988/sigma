// CORS (24/7, web-demo bắt đầu gọi bot-api thật) — trước đây createApp() KHÔNG có middleware CORS, trình
// duyệt tự chặn fetch() cross-origin từ Vite dev server (:5173/:5174) sang bot-api (:8788) ngay ở tầng browser
// (KHÔNG có header Access-Control-Allow-Origin trong preflight/response thật). Test bằng supertest (không
// phải browser thật) NÊN không tự chặn request — thứ cần xác nhận ở đây là ĐÚNG HEADER xuất hiện đúng lúc,
// để nếu ai lỡ xóa/đổi middleware, test đỏ ngay thay vì phải phát hiện qua console lỗi CORS trên trình duyệt.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, CORS_ALLOWED_ORIGINS } from '../src/app.js';

describe('CORS — allowlist origin dev/LAN cố định (app.ts)', () => {
  const app = createApp();

  it('origin trong allowlist (vd http://localhost:5173) → response có Access-Control-Allow-Origin đúng origin đó + Allow-Credentials true', async () => {
    const origin = CORS_ALLOWED_ORIGINS[0];
    const res = await request(app).get('/route-khong-ton-tai').set('Origin', origin!);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('preflight OPTIONS từ origin hợp lệ → 204 kèm Access-Control-Allow-Origin đúng origin', async () => {
    const origin = CORS_ALLOWED_ORIGINS[2]; // http://127.0.0.1:5173 — origin LAN, không chỉ localhost
    const res = await request(app)
      .options('/v1/auth/register/request-otp')
      .set('Origin', origin!)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
  });

  it('origin KHÔNG nằm trong allowlist → response KHÔNG có header Access-Control-Allow-Origin (browser thật sẽ tự chặn)', async () => {
    const res = await request(app).get('/route-khong-ton-tai').set('Origin', 'https://evil-site-khong-lien-quan.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // 4/8 — REGRESSION bản PC Electron (SigMa PC) phục vụ renderer từ http://127.0.0.1:<cổng NGẪU NHIÊN>.
  // Trước fix: origin này KHÔNG trong allowlist cố định → đăng nhập trên PC báo "Lỗi kết nối mạng" (CORS chặn).
  it('origin loopback http (bản PC Electron, 127.0.0.1:<cổng ngẫu nhiên>) → có Access-Control-Allow-Origin đúng origin', async () => {
    const origin = 'http://127.0.0.1:49812';
    const res = await request(app).get('/route-khong-ton-tai').set('Origin', origin);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('preflight OPTIONS từ origin loopback 127.0.0.1 → 204 kèm ACAO đúng origin', async () => {
    const origin = 'http://127.0.0.1:5321';
    const res = await request(app).options('/v1/auth/register/request-otp').set('Origin', origin).set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
  });

  it('origin GIẢ DẠNG loopback (http://127.0.0.1.evil.com) → KHÔNG khớp (regex neo $) → KHÔNG có ACAO', async () => {
    const res = await request(app).get('/route-khong-ton-tai').set('Origin', 'http://127.0.0.1.evil.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
