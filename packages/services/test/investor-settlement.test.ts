// Test LÕI THUẦN investor-settlement core (@sigma/services, Phase C-2b; phí cài máy THEO TID 11/8) — Db GIẢ + ServiceCtx. Kiểm:
//  • tienVe = Σ PER-TXN FLOOR(amount × (100000 − txn.phiCaiMayMilli)/100000) — phí cài máy chốt TRÊN TỪNG GD (theo TID),
//    KHÔNG dùng investor.settleFeeMilli. VD TID A phí 1.06% (1060), GD 100tr → tiền về 98.940.000; GD cùng NĐT khác
//    phí (2000) chứng minh tính PER-TXN, không phải 1 % chung cho NĐT.
//  • phaiTra = (Σ tạm ứng − tiền về) + lãi, GIỮ DẤU (ca ÂM khi tiền về + lãi > tạm ứng);
//  • Σ tạm ứng loại soft-deleted + ngoài-kỳ (tái dùng sumAdvancesByInvestors);
//  • FLOOR (không round) khi phép chia có dư;
//  • permission gate INVESTOR_VIEW.
// BigInt: amount seed literal `…n` (bài học mock bigint dùng 1000n, KHÔNG number) — chống mock sai shape.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { investorDailySettlement, type ServiceCtx } from '../src/index.js';
// Db GIẢ dùng chung (matchWhere in/not/gte/lt + guard Date · table · rawStub $queryRawUnsafe) — gom về 1 factory
// (bài học 27/8: raw-SQL migrate làm fake-Db tự-chế thiếu method → test rơi im). Xem _fake-db.ts.
import { table, rawStub, type Rec } from './_fake-db.js';

const VIEW = 'INVESTOR_VIEW';
const REVENUE = 'REVENUE_VIEW'; // report bên trong gate REVENUE_VIEW → user tất toán cần cả 2.
function authUser(permissions: string[]): AuthUser {
  return { id: 7, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

const d = (day: number, month = 7) => new Date(2026, month, day); // month 7 = Tháng 8 (0-based)

function seedDb() {
  const investors: Rec[] = [
    // INV01: phí đầu tư 0.1%. INV02: 0.2%. settleFeeMilli đặt CỐ TÌNH LỆCH (9999) để chứng minh KHÔNG được dùng
    // (tiền về giờ theo txn.phiCaiMayMilli của TID, không phải %phí cài máy trên NĐT).
    { id: 1, code: 'INV01', nickname: 'NĐT A', fullName: 'Nguyen A', status: 'ACTIVE', investFeeMilli: 100, settleFeeMilli: 9999, deletedAt: null },
    { id: 2, code: 'INV02', nickname: 'NĐT B', fullName: 'Tran B', status: 'ACTIVE', investFeeMilli: 200, settleFeeMilli: 9999, deletedAt: null }
  ];
  const receiveAccounts: Rec[] = [
    { id: 11, investorId: 1, deletedAt: null },
    { id: 12, investorId: 2, deletedAt: null }
  ];
  const tids: Rec[] = [
    { id: 101, receiveAccountId: 11, investFeeMilli: null }, // A, fallback 0.1%
    { id: 102, receiveAccountId: 11, investFeeMilli: 500 }, // A, override 0.5%
    { id: 103, receiveAccountId: 12, investFeeMilli: null } // B, fallback 0.2%
  ];
  // Doanh thu (khớp investor-report.test): A = 100tr+50tr+100tr = 250tr; B = 200tr. LÃI TÍNH TRÊN TIỀN VỀ (Admin Demo
  // 31/8: 0,1% × (amount − phí cài máy), KHÔNG trên gross): A = 98.940+49.470+490.000 = 638.410; B (phí 0 → tv=gross) = 400k.
  // phiCaiMayMilli CHỐT trên từng GD (theo TID lúc tạo): A có 2 mức KHÁC NHAU (1060 & 2000) → chứng minh PER-TXN.
  const transactions: Rec[] = [
    { id: 1001, tidId: 101, amount: 100_000_000n, phiCaiMayMilli: 1060, settled: true, status: 'POSTED', deletedAt: null, txnDate: d(10) }, // tiền về 98.940.000
    { id: 1002, tidId: 101, amount: 50_000_000n, phiCaiMayMilli: 1060, settled: false, status: 'POSTED', deletedAt: null, txnDate: d(11) }, // 49.470.000
    { id: 1003, tidId: 102, amount: 100_000_000n, phiCaiMayMilli: 2000, settled: false, status: 'POSTED', deletedAt: null, txnDate: d(12) }, // 98.000.000
    { id: 1004, tidId: 103, amount: 200_000_000n, phiCaiMayMilli: 0, settled: true, status: 'POSTED', deletedAt: null, txnDate: d(13) } // 200.000.000
  ];
  const investorAdvances: Rec[] = [
    { id: 2001, investorId: 1, amount: 100_000_000n, advanceDate: d(10), deletedAt: null }, // A trong kỳ
    { id: 2002, investorId: 1, amount: 999_000_000n, advanceDate: d(10), deletedAt: new Date() }, // A ĐÃ XÓA → loại
    { id: 2003, investorId: 1, amount: 777_000_000n, advanceDate: d(5, 8), deletedAt: null }, // A ngoài kỳ (Th9) → loại
    { id: 2004, investorId: 2, amount: 500_000_000n, advanceDate: d(11), deletedAt: null } // B trong kỳ
  ];
  const fake: Rec = {
    investor: table(investors, true),
    receiveAccount: table(receiveAccounts),
    tid: table(tids),
    transaction: table(transactions),
    investorAdvance: table(investorAdvances),
    $queryRawUnsafe: rawStub(transactions, investorAdvances)
  };
  return fake;
}
const ctx = (fake: Rec, perms: string[] = [VIEW, REVENUE]): ServiceCtx => ({ db: fake as unknown as Db, user: authUser(perms) });
const KY = { from: '2026-08-01', to: '2026-08-31' };

describe('investorDailySettlement — Phase C-2b (tất toán ngày)', () => {
  it('thiếu INVESTOR_VIEW → FORBIDDEN', async () => {
    const r = await investorDailySettlement(ctx(seedDb(), []), KY);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('VD số cụ thể: tiền về = Σ per-txn FLOOR(amount×(1−phí cài máy TID)) + phải trả GIỮ DẤU (A âm, B dương)', async () => {
    const r = await investorDailySettlement(ctx(seedDb()), KY);
    expect(r.ok).toBe(true);
    expect(r.data).toBeDefined();
    const a = r.data!.find((x) => x.code === 'INV01')!;
    const b = r.data!.find((x) => x.code === 'INV02')!;

    // NĐT A: doanhThu 250tr. Tiền về PER-TXN theo phí cài máy của TID (KHÔNG dùng settleFeeMilli=9999):
    //   100tr×98940/100000=98.940.000 + 50tr×98940/100000=49.470.000 + 100tr×98000/100000=98.000.000 = 246.410.000.
    //   LÃI trên TIỀN VỀ (31/8): 98.940 + 49.470 + 490.000 = 638.410 (KHÔNG phải 650k trên gross).
    expect(a.doanhThu).toBe(250_000_000);
    expect(a.laiNDT).toBe(638_410);
    expect(a).not.toHaveProperty('settleFeePct'); // field đã BỎ khỏi row tất toán
    expect(a.tamUng).toBe(100_000_000); // chỉ dòng ứng trong-kỳ, chưa xóa (loại 999tr đã xóa + 777tr ngoài kỳ)
    expect(a.tienVe).toBe(246_410_000);
    expect(a.daHoan).toBe(0); // A không có dòng REPAYMENT
    // phải trả = (đã ứng − tiền về) + lãi − đã hoàn = (100tr − 246.41tr) + 638.410 − 0 = −145.771.590 (ÂM, KHÔNG kẹp 0).
    expect(a.phaiTra).toBe(-145_771_590);
    expect(a.phaiTra).toBe(a.tamUng - a.tienVe + a.laiNDT - a.daHoan);

    // NĐT B: doanhThu 200tr, GD phí cài máy 0% → tiền về = 200tr. đã ứng 500tr. lãi 400k.
    expect(b.doanhThu).toBe(200_000_000);
    expect(b.tienVe).toBe(200_000_000);
    expect(b.tamUng).toBe(500_000_000);
    expect(b.daHoan).toBe(0);
    expect(b.phaiTra).toBe(300_400_000); // (500tr − 200tr) + 400k − 0
    expect(b.phaiTra).toBe(b.tamUng - b.tienVe + b.laiNDT - b.daHoan);
  });

  it('lọc theo 1 investorId → chỉ NĐT đó', async () => {
    const r = await investorDailySettlement(ctx(seedDb()), { ...KY, investorId: 2 });
    expect(r.ok).toBe(true);
    expect(r.data!.map((x) => x.code)).toEqual(['INV02']);
    expect(r.data![0].tienVe).toBe(200_000_000);
  });

  it('tiền về LÀM TRÒN XUỐNG (FLOOR, không round) khi phép chia có dư', async () => {
    // 1 NĐT, 1 GD 33.333.333đ, phí đầu tư 0% (lãi 0), phí cài máy TID 1.06% (1060, chốt trên GD).
    // 33.333.333 × 98940 / 100000 = 32.979.999,67… → FLOOR 32.979.999 (round sẽ ra 32.980.000).
    const investors: Rec[] = [{ id: 5, code: 'INV05', nickname: 'NĐT F', fullName: 'F', status: 'ACTIVE', investFeeMilli: 0, settleFeeMilli: 0, deletedAt: null }];
    const receiveAccounts: Rec[] = [{ id: 55, investorId: 5, deletedAt: null }];
    const tids: Rec[] = [{ id: 505, receiveAccountId: 55, investFeeMilli: null }];
    const transactions: Rec[] = [{ id: 5001, tidId: 505, amount: 33_333_333n, phiCaiMayMilli: 1060, settled: true, status: 'POSTED', deletedAt: null, txnDate: d(10) }];
    const fake: Rec = {
      investor: table(investors, true),
      receiveAccount: table(receiveAccounts),
      tid: table(tids),
      transaction: table(transactions),
      investorAdvance: table([]),
      $queryRawUnsafe: rawStub(transactions, [])
    };
    const r = await investorDailySettlement(ctx(fake), KY);
    const f = r.data!.find((x) => x.code === 'INV05')!;
    expect(f.doanhThu).toBe(33_333_333);
    expect(f.laiNDT).toBe(0);
    expect(f.tienVe).toBe(32_979_999); // FLOOR (không phải 32.980.000)
    expect(f.tamUng).toBe(0);
    expect(f.phaiTra).toBe(-32_979_999); // (0 − 32.979.999) + 0
  });

  // HƯỚNG-4 (Admin Demo 31/8 phương án B): SigMa hoàn thừa tạm ứng = source='REPAYMENT'. Tạm ứng GIỮ GROSS (loại
  // REPAYMENT khỏi sumAdvances) · đã hoàn gom riêng · phải trả = (tạm ứng − tiền về) + lãi − ĐÃ HOÀN (GIỮ DẤU).
  it('ĐÃ HOÀN (REPAYMENT) TRỪ vào phải trả, KHÔNG cộng vào tạm ứng (gross)', async () => {
    // 1 NĐT, phí đầu tư 0 (lãi 0), phí cài máy 0 (tiền về = doanh thu). Doanh thu 100tr. Tạm ứng 3 tỷ (2 dòng ứng).
    // SigMa hoàn 1 tỷ (REPAYMENT). Kỳ vọng: tạm ứng 3 tỷ (KHÔNG bị −1 tỷ), đã hoàn 1 tỷ, phải trả = 3tỷ−100tr−1tỷ.
    const investors: Rec[] = [{ id: 9, code: 'INV09', nickname: 'NĐT H', fullName: 'H', status: 'ACTIVE', investFeeMilli: 0, settleFeeMilli: 0, deletedAt: null }];
    const receiveAccounts: Rec[] = [{ id: 99, investorId: 9, deletedAt: null }];
    const tids: Rec[] = [{ id: 909, receiveAccountId: 99, investFeeMilli: null }];
    const transactions: Rec[] = [{ id: 9001, tidId: 909, amount: 100_000_000n, phiCaiMayMilli: 0, settled: true, status: 'POSTED', deletedAt: null, txnDate: d(10) }];
    const investorAdvances: Rec[] = [
      { id: 9101, investorId: 9, amount: 2_000_000_000n, advanceDate: d(10), source: 'OCR', deletedAt: null },
      { id: 9102, investorId: 9, amount: 1_000_000_000n, advanceDate: d(11), source: 'MANUAL', deletedAt: null },
      { id: 9103, investorId: 9, amount: 1_000_000_000n, advanceDate: d(12), source: 'REPAYMENT', deletedAt: null } // SigMa hoàn
    ];
    const fake: Rec = {
      investor: table(investors, true),
      receiveAccount: table(receiveAccounts),
      tid: table(tids),
      transaction: table(transactions),
      investorAdvance: table(investorAdvances),
      $queryRawUnsafe: rawStub(transactions, investorAdvances)
    };
    const r = await investorDailySettlement(ctx(fake), KY);
    const h = r.data!.find((x) => x.code === 'INV09')!;
    expect(h.doanhThu).toBe(100_000_000);
    expect(h.tienVe).toBe(100_000_000); // phí cài máy 0
    expect(h.tamUng).toBe(3_000_000_000); // GROSS: 2tỷ + 1tỷ, KHÔNG trừ REPAYMENT
    expect(h.daHoan).toBe(1_000_000_000); // gom riêng source='REPAYMENT'
    // phải trả = (3tỷ − 100tr) + 0 − 1tỷ = 1.900.000.000
    expect(h.phaiTra).toBe(1_900_000_000);
    expect(h.phaiTra).toBe(h.tamUng - h.tienVe + h.laiNDT - h.daHoan);
  });
});
