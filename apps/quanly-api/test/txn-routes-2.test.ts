// Route adapter cho 4 màn nhóm B tx tiền/công nợ/state-machine migrate desktop→API (pos / cash-entry / deposit /
// device-sale) qua supertest. KHÔNG dựa app.ts (LEAD gom mount sau) → dựng express cục bộ mount 4 router mới +
// cookieParser + json + errorHandler, bơm Db giả in-memory (__setDbForTest). Kiểm: 401 không phiên, 403 thiếu quyền,
// 200 có quyền (READ), R34 KHÔNG có DELETE endpoint (404), thao-tác có password (retire/cancel/sell-pos) verify §14 →
// 409 WRONG_PASSWORD. Middleware requireQlSession + core chạy THẬT. KHÔNG sửa test màn khác.
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '@sigma/database';
import { hashPassword } from '@sigma/business-rules';
import { __setDbForTest } from '../src/db.js';
import { makeFakeDb as buildFakeDb } from './_fake-db.js';
import { errorHandler } from '../src/app.js';
import { posRouter } from '../src/routes/pos.js';
import { cashEntryRouter } from '../src/routes/cash-entry.js';
import { depositRouter } from '../src/routes/deposit.js';
import { deviceSaleRouter } from '../src/routes/device-sale.js';

const PASSWORD = 'matkhau-dung-123';
const PW_HASH = hashPassword(PASSWORD);
const COOKIE = 'ql_session=sess-1';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(posRouter);
  app.use(cashEntryRouter);
  app.use(depositRouter);
  app.use(deviceSaleRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Route không tồn tại.' }));
  app.use(errorHandler);
  return app;
}

const empty = { findMany: async () => [], count: async () => 0, groupBy: async () => [], aggregate: async () => ({ _sum: { amount: 0n }, _count: 0 }) };

function makeFakeDb(permissions: string[]): Db {
  const user = {
    id: 7, username: 'nhanvien', fullName: 'Nhân Viên', status: 'ACTIVE', deletedAt: null, forceChangePassword: false,
    passwordHash: PW_HASH,
    roles: [{ role: { code: 'R', status: 'ACTIVE', permissions: permissions.map((c) => ({ permission: { code: c } })) } }]
  };
  const sessions = [{ id: 'sess-1', userId: 7, expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() }];
  // Shared factory stub SẴN 87 model → thêm join model mới KHÔNG 500 test nữa. Chỉ override model test quan tâm.
  return buildFakeDb({
    user: {
      findUnique: async ({ where }: { where: { id: number } }) => (where.id === 7 ? { ...user } : null),
      findUniqueOrThrow: async ({ where }: { where: { id: number } }) => { if (where.id !== 7) throw new Error('no user'); return JSON.parse(JSON.stringify(user)); },
      // B132 #1: verifyActorPassword sai → registerActorReauthFail dùng user.updateMany (feed lockout). Mock phải khớp shape Prisma.
      updateMany: async ({ where, data }: { where: { id?: number; status?: { notIn?: string[] } }; data: Record<string, unknown> }) => {
        const u = user as unknown as Record<string, unknown>;
        if (where.id !== undefined && where.id !== u.id) return { count: 0 };
        if (where.status?.notIn && where.status.notIn.includes(u.status as string)) return { count: 0 };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as object)) u[k] = ((u[k] as number) ?? 0) + ((v as { increment: number }).increment ?? 0);
          else u[k] = v;
        }
        return { count: 1 };
      },
      findMany: async () => []
    },
    loginSession: {
      findUnique: async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null,
      update: async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null,
      deleteMany: async () => ({ count: 0 })
    },
    // đủ để listPosDevices / listCashEntries / depositsHeld / listDeviceSales chạy (dữ liệu rỗng).
    posDevice: { ...empty, findUnique: async () => null }, posModel: empty, supplier: empty, customer: empty, agent: empty, warehouse: empty, bank: empty,
    // listPosDevices join tên HKD của TID hiện gắn (db.tid.findMany theo currentTid) — rỗng → tidHkd map rỗng.
    tid: empty,
    cashEntry: empty, cashCategory: empty, fund: empty, partner: empty,
    deviceDeposit: empty, deviceDepositRefund: empty,
    deviceSale: empty, deviceSaleSettlement: empty,
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) },
    changeToken: { upsert: async () => ({}) }
  });
}

afterEach(() => __setDbForTest(null));

describe('txn routes nhóm B — auth + R34 + password gate', () => {
  it('POS list: không cookie → 401 NO_SESSION', async () => {
    __setDbForTest(makeFakeDb(['POS_VIEW']));
    const res = await request(buildApp()).get('/v1/pos-devices');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('NO_SESSION');
  });

  it('POS list: có POS_VIEW → 200; thiếu quyền → 403 FORBIDDEN', async () => {
    __setDbForTest(makeFakeDb(['POS_VIEW']));
    const ok = await request(buildApp()).get('/v1/pos-devices').set('Cookie', COOKIE);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);

    __setDbForTest(makeFakeDb([]));
    const forb = await request(buildApp()).get('/v1/pos-devices').set('Cookie', COOKIE);
    expect(forb.status).toBe(403);
    expect(forb.body.error).toBe('FORBIDDEN');
  });

  it('cash-entries list (CASHENTRY_VIEW) → 200 + summary', async () => {
    __setDbForTest(makeFakeDb(['CASHENTRY_VIEW']));
    const res = await request(buildApp()).get('/v1/cash-entries').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.summary).toBeDefined();
  });

  it('deposits/held (REVENUE_VIEW) → 200', async () => {
    __setDbForTest(makeFakeDb(['REVENUE_VIEW']));
    const res = await request(buildApp()).get('/v1/deposits/held').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('device-sales list (DEVICE_SALE_VIEW) → 200', async () => {
    __setDbForTest(makeFakeDb(['DEVICE_SALE_VIEW']));
    const res = await request(buildApp()).get('/v1/device-sales').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('R34: KHÔNG có DELETE /v1/pos-devices (404) và DELETE /v1/cash-entries (404)', async () => {
    __setDbForTest(makeFakeDb(['POS_MANAGE', 'CASHENTRY_CANCEL']));
    const d1 = await request(buildApp()).delete('/v1/pos-devices').set('Cookie', COOKIE).send({ ids: [1], password: PASSWORD });
    expect(d1.status).toBe(404);
    const d2 = await request(buildApp()).delete('/v1/cash-entries').set('Cookie', COOKIE).send({ ids: [1], password: PASSWORD });
    expect(d2.status).toBe(404);
  });

  it('POS retire: password sai → 409 WRONG_PASSWORD (chưa gọi lõi)', async () => {
    __setDbForTest(makeFakeDb(['POS_MANAGE']));
    const res = await request(buildApp()).post('/v1/pos-devices/S1/retire').set('Cookie', COOKIE).send({ password: 'sai' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('WRONG_PASSWORD');
  });

  it('cash-entry cancel: password sai → 409 WRONG_PASSWORD', async () => {
    __setDbForTest(makeFakeDb(['CASHENTRY_CANCEL']));
    const res = await request(buildApp()).post('/v1/cash-entries/1/cancel').set('Cookie', COOKIE).send({ password: 'sai', reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('WRONG_PASSWORD');
  });

  it('device-sale sell-pos: password sai → 409 WRONG_PASSWORD', async () => {
    __setDbForTest(makeFakeDb(['DEVICE_SALE_MANAGE']));
    const res = await request(buildApp()).post('/v1/device-sales/sell-pos').set('Cookie', COOKIE).send({ password: 'sai', serial: 'S1', customerId: 5, salePrice: 100 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('WRONG_PASSWORD');
  });

  it('POS retire: password đúng → gọi lõi (404 NOT_FOUND vì máy không tồn tại)', async () => {
    __setDbForTest(makeFakeDb(['POS_MANAGE']));
    const res = await request(buildApp()).post('/v1/pos-devices/UNKNOWN/retire').set('Cookie', COOKIE).send({ password: PASSWORD });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});
