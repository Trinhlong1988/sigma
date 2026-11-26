// Route test GỘP cho 2 màn cuối (agent cuối): realtime (GET /v1/realtime/tokens) + notification
// (GET /v1/notifications/undelivered). Dùng supertest + __setDbForTest (bơm Db giả in-memory) — KHÔNG cần Postgres.
// Bao trọn chuỗi thật: requireQlSession (cookie ql_session → LoginSession → User ACTIVE) → ctxFromReq (loadAuthUser
// roles→permissions phẳng) → lõi @sigma/services → statusFor. ASSERT: 401 khi thiếu phiên; 200 + payload đúng khi có
// phiên; 403 khi thiếu TID_VIEW cho notification.
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import type { Db } from '@sigma/database';
import { errorHandler } from '../src/app.js';
import { realtimeRouter } from '../src/routes/realtime.js';
import { notificationRouter } from '../src/routes/notification.js';
import { __setDbForTest } from '../src/db.js';
import { makeFakeDb as buildFakeDb } from './_fake-db.js';

// KHÔNG dùng createApp() vì app.ts CHƯA mount 2 router mới (LEAD sẽ mount realtimeRouter + notificationRouter). Dựng
// app cục bộ CHỈ 2 router này (mirror middleware createApp: json + cookieParser cho ql_session + 404 + errorHandler)
// để test router độc lập, không phụ thuộc app.ts. Khi LEAD mount xong, có thể chuyển test sang createApp().
function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(realtimeRouter);
  app.use(notificationRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Route không tồn tại.' }));
  app.use(errorHandler);
  return app;
}

const SID = 'test-session-id';
const FUTURE = new Date(Date.now() + 3_600_000);

/** Db giả: phiên hợp lệ + user ACTIVE có `perms`, cùng dữ liệu realtime/notification cần đọc. */
function makeFakeDb(perms: string[]): Db {
  const emptyFind = { findMany: async () => [] as unknown[] };
  const userRecord = {
    id: 1,
    username: 'admin',
    fullName: 'Admin',
    status: 'ACTIVE',
    deletedAt: null,
    forceChangePassword: false,
    roles: [
      {
        role: {
          code: 'ADMIN',
          status: 'ACTIVE',
          permissions: perms.map((code) => ({ permission: { code } }))
        }
      }
    ]
  };
  // Shared factory stub SẴN 87 model → buildTidMaps mọc join model mới KHÔNG 500 test nữa. Chỉ override model cần.
  return buildFakeDb({
    loginSession: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === SID ? { id: SID, userId: 1, expiresAt: FUTURE } : null,
      update: async () => ({}),
      deleteMany: async () => ({ count: 0 })
    },
    user: {
      // requireQlSession (select id/status/deletedAt) + loadAuthUser (findUniqueOrThrow include roles).
      findUnique: async () => ({ id: 1, status: 'ACTIVE', deletedAt: null }),
      findUniqueOrThrow: async () => userRecord
    },
    // realtime
    changeToken: { findMany: async () => [{ domain: 'Customer', version: 7n }] },
    approvalRequest: { count: async () => 2 },
    // notification (listUndeliveredTids: tid.findMany + buildTidMaps FK tables rỗng)
    tid: { findMany: async () => [] },
    bank: { ...emptyFind },
    partner: { ...emptyFind },
    tidConfigStatus: { ...emptyFind },
    dossierSource: { ...emptyFind },
    agent: { ...emptyFind },
    industry: { ...emptyFind },
    customer: { ...emptyFind },
    // Phase B + P4 — buildTidMaps nay còn join: TK nhận tiền (receiveAccount) + uỷ NĐT (investor)
    // + khách có nhóm chat (customerChatGroup) + TID có giá bán thực tế (tidSellFee). Rỗng → maps rỗng.
    receiveAccount: { ...emptyFind },
    investor: { ...emptyFind },
    customerChatGroup: { ...emptyFind },
    tidSellFee: { ...emptyFind }
  });
}

afterEach(() => __setDbForTest(null));

describe('GET /v1/realtime/tokens', () => {
  it('thiếu phiên (không cookie) → 401', async () => {
    __setDbForTest(makeFakeDb([]));
    const res = await request(makeApp()).get('/v1/realtime/tokens');
    expect(res.status).toBe(401);
  });

  it('có phiên → 200 + byDomain (BigInt→number) + pendingCancels', async () => {
    __setDbForTest(makeFakeDb([]));
    const res = await request(makeApp()).get('/v1/realtime/tokens').set('Cookie', `ql_session=${SID}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.byDomain).toEqual({ Customer: 7 });
    expect(res.body.data.pendingCancels).toBe(2);
    expect(typeof res.body.data.serverNow).toBe('string');
  });
});

describe('GET /v1/notifications/undelivered', () => {
  it('có phiên nhưng thiếu TID_VIEW → 403', async () => {
    __setDbForTest(makeFakeDb([]));
    const res = await request(makeApp()).get('/v1/notifications/undelivered').set('Cookie', `ql_session=${SID}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('có TID_VIEW → 200 + summary (không TID chưa giao → count 0)', async () => {
    __setDbForTest(makeFakeDb(['TID_VIEW']));
    const res = await request(makeApp()).get('/v1/notifications/undelivered').set('Cookie', `ql_session=${SID}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ count: 0, totalAgingDays: 0, topAgingDays: 0, topTid: null });
  });
});
