// Route adapter cho 4 màn nhóm B3 (DUYỆT HỦY bill / entity-cancel / export-request / trash) qua supertest. KHÔNG dựa
// app.ts (LEAD gom mount sau) → dựng express app CỤC BỘ mount 4 router mới + cookieParser + json + errorHandler, bơm Db
// giả in-memory (__setDbForTest). Kiểm: 401 không phiên, 403 thiếu quyền, 200 có quyền, DUYỆT {password} (§14) sai→409,
// DỌN SẠCH {level2Password} chưa đặt→LEVEL2_NOT_SET / sai→WRONG_LEVEL2. requireQlSession + core chạy THẬT.
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '@sigma/database';
import { hashPassword, hashLevel2 } from '@sigma/business-rules';
import { __setDbForTest } from '../src/db.js';
import { errorHandler } from '../src/app.js';
import { reauthRateLimiter } from '../src/routes/_ctx.js';
import { approvalRouter } from '../src/routes/approval.js';
import { entityCancelRouter } from '../src/routes/entity-cancel.js';
import { exportRequestRouter } from '../src/routes/export-request.js';
import { trashRouter } from '../src/routes/trash.js';

const PASSWORD = 'matkhau-dung-123';
const LEVEL2 = 'level2-dung-456';
const PW_HASH = hashPassword(PASSWORD);
const COOKIE = 'ql_session=sess-1';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(approvalRouter);
  app.use(entityCancelRouter);
  app.use(exportRequestRouter);
  app.use(trashRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Route không tồn tại.' }));
  app.use(errorHandler);
  return app;
}

const TRASH_KEYS = ['customer', 'agent', 'bank', 'cardType', 'partner', 'supplier', 'posModel', 'posIntakeStatus', 'posIntake', 'feeType', 'feeRate', 'receiveAccountSource', 'receiveAccount', 'dossierSource', 'dossier', 'tidConfigStatus', 'tid', 'transaction'];

function makeFakeDb(permissions: string[], opts: { level2?: boolean } = {}) {
  const user = {
    id: 7, username: 'admin', fullName: 'Admin', status: 'ACTIVE', deletedAt: null, forceChangePassword: false,
    passwordHash: PW_HASH, level2Hash: opts.level2 ? hashLevel2(LEVEL2) : null,
    roles: [{ role: { code: 'ADMIN', status: 'ACTIVE', permissions: permissions.map((c) => ({ permission: { code: c } })) } }]
  };
  const sessions = [{ id: 'sess-1', userId: 7, expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() }];
  const audits: Record<string, unknown>[] = [];
  const emptyTable = { findMany: async () => [], groupBy: async () => [], count: async () => 0, deleteMany: async () => ({ count: 0 }) };
  const fake: Record<string, unknown> = {
    user: {
      findUnique: async ({ where }: { where: { id: number } }) => (where.id === 7 ? { ...user } : null),
      findUniqueOrThrow: async ({ where }: { where: { id: number } }) => { if (where.id !== 7) throw new Error('no user'); return JSON.parse(JSON.stringify(user)); },
      // B132 #1: verify sai → registerActorReauthFail dùng user.updateMany (feed lockout). Mock phải khớp shape Prisma.
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
      // Áp data THẬT: requireQlSession nâng cấp phiên cũ sang id ĐÃ BĂM bằng update — mẫu giả nuốt data thì
      // câu SQL đo thời gian ngồi không sau đó tra bằng id băm sẽ không thấy phiên (lệch so với đời thật).
      update: async ({ where, data }: { where: { id: string }; data?: Record<string, unknown> }) => {
        const s = sessions.find((x) => x.id === where.id);
        if (!s) return null;
        if (data) Object.assign(s, data);
        return { ...s };
      },
      deleteMany: async () => ({ count: 0 })
    },
    // 2 câu SQL thô trên login_sessions mà requireQlSession dùng (tính bằng now() của DB để tránh lệch múi giờ).
    // SQL lạ thì NÉM LỖI kèm nguyên văn — cấm trả rỗng cho qua rồi test xanh suông (R198).
    $queryRawUnsafe: async (sql: string, ...args: unknown[]): Promise<unknown[]> => {
      if (/EXTRACT\(EPOCH FROM \(now\(\) - last_seen_at\)\)/i.test(sql)) {
        const s = sessions.find((x) => x.id === (args[0] as string));
        return s ? [{ giay: Math.floor((Date.now() - s.lastSeenAt.getTime()) / 1000) }] : [];
      }
      throw new Error('mẫu giả CHƯA hỗ trợ câu SQL này, bổ sung đi: ' + sql);
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]): Promise<number> => {
      if (/UPDATE login_sessions SET last_seen_at/i.test(sql)) {
        const s = sessions.find((x) => x.id === (args[0] as string));
        if (!s) return 0;
        s.lastSeenAt = new Date();
        return 1;
      }
      // [B317 24/11] emptyTrash xoá TID-không-còn-tiền qua raw SQL (DELETE FROM tids ... NOT EXISTS lo_rows).
      // Mock không có bảng tiền ⇒ coi như 0 TID đủ điều kiện (test chỉ khẳng định dọn sạch chạy + 200).
      if (/DELETE FROM tids/i.test(sql)) return 0;
      throw new Error('mẫu giả CHƯA hỗ trợ câu SQL này, bổ sung đi: ' + sql);
    },
    approvalRequest: { findMany: async () => [] },
    transaction: { findMany: async () => [] },
    exportRequest: { findMany: async () => [], groupBy: async () => [] },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({}) }
  };
  for (const k of TRASH_KEYS) fake[k] = { ...emptyTable, ...(fake[k] as Record<string, unknown> | undefined) };
  return { db: fake as unknown as Db, audits };
}

// reauthRateLimiter (5/phút/khóa=cookie phiên) nay áp CẢ approve/purge/empty của nhóm B3 → nhiều test dùng CHUNG
// COOKIE 'sess-1' sẽ cộng dồn budget và chạm 429. Reset khóa sau mỗi test để mỗi case kiểm đúng nghiệp vụ (không
// phải rate-limit). Production giữ nguyên 5/phút — chỉ test reset store.
afterEach(() => {
  __setDbForTest(null);
  (reauthRateLimiter as unknown as { resetKey: (k: string) => void }).resetKey('sess:sess-1');
});

describe('B3 route — session + permission gating', () => {
  it('approval list: không cookie → 401 NO_SESSION', async () => {
    __setDbForTest(makeFakeDb(['BILL_CANCEL_APPROVE']).db);
    const res = await request(buildApp()).get('/v1/cancel-requests');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('NO_SESSION');
  });

  it('approval list: có BILL_CANCEL_APPROVE → 200; thiếu → 403', async () => {
    __setDbForTest(makeFakeDb(['BILL_CANCEL_APPROVE']).db);
    const ok = await request(buildApp()).get('/v1/cancel-requests').set('Cookie', COOKIE);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);

    __setDbForTest(makeFakeDb([]).db);
    const forb = await request(buildApp()).get('/v1/cancel-requests').set('Cookie', COOKIE);
    expect(forb.status).toBe(403);
    expect(forb.body.error).toBe('FORBIDDEN');
  });

  it('entity-cancel list: thiếu quyền → 403; có TID_CANCEL_APPROVE → 200', async () => {
    __setDbForTest(makeFakeDb([]).db);
    const forb = await request(buildApp()).get('/v1/entity-cancel-requests').set('Cookie', COOKIE);
    expect(forb.status).toBe(403);

    __setDbForTest(makeFakeDb(['TID_CANCEL_APPROVE']).db);
    const ok = await request(buildApp()).get('/v1/entity-cancel-requests').set('Cookie', COOKIE);
    expect(ok.status).toBe(200);
  });

  it('export-request list: có EXPORT_REQUEST_VIEW → 200 (KPI)', async () => {
    __setDbForTest(makeFakeDb(['EXPORT_REQUEST_VIEW']).db);
    const res = await request(buildApp()).get('/v1/export-requests').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.kpi).toBeDefined();
  });

  it('trash list: có TRASH_VIEW → 200', async () => {
    __setDbForTest(makeFakeDb(['TRASH_VIEW']).db);
    const res = await request(buildApp()).get('/v1/trash').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('B3 route — MẬT KHẨU §14 verify ở ADAPTER', () => {
  it('approval approve: {password} sai → 409 WRONG_PASSWORD (không gọi core)', async () => {
    __setDbForTest(makeFakeDb(['BILL_CANCEL_APPROVE']).db);
    const res = await request(buildApp()).post('/v1/cancel-requests/10/approve').set('Cookie', COOKIE).send({ password: 'sai' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('WRONG_PASSWORD');
  });

  it('entity-cancel approve: {password} sai → 409 WRONG_PASSWORD', async () => {
    __setDbForTest(makeFakeDb(['TID_CANCEL_APPROVE']).db);
    const res = await request(buildApp()).post('/v1/entity-cancel-requests/10/approve').set('Cookie', COOKIE).send({ entityType: 'Tid', password: 'sai' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('WRONG_PASSWORD');
  });

  // ĐƯỜNG GỘP (13/11): 1 mật khẩu cho cả lô thay vì 1 request/phiếu.
  it('entity-cancel approve-bulk: {password} sai → 409 WRONG_PASSWORD (không gọi core)', async () => {
    __setDbForTest(makeFakeDb(['TID_CANCEL_APPROVE']).db);
    const res = await request(buildApp()).post('/v1/entity-cancel-requests/approve-bulk').set('Cookie', COOKIE)
      .send({ password: 'sai', items: [{ entityType: 'Tid', id: 10 }, { entityType: 'Tid', id: 11 }] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('WRONG_PASSWORD');
  });

  it('entity-cancel approve-bulk: mật khẩu ĐÚNG + lô rỗng → 400 VALIDATION (qua được cổng mật khẩu)', async () => {
    __setDbForTest(makeFakeDb(['TID_CANCEL_APPROVE']).db);
    const res = await request(buildApp()).post('/v1/entity-cancel-requests/approve-bulk').set('Cookie', COOKIE)
      .send({ password: PASSWORD, items: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
    expect(res.body.done).toBe(0);
  });

  it('entity-cancel approve-bulk: phiếu thiếu entityType/id bị LOẠI khi đọc body (không âm thầm duyệt nhầm)', async () => {
    __setDbForTest(makeFakeDb(['TID_CANCEL_APPROVE']).db);
    const res = await request(buildApp()).post('/v1/entity-cancel-requests/approve-bulk').set('Cookie', COOKIE)
      .send({ password: PASSWORD, items: [{ id: 10 }, { entityType: 'Tid' }, 'rác', null] });
    expect(res.status).toBe(400); // lọc sạch → lô rỗng → VALIDATION, KHÔNG phải 500
    expect(res.body.error).toBe('VALIDATION');
  });

  it('entity-cancel approve-bulk: 8 lượt gộp liên tiếp mật khẩu ĐÚNG → không lượt nào 429 (B152)', async () => {
    __setDbForTest(makeFakeDb(['TID_CANCEL_APPROVE']).db);
    const app = buildApp();
    for (let i = 1; i <= 8; i++) {
      const res = await request(app).post('/v1/entity-cancel-requests/approve-bulk').set('Cookie', COOKIE)
        .send({ password: PASSWORD, items: [] });
      expect(`lượt ${i}: ${res.status}`).toBe(`lượt ${i}: 400`); // 400 VALIDATION, KHÔNG phải 429 RATE_LIMITED
    }
  });

  it('export-request approve: {password} sai → 409 WRONG_PASSWORD', async () => {
    __setDbForTest(makeFakeDb(['EXPORT_REQUEST_APPROVE']).db);
    const res = await request(buildApp()).post('/v1/export-requests/10/approve').set('Cookie', COOKIE).send({ password: 'sai', lines: [] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('WRONG_PASSWORD');
  });

  it('trash purge: {password} sai → 409 WRONG_PASSWORD', async () => {
    __setDbForTest(makeFakeDb(['TRASH_PURGE']).db);
    const res = await request(buildApp()).post('/v1/trash/purge').set('Cookie', COOKIE).send({ entityType: 'Customer', id: 1, password: 'sai' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('WRONG_PASSWORD');
  });
});

describe('B3 route — MẬT KHẨU CẤP 2 verify ở ADAPTER (dọn sạch thùng rác)', () => {
  it('chưa đặt level2 → LEVEL2_NOT_SET', async () => {
    __setDbForTest(makeFakeDb(['TRASH_PURGE'], { level2: false }).db);
    const res = await request(buildApp()).post('/v1/trash/empty').set('Cookie', COOKIE).send({ level2Password: 'gì đó' });
    expect(res.body.error).toBe('LEVEL2_NOT_SET');
  });

  it('đã đặt level2 nhưng sai → WRONG_LEVEL2', async () => {
    __setDbForTest(makeFakeDb(['TRASH_PURGE'], { level2: true }).db);
    const res = await request(buildApp()).post('/v1/trash/empty').set('Cookie', COOKIE).send({ level2Password: 'sai' });
    expect(res.body.error).toBe('WRONG_LEVEL2');
  });

  it('level2 đúng → 200 dọn sạch (purged)', async () => {
    __setDbForTest(makeFakeDb(['TRASH_PURGE'], { level2: true }).db);
    const res = await request(buildApp()).post('/v1/trash/empty').set('Cookie', COOKIE).send({ level2Password: LEVEL2 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.purged).toBe('number');
  });
});
