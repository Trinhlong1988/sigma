// Test LÕI THUẦN customer core (@sigma/services) — KHÔNG cần Postgres/Electron: bơm 1 Db GIẢ in-memory ĐÚNG SHAPE
// Prisma (customer/codeCounter/auditLog/changeToken/posDevice…) + dựng ServiceCtx = { db, user } trực tiếp. ASSERT
// GIÁ TRỊ CỤ THỂ (error code + nguyên văn message tiếng Việt + audit ghi + soft-delete), không chỉ truthy.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  listCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  type ServiceCtx
} from '../src/customer.js';

// ───────────────────────── Fake Prisma in-memory ─────────────────────────
interface FakeCustomer {
  id: number;
  code: string;
  fullName: string;
  nickname: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  agentId: number | null;
  note: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  deletedBy: number | null;
  createdBy: number | null;
}

interface FakeOpts {
  posHold?: number; // posDevice.count trả về (guard quan hệ sống)
  agents?: { id: number; deletedAt: Date | null }[]; // FIX-FK: đại lý có thật để validate agentId
}

function applyData(target: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as object)) {
      target[k] = ((target[k] as number) ?? 0) + ((v as { increment: number }).increment ?? 0);
    } else {
      target[k] = v;
    }
  }
}

function makeFakeDb(seed: FakeCustomer[], opts: FakeOpts = {}) {
  const customers = seed.map((c) => ({ ...c }));
  const audits: Record<string, unknown>[] = [];
  const counters: Record<string, number> = {};
  let nextId = customers.reduce((m, c) => Math.max(m, c.id), 0) + 1;

  const codeCounter = {
    upsert: async ({ where, create }: { where: { prefix: string }; create: { prefix: string; lastValue: number } }) => {
      const p = where.prefix;
      counters[p] = counters[p] === undefined ? create.lastValue : counters[p] + 1;
      return { prefix: p, lastValue: counters[p] };
    }
  };

  const filterRows = (where?: { deletedAt?: Date | null; status?: unknown }) => {
    let rows = customers.filter((c) => c.deletedAt === (where?.deletedAt ?? null));
    const st = where?.status;
    if (typeof st === 'string') rows = rows.filter((c) => c.status === st);
    else if (st && typeof st === 'object' && 'not' in (st as object)) {
      const not = (st as { not: string }).not;
      rows = rows.filter((c) => c.status !== not);
    }
    return rows.sort((a, b) => a.id - b.id);
  };

  const customer = {
    // FIX-PERF B132: findMany hỗ trợ skip/take (phân trang) — mô phỏng đúng Prisma cho test phân trang.
    findMany: async ({ where, skip, take }: { where?: { deletedAt?: Date | null; status?: unknown }; skip?: number; take?: number }) => {
      const rows = filterRows(where).map((c) => ({ ...c }));
      const start = skip ?? 0;
      return take === undefined ? rows.slice(start) : rows.slice(start, start + take);
    },
    count: async ({ where }: { where?: { deletedAt?: Date | null; status?: unknown } }) => filterRows(where).length,
    findUnique: async ({ where }: { where: { id: number } }) => {
      const c = customers.find((x) => x.id === where.id);
      return c ? { ...c } : null;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const now = new Date();
      const row: FakeCustomer = {
        id: nextId++,
        code: data['code'] as string,
        fullName: data['fullName'] as string,
        nickname: data['nickname'] as string,
        phone: (data['phone'] as string | null) ?? null,
        email: (data['email'] as string | null) ?? null,
        address: (data['address'] as string | null) ?? null,
        agentId: (data['agentId'] as number | null) ?? null,
        note: (data['note'] as string | null) ?? null,
        status: (data['status'] as string) ?? 'ACTIVE',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        deletedBy: null,
        createdBy: (data['createdBy'] as number | null) ?? null
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
  };

  // FIX-FK: fake agent.findFirst — chỉ khớp id CÓ trong opts.agents và chưa xóa mềm (deletedAt null).
  const agentSeed = opts.agents ?? [];
  const agent = {
    findFirst: async ({ where }: { where: { id: number; deletedAt: null } }) => {
      const a = agentSeed.find((x) => x.id === where.id && x.deletedAt === null);
      return a ? { id: a.id } : null;
    }
  };

  const count0 = async () => 0;
  const fake = {
    customer,
    agent,
    codeCounter,
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'Customer', version: 1 }) },
    posDevice: { count: async () => opts.posHold ?? 0 },
    // Nhóm chat SigMa đã liên kết (Admin Demo 11/8) — listCustomers join customerChatGroup + chatRoom để hiện tên
    // nhóm/chấm trạng thái. Test cơ bản KHÔNG seed nhóm nào → trả rỗng (khách chưa liên kết nhóm chat).
    customerChatGroup: { findMany: async () => [] as { customerId: number; roomId: string | null }[] },
    chatRoom: { findMany: async () => [] as { id: string; name: string | null }[] },
    tid: { count: count0 },
    deviceDeposit: { count: count0 },
    exportRequest: { count: count0 },
    deviceSale: { findMany: async () => [] as { id: number; salePrice: bigint }[] },
    deviceSaleSettlement: { aggregate: async () => ({ _sum: { amount: 0n } }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake)
  };
  return { db: fake as unknown as Db, customers, audits };
}

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

function seedCustomer(over: Partial<FakeCustomer> = {}): FakeCustomer {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 1, code: 'KH01', fullName: 'Nguyễn Văn Thanh', nickname: 'Anh Thanh Hải Phòng', phone: '0900000000',
    email: null, address: null, agentId: null, note: null, status: 'ACTIVE',
    createdAt: now, updatedAt: now, deletedAt: null, deletedBy: null, createdBy: 1, ...over
  };
}

// ───────────────────────── list ─────────────────────────
describe('listCustomers', () => {
  it('thiếu quyền CUSTOMER_VIEW → FORBIDDEN + message nguyên văn', async () => {
    const { db } = makeFakeDb([seedCustomer()]);
    const ctx: ServiceCtx = { db, user: authUser([]) };
    const r = await listCustomers(ctx, {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
    expect(r.data).toBeUndefined();
  });

  it('có quyền → trả data (ẩn CANCELLED mặc định) + display đúng định dạng §D', async () => {
    const { db } = makeFakeDb([seedCustomer(), seedCustomer({ id: 2, code: 'KH02', status: 'CANCELLED' })]);
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_VIEW']) };
    const r = await listCustomers(ctx, {});
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(1); // KH02 CANCELLED bị ẩn
    expect(r.data![0]!.code).toBe('KH01');
    expect(r.data![0]!.display).toBe('KH01 · Anh Thanh Hải Phòng (Nguyễn Văn Thanh)');
    // FIX-PERF B132: shape phân trang mặc định (không gửi page) — total đếm đúng số khớp, page 1, pageSize 100.
    expect(r.total).toBe(1);
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(100);
  });

  it('FIX-PERF B132: page/pageSize cắt trang + total là TỔNG khớp (không phải số hàng trang này)', async () => {
    const seed = Array.from({ length: 5 }, (_, i) => seedCustomer({ id: i + 1, code: `KH0${i + 1}` }));
    const { db } = makeFakeDb(seed);
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_VIEW']) };
    const r = await listCustomers(ctx, { page: 2, pageSize: 2 });
    expect(r.ok).toBe(true);
    expect(r.total).toBe(5); // tổng, không đổi theo trang
    expect(r.page).toBe(2);
    expect(r.pageSize).toBe(2);
    expect(r.data!.map((c) => c.code)).toEqual(['KH03', 'KH04']); // trang 2 (skip 2, take 2)
  });

  it('FIX-PERF B132: pageSize > 500 bị kẹp về 500 (chặn kéo full-bảng)', async () => {
    const { db } = makeFakeDb([seedCustomer()]);
    const r = await listCustomers({ db, user: authUser(['CUSTOMER_VIEW']) }, { pageSize: 9999 });
    expect(r.pageSize).toBe(500);
  });
});

// ───────────────────────── create ─────────────────────────
describe('createCustomer', () => {
  it('thiếu nickname → VALIDATION + message tiếng Việt nguyên văn (§D bắt buộc biệt danh)', async () => {
    const { db, audits } = makeFakeDb([]);
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_CREATE']) };
    const r = await createCustomer(ctx, { fullName: 'Trần Văn A', nickname: '   ' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Biệt danh (tên dễ gọi) của khách hàng là bắt buộc.');
    expect(audits).toHaveLength(0);
  });

  it('thiếu quyền → FORBIDDEN', async () => {
    const { db } = makeFakeDb([]);
    const r = await createCustomer({ db, user: authUser(['CUSTOMER_VIEW']) }, { fullName: 'A', nickname: 'a' });
    expect(r.error).toBe('FORBIDDEN');
  });

  it('hợp lệ → tạo với mã KH auto + trả id + ghi audit CUSTOMER_CREATED', async () => {
    const { db, customers, audits } = makeFakeDb([]);
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_CREATE']) };
    const r = await createCustomer(ctx, { fullName: 'Trần Văn A', nickname: 'Anh A' });
    expect(r.ok).toBe(true);
    expect(typeof r.id).toBe('number');
    expect(customers).toHaveLength(1);
    expect(customers[0]!.code).toBe('KH01'); // mã đầu tiên
    expect(customers[0]!.createdBy).toBe(42); // ctx.user.id
    expect(audits).toHaveLength(1);
    expect(audits[0]!['action']).toBe('CUSTOMER_CREATED');
    expect(audits[0]!['targetType']).toBe('Customer');
  });

  it('FIX-FK: agentId trỏ đại lý KHÔNG tồn tại → VALIDATION, KHÔNG tạo, KHÔNG audit', async () => {
    const { db, customers, audits } = makeFakeDb([], { agents: [{ id: 7, deletedAt: null }] });
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_CREATE']) };
    const r = await createCustomer(ctx, { fullName: 'Trần Văn A', nickname: 'Anh A', agentId: 9999 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Đại lý được chọn không tồn tại (hoặc đã bị xóa). Vui lòng chọn lại.');
    expect(customers).toHaveLength(0); // KHÔNG ghi tham chiếu mồ côi
    expect(audits).toHaveLength(0);
  });

  it('FIX-FK: agentId trỏ đại lý ĐÃ XÓA MỀM → VALIDATION (không cho gán vào đại lý đã hủy)', async () => {
    const { db, customers } = makeFakeDb([], { agents: [{ id: 7, deletedAt: new Date() }] });
    const r = await createCustomer({ db, user: authUser(['CUSTOMER_CREATE']) }, { fullName: 'A', nickname: 'a', agentId: 7 });
    expect(r.error).toBe('VALIDATION');
    expect(customers).toHaveLength(0);
  });

  it('FIX-FK: agentId trỏ đại lý CÓ THẬT → tạo thành công, gán đúng agentId', async () => {
    const { db, customers } = makeFakeDb([], { agents: [{ id: 7, deletedAt: null }] });
    const r = await createCustomer({ db, user: authUser(['CUSTOMER_CREATE']) }, { fullName: 'A', nickname: 'a', agentId: 7 });
    expect(r.ok).toBe(true);
    expect(customers[0]!.agentId).toBe(7);
  });
});

// ───────────────────────── update ─────────────────────────
describe('updateCustomer', () => {
  it('optimistic-lock lệch (expectedUpdatedAt cũ) → STALE_WRITE, KHÔNG ghi đè', async () => {
    const { db, customers } = makeFakeDb([seedCustomer()]);
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_UPDATE']) };
    const r = await updateCustomer(ctx, 1, { nickname: 'Tên Mới', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('STALE_WRITE');
    expect(customers[0]!.nickname).toBe('Anh Thanh Hải Phòng'); // không đổi
  });

  it('hợp lệ (expectedUpdatedAt khớp) → cập nhật + audit CUSTOMER_UPDATED (before/after)', async () => {
    const seeded = seedCustomer();
    const { db, customers, audits } = makeFakeDb([seeded]);
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_UPDATE']) };
    const r = await updateCustomer(ctx, 1, { nickname: 'Tên Mới', expectedUpdatedAt: seeded.updatedAt.toISOString() });
    expect(r.ok).toBe(true);
    expect(customers[0]!.nickname).toBe('Tên Mới');
    expect(audits[0]!['action']).toBe('CUSTOMER_UPDATED');
    expect(String(audits[0]!['beforeJson'])).toContain('Anh Thanh Hải Phòng');
  });

  it('nickname rỗng khi cập nhật → VALIDATION nguyên văn', async () => {
    const { db } = makeFakeDb([seedCustomer()]);
    const r = await updateCustomer({ db, user: authUser(['CUSTOMER_UPDATE']) }, 1, { nickname: '  ' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Biệt danh (tên dễ gọi) của khách hàng là bắt buộc.');
  });

  it('FIX-FK: đổi sang agentId đại lý KHÔNG tồn tại → VALIDATION, KHÔNG ghi đè', async () => {
    const seeded = seedCustomer();
    const { db, customers } = makeFakeDb([seeded], { agents: [{ id: 7, deletedAt: null }] });
    const r = await updateCustomer({ db, user: authUser(['CUSTOMER_UPDATE']) }, 1, { agentId: 9999, expectedUpdatedAt: seeded.updatedAt.toISOString() });
    expect(r.error).toBe('VALIDATION');
    expect(customers[0]!.agentId).toBeNull(); // giữ nguyên, không gán mồ côi
  });

  it('FIX-FK: gỡ gán đại lý (agentId=null) LUÔN hợp lệ, không kiểm', async () => {
    const seeded = seedCustomer({ agentId: 7 });
    const { db, customers } = makeFakeDb([seeded]); // KHÔNG cần seed agents — null short-circuit
    const r = await updateCustomer({ db, user: authUser(['CUSTOMER_UPDATE']) }, 1, { agentId: null, expectedUpdatedAt: seeded.updatedAt.toISOString() });
    expect(r.ok).toBe(true);
    expect(customers[0]!.agentId).toBeNull();
  });
});

// ───────────────────────── delete ─────────────────────────
describe('deleteCustomer', () => {
  it('còn giữ máy POS → IN_USE + message số máy, KHÔNG xóa mềm', async () => {
    const { db, customers } = makeFakeDb([seedCustomer()], { posHold: 2 });
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_DELETE']) };
    const r = await deleteCustomer(ctx, 1);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('IN_USE');
    expect(r.message).toBe('Khách đang giữ 2 máy POS. Thu hồi máy trước khi hủy khách.');
    expect(customers[0]!.deletedAt).toBeNull(); // chưa xóa
  });

  it('không còn quan hệ sống → xóa mềm (deletedAt + deletedBy) + audit CUSTOMER_DELETED', async () => {
    const { db, customers, audits } = makeFakeDb([seedCustomer()]);
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_DELETE']) };
    const r = await deleteCustomer(ctx, 1);
    expect(r.ok).toBe(true);
    expect(customers[0]!.deletedAt).toBeInstanceOf(Date);
    expect(customers[0]!.deletedBy).toBe(42); // ctx.user.id
    expect(audits.some((a) => a['action'] === 'CUSTOMER_DELETED')).toBe(true);
  });

  it('thiếu quyền → FORBIDDEN', async () => {
    const { db } = makeFakeDb([seedCustomer()]);
    const r = await deleteCustomer({ db, user: authUser(['CUSTOMER_VIEW']) }, 1);
    expect(r.error).toBe('FORBIDDEN');
  });
});
