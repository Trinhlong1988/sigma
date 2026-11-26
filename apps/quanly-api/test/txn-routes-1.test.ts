// Route /v1/tids + /v1/transactions + /v1/debt qua supertest + Db giả in-memory (__setDbForTest) — KHÔNG cần
// Postgres. app.ts do LEAD mount (chưa mount tidRouter/transactionRouter lúc viết) → dựng app TEST tự mount 2
// router MỚI + cookieParser + errorHandler (cùng chuỗi middleware createApp). Kiểm: 401 không phiên, 403 thiếu
// quyền, 400 validation, R34 KHÔNG expose DELETE /v1/tids (404), DELETE giao dịch + write-off verify password ở
// ADAPTER (409 WRONG_PASSWORD khi sai). ASSERT status + error cụ thể.
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '@sigma/database';
import { errorHandler } from '../src/app.js';
import { makeFakeDb as buildFakeDb } from './_fake-db.js';
import { tidRouter } from '../src/routes/tid.js';
import { transactionRouter } from '../src/routes/transaction.js';
import { __setDbForTest } from '../src/db.js';

const PASSWORD = 'MatKhau@123';
const PASS_HASH = bcrypt.hashSync(PASSWORD, 8);

function testApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(tidRouter);
  app.use(transactionRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Route không tồn tại.' }));
  app.use(errorHandler);
  return app;
}

interface FakeRoleLink { role: { code: string; status: string; permissions: { permission: { code: string } }[] } }
function seedUser(permissions: string[]) {
  return {
    id: 7, username: 'nhanvien', fullName: 'Nhân Viên', status: 'ACTIVE', deletedAt: null, forceChangePassword: false,
    passwordHash: PASS_HASH,
    roles: [{ role: { code: 'R', status: 'ACTIVE', permissions: permissions.map((c) => ({ permission: { code: c } })) } }] as FakeRoleLink[]
  };
}

function makeFakeDb(permissions: string[], over: Record<string, unknown> = {}) {
  const user = seedUser(permissions);
  const audits: Record<string, unknown>[] = [];
  const sessions = [{ id: 'sess-1', userId: user.id, expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() }];
  const emptyMany = { findMany: async () => [], count: async () => 0 }; // FIX-PERF B132: listTids nay gọi count.
  // Shared factory stub SẴN 87 model (thêm join model mới KHÔNG 500 test); `over` giữ nguyên khả năng override lẻ.
  const db = buildFakeDb({
    user: {
      findUnique: async ({ where }: { where: { id: number } }) => (where.id === user.id ? { ...user } : null),
      findUniqueOrThrow: async ({ where }: { where: { id: number } }) => {
        if (where.id !== user.id) throw new Error('user not found');
        return JSON.parse(JSON.stringify(user));
      },
      // B132 #1: verifyActorPassword sai → registerActorReauthFail dùng user.updateMany (feed lockout). Mock khớp shape Prisma.
      updateMany: async ({ where, data }: { where: { id?: number; status?: { notIn?: string[] } }; data: Record<string, unknown> }) => {
        const u = user as unknown as Record<string, unknown>;
        if (where.id !== undefined && where.id !== u.id) return { count: 0 };
        if (where.status?.notIn && where.status.notIn.includes(u.status as string)) return { count: 0 };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as object)) u[k] = ((u[k] as number) ?? 0) + ((v as { increment: number }).increment ?? 0);
          else u[k] = v;
        }
        return { count: 1 };
      }
    },
    loginSession: {
      findUnique: async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null,
      update: async () => ({}),
      deleteMany: async () => ({ count: 0 })
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) },
    // maps join rỗng dùng chung listTids/list/debt.
    tid: emptyMany, bank: emptyMany, partner: emptyMany, tidConfigStatus: emptyMany, dossierSource: emptyMany,
    customer: emptyMany, agent: emptyMany, industry: emptyMany, cardType: emptyMany, feeType: emptyMany,
    // Phase B + P4 — buildTidMaps nay join thêm: TK nhận tiền + uỷ NĐT + khách có nhóm chat + TID có giá bán thực tế.
    receiveAccount: emptyMany, investor: emptyMany, customerChatGroup: emptyMany, tidSellFee: emptyMany,
    transaction: { findMany: async () => [] },
    cashDebtSettlement: { groupBy: async () => [] },
    ...over
  });
  return { db, audits };
}

const COOKIE = 'ql_session=sess-1';
afterEach(() => __setDbForTest(null));

describe('/v1/tids — adapter API', () => {
  it('không cookie phiên → 401 NO_SESSION', async () => {
    __setDbForTest(makeFakeDb(['TID_VIEW']).db);
    const res = await request(testApp()).get('/v1/tids');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('NO_SESSION');
  });

  it('có phiên + TID_VIEW → 200 list', async () => {
    __setDbForTest(makeFakeDb(['TID_VIEW']).db);
    const res = await request(testApp()).get('/v1/tids').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it('thiếu quyền xem → 403 FORBIDDEN', async () => {
    __setDbForTest(makeFakeDb([]).db);
    const res = await request(testApp()).get('/v1/tids').set('Cookie', COOKIE);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('POST /v1/tids thiếu ngân hàng → 400 VALIDATION', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_TID_MANAGE'], { tid: { findUnique: async () => null, findFirst: async () => null } }).db);
    const res = await request(testApp()).post('/v1/tids').set('Cookie', COOKIE).send({ tid: 'T1', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
    expect(res.body.message).toBe('Vui lòng chọn ngân hàng.');
  });

  it('POST /v1/tids/:tid/assign thiếu quyền TID_MANAGE → 403', async () => {
    __setDbForTest(makeFakeDb([]).db);
    const res = await request(testApp()).post('/v1/tids/T1/assign').set('Cookie', COOKIE).send({ posSerial: 'S1', customerId: 7 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  // R34 — KHÔNG expose DELETE /v1/tids/:tid (desktop ipc.ts không có tid:delete; vòng đời đóng bằng recall/replace).
  it('DELETE /v1/tids/:tid KHÔNG tồn tại → 404 (R34)', async () => {
    __setDbForTest(makeFakeDb(['TID_MANAGE']).db);
    const res = await request(testApp()).delete('/v1/tids/T1').set('Cookie', COOKIE);
    expect(res.status).toBe(404);
  });
});

describe('/v1/transactions + /v1/debt — adapter API', () => {
  it('GET /v1/debt/summary có DEBT_VIEW → 200', async () => {
    __setDbForTest(makeFakeDb(['DEBT_VIEW']).db);
    const res = await request(testApp()).get('/v1/debt/summary').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.data.debtTotal).toBe(0);
  });

  it('DELETE /v1/transactions sai mật khẩu → 409 WRONG_PASSWORD (verify ở ADAPTER)', async () => {
    __setDbForTest(makeFakeDb(['REVENUE_MANAGE']).db);
    const res = await request(testApp()).delete('/v1/transactions').set('Cookie', COOKIE).send({ ids: [1], password: 'SAI' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('WRONG_PASSWORD');
  });

  it('DELETE /v1/transactions đúng mật khẩu → 200 (lõi xóa mềm)', async () => {
    const rows = [{ id: 1, code: 'GD00001', amount: 1000, revenueAmount: 30, deletedAt: null }];
    const over = {
      transaction: {
        findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r.id === where.id) ?? null,
        update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = rows.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; }
      }
    };
    __setDbForTest(makeFakeDb(['REVENUE_MANAGE'], over).db);
    const res = await request(testApp()).delete('/v1/transactions').set('Cookie', COOKIE).send({ ids: [1], password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
  });

  it('POST /v1/debt/write-off sai mật khẩu → 409 WRONG_PASSWORD', async () => {
    __setDbForTest(makeFakeDb(['DEBT_WRITEOFF']).db);
    const res = await request(testApp()).post('/v1/debt/write-off').set('Cookie', COOKIE).send({ transactionId: 1, actorPassword: 'SAI' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('WRONG_PASSWORD');
  });
});
