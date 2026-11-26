// Test LÕI THUẦN tid-config core (@sigma/services) — Db GIẢ in-memory ĐÚNG SHAPE Prisma + ServiceCtx = { db, user }.
// ASSERT: error code + nguyên văn message + validate khóa tham chiếu + chống trùng TID + audit + soft-delete.
// §14 xác nhận MẬT KHẨU đã CHUYỂN RA ADAPTER — lõi KHÔNG kiểm password. LƯU Ý R34: deleteConfigTids là NỘI BỘ
// (không route) — vẫn test để bảo đảm parity lõi.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  listStatuses,
  createStatus,
  updateStatus,
  deleteStatuses,
  listConfigTids,
  createConfigTid,
  updateConfigTid,
  deleteConfigTids,
  validateRefs,
  type ServiceCtx
} from '../src/index.js';

interface Row { [k: string]: unknown; id: number; deletedAt: Date | null }

function makeFakeDb() {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const tidStatuses: Row[] = [{ id: 1, name: 'Đang chạy', createdBy: 42, createdAt: now, updatedBy: null, updatedAt: now, deletedAt: null, deletedBy: null }];
  const tids: Row[] = [];
  const banks: Row[] = [{ id: 30, code: 'VCB', name: 'Vietcombank', deletedAt: null }];
  const partners: Row[] = [{ id: 10, code: 'DTA', name: 'Đối tác A', deletedAt: null }];
  // Phase B — TK #50 uỷ = Nhà đầu tư #95 (investorId; owyType SUY RA). Test suy owyName + receiveAccountLabel.
  const receiveAccounts: Row[] = [{ id: 50, accountName: 'CTY A', accountNumber: '123', customerId: null, investorId: 95, deletedAt: null }];
  const dossierSources: Row[] = [{ id: 60, code: 'NGUON1', deletedAt: null }];
  const industries: Row[] = [{ id: 70, name: 'Bán lẻ', active: true, deletedAt: null }];
  const dossiers: Row[] = [{ id: 80, deletedAt: null }];
  const customers: Row[] = [{ id: 90, nickname: 'Anh Ba', fullName: 'Nguyễn Văn Ba', deletedAt: null }];
  const investors: Row[] = [{ id: 95, nickname: 'NĐT Chín', fullName: 'Lê Chín', deletedAt: null }]; // Phase B — owy investor
  const audits: Record<string, unknown>[] = [];
  let nextId = 100;

  function model(store: Row[]) {
    return {
      findMany: async (args?: { where?: Record<string, unknown> }) => {
        const w = args?.where ?? {};
        return store.filter((r) => Object.entries(w).every(([k, cond]) => {
          if (k === 'OR') return true; // search bỏ qua ở test
          if (k === 'createdAt') return true;
          if (cond && typeof cond === 'object' && 'in' in (cond as object)) return (cond as { in: unknown[] }).in.includes(r[k]);
          if (cond === undefined) return true;
          return r[k] === cond;
        })).map((r) => ({ ...r }));
      },
      findUnique: async ({ where }: { where: { id: number } }) => { const r = store.find((x) => x.id === where.id); return r ? { ...r } : null; },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const not = (where['NOT'] as { id?: number } | undefined)?.id;
        const r = store.find((x) => {
          if (not !== undefined && x.id === not) return false;
          return Object.entries(where).every(([k, cond]) => k === 'NOT' ? true : x[k] === cond);
        });
        return r ? { ...r } : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const t = new Date();
        const row: Row = { id: nextId++, createdAt: t, updatedAt: t, updatedBy: null, deletedAt: null, deletedBy: null, ...data } as Row;
        store.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = store.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; }
    };
  }

  const fake = {
    tidConfigStatus: model(tidStatuses),
    tid: model(tids),
    bank: model(banks),
    partner: model(partners),
    receiveAccount: model(receiveAccounts),
    dossierSource: model(dossierSources),
    industry: model(industries),
    dossier: model(dossiers),
    customer: model(customers),
    investor: model(investors),
    user: { findMany: async () => [{ id: 42, fullName: 'Người Kiểm Thử', username: 'tester' }] },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'Tid', version: 1 }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake)
  };
  return { db: fake as unknown as Db, tidStatuses, tids, banks, audits };
}

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}
const MANAGE = ['CONFIG_TID_MANAGE', 'CONFIG_TID_VIEW'];

describe('TID config status CRUD', () => {
  it('list thiếu quyền → FORBIDDEN nguyên văn', async () => {
    const r = await listStatuses({ db: makeFakeDb().db, user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });
  it('create tên rỗng → VALIDATION', async () => {
    const r = await createStatus({ db: makeFakeDb().db, user: authUser(MANAGE) }, { name: ' ' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Tên trạng thái TID bắt buộc.');
  });
  it('create trùng tên → DUPLICATE', async () => {
    const r = await createStatus({ db: makeFakeDb().db, user: authUser(MANAGE) }, { name: 'Đang chạy' });
    expect(r.error).toBe('DUPLICATE');
    expect(r.message).toBe('Trạng thái "Đang chạy" đã tồn tại.');
  });
  it('create hợp lệ + audit', async () => {
    const { db, tidStatuses, audits } = makeFakeDb();
    const r = await createStatus({ db, user: authUser(MANAGE) }, { name: 'Tạm dừng' });
    expect(r.ok).toBe(true);
    expect(tidStatuses.some((s) => s['name'] === 'Tạm dừng' && s['createdBy'] === 42)).toBe(true);
    expect(audits.some((a) => a['action'] === 'TID_CONFIG_STATUS_CREATED')).toBe(true);
  });
  it('update stale → STALE_WRITE', async () => {
    const r = await updateStatus({ db: makeFakeDb().db, user: authUser(MANAGE) }, 1, { name: 'X', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
    expect(r.error).toBe('STALE_WRITE');
  });
  it('delete chưa chọn → VALIDATION; có id → soft-delete + audit', async () => {
    const { db, tidStatuses, audits } = makeFakeDb();
    const bad = await deleteStatuses({ db, user: authUser(MANAGE) }, []);
    expect(bad.error).toBe('VALIDATION');
    expect(bad.message).toBe('Chưa chọn trạng thái để xóa.');
    const ok = await deleteStatuses({ db, user: authUser(MANAGE) }, [1]);
    expect(ok.ok).toBe(true);
    expect(tidStatuses[0]!.deletedAt).toBeInstanceOf(Date);
    expect(audits.some((a) => a['action'] === 'TID_CONFIG_STATUS_DELETED')).toBe(true);
  });
});

describe('validateRefs', () => {
  it('ngân hàng không tồn tại → NOT_FOUND', async () => {
    const { db } = makeFakeDb();
    const r = await validateRefs(db, { bankId: 999, partnerId: 10 });
    expect(r!.error).toBe('NOT_FOUND');
    expect(r!.message).toBe('Ngân hàng đã chọn không tồn tại.');
  });
  it('đối tác không tồn tại → NOT_FOUND', async () => {
    const { db } = makeFakeDb();
    const r = await validateRefs(db, { bankId: 30, partnerId: 999 });
    expect(r!.message).toBe('Đối tác đã chọn không tồn tại.');
  });
  it('đủ khóa hợp lệ → null', async () => {
    const { db } = makeFakeDb();
    const r = await validateRefs(db, { bankId: 30, partnerId: 10, receiveAccountId: 50, configStatusId: 1, dossierSourceId: 60 });
    expect(r).toBeNull();
  });
});

describe('createConfigTid / updateConfigTid', () => {
  it('TID rỗng → VALIDATION', async () => {
    const r = await createConfigTid({ db: makeFakeDb().db, user: authUser(MANAGE) }, { tid: ' ', bankId: 30, partnerId: 10, hkdName: 'HKD A' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Chuỗi TID bắt buộc.');
  });
  it('hợp lệ → tạo status UNASSIGNED + audit TID_CONFIG_CREATED', async () => {
    const { db, tids, audits } = makeFakeDb();
    const r = await createConfigTid({ db, user: authUser(MANAGE) }, { tid: 'TID001', bankId: 30, partnerId: 10, hkdName: 'HKD A', configStatusId: 1 });
    expect(r.ok).toBe(true);
    expect(tids[0]!['status']).toBe('UNASSIGNED');
    expect(tids[0]!['createdBy']).toBe(42);
    expect(audits.some((a) => a['action'] === 'TID_CONFIG_CREATED')).toBe(true);
  });
  it('trùng TID → DUPLICATE', async () => {
    const { db } = makeFakeDb();
    const ctx: ServiceCtx = { db, user: authUser(MANAGE) };
    await createConfigTid(ctx, { tid: 'TID001', bankId: 30, partnerId: 10, hkdName: 'HKD A' });
    const r = await createConfigTid(ctx, { tid: 'TID001', bankId: 30, partnerId: 10, hkdName: 'HKD B' });
    expect(r.error).toBe('DUPLICATE');
    expect(r.message).toBe('TID "TID001" đã tồn tại.');
  });
  it('Phase B: create ghi receiveAccountId + investFeeMilli; list trả receiveAccountLabel + owyType/owyName; update đổi được', async () => {
    const { db, tids } = makeFakeDb();
    const ctx: ServiceCtx = { db, user: authUser(MANAGE) };
    const ok = await createConfigTid(ctx, { tid: 'TID-RA', bankId: 30, partnerId: 10, hkdName: 'HKD A', receiveAccountId: 50, investFeeMilli: 150 });
    expect(ok.ok).toBe(true);
    expect(tids[0]!['receiveAccountId']).toBe(50);
    expect(tids[0]!['investFeeMilli']).toBe(150);
    const list = await listConfigTids(ctx, {});
    const dto = list.data![0]!;
    expect(dto.receiveAccountId).toBe(50);
    expect(dto.receiveAccountLabel).toBe('123 · CTY A');
    expect(dto.owyType).toBe('INVESTOR');
    expect(dto.owyName).toBe('NĐT Chín');
    expect(dto.investFeeMilli).toBe(150);
    const upd = await updateConfigTid(ctx, dto.id, { tid: 'TID-RA', bankId: 30, partnerId: 10, hkdName: 'HKD A', investFeeMilli: 200 });
    expect(upd.ok).toBe(true);
    expect(tids[0]!['investFeeMilli']).toBe(200);
  });
  it('update ngành nghề ngừng dùng → VALIDATION', async () => {
    const { db } = makeFakeDb();
    const ctx: ServiceCtx = { db, user: authUser(MANAGE) };
    await createConfigTid(ctx, { tid: 'TID002', bankId: 30, partnerId: 10, hkdName: 'HKD A' });
    const id = (await listConfigTids(ctx, {})).data![0]!.id;
    const r = await updateConfigTid(ctx, id, { tid: 'TID002', bankId: 30, partnerId: 10, hkdName: 'HKD A', industryId: 999 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Ngành nghề đã chọn không tồn tại hoặc đã ngừng dùng.');
  });
});

describe('listConfigTids + deleteConfigTids (nội bộ)', () => {
  it('list join bank/partner/status/customer + trail', async () => {
    const { db } = makeFakeDb();
    const ctx: ServiceCtx = { db, user: authUser(MANAGE) };
    await createConfigTid(ctx, { tid: 'TID003', bankId: 30, partnerId: 10, hkdName: 'HKD A', configStatusId: 1 });
    const r = await listConfigTids(ctx, {});
    expect(r.ok).toBe(true);
    expect(r.data![0]!.bankCode).toBe('VCB');
    expect(r.data![0]!.partnerName).toBe('Đối tác A');
    expect(r.data![0]!.configStatusName).toBe('Đang chạy');
    expect(r.data![0]!.createdByName).toBe('Người Kiểm Thử');
  });
  it('deleteConfigTids soft-delete + audit TID_CONFIG_DELETED', async () => {
    const { db, tids, audits } = makeFakeDb();
    const ctx: ServiceCtx = { db, user: authUser(MANAGE) };
    await createConfigTid(ctx, { tid: 'TID004', bankId: 30, partnerId: 10, hkdName: 'HKD A' });
    const id = tids[0]!.id;
    const r = await deleteConfigTids(ctx, [id]);
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(1);
    expect(tids[0]!.deletedAt).toBeInstanceOf(Date);
    expect(audits.some((a) => a['action'] === 'TID_CONFIG_DELETED')).toBe(true);
  });
});
