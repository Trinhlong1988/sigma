import { describe, expect, it } from 'vitest';
import { classifyBillType, normalizeOcrText, type OcrLine } from '../src/bill-classify.js';

// Helper: dựng OcrLine từ text (score thật OCR ~0.9x — không ảnh hưởng phân loại).
const L = (text: string, score = 0.95): OcrLine => ({ text, score });

// --- FIXTURE OCR THẬT (PaddleOCR trên ảnh mẫu) — KHÔNG chế biến ---

// BILL_LE thật: bill MB POS quẹt thẻ Mastercard, 1 giao dịch (SALE-THANH TOÁN + TOTAL/TÔNG).
const BILL_LE_REAL: OcrLine[] = [
  L('MB'),
  L('HKD DEMO 47'),
  L('CARD TYPE/LOAI THE:'),
  L('MASTERCARD'),
  L('SALE-THANH TOÁN'),
  L('FATCH No/SÜ LO:'),
  L('000078'),
  L('TRACOE No SÓ HÓA BON:'),
  L('000640'),
  L('TOTAL/TÔNG:'),
  L('VND68,792,000'),
  L('APP: MASTERCARD')
];

// SETTLEMENT thật: bill kết toán tổng của cả lô (SETTLEMENT / KÊT TOÁN / ***TONG KET*** / LO DA KET TOAN).
const SETTLEMENT_REAL: OcrLine[] = [
  L('MB'),
  L('HKD DEMO 44'),
  L('SETTLEMENT'),
  L('KÊT TOÁN'),
  L('TID: 53550072/SEQ:000422'),
  L('***TONG KET***'),
  L('LO DA KET TOAN'),
  L('TONG:'),
  L('11'),
  L('UND112,999,000'),
  L('TÔNG CÓNG'),
  L('UND112,999,000'),
  L('THE:'),
  L('MASTERCARD'),
  L('TONG:'),
  L('9'),
  L('UND68,004,000'),
  L('THE:'),
  L('VISA'),
  L('THE:'),
  L('JCB')
];

// REFUND_TRANSFER thật: ảnh app ABBank chuyển tiền của Ke Toan Demo (tiền ĐÃ HOÀN, không TID/SALE).
const REFUND_REAL: OcrLine[] = [
  L('11:13'),
  L('ABBank'),
  L('Chuyn tin thành công'),
  L('64.207.000VND'),
  L('Dên KHACH HANG 20'),
  L('KHACH HANG 01 chuyen tien'),
  L('Thi gian chuyn'),
  L('25/08/2026 11:13'),
  L('Mã giao dich'),
  L('FT26237502089708')
];

describe('normalizeOcrText — bỏ dấu + đ→d + upper', () => {
  it('KÊT TOÁN → KET TOAN', () => {
    expect(normalizeOcrText('KÊT TOÁN')).toBe('KET TOAN');
  });
  it('Chuyn tin → CHUYN TIN, đường → DUONG', () => {
    expect(normalizeOcrText('Chuyn tin')).toBe('CHUYN TIN');
    expect(normalizeOcrText('đường Đê')).toBe('DUONG DE');
  });
});

describe('classifyBillType — 3 loại bill thật', () => {
  it('BILL_LE: bill POS SALE-THANH TOÁN', () => {
    expect(classifyBillType(BILL_LE_REAL)).toBe('BILL_LE');
  });

  it('SETTLEMENT: bill kết toán tổng lô', () => {
    expect(classifyBillType(SETTLEMENT_REAL)).toBe('SETTLEMENT');
  });

  it('REFUND_TRANSFER: chuyển khoản hoàn tiền Ke Toan Demo', () => {
    expect(classifyBillType(REFUND_REAL)).toBe('REFUND_TRANSFER');
  });

  it('REFUND biến thể "CHUYEN TIEN THANH CONG" đầy đủ dấu', () => {
    const lines: OcrLine[] = [L('Ke Toan Demo'), L('Chuyển tiền thành công'), L('50.000.000 VND')];
    expect(classifyBillType(lines)).toBe('REFUND_TRANSFER');
  });

  it('UNKNOWN: dòng rác không tín hiệu nào', () => {
    const lines: OcrLine[] = [L('xin chào'), L('12345'), L('ảnh mờ quá'), L('QWERTY')];
    expect(classifyBillType(lines)).toBe('UNKNOWN');
  });

  it('UNKNOWN: mảng rỗng', () => {
    expect(classifyBillType([])).toBe('UNKNOWN');
  });
});

describe('classifyBillType — case BIÊN an toàn tiền (REFUND ưu tiên)', () => {
  // Bill có cả tín hiệu SALE/THANH TOÁN (BILL_LE) NHƯNG cũng có "KHACH HANG 01 chuyen tien":
  // phải ra REFUND_TRANSFER để KHÔNG lọt thành doanh số.
  it('SALE + THANH TOÁN nhưng có Ke Toan Demo chuyển tiền → REFUND_TRANSFER', () => {
    const lines: OcrLine[] = [
      L('MB'),
      L('SALE-THANH TOÁN'),
      L('TOTAL/TÔNG:'),
      L('VND10,000,000'),
      L('KHACH HANG 01 chuyen tien')
    ];
    expect(classifyBillType(lines)).toBe('REFUND_TRANSFER');
  });

  // Bill có tín hiệu SETTLEMENT nhưng cũng có Ke Toan Demo chuyển tiền → vẫn REFUND (kiểm trước).
  it('SETTLEMENT + Ke Toan Demo chuyển tiền → REFUND_TRANSFER', () => {
    const lines: OcrLine[] = [L('SETTLEMENT'), L('KÊT TOÁN'), L('KHACH HANG 01 chuyen tien')];
    expect(classifyBillType(lines)).toBe('REFUND_TRANSFER');
  });
});
