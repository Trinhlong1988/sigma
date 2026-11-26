// PHA 2 — 17 CASE "KIỂM CHỨNG CHỐNG LỖI" cho engine RECALC doanh số theo kỳ (quyết định 1A/3a) + wiring.
// Bơm Db giả in-memory ĐÚNG SHAPE Prisma (cột tiền int8 = bigint literal, R48/#1) rồi gọi thẳng lõi ctx-based.
// Nối feedback_bigint_shim_mock_shape (mock 1000n không 1000) + feedback_period_bound_timezone_consistency (bound
// nửa-mở [gte,lt) + mốc 0h00 local) + R198 (không nuốt lỗi — GD tra phí fail phải surface).
import { describe, it, expect } from 'vitest';
import { txnTzRawStub, type LoRowFake } from './_fake-db.js';
import '../src/bigint-json.js'; // shim BigInt.toJSON — cột tiền int8 serialize được
import { computeRevenue } from '@sigma/business-rules';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { recalcRevenueForFeeChange, type RecalcClient, updateTransaction, setTidSellFees, type ServiceCtx } from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 7, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

// ── Nửa đêm LOCAL của 1 ngày (đối xứng startOfDayLocal service) ──
function day(y: number, m: number, d: number): Date { return new Date(y, m - 1, d); }

// ── FAKE STORE — bảng in-memory tối thiểu cho engine + resolveFeeForTxn ──
interface TxnRow {
  id: number; tidId: number; cardTypeId: number | null; feeTypeId: number | null;
  amount: bigint; txnDate: Date; status: string; deletedAt: Date | null; writtenOffAt: Date | null;
  partnerMarginMilli: number; sellMarginMilli: number;
  phiCaiMayMilli?: number; // MONEY-1 — snapshot phí cài máy (×1000) hiệu lực tại ngày GD; recalc phải đồng bộ
  revenuePartner: bigint | number; revenueSell: bigint | number; revenueAmount: bigint | number;
  code: string | null;
  settled?: boolean; settledAt?: Date | null; // đối chiếu settlement sau recalc (Admin Demo 11/8)
}
interface SettlementRow { transactionId: number; side: string; amount: bigint; }
interface FeeRateRow { id: number; partnerId: number; cardTypeId: number; phiMua: number; phiCaiMay: number; effectiveFrom: Date; deletedAt: Date | null; }
interface QuoteRow { id: number; partnerId: number; cardTypeId: number; feeTypeId: number; phiBan: number; effectiveFrom: Date; deletedAt: Date | null; }
interface OverrideRow { id: number; tidId: number; cardTypeId: number; feeTypeId: number; phiBan: number; effectiveFrom: Date; deletedAt: Date | null; }

function makeStore(seed: {
  tids: { id: number; partnerId: number | null; bankId: number | null }[];
  cards?: { id: number; bankId: number | null; deletedAt?: Date | null }[];
  rates?: FeeRateRow[];
  quotes?: QuoteRow[];
  overrides?: OverrideRow[];
  txns: TxnRow[];
  settlements?: SettlementRow[];
  lo?: LoRowFake[]; // [B223] lô gắn với GD — để kiểm engine có chỉnh tiền lô theo giá mới không
}) {
  const cards = seed.cards ?? [{ id: 11, bankId: 5, deletedAt: null }];
  const rates = seed.rates ?? [];
  const quotes = seed.quotes ?? [];
  // P5 (Admin Demo 20/8) — doanh số CHỈ dùng phí bán THỰC TẾ (override TID); resolveFeeForTxn CHẶN nếu chỉ có niêm yết
  // (NO_ACTUAL_SELL_FEE). Các CASE dưới kiểm TOÁN KỲ (không phải cổng sell-source), nên khi KHÔNG khai `overrides`
  // ta MẶC ĐỊNH mirror mọi kỳ niêm yết → override THỰC TẾ (CÙNG số, CÙNG mốc) cho mọi TID: source QUOTE→OVERRIDE,
  // MỌI con số giữ nguyên. CASE muốn kiểm "chỉ niêm yết" (grandfather → failed[]) truyền `overrides: []` để TẮT mirror.
  const overrides: OverrideRow[] = seed.overrides ?? seed.tids.flatMap((t) =>
    quotes.map((q, i) => ({ id: t.id * 1000 + i + 1, tidId: t.id, cardTypeId: q.cardTypeId, feeTypeId: q.feeTypeId, phiBan: q.phiBan, effectiveFrom: q.effectiveFrom, deletedAt: null })));
  const txns = seed.txns;
  const settlements = seed.settlements ?? [];
  const recalcLogs: Record<string, unknown>[] = [];
  const lo: LoRowFake[] = seed.lo ?? [];

  // matcher scalar/{in}/null — BỎ QUA txnDate (engine tự lọc [gte,lt) — đó chính là logic ranh giới cần test).
  const matchScalar = (rowVal: unknown, cond: unknown): boolean => {
    if (cond === null) return rowVal == null;
    if (cond !== null && typeof cond === 'object' && 'in' in (cond as object)) return (cond as { in: unknown[] }).in.includes(rowVal);
    return rowVal === cond;
  };

  const db = {
    // Giá bán THỰC TẾ nay engine đọc bằng SQL thô ⇒ phải cấp qua stub (mock `tidSellFee.findMany` thành đồ chết).
    ...txnTzRawStub(() => txns as never, { giaBanThucTe: () => overrides as never, lo: () => lo }),
    tid: {
      findMany: async ({ where, select: _s }: { where: Record<string, unknown>; select?: unknown }) => {
        let list = seed.tids.slice();
        if (where['partnerId'] !== undefined) list = list.filter((t) => t.partnerId === where['partnerId']);
        if (where['id'] !== undefined) { const ids = (where['id'] as { in: number[] }).in; list = list.filter((t) => ids.includes(t.id)); }
        return list.map((t) => ({ id: t.id, partnerId: t.partnerId, bankId: t.bankId }));
      }
    },
    cardType: { findUnique: async ({ where }: { where: { id: number } }) => cards.find((c) => c.id === where.id) ?? null },
    feeRate: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        rates.filter((r) => (where['partnerId'] === undefined || r.partnerId === where['partnerId'])
          && (where['cardTypeId'] === undefined || r.cardTypeId === where['cardTypeId'])
          && (where['deletedAt'] !== null || r.deletedAt == null)).map((r) => ({ ...r }))
    },
    feeSellQuote: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        quotes.filter((q) => (where['partnerId'] === undefined || q.partnerId === where['partnerId'])
          && (where['cardTypeId'] === undefined || q.cardTypeId === where['cardTypeId'])
          && (where['feeTypeId'] === undefined || q.feeTypeId === where['feeTypeId'])
          && (where['deletedAt'] !== null || q.deletedAt == null)).map((q) => ({ ...q }))
    },
    tidSellFee: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        overrides.filter((o) => (where['tidId'] === undefined || o.tidId === where['tidId'])
          && (where['cardTypeId'] === undefined || o.cardTypeId === where['cardTypeId'])
          && (where['feeTypeId'] === undefined || o.feeTypeId === where['feeTypeId'])
          && (where['deletedAt'] !== null || o.deletedAt == null)).map((o) => ({ ...o }))
    },
    transaction: {
      findMany: async ({ where }: { where: Record<string, unknown>; select?: unknown }) => {
        return txns.filter((t) => {
          for (const [k, cond] of Object.entries(where)) {
            if (k === 'txnDate') continue; // engine lọc range trong code
            if (!matchScalar((t as unknown as Record<string, unknown>)[k], cond)) return false;
          }
          return true;
        }).map((t) => ({ ...t, settled: t.settled ?? false, settledAt: t.settledAt ?? null }));
      },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
        const r = txns.find((t) => t.id === where.id)!;
        Object.assign(r, data);
        return { ...r };
      }
    },
    revenueRecalcLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: recalcLogs.length + 1, ...data }; recalcLogs.push(row); return { ...row }; }
    },
    // Đối chiếu settlement sau recalc (Admin Demo 11/8) — groupBy (transactionId, side) Σamount.
    cashDebtSettlement: {
      groupBy: async ({ where }: { where: { transactionId: { in: number[] } } }) => {
        const ids = where.transactionId.in;
        const agg = new Map<string, bigint>();
        for (const s of settlements) {
          if (!ids.includes(s.transactionId)) continue;
          const k = `${s.transactionId}:${s.side}`;
          agg.set(k, (agg.get(k) ?? 0n) + s.amount);
        }
        return [...agg.entries()].map(([k, amount]) => { const [tid, side] = k.split(':'); return { transactionId: Number(tid), side, _sum: { amount } }; });
      }
    }
  };
  return { db: db as unknown as RecalcClient, txns, recalcLogs, lo, vetLo: (db as unknown as { vetLo: Array<{ loId: number; after: string }> }).vetLo };
}

// Helper: doanh thu KỲ VỌNG cho 1 txn nếu tra phí (phiMua/phiCaiMay + phiBan) — mirror công thức lõi.
function expectedRev(amount: bigint, phiMua: number, phiCaiMay: number, phiBan: number) {
  return computeRevenue(Number(amount), phiMua - phiCaiMay, phiBan - phiCaiMay);
}

const SCOPE_BASE = { reason: 'FEE_RATE_SET', actorUserId: 7 };

describe('PHA 2 — engine recalcRevenueForFeeChange (17 case chống lỗi)', () => {
  // ══ CASE 1 — ranh giới 0h00 LOCAL: GD đúng mốc effectiveFrom thuộc KỲ MỚI (gte, nửa-mở) ══
  it('CASE 1 — GD tại đúng mốc 0h00 local của kỳ mới ĐƯỢC recalc (gte); GD ngay trước mốc thì KHÔNG', async () => {
    const boundary = day(2026, 6, 1);
    const justBefore = new Date(boundary.getTime() - 1); // 23:59:59.999 ngày 31/5 local
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [
        { id: 1, partnerId: 9, cardTypeId: 11, phiMua: 1000, phiCaiMay: 500, effectiveFrom: day(2026, 1, 1), deletedAt: null },
        { id: 2, partnerId: 9, cardTypeId: 11, phiMua: 2000, phiCaiMay: 500, effectiveFrom: boundary, deletedAt: null }
      ],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 3000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      txns: [
        { id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: boundary, status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD100' },
        { id: 101, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: justBefore, status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD101' }
      ]
    });
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: boundary, to: null });
    expect(r.ok).toBe(true);
    // GD 100 (đúng mốc) recalc theo kỳ MỚI phiMua=2000 → partnerMargin 1500.
    const t100 = s.txns.find((t) => t.id === 100)!;
    expect(t100.partnerMarginMilli).toBe(1500);
    // GD 101 (trước mốc) KHÔNG bị đụng.
    const t101 = s.txns.find((t) => t.id === 101)!;
    expect(t101.partnerMarginMilli).toBe(500);
    expect(r.changed).toBe(1);
  });

  // ══ CASE 2 — sửa LÙI (backdate) cắt kỳ có GD → 2 kỳ tính đúng, tổng khớp ══
  it('CASE 2 — chèn KỲ backdate 01/06 cắt đôi: GD tháng 3 giữ kỳ cũ, GD tháng 7 sang kỳ mới; tổng đúng', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [
        { id: 1, partnerId: 9, cardTypeId: 11, phiMua: 1000, phiCaiMay: 500, effectiveFrom: day(2026, 1, 1), deletedAt: null },
        { id: 2, partnerId: 9, cardTypeId: 11, phiMua: 1000, phiCaiMay: 500, effectiveFrom: day(2026, 6, 1), deletedAt: null }
      ],
      quotes: [
        { id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 3000, effectiveFrom: day(2026, 1, 1), deletedAt: null },
        { id: 2, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 5000, effectiveFrom: day(2026, 6, 1), deletedAt: null } // KỲ backdate mới
      ],
      txns: [
        // GD tháng 3 (kỳ cũ 3%): snapshot đúng sẵn.
        { id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 3, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD100' },
        // GD tháng 7 (đáng lẽ kỳ mới 5%) NHƯNG snapshot còn STALE = kỳ cũ 3% → phải recalc.
        { id: 101, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 7, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD101' }
      ]
    });
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 6, 1), to: null });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(1); // chỉ GD tháng 7
    const t100 = s.txns.find((t) => t.id === 100)!; // kỳ cũ — không đụng
    expect(t100.sellMarginMilli).toBe(2500);
    const t101 = s.txns.find((t) => t.id === 101)!; // kỳ mới 5% → sellMargin = 5000-500 = 4500
    const exp = expectedRev(1_000_000n, 1000, 500, 5000);
    expect(t101.sellMarginMilli).toBe(4500);
    expect(Number(t101.revenueSell)).toBe(exp.revenueSell);
    expect(Number(t101.revenueAmount)).toBe(Number(t101.revenuePartner) + Number(t101.revenueSell));
  });

  // ══ CASE 3 — sửa TỚI (future effectiveFrom) KHÔNG đụng quá khứ ══
  it('CASE 3 — from ở TƯƠNG LAI: mọi GD quá khứ không bị đụng (scanned=0)', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 1000, phiCaiMay: 500, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 3000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 3, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD100' }]
    });
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2030, 1, 1), to: null });
    expect(r.ok).toBe(true);
    expect(r.scanned).toBe(0);
    expect(r.changed).toBe(0);
  });

  // ══ CASE 4 — nhiều lần sửa CHỒNG kỳ: kết quả cuối cùng đúng kỳ hiệu lực tại txnDate ══
  it('CASE 4 — 2 lần recalc chồng kỳ (06 rồi 04): GD tháng 5 lấy kỳ 04, GD tháng 7 lấy kỳ 06', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 1000, phiCaiMay: 500, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [
        { id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 3000, effectiveFrom: day(2026, 1, 1), deletedAt: null },
        { id: 2, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 4000, effectiveFrom: day(2026, 4, 1), deletedAt: null },
        { id: 3, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 5000, effectiveFrom: day(2026, 6, 1), deletedAt: null }
      ],
      txns: [
        { id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 5, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD100' },
        { id: 101, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 7, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD101' }
      ]
    });
    await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 6, 1), to: null });
    await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 4, 1), to: null });
    const t100 = s.txns.find((t) => t.id === 100)!; // tháng 5 → kỳ 04 = 4% → sellMargin 3500
    expect(t100.sellMarginMilli).toBe(3500);
    const t101 = s.txns.find((t) => t.id === 101)!; // tháng 7 → kỳ 06 = 5% → sellMargin 4500
    expect(t101.sellMarginMilli).toBe(4500);
  });

  // ══ CASE 5 — IDEMPOTENT: recalc 2 lần liên tiếp, lần 2 = 0 thay đổi / 0 log ══
  it('CASE 5 — chạy 2 lần: lần 1 sửa, lần 2 = 0 đổi + 0 log (idempotent)', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 2000, phiCaiMay: 500, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 5000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 3, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD100' }]
    });
    const r1 = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    expect(r1.changed).toBe(1);
    expect(s.recalcLogs.length).toBe(1);
    const r2 = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    expect(r2.changed).toBe(0);
    expect(s.recalcLogs.length).toBe(1); // KHÔNG thêm log
  });

  // ══ B223 (Admin Demo 20/11) — ĐỔI GIÁ BÁN LÙI NGÀY PHẢI CHỈNH LUÔN SỐ TIỀN CỦA BILL ══
  // Trước đây engine chỉ sửa bảng `transactions`; lô giữ số cũ ⇒ màn Doanh Số và sổ giao dịch LỆCH NHAU.
  // Đo thật 20/11: giá 1,2% → 0,7% lùi ngày, GD đã tính lại mà lô vẫn 9.880.000 thay vì 9.930.000.
  const seedLo = (phiBanMilli: number, lo: LoRowFake[]) => makeStore({
    tids: [{ id: 1, partnerId: 9, bankId: 5 }],
    rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 1500, phiCaiMay: 500, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
    quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: phiBanMilli, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
    txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 10_000_000n, txnDate: day(2026, 3, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 0, sellMarginMilli: 0, revenuePartner: 0n, revenueSell: 0n, revenueAmount: 0n, code: 'GD100' }],
    lo
  });

  it('B223-1 — đổi giá bán lùi ngày: tiền SAU PHÍ của lô đổi theo PHÍ BÁN (không phải margin) + có ghi vết', async () => {
    // giá bán 0,7% trên 10tr ⇒ phí 70.000 ⇒ còn 9.930.000. Lô đang giữ số của giá cũ 1,2%.
    const s = seedLo(700, [{ loId: 55, rowId: 77, txnId: 100, amountBeforeFee: 10_000_000, feeApplied: 120_000, amountAfterFee: 9_880_000 }]);
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    expect(r.changed).toBe(1);
    expect(s.lo[0].feeApplied).toBe(70_000);
    expect(s.lo[0].amountAfterFee).toBe(9_930_000); // CẤM ra 10.095.500 (lỗi truyền nhầm margin, đã cắn 20/11)
    expect(s.lo[0].amountAfterFee).toBeLessThan(10_000_000); // tiền sau phí KHÔNG BAO GIỜ lớn hơn tiền gốc
    expect(r.loDaSua).toBe(1);
    expect(s.vetLo.length).toBe(1); // ghi vết LO_AMOUNT_RECALC
    expect(JSON.parse(s.vetLo[0].after).amountAfterFee).toBe(9_930_000);
  });

  it('B223-2 — chạy LẠI cùng lệnh: lô KHÔNG đổi số thêm lần nữa và KHÔNG đẻ thêm vết (idempotent)', async () => {
    const s = seedLo(700, [{ loId: 55, rowId: 77, txnId: 100, amountBeforeFee: 10_000_000, feeApplied: 120_000, amountAfterFee: 9_880_000 }]);
    await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    expect(s.lo[0].amountAfterFee).toBe(9_930_000);
    expect(s.vetLo.length).toBe(1);
  });

  it('B223-3 — lô TÁCH NHIỀU THẺ: engine KHÔNG tự đoán, bỏ qua và BÁO RA lý do (R198 cấm im lặng)', async () => {
    const s = seedLo(700, [{ loId: 55, rowId: 77, txnId: 100, soDong: 2, amountBeforeFee: 10_000_000, feeApplied: 120_000, amountAfterFee: 9_880_000 }]);
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    expect(s.lo[0].amountAfterFee).toBe(9_880_000); // KHÔNG đụng
    expect(r.loDaSua).toBe(0);
    expect(r.loBoQua?.[0]).toContain('nhiều loại thẻ');
  });

  it('B223-4 — lô ĐÃ ĐỐI SOÁT / đã hoàn tiền: không đụng tiền, vẫn BÁO RA lý do', async () => {
    const s = seedLo(700, [{ loId: 55, rowId: 77, txnId: 100, amountBeforeFee: 10_000_000, feeApplied: 120_000, amountAfterFee: 9_880_000, daDoiSoat: true }]);
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    expect(s.lo[0].amountAfterFee).toBe(9_880_000);
    expect(r.loDaSua).toBe(0);
    expect(r.loBoQua?.[0]).toContain('đối soát');
  });

  // ══ CASE 6 — sau recalc: REVENUE_MISMATCH invariant = 0 (revenueAmount = partner+sell = computeRevenue) ══
  it('CASE 6 — sau recalc, MỌI GD thỏa revenueAmount = revenuePartner+revenueSell = computeRevenue(margin)', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 1500, phiCaiMay: 700, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 4200, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_234_567n, txnDate: day(2026, 3, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 0, sellMarginMilli: 0, revenuePartner: 0n, revenueSell: 0n, revenueAmount: 0n, code: 'GD100' }]
    });
    await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    for (const t of s.txns) {
      const exp = computeRevenue(Number(t.amount), t.partnerMarginMilli, t.sellMarginMilli);
      expect(Number(t.revenuePartner)).toBe(exp.revenuePartner);
      expect(Number(t.revenueSell)).toBe(exp.revenueSell);
      expect(Number(t.revenueAmount)).toBe(exp.revenueAmount);
      expect(Number(t.revenueAmount)).toBe(Number(t.revenuePartner) + Number(t.revenueSell));
    }
  });

  // ══ CASE 7 — chỉ đụng POSTED: bỏ CANCELLED / deletedAt / writtenOffAt ══
  it('CASE 7 — GD CANCELLED / đã xóa mềm / đã ghi giảm nợ xấu KHÔNG bị recalc', async () => {
    const base = { tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 3, 1), partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n } as const;
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 2000, phiCaiMay: 500, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 5000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      txns: [
        { id: 100, ...base, status: 'POSTED', deletedAt: null, writtenOffAt: null, code: 'GD100' },
        { id: 200, ...base, status: 'CANCELLED', deletedAt: null, writtenOffAt: null, code: 'GD200' },
        { id: 300, ...base, status: 'POSTED', deletedAt: new Date(), writtenOffAt: null, code: 'GD300' },
        { id: 400, ...base, status: 'POSTED', deletedAt: null, writtenOffAt: new Date(), code: 'GD400' }
      ]
    });
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    expect(r.scanned).toBe(1);
    expect(r.changed).toBe(1);
    // 3 GD đóng băng giữ nguyên snapshot cũ.
    for (const id of [200, 300, 400]) expect(s.txns.find((t) => t.id === id)!.sellMarginMilli).toBe(2500);
    expect(s.txns.find((t) => t.id === 100)!.sellMarginMilli).toBe(4500);
  });

  // ══ CASE 8 — BigInt số lớn không tràn + log cột tiền là bigint + JSON serialize ra số đúng ══
  it('CASE 8 — amount lớn (int8): recalc đúng, log before/after là bigint, JSON.stringify không throw', async () => {
    const amount = 9_000_000_000_000n; // 9e12
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 2000, phiCaiMay: 500, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 5000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount, txnDate: day(2026, 3, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 0, sellMarginMilli: 0, revenuePartner: 0n, revenueSell: 0n, revenueAmount: 0n, code: 'GD100' }]
    });
    await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    const log = s.recalcLogs[0]!;
    expect(typeof log['beforeRevenueAmount']).toBe('bigint');
    expect(typeof log['afterRevenueAmount']).toBe('bigint');
    const exp = expectedRev(amount, 2000, 500, 5000);
    expect(Number(log['afterRevenueAmount'])).toBe(exp.revenueAmount);
    expect(Number.isSafeInteger(exp.revenueAmount)).toBe(true); // không tràn 2^53
    const json = JSON.parse(JSON.stringify(log));
    expect(json.afterRevenueAmount).toBe(exp.revenueAmount);
  });

  // ══ CASE 9 — GD tra phí FAIL (thiếu FeeRate hiệu lực tại txnDate) → SURFACE (ok=false, failed[]) KHÔNG nuốt lỗi ══
  it('CASE 9 — GD có txnDate TRƯỚC mọi FeeRate → resolve fail → gom failed[], ok=false (R198 không nuốt)', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 2000, phiCaiMay: 500, effectiveFrom: day(2026, 6, 1), deletedAt: null }], // chỉ có từ 06
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 5000, effectiveFrom: day(2026, 6, 1), deletedAt: null }],
      // GD ngày 2026-07-01 (in-range của from=06) tra được; GD 2026-07-02 cũng OK. Để tạo fail: 1 GD có cardType KHÁC không có rate.
      txns: [
        { id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 7, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 0, sellMarginMilli: 0, revenuePartner: 0n, revenueSell: 0n, revenueAmount: 0n, code: 'GD100' },
        { id: 101, tidId: 1, cardTypeId: 99, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 7, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 0, sellMarginMilli: 0, revenuePartner: 0n, revenueSell: 0n, revenueAmount: 0n, code: 'GD101' }
      ],
      cards: [{ id: 11, bankId: 5, deletedAt: null }, { id: 99, bankId: 5, deletedAt: null }]
    });
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, from: day(2026, 6, 1), to: null });
    expect(r.ok).toBe(false);
    expect(r.failed.length).toBe(1);
    expect(r.failed[0]!.transactionId).toBe(101);
    expect(r.failed[0]!.error).toBe('NO_FEE_RATE');
  });

  // ══ CASE 12 — dashboard & ranking đọc CÙNG snapshot đã recalc: cột revenue* trên row = giá trị mới (1 nguồn) ══
  it('CASE 12 — sau recalc, cột revenue* trên GD = giá trị kỳ mới (dashboard/ranking đọc chung 1 nguồn khớp)', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 2000, phiCaiMay: 500, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 6000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 2_000_000n, txnDate: day(2026, 3, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 10000n, revenueSell: 50000n, revenueAmount: 60000n, code: 'GD100' }]
    });
    await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    const t = s.txns.find((x) => x.id === 100)!;
    const exp = expectedRev(2_000_000n, 2000, 500, 6000); // partnerMargin 1500, sellMargin 5500
    expect(Number(t.revenuePartner)).toBe(exp.revenuePartner);
    expect(Number(t.revenueSell)).toBe(exp.revenueSell);
    expect(Number(t.revenueAmount)).toBe(exp.revenueAmount);
  });

  // ══ CASE 13 — bound half-open theo TID scope (setTidSellFees): override đè niêm yết đúng kỳ ══
  it('CASE 13 — scope theo TID + feeType: override kỳ mới đè niêm yết cho GD từ mốc, GD trước lấy niêm yết', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }, { id: 2, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 1000, phiCaiMay: 500, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 3000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      overrides: [{ id: 1, tidId: 1, cardTypeId: 11, feeTypeId: 3, phiBan: 7000, effectiveFrom: day(2026, 6, 1), deletedAt: null }],
      txns: [
        { id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 7, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD100' },
        // GD của TID 2 (khác TID) KHÔNG bị đụng dù cùng đối tác — scope theo TID.
        { id: 200, tidId: 2, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 7, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD200' }
      ]
    });
    const r = await recalcRevenueForFeeChange(s.db, { reason: 'TID_SELL_FEE_SET', actorUserId: 7, tidId: 1, feeTypeId: 3, from: day(2026, 6, 1), to: null });
    expect(r.ok).toBe(true);
    expect(s.txns.find((t) => t.id === 100)!.sellMarginMilli).toBe(6500); // 7000 - 500
    expect(s.txns.find((t) => t.id === 200)!.sellMarginMilli).toBe(2500); // TID 2 không đụng
  });

  // ══ CASE 14 — 3a: GD ĐÃ ĐỐI SOÁT (settled-like, vẫn POSTED) VẪN được recalc ══
  it('CASE 14 — GD POSTED (kể cả đã đối soát/tất toán) vẫn recalc — quyết định 3a', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 2000, phiCaiMay: 500, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 5000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      // settled không phải cột engine lọc → POSTED là recalc.
      txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 3, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD100' }]
    });
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    expect(r.changed).toBe(1);
  });

  // ══ CASE 15 — KHÔNG đụng amount / mã GD ══
  it('CASE 15 — recalc KHÔNG thay đổi amount và code của GD', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 2000, phiCaiMay: 500, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 5000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_234_567n, txnDate: day(2026, 3, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD100' }]
    });
    await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    const t = s.txns.find((x) => x.id === 100)!;
    expect(t.amount).toBe(1_234_567n);
    expect(t.code).toBe('GD100');
  });

  // ══ CASE 16 — log ghi ĐÚNG before→after + feeEffectiveFrom + reason + actorUserId ══
  it('CASE 16 — RevenueRecalcLog ghi before/after margin + revenue + feeEffectiveFrom + reason + actor', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 2000, phiCaiMay: 500, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 5000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 3, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD100' }]
    });
    await recalcRevenueForFeeChange(s.db, { reason: 'FEE_RATE_SET', actorUserId: 7, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    const log = s.recalcLogs[0]!;
    expect(log['transactionId']).toBe(100);
    expect(log['beforePartnerMargin']).toBe(500);
    expect(log['beforeSellMargin']).toBe(2500);
    expect(log['afterPartnerMargin']).toBe(1500);
    expect(log['afterSellMargin']).toBe(4500);
    expect(log['reason']).toBe('FEE_RATE_SET');
    expect(log['actorUserId']).toBe(7);
    expect((log['feeEffectiveFrom'] as Date).getTime()).toBe(day(2026, 1, 1).getTime());
  });

  // ══ CASE 17 — partner không có TID nào → 0 scan (không lỗi) ══
  it('CASE 17 — partner không có TID → scanned=0, ok=true (không nổ)', async () => {
    const s = makeStore({ tids: [], txns: [] });
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 123, from: day(2026, 1, 1), to: null });
    expect(r.ok).toBe(true);
    expect(r.scanned).toBe(0);
  });
});

// ══ CASE 10 + 11 — VIỆC B (loại phí mặc định) + BILL_IMMUTABLE ══
describe('PHA 2 — bill bất biến + loại phí mặc định lúc giao', () => {
  // CASE 11 — updateTransaction VẪN chặn BILL_IMMUTABLE (không mở khe sửa bill khi thêm recalc).
  it('CASE 11 — updateTransaction luôn trả BILL_IMMUTABLE (bill bất biến)', async () => {
    const ctx = { db: {} as unknown as Db, user: authUser(['REVENUE_MANAGE']) } as ServiceCtx;
    const r = await updateTransaction(ctx, 1, { amount: 999 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('BILL_IMMUTABLE');
  });

});

// ══ CỌC/TRẢ DƯ (Admin Demo 11/8) — recalc HẠ doanh thu dưới mức ĐÃ THU → cảnh báo trả dư + đồng bộ settled ══
describe('PHA 2b — recalc cảnh báo TRẢ DƯ + recompute settled (đối chiếu settlement)', () => {
  // OVER-1 — GD đã THU ĐỦ, hạ phí bán → Σthu(SELL) > doanh thu mới(SELL) → overpaid, settled giữ true (net≤0).
  it('OVER-1 — hạ phí bán trên GD đã thu đủ → overpaid SELL, settled vẫn true', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 3000, phiCaiMay: 1000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 2000, effectiveFrom: day(2026, 1, 1), deletedAt: null }], // đã hạ 5000→2000: sellMargin 1000
      // snapshot cũ = phí CAO (phiBan 5000 → sellMargin 4000, revenueSell 400000 trên amount 10tr).
      txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 10_000_000n, txnDate: day(2026, 2, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 2000, sellMarginMilli: 4000, revenuePartner: 200000n, revenueSell: 400000n, revenueAmount: 600000n, code: 'GD100', settled: true, settledAt: day(2026, 2, 2) }],
      settlements: [{ transactionId: 100, side: 'PARTNER', amount: 200000n }, { transactionId: 100, side: 'SELL', amount: 400000n }]
    });
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(1);
    const t = s.txns.find((x) => x.id === 100)!;
    expect(Number(t.revenueSell)).toBe(100000); // amount 10tr × 1000/100000
    expect(r.overpaid.length).toBe(1);
    expect(r.overpaid[0]!.overpaidSell).toBe(300000); // 400000 thu − 100000 doanh thu mới
    expect(r.overpaid[0]!.overpaidPartner).toBe(0);
    expect(r.overpaid[0]!.overpaidTotal).toBe(300000);
    expect(t.settled).toBe(true); // net ≤ 0 cả 2 side → vẫn settled
    expect(r.settledFlagFixed).toBe(0);
  });

  // OVER-2 — TĂNG phí trên GD đang settled → net > 0 → settled bị GỠ (false), không overpaid.
  it('OVER-2 — tăng phí trên GD đã settled → settled bị gỡ false (settledFlagFixed=1), không overpaid', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 3000, phiCaiMay: 1000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 9000, effectiveFrom: day(2026, 1, 1), deletedAt: null }], // tăng: sellMargin 8000
      txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 10_000_000n, txnDate: day(2026, 2, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 2000, sellMarginMilli: 4000, revenuePartner: 200000n, revenueSell: 400000n, revenueAmount: 600000n, code: 'GD100', settled: true, settledAt: day(2026, 2, 2) }],
      settlements: [{ transactionId: 100, side: 'PARTNER', amount: 200000n }, { transactionId: 100, side: 'SELL', amount: 400000n }]
    });
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    const t = s.txns.find((x) => x.id === 100)!;
    expect(Number(t.revenueSell)).toBe(800000); // 10tr × 8000/100000
    expect(t.settled).toBe(false); // đã thu 400000 < 800000 → chưa đủ
    expect(t.settledAt).toBe(null);
    expect(r.settledFlagFixed).toBe(1);
    expect(r.overpaid.length).toBe(0);
  });

  // OVER-3 — GD chưa từng thu (không settlement) → dù đổi phí KHÔNG overpaid, không flip settled (net>0 sẵn false).
  it('OVER-3 — GD không có settlement → không overpaid, settled giữ false', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 3000, phiCaiMay: 1000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 2000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 10_000_000n, txnDate: day(2026, 2, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 2000, sellMarginMilli: 4000, revenuePartner: 200000n, revenueSell: 400000n, revenueAmount: 600000n, code: 'GD100', settled: false, settledAt: null }]
      // KHÔNG settlements
    });
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    expect(r.overpaid.length).toBe(0);
    expect(r.settledFlagFixed).toBe(0);
    expect(s.txns.find((x) => x.id === 100)!.settled).toBe(false);
  });
});

// ══ P5 (Admin Demo 20/8) — doanh số CHỈ dùng giá bán THỰC TẾ (override); GD cũ chỉ có niêm yết → grandfather (failed[]) ══
describe('PHA 2c — P5 doanh số CHỈ giá THỰC TẾ: niêm yết → grandfathered[] (KHÔNG abort), đặt override → cập nhật', () => {
  // P5-1 — GD POSTED mà TID chỉ có niêm yết (KHÔNG override) → resolveFeeForTxn NO_ACTUAL_SELL_FEE → gom vào
  //        grandfathered[] (SOFT, KHÔNG làm ok=false, KHÔNG rollback lệnh đổi phí), KHÔNG hỏng snapshot GD cũ, KHÔNG
  //        ghi log. R198 — vẫn TRẢ RA (không nuốt) để caller surface cảnh báo.
  it('P5-1 — GD chỉ có niêm yết (không override) → grandfathered[] NO_ACTUAL_SELL_FEE, ok=true, revenue cũ GIỮ NGUYÊN', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 2000, phiCaiMay: 500, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 5000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      overrides: [], // TẮT mirror → CHỈ có niêm yết
      txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 3, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD100' }]
    });
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    expect(r.ok).toBe(true); // grandfathered KHÔNG làm ok=false (không rollback đổi phí)
    expect(r.changed).toBe(0);
    expect(r.failed).toEqual([]); // KHÔNG còn ở failed[] (đã tách sang grandfathered)
    expect(r.grandfathered.length).toBe(1);
    expect(r.grandfathered[0]!.transactionId).toBe(100);
    expect(r.grandfathered[0]!.error).toBe('NO_ACTUAL_SELL_FEE');
    // GD cũ grandfathered — snapshot GIỮ NGUYÊN (không âm thầm hỏng doanh thu đã POSTED).
    const t = s.txns.find((x) => x.id === 100)!;
    expect(t.partnerMarginMilli).toBe(500);
    expect(t.sellMarginMilli).toBe(2500);
    expect(Number(t.revenueSell)).toBe(25000);
    expect(Number(t.revenueAmount)).toBe(30000);
    expect(s.recalcLogs.length).toBe(0); // không ghi log khi không đổi
  });

  // P5-2 — SAU khi ĐẶT override thực tế → recalc re-resolve theo override, cập nhật GD (dùng THỰC TẾ, KHÔNG niêm yết).
  it('P5-2 — đặt override thực tế → recalc cập nhật GD theo giá THỰC TẾ (không dùng niêm yết)', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 2000, phiCaiMay: 500, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 5000, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      overrides: [{ id: 1, tidId: 1, cardTypeId: 11, feeTypeId: 3, phiBan: 7000, effectiveFrom: day(2026, 1, 1), deletedAt: null }], // giá THỰC TẾ 7%
      txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 3, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD100' }]
    });
    const r = await recalcRevenueForFeeChange(s.db, { reason: 'TID_SELL_FEE_SET', actorUserId: 7, tidId: 1, feeTypeId: 3, from: day(2026, 1, 1), to: null });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(1);
    const t = s.txns.find((x) => x.id === 100)!;
    expect(t.sellMarginMilli).toBe(6500); // override 7000 − phiCaiMay 500 (KHÔNG dùng niêm yết 5000)
    const exp = expectedRev(1_000_000n, 2000, 500, 7000);
    expect(Number(t.revenueSell)).toBe(exp.revenueSell);
    expect(Number(t.revenueAmount)).toBe(exp.revenueAmount);
  });
});

// ══ MONEY-1 (audit 20/8) — phiCaiMay-only drift: 2 margin GIỮ NGUYÊN nhưng phí cài máy ĐỔI → recalc PHẢI update ══
// Trước fix: `same` chỉ so partnerMargin/sellMargin/revenue* → biểu phí đổi phiCaiMay mà margin không đổi bị coi là
// "đã đúng" → short-circuit, snapshot phiCaiMayMilli cũ đóng băng → tất toán NĐT tính SAI tiền về.
describe('MONEY-1 — recalc đồng bộ phiCaiMayMilli khi CHỈ phí cài máy đổi (margin không đổi)', () => {
  it('MONEY-1 — phiMua+phiCaiMay+phiBan cùng tăng 0.5% (margin bất biến) → UPDATE phiCaiMayMilli 500→700, changed=1, log ghi', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      // Kỳ HIỆN HÀNH: phiMua 1200, phiCaiMay 700, phiBan 3200 → partnerMargin=500, sellMargin=2500 (Y HỆT snapshot cũ),
      // nhưng phiCaiMay = 700 (khác snapshot 500). Chỉ phí cài máy trôi.
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 1200, phiCaiMay: 700, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 3200, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      // Snapshot GD cũ: margin 500/2500 + revenue KHỚP computeRevenue(1tr,500,2500); phiCaiMayMilli CŨ = 500.
      txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 3, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, phiCaiMayMilli: 500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD100' }]
    });
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(1); // KHÔNG short-circuit — phiCaiMay drift ép update
    const t = s.txns.find((x) => x.id === 100)!;
    expect(t.phiCaiMayMilli).toBe(700); // snapshot phí cài máy đồng bộ giá trị mới
    // Margin + revenue GIỮ NGUYÊN (chỉ phí cài máy đổi) — chứng minh không phải trùng hợp margin đổi.
    expect(t.partnerMarginMilli).toBe(500);
    expect(t.sellMarginMilli).toBe(2500);
    expect(Number(t.revenueSell)).toBe(25000);
    expect(Number(t.revenueAmount)).toBe(30000);
    expect(s.recalcLogs.length).toBe(1); // RevenueRecalcLog ghi (before→after)
  });

  it('MONEY-1 — idempotent: sau khi phiCaiMayMilli đã khớp (700=700) → lần 2 changed=0, không thêm log', async () => {
    const s = makeStore({
      tids: [{ id: 1, partnerId: 9, bankId: 5 }],
      rates: [{ id: 1, partnerId: 9, cardTypeId: 11, phiMua: 1200, phiCaiMay: 700, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      quotes: [{ id: 1, partnerId: 9, cardTypeId: 11, feeTypeId: 3, phiBan: 3200, effectiveFrom: day(2026, 1, 1), deletedAt: null }],
      // Snapshot ĐÃ đúng phiCaiMayMilli=700 sẵn → không có gì để đổi.
      txns: [{ id: 100, tidId: 1, cardTypeId: 11, feeTypeId: 3, amount: 1_000_000n, txnDate: day(2026, 3, 1), status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, phiCaiMayMilli: 700, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, code: 'GD100' }]
    });
    const r = await recalcRevenueForFeeChange(s.db, { ...SCOPE_BASE, partnerId: 9, cardTypeId: 11, from: day(2026, 1, 1), to: null });
    expect(r.changed).toBe(0);
    expect(s.recalcLogs.length).toBe(0);
  });
});

describe('PHA 2 — bill bất biến + loại phí mặc định lúc giao (tiếp)', () => {
  it('CASE 10b — set phí bán lúc giao mà loại thẻ chưa có FeeRate → VALIDATION báo rõ (không nuốt)', async () => {
    const fake = {
      tid: { findUnique: async () => ({ id: 1, tid: 'TID001', bankId: 5, partnerId: 9, deletedAt: null }) },
      feeType: { findUnique: async ({ where }: { where: { id: number } }) => (where.id === 3 ? { id: 3, deletedAt: null, name: 'Ủy quyền' } : null) },
      cardType: { findMany: async () => [{ id: 11, code: 'VISA', name: 'Visa', bankId: 5, deletedAt: null }] },
      feeRate: { findMany: async () => [] }, // KHÔNG có biểu phí → không xác định được phí mua
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({})
    };
    const ctx = { db: fake as unknown as Db, user: authUser(['TID_MANAGE']) } as ServiceCtx;
    const r = await setTidSellFees(ctx, { tidId: 1, feeTypeId: 3, entries: [{ cardTypeId: 11, phiBan: 2 }] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toContain('Chưa cấu hình phí mua');
  });
});

describe('MONEY-2 — recalc findMany dùng orderBy id asc (chống ABBA deadlock với createDebtReceipt)', () => {
  it('recalcRevenueForFeeChange gọi transaction.findMany với orderBy { id: asc }', async () => {
    let capturedOrderBy: unknown = 'NOT_CALLED';
    const db = {
      ...txnTzRawStub(() => [], { giaBanThucTe: () => [] }), // ca này CỐ Ý không có giá bán thực tế
      tid: { findMany: async () => [] },
      transaction: {
        findMany: async ({ orderBy }: { orderBy?: unknown }) => { capturedOrderBy = orderBy; return []; },
        update: async () => ({})
      },
      revenueRecalcLog: { create: async () => ({}) },
      cashDebtSettlement: { groupBy: async () => [] },
      cardType: { findUnique: async () => null },
      feeRate: { findMany: async () => [] },
      feeSellQuote: { findMany: async () => [] },
      tidSellFee: { findMany: async () => [] }
    } as unknown as RecalcClient;
    // scope theo tidId (bỏ nhánh partner) → vào thẳng transaction.findMany.
    const r = await recalcRevenueForFeeChange(db, { tidId: 1, from: day(2026, 1, 1), to: null, reason: 'TID_SELL_FEE_SET', actorUserId: 7 });
    expect(r.ok).toBe(true);
    expect(capturedOrderBy).toEqual({ id: 'asc' });
  });
});
