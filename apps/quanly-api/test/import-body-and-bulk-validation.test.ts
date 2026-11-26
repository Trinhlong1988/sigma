// Item 4 + Item 2-route (audit 20/8).
//  #4: /v1/import/* nhận payload 2000 dòng (>100kb) — parser 8mb RIÊNG cho /v1/import phải cho qua (KHÔNG 413);
//      route NON-import cùng cỡ vẫn bị global 100kb chặn 413 (đối chứng).
//  #2: DELETE /v1/funds với ids có phần tử sai kiểu → VALIDATION (không âm thầm xóa tập con).
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { rawPhienStub } from './_raw-phien.js';
import type { Db } from '@sigma/database';
import { createApp, errorHandler } from '../src/app.js';
import { __setDbForTest } from '../src/db.js';
import { fundRouter } from '../src/routes/fund.js';

describe('Item 4 — hòa giải trần body import vs 100kb toàn cục', () => {
  const app = createApp();

  it('POST /v1/import/dry-run payload 2000 dòng (>100kb) → KHÔNG 413 (parser 8mb cho /v1/import)', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ code: 'KH' + i, fullName: 'Khách hàng kiểm thử số ' + i, nickname: 'nick' + i, phone: '090000' + i }));
    const payload = JSON.stringify({ entityKey: 'customer', rows });
    expect(payload.length).toBeGreaterThan(100 * 1024); // chắc chắn vượt 100kb để phép thử có ý nghĩa
    const res = await request(app).post('/v1/import/dry-run').set('Content-Type', 'application/json').send(payload);
    // Parse OK bằng 8mb → dừng ở requireQlSession (401 NO_SESSION), KHÔNG bị 413 ở body-parser.
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(401);
  });

  it('POST route NON-import cùng cỡ >100kb → 413 (global 100kb VẪN áp)', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(200 * 1024) });
    const res = await request(app).post('/v1/customers').set('Content-Type', 'application/json').send(big);
    expect(res.status).toBe(413);
  });
});

// ── Item 2: id sai kiểu trong bulk-delete → VALIDATION (route fund) ──
const COOKIE = 'ql_session=sess-1';
function makeFakeDb(permissions: string[]) {
  const user = {
    id: 7, username: 'nv', fullName: 'Nhân Viên', status: 'ACTIVE', deletedAt: null, forceChangePassword: false, passwordHash: 'x',
    roles: [{ role: { code: 'R', status: 'ACTIVE', permissions: permissions.map((c) => ({ permission: { code: c } })) } }]
  };
  const sessions = [{ id: 'sess-1', userId: 7, expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() }];
  const fake = {
    // [13/11] auth.ts ghi/chạm/đo phiên bằng SQL THÔ (băm phiên 12/11) — thiếu stub là login nổ 500,
    // kéo cả file đỏ CÂM. Stub dùng chung, câu lạ thì NÉM LỖI chứ không trả rỗng.
    ...rawPhienStub(sessions),
    user: {
      findUnique: async ({ where }: { where: { id: number } }) => (where.id === 7 ? { ...user } : null),
      findUniqueOrThrow: async ({ where }: { where: { id: number } }) => { if (where.id !== 7) throw new Error('no user'); return JSON.parse(JSON.stringify(user)); }
    },
    loginSession: {
      findUnique: async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null,
      update: async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null,
      deleteMany: async () => ({ count: 0 })
    },
    fund: { findUnique: async () => null, update: async () => ({}), findMany: async () => [] },
    cashEntry: { count: async () => 0 }
  };
  return fake as unknown as Db;
}

function buildFundApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(fundRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Route không tồn tại.' }));
  app.use(errorHandler);
  return app;
}

describe('Item 2 — DELETE /v1/funds id sai kiểu → VALIDATION', () => {
  it('ids có phần tử phi số ("abc") → 400 VALIDATION (không âm thầm xóa tập con)', async () => {
    __setDbForTest(makeFakeDb(['FUND_DELETE']));
    const app = buildFundApp();
    const res = await request(app).delete('/v1/funds').set('Cookie', COOKIE).send({ ids: [1, 'abc', 3], password: 'bat-ky' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'VALIDATION' });
    expect(res.body.message).toBe('Danh sách mã quỹ chọn có giá trị không hợp lệ.');
  });
});
