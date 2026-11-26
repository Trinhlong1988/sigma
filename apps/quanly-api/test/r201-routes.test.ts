// R201 (dead-IPC 21/8) — route adapter cho 2 method: GET /v1/agents/:id/qr-image (customerRouter) + POST
// /v1/notifications/push-undelivered (notificationRouter). Db giả in-memory + phiên ql_session. Kiểm 401/403/200.
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { rawPhienStub } from './_raw-phien.js';
import type { Db } from '@sigma/database';
import { __setDbForTest } from '../src/db.js';
import { errorHandler } from '../src/app.js';
import { customerRouter } from '../src/routes/customer.js';
import { notificationRouter } from '../src/routes/notification.js';

const COOKIE = 'ql_session=sess-1';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(customerRouter);
  app.use(notificationRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND' }));
  app.use(errorHandler);
  return app;
}

function makeFakeDb(permissions: string[], agent: Record<string, unknown> | null) {
  const user = {
    id: 7, username: 'nv', fullName: 'NV', status: 'ACTIVE', deletedAt: null, forceChangePassword: false,
    roles: [{ role: { code: 'R', status: 'ACTIVE', permissions: permissions.map((c) => ({ permission: { code: c } })) } }]
  };
  const sessions = [{ id: 'sess-1', userId: 7, expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() }];
  const none = { findMany: async () => [] };
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
    agent: { findUnique: async ({ where }: { where: { id: number } }) => (agent && agent.id === where.id ? { ...agent } : null), findMany: async () => [] },
    // buildTidMaps + listUndeliveredTids đụng nhiều bảng → rỗng cho push happy-path.
    tid: none, receiveAccount: none, customer: none, investor: none, customerChatGroup: none,
    tidSellFee: none, bank: none, partner: none, tidConfigStatus: none, dossierSource: none, industry: none
  };
  return fake as unknown as Db;
}

afterEach(() => __setDbForTest(null));

describe('R201 routes', () => {
  it('agent qr-image: không cookie → 401', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_RCV_ACCT_VIEW'], null));
    const res = await request(buildApp()).get('/v1/agents/1/qr-image');
    expect(res.status).toBe(401);
  });

  it('agent qr-image: có quyền + có QR → 200 dataUrl; thiếu quyền → 403', async () => {
    const qr = Uint8Array.from([9, 8, 7]);
    __setDbForTest(makeFakeDb(['CONFIG_RCV_ACCT_VIEW'], { id: 1, code: 'DL01', name: 'Đại lý 1', qrImage: qr, qrImageMime: 'image/png', bankAccountLabel: 'VCB', qrUpdatedAt: null, deletedAt: null }));
    const ok = await request(buildApp()).get('/v1/agents/1/qr-image').set('Cookie', COOKIE);
    expect(ok.status).toBe(200);
    expect(ok.body.data.hasQr).toBe(true);
    expect(ok.body.data.dataUrl).toContain('data:image/png;base64,');

    __setDbForTest(makeFakeDb([], { id: 1, name: 'X', qrImage: null, deletedAt: null }));
    const forb = await request(buildApp()).get('/v1/agents/1/qr-image').set('Cookie', COOKIE);
    expect(forb.status).toBe(403);
  });

  it('agent qr-image: đại lý không tồn tại → 404', async () => {
    __setDbForTest(makeFakeDb(['CONFIG_RCV_ACCT_VIEW'], null));
    const res = await request(buildApp()).get('/v1/agents/999/qr-image').set('Cookie', COOKIE);
    expect(res.status).toBe(404);
  });

  it('push-undelivered: có TID_VIEW → 200 stub message; thiếu quyền → 403', async () => {
    __setDbForTest(makeFakeDb(['TID_VIEW'], null));
    const ok = await request(buildApp()).post('/v1/notifications/push-undelivered').set('Cookie', COOKIE);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.stub).toBe(true);
    expect(typeof ok.body.message).toBe('string');

    __setDbForTest(makeFakeDb([], null));
    const forb = await request(buildApp()).post('/v1/notifications/push-undelivered').set('Cookie', COOKIE);
    expect(forb.status).toBe(403);
  });
});
