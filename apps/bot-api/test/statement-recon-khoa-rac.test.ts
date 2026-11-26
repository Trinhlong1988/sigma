// [Admin Demo 30/9 "bill Tuấn Anh chuyển KT Demo là ĐL TA hoàn ứng sao lại ghi nhận Nhà Nguyễn"] — GATE cho GỐC:
// map "học từ bill hoàn OCR" đang nuốt cả những khoá KHÔNG ĐƯỢC PHÉP làm khoá đại lý:
//   (E) MÃ RÁC không phải số tài khoản — MB điền mã QR "VQRQAIUIF6322" vào cột "TK đối ứng" của báo có. Mã này
//       xuất hiện trong bill hoàn của NHIỀU phòng ⇒ map last-wins ⇒ tiền của đại lý A chạy vào sổ đại lý B,
//       và tên gán ra còn NHẢY theo bill mới nhất (ca thật: máy Admin Demo hiện "Mr Nguyễn SG", chạy lại ra "Bình SG").
//   (F) TÊN NGƯỜI NHÀ SIGMA (KHACH HANG 01…) làm khoá đại lý — MB báo có điền chính chủ TK vào ô đối ứng.
//   (G) SỐ TK CỦA CHÍNH SIGMA (TK đã nạp sao kê) làm khoá đại lý ⇒ KT Demo tự chuyển bị tính "đại lý hoàn lại".
//   (H) KHOÁ MƠ HỒ: cùng một khoá học được ở >1 PHÒNG ⇒ không thể biết của ai ⇒ CẤM đoán, phải bỏ khoá.
//   (I) SỬA TAY đổi LOẠI mà KHÔNG chọn tên ⇒ phải XOÁ tên/ID khớp cũ (đang treo tên đại lý cũ trên dòng
//       "Chuyển giữa TK" → nhìn thành "ghi nhận nhà khác").
// Mỗi ca dưới đây đều tái hiện từ dữ liệu THẬT trong DB sigma ngày 30/9.
import { describe, it, expect } from 'vitest';
import { reconcileStatement, type ParsedStatement } from '../src/statement-recon.js';

const BILL = (acct: string | null, ten: string) => JSON.stringify({ isDealerRefundCk: true, receiverAcct: acct, receiverName: ten });

// Bill hoàn CK đã OCR — nguồn của map "học từ bill". Tái hiện đúng cảnh thật:
//  r_nguyen / r_binh / r_ta / r_huy đều có bill ghi receiverAcct = mã QR "VQRQAIUIF6322", receiverName = KHACH HANG 01.
//  r_ta còn có bill ĐÚNG của Nhan Vien Demo (4268816626) — đây mới là khoá thật của đại lý Đại lý C.
function fakeDb(opts: { overrides?: { ref: string; kind: string | null; target_name: string | null }[] } = {}) {
  const msgs = [
    // Thứ tự đặt ĐÚNG như DB thật: bill CUỐI mang mã rác này là của phòng Mr Nguyễn ⇒ last-wins gán nhầm về #210
    // (đúng cái Admin Demo nhìn thấy trên máy). Đổi thứ tự bill là kết quả đổi nhà — chính là bằng chứng "đoán bừa".
    { roomId: 'r_binh', metadataJson: BILL('VQRQAIUIF6322', 'KHACH HANG 01') },
    { roomId: 'r_ta', metadataJson: BILL('VQRQAIUIF6322', 'KHACH HANG 01') },
    { roomId: 'r_huy', metadataJson: BILL('VQRQAIUIF6322', 'KHACH HANG 01') },
    { roomId: 'r_nguyen', metadataJson: BILL('VQRQAIUIF6322', 'KHACH HANG 01') },
    { roomId: 'r_ta', metadataJson: BILL('4268816626', 'KHACH HANG 57') },
    { roomId: 'r_huy', metadataJson: BILL('8869133934', 'HA QUOC HUY') },
    { roomId: 'r_huy', metadataJson: BILL('DEMO-ACCT', 'KHACH HANG 01') },   // TK của CHÍNH SigMa lọt vào map
    { roomId: 'r_binh', metadataJson: BILL('0987000111', 'DLY NGUYEN') },    // khoá tên MƠ HỒ (2 phòng)
    { roomId: 'r_nguyen', metadataJson: BILL('0987000222', 'DLY NGUYEN') }
  ];
  return {
    chatMessage: { findMany: async () => msgs },
    customerChatGroup: { findMany: async () => [
      { roomId: 'r_binh', customerId: 212 }, { roomId: 'r_nguyen', customerId: 210 },
      { roomId: 'r_ta', customerId: 223 }, { roomId: 'r_huy', customerId: 215 }
    ] },
    chatRoom: { findMany: async () => [
      { id: 'r_binh', name: 'ĐL- Anh Bình Sài Gòn' }, { id: 'r_nguyen', name: 'ĐL- Mr Nguyễn SG' },
      { id: 'r_ta', name: 'ĐL- Đại lý C' }, { id: 'r_huy', name: 'ĐL- Hà Khach Demo SG' }
    ] },
    customer: { findMany: async () => [
      { id: 212, fullName: 'Binh SG', nickname: 'Bình SG' }, { id: 210, fullName: 'Nguyen SG', nickname: 'Mr Nguyễn SG' },
      { id: 223, fullName: 'Le Tuan Anh', nickname: 'Đại lý C' }, { id: 215, fullName: 'Ha Quoc Huy', nickname: 'QUỐC HUY SG' }
    ] },
    investor: { findMany: async () => [{ id: 15, fullName: 'Nguyen Van Thong', nickname: 'NĐT 2' }] },
    receiveAccount: { findMany: async () => [{ accountNumber: '99999999', accountName: 'KHACH HANG 02', investorId: 15 }] },
    $queryRawUnsafe: async (sql: string) => {
      if (/statement_txn_override/.test(sql)) return opts.overrides ?? [];
      // Danh sách TK của CHÍNH SigMa = các tài khoản đã nạp sao kê (đúng như production trả về).
      if (/DISTINCT src_account/.test(sql)) return [{ src_account: 'DEMO-ACCT' }, { src_account: 'DEMO-ACCT' }, { src_account: 'DEMO-ACCT' }];
      return []; // statement_dealer_alias: không khai ánh xạ tay trong bộ test này
    }
  } as unknown as Parameters<typeof reconcileStatement>[0];
}

const base = { desc: null, cpBank: 'MB' as string | null };
const parsed: ParsedStatement = {
  accountHolder: 'KHACH HANG 01', accountNumber: 'DEMO-ACCT', accountBank: 'MB',
  txns: [
    // (E) CA THẬT 29/9 18:26 — Nhan Vien Demo chuyển 100tr cho KT Demo. MB điền chính chủ vào ô đối ứng + mã QR vào ô TK.
    { rowIndex: 1, dateTime: '2026-09-29T18:26:00', ref: 'E1', debit: 0, credit: 100000000, cpName: 'KHACH HANG 01', cpAccount: 'VQRQAIUIF6322', descName: 'KHACH HANG 57', ...base },
    // (F) CA THẬT 25/9 08:21 — Hà Khach Demo chuyển 7tr, đang bị ghi cho đại lý khác.
    { rowIndex: 2, dateTime: '2026-09-25T08:21:00', ref: 'F1', debit: 0, credit: 7000000, cpName: 'KHACH HANG 01', cpAccount: 'VQRQAIUIF6322', descName: 'HA QUOC HUY', ...base },
    // (G) CA THẬT 16/9 17:38 — khớp bằng SỐ TK CỦA CHÍNH SIGMA (DEMO-ACCT) ⇒ cấm gán đại lý.
    { rowIndex: 3, dateTime: '2026-09-16T17:38:00', ref: 'G1', debit: 0, credit: 68144000, cpName: 'MBVBANK IBFT', cpAccount: 'DEMO-ACCT', descName: 'KHACH HANG 01', ...base },
    // (H) KHOÁ TÊN MƠ HỒ (2 phòng) ⇒ CẤM đoán bừa một nhà.
    { rowIndex: 4, dateTime: '2026-09-20T10:00:00', ref: 'H1', debit: 12000000, credit: 0, cpName: 'DLY NGUYEN', cpAccount: '0987000333', descName: 'KHACH HANG 01', ...base },
    // (I) Dòng bị SỬA TAY sang "Chuyển giữa TK" mà không chọn tên ⇒ phải hết tên đại lý cũ.
    { rowIndex: 5, dateTime: '2026-09-29T18:26:00', ref: 'I1', debit: 0, credit: 100000000, cpName: 'KHACH HANG 01', cpAccount: 'VQRQAIUIF6322', descName: 'KHACH HANG 57', ...base }
  ]
};

describe('map học-từ-bill: CẤM khoá rác / khoá của chính SigMa / khoá mơ hồ', () => {
  it('(E) Nhan Vien Demo chuyển 100tr → ĐẠI LÝ HOÀN LẠI cho ĐL Đại lý C (#223), KHÔNG chạy sang nhà khác', async () => {
    const r = await reconcileStatement(fakeDb(), parsed);
    const e = r.txns.find((t) => t.ref === 'E1')!;
    expect(e.matchedCustomerId).toBe(223);
    expect(e.kind).toBe('DEALER_RETURN');
  });

  it('(F) Hà Khach Demo chuyển 7tr → về ĐL Hà Khach Demo (#215), không về đại lý khác', async () => {
    const r = await reconcileStatement(fakeDb(), parsed);
    const f = r.txns.find((t) => t.ref === 'F1')!;
    expect(f.matchedCustomerId).toBe(215);
  });

  it('(G) đối ứng là SỐ TK CỦA CHÍNH SIGMA → CẤM gán đại lý (không "đại lý hoàn lại")', async () => {
    const r = await reconcileStatement(fakeDb(), parsed);
    const g = r.txns.find((t) => t.ref === 'G1')!;
    expect(g.matchedCustomerId).toBeNull();
    expect(g.kind).not.toBe('DEALER_RETURN');
  });

  it('(H) khoá TÊN học được ở >1 phòng = mơ hồ → KHÔNG khớp đại lý nào (thà thiếu còn hơn sai)', async () => {
    const r = await reconcileStatement(fakeDb(), parsed);
    const h = r.txns.find((t) => t.ref === 'H1')!;
    expect(h.matchedCustomerId).toBeNull();
  });

  it('(I) sửa tay đổi LOẠI mà không chọn tên → XOÁ tên/ID khớp cũ, không treo tên đại lý trên dòng Chuyển giữa TK', async () => {
    const r = await reconcileStatement(fakeDb({ overrides: [{ ref: 'I1', kind: 'TRANSFER', target_name: null }] }), parsed);
    const i = r.txns.find((t) => t.ref === 'I1')!;
    expect(i.kind).toBe('TRANSFER');
    expect(i.matchedCustomerId).toBeNull();
    expect(i.matchedInvestorId).toBeNull();
  });
});
