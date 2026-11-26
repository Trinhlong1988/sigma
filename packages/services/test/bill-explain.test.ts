// Test LÕI THUẦN bill-explain core (@sigma/services) — phần CRUD DỮ LIỆU (Product + theo dõi Bill). Db GIẢ in-memory
// + ServiceCtx. ASSERT error code + message + audit + soft-delete + import đếm imported/skipped. generateBills/file
// = TENTATIVE (không port đợt này). §14 mật khẩu ở ADAPTER.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  listProducts, createProduct, updateProduct, deleteProducts, importProducts,
  listBillExplains, deleteBillExplains,
  type ServiceCtx
} from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}
const VIEW = 'BILLEXPLAIN_VIEW';
const PMANAGE = 'PRODUCT_MANAGE';
const BDELETE = 'BILLEXPLAIN_DELETE';

interface Row { id: number; deletedAt: Date | null; [k: string]: unknown }
function makeTable(seed: Row[]) {
  const rows = seed.map((r) => ({ ...r }));
  let nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  return {
    rows,
    findMany: async (args?: { where?: Record<string, unknown> }) => {
      const w = args?.where ?? {};
      return rows.filter((r) => (!('deletedAt' in w) || r.deletedAt === (w['deletedAt'] ?? null))).map((r) => ({ ...r })).sort((a, b) => a.id - b.id);
    },
    findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r.id === where.id) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: nextId++, deletedAt: null, updatedBy: null, createdAt: new Date(), updatedAt: new Date(), ...data } as Row; rows.push(row); return { ...row }; },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = rows.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; },
    count: async () => 0
  };
}
function baseFake() {
  const audits: Record<string, unknown>[] = [];
  const fake: Record<string, unknown> = {
    user: { findMany: async () => [{ id: 42, fullName: 'Người Kiểm Thử', username: 'tester' }] },
    industry: makeTable([{ id: 1, name: 'Bán lẻ', deletedAt: null } as Row]),
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) }
  };
  return { fake, audits };
}
const ctx = (fake: Record<string, unknown>, perms: string[]): ServiceCtx => ({ db: fake as unknown as Db, user: authUser(perms) });

describe('product core', () => {
  it('list thiếu quyền → FORBIDDEN', async () => {
    const { fake } = baseFake();
    fake.product = makeTable([]);
    const r = await listProducts(ctx(fake, []));
    expect(r.error).toBe('FORBIDDEN');
  });

  it('tạo thiếu ngành → VALIDATION', async () => {
    const { fake } = baseFake();
    fake.product = makeTable([]);
    const r = await createProduct(ctx(fake, [PMANAGE]), { industryId: 0, name: 'SP', unit: 'cái', price: 1000 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Chọn nhóm ngành nghề.');
  });

  it('ngành không tồn tại → VALIDATION', async () => {
    const { fake } = baseFake();
    fake.product = makeTable([]);
    const r = await createProduct(ctx(fake, [PMANAGE]), { industryId: 999, name: 'SP', unit: 'cái', price: 1000 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Ngành nghề không tồn tại.');
  });

  it('giá không phải số nguyên dương → VALIDATION', async () => {
    const { fake } = baseFake();
    fake.product = makeTable([]);
    const r = await createProduct(ctx(fake, [PMANAGE]), { industryId: 1, name: 'SP', unit: 'cái', price: -5 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Đơn giá phải là số nguyên dương (VND).');
  });

  it('tạo hợp lệ → ok + audit + price lưu đúng', async () => {
    const { fake, audits } = baseFake();
    const t = makeTable([]);
    fake.product = t;
    const r = await createProduct(ctx(fake, [PMANAGE]), { industryId: 1, name: '  Bút  bi ', unit: 'cái', price: 5000 });
    expect(r.ok).toBe(true);
    expect(t.rows[0]!.name).toBe('Bút bi');
    expect(t.rows[0]!.price).toBe(5000);
    expect(audits.some((a) => a['action'] === 'PRODUCT_CREATED')).toBe(true);
  });

  it('update stale → STALE_WRITE', async () => {
    const { fake } = baseFake();
    fake.product = makeTable([{ id: 1, industryId: 1, name: 'A', unit: 'cái', price: 1000, priority: 0, status: 'ACTIVE', deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-02-01') }]);
    const r = await updateProduct(ctx(fake, [PMANAGE]), 1, { name: 'B', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' });
    expect(r.error).toBe('STALE_WRITE');
  });

  it('xóa SP → soft-delete + audit', async () => {
    const { fake, audits } = baseFake();
    const t = makeTable([{ id: 1, industryId: 1, name: 'A', unit: 'cái', price: 1000, priority: 0, status: 'ACTIVE', deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }]);
    fake.product = t;
    const r = await deleteProducts(ctx(fake, [PMANAGE]), [1]);
    expect(r.ok).toBe(true);
    expect(t.rows[0]!.deletedAt).not.toBeNull();
    expect(audits.some((a) => a['action'] === 'PRODUCT_DELETED')).toBe(true);
  });

  it('import: bỏ dòng thiếu/không hợp lệ, đếm imported/skipped', async () => {
    const { fake } = baseFake();
    const t = makeTable([]);
    fake.product = t;
    const r = await importProducts(ctx(fake, [PMANAGE]), 1, [
      { name: 'SP1', unit: 'cái', price: '45.000' },
      { name: '', unit: 'cái', price: 1000 }, // thiếu tên
      { name: 'SP3', unit: 'kg', price: -1 } // giá sai
    ]);
    expect(r.ok).toBe(true);
    expect(r.imported).toBe(1);
    expect(r.skipped).toBe(2);
    expect(t.rows[0]!.price).toBe(45000); // "45.000" → 45000 (dấu nhóm nghìn)
  });
});

describe('bill explain (theo dõi) core', () => {
  function withBill(perms: string[]) {
    const { fake, audits } = baseFake();
    fake.dossier = makeTable([{ id: 1, hkdName: 'Quán A', deletedAt: null } as Row]);
    fake.tid = makeTable([]);
    const bills = makeTable([]);
    fake.billExplain = bills;
    return { ctx: ctx(fake, perms), bills, audits };
  }

  it('list thiếu quyền → FORBIDDEN', async () => {
    const { ctx: c } = withBill([]);
    const r = await listBillExplains(c);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('list có quyền → resolve tên HKD', async () => {
    const { ctx: c, bills } = withBill([VIEW]);
    bills.rows.push({ id: 2, code: 'BE00001', dossierId: 1, tidId: null, industryId: 1, billDate: new Date('2026-03-01'), totalAmount: 1000000n, billCount: 3, filePath: '/x/y.xlsx', createdBy: 42, deletedAt: null, createdAt: new Date() } as Row);
    const r = await listBillExplains(c);
    expect(r.ok).toBe(true);
    const row = r.data!.find((x) => x.id === 2)!;
    expect(row.dossierName).toBe('Quán A');
    expect(row.totalAmount).toBe(1000000);
    expect(row.billCount).toBe(3);
  });

  it('xóa bill thiếu quyền BILLEXPLAIN_DELETE → FORBIDDEN', async () => {
    const { ctx: c } = withBill([VIEW]);
    const r = await deleteBillExplains(c, [1]);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('xóa bill → soft-delete + audit', async () => {
    const { ctx: c, bills, audits } = withBill([BDELETE]);
    bills.rows.push({ id: 5, code: 'BE00002', dossierId: 1, tidId: null, industryId: 1, billDate: new Date(), totalAmount: 1n, billCount: 1, filePath: '/x', createdBy: 42, deletedAt: null, createdAt: new Date() } as Row);
    const r = await deleteBillExplains(c, [5]);
    expect(r.ok).toBe(true);
    expect(bills.rows.find((x) => x.id === 5)!.deletedAt).not.toBeNull();
    expect(audits.some((a) => a['action'] === 'BILLEXPLAIN_DELETED')).toBe(true);
  });
});
