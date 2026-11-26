// Test LÕI THUẦN fee-config core (@sigma/services) — Db GIẢ in-memory ĐÚNG SHAPE Prisma + ServiceCtx = { db, user }.
// ASSERT: error code + nguyên văn message + phí lưu Int ×1000 + ràng buộc bán ≥ mua + upsert kỳ + audit + soft-delete.
// §14 xác nhận MẬT KHẨU đã CHUYỂN RA ADAPTER — lõi KHÔNG kiểm password.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { txnTzRawStub } from './_fake-db.js';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Db } from '@sigma/database';
import { createPrisma } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  listFeeTypes,
  createFeeType,
  updateFeeType,
  deleteFeeTypes,
  listFeeRates,
  setFeeRate,
  deleteFeeRates,
  listSellQuotes,
  type ServiceCtx
} from '../src/index.js';

interface Row { [k: string]: unknown; id: number; deletedAt: Date | null }

function inRange(v: unknown, cond: unknown): boolean {
  if (cond && typeof cond === 'object' && ('gte' in (cond as object) || 'lt' in (cond as object))) {
    const c = cond as { gte?: Date; lt?: Date };
    const t = (v as Date).getTime();
    if (c.gte && t < c.gte.getTime()) return false;
    if (c.lt && t >= c.lt.getTime()) return false;
    return true;
  }
  return v === cond;
}

function makeFakeDb() {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const feeTypes: Row[] = [{ id: 1, name: 'Ủy quyền', createdBy: 42, createdAt: now, updatedBy: null, updatedAt: now, deletedAt: null, deletedBy: null }];
  const feeRates: Row[] = [];
  const feeSellQuotes: Row[] = [];
  const partners: Row[] = [{ id: 10, code: 'DTA', name: 'Đối tác A', deletedAt: null }];
  const cardTypes: Row[] = [{ id: 20, code: 'VISA', name: 'Visa', bankId: 30, deletedAt: null }];
  const banks: Row[] = [{ id: 30, code: 'VCB', name: 'Vietcombank', deletedAt: null }];
  const partnerBanks: Row[] = [{ id: 40, partnerId: 10, bankId: 30, deletedAt: null }];
  const audits: Record<string, unknown>[] = [];
  let nextId = 100;

  function model(store: Row[]) {
    return {
      findMany: async (args?: { where?: Record<string, unknown> }) => {
        const w = args?.where ?? {};
        return store.filter((r) => Object.entries(w).every(([k, cond]) => {
          if (cond === undefined) return true;
          if (k === 'id') { const idIn = (cond as { in?: number[] }).in; return idIn ? idIn.includes(r.id) : r.id === cond; }
          if (cond && typeof cond === 'object' && 'in' in (cond as object)) return (cond as { in: unknown[] }).in.includes(r[k]);
          return inRange(r[k], cond);
        })).map((r) => ({ ...r }));
      },
      findUnique: async ({ where }: { where: { id: number } }) => { const r = store.find((x) => x.id === where.id); return r ? { ...r } : null; },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const not = (where['NOT'] as { id?: number } | undefined)?.id;
        const r = store.find((x) => {
          if (not !== undefined && x.id === not) return false;
          return Object.entries(where).every(([k, cond]) => k === 'NOT' ? true : inRange(x[k], cond));
        });
        return r ? { ...r } : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const t = new Date();
        const row: Row = { id: nextId++, createdAt: t, updatedAt: t, updatedBy: null, deletedAt: null, deletedBy: null, ...data } as Row;
        store.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = store.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let n = 0;
        for (const r of store) { if (Object.entries(where).every(([k, cond]) => inRange(r[k], cond))) { Object.assign(r, data); n++; } }
        return { count: n };
      }
    };
  }

  const fake = {
    feeType: model(feeTypes),
    feeRate: model(feeRates),
    feeSellQuote: model(feeSellQuotes),
    partner: model(partners),
    cardType: model(cardTypes),
    bank: model(banks),
    partnerBank: model(partnerBanks),
    user: { findMany: async () => [{ id: 42, fullName: 'Người Kiểm Thử', username: 'tester' }] },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'FeeType', version: 1 }) },
    // PHA 2 — engine recalc chạy TRONG tx setFeeRate: đọc tid.findMany({partnerId}) trước. Seed KHÔNG có TID nào của
    // đối tác → recalc short-circuit (scanned 0) TRƯỚC khi chạm transaction/revenueRecalcLog. Vẫn khai đủ shape.
    tid: { findMany: async () => [] },
    transaction: { findMany: async () => [], update: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) },
    revenueRecalcLog: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 1, ...data }) },
    // TOCTOU FIX — setFeeRate gọi tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(...)') ở đầu tx. Db giả
    // KHÔNG chạy Postgres → mock no-op để test lõi in-memory không vỡ (khóa THẬT verify ở test Db-thật cuối file).
    $executeRawUnsafe: async () => 0,
    // deleteFeeRates ĐẾM GD bị kỳ phủ bằng SQL thô trước khi cho xoá (chặn "xoá kỳ đang dùng → recalc rơi về kỳ cũ,
    // tiền lịch sử đổi CÂM"). Fake này KHÔNG có GD nào ⇒ 0 là số ĐÚNG, không phải trả bừa. SQL lạ thì ném lỗi.
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('count(*)::bigint AS n FROM transactions')) return [{ n: 0n }];
      throw new Error('fake fee-config: CHƯA hỗ trợ câu SQL này, bổ sung đi: ' + sql);
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake)
  };
  return { db: fake as unknown as Db, feeTypes, feeRates, feeSellQuotes, partnerBanks, audits };
}

function authUser(permissions: string[], id = 42): AuthUser {
  return { id, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

describe('listFeeTypes / createFeeType', () => {
  it('thiếu quyền → FORBIDDEN nguyên văn', async () => {
    const r = await listFeeTypes({ db: makeFakeDb().db, user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });
  it('tên rỗng → VALIDATION', async () => {
    const r = await createFeeType({ db: makeFakeDb().db, user: authUser(['CONFIG_FEE_MANAGE']) }, { name: '  ' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Tên loại phí bắt buộc.');
  });
  it('trùng tên (active) → DUPLICATE', async () => {
    const r = await createFeeType({ db: makeFakeDb().db, user: authUser(['CONFIG_FEE_MANAGE']) }, { name: 'Ủy quyền' });
    expect(r.error).toBe('DUPLICATE');
    expect(r.message).toBe('Loại phí "Ủy quyền" đã tồn tại.');
  });
  it('hợp lệ → tạo + audit FEE_TYPE_CREATED', async () => {
    const { db, feeTypes, audits } = makeFakeDb();
    const r = await createFeeType({ db, user: authUser(['CONFIG_FEE_MANAGE']) }, { name: 'Tiền nhanh' });
    expect(r.ok).toBe(true);
    expect(feeTypes.some((f) => f['name'] === 'Tiền nhanh' && f['createdBy'] === 42)).toBe(true);
    expect(audits.some((a) => a['action'] === 'FEE_TYPE_CREATED')).toBe(true);
  });
});

describe('updateFeeType / deleteFeeTypes', () => {
  it('update không tồn tại → NOT_FOUND', async () => {
    const r = await updateFeeType({ db: makeFakeDb().db, user: authUser(['CONFIG_FEE_MANAGE']) }, 999, { name: 'X' });
    expect(r.error).toBe('NOT_FOUND');
    expect(r.message).toBe('Loại phí không tồn tại.');
  });
  it('delete chưa chọn → VALIDATION; có id → soft-delete + audit', async () => {
    const { db, feeTypes, audits } = makeFakeDb();
    const bad = await deleteFeeTypes({ db, user: authUser(['CONFIG_FEE_MANAGE']) }, []);
    expect(bad.error).toBe('VALIDATION');
    expect(bad.message).toBe('Chưa chọn loại phí để xóa.');
    const ok = await deleteFeeTypes({ db, user: authUser(['CONFIG_FEE_MANAGE']) }, [1]);
    expect(ok.ok).toBe(true);
    expect(ok.deleted).toBe(1);
    expect(feeTypes[0]!.deletedAt).toBeInstanceOf(Date);
    expect(audits.some((a) => a['action'] === 'FEE_TYPE_DELETED')).toBe(true);
  });
});

describe('setFeeRate', () => {
  const perm = ['CONFIG_FEE_MANAGE', 'CONFIG_FEE_VIEW'];
  it('thiếu đối tác → VALIDATION', async () => {
    const r = await setFeeRate({ db: makeFakeDb().db, user: authUser(perm) }, { partnerId: 0, cardTypeId: 20, phiMua: 1, phiCaiMay: 0, sellQuotes: [{ feeTypeId: 1, phiBan: 2 }] });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Vui lòng chọn đối tác.');
  });
  it('phí quá 3 số thập phân → VALIDATION phí mua', async () => {
    const r = await setFeeRate({ db: makeFakeDb().db, user: authUser(perm) }, { partnerId: 10, cardTypeId: 20, phiMua: 1.2345, phiCaiMay: 0, sellQuotes: [{ feeTypeId: 1, phiBan: 2 }] });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Phí mua không hợp lệ (≥0, tối đa 3 số thập phân).');
  });
  it('phí bán < phí mua → ĐƯỢC PHÉP (bỏ chặn cũ "bán lỗ", src cho phép ≥0 bất kỳ để điều chỉnh được)', async () => {
    const { db, feeSellQuotes } = makeFakeDb();
    const r = await setFeeRate({ db, user: authUser(perm) }, { partnerId: 10, cardTypeId: 20, phiMua: 2, phiCaiMay: 0, sellQuotes: [{ feeTypeId: 1, phiBan: 1 }] });
    expect(r.ok).toBe(true); // KHÔNG còn VALIDATION 'bán lỗ'
    expect(feeSellQuotes[0]!['phiBan']).toBe(1000); // phí bán 1% vẫn ghi được dù < phí mua 2%
  });
  it('ngân hàng chưa liên kết đối tác → NOT_LINKED', async () => {
    const { db, partnerBanks } = makeFakeDb();
    partnerBanks[0]!.deletedAt = new Date(); // gỡ liên kết
    const r = await setFeeRate({ db, user: authUser(perm) }, { partnerId: 10, cardTypeId: 20, phiMua: 1, phiCaiMay: 0, sellQuotes: [{ feeTypeId: 1, phiBan: 2 }] });
    expect(r.error).toBe('NOT_LINKED');
    expect(r.message).toBe('Ngân hàng của loại thẻ này chưa liên kết với đối tác. Hãy liên kết ở mục Đối tác trước.');
  });
  it('hợp lệ → tạo FeeRate (Int ×1000) + FeeSellQuote + audit FEE_RATE_SET; list trả % + isCurrent', async () => {
    const { db, feeRates, feeSellQuotes, audits } = makeFakeDb();
    const ctx: ServiceCtx = { db, user: authUser(perm) };
    const r = await setFeeRate(ctx, { partnerId: 10, cardTypeId: 20, phiMua: 1.5, phiCaiMay: 0.2, effectiveFrom: '2026-01-10', sellQuotes: [{ feeTypeId: 1, phiBan: 2.25 }] });
    expect(r.ok).toBe(true);
    expect(feeRates[0]!['phiMua']).toBe(1500); // ×1000
    expect(feeRates[0]!['phiCaiMay']).toBe(200);
    expect(feeSellQuotes[0]!['phiBan']).toBe(2250);
    expect(audits.some((a) => a['action'] === 'FEE_RATE_SET')).toBe(true);
    const list = await listFeeRates(ctx, {});
    expect(list.ok).toBe(true);
    expect(list.data![0]!.phiMua).toBe(1.5);
    expect(list.data![0]!.clNcc).toBeCloseTo(1.3, 5);
    expect(list.data![0]!.sellQuotes[0]!.phiBan).toBe(2.25);
    expect(list.data![0]!.isCurrent).toBe(true);
  });
  it('upsert CÙNG kỳ (cùng ngày) → cập nhật KHÔNG tạo mới', async () => {
    const { db, feeRates } = makeFakeDb();
    const ctx: ServiceCtx = { db, user: authUser(perm) };
    await setFeeRate(ctx, { partnerId: 10, cardTypeId: 20, phiMua: 1, phiCaiMay: 0, effectiveFrom: '2026-01-10', sellQuotes: [{ feeTypeId: 1, phiBan: 2 }] });
    await setFeeRate(ctx, { partnerId: 10, cardTypeId: 20, phiMua: 1.7, phiCaiMay: 0, effectiveFrom: '2026-01-10', sellQuotes: [{ feeTypeId: 1, phiBan: 3 }] });
    expect(feeRates.length).toBe(1);
    expect(feeRates[0]!['phiMua']).toBe(1700);
  });
});

describe('listSellQuotes', () => {
  it('thiếu đối tác/loại thẻ → VALIDATION', async () => {
    const r = await listSellQuotes({ db: makeFakeDb().db, user: authUser(['CONFIG_FEE_VIEW']) }, 0, 0);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Thiếu đối tác hoặc loại thẻ.');
  });
  it('trả phí bán niêm yết hiệu lực theo loại phí', async () => {
    const { db } = makeFakeDb();
    const ctx: ServiceCtx = { db, user: authUser(['CONFIG_FEE_MANAGE', 'CONFIG_FEE_VIEW']) };
    await setFeeRate(ctx, { partnerId: 10, cardTypeId: 20, phiMua: 1, phiCaiMay: 0, effectiveFrom: '2026-01-05', sellQuotes: [{ feeTypeId: 1, phiBan: 2.5 }] });
    const r = await listSellQuotes(ctx, 10, 20, '2026-02-01');
    expect(r.ok).toBe(true);
    expect(r.data![0]!.feeTypeId).toBe(1);
    expect(r.data![0]!.phiBan).toBe(2.5);
  });
});

describe('deleteFeeRates', () => {
  it('xóa kỳ + phí bán CÙNG kỳ (soft) + audit FEE_RATE_DELETED', async () => {
    const { db, feeRates, feeSellQuotes, audits } = makeFakeDb();
    const ctx: ServiceCtx = { db, user: authUser(['CONFIG_FEE_MANAGE', 'CONFIG_FEE_VIEW']) };
    await setFeeRate(ctx, { partnerId: 10, cardTypeId: 20, phiMua: 1, phiCaiMay: 0, effectiveFrom: '2026-01-10', sellQuotes: [{ feeTypeId: 1, phiBan: 2 }] });
    const rateId = feeRates[0]!.id;
    const r = await deleteFeeRates(ctx, [rateId]);
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(1);
    expect(feeRates[0]!.deletedAt).toBeInstanceOf(Date);
    expect(feeSellQuotes[0]!.deletedAt).toBeInstanceOf(Date);
    expect(audits.some((a) => a['action'] === 'FEE_RATE_DELETED')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// FIX C / Finding-A (Admin Demo 20/8) — REGRESSION khóa hành vi "grandfather KHÔNG abort". Trước fix: 1 GD CŨ ghi bằng
// niêm yết (chưa có giá bán thực tế) rơi vào failed[] → setFeeRate ném RecalcAbortError → REVENUE_RECALC_FAILED,
// HỦY cả lệnh đổi biểu phí (kẹt: không đổi được phí chừng nào còn GD legacy). Sau fix: GD legacy vào grandfathered[]
// (SOFT), setFeeRate THÀNH CÔNG, phí đổi được lưu, GD-có-override tính lại, GD-legacy GIỮ NGUYÊN + surface ra caller.
// Scope setFeeRate = (đối tác × loại thẻ) → phủ CẢ 2 TID (1 no-override legacy + 1 có override) trong 1 lần recalc.
function makeGrandfatherDb() {
  const eff = new Date(2026, 0, 1); // nửa đêm LOCAL — dùng CHUNG cho seed + effectiveFrom setFeeRate (tránh lệch TZ)
  const txnDay = new Date(2026, 2, 1); // 01/03 — sau `eff`, nằm trong [from, +∞)
  const partners: Row[] = [{ id: 10, code: 'DTA', name: 'Đối tác A', deletedAt: null }];
  const cardTypes: Row[] = [{ id: 20, code: 'VISA', name: 'Visa', bankId: 30, deletedAt: null }];
  const feeTypes: Row[] = [{ id: 1, name: 'Ủy quyền', deletedAt: null }];
  const partnerBanks: Row[] = [{ id: 40, partnerId: 10, bankId: 30, deletedAt: null }];
  const tids: Row[] = [
    { id: 1, partnerId: 10, bankId: 30, deletedAt: null }, // legacy — KHÔNG override
    { id: 2, partnerId: 10, bankId: 30, deletedAt: null }  // có override giá bán thực tế
  ];
  const feeRates: Row[] = [{ id: 1, partnerId: 10, cardTypeId: 20, phiMua: 2000, phiCaiMay: 500, effectiveFrom: eff, deletedAt: null }];
  const feeSellQuotes: Row[] = [{ id: 1, partnerId: 10, cardTypeId: 20, feeTypeId: 1, phiBan: 5000, effectiveFrom: eff, deletedAt: null }];
  const tidSellFees: Row[] = [{ id: 1, tidId: 2, cardTypeId: 20, feeTypeId: 1, phiBan: 7000, effectiveFrom: eff, deletedAt: null }]; // chỉ TID 2
  const transactions: Record<string, unknown>[] = [
    // TID 1 (legacy, chỉ niêm yết) — snapshot SENTINEL để dễ kiểm "KHÔNG bị đụng".
    { id: 100, tidId: 1, cardTypeId: 20, feeTypeId: 1, amount: 1_000_000n, txnDate: txnDay, status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 777, sellMarginMilli: 888, revenuePartner: 7770n, revenueSell: 8880n, revenueAmount: 16650n, settled: false, settledAt: null, code: 'GD100' },
    // TID 2 (override 7%) — snapshot STALE → recalc phải cập nhật: sellMargin = 7000 − 500 = 6500.
    { id: 200, tidId: 2, cardTypeId: 20, feeTypeId: 1, amount: 1_000_000n, txnDate: txnDay, status: 'POSTED', deletedAt: null, writtenOffAt: null, partnerMarginMilli: 500, sellMarginMilli: 2500, revenuePartner: 5000n, revenueSell: 25000n, revenueAmount: 30000n, settled: false, settledAt: null, code: 'GD200' }
  ];
  const audits: Record<string, unknown>[] = [];
  const recalcLogs: Record<string, unknown>[] = [];
  let nextId = 1000;

  function model(store: Record<string, unknown>[]) {
    const matchWhere = (r: Record<string, unknown>, w: Record<string, unknown>): boolean =>
      Object.entries(w).every(([k, cond]) => {
        if (cond === undefined) return true;
        if (cond && typeof cond === 'object' && 'in' in (cond as object)) return (cond as { in: unknown[] }).in.includes(r[k]);
        return inRange(r[k], cond);
      });
    return {
      findMany: async (args?: { where?: Record<string, unknown> }) => store.filter((r) => matchWhere(r, args?.where ?? {})).map((r) => ({ ...r })),
      findUnique: async ({ where }: { where: { id: number } }) => { const r = store.find((x) => x['id'] === where.id); return r ? { ...r } : null; },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => { const r = store.find((x) => matchWhere(x, where)); return r ? { ...r } : null; },
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: nextId++, deletedAt: null, ...data }; store.push(row); return { ...row }; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = store.find((x) => x['id'] === where.id)!; Object.assign(r, data); return { ...r }; }
    };
  }

  const fake = {
    partner: model(partners),
    cardType: model(cardTypes),
    feeType: model(feeTypes),
    partnerBank: model(partnerBanks),
    tid: model(tids),
    feeRate: model(feeRates),
    feeSellQuote: model(feeSellQuotes),
    tidSellFee: model(tidSellFees),
    transaction: model(transactions),
    revenueRecalcLog: { create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: recalcLogs.length + 1, ...data }; recalcLogs.push(row); return { ...row }; } },
    cashDebtSettlement: { groupBy: async () => [] }, // không seed settlement → không overpaid/flip
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'FeeRate', version: 1 }) },
    $executeRawUnsafe: async () => 0,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake)
  };
  Object.assign(fake, txnTzRawStub(() => transactions as never, { giaBanThucTe: () => tidSellFees as never }));
  return { db: fake as unknown as Db, feeRates, feeSellQuotes, transactions, audits, recalcLogs, eff };
}

describe('setFeeRate — Finding-A grandfather KHÔNG abort (GD legacy niêm-yết không chặn đổi phí)', () => {
  const perm = ['CONFIG_FEE_MANAGE', 'CONFIG_FEE_VIEW'];
  it('đổi phí THÀNH CÔNG (ok, KHÔNG REVENUE_RECALC_FAILED); GD override tính lại; GD legacy GIỮ NGUYÊN + surface grandfathered[]', async () => {
    const s = makeGrandfatherDb();
    const ctx: ServiceCtx = { db: s.db, user: authUser(perm) };
    // '...T00:00:00' KHÔNG có Z → parse LOCAL = nửa đêm local = `eff` seed (khớp mọi TZ; startOfDayLocal giữ nguyên).
    const r = await setFeeRate(ctx, { partnerId: 10, cardTypeId: 20, phiMua: 2, phiCaiMay: 0.5, effectiveFrom: '2026-01-01T00:00:00', sellQuotes: [{ feeTypeId: 1, phiBan: 5 }] });

    // 1) THÀNH CÔNG — grandfather KHÔNG rollback lệnh đổi phí.
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();

    // 2) Phí đổi ĐÃ LƯU (upsert cùng kỳ → cập nhật tại chỗ, không tạo dòng rác).
    expect(s.feeRates.length).toBe(1);
    expect(s.feeRates[0]!['phiMua']).toBe(2000);
    expect(s.feeRates[0]!['phiCaiMay']).toBe(500);
    expect(s.feeSellQuotes[0]!['phiBan']).toBe(5000);

    // 3) GD-có-override (TID 2) tính lại theo giá THỰC TẾ 7% → sellMargin 6500.
    const t200 = s.transactions.find((t) => t['id'] === 200)!;
    expect(t200['sellMarginMilli']).toBe(6500);
    expect(t200['partnerMarginMilli']).toBe(1500);

    // 4) GD legacy (TID 1, chỉ niêm yết) KHÔNG bị đụng — snapshot SENTINEL giữ nguyên.
    const t100 = s.transactions.find((t) => t['id'] === 100)!;
    expect(t100['sellMarginMilli']).toBe(888);
    expect(t100['partnerMarginMilli']).toBe(777);
    expect(Number(t100['revenueAmount'])).toBe(16650);

    // 5) Surface ra caller (R198 không nuốt): grandfathered[] chứa đúng GD legacy.
    expect(r.grandfathered!.length).toBe(1);
    expect(r.grandfathered![0]!.transactionId).toBe(100);
    expect(r.grandfathered![0]!.error).toBe('NO_ACTUAL_SELL_FEE');

    // 6) Chỉ 1 log recalc (cho GD 200), audit FEE_RATE_SET ghi.
    expect(s.recalcLogs.length).toBe(1);
    expect(s.audits.some((a) => a['action'] === 'FEE_RATE_SET')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// TOCTOU REGRESSION — Db THẬT (throwaway Postgres). Db giả chạy $transaction TUẦN TỰ nên KHÔNG thể chứng minh
// khóa tư vấn cấp-giao-dịch (pg_advisory_xact_lock là no-op trên mock). Test này dựng DB dùng-1-lần thật, migrate
// deploy, rồi CHỨNG MINH (deterministic) rằng setFeeRate LẤY ĐÚNG khóa (910000001, hash(partner,card)) NGAY đầu
// tx: nắm sẵn khóa từ 1 kết nối ngoài → setFeeRate PHẢI TREO; nhả khóa → chạy tiếp. Nếu gỡ khóa khỏi src, test
// FAIL (setFeeRate không treo). Tự BỎ QUA nếu không có Postgres (suite mặc định Postgres-free). Đặt
// SIGMA_TEST_PG_{HOST,PORT,USER,PASSWORD} để trỏ máy chủ khác; mặc định postgres/localhost:5432.
const PG_ADMIN = {
  host: process.env['SIGMA_TEST_PG_HOST'] ?? 'localhost',
  port: Number(process.env['SIGMA_TEST_PG_PORT'] ?? 5432),
  user: process.env['SIGMA_TEST_PG_USER'] ?? 'postgres',
  password: process.env['SIGMA_TEST_PG_PASSWORD'] ?? 'postgres'
};
const FEE_LOCK_NS = 910000001; // PHẢI khớp namespace trong src/fee-config.ts
const testDbName = `alpha_toctou_fee_${process.pid}_${Date.now()}`;
const testDbUrl = `postgresql://${PG_ADMIN.user}:${encodeURIComponent(PG_ADMIN.password)}@${PG_ADMIN.host}:${PG_ADMIN.port}/${testDbName}`;
// ĐỘC LẬP CWD: từ vị trí file test (packages/services/test → ../../.. = repo root), KHÔNG dựa process.cwd()
// (chạy `npm test` từ repo ROOT → cwd=root → ../.. trỏ SAI ngoài repo → execFileSync ENOENT → suite fail giả).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const databaseDir = path.join(repoRoot, 'packages', 'database');
const prismaBin = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');

let realDb: Db | null = null;
let pgAvailable = false;

async function adminExec(sql: string): Promise<void> {
  const c = new pg.Client({ host: PG_ADMIN.host, port: PG_ADMIN.port, user: PG_ADMIN.user, password: PG_ADMIN.password, database: 'postgres' });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

beforeAll(async () => {
  try {
    await adminExec(`CREATE DATABASE "${testDbName}"`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[toctou] Postgres không sẵn — BỎ QUA test đua Db-thật:', e instanceof Error ? e.message : e);
    pgAvailable = false;
    return;
  }
  execFileSync(process.execPath, [prismaBin, 'migrate', 'deploy'], { cwd: databaseDir, env: { ...process.env, DATABASE_URL: testDbUrl }, stdio: 'pipe' });
  realDb = createPrisma(testDbUrl);
  pgAvailable = true;
}, 120_000);

afterAll(async () => {
  if (realDb) await realDb.$disconnect().catch(() => {});
  if (pgAvailable) {
    try {
      await adminExec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${testDbName}' AND pid<>pg_backend_pid()`);
      await adminExec(`DROP DATABASE IF EXISTS "${testDbName}"`);
    } catch { /* best-effort dọn dẹp */ }
  }
}, 60_000);

async function seedFeeBase(db: Db, tag: string): Promise<{ partnerId: number; cardTypeId: number; feeTypeId: number; actorId: number }> {
  const bank = await db.bank.create({ data: { name: 'B', code: 'BK' + tag } });
  const partner = await db.partner.create({ data: { name: 'P', code: 'PT' + tag } });
  const card = await db.cardType.create({ data: { bankId: bank.id, name: 'Visa', code: 'V' } });
  await db.partnerBank.create({ data: { partnerId: partner.id, bankId: bank.id } });
  const ft = await db.feeType.create({ data: { name: 'FT' + tag } });
  const actor = await db.user.create({ data: { fullName: 'Tester', username: 'u' + tag, passwordHash: 'x' } });
  return { partnerId: partner.id, cardTypeId: card.id, feeTypeId: ft.id, actorId: actor.id };
}

describe('setFeeRate — TOCTOU advisory-lock (Db thật)', () => {
  it('LẤY đúng khóa xact (910000001, hash(partner,card)) đầu tx → chặn lời gọi song song rồi nhả', async () => {
    if (!pgAvailable || !realDb) { console.warn('[toctou] skip: no Postgres'); return; }
    const db = realDb;
    const { partnerId, cardTypeId, feeTypeId, actorId } = await seedFeeBase(db, 'a' + Date.now());
    const ctx: ServiceCtx = { db, user: authUser(['CONFIG_FEE_MANAGE', 'CONFIG_FEE_VIEW'], actorId) };
    // objid PHẢI khớp CHÍNH XÁC công thức trong src: ((partnerId & 0xffff) << 16) | (cardTypeId & 0xffff)
    const objid = ((partnerId & 0xffff) << 16) | (cardTypeId & 0xffff);

    const ext = new pg.Client(testDbUrl);
    await ext.connect();
    try {
      // Nắm sẵn CHÍNH XÁC advisory key mà setFeeRate sẽ xin (session-lock xung đột với xact-lock cùng key).
      await ext.query('SELECT pg_advisory_lock($1,$2)', [FEE_LOCK_NS, objid]);
      const p = setFeeRate(ctx, { partnerId, cardTypeId, phiMua: 1, phiCaiMay: 0, effectiveFrom: '2026-02-01', sellQuotes: [{ feeTypeId, phiBan: 5 }] });
      let done = false;
      void p.then(() => (done = true), () => (done = true));
      await new Promise((r) => setTimeout(r, 800));
      expect(done).toBe(false); // BỊ CHẶN — chứng minh src xin đúng key ở đầu tx (gỡ khóa src ⇒ done=true ⇒ FAIL)
      await ext.query('SELECT pg_advisory_unlock($1,$2)', [FEE_LOCK_NS, objid]);
      const r = await p;
      expect(r.ok).toBe(true); // nhả khóa → chạy tiếp sạch
    } finally {
      await ext.end();
    }
    const rows = await db.feeRate.findMany({ where: { partnerId, cardTypeId, deletedAt: null } });
    expect(rows.length).toBe(1);
  }, 30_000);

  it('N lời gọi setFeeRate SONG SONG cùng (partner,card) → 1 kỳ, không lỗi, giá trị cuối nhất quán', async () => {
    if (!pgAvailable || !realDb) { console.warn('[toctou] skip: no Postgres'); return; }
    const db = realDb;
    const { partnerId, cardTypeId, feeTypeId, actorId } = await seedFeeBase(db, 'b' + Date.now());
    const ctx: ServiceCtx = { db, user: authUser(['CONFIG_FEE_MANAGE'], actorId) };
    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        setFeeRate(ctx, { partnerId, cardTypeId, phiMua: 1 + i * 0.001, phiCaiMay: 0, effectiveFrom: '2026-02-01', sellQuotes: [{ feeTypeId, phiBan: 5 }] })
      )
    );
    expect(results.every((r) => r.ok)).toBe(true); // serialize → KHÔNG P2002 unique-violation / deadlock
    const rows = await db.feeRate.findMany({ where: { partnerId, cardTypeId, deletedAt: null } });
    expect(rows.length).toBe(1); // đúng 1 kỳ (không 2 dòng trùng effectiveFrom)
    const quotes = await db.feeSellQuote.findMany({ where: { partnerId, cardTypeId, deletedAt: null } });
    expect(quotes.length).toBe(1);
    // giá trị cuối = MỘT trong các lần ghi (1000..1005 milli) — last-writer-wins nhất quán, không rác.
    expect([1000, 1001, 1002, 1003, 1004, 1005]).toContain(rows[0]!.phiMua);
  }, 30_000);
});
