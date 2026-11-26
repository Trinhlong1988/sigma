// Test LÕI THUẦN industry core (@sigma/services) — Db GIẢ in-memory ĐÚNG SHAPE Prisma + ServiceCtx = { db, user }.
// ASSERT giá trị cụ thể: error code + nguyên văn message tiếng Việt + mã NGH auto + audit + soft-delete.
// §14 xác nhận MẬT KHẨU đã CHUYỂN RA ADAPTER (route) — lõi KHÔNG còn kiểm password (khuôn customer.ts).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { hashPassword } from '@sigma/business-rules';
import {
  listIndustries,
  createIndustry,
  updateIndustry,
  deleteIndustries,
  type ServiceCtx
} from '../src/index.js';

interface FakeIndustry {
  id: number; code: string; name: string; active: boolean; note: string | null;
  createdBy: number | null; createdAt: Date; updatedBy: number | null; updatedAt: Date; deletedAt: Date | null; deletedBy: number | null;
}

const PASSWORD = 'matkhau-dung-123';
const PW_HASH = hashPassword(PASSWORD);

function contains(hay: string, needle: unknown): boolean {
  return typeof needle === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

function makeFakeDb(seed: FakeIndustry[]) {
  const industries = seed.map((c) => ({ ...c }));
  const audits: Record<string, unknown>[] = [];
  const counters: Record<string, number> = {};
  let nextId = industries.reduce((m, c) => Math.max(m, c.id), 0) + 1;

  const industry = {
    findMany: async (args?: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      let rows = industries.slice();
      if ('deletedAt' in where) rows = rows.filter((c) => c.deletedAt === (where['deletedAt'] ?? null));
      if (where['active'] !== undefined) rows = rows.filter((c) => c.active === where['active']);
      const not = where['NOT'] as { id?: number } | undefined;
      if (not?.id !== undefined) rows = rows.filter((c) => c.id !== not.id);
      const or = where['OR'] as { code?: { contains: string }; name?: { contains: string } }[] | undefined;
      if (or) rows = rows.filter((c) => or.some((o) => (o.code && contains(c.code, o.code.contains)) || (o.name && contains(c.name, o.name.contains))));
      return rows.map((c) => ({ ...c })).sort((a, b) => a.id - b.id);
    },
    findUnique: async ({ where }: { where: { id: number } }) => {
      const c = industries.find((x) => x.id === where.id);
      return c ? { ...c } : null;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const now = new Date();
      const row: FakeIndustry = {
        id: nextId++, code: data['code'] as string, name: data['name'] as string,
        active: (data['active'] as boolean) ?? true, note: (data['note'] as string | null) ?? null,
        createdBy: (data['createdBy'] as number | null) ?? null, createdAt: now, updatedBy: null, updatedAt: now, deletedAt: null, deletedBy: null
      };
      industries.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
      const c = industries.find((x) => x.id === where.id);
      if (!c) throw new Error('industry not found');
      Object.assign(c, data);
      return { ...c };
    }
  };

  const fake = {
    industry,
    user: {
      findMany: async () => [{ id: 42, fullName: 'Người Kiểm Thử', username: 'tester' }],
      findUnique: async ({ where }: { where: { id: number } }) => (where.id === 42 ? { passwordHash: PW_HASH } : null)
    },
    codeCounter: {
      upsert: async ({ where, create }: { where: { prefix: string }; create: { prefix: string; lastValue: number } }) => {
        const p = where.prefix;
        counters[p] = counters[p] === undefined ? create.lastValue : counters[p] + 1;
        return { prefix: p, lastValue: counters[p] };
      }
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'Industry', version: 1 }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake)
  };
  return { db: fake as unknown as Db, industries, audits };
}

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

function seed(over: Partial<FakeIndustry> = {}): FakeIndustry {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return { id: 1, code: 'NGH01', name: 'Bán lẻ', active: true, note: null, createdBy: 42, createdAt: now, updatedBy: null, updatedAt: now, deletedAt: null, deletedBy: null, ...over };
}

describe('listIndustries', () => {
  it('thiếu quyền CONFIG_INDUSTRY_VIEW → FORBIDDEN + message nguyên văn', async () => {
    const { db } = makeFakeDb([seed()]);
    const r = await listIndustries({ db, user: authUser([]) }, {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('có quyền → data (ẩn đã xóa) + trail.createdByName', async () => {
    const { db } = makeFakeDb([seed(), seed({ id: 2, code: 'NGH02', name: 'Đã xóa', deletedAt: new Date() })]);
    const ctx: ServiceCtx = { db, user: authUser(['CONFIG_INDUSTRY_VIEW']) };
    const r = await listIndustries(ctx, {});
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(r.data![0]!.code).toBe('NGH01');
    expect(r.data![0]!.createdByName).toBe('Người Kiểm Thử');
  });
});

describe('createIndustry', () => {
  it('tên rỗng → VALIDATION nguyên văn', async () => {
    const { db, audits } = makeFakeDb([]);
    const r = await createIndustry({ db, user: authUser(['CONFIG_INDUSTRY_CREATE']) }, { name: '   ' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Tên ngành nghề bắt buộc.');
    expect(audits).toHaveLength(0);
  });

  it('trùng tên (active) → DUPLICATE', async () => {
    const { db } = makeFakeDb([seed({ name: 'Bán lẻ' })]);
    const r = await createIndustry({ db, user: authUser(['CONFIG_INDUSTRY_CREATE']) }, { name: 'bán  lẻ' });
    expect(r.error).toBe('DUPLICATE');
    expect(r.message).toBe('Ngành "bán lẻ" đã tồn tại.');
  });

  it('hợp lệ → mã NGH01 auto + createdBy + audit INDUSTRY_CREATED', async () => {
    const { db, industries, audits } = makeFakeDb([]);
    const r = await createIndustry({ db, user: authUser(['CONFIG_INDUSTRY_CREATE']) }, { name: 'Dịch vụ' });
    expect(r.ok).toBe(true);
    expect(industries[0]!.code).toBe('NGH01');
    expect(industries[0]!.createdBy).toBe(42);
    expect(audits.some((a) => a['action'] === 'INDUSTRY_CREATED')).toBe(true);
  });
});

describe('updateIndustry', () => {
  it('không tồn tại → NOT_FOUND', async () => {
    const { db } = makeFakeDb([]);
    const r = await updateIndustry({ db, user: authUser(['CONFIG_INDUSTRY_UPDATE']) }, 99, { name: 'X' });
    expect(r.error).toBe('NOT_FOUND');
    expect(r.message).toBe('Ngành nghề không tồn tại.');
  });

  it('optimistic-lock lệch → STALE_WRITE, KHÔNG đổi', async () => {
    const { db, industries } = makeFakeDb([seed()]);
    const r = await updateIndustry({ db, user: authUser(['CONFIG_INDUSTRY_UPDATE']) }, 1, { name: 'Mới', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
    expect(r.error).toBe('STALE_WRITE');
    expect(industries[0]!.name).toBe('Bán lẻ');
  });

  it('hợp lệ → đổi tên + updatedBy + audit UPDATED', async () => {
    const s = seed();
    const { db, industries, audits } = makeFakeDb([s]);
    const r = await updateIndustry({ db, user: authUser(['CONFIG_INDUSTRY_UPDATE']) }, 1, { name: 'Bán sỉ', expectedUpdatedAt: s.updatedAt.toISOString() });
    expect(r.ok).toBe(true);
    expect(industries[0]!.name).toBe('Bán sỉ');
    expect(industries[0]!.updatedBy).toBe(42);
    expect(audits.some((a) => a['action'] === 'INDUSTRY_UPDATED')).toBe(true);
  });
});

describe('deleteIndustries', () => {
  it('thiếu quyền → FORBIDDEN', async () => {
    const { db } = makeFakeDb([seed()]);
    const r = await deleteIndustries({ db, user: authUser(['CONFIG_INDUSTRY_VIEW']) }, [1]);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('chưa chọn id → VALIDATION', async () => {
    const { db } = makeFakeDb([seed()]);
    const r = await deleteIndustries({ db, user: authUser(['CONFIG_INDUSTRY_DELETE']) }, []);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Chưa chọn ngành nghề để xóa.');
  });

  it('lõi giả định đã xác thực (adapter kiểm mật khẩu) → soft-delete + audit DELETED', async () => {
    const { db, industries, audits } = makeFakeDb([seed()]);
    const r = await deleteIndustries({ db, user: authUser(['CONFIG_INDUSTRY_DELETE']) }, [1]);
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(1);
    expect(industries[0]!.deletedAt).toBeInstanceOf(Date);
    expect(industries[0]!.deletedBy).toBe(42);
    expect(audits.some((a) => a['action'] === 'INDUSTRY_DELETED')).toBe(true);
  });
});
