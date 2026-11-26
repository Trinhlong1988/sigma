// LAG-FIX v2 WIRE (12/8 — nối thư viện thu nhỏ ảnh image-resize.ts vào chỗ GỬI trong MessageComposer.tsx) —
// điểm nối DUY NHẤT cho luồng "Ảnh" THƯỜNG: thu nhỏ ảnh phía client TRƯỚC upload rồi đẩy qua `upload`.
//
// VÌ SAO tách ra 1 file lib riêng (thay vì gọi thẳng trong MessageComposer): vitest ở repo này chạy env
// 'node' (KHÔNG jsdom) → component JSX/hooks KHÔNG unit-test được (xem DateOfBirthPicker.test.ts). Tách wiring
// thành 1 hàm THUẦN nhận `upload` để có thể spy + khẳng định "đường ẢNH gọi resize, rồi upload bản đã resize".
//
// PHẠM VI (cố ý HẸP — KHỚP đúng docstring đầu image-resize.ts, KHÔNG mở rộng): CHỈ dùng cho 2 đường "Ảnh"
// thường trong MessageComposer.tsx:
//   - handlePickedImageFile  (chọn ảnh từ máy, <input accept="image/*"> fallback web)
//   - handleAttachImageClick (Camera.getPhoto trên native)
// CỐ Ý KHÔNG dùng cho:
//   - "Quét bill" (handleScanBillClick/handleConfirmBillSend): dữ liệu TIỀN, OCR server đọc số/TID → GIỮ
//     NGUYÊN full-res (chỉ resize phía server, đã kiểm chứng bằng bill thật — xem comment handleScanBillClick).
//   - "Chụp màn hình" (handleCaptureScreenClick/screen-capture.ts): đã nén riêng PNG→JPEG q=0.85.
//   - "File"/"Ghi âm": KHÔNG phải ảnh — giữ nguyên tuyệt đối.
//
// AN TOÀN: resizeImageForUpload KHÔNG BAO GIỜ throw/chặn gửi — mọi lỗi/thiếu API/loại-không-resize-được
// (gif động/svg) → trả về CHÍNH file gốc (xem image-resize.ts). Nên wiring này không thêm điểm hỏng nào.
import { resizeImageForUpload } from './image-resize';

/** Gửi 1 ảnh "thường": thu nhỏ phía client (best-effort) rồi upload. `upload` nhận File ĐÃ chuẩn bị (bản thu
 * nhỏ khi có lợi, ngược lại chính file gốc). Trả về Promise của `upload` để caller vẫn `await` được như cũ. */
export async function sendResizedImage(
  file: File,
  upload: (prepared: File) => Promise<void> | void
): Promise<void> {
  const prepared = await resizeImageForUpload(file);
  await upload(prepared);
}
