// SIGMA LANE B Vòng 2 (#4, 3/8) — verify OCR biên lai HOÀN TIỀN bằng LINES THẬT (chạy PaddleOCR thật qua
// 2 ảnh mẫu Admin Demo gửi: apps/ocr-service/samples/refund/*.jpg — xem GROUND_TRUTH.md). Bài học B121: CẤM viết
// alias/regex từ nhìn ảnh bằng mắt — PHẢI dùng `lines[]` THẬT do OCR trả về. Các fixture dưới đây là output
// THẬT của OCR (copy nguyên văn text+score từ POST /ocr, KHÔNG chỉnh tay) — nếu OCR đổi model/kết quả, cập
// nhật fixture bằng cách chạy lại OCR thật, KHÔNG sửa tay theo suy đoán.
import { describe, expect, it } from 'vitest';
import { buildRefundReceiptPreview, extractRefundReceiptFields, extractRefundTransferCode, type OcrLine } from '../src/ocr-bridge.js';

// ── FIXTURE THẬT 1: BIDV (app gửi) → Techcombank (người nhận). Số tiền phân tách bằng DẤU PHẨY 102,707,000.
// Nhãn "Đn:" (=Đến) + "Tàikhoàn:" (=Tài khoản) INLINE (nhãn+giá trị CÙNG dòng). 1 STK thuần (8791797777).
const BIDV_LINES: OcrLine[] = [
  { text: 'BIDV', score: 0.9999890327453613 },
  { text: 'Giao dch thành công', score: 0.9985019564628601 },
  { text: '102,707,000 vND', score: 0.9600850939750671 },
  { text: '02/08/202615:52:57', score: 0.9998223185539246 },
  { text: 'Đn: KHACH HANG 44', score: 0.9273263216018677 },
  { text: 'Tàikhoàn: 8791797777', score: 0.9680947065353394 },
  { text: 'Tai:', score: 0.9990863800048828 },
  { text: 'NHTMCP Ký Thương Vit Nam (TCB)', score: 0.9470218420028687 },
  { text: 'Nidung', score: 0.9996265769004822 },
  { text: 'LUU THI TRANG NHUNG Chuyen tien', score: 0.9828201532363892 },
  { text: 'Stham chiu', score: 0.9837309718132019 },
  { text: '6214BIDVE2DY1464', score: 0.9998852014541626 }
];

// ── FIXTURE THẬT 2: ACB (app gửi) → MB Bank (người nhận). Số tiền phân tách bằng DẤU CHẤM 177.712.000.
// Nhãn "Tù"(=Từ)/"ĐDn"(=Đến) đứng RIÊNG dòng (giá trị ở dòng SAU). "Tài khoản" hiển thị là MÃ VietQR
// VQRQAASGJ6634 (KHÔNG phải dãy số TK thuần) → đối chiếu chỉ so TÊN, KHÔNG so số.
const ACB_LINES: OcrLine[] = [
  { text: 'ACB', score: 0.9998252391815186 },
  { text: 'PRIVILEGE', score: 0.999099850654602 },
  { text: 'BANKING', score: 0.9999651908874512 },
  { text: 'Chuyn tiên thành công!', score: 0.9809466004371643 },
  { text: '177.712.000 VND', score: 0.9993592500686646 },
  { text: 'Mt trăm by mưi by triu by trăm mưi hai', score: 0.9833495616912842 },
  { text: 'nghìn đông', score: 0.9520643949508667 },
  { text: 'Tù', score: 0.9952974319458008 },
  { text: 'LUU THI TRANG NHUNG', score: 0.9948732256889343 },
  { text: '******86', score: 0.9999791383743286 },
  { text: 'ĐDn', score: 0.7773053050041199 },
  { text: 'KHACH HANG 38', score: 0.9995667338371277 },
  { text: 'MB Bank - NH TMCP Quan Doi', score: 0.9749227166175842 },
  { text: 'VQRQAASGJ6634', score: 0.999994158744812 },
  { text: 'Chuyn lúc', score: 0.9982461929321289 },
  { text: '02/08/2026,22:45:20', score: 0.9999866485595703 },
  { text: 'Phí', score: 0.9999341368675232 },
  { text: 'Min phí', score: 0.9998742341995239 },
  { text: 'Mã giao dch', score: 0.9991763830184937 },
  { text: '6819', score: 0.9999987483024597 },
  { text: 'Ni dung', score: 0.9998751878738403 },
  { text: 'LUU THI TRANG NHUNG CHUYEN', score: 0.9993174076080322 },
  { text: 'KHOAN-020826-22:45:20', score: 0.9998961687088013 },
  { text: '6214ASCB02TA3BAV', score: 0.9998300075531006 },
  { text: 'CHUYÊNKHOÀNNHANH', score: 0.9582608938217163 },
  { text: 'Tu', score: 0.8491175770759583 },
  { text: '500', score: 0.9999505877494812 },
  { text: 'NAPAS 247', score: 0.9925040006637573 }
];

describe('#4 OCR biên lai hoàn tiền — BIDV→TCB (lines THẬT, phẩy phân tách nghìn, INLINE nhãn)', () => {
  it('số tiền = 102.707.000 (đọc đúng dấu PHẨY, KHÔNG ×1000 sai)', () => {
    const p = buildRefundReceiptPreview(BIDV_LINES);
    expect(p.parsedAmount).toBe(102_707_000);
  });
  it('tên người nhận = KHACH HANG 44 (nhãn "Đn:" INLINE)', () => {
    const f = extractRefundReceiptFields(BIDV_LINES);
    expect(f.recipientName?.value).toBe('KHACH HANG 44');
  });
  it('STK người nhận = 8791797777 (nhãn "Tàikhoàn:" INLINE, 1 STK thuần)', () => {
    const f = extractRefundReceiptFields(BIDV_LINES);
    expect(f.recipientAccountNumber?.value).toBe('8791797777');
    expect(f.recipientAccountVietQR).toBeNull();
  });
  it('ngân hàng NGƯỜI NHẬN = TCB (KHÔNG phải brand app BIDV)', () => {
    const f = extractRefundReceiptFields(BIDV_LINES);
    expect(f.recipientBank?.value).toBe('TCB');
  });
  it('mã chuyển tiền/số tham chiếu = 6214BIDVE2DY1464', () => {
    expect(extractRefundTransferCode(BIDV_LINES)).toBe('6214BIDVE2DY1464');
  });
});

describe('#4 OCR biên lai hoàn tiền — ACB→MB (lines THẬT, chấm phân tách nghìn, nhãn 2 dòng, VietQR)', () => {
  it('số tiền = 177.712.000 (đọc đúng dấu CHẤM)', () => {
    const p = buildRefundReceiptPreview(ACB_LINES);
    expect(p.parsedAmount).toBe(177_712_000);
  });
  it('tên người nhận = KHACH HANG 38 (nhãn "ĐDn" đứng RIÊNG dòng, giá trị dòng sau) — KHÔNG lấy nhầm người GỬI (Từ)', () => {
    const f = extractRefundReceiptFields(ACB_LINES);
    expect(f.recipientName?.value).toBe('KHACH HANG 38');
    expect(f.senderName?.value).toBe('LUU THI TRANG NHUNG'); // "Tù" (Từ) → người gửi.
  });
  it('STK = MÃ VietQR → recipientAccountNumber NULL (không so số), recipientAccountVietQR = VQRQAASGJ6634', () => {
    const f = extractRefundReceiptFields(ACB_LINES);
    expect(f.recipientAccountNumber).toBeNull();
    expect(f.recipientAccountVietQR).toBe('VQRQAASGJ6634');
  });
  it('ngân hàng NGƯỜI NHẬN = MB (KHÔNG phải brand app ACB)', () => {
    const f = extractRefundReceiptFields(ACB_LINES);
    expect(f.recipientBank?.value).toBe('MB');
  });
  it('mã chuyển tiền/số tham chiếu mạnh = 6214ASCB02TA3BAV (KHÔNG lấy nhầm mã VietQR/4-số 6819)', () => {
    const code = extractRefundTransferCode(ACB_LINES);
    expect(code).toBe('6214ASCB02TA3BAV');
    expect(code).not.toBe('VQRQAASGJ6634');
  });
});
