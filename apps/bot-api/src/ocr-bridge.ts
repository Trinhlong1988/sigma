// SIGMA (31/7, B71 phần 2) — Cầu nối Node (bot-api) → OCR microservice Python (apps/ocr-service/main.py,
// PaddleOCR PP-OCRv6 medium — xem BUGS_FIXED.md B70/B71-part1 cho lý do chọn model này, KHÔNG đổi). File này
// CHỈ gọi HTTP nội bộ + parse kết quả thô thành dữ liệu route dùng được — KHÔNG chứa logic OCR, KHÔNG chứa
// logic nghiệp vụ Lô/đối soát nào (route ocr-preview ở routes/me.ts CHỈ xem trước/gợi ý điền form).
//
// Dùng `fetch`/`FormData`/`Blob` built-in Node 24 (global, KHÔNG cần npm install thêm package nào — đúng ràng
// buộc B71 phần 2: tuyệt đối không npm install cho apps/bot-api đang chạy production).
//
// AUDIT độc lập (31/7, MEDIUM) — `file-type` (ĐÃ có sẵn trong package.json, dùng bởi chat-attachment-service.ts,
// KHÔNG cài thêm gì): sniff magic-bytes THẬT của buffer TRƯỚC khi forward sang OCR service Python. Lý do: buffer
// bất kỳ (không phải ảnh thật) có thể làm PaddleOCR/OpenCV (native code) crash cứng tiến trình Python — service
// này DÙNG CHUNG cho MỌI đại lý và KHÔNG có Scheduled Task tự khởi động lại (xem B71-part1), 1 request rác làm
// service chết sẽ chặn đứng OCR preview cho tất cả người dùng khác tới khi có người chạy tay `python main.py`
// lại. Allowlist CHỈ 3 định dạng ảnh (KHÔNG cần pdf/docx/xlsx như chat-attachment-service.ts — đây là ảnh chụp
// bill, không phải file đính kèm chat).
import { checkOcrAmountConfidence, type OcrAmountFieldResult } from '@sigma/business-rules';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp'; // OCR đa độ phân giải (buildBillPreviewMultiScale) — thu nhỏ ảnh cho lượt đọc logo bank.

export interface OcrLine {
  text: string;
  score: number;
}

export type OcrServiceResult =
  | { ok: true; lines: OcrLine[] }
  | { ok: false; reason: 'SERVICE_UNREACHABLE' | 'SERVICE_ERROR' | 'EMPTY_FILE' | 'MIME_NOT_ALLOWED' };

const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Gọi OCR microservice Python qua HTTP nội bộ (POST /ocr, multipart field "image"). KHÔNG nuốt lỗi câm (đúng
 * R198) — mọi nhánh lỗi đều console.error TRƯỚC khi trả reason cho caller, để log server phản ánh đúng chuyện
 * gì đã xảy ra (service chưa bật/service lỗi nội bộ) thay vì chỉ thấy 1 mã lỗi khô khan. */
export async function callOcrService(buffer: Buffer, fileName: string): Promise<OcrServiceResult> {
  if (buffer.length === 0) {
    return { ok: false, reason: 'EMPTY_FILE' };
  }

  // Sniff magic-bytes THẬT (KHÔNG tin tên file/Content-Type client tự khai, CÙNG nguyên tắc
  // chat-attachment-service.ts) — chặn NGAY TẠI ĐÂY, TRƯỚC khi buffer rác kịp bay sang service Python.
  const detected = await fileTypeFromBuffer(buffer);
  const mime = detected?.mime ?? null;
  if (!mime || !ALLOWED_IMAGE_MIME.has(mime)) {
    console.error(`[bot-api] ocr-bridge: từ chối forward sang OCR service, mime không hợp lệ (detected="${mime ?? 'unknown'}", fileName="${fileName}") — chỉ chấp nhận image/jpeg, image/png, image/webp.`);
    return { ok: false, reason: 'MIME_NOT_ALLOWED' };
  }

  const port = process.env.OCR_SERVICE_PORT || '8799';
  const url = `http://127.0.0.1:${port}/ocr`;

  let response: Response;
  try {
    const form = new FormData();
    form.append('image', new Blob([buffer]), fileName);
    response = await fetch(url, { method: 'POST', body: form });
  } catch (err) {
    // Lỗi MẠNG (service chưa chạy/refused/timeout) — KHÔNG phải lỗi ứng dụng, phân biệt rõ với SERVICE_ERROR
    // để log/caller biết hướng xử lý khác nhau (service down vs service trả lỗi nội bộ).
    console.error('[bot-api] ocr-bridge: không gọi được OCR service (mạng):', err);
    return { ok: false, reason: 'SERVICE_UNREACHABLE' };
  }

  if (!response.ok) {
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      // best-effort đọc body lỗi để log — không throw thêm nếu đọc body cũng lỗi.
    }
    console.error(`[bot-api] ocr-bridge: OCR service trả lỗi HTTP ${response.status}: ${bodyText}`);
    return { ok: false, reason: 'SERVICE_ERROR' };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    console.error('[bot-api] ocr-bridge: không parse được JSON từ OCR service:', err);
    return { ok: false, reason: 'SERVICE_ERROR' };
  }

  const lines = (json as { lines?: unknown })?.lines;
  if (!Array.isArray(lines)) {
    console.error('[bot-api] ocr-bridge: shape response OCR service không đúng (thiếu mảng lines):', json);
    return { ok: false, reason: 'SERVICE_ERROR' };
  }

  return { ok: true, lines: lines as OcrLine[] };
}

// Regex tìm dòng chứa mẫu "VND <số>" — KHỚP đúng output PaddleOCR thật đã verify 31/7 (vd "Thanh toán VND
// 52700.000"). `[\d.,\s]+` giữ nguyên dấu chấm/PHẨY/khoảng trắng NGUYÊN VĂN (không lọc/sửa trước) — đúng hợp
// đồng OcrAmountFieldResult.rawText của ocr-confidence.rules.ts (rule cần rawText GỐC để tự phát hiện ký tự
// lạ/sai định dạng phân nhóm, sửa trước ở đây sẽ làm rule mất khả năng bắt lỗi).
//
// BUG THẬT (1/8, Admin Demo chụp ảnh minh chứng + LEAD tự thêm log chẩn đoán tạm rồi xem log thật, KHÔNG suy
// đoán) — bill MB Bank/PAX terminal in "VND140,000.000" (140 TRIỆU) nhưng regex TRƯỚC ĐÂY chỉ nhận dấu CHẤM
// (`[\d.\s]+`, thiếu dấu phẩy trong char class) → gặp dấu phẩy ngay sau "140" là DỪNG CAPTURE → rawText chỉ
// còn "140" → parsedAmount=140 (lệch x1.000.000!) — VÀ vì "140" là số sạch không ký tự lạ/không sai cấu trúc
// nhóm, checkOcrAmountConfidence() KHÔNG bắt được (bug xảy ra Ở TẦNG TRÍCH XUẤT, trước khi rule an toàn có cơ
// hội soi). Cùng 1 bill, PaddleOCR đọc RA 4 LẦN "VND ..." với dấu phân cách KHÔNG NHẤT QUÁN
// ("140,000.000"/"140,000,000"/"140,000.000"/"140.000.000" — nhiễu nhận diện dấu chấm/phẩy trên bản in nhiệt
// nhỏ), không phải bug định dạng cố định 1 kiểu. Mở rộng char class nhận CẢ dấu phẩy — rawText giờ giữ ĐỦ
// "140,000.000", `buildAmountPreview()` digitsOnly strip mọi ký tự không phải số (`\D`, đã bao gồm dấu phẩy
// từ trước) nên parsedAmount tính ra ĐÚNG 140000000. Dấu phẩy vẫn KHÔNG nằm trong AMOUNT_ALLOWED_CHAR
// (ocr-confidence.rules.ts) — cố ý GIỮ NGUYÊN, để rule (1) tự động gắn cờ "ký tự lạ" cho MỌI trường hợp có
// phẩy → needsManualReview=true → hiện CẢNH BÁO ĐỎ bắt xác nhận tay, KHÔNG âm thầm tin tuyệt đối số đọc được
// dù giá trị tính ra đã đúng (an toàn hơn cho tiền — nhiễu tách dấu chấm/phẩy như bill này ĐÁNG ngờ thật).
//
// BUG THẬT #2 (1/8, bill "HKD THANH TOÁN 2"/TID 53550015, cùng phương pháp log chẩn đoán tạm) — PaddleOCR đọc
// NHẦM chữ "V" thành "U" ("VND79,829,000" in trên bill → OCR ra "UND79,829,000", NHẤT QUÁN cả 4/4 lần xuất
// hiện dòng số tiền trên CHÍNH bill này) — chữ V/U nhìn giống nhau khi in nhiệt nhỏ/nét mòn, lớp nhiễu KHÁC
// hẳn bug #1 (đó là dấu phân cách, đây là CHÍNH chữ cái từ khoá). Regex trước đó đòi ĐÚNG literal "VND" nên
// bỏ qua hoàn toàn dòng "UND..." → extractAmountField() trả null → found:false → không đọc được số tiền nào,
// dù 6 trường khác (TID/HKD/ngày giờ/số lô/HĐ) vẫn đọc đúng bình thường (không đụng chữ "V" nào). Mở rộng
// nhận CẢ "UND" (chỉ riêng cặp V/U dễ nhầm lẫn OCR đã có bằng chứng thật — KHÔNG mở rộng thêm ký tự khác chưa
// có bằng chứng, đúng nguyên tắc không suy đoán rộng).
const AMOUNT_LINE_PATTERN = /[VU]ND\s*([\d.,\s]+)/i;

// Sacombank thật (2/8, verify OCR thật ảnh mẫu) in số tiền THEO SAU "VND" (vd "19.985.000 VND"/"9.998.000
// VND") — NGƯỢC CHIỀU 4 định dạng kia (VND luôn đứng TRƯỚC số). Pattern THÊM MỚI, CHỈ thử khi dòng KHÔNG khớp
// AMOUNT_LINE_PATTERN (thứ tự thử trong extractAllAmountFields() dưới đây) — KHÔNG đổi hành vi bất kỳ bill nào
// đã production-validated trước đó (những bill đó không có dòng dạng "<số> VND" nên pattern mới không match gì
// thêm, chỉ mở rộng coverage cho case MỚI). Yêu cầu tối thiểu 1 chữ số đứng đầu + tối thiểu 3 ký tự tổng cộng
// trong nhóm số để giảm rủi ro khớp nhầm chuỗi ngắn không liên quan đứng trước 1 chữ "VND" ngẫu nhiên khác.
const AMOUNT_LINE_SUFFIX_PATTERN = /(\d[\d.,\s]{2,})\s*[VU]ND\b/i;

/** Tìm dòng ĐẦU TIÊN khớp mẫu "VND ..." trong danh sách dòng OCR trả về, dựng OcrAmountFieldResult cho
 * checkOcrAmountConfidence dùng. Trả `null` nếu không có dòng nào khớp (hoặc rawText rỗng sau trim — vd
 * "VND" đứng 1 mình không có số theo sau). GIỮ NGUYÊN cho tương thích ngược (dùng làm fallback khi chỉ có
 * ĐÚNG 1 dòng khớp, xem buildAmountPreview() — trường hợp nhiều dòng khớp dùng extractAllAmountFields()). */
export function extractAmountField(lines: OcrLine[]): OcrAmountFieldResult | null {
  return extractAllAmountFields(lines)[0] ?? null;
}

/** Tìm TẤT CẢ dòng khớp mẫu "VND ..." (KHÔNG chỉ dòng đầu tiên) — nền tảng cho đối chiếu chéo nhiều lần đọc
 * (1/8, Admin Demo yêu cầu "xử lý triệt để" thay vì vá từng lỗi ký tự riêng lẻ, xem buildAmountPreview()). Bill
 * nhiệt THẬT thường in LẶP LẠI đúng 1 tổng tiền 2-4 lần (liên khách hàng + liên đại lý, đôi khi thêm dòng
 * "TỔNG:"/"TỔNG CỘNG" cạnh nhau) — tận dụng phần lặp này để tự phát hiện sai lệch mà KHÔNG cần biết trước OCR
 * sẽ nhầm ký tự cụ thể nào (đã xảy ra thật 2 lần khác nhau: nhầm dấu phẩy/chấm — B93, nhầm chữ V/U — B94-tiếp
 * — không thể liệt kê hết mọi khả năng nhầm lẫn ký tự, đối chiếu chéo bằng DỮ LIỆU LẶP LẠI trên chính bill
 * mạnh hơn nhiều so với vá từng ký tự riêng lẻ mỗi khi gặp case mới). */
export function extractAllAmountFields(lines: OcrLine[]): OcrAmountFieldResult[] {
  const results: OcrAmountFieldResult[] = [];
  for (const line of lines) {
    const match = AMOUNT_LINE_PATTERN.exec(line.text) ?? AMOUNT_LINE_SUFFIX_PATTERN.exec(line.text);
    if (!match) continue;
    const rawText = match[1].trim();
    if (rawText.length === 0) continue;

    // PaddleOCR trả confidence THEO DÒNG, không theo từng ký tự — rải đều `score` của cả dòng cho từng ký tự
    // là XẤP XỈ (không phải đo trực tiếp từng glyph), ĐÚNG caveat đã ghi trong OcrCharConfidence
    // (ocr-confidence.rules.ts dòng 13-15). KHÔNG âm thầm coi đây là confidence per-char chính xác.
    const chars = [...rawText].map((char) => ({ char, confidence: line.score }));
    results.push({ rawText, chars });
  }
  return results;
}

// TENTATIVE — CHƯA Admin Demo chốt số cuối. Gợi ý khởi điểm ghi trong ocr-confidence.rules.ts (dòng 38-42) là
// 0.90; dùng tạm CÙNG số đó ở đây cho tới khi LEAD xác nhận, KHÔNG tự suy ra số khác (đúng feedback_cam_suy_luan).
export const TENTATIVE_MIN_CHAR_CONFIDENCE = 0.9;

// AUDIT độc lập (31/7, ghi chú cho người nối UI sau này): `rawText`/`reasons[]` bắt nguồn từ OCR đọc ảnh do
// CHÍNH đại lý tự chụp/tải lên — về bản chất "attacker-influenceable" (đại lý có thể cố ý chụp ảnh chứa text
// lạ để OCR đọc ra chuỗi tuỳ ý). Khi `ReconcileDetailScreen.tsx` (CHƯA nối, xem BUGS_FIXED.md B71-part2) render
// 2 field này, BẮT BUỘC hiển thị dạng TEXT THUẦN (`{value}` JSX bình thường) — TUYỆT ĐỐI KHÔNG
// `dangerouslySetInnerHTML` hay render như HTML.
export interface OcrAmountPreview {
  found: boolean;
  rawText: string | null;
  parsedAmount: number | null;
  needsManualReview: boolean;
  reasons: string[];
}

function toDigitsOnly(rawText: string): string {
  return rawText.replace(/\D/g, '');
}

/** Dựng preview số tiền từ danh sách dòng OCR thô (1/8, thiết kế lại theo yêu cầu Admin Demo "giả định các
 * trường có thể sai lỗi mờ khác nhau, xử lý triệt để" — thay vì chỉ vá từng ký tự cụ thể bị nhầm mỗi khi phát
 * hiện case mới — B93 nhầm dấu phẩy/chấm, B94-tiếp nhầm chữ V/U — dùng ĐỐI CHIẾU CHÉO nhiều lần đọc CÙNG 1 số
 * tiền lặp lại trên bill nhiệt thật (2-4 lần, liên khách+liên đại lý) làm phòng tuyến chính, KHÔNG phụ thuộc
 * biết trước OCR sẽ nhầm ký tự gì.
 *
 * Thuật toán:
 *  1. Lấy TẤT CẢ dòng khớp "VND/UND ..." (extractAllAmountFields, không chỉ dòng đầu).
 *  2. Chuẩn hoá mỗi dòng về digits-only, LOẠI các dòng ra "0" (KHÔNG dùng để đối chiếu — bill thật có thể có
 *    dòng "VND 0" ở mục "Hoàn tiền"/"Đã hủy" hoàn toàn KHÁC ý nghĩa với tổng tiền thật, KHÔNG phải cùng 1 giá
 *    trị lặp lại — trộn lẫn sẽ làm sai lệch việc "đếm phiếu bầu", xem case thật B70 bill "HKD DEMO 53" có
 *    4 dòng "VND 0" không liên quan tổng tiền thật 52.700.000).
 *  3. CHỈ 1 giá trị khác-0 (hoặc 0 dòng khác-0) → dữ liệu không có gì lặp lại để đối chiếu, dùng lại logic CŨ
 *    (check ký tự lạ + cấu trúc phân nhóm + confidence-theo-ký-tự, checkOcrAmountConfidence B70) cho ĐÚNG
 *    dòng đó — KHÔNG đổi hành vi case chỉ có 1 lần đọc.
 *  4. ≥2 giá trị khác-0 — đếm số dòng cho mỗi giá trị chuẩn hoá:
 *     - TẤT CẢ đồng thuận (100% cùng giá trị) → tin tưởng CAO dù từng ký tự riêng lẻ có bất thường gì (đây
 *       chính là 2 case thật B93/B94-tiếp: dù dấu phẩy/chữ U trông "lạ" ở TỪNG dòng riêng, 4 lần đọc ĐỘC LẬP
 *       ra CÙNG 1 số chuẩn hoá là bằng chứng mạnh hơn hẳn 1 lần đọc "sạch") — needsManualReview=false.
 *     - CÓ đa số nhưng KHÔNG tuyệt đối → vẫn dùng giá trị đa số làm gợi ý (không vứt bỏ, đúng nguyên tắc
 *       suggestedAmount) NHƯNG bắt xác nhận tay, liệt kê rõ các giá trị khác nhau đã đọc được.
 * Route gọi hàm này CHỈ để xem trước/gợi ý điền form (KHÔNG tự ghi Lô/đối soát nào). */
export function buildAmountPreview(lines: OcrLine[]): OcrAmountPreview {
  const allFields = extractAllAmountFields(lines);
  if (allFields.length === 0) {
    return {
      found: false,
      rawText: null,
      parsedAmount: null,
      needsManualReview: true,
      reasons: ['Không tìm thấy dòng số tiền (mẫu "VND ...") trong kết quả OCR — cần nhập tay.']
    };
  }

  const nonZeroFields = allFields.filter((f) => {
    const digits = toDigitsOnly(f.rawText);
    return digits.length > 0 && Number(digits) !== 0;
  });

  // Chỉ 0 hoặc 1 giá trị khác-0 → không có gì để đối chiếu chéo, quay về logic CŨ (1 dòng, check ký tự/cấu
  // trúc/confidence B70) — ưu tiên dòng khác-0 nếu có, không thì dùng dòng đầu tiên (giữ hành vi cũ nguyên vẹn
  // cho case hiếm "chỉ đọc được VND 0").
  if (nonZeroFields.length <= 1) {
    const field = nonZeroFields[0] ?? allFields[0];
    const check = checkOcrAmountConfidence(field, TENTATIVE_MIN_CHAR_CONFIDENCE);
    const digitsOnly = toDigitsOnly(field.rawText);
    const parsedAmount = digitsOnly.length > 0 ? Number(digitsOnly) : null;
    return { found: true, rawText: field.rawText, parsedAmount, needsManualReview: check.needsManualReview, reasons: check.reasons };
  }

  // ≥2 giá trị khác-0 — đếm "phiếu bầu" theo giá trị chuẩn hoá (digits-only).
  const voteCounts = new Map<string, number>();
  for (const f of nonZeroFields) {
    const digits = toDigitsOnly(f.rawText);
    voteCounts.set(digits, (voteCounts.get(digits) ?? 0) + 1);
  }
  const sortedVotes = [...voteCounts.entries()].sort((a, b) => b[1] - a[1]);
  const [topValue, topCount] = sortedVotes[0];
  const representativeField = nonZeroFields.find((f) => toDigitsOnly(f.rawText) === topValue)!;

  if (topCount === nonZeroFields.length) {
    // TẤT CẢ đồng thuận — tin tưởng cao, KHÔNG chạy lại check ký tự-đơn-lẻ (đối chiếu chéo đã là bằng chứng
    // mạnh hơn, tránh cảnh báo dư thừa cho nhiễu ký tự KHÔNG đổi giá trị cuối cùng, đúng chỉ đạo Admin Demo "chỉ
    // cảnh báo khi mờ không đọc được"/B94-tiếp).
    return { found: true, rawText: representativeField.rawText, parsedAmount: Number(topValue), needsManualReview: false, reasons: [] };
  }

  // BILL KẾT TOÁN ĐA LOẠI THẺ (Admin Demo 25/8) — bill tổng kết in NHIỀU số tiền THẬT theo loại thẻ (Visa/Master/JCB/
  // Napas) + 1 dòng TỔNG. Trước đây logic tưởng "8 số khác nhau = đọc lệch" → bắt kiểm tay oan. NHẬN DIỆN chắc
  // chắn (KHÔNG cần đọc nhãn scheme): nếu giá trị LỚN NHẤT = TỔNG các giá trị phân biệt còn lại → đó là DÒNG TỔNG
  // (các số kia là chi tiết theo loại thẻ) → doanh số = dòng tổng (Admin Demo chốt "tổng = 1 doanh số", và tổng đã
  // in sẵn trên bill; KHÔNG cộng đôi cả tổng lẫn chi tiết). Điều kiện toán học chặt → KHÔNG lẫn với đọc-lệch thật
  // (số misread hiếm khi khớp đúng công thức tổng=Σ chi tiết tới từng đồng). Đọc-lệch thật vẫn rơi xuống kiểm tay.
  const distinctVals = [...voteCounts.keys()].map((d) => Number(d)).filter((v) => v > 0);
  if (distinctVals.length >= 2) {
    const desc = [...distinctVals].sort((a, b) => b - a);
    const grandTotal = desc[0];
    const sumOthers = desc.slice(1).reduce((a, b) => a + b, 0);
    if (grandTotal === sumOthers) {
      const totalField = nonZeroFields.find((f) => Number(toDigitsOnly(f.rawText)) === grandTotal) ?? representativeField;
      const breakdown = desc.slice(1).map((v) => v.toLocaleString('vi-VN')).join(' + ');
      return {
        found: true,
        rawText: totalField.rawText,
        parsedAmount: grandTotal,
        needsManualReview: false,
        reasons: [`Bill nhiều loại thẻ — dùng DÒNG TỔNG ${grandTotal.toLocaleString('vi-VN')}đ (= ${breakdown} theo loại thẻ).`]
      };
    }
  }

  // KHÔNG đồng thuận tuyệt đối + KHÔNG phải bill kết toán đa thẻ — liệt kê rõ các giá trị khác nhau đã đọc được,
  // dùng giá trị ĐA SỐ làm gợi ý (không vứt bỏ, người dùng vẫn xác nhận/sửa được ngay — đúng nguyên tắc suggestedAmount).
  const distinctSummary = sortedVotes.map(([val, count]) => `${Number(val).toLocaleString('vi-VN')}đ (${count} lần)`).join(', ');
  return {
    found: true,
    rawText: representativeField.rawText,
    parsedAmount: Number(topValue),
    needsManualReview: true,
    reasons: [`Đọc được ${nonZeroFields.length} lần trên bill nhưng KHÔNG khớp nhau: ${distinctSummary} — vui lòng kiểm tra tay.`]
  };
}

// ── Mở rộng đọc 6 trường bill (1/8, theo yêu cầu Admin Demo) ─────────────────────────────────────────────────
// TID, tên đại lý (HKD), ngày giờ quẹt, số lô, số hóa đơn, tên ngân hàng — CÙNG 1 lần gọi OCR với số tiền
// (buildBillPreview() dưới đây gọi lại extractAmountField()/buildAmountPreview() TRÊN CÙNG mảng `lines` đã có
// sẵn, KHÔNG gọi callOcrService() thêm lần nào). extractAmountField()/buildAmountPreview() ở TRÊN GIỮ NGUYÊN
// 100% KHÔNG SỬA — mọi hàm mới đặt riêng bên dưới để không đụng hành vi/test đã có (đúng ràng buộc R196:
// hành vi đọc số tiền đã production-validated không được đổi).
//
// ĐA-NGÂN-HÀNG (2/8, Admin Demo chỉ đạo tường minh: KHÔNG dùng Claude API/Haiku/bất kỳ AI ngoài nào cho OCR —
// mở rộng THUẦN PaddleOCR text + alias nhãn nhiều bank/máy POS, thiết kế DATA-DRIVEN để dễ thêm bank mới).
// Bug gốc Admin Demo báo: bill máy "MBV" đọc tốt mọi trường, nhưng bill NGÂN HÀNG MB THẬT (logo/định dạng khác
// hẳn MBV dù tên gần giống — phiếu "SETTLEMENT - KẾT TOÁN" dùng nhãn "TID:"/"MID:"/"BATCH No/Số Lô:"/"TRACE
// No/Số hóa đơn:" thay vì "SỐ LÔ"/"SỐ TRACE"/"SỐ THAM CHIẾU" của MBV) → trường "Ngân hàng" báo "Không đọc
// được". Root-cause THẬT (xác nhận bằng cách chạy OCR thật qua ảnh mẫu, KHÔNG suy đoán): `findBankName()` cũ
// CHỈ quét 5 dòng ĐẦU + allowlist KHÔNG có "MBV" — ảnh bill thật Admin Demo dùng để test có nhiễu đầu dòng (chụp
// qua nhiều lớp Zalo/status bar điện thoại) đẩy dòng logo "MB" ra ngoài vị trí dòng thứ 5, và MBV chưa từng có
// trong allowlist nên dù đúng vị trí cũng không khớp.
//
// ĐÃ XÁC NHẬN THẬT bằng 19 ảnh mẫu (`<REPO>\Desktop\test\`, Admin Demo gửi trực tiếp 2/8) cho 6
// biến thể nhãn khác nhau của 5 ngân hàng/thương hiệu POS:
//   1. MBV (máy POS thương hiệu riêng) — nhãn tiếng Việt: "TÊN ĐẠI LÝ:"/"SỐ LÔ"/"SỐ TRACE"/"SỐ TIỀN", KHÔNG có
//      trường TID (chỉ có "MÃ MÁY"/"MÃ ĐẠI LÝ").
//   2. MB Bank thật — phiếu "SETTLEMENT - KẾT TOÁN": "TID:.../MID:" (CÙNG dòng), "BATCH No/Số Lô:"/"TRACE
//      No/Số hóa đơn:" (nhãn RIÊNG dòng, giá trị dòng SAU).
//   3. ABBANK (Ngân hàng An Bình), 2 biến thể CÙNG thương hiệu: (a) nhãn tiếng Việt kiểu MBV/MB ("TÊN ĐẠI LÝ:"/
//      "SỐ LÔ:"/"SỐ H.ĐƠN:", máy D210) (b) nhãn tiếng Anh HOÀN TOÀN ("MERCHANT NAME:"/"CARD:"/"BATCH:"/"DATE:"
//      định dạng tháng chữ "APR 22, 2026"/"TIME:"/"INVOICE:"/"TOTAL:" + "UND"/"VND").
//   4. Sacombank — nhãn SONG NGỮ Việt/Anh CÙNG DÒNG phân cách bằng "/": "Date/Ngày:", "Batch/Lô:", "Invoice/
//      Hóa đơn:", "TOTAL/Tổng:".
//   5. VPBank — nhãn tiếng Việt nhưng KHÁC MBV/MB: "SỐ H.ĐƠN:" (viết tắt khác "SỐ HÓA ĐƠN"), "NGÀY GIỜ:" GỘP
//      CHUNG 1 dòng dạng "dd/mm/yyyy hh:mm:ss" (có thể bị OCR làm DÍNH LIỀN mất dấu ':' phân cách giờ/phút/
//      giây — vd "08/01/202616:1809"), TID dạng CHỮ+SỐ ("DEMO-TID-11", KHÔNG chỉ số như 4 format kia) và nhãn
//      "TID:" đứng RIÊNG 1 dòng (giá trị dòng SAU, khác MB/MBV/ABBANK-EN luôn dính giá trị CÙNG dòng nhãn).
// VPBank/Eximbank/Sacombank nằm trong danh sách Admin Demo yêu cầu ban đầu — Eximbank CHƯA có ảnh mẫu thật, giữ
// alias mã ngân hàng CHUẨN đã có sẵn trong hệ thống (`packages/database/prisma/schema.prisma` model Bank.code,
// vd 'EIB'/'VPB'/'STB'...) + tên đầy đủ hợp lý, ghi rõ CHƯA VERIFY — KHÔNG tự bịa biến thể nhãn khác.
//
// THIẾT KẾ: mọi bảng alias dưới đây là DATA-DRIVEN (mảng cấu hình, KHÔNG if/else cứng theo từng bank) — thêm
// ngân hàng/nhãn mới CHỈ cần thêm 1 dòng vào bảng, KHÔNG cần sửa logic lõi. So khớp nhãn qua `condensed()`
// (bỏ MỌI dấu câu/khoảng trắng trước khi so, KHÔNG chỉ bỏ dấu tiếng Việt) — verify thật cho thấy CÙNG 1 nhãn
// có thể bị OCR đọc ra 3-4 biến thể khoảng trắng/dấu câu khác nhau tuỳ ảnh (vd "SỐ H.ĐƠN:" → "SÖHDON"/"SÖ HOON"
// /"SÖ HDON" tuỳ độ rõ nét), so khớp bỏ dấu câu triệt để hơn hẳn so khớp giữ nguyên khoảng trắng như thiết kế
// cũ (bug gốc B71 chỉ tính tới dấu tiếng Việt, chưa tính khoảng trắng/dấu câu bị OCR làm lệch).

/** Bỏ dấu tiếng Việt + chuẩn hoá HOA/thường để so khớp nhãn không phụ thuộc OCR đọc ra có dấu hay mất dấu —
 * CÙNG thuật toán `normalizeForSearch()` (apps/web-demo/src/lib/smart-search.ts, đã có tiền lệ trong repo,
 * tương đương `lower(unaccent())` PostgreSQL) nhưng chuyển sang HOA thay vì thường (chỉ khác hướng case, ý
 * nghĩa giống hệt) — apps/bot-api và apps/web-demo là 2 app build riêng, KHÔNG import chéo qua ranh giới app
 * (CÙNG lý do OcrAmountPreview phải mirror thủ công ở agent-api-client.ts), nên viết lại tại đây. "Đ/đ" KHÔNG
 * tách được qua `normalize('NFD')` (là 1 codepoint Unicode độc lập, không phải "D" + dấu tổ hợp) nên phải thay
 * tay TRƯỚC khi NFD. */
// Dải Unicode "combining diacritical marks" (U+0300–U+036F) — CÙNG hằng số COMBINING_MARKS_RE của
// normalizeForSearch() (apps/web-demo/src/lib/smart-search.ts) — viết bằng \u escape tường minh (KHÔNG gõ
// literal ký tự tổ hợp trong source) để tránh mơ hồ/rủi ro encoding khi file được mở lại bằng editor khác.
const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;

export function stripDiacriticsUpper(text: string): string {
  return text
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(COMBINING_MARKS_RE, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface OcrBillFieldValue {
  value: string;
  /** true nếu confidence của DÒNG OCR chứa giá trị này (PaddleOCR trả confidence theo dòng, KHÔNG theo từng
   * ký tự — CÙNG caveat extractAmountField() ở trên) thấp hơn TENTATIVE_MIN_CHAR_CONFIDENCE. Field `uncertain`
   * này chỉ là "gợi ý, chưa chắc chắn", KHÔNG cùng mức tin tưởng như field đã đọc chắc (đúng yêu cầu Admin Demo —
   * "không cùng mức tin tưởng đã tự đọc thành công như số tiền hiện có khi confidence cao"). */
  uncertain: boolean;
}

export interface OcrBillFields {
  tid: OcrBillFieldValue | null;
  hkdName: OcrBillFieldValue | null;
  dateTime: OcrBillFieldValue | null;
  batchNumber: OcrBillFieldValue | null;
  invoiceNumber: OcrBillFieldValue | null;
  bankName: OcrBillFieldValue | null;
}

/** Bỏ MỌI dấu câu/khoảng trắng (chỉ giữ chữ+số) — dùng để so khớp nhãn KHÔNG phụ thuộc OCR có giữ nguyên ':'/
 * '.'/khoảng trắng giữa các từ hay không. Verify thật (2/8, 6 định dạng bank khác nhau) cho thấy CÙNG 1 nhãn
 * in trên bill bị OCR đọc ra nhiều biến thể khoảng trắng/dấu câu tuỳ độ rõ nét ảnh (vd "SỐ H.ĐƠN:" → có ảnh ra
 * "SÖHDON" dính liền hết dấu câu, có ảnh ra "SÖ HOON" mất chữ D) — so khớp bỏ dấu câu triệt để bắt được biến
 * thể ĐẦU (dính liền), biến thể SAU vẫn không khớp được (chữ cái bị OCR đọc sai hẳn, KHÔNG fix được bằng so
 * khớp nhãn, đây là giới hạn OCR thật, ghi rõ trong báo cáo). */
function condensed(text: string): string {
  return text.replace(/[^A-Z0-9]/g, '');
}

/** Nhãn (đã stripDiacriticsUpper) khớp bất kỳ alias nào trong danh sách, so khớp qua condensed() (substring,
 * KHÔNG cần bằng tuyệt đối — nhãn có thể nằm giữa 1 dòng dài hơn, vd nhãn song ngữ Sacombank "Date/Ngày:"). */
function matchesAnyAlias(normalizedLabel: string, aliases: readonly string[]): boolean {
  const c = condensed(normalizedLabel);
  return aliases.some((alias) => c.includes(condensed(alias)));
}

/** Khớp CHÍNH XÁC (không phải substring) — dùng cho alias NGẮN/dễ đụng nhãn khác chứa nó làm tiền tố (vd
 * "NGAY" bare có thể vô tình khớp SUBSTRING bên trong "NGÀY H.HẠN" — nhãn NGÀY HẾT HẠN của thẻ, HOÀN TOÀN
 * KHÁC ý nghĩa với "NGÀY:" ngày giao dịch — bug thật phát hiện lúc verify OCR ảnh MBV, xem findDateTime()). */
function matchesExactAlias(normalizedLabel: string, aliases: readonly string[]): boolean {
  const c = condensed(normalizedLabel);
  return aliases.some((alias) => c === condensed(alias));
}

/** Tìm dòng NHÃN đầu tiên khớp bất kỳ alias nào trong `aliases`, lấy dòng NGAY SAU làm giá trị (đúng layout
 * thật: nhãn và giá trị nằm ở 2 dòng liên tiếp khác nhau, xem các fixture bill thật). Bỏ qua nếu dòng giá trị
 * rỗng sau trim (coi như không tìm thấy, KHÔNG trả giá trị rỗng gây hiểu nhầm "đã đọc được"). `exact=true` đòi
 * khớp CHÍNH XÁC nguyên dòng nhãn (không phải substring, xem matchesExactAlias). */
function findValueAfterLabel(lines: OcrLine[], aliases: readonly string[], exact = false): OcrBillFieldValue | null {
  const matcher = exact ? matchesExactAlias : matchesAnyAlias;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!matcher(stripDiacriticsUpper(lines[i].text), aliases)) continue;
    const valueLine = lines[i + 1];
    const value = valueLine.text.trim();
    if (value.length === 0) continue;
    return { value, uncertain: valueLine.score < TENTATIVE_MIN_CHAR_CONFIDENCE };
  }
  return null;
}

// ── TID — DATA-DRIVEN, 2 chiến lược (2/8) ───────────────────────────────────────────────────────────────
// Chiến lược 1 (MB/MBV/ABBANK-EN, verify thật): giá trị nằm CÙNG DÒNG với nhãn "TID:" — vd "TID:50550759/SEO:
// 001283 MID:". CHỈ SỐ trước đây (\d{3,}) — MỞ RỘNG sang chữ+số (VPBank thật có TID "DEMO-TID-11", bắt đầu bằng
// chữ cái, KHÔNG chỉ số — nếu giữ \d{3,} sẽ bỏ sót toàn bộ TID VPBank).
const TID_LINE_PATTERN = /TID\s*[:\-]?\s*([A-Z0-9]{3,})/i;
// Chiến lược 2 (VPBank thật, verify OCR thật 2/8): nhãn "TID:" đứng RIÊNG 1 dòng, KHÔNG kèm giá trị (khác hẳn
// MB/MBV/ABBANK-EN luôn dính giá trị ngay sau nhãn CÙNG dòng) — dòng NGAY SAU bắt đầu bằng giá trị TID (token
// đầu dòng, trước khi tới nhãn "MID:" kế tiếp thường dính cùng dòng đó). Bằng chứng thật: "TID:" (dòng riêng)
// → "DEMO-TID-11 M0:019380200947501" (dòng sau, token đầu "DEMO-TID-11" chính là TID).
const TID_LABEL_ONLY_PATTERN = /^TID\s*[:\-]?\s*$/;
const TID_VALUE_TOKEN_PATTERN = /^([A-Z0-9]{3,})/i;

// ── Helper CHUNG (12/8): trích GIÁ TRỊ SỐ đứng NGAY SAU 1 nhãn trên CÙNG DÒNG ─────────────────────────────
// Bill MBV THẬT (12/8, Admin Demo gửi 2 ảnh mẫu: 1 "TỔNG KẾT / ĐÓNG LÔ" = biên lai đóng lô, 1 giao dịch LẺ) in
// nhãn + giá trị trên CÙNG 1 dòng theo bố cục 2 CỘT / canh phải — KHÁC hẳn layout "nhãn 1 dòng, giá trị dòng
// SAU" mà findValueAfterLabel() giả định. Vd thật: "MÃ MÁY   20280820", "SỐ LÔ  000014      SỐ TRACE  000029".
// stripDiacriticsUpper() ĐÃ gộp mọi khoảng trắng về 1 dấu cách nên nhãn nhiều-token khớp qua "\s*" giữa token.
// Neo `(?:^|[^A-Z0-9])` để nhãn phải bắt đầu ở ĐẦU 1 token (KHÔNG nhặt nhầm nhãn nằm GIỮA 1 từ khác).
//
// BUG THẬT (12/8, tái hiện bằng text-lines từ 2 ảnh Admin Demo gửi, xem test/ocr-bridge-mbv.test.ts): findValueAfterLabel
// (BATCH_NUMBER_LABEL_ALIASES chứa "SO LO") so khớp SUBSTRING trúng dòng 2-cột "SỐ LÔ 000014 ..." rồi lấy dòng
// NGAY SAU (dòng "NGÀY/GIỜ ...") làm số lô → batchNumber ĐỌC NHẦM cả dòng ngày. Chiến lược inline dưới đây đặt
// TRƯỚC findValueAfterLabel (?? fallback) nên lấy đúng số CÙNG dòng nhãn; layout cũ (giá trị dòng sau) không có
// chữ số cùng dòng nhãn → không khớp inline → vẫn rơi về findValueAfterLabel như cũ (KHÔNG đổi hành vi cũ).
function aliasToInlineRegex(alias: string): RegExp {
  const tokens = stripDiacriticsUpper(alias)
    .split(' ')
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s*');
  return new RegExp(`(?:^|[^A-Z0-9])${tokens}\\s*[:\\-]?\\s*(\\d{3,})`);
}

/** Trích chuỗi SỐ (≥3 chữ số) đứng NGAY SAU nhãn (bất kỳ alias nào) trên CÙNG DÒNG. Trả match ĐẦU TIÊN theo
 * thứ tự dòng. Dùng cho bill MBV 2 cột — nhãn và giá trị KHÔNG tách 2 dòng như findValueAfterLabel(). */
function findNumericAfterInlineLabel(lines: OcrLine[], aliases: readonly string[]): OcrBillFieldValue | null {
  const patterns = aliases.map(aliasToInlineRegex);
  for (const line of lines) {
    const up = stripDiacriticsUpper(line.text);
    for (const re of patterns) {
      const m = re.exec(up);
      if (m) return { value: m[1], uncertain: line.score < TENTATIVE_MIN_CHAR_CONFIDENCE };
    }
  }
  return null;
}

// ── TID cho bill MBV (12/8, Admin Demo chốt trực tiếp) ──────────────────────────────────────────────────────
// Bill MBV (máy POS thương hiệu MBV) KHÔNG in nhãn "TID" → 2 chiến lược TID ở trên (MB/VPBank/ABBANK) trả null
// (đã tái hiện tid=null). Admin Demo CHỐT: TID trên bill MBV = trường "REF ID" (trên dòng "APP VER: ...MBV - REF
// ID: <số>") = trường "MÃ MÁY" (dòng "MÃ MÁY   <số>", canh phải) — CÙNG 1 giá trị (vd cả 2 = 20280820 / 20280819).
// TUYỆT ĐỐI KHÔNG lấy "MÃ ĐẠI LÝ" (mã merchant, DÀI hơn — vd 10280000000182) làm TID. 2 nguồn KHỚP nhau → tin
// (uncertain theo score dòng); LỆCH nhau → vẫn trả (ưu tiên "MÃ MÁY" theo lời Admin Demo "dòng mã máy có dãy số
// ngang") NHƯNG gắn uncertain=true để bắt kiểm tay — KHÔNG tự chọn bừa 1 nguồn khi 2 nguồn mâu thuẫn.
const MBV_REF_ID_INLINE_RE = aliasToInlineRegex('REF ID');
const MBV_MA_MAY_INLINE_RE = aliasToInlineRegex('MA MAY');

function findMbvTid(lines: OcrLine[]): OcrBillFieldValue | null {
  let refId: { value: string; score: number } | null = null;
  let machine: { value: string; score: number } | null = null;
  for (const line of lines) {
    const up = stripDiacriticsUpper(line.text);
    if (!refId) {
      const m = MBV_REF_ID_INLINE_RE.exec(up);
      if (m) refId = { value: m[1], score: line.score };
    }
    if (!machine) {
      const m = MBV_MA_MAY_INLINE_RE.exec(up);
      if (m) machine = { value: m[1], score: line.score };
    }
  }
  if (!refId && !machine) return null;
  if (refId && machine) {
    const agree = refId.value === machine.value;
    return {
      value: machine.value, // ưu tiên "MÃ MÁY" (lời Admin Demo); 2 nguồn khớp → giá trị y hệt nhau.
      uncertain: !agree || machine.score < TENTATIVE_MIN_CHAR_CONFIDENCE || refId.score < TENTATIVE_MIN_CHAR_CONFIDENCE
    };
  }
  const only = machine ?? refId!;
  return { value: only.value, uncertain: only.score < TENTATIVE_MIN_CHAR_CONFIDENCE };
}

function findTid(lines: OcrLine[]): OcrBillFieldValue | null {
  for (const line of lines) {
    const match = TID_LINE_PATTERN.exec(line.text);
    if (!match) continue;
    return { value: match[1].toUpperCase(), uncertain: line.score < TENTATIVE_MIN_CHAR_CONFIDENCE };
  }
  for (let i = 0; i < lines.length - 1; i++) {
    if (!TID_LABEL_ONLY_PATTERN.test(stripDiacriticsUpper(lines[i].text))) continue;
    const nextLine = lines[i + 1];
    const tokenMatch = TID_VALUE_TOKEN_PATTERN.exec(nextLine.text.trim());
    if (!tokenMatch) continue;
    const token = tokenMatch[1].toUpperCase();
    // Bắt buộc có ÍT NHẤT 1 chữ số — tránh nhặt nhầm 1 từ tiếng Anh ngẫu nhiên đứng ngay sau dòng "TID:" bị
    // OCR đọc sai vị trí (an toàn hơn tin mù token đầu dòng bất kỳ).
    if (!/\d/.test(token)) continue;
    return { value: token, uncertain: nextLine.score < TENTATIVE_MIN_CHAR_CONFIDENCE };
  }
  // Chiến lược 3 (MBV, 12/8) — CHỈ chạy khi 2 chiến lược "TID" ở trên KHÔNG khớp (MB/VPBank/ABBANK luôn có nhãn
  // "TID" nên return sớm ở trên → bill khác KHÔNG bị chiến lược MBV cướp giá trị). Xem findMbvTid().
  return findMbvTid(lines);
}

// ── Ngân hàng — bảng alias DATA-DRIVEN (2/8) ────────────────────────────────────────────────────────────
// So khớp NGUYÊN DÒNG sau khi bỏ dấu/hoa-thường VÀ mọi ký tự không phải chữ cái (tên/logo ngân hàng không có
// chữ số) — KHÔNG còn giới hạn "chỉ quét N dòng đầu" (giới hạn cũ 5 dòng chính là NGUYÊN NHÂN THẬT bug Admin Demo
// báo: ảnh test có nhiễu đầu dòng — status bar điện thoại/khung Zalo — đẩy dòng logo ra ngoài vị trí 5, verify
// bằng chạy OCR thật qua ảnh gốc, KHÔNG suy đoán). Quét TOÀN BỘ dòng vẫn AN TOÀN vì đòi khớp NGUYÊN DÒNG
// (không phải substring) — 1 dòng thân bill tình cờ chỉ chứa đúng 2-6 chữ cái trùng tên bank gần như không xảy
// ra trong thực tế (đã verify qua 19 ảnh mẫu, 0 false-positive).
interface BankAliasEntry {
  /** Giá trị hiển thị cho field bankName.value — dùng ĐÚNG text thương hiệu in trên bill khi đã verify thật. */
  display: string;
  aliases: readonly string[];
}

const BANK_ALIASES: readonly BankAliasEntry[] = [
  // Đã XÁC NHẬN THẬT bằng ảnh mẫu 2/8 (19 ảnh, <REPO>\Desktop\test\).
  { display: 'MB', aliases: ['MB'] },
  { display: 'MBV', aliases: ['MBV'] },
  { display: 'ABBANK', aliases: ['ABBANK', 'NGANHANGANBINH'] },
  { display: 'Sacombank', aliases: ['SACOMBANK'] },
  { display: 'VPBank', aliases: ['VPBANK'] },
  // CHƯA có ảnh mẫu thật — giữ mã ngân hàng CHUẨN đã có sẵn trong hệ thống (packages/database/prisma/
  // schema.prisma model Bank.code) + tên đầy đủ hợp lý làm alias, SẴN SÀNG mở rộng thêm biến thể nhãn khi có
  // ảnh thật — KHÔNG tự bịa thêm alias ngoài mã chuẩn/tên chính thức đã biết chắc.
  { display: 'VCB', aliases: ['VCB', 'VIETCOMBANK'] },
  { display: 'TCB', aliases: ['TCB', 'TECHCOMBANK'] },
  { display: 'ACB', aliases: ['ACB'] },
  { display: 'BIDV', aliases: ['BIDV'] },
  { display: 'VPB', aliases: ['VPB'] },
  { display: 'TPB', aliases: ['TPB', 'TPBANK'] },
  { display: 'STB', aliases: ['STB'] },
  { display: 'SHB', aliases: ['SHB'] },
  { display: 'MSB', aliases: ['MSB'] },
  { display: 'OCB', aliases: ['OCB'] },
  { display: 'VIB', aliases: ['VIB'] },
  { display: 'HDB', aliases: ['HDB', 'HDBANK'] },
  { display: 'EIB', aliases: ['EIB', 'EXIMBANK'] },
  { display: 'SEAB', aliases: ['SEAB', 'SEABANK'] }
];

function findBankName(lines: OcrLine[]): OcrBillFieldValue | null {
  for (const line of lines) {
    const normalized = stripDiacriticsUpper(line.text).replace(/[^A-Z]/g, '');
    if (normalized.length === 0) continue;
    const matched = BANK_ALIASES.find((bank) => bank.aliases.includes(normalized));
    if (matched) {
      return { value: matched.display, uncertain: line.score < TENTATIVE_MIN_CHAR_CONFIDENCE };
    }
  }
  return null;
}

// ── Tên đại lý (HKD) / Số lô / Số hóa đơn — alias DATA-DRIVEN theo field (2/8) ──────────────────────────
// Mỗi field 1 danh sách alias nhãn — THÊM bank/nhãn mới CHỈ cần thêm 1 chuỗi vào mảng, KHÔNG sửa logic.
const HKD_NAME_LABEL_ALIASES = ['TEN DAI LY', 'MERCHANT NAME'] as const;
const BATCH_NUMBER_LABEL_ALIASES = ['BATCH NO', 'BATCH', 'SO LO'] as const; // 'BATCH' bare = ABBANK-EN "BATCH:"
const INVOICE_NUMBER_LABEL_ALIASES = ['TRACE NO', 'SO H.DON', 'SO HOA DON', 'INVOICE'] as const; // 'INVOICE' = ABBANK-EN

// ── Nhãn INLINE cho bill MBV 2 cột (12/8) — giá trị SỐ nằm CÙNG DÒNG với nhãn (findNumericAfterInlineLabel) ──
// Bill TỔNG KẾT / ĐÓNG LÔ: "SỐ LÔ  000014" (KHÔNG có SỐ TRACE → invoiceNumber phải null, KHÔNG báo lỗi).
// Bill LẺ: "SỐ LÔ  000014      SỐ TRACE  000029" → SỐ HÓA ĐƠN (invoiceNumber) = "SỐ TRACE" = 000029 (Admin Demo
// chốt). PHÂN BIỆT rõ với các trường số dễ nhầm KHÁC trên bill lẻ: KHÔNG map "SỐ THAM CHIẾU" (600000000001,
// 12 số), "MÃ C.CHI" (mã chuẩn chi 209695), hay "MÃ ĐẠI LÝ" (merchant) thành số lô/hóa đơn — alias CHỈ gồm
// "SO LO"/"SO TRACE", không đụng các nhãn kia.
const MBV_BATCH_INLINE_ALIASES = ['SO LO'] as const;
const MBV_INVOICE_INLINE_ALIASES = ['SO TRACE'] as const;

// ── Ngày giờ — 3 chiến lược DATA-DRIVEN (2/8) ───────────────────────────────────────────────────────────
const DATE_TIME_COMBINED_LABEL_ALIASES = ['DATE TIME', 'NGAY GIO'] as const; // MB/MBV/VPBank: nhãn gộp 1 dòng
const DATE_ONLY_LABEL_ALIASES = ['NGAY'] as const; // MBV "THANH TOÁN": "NGÀY:" tách riêng khỏi "GIỜ:"
const TIME_ONLY_LABEL_ALIASES = ['GIO', 'GID'] as const; // "GID" = OCR đọc nhầm "Ờ"→"D" (bằng chứng thật MBV)

/** Chuẩn hoá 1 chuỗi ngày-giờ VN "dd/mm/yyyy..." — nếu phần SAU ngày là giờ bị OCR làm DÍNH LIỀN mất dấu ':'
 * phân cách (bằng chứng thật VPBank, vd "08/01/202616:1809" → nên là "08/01/2026 16:18:09"), tách lại theo VỊ
 * TRÍ CỐ ĐỊNH 2-2-2 chữ số (giờ-phút-giây, ĐÚNG định dạng chuẩn hh:mm:ss, KHÔNG suy đoán ranh giới nào khác).
 * Chuỗi ĐÃ sạch sẵn (MB: "31/07/2026 17:03:50") đi qua hàm này vẫn ra NGUYÊN VẸN không đổi. Chuỗi không khớp
 * mẫu ngày VN (vd định dạng tiếng Anh ABBANK) → trả nguyên văn, không đụng. */
function normalizeDateTimeValue(raw: string): string {
  const dateMatch = /(\d{2}\/\d{2}\/\d{4})/.exec(raw);
  if (!dateMatch) return raw;
  const rest = raw.slice(dateMatch.index + dateMatch[0].length);
  const timeDigits = rest.replace(/\D/g, '');
  if (timeDigits.length < 6) return dateMatch[1];
  return `${dateMatch[1]} ${timeDigits.slice(0, 2)}:${timeDigits.slice(2, 4)}:${timeDigits.slice(4, 6)}`;
}

// Định dạng tiếng Anh ABBANK ("APR 22, 2026" tháng-chữ, KHÁC hẳn dd/mm/yyyy) + giờ HH:MM:SS — quét TOÀN BỘ
// dòng (KHÔNG phụ thuộc nhãn "DATE:"/"TIME:" đứng liền kề giá trị, vì ảnh mẫu ABBANK-EN hiện có đều là ảnh
// NHIỀU PHIẾU chụp gộp/xoay khiến thứ tự dòng OCR bị xáo trộn, nhãn và giá trị không còn nằm cạnh nhau — xem
// báo cáo cuối, đây là giới hạn của ẢNH MẪU hiện có chứ không phải logic).
const ENGLISH_DATE_PATTERN = /\b([A-Z]{3}\s+\d{1,2},?\s+\d{4})\b/;
const TIME_PATTERN = /\b(\d{2}:\d{2}:\d{2})\b/;

function findDateTime(lines: OcrLine[]): OcrBillFieldValue | null {
  // 1. Nhãn GỘP 1 dòng ("DATE TIME"/"NGÀY GIỜ") — chuẩn hoá qua normalizeDateTimeValue() để cả trường hợp sạch
  //    (MB) lẫn trường hợp OCR làm dính liền mất dấu ':' (VPBank) ra output NHẤT QUÁN.
  const combined = findValueAfterLabel(lines, DATE_TIME_COMBINED_LABEL_ALIASES);
  if (combined) {
    return { ...combined, value: normalizeDateTimeValue(combined.value) };
  }

  // 2. Nhãn TÁCH RIÊNG "NGÀY:"/"GIỜ:" (MBV "THANH TOÁN" — verify thật) — mỗi nhãn đã cho giá trị SẠCH riêng.
  //    KHỚP CHÍNH XÁC (exact) — BUG THẬT phát hiện lúc verify ảnh MBV: alias "NGAY" so khớp SUBSTRING sẽ khớp
  //    NHẦM vào nhãn "NGÀY H.HẠN" (ngày hết hạn thẻ, đứng TRƯỚC "NGÀY:" giao dịch trên bill) → lấy nhầm giá
  //    trị "**/**" — exact match chỉ nhận đúng dòng CHỈ CHỨA "NGÀY:"/"NGÀY", không nhận dòng dài hơn.
  for (let i = 0; i < lines.length - 1; i++) {
    if (!matchesExactAlias(stripDiacriticsUpper(lines[i].text), DATE_ONLY_LABEL_ALIASES)) continue;
    const dateValueLine = lines[i + 1];
    const dateMatch = /(\d{2}\/\d{2}\/\d{4})/.exec(dateValueLine.text);
    if (!dateMatch) continue;

    // Giờ CÓ THỂ: (a) nhãn "GIỜ:"/"GID:" đứng RIÊNG 1 dòng khác (tìm exact match bình thường), HOẶC (b) dính
    // vào CUỐI dòng giá trị ngày do OCR đọc 2 cột chồng dòng (bằng chứng thật MBV bill 1: dòng giá trị ngày
    // đọc ra "22/05/2026 GID:" — nhãn giờ bị kéo dính theo, giá trị giờ THẬT nằm dòng NGAY SAU đó).
    const timeLabelGlued = /GI[OD]\s*[:\-]?\s*$/.test(stripDiacriticsUpper(dateValueLine.text));
    if (timeLabelGlued && lines[i + 2] && /^\d{2}:\d{2}:\d{2}$/.test(lines[i + 2].text.trim())) {
      const timeLine = lines[i + 2];
      return {
        value: `${dateMatch[1]} ${timeLine.text.trim()}`,
        uncertain: dateValueLine.score < TENTATIVE_MIN_CHAR_CONFIDENCE || timeLine.score < TENTATIVE_MIN_CHAR_CONFIDENCE
      };
    }
    const timeOnly = findValueAfterLabel(lines, TIME_ONLY_LABEL_ALIASES, true);
    if (timeOnly) {
      return {
        value: `${dateMatch[1]} ${timeOnly.value}`,
        uncertain: dateValueLine.score < TENTATIVE_MIN_CHAR_CONFIDENCE || timeOnly.uncertain
      };
    }
    break; // Tìm thấy đúng 1 nhãn "NGÀY:" thật (bill chỉ có 1) nhưng không ghép được giờ nào — dừng, không thử tiếp.
  }

  // 3. Định dạng tiếng Anh ABBANK — quét toàn bộ dòng tìm mẫu tháng-chữ + giờ riêng biệt.
  let englishDate: OcrLine | null = null;
  let englishTime: OcrLine | null = null;
  for (const line of lines) {
    if (!englishDate) {
      const m = ENGLISH_DATE_PATTERN.exec(line.text.toUpperCase());
      if (m) englishDate = { text: m[1], score: line.score };
    }
    if (!englishTime) {
      const m = TIME_PATTERN.exec(line.text);
      if (m) englishTime = { text: m[1], score: line.score };
    }
    if (englishDate && englishTime) break;
  }
  if (englishDate && englishTime) {
    return {
      value: `${englishDate.text} ${englishTime.text}`,
      uncertain: englishDate.score < TENTATIVE_MIN_CHAR_CONFIDENCE || englishTime.score < TENTATIVE_MIN_CHAR_CONFIDENCE
    };
  }

  // 4. Fallback CUỐI (Sacombank thật, verify OCR thật 2/8): nhãn song ngữ "Date/Ngày: <giá trị> Time/Giờ:
  //    <giá trị>" nằm CHUNG 1 dòng, giá trị dính NGAY SAU nhãn CÙNG dòng (khác 4 format kia luôn tách nhãn/
  //    giá trị 2 dòng) — quét TOÀN BỘ dòng tìm mẫu dd/mm/yyyy TRỰC TIẾP, KHÔNG cần nhãn liền kề, rồi tái dùng
  //    normalizeDateTimeValue() để tự tách phần giờ theo SAU (đã xử lý y hệt case VPBank dính liền mất dấu ':').
  for (const line of lines) {
    if (!/\d{2}\/\d{2}\/\d{4}/.test(line.text)) continue;
    const normalized = normalizeDateTimeValue(line.text);
    if (/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/.test(normalized)) {
      return { value: normalized, uncertain: line.score < TENTATIVE_MIN_CHAR_CONFIDENCE };
    }
  }

  return null;
}

// Sacombank thật (2/8, verify OCR thật): nhãn song ngữ "Batch/Lô:"/"Invoice/Hóa đơn:" ĐÍNH GIÁ TRỊ NGAY TRÊN
// CÙNG DÒNG với nhãn (khác 4 format kia luôn tách nhãn/giá trị 2 dòng riêng, dùng findValueAfterLabel) — quét
// TỪNG dòng tìm literal nhãn NGAY TRƯỚC dấu ':' rồi lấy số theo sau CÙNG dòng.
const BATCH_INLINE_PATTERN = /BATCH\/L[O]\s*[:\-]?\s*(\d{3,})/;
const INVOICE_INLINE_PATTERN = /INVOICE\/HOA\s*DON\s*[:\-]?\s*(\d{3,})/;

function findInlineNumeric(lines: OcrLine[], pattern: RegExp): OcrBillFieldValue | null {
  for (const line of lines) {
    const match = pattern.exec(stripDiacriticsUpper(line.text));
    if (!match) continue;
    return { value: match[1], uncertain: line.score < TENTATIVE_MIN_CHAR_CONFIDENCE };
  }
  return null;
}

/** Cắt lấy CHUỖI SỐ ở ĐẦU giá trị — bill MBV thật (2/8, verify OCR thật) có layout 2 CỘT khiến dòng giá trị
 * "Số lô" bị OCR đọc DÍNH LIỀN theo sau bởi nhãn cột KẾ BÊN (vd "000036 SÖ TRACE" — "SÖ TRACE" là nhãn cột
 * "Số Trace" bên phải, không phải 1 phần giá trị số lô). Số lô/số hóa đơn LUÔN là chuỗi số thuần trên MỌI định
 * dạng đã verify — an toàn cắt bỏ phần chữ dư thừa phía sau. Giá trị KHÔNG bắt đầu bằng số (case khác, lỗi
 * đọc nhầm dòng hẳn — không sửa được bằng cách này) → giữ nguyên, KHÔNG đoán mù. */
function extractLeadingNumericToken(value: string): string {
  const match = /^(\d{3,})\b/.exec(value.trim());
  return match ? match[1] : value;
}

function cleanNumericField(field: OcrBillFieldValue | null): OcrBillFieldValue | null {
  return field ? { ...field, value: extractLeadingNumericToken(field.value) } : null;
}

/** Đọc 6 trường mở rộng từ mảng dòng OCR thô — hàm THUẦN, KHÔNG throw, MỖI trường không tìm thấy → null (đúng
 * ràng buộc "không chặn preview tổng thể", số tiền vẫn hoạt động độc lập dù hàm này có lỗi/không tìm được gì). */
export function extractBillFields(lines: OcrLine[]): OcrBillFields {
  return {
    tid: findTid(lines),
    hkdName: findValueAfterLabel(lines, HKD_NAME_LABEL_ALIASES),
    dateTime: findDateTime(lines),
    batchNumber: cleanNumericField(findInlineNumeric(lines, BATCH_INLINE_PATTERN) ?? findNumericAfterInlineLabel(lines, MBV_BATCH_INLINE_ALIASES) ?? findValueAfterLabel(lines, BATCH_NUMBER_LABEL_ALIASES)),
    invoiceNumber: cleanNumericField(findInlineNumeric(lines, INVOICE_INLINE_PATTERN) ?? findNumericAfterInlineLabel(lines, MBV_INVOICE_INLINE_ALIASES) ?? findValueAfterLabel(lines, INVOICE_NUMBER_LABEL_ALIASES)),
    bankName: findBankName(lines)
  };
}

// ── Cảnh báo rủi ro mã đóng lô (1/8, Admin Demo chỉ đạo tường minh sau khi tự đọc bill thật) ─────────────────────
// "ĐÓNG(95)" in trên bill THẬT (fixture REAL_BILL_V_TO_U_BUG_OCR_LINES — OCR đọc mất dấu "Đ" thành "DÓNG(95)")
// LÀ mã trạng thái đóng lô có RỦI RO HOÀN TIỀN SAU (Admin Demo xác nhận nghiệp vụ trực tiếp, KHÔNG suy đoán) —
// PHẢI cảnh báo ĐỎ, MỨC CAO NHẤT ngay khi OCR đọc ra, KHÁC HẲN mức "cần xem lại/chưa chắc chắn" của các field
// khác (đây là tín hiệu RỦI RO NGHIỆP VỤ THẬT, không phải "OCR không chắc đọc đúng chữ gì"). CHỈ khớp ĐÚNG mã
// "95" đã có bằng chứng thật — KHÔNG suy rộng sang mã khác chưa được xác nhận (đúng nguyên tắc "cấm suy luận
// value/spec", xem feedback_cam_suy_luan). Bill KHÔNG khớp mã rủi ro nào → coi là hợp lệ (Admin Demo: "các bill
// không vi phạm rule báo hợp lệ") — trả `null`, UI tự hiện trạng thái "Hợp lệ" trung tính khi null.
const RISKY_SETTLEMENT_CODES = new Set(['95']);
// Khớp "DONG(95)" sau khi bỏ dấu/hoa-thường/khoảng trắng (nhãn gốc "ĐÓNG(95)" — OCR có thể ra "DÓNG"/"DONG"/
// "Đóng" tuỳ độ rõ nét, stripDiacriticsUpper() đã chuẩn hoá hết Đ/đ→D trước NFD nên chỉ cần so "DONG(<số>)").
const SETTLEMENT_CODE_PATTERN = /DONG\s*\(\s*(\d+)\s*\)/;

export interface SettlementRiskWarning {
  code: string;
  message: string;
}

/** Quét TOÀN BỘ dòng OCR tìm mã đóng lô dạng "ĐÓNG(<số>)" — trả cảnh báo NẾU mã khớp `RISKY_SETTLEMENT_CODES`
 * (hiện chỉ "95", đã có bằng chứng thật). Mã đóng lô KHÔNG trong danh sách rủi ro (hoặc không tìm thấy dòng
 * "ĐÓNG(...)" nào) → trả `null` (hợp lệ/không phát hiện rủi ro, KHÔNG phải "chưa đọc được" — 2 khái niệm khác
 * nhau: bill có thể không in dòng này, không có nghĩa là rủi ro). */
export function checkSettlementRisk(lines: OcrLine[]): SettlementRiskWarning | null {
  for (const line of lines) {
    const match = SETTLEMENT_CODE_PATTERN.exec(stripDiacriticsUpper(line.text));
    if (!match) continue;
    const code = match[1];
    if (!RISKY_SETTLEMENT_CODES.has(code)) continue;
    return {
      code,
      message: `Bill có mã đóng lô ĐÓNG(${code}) — CẢNH BÁO rủi ro hoàn tiền/hủy giao dịch sau khi đã nhận tiền. Kiểm tra kỹ trước khi xác nhận giao dịch với khách.`
    };
  }
  return null;
}

export interface OcrBillPreview extends OcrAmountPreview, OcrBillFields {
  settlementRisk: SettlementRiskWarning | null;
}

/** Preview ĐẦY ĐỦ cho route `/v1/me/lo/ocr-preview` — gộp `buildAmountPreview()` (KHÔNG SỬA, gọi nguyên xi) +
 * `extractBillFields()` + `checkSettlementRisk()` TRÊN CÙNG mảng `lines` đã fetch 1 lần từ OCR service (caller
 * callOcrService() 1 lần DUY NHẤT rồi truyền `lines` vào đây — hàm này KHÔNG tự gọi mạng gì thêm). */
export function buildBillPreview(lines: OcrLine[]): OcrBillPreview {
  return { ...buildAmountPreview(lines), ...extractBillFields(lines), settlementRisk: checkSettlementRisk(lines) };
}

// ── OCR ĐA ĐỘ PHÂN GIẢI (Admin Demo 21/8 "kiểm tra tận gốc" — bill Oanh MB không đọc được TID+ngân hàng) ──────────
// GỐC RỄ (verify bằng OCR thật nhiều res trên chính ảnh): 1 độ phân giải KHÔNG BAO GIỜ đọc được CẢ TID lẫn logo
// ngân hàng. TID (chữ SỐ nhỏ) cần res CAO (≥1333) mới nét; logo ngân hàng (hình cách điệu lớn, vd ngôi sao "MB")
// chỉ ra chữ ở res THẤP (≤1100) — lên cao thì chi tiết/nhiễu làm OCR không nhận. OCR service ép 1 res=1600 → luôn
// mất 1 trong 2. FIX: chạy 2 LƯỢT (gốc ≤1600 cho TID/chữ + ~1000 cho logo bank) rồi GỘP field (ưu tiên lượt gốc,
// bù trường thiếu từ lượt thấp-res). Số tiền/rủi ro GIỮ từ lượt gốc (res cao, đáng tin). Lượt 2 lỗi → dùng lượt 1.
const OCR_LOWRES_LONGEST_PX = 1000;

// ── AUTO-XOAY hướng bill (Admin Demo 25/8 "xử lý triệt để bill xoay ngang / tự xoay rồi ocr") ────────────────────
// Bill chụp NẰM NGANG/ngược → PaddleOCR đọc rác (verify thật ảnh 4-bill: score từ khóa deg0=13 vs deg90=43). FIX:
// thử OCR ở 4 góc 0/90/180/270 tại độ phân giải thấp (rẻ) → CHẤM ĐIỂM bằng số từ khóa bill nhận ra → chọn góc cao
// nhất → xoay buffer về góc đó rồi mới trích trọn. Bill dựng-sẵn (score deg0 đã cao) vẫn chọn 0 (không đổi hành vi).
const BILL_ORIENT_KEYWORDS = ['SALE', 'THANH', 'TOTAL', 'TONG', 'VND', 'UND', 'BATCH', 'TRACE', 'MASTERCARD', 'VISA', 'JCB', 'APPROVAL', 'SETTLEMENT', 'CHUYEN'] as const;
function scoreBillOcr(lines: OcrLine[]): number {
  const t = lines.map((l) => (l?.text ?? '').toUpperCase()).join(' ');
  let s = 0;
  for (const k of BILL_ORIENT_KEYWORDS) s += t.split(k).length - 1;
  return s;
}
/** Dò góc xoay tốt nhất (0/90/180/270) bằng OCR nhỏ + chấm điểm từ khóa. Trả buffer ĐÃ XOAY về góc tốt nhất +
 *  lines OCR nhỏ ở góc đó (tái dùng làm lượt low-res, khỏi OCR lại). sharp/OCR lỗi → giữ nguyên (best-effort). */
async function detectBestOrientation(buffer: Buffer, fileName: string): Promise<{ orientedBuffer: Buffer; smallLines: OcrLine[] | null }> {
  let best = { deg: 0, score: -1, smallLines: null as OcrLine[] | null };
  for (const deg of [0, 90, 180, 270]) {
    try {
      const small = await sharp(buffer).rotate(deg).resize({ width: OCR_LOWRES_LONGEST_PX, height: OCR_LOWRES_LONGEST_PX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
      const r = await callOcrService(small, fileName);
      if (r.ok) {
        const s = scoreBillOcr(r.lines);
        if (s > best.score) best = { deg, score: s, smallLines: r.lines };
      }
    } catch {
      // sharp lỗi ở 1 góc → bỏ qua góc đó.
    }
  }
  if (best.deg === 0) return { orientedBuffer: buffer, smallLines: best.smallLines };
  try {
    const orientedBuffer = await sharp(buffer).rotate(best.deg).jpeg({ quality: 92 }).toBuffer();
    return { orientedBuffer, smallLines: best.smallLines };
  } catch {
    return { orientedBuffer: buffer, smallLines: best.smallLines };
  }
}

export async function buildBillPreviewMultiScale(
  buffer: Buffer,
  fileName: string
): Promise<{ ok: true; preview: OcrBillPreview; lines: OcrLine[]; nativeLines: OcrLine[] } | { ok: false; reason: 'SERVICE_UNREACHABLE' | 'SERVICE_ERROR' | 'EMPTY_FILE' | 'MIME_NOT_ALLOWED' }> {
  // AUTO-XOAY: chọn góc bill đọc tốt nhất TRƯỚC (cứu bill chụp nằm ngang) — làm việc trên buffer đã xoay.
  const { orientedBuffer, smallLines } = await detectBestOrientation(buffer, fileName);
  const r1 = await callOcrService(orientedBuffer, fileName);
  if (!r1.ok) return { ok: false, reason: r1.reason };
  let preview = buildBillPreview(r1.lines);
  let lines = r1.lines;
  try {
    // Lượt low-res: tái dùng smallLines từ dò-hướng (cùng góc, cùng res 1000) nếu có; else OCR lại buffer đã xoay.
    const r2 = smallLines
      ? { ok: true as const, lines: smallLines }
      : await callOcrService(await sharp(orientedBuffer).rotate().resize({ width: OCR_LOWRES_LONGEST_PX, height: OCR_LOWRES_LONGEST_PX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer(), fileName);
    if (r2.ok) {
      preview = mergeLowresBillFields(preview, r2.lines);
      lines = [...r1.lines, ...r2.lines]; // union cho detectCardFromOcr (scheme/BIN có thể ở lượt nào)
    }
  } catch {
    // sharp/decode lỗi → dùng nguyên lượt 1 (KHÔNG chặn luồng quét).
  }
  // nativeLines = CHỈ lượt gốc (đã xoay) — dùng cho đếm tín hiệu (vd số bill) mà KHÔNG bị nhân đôi bởi union 2 lượt.
  return { ok: true, preview, lines, nativeLines: r1.lines };
}

/** GỘP field từ lượt low-res vào preview lượt gốc — ưu tiên lượt gốc (res cao đáng tin), CHỈ bù trường lượt gốc
 *  THIẾU (null). Số tiền/rủi ro GIỮ nguyên lượt gốc. Tách hàm THUẦN để test độc lập (không phụ thuộc số lượt OCR). */
export function mergeLowresBillFields(base: OcrBillPreview, lowresLines: OcrLine[]): OcrBillPreview {
  const f2 = extractBillFields(lowresLines);
  return {
    ...base,
    tid: base.tid ?? f2.tid,
    bankName: base.bankName ?? f2.bankName,
    hkdName: base.hkdName ?? f2.hkdName,
    batchNumber: base.batchNumber ?? f2.batchNumber,
    invoiceNumber: base.invoiceNumber ?? f2.invoiceNumber
  };
}

// ── Biên lai chuyển khoản HOÀN TIỀN (2/8, tính năng "Hoàn tiền" MỚI, Admin Demo yêu cầu trực tiếp) ─────────────
// CẢNH BÁO GIỚI HẠN THẬT (khác 5 định dạng bill quẹt thẻ Ở TRÊN đã verify bằng 19 ảnh mẫu thật B121): bảng
// alias dưới đây CHƯA được chạy qua OCR thật với ảnh mẫu biên lai chuyển khoản hoàn tiền nào — Admin Demo CHƯA gửi
// ảnh mẫu loại này. Alias dựa trên thuật ngữ chuyển khoản ngân hàng VN phổ biến (Người chuyển/Người nhận/Số
// tài khoản nhận...), CÙNG phương pháp data-driven/condensed-match đã dùng cho bill quẹt thẻ — nhưng CHƯA có
// bằng chứng thật như B121 đòi hỏi ("BẮT BUỘC lấy OCR THẬT từ ≥1 ảnh mẫu thật trước khi viết regex/alias").
// Đây là ĐÁNH ĐỔI CÓ CHỦ ĐÍCH (task yêu cầu xây dựng khi CHƯA có ảnh mẫu) — bù lại: (1) field không đọc được
// KHÔNG chặn luồng gửi (CÙNG triết lý mọi field mở rộng khác), (2) so khớp tài khoản/tên chỉ dùng để CẢNH BÁO,
// KHÔNG BAO GIỜ tự động kết luận "khớp" khi không đọc được, (3) alias CỐ Ý hẹp/tránh fallback mơ hồ (KHÔNG có
// alias "SỐ TÀI KHOẢN" trần trụi — dễ nhầm với số tài khoản NGƯỜI CHUYỂN nếu bill in cả 2, chỉ nhận alias có
// từ "NHẬN"/"THỤ HƯỞNG" rõ ràng chỉ đích danh phía nhận tiền). Đề xuất quy trình (ghi trong báo cáo cuối): khi
// có ảnh mẫu thật đầu tiên, verify + mở rộng alias theo ĐÚNG quy trình B121 (bắt buộc OCR thật trước khi sửa).
const SENDER_NAME_LABEL_ALIASES = ['NGUOI CHUYEN', 'TEN NGUOI CHUYEN', 'NGUOI GUI', 'TEN NGUOI GUI', 'SENDER'] as const;
const RECIPIENT_NAME_LABEL_ALIASES = [
  'NGUOI NHAN',
  'TEN NGUOI NHAN',
  'NGUOI THU HUONG',
  'TEN NGUOI THU HUONG',
  'CHU TAI KHOAN NHAN',
  'BENEFICIARY',
  'RECEIVER'
] as const;
// CỐ Ý KHÔNG có alias "SO TAI KHOAN" trần trụi — xem giải thích ở comment khối trên (tránh nhặt nhầm STK
// người CHUYỂN nếu bill in cả 2 số tài khoản).
const RECIPIENT_ACCOUNT_LABEL_ALIASES = [
  'SO TAI KHOAN NHAN',
  'STK NHAN',
  'TAI KHOAN NHAN',
  'SO TK NHAN',
  'TAI KHOAN THU HUONG',
  'SO TK THU HUONG',
  'ACCOUNT NUMBER',
  'ACCOUNT NO'
] as const;

// ── #4 (3/8, LANE B Vòng 2) — ĐÃ VERIFY OCR THẬT trên 2 ảnh biên lai chuyển khoản hoàn tiền Admin Demo gửi ─────
// (apps/ocr-service/samples/refund/*.jpg, test refund-receipt-real-ocr.test.ts dùng `lines[]` THẬT). Bằng
// chứng OCR THẬT phơi ra các layout mà bảng alias CŨ (viết khi CHƯA có ảnh) KHÔNG bắt được — mở rộng theo
// đúng quy trình B121 (chỉ sửa SAU khi có OCR thật, KHÔNG suy đoán từ nhìn ảnh):
//   BIDV→TCB: nhãn "Đn:"(=Đến)/"Tàikhoàn:"(=Tài khoản) INLINE (nhãn+giá trị CÙNG dòng); 1 STK số thuần.
//   ACB→MB:   nhãn "Tù"(=Từ)/"ĐDn"(=Đến) đứng RIÊNG dòng (giá trị dòng SAU); "tài khoản" là MÃ VietQR.
// Nhãn hướng bị OCR làm rụng ký tự: "Đến"→"Đn"/"ĐDn"; "Từ"→"Tù". So khớp theo token đã bỏ dấu (condensed).
const RECIPIENT_DIR_LABEL_TOKENS = ['DEN', 'DDN', 'DN'] as const; // "Đến"/người nhận (+ biến thể OCR thật).
const SENDER_DIR_LABEL_TOKENS = ['TU'] as const; // "Từ"/người gửi.
const REFUND_ACCOUNT_INLINE_TOKENS = ['TAIKHOAN', 'STK', 'SOTAIKHOAN', 'SOTK'] as const;
const REF_CODE_LABEL_ALIASES = ['SO THAM CHIEU', 'THAM CHIEU', 'THAM CHIU', 'MA GIAO DICH', 'GIAO DICH', 'GIAO DCH', 'MA CHUYEN TIEN', 'REFERENCE'] as const;
// Mã VietQR/napas hiển thị ở ô "tài khoản" (ACB thật: "VQRQAASGJ6634") — KHÔNG phải dãy số TK thuần: đối chiếu
// người nhận chỉ so TÊN, KHÔNG so số (so số sẽ LỆCH giả → tick "hoàn đủ" sai hoặc báo lệch giả).
const VIETQR_PATTERN = /^VQR[A-Z0-9]{4,}$/i;
// Mã chuyển tiền/tham chiếu MẠNH (khóa dedup #5): 1 DÒNG thuần chữ+số (KHÔNG khoảng trắng/gạch/hai chấm), ≥14
// ký tự, có ≥2 chữ + ≥2 số, KHÔNG bắt đầu "VQR". Bằng chứng thật: "6214BIDVE2DY1464"/"6214ASCB02TA3BAV" (16).
const STRONG_REF_LINE_PATTERN = /^[A-Z0-9]{14,}$/i;

export interface RefundReceiptFields {
  bankName: OcrBillFieldValue | null; // ngân hàng brand APP (đầu biên lai) — GIỮ để tham chiếu, KHÔNG dùng đối chiếu người nhận.
  recipientBank: OcrBillFieldValue | null; // #4: ngân hàng NGƯỜI NHẬN (khác brand app) — đây mới là bên nhận tiền.
  senderName: OcrBillFieldValue | null;
  recipientName: OcrBillFieldValue | null;
  recipientAccountNumber: OcrBillFieldValue | null; // dãy SỐ thuần; null nếu là mã VietQR (xem recipientAccountVietQR).
  recipientAccountVietQR: string | null; // #4: mã VietQR/napas thay cho STK — đối chiếu chỉ so TÊN.
  transferCode: string | null; // #4/#5: mã chuyển tiền/số tham chiếu — khóa mạnh chống hoàn TRÙNG.
  dateTime: OcrBillFieldValue | null;
}

/** Tách "nhãn: giá trị" CÙNG dòng (INLINE) — BIDV thật "Đn: KHACH HANG 44"/"Tàikhoàn: 8791797777". */
function splitInline(text: string): { label: string; value: string } | null {
  const idx = text.indexOf(':');
  if (idx < 0) return null;
  const label = text.slice(0, idx).trim();
  const value = text.slice(idx + 1).trim();
  if (!label || !value) return null;
  return { label, value };
}

// ── #B123-fix (3/8, Admin Demo báo): TÊN NGƯỜI NHẬN TRÀN 2 DÒNG + NGÂN HÀNG NGƯỜI NHẬN không trả kết quả ────────
// GIỚI HẠN THẬT: 2 ảnh refund mẫu hiện có (đã chạy lại PaddleOCR thật 3/8) đều có tên người nhận GỌN 1 DÒNG —
// KHÔNG có ảnh tên-2-dòng thật để verify tuyệt đối. Fix + test dựa trên mô phỏng ĐÚNG dạng OCR thật (nhãn hướng
// "Đến" đứng riêng dòng như fixture ACB thật) — xem test/refund-name-2line-recipientbank.test.ts (ghi rõ mô
// phỏng). Khi có ảnh thật, chạy OCR thật + cập nhật fixture theo quy trình B121.

/** Bảng nhãn để DỪNG gộp tên — 1 dòng KHÔNG được coi là phần tiếp theo của tên nếu nó là nhãn field khác. */
const NAME_STOP_LABEL_ALIAS_GROUPS: readonly (readonly string[])[] = [
  RECIPIENT_ACCOUNT_LABEL_ALIASES,
  REF_CODE_LABEL_ALIASES,
  SENDER_NAME_LABEL_ALIASES,
  RECIPIENT_NAME_LABEL_ALIASES,
  // Nhãn ngày/giờ cũng là mốc DỪNG — tên KHÔNG được nuốt nhãn "Ngày Giờ"/"Ngày"/"Giờ" đứng ngay dưới tên
  // (bug regression phát hiện lúc chạy test: "LUU THI TRANG NHUNG" bị gộp thành "... Ngày Giờ").
  DATE_TIME_COMBINED_LABEL_ALIASES,
  DATE_ONLY_LABEL_ALIASES,
  TIME_ONLY_LABEL_ALIASES
];

/** Nhận diện dòng chứa TÊN NGÂN HÀNG (dùng cho recipientBank VÀ để DỪNG gộp tên). So khớp AN TOÀN:
 *  - đòi NGỮ CẢNH ngân hàng trên dòng ("BANK"/"NHTMCP"/"TMCP"/"NGÂN HÀNG") để không nhặt nhầm dòng thân bill;
 *  - alias NGẮN (mã ngân hàng ≤4 ký tự: MB/TCB/ACB/VCB…) đòi khớp NGUYÊN 1 TOKEN (tách theo ranh giới chữ-số),
 *    KHÔNG substring — vì "TECHCOMBANK" CHỨA chuỗi con "MB" (…COMB…) sẽ khớp NHẦM 'MB' nếu dùng substring
 *    (bug thật lộ ra khi viết test #B123: findRecipientBank cũ trả 'MB' cho dòng "Techcombank");
 *  - tên đầy đủ (≥5 ký tự: TECHCOMBANK/VIETCOMBANK/ABBANK…) cho phép substring (an toàn, đủ dài/đặc trưng). */
function detectBankOnLine(text: string): { display: string } | null {
  const up = stripDiacriticsUpper(text);
  const letters = up.replace(/[^A-Z]/g, '');
  if (letters.length === 0) return null;
  if (!/BANK|NHTMCP|TMCP|NGANHANG/.test(letters)) return null;
  const cond = condensed(up);
  const tokens = up.split(/[^A-Z0-9]+/).filter(Boolean).map((t) => condensed(t));
  for (const bank of BANK_ALIASES) {
    for (const alias of bank.aliases) {
      const a = condensed(alias);
      const matched = a.length >= 5 ? cond.includes(a) : tokens.includes(a);
      if (matched) return { display: bank.display };
    }
  }
  return null;
}

/** true nếu `text` có thể là 1 DÒNG TIẾP THEO của tên người (tên dài tràn dòng). Điều kiện: có chữ cái, KHÔNG
 * có chữ số (số TK/ngày/mã/số bị che ****86 đều có số → DỪNG), KHÔNG phải dòng tên ngân hàng, KHÔNG phải nhãn
 * field khác (hướng Đến/Từ, số TK, số tham chiếu, nhãn tên). */
function looksLikeNameContinuation(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (!/[A-Za-zÀ-ỹ]/.test(t)) return false;
  if (/[0-9]/.test(t)) return false;
  if (detectBankOnLine(t)) return false;
  const c = condensed(stripDiacriticsUpper(t));
  if ((RECIPIENT_DIR_LABEL_TOKENS as readonly string[]).includes(c)) return false;
  if ((SENDER_DIR_LABEL_TOKENS as readonly string[]).includes(c)) return false;
  if ((REFUND_ACCOUNT_INLINE_TOKENS as readonly string[]).some((tok) => c.includes(tok))) return false;
  for (const group of NAME_STOP_LABEL_ALIAS_GROUPS) {
    if (group.some((alias) => c.includes(condensed(alias)))) return false;
  }
  return true;
}

/** Gộp tên người từ dòng giá trị đầu + các dòng TIẾP THEO là phần tràn của tên (dừng ở dòng đầu tiên không
 * phải name-continuation). Cap 3 dòng tràn (tên người thật gần như không vượt quá) — tránh nuốt cả khối text
 * nếu OCR trả bố cục lạ. `firstValueIdx` = index dòng chứa giá trị đầu (đã lấy) trong `lines`. */
function mergeNameFrom(lines: OcrLine[], firstValueIdx: number, base: OcrBillFieldValue): OcrBillFieldValue {
  let value = base.value.trim();
  let uncertain = base.uncertain;
  let merged = 0;
  for (let k = firstValueIdx + 1; k < lines.length && merged < 3; k++) {
    const t = lines[k].text.trim();
    if (!looksLikeNameContinuation(t)) break;
    value = `${value} ${t}`;
    if (lines[k].score < TENTATIVE_MIN_CHAR_CONFIDENCE) uncertain = true;
    merged++;
  }
  return { value, uncertain };
}

/** Tìm giá trị theo nhãn HƯỚNG (Đến/Từ) — hỗ trợ CẢ 2 layout thật: (a) INLINE nhãn+giá trị cùng dòng (BIDV),
 * (b) nhãn đứng RIÊNG 1 dòng → giá trị dòng NGAY SAU (ACB). Nhãn khớp CHÍNH XÁC token đã bỏ dấu/condensed
 * (token rất ngắn nên đòi khớp tuyệt đối, tránh false-positive). Trả match ĐẦU TIÊN theo thứ tự dòng.
 * #B123-fix: tên có thể TRÀN nhiều dòng → gộp qua mergeNameFrom() (dừng ở STK/nhãn/ngân hàng). */
function findByDirectionLabel(lines: OcrLine[], tokens: readonly string[]): OcrBillFieldValue | null {
  const tokenSet = tokens as readonly string[];
  for (let i = 0; i < lines.length; i++) {
    const inline = splitInline(lines[i].text);
    if (inline) {
      const labelC = condensed(stripDiacriticsUpper(inline.label));
      if (tokenSet.includes(labelC) && /[A-Za-zÀ-ỹ]/.test(inline.value)) {
        return mergeNameFrom(lines, i, { value: inline.value, uncertain: lines[i].score < TENTATIVE_MIN_CHAR_CONFIDENCE });
      }
      continue; // có ':' nhưng nhãn không khớp → không coi là nhãn-đứng-riêng.
    }
    const wholeC = condensed(stripDiacriticsUpper(lines[i].text));
    if (!tokenSet.includes(wholeC)) continue;
    const next = lines[i + 1];
    if (!next || next.text.trim().length === 0) continue;
    return mergeNameFrom(lines, i + 1, { value: next.text.trim(), uncertain: next.score < TENTATIVE_MIN_CHAR_CONFIDENCE });
  }
  return null;
}

/** Tìm tên theo nhãn "Người nhận"/"Người chuyển" (own-line, giá trị dòng sau) + gộp tên tràn nhiều dòng
 * (#B123-fix). Tách riêng khỏi findValueAfterLabel() (dùng chung cho nhiều field) để KHÔNG đổi hành vi các
 * field khác — chỉ tên người mới cần gộp dòng. */
function findNameAfterLabel(lines: OcrLine[], aliases: readonly string[]): OcrBillFieldValue | null {
  for (let i = 0; i < lines.length - 1; i++) {
    if (!matchesAnyAlias(stripDiacriticsUpper(lines[i].text), aliases)) continue;
    const valueLine = lines[i + 1];
    const value = valueLine.text.trim();
    if (value.length === 0) continue;
    return mergeNameFrom(lines, i + 1, { value, uncertain: valueLine.score < TENTATIVE_MIN_CHAR_CONFIDENCE });
  }
  return null;
}

/** Phân loại chuỗi ô "tài khoản": dãy SỐ thuần → recipientAccountNumber; có chữ cái / bắt đầu "VQR" → coi là
 * MÃ (VietQR/napas) → recipientAccountVietQR (đối chiếu chỉ so TÊN, KHÔNG so số). */
function classifyAccount(raw: string): { number: string | null; vietQR: string | null } {
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, '');
  if (!cleaned) return { number: null, vietQR: null };
  if (VIETQR_PATTERN.test(cleaned) || /[A-Za-z]/.test(cleaned)) return { number: null, vietQR: cleaned.toUpperCase() };
  return { number: cleaned, vietQR: null };
}

// #B123-fix vòng 2 (3/8, ảnh THẬT refund_acb_ocb_2line.jpg): STK người nhận có thể nằm SAU dòng NGÂN HÀNG người
// nhận (layout tổng quát: nhãn hướng "Đến"/"Người nhận" → TÊN 1-3 dòng → NGÂN HÀNG → SỐ TK), KHÔNG có nhãn
// "Tài khoản" đi kèm. Dãy số thuần dài 8-19 chữ số (khoảng độ dài STK ngân hàng VN) = STK người nhận. Neo theo
// VÙNG NGƯỜI NHẬN (sau nhãn hướng/nhãn tên/dòng bank người nhận) để KHÔNG nhặt nhầm số của người GỬI (thường
// nằm TRƯỚC, ở khối "Từ", và ở bill này đã bị che dạng "******86").
const PURE_ACCOUNT_LINE_PATTERN = /^\d{8,19}$/;

/** Index dòng bắt đầu VÙNG NGƯỜI NHẬN: nhãn hướng (Đến/DN/DDN) đứng-riêng hoặc inline, HOẶC nhãn "Người nhận",
 * HOẶC (fallback) dòng ngân hàng người nhận. Trả -1 nếu không xác định được vùng người nhận (khi đó KHÔNG áp
 * chiến lược số-thuần-neo để tránh nhặt nhầm số người gửi). */
function findRecipientAnchorIndex(lines: OcrLine[]): number {
  for (let i = 0; i < lines.length; i++) {
    const inline = splitInline(lines[i].text);
    const labelC = inline
      ? condensed(stripDiacriticsUpper(inline.label))
      : condensed(stripDiacriticsUpper(lines[i].text));
    if ((RECIPIENT_DIR_LABEL_TOKENS as readonly string[]).includes(labelC)) return i;
    if (matchesAnyAlias(stripDiacriticsUpper(lines[i].text), RECIPIENT_NAME_LABEL_ALIASES)) return i;
  }
  for (let i = 0; i < lines.length; i++) {
    if (detectBankOnLine(lines[i].text)) return i;
  }
  return -1;
}

/** STK người nhận — Quy tắc 6 (biên lai chuyển khoản 1-STK → STK đó LÀ của người nhận). Thứ tự: (1) INLINE
 * "Tàikhoàn: <giá trị>", (2) nhãn "…tài khoản nhận…" 2 dòng, (3) dòng mã VietQR đứng riêng, (4) #B123-fix vòng
 * 2: dãy số thuần 8-19 chữ số nằm trong VÙNG NGƯỜI NHẬN (sau nhãn/bank — STK đứng sau dòng bank). Trả cả field
 * số lẫn mã VietQR (nếu có). */
function findRefundRecipientAccount(lines: OcrLine[]): { numberField: OcrBillFieldValue | null; vietQR: string | null } {
  for (const line of lines) {
    const inline = splitInline(line.text);
    if (!inline) continue;
    const labelC = condensed(stripDiacriticsUpper(inline.label));
    if (!(REFUND_ACCOUNT_INLINE_TOKENS as readonly string[]).some((t) => labelC.includes(t))) continue;
    const c = classifyAccount(inline.value);
    if (c.number || c.vietQR) {
      return { numberField: c.number ? { value: c.number, uncertain: line.score < TENTATIVE_MIN_CHAR_CONFIDENCE } : null, vietQR: c.vietQR };
    }
  }
  const byLabel = findValueAfterLabel(lines, RECIPIENT_ACCOUNT_LABEL_ALIASES);
  if (byLabel) {
    const c = classifyAccount(byLabel.value);
    if (c.number || c.vietQR) return { numberField: c.number ? { value: c.number, uncertain: byLabel.uncertain } : null, vietQR: c.vietQR };
  }
  for (const line of lines) {
    const t = line.text.trim();
    if (VIETQR_PATTERN.test(t)) return { numberField: null, vietQR: t.toUpperCase() };
  }
  // (4) Dãy SỐ THUẦN 8-19 chữ số trong VÙNG NGƯỜI NHẬN (sau nhãn hướng/tên/bank) — STK đứng sau dòng bank.
  const anchor = findRecipientAnchorIndex(lines);
  if (anchor >= 0) {
    for (let i = anchor + 1; i < lines.length; i++) {
      const t = lines[i].text.trim().replace(/\s+/g, '');
      if (PURE_ACCOUNT_LINE_PATTERN.test(t)) {
        return { numberField: { value: t, uncertain: lines[i].score < TENTATIVE_MIN_CHAR_CONFIDENCE }, vietQR: null };
      }
    }
  }
  return { numberField: null, vietQR: null };
}

/** Ngân hàng NGƯỜI NHẬN — dòng có NGỮ CẢNH ngân hàng ("Ngân hàng"/"NHTMCP"/"Bank"/"TMCP") khớp 1 alias (xem
 * detectBankOnLine — khớp AN TOÀN token cho mã ngắn, substring cho tên đầy đủ). #B123-fix: KHÔNG còn loại trừ
 * theo brand app đầu bill — bug thật Admin Demo báo là khi app CHUYỂN KHÔNG phải ngân hàng nhận diện được (vd ví
 * điện tử/logo không đọc ra mã), findBankName() vô tình coi chính NGÂN HÀNG NGƯỜI NHẬN là "brand" rồi loại trừ
 * → trả null. Nay dựa vào NGỮ CẢNH ngân hàng để bỏ qua logo đầu bill (logo "BIDV"/"ACB"/ví điện tử KHÔNG có
 * từ "Bank"/"Ngân hàng"/"TMCP" đi kèm) thay vì loại theo brand — đọc được đúng ngân hàng người nhận cả khi app
 * gửi không nhận diện được. Trả match ĐẦU TIÊN theo thứ tự dòng (dòng ngân hàng người nhận là dòng có ngữ cảnh
 * bank đầu tiên trong thân biên lai — verify trên 2 fixture thật BIDV→TCB, ACB→MB). */
function findRecipientBank(lines: OcrLine[]): OcrBillFieldValue | null {
  for (const line of lines) {
    const bank = detectBankOnLine(line.text);
    if (bank) return { value: bank.display, uncertain: line.score < TENTATIVE_MIN_CHAR_CONFIDENCE };
  }
  return null;
}

/** Mã chuyển tiền / số tham chiếu (khóa MẠNH chống hoàn TRÙNG #5). Ưu tiên token tham chiếu MẠNH (1 dòng thuần
 * chữ+số ≥14 ký tự, KHÔNG VietQR) — bằng chứng thật cả 2 biên lai. Fallback: nhãn "Số tham chiếu"/"Mã giao
 * dịch". Trả null nếu không đọc được (→ dedup coi là "thiếu dữ liệu đối chiếu, kiểm tay"). */
export function extractRefundTransferCode(lines: OcrLine[]): string | null {
  for (const line of lines) {
    const t = line.text.trim();
    if (!STRONG_REF_LINE_PATTERN.test(t)) continue;
    if (/^VQR/i.test(t)) continue;
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    const digits = (t.match(/[0-9]/g) || []).length;
    if (letters >= 2 && digits >= 2) return t.toUpperCase();
  }
  const byLabel = findValueAfterLabel(lines, REF_CODE_LABEL_ALIASES);
  if (byLabel) {
    const tok = byLabel.value.replace(/[^A-Za-z0-9]/g, '');
    if (tok.length >= 3) return tok.toUpperCase();
  }
  return null;
}

/** Đọc các trường từ biên lai chuyển khoản hoàn tiền — TÁI DÙNG `findDateTime()` NGUYÊN XI + logic hướng
 * Đến/Từ, ngân hàng người nhận, VietQR, mã chuyển tiền (đã verify OCR THẬT #4). Hàm THUẦN, KHÔNG throw, field
 * không tìm được → null (KHÔNG chặn luồng — CÙNG nguyên tắc `extractBillFields()`). */
export function extractRefundReceiptFields(lines: OcrLine[]): RefundReceiptFields {
  const account = findRefundRecipientAccount(lines);
  return {
    bankName: findBankName(lines),
    recipientBank: findRecipientBank(lines),
    senderName: findByDirectionLabel(lines, SENDER_DIR_LABEL_TOKENS) ?? findNameAfterLabel(lines, SENDER_NAME_LABEL_ALIASES),
    recipientName: findByDirectionLabel(lines, RECIPIENT_DIR_LABEL_TOKENS) ?? findNameAfterLabel(lines, RECIPIENT_NAME_LABEL_ALIASES),
    recipientAccountNumber: account.numberField,
    recipientAccountVietQR: account.vietQR,
    transferCode: extractRefundTransferCode(lines),
    dateTime: findDateTime(lines)
  };
}

export interface RefundReceiptPreview extends OcrAmountPreview, RefundReceiptFields {}

/** Preview ĐẦY ĐỦ cho route `/v1/me/refund/ocr-preview` — gộp `buildAmountPreview()` (số tiền hoàn đọc từ
 * ảnh, CÙNG bộ máy "VND/UND ..." đã verify cho bill quẹt thẻ — biên lai chuyển khoản NH cũng phổ biến in mẫu
 * này) + `extractRefundReceiptFields()` TRÊN CÙNG mảng `lines`. */
export function buildRefundReceiptPreview(lines: OcrLine[]): RefundReceiptPreview {
  return { ...buildAmountPreview(lines), ...extractRefundReceiptFields(lines) };
}

// ── MIGRATE OCR-in-chat: Python(8799) → SONNET@2400 (8796) đồng nhất 2 tab (Admin Demo 31/8 "phòng chat đồng nhất
//    OCR thủ công"). Engine cũ (nghi PaddleOCR mù MBV) đọc lệch bill hoàn/lô. Sonnet-PRIMARY + Python-FALLBACK
//    (an toàn: Sonnet lỗi/rỗng → giữ Python, KHÔNG phá subsystem refund). Bảo toàn đóng-lô-95 qua settlementCode. ──
const SONNET_OCR_URL = process.env.OCR_HTTP_URL || 'http://127.0.0.1:8796';
const SONNET_OCR_TOKEN = process.env.OCR_HTTP_TOKEN || '';
const SONNET_OCR_TIMEOUT_MS = Number(process.env.OCR_HTTP_TIMEOUT_MS) || 150_000;

interface SonnetBill { tid?: string | null; agencyName?: string | null; batchNumber?: string | null; type?: string; totalAmount?: number; dateTime?: string | null; bankName?: string | null; settlementCode?: string | null; cardScheme?: string | null; cardBin6?: string | null; }
interface SonnetTransfer { receiverName?: string | null; receiverAccount?: string | null; receiverBank?: string | null; senderName?: string | null; senderAccount?: string | null; amount?: number; date?: string | null; ref?: string | null; content?: string | null; }

/** Gọi OCR service SONNET (8796 /ocr — readBillOrTransfer: POS + CK). Lỗi/timeout/thiếu token → null (caller fallback Python). */
export async function callSonnetOcr(buffer: Buffer): Promise<{ bills: SonnetBill[]; transfers: SonnetTransfer[]; kind: string } | null> {
  if (!SONNET_OCR_TOKEN) return null;
  try {
    const res = await fetch(`${SONNET_OCR_URL}/ocr`, {
      method: 'POST', headers: { 'x-ocr-token': SONNET_OCR_TOKEN, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(buffer), signal: AbortSignal.timeout(SONNET_OCR_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { bills?: SonnetBill[]; transfers?: SonnetTransfer[]; kind?: string };
    return { bills: j.bills ?? [], transfers: j.transfers ?? [], kind: j.kind ?? 'UNKNOWN' };
  } catch { return null; }
}

function fv(s: string | null | undefined): OcrBillFieldValue | null { const v = (s ?? '').toString().trim(); return v ? { value: v, uncertain: false } : null; }
function amtPreview(amount: number, label: string): OcrAmountPreview {
  const ok = amount > 0;
  return { found: ok, rawText: ok ? String(amount) : null, parsedAmount: ok ? amount : null, needsManualReview: !ok, reasons: ok ? [] : [`OCR không đọc được ${label}`] };
}

/** Map bill POS Sonnet → OcrBillPreview (shape route /v1/me/lo/ocr-preview). settlementCode 95 → cảnh báo đóng-lô. */
export function sonnetBillToBillPreview(b: SonnetBill): OcrBillPreview {
  return {
    ...amtPreview(Number(b.totalAmount) || 0, 'số tiền'),
    tid: fv(b.tid), hkdName: fv(b.agencyName), dateTime: fv(b.dateTime),
    batchNumber: fv(b.batchNumber), invoiceNumber: null, bankName: fv(b.bankName),
    settlementRisk: b.settlementCode === '95'
      ? { code: '95', message: `Bill có mã đóng lô ĐÓNG(95) — CẢNH BÁO rủi ro hoàn tiền/hủy giao dịch sau khi đã nhận tiền. Kiểm tra kỹ trước khi xác nhận giao dịch với khách.` }
      : null
  };
}

/** Nhận diện scheme/BIN từ bill POS Sonnet (thay detectCardFromOcr(lines) khi migrate route lô sang Sonnet).
 *  DetectedScheme = INTERNATIONAL (Visa/Master/JCB/Amex/UnionPay) | DOMESTIC (Napas). Không rõ → null. */
export function sonnetCardDetection(b: SonnetBill): { scheme: 'INTERNATIONAL' | 'DOMESTIC' | null; bin6: string | null } {
  const s = (b.cardScheme ?? '').toString().toUpperCase();
  let scheme: 'INTERNATIONAL' | 'DOMESTIC' | null = null;
  if (/VISA|MASTER|JCB|AMEX|AMERICAN|UNIONPAY|QUOC TE/.test(s)) scheme = 'INTERNATIONAL';
  else if (/NAPAS|NOI DIA/.test(s)) scheme = 'DOMESTIC';
  const bin6 = (b.cardBin6 ?? '').toString().replace(/[^0-9]/g, '').slice(0, 6) || null;
  return { scheme, bin6 };
}

/** Map transfer CK Sonnet → RefundReceiptPreview (shape route /v1/me/refund/ocr-preview). */
export function sonnetTransferToRefundPreview(t: SonnetTransfer): RefundReceiptPreview {
  return {
    ...amtPreview(Number(t.amount) || 0, 'số tiền hoàn'),
    bankName: fv(t.receiverBank), recipientBank: fv(t.receiverBank),
    senderName: fv(t.senderName), recipientName: fv(t.receiverName),
    recipientAccountNumber: fv(t.receiverAccount), recipientAccountVietQR: null,
    transferCode: (t.ref ?? '').toString().trim() || null, dateTime: fv(t.date)
  };
}
