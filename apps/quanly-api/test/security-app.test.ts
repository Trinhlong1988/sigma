// Security tầng app (B132, 4 finding) — kiểm chứng middleware bảo mật ở app.ts qua supertest (KHÔNG cần
// Postgres/DB giả: cả 3 lớp này chạy TRƯỚC router nên không chạm service). Nếu ai lỡ gỡ/đổi middleware → test đỏ.
// Bao: (#9) origin lạ + POST → 403 FORBIDDEN_ORIGIN; (#10) JSON hỏng → 400 BAD_JSON; (#8) mọi response có nosniff.
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp();

describe('AUDIT-VÁ #9 (MED CSRF) — origin-reject cho request state-changing', () => {
  it('POST cross-origin (origin lạ) → 403 FORBIDDEN_ORIGIN, KHÔNG chạm handler', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .set('Origin', 'https://evil-site-khong-lien-quan.example.com')
      .send({ any: 'thing' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'FORBIDDEN_ORIGIN', message: 'Nguồn gửi không hợp lệ.' });
  });

  it('PUT/PATCH/DELETE cross-origin cũng bị chặn (mọi method state-changing)', async () => {
    for (const method of ['put', 'patch', 'delete'] as const) {
      const res = await request(app)[method]('/v1/bat-ky').set('Origin', 'https://evil.example.com');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN_ORIGIN');
    }
  });

  it('GET cross-origin KHÔNG bị chặn ở lớp này (chỉ state-changing mới chặn; đọc do CORS lo)', async () => {
    const res = await request(app).get('/v1/health').set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(200);
  });

  it('POST từ origin loopback hợp lệ (bản desktop Electron) KHÔNG bị chặn bởi origin-reject', async () => {
    // Origin hợp lệ → qua lớp #9, dừng ở 404 (route không tồn tại) chứ KHÔNG phải 403.
    const res = await request(app)
      .post('/route-khong-ton-tai')
      .set('Origin', 'http://127.0.0.1:49812')
      .send({});
    expect(res.status).not.toBe(403);
  });

  it('POST KHÔNG có header Origin (client native) KHÔNG bị chặn', async () => {
    const res = await request(app).post('/route-khong-ton-tai').send({});
    expect(res.status).not.toBe(403);
  });
});

// SEC-FIX 12/8 (bug TB) — Origin:'null' (opaque, Electron file://) trên ĐƯỜNG GHI: chỉ CHO QUA khi content-type
// buộc-preflight (application/json của bản desktop); CHẶN khi content-type "simple" (vector CSRF-ghi
// <form>/sandboxed-iframe không-preflight). Đọc (GET) và JSON-write của desktop KHÔNG bị phá.
describe('SEC-FIX Origin:null trên state-changing — chặn CSRF-ghi simple, GIỮ desktop JSON-write', () => {
  it('POST Origin:null + multipart/form-data (không preflight) → 403 (vector CSRF-ghi bị chặn)', async () => {
    const res = await request(app)
      .post('/route-khong-ton-tai')
      .set('Origin', 'null')
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .send('--x--');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN_ORIGIN');
  });

  it('POST Origin:null + text/plain → 403; + x-www-form-urlencoded → 403 (đều content-type simple)', async () => {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded']) {
      const res = await request(app).post('/route-khong-ton-tai').set('Origin', 'null').set('Content-Type', ct).send('a=b');
      expect(res.status, `content-type ${ct}`).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN_ORIGIN');
    }
  });

  it('POST Origin:null KHÔNG có Content-Type → 403 (thiếu content-type coi như simple)', async () => {
    // supertest KHÔNG set content-type khi không .send() body & không .set() → gửi request rỗng.
    const res = await request(app).post('/route-khong-ton-tai').set('Origin', 'null');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN_ORIGIN');
  });

  it('POST Origin:null + application/json (bản desktop file://) → KHÔNG 403 (không phá app)', async () => {
    const res = await request(app).post('/route-khong-ton-tai').set('Origin', 'null').send({ any: 'thing' });
    expect(res.status).not.toBe(403); // dừng ở 404 route không tồn tại
  });

  it('DELETE Origin:null + application/json → KHÔNG 403 (desktop xóa qua httpCall json)', async () => {
    const res = await request(app).delete('/route-khong-ton-tai').set('Origin', 'null').set('Content-Type', 'application/json');
    expect(res.status).not.toBe(403);
  });

  it('GET Origin:null (đọc) KHÔNG bị chặn dù content-type gì', async () => {
    const res = await request(app).get('/v1/health').set('Origin', 'null');
    expect(res.status).toBe(200);
  });
});

describe('AUDIT-VÁ #10 (LOW) — JSON hỏng → 400 BAD_JSON (không phải 500)', () => {
  it('body JSON sai cú pháp → 400 BAD_JSON', async () => {
    const res = await request(app)
      .post('/route-khong-ton-tai')
      .set('Content-Type', 'application/json')
      .send('{"a": '); // JSON cụt → entity.parse.failed
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      ok: false,
      error: 'BAD_JSON',
      message: 'Dữ liệu gửi lên không hợp lệ (JSON sai định dạng).'
    });
  });
});

describe('AUDIT-VÁ #8 (LOW) — security headers áp cho MỌI response', () => {
  it('response có X-Content-Type-Options: nosniff + X-Frame-Options: DENY + Referrer-Policy: no-referrer', async () => {
    const res = await request(app).get('/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('nosniff xuất hiện cả trên response lỗi (404) — áp trước router', async () => {
    const res = await request(app).get('/route-khong-ton-tai');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('KHÔNG lộ header X-Powered-By', async () => {
    const res = await request(app).get('/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
