// Regression cho OCR bill MBV (Admin Demo 12/8) — ĐỌC TID + phân biệt bill TỔNG KẾT/ĐÓNG LÔ vs bill LẺ.
// Bối cảnh: bill MBV KHÔNG in nhãn "TID" → OCR cũ trả tid=null (bug Admin Demo báo). Admin Demo CHỐT:
//   • TID = "REF ID" (dòng "APP VER: ...MBV - REF ID: <số>") = "MÃ MÁY" (dòng "MÃ MÁY  <số>"). CÙNG 1 giá trị.
//   • KHÔNG lấy "MÃ ĐẠI LÝ" (merchant, dài hơn) làm TID.
//   • Bill TỔNG KẾT/ĐÓNG LÔ: KHÔNG có SỐ HÓA ĐƠN → invoiceNumber=null (không báo lỗi).
//   • Bill LẺ: SỐ HÓA ĐƠN (invoiceNumber) = "SỐ TRACE"; KHÔNG nhầm "SỐ THAM CHIẾU"/"MÃ C.CHI"/"MÃ ĐẠI LÝ".
// Fixture = các dòng text OCR THẬT lấy từ 2 ảnh mẫu Admin Demo gửi 12/8 (dùng text-lines — không cần PaddleOCR live).
// Kèm regression các format bank KHÁC (MB/VPBank/Sacombank/ABBANK) để chắc chắn KHÔNG phá đường đọc cũ.
import { describe, it, expect } from 'vitest';
import { extractBillFields } from '../src/ocr-bridge.js';

const L = (text: string, score = 0.99) => ({ text, score });
const v = (f: { value: string } | null) => (f ? f.value : null);

describe('ocr-bridge MBV — bill TỔNG KẾT / ĐÓNG LÔ', () => {
  const lines = [
    L('MBV'),
    L('APP VER: 200825A920MBV - REF ID: 20280820'),
    L('TÊN ĐẠI LÝ:            HKO THANH NAM-4'),
    L('Đ.CHỈ ĐẠI LÝ:          KHU 6, XA LAM THAO / PHU THO'),
    L('TỔNG KẾT / ĐÓNG LÔ'),
    L('MÃ ĐẠI LÝ             10280000000182'),
    L('MÃ MÁY                20280820'),
    L('SỐ LÔ                 000014'),
    L('NGÀY/GIỜ              2026/08/11 12:38:29')
  ];

  it('TID = REF ID = MÃ MÁY = 20280820 (KHÔNG phải MÃ ĐẠI LÝ)', () => {
    const f = extractBillFields(lines);
    expect(v(f.tid)).toBe('20280820');
    expect(v(f.tid)).not.toBe('10280000000182');
    expect(f.tid?.uncertain).toBe(false);
  });

  it('SỐ LÔ = 000014 (không đọc nhầm dòng NGÀY/GIỜ)', () => {
    expect(v(extractBillFields(lines).batchNumber)).toBe('000014');
  });

  it('bill đóng lô KHÔNG có SỐ HÓA ĐƠN → invoiceNumber = null (không báo lỗi)', () => {
    expect(extractBillFields(lines).invoiceNumber).toBeNull();
  });
});

describe('ocr-bridge MBV — bill LẺ (giao dịch đơn)', () => {
  const lines = [
    L('MBV'),
    L('APP VER: 200825A920MBV - REF ID: 20280819'),
    L('TÊN ĐẠI LÝ:            HKD DEMO 6-3'),
    L('MÃ ĐẠI LÝ             10280000000181'),
    L('MÃ MÁY                20280819'),
    L('SỐ THẺ: VISA          4030-****-****-1529(C)'),
    L('THANH TOÁN'),
    L('SỐ LÔ  000014      SỐ TRACE  000029'),
    L('NGÀY:  11/08/2026   GIỜ:  17:31:06'),
    L('SỐ THAM CHIẾU  600000000001     MÃ C.CHI  209695'),
    L('SỐ TIỀN     VND 13.899.000')
  ];

  it('TID = 20280819 (REF ID = MÃ MÁY)', () => {
    expect(v(extractBillFields(lines).tid)).toBe('20280819');
  });

  it('SỐ LÔ = 000014', () => {
    expect(v(extractBillFields(lines).batchNumber)).toBe('000014');
  });

  it('SỐ HÓA ĐƠN = SỐ TRACE = 000029 (KHÔNG phải SỐ THAM CHIẾU / MÃ C.CHI)', () => {
    const f = extractBillFields(lines);
    expect(v(f.invoiceNumber)).toBe('000029');
    expect(v(f.invoiceNumber)).not.toBe('600000000001'); // SỐ THAM CHIẾU
    expect(v(f.invoiceNumber)).not.toBe('209695'); // MÃ C.CHI
  });
});

describe('ocr-bridge MBV — 2 nguồn TID lệch nhau → uncertain', () => {
  it('REF ID != MÃ MÁY → trả (ưu tiên MÃ MÁY) NHƯNG uncertain=true (không tự chọn bừa)', () => {
    const f = extractBillFields([
      L('MBV'),
      L('APP VER: 200825A920MBV - REF ID: 20280819'),
      L('MÃ MÁY                20289999')
    ]);
    expect(v(f.tid)).toBe('20289999');
    expect(f.tid?.uncertain).toBe(true);
  });
});

describe('ocr-bridge — regression các format bank khác KHÔNG bị phá', () => {
  it('MB Bank: TID:50550759 (nhãn TID cùng dòng) + batch/invoice/datetime dòng sau', () => {
    const f = extractBillFields([
      L('MB'),
      L('SETTLEMENT - KẾT TOÁN'),
      L('TID:50550759/SEO: 001283 MID:'),
      L('NGÀY GIỜ'),
      L('31/07/2026 17:03:50'),
      L('BATCH No/Số Lô:'),
      L('001234'),
      L('TRACE No/Số hóa đơn:'),
      L('005678')
    ]);
    expect(v(f.tid)).toBe('50550759');
    expect(v(f.batchNumber)).toBe('001234');
    expect(v(f.invoiceNumber)).toBe('005678');
    expect(v(f.dateTime)).toBe('31/07/2026 17:03:50');
  });

  it('VPBank: TID chữ+số DEMO-TID-11 (nhãn "TID:" riêng dòng, giá trị dòng sau)', () => {
    const f = extractBillFields([
      L('VPBANK'),
      L('TID:'),
      L('DEMO-TID-11 M0:019380200947501'),
      L('NGÀY GIỜ:'),
      L('08/01/202616:1809')
    ]);
    expect(v(f.tid)).toBe('DEMO-TID-11');
  });

  it('Sacombank: batch/invoice song ngữ inline "Batch/Lô:"/"Invoice/Hóa đơn:"', () => {
    const f = extractBillFields([
      L('SACOMBANK'),
      L('Date/Ngày: 02/08/2026 09:15:22'),
      L('Batch/Lô: 000123'),
      L('Invoice/Hóa đơn: 000456')
    ]);
    expect(v(f.batchNumber)).toBe('000123');
    expect(v(f.invoiceNumber)).toBe('000456');
  });

  it('ABBANK-EN: BATCH/INVOICE nhãn tiếng Anh, giá trị dòng sau', () => {
    const f = extractBillFields([
      L('ABBANK'),
      L('MERCHANT NAME:'),
      L('HKD ABC'),
      L('BATCH:'),
      L('000111'),
      L('INVOICE:'),
      L('000222'),
      L('DATE: APR 22, 2026'),
      L('TIME: 10:20:30')
    ]);
    expect(v(f.batchNumber)).toBe('000111');
    expect(v(f.invoiceNumber)).toBe('000222');
  });
});
