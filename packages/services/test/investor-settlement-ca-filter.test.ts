// [Agent-4 phản biện 11/9 — BUG LỌC CA NUỐT CÂM Ở TẤT TOÁN] Route /v1/me/investor-settlement truyền
// `...parseFilters(req)` (gồm `ca` 1/2/3) NHƯNG investorDailySettlement KHÔNG forward `ca` xuống
// investorDailyReport → cùng 1 màn InvestorRevenueScreen: bảng report LỌC ca, hàng tất toán (tamUng/tienVe/
// phaiTra/doanhThu) KHÔNG lọc → 2 số cùng NĐT cùng màn MÂU THUẪN, user tưởng phaiTra đã theo ca.
// Lớp bug: field mapper vứt câm (như bug OCR field bị drop). Test đối chiếu 2 NGUỒN cùng kỳ cùng filter:
// settlement.doanhThu PHẢI = report.doanhThu khi cùng ca — lệch 1 đồng cũng fail.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { investorDailySettlement, investorDailyReport, type ServiceCtx } from '../src/index.js';
import { table, type Rec } from './_fake-db.js';

function authUser(): AuthUser {
  return { id: 7, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions: ['INVESTOR_VIEW', 'REVENUE_VIEW'] };
}
const d = (day: number) => new Date(2026, 7, day); // Tháng 8/2026 local

function seedDb() {
  const investors: Rec[] = [
    { id: 1, code: 'INV01', nickname: 'NĐT A', fullName: 'Nguyen A', status: 'ACTIVE', investFeeMilli: 100, deletedAt: null }
  ];
  const receiveAccounts: Rec[] = [{ id: 11, investorId: 1, deletedAt: null }];
  // TID gắn ngân hàng MB (id 5) — ca MB: ca1 ≤ 09:40 (phút 580), ca3 > 16:40 (phút 1000).
  const tids: Rec[] = [{ id: 101, receiveAccountId: 11, investFeeMilli: null, bankId: 5 }];
  const banks: Rec[] = [{ id: 5, name: 'MB' }];
  // 2 GD cùng TID, cùng ngày, KHÁC ca (phutHcm = giờ tổng kết bill HCM):
  //   GD1 100tr @08:20 (phút 500) → CA 1 · GD2 40tr @20:00 (phút 1200) → CA 3.
  const transactions: Rec[] = [
    { id: 1001, tidId: 101, amount: 100_000_000n, phiCaiMayMilli: 0, settled: false, status: 'POSTED', deletedAt: null, txnDate: d(10), phutHcm: 500 },
    { id: 1002, tidId: 101, amount: 40_000_000n, phiCaiMayMilli: 0, settled: false, status: 'POSTED', deletedAt: null, txnDate: d(10), phutHcm: 1200 }
  ];
  const rawStubCa = async (sql: string, ...params: unknown[]) => {
    // [KẾ TOÁN NĐT 24/11 — L15] resolveScopeInvestorId: fake không khóa phạm vi → scope null (giữ hành vi cũ).
    if (sql.includes('scope_investor_id')) return [{ scope_investor_id: null }];
    if (sql.includes('investor_advances')) return []; // không tạm ứng/hoàn trong test này
    const tidIds = params[0] as number[];
    const start = new Date(params[1] as string).getTime();
    const end = new Date(params[2] as string).getTime();
    return transactions
      .filter((t) => t['status'] === 'POSTED' && t['deletedAt'] == null && tidIds.includes(t['tidId'] as number)
        && (t['txnDate'] as Date).getTime() >= start && (t['txnDate'] as Date).getTime() < end)
      .map((t) => ({
        tidId: t['tidId'], amount: t['amount'], settled: t['settled'],
        phiCaiMayMilli: (t['phiCaiMayMilli'] as number | undefined) ?? null,
        txnDate: t['txnDate'] ?? null,
        txnIso: (t['txnDate'] as Date).toISOString(),
        installFeeAmount: 0n,
        phutHcm: t['phutHcm'] // giờ bill thật (los.bill_txn_date) — báo cáo lọc ca theo cột này
      }));
  };
  return {
    investor: table(investors, true),
    receiveAccount: table(receiveAccounts),
    tid: table(tids),
    bank: table(banks),
    transaction: table(transactions),
    investorAdvance: table([]),
    $queryRawUnsafe: rawStubCa
  } as unknown as Db;
}
const ctx = (db: Db): ServiceCtx => ({ db, user: authUser() });
const KY = { from: '2026-08-01', to: '2026-08-31' };

describe('investorDailySettlement — forward lọc CA xuống report (chống nuốt câm filter)', () => {
  it('SANITY: report lọc ca=1 chỉ còn GD 08:20 → doanhThu 100tr (path ca của report hoạt động)', async () => {
    const db = seedDb();
    const rep = await investorDailyReport(ctx(db), { ...KY, ca: 1 });
    expect(rep.ok).toBe(true);
    expect(rep.data![0].doanhThu).toBe(100_000_000);
    const repAll = await investorDailyReport(ctx(db), { ...KY });
    expect(repAll.data![0].doanhThu).toBe(140_000_000); // không lọc = đủ 2 GD
  });

  it('ĐỐI CHIẾU 2 NGUỒN: settlement(ca=1) PHẢI khớp report(ca=1) — doanhThu/tienVe chỉ gồm GD ca 1', async () => {
    const db = seedDb();
    const st = await investorDailySettlement(ctx(db), { ...KY, ca: 1 });
    expect(st.ok).toBe(true);
    const row = st.data!.find((x) => x.investorId === 1)!;
    // TRƯỚC FIX: settlement drop `ca` → doanhThu 140tr (lệch 40tr so với bảng report cùng màn).
    expect(row.doanhThu).toBe(100_000_000);
    expect(row.tienVe).toBe(100_000_000); // phí cài máy 0 → tiền về = gross của GD ca 1
    // phaiTra = (tamUng 0 − tienVe) + lãi − đã hoàn; lãi 0.1% trên tiền về 100tr = 100.000
    expect(row.laiNDT).toBe(100_000);
    expect(row.phaiTra).toBe(0 - 100_000_000 + 100_000);
  });

  it('settlement(ca=3) → chỉ GD 20:00 (40tr)', async () => {
    const db = seedDb();
    const st = await investorDailySettlement(ctx(db), { ...KY, ca: 3 });
    expect(st.ok).toBe(true);
    expect(st.data![0].doanhThu).toBe(40_000_000);
  });
});
