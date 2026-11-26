// Test LÕI THUẦN status-catalog core (@sigma/services) — Db GIẢ in-memory + ServiceCtx. ASSERT: đọc active/all,
// listMany gom nhóm, isValidStatus, sinh CUSTOM_<n>, builtin/IN_USE chặn xóa, audit. READ chỉ cần ctx (đã đăng nhập).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  listStatusOptions,
  listStatusOptionsMany,
  listStatusEntities,
  isValidStatus,
  createStatusOption,
  updateStatusOption,
  deleteStatusOption,
  type ServiceCtx
} from '../src/index.js';

interface FakeSO {
  id: number; entity: string; code: string; label: string; tone: string; isBuiltin: boolean; sortOrder: number;
  active: boolean; createdBy: number | null; createdAt: Date; updatedBy: number | null; updatedAt: Date; deletedAt: Date | null; deletedBy: number | null;
}

function makeFakeDb(seed: FakeSO[], opts: { usage?: Record<string, number> } = {}) {
  const rows = seed.map((s) => ({ ...s }));
  const audits: Record<string, unknown>[] = [];
  let nextId = rows.reduce((m, c) => Math.max(m, c.id), 0) + 1;

  const statusOption = {
    findMany: async (args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      let out = rows.slice();
      if ('deletedAt' in where) out = out.filter((r) => r.deletedAt === (where['deletedAt'] ?? null));
      const ent = where['entity'];
      if (typeof ent === 'string') out = out.filter((r) => r.entity === ent);
      else if (ent && typeof ent === 'object' && 'in' in (ent as object)) out = out.filter((r) => ((ent as { in: string[] }).in).includes(r.entity));
      if (where['active'] !== undefined) out = out.filter((r) => r.active === where['active']);
      const code = where['code'] as { startsWith?: string } | undefined;
      if (code?.startsWith) out = out.filter((r) => r.code.startsWith(code.startsWith!));
      out = out.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
      return out.map((r) => ({ ...r }));
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const not = where['NOT'] as { id?: number } | undefined;
      const r = rows.find((x) =>
        (where['entity'] === undefined || x.entity === where['entity']) &&
        (where['code'] === undefined || x.code === where['code']) &&
        (where['label'] === undefined || x.label === where['label']) &&
        (!('deletedAt' in where) || x.deletedAt === (where['deletedAt'] ?? null)) &&
        (not?.id === undefined || x.id !== not.id)
      );
      return r ? { ...r } : null;
    },
    findUnique: async ({ where }: { where: { id: number } }) => {
      const r = rows.find((x) => x.id === where.id);
      return r ? { ...r } : null;
    },
    aggregate: async ({ where }: { where: { entity: string; deletedAt: null } }) => {
      const rel = rows.filter((r) => r.entity === where.entity && r.deletedAt === null);
      const max = rel.reduce((m, r) => Math.max(m, r.sortOrder), -Infinity);
      return { _max: { sortOrder: rel.length ? max : null } };
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const now = new Date();
      const row: FakeSO = {
        id: nextId++, entity: data['entity'] as string, code: data['code'] as string, label: data['label'] as string,
        tone: (data['tone'] as string) ?? 'slate', isBuiltin: (data['isBuiltin'] as boolean) ?? false, sortOrder: (data['sortOrder'] as number) ?? 0,
        active: (data['active'] as boolean) ?? true, createdBy: (data['createdBy'] as number | null) ?? null, createdAt: now, updatedBy: null, updatedAt: now, deletedAt: null, deletedBy: null
      };
      rows.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
      const r = rows.find((x) => x.id === where.id);
      if (!r) throw new Error('so not found');
      Object.assign(r, data);
      return { ...r };
    }
  };

  const usageCount = (key: string) => async () => opts.usage?.[key] ?? 0;
  const fake = {
    statusOption,
    bank: { count: usageCount('BANK') },
    customer: { count: usageCount('CUSTOMER') },
    partner: { count: usageCount('PARTNER') },
    posDevice: { count: usageCount('POS_DEVICE') },
    dossier: { count: usageCount('HKD_MST') },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'StatusOption', version: 1 }) }
  };
  return { db: fake as unknown as Db, rows, audits };
}

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

function seed(over: Partial<FakeSO> = {}): FakeSO {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return { id: 1, entity: 'CUSTOMER', code: 'ACTIVE', label: 'Đang hoạt động', tone: 'emerald', isBuiltin: true, sortOrder: 0, active: true, createdBy: null, createdAt: now, updatedBy: null, updatedAt: now, deletedAt: null, deletedBy: null, ...over };
}

describe('reads (chỉ cần đăng nhập)', () => {
  it('listStatusOptions: mặc định chỉ active; includeInactive → cả ẩn', async () => {
    const { db } = makeFakeDb([seed(), seed({ id: 2, code: 'LOCKED', label: 'Khóa', active: false })]);
    const ctx: ServiceCtx = { db, user: authUser([]) };
    const onlyActive = await listStatusOptions(ctx, 'CUSTOMER');
    expect(onlyActive.data).toHaveLength(1);
    const all = await listStatusOptions(ctx, 'CUSTOMER', { includeInactive: true });
    expect(all.data).toHaveLength(2);
  });

  it('listStatusOptionsMany: gom theo entity, entity trống → []', async () => {
    const { db } = makeFakeDb([seed(), seed({ id: 3, entity: 'BANK', code: 'OPEN', label: 'Mở' })]);
    const r = await listStatusOptionsMany({ db, user: authUser([]) }, ['CUSTOMER', 'BANK', 'PARTNER']);
    expect(r.data!['CUSTOMER']).toHaveLength(1);
    expect(r.data!['BANK']).toHaveLength(1);
    expect(r.data!['PARTNER']).toEqual([]);
  });

  it('listStatusEntities: trả danh sách thực thể', async () => {
    const { db } = makeFakeDb([]);
    const r = await listStatusEntities({ db, user: authUser([]) });
    expect(r.ok).toBe(true);
    expect(r.data!.some((e) => e.entity === 'CUSTOMER')).toBe(true);
  });

  it('isValidStatus: tồn tại → true, không → false', async () => {
    const { db } = makeFakeDb([seed()]);
    const ctx: ServiceCtx = { db, user: authUser([]) };
    expect(await isValidStatus(ctx, 'CUSTOMER', 'ACTIVE')).toBe(true);
    expect(await isValidStatus(ctx, 'CUSTOMER', 'NOPE')).toBe(false);
  });
});

describe('createStatusOption', () => {
  it('thiếu quyền → FORBIDDEN', async () => {
    const { db } = makeFakeDb([]);
    const r = await createStatusOption({ db, user: authUser([]) }, { entity: 'CUSTOMER', label: 'Mới' });
    expect(r.error).toBe('FORBIDDEN');
  });

  it('entity không hợp lệ → VALIDATION', async () => {
    const { db } = makeFakeDb([]);
    const r = await createStatusOption({ db, user: authUser(['SYSTEM_SETTING_UPDATE']) }, { entity: 'ZZZ', label: 'Mới' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Thực thể không hợp lệ.');
  });

  it('trùng nhãn → DUPLICATE', async () => {
    const { db } = makeFakeDb([seed({ label: 'Đang hoạt động' })]);
    const r = await createStatusOption({ db, user: authUser(['SYSTEM_SETTING_UPDATE']) }, { entity: 'CUSTOMER', label: 'Đang hoạt động' });
    expect(r.error).toBe('DUPLICATE');
    expect(r.message).toBe('Trạng thái "Đang hoạt động" đã tồn tại.');
  });

  it('hợp lệ → code CUSTOM_1 + sortOrder kế + audit CREATED', async () => {
    const { db, rows, audits } = makeFakeDb([seed({ sortOrder: 0 })]);
    const r = await createStatusOption({ db, user: authUser(['SYSTEM_SETTING_UPDATE']) }, { entity: 'CUSTOMER', label: 'Chờ duyệt', tone: 'amber' });
    expect(r.ok).toBe(true);
    const created = rows.find((x) => x.id === r.id)!;
    expect(created.code).toBe('CUSTOM_1');
    expect(created.sortOrder).toBe(1);
    expect(created.createdBy).toBe(42);
    expect(audits.some((a) => a['action'] === 'STATUS_OPTION_CREATED')).toBe(true);
  });
});

describe('updateStatusOption', () => {
  it('optimistic-lock lệch → STALE_WRITE', async () => {
    const { db, rows } = makeFakeDb([seed({ isBuiltin: true })]);
    const r = await updateStatusOption({ db, user: authUser(['SYSTEM_SETTING_UPDATE']) }, 1, { label: 'Đổi', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
    expect(r.error).toBe('STALE_WRITE');
    expect(rows[0]!.label).toBe('Đang hoạt động');
  });

  it('hợp lệ → đổi nhãn/màu + audit UPDATED', async () => {
    const s = seed();
    const { db, rows, audits } = makeFakeDb([s]);
    const r = await updateStatusOption({ db, user: authUser(['SYSTEM_SETTING_UPDATE']) }, 1, { label: 'Hoạt động', tone: 'sky', expectedUpdatedAt: s.updatedAt.toISOString() });
    expect(r.ok).toBe(true);
    expect(rows[0]!.label).toBe('Hoạt động');
    expect(rows[0]!.tone).toBe('sky');
    expect(audits.some((a) => a['action'] === 'STATUS_OPTION_UPDATED')).toBe(true);
  });
});

describe('deleteStatusOption', () => {
  it('builtin → BUILTIN_LOCKED (không xóa)', async () => {
    const { db, rows } = makeFakeDb([seed({ isBuiltin: true })]);
    const r = await deleteStatusOption({ db, user: authUser(['SYSTEM_SETTING_UPDATE']) }, 1);
    expect(r.error).toBe('BUILTIN_LOCKED');
    expect(rows[0]!.deletedAt).toBeNull();
  });

  it('đang dùng → IN_USE (không xóa)', async () => {
    const { db, rows } = makeFakeDb([seed({ id: 5, code: 'CUSTOM_1', label: 'Tùy biến', isBuiltin: false })], { usage: { CUSTOMER: 4 } });
    const r = await deleteStatusOption({ db, user: authUser(['SYSTEM_SETTING_UPDATE']) }, 5);
    expect(r.error).toBe('IN_USE');
    expect(rows[0]!.deletedAt).toBeNull();
  });

  it('không builtin + không dùng → soft-delete + audit DELETED', async () => {
    const { db, rows, audits } = makeFakeDb([seed({ id: 5, code: 'CUSTOM_1', label: 'Tùy biến', isBuiltin: false })]);
    const r = await deleteStatusOption({ db, user: authUser(['SYSTEM_SETTING_UPDATE']) }, 5);
    expect(r.ok).toBe(true);
    expect(rows[0]!.deletedAt).toBeInstanceOf(Date);
    expect(rows[0]!.deletedBy).toBe(42);
    expect(audits.some((a) => a['action'] === 'STATUS_OPTION_DELETED')).toBe(true);
  });
});
