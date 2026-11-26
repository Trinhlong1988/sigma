// REGRESSION bug 1/9 (Agent-A + LEAD verify DB thật): investorReportDetail (nguồn Excel chi tiết NĐT) TRƯỚC ĐÂY
// KHÔNG áp MỐC CHỐT (clearCutoffs) trong khi investorDailyReport/Settlement CÓ → NĐT đã clear (vd inv15 thật: 43 tạm
// ứng = 15,69 tỷ trước 30/8) bị CỘNG LẠI vào daNhan/thuaThieu → Excel chi tiết mâu thuẫn tất toán. Fix: áp
// loadInvestorCutoffs + isBeforeCutoff cho CẢ giao dịch (tienVe) LẪN tạm ứng (daNhan). Test khẳng định: có cutoff →
// loại trước mốc ở CẢ 2; không cutoff → giữ nguyên (hành vi cũ).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { investorReportDetail, type ServiceCtx } from '../src/index.js';
import { table, type Rec } from './_fake-db.js';

const INV = 15;
const authUser = (permissions: string[]): AuthUser =>
  ({ id: 7, username: 't', fullName: 'T', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions });

// GD: 1 trước mốc (20/8, 10tr) + 1 sau mốc (31/8, 20tr). Tạm ứng: 1 trước (20/8, 5tr) + 1 sau (31/8, 7tr).
// [GÓI TZ 11/9] cutoff/display nay so bằng txn_iso/advance_iso (to_char instant thật) — fixture bổ sung iso.
const txnRows = [
  { amount: 10_000_000n, phi_cai_may_milli: 0, install_fee_amount: 0, txn_date: new Date('2026-08-20T03:00:00Z'), txn_iso: '2026-08-20T03:00:00.000Z', tid: '111', tid_fee: 100, hkd_name: 'HKD X', bank_name: 'MB', so_lo: '1', bill_key: 'nat|111|1|' },
  { amount: 20_000_000n, phi_cai_may_milli: 0, install_fee_amount: 0, txn_date: new Date('2026-08-31T03:00:00Z'), txn_iso: '2026-08-31T03:00:00.000Z', tid: '111', tid_fee: 100, hkd_name: 'HKD X', bank_name: 'MB', so_lo: '2', bill_key: 'nat|111|2|' }
];
const advRows = [
  { advance_date: new Date('2026-08-20T03:00:00Z'), advance_iso: '2026-08-20T03:00:00.000Z', sender_name: 'A', receiver_name: 'SigMa', amount: 5_000_000n, source: 'OCR' },
  { advance_date: new Date('2026-08-31T03:00:00Z'), advance_iso: '2026-08-31T03:00:00.000Z', sender_name: 'A', receiver_name: 'SigMa', amount: 7_000_000n, source: 'OCR' }
];

function makeDb(withCutoff: boolean): Rec {
  return {
    investor: table([{ id: INV, fullName: 'Ông Thông', nickname: 'Thông', investFeeMilli: 100, deletedAt: null }]),
    // 2 query raw KHÁC nhau — phân biệt theo bảng trong SQL (transactions vs investor_advances).
    $queryRawUnsafe: async (sql: string) =>
      (sql.includes('investor_advances') ? advRows : txnRows),
    // Kênh mốc chốt: có cutoff → inv15 chốt 30/8; không → thiếu appSetting (Map rỗng, giữ hành vi cũ).
    ...(withCutoff
      ? { appSetting: { findUnique: async () => ({ value: JSON.stringify({ [INV]: '2026-08-30' }) }) } }
      : {})
  };
}

const ctx = (db: Rec): ServiceCtx => ({ db: db as unknown as Db, user: authUser(['REVENUE_VIEW']) });
const KY = { investorId: INV, from: '2026-08-01', to: '2026-08-31' };

describe('investorReportDetail — áp mốc chốt (clearCutoffs) [FIX 1/9]', () => {
  it('KHÔNG cutoff (bản cũ): tính CẢ trước+sau → truoc=30tr, daNhan=12tr', async () => {
    const r = await investorReportDetail(ctx(makeDb(false)), KY);
    expect(r.ok).toBe(true);
    expect(r.data!.totals.truoc).toBe(30_000_000); // 10 + 20
    expect(r.data!.totals.daNhan).toBe(12_000_000); // 5 + 7
    expect(r.data!.bills).toHaveLength(2);
    expect(r.data!.advances).toHaveLength(2);
  });

  it('CÓ cutoff 30/8: LOẠI trước mốc ở CẢ GD lẫn tạm ứng → truoc=20tr, daNhan=7tr (hết hồi sinh 15,69 tỷ)', async () => {
    const r = await investorReportDetail(ctx(makeDb(true)), KY);
    expect(r.ok).toBe(true);
    expect(r.data!.totals.truoc).toBe(20_000_000); // chỉ GD 31/8
    expect(r.data!.totals.daNhan).toBe(7_000_000); // chỉ tạm ứng 31/8
    expect(r.data!.bills).toHaveLength(1);
    expect(r.data!.advances).toHaveLength(1);
    // thuaThieu = daNhan − tienVe, nhất quán với daily/settlement (không lệch bằng đống đã clear).
    expect(r.data!.totals.thuaThieu).toBe(r.data!.totals.daNhan - r.data!.totals.tienVe);
  });
});
