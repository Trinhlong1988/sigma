// Test LÕI THUẦN pos core (@sigma/services) — Db GIẢ in-memory + ServiceCtx = { db, user }. ASSERT: state-machine
// (INVALID_STATE), optimistic-lock (STALE_WRITE), tx ghi PosDevice + AssetEvent + audit, message tiếng Việt nguyên văn.
// §14 mật khẩu (retire) ở ADAPTER — lõi KHÔNG kiểm.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  listPosDevices, createPos, updatePos, deployPos, recallPos, retirePos, reportPosDamage, transferPosAgent,
  type ServiceCtx
} from '../src/index.js';

const VIEW = 'POS_VIEW';
const MANAGE = 'POS_MANAGE';
function authUser(permissions: string[]): AuthUser {
  return { id: 9, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}
function ctxOf(fake: Record<string, unknown>, perms: string[]): ServiceCtx {
  return { db: fake as unknown as Db, user: authUser(perms) };
}

function baseFake() {
  const audits: Record<string, unknown>[] = [];
  const fake: Record<string, unknown> = {
    user: { findMany: async () => [{ id: 9, fullName: 'Người Kiểm Thử', username: 'tester' }], findUnique: async () => ({ address: '12 Kho' }) },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) }
  };
  return { fake, audits };
}

describe('pos core — đọc + hồ sơ', () => {
  it('thiếu quyền POS_VIEW → FORBIDDEN nguyên văn', async () => {
    const { fake } = baseFake();
    fake.posDevice = { findMany: async () => [] };
    const r = await listPosDevices(ctxOf(fake, []));
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('createPos thiếu serial → VALIDATION', async () => {
    const { fake } = baseFake();
    fake.posDevice = { findUnique: async () => null };
    const r = await createPos(ctxOf(fake, [MANAGE]), { serial: '  ' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Serial máy POS bắt buộc.');
  });

  it('createPos trùng serial → DUPLICATE', async () => {
    const { fake } = baseFake();
    fake.posDevice = { findUnique: async ({ where }: { where: { serial: string } }) => (where.serial === 'S1' ? { id: 1, serial: 'S1' } : null) };
    const r = await createPos(ctxOf(fake, [MANAGE]), { serial: 'S1' });
    expect(r.error).toBe('DUPLICATE');
    expect(r.message).toBe('Serial POS "S1" đã tồn tại.');
  });

  it('createPos hợp lệ → IN_STOCK + STOCK_IN event + audit POS_CREATED (trong $transaction)', async () => {
    const { fake, audits } = baseFake();
    const devices: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    fake.posDevice = {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { const d = { id: 1, ...data }; devices.push(d); return d; }
    };
    fake.assetEvent = { create: async ({ data }: { data: Record<string, unknown> }) => { events.push({ ...data }); return { ...data }; } };
    fake.$queryRaw = async () => [];
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(fake);
    const r = await createPos(ctxOf(fake, [MANAGE]), { serial: 'SER-NEW' });
    expect(r.ok).toBe(true);
    expect(devices[0]!.status).toBe('IN_STOCK');
    expect(events[0]!.eventType).toBe('STOCK_IN');
    expect(audits.some((a) => a['action'] === 'POS_CREATED')).toBe(true);
  });

  it('updatePos optimistic-lock lệch mốc → STALE_WRITE', async () => {
    const { fake } = baseFake();
    const row = { id: 1, deletedAt: null, updatedAt: new Date('2026-01-02T00:00:00Z'), model: 'A', bank: null, bankId: null, posModelId: null, supplierId: null, importPrice: null, importedAt: null, warehouseId: null, warehouseLoc: null, note: null, status: 'IN_STOCK' };
    fake.posDevice = { findUnique: async () => ({ ...row }) };
    const r = await updatePos(ctxOf(fake, [MANAGE]), 1, { note: 'x', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' });
    expect(r.error).toBe('STALE_WRITE');
  });
});

describe('pos core — transition (state-machine + tx)', () => {
  // FIX-FK: opts.customers / opts.agents = khách/đại lý CÓ THẬT để validate scalar-ref (deploy/transferAgent).
  // Mặc định seed khách #5 (các test deploy cũ dùng customerId:5) để không vỡ; đại lý mặc định rỗng.
  function fakeWithDevice(
    dev: Record<string, unknown>,
    opts: { customers?: { id: number; deletedAt: Date | null }[]; agents?: { id: number; deletedAt: Date | null }[] } = {}
  ) {
    const { fake, audits } = baseFake();
    const events: Record<string, unknown>[] = [];
    const patches: Record<string, unknown>[] = [];
    const cur = { ...dev };
    fake.posDevice = {
      findUnique: async (_args?: unknown) => ({ ...cur }),
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(cur, data); patches.push({ ...data }); return { ...cur }; }
    };
    // FIX-FK: fake customer/agent.findFirst — chỉ khớp id CÓ trong seed và chưa xóa mềm (deletedAt null).
    const custSeed = opts.customers ?? [{ id: 5, deletedAt: null }];
    fake.customer = { findFirst: async ({ where }: { where: { id: number; deletedAt: null } }) => {
      const c = custSeed.find((x) => x.id === where.id && x.deletedAt === null);
      return c ? { id: c.id } : null;
    } };
    const agentSeed = opts.agents ?? [];
    fake.agent = { findFirst: async ({ where }: { where: { id: number; deletedAt: null } }) => {
      const a = agentSeed.find((x) => x.id === where.id && x.deletedAt === null);
      return a ? { id: a.id } : null;
    } };
    fake.warehouse = { findFirst: async ({ where }: { where: { id: number } }) => (where.id === 1 ? { id: 1, deletedAt: null, address: '12 Kho Chính', managerUserId: null } : null) };
    fake.assetEvent = { create: async ({ data }: { data: Record<string, unknown> }) => { events.push({ ...data }); return { ...data }; } };
    fake.tid = { updateMany: async () => ({ count: 0 }), findUnique: async () => null, update: async () => ({}) };
    fake.posTidBinding = { updateMany: async () => ({ count: 0 }) };
    // TID-5 — recall/changeCustomer nay soft-unlink phòng chat của TID (chatRoomTid). Mặc định KHÔNG có link active → no-op.
    fake.chatRoomTid = { findFirst: async () => null, update: async () => ({}), create: async () => ({}) };
    fake.deviceDeposit = { findMany: async () => [] };
    fake.$queryRaw = async () => [];
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] });
    return { fake, audits, events, patches, cur };
  }

  it('deploy thiếu khách → VALIDATION (trước tx)', async () => {
    const { fake } = fakeWithDevice({ id: 1, serial: 'S1', status: 'IN_STOCK', warehouseId: 1, currentTid: null, currentCustomerId: null, currentAgentId: null });
    const r = await deployPos(ctxOf(fake, [MANAGE]), 'S1', {});
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Triển khai máy phải chọn khách hàng nhận máy.');
  });

  it('deploy hợp lệ (NONE, mượn 0đ) → DEPLOYED + AssetEvent DEPLOY + audit POS_TRANSITION', async () => {
    const { fake, audits, events, cur } = fakeWithDevice({ id: 1, serial: 'S1', status: 'IN_STOCK', warehouseId: 1, currentTid: null, currentCustomerId: null, currentAgentId: null });
    const r = await deployPos(ctxOf(fake, [MANAGE]), 'S1', { customerId: 5 });
    expect(r.ok).toBe(true);
    expect(cur.status).toBe('DEPLOYED');
    expect(cur.warehouseId).toBe(null); // rời kho → invariant warehouseId=null khi không IN_STOCK
    expect(events[0]!.eventType).toBe('DEPLOY');
    expect(events[0]!.customerId).toBe(5);
    expect(audits.some((a) => a['action'] === 'POS_TRANSITION')).toBe(true);
  });

  it('FIX-FK: deploy khách KHÔNG tồn tại → VALIDATION, KHÔNG chuyển trạng thái (không ghi mồ côi)', async () => {
    const { fake, cur, audits } = fakeWithDevice({ id: 1, serial: 'S1', status: 'IN_STOCK', warehouseId: 1, currentTid: null, currentCustomerId: null, currentAgentId: null }, { customers: [{ id: 5, deletedAt: null }] });
    const r = await deployPos(ctxOf(fake, [MANAGE]), 'S1', { customerId: 9999 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Khách hàng được chọn không tồn tại (hoặc đã bị xóa). Vui lòng chọn lại.');
    expect(cur.status).toBe('IN_STOCK'); // chưa chuyển
    expect(audits.some((a) => a['action'] === 'POS_TRANSITION')).toBe(false);
  });

  it('FIX-FK: deploy khách ĐÃ XÓA MỀM → VALIDATION', async () => {
    const { fake, cur } = fakeWithDevice({ id: 1, serial: 'S1', status: 'IN_STOCK', warehouseId: 1, currentTid: null, currentCustomerId: null, currentAgentId: null }, { customers: [{ id: 5, deletedAt: new Date() }] });
    const r = await deployPos(ctxOf(fake, [MANAGE]), 'S1', { customerId: 5 });
    expect(r.error).toBe('VALIDATION');
    expect(cur.status).toBe('IN_STOCK');
  });

  it('FIX-FK: deploy kèm đại lý KHÔNG tồn tại → VALIDATION (đại lý)', async () => {
    const { fake, cur } = fakeWithDevice({ id: 1, serial: 'S1', status: 'IN_STOCK', warehouseId: 1, currentTid: null, currentCustomerId: null, currentAgentId: null }, { customers: [{ id: 5, deletedAt: null }], agents: [{ id: 7, deletedAt: null }] });
    const r = await deployPos(ctxOf(fake, [MANAGE]), 'S1', { customerId: 5, agentId: 8888 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Đại lý được chọn không tồn tại (hoặc đã bị xóa). Vui lòng chọn lại.');
    expect(cur.status).toBe('IN_STOCK');
  });

  it('FIX-FK: deploy khách + đại lý CÓ THẬT → DEPLOYED, gán đúng currentCustomerId/currentAgentId', async () => {
    const { fake, cur } = fakeWithDevice({ id: 1, serial: 'S1', status: 'IN_STOCK', warehouseId: 1, currentTid: null, currentCustomerId: null, currentAgentId: null }, { customers: [{ id: 5, deletedAt: null }], agents: [{ id: 7, deletedAt: null }] });
    const r = await deployPos(ctxOf(fake, [MANAGE]), 'S1', { customerId: 5, agentId: 7 });
    expect(r.ok).toBe(true);
    expect(cur.status).toBe('DEPLOYED');
    expect(cur.currentCustomerId).toBe(5);
    expect(cur.currentAgentId).toBe(7);
  });

  it('FIX-FK: transferAgent đại lý KHÔNG tồn tại → VALIDATION, KHÔNG ghi', async () => {
    const { fake, cur } = fakeWithDevice({ id: 1, serial: 'S1', status: 'DEPLOYED', warehouseId: null, currentTid: null, currentCustomerId: 5, currentAgentId: null }, { agents: [{ id: 7, deletedAt: null }] });
    const r = await transferPosAgent(ctxOf(fake, [MANAGE]), 'S1', { agentId: 9999 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Đại lý được chọn không tồn tại (hoặc đã bị xóa). Vui lòng chọn lại.');
    expect(cur.currentAgentId).toBeNull(); // giữ nguyên, không gán mồ côi
  });

  it('FIX-FK: transferAgent đại lý CÓ THẬT → gán đúng currentAgentId', async () => {
    const { fake, cur } = fakeWithDevice({ id: 1, serial: 'S1', status: 'DEPLOYED', warehouseId: null, currentTid: null, currentCustomerId: 5, currentAgentId: null }, { agents: [{ id: 7, deletedAt: null }] });
    const r = await transferPosAgent(ctxOf(fake, [MANAGE]), 'S1', { agentId: 7 });
    expect(r.ok).toBe(true);
    expect(cur.currentAgentId).toBe(7);
  });

  it('recall máy IN_STOCK → INVALID_STATE (message tiếng Việt có nhãn thao tác)', async () => {
    const { fake } = fakeWithDevice({ id: 1, serial: 'S1', status: 'IN_STOCK', warehouseId: 1, currentTid: null, currentCustomerId: null, currentAgentId: null });
    const r = await recallPos(ctxOf(fake, [MANAGE]), 'S1', { toWarehouseId: 1 });
    expect(r.error).toBe('INVALID_STATE');
    expect(r.message).toContain('Thu hồi về kho');
    expect(r.message).toContain('IN_STOCK');
  });

  it('recall DEPLOYED thiếu kho nhận → VALIDATION', async () => {
    const { fake } = fakeWithDevice({ id: 1, serial: 'S1', status: 'DEPLOYED', warehouseId: null, currentTid: null, currentCustomerId: 5, currentAgentId: null });
    const r = await recallPos(ctxOf(fake, [MANAGE]), 'S1', {});
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Phải chọn KHO nhận máy về (máy trong kho luôn phải thuộc 1 kho).');
  });

  it('recall DEPLOYED có kho → IN_STOCK + RECALL event (warehouseId gán lại)', async () => {
    const { fake, cur, events } = fakeWithDevice({ id: 1, serial: 'S1', status: 'DEPLOYED', warehouseId: null, currentTid: null, currentCustomerId: 5, currentAgentId: null });
    const r = await recallPos(ctxOf(fake, [MANAGE]), 'S1', { toWarehouseId: 1 });
    expect(r.ok).toBe(true);
    expect(cur.status).toBe('IN_STOCK');
    expect(cur.warehouseId).toBe(1);
    expect(events.some((e) => e['eventType'] === 'RECALL')).toBe(true);
  });

  // FIX ASSET-4 (RESET, owner 20/8): thu hồi MÁY về kho ⟹ TID reset hoàn toàn "chưa gán máy, chưa giao, chưa có khách".
  it('recall máy đang mang TID đã giao → TID về UNASSIGNED + customerId/deliveredAt/posSerial/agentId = null (RESET)', async () => {
    const { fake } = fakeWithDevice({ id: 1, serial: 'S1', status: 'DEPLOYED', warehouseId: null, currentTid: 'T1', currentCustomerId: 7, currentAgentId: 5 });
    const tidUpdates: Record<string, unknown>[] = [];
    // Override fake.tid: TID T1 đang ACTIVE, đã giao khách 7 — unbindTidFromDevice(mode recall) phải RESET.
    fake.tid = {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => ({ id: 1, tid: 'T1', status: 'ACTIVE', posSerial: 'S1', customerId: 7, agentId: 5, deliveredAt: new Date('2026-01-01T00:00:00.000Z') }),
      update: async ({ data }: { data: Record<string, unknown> }) => { tidUpdates.push({ ...data }); return { ...data }; }
    };
    const r = await recallPos(ctxOf(fake, [MANAGE]), 'S1', { toWarehouseId: 1 });
    expect(r.ok).toBe(true);
    expect(tidUpdates[0]!.status).toBe('UNASSIGNED');
    expect(tidUpdates[0]!.customerId).toBeNull();
    expect(tidUpdates[0]!.deliveredAt).toBeNull();
    expect(tidUpdates[0]!.posSerial).toBeNull();
    expect(tidUpdates[0]!.agentId).toBeNull();
  });

  it('reportDamage FORBIDDEN khi thiếu POS_MANAGE', async () => {
    const { fake } = fakeWithDevice({ id: 1, serial: 'S1', status: 'DEPLOYED', warehouseId: null, currentTid: null, currentCustomerId: 5, currentAgentId: null });
    const r = await reportPosDamage(ctxOf(fake, [VIEW]), 'S1', {});
    expect(r.error).toBe('FORBIDDEN');
  });

  it('retirePos (lõi KHÔNG kiểm password) IN_STOCK → RETIRED + audit', async () => {
    const { fake, cur, audits } = fakeWithDevice({ id: 1, serial: 'S1', status: 'IN_STOCK', warehouseId: 1, currentTid: null, currentCustomerId: null, currentAgentId: null });
    const r = await retirePos(ctxOf(fake, [MANAGE]), 'S1', {});
    expect(r.ok).toBe(true);
    expect(cur.status).toBe('RETIRED');
    expect(audits.some((a) => a['action'] === 'POS_TRANSITION')).toBe(true);
  });
});
