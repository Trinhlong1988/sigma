// SIGMA (31/7, B71 phần 2) — regression THUẦN cho ocr-bridge.ts (extractAmountField/buildAmountPreview/
// callOcrService). Đặt ở `test/` (KHÔNG phải `apps/bot-api/src/`) để khớp ĐÚNG convention thật của suite này
// (`vitest.config.ts` → `include: ['test/**/*.test.ts']` — MỌI test bot-api khác đều nằm ở đây, xem
// test/chat-attachments-routes.test.ts/test/auth.test.ts...); đặt trong src/ sẽ KHÔNG được vitest nhặt vào
// (include pattern không khớp) → test "chạy" nhưng thực ra không ai gọi tới, đúng lớp lỗi R198 "trông như có
// kiểm mà không kiểm gì cả". 3 test đầu (extractAmountField/buildAmountPreview) là logic THUẦN, KHÔNG cần
// Postgres/OCR service Python nào — nhưng suite này dùng CHUNG globalSetup (throwaway Postgres, xem
// test/global-setup.ts) với các file test khác trong thư mục, nên khi chạy `npx vitest run` DB throwaway vẫn
// được dựng/hủy bình thường dù các test ở file này không đụng DB.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAmountPreview,
  buildBillPreview,
  buildBillPreviewMultiScale,
  mergeLowresBillFields,
  callOcrService,
  checkSettlementRisk,
  extractAmountField,
  extractBillFields,
  TENTATIVE_MIN_CHAR_CONFIDENCE,
  type OcrLine
} from '../src/ocr-bridge.js';

// PNG 1x1 THẬT ĐẦY ĐỦ (CÙNG buffer test/chat-attachments-routes.test.ts dùng, KHÔNG bịa) — chỉ 8-byte signature
// "\x89PNG\r\n\x1a\n" KHÔNG ĐỦ để `file-type` nhận diện, cần chunk IHDR hợp lệ thật. Dùng buffer này cho MỌI
// test callOcrService() cần vượt qua bước sniff mime để chạm tới fetch() — buffer chuỗi tuỳ ý ("fake-jpeg-bytes",
// "x"...) sẽ bị chặn NGAY ở bước sniff (MIME_NOT_ALLOWED), không đại diện đúng luồng "ảnh thật gọi service".
const REAL_PNG_BUFFER = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

// Tái hiện ĐÚNG output PaddleOCR PP-OCRv6 THẬT đã verify 31/7 trên bill "HKD DEMO 53" (BUGS_FIXED.md
// B70/B71-part1, KHÔNG bịa shape) — dòng tiền thật "Thanh toán VND 52.700.000" bị OCR đọc rớt 1 dấu chấm
// thành "VND 52700.000" (confidence 0.9592), THEO SAU bởi nhiều dòng "VND 0" khác (mục "Hoàn tiền"/"Đã hủy"...)
// cũng khớp mẫu regex "VND ..." — fixture này khẳng định hàm lấy ĐÚNG dòng ĐẦU TIÊN khớp, không lạc sang các
// dòng "VND 0" phía sau.
const REAL_BILL_OCR_LINES: OcrLine[] = [
  { text: 'HKD DEMO 53', score: 0.98 },
  { text: 'Thanh toan', score: 0.9701 },
  { text: 'VND 52700.000', score: 0.9592 },
  { text: 'Hoan tien', score: 0.9123 },
  { text: 'VND 0', score: 0.9301 },
  { text: 'Da huy', score: 0.9044 },
  { text: 'VND 0', score: 0.9256 },
  { text: 'VND 0', score: 0.9418 },
  { text: 'VND 0', score: 0.897 }
];

// BUG THẬT (1/8) — Admin Demo chụp ảnh minh chứng bill MB Bank/máy PAX thật báo app hiện "140đ" thay vì 140 TRIỆU.
// LEAD thêm log chẩn đoán TẠM ở route (đã xóa sau khi tìm ra nguyên nhân), bắt được ĐÚNG NGUYÊN VĂN 32 dòng
// OCR thật server nhận — copy y hệt (KHÔNG rút gọn/sửa) làm fixture regression, KHÔNG bịa lại từ trí nhớ.
// Điểm mấu chốt: PaddleOCR đọc RA 4 LẦN "VND ..." với dấu phân cách KHÔNG NHẤT QUÁN (nhiễu nhận diện chấm/
// phẩy trên bill in nhiệt nhỏ) — dòng ĐẦU TIÊN khớp là "VND140,000.000" (lẫn cả chấm lẫn phẩy), ĐÚNG dòng gây
// bug vì regex cũ dừng capture ngay tại dấu phẩy.
const REAL_BILL_COMMA_BUG_OCR_LINES: OcrLine[] = [
  { text: 'VKHONG HOÀN TIEN', score: 0.9 },
  { text: 'LIÊN DÀNH CHO DAILÝ', score: 0.9 },
  { text: 'MB', score: 0.99 },
  { text: 'TÊN DAI LÝ:', score: 0.9 },
  { text: 'HKD DEMOMAY 1', score: 0.9 },
  { text: 'D.CHI DAI LY:', score: 0.9 },
  { text: '11B NGACH 7 NGO 101 THA', score: 0.9 },
  { text: 'NH NHAN,BACH MAI,HN', score: 0.9 },
  { text: 'DATE TIME/NGÀY GIÒ', score: 0.9 },
  { text: '21/11/2025 10:39:56', score: 0.9 },
  { text: 'SETTLEMENT-KÊT TOÁN', score: 0.9 },
  { text: 'TID:50550759/SEO:001283 MID:', score: 0.9 },
  { text: '055-C-458485', score: 0.9 },
  { text: 'BATCH No/SÖ LÔ', score: 0.9 },
  { text: '000189', score: 0.9 },
  { text: 'TRACE NO/SÔ H.DON:', score: 0.9 },
  { text: '001283', score: 0.9 },
  { text: 'TÓNG KET***', score: 0.9 },
  { text: 'LÔ DÃ KÊT TOÁN', score: 0.9 },
  { text: 'TIÉN', score: 0.9 },
  { text: '2', score: 0.9 },
  { text: 'VND140,000.000', score: 0.95 },
  { text: 'TÓNG CÔNG', score: 0.9 },
  { text: 'VND 140,000,000', score: 0.95 },
  { text: 'THE:', score: 0.9 },
  { text: 'MASTERCARD', score: 0.9 },
  { text: 'TIÉN', score: 0.9 },
  { text: '2', score: 0.9 },
  { text: 'VND 140,000.000', score: 0.95 },
  { text: 'TONG CÔNG', score: 0.9 },
  { text: 'VND 140.000.000', score: 0.95 },
  { text: '3', score: 0.9 },
  { text: 'PAX', score: 0.9 }
];

// BUG THẬT #2 (1/8) — Admin Demo quét bill "HKD THANH TOÁN 2" (TID 53550015), báo "vẫn báo không đọc được số
// tiền". LEAD thêm log chẩn đoán tạm lần 2, bắt được ĐÚNG NGUYÊN VĂN 30 dòng OCR thật — copy y hệt, KHÔNG bịa.
// Điểm mấu chốt: PaddleOCR đọc NHẦM chữ "V" thành "U" — bill in "VND79,829,000" nhưng OCR ra "UND79,829,000"
// (NHẤT QUÁN cả 4/4 lần xuất hiện dòng số tiền trên CHÍNH bill này) — lớp nhiễu KHÁC bug #1 (đó là dấu phân
// cách, đây là chính chữ cái từ khoá "VND"). 6 trường khác (TID/HKD/ngày giờ/số lô/HĐ) đọc đúng bình thường
// (không đụng chữ V nào) — CHỈ số tiền bị ảnh hưởng.
const REAL_BILL_V_TO_U_BUG_OCR_LINES: OcrLine[] = [
  { text: '12:29', score: 0.9 },
  { text: 'MB', score: 0.99 },
  { text: 'TÉN DAI LY:', score: 0.9 },
  { text: 'HKD THANH TOAN 2', score: 0.9 },
  { text: 'DIA CHI DAI LY :', score: 0.9 },
  { text: 'KHU 12, XA LAM IHAO, II', score: 0.9 },
  { text: 'NH PHU THO', score: 0.9 },
  { text: 'DATETIME/NGAY GIÖ:', score: 0.9 },
  { text: '31/07/2026 17:03:50', score: 0.9 },
  { text: 'SETTLEMENT - KÉT TOÁN', score: 0.9 },
  { text: 'DÓNG(95)', score: 0.9 },
  { text: 'TID:53550015/SEQ:001900 MID:355-C-944162', score: 0.9 },
  { text: 'BATCH No/SÖ LÓ:', score: 0.9 },
  { text: '000295', score: 0.9 },
  { text: 'TRACE No/SÖ HÓA DON:', score: 0.9 },
  { text: '001900', score: 0.9 },
  { text: '***TONG KET***', score: 0.9 },
  { text: 'LÓ DÁ KÉT TOÁN', score: 0.9 },
  { text: 'TONG:', score: 0.9 },
  { text: '8', score: 0.9 },
  { text: 'UND79,829,000', score: 0.95 },
  { text: 'TONG CÔNG', score: 0.9 },
  { text: 'UND79,829,000', score: 0.95 },
  { text: 'THE:', score: 0.9 },
  { text: 'MASTERCARD', score: 0.9 },
  { text: 'TONG:', score: 0.9 },
  { text: '8', score: 0.9 },
  { text: 'UND79,829,000', score: 0.95 },
  { text: 'TÓNG CÓNG', score: 0.9 },
  { text: 'UND79,829,000', score: 0.95 }
];

describe('extractAmountField', () => {
  it('lấy ĐÚNG dòng ĐẦU TIÊN khớp "VND ..." — không nhầm sang các dòng "VND 0" phía sau (bill thật 31/7)', () => {
    const field = extractAmountField(REAL_BILL_OCR_LINES);
    expect(field).not.toBeNull();
    expect(field!.rawText).toBe('52700.000');
    // Confidence rải đều = confidence CỦA DÒNG (0.9592), KHÔNG phải confidence dòng "VND 0" phía sau.
    expect(field!.chars.every((c) => c.confidence === 0.9592)).toBe(true);
    expect(field!.chars.map((c) => c.char).join('')).toBe('52700.000');
  });

  it('trả null nếu KHÔNG có dòng nào khớp mẫu "VND ..."', () => {
    const lines: OcrLine[] = [
      { text: 'HKD DEMO 53', score: 0.98 },
      { text: 'Thanh toan tien mat', score: 0.95 }
    ];
    expect(extractAmountField(lines)).toBeNull();
  });

  it('trả null nếu dòng khớp "VND" nhưng rawText rỗng sau trim (vd "VND" đứng 1 mình)', () => {
    const lines: OcrLine[] = [{ text: 'VND', score: 0.9 }];
    expect(extractAmountField(lines)).toBeNull();
  });
});

describe('buildAmountPreview', () => {
  it('bill thật 31/7: found=true, parsedAmount đúng số ĐÃ BỊ OCR làm rớt dấu chấm, needsManualReview=true (đúng case B70)', () => {
    const preview = buildAmountPreview(REAL_BILL_OCR_LINES);
    expect(preview.found).toBe(true);
    expect(preview.rawText).toBe('52700.000');
    // "52700.000" bỏ hết ký tự không phải số → "52700000" (KHÔNG phải 52700 — parsedAmount phản ánh ĐÚNG
    // chuỗi ký tự OCR trả về, kể cả khi nó đã sai giá trị thật; đây chính là lý do rule phân nhóm B70 tồn tại).
    expect(preview.parsedAmount).toBe(52700000);
    expect(preview.needsManualReview).toBe(true);
    expect(preview.reasons.some((r) => r.includes('phân nhóm'))).toBe(true);
  });

  it('không tìm thấy dòng số tiền nào → found:false, needsManualReview:true, rawText/parsedAmount null', () => {
    const preview = buildAmountPreview([{ text: 'HKD DEMO 53', score: 0.98 }]);
    expect(preview).toEqual({
      found: false,
      rawText: null,
      parsedAmount: null,
      needsManualReview: true,
      reasons: ['Không tìm thấy dòng số tiền (mẫu "VND ...") trong kết quả OCR — cần nhập tay.']
    });
  });

  it('số tiền sạch, confidence cao, đúng định dạng phân nhóm → needsManualReview:false', () => {
    const preview = buildAmountPreview([{ text: 'VND 1.234.567', score: 0.99 }]);
    expect(preview.found).toBe(true);
    expect(preview.rawText).toBe('1.234.567');
    expect(preview.parsedAmount).toBe(1234567);
    expect(preview.needsManualReview).toBe(false);
    expect(preview.reasons).toEqual([]);
  });

  it('TENTATIVE_MIN_CHAR_CONFIDENCE hiện = 0.9 (khớp gợi ý ocr-confidence.rules.ts, CHƯA Admin Demo chốt số cuối)', () => {
    expect(TENTATIVE_MIN_CHAR_CONFIDENCE).toBe(0.9);
  });

  // BILL KẾT TOÁN ĐA LOẠI THẺ (Admin Demo 25/8) — bill in dòng TỔNG + chi tiết theo loại thẻ (Visa/Master/JCB/Napas),
  // mỗi số hiện 2 lần. Trước fix: "8 số không khớp" → bắt kiểm tay OAN. Sau fix: nhận diện dòng tổng (lớn nhất =
  // Σ còn lại) → doanh số = dòng tổng, KHÔNG kiểm tay, KHÔNG cộng đôi. Số THẬT của Admin Demo: tổng 112.999.000 =
  // 68.004.000 + 24.997.000 + 19.998.000.
  it('bill kết toán đa loại thẻ (tổng = Σ chi tiết, mỗi số ×2) → dùng DÒNG TỔNG, needsManualReview=false', () => {
    const lines = [
      { text: 'VND 112.999.000', score: 0.98 }, { text: 'VND 112.999.000', score: 0.97 },
      { text: 'VND 68.004.000', score: 0.98 }, { text: 'VND 68.004.000', score: 0.97 },
      { text: 'VND 24.997.000', score: 0.98 }, { text: 'VND 24.997.000', score: 0.97 },
      { text: 'VND 19.998.000', score: 0.98 }, { text: 'VND 19.998.000', score: 0.97 }
    ];
    const preview = buildAmountPreview(lines);
    expect(preview.found).toBe(true);
    expect(preview.parsedAmount).toBe(112_999_000); // dòng tổng = 68.004tr+24.997tr+19.998tr
    expect(preview.needsManualReview).toBe(false); // KHÔNG bắt kiểm tay
    expect(preview.reasons[0]).toContain('DÒNG TỔNG');
  });

  it('đa số tiền THẬT lệch (không tạo thành tổng=Σ chi tiết) → VẪN needsManualReview=true (giữ chống OCR đọc lệch)', () => {
    // 52.700.000 bị OCR đọc lẫn thành 5.270.000 (rớt 1 số) — 5.27tr KHÔNG = phần còn lại → không phải bill đa thẻ.
    const lines = [
      { text: 'VND 52.700.000', score: 0.95 }, { text: 'VND 52.700.000', score: 0.94 },
      { text: 'VND 5.270.000', score: 0.6 }
    ];
    const preview = buildAmountPreview(lines);
    expect(preview.needsManualReview).toBe(true);
    expect(preview.reasons[0]).toContain('KHÔNG khớp nhau');
  });

  it('BUG THẬT 1/8 (Admin Demo báo "140đ" thay vì 140 triệu) — bill dấu phẩy lẫn dấu chấm: parsedAmount ĐÚNG 140 triệu (KHÔNG còn cắt cụt còn "140")', () => {
    const preview = buildAmountPreview(REAL_BILL_COMMA_BUG_OCR_LINES);
    expect(preview.found).toBe(true);
    // Dòng ĐẦU TIÊN khớp "VND ..." là "VND140,000.000" — rawText PHẢI giữ ĐỦ, KHÔNG bị cắt tại dấu phẩy
    // (trước fix: rawText="140", parsedAmount=140 — lệch x1.000.000, đây chính là bug Admin Demo báo thật).
    expect(preview.rawText).toBe('140,000.000');
    expect(preview.parsedAmount).toBe(140000000);
    // CẬP NHẬT (1/8, ngay sau — Admin Demo chỉ đạo "chấp nhận dấu phẩy mà sao vẫn báo lỗi?"/"chỉ cảnh báo khi mờ
    // không đọc được"): dấu phẩy giờ là dấu phân cách HỢP LỆ (AMOUNT_ALLOWED_CHAR đã mở rộng) + check cấu trúc
    // nhóm 3 số CHUẨN HOÁ phẩy/chấm trước khi so khớp — "140,000.000" chuẩn hoá thành "140.000.000", ĐÚNG cấu
    // trúc → KHÔNG còn cảnh báo (confidence dòng gốc 0.95 cũng đủ cao, check 3 cũng không kích hoạt). Chỉ
    // cảnh báo lại nếu confidence THẤP THẬT (ảnh mờ) — xem test riêng ocr-confidence.rules.test.ts.
    // CẬP NHẬT LẦN 2 (1/8, đối chiếu chéo): fixture này có 4 dòng "VND ..." đều chuẩn hoá về CÙNG 140000000 →
    // giờ đi qua đường ĐỐI CHIẾU CHÉO (TẤT CẢ đồng thuận) thay vì chỉ dựa vào check cấu trúc dòng đầu — kết
    // quả CUỐI vẫn y hệt (không lệch), nhưng độ tin cậy THẬT SỰ cao hơn (4 lần đọc độc lập đồng ý, không phải
    // chỉ 1 dòng "trông có vẻ đúng cấu trúc").
    expect(preview.needsManualReview).toBe(false);
    expect(preview.reasons).toEqual([]);
  });

  it('BUG THẬT #2 (1/8, bill "HKD THANH TOÁN 2") — OCR nhầm "VND" thành "UND" cả 4/4 lần, đối chiếu chéo vẫn ra ĐÚNG 79.829.000, không cảnh báo', () => {
    const preview = buildAmountPreview(REAL_BILL_V_TO_U_BUG_OCR_LINES);
    expect(preview.found).toBe(true);
    expect(preview.parsedAmount).toBe(79829000);
    expect(preview.needsManualReview).toBe(false);
    expect(preview.reasons).toEqual([]);
  });

  it('ĐỐI CHIẾU CHÉO — 3/4 dòng đồng ý 1 giá trị, 1 dòng lệch thật (không phải nhiễu ký tự vô hại) → parsedAmount lấy giá trị ĐA SỐ làm gợi ý NHƯNG vẫn cảnh báo, liệt kê rõ các giá trị khác nhau', () => {
    const lines: OcrLine[] = [
      { text: 'VND 79,829,000', score: 0.95 },
      { text: 'VND 79,829,000', score: 0.95 },
      { text: 'VND 79,829,000', score: 0.95 },
      { text: 'VND 79,928,000', score: 0.95 } // lệch thật (đảo 2 số) — KHÔNG phải cùng giá trị chuẩn hoá
    ];
    const preview = buildAmountPreview(lines);
    expect(preview.found).toBe(true);
    expect(preview.parsedAmount).toBe(79829000); // đa số 3/4
    expect(preview.needsManualReview).toBe(true);
    expect(preview.reasons.some((r) => r.includes('KHÔNG khớp nhau'))).toBe(true);
    expect(preview.reasons.some((r) => r.includes('79.829.000') && r.includes('79.928.000'))).toBe(true);
  });

  it('dòng "VND 0" (mục Hoàn tiền/Đã hủy) KHÔNG được tính vào đối chiếu chéo — chỉ 1 giá trị khác-0 vẫn quay về check ký tự/cấu trúc cũ đúng như trước', () => {
    // Tái hiện ĐÚNG tình huống thật REAL_BILL_OCR_LINES (case B70 gốc) nhưng viết tay để khẳng định rõ ràng:
    // dù có NHIỀU dòng "VND 0" (4 dòng), chúng KHÔNG được đếm là "đồng thuận" — chỉ 1 dòng khác-0 duy nhất nên
    // vẫn chạy check cấu trúc phân nhóm cũ (bắt được lỗi rớt dấu chấm), KHÔNG bị dòng "VND 0" pha loãng.
    const lines: OcrLine[] = [
      { text: 'VND 52700.000', score: 0.9592 },
      { text: 'VND 0', score: 0.93 },
      { text: 'VND 0', score: 0.92 },
      { text: 'VND 0', score: 0.94 }
    ];
    const preview = buildAmountPreview(lines);
    expect(preview.parsedAmount).toBe(52700000);
    expect(preview.needsManualReview).toBe(true);
    expect(preview.reasons.some((r) => r.includes('phân nhóm'))).toBe(true);
  });
});

// ── extractBillFields/buildBillPreview (1/8) — 6 trường mở rộng: TID/tên HKD/ngày giờ/số lô/số hóa đơn/tên
// ngân hàng, đọc trên ĐÚNG fixture bill thật REAL_BILL_COMMA_BUG_OCR_LINES (KHÔNG bịa fixture mới). CHỈ 1 mẫu
// bill thật (máy PAX/MB Bank) — test này xác nhận layout ĐÓ đọc đúng, KHÔNG chứng minh phủ mọi layout POS
// khác (xem comment giới hạn ở đầu khối extractBillFields trong ocr-bridge.ts).
describe('extractBillFields', () => {
  it('bill thật 1/8 (PAX/MB Bank): đọc đúng CẢ 6 trường, không field nào uncertain (mọi dòng fixture score=0.9/0.95/0.99 ≥ ngưỡng 0.9)', () => {
    const fields = extractBillFields(REAL_BILL_COMMA_BUG_OCR_LINES);
    expect(fields.tid).toEqual({ value: '50550759', uncertain: false });
    expect(fields.hkdName).toEqual({ value: 'HKD DEMOMAY 1', uncertain: false });
    expect(fields.dateTime).toEqual({ value: '21/11/2025 10:39:56', uncertain: false });
    expect(fields.batchNumber).toEqual({ value: '000189', uncertain: false });
    expect(fields.invoiceNumber).toEqual({ value: '001283', uncertain: false });
    expect(fields.bankName).toEqual({ value: 'MB', uncertain: false });
  });

  it('bill KHÔNG có field nào khớp (chỉ 1 dòng linh tinh) → CẢ 6 field null, KHÔNG throw', () => {
    const fields = extractBillFields([{ text: 'HKD DEMO 53', score: 0.98 }]);
    expect(fields).toEqual({
      tid: null,
      hkdName: null,
      dateTime: null,
      batchNumber: null,
      invoiceNumber: null,
      bankName: null
    });
  });

  it('mảng dòng OCR rỗng → CẢ 6 field null, KHÔNG throw (phòng thủ OCR service trả lines:[])', () => {
    const fields = extractBillFields([]);
    expect(fields).toEqual({
      tid: null,
      hkdName: null,
      dateTime: null,
      batchNumber: null,
      invoiceNumber: null,
      bankName: null
    });
  });

  it('nhãn khớp nhưng dòng NGAY SAU rỗng sau trim → field đó null (KHÔNG trả giá trị rỗng gây hiểu nhầm)', () => {
    const fields = extractBillFields([
      { text: 'TÊN DAI LÝ:', score: 0.9 },
      { text: '   ', score: 0.9 }
    ]);
    expect(fields.hkdName).toBeNull();
  });

  it('confidence dòng giá trị THẤP hơn ngưỡng → field vẫn đọc được nhưng uncertain=true (gợi ý, chưa chắc chắn)', () => {
    const fields = extractBillFields([
      { text: 'BATCH No/SÖ LÔ', score: 0.9 },
      { text: '000189', score: 0.5 } // < TENTATIVE_MIN_CHAR_CONFIDENCE (0.9)
    ]);
    expect(fields.batchNumber).toEqual({ value: '000189', uncertain: true });
  });

  it('bankName CHỈ nhận mã KHỚP allowlist ngân hàng — chuỗi ngắn ngẫu nhiên KHÔNG khớp → null (không suy đoán liều)', () => {
    const fields = extractBillFields([{ text: 'XX', score: 0.9 }]);
    expect(fields.bankName).toBeNull();
  });
});

describe('buildBillPreview', () => {
  it('gộp ĐÚNG cả số tiền (buildAmountPreview KHÔNG đổi) LẪN 6 trường mới trong 1 lần gọi trên CÙNG mảng lines', () => {
    const preview = buildBillPreview(REAL_BILL_COMMA_BUG_OCR_LINES);
    // Số tiền — PHẢI khớp NGUYÊN VĂN kết quả buildAmountPreview() độc lập (không đổi hành vi số tiền).
    expect(preview.found).toBe(true);
    expect(preview.parsedAmount).toBe(140000000);
    // 6 trường mới.
    expect(preview.tid).toEqual({ value: '50550759', uncertain: false });
    expect(preview.hkdName).toEqual({ value: 'HKD DEMOMAY 1', uncertain: false });
    expect(preview.dateTime).toEqual({ value: '21/11/2025 10:39:56', uncertain: false });
    expect(preview.batchNumber).toEqual({ value: '000189', uncertain: false });
    expect(preview.invoiceNumber).toEqual({ value: '001283', uncertain: false });
    expect(preview.bankName).toEqual({ value: 'MB', uncertain: false });
    // Fixture này KHÔNG có dòng "ĐÓNG(...)" nào → không phát hiện rủi ro (khác REAL_BILL_V_TO_U_BUG_OCR_LINES
    // bên dưới, bill có mã 95 thật).
    expect(preview.settlementRisk).toBeNull();
  });
});

describe('checkSettlementRisk', () => {
  it('bill thật "HKD THANH TOÁN 2" — OCR đọc "DÓNG(95)" (mất dấu Đ) → cảnh báo đúng mã 95, message tiếng Việt', () => {
    const warning = checkSettlementRisk(REAL_BILL_V_TO_U_BUG_OCR_LINES);
    expect(warning).toEqual({
      code: '95',
      message: 'Bill có mã đóng lô ĐÓNG(95) — CẢNH BÁO rủi ro hoàn tiền/hủy giao dịch sau khi đã nhận tiền. Kiểm tra kỹ trước khi xác nhận giao dịch với khách.'
    });
  });

  it('bill KHÔNG có dòng "ĐÓNG(...)" nào (fixture bình thường) → null (hợp lệ, không phát hiện rủi ro)', () => {
    expect(checkSettlementRisk(REAL_BILL_COMMA_BUG_OCR_LINES)).toBeNull();
  });

  it('mảng dòng OCR rỗng → null, KHÔNG throw', () => {
    expect(checkSettlementRisk([])).toBeNull();
  });

  it('mã đóng lô KHÁC 95 (chưa có bằng chứng thật là rủi ro) → null, KHÔNG suy rộng sang mã chưa xác nhận', () => {
    expect(checkSettlementRisk([{ text: 'DONG(00)', score: 0.9 }])).toBeNull();
  });

  it('nhận diện KHÔNG phân biệt hoa/thường/dấu và khoảng trắng quanh dấu ngoặc (Đóng(95) / dong ( 95 ))', () => {
    expect(checkSettlementRisk([{ text: 'Đóng(95)', score: 0.9 }])).toEqual({
      code: '95',
      message: expect.stringContaining('ĐÓNG(95)')
    });
    expect(checkSettlementRisk([{ text: 'dong ( 95 )', score: 0.9 }])).toEqual({
      code: '95',
      message: expect.stringContaining('ĐÓNG(95)')
    });
  });
});

describe('buildBillPreview + checkSettlementRisk tích hợp', () => {
  it('bill thật có mã ĐÓNG(95) → buildBillPreview() gộp ĐÚNG cảnh báo vào settlementRisk (không tách rời khỏi 6 field còn lại)', () => {
    const preview = buildBillPreview(REAL_BILL_V_TO_U_BUG_OCR_LINES);
    expect(preview.settlementRisk).toEqual({
      code: '95',
      message: expect.stringContaining('ĐÓNG(95)')
    });
    // Vẫn giữ NGUYÊN hành vi số tiền/6 field cũ (KHÔNG bị rule mới làm lệch) — bill này đã có regression riêng
    // ở buildAmountPreview() phía trên (case "BUG THẬT #2"), ở đây chỉ xác nhận preview gộp không vỡ.
    expect(preview.parsedAmount).toBe(79829000);
    expect(preview.tid).toEqual({ value: '53550015', uncertain: false });
  });
});

describe('callOcrService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('buffer rỗng → EMPTY_FILE, KHÔNG gọi mạng', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await callOcrService(Buffer.alloc(0), 'bill.jpg');
    expect(result).toEqual({ ok: false, reason: 'EMPTY_FILE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetch thành công 200 + shape {ok:true,lines:[...]} → trả ok:true kèm lines đúng nguyên văn', async () => {
    const fakeLines = [{ text: 'VND 52700.000', score: 0.9592 }];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, lines: fakeLines })
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await callOcrService(REAL_PNG_BUFFER, 'bill.png');
    expect(result).toEqual({ ok: true, lines: fakeLines });
    // Đúng URL nội bộ mặc định (OCR_SERVICE_PORT không set trong env test) + method POST.
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8799/ocr', expect.objectContaining({ method: 'POST' }));
  });

  it('fetch throw (service chưa bật/refused) → SERVICE_UNREACHABLE, có console.error (KHÔNG nuốt câm, đúng R198)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    );
    const result = await callOcrService(REAL_PNG_BUFFER, 'bill.png');
    expect(result).toEqual({ ok: false, reason: 'SERVICE_UNREACHABLE' });
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('fetch trả HTTP không 2xx (vd 500 nội bộ OCR service) → SERVICE_ERROR', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'PaddleOCR crashed' })
    );
    const result = await callOcrService(REAL_PNG_BUFFER, 'bill.png');
    expect(result).toEqual({ ok: false, reason: 'SERVICE_ERROR' });
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('fetch 200 nhưng shape JSON thiếu mảng "lines" → SERVICE_ERROR (KHÔNG tin mù shape lạ, đúng feedback_mock_shape_accuracy_assert_values)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
    );
    const result = await callOcrService(REAL_PNG_BUFFER, 'bill.png');
    expect(result).toEqual({ ok: false, reason: 'SERVICE_ERROR' });
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  // AUDIT độc lập (31/7, MEDIUM) — sniff magic-bytes TRƯỚC khi forward sang OCR service Python, chặn buffer
  // rác có thể làm PaddleOCR/OpenCV (native) crash cứng tiến trình dùng chung cho mọi đại lý.
  it('buffer KHÔNG PHẢI ảnh thật (vd .txt đổi tên .jpg) → MIME_NOT_ALLOWED, KHÔNG gọi mạng sang OCR service', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const plainTextAsJpg = Buffer.from('khong phai anh that, chi la .txt doi ten', 'utf8');
    const result = await callOcrService(plainTextAsJpg, 'gia-mao.jpg');
    expect(result).toEqual({ ok: false, reason: 'MIME_NOT_ALLOWED' });
    expect(fetchMock).not.toHaveBeenCalled(); // chặn TRƯỚC khi kịp gọi mạng — đúng mục đích bảo vệ service.
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('ảnh PNG thật hợp lệ → vượt qua sniff mime, tới được fetch() bình thường (không bị chặn nhầm ảnh sạch)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    const result = await callOcrService(REAL_PNG_BUFFER, 'bill.png');
    expect(result).toEqual({ ok: true, lines: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ── GUARD OCR ĐA ĐỘ PHÂN GIẢI (Admin Demo 21/8 "kiểm tra tận gốc") ──────────────────────────────────────────────
// BUG THẬT: bill Oanh MB (uploads/6c1ca261...jpg) — 1 lượt OCR ở 1600px đọc ĐƯỢC tid=53550080 nhưng bankName=null
// (logo "MB" cách điệu chỉ ra chữ ở res THẤP ≤1100). Root cause đã verify bằng OCR THẬT nhiều res: KHÔNG res đơn
// nào đọc được CẢ TID lẫn ngân hàng. FIX = buildBillPreviewMultiScale chạy 2 lượt + GỘP field. Guard này khẳng
// định HÀNH VI GỘP: lượt gốc thiếu bank → PHẢI bù từ lượt thu-nhỏ; tid ưu tiên lượt gốc (KHÔNG bị lượt 2 ghi đè).
// Đây là lớp lỗi R198 "test suite xanh nhưng không kiểm đúng thứ hỏng": trước fix, mọi test callOcrService đơn-lượt
// vẫn xanh mà bill Oanh vẫn mất bank. Guard chạy ĐÚNG đường 2-lượt (mock fetch trả 2 kết quả khác nhau theo lượt).
describe('buildBillPreviewMultiScale — gộp đa độ phân giải (regression bill Oanh MB mất bank)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // GỘP là hàm THUẦN mergeLowresBillFields (tách khỏi buildBillPreviewMultiScale để test không phụ thuộc số lượt
  // OCR — sau khi thêm AUTO-XOAY 25/8, buildBillPreviewMultiScale gọi OCR nhiều lượt hơn, mock theo-lượt cũ vỡ).
  it('lượt gốc có TID nhưng THIẾU bank + lượt thu-nhỏ có bank → GỘP: có CẢ tid LẪN bankName', () => {
    const base = buildBillPreview([
      { text: 'TID: 53550080', score: 0.98 },
      { text: 'HKD DEMO 18', score: 0.98 }
    ]); // lượt gốc: tid + hkd, KHÔNG bank
    const merged = mergeLowresBillFields(base, [
      { text: 'MB', score: 0.99 },
      { text: 'HKD DEMO 18', score: 0.9 }
    ]); // lượt thu-nhỏ: có 'MB'
    expect(merged.tid).toEqual({ value: '53550080', uncertain: false }); // giữ lượt gốc
    expect(merged.bankName).toEqual({ value: 'MB', uncertain: false }); // bù từ lượt 2 (field bill Oanh mất trước fix)
  });

  it('lượt gốc ĐÃ đủ tid+bank → lượt 2 KHÔNG ghi đè field lượt gốc (ưu tiên res cao)', () => {
    const base = buildBillPreview([
      { text: 'TID: 53550080', score: 0.98 },
      { text: 'MB', score: 0.98 }
    ]);
    const merged = mergeLowresBillFields(base, [{ text: 'VPBANK', score: 0.99 }]); // lượt 2 bank KHÁC
    expect(merged.bankName).toEqual({ value: 'MB', uncertain: false }); // KHÔNG bị ghi đè VPBANK
  });

  it('lượt thu-nhỏ KHÔNG có field nào → GIỮ NGUYÊN lượt gốc (bù null an toàn)', () => {
    const base = buildBillPreview([{ text: 'TID: 53550080', score: 0.98 }]);
    const merged = mergeLowresBillFields(base, []); // không có dữ liệu lượt 2
    expect(merged.tid).toEqual({ value: '53550080', uncertain: false });
  });

  it('lượt gốc lỗi (service unreachable) → trả ok:false, KHÔNG chạy lượt 2', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await buildBillPreviewMultiScale(REAL_PNG_BUFFER, 'x.png');
    expect(result).toEqual({ ok: false, reason: 'SERVICE_UNREACHABLE' });
    consoleErrorSpy.mockRestore();
  });
});

// ── ĐA-NGÂN-HÀNG (2/8, B121) — regression THUẬT bằng ẢNH THẬT ────────────────────────────────────────────
// Admin Demo gửi trực tiếp bill máy "MBV" đọc tốt mọi trường nhưng bill NGÂN HÀNG MB THẬT báo "Ngân hàng: Không
// đọc được" → điều tra ra root-cause: `findBankName()` cũ chỉ quét 5 dòng đầu + KHÔNG có "MBV" trong allowlist.
// 6 fixture dưới đây là NGUYÊN VĂN output PaddleOCR thật (KHÔNG bịa) chạy qua 19 ảnh mẫu thật Admin Demo gửi
// (`<REPO>\Desktop\test\`, 2/8) — copy CHÍNH XÁC qua script `scripts-tmp-verify-fields.mjs`
// (đã xóa sau khi dùng xong, KHÔNG commit).

// Tái hiện ĐÚNG bug Admin Demo báo: ảnh gốc là ảnh CHỤP MÀN HÌNH cuộc trò chuyện Zalo (KHÔNG phải ảnh camera trực
// tiếp) — 8 dòng nhiễu đầu (giờ điện thoại/tên app/tab/nút chuyển theme/tên người chat) đẩy dòng logo "MB" ra
// vị trí INDEX 8, VƯỢT giới hạn cũ BANK_NAME_SCAN_LINE_LIMIT=5 → bankName=null (đúng bug thật). Bill: TID
// 53550015, "HKD THANH TOAN 2".
const REAL_BILL_MB_DEEP_NOISE_OCR_LINES: OcrLine[] = [
  { text: '13:49', score: 0.9999889135360718 },
  { text: 'A Zzlo ', score: 0.6731147766113281 },
  { text: '5', score: 0.7490525245666504 },
  { text: 'Trò ch...', score: 0.9946032762527466 },
  { text: 'Sáng', score: 0.9999275207519531 },
  { text: 'Nam', score: 0.9999942779541016 },
  { text: 'Đang', score: 0.8934303522109985 },
  { text: '12:29', score: 0.9999917149543762 },
  { text: 'MB', score: 0.9999935030937195 },
  { text: 'TÉN DAI LY:', score: 0.9398021697998047 },
  { text: 'HKD THANH TOAN 2', score: 0.9983839988708496 },
  { text: 'DIA CHI DAI LY :', score: 0.9587355852127075 },
  { text: 'KHU 12, XA LAM THAO, I', score: 0.9711754322052002 },
  { text: 'NH PHU THO', score: 0.9983770251274109 },
  { text: 'DATETIME/NGAY GIÖ:', score: 0.9436362385749817 },
  { text: '31/07/2026 17:03:50', score: 0.9983639121055603 },
  { text: 'SETTLEMENT - KET TOÁN', score: 0.9599819183349609 },
  { text: 'DÓNG(95)', score: 0.9905078411102295 },
  { text: 'TID:53550015/SEQ:001900 MID:355-C-944162', score: 0.9828329086303711 },
  { text: 'BATCH No/SÖ LO:', score: 0.9585462212562561 },
  { text: '000295', score: 0.9805796146392822 },
  { text: 'TRACE No/SÖ HÓA DON:', score: 0.9669314622879028 },
  { text: '001900', score: 0.9998764991760254 }
];

// Bill MBV thật "THANH TOÁN" (khác hẳn format "TỔNG KẾT" — có TID? KHÔNG, MBV không in trường TID, chỉ có "MÃ
// MÁY"). Đặc biệt: layout 2 CỘT khiến dòng giá trị "Số lô" dính liền nhãn cột bên "SÖ TRACE", và dòng giá trị
// "Ngày" dính liền nhãn "GID:" (giờ) của cột bên — cả 2 đều verify bằng OCR thật, KHÔNG bịa.
const REAL_BILL_MBV_SALE_OCR_LINES: OcrLine[] = [
  { text: 'MBV', score: 0.9999862313270569 },
  { text: 'APP VER: 200825A930MBV REF ID: 20280352', score: 0.9914526343345642 },
  { text: 'TÉN DAI LY:', score: 0.9264337420463562 },
  { text: 'HKD DEMO 54-2', score: 0.9966012239456177 },
  { text: 'D.CHI DAI LY:', score: 0.9850788116455078 },
  { text: 'KHU 1, LAM THAO,', score: 0.961673378944397 },
  { text: 'PHU THO', score: 0.9869546294212341 },
  { text: 'MÃ DAI LÝ', score: 0.9257426857948303 },
  { text: '102800000000071', score: 0.9993747472763062 },
  { text: 'MÃ MÁY', score: 0.9373302459716797 },
  { text: '20280352', score: 0.9999964833259583 },
  { text: 'SÖ THÊ: VISA', score: 0.9093771576881409 },
  { text: '4848-****_****-4748(C)', score: 0.9561905264854431 },
  { text: 'TÊN CHÙ THE:', score: 0.9636461138725281 },
  { text: 'COLLECTOR/MB', score: 0.9999687075614929 },
  { text: 'NGÀY H.HAN', score: 0.9648669958114624 },
  { text: '**/**', score: 0.996198832988739 },
  { text: 'THANH TOAN', score: 0.9645711779594421 },
  { text: 'SÖLO', score: 0.9253423810005188 },
  { text: '000036 SÖ TRACE', score: 0.9877397418022156 },
  { text: '000511', score: 0.9741951823234558 },
  { text: 'NGÀY:', score: 0.9154864549636841 },
  { text: '22/05/2026 GID:', score: 0.9543895125389099 },
  { text: '10:32:47', score: 0.9999768733978271 },
  { text: 'SÖ THAM', score: 0.9858819246292114 },
  { text: '600000000002 MA C.CHI', score: 0.9704974293708801 },
  { text: '316212', score: 0.9999987483024597 },
  { text: 'CHIÊU', score: 0.9324465990066528 },
  { text: 'SÖ TIÉN', score: 0.8196526765823364 },
  { text: 'VND 1.749.000', score: 0.9990716576576233 },
  { text: 'APP NAME:MB PAYWAVE', score: 0.9999588131904602 }
];

// Bill VPBank thật (SALE) — TID CHỮ+SỐ "DEMO-TID-11" (khác 4 format kia chỉ số), nhãn "TID:" đứng RIÊNG 1 dòng
// (giá trị dòng SAU, dính CHUNG dòng với "MID:"), "NGÀY GIỜ:" gộp 1 dòng nhưng giá trị bị OCR làm dính liền mất
// dấu ':' phân cách giờ ("08/01/202616:20.01").
const REAL_BILL_VPBANK_SALE_OCR_LINES: OcrLine[] = [
  { text: 'VPBank', score: 0.9985660910606384 },
  { text: 'APPVER010724P30VPB 1931595', score: 0.8294855952262878 },
  { text: 'TÉN DAI LY', score: 0.893886387348175 },
  { text: 'BICH NGOC BANLE', score: 0.9441044926643372 },
  { text: 'D CHI DAI LY:', score: 0.9050480723381042 },
  { text: '10 14 KHU 2A CAO THANG.', score: 0.91200190782547 },
  { text: 'PHUONG HA LAM, QUANG', score: 0.9280926585197449 },
  { text: 'TID:', score: 0.7604916095733643 },
  { text: 'DEMO-TID-11 M0:019380200947501', score: 0.9646328091621399 },
  { text: 'THE', score: 0.9912252426147461 },
  { text: 'MC', score: 0.9983168840408325 },
  { text: '8020(C)', score: 0.9877785444259644 },
  { text: 'TÉN:', score: 0.6676378846168518 },
  { text: 'VAN THANH/LE', score: 0.9993848204612732 },
  { text: 'NGAY H.HAN', score: 0.9117560386657715 },
  { text: '08/30', score: 0.999987006187439 },
  { text: 'THANH TOÁN', score: 0.9627989530563354 },
  { text: 'SÓ LO:', score: 0.8383798003196716 },
  { text: '000023', score: 0.9999106526374817 },
  { text: 'SÖHDON', score: 0.9395596981048584 },
  { text: '000088', score: 0.9994149804115295 },
  { text: 'NGAY GIÒ:', score: 0.7745841145515442 },
  { text: '08/01/202616:20.01', score: 0.9787157773971558 },
  { text: 'SÖ IC:', score: 0.7632182240486145 },
  { text: '600000000003', score: 0.9999737739562988 },
  { text: 'MÃ C.CHI:', score: 0.9211711883544922 },
  { text: '886095', score: 0.9999116063117981 },
  { text: 'SÖ H.DON NHÃP', score: 0.8813595175743103 },
  { text: 'TÓNG CÔNG', score: 0.8721516132354736 },
  { text: 'VND34,713,000', score: 0.9998422265052795 }
];

// Bill Sacombank thật (ẢNH CHỤP GỘP 4 phiếu — 1 TỔNG KẾT + 3 SALE, xoay đặt cạnh nhau + thước đo — KHÔNG PHẢI
// ảnh 1 bill đơn lẻ, đây là GIỚI HẠN CỦA ẢNH MẪU HIỆN CÓ, xem báo cáo cuối). Nhãn SONG NGỮ "Date/Ngày:"/
// "Batch/Lô:"/"Invoice/Hóa đơn:" dính giá trị NGAY CÙNG DÒNG. Copy NGUYÊN VĂN 166 dòng OCR thật.
const REAL_BILL_SACOMBANK_COMPOSITE_OCR_LINES: OcrLine[] = [
  { text: 'Sacombank', score: 0.9999959468841553 },
  { text: 'GTELPAY-MANH TUAN', score: 0.9967235326766968 },
  { text: 'KHU 3, X. LAM THAO', score: 0.8853499293327332 },
  { text: 'PHU THO, DT: 0900000601', score: 0.9772104024887085 },
  { text: 'NGAY:09/03/2026', score: 0.9978464841842651 },
  { text: 'TID:80606718', score: 0.9747207760810852 },
  { text: 'L6:000007', score: 0.9663023352622986 },
  { text: 'GI0:11:31:17', score: 0.9297320246696472 },
  { text: 'MID: 3893', score: 0.9500138163566589 },
  { text: 'MÁY CHÙ: VND', score: 0.957345724105835 },
  { text: 'TÓNG KET', score: 0.9092743396759033 },
  { text: 'GIAO D|CH', score: 0.9588663578033447 },
  { text: 'SÓLUÇNG', score: 0.678071916103363 },
  { text: 'THANH TOAN', score: 0.9823362231254578 },
  { text: 'SÓ TIEN', score: 0.9834285378456116 },
  { text: 'TÓNG CONG', score: 0.9503330588340759 },
  { text: '3', score: 0.9999969005584717 },
  { text: '19.985.000 VND', score: 0.9989967942237854 },
  { text: '3', score: 0.9999842643737793 },
  { text: '19.985.000 VND', score: 0.9973365068435669 },
  { text: 'LOI THÊ: VISA', score: 0.9346840381622314 },
  { text: 'GIAO DICH', score: 0.9942485094070435 },
  { text: 'SÓLUONG', score: 0.782029926776886 },
  { text: 'SÓ TIEN', score: 0.9822909235954285 },
  { text: 'THANH TOAN', score: 0.990567684173584 },
  { text: '3', score: 0.999982476234436 },
  { text: '19.985.000 VND', score: 0.9997989535331726 },
  { text: 'TÓNG CONG', score: 0.8183428645133972 },
  { text: '3', score: 0.9999892711639404 },
  { text: '19.985.000 VND', score: 0.9986749887466431 },
  { text: 'TÓNG KET THANH CÓNG', score: 0.917911946773529 },
  { text: 'IVN (2.2.119)', score: 0.9811601042747498 },
  { text: '6', score: 0.9999467134475708 },
  { text: '7', score: 0.9995321035385132 },
  { text: '8', score: 0.9995096921920776 },
  { text: '9', score: 0.9997459053993225 },
  { text: '10', score: 0.9999974370002747 },
  { text: '11', score: 0.9993604421615601 },
  { text: '12', score: 0.9999870657920837 },
  { text: '13', score: 0.9999986886978149 },
  { text: '14', score: 0.9999815225601196 },
  { text: '15', score: 0.9999955296516418 },
  { text: '16', score: 0.9999971985816956 },
  { text: '17', score: 0.9999929070472717 },
  { text: '18', score: 0.9999862909317017 },
  { text: '19', score: 0.9999775290489197 },
  { text: '20', score: 0.9999861121177673 },
  { text: '0 cm 1', score: 0.9188717007637024 },
  { text: '2', score: 0.9999942779541016 },
  { text: 'MeOWT', score: 0.8691251873970032 },
  { text: 'BAOKE RU2020', score: 0.9771420955657959 },
  { text: 'Sacomban.', score: 0.9523959755897522 },
  { text: 'Sacombank', score: 0.9999972581863403 },
  { text: 'GTELPAY-MANH TUAN', score: 0.9988459348678589 },
  { text: 'Sacombank', score: 0.9999960660934448 },
  { text: 'KHU 3, X.LAM THAO', score: 0.9905964136123657 },
  { text: 'GTELPAY-MANH TUAN', score: 0.9848846197128296 },
  { text: 'PHU THO, DT: 0900000601', score: 0.9852187037467957 },
  { text: 'KHU 3, X.LAM THAO', score: 0.9775065183639526 },
  { text: 'PHU THO, DT: 0900000601', score: 0.981697142124176 },
  { text: 'GTELPAY-MANH TUAN', score: 0.9886326789855957 },
  { text: 'KHU 3, X.LAM THAO', score: 0.9947846531867981 },
  { text: 'Date/Ngày: 09/03/2026 TIme/Gio: 11:19:05', score: 0.9232784509658813 },
  { text: 'MID: 3893', score: 0.9706385135650635 },
  { text: 'PHU THO, DT: 0900000601', score: 0.9938720464706421 },
  { text: 'TID:80606718', score: 0.9923537373542786 },
  { text: 'Date/Ngày: 09/03/2026 Tlme/Gib: 11:18:17', score: 0.9471885561943054 },
  { text: 'MID: 3893', score: 0.9468820095062256 },
  { text: 'Batch/Lô: 000007 Invoice/Hóa don: 000022', score: 0.9544962048530579 },
  { text: 'TID:80506718', score: 0.9648526310920715 },
  { text: 'Batch/L6: 000007 Involce/Hoa don: 000021', score: 0.957075297832489 },
  { text: 'Date/Ngày: 09/03/2026 Time/Glo: 11:16:24', score: 0.952762246131897 },
  { text: 'SALE/THANH TOAN', score: 0.9835782647132874 },
  { text: 'TID:80606718', score: 0.9993463158607483 },
  { text: 'MID:3893', score: 0.9972753524780273 },
  { text: '4786 68** **** 0625 (CHIP)', score: 0.9217881560325623 },
  { text: 'SALE/THANH TOAN', score: 0.9719725251197815 },
  { text: 'Batch/L6: 000007 Involce/Hóa don: 000020', score: 0.9628046154975891 },
  { text: '4162 59** **** 9036 (CHIP)', score: 0.953433632850647 },
  { text: 'DUY VU DUNG/NGUYEN', score: 0.9997077584266663 },
  { text: '7BB463CD43BC66EB', score: 0.9956628084182739 },
  { text: 'KHACH HANG 28', score: 0.9994639754295349 },
  { text: 'SALE/THANH TOAN', score: 0.9889512658119202 },
  { text: 'TC:', score: 0.9997709393501282 },
  { text: 'A0000000031010', score: 0.9981902837753296 },
  { text: 'VPB PAYWAVE', score: 0.9843584299087524 },
  { text: '896D9B28E2DA1496', score: 0.9786698818206787 },
  { text: '4786 68******0625 (CHIP)', score: 0.9659214615821838 },
  { text: 'AID:', score: 0.9996516108512878 },
  { text: 'TSI: 6800', score: 0.9675893783569336 },
  { text: 'TC:', score: 0.9998024106025696 },
  { text: 'A0000000031010', score: 0.9973055124282837 },
  { text: 'Appl Label:', score: 0.9789043068885803 },
  { text: '**.10*', score: 0.7736847400665283 },
  { text: 'AID:', score: 0.9996252059936523 },
  { text: 'HDB VISA CARD', score: 0.9977849721908569 },
  { text: 'VISA', score: 0.9997969269752502 },
  { text: 'TSI: 6800', score: 0.9605387449264526 },
  { text: 'DUY VU DUNG/NGUYEN', score: 0.997752845287323 },
  { text: 'TVR:8000008000', score: 0.9989694952964783 }
];

// Bill ABBANK thật — nhãn TIẾNG ANH HOÀN TOÀN. Ảnh mẫu duy nhất hiện có là ẢNH CHỤP GỘP 2 phiếu XOAY NGANG
// chồng nhau (KHÔNG phải 1 bill đơn lẻ) — PaddleOCR đọc đúng thứ tự bị XÁO TRỘN (nhãn và giá trị không còn nằm
// cạnh nhau) — đây là GIỚI HẠN CỦA ẢNH MẪU, xem báo cáo cuối. Test bên dưới CHỈ khẳng định phần ĐÁNG TIN CẬY
// (bankName — quét toàn dòng, không phụ thuộc thứ tự).
const REAL_BILL_ABBANK_COMPOSITE_OCR_LINES: OcrLine[] = [
  { text: 'CARDHOLDER SIGNATURE', score: 0.9996837377548218 },
  { text: 'TC : 6B6D9B0B117F4FF7', score: 0.9648928046226501 },
  { text: 'AID: A000000031010', score: 0.9101686477661133 },
  { text: 'APP: VISA CARD', score: 0.9959297180175781 },
  { text: 'TOTAL:', score: 0.9998261332511902 },
  { text: 'REF No:', score: 0.978969156742096 },
  { text: 'DATE:', score: 0.9999122619628906 },
  { text: 'BATCH:', score: 0.9973258376121521 },
  { text: 'EXPIRY DATE:', score: 0.9998213648796082 },
  { text: 'NAME: KHACH HANG 14', score: 0.9979202151298523 },
  { text: 'CARD: VISA', score: 0.953133225440979 },
  { text: '11', score: 0.6969184875488281 },
  { text: 'MERCHANT ADDRESS:', score: 0.9998467564582825 },
  { text: 'MERCHANT NAME:', score: 0.9997391104698181 },
  { text: 'NGÂN HANG AN BINH', score: 0.9087123870849609 },
  { text: 'ABBANK', score: 0.9372901916503906 },
  { text: 'I ACKNOWLEDGE SATISFACTORY RECEIPT OF', score: 0.985706627368927 },
  { text: '600000000004', score: 0.9999673366546631 },
  { text: 'APR 22, 2026', score: 0.9946115612983704 },
  { text: 'RELATIVE GOODS/SERVICES', score: 0.99425208568573 },
  { text: '69101305', score: 0.9999876022338867 },
  { text: 'MERCHANT COPY', score: 0.9976624250411987 },
  { text: '000015', score: 0.9960004687309265 },
  { text: 'SALE', score: 0.9999662637710571 },
  { text: 'VND 19,996,000', score: 0.9875601530075073 },
  { text: 'APPROVE CODE: 660028', score: 0.990444540977478 },
  { text: '30T', score: 0.3962489068508148 },
  { text: 'INVOICE:', score: 0.9824154376983643 },
  { text: '4032-80**-****-1890(C)', score: 0.9664561748504639 },
  { text: 'MID: 691-S-972000013', score: 0.9556767344474792 },
  { text: 'HKD DEMO 12', score: 0.9915611147880554 },
  { text: 'KHU 10 LAM THAO', score: 0.9988022446632385 },
  { text: '17:10:33', score: 0.9999029636383057 },
  { text: 'PHU THO', score: 0.999845564365387 },
  { text: '000049', score: 0.9998684525489807 }
];

describe('extractBillFields — ĐA-NGÂN-HÀNG (2/8, B121, verify OCR thật)', () => {
  it('BUG GỐC Admin Demo báo — bill MB thật qua ảnh chụp màn hình Zalo (logo "MB" ở dòng index 8, vượt giới hạn CŨ 5 dòng) → bankName="MB" (TRƯỚC ĐÂY null, đúng bug thật)', () => {
    const fields = extractBillFields(REAL_BILL_MB_DEEP_NOISE_OCR_LINES);
    expect(fields.bankName).toEqual({ value: 'MB', uncertain: false });
    expect(fields.tid).toEqual({ value: '53550015', uncertain: false });
    expect(fields.hkdName).toEqual({ value: 'HKD THANH TOAN 2', uncertain: false });
    expect(fields.dateTime).toEqual({ value: '31/07/2026 17:03:50', uncertain: false });
    expect(fields.batchNumber).toEqual({ value: '000295', uncertain: false });
    expect(fields.invoiceNumber).toEqual({ value: '001900', uncertain: false });
  });

  it('MBV thật — bankName="MBV" (TRƯỚC ĐÂY không có trong allowlist → null), dateTime ghép đúng dù giá trị Ngày/Số lô bị OCR dính nhãn cột bên', () => {
    const fields = extractBillFields(REAL_BILL_MBV_SALE_OCR_LINES);
    expect(fields.bankName).toEqual({ value: 'MBV', uncertain: false });
    expect(fields.hkdName).toEqual({ value: 'HKD DEMO 54-2', uncertain: false });
    // Số lô: dòng giá trị gốc "000036 SÖ TRACE" (dính nhãn cột "Số Trace" bên cạnh) — cắt lấy chuỗi số đầu.
    expect(fields.batchNumber).toEqual({ value: '000036', uncertain: false });
    // Ngày: dòng giá trị gốc "22/05/2026 GID:" (dính nhãn "Giờ" cột bên) + giờ thật nằm dòng NGAY SAU đó.
    expect(fields.dateTime).toEqual({ value: '22/05/2026 10:32:47', uncertain: false });
    // Admin Demo CHỐT: TID trên bill MBV = "REF ID" (dòng "APP VER: ...MBV REF ID: 20280352") = "MÃ MÁY"
    // (dòng "MÃ MÁY" + "20280352") — CÙNG 1 giá trị, ưu tiên "MÃ MÁY". => tid = 20280352 (KHÔNG null).
    expect(fields.tid).toEqual({ value: '20280352', uncertain: false });
  });

  it('VPBank thật — TID CHỮ+SỐ "DEMO-TID-11" (nhãn đứng riêng dòng, giá trị dòng sau), dateTime tự tách đúng dù OCR làm dính liền mất dấu \':\' phân cách giờ', () => {
    const fields = extractBillFields(REAL_BILL_VPBANK_SALE_OCR_LINES);
    expect(fields.bankName).toEqual({ value: 'VPBank', uncertain: false });
    expect(fields.tid).toEqual({ value: 'DEMO-TID-11', uncertain: false });
    expect(fields.hkdName).toEqual({ value: 'BICH NGOC BANLE', uncertain: false });
    expect(fields.batchNumber).toEqual({ value: '000023', uncertain: false });
    expect(fields.invoiceNumber).toEqual({ value: '000088', uncertain: false });
    // Giá trị OCR gốc "08/01/202616:20.01" (mất dấu ':' phân cách giờ/phút/giây) → chuẩn hoá đúng "16:20:01".
    expect(fields.dateTime).toEqual({ value: '08/01/2026 16:20:01', uncertain: false });
    const amount = buildAmountPreview(REAL_BILL_VPBANK_SALE_OCR_LINES);
    expect(amount.parsedAmount).toBe(34713000);
  });

  it('Sacombank thật — nhãn song ngữ "Date/Ngày:"/"Batch/Lô:" dính giá trị CÙNG dòng vẫn tách đúng; số tiền in "<số> VND" (VND SAU số, ngược 4 format kia) vẫn đọc đúng', () => {
    const fields = extractBillFields(REAL_BILL_SACOMBANK_COMPOSITE_OCR_LINES);
    expect(fields.bankName).toEqual({ value: 'Sacombank', uncertain: false });
    expect(fields.tid).toEqual({ value: '80606718', uncertain: false });
    expect(fields.dateTime).toEqual({ value: '09/03/2026 11:19:05', uncertain: false });
    expect(fields.batchNumber).toEqual({ value: '000007', uncertain: false });
    // Ảnh mẫu là ẢNH GỘP nhiều phiếu SALE cùng TID/Batch — invoiceNumber lấy dòng khớp ĐẦU TIÊN theo thứ tự
    // OCR đọc được (000022), KHÔNG NHẤT THIẾT là phiếu Admin Demo dùng đối chiếu (000020) — giới hạn CỦA ẢNH MẪU
    // GỘP nhiều phiếu, KHÔNG phải bug logic (1 bill SALE đơn lẻ thật sẽ chỉ có ĐÚNG 1 dòng khớp).
    expect(fields.invoiceNumber).toEqual({ value: '000022', uncertain: false });
    // "19.985.000 VND" — mẫu SUFFIX mới (số ĐỨNG TRƯỚC "VND"), khớp qua AMOUNT_LINE_SUFFIX_PATTERN.
    const amount = buildAmountPreview(REAL_BILL_SACOMBANK_COMPOSITE_OCR_LINES);
    expect(amount.found).toBe(true);
    expect(amount.parsedAmount).toBe(19985000);
  });

  it('ABBANK thật — bankName="ABBANK" đọc đúng dù ảnh mẫu là ảnh GỘP 2 phiếu XOAY NGANG (thứ tự dòng OCR bị xáo trộn, quét bankName không phụ thuộc thứ tự nên vẫn đúng)', () => {
    const fields = extractBillFields(REAL_BILL_ABBANK_COMPOSITE_OCR_LINES);
    expect(fields.bankName).toEqual({ value: 'ABBANK', uncertain: false });
    // Số tiền đọc đúng "VND 19,996,000" (mẫu PREFIX cũ, không đổi hành vi).
    const amount = buildAmountPreview(REAL_BILL_ABBANK_COMPOSITE_OCR_LINES);
    expect(amount.found).toBe(true);
    expect(amount.parsedAmount).toBe(19996000);
    // CHƯA verify được TID/tên đại lý/số lô/số hóa đơn CHÍNH XÁC cho ABBANK-EN vì ảnh mẫu duy nhất hiện có bị
    // xoay/ghép nhiều phiếu — GHI NHẬN GIỚI HẠN, không giả vờ đã đúng. Nhãn "TID:" không xuất hiện tách biệt
    // trong OCR ảnh này nên tid=null (không bịa số ngẫu nhiên đứng gần đó).
    expect(fields.tid).toBeNull();
  });

  it('Ngân hàng CHƯA có ảnh mẫu thật (VCB/TCB/ACB/BIDV/Eximbank...) — alias mã CHUẨN đã sẵn sàng, khớp ĐÚNG dòng logo dạng text thuần', () => {
    expect(extractBillFields([{ text: 'EXIMBANK', score: 0.99 }]).bankName).toEqual({ value: 'EIB', uncertain: false });
    expect(extractBillFields([{ text: 'VIETCOMBANK', score: 0.99 }]).bankName).toEqual({ value: 'VCB', uncertain: false });
  });
});
