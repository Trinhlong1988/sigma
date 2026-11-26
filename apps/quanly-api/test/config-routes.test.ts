// Route adapter cho 4 màn cấu hình (industry / cash-category / settings / status-option) qua supertest. KHÔNG
// dựa vào app.ts (LEAD gom mount sau) → dựng 1 express app CỤC BỘ mount 4 router mới + cookieParser + json +
// errorHandler, bơm Db giả in-memory (__setDbForTest). Kiểm: 401 không phiên, 403 thiếu quyền, 200 có quyền,
// DELETE bề mặt (industry body {ids,password}, status-options/:id). Middleware requireQlSession + core chạy THẬT.
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { rawPhienStub } from './_raw-phien.js';
import type { Db } from '@sigma/database';
import { hashPassword } from '@sigma/business-rules';
import { __setDbForTest } from '../src/db.js';
import { errorHandler } from '../src/app.js';
import { industryRouter } from '../src/routes/industry.js';
import { cashCategoryRouter } from '../src/routes/cash-category.js';
import { settingsRouter } from '../src/routes/settings.js';
import { statusOptionRouter } from '../src/routes/status-option.js';

const PASSWORD = 'matkhau-dung-123';
const PW_HASH = hashPassword(PASSWORD);
const COOKIE = 'ql_session=sess-1';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(industryRouter);
  app.use(cashCategoryRouter);
  app.use(settingsRouter);
  app.use(statusOptionRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Route không tồn tại.' }));
  app.use(errorHandler);
  return app;
}

function makeFakeDb(permissions: string[]) {
  const user = {
    id: 7, username: 'nhanvien', fullName: 'Nhân Viên', status: 'ACTIVE', deletedAt: null, forceChangePassword: false,
    passwordHash: PW_HASH,
    roles: [{ role: { code: 'R', status: 'ACTIVE', permissions: permissions.map((c) => ({ permission: { code: c } })) } }]
  };
  const sessions = [{ id: 'sess-1', userId: 7, expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() }];
  const industries = [{ id: 1, code: 'NGH01', name: 'Bán lẻ', active: true, note: null, createdBy: 7, createdAt: new Date('2026-01-01'), updatedBy: null, updatedAt: new Date('2026-01-01'), deletedAt: null as Date | null, deletedBy: null as number | null }];
  const settings = [{ key: 'theme', value: 'light' }];
  const statusOptions = [{ id: 1, entity: 'CUSTOMER', code: 'ACTIVE', label: 'Đang hoạt động', tone: 'emerald', isBuiltin: true, sortOrder: 0, active: true, createdBy: null, createdAt: new Date('2026-01-01'), updatedBy: null, updatedAt: new Date('2026-01-01'), deletedAt: null as Date | null, deletedBy: null as number | null }];
  const cats = [{ id: 1, kind: 'THU', name: 'Doanh thu', unit: null, periodType: 'NONE', sourceKind: 'MANUAL', affectsPnl: true, isSystem: false, active: true, createdBy: 7, createdAt: new Date('2026-01-01'), updatedBy: null, updatedAt: new Date('2026-01-01'), deletedAt: null as Date | null, deletedBy: null as number | null }];
  const audits: Record<string, unknown>[] = [];

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
    industry: {
      findMany: async () => industries.filter((i) => i.deletedAt === null).map((i) => ({ ...i })),
      findUnique: async ({ where }: { where: { id: number } }) => industries.find((i) => i.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const i = industries.find((x) => x.id === where.id)!; Object.assign(i, data); return { ...i }; }
    },
    appSetting: {
      findMany: async () => settings.map((s) => ({ ...s })),
      findUnique: async ({ where }: { where: { key: string } }) => settings.find((s) => s.key === where.key) ?? null,
      upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
        const s = settings.find((x) => x.key === where.key);
        if (s) { s.value = update.value; return { ...s }; }
        settings.push({ ...create }); return { ...create };
      }
    },
    statusOption: {
      findMany: async ({ where }: { where?: Record<string, unknown> }) => {
        const w = where ?? {};
        return statusOptions.filter((s) => s.deletedAt === null && (w['entity'] === undefined || s.entity === w['entity']) && (w['active'] === undefined || s.active === w['active'])).map((s) => ({ ...s }));
      },
      findUnique: async ({ where }: { where: { id: number } }) => statusOptions.find((s) => s.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const s = statusOptions.find((x) => x.id === where.id)!; Object.assign(s, data); return { ...s }; }
    },
    cashCategory: {
      findMany: async () => cats.filter((c) => c.deletedAt === null).map((c) => ({ ...c })),
      findUnique: async ({ where }: { where: { id: number } }) => cats.find((c) => c.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const c = cats.find((x) => x.id === where.id)!; Object.assign(c, data); return { ...c }; }
    },
    cashEntry: { count: async () => 0 },
    customer: { count: async () => 0 },
    bank: { count: async () => 0 },
    partner: { count: async () => 0 },
    posDevice: { count: async () => 0 },
    dossier: { count: async () => 0 },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) }
  };
  return { db: fake as unknown as Db, industries, settings, statusOptions, cats, audits };
}

afterEach(() => __setDbForTest(null));

describe('4 route cấu hình — adapter API', () => {
  it('industry: không cookie → 401 NO_SESSION', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_INDUSTRY_VIEW']).db);
    const res = await request(buildApp()).get('/v1/industries');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('NO_SESSION');
  });

  it('industry: có quyền → 200 list; thiếu quyền → 403', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_INDUSTRY_VIEW']).db);
    const ok = await request(buildApp()).get('/v1/industries').set('Cookie', COOKIE);
    expect(ok.status).toBe(200);
    expect(ok.body.data[0].code).toBe('NGH01');

    __setDbForTest(makeFakeDb([]).db);
    const forb = await request(buildApp()).get('/v1/industries').set('Cookie', COOKIE);
    expect(forb.status).toBe(403);
    expect(forb.body.error).toBe('FORBIDDEN');
  });

  it('industry: DELETE body {ids,password} sai mật khẩu → 409 WRONG_PASSWORD; đúng → 200', async () => {
    const { db, industries } = makeFakeDb(['CONFIG_INDUSTRY_DELETE']);
    __setDbForTest(db);
    const bad = await request(buildApp()).delete('/v1/industries').set('Cookie', COOKIE).send({ ids: [1], password: 'sai' });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe('WRONG_PASSWORD');
    expect(industries[0]!.deletedAt).toBeNull();

    const ok = await request(buildApp()).delete('/v1/industries').set('Cookie', COOKIE).send({ ids: [1], password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.deleted).toBe(1);
  });

  it('settings: GET list + PUT /:key upsert', async () => {
    const { db, settings } = makeFakeDb(['SYSTEM_SETTING_VIEW', 'SYSTEM_SETTING_UPDATE']);
    __setDbForTest(db);
    const list = await request(buildApp()).get('/v1/settings').set('Cookie', COOKIE);
    expect(list.status).toBe(200);
    expect(list.body.data[0].key).toBe('theme');

    const upd = await request(buildApp()).put('/v1/settings/theme').set('Cookie', COOKIE).send({ value: 'dark' });
    expect(upd.status).toBe(200);
    expect(settings[0]!.value).toBe('dark');
  });

  it('status-options: GET list (entity) + entities + DELETE builtin → 409', async () => {
    __setDbForTest(makeFakeDb(['SYSTEM_SETTING_UPDATE']).db);
    const list = await request(buildApp()).get('/v1/status-options?entity=CUSTOMER').set('Cookie', COOKIE);
    expect(list.status).toBe(200);
    expect(list.body.data[0].code).toBe('ACTIVE');

    const ents = await request(buildApp()).get('/v1/status-entities').set('Cookie', COOKIE);
    expect(ents.status).toBe(200);
    expect(ents.body.data.some((e: { entity: string }) => e.entity === 'CUSTOMER')).toBe(true);

    const del = await request(buildApp()).delete('/v1/status-options/1').set('Cookie', COOKIE);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('BUILTIN_LOCKED');
  });

  it('status-options: thiếu tham số entity → 400 VALIDATION', async () => {
    __setDbForTest(makeFakeDb(['SYSTEM_SETTING_UPDATE']).db);
    const res = await request(buildApp()).get('/v1/status-options').set('Cookie', COOKIE);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('cash-categories: có quyền → 200 list', async () => {
    __setDbForTest(makeFakeDb(['CASHCAT_VIEW']).db);
    const res = await request(buildApp()).get('/v1/cash-categories').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.data[0].name).toBe('Doanh thu');
  });

  it('cash-categories: DELETE body {ids,password} sai mật khẩu → 409 WRONG_PASSWORD; đúng → 200', async () => {
    const { db, cats } = makeFakeDb(['CASHCAT_DELETE']);
    __setDbForTest(db);
    const bad = await request(buildApp()).delete('/v1/cash-categories').set('Cookie', COOKIE).send({ ids: [1], password: 'sai' });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe('WRONG_PASSWORD');
    expect(cats[0]!.deletedAt).toBeNull();

    const ok = await request(buildApp()).delete('/v1/cash-categories').set('Cookie', COOKIE).send({ ids: [1], password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.deleted).toBe(1);
  });
});
