// SIGMA (2/8, tính năng "Hoàn tiền" MỚI) — logic THUẦN tính trạng thái CỘNG DỒN hoàn tiền + format hiển
// thị. Type mirror THỦ CÔNG của `computeRefundAggregate()`/`REFUND_MATCH_TOLERANCE_VND`
// (apps/bot-api/src/refund-service.ts) — CÙNG ngưỡng ±3.000đ, dùng ở CLIENT để hiện trạng thái LIVE trong panel
// xem trước (TRƯỚC khi xác nhận gửi — Admin Demo 2/8: "cảnh báo phải hiện NGAY LÚC XEM TRƯỚC"), server tính LẠI
// giá trị cuối cùng lưu vào metadataJson lúc gửi (KHÔNG tin riêng client cho dữ liệu tài chính — nhưng ở ĐÂY
// KHÔNG có ranh giới bảo mật nào bị vi phạm nếu 2 bên tính lệch nhau vài giây do làm tròn, vì đây chỉ là hiển
// thị/snapshot audit-trail, KHÔNG phải số tiền chuyển khoản thật qua hệ thống ngân hàng).
//
// 4 TRẠNG THÁI đã CHỐT TÊN (Admin Demo 2/8, dùng ĐÚNG 4 tên này xuyên suốt UI — KHÔNG tự đặt tên khác):
//   "Chưa hoàn" (none) / "Hoàn thiếu" (partial) / "Hoàn đủ" (matched) / "Hoàn thừa" (over).
import { formatVndGrouped } from './bill-refund-text';

export type RefundAmountStatus = 'none' | 'partial' | 'matched' | 'over';

export const REFUND_MATCH_TOLERANCE_VND = 3000;

export interface RefundAggregateResult {
  status: RefundAmountStatus;
  /** totalConfirmed − requiredAmount. Dương = hoàn thừa, âm = hoàn thiếu/chưa hoàn hết. */
  diff: number;
  totalConfirmed: number;
  requiredAmount: number;
}

/** CÙNG THUẬT TOÁN `computeRefundAggregate()` (refund-service.ts backend) — xem comment đầu file. */
export function computeRefundAggregate(requiredAmount: number, totalConfirmed: number): RefundAggregateResult {
  const diff = totalConfirmed - requiredAmount;
  if (totalConfirmed <= 0) return { status: 'none', diff: -requiredAmount, totalConfirmed, requiredAmount };
  if (diff > REFUND_MATCH_TOLERANCE_VND) return { status: 'over', diff, totalConfirmed, requiredAmount };
  if (diff < -REFUND_MATCH_TOLERANCE_VND) return { status: 'partial', diff, totalConfirmed, requiredAmount };
  return { status: 'matched', diff, totalConfirmed, requiredAmount };
}

export const REFUND_STATUS_LABEL_VI: Record<RefundAmountStatus, string> = {
  none: 'Chưa hoàn',
  partial: 'Hoàn thiếu',
  matched: 'Hoàn đủ',
  over: 'Hoàn thừa'
};

/** Màu Tailwind cho từng trạng thái — "Hoàn thừa" ĐỎ (mức cảnh báo cao nhất, Admin Demo: rủi ro tài chính thật),
 * "Hoàn thiếu" màu cảnh báo KHÁC đỏ (amber, phân biệt rõ 2 loại lệch theo đúng yêu cầu), "Hoàn đủ" xanh
 * (success, CÙNG tông "Hoàn tiền" hero row đã dùng ở B111), "Chưa hoàn" xám trung tính. */
export const REFUND_STATUS_COLOR_CLASS: Record<RefundAmountStatus, string> = {
  none: 'border-slate-300 bg-slate-50 text-slate-600',
  partial: 'border-amber-400 bg-amber-50 text-amber-700',
  matched: 'border-success bg-success/10 text-success',
  over: 'border-danger bg-danger/10 text-danger'
};

/** Câu hiển thị ĐẦY ĐỦ trạng thái — Admin Demo nhấn mạnh lại 2 lần: "Hoàn thừa"/"Hoàn thiếu" BẮT BUỘC kèm SỐ TIỀN
 * CHÊNH LỆCH CHÍNH XÁC (vd "Hoàn thừa 5.000đ"/"Hoàn thiếu 60.000đ"), KHÔNG chỉ nhãn chung chung. */
export function describeRefundAggregate(agg: RefundAggregateResult): string {
  if (agg.status === 'matched') return REFUND_STATUS_LABEL_VI.matched;
  if (agg.status === 'none') return REFUND_STATUS_LABEL_VI.none;
  const absDiff = Math.abs(agg.diff);
  const label = agg.status === 'over' ? REFUND_STATUS_LABEL_VI.over : REFUND_STATUS_LABEL_VI.partial;
  return `${label} ${formatVndGrouped(absDiff)}đ`;
}

/** Dòng nhỏ "Đã hoàn: X/Y (lần này: Z)" — Admin Demo 2/8: hiện NGAY dưới MỖI tin nhắn hoàn tiền riêng lẻ, không
 * cần cuộn lại các lần hoàn trước để biết tổng. */
export function describeRefundLineProgress(totalConfirmed: number, requiredAmount: number, thisEntryAmount: number): string {
  return `Đã hoàn: ${formatVndGrouped(totalConfirmed)}đ/${formatVndGrouped(requiredAmount)}đ (lần này: ${formatVndGrouped(thisEntryAmount)}đ)`;
}
