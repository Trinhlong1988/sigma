// SIGMA — bảo mật endpoint nội bộ nhận bill Zalo (Admin Demo 25/8). Test TRỌNG TÂM: guard fail-closed + shape.
// KHÔNG cần DB: mọi case ở đây short-circuit TRƯỚC khi gọi ingestZaloBill (logic ingest đã test riêng ở
// zalo-bill-ingest.test.ts). Nếu ai lỡ mở toang khi chưa cấu hình token / bỏ check token → test đỏ ngay.
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp();
const PATH = '/internal/zalo-bill-ingest';
const TOKEN = 'test-secret-token-12345';

describe('POST /internal/zalo-bill-ingest — guard fail-closed', () => {
  const original = process.env['SIGMA_INTERNAL_INGEST_TOKEN'];
  afterEach(() => {
    if (original === undefined) delete process.env['SIGMA_INTERNAL_INGEST_TOKEN'];
    else process.env['SIGMA_INTERNAL_INGEST_TOKEN'] = original;
  });

  it('CHƯA cấu hình token → 503 (TỪ CHỐI, không mở toang)', async () => {
    delete process.env['SIGMA_INTERNAL_INGEST_TOKEN'];
    const res = await request(app).post(`${PATH}?zaloGroupId=g123`).set('x-internal-token', 'anything');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'INTERNAL_INGEST_NOT_CONFIGURED' });
  });

  it('token rỗng cấu hình (chỉ khoảng trắng) → coi như CHƯA cấu hình → 503', async () => {
    process.env['SIGMA_INTERNAL_INGEST_TOKEN'] = '   ';
    const res = await request(app).post(`${PATH}?zaloGroupId=g123`).set('x-internal-token', 'x');
    expect(res.status).toBe(503);
  });

  it('thiếu header token → 401', async () => {
    process.env['SIGMA_INTERNAL_INGEST_TOKEN'] = TOKEN;
    const res = await request(app).post(`${PATH}?zaloGroupId=g123`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHORIZED' });
  });

  it('sai token → 401', async () => {
    process.env['SIGMA_INTERNAL_INGEST_TOKEN'] = TOKEN;
    const res = await request(app).post(`${PATH}?zaloGroupId=g123`).set('x-internal-token', 'sai-token');
    expect(res.status).toBe(401);
  });

  it('token ĐÚNG nhưng thiếu zaloGroupId → 400 MISSING_ZALO_GROUP_ID (không đoán nhóm)', async () => {
    process.env['SIGMA_INTERNAL_INGEST_TOKEN'] = TOKEN;
    const res = await request(app).post(PATH).set('x-internal-token', TOKEN);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'MISSING_ZALO_GROUP_ID' });
  });

  it('token ĐÚNG + zaloGroupId nhưng KHÔNG có file → 400 NO_FILE', async () => {
    process.env['SIGMA_INTERNAL_INGEST_TOKEN'] = TOKEN;
    const res = await request(app)
      .post(`${PATH}?zaloGroupId=g123`)
      .set('x-internal-token', TOKEN)
      .set('content-type', 'multipart/form-data; boundary=----none')
      .send('------none--\r\n');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'NO_FILE' });
  });
});

describe('GET /internal/zalo-mapped-groups — guard + shape', () => {
  const MAP_PATH = '/internal/zalo-mapped-groups';
  const original = process.env['SIGMA_INTERNAL_INGEST_TOKEN'];
  afterEach(() => {
    if (original === undefined) delete process.env['SIGMA_INTERNAL_INGEST_TOKEN'];
    else process.env['SIGMA_INTERNAL_INGEST_TOKEN'] = original;
  });

  it('chưa cấu hình token → 503', async () => {
    delete process.env['SIGMA_INTERNAL_INGEST_TOKEN'];
    const res = await request(app).get(MAP_PATH).set('x-internal-token', 'x');
    expect(res.status).toBe(503);
  });

  it('sai token → 401', async () => {
    process.env['SIGMA_INTERNAL_INGEST_TOKEN'] = TOKEN;
    const res = await request(app).get(MAP_PATH).set('x-internal-token', 'sai');
    expect(res.status).toBe(401);
  });

  it('token ĐÚNG → 200 {ok:true, groupIds:[...]} (mảng)', async () => {
    process.env['SIGMA_INTERNAL_INGEST_TOKEN'] = TOKEN;
    const res = await request(app).get(MAP_PATH).set('x-internal-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.groupIds)).toBe(true);
  });
});
