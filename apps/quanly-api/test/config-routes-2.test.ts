// Route adapter cho 3 màn cấu hình migrate desktop→API (bank-config / fee-config / tid-config) qua supertest.
// KHÔNG dựa app.ts (LEAD gom mount sau) → dựng 1 express app CỤC BỘ mount 3 router mới + cookieParser + json +
// errorHandler, bơm Db giả in-memory (__setDbForTest). Kiểm: 401 không phiên, 403 thiếu quyền, 200 có quyền,
// DELETE bề mặt (bank/cardType/partner/feeType/feeRate/tidStatus body {ids,password} verify §14; tid-config KHÔNG
// có DELETE — R34). Middleware requireQlSession + core chạy THẬT. KHÔNG sửa config-routes.test.ts (màn khác).
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '@sigma/database';
import { hashPassword } from '@sigma/business-rules';
import { __setDbForTest } from '../src/db.js';
import { makeFakeDb as buildFakeDb } from './_fake-db.js';
import { errorHandler } from '../src/app.js';
import { bankConfigRouter } from '../src/routes/bank-config.js';
import { feeConfigRouter } from '../src/routes/fee-config.js';
import { tidConfigRouter } from '../src/routes/tid-config.js';

const PASSWORD = 'matkhau-dung-123';
const PW_HASH = hashPassword(PASSWORD);
const COOKIE = 'ql_session=sess-1';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(bankConfigRouter);
  app.use(feeConfigRouter);
  app.use(tidConfigRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Route không tồn tại.' }));
  app.use(errorHandler);
  return app;
}

interface Row { [k: string]: unknown; id: number; deletedAt: Date | null }

function model(store: Row[], counter: { n: number }) {
  return {
    findMany: async (args?: { where?: Record<string, unknown> }) => {
      const w = args?.where ?? {};
      return store.filter((r) => Object.entries(w).every(([k, cond]) => {
        if (k === 'OR' || k === 'createdAt') return true;
        if (cond === undefined) return true;
        if (cond && typeof cond === 'object' && 'in' in (cond as object)) return (cond as { in: unknown[] }).in.includes(r[k]);
        return r[k] === cond;
      })).map((r) => ({ ...r }));
    },
    findUnique: async ({ where }: { where: { id: number } }) => { const r = store.find((x) => x.id === where.id); return r ? { ...r } : null; },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const not = (where['NOT'] as { id?: number } | undefined)?.id;
      const r = store.find((x) => { if (not !== undefined && x.id === not) return false; return Object.entries(where).every(([k, cond]) => k === 'NOT' ? true : x[k] === cond); });
      return r ? { ...r } : null;
    },
    aggregate: async () => ({ _max: { seq: store.reduce((m, r) => Math.max(m, (r['seq'] as number) ?? 0), 0) } }),
    create: async ({ data }: { data: Record<string, unknown> }) => { const t = new Date(); const row: Row = { id: counter.n++, createdAt: t, updatedAt: t, updatedBy: null, deletedAt: null, deletedBy: null, ...data } as Row; store.push(row); return { ...row }; },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = store.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { let n = 0; for (const r of store) { if (Object.entries(where).every(([k, cond]) => r[k] === cond)) { Object.assign(r, data); n++; } } return { count: n }; }
  };
}

function makeFakeDb(permissions: string[]) {
  const now = new Date('2026-01-01');
  const user = {
    id: 7, username: 'nhanvien', fullName: 'Nhân Viên', status: 'ACTIVE', deletedAt: null, forceChangePassword: false,
    passwordHash: PW_HASH,
    roles: [{ role: { code: 'R', status: 'ACTIVE', permissions: permissions.map((c) => ({ permission: { code: c } })) } }]
  };
  const sessions = [{ id: 'sess-1', userId: 7, expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() }];
  const counter = { n: 1000 };
  const banks: Row[] = [{ id: 1, seq: 1, name: 'Vietcombank', code: 'VCB', status: 'ACTIVE', createdBy: 7, createdAt: now, updatedBy: null, updatedAt: now, deletedAt: null, deletedBy: null }];
  const cardTypes: Row[] = [];
  const partners: Row[] = [{ id: 5, code: 'DTA', name: 'Đối tác A', status: 'UNSIGNED', address: null, phone: null, email: null, contactPerson: null, createdBy: 7, createdAt: now, updatedBy: null, updatedAt: now, deletedAt: null, deletedBy: null }];
  const partnerBanks: Row[] = [];
  const feeTypes: Row[] = [{ id: 2, name: 'Ủy quyền', createdBy: 7, createdAt: now, updatedBy: null, updatedAt: now, deletedAt: null, deletedBy: null }];
  const feeRates: Row[] = [];
  const feeSellQuotes: Row[] = [];
  const tidStatuses: Row[] = [{ id: 3, name: 'Đang chạy', createdBy: 7, createdAt: now, updatedBy: null, updatedAt: now, deletedAt: null, deletedBy: null }];
  const tids: Row[] = [];
  const statusOptions = [
    { entity: 'BANK', code: 'ACTIVE', deletedAt: null },
    { entity: 'PARTNER', code: 'UNSIGNED', deletedAt: null }
  ];
  const audits: Record<string, unknown>[] = [];

  // Shared factory stub SẴN 87 model (join model mới KHÔNG 500 test); $transaction mặc định chạy fn(db-đầy-đủ).
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
      findMany: async () => [{ id: 7, fullName: 'Nhân Viên', username: 'nhanvien' }]
    },
    loginSession: {
      findUnique: async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null,
      update: async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null,
      deleteMany: async () => ({ count: 0 })
    },
    bank: model(banks, counter),
    cardType: model(cardTypes, counter),
    partner: model(partners, counter),
    partnerBank: model(partnerBanks, counter),
    feeType: model(feeTypes, counter),
    feeRate: model(feeRates, counter),
    feeSellQuote: model(feeSellQuotes, counter),
    tidConfigStatus: model(tidStatuses, counter),
    tid: model(tids, counter),
    receiveAccount: model([], counter),
    dossierSource: model([], counter),
    industry: model([], counter),
    dossier: model([], counter),
    customer: model([], counter),
    investor: model([], counter),
    statusOption: { findFirst: async ({ where }: { where: { entity: string; code: string; deletedAt: null } }) => statusOptions.find((s) => s.entity === where.entity && s.code === where.code && s.deletedAt === null) ?? null },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) }
  });
  return { db, banks, feeTypes, tidStatuses, audits };
}

afterEach(() => __setDbForTest(null));

describe('3 route cấu hình migrate — adapter API', () => {
  it('bank: không cookie → 401 NO_SESSION', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_BANK_VIEW']).db);
    const res = await request(buildApp()).get('/v1/banks');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('NO_SESSION');
  });

  it('bank: có quyền → 200 list (seqCode NH01); thiếu quyền → 403', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_BANK_VIEW']).db);
    const ok = await request(buildApp()).get('/v1/banks').set('Cookie', COOKIE);
    expect(ok.status).toBe(200);
    expect(ok.body.data[0].seqCode).toBe('NH01');

    __setDbForTest(makeFakeDb([]).db);
    const forb = await request(buildApp()).get('/v1/banks').set('Cookie', COOKIE);
    expect(forb.status).toBe(403);
    expect(forb.body.error).toBe('FORBIDDEN');
  });

  it('bank: GET /v1/banks/lite → 200', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_BANK_VIEW']).db);
    const res = await request(buildApp()).get('/v1/banks/lite').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.data[0].code).toBe('VCB');
  });

  it('bank: POST create (body parse) → 200 + seq 2', async () => {
    const { db, banks } = makeFakeDb(['CONFIG_BANK_MANAGE']);
    __setDbForTest(db);
    const res = await request(buildApp()).post('/v1/banks').set('Cookie', COOKIE).send({ name: 'ACB', code: 'acb', status: 'ACTIVE' });
    expect(res.status).toBe(200);
    expect(banks.some((b) => b['code'] === 'ACB' && b['seq'] === 2)).toBe(true);
  });

  it('bank: DELETE {ids,password} sai → 409 WRONG_PASSWORD (không xóa); đúng → 200 deleted', async () => {
    const { db, banks } = makeFakeDb(['CONFIG_BANK_MANAGE']);
    __setDbForTest(db);
    const bad = await request(buildApp()).delete('/v1/banks').set('Cookie', COOKIE).send({ ids: [1], password: 'sai' });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe('WRONG_PASSWORD');
    expect(banks[0]!.deletedAt).toBeNull();

    const ok = await request(buildApp()).delete('/v1/banks').set('Cookie', COOKIE).send({ ids: [1], password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.deleted).toBe(1);
  });

  it('bank: GET /v1/partner-bank-matrix → 200', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_BANK_VIEW']).db);
    const res = await request(buildApp()).get('/v1/partner-bank-matrix').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.some((r: { partnerCode: string }) => r.partnerCode === 'DTA')).toBe(true);
  });

  it('bank: PUT /v1/partners/:id/banks (partnerBank:set) → 200 linked', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_BANK_MANAGE']).db);
    const res = await request(buildApp()).put('/v1/partners/5/banks').set('Cookie', COOKIE).send({ bankIds: [1] });
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(1);
  });

  it('fee: GET /v1/fee-types → 200; DELETE sai mật khẩu → 409, đúng → 200', async () => {
    const { db, feeTypes } = makeFakeDb(['CONFIG_FEE_VIEW', 'CONFIG_FEE_MANAGE']);
    __setDbForTest(db);
    const list = await request(buildApp()).get('/v1/fee-types').set('Cookie', COOKIE);
    expect(list.status).toBe(200);
    expect(list.body.data[0].name).toBe('Ủy quyền');

    const bad = await request(buildApp()).delete('/v1/fee-types').set('Cookie', COOKIE).send({ ids: [2], password: 'sai' });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe('WRONG_PASSWORD');
    expect(feeTypes[0]!.deletedAt).toBeNull();

    const ok = await request(buildApp()).delete('/v1/fee-types').set('Cookie', COOKIE).send({ ids: [2], password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.deleted).toBe(1);
  });

  it('fee: GET /v1/fee-rates (rỗng) → 200; GET /v1/fee-sell-quotes thiếu tham số → 400 VALIDATION', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_FEE_VIEW']).db);
    const rates = await request(buildApp()).get('/v1/fee-rates').set('Cookie', COOKIE);
    expect(rates.status).toBe(200);
    expect(rates.body.data).toEqual([]);

    const sq = await request(buildApp()).get('/v1/fee-sell-quotes').set('Cookie', COOKIE);
    expect(sq.status).toBe(400);
    expect(sq.body.error).toBe('VALIDATION');
  });

  it('tid: GET /v1/tid-statuses → 200; DELETE sai mật khẩu → 409', async () => {
    const { db } = makeFakeDb(['CONFIG_TID_VIEW', 'CONFIG_TID_MANAGE']);
    __setDbForTest(db);
    const list = await request(buildApp()).get('/v1/tid-statuses').set('Cookie', COOKIE);
    expect(list.status).toBe(200);
    expect(list.body.data[0].name).toBe('Đang chạy');

    const bad = await request(buildApp()).delete('/v1/tid-statuses').set('Cookie', COOKIE).send({ ids: [3], password: 'sai' });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe('WRONG_PASSWORD');
  });

  it('tid: GET /v1/tid-configs → 200 (rỗng)', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_TID_VIEW']).db);
    const res = await request(buildApp()).get('/v1/tid-configs').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('tid: KHÔNG có DELETE /v1/tid-configs (R34) → 404 Route không tồn tại', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_TID_MANAGE']).db);
    const res = await request(buildApp()).delete('/v1/tid-configs').set('Cookie', COOKIE).send({ ids: [1], password: PASSWORD });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});
