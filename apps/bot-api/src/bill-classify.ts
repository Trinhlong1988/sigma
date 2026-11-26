// SIGMA — LỚP AN TOÀN TIỀN cho tính năng "tự lấy bill từ Zalo".
//
// Mục đích: phân loại 3 loại ảnh bill mà OCR (PaddleOCR PP-OCRv6, xem ocr-bridge.ts / B121) đọc ra,
// để KHÔNG bao giờ tính nhầm 1 bill chuyển-khoản-hoàn-tiền hay bill kết-toán thành doanh số hoàn thành.
//
// Ràng buộc thiết kế:
//   - Hàm THUẦN: không DB, không mạng, input = mảng dòng OCR đã có sẵn.
//   - KHÔNG import ngược ocr-bridge.ts (tránh vòng phụ thuộc) → copy type OcrLine nhỏ tại đây.
//   - OCR tiếng Việt hay MẤT DẤU + lẫn ký tự ("KÊT TOÁN"→"KET TOAN", "Chuyn tin"→"CHUYN TIN"),
//     nên chuẩn hoá = bỏ dấu (NFD) + xử đ/Đ→d + uppercase, rồi so khớp CHỨA (includes) linh hoạt,
//     KHÔNG so khớp chính xác cả dòng.
//   - REFUND kiểm TRƯỚC TIÊN: an toàn tiền — thà nhận nhầm 1 bill quẹt thẻ thành hoàn tiền (không ghi
//     doanh số) còn hơn để 1 bill hoàn tiền lọt thành doanh số.

/** Copy tối thiểu của OcrLine (KHÔNG import ocr-bridge để tránh vòng). */
export interface OcrLine {
  text: string;
  score: number;
}

export type BillType = 'BILL_LE' | 'SETTLEMENT' | 'REFUND_TRANSFER' | 'UNKNOWN';

/**
 * Chuẩn hoá 1 đoạn text OCR để so khớp không dấu:
 *   - tách dấu tổ hợp (NFD) rồi bỏ các dấu thanh/mũ (U+0300..U+036F)
 *   - đ/Đ → D (không nằm trong dải kết hợp NFD nên xử riêng)
 *   - uppercase + gộp mọi khoảng trắng liên tiếp thành 1 space
 */
export function normalizeOcrText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // bỏ dấu thanh + dấu mũ tiếng Việt (combining marks)
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Gộp toàn bộ dòng OCR thành 1 chuỗi đã chuẩn hoá (ngăn cách bằng khoảng trắng). */
function joinNormalized(lines: OcrLine[]): string {
  return normalizeOcrText(lines.map((l) => l?.text ?? '').join(' '));
}

// --- Tín hiệu OCR THẬT (đã chạy PaddleOCR trên ảnh mẫu — KHÔNG suy đoán) ---

// (1) REFUND_TRANSFER: ảnh app ngân hàng chuyển tiền của Ke Toan Demo (tiền ĐÃ HOÀN, không có TID/SALE).
const REFUND_PAYER = 'KHACH HANG 01';
// OCR mất dấu: "Chuyển tiền" → có khi ra "CHUYEN TIEN", "CHUYEN TIN", hoặc "CHUYN TIN" (rơi nguyên âm).
const REFUND_TRANSFER_HINTS = ['CHUYEN TIEN THANH CONG', 'CHUYEN TIEN', 'CHUYEN TIN', 'CHUYN TIN'] as const;

// (2) SETTLEMENT: bill kết toán tổng, KHÔNG ghi doanh số riêng cho từng giao dịch.
const SETTLEMENT_HINTS = ['SETTLEMENT', 'KET TOAN', 'TONG KET', 'LO DA KET TOAN'] as const;

// (3) BILL_LE: bill POS quẹt thẻ 1 giao dịch = doanh số. OCR hay dính "SALE-THANH TOAN".
//     Bắt cả biến thể mất dấu / dính ký tự bằng cách chuẩn hoá rồi includes.

/**
 * Phân loại loại bill từ các dòng OCR. Ưu tiên từ trên xuống, REFUND kiểm TRƯỚC (an toàn tiền).
 */
export function classifyBillType(lines: OcrLine[]): BillType {
  if (!Array.isArray(lines) || lines.length === 0) return 'UNKNOWN';
  const text = joinNormalized(lines);

  // 1) REFUND_TRANSFER — kiểm TRƯỚC để tuyệt đối không lọt thành doanh số.
  if (text.includes(REFUND_PAYER) && REFUND_TRANSFER_HINTS.some((h) => text.includes(h))) {
    return 'REFUND_TRANSFER';
  }

  // 2) SETTLEMENT — bill kết toán, không ghi doanh số riêng.
  if (SETTLEMENT_HINTS.some((h) => text.includes(h))) {
    return 'SETTLEMENT';
  }

  // 3) BILL_LE — bill quẹt thẻ 1 giao dịch (mặc định cho POS SALE-THANH TOAN).
  if (text.includes('SALE') && text.includes('THANH TOAN')) {
    return 'BILL_LE';
  }

  // 4) Không khớp gì.
  return 'UNKNOWN';
}
