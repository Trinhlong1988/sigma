import { describe, expect, it } from 'vitest';
import {
  detectMultipleBillsInImage,
  reconcileBatch,
  type BillLeRecord,
  type SettlementInfo,
} from '../src/bill-reconcile.js';

const bill = (invoiceNumber: string, amount: number): BillLeRecord => ({ invoiceNumber, amount });

describe('detectMultipleBillsInImage', () => {
  it('1 sale, 1 invoice → false (ảnh 1 bill)', () => {
    expect(detectMultipleBillsInImage({ saleOccurrences: 1, distinctInvoiceNumbers: 1 })).toBe(false);
  });

  it('2 sale → true', () => {
    expect(detectMultipleBillsInImage({ saleOccurrences: 2, distinctInvoiceNumbers: 1 })).toBe(true);
  });

  it('1 sale nhưng 2 Số HĐ phân biệt → true', () => {
    expect(detectMultipleBillsInImage({ saleOccurrences: 1, distinctInvoiceNumbers: 2 })).toBe(true);
  });

  it('0 sale, 0 invoice → false', () => {
    expect(detectMultipleBillsInImage({ saleOccurrences: 0, distinctInvoiceNumbers: 0 })).toBe(false);
  });

  it('3 sale, 5 invoice → true', () => {
    expect(detectMultipleBillsInImage({ saleOccurrences: 3, distinctInvoiceNumbers: 5 })).toBe(true);
  });
});

describe('reconcileBatch', () => {
  it('(1) đủ liên tiếp 412-415 + count/total khớp → OK', () => {
    const bills = [
      bill('000412', 10_000_000),
      bill('000413', 20_000_000),
      bill('000414', 30_000_000),
      bill('000415', 40_000_000),
    ];
    const settlement: SettlementInfo = { totalCount: 4, totalAmount: 100_000_000 };
    const r = reconcileBatch(bills, settlement);
    expect(r.status).toBe('OK');
    expect(r.missingInvoiceNumbers).toEqual([]);
    expect(r.collectedCount).toBe(4);
    expect(r.collectedAmount).toBe(100_000_000);
    expect(r.expectedCount).toBe(4);
    expect(r.expectedAmount).toBe(100_000_000);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('(2) thiếu 414 (có 412,413,415) → MISSING_BILLS, missing=[000414]', () => {
    const bills = [
      bill('000412', 10_000_000),
      bill('000413', 20_000_000),
      bill('000415', 40_000_000),
    ];
    const settlement: SettlementInfo = { totalCount: 4, totalAmount: 100_000_000 };
    const r = reconcileBatch(bills, settlement);
    expect(r.status).toBe('MISSING_BILLS');
    expect(r.missingInvoiceNumbers).toEqual(['000414']);
    expect(r.collectedCount).toBe(3);
    expect(r.expectedCount).toBe(4);
    expect(r.reasons.join(' ')).toContain('000414');
    expect(r.reasons.join(' ')).toContain('000412,000413,000415');
  });

  it('(3) đủ Số HĐ liên tiếp nhưng collectedCount < totalCount → COUNT_MISMATCH', () => {
    const bills = [bill('000412', 10_000_000), bill('000413', 20_000_000)];
    const settlement: SettlementInfo = { totalCount: 3, totalAmount: 30_000_000 };
    const r = reconcileBatch(bills, settlement);
    expect(r.status).toBe('COUNT_MISMATCH');
    expect(r.missingInvoiceNumbers).toEqual([]);
    expect(r.collectedCount).toBe(2);
    expect(r.expectedCount).toBe(3);
    expect(r.reasons.join(' ')).toContain('Số lượng lệch');
  });

  it('(4) count khớp nhưng Σ tiền != totalAmount → AMOUNT_MISMATCH', () => {
    const bills = [
      bill('000412', 10_000_000),
      bill('000413', 20_000_000),
      bill('000414', 30_000_000),
    ];
    const settlement: SettlementInfo = { totalCount: 3, totalAmount: 99_000_000 };
    const r = reconcileBatch(bills, settlement);
    expect(r.status).toBe('AMOUNT_MISMATCH');
    expect(r.collectedCount).toBe(3);
    expect(r.collectedAmount).toBe(60_000_000);
    expect(r.expectedAmount).toBe(99_000_000);
    expect(r.reasons.join(' ')).toContain('Tổng tiền lệch');
  });

  it('(5) settlement null → NO_SETTLEMENT (vẫn trả gap nội bộ)', () => {
    const bills = [
      bill('000412', 10_000_000),
      bill('000414', 30_000_000), // thiếu 413
    ];
    const r = reconcileBatch(bills, null);
    expect(r.status).toBe('NO_SETTLEMENT');
    expect(r.missingInvoiceNumbers).toEqual(['000413']);
    expect(r.expectedCount).toBeNull();
    expect(r.expectedAmount).toBeNull();
    expect(r.collectedCount).toBe(2);
  });

  it('(6) invoiceNumber không phải số → không crash, vẫn đếm', () => {
    const bills = [
      bill('ABC', 10_000_000),
      bill('000413', 20_000_000),
      bill('', 5_000_000),
    ];
    const settlement: SettlementInfo = { totalCount: 3, totalAmount: 35_000_000 };
    const r = reconcileBatch(bills, settlement);
    // 3 bill được đếm; chỉ 1 Số HĐ hợp lệ (413) → không có gap.
    expect(r.collectedCount).toBe(3);
    expect(r.collectedAmount).toBe(35_000_000);
    expect(r.missingInvoiceNumbers).toEqual([]);
    expect(r.status).toBe('OK');
  });

  it('(7) 1 bill duy nhất + settlement totalCount=1 khớp → OK', () => {
    const bills = [bill('000640', 12_500_000)];
    const settlement: SettlementInfo = { totalCount: 1, totalAmount: 12_500_000 };
    const r = reconcileBatch(bills, settlement);
    expect(r.status).toBe('OK');
    expect(r.missingInvoiceNumbers).toEqual([]);
    expect(r.collectedCount).toBe(1);
  });

  it('(8) SỐ THẬT lô 000053: 11 bill liên tiếp, tổng 112.999.000 khớp → OK', () => {
    // Dựng 11 bill Số HĐ liên tiếp; tổng đúng bằng settlement.totalAmount.
    const amounts = [
      10_000_000, 12_000_000, 8_500_000, 9_999_000, 11_000_000, 7_500_000,
      13_000_000, 10_500_000, 9_000_000, 11_000_000, 10_500_000,
    ];
    const sum = amounts.reduce((a, b) => a + b, 0);
    expect(sum).toBe(112_999_000); // fixture sanity
    const bills = amounts.map((amt, i) => bill(padInv(500 + i), amt));
    const settlement: SettlementInfo = { totalCount: 11, totalAmount: 112_999_000 };
    const r = reconcileBatch(bills, settlement);
    expect(r.status).toBe('OK');
    expect(r.collectedCount).toBe(11);
    expect(r.collectedAmount).toBe(112_999_000);
    expect(r.expectedCount).toBe(11);
    expect(r.expectedAmount).toBe(112_999_000);
  });

  it('(9) SỐ THẬT lô 000053: thiếu 1 bill giữa lô → MISSING_BILLS + tiền cũng lệch', () => {
    // Bỏ bill thứ 6 (Số HĐ 000505) → gap ưu tiên MISSING_BILLS.
    const bills = [
      bill('000500', 10_000_000),
      bill('000501', 12_000_000),
      bill('000502', 8_500_000),
      bill('000503', 9_999_000),
      bill('000504', 11_000_000),
      // thiếu 000505
      bill('000506', 13_000_000),
      bill('000507', 10_500_000),
      bill('000508', 9_000_000),
      bill('000509', 11_000_000),
      bill('000510', 10_500_000),
    ];
    const settlement: SettlementInfo = { totalCount: 11, totalAmount: 112_999_000 };
    const r = reconcileBatch(bills, settlement);
    expect(r.status).toBe('MISSING_BILLS');
    expect(r.missingInvoiceNumbers).toEqual(['000505']);
    expect(r.collectedCount).toBe(10);
    expect(r.expectedCount).toBe(11);
  });

  it('(10) nhiều số thiếu trong dải → liệt kê đủ, sắp tăng dần', () => {
    const bills = [bill('000412', 1), bill('000415', 1), bill('000418', 1)];
    const r = reconcileBatch(bills, { totalCount: 7, totalAmount: 3 });
    expect(r.status).toBe('MISSING_BILLS');
    expect(r.missingInvoiceNumbers).toEqual(['000413', '000414', '000416', '000417']);
  });

  it('(11) totalCount null nhưng totalAmount lệch → AMOUNT_MISMATCH', () => {
    const bills = [bill('000412', 10_000_000), bill('000413', 20_000_000)];
    const r = reconcileBatch(bills, { totalCount: null, totalAmount: 40_000_000 });
    expect(r.status).toBe('AMOUNT_MISMATCH');
    expect(r.expectedCount).toBeNull();
    expect(r.expectedAmount).toBe(40_000_000);
  });

  it('(12) settlement cả 2 null nhưng đủ Số HĐ → OK', () => {
    const bills = [bill('000412', 1), bill('000413', 1)];
    const r = reconcileBatch(bills, { totalCount: null, totalAmount: null });
    expect(r.status).toBe('OK');
    expect(r.missingInvoiceNumbers).toEqual([]);
  });

  it('(13) danh sách rỗng + settlement null → NO_SETTLEMENT, count 0', () => {
    const r = reconcileBatch([], null);
    expect(r.status).toBe('NO_SETTLEMENT');
    expect(r.collectedCount).toBe(0);
    expect(r.collectedAmount).toBe(0);
    expect(r.missingInvoiceNumbers).toEqual([]);
  });
});

/** Pad Số HĐ về 6 chữ số cho fixture (vd 500 -> '000500'). */
function padInv(n: number): string {
  return n.toString().padStart(6, '0');
}
