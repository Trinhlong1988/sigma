// REGRESSION L1 (đối kháng 12/8) — WIRE detector "phí cài máy NĐT chưa backfill" (scanZeroPhiCaiMayCore) VÀO
// health-scan collectFindings. Trước đây detector tồn tại nhưng KHÔNG được gọi ở collectFindings (chỉ có `db`,
// không có ctx.user) → bug "tiền về NĐT tính thừa" không bao giờ nổi trong Quét sức khỏe. Test khẳng định:
//   (a) core db-only chạy đúng (không cần permission);
//   (b) collectFindings ĐẨY finding INVESTOR_PHICAIMAY_UNBACKFILLED khi needsBackfill>0, và KHÔNG khi =0;
//   (c) không có CHECK_FAILED (mọi check chạy được trên mock — R198 đếm động).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import { collectFindings } from '../src/health.js';
import { scanZeroPhiCaiMayCore } from '../src/investor-report.js';

const EFF = new Date('2026-01-01');
// Kịch bản: TID#1 (partner 10, phí>0) có 2 GD phí=0 → needsBackfill=2; TID#2 (partner 20, phí=0) 1 GD → không backfill.
const SCENARIO = {
  rcv: [{ id: 50 }],
  tids: [ { id: 1, partnerId: 10 }, { id: 2, partnerId: 20 } ],
  txns: [
    { tidId: 1, cardTypeId: 100, txnDate: new Date('2026-08-11T03:00:00') },
    { tidId: 1, cardTypeId: 100, txnDate: new Date('2026-08-12T03:00:00') },
    { tidId: 2, cardTypeId: 100, txnDate: new Date('2026-08-11T03:00:00') }
  ],
  rates: [
    { partnerId: 10, cardTypeId: 100, phiCaiMay: 1060, effectiveFrom: EFF },
    { partnerId: 20, cardTypeId: 100, phiCaiMay: 0, effectiveFrom: EFF }
  ]
};

// Db GIẢ: mọi model rỗng (findMany→[], count→0, findUnique→null) TRỪ nhánh phục vụ scanZeroPhiCaiMayCore. Nhờ
// vậy các check khác của collectFindings đều chạy nhưng KHÔNG phát hiện gì → cô lập finding cần kiểm.
function makeDb(sc: typeof SCENARIO | null): Db {
  const empty = { findMany: async () => [], count: async () => 0, findUnique: async () => null };
  const db: any = new Proxy({}, { get: (t: any, p: string) => (p in t ? t[p] : empty) });
  // [17/9] Db giả PHẢI có $queryRawUnsafe cho MỌI kịch bản: check "lô ↔ giao dịch lệch tiền" (health #12) gọi raw
  // SQL — thiếu hàm là check ném → CHECK_FAILED (đúng R198, không nuốt lỗi) và test cô-lập-finding đỏ oan.
  db.$queryRawUnsafe = async () => [];
  if (!sc) return db as Db;
  db.receiveAccount = { findMany: async ({ where }: any) => (where?.investorId ? sc.rcv.map((r) => ({ id: r.id })) : []), count: async () => 0 };
  db.tid = { findMany: async ({ where }: any) => (where?.receiveAccountId ? sc.tids.map((t) => ({ id: t.id, partnerId: t.partnerId })) : []), count: async () => 0 };
  db.transaction = { findMany: async ({ where }: any) => (where?.phiCaiMayMilli === 0 ? sc.txns.map((t, i) => ({ id: i + 1, tidId: t.tidId, cardTypeId: t.cardTypeId, txnDate: t.txnDate })) : []), count: async () => 0 };
  // [GÓI TZ 11/9] scanZeroPhiCaiMayCore nay tra instant thật qua txnIsoMap — fake không bệnh adapter → iso = toISOString.
  db.$queryRawUnsafe = async (sql: string, ...params: unknown[]) => {
    if (String(sql).includes('to_char(txn_date')) {
      const ids = (params[0] as number[]) ?? [];
      return sc.txns.map((t, i) => ({ id: i + 1, iso: (t.txnDate as Date).toISOString() })).filter((r) => ids.includes(r.id));
    }
    return [];
  };
  db.feeRate = { findMany: async ({ where }: any) => (where?.partnerId?.in ? sc.rates.filter((r) => where.partnerId.in.includes(r.partnerId)).map((r) => ({ ...r })) : []), count: async () => 0 };
  return db as Db;
}

describe('L1 — scanZeroPhiCaiMayCore (db-only)', () => {
  it('đếm needsBackfill đúng, không cần permission', async () => {
    const r = await scanZeroPhiCaiMayCore(makeDb(SCENARIO));
    expect(r.zeroFeeCount).toBe(3);
    expect(r.needsBackfill).toBe(2);
    expect(r.noRateCount).toBe(0);
  });
  it('không có TK uỷ NĐT → 0', async () => {
    const r = await scanZeroPhiCaiMayCore(makeDb(null));
    expect(r.needsBackfill).toBe(0);
  });
});

describe('L1 — collectFindings WIRE detector phí cài máy NĐT', () => {
  it('needsBackfill>0 → đẩy finding INVESTOR_PHICAIMAY_UNBACKFILLED + KHÔNG có CHECK_FAILED', async () => {
    const { findings } = await collectFindings(makeDb(SCENARIO));
    const hit = findings.find((x) => x.code === 'INVESTOR_PHICAIMAY_UNBACKFILLED');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('WARN');
    expect(hit!.count).toBe(2);
    expect(findings.some((x) => x.code === 'CHECK_FAILED')).toBe(false);
  });
  it('needsBackfill=0 → KHÔNG đẩy finding đó', async () => {
    const { findings } = await collectFindings(makeDb(null));
    expect(findings.some((x) => x.code === 'INVESTOR_PHICAIMAY_UNBACKFILLED')).toBe(false);
    expect(findings.some((x) => x.code === 'CHECK_FAILED')).toBe(false);
  });
});
