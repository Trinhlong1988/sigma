// Test MỐC CHỐT / CLEAR NĐT (Admin Demo 1/9, @sigma/services) — dữ liệu TRƯỚC ngày chốt = đã tất toán → KHÔNG tính vào
// doanh thu / tạm ứng / hoàn / phải-trả hiện tại, NHƯNG GIỮ nguyên trong DB (chỉ cắt khỏi tổng). Lưu app_settings JSON.
// Kiểm:
//  (1) loadInvestorCutoffs parse JSON {id:'YYYY-MM-DD'} → Map local-midnight; env không có app_settings → Map rỗng.
//  (2) isBeforeCutoff: nửa-mở (đúng ngày chốt = GIỮ; trước = loại; không mốc/không ngày = giữ).
//  (3) sumAdvancesByInvestors / sumRepaymentsByInvestors LOẠI dòng trước mốc.
//  (4) investorDailySettlement (doanh thu + tạm ứng) áp mốc: GD/ứng trước mốc biến mất, từ mốc trở đi giữ.
//  (5) setInvestorClearCutoff: gate quyền + ghi/gỡ app_settings.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  loadInvestorCutoffs, isBeforeCutoff, setInvestorClearCutoff, listInvestorCutoffs,
  sumAdvancesByInvestors, sumRepaymentsByInvestors, investorDailySettlement, type ServiceCtx
} from '../src/index.js';
import { table, rawStub, type Rec } from './_fake-db.js';

const REVENUE = 'REVENUE_VIEW';
function authUser(perms: string[]): AuthUser {
  return { id: 7, username: 't', fullName: 'T', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions: perms };
}
const d = (day: number, month = 7) => new Date(2026, month, day); // month 7 = Tháng 8 (0-based)

// app_settings GIẢ in-memory (findUnique + upsert) — đủ cho loadInvestorCutoffs/setInvestorClearCutoff.
function appSettingStore(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    findUnique: async (a: { where: { key: string } }) => (m.has(a.where.key) ? { key: a.where.key, value: m.get(a.where.key)! } : null),
    upsert: async (a: { where: { key: string }; update: { value: string }; create: { value: string } }) => {
      m.set(a.where.key, a.update?.value ?? a.create.value); return { key: a.where.key, value: m.get(a.where.key)! };
    },
    _map: m
  };
}
const noAudit = { auditLog: { create: async () => ({}) }, changeToken: { upsert: async () => ({}) } };

// 1 NĐT (id 1, phí đầu tư 0.1%), phí cài máy 0. GD + tạm ứng RẢI 2 phía mốc 15/8:
//  • 10/8 (TRƯỚC mốc): doanh thu 100tr, tạm ứng 500tr, hoàn 200tr → PHẢI bị loại khi mốc=15/8.
//  • 20/8 (TỪ mốc):    doanh thu 300tr, tạm ứng 100tr, hoàn 0    → GIỮ.
function seed(cutoffJson?: string) {
  const investors: Rec[] = [{ id: 1, code: 'INV01', nickname: 'A', fullName: 'A', status: 'ACTIVE', investFeeMilli: 100, settleFeeMilli: 0, deletedAt: null }];
  const receiveAccounts: Rec[] = [{ id: 11, investorId: 1, deletedAt: null }];
  const tids: Rec[] = [{ id: 101, receiveAccountId: 11, investFeeMilli: null }];
  const transactions: Rec[] = [
    { id: 1001, tidId: 101, amount: 100_000_000n, phiCaiMayMilli: 0, settled: true, status: 'POSTED', deletedAt: null, txnDate: d(10) }, // trước mốc
    { id: 1002, tidId: 101, amount: 300_000_000n, phiCaiMayMilli: 0, settled: true, status: 'POSTED', deletedAt: null, txnDate: d(20) }  // từ mốc
  ];
  const investorAdvances: Rec[] = [
    { id: 2001, investorId: 1, amount: 500_000_000n, advanceDate: d(10), source: 'OCR', deletedAt: null },       // trước mốc
    { id: 2002, investorId: 1, amount: 100_000_000n, advanceDate: d(20), source: 'OCR', deletedAt: null },       // từ mốc
    { id: 2003, investorId: 1, amount: 200_000_000n, advanceDate: d(10), source: 'REPAYMENT', deletedAt: null }  // hoàn trước mốc
  ];
  const app = appSettingStore(cutoffJson ? { 'investor.clearCutoffs': cutoffJson } : {});
  const fake: Rec = {
    investor: table(investors, true), receiveAccount: table(receiveAccounts), tid: table(tids),
    transaction: table(transactions), investorAdvance: table(investorAdvances),
    appSetting: app, ...noAudit, $queryRawUnsafe: rawStub(transactions, investorAdvances)
  };
  return { fake, app };
}
const ctx = (fake: Rec, perms = [REVENUE, 'INVESTOR_VIEW', 'INVESTOR_UPDATE']): ServiceCtx => ({ db: fake as unknown as Db, user: authUser(perms) });
const KY = { from: '2026-08-01', to: '2026-08-31', investorId: 1 };

describe('loadInvestorCutoffs + isBeforeCutoff', () => {
  it('env không có app_settings → Map rỗng (không cutoff, giữ hành vi cũ)', async () => {
    const map = await loadInvestorCutoffs({} as unknown as Db);
    expect(map.size).toBe(0);
  });
  it('parse JSON → Map local-midnight; isBeforeCutoff nửa-mở (đúng ngày = giữ)', async () => {
    const { fake } = seed('{"1":"2026-08-15"}');
    const map = await loadInvestorCutoffs(fake as unknown as Db);
    expect(map.get(1)?.getTime()).toBe(new Date(2026, 7, 15).getTime());
    expect(isBeforeCutoff(map, 1, d(14))).toBe(true);   // trước → loại
    expect(isBeforeCutoff(map, 1, d(15))).toBe(false);  // đúng ngày chốt → GIỮ (tính từ ngày chốt)
    expect(isBeforeCutoff(map, 1, d(20))).toBe(false);  // sau → giữ
    expect(isBeforeCutoff(map, 2, d(1))).toBe(false);   // NĐT không mốc → giữ
    expect(isBeforeCutoff(map, 1, null)).toBe(false);   // không ngày → giữ
  });
});

describe('sum functions áp mốc chốt', () => {
  it('KHÔNG mốc → tính cả 2 dòng ứng (600tr) + hoàn (200tr)', async () => {
    const { fake } = seed();
    const a = await sumAdvancesByInvestors(ctx(fake), { investorIds: [1] });
    const r = await sumRepaymentsByInvestors(ctx(fake), { investorIds: [1] });
    expect(a.totals!.get(1)).toBe(600_000_000n);
    expect(r.totals!.get(1)).toBe(200_000_000n);
  });
  it('mốc 15/8 → LOẠI dòng 10/8: tạm ứng chỉ còn 100tr, hoàn còn 0', async () => {
    const { fake } = seed('{"1":"2026-08-15"}');
    const a = await sumAdvancesByInvestors(ctx(fake), { investorIds: [1] });
    const r = await sumRepaymentsByInvestors(ctx(fake), { investorIds: [1] });
    expect(a.totals!.get(1)).toBe(100_000_000n); // chỉ 20/8
    expect(r.totals!.get(1)).toBe(0n);           // hoàn 10/8 bị loại
  });
});

describe('investorDailySettlement áp mốc chốt (doanh thu + tạm ứng cùng cắt)', () => {
  it('KHÔNG mốc: doanh thu 400tr, tạm ứng 600tr, đã hoàn 200tr', async () => {
    const { fake } = seed();
    const s = await investorDailySettlement(ctx(fake), KY);
    const row = s.data![0];
    expect(row.doanhThu).toBe(400_000_000);
    expect(row.tamUng).toBe(600_000_000);
    expect(row.daHoan).toBe(200_000_000);
    // phải trả = tạm ứng − tiền về + lãi − đã hoàn = 600tr − 400tr(phí cài 0) + 400k(0.1%×400tr) − 200tr = 400.000
    expect(row.phaiTra).toBe(400_000);
    expect(row.phaiTra).toBe(row.tamUng - row.tienVe + row.laiNDT - row.daHoan);
  });
  it('mốc 15/8: chỉ còn 20/8 → doanh thu 300tr, tạm ứng 100tr, đã hoàn 0', async () => {
    const { fake } = seed('{"1":"2026-08-15"}');
    const s = await investorDailySettlement(ctx(fake), KY);
    const row = s.data![0];
    expect(row.doanhThu).toBe(300_000_000);
    expect(row.tamUng).toBe(100_000_000);
    expect(row.daHoan).toBe(0);
    // phải trả = 100tr − 300tr(tiền về) + lãi(0.1%×300tr=300k) − 0 = −199.700.000 (giữ dấu)
    expect(row.phaiTra).toBe(-199_700_000);
    expect(row.phaiTra).toBe(row.tamUng - row.tienVe + row.laiNDT - row.daHoan);
  });
});

describe('setInvestorClearCutoff', () => {
  it('thiếu quyền → FORBIDDEN', async () => {
    const { fake } = seed();
    const r = await setInvestorClearCutoff(ctx(fake, []), 1, '2026-08-30');
    expect(r.error).toBe('FORBIDDEN');
  });
  it('ngày sai định dạng → VALIDATION', async () => {
    const { fake } = seed();
    const r = await setInvestorClearCutoff(ctx(fake), 1, '30-08-2026');
    expect(r.error).toBe('VALIDATION');
  });
  it('đặt rồi gỡ (day=null) → app_settings phản ánh; listInvestorCutoffs khớp', async () => {
    const { fake, app } = seed();
    expect((await setInvestorClearCutoff(ctx(fake), 1, '2026-08-30')).ok).toBe(true);
    expect(JSON.parse(app._map.get('investor.clearCutoffs')!)).toEqual({ '1': '2026-08-30' });
    const list = await listInvestorCutoffs(ctx(fake));
    expect(list.data).toEqual([{ investorId: 1, day: '2026-08-30' }]);
    expect((await setInvestorClearCutoff(ctx(fake), 1, null)).ok).toBe(true);
    expect(JSON.parse(app._map.get('investor.clearCutoffs')!)).toEqual({});
  });
});
