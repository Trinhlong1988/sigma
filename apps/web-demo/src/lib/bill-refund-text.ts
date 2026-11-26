// B112 (2/8) — tách "Hoàn tiền sau phí" (`formatVndGrouped`/`buildRefundText`) ra khỏi OcrBillPreview.tsx
// (nơi 2 hàm này ban đầu được viết inline, B111 2/8) thành module DÙNG CHUNG — EditBillMessageModal.tsx (panel
// "Sửa" bill đã gửi, mới) cần TÁI DÙNG NGUYÊN CÔNG THỨC này để hàng "Hoàn tiền" hiển thị NHẤT QUÁN giữa lúc
// quét lần đầu và lúc sửa, tránh lệch 2 nơi — ĐÚNG bài học B106 retro "sửa 1 nơi quên nơi khác" mà chính B111
// đã tự nhắc (xem comment cũ `buildRefundText` OcrBillPreview.tsx).
import { groupDigits } from './grouped-money-input';
import type { FeePreviewData } from './agent-api-client';

/** Định dạng số nguyên kiểu Việt Nam (phân nhóm nghìn bằng dấu chấm, VD 52700000 -> "52.700.000"). */
export function formatVndGrouped(n: number): string {
  return groupDigits(String(Math.trunc(n)));
}

/** Text hàng "Hoàn tiền" (số tiền sau phí bán) — GET /v1/me/fee-preview KHÔNG BAO GIỜ lỗi: TID/phí chưa cấu
 * hình → `resolved:false`, hàm này TỰ hiểu là phí 0% (đúng yêu cầu "rỗng thì để = 0%"). `null` khi chưa có số
 * tiền hợp lệ (không có gì để hoàn). */
export function buildRefundText(parsedAmount: number | null, feePreview: FeePreviewData | null): string | null {
  if (parsedAmount == null || parsedAmount <= 0) return null;
  // Admin Demo 20/8: TID khớp đúng đại lý nhưng CHƯA set giá bán thực tế → hiện "chưa cấu hình giá bán" (KHÔNG mượn %
  // niêm yết, KHÔNG hiện "phí 0%" gây hiểu nhầm đã hoàn đủ). Phân biệt với resolved:false do TID không khớp/không
  // thuộc đại lý (vẫn 0% như cũ vì đó là ước tính TID lạ).
  if (feePreview?.noActualFee === true) {
    return `${formatVndGrouped(parsedAmount)}đ (chưa cấu hình giá bán)`;
  }
  const resolved = feePreview?.resolved === true;
  const amountAfterFee = resolved ? feePreview!.amountAfterFee : parsedAmount;
  // TỶ LỆ % lấy TRỰC TIẾP từ backend (phiBanMilli = % × 1000) — hiển thị ĐÚNG tỷ lệ đã cấu hình, KHÔNG suy ngược
  // feeApplied/parsedAmount (suy ngược lệch khi làm tròn VND hoặc phí bậc thang). Chỉ khi resolved:true mới có
  // phiBanMilli; các nhánh khác (chưa tải/lỗi mạng/resolved:false) = 0% như cũ.
  const feePercent = resolved && feePreview?.phiBanMilli != null ? feePreview.phiBanMilli / 1000 : 0;
  const feePercentText = feePercent.toLocaleString('vi-VN', { maximumFractionDigits: 2 });
  return `${formatVndGrouped(amountAfterFee)}đ (phí ${feePercentText}%)`;
}
