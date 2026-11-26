// SIGMA LANE B (#B123-fix, 3/8) — Admin Demo báo: OCR bill HOÀN TIỀN SAI khi TÊN NGƯỜI ĐƯỢC HOÀN nằm 2 DÒNG
// (tên dài tràn dòng); và NGÂN HÀNG NGƯỜI NHẬN "không trả kết quả".
//
// ⚠️ GIỚI HẠN THẬT (ghi thẳng, KHÔNG giả vờ đã verify ảnh thật — đúng B121): 2 ảnh mẫu refund THẬT hiện có
// (apps/ocr-service/samples/refund/*.jpg — đã CHẠY LẠI PaddleOCR thật 3/8 để đối chiếu) đều có tên người nhận
// nằm GỌN 1 DÒNG ("KHACH HANG 44" / "KHACH HANG 38") — KHÔNG có mẫu tên 2 dòng nào. Admin Demo CHƯA gửi ảnh loại
// tên-2-dòng. Vì vậy `lines[]` dưới đây là DÒNG MÔ PHỎNG, dựng theo ĐÚNG dạng OCR thật (nhãn hướng "Đến" đứng
// RIÊNG dòng như fixture ACB thật, tên chữ HOA không dấu, STK/mã ngân hàng người nhận bên dưới) — KHÔNG phải
// output PaddleOCR thật. Khi Admin Demo gửi ảnh tên-2-dòng thật, PHẢI chạy OCR thật + cập nhật fixture (quy trình
// B121), KHÔNG giữ mãi mẫu mô phỏng làm bằng chứng cuối.
//
// Bill mô phỏng: app CHUYỂN không phải ngân hàng được nhận diện (vd ví điện tử / logo không đọc ra mã bank) →
// dòng bank DUY NHẤT nhận diện được lại là của NGƯỜI NHẬN ("Techcombank") → findBankName() vô tình coi đó là
// "brand", findRecipientBank() (cũ) loại trừ chính nó → trả null = đúng triệu chứng Admin Demo báo.
import { describe, expect, it } from 'vitest';
import { extractRefundReceiptFields, type OcrLine } from '../src/ocr-bridge.js';

// SIMULATED — tên người nhận TRÀN 2 DÒNG ("KHACH HANG 06" + "NGUYET"), STK số thuần, bank người nhận standalone.
const SIM_2LINE_NAME_LINES: OcrLine[] = [
  { text: 'MoMo', score: 0.99 }, // app CHUYỂN — KHÔNG phải alias ngân hàng nào.
  { text: 'Chuyển tiền thành công', score: 0.98 },
  { text: '5.000.000 VND', score: 0.99 },
  { text: '03/08/2026 09:15:00', score: 0.99 },
  { text: 'Đến', score: 0.95 }, // nhãn hướng đứng RIÊNG dòng (dạng ACB thật).
  { text: 'KHACH HANG 06', score: 0.99 }, // tên dòng 1
  { text: 'NGUYET', score: 0.98 }, // tên dòng 2 (tràn) — PHẢI gộp vào tên.
  { text: 'Tài khoản: 0123456789', score: 0.97 }, // STK có nhãn INLINE → mốc DỪNG gộp tên.
  { text: 'Techcombank', score: 0.95 }, // ngân hàng NGƯỜI NHẬN (chứa "BANK").
  { text: 'Số tham chiếu', score: 0.98 },
  { text: 'FT26ABCD1234567', score: 0.99 }
];

describe('#B123-fix — tên người nhận TRÀN 2 DÒNG (mô phỏng, dạng OCR thật)', () => {
  it('recipientName GỘP đủ 2 dòng = "KHACH HANG 05" (KHÔNG chỉ lấy dòng đầu)', () => {
    const f = extractRefundReceiptFields(SIM_2LINE_NAME_LINES);
    expect(f.recipientName?.value).toBe('KHACH HANG 05');
  });

  it('DỪNG gộp tại STK — KHÔNG nuốt số tài khoản/ngân hàng vào tên', () => {
    const f = extractRefundReceiptFields(SIM_2LINE_NAME_LINES);
    expect(f.recipientName?.value).not.toContain('0123456789');
    expect(f.recipientName?.value).not.toContain('Techcombank');
  });

  it('STK người nhận = 0123456789 (không bị tên nuốt mất)', () => {
    const f = extractRefundReceiptFields(SIM_2LINE_NAME_LINES);
    expect(f.recipientAccountNumber?.value).toBe('0123456789');
  });

  it('recipientBank = TCB (đọc được ngân hàng người nhận, KHÔNG null) dù app CHUYỂN không phải bank nhận diện được', () => {
    const f = extractRefundReceiptFields(SIM_2LINE_NAME_LINES);
    expect(f.recipientBank?.value).toBe('TCB');
  });
});

// Biến thể: tên 2 dòng dưới nhãn "Người nhận" (findValueAfterLabel path) — cùng phải gộp.
const SIM_2LINE_NAME_LABELVN: OcrLine[] = [
  { text: 'BIDV', score: 0.99 },
  { text: 'Người nhận', score: 0.95 },
  { text: 'KHACH HANG 53', score: 0.99 },
  { text: 'PHUONG', score: 0.98 }, // tràn dòng 2
  { text: 'Số tài khoản nhận', score: 0.95 },
  { text: '9988776655', score: 0.97 },
  { text: 'NHTMCP A Chau (ACB)', score: 0.95 }
];

describe('#B123-fix — tên 2 dòng dưới nhãn "Người nhận" (fallback path)', () => {
  it('recipientName = "KHACH HANG 10" (gộp 2 dòng, dừng tại nhãn STK)', () => {
    const f = extractRefundReceiptFields(SIM_2LINE_NAME_LABELVN);
    expect(f.recipientName?.value).toBe('KHACH HANG 10');
  });
  it('recipientBank = ACB (ngân hàng người nhận đọc được)', () => {
    const f = extractRefundReceiptFields(SIM_2LINE_NAME_LABELVN);
    expect(f.recipientBank?.value).toBe('ACB');
  });
});
