// Route /v1/customers qua supertest + createApp() THẬT + Db giả in-memory (__setDbForTest) — KHÔNG cần Postgres.
// Cạnh duy nhất bị giả là tầng Prisma; toàn bộ middleware (cookie/requireQlSession/asyncHandler) + core @sigma/services
// chạy THẬT. Kiểm: 401 khi không có phiên, 200 list khi có phiên + quyền, 403 khi thiếu quyền, create/update/delete
// happy + validation. ASSERT status + error/message cụ thể.
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '@sigma/database';
import { createApp } from '../src/app.js';
import { __setDbForTest } from '../src/db.js';
import { makeFakeDb as buildFakeDb } from './_fake-db.js';

// ───────────────────────── Fake Prisma in-memory ─────────────────────────
interface FakeCustomer {
  id: number; code: string; fullName: string; nickname: string; phone: string | null; email: string | null;
  address: string | null; agentId: number | null; note: string | null; status: string;
  createdAt: Date; updatedAt: Date; deletedAt: Date | null; deletedBy: number | null; createdBy: number | null;
}
interface FakeRoleLink { role: { code: string; status: string; permissions: { permission: { code: string } }[] } }
interface FakeUser { id: number; username: string; fullName: string; status: string; deletedAt: Date | null; forceChangePassword: boolean; roles: FakeRoleLink[] }
interface FakeSession { id: string; userId: number; expiresAt: Date; lastSeenAt: Date }

function applyData(target: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as object)) {
      target[k] = ((target[k] as number) ?? 0) + ((v as { increment: number }).increment ?? 0);
    } else target[k] = v;
  }
}

function seedUser(permissions: string[]): FakeUser {
  return {
    id: 7, username: 'nhanvien', fullName: 'Nhân Viên', status: 'ACTIVE', deletedAt: null, forceChangePassword: false,
    roles: [{ role: { code: 'R', status: 'ACTIVE', permissions: permissions.map((c) => ({ permission: { code: c } })) } }]
  };
}
function seedCustomer(over: Partial<FakeCustomer> = {}): FakeCustomer {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 1, code: 'KH01', fullName: 'Nguyễn Văn Thanh', nickname: 'Anh Thanh Hải Phòng', phone: '0900000000',
    email: null, address: null, agentId: null, note: null, status: 'ACTIVE',
    createdAt: now, updatedAt: now, deletedAt: null, deletedBy: null, createdBy: 1, ...over
  };
}

function makeFakeDb(user: FakeUser, seedCustomers: FakeCustomer[]) {
  const customers = seedCustomers.map((c) => ({ ...c }));
  const audits: Record<string, unknown>[] = [];
  const counters: Record<string, number> = {};
  const sessions: FakeSession[] = [{ id: 'sess-1', userId: user.id, expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() }];
  let nextId = customers.reduce((m, c) => Math.max(m, c.id), 0) + 1;
  const count0 = async () => 0;

  // Shared factory stub SẴN 87 model (listCustomers mọc join model mới KHÔNG 500 test); $transaction chạy fn(db).
  const db = buildFakeDb({
    user: {
      findUnique: async ({ where }: { where: { id: number } }) => (where.id === user.id ? { ...user } : null),
      findUniqueOrThrow: async ({ where }: { where: { id: number } }) => {
        if (where.id !== user.id) throw new Error('user not found');
        return JSON.parse(JSON.stringify(user)) as FakeUser;
      }
    },
    loginSession: {
      findUnique: async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const s = sessions.find((x) => x.id === where.id);
        if (s) applyData(s as unknown as Record<string, unknown>, data);
        return s ? { ...s } : null;
      },
      deleteMany: async ({ where }: { where: { id: string } }) => {
        const before = sessions.length;
        for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i]!.id === where.id) sessions.splice(i, 1);
        return { count: before - sessions.length };
      }
    },
    customer: {
      findMany: async ({ where }: { where?: { deletedAt?: Date | null; status?: unknown } }) => {
        let rows = customers.filter((c) => c.deletedAt === (where?.deletedAt ?? null));
        const st = where?.status;
        if (typeof st === 'string') rows = rows.filter((c) => c.status === st);
        else if (st && typeof st === 'object' && 'not' in (st as object)) rows = rows.filter((c) => c.status !== (st as { not: string }).not);
        return rows.map((c) => ({ ...c })).sort((a, b) => a.id - b.id);
      },
      findUnique: async ({ where }: { where: { id: number } }) => {
        const c = customers.find((x) => x.id === where.id);
        return c ? { ...c } : null;
      },
      count: async ({ where }: { where?: { deletedAt?: Date | null; status?: string; agentId?: number | null } }) => {
        return customers.filter(
          (c) =>
            c.deletedAt === (where?.deletedAt ?? null) &&
            (where?.status === undefined || c.status === where.status) &&
            (where?.agentId === undefined || c.agentId === where.agentId)
        ).length;
      },
      groupBy: async () => {
        const m = new Map<number, number>();
        for (const c of customers) if (c.deletedAt === null && c.agentId !== null) m.set(c.agentId, (m.get(c.agentId) ?? 0) + 1);
        return [...m.entries()].map(([agentId, n]) => ({ agentId, _count: { _all: n } }));
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date();
        const row: FakeCustomer = {
          id: nextId++, code: data['code'] as string, fullName: data['fullName'] as string, nickname: data['nickname'] as string,
          phone: (data['phone'] as string | null) ?? null, email: (data['email'] as string | null) ?? null,
          address: (data['address'] as string | null) ?? null, agentId: (data['agentId'] as number | null) ?? null,
          note: (data['note'] as string | null) ?? null, status: (data['status'] as string) ?? 'ACTIVE',
          createdAt: now, updatedAt: now, deletedAt: null, deletedBy: null, createdBy: (data['createdBy'] as number | null) ?? null
        };
        customers.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
        const c = customers.find((x) => x.id === where.id);
        if (!c) throw new Error('customer not found');
        applyData(c as unknown as Record<string, unknown>, data);
        return { ...c };
      }
    },
    codeCounter: {
      upsert: async ({ where, create }: { where: { prefix: string }; create: { prefix: string; lastValue: number } }) => {
        const p = where.prefix;
        counters[p] = counters[p] === undefined ? create.lastValue : counters[p] + 1;
        return { prefix: p, lastValue: counters[p] };
      }
    },
    agent: { findMany: async () => [{ id: 5, code: 'DL01', name: 'Đại lý 1', region: 'HN' }] },
    // P4/B140 — listCustomers nay join nhóm chat SigMa: customerChatGroup (kỳ active có roomId) + chatRoom (tên phòng).
    // Rỗng → hasChatGroup=false, chatGroupNames=[] (assert list length/display không phụ thuộc nhóm chat).
    customerChatGroup: { findMany: async () => [] },
    chatRoom: { findMany: async () => [] },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'Customer', version: 1 }) },
    posDevice: { count: count0 },
    tid: { count: count0 },
    deviceDeposit: { count: count0 },
    exportRequest: { count: count0 },
    deviceSale: { findMany: async () => [] as { id: number; salePrice: bigint }[] },
    deviceSaleSettlement: { aggregate: async () => ({ _sum: { amount: 0n } }) }
  });
  return { db, customers, audits, sessions };
}

const COOKIE = 'ql_session=sess-1';
afterEach(() => __setDbForTest(null));

describe('/v1/customers — adapter API', () => {
  it('không cookie phiên → 401 NO_SESSION', async () => {
    __setDbForTest(makeFakeDb(seedUser(['CUSTOMER_VIEW']), [seedCustomer()]).db);
    const res = await request(createApp()).get('/v1/customers');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('NO_SESSION');
  });

  it('có phiên + quyền CUSTOMER_VIEW → 200 + list data', async () => {
    __setDbForTest(makeFakeDb(seedUser(['CUSTOMER_VIEW']), [seedCustomer()]).db);
    const res = await request(createApp()).get('/v1/customers').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].display).toBe('KH01 · Anh Thanh Hải Phòng (Nguyễn Văn Thanh)');
  });

  it('có phiên nhưng THIẾU quyền → 403 FORBIDDEN', async () => {
    __setDbForTest(makeFakeDb(seedUser([]), [seedCustomer()]).db);
    const res = await request(createApp()).get('/v1/customers').set('Cookie', COOKIE);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(res.body.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('POST tạo khách hợp lệ → 200 + id, thiếu nickname → 400 VALIDATION', async () => {
    const { db, customers } = makeFakeDb(seedUser(['CUSTOMER_CREATE']), []);
    __setDbForTest(db);
    const ok = await request(createApp()).post('/v1/customers').set('Cookie', COOKIE).send({ fullName: 'Trần Văn A', nickname: 'Anh A' });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(typeof ok.body.id).toBe('number');
    expect(customers[0]!.code).toBe('KH01');

    const bad = await request(createApp()).post('/v1/customers').set('Cookie', COOKIE).send({ fullName: 'Trần Văn A', nickname: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('VALIDATION');
    expect(bad.body.message).toBe('Biệt danh (tên dễ gọi) của khách hàng là bắt buộc.');
  });

  it('PATCH cập nhật hợp lệ → 200; stale (expectedUpdatedAt cũ) → 409 STALE_WRITE', async () => {
    const seeded = seedCustomer();
    const { db, customers } = makeFakeDb(seedUser(['CUSTOMER_UPDATE']), [seeded]);
    __setDbForTest(db);
    const ok = await request(createApp()).patch('/v1/customers/1').set('Cookie', COOKIE).send({ nickname: 'Tên Mới', expectedUpdatedAt: seeded.updatedAt.toISOString() });
    expect(ok.status).toBe(200);
    expect(customers[0]!.nickname).toBe('Tên Mới');

    const stale = await request(createApp()).patch('/v1/customers/1').set('Cookie', COOKIE).send({ nickname: 'X', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('STALE_WRITE');
  });

  // R34: xóa khách hàng CHỈ qua Duyệt Hủy (entity-cancel) — route KHÔNG được expose DELETE trực tiếp (bỏ qua
  // duyệt + mật khẩu §14). Khẳng định endpoint KHÔNG tồn tại (404) để chống ai đó thêm lại đường xóa thẳng.
  it('DELETE /v1/customers/:id KHÔNG expose (R34 — xóa chỉ qua Duyệt Hủy) → 404', async () => {
    __setDbForTest(makeFakeDb(seedUser(['CUSTOMER_DELETE']), [seedCustomer()]).db);
    const res = await request(createApp()).delete('/v1/customers/1').set('Cookie', COOKIE);
    expect(res.status).toBe(404);
  });

  it('GET /v1/agents → 200 + danh sách đại lý', async () => {
    __setDbForTest(makeFakeDb(seedUser(['CUSTOMER_VIEW']), []).db);
    const res = await request(createApp()).get('/v1/agents').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data[0].name).toBe('Đại lý 1');
  });

  it('GET /v1/customers/counts → 200 + bộ đếm', async () => {
    __setDbForTest(makeFakeDb(seedUser(['CUSTOMER_VIEW']), [seedCustomer()]).db);
    const res = await request(createApp()).get('/v1/customers/counts').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.active).toBe(1);
  });
});
