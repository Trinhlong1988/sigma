// Test LÕI THUẦN receive-account core (@sigma/services) — Db GIẢ in-memory + ServiceCtx. ASSERT error code + nguyên
// văn message + audit + soft-delete + ref-guard. §14 mật khẩu ở ADAPTER (lõi KHÔNG kiểm password).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  listRcvSources, createRcvSource, updateRcvSource, deleteRcvSources,
  listRcvAccounts, createRcvAccount, updateRcvAccount, deleteRcvAccounts,
  type ServiceCtx
} from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}
const VIEW = 'CONFIG_RCV_ACCT_VIEW';
const MANAGE = 'CONFIG_RCV_ACCT_MANAGE';

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
      // Khớp MỌI khóa scalar trong where (id/code/name/deletedAt…) — cần cho validateOwy findFirst theo {id, deletedAt}.
      return rows.find((r) => {
        if (not && r.id === not.id) return false;
        return Object.entries(where).every(([k, v]) => k === 'NOT' || k === 'OR' || r[k] === v);
      }) ?? null;
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

describe('rcv source core', () => {
  it('thiếu quyền VIEW → FORBIDDEN', async () => {
    const { fake } = baseFake();
    fake.receiveAccountSource = makeTable([]);
    const r = await listRcvSources(ctx(fake, []));
    expect(r.error).toBe('FORBIDDEN');
  });

  it('tạo thiếu tên → VALIDATION', async () => {
    const { fake } = baseFake();
    fake.receiveAccountSource = makeTable([]);
    const r = await createRcvSource(ctx(fake, [MANAGE]), { name: '  ' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Tên nguồn tài khoản bắt buộc.');
  });

  it('trùng tên → DUPLICATE; trong thùng rác → DUPLICATE_TRASH', async () => {
    const { fake } = baseFake();
    fake.receiveAccountSource = makeTable([{ id: 1, name: 'Nguồn A', deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }]);
    const dup = await createRcvSource(ctx(fake, [MANAGE]), { name: 'Nguồn A' });
    expect(dup.error).toBe('DUPLICATE');

    const { fake: f2 } = baseFake();
    f2.receiveAccountSource = makeTable([{ id: 1, name: 'Nguồn B', deletedAt: new Date(), createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }]);
    const trash = await createRcvSource(ctx(f2, [MANAGE]), { name: 'Nguồn B' });
    expect(trash.error).toBe('DUPLICATE_TRASH');
  });

  it('tạo hợp lệ → ok + audit', async () => {
    const { fake, audits } = baseFake();
    const t = makeTable([]);
    fake.receiveAccountSource = t;
    const r = await createRcvSource(ctx(fake, [MANAGE]), { name: 'Nguồn A' });
    expect(r.ok).toBe(true);
    expect(audits.some((a) => a['action'] === 'RCV_ACCT_SOURCE_CREATED')).toBe(true);
  });

  it('update stale → STALE_WRITE', async () => {
    const { fake } = baseFake();
    fake.receiveAccountSource = makeTable([{ id: 1, name: 'A', deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-02-01') }]);
    const r = await updateRcvSource(ctx(fake, [MANAGE]), 1, { name: 'B', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' });
    expect(r.error).toBe('STALE_WRITE');
  });

  it('xóa → soft-delete + audit', async () => {
    const { fake, audits } = baseFake();
    const t = makeTable([{ id: 1, name: 'A', deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }]);
    fake.receiveAccountSource = t;
    const r = await deleteRcvSources(ctx(fake, [MANAGE]), [1]);
    expect(r.ok).toBe(true);
    expect(t.rows[0]!.deletedAt).not.toBeNull();
    expect(audits.some((a) => a['action'] === 'RCV_ACCT_SOURCE_DELETED')).toBe(true);
  });
});

describe('rcv account core', () => {
  function withAcct(perms: string[]) {
    const { fake, audits } = baseFake();
    fake.receiveAccountSource = makeTable([{ id: 1, name: 'Nguồn A', deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }]);
    fake.bank = makeTable([{ id: 1, code: 'EIB', name: 'Ngân hàng Exim', deletedAt: null } as Row]);
    // Phase B — khách #5 + NĐT #8 CÓ THẬT để test UỶ (owy) validate + join owyName.
    fake.customer = makeTable([{ id: 5, nickname: 'Anh Năm', fullName: 'Trần Năm', deletedAt: null } as Row]);
    fake.investor = makeTable([{ id: 8, nickname: 'NĐT Tám', fullName: 'Lê Tám', deletedAt: null } as Row]);
    const accounts = makeTable([]);
    fake.receiveAccount = accounts;
    return { ctx: ctx(fake, perms), accounts, audits };
  }

  it('thiếu số tài khoản → VALIDATION', async () => {
    const { ctx: c } = withAcct([MANAGE]);
    const r = await createRcvAccount(c, { sourceId: 1, accountName: 'Chủ TK', accountNumber: '  ', bankId: 1 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Số tài khoản bắt buộc.');
  });

  it('ngân hàng không tồn tại → NOT_FOUND', async () => {
    const { ctx: c } = withAcct([MANAGE]);
    const r = await createRcvAccount(c, { sourceId: 1, accountName: 'Chủ TK', accountNumber: '0123', bankId: 999 });
    expect(r.error).toBe('NOT_FOUND');
    expect(r.message).toBe('Ngân hàng đã chọn không tồn tại.');
  });

  it('tạo hợp lệ → ok + audit', async () => {
    const { ctx: c, accounts, audits } = withAcct([MANAGE]);
    const r = await createRcvAccount(c, { sourceId: 1, accountName: 'Chủ TK', accountNumber: '0123', bankId: 1 });
    expect(r.ok).toBe(true);
    expect(accounts.rows[0]!.accountNumber).toBe('0123');
    expect(audits.some((a) => a['action'] === 'RCV_ACCT_CREATED')).toBe(true);
  });

  it('list có quyền → resolve tên nguồn/ngân hàng', async () => {
    const { ctx: c, accounts } = withAcct([VIEW]);
    accounts.rows.push({ id: 3, sourceId: 1, accountName: 'Chủ TK', accountNumber: '0123', bankId: 1, branch: null, cccdNumber: null, cccdIssueDate: null, cccdIssuePlace: null, cccdExpiry: null, phone: null, email: null, customerId: null, cccdFrontPath: null, cccdFrontName: null, cccdBackPath: null, cccdBackName: null, deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() } as Row);
    const r = await listRcvAccounts(c);
    expect(r.ok).toBe(true);
    const row = r.data!.find((x) => x.id === 3)!;
    expect(row.sourceName).toBe('Nguồn A');
    expect(row.bankCode).toBe('EIB');
  });

  it('UỶ set CẢ customerId LẪN investorId → VALIDATION (1 bên)', async () => {
    const { ctx: c } = withAcct([MANAGE]);
    const r = await createRcvAccount(c, { sourceId: 1, accountName: 'Chủ TK', accountNumber: '01', bankId: 1, customerId: 5, investorId: 8 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toContain('1 bên');
  });

  it('UỶ NĐT không tồn tại (investorId) → NOT_FOUND', async () => {
    const { ctx: c } = withAcct([MANAGE]);
    const r = await createRcvAccount(c, { sourceId: 1, accountName: 'Chủ TK', accountNumber: '02', bankId: 1, investorId: 999 });
    expect(r.error).toBe('NOT_FOUND');
    expect(r.message).toContain('Nhà đầu tư');
  });

  it('UỶ NĐT hợp lệ (investorId) → ghi investorId; list DERIVE owyType=INVESTOR + owyName + investorName', async () => {
    const { ctx: c, accounts } = withAcct([MANAGE, VIEW]);
    const r = await createRcvAccount(c, { sourceId: 1, accountName: 'Chủ TK', accountNumber: '03', bankId: 1, investorId: 8 });
    expect(r.ok).toBe(true);
    const saved = accounts.rows.find((x) => x.accountNumber === '03')!;
    expect(saved.investorId).toBe(8);
    expect(saved.customerId).toBe(null);
    const list = await listRcvAccounts(c);
    const dto = list.data!.find((x) => x.accountNumber === '03')!;
    expect(dto.owyType).toBe('INVESTOR');
    expect(dto.owyName).toBe('NĐT Tám');
    expect(dto.investorId).toBe(8);
    expect(dto.investorName).toBe('NĐT Tám');
  });

  it('UỶ Khách (customerId) → owyType=CUSTOMER; UỶ Nội bộ (cả 2 null) → owyType=INTERNAL', async () => {
    const { ctx: c, accounts } = withAcct([MANAGE, VIEW]);
    const rc = await createRcvAccount(c, { sourceId: 1, accountName: 'A', accountNumber: '04', bankId: 1, customerId: 5 });
    expect(rc.ok).toBe(true);
    const c4 = accounts.rows.find((x) => x.accountNumber === '04')!;
    expect(c4.customerId).toBe(5);
    expect(c4.investorId).toBe(null);
    const ri = await createRcvAccount(c, { sourceId: 1, accountName: 'B', accountNumber: '05', bankId: 1 });
    expect(ri.ok).toBe(true);
    const c5 = accounts.rows.find((x) => x.accountNumber === '05')!;
    expect(c5.customerId).toBe(null);
    expect(c5.investorId).toBe(null);
    const list = await listRcvAccounts(c);
    expect(list.data!.find((x) => x.accountNumber === '04')!.owyType).toBe('CUSTOMER');
    expect(list.data!.find((x) => x.accountNumber === '05')!.owyType).toBe('INTERNAL');
  });

  it('updateRcvAccount đổi UỶ Nội bộ → NĐT (investorId) hợp lệ', async () => {
    const { ctx: c, accounts } = withAcct([MANAGE]);
    accounts.rows.push({ id: 20, sourceId: 1, accountName: 'X', accountNumber: '20', bankId: 1, customerId: null, investorId: null, deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date('2026-01-01') } as Row);
    const r = await updateRcvAccount(c, 20, { sourceId: 1, accountName: 'X', accountNumber: '20', bankId: 1, investorId: 8 });
    expect(r.ok).toBe(true);
    const saved = accounts.rows.find((x) => x.id === 20)!;
    expect(saved.investorId).toBe(8);
    expect(saved.customerId).toBe(null);
  });

  it('xóa TK → soft-delete + audit', async () => {
    const { ctx: c, accounts, audits } = withAcct([MANAGE]);
    accounts.rows.push({ id: 9, sourceId: 1, accountName: 'X', accountNumber: '9', bankId: 1, deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() } as Row);
    const r = await deleteRcvAccounts(c, [9]);
    expect(r.ok).toBe(true);
    expect(accounts.rows.find((x) => x.id === 9)!.deletedAt).not.toBeNull();
    expect(audits.some((a) => a['action'] === 'RCV_ACCT_DELETED')).toBe(true);
  });
});
