// Route adapter cho 4 domain thuần-server-2 (dossier / receive-account / bill-explain / import) qua supertest.
// Dựng 1 express app CỤC BỘ mount 4 router mới + cookieParser + json + errorHandler, bơm Db giả in-memory
// (__setDbForTest). Kiểm: 401 không phiên, 403 thiếu quyền, 200 có quyền, DELETE body {ids,password} sai/đúng mật
// khẩu, POST create, import run (partial). Middleware requireQlSession + core chạy THẬT.
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { rawPhienStub } from './_raw-phien.js';
import type { Db } from '@sigma/database';
import { hashPassword } from '@sigma/business-rules';
import { __setDbForTest } from '../src/db.js';
import { errorHandler } from '../src/app.js';
import { dossierRouter } from '../src/routes/dossier.js';
import { receiveAccountRouter } from '../src/routes/receive-account.js';
import { billExplainRouter } from '../src/routes/bill-explain.js';
import { importRouter } from '../src/routes/import.js';

const PASSWORD = 'matkhau-dung-123';
const PW_HASH = hashPassword(PASSWORD);
const COOKIE = 'ql_session=sess-1';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(dossierRouter);
  app.use(receiveAccountRouter);
  app.use(billExplainRouter);
  app.use(importRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Route không tồn tại.' }));
  app.use(errorHandler);
  return app;
}

interface Row { id: number; deletedAt: Date | null; [k: string]: unknown }
function makeTable(seed: Row[]) {
  const rows = seed.map((r) => ({ ...r }));
  let nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  return {
    rows,
    findMany: async (args?: { where?: Record<string, unknown> }) => {
      const w = args?.where ?? {};
      return rows.filter((r) => (!('deletedAt' in w) || r.deletedAt === (w['deletedAt'] ?? null))).map((r) => ({ ...r }));
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const not = where['NOT'] as { id?: number } | undefined;
      return rows.find((r) => (where['code'] === undefined || r.code === where['code']) && (where['name'] === undefined || r.name === where['name']) && (!not || r.id !== not.id)) ?? null;
    },
    findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r.id === where.id) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: nextId++, deletedAt: null, updatedBy: null, createdAt: new Date(), updatedAt: new Date(), ...data } as Row; rows.push(row); return { ...row }; },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = rows.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; },
    count: async () => 0
  };
}

function makeFakeDb(permissions: string[]) {
  const user = {
    id: 7, username: 'nhanvien', fullName: 'Nhân Viên', status: 'ACTIVE', deletedAt: null, forceChangePassword: false,
    passwordHash: PW_HASH,
    roles: [{ role: { code: 'R', status: 'ACTIVE', permissions: permissions.map((c) => ({ permission: { code: c } })) } }]
  };
  const sessions = [{ id: 'sess-1', userId: 7, expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() }];
  const dossierSource = makeTable([{ id: 1, code: 'NG1', discountRate: 0, deletedAt: null, createdBy: 7, updatedBy: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }]);
  const dossier = makeTable([{ id: 1, sourceId: 1, hkdName: 'Quán A', ownerName: 'Chủ A', mstStatus: 'ACTIVE', taxCode: null, hkdAddress: null, dkkdIssueDate: null, dkkdIssuePlace: null, gender: null, ethnicity: null, cccdNumber: null, cccdIssueDate: null, cccdIssuePlace: null, cccdExpiry: null, permanentAddress: null, currentAddress: null, email: null, note: null, dkkdFrontPath: null, dkkdFrontName: null, dkkdBackPath: null, dkkdBackName: null, cccdFrontPath: null, cccdFrontName: null, cccdBackPath: null, cccdBackName: null, deletedAt: null, createdBy: 7, updatedBy: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }]);
  const product = makeTable([{ id: 1, industryId: 1, name: 'SP', unit: 'cái', price: 1000, priority: 0, status: 'ACTIVE', deletedAt: null, createdBy: 7, updatedBy: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }]);
  const industry = makeTable([{ id: 1, name: 'Bán lẻ', active: true, deletedAt: null } as Row]);
  const billExplain = makeTable([{ id: 1, code: 'BE00001', dossierId: 1, tidId: null, industryId: 1, billDate: new Date('2026-03-01'), totalAmount: 1000000n, billCount: 2, filePath: '/x/y.xlsx', createdBy: 7, deletedAt: null, createdAt: new Date('2026-03-01') } as Row]);
  const tid = makeTable([]);
  const bank = makeTable([{ id: 1, code: 'EIB', name: 'Ngân hàng Exim', deletedAt: null } as Row]);
  const customer = makeTable([]);
  const receiveAccountSource = makeTable([{ id: 1, name: 'Nguồn A', deletedAt: null, createdBy: 7, updatedBy: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }]);
  const receiveAccount = makeTable([]);
  const audits: Record<string, unknown>[] = [];

  // R201 — AppSetting (số HĐ) + codeCounter (nextCode) + $transaction/$executeRawUnsafe cho reserve/record bill.
  const settingsStore = new Map<string, string>();
  const appSetting = {
    findUnique: async ({ where }: { where: { key: string } }) => (settingsStore.has(where.key) ? { key: where.key, value: settingsStore.get(where.key)! } : null),
    upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
      settingsStore.set(where.key, settingsStore.has(where.key) ? update.value : create.value);
      return { key: where.key, value: settingsStore.get(where.key)! };
    }
  };
  const countersStore = new Map<string, number>();
  const codeCounter = {
    upsert: async ({ where, create, update }: { where: { prefix: string }; create: { prefix: string; lastValue: number }; update: { lastValue: { increment: number } } }) => {
      const cur = countersStore.get(where.prefix);
      const val = cur === undefined ? create.lastValue : cur + (update.lastValue.increment ?? 0);
      countersStore.set(where.prefix, val);
      return { prefix: where.prefix, lastValue: val };
    }
  };

  const fake = {
    // [13/11] auth.ts ghi/chạm/đo phiên bằng SQL THÔ (băm phiên 12/11) — thiếu stub là login nổ 500,
    // kéo cả file đỏ CÂM. Stub dùng chung, câu lạ thì NÉM LỖI chứ không trả rỗng.
    ...rawPhienStub(sessions),
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
    dossierSource, dossier, product, industry, billExplain, tid, bank, customer, receiveAccountSource, receiveAccount,
    appSetting, codeCounter,
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) },
    $executeRawUnsafe: async () => 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(fake)
  };
  return { db: fake as unknown as Db, dossierSource, dossier, product, billExplain, receiveAccountSource, audits, settingsStore };
}

afterEach(() => __setDbForTest(null));

describe('4 route thuần-server-2 — adapter API', () => {
  it('dossier-sources: không cookie → 401', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_DOSSIER_VIEW']).db);
    const res = await request(buildApp()).get('/v1/dossier-sources');
    expect(res.status).toBe(401);
  });

  it('dossier-sources: có quyền → 200; thiếu quyền → 403', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_DOSSIER_VIEW']).db);
    const ok = await request(buildApp()).get('/v1/dossier-sources').set('Cookie', COOKIE);
    expect(ok.status).toBe(200);
    expect(ok.body.data[0].code).toBe('NG1');

    __setDbForTest(makeFakeDb([]).db);
    const forb = await request(buildApp()).get('/v1/dossier-sources').set('Cookie', COOKIE);
    expect(forb.status).toBe(403);
    expect(forb.body.error).toBe('FORBIDDEN');
  });

  it('dossier-sources: POST tạo hợp lệ → 200 + audit', async () => {
    const f = makeFakeDb(['CONFIG_DOSSIER_MANAGE']);
    __setDbForTest(f.db);
    const res = await request(buildApp()).post('/v1/dossier-sources').set('Cookie', COOKIE).send({ code: 'NG9', discountRate: 2.5 });
    expect(res.status).toBe(200);
    expect(f.dossierSource.rows.find((r) => r.code === 'NG9')!.discountRate).toBe(2500);
  });

  it('dossiers: DELETE sai mật khẩu → 409 WRONG_PASSWORD; đúng → 200 soft-delete', async () => {
    const f = makeFakeDb(['CONFIG_DOSSIER_MANAGE']);
    __setDbForTest(f.db);
    const wrong = await request(buildApp()).delete('/v1/dossiers').set('Cookie', COOKIE).send({ ids: [1], password: 'sai' });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toBe('WRONG_PASSWORD');

    const ok = await request(buildApp()).delete('/v1/dossiers').set('Cookie', COOKIE).send({ ids: [1], password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(f.dossier.rows.find((r) => r.id === 1)!.deletedAt).not.toBeNull();
  });

  it('products: GET 200 có quyền; POST import 200 partial', async () => {
    const f = makeFakeDb(['BILLEXPLAIN_VIEW', 'PRODUCT_MANAGE']);
    __setDbForTest(f.db);
    const list = await request(buildApp()).get('/v1/products').set('Cookie', COOKIE);
    expect(list.status).toBe(200);
    expect(list.body.data[0].name).toBe('SP');

    const imp = await request(buildApp()).post('/v1/products/import').set('Cookie', COOKIE)
      .send({ industryId: 1, rows: [{ name: 'SP2', unit: 'cái', price: '45.000' }, { name: '', unit: 'cái', price: 1 }] });
    expect(imp.status).toBe(200);
    expect(imp.body.imported).toBe(1);
    expect(imp.body.skipped).toBe(1);
  });

  it('bill-explains: GET 200 resolve tên HKD', async () => {
    __setDbForTest(makeFakeDb(['BILLEXPLAIN_VIEW']).db);
    const res = await request(buildApp()).get('/v1/bill-explains').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.data[0].dossierName).toBe('Quán A');
    expect(res.body.data[0].totalAmount).toBe(1000000);
  });

  // ── R201 (dead-IPC) — Bill giải trình: config (C) + reserve/record (D) ──
  it('bill-explain config: GET 200 (VIEW) mặc định billNoStart 1; thiếu quyền → 403', async () => {
    __setDbForTest(makeFakeDb(['BILLEXPLAIN_VIEW']).db);
    const ok = await request(buildApp()).get('/v1/bill-explain/config').set('Cookie', COOKIE);
    expect(ok.status).toBe(200);
    expect(ok.body.data.billNoStart).toBe(1);
    expect(ok.body.data.templateCustomPath).toBeNull();

    __setDbForTest(makeFakeDb([]).db);
    const forb = await request(buildApp()).get('/v1/bill-explain/config').set('Cookie', COOKIE);
    expect(forb.status).toBe(403);
  });

  it('bill-explain config: PUT (CREATE) ghi số HĐ vào AppSetting', async () => {
    const f = makeFakeDb(['BILLEXPLAIN_CREATE', 'BILLEXPLAIN_VIEW']);
    __setDbForTest(f.db);
    const res = await request(buildApp()).put('/v1/bill-explain/config').set('Cookie', COOKIE).send({ billNoStart: 500, billNoYear: 2027 });
    expect(res.status).toBe(200);
    expect(f.settingsStore.get('billexplain.billNoStart')).toBe('500');
    expect(f.settingsStore.get('billexplain.billNoYear')).toBe('2027');
  });

  it('bill-explain reserve: POST (CREATE) → 200 cấp dải số + trả dossier/products/targets; thiếu quyền → 403', async () => {
    const f = makeFakeDb(['BILLEXPLAIN_CREATE']);
    __setDbForTest(f.db);
    const res = await request(buildApp()).post('/v1/bill-explain/reserve').set('Cookie', COOKIE)
      .send({ dossierId: 1, industryId: 1, billDate: '2026-07-16', targets: ['1000000', '2000000'] });
    expect(res.status).toBe(200);
    expect(res.body.billNoStart).toBe(1);
    expect(res.body.count).toBe(2);
    expect(res.body.targets).toEqual([1000000, 2000000]);
    expect(res.body.dossier.hkdName).toBe('Quán A');
    expect(f.settingsStore.get('billexplain.billNoStart')).toBe('3'); // con trỏ tiến 1+2

    __setDbForTest(makeFakeDb([]).db);
    const forb = await request(buildApp()).post('/v1/bill-explain/reserve').set('Cookie', COOKIE)
      .send({ dossierId: 1, industryId: 1, billDate: '2026-07-16', targets: ['1000000'] });
    expect(forb.status).toBe(403);
  });

  it('bill-explain record: POST (CREATE) → 200 tạo bản ghi + code BE##', async () => {
    const f = makeFakeDb(['BILLEXPLAIN_CREATE']);
    __setDbForTest(f.db);
    const res = await request(buildApp()).post('/v1/bill-explain/record').set('Cookie', COOKIE)
      .send({ dossierId: 1, industryId: 1, billDate: '2026-07-16', totalAmount: '3000000', billCount: 2, filePath: '/out/Quán A.xlsx' });
    expect(res.status).toBe(200);
    expect(res.body.code).toMatch(/^BE/);
    expect(f.billExplain.rows.some((r) => r.filePath === '/out/Quán A.xlsx' && r.billCount === 2)).toBe(true);
  });

  it('bill-explain record: totalAmount phi-số → 400 VALIDATION', async () => {
    __setDbForTest(makeFakeDb(['BILLEXPLAIN_CREATE']).db);
    const res = await request(buildApp()).post('/v1/bill-explain/record').set('Cookie', COOKIE)
      .send({ dossierId: 1, industryId: 1, billDate: '2026-07-16', totalAmount: '1e6', billCount: 1, filePath: '/x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('receive-accounts: POST tạo hợp lệ → 200', async () => {
    const f = makeFakeDb(['CONFIG_RCV_ACCT_MANAGE']);
    __setDbForTest(f.db);
    const res = await request(buildApp()).post('/v1/receive-accounts').set('Cookie', COOKIE)
      .send({ sourceId: 1, accountName: 'Chủ TK', accountNumber: '0123', bankId: 1 });
    expect(res.status).toBe(200);
    expect(f.receiveAccountSource.rows.length).toBeGreaterThan(0);
  });

  it('import: template 200; run dossier tạo THẬT (partial)', async () => {
    const f = makeFakeDb(['CONFIG_DOSSIER_MANAGE']);
    __setDbForTest(f.db);
    const tpl = await request(buildApp()).get('/v1/import/template?entityKey=dossier').set('Cookie', COOKIE);
    expect(tpl.status).toBe(200);
    expect(tpl.body.data.some((c: { header: string }) => c.header === 'Tên HKD')).toBe(true);

    const run = await request(buildApp()).post('/v1/import/run').set('Cookie', COOKIE)
      .send({ entityKey: 'dossier', rows: [{ 'Nguồn': 'NG1', 'Tên HKD': 'Quán Import', 'Chủ hộ': 'Người A' }, { 'Nguồn': 'NG1', 'Tên HKD': 'Thiếu chủ hộ' }] });
    expect(run.status).toBe(200);
    expect(run.body.summary).toEqual({ created: 1, skipped: 1 });
    expect(f.dossier.rows.some((r) => r.hkdName === 'Quán Import')).toBe(true);
  });
});
