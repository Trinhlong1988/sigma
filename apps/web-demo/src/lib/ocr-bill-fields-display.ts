// SIGMA (1/8) — logic THUẦN (không DOM/React) quyết định hiển thị 6 trường bill mở rộng OCR đọc được
// (TID/tên HKD/ngày giờ/số lô/số hóa đơn/tên ngân hàng, xem apps/bot-api/src/ocr-bridge.ts
// extractBillFields()) — dùng CHUNG cho CẢ 2 nơi hiện panel OCR (OcrBillPreview.tsx trong chat +
// ReconcileDetailScreen.tsx đối soát) để giữ ĐÚNG nguyên tắc "UI đồng bộ tuyệt đối"
// (feedback_ui_design_system_consistency_9_7) — tách hàm THUẦN ra đây để test được KHÔNG cần
// jsdom/@testing-library/react (CÙNG lý do ocr-preview-ui.ts đã tách, xem comment đầu file đó — repo CHƯA có
// hạ tầng test render component).
//
// Bổ sung 1/8 (Admin Demo: "ô cột ngày riêng, giờ riêng") — `buildBillFieldDisplayRows()` trả 7 DÒNG hiển thị
// (KHÔNG còn 6:1) vì field `dateTime` gốc (1 giá trị OCR duy nhất, format "dd/mm/yyyy hh:mm:ss") được tách
// thành 2 dòng con "Ngày"/"Giờ" (`splitDateTime()`) — xem `apps/web-demo/src/lib/bill-table-image.ts` là nơi
// TIÊU THỤ 7 dòng này để vẽ bảng ảnh gửi trong chat (thay caption chữ dồn cục cũ).
import type { OcrBillFieldValue, OcrBillPreview, RefundReceiptPreview } from './agent-api-client';

/** Câu hiển thị khi field không đọc được — dùng CHUNG cho UI (hiện mờ) VÀ test (so khớp), tránh lệch chuỗi
 * giữa 2 nơi nếu sau này đổi câu chữ. */
export const BILL_FIELD_NOT_FOUND_TEXT = 'Không đọc được';

export interface BillFieldDisplayRow {
  key: 'bankName' | 'hkdName' | 'tid' | 'date' | 'time' | 'batchNumber' | 'invoiceNumber';
  label: string;
  /** Text hiển thị — `BILL_FIELD_NOT_FOUND_TEXT` nếu field null, kèm hậu tố "(chưa chắc chắn)" nếu field có
   * giá trị nhưng `uncertain:true` (confidence dòng OCR thấp hơn ngưỡng). */
  text: string;
  /** true nếu field null HOẶC uncertain — UI hiện MỜ (KHÔNG cùng mức tin tưởng field đã đọc chắc). */
  muted: boolean;
}

function formatField(field: OcrBillFieldValue | null): { text: string; muted: boolean } {
  if (!field) return { text: BILL_FIELD_NOT_FOUND_TEXT, muted: true };
  return { text: field.uncertain ? `${field.value} (chưa chắc chắn)` : field.value, muted: field.uncertain };
}

// SIGMA (1/8, Admin Demo chỉnh thuật ngữ) — "Đại lý" trong app này CHỈ dùng cho khái niệm khách hàng/nhóm
// chat được cấu hình (Agent/FriendRequest...) — KHÔNG PHẢI tên hộ kinh doanh in trên bill POS, dùng chung chữ
// "Đại lý" ở đây gây lẫn 2 khái niệm khác nhau. Đổi nhãn thành "Tên Pos (HKD)". Đồng thời giá trị OCR đọc
// được LUÔN có tiền tố "HKD " (mẫu bill thật: "HKD DEMOMAY 1"/"HKD THANH TOAN 2") — nhãn cột đã ghi rõ "(HKD)"
// nên tiền tố này dư thừa/trùng lặp — bóc bỏ CHỈ khi value bắt đầu ĐÚNG "HKD " (case-insensitive, không đụng
// phần còn lại của tên nếu không khớp tiền tố, tránh cắt nhầm dữ liệu KHÔNG có tiền tố này).
export const HKD_PREFIX_PATTERN = /^HKD\s+/i;

function formatHkdNameField(field: OcrBillFieldValue | null): { text: string; muted: boolean } {
  if (!field) return { text: BILL_FIELD_NOT_FOUND_TEXT, muted: true };
  const displayValue = field.value.replace(HKD_PREFIX_PATTERN, '');
  return { text: field.uncertain ? `${displayValue} (chưa chắc chắn)` : displayValue, muted: field.uncertain };
}

/** Tách chuỗi `preview.dateTime.value` — format CỐ ĐỊNH "dd/mm/yyyy hh:mm:ss" do `extractBillFields()` ghép
 * (xem apps/bot-api/src/ocr-bridge.ts `findValueAfterLabel()`: nhãn "DATE TIME"/"NGAY GIO" rồi lấy NGUYÊN dòng
 * ngay sau, KHÔNG có xử lý gì thêm) — thành `{date, time}` riêng, ranh giới là khoảng trắng ĐẦU TIÊN (ngày
 * luôn đứng trước, tự nó không chứa khoảng trắng). Hàm THUẦN, test độc lập được. Trả `null` nếu KHÔNG tìm được
 * khoảng trắng hợp lệ (không có phần ngày HOẶC không có phần giờ) — dữ liệu lệch format kỳ vọng (hiếm, OCR đọc
 * sai dòng), caller tự fallback hiện NGUYÊN chuỗi gốc thay vì vỡ layout/mất dữ liệu. */
export function splitDateTime(value: string): { date: string; time: string } | null {
  const trimmed = value.trim();
  const idx = trimmed.indexOf(' ');
  if (idx <= 0 || idx === trimmed.length - 1) return null;
  return { date: trimmed.slice(0, idx), time: trimmed.slice(idx + 1) };
}

/** Field `dateTime` gốc (1 giá trị OCR duy nhất) → 2 ô hiển thị riêng "Ngày"/"Giờ" (Admin Demo yêu cầu 1/8, tiếp
 * theo yêu cầu "chỉ bảng kẻ ô đẹp"). `uncertain`/null áp DÙNG CHUNG cho cả 2 ô con — CÙNG 1 nguồn OCR, KHÔNG
 * có khái niệm "chắc ngày, không chắc giờ" riêng biệt. */
function formatDateTimeField(field: OcrBillFieldValue | null): {
  date: { text: string; muted: boolean };
  time: { text: string; muted: boolean };
} {
  if (!field) {
    const notFound = { text: BILL_FIELD_NOT_FOUND_TEXT, muted: true };
    return { date: notFound, time: notFound };
  }
  const split = splitDateTime(field.value);
  const rawDate = split ? split.date : field.value;
  const rawTime = split ? split.time : field.value;
  return {
    date: { text: field.uncertain ? `${rawDate} (chưa chắc chắn)` : rawDate, muted: field.uncertain },
    time: { text: field.uncertain ? `${rawTime} (chưa chắc chắn)` : rawTime, muted: field.uncertain }
  };
}

/** Dựng 7 dòng hiển thị theo ĐÚNG thứ tự ưu tiên Admin Demo xác nhận (1/8, ngày/giờ tách 2 ô riêng bổ sung cùng
 * ngày): Bank, tên HKD, TID, Ngày, Giờ — rồi tới số lô/số hóa đơn. */
export function buildBillFieldDisplayRows(preview: OcrBillPreview): BillFieldDisplayRow[] {
  const { date, time } = formatDateTimeField(preview.dateTime);
  return [
    { key: 'bankName', label: 'Ngân hàng', ...formatField(preview.bankName) },
    { key: 'hkdName', label: 'Tên Pos (HKD)', ...formatHkdNameField(preview.hkdName) },
    { key: 'tid', label: 'TID', ...formatField(preview.tid) },
    { key: 'date', label: 'Ngày', ...date },
    { key: 'time', label: 'Giờ', ...time },
    { key: 'batchNumber', label: 'Số lô', ...formatField(preview.batchNumber) },
    { key: 'invoiceNumber', label: 'Số hóa đơn', ...formatField(preview.invoiceNumber) }
  ];
}

/** Cảnh báo NHẸ (KHÔNG chặn luồng, CÙNG triết lý needsManualReview số tiền) khi TID đọc được KHÔNG khớp dữ
 * liệu Tid đã cấu hình của đại lý (matchBillTidWithAgentTids(), apps/bot-api/src/routes/me.ts) — null nếu
 * KHÔNG có TID đọc được (không có gì để đối chiếu, hiện cảnh báo sẽ gây nhiễu vô ích) HOẶC đã khớp. */
export function describeTidMatchWarning(preview: OcrBillPreview): string | null {
  if (!preview.tid || preview.tidMatched) return null;
  return `TID ${preview.tid.value} chưa khớp dữ liệu đã cấu hình trong hệ thống — vui lòng kiểm tra lại.`;
}

// ── SIGMA (2/8, tính năng "Hoàn tiền" MỚI) — 5 dòng hiển thị cho biên lai chuyển khoản hoàn tiền, CÙNG
// khuôn `buildBillFieldDisplayRows()` trên (dateTime tách 2 ô Ngày/Giờ, field không đọc được → mờ +
// BILL_FIELD_NOT_FOUND_TEXT) — DÙNG CHUNG BillFieldsTable.tsx (component đó nhận rows generic, KHÔNG viết bảng
// riêng cho refund, đúng nguyên tắc "1 bảng, tái dùng").
export interface RefundFieldDisplayRow {
  key: 'bankName' | 'senderName' | 'recipientName' | 'recipientAccountNumber' | 'date' | 'time';
  label: string;
  text: string;
  muted: boolean;
}

export function buildRefundFieldDisplayRows(preview: RefundReceiptPreview): RefundFieldDisplayRow[] {
  const { date, time } = formatDateTimeField(preview.dateTime);
  return [
    { key: 'bankName', label: 'Ngân hàng', ...formatField(preview.bankName) },
    { key: 'senderName', label: 'Người chuyển', ...formatField(preview.senderName) },
    { key: 'recipientName', label: 'Người nhận', ...formatField(preview.recipientName) },
    { key: 'recipientAccountNumber', label: 'STK người nhận', ...formatField(preview.recipientAccountNumber) },
    { key: 'date', label: 'Ngày', ...date },
    { key: 'time', label: 'Giờ', ...time }
  ];
}
