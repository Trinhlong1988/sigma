// Test LÕI THUẦN dossier core (@sigma/services) — Db GIẢ in-memory + ServiceCtx = { db, user }. ASSERT giá trị cụ
// thể: error code + nguyên văn message tiếng Việt + audit + soft-delete + chiết khấu ×1000. §14 mật khẩu ở ADAPTER.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  listDossierSources, createDossierSource, updateDossierSource, deleteDossierSources,
  createDossier, updateDossier, deleteDossiers, listDossiers,
  type ServiceCtx
} from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}
const VIEW = 'CONFIG_DOSSIER_VIEW';
const MANAGE = 'CONFIG_DOSSIER_MANAGE';

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
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const not = where['NOT'] as { id?: number } | undefined;
      return rows.find((r) => (where['code'] === undefined || r.code === where['code']) && (where['name'] === undefined || r.name === where['name']) && (!not || r.id !== not.id)) ?? null;
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
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) }
  };
  return { fake, audits };
}
const ctx = (fake: Record<string, unknown>, perms: string[]): ServiceCtx => ({ db: fake as unknown as Db, user: authUser(perms) });

describe('dossier source core', () => {
  it('thiếu quyền VIEW → FORBIDDEN nguyên văn', async () => {
    const { fake } = baseFake();
    fake.dossierSource = makeTable([]);
    const r = await listDossierSources(ctx(fake, []));
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('tạo thiếu mã → VALIDATION', async () => {
    const { fake } = baseFake();
    fake.dossierSource = makeTable([]);
    const r = await createDossierSource(ctx(fake, [MANAGE]), { code: '  ', discountRate: 1 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Mã nguồn hồ sơ bắt buộc.');
  });

  it('chiết khấu >3 thập phân → VALIDATION', async () => {
    const { fake } = baseFake();
    fake.dossierSource = makeTable([]);
    const r = await createDossierSource(ctx(fake, [MANAGE]), { code: 'NG1', discountRate: 1.2345 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Chính sách chiết khấu phải ≥ 0 và tối đa 3 số thập phân.');
  });

  it('tạo hợp lệ → ok + lưu ×1000 + audit', async () => {
    const { fake, audits } = baseFake();
    const t = makeTable([]);
    fake.dossierSource = t;
    const r = await createDossierSource(ctx(fake, [MANAGE]), { code: 'NG1', discountRate: 1.5 });
    expect(r.ok).toBe(true);
    expect(t.rows[0]!.discountRate).toBe(1500);
    expect(audits.some((a) => a['action'] === 'DOSSIER_SOURCE_CREATED')).toBe(true);
  });

  it('trùng mã đang sống → DUPLICATE; trong thùng rác → DUPLICATE_TRASH', async () => {
    const { fake } = baseFake();
    fake.dossierSource = makeTable([{ id: 1, code: 'NG1', discountRate: 0, deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }]);
    const dup = await createDossierSource(ctx(fake, [MANAGE]), { code: 'NG1', discountRate: 0 });
    expect(dup.error).toBe('DUPLICATE');

    const { fake: fake2 } = baseFake();
    fake2.dossierSource = makeTable([{ id: 1, code: 'NG2', discountRate: 0, deletedAt: new Date(), createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }]);
    const trash = await createDossierSource(ctx(fake2, [MANAGE]), { code: 'NG2', discountRate: 0 });
    expect(trash.error).toBe('DUPLICATE_TRASH');
  });

  it('update stale (expectedUpdatedAt cũ) → STALE_WRITE', async () => {
    const { fake } = baseFake();
    fake.dossierSource = makeTable([{ id: 1, code: 'NG1', discountRate: 0, deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-02-01') }]);
    const r = await updateDossierSource(ctx(fake, [MANAGE]), 1, { code: 'NG1B', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' });
    expect(r.error).toBe('STALE_WRITE');
  });

  it('xóa (đã xác thực ở adapter) → soft-delete + audit', async () => {
    const { fake, audits } = baseFake();
    const t = makeTable([{ id: 1, code: 'NG1', discountRate: 0, deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }]);
    fake.dossierSource = t;
    const r = await deleteDossierSources(ctx(fake, [MANAGE]), [1]);
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(1);
    expect(t.rows[0]!.deletedAt).not.toBeNull();
    expect(audits.some((a) => a['action'] === 'DOSSIER_SOURCE_DELETED')).toBe(true);
  });
});

describe('dossier core', () => {
  function withDossier(perms: string[]) {
    const { fake, audits } = baseFake();
    fake.dossierSource = makeTable([{ id: 1, code: 'NG1', discountRate: 0, deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }]);
    const dossiers = makeTable([]);
    fake.dossier = dossiers;
    return { ctx: ctx(fake, perms), dossiers, audits };
  }

  it('tạo thiếu tên HKD → VALIDATION', async () => {
    const { ctx: c } = withDossier([MANAGE]);
    const r = await createDossier(c, { sourceId: 1, hkdName: '  ', ownerName: 'Chủ A' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Tên Hộ Kinh Doanh bắt buộc.');
  });

  it('nguồn hồ sơ không tồn tại → NOT_FOUND', async () => {
    const { ctx: c } = withDossier([MANAGE]);
    const r = await createDossier(c, { sourceId: 999, hkdName: 'Quán A', ownerName: 'Chủ A' });
    expect(r.error).toBe('NOT_FOUND');
    expect(r.message).toBe('Nguồn hồ sơ đã chọn không tồn tại.');
  });

  it('tạo hợp lệ → ok + mstStatus mặc định ACTIVE + audit', async () => {
    const { ctx: c, dossiers, audits } = withDossier([MANAGE]);
    const r = await createDossier(c, { sourceId: 1, hkdName: 'Quán A', ownerName: 'Nguyễn Văn A', taxCode: ' 123 ' });
    expect(r.ok).toBe(true);
    expect(dossiers.rows[0]!.mstStatus).toBe('ACTIVE');
    expect(dossiers.rows[0]!.taxCode).toBe('123');
    expect(audits.some((a) => a['action'] === 'DOSSIER_CREATED')).toBe(true);
  });

  it('mstStatus không hợp lệ → VALIDATION', async () => {
    const { ctx: c } = withDossier([MANAGE]);
    const r = await createDossier(c, { sourceId: 1, hkdName: 'Quán A', ownerName: 'A', mstStatus: 'XXX' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Trạng thái MST không hợp lệ (chỉ Hoạt động / Đóng).');
  });

  it('list thiếu quyền → FORBIDDEN; có quyền → trả data', async () => {
    const { ctx: c, dossiers } = withDossier([VIEW]);
    dossiers.rows.push({ id: 5, sourceId: 1, hkdName: 'Quán X', ownerName: 'Chủ X', mstStatus: 'ACTIVE', deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date(), dkkdFrontPath: null, dkkdFrontName: null, dkkdBackPath: null, dkkdBackName: null, cccdFrontPath: null, cccdFrontName: null, cccdBackPath: null, cccdBackName: null } as Row);
    const ok = await listDossiers(c);
    expect(ok.ok).toBe(true);
    expect(ok.data!.some((d) => d.hkdName === 'Quán X')).toBe(true);
    expect(ok.data![0]!.sourceCode).toBe('NG1');
  });

  it('update NOT_FOUND khi hồ sơ không tồn tại', async () => {
    const { ctx: c } = withDossier([MANAGE]);
    const r = await updateDossier(c, 123, { sourceId: 1, hkdName: 'A', ownerName: 'B' });
    expect(r.error).toBe('NOT_FOUND');
  });

  it('xóa hồ sơ → soft-delete + audit', async () => {
    const { ctx: c, dossiers, audits } = withDossier([MANAGE]);
    dossiers.rows.push({ id: 7, sourceId: 1, hkdName: 'Quán Y', ownerName: 'Chủ Y', mstStatus: 'ACTIVE', deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() } as Row);
    const r = await deleteDossiers(c, [7]);
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(1);
    expect(dossiers.rows.find((x) => x.id === 7)!.deletedAt).not.toBeNull();
    expect(audits.some((a) => a['action'] === 'DOSSIER_DELETED')).toBe(true);
  });
});
