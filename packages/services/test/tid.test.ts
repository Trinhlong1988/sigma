// Test LÕI THUẦN tid core (@sigma/services) — Db GIẢ in-memory + ServiceCtx = { db, user }. ASSERT giá trị cụ thể:
// error code + nguyên văn message tiếng Việt + tx NHIỀU BẢNG (tid/posDevice/posTidBinding/assetEvent) + guard
// bất biến 1 máy 1 TID + khóa FOR UPDATE re-check double-delivery (optimistic-lock analog) + audit.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  listTids, createTidUnified, assignTid, markTidDelivered, recallTid, replaceTid,
  type ServiceCtx
} from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}
const ctxOf = (fake: Record<string, unknown>, perms: string[]): ServiceCtx => ({ db: fake as unknown as Db, user: authUser(perms) });

function baseFake() {
  const audits: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const bindings: Record<string, unknown>[] = [];
  const fake: Record<string, unknown> = {
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) },
    // maps rỗng cho buildTidMaps/list (không có FK cần resolve trong test cơ bản).
    bank: { findMany: async () => [], findUnique: async ({ where }: { where: { id: number } }) => (where.id === 1 ? { id: 1, deletedAt: null, code: 'B1', name: 'Bank 1' } : null) },
    partner: { findMany: async () => [], findUnique: async ({ where }: { where: { id: number } }) => (where.id === 2 ? { id: 2, deletedAt: null, code: 'P1', name: 'Đối tác 1' } : null) },
    tidConfigStatus: { findMany: async () => [], findUnique: async () => null },
    dossierSource: { findMany: async () => [], findUnique: async () => null },
    // Phase B — buildTidMaps join TK nhận tiền (receiveAccount.findMany) + validateConfigRefs (findUnique id 50 hợp lệ).
    receiveAccount: { findMany: async () => [], findUnique: async ({ where }: { where: { id: number } }) => (where.id === 50 ? { id: 50, deletedAt: null } : null) },
    // [B265 24/11] assignTid nay KIỂM khách tồn tại qua findFirst({id, deletedAt:null}) — mock phải có
    // ĐÚNG shape thật (bài học mock-sai-shape: thiếu hàm là 10 test đỏ oan TypeError).
    customer: { findMany: async () => [], findUnique: async ({ where }: { where: { id: number } }) => (where.id === 7 ? { id: 7, deletedAt: null, nickname: 'Anh Bảy', fullName: 'Nguyễn Bảy', agentId: null } : null), findFirst: async ({ where }: { where: { id: number } }) => (where.id === 7 || where.id === 8 ? { id: where.id } : null) },
    agent: { findMany: async () => [], findUnique: async () => null },
    industry: { findMany: async () => [], findUnique: async ({ where }: { where: { id: number } }) => (where.id === 3 ? { id: 3, deletedAt: null, active: true, name: 'Ăn uống' } : null) },
    posTidBinding: { create: async ({ data }: { data: Record<string, unknown> }) => { bindings.push({ ...data }); return { ...data }; }, updateMany: async () => ({ count: 0 }) },
    assetEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { events.push({ ...data }); return { ...data }; }, findMany: async () => [] },
    // Phase B — owy investor (mặc định rỗng; test override khi cần).
    investor: { findMany: async () => [] },
    // P4 — buildTidMaps batch cảnh báo giao-dở (mặc định rỗng → false; test override khi cần).
    customerChatGroup: { findMany: async () => [] },
    tidSellFee: { findMany: async () => [] }
  };
  return { fake, audits, events, bindings };
}

describe('tid core — quyền + list', () => {
  it('thiếu quyền xem (không TID_VIEW/CONFIG_TID_VIEW) → FORBIDDEN nguyên văn', async () => {
    const { fake } = baseFake();
    fake.tid = { findMany: async () => [] };
    const r = await listTids(ctxOf(fake, []));
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('có TID_VIEW → list ok + DTO derive deviceAssigned/delivered + shape phân trang (FIX-PERF B132)', async () => {
    const { fake } = baseFake();
    const rows = [{ id: 1, tid: 'T1', mid: null, bank: null, status: 'ACTIVE', posSerial: 'S1', customerId: null, agentId: null, openedAt: new Date('2026-01-01'), deliveredAt: new Date('2026-01-02'), closedAt: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), customerDeviceSerial: null, dossierId: null, industryId: null, bankId: null, partnerId: null, hkdName: 'HKD A', receiveAccountId: null, issuedAt: null, configStatusId: null, dossierSourceId: null, note: null }];
    // FIX-PERF B132: count + findMany(skip/take) như Prisma. take mặc định 100 → slice không đổi ở seed 1 hàng.
    fake.tid = { count: async () => rows.length, findMany: async ({ skip, take }: { skip?: number; take?: number } = {}) => rows.slice(skip ?? 0, take === undefined ? undefined : (skip ?? 0) + take) };
    const r = await listTids(ctxOf(fake, ['TID_VIEW']));
    expect(r.ok).toBe(true);
    expect(r.data![0]!.deviceAssigned).toBe(true);
    expect(r.data![0]!.delivered).toBe(true);
    expect(r.data![0]!.holdingCustomerName).toBe(null); // customerId null → không có khách giữ
    expect(r.total).toBe(1);
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(100);
  });

  it('FIX-PERF B132: page/pageSize cắt trang TID + total là tổng khớp + pageSize kẹp 500', async () => {
    const { fake } = baseFake();
    const mk = (id: number) => ({ id, tid: `T${id}`, mid: null, bank: null, status: 'UNASSIGNED', posSerial: null, customerId: null, agentId: null, openedAt: null, deliveredAt: null, closedAt: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), customerDeviceSerial: null, dossierId: null, industryId: null, bankId: null, partnerId: null, hkdName: null, receiveAccountId: null, issuedAt: null, configStatusId: null, dossierSourceId: null, note: null });
    const all = [mk(1), mk(2), mk(3), mk(4), mk(5)];
    fake.tid = { count: async () => all.length, findMany: async ({ skip, take }: { skip?: number; take?: number } = {}) => all.slice(skip ?? 0, take === undefined ? undefined : (skip ?? 0) + take) };
    const r = await listTids(ctxOf(fake, ['TID_VIEW']), { page: 2, pageSize: 2 });
    expect(r.total).toBe(5);
    expect(r.page).toBe(2);
    expect(r.pageSize).toBe(2);
    expect(r.data!.map((t) => t.tid)).toEqual(['T3', 'T4']);
    const r2 = await listTids(ctxOf(fake, ['TID_VIEW']), { pageSize: 9999 });
    expect(r2.pageSize).toBe(500);
  });
});

describe('tid core — holdingCustomerName loại TID terminal (TID-1)', () => {
  const mkRow = (over: Record<string, unknown>) => ({ id: 1, tid: 'T1', mid: null, bank: null, status: 'ACTIVE', posSerial: 'S1', customerId: 7, agentId: null, openedAt: new Date('2026-01-01'), deliveredAt: new Date('2026-01-02'), closedAt: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), customerDeviceSerial: null, dossierId: null, industryId: null, bankId: null, partnerId: null, hkdName: 'HKD A', receiveAccountId: null, investFeeMilli: null, issuedAt: null, configStatusId: null, dossierSourceId: null, note: null, ...over });

  // DEAD/SOLD dù ĐÃ GIAO (deliveredAt set) + còn customerId → KHÔNG hiện "khách đang giữ". customerName (danh mục)
  // vẫn resolve → chứng minh map khách CÓ id 7 (nếu không loại DEAD/SOLD thì holdingCustomerName sẽ ra tên).
  for (const st of ['DEAD', 'SOLD']) {
    it(`TID ${st} đã giao → holdingCustomerName = null (không phải khách đang giữ), customerName vẫn có`, async () => {
      const { fake } = baseFake();
      fake.customer = { findMany: async () => [{ id: 7, nickname: 'Anh Bảy', fullName: 'Nguyễn Bảy' }], findUnique: async () => ({ id: 7, deletedAt: null }) };
      const rows = [mkRow({ status: st })];
      fake.tid = { count: async () => rows.length, findMany: async () => rows };
      const r = await listTids(ctxOf(fake, ['TID_VIEW']));
      expect(r.ok).toBe(true);
      expect(r.data![0]!.customerName).toBe('Anh Bảy'); // map khách có id 7
      expect(r.data![0]!.holdingCustomerName).toBe(null); // nhưng terminal → không "đang giữ"
    });
  }

  it('TID ACTIVE đã giao → holdingCustomerName = tên khách (đối chứng: còn sống thì vẫn giữ)', async () => {
    const { fake } = baseFake();
    fake.customer = { findMany: async () => [{ id: 7, nickname: 'Anh Bảy', fullName: 'Nguyễn Bảy' }], findUnique: async () => ({ id: 7, deletedAt: null }) };
    const rows = [mkRow({ status: 'ACTIVE' })];
    fake.tid = { count: async () => rows.length, findMany: async () => rows };
    const r = await listTids(ctxOf(fake, ['TID_VIEW']));
    expect(r.data![0]!.holdingCustomerName).toBe('Anh Bảy');
  });
});

describe('tid core — P4 cảnh báo TID giao-dở (chat group + giá bán thực tế)', () => {
  // TID đã giao cho khách 7 — override customerChatGroup/tidSellFee để mô phỏng 4 tổ hợp.
  const deliveredRow = (over: Record<string, unknown> = {}) => [{ id: 1, tid: 'T1', mid: null, bank: null, status: 'ACTIVE', posSerial: 'S1', customerId: 7, agentId: null, openedAt: new Date('2026-01-01'), deliveredAt: new Date('2026-01-02'), closedAt: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), customerDeviceSerial: null, dossierId: null, industryId: null, bankId: null, partnerId: null, hkdName: 'HKD A', receiveAccountId: null, investFeeMilli: null, issuedAt: null, configStatusId: null, dossierSourceId: null, note: null, ...over }];

  it('khách KHÔNG có nhóm chat còn hoạt động → customerHasActiveChatGroup false', async () => {
    const { fake } = baseFake();
    const rows = deliveredRow();
    fake.tid = { count: async () => rows.length, findMany: async () => rows };
    // customerChatGroup rỗng (mặc định) = không có nhóm; tidSellFee rỗng.
    const r = await listTids(ctxOf(fake, ['TID_VIEW']));
    expect(r.data![0]!.customerHasActiveChatGroup).toBe(false);
  });

  it('khách CÓ nhóm chat còn hoạt động → customerHasActiveChatGroup true', async () => {
    const { fake } = baseFake();
    const rows = deliveredRow();
    fake.tid = { count: async () => rows.length, findMany: async () => rows };
    fake.customerChatGroup = { findMany: async () => [{ customerId: 7 }] };
    const r = await listTids(ctxOf(fake, ['TID_VIEW']));
    expect(r.data![0]!.customerHasActiveChatGroup).toBe(true);
  });

  it('TID KHÔNG có TidSellFee còn sống → hasActualSellFee false', async () => {
    const { fake } = baseFake();
    const rows = deliveredRow();
    fake.tid = { count: async () => rows.length, findMany: async () => rows };
    const r = await listTids(ctxOf(fake, ['TID_VIEW']));
    expect(r.data![0]!.hasActualSellFee).toBe(false);
  });

  it('TID CÓ TidSellFee còn sống → hasActualSellFee true', async () => {
    const { fake } = baseFake();
    const rows = deliveredRow();
    fake.tid = { count: async () => rows.length, findMany: async () => rows };
    fake.tidSellFee = { findMany: async () => [{ tidId: 1 }] };
    const r = await listTids(ctxOf(fake, ['TID_VIEW']));
    expect(r.data![0]!.hasActualSellFee).toBe(true);
  });

  it('khách null → customerHasActiveChatGroup false dù có nhóm chat của khách khác (null-safe)', async () => {
    const { fake } = baseFake();
    const rows = deliveredRow({ customerId: null });
    fake.tid = { count: async () => rows.length, findMany: async () => rows };
    fake.customerChatGroup = { findMany: async () => [{ customerId: 99 }] };
    const r = await listTids(ctxOf(fake, ['TID_VIEW']));
    expect(r.data![0]!.customerHasActiveChatGroup).toBe(false);
  });
});

describe('tid core — createTidUnified', () => {
  it('thiếu ngân hàng → VALIDATION (trước validateRefs)', async () => {
    const { fake } = baseFake();
    fake.tid = { findUnique: async () => null, findFirst: async () => null, create: async () => ({ id: 1 }) };
    const r = await createTidUnified(ctxOf(fake, ['CONFIG_TID_MANAGE']), { tid: 'T9', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 0 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Vui lòng chọn ngân hàng.');
  });

  it('tạo TID cơ bản (chưa gán/giao) hợp lệ → tid.create + audit TID_CONFIG_CREATED', async () => {
    const { fake, audits } = baseFake();
    const tids: Record<string, unknown>[] = [];
    fake.dossier = { findUnique: async () => null };
    fake.tid = {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: 10, ...data }; tids.push(row); return row; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => ({ id: where.id, ...data })
    };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] });
    const r = await createTidUnified(ctxOf(fake, ['CONFIG_TID_MANAGE']), { tid: 'T10', industryId: 3, hkdName: 'HKD B', partnerId: 2, bankId: 1 });
    expect(r.ok).toBe(true);
    expect(tids[0]!.tid).toBe('T10');
    expect(tids[0]!.status).toBe('UNASSIGNED');
    expect(audits.some((a) => a['action'] === 'TID_CONFIG_CREATED')).toBe(true);
  });

  it('assign+deliver nhưng THIẾU quyền TID_MANAGE → FORBIDDEN + audit PERMISSION_DENIED', async () => {
    const { fake, audits } = baseFake();
    fake.tid = { findUnique: async () => null, findFirst: async () => null };
    const r = await createTidUnified(ctxOf(fake, ['CONFIG_TID_MANAGE']), { tid: 'T11', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 1, assign: { posSerial: 'S1', customerId: 7 } });
    expect(r.error).toBe('FORBIDDEN');
    expect(audits.some((a) => a['action'] === 'PERMISSION_DENIED')).toBe(true);
  });

  // TID-6 (audit 21/8): gán (assign.customerId) + giao (deliver.customerId) TRONG CÙNG lệnh tạo phải CÙNG khách;
  // khác nhau ⟹ máy về khách A, TID ghi giao khách B (split-brain: device holder ≠ TID holder) → CHẶN, không tạo.
  it('TID-6: assign + deliver KHÁC khách → VALIDATION, KHÔNG tạo TID', async () => {
    const { fake } = baseFake();
    const created: unknown[] = [];
    fake.posDevice = { findUnique: async () => ({ id: 1, serial: 'S1', status: 'IN_STOCK', currentTid: null, bankId: 1, deletedAt: null }) };
    fake.tid = {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return { id: 1, ...data }; }
    };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] });
    const r = await createTidUnified(ctxOf(fake, ['CONFIG_TID_MANAGE', 'TID_MANAGE']), {
      tid: 'T40', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 1,
      assign: { posSerial: 'S1', customerId: 7 }, deliver: { customerId: 8 }
    });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toContain('cùng một khách');
    expect(created.length).toBe(0); // transaction chưa mở → không tid.create
  });

  it('TID-6: assign + deliver CÙNG khách → KHÔNG bị chặn bởi guard (đối chứng)', async () => {
    const { fake } = baseFake();
    // Chỉ cần chứng minh guard KHÔNG chặn khi cùng khách: cho qua tới bước dup-check (findFirst) rồi dừng bằng DUPLICATE.
    fake.posDevice = { findUnique: async () => ({ id: 1, serial: 'S1', status: 'IN_STOCK', currentTid: null, bankId: 1, deletedAt: null }) };
    fake.tid = { findUnique: async () => null, findFirst: async () => ({ id: 99, deletedAt: null }) }; // dup đang dùng
    const r = await createTidUnified(ctxOf(fake, ['CONFIG_TID_MANAGE', 'TID_MANAGE']), {
      tid: 'T41', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 1,
      assign: { posSerial: 'S1', customerId: 7 }, deliver: { customerId: 7 }
    });
    expect(r.error).toBe('DUPLICATE'); // vượt qua guard TID-6, dừng ở dup-check → chứng minh cùng-khách KHÔNG bị chặn
  });
});

describe('tid core — UỶ qua TK nhận tiền (Phase B)', () => {
  it('listTids: TID gắn TK nhận tiền uỷ=NĐT → DTO trả receiveAccountLabel + owyType/owyName + investFeeMilli', async () => {
    const { fake } = baseFake();
    fake.receiveAccount = { findMany: async () => [{ id: 50, accountName: 'CTY A', accountNumber: '0123', customerId: null, investorId: 8 }] };
    fake.investor = { findMany: async () => [{ id: 8, nickname: 'NĐT Tám', fullName: 'Lê Tám' }] };
    const rows = [{ id: 1, tid: 'T1', mid: null, bank: null, status: 'ACTIVE', posSerial: null, customerId: null, agentId: null, openedAt: null, deliveredAt: null, closedAt: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), customerDeviceSerial: null, dossierId: null, industryId: null, bankId: null, partnerId: null, hkdName: null, receiveAccountId: 50, investFeeMilli: 100, issuedAt: null, configStatusId: null, dossierSourceId: null, note: null }];
    fake.tid = { count: async () => rows.length, findMany: async () => rows };
    const r = await listTids(ctxOf(fake, ['TID_VIEW']));
    expect(r.ok).toBe(true);
    expect(r.data![0]!.receiveAccountLabel).toBe('0123 · CTY A');
    expect(r.data![0]!.owyType).toBe('INVESTOR');
    expect(r.data![0]!.owyName).toBe('NĐT Tám');
    expect(r.data![0]!.investFeeMilli).toBe(100);
  });

  it('listTids: TID không gắn TK nhận tiền → receiveAccountLabel/owyType/owyName null', async () => {
    const { fake } = baseFake();
    const rows = [{ id: 2, tid: 'T2', mid: null, bank: null, status: 'ACTIVE', posSerial: null, customerId: null, agentId: null, openedAt: null, deliveredAt: null, closedAt: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), customerDeviceSerial: null, dossierId: null, industryId: null, bankId: null, partnerId: null, hkdName: null, receiveAccountId: null, investFeeMilli: null, issuedAt: null, configStatusId: null, dossierSourceId: null, note: null }];
    fake.tid = { count: async () => rows.length, findMany: async () => rows };
    const r = await listTids(ctxOf(fake, ['TID_VIEW']));
    expect(r.data![0]!.receiveAccountLabel).toBe(null);
    expect(r.data![0]!.owyType).toBe(null);
    expect(r.data![0]!.owyName).toBe(null);
    expect(r.data![0]!.investFeeMilli).toBe(null);
  });

  it('createTidUnified: ghi receiveAccountId + investFeeMilli', async () => {
    const { fake } = baseFake();
    const tids: Record<string, unknown>[] = [];
    fake.dossier = { findUnique: async () => null };
    fake.tid = {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: 30, ...data }; tids.push(row); return row; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => ({ id: where.id, ...data })
    };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] });
    const r = await createTidUnified(ctxOf(fake, ['CONFIG_TID_MANAGE']), { tid: 'T30', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 1, receiveAccountId: 50, investFeeMilli: 100 });
    expect(r.ok).toBe(true);
    expect(tids[0]!.receiveAccountId).toBe(50);
    expect(tids[0]!.investFeeMilli).toBe(100);
  });
});

describe('tid core — assignTid (tx nhiều bảng + bất biến 1 máy 1 TID)', () => {
  function fakeForAssign(devOver: Record<string, unknown> = {}) {
    const { fake, audits, events, bindings } = baseFake();
    const tidRow = { id: 1, tid: 'T1', status: 'UNASSIGNED', posSerial: null, bankId: 1, customerId: null, agentId: null };
    const dev = { id: 100, serial: 'S1', status: 'IN_STOCK', bankId: 1, currentTid: null, currentAgentId: null, ...devOver };
    const tidUpdates: Record<string, unknown>[] = [];
    const posUpdates: Record<string, unknown>[] = [];
    fake.tid = { findUnique: async () => ({ ...tidRow }), update: async ({ data }: { data: Record<string, unknown> }) => { tidUpdates.push({ ...data }); return { ...tidRow, ...data }; } };
    fake.posDevice = { findUnique: async () => ({ ...dev }), update: async ({ data }: { data: Record<string, unknown> }) => { posUpdates.push({ ...data }); return { ...dev, ...data }; } };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] });
    return { fake, audits, events, bindings, tidUpdates, posUpdates };
  }

  it('gán hợp lệ → tid ACTIVE + posDevice DEPLOYED + binding + assetEvent TID_ASSIGN + audit', async () => {
    const { fake, audits, events, bindings, tidUpdates, posUpdates } = fakeForAssign();
    const r = await assignTid(ctxOf(fake, ['TID_MANAGE']), 'T1', { posSerial: 'S1', customerId: 7 });
    expect(r.ok).toBe(true);
    expect(tidUpdates[0]!.status).toBe('ACTIVE');
    expect(tidUpdates[0]!.posSerial).toBe('S1');
    expect(posUpdates[0]!.currentTid).toBe('T1');
    expect(posUpdates[0]!.status).toBe('DEPLOYED'); // IN_STOCK → DEPLOYED
    expect(bindings[0]!.tid).toBe('T1');
    expect(events[0]!.eventType).toBe('TID_ASSIGN');
    expect(audits.some((a) => a['action'] === 'TID_ASSIGNED')).toBe(true);
  });

  it('[B265] gán cho KHÁCH KHÔNG TỒN TẠI → NOT_FOUND, không ghi gì', async () => {
    const { fake, tidUpdates, posUpdates } = fakeForAssign();
    const r = await assignTid(ctxOf(fake, ['TID_MANAGE']), 'T1', { posSerial: 'S1', customerId: 999999 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('NOT_FOUND');
    expect(tidUpdates.length).toBe(0);
    expect(posUpdates.length).toBe(0);
  });

  it('[B264] TID nằm trong THÙNG RÁC (deletedAt) → NOT_FOUND nói rõ phải phục hồi, không ghi gì', async () => {
    const { fake, tidUpdates } = fakeForAssign();
    fake.tid = { findUnique: async () => ({ id: 1, tid: 'T1', status: 'UNASSIGNED', posSerial: null, bankId: 1, customerId: null, agentId: null, deletedAt: new Date() }), update: async () => { throw new Error('CẤM update TID trong thùng rác'); } };
    const r = await assignTid(ctxOf(fake, ['TID_MANAGE']), 'T1', { posSerial: 'S1', customerId: 7 });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toBe('NOT_FOUND'); expect(r.message).toContain('Thùng rác'); }
    expect(tidUpdates.length).toBe(0);
  });

  it('BẤT BIẾN kho: gán TID vào máy IN_STOCK có warehouseId → DEPLOYED + warehouseId/Loc CLEAR null (máy giao không nằm kho)', async () => {
    const { fake, posUpdates } = fakeForAssign({ status: 'IN_STOCK', warehouseId: 3, warehouseLoc: 'Kệ A1' });
    const r = await assignTid(ctxOf(fake, ['TID_MANAGE']), 'T1', { posSerial: 'S1', customerId: 7 });
    expect(r.ok).toBe(true);
    expect(posUpdates[0]!.status).toBe('DEPLOYED');
    expect(posUpdates[0]!.warehouseId).toBeNull();
    expect(posUpdates[0]!.warehouseLoc).toBeNull();
  });

  it('máy đang mang TID khác → DEVICE_HAS_TID (pre-check, chặn 1 máy 2 TID)', async () => {
    const { fake } = fakeForAssign({ currentTid: 'T-OTHER' });
    const r = await assignTid(ctxOf(fake, ['TID_MANAGE']), 'T1', { posSerial: 'S1', customerId: 7 });
    expect(r.error).toBe('DEVICE_HAS_TID');
    expect(r.message).toContain('T-OTHER');
  });

  it('máy trắng (bankId null) → MACHINE_BLANK', async () => {
    const { fake } = fakeForAssign({ bankId: null });
    const r = await assignTid(ctxOf(fake, ['TID_MANAGE']), 'T1', { posSerial: 'S1', customerId: 7 });
    expect(r.error).toBe('MACHINE_BLANK');
  });

  it('bank TID ≠ app máy → BANK_MISMATCH', async () => {
    const { fake } = fakeForAssign({ bankId: 999 });
    const r = await assignTid(ctxOf(fake, ['TID_MANAGE']), 'T1', { posSerial: 'S1', customerId: 7 });
    expect(r.error).toBe('BANK_MISMATCH');
  });

  // FIX ASSET-1: CHỈ máy IN_STOCK/DEPLOYED gán được TID. Máy SOLD/DAMAGED/IN_REPAIR/RETIRED bị chặn.
  it('gán TID lên máy đã BÁN (SOLD) → INVALID_STATE (không để TID sống trên máy đã bán)', async () => {
    const { fake } = fakeForAssign({ status: 'SOLD' });
    const r = await assignTid(ctxOf(fake, ['TID_MANAGE']), 'T1', { posSerial: 'S1', customerId: 7 });
    expect(r.error).toBe('INVALID_STATE');
    expect(r.message).toBe('Máy POS S1 đang ở trạng thái SOLD, không gán được TID.');
  });

  it('gán TID lên máy đang SỬA (IN_REPAIR) / HỎNG (DAMAGED) → INVALID_STATE', async () => {
    for (const st of ['IN_REPAIR', 'DAMAGED', 'RETIRED'] as const) {
      const { fake } = fakeForAssign({ status: st });
      const r = await assignTid(ctxOf(fake, ['TID_MANAGE']), 'T1', { posSerial: 'S1', customerId: 7 });
      expect(r.error).toBe('INVALID_STATE');
      expect(r.message).toContain(st);
    }
  });
});

describe('tid core — replaceTid (khóa FOR UPDATE + guard máy + carry deliveredAt)', () => {
  const OLD_DELIVERED = new Date('2026-01-05T00:00:00.000Z');
  function fakeForReplace(devOver: Record<string, unknown> = {}, oldOver: Record<string, unknown> = {}) {
    const { fake, audits, events, bindings } = baseFake();
    const oldRow = { id: 1, tid: 'OLD', status: 'ACTIVE', posSerial: 'S1', bankId: 1, customerId: 7, agentId: 5, deliveredAt: OLD_DELIVERED, ...oldOver };
    const newRow = { id: 2, tid: 'NEW', status: 'UNASSIGNED', posSerial: null, bankId: 1, customerId: null, agentId: null, deliveredAt: null };
    const dev = { id: 100, serial: 'S1', status: 'DEPLOYED', bankId: 1, currentTid: 'OLD', ...devOver };
    const tidUpdates: Record<string, unknown>[] = [];
    const posUpdates: Record<string, unknown>[] = [];
    fake.tid = {
      findUnique: async ({ where }: { where: { tid: string } }) => (where.tid === 'OLD' ? { ...oldRow } : where.tid === 'NEW' ? { ...newRow } : null),
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { tidUpdates.push({ id: where.id, ...data }); return { id: where.id, ...data }; }
    };
    fake.posDevice = { findUnique: async () => ({ ...dev }), update: async ({ data }: { data: Record<string, unknown> }) => { posUpdates.push({ ...data }); return { ...dev, ...data }; } };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] });
    return { fake, audits, events, bindings, tidUpdates, posUpdates };
  }

  it('thay TID → TID mới ACTIVE + posSerial/customerId kế thừa + CARRY deliveredAt của TID cũ (FIX ASSET-3)', async () => {
    const { fake, tidUpdates, posUpdates } = fakeForReplace();
    const r = await replaceTid(ctxOf(fake, ['TID_MANAGE']), 'OLD', { newTid: 'NEW' });
    expect(r.ok).toBe(true);
    const newUpd = tidUpdates.find((u) => u.id === 2)!;
    expect(newUpd.status).toBe('ACTIVE');
    expect(newUpd.posSerial).toBe('S1');
    expect(newUpd.customerId).toBe(7);
    // FIX ASSET-3: KHÔNG để deliveredAt null (chưa giao) — phải mang mốc giao của TID cũ.
    expect((newUpd.deliveredAt as Date).getTime()).toBe(OLD_DELIVERED.getTime());
    expect(posUpdates[0]!.currentTid).toBe('NEW'); // FIX ASSET-2: chỉ ghi khi guard hợp lệ
  });

  it('TID cũ CHƯA có deliveredAt → carry = occurredAt (không null)', async () => {
    const { fake, tidUpdates } = fakeForReplace({}, { deliveredAt: null });
    const r = await replaceTid(ctxOf(fake, ['TID_MANAGE']), 'OLD', { newTid: 'NEW', occurredAt: '2026-02-02T00:00:00.000Z' });
    expect(r.ok).toBe(true);
    const newUpd = tidUpdates.find((u) => u.id === 2)!;
    expect(newUpd.deliveredAt).toBeInstanceOf(Date);
    expect((newUpd.deliveredAt as Date).getTime()).toBe(new Date('2026-02-02T00:00:00.000Z').getTime());
  });

  it('FIX ASSET-2: máy đã đổi (currentTid ≠ TID cũ) giữa dirty-read và khóa → CONFLICT, KHÔNG đè currentTid', async () => {
    const { fake, posUpdates } = fakeForReplace({ currentTid: 'SOMETHING_ELSE' });
    const r = await replaceTid(ctxOf(fake, ['TID_MANAGE']), 'OLD', { newTid: 'NEW' });
    expect(r.error).toBe('CONFLICT');
    expect(posUpdates.length).toBe(0); // không ghi đè currentTid máy
  });

  it('FIX ASSET-2: máy không còn DEPLOYED (đã thu hồi) → CONFLICT', async () => {
    const { fake } = fakeForReplace({ status: 'IN_STOCK' });
    const r = await replaceTid(ctxOf(fake, ['TID_MANAGE']), 'OLD', { newTid: 'NEW' });
    expect(r.error).toBe('CONFLICT');
  });

  // FIX ASSET-2 (hardening 20/8): 2 TID phải khóa theo THỨ TỰ CHUỖI XÁC ĐỊNH (nhỏ trước), KHÔNG theo (old,new) —
  // nếu không, replaceTid(A,B) và replaceTid(B,A) đồng thời giành khóa ngược chiều → ABBA deadlock.
  function fakeForLockOrder(oldTidStr: string, newTidStr: string) {
    const { fake } = baseFake();
    const oldRow = { id: 1, tid: oldTidStr, status: 'ACTIVE', posSerial: 'S1', bankId: 1, customerId: 7, agentId: 5, deliveredAt: new Date('2026-01-05T00:00:00.000Z') };
    const newRow = { id: 2, tid: newTidStr, status: 'UNASSIGNED', posSerial: null, bankId: 1, customerId: null, agentId: null, deliveredAt: null };
    const dev = { id: 100, serial: 'S1', status: 'DEPLOYED', bankId: 1, currentTid: oldTidStr };
    const lockOrder: string[] = [];
    fake.tid = {
      findUnique: async ({ where }: { where: { tid: string } }) => (where.tid === oldTidStr ? { ...oldRow } : where.tid === newTidStr ? { ...newRow } : null),
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => ({ id: where.id, ...data })
    };
    fake.posDevice = { findUnique: async () => ({ ...dev }), update: async () => ({}) };
    // $queryRaw tagged-template: chỉ ghi lại value của các khóa TID (SQL chứa "FROM tids").
    const rec = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      if (strings.join('?').includes('FROM tids')) lockOrder.push(String(vals[0]));
      return [];
    };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: rec });
    return { fake, lockOrder };
  }

  it('khóa 2 TID theo thứ tự chuỗi tăng dần khi old < new (A9 trước B1)', async () => {
    const { fake, lockOrder } = fakeForLockOrder('A9', 'B1');
    const r = await replaceTid(ctxOf(fake, ['TID_MANAGE']), 'A9', { newTid: 'B1' });
    expect(r.ok).toBe(true);
    expect(lockOrder).toEqual(['A9', 'B1']);
  });

  it('khóa 2 TID theo thứ tự chuỗi (KHÔNG theo arg): old=Z9,new=A1 → khóa A1 TRƯỚC Z9 (chống ABBA)', async () => {
    const { fake, lockOrder } = fakeForLockOrder('Z9', 'A1');
    const r = await replaceTid(ctxOf(fake, ['TID_MANAGE']), 'Z9', { newTid: 'A1' });
    expect(r.ok).toBe(true);
    // Nếu khóa theo (old,new) sẽ là ['Z9','A1']; đúng phải là sort tăng dần → A1 trước.
    expect(lockOrder).toEqual(['A1', 'Z9']);
    expect(lockOrder[0]! < lockOrder[1]!).toBe(true);
  });

  // TID-1 (audit 20/8): TID CŨ bị thay = DEAD phải NHẢ MÁY (posSerial+agentId) — nếu không, serial S1 bị 2 TID cùng
  // nhận (TID mới vừa lấy posSerial='S1', TID cũ vẫn ÔM 'S1') → orphan serial, vi phạm posSerial⟹ACTIVE +
  // posSerial⟹device-link. NHƯNG customerId + deliveredAt (lịch sử giao) PHẢI GIỮ (khớp recallTid) — chống re-giao
  // dựa vào guard trạng-thái-terminal 'deliver', KHÔNG dựa vào việc xoá cột deliveredAt.
  it('TID-1 — TID cũ sau thay: status DEAD + posSerial/agentId null; customerId/deliveredAt GIỮ nguyên (không xoá lịch sử)', async () => {
    const { fake, tidUpdates, posUpdates } = fakeForReplace();
    const r = await replaceTid(ctxOf(fake, ['TID_MANAGE']), 'OLD', { newTid: 'NEW' });
    expect(r.ok).toBe(true);
    const oldUpd = tidUpdates.find((u) => u.id === 1)!;
    expect(oldUpd.status).toBe('DEAD');
    expect(oldUpd.posSerial).toBe(null); // NHẢ máy → chống orphan serial
    expect(oldUpd.agentId).toBe(null);
    // KHÔNG ghi đè customerId/deliveredAt (không có trong data update) → DB giữ giá trị cũ (lịch sử giao).
    expect('customerId' in oldUpd).toBe(false);
    expect('deliveredAt' in oldUpd).toBe(false);
    // BẤT BIẾN: không hai TID cùng nhận 1 serial — máy trỏ TID MỚI, TID cũ đã nhả serial.
    const newUpd = tidUpdates.find((u) => u.id === 2)!;
    expect(newUpd.posSerial).toBe('S1');
    expect(posUpdates[0]!.currentTid).toBe('NEW');
  });

  // TID-1 (guard belt-and-suspenders): TID DEAD (đã thay, deliveredAt còn giá trị cũ) KHÔNG được GIAO LẠI qua
  // markTidDelivered — dù cột deliveredAt bị (giả sử) xoá về null, guard trạng-thái-terminal 'deliver' vẫn chặn.
  it('TID-1 guard — markTidDelivered trên TID DEAD → INVALID_STATE, KHÔNG ghi deliveredAt (không đặt lại delivered⟹ACTIVE)', async () => {
    const { fake } = baseFake();
    const tidUpdates: Record<string, unknown>[] = [];
    // DEAD + deliveredAt=null (kịch bản xấu nhất: cột giao đã bị làm rỗng) → chỉ còn status chặn.
    fake.tid = {
      findUnique: async () => ({ id: 1, tid: 'OLD', status: 'DEAD', posSerial: null, bankId: 1, customerId: 7, agentId: null, deliveredAt: null }),
      update: async ({ data }: { data: Record<string, unknown> }) => { tidUpdates.push({ ...data }); return { ...data }; }
    };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] });
    const r = await markTidDelivered(ctxOf(fake, ['TID_MANAGE']), 'OLD', { customerId: 7 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('INVALID_STATE');
    expect(tidUpdates.length).toBe(0); // KHÔNG mutation — không ghi deliveredAt
  });
});

describe('tid core — gán TID = ĐÃ GIAO (deliveredAt set khi gán vào máy cho khách)', () => {
  // Harness gán TID cho phép override hàng tid (status/customerId/deliveredAt) để mô phỏng gán mới vs gán lại.
  function fakeForAssignD(tidOver: Record<string, unknown> = {}, devOver: Record<string, unknown> = {}) {
    const { fake, audits, events, bindings } = baseFake();
    const tidRow = { id: 1, tid: 'T1', status: 'UNASSIGNED', posSerial: null, bankId: 1, customerId: null, agentId: null, deliveredAt: null, ...tidOver };
    const dev = { id: 100, serial: 'S1', status: 'IN_STOCK', bankId: 1, currentTid: null, currentAgentId: null, ...devOver };
    const tidUpdates: Record<string, unknown>[] = [];
    const posUpdates: Record<string, unknown>[] = [];
    fake.tid = { findUnique: async () => ({ ...tidRow }), update: async ({ data }: { data: Record<string, unknown> }) => { tidUpdates.push({ ...data }); return { ...tidRow, ...data }; } };
    fake.posDevice = { findUnique: async () => ({ ...dev }), update: async ({ data }: { data: Record<string, unknown> }) => { posUpdates.push({ ...data }); return { ...dev, ...data }; } };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] });
    return { fake, audits, events, bindings, tidUpdates, posUpdates };
  }

  it('(a) createTidUnified assign (máy+khách) KHÔNG deliver → TID có deliveredAt != null (đã giao)', async () => {
    const { fake } = baseFake();
    const tids: Record<string, unknown>[] = [];
    const tidUpdates: Record<string, unknown>[] = [];
    fake.dossier = { findUnique: async () => null };
    fake.posDevice = {
      findUnique: async () => ({ id: 100, serial: 'S1', status: 'IN_STOCK', bankId: 1, currentTid: null, currentAgentId: null }),
      update: async ({ data }: { data: Record<string, unknown> }) => ({ id: 100, ...data })
    };
    fake.tid = {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: 20, ...data }; tids.push(row); return row; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { tidUpdates.push({ ...data }); return { id: where.id, ...data }; }
    };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] });
    const r = await createTidUnified(ctxOf(fake, ['CONFIG_TID_MANAGE', 'TID_MANAGE']), { tid: 'T20', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 1, assign: { posSerial: 'S1', customerId: 7 } });
    expect(r.ok).toBe(true);
    // Gán không kèm deliver → update gán phải set deliveredAt (đã giao) không còn null.
    expect(tidUpdates[0]!.deliveredAt).toBeInstanceOf(Date);
    expect(tidUpdates[0]!.customerId).toBe(7);
  });

  it('(b) assignTid trên TID CHƯA giao (deliveredAt null) → set deliveredAt (non-null = đã giao)', async () => {
    const { fake, tidUpdates } = fakeForAssignD();
    const r = await assignTid(ctxOf(fake, ['TID_MANAGE']), 'T1', { posSerial: 'S1', customerId: 7 });
    expect(r.ok).toBe(true);
    expect(tidUpdates[0]!.deliveredAt).toBeInstanceOf(Date);
    expect(tidUpdates[0]!.deliveredAt).not.toBeNull();
  });

  it('(c) assignTid gán LẠI CÙNG khách (đã giao) → deliveredAt GIỮ NGUYÊN mốc cũ', async () => {
    const old = new Date('2026-01-01T00:00:00.000Z');
    // TID đã thu hồi khỏi máy (ACTIVE, posSerial null) của chính khách 7, đã có mốc giao → lắp máy khác cùng khách.
    const { fake, tidUpdates } = fakeForAssignD({ status: 'ACTIVE', posSerial: null, customerId: 7, deliveredAt: old });
    const r = await assignTid(ctxOf(fake, ['TID_MANAGE']), 'T1', { posSerial: 'S1', customerId: 7 });
    expect(r.ok).toBe(true);
    expect((tidUpdates[0]!.deliveredAt as Date).getTime()).toBe(old.getTime());
  });

  it('(d) assignTid gán sang khách KHÁC → deliveredAt RESET (khác mốc cũ, không mang ngày khách cũ)', async () => {
    const old = new Date('2026-01-01T00:00:00.000Z');
    // TID đã thu hồi khỏi máy của khách 7 (đã có mốc giao), nay gán cho khách 8 khác.
    const { fake, tidUpdates } = fakeForAssignD({ status: 'ACTIVE', posSerial: null, customerId: 7, deliveredAt: old });
    const r = await assignTid(ctxOf(fake, ['TID_MANAGE']), 'T1', { posSerial: 'S1', customerId: 8 });
    expect(r.ok).toBe(true);
    expect(tidUpdates[0]!.deliveredAt).toBeInstanceOf(Date);
    expect((tidUpdates[0]!.deliveredAt as Date).getTime()).not.toBe(old.getTime());
    expect(tidUpdates[0]!.customerId).toBe(8);
  });
});

describe('tid core — markTidDelivered (khóa FOR UPDATE re-check double-delivery)', () => {
  it('bên thua race: delivered_at đã set trong tx → ALREADY_DELIVERED (rollback, không AssetEvent thứ 2)', async () => {
    const { fake, events } = baseFake();
    fake.tid = { findUnique: async () => ({ id: 1, tid: 'T1', status: 'ACTIVE', posSerial: 'S1', customerId: 7, agentId: null, deliveredAt: null }), update: async () => ({}) };
    // $queryRaw (FOR UPDATE re-đọc delivered_at) trả về đã-giao → guard atomic trong tx bắt được.
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [{ delivered_at: new Date('2026-01-01') }] });
    const r = await markTidDelivered(ctxOf(fake, ['TID_MANAGE']), 'T1', { customerId: 7 });
    expect(r.error).toBe('ALREADY_DELIVERED');
    expect(events.length).toBe(0); // KHÔNG tạo AssetEvent thứ 2
  });

  it('giao hợp lệ → tid.update deliveredAt + AssetEvent TID_DELIVERED + audit', async () => {
    const { fake, events, audits } = baseFake();
    const tidUpdates: Record<string, unknown>[] = [];
    fake.tid = { findUnique: async () => ({ id: 1, tid: 'T1', status: 'ACTIVE', posSerial: 'S1', customerId: 7, agentId: null, deliveredAt: null }), update: async ({ data }: { data: Record<string, unknown> }) => { tidUpdates.push({ ...data }); return { ...data }; } };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [{ delivered_at: null }] });
    const r = await markTidDelivered(ctxOf(fake, ['TID_MANAGE']), 'T1', { customerId: 7 });
    expect(r.ok).toBe(true);
    expect(tidUpdates[0]!.deliveredAt).toBeInstanceOf(Date);
    expect(events[0]!.eventType).toBe('TID_DELIVERED');
    expect(audits.some((a) => a['action'] === 'TID_DELIVERED')).toBe(true);
  });

  it('giao TID đang CHƯA GÁN (UNASSIGNED) → promote status ACTIVE + deliveredAt set (không kẹt "đã giao mà Chưa gán")', async () => {
    const { fake, events } = baseFake();
    const tidUpdates: Record<string, unknown>[] = [];
    // TID chưa gán máy: status UNASSIGNED, chưa có khách, chưa giao.
    fake.tid = { findUnique: async () => ({ id: 1, tid: 'T1', status: 'UNASSIGNED', posSerial: null, customerId: null, agentId: null, deliveredAt: null }), update: async ({ data }: { data: Record<string, unknown> }) => { tidUpdates.push({ ...data }); return { ...data }; } };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [{ delivered_at: null }] });
    const r = await markTidDelivered(ctxOf(fake, ['TID_MANAGE']), 'T1', { customerId: 7 });
    expect(r.ok).toBe(true);
    expect(tidUpdates[0]!.status).toBe('ACTIVE'); // UNASSIGNED → ACTIVE
    expect(tidUpdates[0]!.deliveredAt).toBeInstanceOf(Date);
    expect(events[0]!.eventType).toBe('TID_DELIVERED');
  });

  it('giao TID đã ACTIVE → status GIỮ NGUYÊN (update không ghi đè status = undefined) + deliver thành công', async () => {
    const { fake } = baseFake();
    const tidUpdates: Record<string, unknown>[] = [];
    fake.tid = { findUnique: async () => ({ id: 1, tid: 'T1', status: 'ACTIVE', posSerial: 'S1', customerId: 7, agentId: null, deliveredAt: null }), update: async ({ data }: { data: Record<string, unknown> }) => { tidUpdates.push({ ...data }); return { ...data }; } };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [{ delivered_at: null }] });
    const r = await markTidDelivered(ctxOf(fake, ['TID_MANAGE']), 'T1', { customerId: 7 });
    expect(r.ok).toBe(true);
    expect(tidUpdates[0]!.status).toBeUndefined(); // Prisma: undefined = không đổi → giữ ACTIVE
    expect(tidUpdates[0]!.deliveredAt).toBeInstanceOf(Date);
  });
});

describe('tid core — createTidUnified deliver-only → ACTIVE', () => {
  it('tạo TID rồi giao ngay (deliver, KHÔNG assign) → update giao set status ACTIVE + deliveredAt', async () => {
    const { fake } = baseFake();
    const tids: Record<string, unknown>[] = [];
    const tidUpdates: Record<string, unknown>[] = [];
    fake.dossier = { findUnique: async () => null };
    fake.tid = {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: 40, ...data }; tids.push(row); return row; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { tidUpdates.push({ ...data }); return { id: where.id, ...data }; }
    };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] });
    const r = await createTidUnified(ctxOf(fake, ['CONFIG_TID_MANAGE', 'TID_MANAGE']), { tid: 'T40', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 1, deliver: { customerId: 7 } });
    expect(r.ok).toBe(true);
    expect(tids[0]!.status).toBe('UNASSIGNED'); // create ban đầu chưa gán
    // Update giao ngay phải promote status ACTIVE (không để "đã giao mà Chưa gán").
    expect(tidUpdates[0]!.status).toBe('ACTIVE');
    expect(tidUpdates[0]!.deliveredAt).toBeInstanceOf(Date);
    expect(tidUpdates[0]!.customerId).toBe(7);
  });
});

// PHA 2 (2A) — createTidUnified + deliver + sellFees (top-level) → applyHandoverSellFees ghi tid_sell_fees.
/**
 * [B230 22/11] `setTidSellFees` nay CHEN gia ban bang SQL THO (`INSERT INTO tid_sell_fees ... ::timestamptz`)
 * chu khong con `tidSellFee.create` — vi ghi qua Prisma bi lui 7 tieng lam dung khoa duy nhat theo NGAY VN.
 * Mau gia PHAI hieu cau SQL do, neu khong `$executeRawUnsafe: () => 0` NUOT lenh ghi va 3 bai kiem do CAM
 * ("da ghi gia ban" nhung mang rong). Cac cau khac (advisory lock...) van tra 0 nhu cu.
 */
function ghiRawSellFee(sellFeeRows: Record<string, unknown>[]) {
  return async (sql: string, ...params: unknown[]): Promise<number> => {
    if (!/INSERT INTO tid_sell_fees/i.test(sql)) return 0;
    const coKhach = /customer_id/i.test(sql);
    sellFeeRows.push({
      id: sellFeeRows.length + 1,
      deletedAt: null,
      tidId: params[0],
      cardTypeId: params[1],
      feeTypeId: params[2],
      phiBan: params[3],
      effectiveFrom: new Date(String(params[4])),
      customerId: coKhach ? params[5] : null
    });
    return 1;
  };
}

describe('tid core — createTidUnified deliver + sellFees ghi tid_sell_fees', () => {
  it('tạo+giao ngay kèm defaultFeeTypeId + sellFees custom → tidSellFee.create được gọi (2% → 2000 milli)', async () => {
    const { fake } = baseFake();
    const sellFeeRows: Record<string, unknown>[] = [];
    let created: Record<string, unknown> | null = null;
    fake.dossier = { findUnique: async () => null };
    fake.feeType = { findUnique: async ({ where }: { where: { id: number } }) => (where.id === 3 ? { id: 3, deletedAt: null, name: 'Phí A' } : null) };
    fake.cardType = { findMany: async ({ where }: { where: Record<string, unknown> }) => {
      const cards = [{ id: 11, code: 'VISA', name: 'Visa', bankId: 1, deletedAt: null }];
      if (where['id']) { const ids = (where['id'] as { in: number[] }).in; return cards.filter((c) => ids.includes(c.id)); }
      return cards.filter((c) => c.bankId === where['bankId']);
    } };
    // FeeRate phí mua 1% để check "bán ≥ mua" qua (bán 2% ≥ 1%).
    fake.feeRate = { findMany: async () => [{ id: 1, effectiveFrom: new Date('2020-01-01'), phiMua: 1000, phiCaiMay: 0, deletedAt: null }] };
    fake.feeSellQuote = { findMany: async () => [] };
    fake.tidSellFee = {
      findMany: async () => [],
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: sellFeeRows.length + 1, deletedAt: null, ...data }; sellFeeRows.push(row); return { ...row }; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => ({ id: where.id, ...data })
    };
    // Engine recalc chạy trong tx setTidSellFees — seed KHÔNG có GD.
    fake.transaction = { findMany: async () => [], update: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) };
    fake.revenueRecalcLog = { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 1, ...data }) };
    fake.tid = {
      findUnique: async ({ where }: { where: { id: number } }) => (created && created['id'] === where.id ? { ...created } : null),
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { created = { id: 50, deletedAt: null, ...data }; return { ...created }; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { if (created) Object.assign(created, data); return { id: where.id, ...data }; }
    };
    // tx cần cả $queryRaw (createTidUnified FOR UPDATE) + $executeRawUnsafe/$queryRawUnsafe (setTidSellFees advisory-lock).
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [], $queryRawUnsafe: async () => [], $executeRawUnsafe: ghiRawSellFee(sellFeeRows) });
    const r = await createTidUnified(ctxOf(fake, ['CONFIG_TID_MANAGE', 'TID_MANAGE']), {
      tid: 'T50', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 1,
      deliver: { customerId: 7 },
      defaultFeeTypeId: 3,
      sellFees: [{ cardTypeId: 11, phiBan: 2 }]
    });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined(); // happy path: KHÔNG có cảnh báo
    expect(sellFeeRows.length).toBe(1); // đã ghi tid_sell_fees
    expect(sellFeeRows[0]!['phiBan']).toBe(2000); // 2% → 2000 milli
    expect(sellFeeRows[0]!['cardTypeId']).toBe(11);
    expect(sellFeeRows[0]!['feeTypeId']).toBe(3);
    expect(sellFeeRows[0]!['tidId']).toBe(50);
  });

  // GIÁ BÁN GẮN NGÀY GIAO (Admin Demo) — deliver.deliveredAt LÙI NGÀY → KỲ hiệu lực override (TidSellFee.effectiveFrom)
  // = ĐÚNG ngày giao đó (floor nửa đêm LOCAL), KHÔNG phải hôm nay. Chứng minh applyHandoverSellFees forward
  // effectiveFrom = mốc giao thực xuống setTidSellFees.
  it('deliver deliveredAt LÙI NGÀY → TidSellFee.effectiveFrom = ngày giao (nửa đêm LOCAL), không phải hôm nay', async () => {
    const { fake } = baseFake();
    const sellFeeRows: Record<string, unknown>[] = [];
    let created: Record<string, unknown> | null = null;
    fake.dossier = { findUnique: async () => null };
    fake.feeType = { findUnique: async ({ where }: { where: { id: number } }) => (where.id === 3 ? { id: 3, deletedAt: null, name: 'Phí A' } : null) };
    fake.cardType = { findMany: async ({ where }: { where: Record<string, unknown> }) => {
      const cards = [{ id: 11, code: 'VISA', name: 'Visa', bankId: 1, deletedAt: null }];
      if (where['id']) { const ids = (where['id'] as { in: number[] }).in; return cards.filter((c) => ids.includes(c.id)); }
      return cards.filter((c) => c.bankId === where['bankId']);
    } };
    fake.feeRate = { findMany: async () => [{ id: 1, effectiveFrom: new Date('2020-01-01'), phiMua: 1000, phiCaiMay: 0, deletedAt: null }] };
    fake.feeSellQuote = { findMany: async () => [] };
    fake.tidSellFee = {
      findMany: async () => [],
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: sellFeeRows.length + 1, deletedAt: null, ...data }; sellFeeRows.push(row); return { ...row }; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => ({ id: where.id, ...data })
    };
    fake.transaction = { findMany: async () => [], update: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) };
    fake.revenueRecalcLog = { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 1, ...data }) };
    fake.tid = {
      findUnique: async ({ where }: { where: { id: number } }) => (created && created['id'] === where.id ? { ...created } : null),
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { created = { id: 55, deletedAt: null, ...data }; return { ...created }; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { if (created) Object.assign(created, data); return { id: where.id, ...data }; }
    };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [], $queryRawUnsafe: async () => [], $executeRawUnsafe: ghiRawSellFee(sellFeeRows) });
    const deliveredIso = '2026-03-15T10:30:00.000Z';
    const d = new Date(deliveredIso);
    const expectedEff = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); // startOfDayLocal (khớp service)
    const r = await createTidUnified(ctxOf(fake, ['CONFIG_TID_MANAGE', 'TID_MANAGE']), {
      tid: 'T55', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 1,
      deliver: { customerId: 7, deliveredAt: deliveredIso },
      defaultFeeTypeId: 3,
      sellFees: [{ cardTypeId: 11, phiBan: 2 }]
    });
    expect(r.ok).toBe(true);
    expect(sellFeeRows.length).toBe(1);
    expect((sellFeeRows[0]!['effectiveFrom'] as Date).getTime()).toBe(expectedEff); // = ngày giao, KHÔNG phải hôm nay
    // Sanity: ngày giao (03/2026) khác hôm nay → khẳng định KHÔNG rơi về default hôm nay.
    const todayStart = new Date(); const todayMid = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate()).getTime();
    expect(expectedEff).not.toBe(todayMid);
  });
});

// PHA 2 (2A) — NON-FATAL sell-fee: nếu setTidSellFees TỪ CHỐI (vd phí bán < phí mua niêm yết), handover VẪN
// thành công (TID đã commit/giao) + trả ok:true + warning (KHÔNG ok:false → tránh orphan delivered TID + DUPLICATE).
describe('tid core — handover sell-fee NON-FATAL (giao thành công + warning khi giá bán fail)', () => {
  function feeFailFake(): { fake: ReturnType<typeof baseFake>['fake']; sellFeeRows: Record<string, unknown>[] } {
    const { fake } = baseFake();
    const sellFeeRows: Record<string, unknown>[] = [];
    let created: Record<string, unknown> | null = null;
    fake.dossier = { findUnique: async () => null };
    fake.feeType = { findUnique: async ({ where }: { where: { id: number } }) => (where.id === 3 ? { id: 3, deletedAt: null, name: 'Phí A' } : null) };
    fake.cardType = { findMany: async ({ where }: { where: Record<string, unknown> }) => {
      const cards = [{ id: 11, code: 'VISA', name: 'Visa', bankId: 1, deletedAt: null }];
      if (where['id']) { const ids = (where['id'] as { in: number[] }).in; return cards.filter((c) => ids.includes(c.id)); }
      return cards.filter((c) => c.bankId === where['bankId']);
    } };
    // phí MUA niêm yết = 1% → phí bán 0.5% < 1% ⇒ setTidSellFees TỪ CHỐI (bán thấp hơn mua là lỗ).
    fake.feeRate = { findMany: async () => [{ id: 1, effectiveFrom: new Date('2020-01-01'), phiMua: 1000, phiCaiMay: 0, deletedAt: null }] };
    fake.feeSellQuote = { findMany: async () => [] };
    fake.tidSellFee = {
      findMany: async () => [],
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: sellFeeRows.length + 1, deletedAt: null, ...data }; sellFeeRows.push(row); return { ...row }; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => ({ id: where.id, ...data })
    };
    fake.transaction = { findMany: async () => [], update: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) };
    fake.revenueRecalcLog = { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 1, ...data }) };
    fake.tid = {
      findUnique: async ({ where }: { where: { id: number } }) => (created && created['id'] === where.id ? { ...created } : null),
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { created = { id: 50, deletedAt: null, ...data }; return { ...created }; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { if (created) Object.assign(created, data); return { id: where.id, ...data }; }
    };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [], $queryRawUnsafe: async () => [], $executeRawUnsafe: ghiRawSellFee(sellFeeRows) });
    return { fake, sellFeeRows };
  }

  // [B209 19/11 — Admin Demo "giá bán được phép cao hoặc thấp hơn"] LUẬT ĐỔI: bán dưới giá vốn KHÔNG còn bị
  // từ chối ⇒ giá bán PHẢI được ghi luôn khi tạo+giao TID (trước đây bị chặn nên rơi vào nhánh cảnh báo).
  it('createTidUnified + deliver + sellFees dưới giá vốn → ok:true + GHI ĐƯỢC giá bán (luật mới 19/11)', async () => {
    const { fake, sellFeeRows } = feeFailFake();
    const r = await createTidUnified(ctxOf(fake, ['CONFIG_TID_MANAGE', 'TID_MANAGE']), {
      tid: 'T60', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 1,
      deliver: { customerId: 7 },
      defaultFeeTypeId: 3,
      sellFees: [{ cardTypeId: 11, phiBan: 0.5 }] // 0.5% < phí mua 1% — nay CHO PHÉP, chỉ cảnh báo
    });
    expect(r.ok).toBe(true);
    expect(r.id).toBe(50);
    expect(sellFeeRows.length).toBe(1); // giá bán ĐÃ được ghi
  });

  it('createTidUnified + deliver + sellFees NHƯNG thiếu defaultFeeTypeId → ok:true + warning (không ghi giá)', async () => {
    const { fake, sellFeeRows } = feeFailFake();
    const r = await createTidUnified(ctxOf(fake, ['CONFIG_TID_MANAGE', 'TID_MANAGE']), {
      tid: 'T61', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 1,
      deliver: { customerId: 7 },
      sellFees: [{ cardTypeId: 11, phiBan: 2 }] // defaultFeeTypeId undefined
    });
    expect(r.ok).toBe(true);
    expect(r.id).toBe(50);
    expect(typeof r.warning).toBe('string');
    expect((r.warning ?? '').length).toBeGreaterThan(0);
    expect(sellFeeRows.length).toBe(0);
  });
});

describe('tid core — recallTid (tx: clear máy + unbind + assetEvent)', () => {
  it('thu hồi ACTIVE → RECALLED + clear posSerial/agentId + assetEvent + audit', async () => {
    const { fake, events, audits } = baseFake();
    const tidUpdates: Record<string, unknown>[] = [];
    fake.tid = { findUnique: async () => ({ id: 1, tid: 'T1', status: 'ACTIVE', posSerial: 'S1', customerId: 7, agentId: 5 }), update: async ({ data }: { data: Record<string, unknown> }) => { tidUpdates.push({ ...data }); return { ...data }; } };
    fake.posDevice = { updateMany: async () => ({ count: 1 }) };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] });
    const r = await recallTid(ctxOf(fake, ['TID_MANAGE']), 'T1', {});
    expect(r.ok).toBe(true);
    expect(tidUpdates[0]!.status).toBe('RECALLED');
    expect(tidUpdates[0]!.posSerial).toBe(null);
    expect(tidUpdates[0]!.agentId).toBe(null);
    expect(events[0]!.toState).toBe('RECALLED');
    expect(audits.some((a) => a['action'] === 'TID_RECALLED')).toBe(true);
  });

  // TID-8 (audit 21/8): recall RE-ĐỌC hàng tid TRONG tx (FOR UPDATE) rồi RE-QUYẾT ĐỊNH — dùng posSerial/customerId
  // TƯƠI, KHÔNG phải snapshot đọc NGOÀI tx (chống TOCTOU: giữa dirty-read và ghi, thao tác khác đổi máy/khách).
  it('TID-8: re-đọc TRONG tx (FOR UPDATE) — dùng posSerial/customerId TƯƠI, có khóa tids', async () => {
    const { fake, events } = baseFake();
    const locks: string[] = [];
    let call = 0;
    const stale = { id: 1, tid: 'T1', status: 'ACTIVE', posSerial: 'S1', customerId: 7, agentId: 5, deletedAt: null };
    const fresh = { id: 1, tid: 'T1', status: 'ACTIVE', posSerial: 'S2', customerId: 9, agentId: 6, deletedAt: null };
    fake.tid = {
      findUnique: async () => (call++ === 0 ? stale : fresh), // lần 1 = pre-check NGOÀI tx; lần 2 = re-đọc TRONG tx
      update: async ({ data }: { data: Record<string, unknown> }) => ({ ...data })
    };
    const bindingWhere: Record<string, unknown>[] = [];
    fake.posTidBinding = { updateMany: async ({ where }: { where: Record<string, unknown> }) => { bindingWhere.push(where); return { count: 1 }; } };
    fake.posDevice = { updateMany: async () => ({ count: 1 }) };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({
      ...fake,
      $queryRaw: async (strings: TemplateStringsArray) => { if (strings.join('?').includes('FROM tids')) locks.push('tid'); return []; }
    });
    const r = await recallTid(ctxOf(fake, ['TID_MANAGE']), 'T1', {});
    expect(r.ok).toBe(true);
    // Dùng bản TƯƠI 'S2'/khách 9 cho unbind binding + assetEvent — KHÔNG dùng snapshot 'S1'/khách 7.
    expect(bindingWhere[0]!.posSerial).toBe('S2');
    expect(events[0]!.deviceSerial).toBe('S2');
    expect(events[0]!.customerId).toBe(9);
    // Có khóa FOR UPDATE trên hàng tids TRONG tx.
    expect(locks).toContain('tid');
  });
});
