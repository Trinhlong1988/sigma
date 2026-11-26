// SIGMA LANE B (#B123-fix vòng 2, 3/8) — ẢNH THẬT ca tên người nhận TRÀN 2 DÒNG + STK nằm SAU dòng bank.
// Admin Demo gửi ảnh thật `apps/ocr-service/samples/refund/refund_acb_ocb_2line.jpg`. `lines[]` dưới đây là output
// PaddleOCR THẬT (chạy lại 3/8, copy nguyên văn) — KHÔNG mô phỏng. Layout: app ACB gửi → người nhận OCB Bank.
// Nhãn "Dn"(=Đến) đứng RIÊNG dòng → tên "KHACH HANG 30" + "DOANH" (2 dòng) → bank "OCB - NH TMCP Phuong
// Dong" → STK "0003100018565008" (16 số thuần, KHÔNG phải VietQR). Ground-truth: name=KHACH HANG 06,
// bank=OCB, acct=0003100018565008, amount=53.166.000.
import { describe, expect, it } from 'vitest';
import { buildRefundReceiptPreview, extractRefundReceiptFields, type OcrLine } from '../src/ocr-bridge.js';

const ACB_OCB_2LINE_LINES: OcrLine[] = [
  { text: 'ACB', score: 0.9998 },
  { text: 'PRIVILEGE', score: 0.9985 },
  { text: 'BANKING', score: 0.9996 },
  { text: 'Chuyn tiên thành công!', score: 0.9758 },
  { text: '53.166.000 VND', score: 0.9898 },
  { text: 'Năm mươi ba triu mt trăm sáu mươi sáu nghìn', score: 0.9769 },
  { text: 'đông', score: 0.9169 },
  { text: 'Tù', score: 0.9957 },
  { text: 'LUU THI TRANG NHUNG', score: 0.9902 },
  { text: '******86', score: 0.9999 },
  { text: 'Dn', score: 0.757 },
  { text: 'KHACH HANG 30', score: 0.9888 },
  { text: 'DOANH', score: 1.0 },
  { text: 'OCB - NH TMCP Phuong Dong', score: 0.9812 },
  { text: '0003100018565008', score: 1.0 },
  { text: 'Chuyn lúc', score: 0.9764 },
  { text: '03/08/2026,18:02:56', score: 1.0 },
  { text: 'Phí', score: 0.9996 },
  { text: 'Min phí', score: 0.9995 },
  { text: 'Mã giao dch', score: 0.9986 },
  { text: '6968', score: 1.0 },
  { text: 'Ni dung', score: 0.9999 },
  { text: 'LUU THI TRANG NHUNG CHUYEN', score: 0.9852 },
  { text: 'KHOAN-030826-18:02:56', score: 1.0 },
  { text: '6215ASCB02T1NVWT', score: 0.9999 },
  { text: 'CHUYÊNKHOÀNNHANH', score: 0.925 },
  { text: '500', score: 0.9999 },
  { text: 'TU', score: 0.7146 },
  { text: 'NAPAS 247', score: 0.9954 }
];

describe('#B123-fix vòng 2 — ACB→OCB (lines THẬT): tên 2 dòng, bank giữa tên và STK', () => {
  it('tên người nhận GỘP = "KHACH HANG 06"', () => {
    const f = extractRefundReceiptFields(ACB_OCB_2LINE_LINES);
    expect(f.recipientName?.value).toBe('KHACH HANG 06');
  });
  it('người GỬI = "LUU THI TRANG NHUNG" (KHÔNG lẫn với người nhận)', () => {
    const f = extractRefundReceiptFields(ACB_OCB_2LINE_LINES);
    expect(f.senderName?.value).toBe('LUU THI TRANG NHUNG');
  });
  it('ngân hàng NGƯỜI NHẬN = OCB (KHÔNG phải brand app ACB)', () => {
    const f = extractRefundReceiptFields(ACB_OCB_2LINE_LINES);
    expect(f.recipientBank?.value).toBe('OCB');
  });
  it('STK người nhận = 0003100018565008 (số thuần, nằm SAU dòng bank)', () => {
    const f = extractRefundReceiptFields(ACB_OCB_2LINE_LINES);
    expect(f.recipientAccountNumber?.value).toBe('0003100018565008');
    expect(f.recipientAccountVietQR).toBeNull();
  });
  it('số tiền = 53.166.000', () => {
    const p = buildRefundReceiptPreview(ACB_OCB_2LINE_LINES);
    expect(p.parsedAmount).toBe(53_166_000);
  });
});
