// P1 (nền — LỊCH SỬ DOANH SỐ) — RevenueRecalcLog trên DB THẬT (throwaway Postgres, migration
// 20260805140000_fee_effective_periods đã migrate deploy ở global-setup). Xác nhận: (1) bảng
// revenue_recalc_logs TỒN TẠI với cột int8 (before/after_revenue_amount) → round-trip đúng `bigint`; (2)
// generated client có delegate revenueRecalcLog (prisma generate sau đổi schema). KHÔNG có engine ghi ở PHA 1.
import { describe, it, expect } from 'vitest';
import { getBotDb } from '../src/db.js';

describe('RevenueRecalcLog (P1 nền) — bảng thật + BigInt round-trip', () => {
  it('create + đọc lại: cột tiền là bigint, giá trị khớp; margin int; shape đầy đủ', async () => {
    const db = getBotDb();
    const created = await db.revenueRecalcLog.create({
      data: {
        transactionId: 987654, // scalar (no FK) — không cần GD thật
        feeEffectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        beforePartnerMargin: 1000,
        beforeSellMargin: 1500,
        beforeRevenueAmount: 250_000n,
        afterPartnerMargin: 1000,
        afterSellMargin: 2000,
        afterRevenueAmount: 300_000n,
        reason: 'FEE_RATE_SET',
        actorUserId: 7
      }
    });
    expect(typeof created.beforeRevenueAmount).toBe('bigint');
    expect(created.beforeRevenueAmount).toBe(250_000n);
    expect(created.afterRevenueAmount).toBe(300_000n);
    expect(created.beforePartnerMargin).toBe(1000);

    const read = await db.revenueRecalcLog.findUniqueOrThrow({ where: { id: created.id } });
    expect(read.transactionId).toBe(987654);
    expect(read.afterRevenueAmount).toBe(300_000n);
    expect(read.afterSellMargin).toBe(2000);
    expect(read.reason).toBe('FEE_RATE_SET');
    expect(read.actorUserId).toBe(7);
    // cột lớn > 2^31 vẫn đúng (int8 không tràn)
    const big = await db.revenueRecalcLog.create({
      data: {
        transactionId: 1, feeEffectiveFrom: new Date(),
        beforePartnerMargin: 0, beforeSellMargin: 0, beforeRevenueAmount: 0n,
        afterPartnerMargin: 0, afterSellMargin: 0, afterRevenueAmount: 5_000_000_000_000n
      }
    });
    expect(big.afterRevenueAmount).toBe(5_000_000_000_000n);
  });
});
