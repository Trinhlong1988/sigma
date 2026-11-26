// REGRESSION — Money-F4 (cảnh báo GD uỷ-NĐT còn phiCaiMayMilli=0 mà FeeRate hiệu lực>0 ⇒ cần backfill). CHỈ ĐỌC.
// KHÔNG đổi công thức tiền về; chỉ đếm ĐỘNG (R198). Db GIẢ in-memory + pickEffectiveRate THẬT (business-rules).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { countZeroPhiCaiMayInvestorTxns, type ServiceCtx } from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 9, username: 'staff', fullName: 'Staff', status: 'ACTIVE', forceChangePassword: false, roles: ['ADMIN'], permissions };
}
const REVENUE = 'REVENUE_VIEW';

function makeDb(opts: {
  rcv: { id: number }[];
  tids: { id: number; partnerId: number | null; receiveAccountId: number }[];
  txns: { tidId: number; cardTypeId: number | null; txnDate: Date }[]; // đã lọc phiCaiMayMilli=0 ở fake
  rates: { partnerId: number; cardTypeId: number; phiCaiMay: number; effectiveFrom: Date }[];
}) {
  const db = {
    receiveAccount: { findMany: async () => opts.rcv.map((r) => ({ id: r.id })) },
    tid: { findMany: async ({ where }: { where: any }) => opts.tids.filter((t) => where.receiveAccountId.in.includes(t.receiveAccountId)).map((t) => ({ id: t.id, partnerId: t.partnerId })) },
    transaction: { findMany: async ({ where }: { where: any }) => opts.txns.filter((t) => where.tidId.in.includes(t.tidId)).map((t, i) => ({ id: i + 1, tidId: t.tidId, cardTypeId: t.cardTypeId, txnDate: t.txnDate })) },
    // [GÓI TZ 11/9] pickEffectiveRate nay nhận instant thật qua txnIsoMap — fake không bệnh adapter → toISOString.
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (String(sql).includes('to_char(txn_date')) {
        const ids = (params[0] as number[]) ?? [];
        return opts.txns.map((t, i) => ({ id: i + 1, iso: t.txnDate.toISOString() })).filter((r) => ids.includes(r.id));
      }
      return [];
    },
    feeRate: { findMany: async ({ where }: { where: any }) => opts.rates.filter((r) => where.partnerId.in.includes(r.partnerId)).map((r) => ({ ...r })) }
  };
  return db as unknown as Db;
}
const ctxOf = (db: Db, perms: string[]): ServiceCtx => ({ db, user: authUser(perms) });

describe('Money-F4 — countZeroPhiCaiMayInvestorTxns', () => {
  it('thiếu REVENUE_VIEW → FORBIDDEN', async () => {
    const db = makeDb({ rcv: [], tids: [], txns: [], rates: [] });
    const r = await countZeroPhiCaiMayInvestorTxns(ctxOf(db, []), {});
    expect(r.error).toBe('FORBIDDEN');
  });

  it('đếm needsBackfill = GD phí=0 nhưng FeeRate hiệu lực>0; loại GD FeeRate=0; loại GD không có rate', async () => {
    const eff = new Date('2026-01-01');
    const db = makeDb({
      rcv: [{ id: 50 }],
      tids: [
        { id: 1, partnerId: 10, receiveAccountId: 50 }, // partner 10 có phí>0
        { id: 2, partnerId: 20, receiveAccountId: 50 }  // partner 20 có phí=0 (phí thật 0)
      ],
      txns: [
        { tidId: 1, cardTypeId: 100, txnDate: new Date('2026-08-11T03:00:00') }, // → needsBackfill
        { tidId: 1, cardTypeId: 100, txnDate: new Date('2026-08-12T03:00:00') }, // → needsBackfill
        { tidId: 2, cardTypeId: 100, txnDate: new Date('2026-08-11T03:00:00') }, // FeeRate=0 → KHÔNG backfill
        { tidId: 1, cardTypeId: 999, txnDate: new Date('2026-08-11T03:00:00') }  // không có rate → noRate
      ],
      rates: [
        { partnerId: 10, cardTypeId: 100, phiCaiMay: 1060, effectiveFrom: eff },
        { partnerId: 20, cardTypeId: 100, phiCaiMay: 0, effectiveFrom: eff }
      ]
    });
    const r = await countZeroPhiCaiMayInvestorTxns(ctxOf(db, [REVENUE]), {});
    expect(r.ok).toBe(true);
    expect(r.zeroFeeCount).toBe(4);
    expect(r.needsBackfill).toBe(2);
    expect(r.noRateCount).toBe(1);
  });

  it('không có TK uỷ NĐT → count 0', async () => {
    const db = makeDb({ rcv: [], tids: [], txns: [], rates: [] });
    const r = await countZeroPhiCaiMayInvestorTxns(ctxOf(db, [REVENUE]), {});
    expect(r.ok).toBe(true);
    expect(r.zeroFeeCount).toBe(0);
    expect(r.needsBackfill).toBe(0);
  });

  it('ngày "từ" sai định dạng → VALIDATION (không nuốt lỗi)', async () => {
    const db = makeDb({ rcv: [{ id: 1 }], tids: [], txns: [], rates: [] });
    const r = await countZeroPhiCaiMayInvestorTxns(ctxOf(db, [REVENUE]), { from: '11/08/2026' });
    expect(r.error).toBe('VALIDATION');
  });
});
