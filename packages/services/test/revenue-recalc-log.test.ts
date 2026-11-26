// P1 (nền — LỊCH SỬ DOANH SỐ) — RevenueRecalcLog: SHAPE (before→after margin + revenue) + cột tiền BigInt.
// PHA 1 CHƯA có engine ghi log (đó là PHA 2); test này chốt HỢP ĐỒNG dữ liệu: mock ĐÚNG shape với cột tiền
// literal `n` (KHÔNG number) + xác nhận BigInt.toJSON shim serialize được. Nối feedback_bigint_shim_mock_shape.
import { describe, it, expect } from 'vitest';
import '../src/bigint-json.js'; // nạp shim (side-effect) — dạy JSON.stringify serialize BigInt cột tiền int8

interface RevenueRecalcLogRow {
  id: number;
  transactionId: number;
  feeEffectiveFrom: Date;
  beforePartnerMargin: number;
  beforeSellMargin: number;
  beforeRevenueAmount: bigint;
  afterPartnerMargin: number;
  afterSellMargin: number;
  afterRevenueAmount: bigint;
  reason: string | null;
  actorUserId: number | null;
  createdAt: Date;
}

function fakeLogTable() {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    revenueRecalcLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: rows.length + 1, createdAt: new Date(), reason: null, actorUserId: null, ...data };
        rows.push(row);
        return { ...row };
      }
    }
  };
}

describe('RevenueRecalcLog (P1 nền — lịch sử doanh số) — shape + BigInt', () => {
  it('create nhận đúng shape before→after; cột tiền là BigInt literal (1000n), KHÔNG number', async () => {
    const { rows, revenueRecalcLog } = fakeLogTable();
    const created = (await revenueRecalcLog.create({
      data: {
        transactionId: 42,
        feeEffectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        beforePartnerMargin: 1000, // CL_NCC ×1000
        beforeSellMargin: 1500, // CL_KH ×1000
        beforeRevenueAmount: 250000n, // int8 — literal n (mock shape đúng, không number)
        afterPartnerMargin: 1000,
        afterSellMargin: 2000,
        afterRevenueAmount: 300000n,
        reason: 'TID_SELL_FEE_SET',
        actorUserId: 7
      }
    })) as unknown as RevenueRecalcLogRow;
    expect(typeof created.beforeRevenueAmount).toBe('bigint');
    expect(created.beforeRevenueAmount).toBe(250000n);
    expect(created.afterRevenueAmount).toBe(300000n);
    expect(created.beforePartnerMargin).toBe(1000);
    expect(created.afterSellMargin).toBe(2000);
    expect(rows.length).toBe(1);
  });

  it('BigInt.toJSON shim: JSON.stringify hàng có cột tiền KHÔNG throw + ra SỐ đúng (VND < 2^53)', () => {
    const row = { beforeRevenueAmount: 250000n, afterRevenueAmount: 5_000_000_000_000n };
    const json = JSON.parse(JSON.stringify(row));
    expect(json.beforeRevenueAmount).toBe(250000);
    expect(json.afterRevenueAmount).toBe(5_000_000_000_000);
  });
});
