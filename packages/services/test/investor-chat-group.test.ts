// Test LÕI THUẦN investor-chat-group core (@sigma/services) — KHÔNG cần Postgres/Electron: Db GIẢ in-memory ĐÚNG
// SHAPE Prisma (investor / chatRoom / investorChatGroup / auditLog) + ServiceCtx. NHÂN BẢN kiểm thử customer-chat-
// group nhưng theo investorId (NHIỀU nhóm active/NĐT, KHÔNG khóa loại phí). ASSERT error code + nguyên văn message
// tiếng Việt + kỳ gán/xóa (unassignedAt) + roomName join. Thêm: gán nhóm vào TK nhận tiền (validate group ↔ investor
// + uỷ khác NĐT thì clear).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  listInvestorChatGroups, createInvestorChatGroup, updateInvestorChatGroup, deleteInvestorChatGroup, listAssignableInvestorChatGroups,
  createRcvAccount, updateRcvAccount, listRcvAccounts,
  type ServiceCtx
} from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

interface FakeGroup {
  id: number; investorId: number; roomId: string | null; name: string | null;
  link: string | null; qr: string | null; note: string | null;
  createdBy: number | null; assignedFrom: Date; unassignedAt: Date | null;
}
interface FakeRoom { id: string; type: string; name: string | null; deletedAt: Date | null }
interface FakeOpts {
  investor?: { id: number; deletedAt: Date | null } | null;
  rooms?: FakeRoom[];
  groups?: Partial<FakeGroup>[];
}
function mkGroup(g: Partial<FakeGroup>): FakeGroup {
  return {
    id: g.id ?? 0, investorId: g.investorId ?? 8, roomId: g.roomId ?? null, name: g.name ?? null,
    link: g.link ?? null, qr: g.qr ?? null, note: g.note ?? null, createdBy: g.createdBy ?? null,
    assignedFrom: g.assignedFrom ?? new Date('2026-01-01T00:00:00Z'), unassignedAt: g.unassignedAt ?? null
  };
}

function makeFakeDb(opts: FakeOpts = {}) {
  const investorSeed = opts.investor === undefined ? { id: 8, deletedAt: null } : opts.investor;
  const roomSeed: FakeRoom[] = opts.rooms ?? [
    { id: 'room-A', type: 'GROUP', name: 'Nhóm NĐT A', deletedAt: null },
    { id: 'room-B', type: 'GROUP', name: 'Nhóm NĐT B', deletedAt: null }
  ];
  const groups: FakeGroup[] = (opts.groups ?? []).map(mkGroup);
  const audits: Record<string, unknown>[] = [];
  let nextId = groups.reduce((m, g) => Math.max(m, g.id), 0) + 1;

  const matchWhere = (g: FakeGroup, where?: Record<string, unknown>): boolean => {
    if (!where) return true;
    if (where['investorId'] !== undefined && g.investorId !== where['investorId']) return false;
    if ('unassignedAt' in where && g.unassignedAt !== (where['unassignedAt'] ?? null)) return false;
    if (where['roomId'] !== undefined && g.roomId !== where['roomId']) return false;
    const idW = where['id'];
    if (typeof idW === 'number' && g.id !== idW) return false;
    if (idW && typeof idW === 'object' && 'not' in idW && g.id === (idW as { not: number }).not) return false;
    return true;
  };

  const investorChatGroup = {
    findMany: async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown }) => {
      let rows = groups.filter((g) => matchWhere(g, where)).map((g) => ({ ...g }));
      if (orderBy) rows = rows.sort((a, b) => a.id - b.id);
      return rows;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const g = groups.find((x) => matchWhere(x, where));
      return g ? { ...g } : null;
    },
    findUnique: async ({ where }: { where: { id: number } }) => {
      const g = groups.find((x) => x.id === where.id);
      return g ? { ...g } : null;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = mkGroup({
        id: nextId++, investorId: data['investorId'] as number, roomId: (data['roomId'] as string | null) ?? null,
        name: (data['name'] as string | null) ?? null, link: (data['link'] as string | null) ?? null,
        qr: (data['qr'] as string | null) ?? null, note: (data['note'] as string | null) ?? null,
        createdBy: (data['createdBy'] as number | null) ?? null, assignedFrom: (data['assignedFrom'] as Date) ?? new Date(),
        unassignedAt: (data['unassignedAt'] as Date | null) ?? null
      });
      groups.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
      const g = groups.find((x) => x.id === where.id);
      if (!g) throw new Error('group not found');
      for (const [k, v] of Object.entries(data)) (g as unknown as Record<string, unknown>)[k] = v;
      return { ...g };
    }
  };

  const chatRoom = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const r = roomSeed.find((x) => x.id === where.id);
      return r ? { id: r.id, deletedAt: r.deletedAt } : null;
    },
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      roomSeed.filter((r) => where.id.in.includes(r.id)).map((r) => ({ id: r.id, name: r.name }))
  };

  const investor = {
    findFirst: async ({ where }: { where: { id: number; deletedAt: null } }) =>
      (investorSeed && investorSeed.id === where.id && investorSeed.deletedAt === null ? { id: investorSeed.id } : null)
  };

  const fake = {
    investor, chatRoom, investorChatGroup,
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'Investor', version: 1 }) },
    // Fix audit #5a — create/update/delete giờ bọc $transaction; fake chạy thẳng callback với chính nó.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake)
  };
  return { db: fake as unknown as Db, groups, audits };
}

// ───────────────────────── create ─────────────────────────
describe('createInvestorChatGroup', () => {
  it('thiếu quyền INVESTOR_UPDATE → FORBIDDEN', async () => {
    const { db } = makeFakeDb();
    const r = await createInvestorChatGroup({ db, user: authUser(['INVESTOR_VIEW']) }, 8, { name: 'X' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('NĐT không tồn tại → NOT_FOUND', async () => {
    const { db, groups } = makeFakeDb({ investor: null });
    const r = await createInvestorChatGroup({ db, user: authUser(['INVESTOR_UPDATE']) }, 999, { name: 'X' });
    expect(r.error).toBe('NOT_FOUND');
    expect(r.message).toBe('Nhà đầu tư không tồn tại (hoặc đã bị xóa).');
    expect(groups).toHaveLength(0);
  });

  it('tạo hợp lệ (tên + roomId) → ok + kỳ active + createdBy + audit INVESTOR_UPDATED', async () => {
    const { db, groups, audits } = makeFakeDb();
    const r = await createInvestorChatGroup({ db, user: authUser(['INVESTOR_UPDATE']) }, 8, { name: 'Nhóm 1', roomId: 'room-A', link: 'https://a' });
    expect(r.ok).toBe(true);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe('Nhóm 1');
    expect(groups[0]!.roomId).toBe('room-A');
    expect(groups[0]!.createdBy).toBe(42);
    expect(groups[0]!.unassignedAt).toBeNull();
    expect(audits[0]!['action']).toBe('INVESTOR_UPDATED');
    expect(audits[0]!['targetType']).toBe('Investor');
  });

  it('NHIỀU nhóm active / 1 NĐT được phép (không khóa loại phí)', async () => {
    const { db, groups } = makeFakeDb();
    await createInvestorChatGroup({ db, user: authUser(['INVESTOR_UPDATE']) }, 8, { name: 'N1', roomId: 'room-A' });
    const r2 = await createInvestorChatGroup({ db, user: authUser(['INVESTOR_UPDATE']) }, 8, { name: 'N2', roomId: 'room-B' });
    expect(r2.ok).toBe(true);
    expect(groups.filter((g) => g.unassignedAt === null)).toHaveLength(2);
  });

  it('roomId trỏ phòng không tồn tại → VALIDATION', async () => {
    const { db, groups } = makeFakeDb();
    const r = await createInvestorChatGroup({ db, user: authUser(['INVESTOR_UPDATE']) }, 8, { roomId: 'room-X' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Phòng chat được chọn không tồn tại (hoặc đã bị xóa). Vui lòng chọn lại.');
    expect(groups).toHaveLength(0);
  });

  it('trùng roomId ACTIVE của cùng NĐT → VALIDATION', async () => {
    const { db } = makeFakeDb({ groups: [{ id: 1, investorId: 8, roomId: 'room-A' }] });
    const r = await createInvestorChatGroup({ db, user: authUser(['INVESTOR_UPDATE']) }, 8, { roomId: 'room-A' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toContain('đã là nhóm của một nhà đầu tư khác');
  });

  // FIX INV-1: 1 phòng = 1 NĐT — phòng đang ACTIVE cho NĐT KHÁC cũng bị chặn (không chỉ cùng NĐT).
  // room-A đang là nhóm của NĐT 7; NĐT 8 (được seed hợp lệ) không được chiếm lại room-A.
  it('trùng roomId ACTIVE của NĐT KHÁC → VALIDATION (cross-investor, 1 phòng 1 NĐT)', async () => {
    const { db } = makeFakeDb({ groups: [{ id: 1, investorId: 7, roomId: 'room-A' }] });
    const r = await createInvestorChatGroup({ db, user: authUser(['INVESTOR_UPDATE']) }, 8, { roomId: 'room-A' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Phòng chat này đã là nhóm của một nhà đầu tư khác. Vui lòng chọn phòng khác.');
  });
});

// ───────────────────────── list + picker ─────────────────────────
describe('listInvestorChatGroups', () => {
  it('thiếu quyền INVESTOR_VIEW → FORBIDDEN', async () => {
    const { db } = makeFakeDb();
    const r = await listInvestorChatGroups({ db, user: authUser([]) }, 8);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('trả kỳ active + roomName (join), ẩn kỳ đã đóng', async () => {
    const { db } = makeFakeDb({
      groups: [
        { id: 1, investorId: 8, roomId: 'room-A', name: 'N1', link: 'https://a' },
        { id: 2, investorId: 8, roomId: 'room-B', name: 'N2', unassignedAt: new Date() }
      ]
    });
    const r = await listInvestorChatGroups({ db, user: authUser(['INVESTOR_VIEW']) }, 8);
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(r.data![0]!.roomId).toBe('room-A');
    expect(r.data![0]!.roomName).toBe('Nhóm NĐT A');
    expect(r.data![0]!.name).toBe('N1');
  });

  it('CHỈ trả nhóm của ĐÚNG NĐT (không lẫn NĐT khác)', async () => {
    const { db } = makeFakeDb({
      groups: [
        { id: 1, investorId: 8, roomId: 'room-A', name: 'Của 8' },
        { id: 2, investorId: 9, roomId: 'room-B', name: 'Của 9' }
      ]
    });
    const r = await listInvestorChatGroups({ db, user: authUser(['INVESTOR_VIEW']) }, 8);
    expect(r.data!.map((x) => x.id)).toEqual([1]);
  });
});

describe('listAssignableInvestorChatGroups', () => {
  it('picker trả {id,name} theo NĐT; fallback tên phòng khi name null', async () => {
    const { db } = makeFakeDb({
      groups: [
        { id: 1, investorId: 8, roomId: 'room-A', name: 'Đặt tên' },
        { id: 2, investorId: 8, roomId: 'room-B', name: null } // fallback → roomName 'Nhóm NĐT B'
      ]
    });
    const r = await listAssignableInvestorChatGroups({ db, user: authUser(['INVESTOR_VIEW']) }, 8);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([{ id: 1, name: 'Đặt tên' }, { id: 2, name: 'Nhóm NĐT B' }]);
  });
});

// ───────────────────────── update + delete ─────────────────────────
describe('updateInvestorChatGroup', () => {
  it('sửa tên/link tại chỗ → ok', async () => {
    const { db, groups } = makeFakeDb({ groups: [{ id: 1, investorId: 8, roomId: 'room-A', name: 'cũ', link: 'old' }] });
    const r = await updateInvestorChatGroup({ db, user: authUser(['INVESTOR_UPDATE']) }, 1, { name: 'mới', link: 'new' });
    expect(r.ok).toBe(true);
    expect(groups[0]!.name).toBe('mới');
    expect(groups[0]!.link).toBe('new');
  });

  it('nhóm không tồn tại / đã đóng kỳ → NOT_FOUND', async () => {
    const { db } = makeFakeDb({ groups: [{ id: 1, investorId: 8, roomId: 'room-A', unassignedAt: new Date() }] });
    const r = await updateInvestorChatGroup({ db, user: authUser(['INVESTOR_UPDATE']) }, 1, { name: 'x' });
    expect(r.error).toBe('NOT_FOUND');
  });

  it('đổi roomId trùng phòng active khác → VALIDATION', async () => {
    const { db } = makeFakeDb({
      groups: [
        { id: 1, investorId: 8, roomId: 'room-A' },
        { id: 2, investorId: 8, roomId: 'room-B' }
      ]
    });
    const r = await updateInvestorChatGroup({ db, user: authUser(['INVESTOR_UPDATE']) }, 1, { roomId: 'room-B' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toContain('đã là nhóm của một nhà đầu tư khác');
  });
});

describe('deleteInvestorChatGroup', () => {
  it('xóa = đóng kỳ (set unassignedAt), GIỮ hàng + audit', async () => {
    const { db, groups, audits } = makeFakeDb({ groups: [{ id: 1, investorId: 8, roomId: 'room-A' }] });
    const r = await deleteInvestorChatGroup({ db, user: authUser(['INVESTOR_UPDATE']) }, 1);
    expect(r.ok).toBe(true);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.unassignedAt).toBeInstanceOf(Date);
    expect(audits.some((a) => a['action'] === 'INVESTOR_UPDATED')).toBe(true);
  });

  it('xóa nhóm đã đóng kỳ → NOT_FOUND', async () => {
    const { db } = makeFakeDb({ groups: [{ id: 1, investorId: 8, unassignedAt: new Date() }] });
    const r = await deleteInvestorChatGroup({ db, user: authUser(['INVESTOR_UPDATE']) }, 1);
    expect(r.error).toBe('NOT_FOUND');
  });
});

// ───────────────────────── gán vào TK nhận tiền ─────────────────────────
interface Row { id: number; deletedAt: Date | null; [k: string]: unknown }
function makeTable(seed: Row[]) {
  const rows = seed.map((r) => ({ ...r }));
  let nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  return {
    rows,
    findMany: async (args?: { where?: Record<string, unknown> }) => {
      const w = args?.where ?? {};
      const idIn = (w['id'] as { in?: number[] } | undefined)?.in;
      return rows
        .filter((r) => (!('deletedAt' in w) || r.deletedAt === (w['deletedAt'] ?? null)))
        .filter((r) => (idIn === undefined || idIn.includes(r.id as number)))
        .map((r) => ({ ...r }))
        .sort((a, b) => a.id - b.id);
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((r) => Object.entries(where).every(([k, v]) => (k === 'unassignedAt' ? r[k] === (v ?? null) : r[k] === v))) ?? null,
    findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r.id === where.id) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: nextId++, deletedAt: null, updatedBy: null, createdAt: new Date(), updatedAt: new Date(), ...data } as Row; rows.push(row); return { ...row }; },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = rows.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; },
    count: async () => 0
  };
}

/** Fake db đầy đủ cho createRcvAccount + list join nhóm chat NĐT. NĐT #8 có nhóm #1 (room-A); NĐT #9 có nhóm #2. */
function makeRcvFake(perms: string[]) {
  const audits: Record<string, unknown>[] = [];
  const fake: Record<string, unknown> = {
    user: { findMany: async () => [{ id: 42, fullName: 'Người Kiểm Thử', username: 'tester' }] },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) },
    receiveAccountSource: makeTable([{ id: 1, name: 'Nguồn A', deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }]),
    bank: makeTable([{ id: 1, code: 'EIB', name: 'Ngân hàng Exim', deletedAt: null } as Row]),
    customer: makeTable([{ id: 5, nickname: 'Anh Năm', fullName: 'Trần Năm', deletedAt: null } as Row]),
    investor: makeTable([{ id: 8, nickname: 'NĐT Tám', fullName: 'Lê Tám', deletedAt: null } as Row, { id: 9, nickname: 'NĐT Chín', fullName: 'Lê Chín', deletedAt: null } as Row]),
    investorChatGroup: makeTable([
      { id: 1, investorId: 8, roomId: 'room-A', name: 'Nhóm 8', unassignedAt: null, deletedAt: null } as Row,
      { id: 2, investorId: 9, roomId: null, name: 'Nhóm 9', unassignedAt: null, deletedAt: null } as Row,
      { id: 3, investorId: 8, roomId: null, name: 'Nhóm 8 cũ', unassignedAt: new Date(), deletedAt: null } as Row // đã đóng kỳ
    ]),
    chatRoom: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => [{ id: 'room-A', name: 'Nhóm NĐT A' }].filter((r) => where.id.in.includes(r.id)) }
  };
  const accounts = makeTable([]);
  fake.receiveAccount = accounts;
  const ctx: ServiceCtx = { db: fake as unknown as Db, user: authUser(perms) };
  return { ctx, accounts, audits };
}
const MANAGE = 'CONFIG_RCV_ACCT_MANAGE';
const VIEW = 'CONFIG_RCV_ACCT_VIEW';

describe('receive-account gán nhóm chat NĐT', () => {
  it('uỷ=NĐT + group thuộc đúng NĐT → ghi investorChatGroupId + list trả tên nhóm', async () => {
    const { ctx: c, accounts } = makeRcvFake([MANAGE, VIEW]);
    const r = await createRcvAccount(c, { sourceId: 1, accountName: 'A', accountNumber: '01', bankId: 1, investorId: 8, investorChatGroupId: 1 });
    expect(r.ok).toBe(true);
    const saved = accounts.rows.find((x) => x.accountNumber === '01')!;
    expect(saved.investorChatGroupId).toBe(1);
    const list = await listRcvAccounts(c);
    const dto = list.data!.find((x) => x.accountNumber === '01')!;
    expect(dto.investorChatGroupId).toBe(1);
    expect(dto.investorChatGroupName).toBe('Nhóm 8');
  });

  it('group KHÔNG thuộc NĐT được chọn → VALIDATION, KHÔNG ghi', async () => {
    const { ctx: c, accounts } = makeRcvFake([MANAGE]);
    const r = await createRcvAccount(c, { sourceId: 1, accountName: 'A', accountNumber: '02', bankId: 1, investorId: 8, investorChatGroupId: 2 }); // #2 của NĐT 9
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toContain('không thuộc nhà đầu tư này');
    expect(accounts.rows.find((x) => x.accountNumber === '02')).toBeUndefined();
  });

  it('group đã đóng kỳ (unassignedAt) → VALIDATION', async () => {
    const { ctx: c } = makeRcvFake([MANAGE]);
    const r = await createRcvAccount(c, { sourceId: 1, accountName: 'A', accountNumber: '03', bankId: 1, investorId: 8, investorChatGroupId: 3 });
    expect(r.error).toBe('VALIDATION');
  });

  it('uỷ=Khách (không NĐT) nhưng gửi investorChatGroupId → CLEAR null (không lỗi)', async () => {
    const { ctx: c, accounts } = makeRcvFake([MANAGE]);
    const r = await createRcvAccount(c, { sourceId: 1, accountName: 'A', accountNumber: '04', bankId: 1, customerId: 5, investorChatGroupId: 1 });
    expect(r.ok).toBe(true);
    expect(accounts.rows.find((x) => x.accountNumber === '04')!.investorChatGroupId).toBe(null);
  });

  it('update đổi uỷ NĐT→Khách → clear investorChatGroupId về null', async () => {
    const { ctx: c, accounts } = makeRcvFake([MANAGE]);
    accounts.rows.push({ id: 20, sourceId: 1, accountName: 'X', accountNumber: '20', bankId: 1, customerId: null, investorId: 8, investorChatGroupId: 1, deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date('2026-01-01') } as Row);
    const r = await updateRcvAccount(c, 20, { sourceId: 1, accountName: 'X', accountNumber: '20', bankId: 1, customerId: 5, investorId: null });
    expect(r.ok).toBe(true);
    const saved = accounts.rows.find((x) => x.id === 20)!;
    expect(saved.investorId).toBe(null);
    expect(saved.investorChatGroupId).toBe(null);
  });
});
