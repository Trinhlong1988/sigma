// SIGMA (2026-07-31) — Rule chống tin nhầm OCR đọc số tiền trên bill nhiệt (thermal receipt). Phát sinh
// từ case thật Admin Demo test 31/7: bill MBV "Thanh toán VND 52.700.000" in nhiệt mòn đầu in đúng vị trí số "7"
// → chỉ còn 1 nét chéo, PaddleOCR (hay BẤT KỲ OCR nào) đọc thành "52/00.000" — đây là GIỚI HẠN VẬT LÝ của ảnh
// gốc (glyph mất nét thật), KHÔNG phải lỗi model OCR, nên không thể "tăng độ chính xác" để tự sửa đúng. Rule
// này KHÔNG cố đoán lại số đúng — chỉ phát hiện tín hiệu đáng ngờ để đẩy sang xác nhận thủ công (đúng khuôn
// sigma-fraud-rules.ts: trả {violated/needsManualReview, message}, KHÔNG throw cho luồng bình thường).
//
// Pure logic — KHÔNG DB, KHÔNG Electron, KHÔNG gọi engine OCR (caller/script Python truyền kết quả OCR đã
// chạy xong vào đây).

export interface OcrCharConfidence {
  char: string;
  /** 0..1. PaddleOCR mặc định trả confidence THEO TỪ/DÒNG chứ không theo từng ký tự đơn lẻ — nếu caller rải
   * đều confidence của cả từ cho từng ký tự (xấp xỉ, không phải đo trực tiếp từng glyph), PHẢI nói rõ ở nơi
   * gọi (xem scripts/ocr-bill-reader.py), không âm thầm coi là đo chính xác per-char. */
  confidence: number;
}

export interface OcrAmountFieldResult {
  /** Text OCR trả về NGUYÊN VĂN cho vùng số tiền, TRƯỚC khi cố parse thành number — giữ nguyên ký tự lạ
   * (vd "/") để rule bên dưới bắt được, KHÔNG được lọc/sửa trước khi truyền vào đây. */
  rawText: string;
  chars: OcrCharConfidence[];
}

export interface OcrConfidenceCheckResult {
  needsManualReview: boolean;
  /** Có thể nhiều lý do cùng lúc (vd vừa ký tự lạ vừa confidence thấp chỗ khác). */
  reasons: string[];
}

// Số tiền hợp lệ gồm chữ số + dấu phân cách nghìn (chấm HOẶC phẩy) + khoảng trắng OCR đôi khi chèn thêm quanh
// dấu.
//
// CẬP NHẬT (1/8, Admin Demo chỉ đạo tường minh sau case bill MB Bank/PAX thật — xem B93 BUGS_FIXED.md) — TRƯỚC
// ĐÂY chỉ nhận dấu chấm, coi dấu phẩy là "ký tự lạ" luôn ép cảnh báo đỏ dù giá trị tính ra đã đúng. Admin Demo
// xác nhận: đây là NHIỄU NHẬN DIỆN OCR giữa dấu chấm/phẩy trên bill in nhiệt nhỏ (cùng 1 bill, PaddleOCR đọc
// ra CẢ 4 kiểu ".", ",", lẫn lộn "," rồi "." trong 4 lần xuất hiện số tiền giống hệt nhau) — KHÔNG phải dấu
// hiệu đọc SAI giá trị (khác hẳn case gốc "52.700.000"→"52700.000" RỚT hẳn 1 dấu chấm, đổi sai giá trị thật).
// "Chỉ cảnh báo khi mờ không đọc được" — dấu phẩy giờ là ký tự HỢP LỆ, KHÔNG tự động kích hoạt cảnh báo (1)
// nữa; check (3) confidence-theo-ký-tự vẫn là tuyến phòng thủ chính cho glyph mờ/mất nét thật.
const AMOUNT_ALLOWED_CHAR = /[\d.,\s]/;

/**
 * Kiểm 1 vùng số tiền OCR — TENTATIVE ngưỡng `minCharConfidence`: chưa có số LEAD chốt, hàm KHÔNG tự đặt
 * default để tránh áp ngưỡng chưa duyệt lên luồng thật; caller BẮT BUỘC truyền tường minh. Gợi ý khởi điểm để
 * LEAD cân nhắc: 0.90 (PaddleOCR thường trả >0.95 cho chữ số in rõ; case bill mờ 31/7 thực tế PaddleOCR trả
 * confidence THẤP RÕ RỆT cho từ chứa ký tự lạ — xem kết quả verify script) — CẦN Admin Demo xác nhận trước khi
 * áp cứng vào pipeline production.
 */
export function checkOcrAmountConfidence(field: OcrAmountFieldResult, minCharConfidence: number): OcrConfidenceCheckResult {
  const reasons: string[] = [];

  // 1) Ký tự lạ xen giữa vùng số tiền — dấu hiệu MẠNH NHẤT (không phụ thuộc confidence model có tự tin hay
  //    không — model có thể tự tin ĐỌC SAI, như "/" trông rất rõ nét trên ảnh dù giá trị THẬT là "7" mờ).
  const strayChars = [...new Set([...field.rawText].filter((c) => !AMOUNT_ALLOWED_CHAR.test(c)))];
  if (strayChars.length > 0) {
    reasons.push(
      `Ký tự lạ ${strayChars.map((c) => `"${c}"`).join(', ')} xuất hiện trong vùng số tiền OCR ("${field.rawText}") — không phải chữ số/dấu phân cách nghìn hợp lệ, nghi ngờ đọc nhầm ký tự bị mờ/mất nét trên bill in nhiệt.`
    );
  }

  // 2) Định dạng phân nhóm nghìn SAI cấu trúc dù MỌI ký tự đều hợp lệ riêng lẻ — bắt được nhờ chạy PaddleOCR
  //    THẬT (PP-OCRv6, model tiếng Anh mặc định, chưa tinh chỉnh cho mẫu bill này) trên đúng bill 31/7:
  //    "VND 52.700.000" bị OCR đọc ra "52700.000" — RỚT đúng 1 dấu chấm đầu, không hề sinh ký tự lạ nào nên
  //    check (1) ở trên KHÔNG bắt được. Số tiền hợp lệ PHẢI là 1-3 chữ số đầu, sau đó CHỈ các nhóm ĐÚNG 3 chữ
  //    số ngăn bởi dấu phân cách — sai cấu trúc này đổi hẳn GIÁ TRỊ (mất/thừa 1 bậc nhóm nghìn), nguy hiểm hơn
  //    ký tự lạ vì dễ bị parse ẩu mà không ai để ý.
  //
  //    CHUẨN HOÁ (1/8) — dấu chấm/phẩy coi NHƯ NHAU (cả 2 chỉ là dấu phân cách nghìn, PaddleOCR lẫn lộn giữa 2
  //    ký tự này trên bill nhiệt nhỏ, xem AMOUNT_ALLOWED_CHAR ở trên) TRƯỚC khi kiểm cấu trúc nhóm 3 số — "140,
  //    000.000" chuẩn hoá thành "140.000.000", ĐÚNG cấu trúc → KHÔNG cảnh báo (khác hẳn case rớt dấu chấm thật
  //    sự làm sai SỐ LƯỢNG nhóm, vẫn bị bắt sau chuẩn hoá vì "52700.000" chuẩn hoá không đổi gì, vẫn sai cấu
  //    trúc). Compact giữ NGUYÊN VĂN CÓ dấu phẩy trong message hiển thị (không sửa `field.rawText` gốc).
  const compact = field.rawText.replace(/\s/g, '');
  const normalizedForGroupCheck = compact.replace(/,/g, '.');
  const groupedNumberPattern = /^\d{1,3}(\.\d{3})*$/;
  if (
    compact.length > 0 &&
    /^[\d.,]+$/.test(compact) &&
    normalizedForGroupCheck.includes('.') &&
    !groupedNumberPattern.test(normalizedForGroupCheck)
  ) {
    reasons.push(
      `Định dạng phân nhóm nghìn không đúng chuẩn (mỗi nhóm sau dấu phân cách phải đúng 3 chữ số): "${field.rawText}" — nghi ngờ OCR làm rớt/thêm dấu phân cách, đổi sai giá trị số tiền.`
    );
  }

  // 3) Bất kỳ ký tự nào (kể cả chữ số trông "sạch") có confidence dưới ngưỡng → không tin tuyệt đối.
  const lowConfChars = field.chars.filter((c) => c.confidence < minCharConfidence);
  if (lowConfChars.length > 0) {
    const list = lowConfChars.map((c) => `"${c.char}" (${(c.confidence * 100).toFixed(1)}%)`).join(', ');
    reasons.push(`${lowConfChars.length} ký tự có độ tin cậy OCR dưới ngưỡng ${(minCharConfidence * 100).toFixed(0)}%: ${list}.`);
  }

  return { needsManualReview: reasons.length > 0, reasons };
}
