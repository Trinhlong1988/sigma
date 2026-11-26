import { describe, expect, it } from 'vitest';
import {
  normalizeOcrText,
  parseRefundTransfer,
  parseSettlementBill,
  type OcrLine
} from '../src/bill-parse-extra.js';

// Helper: dựng OcrLine từ text (score thật OCR ~0.9x — không ảnh hưởng parse).
const L = (text: string, score = 0.95): OcrLine => ({ text, score });

// =============================== FIXTURE OCR THẬT ===============================

// SETTLEMENT thật: bill MB kết toán lô POS "HKD DEMO 44" (25/08/2026 09:11:39).
// Cột OCR lệch: value "000053" đứng TRƯỚC nhãn "BATCH No/SO LO"; VISA có amount TRƯỚC "TONG:".
const SETTLEMENT_REAL: OcrLine[] = [
  L('MB'),
  L('TÉN DAI LY:'),
  L('HKD DEMO 44'),
  L('DATETIME/NGAY GIO:'),
  L('25/08/2026 09:11:39'),
  L('SETTLEMENT'),
  L('KÊT TOÁN'),
  L('TID: 53550072/SEQ:000422 MID:'),
  L('355-C-963743'),
  L('000053'),
  L('BATCH No/SO LO'),
  L('000422'),
  L('TRACE No/SÖ HÓA DON:'),
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
  L('TÖNG CÓNG'),
  L('UND68,004,000'),
  L('THE:'),
  L('VISA'),
  L('UND24,997,000'),
  L('TONG:'),
  L('1'),
  L('TÓNG CÓNG'),
  L('UND24,997,000'),
  L('THE:'),
  L('JCB'),
  L('TÓNG:'),
  L('UND19,998,000'),
  L('TÓNG CONG'),
  L('UND19,998,000')
];

// REFUND_TRANSFER thật #1: app ABBank, phân cách CHẤM ("64.207.000VND"), có người nhận + mã FT.
const REFUND_ABBANK: OcrLine[] = [
  L('11:13'),
  L('00:37'),
  L('5G76'),
  L('ABBank'),
  L('Chuyn tin thành công'),
  L('64.207.000VND'),
  L('Dên KHACH HANG 20'),
  L('Tài khon ngưi nhn'),
  L('1907 3333 1210 16'),
  L('TECHCOMBANK (TCB)'),
  L('Cùng ni dung'),
  L('KHACH HANG 01 chuyen tien'),
  L('Thi gian chuyn'),
  L('25/08/2026 11:13'),
  L('Mã giao dich'),
  L('FT26237502089708')
];

// REFUND_TRANSFER thật #2: app MB, phân cách PHẨY, có số phụ ÂM phía trên phải bỏ qua.
const REFUND_MB: OcrLine[] = [
  L('-43,382,000 VND'),
  L('MBCT KHACH HANG 01 chuyen tien D2H MP3MX/299841'),
  L('Chuyển tiền thành công'),
  L('123,464,000 VND'),
  L('KHACH HANG 01 chuyen tien')
];

// =============================== TEST ===============================

describe('normalizeOcrText — bỏ dấu + đ→d + upper (copy bill-classify)', () => {
  it('KÊT TOÁN → KET TOAN, Dên → DEN', () => {
    expect(normalizeOcrText('KÊT TOÁN')).toBe('KET TOAN');
    expect(normalizeOcrText('Dên KHACH HANG 20')).toBe('DEN KHACH HANG 20');
    expect(normalizeOcrText('Chuyển tiền thành công')).toBe('CHUYEN TIEN THANH CONG');
  });
});

describe('parseSettlementBill — bill kết toán thật', () => {
  const parsed = parseSettlementBill(SETTLEMENT_REAL);

  it('rút đủ field: tid / batch / totalCount / totalAmount / perCard', () => {
    expect(parsed).toEqual({
      tid: '53550072',
      batchNumber: '000053',
      totalCount: 11,
      totalAmount: 112999000,
      perCard: [
        { scheme: 'MASTERCARD', count: 9, amount: 68004000 },
        { scheme: 'VISA', count: 1, amount: 24997000 },
        { scheme: 'JCB', count: 1, amount: 19998000 }
      ]
    });
  });

  it('INVARIANT: totalAmount = Σ perCard.amount (112.999tr = 68.004 + 24.997 + 19.998)', () => {
    const sum = parsed.perCard.reduce((s, c) => s + c.amount, 0);
    expect(sum).toBe(parsed.totalAmount);
    expect(sum).toBe(112999000);
  });

  it('INVARIANT phụ: totalCount = Σ perCard.count (11 = 9 + 1 + 1)', () => {
    const sum = parsed.perCard.reduce((s, c) => s + (c.count ?? 0), 0);
    expect(sum).toBe(parsed.totalCount);
  });

  it('thiếu field (chỉ có nhãn SETTLEMENT) → trả null, KHÔNG throw', () => {
    const r = parseSettlementBill([L('SETTLEMENT'), L('KÊT TOÁN')]);
    expect(r.tid).toBeNull();
    expect(r.batchNumber).toBeNull();
    expect(r.totalCount).toBeNull();
    expect(r.totalAmount).toBeNull();
    expect(r.perCard).toEqual([]);
  });

  it('mảng rỗng → tất cả null / perCard rỗng, KHÔNG throw', () => {
    const r = parseSettlementBill([]);
    expect(r).toEqual({ tid: null, batchNumber: null, totalCount: null, totalAmount: null, perCard: [] });
  });
});

describe('parseRefundTransfer — 2 ngân hàng (chấm / phẩy)', () => {
  it('ABBank (phân cách CHẤM): amount + recipient + refCode FT', () => {
    const r = parseRefundTransfer(REFUND_ABBANK);
    expect(r.amount).toBe(64207000);
    expect(r.recipientName).toBe('KHACH HANG 20');
    expect(r.refCode).toBe('FT26237502089708');
  });

  it('MB (phân cách PHẨY): lấy số cạnh "THÀNH CÔNG" (123.464.000), bỏ số phụ âm -43.382.000', () => {
    const r = parseRefundTransfer(REFUND_MB);
    expect(r.amount).toBe(123464000);
    // recipient không rõ trên bill này → null là chấp nhận được.
    expect(r.recipientName).toBeNull();
    // refCode dạng "MP3MX/299841" (không có mã FT).
    expect(r.refCode).toBe('MP3MX/299841');
  });

  it('thiếu field (không tiền / không tên / không mã) → null, KHÔNG throw', () => {
    const r = parseRefundTransfer([L('xin chào'), L('ảnh mờ quá')]);
    expect(r).toEqual({ amount: null, recipientName: null, refCode: null });
  });

  it('mảng rỗng → tất cả null, KHÔNG throw', () => {
    expect(parseRefundTransfer([])).toEqual({ amount: null, recipientName: null, refCode: null });
  });
});
