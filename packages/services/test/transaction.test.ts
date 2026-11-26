// Test LÕI THUẦN transaction core (@sigma/services) — Db GIẢ in-memory + ServiceCtx = { db, user }. ASSERT giá trị
// cụ thể: error code + nguyên văn message tiếng Việt + tx NHIỀU BẢNG (transaction/auditLog/cashEntry/debtQualityLog)
// + khóa FOR UPDATE TOCTOU write-off (đọc net TRONG khóa) + công nợ net-of-settlement + audit. §14 mật khẩu ở
// ADAPTER (lõi KHÔNG kiểm password — deleteTransactions/writeOffBadDebt bỏ tham số password).
import { describe, it, expect } from 'vitest';
import { txnTzRawStub } from './_fake-db.js';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  createTransaction, deleteTransactions, listTransactions,
  debtSummary, classifyDebt, writeOffBadDebt,
  type ServiceCtx
} from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}
const ctxOf = (fake: Record<string, unknown>, perms: string[]): ServiceCtx => ({ db: fake as unknown as Db, user: authUser(perms) });
const MANAGE = 'REVENUE_MANAGE';
const VIEW = 'REVENUE_VIEW';

function baseFake() {
  const audits: Record<string, unknown>[] = [];
  const fake: Record<string, unknown> = {
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'Transaction', version: 1 }) },
    codeCounter: { upsert: async ({ where }: { where: { prefix: string } }) => ({ prefix: where.prefix, lastValue: 7 }) }
  };
  return { fake, audits };
}

describe('transaction core — createTransaction', () => {
  it('thiếu quyền → FORBIDDEN nguyên văn', async () => {
    const { fake } = baseFake();
    const r = await createTransaction(ctxOf(fake, []), { tidId: 1, cardTypeId: 4, feeTypeId: 5, amount: 1000, txnDate: '2026-01-15' });
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('số tiền âm → VALIDATION', async () => {
    const { fake } = baseFake();
    const r = await createTransaction(ctxOf(fake, [MANAGE]), { tidId: 1, cardTypeId: 4, feeTypeId: 5, amount: -5, txnDate: '2026-01-15' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Số tiền không hợp lệ (số nguyên ≥ 0).');
  });

  it('ngày không có thật (2026-02-31) → VALIDATION (P1-05 chống JS cuộn)', async () => {
    const { fake } = baseFake();
    fake.tid = { findUnique: async () => ({ id: 1, deletedAt: null, partnerId: 2, bankId: 1, customerId: 7 }) };
    const r = await createTransaction(ctxOf(fake, [MANAGE]), { tidId: 1, cardTypeId: 4, feeTypeId: 5, amount: 1000, txnDate: '2026-02-31' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Ngày giao dịch không hợp lệ.');
  });

  it('TID chưa gán đối tác → NO_PARTNER', async () => {
    const { fake } = baseFake();
    fake.tid = { findUnique: async () => ({ id: 1, deletedAt: null, partnerId: null, bankId: 1, customerId: 7 }) };
    fake.feeType = { findUnique: async () => ({ id: 5, deletedAt: null }) };
    const r = await createTransaction(ctxOf(fake, [MANAGE]), { tidId: 1, cardTypeId: 4, feeTypeId: 5, amount: 1000, txnDate: '2026-01-15' });
    expect(r.error).toBe('NO_PARTNER');
  });

  it('khách hàng LOCKED → CUSTOMER_INACTIVE (chặn GD mới)', async () => {
    const { fake } = baseFake();
    fake.tid = { findUnique: async () => ({ id: 1, deletedAt: null, partnerId: 2, bankId: 1, customerId: 7 }) };
    fake.feeType = { findUnique: async () => ({ id: 5, deletedAt: null }) };
    fake.cardType = { findUnique: async () => ({ id: 4, deletedAt: null, bankId: 1 }) };
    fake.feeRate = { findMany: async () => [{ effectiveFrom: new Date('2025-01-01'), phiMua: 2000, phiCaiMay: 1000, deletedAt: null }] };
    // P5 — doanh số dùng giá bán THỰC TẾ: seed override để qua được cổng phí, tới được kiểm tra khách LOCKED.
    fake.tidSellFee = { findMany: async () => [{ effectiveFrom: new Date('2025-01-01'), phiBan: 3000, deletedAt: null }] };
    fake.feeSellQuote = { findMany: async () => [{ effectiveFrom: new Date('2025-01-01'), phiBan: 3000, deletedAt: null }] };
    fake.customer = { findUnique: async () => ({ id: 7, status: 'LOCKED', deletedAt: null }) };
    // Giá bán THỰC TẾ nay đọc bằng SQL thô ⇒ phải có stub, nếu không là "db.$queryRawUnsafe is not a function".
    Object.assign(fake, txnTzRawStub(() => [], { giaBanThucTe: () => (fake.tidSellFee as { findMany: (a: unknown) => Promise<never[]> }).findMany({ where: {} }) }));
    const r = await createTransaction(ctxOf(fake, [MANAGE]), { tidId: 1, cardTypeId: 4, feeTypeId: 5, amount: 1000, txnDate: '2026-01-15' });
    expect(r.error).toBe('CUSTOMER_INACTIVE');
  });

  it('hợp lệ → tx create + gán mã GD##### + audit NGHIÊM TRANSACTION_CREATED', async () => {
    const { fake, audits } = baseFake();
    const created: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];
    fake.tid = { findUnique: async () => ({ id: 1, deletedAt: null, partnerId: 2, bankId: 1, customerId: 7 }) };
    fake.feeType = { findUnique: async () => ({ id: 5, deletedAt: null }) };
    fake.cardType = { findUnique: async () => ({ id: 4, deletedAt: null, bankId: 1 }) };
    fake.feeRate = { findMany: async () => [{ effectiveFrom: new Date('2025-01-01'), phiMua: 2000, phiCaiMay: 1000, deletedAt: null }] };
    // P5 — doanh số dùng giá bán THỰC TẾ (override TID): seed override cùng % niêm yết → source QUOTE→OVERRIDE, số không đổi.
    fake.tidSellFee = { findMany: async () => [{ effectiveFrom: new Date('2025-01-01'), phiBan: 3000, deletedAt: null }] };
    fake.feeSellQuote = { findMany: async () => [{ effectiveFrom: new Date('2025-01-01'), phiBan: 3000, deletedAt: null }] };
    fake.customer = { findUnique: async () => ({ id: 7, status: 'ACTIVE', deletedAt: null }) };
    fake.transaction = {
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: 100, ...data }; created.push(row); return row; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { updated.push({ ...data }); return { id: where.id, ...data }; }
    };
    Object.assign(fake, txnTzRawStub(() => created as never, { giaBanThucTe: () => (fake.tidSellFee as { findMany: (a: unknown) => Promise<never[]> }).findMany({ where: {} }) })); // [GÓI TZ] stub raw txn_date (mock đúng shape)
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake });
    const r = await createTransaction(ctxOf(fake, [MANAGE]), { tidId: 1, cardTypeId: 4, feeTypeId: 5, amount: 1000, txnDate: '2026-01-15' });
    expect(r.ok).toBe(true);
    expect(r.id).toBe(100);
    expect(created[0]!.tidId).toBe(1);
    expect(updated[0]!.code).toBe('GD00100');
    expect(audits.some((a) => a['action'] === 'TRANSACTION_CREATED')).toBe(true);
  });

  // P5 (Admin Demo 20/8) — doanh số CHỈ dùng giá bán THỰC TẾ (override TID), KHÔNG mượn niêm yết.
  it('TID chỉ có phí bán NIÊM YẾT (không override) → NO_ACTUAL_SELL_FEE, KHÔNG tạo GD', async () => {
    const { fake } = baseFake();
    const created: Record<string, unknown>[] = [];
    fake.tid = { findUnique: async () => ({ id: 1, deletedAt: null, partnerId: 2, bankId: 1, customerId: 7 }) };
    fake.feeType = { findUnique: async () => ({ id: 5, deletedAt: null }) };
    fake.cardType = { findUnique: async () => ({ id: 4, deletedAt: null, bankId: 1 }) };
    fake.feeRate = { findMany: async () => [{ effectiveFrom: new Date('2025-01-01'), phiMua: 2000, phiCaiMay: 1000, deletedAt: null }] };
    fake.tidSellFee = { findMany: async () => [] }; // KHÔNG override → chỉ có niêm yết
    fake.feeSellQuote = { findMany: async () => [{ effectiveFrom: new Date('2025-01-01'), phiBan: 3000, deletedAt: null }] };
    fake.customer = { findUnique: async () => ({ id: 7, status: 'ACTIVE', deletedAt: null }) };
    fake.transaction = { create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: 100, ...data }; created.push(row); return row; }, update: async () => ({}) };
    Object.assign(fake, txnTzRawStub(() => created as never, { giaBanThucTe: () => (fake.tidSellFee as { findMany: (a: unknown) => Promise<never[]> }).findMany({ where: {} }) })); // [GÓI TZ] stub raw txn_date (mock đúng shape)
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake });
    const r = await createTransaction(ctxOf(fake, [MANAGE]), { tidId: 1, cardTypeId: 4, feeTypeId: 5, amount: 1000, txnDate: '2026-01-15' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('NO_ACTUAL_SELL_FEE');
    expect(r.message).toContain('chưa cấu hình giá bán thực tế');
    expect(created.length).toBe(0); // GD KHÔNG được tạo
  });

  it('TID có override giá bán THỰC TẾ hiệu lực → tạo GD, sellMargin dùng THỰC TẾ (không dùng niêm yết)', async () => {
    const { fake } = baseFake();
    const created: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];
    fake.tid = { findUnique: async () => ({ id: 1, deletedAt: null, partnerId: 2, bankId: 1, customerId: 7 }) };
    fake.feeType = { findUnique: async () => ({ id: 5, deletedAt: null }) };
    fake.cardType = { findUnique: async () => ({ id: 4, deletedAt: null, bankId: 1 }) };
    fake.feeRate = { findMany: async () => [{ effectiveFrom: new Date('2025-01-01'), phiMua: 2000, phiCaiMay: 1000, deletedAt: null }] };
    fake.tidSellFee = { findMany: async () => [{ effectiveFrom: new Date('2025-01-01'), phiBan: 4000, deletedAt: null }] }; // giá THỰC TẾ 4%
    fake.feeSellQuote = { findMany: async () => [{ effectiveFrom: new Date('2025-01-01'), phiBan: 3000, deletedAt: null }] }; // niêm yết 3% — KHÔNG dùng
    fake.customer = { findUnique: async () => ({ id: 7, status: 'ACTIVE', deletedAt: null }) };
    fake.transaction = {
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: 100, ...data }; created.push(row); return row; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { updated.push({ ...data }); return { id: where.id, ...data }; }
    };
    Object.assign(fake, txnTzRawStub(() => created as never, { giaBanThucTe: () => (fake.tidSellFee as { findMany: (a: unknown) => Promise<never[]> }).findMany({ where: {} }) })); // [GÓI TZ] stub raw txn_date (mock đúng shape)
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake });
    const r = await createTransaction(ctxOf(fake, [MANAGE]), { tidId: 1, cardTypeId: 4, feeTypeId: 5, amount: 1000, txnDate: '2026-01-15' });
    expect(r.ok).toBe(true);
    // sellMargin = phí bán THỰC TẾ (4000) − phí cài máy (1000) = 3000 (KHÔNG phải niêm yết 3000−1000=2000).
    expect(created[0]!.sellMarginMilli).toBe(3000);
    expect(created[0]!.partnerMarginMilli).toBe(1000); // phiMua 2000 − phiCaiMay 1000
  });
});

describe('transaction core — deleteTransactions (lõi KHÔNG kiểm password; adapter đã verify)', () => {
  it('xóa mềm → deletedAt + audit TRANSACTION_DELETED', async () => {
    const { fake, audits } = baseFake();
    const rows: Record<string, unknown>[] = [{ id: 1, code: 'GD00001', amount: 1000, revenueAmount: 30, deletedAt: null }];
    fake.transaction = {
      findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = rows.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; }
    };
    // [B-M5 21/9] deleteTransactions ĐẾM phiếu thu công nợ trước khi cho xoá (chặn phiếu mồ côi). Seed này KHÔNG
    // có phiếu nào ⇒ 0 là số ĐÚNG. Thiếu bảng ⇒ "Cannot read properties of undefined (reading 'count')".
    fake.cashDebtSettlement = { count: async () => 0 };
    const r = await deleteTransactions(ctxOf(fake, [MANAGE]), [1]);
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(1);
    expect(rows[0]!.deletedAt).toBeInstanceOf(Date);
    expect(audits.some((a) => a['action'] === 'TRANSACTION_DELETED')).toBe(true);
  });

  it('không chọn GD → VALIDATION', async () => {
    const { fake } = baseFake();
    const r = await deleteTransactions(ctxOf(fake, [MANAGE]), []);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Chưa chọn giao dịch để xóa.');
  });
});

describe('transaction core — công nợ net-of-settlement', () => {
  it('debtSummary trừ Σ settlement từng side (H4)', async () => {
    const { fake } = baseFake();
    fake.transaction = { findMany: async () => [{ id: 1, revenuePartner: 1000, revenueSell: 2000 }] };
    fake.cashDebtSettlement = { groupBy: async () => [{ transactionId: 1, side: 'PARTNER', _sum: { amount: 400 } }] };
    const r = await debtSummary(ctxOf(fake, ['DEBT_VIEW']));
    expect(r.ok).toBe(true);
    expect(r.data!.debtPartner).toBe(600); // 1000 − 400
    expect(r.data!.debtSell).toBe(2000);
    expect(r.data!.debtTotal).toBe(2600);
    expect(r.data!.count).toBe(1);
  });
});

describe('transaction core — classifyDebt', () => {
  it('GD còn nợ net → ghi DebtQualityLog + update debtQuality + audit', async () => {
    const { fake, audits } = baseFake();
    const logs: Record<string, unknown>[] = [];
    const upd: Record<string, unknown>[] = [];
    fake.transaction = {
      findUnique: async () => ({ id: 1, deletedAt: null, status: 'POSTED', revenuePartner: 1000, revenueSell: 2000, debtQuality: null, writtenOffAt: null }),
      update: async ({ data }: { data: Record<string, unknown> }) => { upd.push({ ...data }); return { ...data }; }
    };
    fake.cashDebtSettlement = { groupBy: async () => [] };
    fake.debtQualityLog = { create: async ({ data }: { data: Record<string, unknown> }) => { logs.push({ ...data }); return { ...data }; } };
    Object.assign(fake, txnTzRawStub(() => [], { giaBanThucTe: () => (fake.tidSellFee as { findMany: (a: unknown) => Promise<never[]> }).findMany({ where: {} }) })); // [GÓI TZ] stub raw txn_date (mock đúng shape)
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake });
    const r = await classifyDebt(ctxOf(fake, ['DEBT_CLASSIFY']), 1, 'bad', 'khách bỏ trốn');
    expect(r.ok).toBe(true);
    expect(logs[0]!.toQuality).toBe('BAD');
    expect(upd[0]!.debtQuality).toBe('BAD');
    expect(audits.some((a) => a['action'] === 'DEBT_CLASSIFIED')).toBe(true);
  });

  it('GD đã thu đủ (net=0) → DEBT_FULLY_PAID', async () => {
    const { fake } = baseFake();
    fake.transaction = { findUnique: async () => ({ id: 1, deletedAt: null, status: 'POSTED', revenuePartner: 1000, revenueSell: 0, debtQuality: null, writtenOffAt: null }) };
    fake.cashDebtSettlement = { groupBy: async () => [{ transactionId: 1, side: 'PARTNER', _sum: { amount: 1000 } }] };
    const r = await classifyDebt(ctxOf(fake, ['DEBT_CLASSIFY']), 1, 'BAD');
    expect(r.error).toBe('DEBT_FULLY_PAID');
  });
});

describe('transaction core — writeOffBadDebt (TOCTOU FOR UPDATE, net trong khóa)', () => {
  function fakeWriteOff(over: Record<string, unknown> = {}, settle: number = 0) {
    const { fake, audits } = baseFake();
    const cashEntries: Record<string, unknown>[] = [];
    const movedUpd: Record<string, unknown>[] = [];
    const txnRow = { id: 1, deletedAt: null, status: 'POSTED', revenuePartner: 1000, revenueSell: 2000, debtQuality: 'BAD', writtenOffAt: null, ...over };
    fake.transaction = {
      findUnique: async () => ({ ...txnRow }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { movedUpd.push({ ...data }); return { count: 1 }; }
    };
    fake.cashCategory = { findFirst: async () => ({ id: 9 }) };
    fake.cashDebtSettlement = { groupBy: async () => (settle > 0 ? [{ side: 'PARTNER', _sum: { amount: settle } }] : []) };
    fake.cashEntry = { create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: 50, ...data }; cashEntries.push(row); return row; } };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRawUnsafe: async () => [] });
    return { fake, audits, cashEntries, movedUpd };
  }

  it('BAD + còn nợ net → CashEntry CHI nợ xấu + writtenOffAt + audit NGHIÊM', async () => {
    const { fake, audits, cashEntries, movedUpd } = fakeWriteOff();
    const r = await writeOffBadDebt(ctxOf(fake, ['DEBT_WRITEOFF']), 1);
    expect(r.ok).toBe(true);
    expect(cashEntries[0]!.kind).toBe('CHI');
    expect(cashEntries[0]!.amount).toBe(3000); // net = 1000 + 2000
    expect(cashEntries[0]!.fundId).toBe(null); // bút toán phi tiền mặt
    expect(movedUpd[0]!.writtenOffAt).toBeInstanceOf(Date);
    expect(audits.some((a) => a['action'] === 'DEBT_WRITTEN_OFF')).toBe(true);
  });

  it('GD không phải BAD → NOT_BAD_DEBT (pre-check)', async () => {
    const { fake } = fakeWriteOff({ debtQuality: 'HARD' });
    const r = await writeOffBadDebt(ctxOf(fake, ['DEBT_WRITEOFF']), 1);
    expect(r.error).toBe('NOT_BAD_DEBT');
  });

  it('đã ghi giảm rồi → ALREADY_WRITTEN_OFF (pre-check idempotent)', async () => {
    const { fake } = fakeWriteOff({ writtenOffAt: new Date('2026-01-01') });
    const r = await writeOffBadDebt(ctxOf(fake, ['DEBT_WRITEOFF']), 1);
    expect(r.error).toBe('ALREADY_WRITTEN_OFF');
  });
});

describe('transaction core — listTransactions', () => {
  it('thiếu quyền → FORBIDDEN', async () => {
    const { fake } = baseFake();
    const r = await listTransactions(ctxOf(fake, []));
    expect(r.error).toBe('FORBIDDEN');
  });

  it('có quyền → list rỗng + summary 0', async () => {
    const { fake } = baseFake();
    fake.transaction = { count: async () => 0, aggregate: async () => ({ _sum: {}, _count: 0 }), findMany: async () => [] };
    // list resolve nhãn: dù rỗng vẫn gọi các findMany join → stub trả [] (không N+1 khi 0 dòng, nhưng vẫn gọi 1 lần).
    for (const m of ['tid', 'bank', 'partner', 'customer', 'cardType', 'feeType', 'user']) fake[m] = { findMany: async () => [] };
    const r = await listTransactions(ctxOf(fake, [VIEW]));
    expect(r.ok).toBe(true);
    expect(r.total).toBe(0);
    expect(r.summary!.totalRevenue).toBe(0);
  });
});
