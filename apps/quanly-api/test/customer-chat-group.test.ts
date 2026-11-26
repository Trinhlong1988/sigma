// Route /v1/customers/:id/chat-groups qua supertest + createApp() THẬT + Db giả in-memory (__setDbForTest) —
// KHÔNG cần Postgres. Toàn bộ middleware (cookie/requireQlSession/asyncHandler) + core @sigma/services chạy THẬT.
// Kiểm: 401 khi không phiên, 200 GET/PUT khi có quyền, 403 thiếu quyền, 400 VALIDATION (feeType/room/trùng). ASSERT status + error/message.
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { rawPhienStub } from './_raw-phien.js';
import type { Db } from '@sigma/database';
import { createApp } from '../src/app.js';
import { __setDbForTest } from '../src/db.js';

interface FakeRoleLink { role: { code: string; status: string; permissions: { permission: { code: string } }[] } }
interface FakeUser { id: number; username: string; fullName: string; status: string; deletedAt: Date | null; forceChangePassword: boolean; roles: FakeRoleLink[] }
interface FakeSession { id: string; userId: number; expiresAt: Date; lastSeenAt: Date }
interface FakeGroup { id: number; customerId: number; feeTypeId: number; roomId: string | null; link: string | null; qr: string | null; note: string | null; createdBy: number | null; assignedFrom: Date; unassignedAt: Date | null }

function applyData(target: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) target[k] = v;
}

function seedUser(permissions: string[]): FakeUser {
  return {
    id: 7, username: 'nhanvien', fullName: 'Nhân Viên', status: 'ACTIVE', deletedAt: null, forceChangePassword: false,
    roles: [{ role: { code: 'R', status: 'ACTIVE', permissions: permissions.map((c) => ({ permission: { code: c } })) } }]
  };
}

function makeFakeDb(user: FakeUser, groups: FakeGroup[] = []) {
  const sessions: FakeSession[] = [{ id: 'sess-1', userId: user.id, expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() }];
  const feeSeed = [{ id: 10, name: 'Ủy quyền', deletedAt: null }, { id: 11, name: 'Tiền chờ', deletedAt: null }];
  const roomSeed = [
    { id: 'room-A', type: 'GROUP', name: 'Nhóm A', deletedAt: null as Date | null },
    { id: 'room-Free', type: 'GROUP', name: 'Nhóm trống', deletedAt: null as Date | null }
  ];
  const rows: FakeGroup[] = groups.map((g) => ({ ...g }));
  const audits: Record<string, unknown>[] = [];
  let nextId = rows.reduce((m, g) => Math.max(m, g.id), 0) + 1;

  const fake = {
    // [13/11] auth.ts ghi/chạm/đo phiên bằng SQL THÔ (băm phiên 12/11) — thiếu stub là login nổ 500,
    // kéo cả file đỏ CÂM. Stub dùng chung, câu lạ thì NÉM LỖI chứ không trả rỗng.
    ...rawPhienStub(sessions),
    // [13/11] Lớp TÌM KIẾM KHÔNG PHÂN BIỆT HOA/THƯỜNG chạy 2 câu thô: dò collation ICU, rồi lấy id khớp.
    // Ghi đè stub phiên cho 2 câu này, còn lại giao lại cho stub phiên (nó tự ném nếu gặp câu lạ).
    $queryRawUnsafe: async (sql: string, ...p: unknown[]) => {
      // Fake không chạy Postgres ⇒ coi như KHÔNG có collation ICU; lớp tìm kiếm tự hạ cấp về lower() — đúng
      // nhánh dự phòng của nó, không phải nuốt lỗi.
      if (sql.includes('FROM pg_collation')) return [];
      if (sql.includes('FROM "chat_rooms"')) {
        const tu = String(p[0] ?? '').replace(/%/g, '').toLowerCase();
        return roomSeed.filter((r) => (r.name ?? '').toLowerCase().includes(tu) || r.id.toLowerCase().includes(tu)).map((r) => ({ id: r.id }));
      }
      return rawPhienStub(sessions).$queryRawUnsafe(sql, ...p);
    },
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
    customer: { findUnique: async ({ where }: { where: { id: number } }) => (where.id === 1 ? { id: 1, deletedAt: null } : null) },
    feeType: {
      findFirst: async ({ where }: { where: { id: number; deletedAt: null } }) => {
        const f = feeSeed.find((x) => x.id === where.id && x.deletedAt === null);
        return f ? { id: f.id } : null;
      },
      findMany: async ({ where }: { where: { id: { in: number[] } } }) => feeSeed.filter((f) => where.id.in.includes(f.id)).map((f) => ({ id: f.id, name: f.name }))
    },
    chatRoom: {
      findUnique: async ({ where }: { where: { id: string } }) => { const r = roomSeed.find((x) => x.id === where.id); return r ? { id: r.id, deletedAt: r.deletedAt } : null; },
      findMany: async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
        const idIn = (where['id'] as { in?: string[] } | undefined)?.in;
        if (idIn) return roomSeed.filter((r) => idIn.includes(r.id)).map((r) => ({ id: r.id, name: r.name }));
        let list = roomSeed.filter((r) => r.type === (where['type'] as string) && r.deletedAt === null);
        const notIn = (where['id'] as { notIn?: string[] } | undefined)?.notIn;
        if (notIn) list = list.filter((r) => !notIn.includes(r.id));
        // [13/11] `AND` nay CÓ 2 DẠNG: dạng cũ `{ OR: [{name:{contains}}, {id:{contains}}] }` và dạng mới
        // `{ id: { in: [...] } }` do lớp tìm-kiếm-không-phân-biệt-hoa-thường nhét vào. Mẫu giả chỉ hiểu dạng cũ
        // thì `c.OR.some` nổ "reading 'some'" ⇒ route 500. Hiểu CẢ HAI.
        const and = where['AND'] as Array<{ OR?: { name?: { contains: string }; id?: { contains: string } }[]; id?: { in?: string[] } }> | undefined;
        if (and) for (const c of and) {
          if (c.OR) list = list.filter((r) => c.OR!.some((o) => (o.name && (r.name ?? '').toLowerCase().includes(o.name.contains.toLowerCase())) || (o.id && r.id.toLowerCase().includes(o.id.contains.toLowerCase()))));
          else if (c.id?.in) list = list.filter((r) => c.id!.in!.includes(r.id));
          else throw new Error('mẫu giả chatRoom: CHƯA hiểu mệnh đề AND này: ' + JSON.stringify(c));
        }
        if (orderBy) list = list.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
        if (take) list = list.slice(0, take);
        return list.map((r) => ({ id: r.id, name: r.name }));
      }
    },
    customerChatGroup: {
      findMany: async ({ where, select }: { where?: { customerId?: number; unassignedAt?: Date | null; roomId?: { not: null } }; select?: { roomId?: boolean } }) => {
        const out = rows.filter((g) =>
          (where?.customerId === undefined || g.customerId === where.customerId) &&
          (where?.unassignedAt === undefined || g.unassignedAt === where.unassignedAt) &&
          (where?.roomId === undefined || (where.roomId.not === null && g.roomId !== null))
        ).map((g) => ({ ...g })).sort((a, b) => a.id - b.id);
        return select?.roomId ? out.map((r) => ({ roomId: r.roomId })) : out;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: FakeGroup = { id: nextId++, customerId: data['customerId'] as number, feeTypeId: data['feeTypeId'] as number, roomId: (data['roomId'] as string | null) ?? null, link: (data['link'] as string | null) ?? null, qr: (data['qr'] as string | null) ?? null, note: (data['note'] as string | null) ?? null, createdBy: (data['createdBy'] as number | null) ?? null, assignedFrom: (data['assignedFrom'] as Date) ?? new Date(), unassignedAt: (data['unassignedAt'] as Date | null) ?? null };
        rows.push(row); return { ...row };
      },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
        const g = rows.find((x) => x.id === where.id); if (!g) throw new Error('not found');
        for (const [k, v] of Object.entries(data)) (g as unknown as Record<string, unknown>)[k] = v; return { ...g };
      }
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'Customer', version: 1 }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake)
  };
  return { db: fake as unknown as Db, rows, audits };
}

const COOKIE = 'ql_session=sess-1';
afterEach(() => __setDbForTest(null));

describe('/v1/customers/:id/chat-groups — adapter API', () => {
  it('không cookie phiên → 401', async () => {
    __setDbForTest(makeFakeDb(seedUser(['CUSTOMER_VIEW'])).db);
    const res = await request(createApp()).get('/v1/customers/1/chat-groups');
    expect(res.status).toBe(401);
  });

  it('GET có quyền CUSTOMER_VIEW → 200 + data kèm feeTypeName', async () => {
    __setDbForTest(makeFakeDb(seedUser(['CUSTOMER_VIEW']), [
      { id: 1, customerId: 1, feeTypeId: 10, roomId: 'room-A', link: 'https://a', qr: 'qrA', note: null, createdBy: 1, assignedFrom: new Date(), unassignedAt: null }
    ]).db);
    const res = await request(createApp()).get('/v1/customers/1/chat-groups').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].feeTypeName).toBe('Ủy quyền');
    expect(res.body.data[0].roomName).toBe('Nhóm A');
  });

  it('GET thiếu quyền → 403 FORBIDDEN', async () => {
    __setDbForTest(makeFakeDb(seedUser([])).db);
    const res = await request(createApp()).get('/v1/customers/1/chat-groups').set('Cookie', COOKIE);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('PUT đặt danh sách hợp lệ → 200 + tạo hàng', async () => {
    const { db, rows } = makeFakeDb(seedUser(['CUSTOMER_UPDATE']));
    __setDbForTest(db);
    const res = await request(createApp()).put('/v1/customers/1/chat-groups').set('Cookie', COOKIE).send({ rows: [{ feeTypeId: 10, roomId: 'room-A' }, { feeTypeId: 11 }] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(rows.filter((g) => g.unassignedAt === null)).toHaveLength(2);
  });

  it('PUT feeType không tồn tại → 400 VALIDATION', async () => {
    __setDbForTest(makeFakeDb(seedUser(['CUSTOMER_UPDATE'])).db);
    const res = await request(createApp()).put('/v1/customers/1/chat-groups').set('Cookie', COOKIE).send({ rows: [{ feeTypeId: 9999 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('PUT trùng feeType trong 1 lần gửi → 400 VALIDATION', async () => {
    __setDbForTest(makeFakeDb(seedUser(['CUSTOMER_UPDATE'])).db);
    const res = await request(createApp()).put('/v1/customers/1/chat-groups').set('Cookie', COOKIE).send({ rows: [{ feeTypeId: 10 }, { feeTypeId: 10 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Mỗi loại phí chỉ được cấu hình 1 nhóm chat cho khách. Vui lòng bỏ loại phí bị trùng.');
  });

  it('PUT roomId sai → 400 VALIDATION', async () => {
    __setDbForTest(makeFakeDb(seedUser(['CUSTOMER_UPDATE'])).db);
    const res = await request(createApp()).put('/v1/customers/1/chat-groups').set('Cookie', COOKIE).send({ rows: [{ feeTypeId: 10, roomId: 'room-X' }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Phòng chat được chọn không tồn tại (hoặc đã bị xóa). Vui lòng chọn lại.');
  });
});

describe('/v1/chat-groups — picker nhóm chat chưa gán', () => {
  it('không cookie phiên → 401', async () => {
    __setDbForTest(makeFakeDb(seedUser(['CUSTOMER_VIEW'])).db);
    const res = await request(createApp()).get('/v1/chat-groups');
    expect(res.status).toBe(401);
  });

  it('GET CUSTOMER_VIEW → 200, chỉ nhóm CHƯA gán (room-A đang gán bị loại)', async () => {
    __setDbForTest(makeFakeDb(seedUser(['CUSTOMER_VIEW']), [
      { id: 1, customerId: 1, feeTypeId: 10, roomId: 'room-A', link: null, qr: null, note: null, createdBy: 1, assignedFrom: new Date(), unassignedAt: null }
    ]).db);
    const res = await request(createApp()).get('/v1/chat-groups').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.map((x: { roomId: string }) => x.roomId)).toEqual(['room-Free']);
  });

  it('GET thiếu quyền → 403 FORBIDDEN', async () => {
    __setDbForTest(makeFakeDb(seedUser([])).db);
    const res = await request(createApp()).get('/v1/chat-groups').set('Cookie', COOKIE);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('GET search=trống → tìm theo tên (contains)', async () => {
    __setDbForTest(makeFakeDb(seedUser(['CUSTOMER_VIEW'])).db);
    const res = await request(createApp()).get('/v1/chat-groups?search=' + encodeURIComponent('trống')).set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.data.map((x: { roomId: string }) => x.roomId)).toEqual(['room-Free']);
  });
});
