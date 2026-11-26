// Test backfillTxnPhiCaiMay (@sigma/services, Admin Demo 11/8) — vá phí cài máy cho GD CŨ (phi_cai_may_milli=0). Kiểm:
//  • Chọn ĐÚNG kỳ FeeRate hiệu lực tại txnDate (pickEffectiveRate) — GD trước/sau mốc đổi giá lấy phí khác nhau;
//  • CHỐNG N+1: feeRate.findMany gọi ĐÚNG 1 lần cho toàn bộ (gom theo partnerId), tid.findMany 1 lần;
//  • updateMany theo lô (gom theo giá trị phí), không update từng dòng;
//  • Bỏ qua: phí hiệu lực = 0 (giữ 0), TID thiếu partnerId, không có FeeRate hiệu lực; đếm skip đúng;
//  • KHÔNG đụng GD non-POSTED / đã xóa / đã có phí > 0.
// BigInt không cần ở đây (backfill chỉ đọc id/tidId/cardTypeId/txnDate + ghi int phiCaiMayMilli).
import { describe, it, expect } from 'vitest';
import { txnTzRawStub } from './_fake-db.js';
import type { Db } from '@sigma/database';
import { backfillTxnPhiCaiMay } from '../src/index.js';

type Rec = Record<string, unknown>;
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

// Fake Db tối thiểu + đếm số lần gọi findMany (chống N+1). updateMany ghi vào seed thật để verify.
function makeDb(seed: { txns: Rec[]; tids: Rec[]; rates: Rec[] }) {
  const calls = { txnFind: 0, tidFind: 0, rateFind: 0, txnUpdateMany: 0 };
  const inList = (cond: unknown, v: unknown): boolean =>
    cond !== null && typeof cond === 'object' && 'in' in (cond as object)
      ? (cond as { in: unknown[] }).in.includes(v)
      : cond === v;
  const db = {
    // Bộ kiểm backfill không seed giá bán thực tế ⇒ khai TRỐNG tường minh (cố ý), không để stub đoán.
    ...txnTzRawStub(() => seed.txns as never, { giaBanThucTe: () => [] }),
    transaction: {
      findMany: async ({ where }: { where: Rec }) => {
        calls.txnFind++;
        return seed.txns.filter((t) =>
          t['phiCaiMayMilli'] === where['phiCaiMayMilli'] &&
          t['status'] === where['status'] &&
          t['deletedAt'] === where['deletedAt']
        ).map((t) => ({ ...t }));
      },
      updateMany: async ({ where, data }: { where: { id: { in: number[] } }; data: Rec }) => {
        calls.txnUpdateMany++;
        let count = 0;
        for (const t of seed.txns) {
          if (where.id.in.includes(t['id'] as number)) { t['phiCaiMayMilli'] = data['phiCaiMayMilli']; count++; }
        }
        return { count };
      }
    },
    tid: {
      findMany: async ({ where }: { where: Rec }) => {
        calls.tidFind++;
        return seed.tids.filter((t) => inList(where['id'], t['id'])).map((t) => ({ ...t }));
      }
    },
    feeRate: {
      findMany: async ({ where }: { where: Rec }) => {
        calls.rateFind++;
        return seed.rates.filter((r) => inList(where['partnerId'], r['partnerId']) && r['deletedAt'] === where['deletedAt']).map((r) => ({ ...r }));
      }
    }
  };
  return { db: db as unknown as Db, calls, seed };
}

describe('backfillTxnPhiCaiMay — vá phí cài máy GD cũ (per-txn, chọn kỳ theo txnDate)', () => {
  it('vá đúng phí theo KỲ hiệu lực + chống N+1 + updateMany theo lô', async () => {
    // Partner 1, Loại thẻ 11: 2 kỳ giá — từ 1/7 phí cài máy 1000; từ 1/8 phí cài máy 2000.
    const rates: Rec[] = [
      { partnerId: 1, cardTypeId: 11, phiCaiMay: 1000, effectiveFrom: d(2026, 7, 1), deletedAt: null },
      { partnerId: 1, cardTypeId: 11, phiCaiMay: 2000, effectiveFrom: d(2026, 8, 1), deletedAt: null }
    ];
    const tids: Rec[] = [
      { id: 101, partnerId: 1 },
      { id: 102, partnerId: 1 },
      { id: 103, partnerId: null } // thiếu partner → không tra được
    ];
    const txns: Rec[] = [
      // GD tháng 7 → kỳ 1000; GD tháng 8 → kỳ 2000 (cùng partner/card → chứng minh chọn kỳ theo txnDate).
      { id: 1, tidId: 101, cardTypeId: 11, txnDate: d(2026, 7, 15), phiCaiMayMilli: 0, status: 'POSTED', deletedAt: null },
      { id: 2, tidId: 102, cardTypeId: 11, txnDate: d(2026, 8, 10), phiCaiMayMilli: 0, status: 'POSTED', deletedAt: null },
      { id: 3, tidId: 101, cardTypeId: 11, txnDate: d(2026, 8, 20), phiCaiMayMilli: 0, status: 'POSTED', deletedAt: null },
      { id: 4, tidId: 103, cardTypeId: 11, txnDate: d(2026, 8, 20), phiCaiMayMilli: 0, status: 'POSTED', deletedAt: null }, // TID thiếu partner
      { id: 5, tidId: 101, cardTypeId: 11, txnDate: d(2026, 6, 1), phiCaiMayMilli: 0, status: 'POSTED', deletedAt: null }, // trước mọi kỳ → không có rate
      { id: 6, tidId: 101, cardTypeId: 11, txnDate: d(2026, 8, 20), phiCaiMayMilli: 500, status: 'POSTED', deletedAt: null }, // ĐÃ có phí → không quét
      { id: 7, tidId: 101, cardTypeId: 11, txnDate: d(2026, 8, 20), phiCaiMayMilli: 0, status: 'CANCELLED', deletedAt: null }, // non-POSTED → không quét
      { id: 8, tidId: 101, cardTypeId: 11, txnDate: d(2026, 8, 20), phiCaiMayMilli: 0, status: 'POSTED', deletedAt: d(2026, 8, 21) } // đã xóa → không quét
    ];
    const { db, calls, seed } = makeDb({ txns, tids, rates });

    const res = await backfillTxnPhiCaiMay(db);

    // Quét 5 GD (id 1-5: POSTED, chưa xóa, phí=0). GD 6/7/8 bị loại bởi where.
    expect(res.scanned).toBe(5);
    expect(res.updated).toBe(3); // id 1 (1000), 2 (2000), 3 (2000)
    expect(res.skippedNoPartner).toBe(1); // id 4
    expect(res.skippedNoRate).toBe(1); // id 5 (trước mọi kỳ)
    expect(res.skippedZeroRate).toBe(0);

    // Giá trị vá đúng theo KỲ.
    const byId = new Map(seed.txns.map((t) => [t['id'], t['phiCaiMayMilli']]));
    expect(byId.get(1)).toBe(1000); // tháng 7
    expect(byId.get(2)).toBe(2000); // tháng 8
    expect(byId.get(3)).toBe(2000); // tháng 8
    expect(byId.get(6)).toBe(500); // KHÔNG đụng
    expect(byId.get(7)).toBe(0); // non-POSTED không đụng
    expect(byId.get(8)).toBe(0); // đã xóa không đụng

    // CHỐNG N+1: mỗi loại query GOM đúng 1 lần (không lặp theo GD).
    expect(calls.txnFind).toBe(1);
    expect(calls.tidFind).toBe(1);
    expect(calls.rateFind).toBe(1);
    // updateMany GOM theo giá trị phí: {1000:[1]}, {2000:[2,3]} → 2 lệnh ghi (không phải 3).
    expect(calls.txnUpdateMany).toBe(2);
  });

  it('phí hiệu lực = 0 → giữ 0, đếm skippedZeroRate, KHÔNG ghi', async () => {
    const rates: Rec[] = [{ partnerId: 1, cardTypeId: 11, phiCaiMay: 0, effectiveFrom: d(2026, 7, 1), deletedAt: null }];
    const tids: Rec[] = [{ id: 101, partnerId: 1 }];
    const txns: Rec[] = [{ id: 1, tidId: 101, cardTypeId: 11, txnDate: d(2026, 8, 1), phiCaiMayMilli: 0, status: 'POSTED', deletedAt: null }];
    const { db, calls } = makeDb({ txns, tids, rates });
    const res = await backfillTxnPhiCaiMay(db);
    expect(res.scanned).toBe(1);
    expect(res.updated).toBe(0);
    expect(res.skippedZeroRate).toBe(1);
    expect(calls.txnUpdateMany).toBe(0); // không ghi khi phí đúng = 0
  });

  it('không có GD nào cần vá → trả rỗng, không query TID/FeeRate', async () => {
    const { db, calls } = makeDb({ txns: [], tids: [], rates: [] });
    const res = await backfillTxnPhiCaiMay(db);
    expect(res).toEqual({ scanned: 0, updated: 0, skippedZeroRate: 0, skippedNoPartner: 0, skippedNoRate: 0 });
    expect(calls.tidFind).toBe(0);
    expect(calls.rateFind).toBe(0);
  });
});
