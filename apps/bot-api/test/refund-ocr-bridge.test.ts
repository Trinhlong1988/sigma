// SIGMA (2/8, tính năng "Hoàn tiền" MỚI) — regression THUẦN cho phần đọc biên lai chuyển khoản hoàn tiền
// (ocr-bridge.ts extractRefundReceiptFields/buildRefundReceiptPreview).
//
// GIỚI HẠN THẬT (ghi lại đúng như đã ghi trong ocr-bridge.ts): CHƯA có ảnh mẫu biên lai chuyển khoản hoàn tiền
// THẬT nào được Admin Demo gửi tính tới lúc build — mọi `lines` dưới đây là DÒNG TỰ DỰNG dựa trên thuật ngữ
// chuyển khoản ngân hàng VN phổ biến + ví dụ Admin Demo mô tả bằng lời (BIDV, "Đến: KHACH HANG 44", TK
// 8791797777 tại TCB, "Nội dung: LUU THI TRANG NHUNG Chuyen tien") — KHÔNG PHẢI output PaddleOCR thật như 6
// fixture `REAL_BILL_*_OCR_LINES` của ocr-bridge.test.ts (bill quẹt thẻ, đã verify bằng 19 ảnh mẫu thật B121).
// Test này CHỈ xác nhận LOGIC PARSE chạy đúng theo alias đã viết, KHÔNG PHẢI bằng chứng "đọc đúng ảnh thật".
import { describe, expect, it } from 'vitest';
import { buildRefundReceiptPreview, extractRefundReceiptFields, type OcrLine } from '../src/ocr-bridge.js';

describe('extractRefundReceiptFields', () => {
  const fullLines: OcrLine[] = [
    { text: 'BIDV', score: 0.99 },
    { text: 'Người chuyển', score: 0.9 },
    { text: 'LUU THI TRANG NHUNG', score: 0.9 },
    { text: 'Ngày Giờ', score: 0.9 },
    { text: '02/08/2026 10:30:00', score: 0.9 },
    { text: 'Người nhận', score: 0.9 },
    { text: 'KHACH HANG 44', score: 0.9 },
    { text: 'Số tài khoản nhận', score: 0.9 },
    { text: '8791 7977 77', score: 0.9 }
  ];

  it('đọc ĐỦ 5 trường khi nhãn/giá trị đúng bố cục 2 dòng liên tiếp', () => {
    const r = extractRefundReceiptFields(fullLines);
    expect(r.bankName).toEqual({ value: 'BIDV', uncertain: false });
    expect(r.senderName).toEqual({ value: 'LUU THI TRANG NHUNG', uncertain: false });
    expect(r.recipientName).toEqual({ value: 'KHACH HANG 44', uncertain: false });
    // Số tài khoản nhận — bỏ khoảng trắng OCR chèn giữa các nhóm số.
    expect(r.recipientAccountNumber).toEqual({ value: '8791797777', uncertain: false });
    expect(r.dateTime).toEqual({ value: '02/08/2026 10:30:00', uncertain: false });
  });

  it('field KHÔNG có nhãn tương ứng trong ảnh → null, KHÔNG throw', () => {
    const r = extractRefundReceiptFields([{ text: 'chỉ có 1 dòng vô nghĩa', score: 0.9 }]);
    expect(r.bankName).toBeNull();
    expect(r.senderName).toBeNull();
    expect(r.recipientName).toBeNull();
    expect(r.recipientAccountNumber).toBeNull();
    expect(r.dateTime).toBeNull();
  });

  it('CỐ Ý KHÔNG có alias "Số tài khoản" trần trụi — dòng nhãn mơ hồ (không ghi rõ "nhận"/"thụ hưởng") KHÔNG được nhặt làm recipientAccountNumber', () => {
    const ambiguousLines: OcrLine[] = [
      { text: 'Số tài khoản', score: 0.9 }, // KHÔNG rõ của ai (có thể là người CHUYỂN) — cố ý không alias.
      { text: '1111222233', score: 0.9 }
    ];
    const r = extractRefundReceiptFields(ambiguousLines);
    expect(r.recipientAccountNumber).toBeNull();
  });

  it('nhãn "Người nhận"/"Người chuyển" KHÔNG bị đọc nhầm lẫn nhau (thứ tự đúng field)', () => {
    const swapped: OcrLine[] = [
      { text: 'Người nhận', score: 0.9 },
      { text: 'A NHAN TIEN', score: 0.9 },
      { text: 'Người chuyển', score: 0.9 },
      { text: 'B GUI TIEN', score: 0.9 }
    ];
    const r = extractRefundReceiptFields(swapped);
    expect(r.recipientName).toEqual({ value: 'A NHAN TIEN', uncertain: false });
    expect(r.senderName).toEqual({ value: 'B GUI TIEN', uncertain: false });
  });

  it('số tài khoản có ký tự lạ dính kèm (OCR nhiễu, vd dấu ":"/"-") vẫn lọc ra đúng chuỗi chữ+số', () => {
    const lines: OcrLine[] = [
      { text: 'STK nhận', score: 0.9 },
      { text: '879-1797-777', score: 0.9 }
    ];
    const r = extractRefundReceiptFields(lines);
    expect(r.recipientAccountNumber).toEqual({ value: '8791797777', uncertain: false });
  });
});

describe('buildRefundReceiptPreview', () => {
  it('gộp ĐỦ buildAmountPreview (số tiền) + extractRefundReceiptFields (5 trường)', () => {
    const lines: OcrLine[] = [
      { text: 'BIDV', score: 0.99 },
      { text: 'Người nhận', score: 0.9 },
      { text: 'KHACH HANG 44', score: 0.9 },
      { text: 'Số tài khoản nhận', score: 0.9 },
      { text: '8791797777', score: 0.9 },
      { text: 'VND 102.707.000', score: 0.95 }
    ];
    const r = buildRefundReceiptPreview(lines);
    expect(r.found).toBe(true);
    expect(r.parsedAmount).toBe(102_707_000);
    expect(r.recipientName).toEqual({ value: 'KHACH HANG 44', uncertain: false });
    expect(r.recipientAccountNumber).toEqual({ value: '8791797777', uncertain: false });
    expect(r.bankName).toEqual({ value: 'BIDV', uncertain: false });
  });

  it('không đọc được số tiền nào → found:false, các trường khác vẫn đọc độc lập (KHÔNG phụ thuộc lẫn nhau)', () => {
    const lines: OcrLine[] = [
      { text: 'BIDV', score: 0.99 },
      { text: 'Người nhận', score: 0.9 },
      { text: 'KHACH HANG 44', score: 0.9 }
    ];
    const r = buildRefundReceiptPreview(lines);
    expect(r.found).toBe(false);
    expect(r.recipientName).toEqual({ value: 'KHACH HANG 44', uncertain: false });
  });
});
