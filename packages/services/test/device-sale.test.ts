// Test LÕI THUẦN device-sale core (@sigma/services) — Db GIẢ in-memory. ASSERT: bán máy POS (DeviceSale + SELL event
// + PosDevice→SOLD), kế toán khóa (doanh thu SALE_POS fundId=null accrual + tiền thu SALE_COLLECT vào quỹ +
// settlement = PnL), thu thêm không vượt còn-nợ, công nợ gộp theo khách. §14 mật khẩu (bán) ở ADAPTER — lõi KHÔNG kiểm.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { sellPos, collectDeviceSaleDebt, listDeviceSales, customerDeviceReceivables, type ServiceCtx } from '../src/index.js';

const MANAGE = 'DEVICE_SALE_MANAGE', SVIEW = 'DEVICE_SALE_VIEW';
function authUser(permissions: string[]): AuthUser {
  return { id: 9, username: 't', fullName: 'KT', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}
function ctxOf(fake: Record<string, unknown>, perms: string[]): ServiceCtx {
  return { db: fake as unknown as Db, user: authUser(perms) };
}

function base() {
  const audits: Record<string, unknown>[] = [];
  const counters = new Map<string, number>();
  const fake: Record<string, unknown> = {
    user: { findMany: async () => [] },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({}) },
    codeCounter: { upsert: async ({ where }: { where: { prefix: string } }) => { const n = (counters.get(where.prefix) ?? 0) + 1; counters.set(where.prefix, n); return { prefix: where.prefix, lastValue: n }; } }
  };
  return { fake, audits };
}

describe('sellPos — bán máy + kế toán khóa', () => {
  it('thiếu quyền → FORBIDDEN', async () => {
    const { fake } = base();
    const r = await sellPos(ctxOf(fake, [SVIEW]), 'S1', { customerId: 5, salePrice: 100 });
    expect(r.error).toBe('FORBIDDEN');
  });

  it('giá bán = 0 → VALIDATION (money)', async () => {
    const { fake } = base();
    fake.customer = { findFirst: async () => ({ id: 5 }) };
    const r = await sellPos(ctxOf(fake, [MANAGE]), 'S1', { customerId: 5, salePrice: 0 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Giá bán phải là số nguyên > 0 (VND).');
  });

  it('thu ngay > giá bán → VALIDATION', async () => {
    const { fake } = base();
    fake.customer = { findFirst: async () => ({ id: 5 }) };
    const r = await sellPos(ctxOf(fake, [MANAGE]), 'S1', { customerId: 5, salePrice: 100, paidNow: 200, fundId: 1 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Số tiền thu không được lớn hơn giá bán.');
  });

  function saleFake(devStatus: string, openDeps: { amount: bigint; refunded: bigint }[] = []) {
    const { fake, audits } = base();
    const entries: Record<string, unknown>[] = [];
    const settlements: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    const dev = { id: 1, serial: 'S1', deletedAt: null, status: devStatus, currentTid: null, warehouseId: 1, currentCustomerId: null, currentAgentId: null };
    fake.customer = { findFirst: async () => ({ id: 5 }) };
    fake.fund = { findFirst: async () => ({ id: 1 }) };
    fake.posDevice = { findUnique: async () => ({ ...dev }), update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(dev, data); return { ...dev }; } };
    fake.deviceSale = { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 50, ...data }) };
    fake.tid = { findUnique: async () => null, update: async () => ({}) };
    fake.posTidBinding = { updateMany: async () => ({ count: 0 }) };
    fake.assetEvent = { create: async ({ data }: { data: Record<string, unknown> }) => { events.push({ ...data }); return { ...data }; } };
    fake.cashCategory = { findFirst: async ({ where }: { where: { sourceKind: string } }) => ({ id: where.sourceKind === 'SALE_POS' ? 60 : 61 }) };
    fake.cashEntry = { create: async ({ data }: { data: Record<string, unknown> }) => { const e = { id: entries.length + 1, ...data }; entries.push(e); return e; } };
    fake.deviceSaleSettlement = { create: async ({ data }: { data: Record<string, unknown> }) => { settlements.push({ ...data }); return { ...data }; } };
    // CỌC KẸT (Admin Demo 11/8) — sellPos gọi flagStrandedDepositsTx trong tx. deposits = danh sách cọc OPEN gắn máy.
    const deposits = openDeps.map((d, i) => ({ id: i + 1, customerId: 5, tid: null as string | null, amount: d.amount, refunded: d.refunded }));
    fake.deviceDeposit = {
      findMany: async () => deposits.map((d) => ({ id: d.id, customerId: d.customerId, tid: d.tid })),
      findUnique: async ({ where }: { where: { id: number } }) => { const d = deposits.find((x) => x.id === where.id); return d ? { amount: d.amount } : null; }
    };
    fake.deviceDepositRefund = { aggregate: async ({ where }: { where: { deviceDepositId: number } }) => ({ _sum: { amount: deposits.find((d) => d.id === where.deviceDepositId)?.refunded ?? 0n } }) };
    fake.$queryRaw = async () => [];
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] });
    return { fake, audits, entries, settlements, events, dev };
  }

  it('bán máy IN_STOCK thu ngay 1 phần → SOLD + doanh thu SALE_POS(fundId=null) + thu SALE_COLLECT + settlement', async () => {
    const { fake, dev, entries, settlements, events, audits } = saleFake('IN_STOCK');
    const r = await sellPos(ctxOf(fake, [MANAGE]), 'S1', { customerId: 5, salePrice: 1000000, paidNow: 400000, fundId: 1, method: 'CK' });
    expect(r.ok).toBe(true);
    expect(dev.status).toBe('SOLD');
    expect(dev.warehouseId).toBe(null);
    expect(events.some((e) => e['eventType'] === 'SELL')).toBe(true);
    const revenue = entries.find((e) => e['sourceType'] === 'SALE_POS');
    expect(revenue!.fundId).toBe(null); // doanh thu accrual — KHÔNG đụng quỹ
    expect(revenue!.amount).toBe(1000000n);
    const collect = entries.find((e) => e['sourceType'] === 'SALE_COLLECT');
    expect(collect!.fundId).toBe(1);
    expect(collect!.amount).toBe(400000n);
    expect(settlements[0]!.amount).toBe(400000n);
    expect(audits.some((a) => a['action'] === 'DEVICE_SOLD')).toBe(true);
  });

  it('CỌC KẸT — bán máy DEPLOYED còn cọc OPEN → SOLD + cọc GIỮ (breadcrumb DEPOSIT_UNREFUNDED, KHÔNG tự hoàn/chặn)', async () => {
    const { fake, dev, events } = saleFake('DEPLOYED', [{ amount: 500000n, refunded: 0n }]);
    const r = await sellPos(ctxOf(fake, [MANAGE]), 'S1', { customerId: 5, salePrice: 1000000 });
    expect(r.ok).toBe(true);
    expect(dev.status).toBe('SOLD');
    // KHÔNG có bút toán hoàn cọc (CHI DEPOSIT_REFUND) — cọc phải hoàn TAY.
    const warn = events.find((e) => e['eventType'] === 'DEPOSIT_UNREFUNDED');
    expect(warn).toBeTruthy();
    expect(String(warn!['note'])).toContain('500000');
  });

  it('bán máy đã RETIRED → INVALID_STATE (không bán được)', async () => {
    const { fake } = saleFake('RETIRED');
    const r = await sellPos(ctxOf(fake, [MANAGE]), 'S1', { customerId: 5, salePrice: 1000 });
    expect(r.error).toBe('INVALID_STATE');
    expect(r.message).toContain('RETIRED');
  });
});

describe('collectDeviceSaleDebt — thu thêm', () => {
  function collectFake(salePrice: bigint, alreadyPaid: bigint) {
    const { fake, audits } = base();
    const entries: Record<string, unknown>[] = [];
    fake.deviceSale = { findUnique: async () => ({ id: 50, deletedAt: null, status: 'POSTED', salePrice, customerId: 5 }) };
    fake.deviceSaleSettlement = { aggregate: async () => ({ _sum: { amount: alreadyPaid } }), create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) };
    fake.fund = { findFirst: async () => ({ id: 1 }) };
    fake.cashCategory = { findFirst: async () => ({ id: 61 }) };
    fake.cashEntry = { create: async ({ data }: { data: Record<string, unknown> }) => { const e = { id: 1, ...data }; entries.push(e); return e; } };
    fake.$queryRaw = async () => [];
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] });
    return { fake, audits, entries };
  }
  it('đã thu đủ → ALREADY_SETTLED', async () => {
    const { fake } = collectFake(1000n, 1000n);
    const r = await collectDeviceSaleDebt(ctxOf(fake, [MANAGE]), { deviceSaleId: 50, amount: 100, fundId: 1 });
    expect(r.error).toBe('ALREADY_SETTLED');
  });
  it('thu vượt còn-nợ → VALIDATION', async () => {
    const { fake } = collectFake(1000n, 800n);
    const r = await collectDeviceSaleDebt(ctxOf(fake, [MANAGE]), { deviceSaleId: 50, amount: 500, fundId: 1 });
    expect(r.error).toBe('VALIDATION');
  });
  it('thu hợp lệ → ok + SALE_COLLECT + audit', async () => {
    const { fake, entries, audits } = collectFake(1000n, 800n);
    const r = await collectDeviceSaleDebt(ctxOf(fake, [MANAGE]), { deviceSaleId: 50, amount: 200, fundId: 1, method: 'CASH' });
    expect(r.ok).toBe(true);
    expect(entries[0]!.sourceType).toBe('SALE_COLLECT');
    expect(audits.some((a) => a['action'] === 'DEVICE_SALE_COLLECT')).toBe(true);
  });

  // API-3 (audit 21/8): thiếu quỹ (fundId undefined/0) → PHẢI VALIDATION. Trước đây Prisma DROP `id: undefined` →
  // findFirst khớp quỹ đầu tiên → CashEntry.fundId=undefined (NULL quỹ) = tiền vào không ghi quỹ. Nay CHẶN + KHÔNG
  // ghi CashEntry/settlement nào.
  it('API-3: thiếu quỹ (fundId undefined) → VALIDATION, KHÔNG tạo CashEntry/settlement', async () => {
    const { fake, entries } = collectFake(1000n, 800n);
    const settleCreated: unknown[] = [];
    (fake.deviceSaleSettlement as { create: (a: { data: Record<string, unknown> }) => Promise<unknown> }).create =
      async ({ data }) => { settleCreated.push(data); return data; };
    const r = await collectDeviceSaleDebt(ctxOf(fake, [MANAGE]), { deviceSaleId: 50, amount: 200 } as unknown as { deviceSaleId: number; amount: number; fundId: number });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Phải chọn quỹ nhận tiền.');
    expect(entries.length).toBe(0);
    expect(settleCreated.length).toBe(0);
  });

  it('API-3: fundId = 0 (không hợp lệ) → VALIDATION', async () => {
    const { fake, entries } = collectFake(1000n, 800n);
    const r = await collectDeviceSaleDebt(ctxOf(fake, [MANAGE]), { deviceSaleId: 50, amount: 200, fundId: 0 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Phải chọn quỹ nhận tiền.');
    expect(entries.length).toBe(0);
  });
});

describe('listDeviceSales / customerDeviceReceivables — công nợ', () => {
  it('remaining = salePrice − Σ settlement; onlyDebt lọc còn nợ', async () => {
    const fake = {
      deviceSale: { findMany: async () => [{ id: 50, code: 'BS01', saleKind: 'POS', deviceSerial: 'S1', tid: null, customerId: 5, salePrice: 1000n, soldByUserId: 9, occurredAt: new Date(), note: null }] },
      deviceSaleSettlement: { groupBy: async () => [{ deviceSaleId: 50, _sum: { amount: 300n } }] },
      customer: { findMany: async () => [{ id: 5, nickname: 'A', fullName: 'Nguyễn A' }] },
      user: { findMany: async () => [{ id: 9, fullName: 'KT', username: 't' }] }
    } as unknown as Db;
    const r = await listDeviceSales({ db: fake, user: authUser([SVIEW]) } as ServiceCtx, { onlyDebt: true });
    expect(r.ok).toBe(true);
    expect(r.data![0]!.remaining).toBe(700);
  });

  it('customerDeviceReceivables gộp theo khách (chỉ còn nợ)', async () => {
    const fake = {
      deviceSale: { findMany: async () => [{ id: 50, customerId: 5, salePrice: 1000n }, { id: 51, customerId: 5, salePrice: 500n }] },
      deviceSaleSettlement: { groupBy: async () => [{ deviceSaleId: 50, _sum: { amount: 200n } }] },
      customer: { findMany: async () => [{ id: 5, nickname: 'A', fullName: 'Nguyễn A' }] }
    } as unknown as Db;
    const r = await customerDeviceReceivables({ db: fake, user: authUser([SVIEW]) } as ServiceCtx);
    expect(r.ok).toBe(true);
    expect(r.data![0]!.remaining).toBe(1300); // 1500 − 200
  });
});
