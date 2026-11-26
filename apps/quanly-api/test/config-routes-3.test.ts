// Route adapter cho 5 màn agent-2 (pos-supply / warehouse / handover / fund / tid-sell-fee) qua supertest. KHÔNG
// dựa app.ts (LEAD gom mount sau) → dựng express app CỤC BỘ mount 5 router mới + cookieParser + json + errorHandler,
// bơm Db giả in-memory (__setDbForTest). Kiểm: 401 không phiên, 403 thiếu quyền, 200 có quyền, DELETE body
// {ids,password} verify mật khẩu ở ADAPTER (sai → 409 WRONG_PASSWORD, KHÔNG gọi lõi). requireQlSession + core THẬT.
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '@sigma/database';
import { hashPassword } from '@sigma/business-rules';
import { __setDbForTest } from '../src/db.js';
import { makeFakeDb as buildFakeDb } from './_fake-db.js';
import { errorHandler } from '../src/app.js';
import { posSupplyRouter } from '../src/routes/pos-supply.js';
import { warehouseRouter } from '../src/routes/warehouse.js';
import { handoverRouter } from '../src/routes/handover.js';
import { fundRouter } from '../src/routes/fund.js';
import { tidSellFeeRouter } from '../src/routes/tid-sell-fee.js';

const PASSWORD = 'matkhau-dung-123';
const PW_HASH = hashPassword(PASSWORD);
const COOKIE = 'ql_session=sess-1';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(posSupplyRouter);
  app.use(warehouseRouter);
  app.use(handoverRouter);
  app.use(fundRouter);
  app.use(tidSellFeeRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Route không tồn tại.' }));
  app.use(errorHandler);
  return app;
}

function makeFakeDb(permissions: string[], opts: { posDeviceCount?: number; entryCount?: number } = {}) {
  const user = {
    id: 7, username: 'nhanvien', fullName: 'Nhân Viên', status: 'ACTIVE', deletedAt: null, forceChangePassword: false,
    passwordHash: PW_HASH,
    roles: [{ role: { code: 'R', status: 'ACTIVE', permissions: permissions.map((c) => ({ permission: { code: c } })) } }]
  };
  const sessions = [{ id: 'sess-1', userId: 7, expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() }];
  const suppliers = [{ id: 1, code: 'NCC1', name: 'Cty A', address: null, phone: null, contactPerson: null, deletedAt: null as Date | null, deletedBy: null as number | null, createdBy: 7, updatedBy: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }];
  const warehouses = [{ id: 1, code: 'K1', name: 'Kho 1', address: null, phone: null, managerUserId: null, note: null, status: 'ACTIVE', deletedAt: null as Date | null, deletedBy: null as number | null, createdBy: 7, updatedBy: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }];
  const handoverTypes = [{ id: 1, name: 'Bán', moneyKind: 'SALE', isBuiltin: true, sortOrder: 0, deletedAt: null as Date | null, deletedBy: null as number | null, createdBy: 7, updatedBy: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }];
  const funds = [{ id: 1, code: 'QU01', name: 'Quỹ chính', type: 'CASH', keeperUserId: null, openingBalance: 1000, active: true, note: null, deletedAt: null as Date | null, deletedBy: null as number | null, createdBy: 7, updatedBy: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }];
  const tidSellFees: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];

  const softTable = (rows: Record<string, unknown>[], keyMatch: (r: Record<string, unknown>, w: Record<string, unknown>) => boolean) => ({
    findMany: async () => rows.filter((r) => r['deletedAt'] == null).map((r) => ({ ...r })),
    findFirst: async ({ where }: { where: Record<string, unknown> }) => { const not = where['NOT'] as { id?: number } | undefined; return rows.find((r) => keyMatch(r, where) && (!not || r['id'] !== not.id)) ?? null; },
    findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r['id'] === where.id) ?? null,
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = rows.find((x) => x['id'] === where.id)!; Object.assign(r, data); return { ...r }; }
  });

  // Shared factory stub SẴN 87 model (join model mới KHÔNG 500 test); $transaction mặc định chạy fn(db) — db đã
  // gồm $queryRawUnsafe/$executeRawUnsafe no-op (engine recalc trong tx setTidSellFees quét 0 GD).
  const db = buildFakeDb({
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
      findMany: async () => [{ id: 7, fullName: 'Nhân Viên', username: 'nhanvien', employeeCode: 'NV01' }]
    },
    loginSession: {
      findUnique: async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null,
      update: async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null,
      deleteMany: async () => ({ count: 0 })
    },
    supplier: softTable(suppliers, (r, w) => r['code'] === w['code']),
    warehouse: softTable(warehouses, (r, w) => r['code'] === w['code']),
    handoverType: softTable(handoverTypes, (r, w) => r['name'] === w['name']),
    fund: { ...softTable(funds, (r, w) => r['name'] === w['name']), findMany: async () => funds.filter((f) => f.deletedAt == null).map((f) => ({ ...f })) },
    posDevice: { count: async () => opts.posDeviceCount ?? 0 },
    cashEntry: { count: async () => opts.entryCount ?? 0, groupBy: async () => [] },
    tid: { findUnique: async ({ where }: { where: { id: number } }) => (where.id === 1 ? { id: 1, tid: 'TID001', bankId: 5, partnerId: 9, deletedAt: null } : null), findMany: async () => [] },
    feeType: { findUnique: async () => ({ id: 3, deletedAt: null, name: 'Phí A' }) },
    bank: { findUnique: async () => ({ code: 'VCB' }), findMany: async () => [] },
    cardType: { findMany: async ({ where }: { where: Record<string, unknown> }) => { const list = [{ id: 11, code: 'VISA', name: 'Visa', bankId: 5, deletedAt: null }]; if (where['id']) { const ids = (where['id'] as { in: number[] }).in; return list.filter((c) => ids.includes(c.id)); } return list.filter((c) => c.bankId === where['bankId']); } },
    feeRate: { findMany: async () => [{ id: 1, effectiveFrom: new Date('2020-01-01'), phiMua: 1000, phiCaiMay: 500, deletedAt: null }] },
    feeSellQuote: { findMany: async () => [{ id: 1, effectiveFrom: new Date('2020-01-01'), phiBan: 3000, deletedAt: null }] },
    tidSellFee: {
      findMany: async () => tidSellFees.filter((s) => s['deletedAt'] == null).map((s) => ({ ...s })),
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: tidSellFees.length + 1, deletedAt: null, ...data }; tidSellFees.push(row); return { ...row }; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = tidSellFees.find((x) => x['id'] === where.id)!; Object.assign(r, data); return { ...r }; }
    },
    // [B230 22/11] `setTidSellFees` nay CHEN gia ban bang SQL THO (lui-7h cua Prisma lam dung khoa duy nhat
    // theo NGAY VN). Mau gia phai hieu cau INSERT do; de `$executeRawUnsafe` no-op la NUOT lenh ghi,
    // `tidSellFees` rong, bai kiem do CAM "da set override" trong khi route tra 200.
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (!/INSERT INTO tid_sell_fees/i.test(sql)) return 0;
      const coKhach = /customer_id/i.test(sql);
      tidSellFees.push({
        id: tidSellFees.length + 1, deletedAt: null,
        tidId: params[0], cardTypeId: params[1], feeTypeId: params[2], phiBan: params[3],
        effectiveFrom: new Date(String(params[4])), customerId: coKhach ? params[5] : null
      });
      return 1;
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) },
    // PHA 2 — engine recalc chạy trong tx setTidSellFees (không có GD seed → scan 0, không đụng assert phí bán).
    transaction: { findMany: async () => [], update: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) },
    revenueRecalcLog: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 1, ...data }) }
  });
  return { db, suppliers, warehouses, handoverTypes, funds, tidSellFees, audits };
}

afterEach(() => __setDbForTest(null));

describe('5 route agent-2 — adapter API', () => {
  it('supplier: không cookie → 401', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_POS_SUPPLY_VIEW']).db);
    const res = await request(buildApp()).get('/v1/suppliers');
    expect(res.status).toBe(401);
  });

  it('supplier: có quyền → 200 list; thiếu quyền → 403', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_POS_SUPPLY_VIEW']).db);
    const ok = await request(buildApp()).get('/v1/suppliers').set('Cookie', COOKIE);
    expect(ok.status).toBe(200);
    expect(ok.body.data[0].code).toBe('NCC1');

    __setDbForTest(makeFakeDb([]).db);
    const forb = await request(buildApp()).get('/v1/suppliers').set('Cookie', COOKIE);
    expect(forb.status).toBe(403);
    expect(forb.body.error).toBe('FORBIDDEN');
  });

  it('supplier: DELETE {ids,password} sai mật khẩu → 409 WRONG_PASSWORD; đúng → 200', async () => {
    const { db, suppliers } = makeFakeDb(['CONFIG_POS_SUPPLY_MANAGE']);
    __setDbForTest(db);
    const bad = await request(buildApp()).delete('/v1/suppliers').set('Cookie', COOKIE).send({ ids: [1], password: 'sai' });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe('WRONG_PASSWORD');
    expect(suppliers[0]!.deletedAt).toBeNull();

    const ok = await request(buildApp()).delete('/v1/suppliers').set('Cookie', COOKIE).send({ ids: [1], password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.deleted).toBe(1);
  });

  it('supplier: lite GET → 200', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_POS_SUPPLY_VIEW']).db);
    const res = await request(buildApp()).get('/v1/suppliers/lite').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.data[0].name).toBe('Cty A');
  });

  it('warehouse: list 200 + DELETE kho còn máy → 409 IN_USE (core reached sau verify mật khẩu)', async () => {
    const { db } = makeFakeDb(['CONFIG_WAREHOUSE_VIEW', 'CONFIG_WAREHOUSE_MANAGE'], { posDeviceCount: 2 });
    __setDbForTest(db);
    const list = await request(buildApp()).get('/v1/warehouses').set('Cookie', COOKIE);
    expect(list.status).toBe(200);
    expect(list.body.data[0].code).toBe('K1');

    const del = await request(buildApp()).delete('/v1/warehouses').set('Cookie', COOKIE).send({ ids: [1], password: PASSWORD });
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('IN_USE');
  });

  it('handover: list 200 + lite chấp nhận POS_VIEW', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_HANDOVER_VIEW']).db);
    const list = await request(buildApp()).get('/v1/handover-types').set('Cookie', COOKIE);
    expect(list.status).toBe(200);
    expect(list.body.data[0].moneyKind).toBe('SALE');

    __setDbForTest(makeFakeDb(['POS_VIEW']).db);
    const lite = await request(buildApp()).get('/v1/handover-types/lite').set('Cookie', COOKIE);
    expect(lite.status).toBe(200);
    expect(lite.body.data[0].name).toBe('Bán');
  });

  it('fund: list 200 + userLite + DELETE {ids,password} sai → 409', async () => {
    const { db } = makeFakeDb(['FUND_VIEW', 'FUND_DELETE']);
    __setDbForTest(db);
    const list = await request(buildApp()).get('/v1/funds').set('Cookie', COOKIE);
    expect(list.status).toBe(200);
    expect(list.body.data[0].code).toBe('QU01');

    const lite = await request(buildApp()).get('/v1/cashflow-users/lite').set('Cookie', COOKIE);
    expect(lite.status).toBe(200);
    expect(lite.body.data[0].code).toBe('NV01');

    const bad = await request(buildApp()).delete('/v1/funds').set('Cookie', COOKIE).send({ ids: [1], password: 'sai' });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe('WRONG_PASSWORD');
  });

  it('tid-sell-fee: GET niêm yết 200 + PUT set override 200', async () => {
    __setDbForTest(makeFakeDb(['TID_VIEW', 'TID_MANAGE']).db);
    const get = await request(buildApp()).get('/v1/tids/1/sell-fees?feeTypeId=3').set('Cookie', COOKIE);
    expect(get.status).toBe(200);
    expect(get.body.data.rows[0].phiMuaNiemYet).toBe(1);

    const { db, tidSellFees } = makeFakeDb(['TID_VIEW', 'TID_MANAGE']);
    __setDbForTest(db);
    const put = await request(buildApp()).put('/v1/tids/1/sell-fees').set('Cookie', COOKIE).send({ feeTypeId: 3, entries: [{ cardTypeId: 11, phiBan: 2 }] });
    expect(put.status).toBe(200);
    expect(tidSellFees[0]!['phiBan']).toBe(2000);
  });
});
