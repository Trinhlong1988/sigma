// Route adapter upload/download ảnh đính kèm (dossier + receive-account) qua supertest — multipart .attach()
// (busboy parse), Db giả in-memory (__setDbForTest) + kho file TMP (SIGMA_FILE_STORE, KHÔNG đụng D:/alpha-files).
// Kiểm: 401 không phiên, 403 thiếu quyền, POST upload 200 + lưu path DB, GET tải về đúng Content-Type + bytes,
// field sai → 400, nội dung .exe → 400 BAD_CONTENT. requireQlSession + core chạy THẬT.
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rawPhienStub } from './_raw-phien.js';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@sigma/database';
import { __setDbForTest } from '../src/db.js';
import { errorHandler } from '../src/app.js';
import { dossierRouter } from '../src/routes/dossier.js';
import { receiveAccountRouter } from '../src/routes/receive-account.js';

const COOKIE = 'ql_session=sess-1';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(dossierRouter);
  app.use(receiveAccountRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Route không tồn tại.' }));
  app.use(errorHandler);
  return app;
}

interface Row { id: number; deletedAt: Date | null; [k: string]: unknown }
function makeTable(seed: Row[]) {
  const rows = seed.map((r) => ({ ...r }));
  return {
    rows,
    findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r.id === where.id) ?? null,
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = rows.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; }
  };
}

function makeFakeDb(permissions: string[]) {
  const user = {
    id: 7, username: 'nhanvien', fullName: 'Nhân Viên', status: 'ACTIVE', deletedAt: null, forceChangePassword: false,
    roles: [{ role: { code: 'R', status: 'ACTIVE', permissions: permissions.map((c) => ({ permission: { code: c } })) } }]
  };
  const sessions = [{ id: 'sess-1', userId: 7, expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() }];
  const dossier = makeTable([{ id: 1, hkdName: 'Quán A', ownerName: 'Chủ A', deletedAt: null, updatedBy: null, dkkdFrontPath: null, dkkdFrontName: null, dkkdBackPath: null, dkkdBackName: null, cccdFrontPath: null, cccdFrontName: null, cccdBackPath: null, cccdBackName: null } as Row]);
  const receiveAccount = makeTable([{ id: 1, accountName: 'Chủ TK', deletedAt: null, updatedBy: null, cccdFrontPath: null, cccdFrontName: null, cccdBackPath: null, cccdBackName: null } as Row]);
  const fake = {
    // [13/11] auth.ts ghi/chạm/đo phiên bằng SQL THÔ (băm phiên 12/11) — thiếu stub là login nổ 500,
    // kéo cả file đỏ CÂM. Stub dùng chung, câu lạ thì NÉM LỖI chứ không trả rỗng.
    ...rawPhienStub(sessions),
    user: {
      findUnique: async ({ where }: { where: { id: number } }) => (where.id === 7 ? { ...user } : null),
      findUniqueOrThrow: async ({ where }: { where: { id: number } }) => { if (where.id !== 7) throw new Error('no user'); return JSON.parse(JSON.stringify(user)); },
      findMany: async () => [{ id: 7, fullName: 'Nhân Viên', username: 'nhanvien' }]
    },
    loginSession: {
      findUnique: async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null,
      update: async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null,
      deleteMany: async () => ({ count: 0 })
    },
    dossier, receiveAccount,
    auditLog: { create: async () => ({}) },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) }
  };
  return { db: fake as unknown as Db, dossier, receiveAccount };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'alpha-route-fs-'));
  process.env['SIGMA_FILE_STORE'] = root;
});
afterEach(() => {
  __setDbForTest(null);
  delete process.env['SIGMA_FILE_STORE'];
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('dossier attachment route', () => {
  it('POST không cookie → 401', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_DOSSIER_MANAGE']).db);
    const res = await request(buildApp()).post('/v1/dossiers/1/attachment').attach('dkkdFront', PNG, 'a.png');
    expect(res.status).toBe(401);
  });

  it('POST thiếu quyền → 403', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_DOSSIER_VIEW']).db);
    const res = await request(buildApp()).post('/v1/dossiers/1/attachment').set('Cookie', COOKIE).attach('dkkdFront', PNG, 'a.png');
    expect(res.status).toBe(403);
  });

  it('POST upload PNG hợp lệ → 200 + lưu path vào DB; GET tải về đúng Content-Type + bytes', async () => {
    const f = makeFakeDb(['CONFIG_DOSSIER_MANAGE', 'CONFIG_DOSSIER_VIEW']);
    __setDbForTest(f.db);
    const up = await request(buildApp()).post('/v1/dossiers/1/attachment').set('Cookie', COOKIE).attach('dkkdFront', PNG, 'dkkd.png');
    expect(up.status).toBe(200);
    expect(up.body.ok).toBe(true);
    expect((f.dossier.rows[0]!.dkkdFrontPath as string).startsWith('dossiers/1/')).toBe(true);

    const dl = await request(buildApp()).get('/v1/dossiers/1/attachment/dkkdFront').set('Cookie', COOKIE);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(dl.body, PNG)).toBe(0);
  });

  it('POST field không hợp lệ → 400 VALIDATION', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_DOSSIER_MANAGE']).db);
    const res = await request(buildApp()).post('/v1/dossiers/1/attachment').set('Cookie', COOKIE).attach('avatar', PNG, 'a.png');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('POST nội dung .exe đổi đuôi → 400 BAD_CONTENT', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_DOSSIER_MANAGE']).db);
    const res = await request(buildApp()).post('/v1/dossiers/1/attachment').set('Cookie', COOKIE).attach('dkkdFront', EXE, 'a.png');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BAD_CONTENT');
  });

  it('GET khi chưa có ảnh → 404', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_DOSSIER_VIEW']).db);
    const res = await request(buildApp()).get('/v1/dossiers/1/attachment/cccdBack').set('Cookie', COOKIE);
    expect(res.status).toBe(404);
  });
});

describe('receive-account attachment route', () => {
  it('POST upload + GET tải về CCCD mặt trước', async () => {
    const f = makeFakeDb(['CONFIG_RCV_ACCT_MANAGE', 'CONFIG_RCV_ACCT_VIEW']);
    __setDbForTest(f.db);
    const up = await request(buildApp()).post('/v1/receive-accounts/1/attachment').set('Cookie', COOKIE).attach('cccdFront', PNG, 'cccd.png');
    expect(up.status).toBe(200);
    expect((f.receiveAccount.rows[0]!.cccdFrontPath as string).startsWith('receive-accounts/1/')).toBe(true);

    const dl = await request(buildApp()).get('/v1/receive-accounts/1/attachment/cccdFront').set('Cookie', COOKIE);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(dl.body, PNG)).toBe(0);
  });
});
