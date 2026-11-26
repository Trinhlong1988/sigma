// SIGMA (31/7 tiếp B71-part2) — test THUẦN cho deriveOcrPreviewUiState() (lib/ocr-preview-ui.ts), toàn bộ
// logic quyết định UI của form OCR preview ReconcileDetailScreen.tsx (autofill/cảnh báo đỏ/cảnh báo nhẹ/lỗi
// dịch vụ). Đây là nơi cô lập phần "rủi ro nhất" của tính năng để test được — xem comment đầu ocr-preview-ui.ts
// lý do KHÔNG render-test component React thật (repo CHƯA có jsdom/@testing-library/react, cài thêm là quyết
// định hạ tầng ngoài phạm vi đợt build này).
import { describe, expect, it } from 'vitest';
import { deriveOcrPreviewUiState } from './ocr-preview-ui';
import type { AgentApiResult, OcrAmountPreview } from './agent-api-client';

function ok(data: OcrAmountPreview): AgentApiResult<OcrAmountPreview> {
  return { ok: true, data };
}
function fail(error: string, message: string): AgentApiResult<OcrAmountPreview> {
  return { ok: false, error, message };
}

describe('deriveOcrPreviewUiState', () => {
  it('found=true, needsManualReview=false, có parsedAmount -> autofilled', () => {
    const state = deriveOcrPreviewUiState(ok({ found: true, rawText: '520000', parsedAmount: 520000, needsManualReview: false, reasons: [] }));
    expect(state).toEqual({ kind: 'autofilled', parsedAmount: 520000 });
  });

  it('found=true, needsManualReview=true (case thật B71-part2, rớt dấu chấm phân nhóm) -> needs_review giữ NGUYÊN reasons[] + suggestedAmount (1/8, không vứt bỏ giá trị đã tính được)', () => {
    const reasons = ['Định dạng phân nhóm nghìn không đúng chuẩn (mỗi nhóm sau dấu chấm phải đúng 3 chữ số): "52700.000".'];
    const state = deriveOcrPreviewUiState(ok({ found: true, rawText: '52700.000', parsedAmount: 52700000, needsManualReview: true, reasons }));
    expect(state).toEqual({ kind: 'needs_review', reasons, suggestedAmount: 52700000 });
  });

  it('found=true nhưng parsedAmount=null (phòng thủ nếu contract server đổi) -> needs_review, KHÔNG autofill giá trị rỗng', () => {
    const state = deriveOcrPreviewUiState(ok({ found: true, rawText: '', parsedAmount: null, needsManualReview: false, reasons: [] }));
    expect(state.kind).toBe('needs_review');
  });

  it('found=false -> not_found (cảnh báo nhẹ, KHÔNG chặn submit)', () => {
    const state = deriveOcrPreviewUiState(ok({ found: false, rawText: null, parsedAmount: null, needsManualReview: true, reasons: ['Không tìm thấy dòng số tiền (mẫu "VND ...") trong kết quả OCR — cần nhập tay.'] }));
    expect(state).toEqual({ kind: 'not_found' });
  });

  it('lỗi mạng (NETWORK_ERROR, fetch throw) -> error, thông báo chung "Không kết nối được dịch vụ OCR"', () => {
    const state = deriveOcrPreviewUiState(fail('NETWORK_ERROR', 'Lỗi kết nối mạng, vui lòng kiểm tra đường truyền và thử lại.'));
    expect(state).toEqual({ kind: 'error', message: 'Không kết nối được dịch vụ OCR, vui lòng nhập tay.' });
  });

  it('502 SERVICE_UNREACHABLE -> error, CÙNG thông báo chung như lỗi mạng (không phân biệt phía người dùng)', () => {
    const state = deriveOcrPreviewUiState(fail('SERVICE_UNREACHABLE', 'Không gọi được dịch vụ OCR — vui lòng nhập tay.'));
    expect(state).toEqual({ kind: 'error', message: 'Không kết nối được dịch vụ OCR, vui lòng nhập tay.' });
  });

  it('502 SERVICE_ERROR (OCR service lỗi nội bộ) -> error, CÙNG thông báo chung', () => {
    const state = deriveOcrPreviewUiState(fail('SERVICE_ERROR', 'Không gọi được dịch vụ OCR — vui lòng nhập tay.'));
    expect(state).toEqual({ kind: 'error', message: 'Không kết nối được dịch vụ OCR, vui lòng nhập tay.' });
  });

  it('400 NO_FILE (lỗi PHÍA CLIENT, không phải mạng/service) -> error, giữ NGUYÊN message server (không thay bằng câu chung)', () => {
    const state = deriveOcrPreviewUiState(fail('NO_FILE', 'Thiếu ảnh bill trong yêu cầu.'));
    expect(state).toEqual({ kind: 'error', message: 'Thiếu ảnh bill trong yêu cầu.' });
  });

  it('413 FILE_TOO_LARGE -> error, giữ nguyên message server', () => {
    const state = deriveOcrPreviewUiState(fail('FILE_TOO_LARGE', 'Ảnh vượt quá giới hạn 10MB.'));
    expect(state).toEqual({ kind: 'error', message: 'Ảnh vượt quá giới hạn 10MB.' });
  });

  it('400 MIME_NOT_ALLOWED -> error, giữ nguyên message server', () => {
    const state = deriveOcrPreviewUiState(fail('MIME_NOT_ALLOWED', 'Ảnh không đúng định dạng jpeg/png/webp — vui lòng chụp lại.'));
    expect(state).toEqual({ kind: 'error', message: 'Ảnh không đúng định dạng jpeg/png/webp — vui lòng chụp lại.' });
  });

  it('400 EMPTY_FILE -> error, giữ nguyên message server', () => {
    const state = deriveOcrPreviewUiState(fail('EMPTY_FILE', 'Ảnh rỗng, không đọc được nội dung.'));
    expect(state).toEqual({ kind: 'error', message: 'Ảnh rỗng, không đọc được nội dung.' });
  });

  it('PARSE_ERROR (JSON phản hồi hỏng) -> error, giữ nguyên message client', () => {
    const state = deriveOcrPreviewUiState(fail('PARSE_ERROR', 'Không đọc được phản hồi từ máy chủ, vui lòng thử lại.'));
    expect(state).toEqual({ kind: 'error', message: 'Không đọc được phản hồi từ máy chủ, vui lòng thử lại.' });
  });
});
