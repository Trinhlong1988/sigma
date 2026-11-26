// Test LÕI THUẦN investor-report core (@sigma/services, Phase C-1) — Db GIẢ in-memory + ServiceCtx. Kiểm:
//  • doanhThu / soBill / laiNDT gom theo NĐT + join Transaction→Tid→ReceiveAccount→Investor;
//  • tách đã hoàn (settled) vs chưa hoàn;
//  • VD chuẩn 100tr × 0.1% = 100k;
//  • override tid.investFeeMilli THẮNG investFeeMilli mặc định của NĐT;
//  • LOẠI GD CANCELLED / deleted / ngoài-kỳ;
//  • permission gate + validate kỳ.
// BigInt: amount lưu literal `…n` (khớp bài học mock bigint dùng 1000n, KHÔNG number) — chống mock sai shape.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { investorDailyReport, type ServiceCtx } from '../src/index.js';
// Db GIẢ dùng chung — matchWhere là SUPERSET (kèm contains+mode dùng ở bộ lọc HKD) · table · rawStub $queryRawUnsafe.
// Gom về 1 factory (bài học 27/8: raw-SQL migrate làm fake-Db tự-chế thiếu method → test rơi im). Xem _fake-db.ts.
import { table, rawStub, type Rec } from './_fake-db.js';

const VIEW = 'REVENUE_VIEW';
function authUser(permissions: string[]): AuthUser {
  return { id: 7, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

function seedDb() {
  const investors: Rec[] = [
    { id: 1, code: 'INV01', nickname: 'NĐT A', fullName: 'Nguyen A', status: 'ACTIVE', investFeeMilli: 100, deletedAt: null }, // 0.1%
    { id: 2, code: 'INV02', nickname: 'NĐT B', fullName: 'Tran B', status: 'ACTIVE', investFeeMilli: 200, deletedAt: null }, // 0.2%
    { id: 3, code: 'INV03', nickname: 'NĐT C khoá', fullName: 'Le C', status: 'LOCKED', investFeeMilli: 100, deletedAt: null } // KHÔNG ACTIVE → không vào báo cáo "mọi NĐT"
  ];
  const receiveAccounts: Rec[] = [
    { id: 11, investorId: 1, deletedAt: null },
    { id: 12, investorId: 2, deletedAt: null }
  ];
  const tids: Rec[] = [
    { id: 101, receiveAccountId: 11, investFeeMilli: null }, // NĐT A, fallback 0.1%
    { id: 102, receiveAccountId: 11, investFeeMilli: 500 }, // NĐT A, OVERRIDE 0.5% (thắng 0.1%)
    { id: 103, receiveAccountId: 12, investFeeMilli: null } // NĐT B, fallback 0.2%
  ];
  const d = (day: number, month = 7) => new Date(2026, month, day); // month 7 = Tháng 8 (0-based)
  const transactions: Rec[] = [
    { id: 1001, tidId: 101, amount: 100_000_000n, settled: true, status: 'POSTED', deletedAt: null, txnDate: d(10) }, // A · đã hoàn · lãi 100k
    { id: 1002, tidId: 101, amount: 50_000_000n, settled: false, status: 'POSTED', deletedAt: null, txnDate: d(11) }, // A · chưa hoàn · lãi 50k
    { id: 1003, tidId: 102, amount: 100_000_000n, settled: false, status: 'POSTED', deletedAt: null, txnDate: d(12) }, // A · override 0.5% · lãi 500k
    { id: 1004, tidId: 103, amount: 200_000_000n, settled: true, status: 'POSTED', deletedAt: null, txnDate: d(13), phiCaiMayMilli: 1000 }, // B · đã hoàn · phí cài máy 1% → tiền về 198tr × 0.2% = 396k (Admin Demo 31/8: lãi TRÊN TIỀN VỀ, không gross)
    { id: 1005, tidId: 101, amount: 999_000_000n, settled: true, status: 'CANCELLED', deletedAt: null, txnDate: d(14) }, // LOẠI (CANCELLED)
    { id: 1006, tidId: 101, amount: 777_000_000n, settled: true, status: 'POSTED', deletedAt: null, txnDate: d(5, 8) }, // LOẠI (ngoài kỳ — Tháng 9)
    { id: 1007, tidId: 101, amount: 888_000_000n, settled: true, status: 'POSTED', deletedAt: new Date(), txnDate: d(15) } // LOẠI (đã xóa mềm)
  ];
  const fake: Rec = {
    investor: table(investors, true),
    receiveAccount: table(receiveAccounts),
    tid: table(tids),
    transaction: table(transactions),
    // investorDailyReport (fix TZ 27/8) fetch GD qua $queryRawUnsafe raw SQL — rawStub mô phỏng ĐÚNG query đó.
    $queryRawUnsafe: rawStub(transactions)
  };
  return fake;
}
const ctx = (fake: Rec, perms: string[] = [VIEW]): ServiceCtx => ({ db: fake as unknown as Db, user: authUser(perms) });
const KY = { from: '2026-08-01', to: '2026-08-31' };

describe('investorDailyReport — Phase C-1', () => {
  it('thiếu REVENUE_VIEW → FORBIDDEN', async () => {
    const r = await investorDailyReport(ctx(seedDb(), []), KY);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('kỳ sai định dạng → VALIDATION', async () => {
    const r = await investorDailyReport(ctx(seedDb()), { from: '2026-13-40', to: '2026-08-31' });
    expect(r.error).toBe('VALIDATION');
  });

  it('to < from → VALIDATION', async () => {
    const r = await investorDailyReport(ctx(seedDb()), { from: '2026-08-31', to: '2026-08-01' });
    expect(r.error).toBe('VALIDATION');
  });

  it('mọi NĐT ACTIVE: gom đúng doanhThu/soBill/laiNDT + tách đã/chưa hoàn + loại CANCELLED/deleted/ngoài-kỳ', async () => {
    const r = await investorDailyReport(ctx(seedDb()), KY);
    expect(r.ok).toBe(true);
    expect(r.data).toBeDefined();
    // Chỉ 2 NĐT ACTIVE (NĐT C LOCKED không vào).
    expect(r.data!.map((x) => x.code)).toEqual(['INV01', 'INV02']);
    const a = r.data!.find((x) => x.code === 'INV01')!;
    const b = r.data!.find((x) => x.code === 'INV02')!;

    // NĐT A: TX1(100M,đã hoàn,100k) + TX2(50M,chưa,50k) + TX3(100M override0.5%,chưa,500k). CANCELLED/ngoài-kỳ/deleted LOẠI.
    expect(a.doanhThu).toBe(250_000_000);
    expect(a.soBill).toBe(3);
    expect(a.laiNDT).toBe(650_000); // 100k + 50k + 500k
    expect(a.daHoan).toEqual({ doanhThu: 100_000_000, soBill: 1, laiNDT: 100_000 }); // VD chuẩn 100tr×0.1%=100k
    expect(a.chuaHoan).toEqual({ doanhThu: 150_000_000, soBill: 2, laiNDT: 550_000 }); // 50k + 500k(override)
    // tổng = đã + chưa
    expect(a.doanhThu).toBe(a.daHoan.doanhThu + a.chuaHoan.doanhThu);
    expect(a.laiNDT).toBe(a.daHoan.laiNDT + a.chuaHoan.laiNDT);
    expect(a.soBill).toBe(a.daHoan.soBill + a.chuaHoan.soBill);

    // NĐT B: TX4(200M, đã hoàn, 0.2% → 400k).
    expect(b.doanhThu).toBe(200_000_000);
    expect(b.soBill).toBe(1);
    expect(b.laiNDT).toBe(396_000); // Admin Demo 31/8: lãi 0.2% TRÊN TIỀN VỀ = 200tr×(1−1%)×0.2% = 198tr×0.2% = 396k (KHÔNG 400k gross)
    expect(b.daHoan).toEqual({ doanhThu: 200_000_000, soBill: 1, laiNDT: 396_000 });
    expect(b.chuaHoan).toEqual({ doanhThu: 0, soBill: 0, laiNDT: 0 });
  });

  it('override tid.investFeeMilli THẮNG mặc định NĐT (nếu bỏ qua override, lãi A chưa-hoàn = 150k thay vì 550k)', async () => {
    const r = await investorDailyReport(ctx(seedDb()), KY);
    const a = r.data!.find((x) => x.code === 'INV01')!;
    // TX3 = 100tr, override 0.5% → 500k. Nếu dùng nhầm 0.1% của NĐT → 100k → chưa-hoàn lãi = 150k.
    expect(a.chuaHoan.laiNDT).toBe(550_000);
  });

  it('lọc theo 1 investorId → chỉ NĐT đó', async () => {
    const r = await investorDailyReport(ctx(seedDb()), { ...KY, investorId: 2 });
    expect(r.ok).toBe(true);
    expect(r.data!.map((x) => x.code)).toEqual(['INV02']);
    expect(r.data![0].laiNDT).toBe(396_000); // lãi trên TIỀN VỀ (198tr × 0.2%), không gross
  });

  it('VD chuẩn Admin Demo: amount 100_000_000 × 0.1% = 100_000đ (làm tròn nửa lên)', async () => {
    const r = await investorDailyReport(ctx(seedDb()), { ...KY, investorId: 1 });
    const a = r.data![0];
    expect(a.daHoan.laiNDT).toBe(100_000); // GD 100tr settled, fee 0.1%
  });
});

// ── BỘ LỌC (Admin Demo 11/8): 1 NĐT, 2 TID KHÁC bank/HKD/receiveAccount → lọc từng chiều chỉ giữ TID khớp; lọc ngoài
//    phạm vi (hoặc TK không thuộc uỷ NĐT) → tập rỗng → doanhThu/lãi = 0 (KHÔNG lỗi). GIỮ scope Phase D. ──
function seedFilterDb() {
  const investors: Rec[] = [
    { id: 1, code: 'INV01', nickname: 'NĐT A', fullName: 'Nguyen A', status: 'ACTIVE', investFeeMilli: 100, deletedAt: null } // 0.1%
  ];
  const receiveAccounts: Rec[] = [
    { id: 11, investorId: 1, deletedAt: null }, // uỷ NĐT 1
    { id: 12, investorId: 1, deletedAt: null } // uỷ NĐT 1 (TK thứ 2)
  ];
  // 2 TID cùng NĐT nhưng KHÁC receiveAccount + bank + HKD.
  const tids: Rec[] = [
    { id: 201, receiveAccountId: 11, bankId: 501, hkdName: 'HKD SigMa', investFeeMilli: null }, // → 100tr
    { id: 202, receiveAccountId: 12, bankId: 502, hkdName: 'HKD Beta', investFeeMilli: null } // → 200tr
  ];
  const d = (day: number) => new Date(2026, 7, day); // Tháng 8 (0-based 7)
  const transactions: Rec[] = [
    { id: 3001, tidId: 201, amount: 100_000_000n, settled: true, status: 'POSTED', deletedAt: null, txnDate: d(10), phiCaiMayMilli: 0 }, // lãi 100k
    { id: 3002, tidId: 202, amount: 200_000_000n, settled: true, status: 'POSTED', deletedAt: null, txnDate: d(11), phiCaiMayMilli: 0 } // lãi 200k
  ];
  return {
    investor: table(investors, true),
    receiveAccount: table(receiveAccounts),
    tid: table(tids),
    transaction: table(transactions),
    // `tids` cho nhánh TÌM KIẾM thô: bộ lọc hkdName nay chạy qua lower(COLLATE ICU) vì collation DB là "C"
    // (xem src/tim-kiem-hoa-thuong.ts) — Db giả phải mô phỏng đúng câu SQL đó, không thì bộ lọc bị bỏ qua.
    $queryRawUnsafe: rawStub(transactions, [], { tids })
  } as Rec;
}

describe('investorDailyReport — BỘ LỌC TID (Admin Demo 11/8)', () => {
  const only = (r: Awaited<ReturnType<typeof investorDailyReport>>) => r.data![0];

  it('KHÔNG lọc → gộp cả 2 TID (300tr, lãi 300k)', async () => {
    const a = only(await investorDailyReport(ctx(seedFilterDb()), KY));
    expect(a.doanhThu).toBe(300_000_000);
    expect(a.laiNDT).toBe(300_000);
    expect(a.soBill).toBe(2);
  });

  it('lọc theo receiveAccountId=11 → chỉ TID 201 (100tr, lãi 100k)', async () => {
    const a = only(await investorDailyReport(ctx(seedFilterDb()), { ...KY, receiveAccountId: 11 }));
    expect(a.doanhThu).toBe(100_000_000);
    expect(a.laiNDT).toBe(100_000);
    expect(a.soBill).toBe(1);
  });

  it('lọc theo bankId=502 → chỉ TID 202 (200tr, lãi 200k)', async () => {
    const a = only(await investorDailyReport(ctx(seedFilterDb()), { ...KY, bankId: 502 }));
    expect(a.doanhThu).toBe(200_000_000);
    expect(a.laiNDT).toBe(200_000);
    expect(a.soBill).toBe(1);
  });

  it('lọc theo tidId=201 → chỉ TID 201 (100tr)', async () => {
    const a = only(await investorDailyReport(ctx(seedFilterDb()), { ...KY, tidId: 201 }));
    expect(a.doanhThu).toBe(100_000_000);
    expect(a.soBill).toBe(1);
  });

  it('lọc theo hkdName="beta" (không phân biệt hoa/thường) → chỉ TID 202 (200tr)', async () => {
    const a = only(await investorDailyReport(ctx(seedFilterDb()), { ...KY, hkdName: 'beta' }));
    expect(a.doanhThu).toBe(200_000_000);
    expect(a.soBill).toBe(1);
  });

  it('lọc kết hợp bankId=501 + hkdName="alpha" → chỉ TID 201', async () => {
    const a = only(await investorDailyReport(ctx(seedFilterDb()), { ...KY, bankId: 501, hkdName: 'alpha' }));
    expect(a.doanhThu).toBe(100_000_000);
    expect(a.soBill).toBe(1);
  });

  it('lọc rỗng tập (receiveAccountId ngoài uỷ NĐT) → 0, KHÔNG lỗi + NĐT vẫn hiện khung', async () => {
    const r = await investorDailyReport(ctx(seedFilterDb()), { ...KY, receiveAccountId: 999 });
    expect(r.ok).toBe(true);
    const a = r.data![0];
    expect(a.doanhThu).toBe(0);
    expect(a.laiNDT).toBe(0);
    expect(a.soBill).toBe(0);
  });

  it('lọc rỗng tập (bankId không TID nào khớp) → 0', async () => {
    const a = only(await investorDailyReport(ctx(seedFilterDb()), { ...KY, bankId: 999 }));
    expect(a.doanhThu).toBe(0);
    expect(a.soBill).toBe(0);
  });
});
