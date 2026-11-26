// Test LÕI THUẦN deposit core (@sigma/services) — helper tx (openDepositTx/refund/applyHandoverTx) + resolveHandoverInput
// + báo cáo depositsHeld (REVENUE_VIEW). ASSERT: mô hình tiền CỌC (DeviceDeposit OPEN + CashEntry THU DEPOSIT),
// HOÀN cọc (CashEntry CHI DEPOSIT_REFUND + REFUNDED), RENT → doanh thu, validate loại giao, message tiếng Việt.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import type { Prisma } from '@sigma/database';
import {
  resolveHandoverInput, buildHandoverContext, applyHandoverTx, openDepositTx, refundOpenDepositsForSerialTx, depositsHeld,
  flagStrandedDepositsTx, depositsNeedingManualRefund, refundDepositManual,
  type ServiceCtx
} from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 9, username: 't', fullName: 'KT', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

function counterFns() {
  const counters = new Map<string, number>();
  return { codeCounter: { upsert: async ({ where }: { where: { prefix: string } }) => { const n = (counters.get(where.prefix) ?? 0) + 1; counters.set(where.prefix, n); return { prefix: where.prefix, lastValue: n }; } } };
}

describe('resolveHandoverInput — validate loại giao', () => {
  const db = { handoverType: { findUnique: async ({ where }: { where: { id: number } }) => ({ 10: { id: 10, deletedAt: null, moneyKind: 'DEPOSIT' }, 11: { id: 11, deletedAt: null, moneyKind: 'RENT' }, 12: { id: 12, deletedAt: null, moneyKind: 'NONE' } }[where.id] ?? null) }, fund: { findFirst: async () => ({ id: 1 }) } } as unknown as Db;

  it('không chọn loại giao → NONE 0đ', async () => {
    const r = await resolveHandoverInput(db, {});
    expect(r.ok && r.moneyKind).toBe('NONE');
  });
  it('CỌC phải nhập tiền > 0 → VALIDATION', async () => {
    const r = await resolveHandoverInput(db, { handoverTypeId: 10, amount: 0 });
    expect(!r.ok && r.error).toBe('VALIDATION');
    expect(!r.ok && r.message).toBe('Giao hình thức "Cọc" phải nhập số tiền cọc (> 0).');
  });
  it('CỌC có tiền nhưng thiếu quỹ → VALIDATION quỹ nhận', async () => {
    const dbNoFund = { ...db, fund: { findFirst: async () => null } } as unknown as Db;
    const r = await resolveHandoverInput(dbNoFund, { handoverTypeId: 10, amount: 500000, fundId: 9 });
    expect(!r.ok && r.error).toBe('NOT_FOUND');
  });
  it('CỌC hợp lệ → DEPOSIT + amount bigint + fundId', async () => {
    const r = await resolveHandoverInput(db, { handoverTypeId: 10, amount: 500000, fundId: 1 });
    expect(r.ok && r.moneyKind).toBe('DEPOSIT');
    expect(r.ok && r.amount).toBe(500000n);
  });
});

describe('applyHandoverTx / openDepositTx — mô hình tiền (tx GHI)', () => {
  it('DEPOSIT → DeviceDeposit OPEN + CashEntry THU DEPOSIT', async () => {
    const deposits: Record<string, unknown>[] = [];
    const entries: Record<string, unknown>[] = [];
    const tx = {
      ...counterFns(),
      deviceDeposit: { create: async ({ data }: { data: Record<string, unknown> }) => { const d = { id: 1, ...data }; deposits.push(d); return d; } },
      cashCategory: { findFirst: async ({ where }: { where: { sourceKind: string } }) => ({ id: where.sourceKind === 'DEPOSIT' ? 20 : 0 }) },
      cashEntry: { create: async ({ data }: { data: Record<string, unknown> }) => { entries.push({ ...data }); return { ...data }; } }
    } as unknown as Prisma.TransactionClient;
    const r = await resolveHandoverInput({ handoverType: { findUnique: async () => ({ id: 10, deletedAt: null, moneyKind: 'DEPOSIT' }) }, fund: { findFirst: async () => ({ id: 1 }) } } as unknown as Db, { handoverTypeId: 10, amount: 500000, fundId: 1 });
    expect(r.ok).toBe(true);
    const ctx = buildHandoverContext(r as Extract<typeof r, { ok: true }>, { deviceSerial: 'S1', tid: null, customerId: 5, occurredAt: new Date(), actorId: 9 });
    await applyHandoverTx(tx, ctx);
    expect(deposits[0]!.status).toBe('OPEN');
    expect(deposits[0]!.amount).toBe(500000n);
    expect(entries[0]!.sourceType).toBe('DEVICE_DEPOSIT');
    expect(entries[0]!.kind).toBe('THU');
  });

  it('RENT amount>0 → CashEntry THU RENT (doanh thu)', async () => {
    const entries: Record<string, unknown>[] = [];
    const tx = {
      ...counterFns(),
      cashCategory: { findFirst: async () => ({ id: 30 }) },
      cashEntry: { create: async ({ data }: { data: Record<string, unknown> }) => { entries.push({ ...data }); return { ...data }; } }
    } as unknown as Prisma.TransactionClient;
    await applyHandoverTx(tx, { moneyKind: 'RENT', handoverTypeId: 11, amount: 200000n, fundId: 1, method: 'CASH', deviceSerial: 'S1', tid: null, customerId: 5, occurredAt: new Date(), actorId: 9 });
    expect(entries[0]!.sourceType).toBe('RENT');
    expect(entries[0]!.amount).toBe(200000n);
  });

  it('refundOpenDepositsForSerialTx → hoàn phần còn giữ (CHI DEPOSIT_REFUND + REFUNDED)', async () => {
    const chi: Record<string, unknown>[] = [];
    const refunds: Record<string, unknown>[] = [];
    let depStatus = 'OPEN';
    const tx = {
      ...counterFns(),
      deviceDeposit: {
        findMany: async () => [{ id: 1 }],
        findUnique: async ({ where, select }: { where: { id: number }; select?: Record<string, boolean> }) => (select?.amount ? { amount: 500000n } : { id: 1, status: depStatus, amount: 500000n, customerId: 5 }),
        update: async ({ data }: { data: { status: string } }) => { depStatus = data.status; return {}; }
      },
      deviceDepositRefund: { aggregate: async () => ({ _sum: { amount: 0n } }), create: async ({ data }: { data: Record<string, unknown> }) => { refunds.push({ ...data }); return { ...data }; } },
      cashCategory: { findFirst: async () => ({ id: 40 }) },
      cashEntry: { findFirst: async () => ({ fundId: 1 }), create: async ({ data }: { data: Record<string, unknown> }) => { const e = { id: 99, ...data }; chi.push(e); return e; } },
      $queryRaw: async () => []
    } as unknown as Prisma.TransactionClient;
    const total = await refundOpenDepositsForSerialTx(tx, { serial: 'S1', fundIdOverride: null, method: 'CASH', occurredAt: new Date(), actorId: 9 });
    expect(total).toBe(500000n);
    expect(chi[0]!.kind).toBe('CHI');
    expect(chi[0]!.sourceType).toBe('DEVICE_DEPOSIT');
    expect(refunds[0]!.amount).toBe(500000n);
    expect(depStatus).toBe('REFUNDED');
  });
});

describe('CỌC KẸT (Admin Demo 11/8) — flag + cảnh báo + hoàn TAY', () => {
  it('flagStrandedDepositsTx — cọc OPEN còn giữ (remaining>0) → ghi 1 AssetEvent DEPOSIT_UNREFUNDED; cọc đã hoàn hết thì bỏ qua', async () => {
    const events: Record<string, unknown>[] = [];
    const tx = {
      deviceDeposit: { findMany: async () => [{ id: 1, customerId: 5, tid: null }, { id: 2, customerId: 6, tid: 'T2' }], findUnique: async ({ where }: { where: { id: number } }) => ({ 1: { amount: 500000n }, 2: { amount: 300000n } }[where.id] ?? null) },
      // cọc #1 chưa hoàn (remaining 500000); cọc #2 đã hoàn hết (remaining 0) → không flag.
      deviceDepositRefund: { aggregate: async ({ where }: { where: { deviceDepositId: number } }) => ({ _sum: { amount: where.deviceDepositId === 2 ? 300000n : 0n } }) },
      assetEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data; } }
    } as unknown as Prisma.TransactionClient;
    const n = await flagStrandedDepositsTx(tx, { serial: 'S1', reason: 'SOLD', actorId: 9, occurredAt: new Date() });
    expect(n).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('DEPOSIT_UNREFUNDED');
    expect(String(events[0]!.note)).toContain('500000');
  });

  it('depositsNeedingManualRefund — chỉ cọc OPEN gắn máy SOLD/RETIRED (hoặc máy mất) + remaining>0', async () => {
    const fake = {
      deviceDeposit: { findMany: async () => [
        { id: 1, code: 'CO1', customerId: 5, deviceSerial: 'S1', tid: null, amount: 500000n, occurredAt: new Date('2026-01-01'), note: null }, // máy SOLD → liệt kê
        { id: 2, code: 'CO2', customerId: 5, deviceSerial: 'S2', tid: null, amount: 200000n, occurredAt: new Date('2026-01-02'), note: null }, // máy DEPLOYED → bỏ (recall được)
        { id: 3, code: 'CO3', customerId: 6, deviceSerial: 'S3', tid: null, amount: 100000n, occurredAt: new Date('2026-01-03'), note: null }  // máy RETIRED nhưng đã hoàn hết → bỏ
      ] },
      posDevice: { findMany: async () => [{ serial: 'S1', status: 'SOLD' }, { serial: 'S2', status: 'DEPLOYED' }, { serial: 'S3', status: 'RETIRED' }] },
      deviceDepositRefund: { groupBy: async () => [{ deviceDepositId: 3, _sum: { amount: 100000n } }] },
      customer: { findMany: async () => [{ id: 5, nickname: 'A', fullName: 'Ng A' }, { id: 6, nickname: 'B', fullName: 'Ng B' }] }
    } as unknown as Db;
    const r = await depositsNeedingManualRefund({ db: fake, user: authUser(['REVENUE_VIEW']) } as ServiceCtx);
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(r.data![0]!.depositId).toBe(1);
    expect(r.data![0]!.deviceStatus).toBe('SOLD');
    expect(r.data![0]!.remaining).toBe(500000);
  });

  it('depositsNeedingManualRefund — thiếu REVENUE_VIEW → FORBIDDEN', async () => {
    const r = await depositsNeedingManualRefund({ db: {} as unknown as Db, user: authUser([]) } as ServiceCtx);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('refundDepositManual — máy đã SOLD vẫn hoàn được: CHI DEPOSIT_REFUND + REFUNDED + breadcrumb; thiếu quỹ → VALIDATION', async () => {
    // thiếu fundId
    const rNoFund = await refundDepositManual({ db: {} as unknown as Db, user: authUser(['POS_MANAGE']) } as ServiceCtx, { depositId: 1, fundId: 0 });
    expect(rNoFund.ok).toBe(false);
    expect(rNoFund.error).toBe('VALIDATION');

    const chi: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    let depStatus = 'OPEN';
    const tx = {
      ...counterFns(),
      fund: { findFirst: async () => ({ id: 1 }) },
      deviceDeposit: {
        findUnique: async ({ where, select }: { where: { id: number }; select?: Record<string, boolean> }) => (select?.amount ? { amount: 500000n } : { id: 1, status: depStatus, amount: 500000n, customerId: 5, deviceSerial: 'S1', tid: null, code: 'CO1' }),
        update: async ({ data }: { data: { status: string } }) => { depStatus = data.status; return {}; }
      },
      deviceDepositRefund: { aggregate: async () => ({ _sum: { amount: 0n } }), create: async () => ({}) },
      cashCategory: { findFirst: async () => ({ id: 40 }) },
      cashEntry: { create: async ({ data }: { data: Record<string, unknown> }) => { const e = { id: 77, ...data }; chi.push(e); return e; } },
      assetEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data; } },
      $queryRaw: async () => []
    } as unknown as Prisma.TransactionClient;
    const db = {
      $transaction: async (fn: (t: Prisma.TransactionClient) => Promise<unknown>) => fn(tx),
      changeToken: { upsert: async () => ({}) }
    } as unknown as Db;
    const r = await refundDepositManual({ db, user: authUser(['POS_MANAGE']) } as ServiceCtx, { depositId: 1, fundId: 1, method: 'CK' });
    expect(r.ok).toBe(true);
    expect(depStatus).toBe('REFUNDED');
    expect(chi[0]!.kind).toBe('CHI');
    expect(chi[0]!.sourceType).toBe('DEVICE_DEPOSIT');
    expect(Number(chi[0]!.amount)).toBe(500000);
    expect(events[0]!.eventType).toBe('DEPOSIT_REFUND_MANUAL');
  });

  it('refundDepositManual — cọc đã REFUNDED → ALREADY_REFUNDED (chống hoàn 2 lần)', async () => {
    const tx = {
      ...counterFns(),
      fund: { findFirst: async () => ({ id: 1 }) },
      deviceDeposit: { findUnique: async () => ({ id: 1, status: 'REFUNDED', amount: 500000n, customerId: 5, deviceSerial: 'S1', tid: null, code: 'CO1' }) },
      $queryRaw: async () => []
    } as unknown as Prisma.TransactionClient;
    const db = { $transaction: async (fn: (t: Prisma.TransactionClient) => Promise<unknown>) => fn(tx), changeToken: { upsert: async () => ({}) } } as unknown as Db;
    const r = await refundDepositManual({ db, user: authUser(['POS_MANAGE']) } as ServiceCtx, { depositId: 1, fundId: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('ALREADY_REFUNDED');
  });

  it('refundDepositManual — thiếu POS_MANAGE → FORBIDDEN', async () => {
    const r = await refundDepositManual({ db: {} as unknown as Db, user: authUser([]) } as ServiceCtx, { depositId: 1, fundId: 1 });
    expect(r.error).toBe('FORBIDDEN');
  });
});

describe('depositsHeld — báo cáo cọc đang giữ', () => {
  it('thiếu REVENUE_VIEW → FORBIDDEN', async () => {
    const fake = { deviceDeposit: { findMany: async () => [] } } as unknown as Db;
    const r = await depositsHeld({ db: fake, user: authUser([]) } as ServiceCtx);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('gộp theo khách, chỉ remaining>0', async () => {
    const fake = {
      deviceDeposit: { findMany: async () => [{ id: 1, customerId: 5, amount: 500000n }, { id: 2, customerId: 5, amount: 300000n }] },
      deviceDepositRefund: { groupBy: async () => [{ deviceDepositId: 2, _sum: { amount: 100000n } }] },
      customer: { findMany: async () => [{ id: 5, nickname: 'Anh A', fullName: 'Nguyễn A' }] }
    } as unknown as Db;
    const r = await depositsHeld({ db: fake, user: authUser(['REVENUE_VIEW']) } as ServiceCtx);
    expect(r.ok).toBe(true);
    expect(r.data![0]!.customerName).toBe('Anh A');
    expect(r.data![0]!.remaining).toBe(700000); // 800000 − 100000 hoàn
  });
});
