// [Admin Demo 8/9 — GATE "cấm tái diễn"] Regression cho 2 gốc bug tra soát sao kê:
//  (A) MB BÁO CÓ điền CHÍNH CHỦ TK vào cột đối ứng (cpName=chủ TK, cpAccount=CHÍNH TK nguồn) → người chuyển THẬT ở
//      NỘI DUNG (descName="KHACH HANG 02"=NĐT). Gate self CŨ bắn nhầm → "Chuyển giữa TK", NUỐT tạm ứng NĐT. Phải =
//      INVESTOR_ADVANCE khớp NĐT theo descName.
//  (B) Chuyển nội bộ THẬT (descName không khớp party nào, vd "MBVBANK") vẫn = TRANSFER (Admin Demo xác nhận +2.000.000 đúng).
//  (C) KT Demo TỰ CHUYỂN giữa 2 TK của mình (cpName=KT Demo) mà cpAccount TRÙNG receiverAcct 1 đại lý (bill hoàn cũ) → PHẢI
//      giữ TRANSFER, CẤM thành "Đại lý hoàn lại" (bug 265.600 = số dư KT Demo tự chuyển). Đại lý hoàn lại CHỈ khi tiền VÀO
//      từ tài khoản/tên KHỚP ĐẠI LÝ thật (không phải chính chủ TK sao kê).
import { describe, it, expect } from 'vitest';
import { reconcileStatement, type ParsedStatement } from '../src/statement-recon.js';

// Fake Db tối thiểu. chatMessage có 1 bill hoàn đại lý với receiverAcct='DEMO-ACCT' (đúng cảnh trùng TK riêng của KT Demo).
function fakeDb() {
  return {
    chatMessage: { findMany: async () => [{ roomId: 'r1', metadataJson: '{"isDealerRefundCk":true,"receiverAcct":"DEMO-ACCT","receiverName":"Loc SG"}' }] },
    customerChatGroup: { findMany: async () => [{ roomId: 'r1', customerId: 99 }] },
    chatRoom: { findMany: async () => [{ id: 'r1', name: 'ĐL- Loc SG' }] },
    customer: { findMany: async () => [{ id: 99, fullName: 'Loc SG', nickname: null }] },
    investor: { findMany: async () => [{ id: 15, fullName: 'Nguyen Van Thong', nickname: 'NĐT 2' }] },
    receiveAccount: { findMany: async () => [{ accountNumber: '99999999', accountName: 'KHACH HANG 02', investorId: 15 }] },
    $queryRawUnsafe: async () => []
  } as unknown as Parameters<typeof reconcileStatement>[0];
}

const base = { desc: null, cpBank: 'MB' as string | null };
const parsed: ParsedStatement = {
  accountHolder: 'KHACH HANG 01', accountNumber: 'DEMO-ACCT', accountBank: 'MB',
  txns: [
    // (A) người chuyển thật = Khach Demo A (NĐT) ở nội dung; đối ứng bị điền chính chủ TK
    { rowIndex: 1, dateTime: '2026-09-07T09:04:00', ref: 'A1', debit: 0, credit: 400000001, cpName: 'KHACH HANG 01', cpAccount: 'DEMO-ACCT', descName: 'KHACH HANG 02', ...base },
    // (B) chuyển nội bộ thật — nội dung KHÔNG khớp party nào (MBVBANK) → phải giữ TRANSFER
    { rowIndex: 2, dateTime: '2026-09-07T11:00:00', ref: 'A2', debit: 0, credit: 2000000, cpName: 'KHACH HANG 01', cpAccount: 'DEMO-ACCT', descName: 'MBVBANK', ...base },
    // (C) KT Demo tự chuyển: cpName=KT Demo, cpAccount=DEMO-ACCT (TRÙNG receiverAcct đại lý Loc SG) → PHẢI TRANSFER, KHÔNG DEALER_RETURN
    { rowIndex: 3, dateTime: '2026-09-07T00:15:00', ref: 'A3', debit: 0, credit: 265600, cpName: 'Ke Toan Demo', cpAccount: 'DEMO-ACCT', descName: 'CUSTOMER KHACH HANG 01', ...base }
  ]
};

describe('reconcileStatement — self-transfer gate không nuốt tạm ứng NĐT (MB báo có)', () => {
  it('(A) báo có có người chuyển thật=Khach Demo A ở nội dung → INVESTOR_ADVANCE khớp NĐT Thông (KHÔNG phải TRANSFER)', async () => {
    const r = await reconcileStatement(fakeDb(), parsed);
    const a1 = r.txns.find((t) => t.ref === 'A1')!;
    expect(a1.kind).toBe('INVESTOR_ADVANCE');
    expect(a1.matchedInvestorId).toBe(15);
    expect(a1.matchedName).toBe('NĐT 2');
  });
  it('(B) chuyển nội bộ thật (nội dung không khớp party nào) vẫn = TRANSFER', async () => {
    const r = await reconcileStatement(fakeDb(), parsed);
    const a2 = r.txns.find((t) => t.ref === 'A2')!;
    expect(a2.kind).toBe('TRANSFER');
  });
  it('tổng tạm ứng NĐT tính đúng theo credit của (A)', async () => {
    const r = await reconcileStatement(fakeDb(), parsed);
    expect(r.totals.tamUngNDT).toBe(400000001);
  });
  it('(C) KT Demo tự chuyển (cpAccount trùng receiverAcct đại lý) → TRANSFER, KHÔNG "Đại lý hoàn lại"', async () => {
    const r = await reconcileStatement(fakeDb(), parsed);
    const a3 = r.txns.find((t) => t.ref === 'A3')!;
    expect(a3.kind).toBe('TRANSFER');
    expect(r.totals.hoanLaiDaiLy).toBe(0); // không có đại lý hoàn lại nào từ khoản tự chuyển
  });
  it('(D) "Chưa khớp" CHỈ đếm UNKNOWN — TRANSFER (B,C) KHÔNG bị tính vào unmatched', async () => {
    const r = await reconcileStatement(fakeDb(), parsed);
    // A=ADVANCE, B=TRANSFER(2tr), C=TRANSFER(265.6k) → không có UNKNOWN → unmatched = 0 (trước fix: B+C credit bị gộp).
    expect(r.totals.unmatchedIn).toBe(0);
    expect(r.totals.unmatchedOut).toBe(0);
  });
});
