// SIGMA (31/7 tiếp B71-part2) — logic THUẦN (không DOM) quyết định UI hiển thị gì sau khi gọi
// previewLoOcr() (agent-api-client.ts) ở ReconcileDetailScreen.tsx, field "Tổng tiền OCR (bill tổng kết)".
// Tách riêng khỏi component để test được bằng vitest environment 'node' — dự án CHƯA có jsdom/
// @testing-library/react (kiểm tra thật TRƯỚC khi viết: `grep -rn "jsdom|testing-library" **/package.json`
// KHÔNG có kết quả nào, apps/web-demo/package.json KHÔNG có cả script "test"; mọi *.test.tsx render-test
// component KHÔNG tồn tại tiền lệ nào trong repo) — cài thêm framework mới NGOÀI phạm vi "code + test thuần"
// được giao (sẽ phải thêm devDependency + environment jsdom + config riêng, là quyết định hạ tầng test cần
// LEAD duyệt, KHÔNG tự ý làm — xem BUGS_FIXED.md B71-part3 mục "CHƯA làm"). Thay vào đó, TOÀN BỘ nhánh quyết
// định rủi ro nhất (tự điền/cảnh báo đỏ/cảnh báo nhẹ/thông báo lỗi dịch vụ) được cô lập ở ĐÂY thành hàm thuần,
// test đầy đủ mọi nhánh; component chỉ gọi hàm này rồi render theo `kind` — phần JSX còn lại là rendering
// thuần túy, rủi ro thấp hơn nhiều so với phần logic quyết định.
import type { AgentApiResult, OcrAmountPreview } from './agent-api-client';

export type OcrPreviewUiState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'autofilled'; parsedAmount: number }
  // suggestedAmount (1/8, bug thật Admin Demo báo "chấp nhận dấu phẩy mà sao không ra số tiền?") — TRƯỚC ĐÂY
  // nhánh needs_review KHÔNG mang parsedAmount, dù server (buildAmountPreview()) vẫn tính ĐÚNG số tiền song
  // song với việc gắn cờ cảnh báo (vd dấu phẩy — B93). Component vứt bỏ giá trị đã tính đúng, hiện ô trống bắt
  // gõ lại từ đầu dù máy đã ra đúng số. Null khi thật sự không tính được gì (found=false hoặc server không
  // trả parsedAmount) — CHỈ khác `autofilled` ở chỗ vẫn cần xác nhận tay do có tín hiệu đáng ngờ.
  | { kind: 'needs_review'; reasons: string[]; suggestedAmount: number | null }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

/** Câu thông báo CHUNG cho lỗi mạng (fetch throw) HOẶC OCR service không tới được/lỗi nội bộ (502
 * SERVICE_UNREACHABLE/SERVICE_ERROR, ocr-bridge.ts) — đúng yêu cầu "Lỗi mạng/502 → thông báo này, KHÔNG throw
 * ra ngoài làm vỡ UI". Các lỗi PHÍA CLIENT khác (400/413 — file sai định dạng/quá lớn/rỗng) đã có message
 * tiếng Việt phù hợp riêng từ server, KHÔNG cần thay bằng câu chung này. */
const SERVICE_DOWN_MESSAGE_VI = 'Không kết nối được dịch vụ OCR, vui lòng nhập tay.';
const SERVICE_DOWN_ERROR_CODES = new Set(['NETWORK_ERROR', 'SERVICE_UNREACHABLE', 'SERVICE_ERROR']);

/** result = trả về THẲNG từ previewLoOcr(). KHÔNG BAO GIỜ throw — luôn trả về 1 state hợp lệ để form nhập tay
 * (summaryAmount) tiếp tục hoạt động bình thường dù OCR lỗi bất kỳ kiểu gì (đúng yêu cầu "OCR CHỈ hỗ trợ điền
 * sẵn field, không chặn submit"). */
export function deriveOcrPreviewUiState(result: AgentApiResult<OcrAmountPreview>): OcrPreviewUiState {
  if (!result.ok) {
    if (SERVICE_DOWN_ERROR_CODES.has(result.error)) {
      return { kind: 'error', message: SERVICE_DOWN_MESSAGE_VI };
    }
    return { kind: 'error', message: result.message };
  }

  const preview = result.data;
  if (!preview.found) {
    return { kind: 'not_found' };
  }
  // Phòng thủ: found=true nhưng parsedAmount null (không nên xảy ra theo buildAmountPreview() hiện tại — nếu
  // found thì rawText/parsedAmount luôn có giá trị, xem ocr-bridge.ts — nhưng KHÔNG tự điền field bằng giá trị
  // rỗng nếu contract phía server đổi trong tương lai) → coi như cần kiểm tra tay, KHÔNG throw/crash UI.
  if (preview.needsManualReview || preview.parsedAmount == null) {
    const reasons = preview.reasons.length > 0 ? preview.reasons : ['OCR không chắc chắn về số tiền đọc được — vui lòng kiểm tra tay.'];
    return { kind: 'needs_review', reasons, suggestedAmount: preview.parsedAmount };
  }
  return { kind: 'autofilled', parsedAmount: preview.parsedAmount };
}
