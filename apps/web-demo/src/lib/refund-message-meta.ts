// SIGMA (2/8, tính năng "Hoàn tiền" MỚI, Admin Demo yêu cầu trực tiếp) — metadata ĐẦY ĐỦ lưu trong
// `ChatMessage.metadataJson` cho tin nhắn xác nhận HOÀN TIỀN (kind IMAGE, ảnh biên lai chuyển khoản ĐÃ GHÉP
// bảng OCR + cảnh báo, gửi kèm `replyToMessageId` trỏ tới bill gốc — Admin Demo chốt 2/8: "PHẢI dùng CƠ CHẾ TRÍCH
// DẪN (quote-reply) ĐÃ CÓ SẴN", KHÔNG cần trường liên kết riêng nào khác ngoài `replyToMessageId` có sẵn).
// Module này là NGUỒN DUY NHẤT build/parse metadataJson hoàn tiền — CẢ lúc gửi lần đầu (ConversationScreen.tsx
// qua RefundBillModal.tsx) LẪN lúc sửa (EditRefundMessageModal.tsx), CÙNG nguyên tắc bill-message-meta.ts (B112)
// "tránh lệch field 2 nơi".
//
// AUDIT TRAIL KHI SỬA (Admin Demo 2/8, chốt bổ sung): mọi lần sửa PHẢI ghi lại "Đã sửa bởi <tên> lúc <giờ>" —
// KHÔNG ghi đè, giữ MỌI lần sửa trước — lưu trong CHÍNH metadataJson này (`editHistory[]`, KHÔNG cần bảng/field
// DB mới — metadataJson vốn đã là JSON tự do, additive an toàn, KHÔNG đổi schema).
//
// Backend mirror THỦ CÔNG (apps/bot-api/src/services/chat-message-service.ts editMessage(), field
// `isRefundImage`/`refundAmount` PHẢI khớp CHÍNH XÁC tên field ở đây — CÙNG quy ước bill-message-meta.ts).
import type { RecipientMatchStatus, RefundReceiptPreview } from './agent-api-client';

export type RefundAmountStatus = 'none' | 'partial' | 'matched' | 'over';

export interface RefundEditHistoryEntry {
  editedByAgentId: number;
  editedByName: string;
  editedAt: string; // ISO
}

export interface RefundMessageMeta {
  /** 5 trường OCR + preview số tiền đọc từ ảnh biên lai hoàn tiền LẦN NÀY (bank/người chuyển/người nhận/STK
   * nhận/ngày giờ) — lưu NGUYÊN VĂN để "Sửa" KHÔNG cần chạy lại OCR (CÙNG lý do bill-message-meta.ts). */
  refundFields: RefundReceiptPreview;
  /** Số tiền hoàn ĐÃ XÁC NHẬN cho LẦN NÀY (KHÔNG phải tổng cộng dồn — mỗi lần hoàn tiền là 1 con số riêng, Mr.
   * Long 2/8: "mang số tiền OCR đọc được của LẦN ĐÓ, KHÔNG phải tổng"). */
  amount: number;
  /** Chiều cao PHYSICAL PIXEL phần ẢNH BIÊN LAI GỐC trong ảnh ghép — CÙNG vai trò `billImageHeightPx`
   * (bill-message-meta.ts), dùng để cắt lại đúng phần ảnh lúc "Sửa" (cropTopOfImage()). */
  imageHeightPx: number;
  /** Trạng thái CỘNG DỒN (Chưa hoàn/Hoàn thiếu/Hoàn đủ/Hoàn thừa) + số tiền phải hoàn TẠI THỜI ĐIỂM xác nhận
   * lần này — LƯU LẠI VĨNH VIỄN trong tin nhắn đã gửi (Admin Demo 2/8, bug đã phát hiện+sửa: "cảnh báo lúc xem
   * trước KHÔNG được biến mất sau khi gửi" — KHÔNG chỉ hiện thoáng qua trong panel xem trước, phải in vào bảng/
   * ảnh ghép gửi đi để xem lại sau này biết rõ giao dịch từng có vấn đề gì). Trạng thái CÓ THỂ khác giá trị
   * tính lại SAU NÀY nếu có thêm lần hoàn tiền khác — đây là ẢNH CHỤP (snapshot) tại thời điểm xác nhận, KHÔNG
   * phải trạng thái sống động.
   */
  amountStatusAtConfirm: RefundAmountStatus;
  amountDiffAtConfirm: number;
  requiredAmountAtConfirm: number;
  /** Đối chiếu "Người nhận" — snapshot tại thời điểm xác nhận (CÙNG lý do amountStatusAtConfirm — cảnh báo
   * PHẢI sống sót sau khi gửi). */
  recipientMatchStatus: RecipientMatchStatus;
  recipientMatchMessage: string;
  /** Lịch sử MỌI lần sửa (Admin Demo 2/8: "ghi lại MỌI lần sửa, không chỉ lần cuối") — rỗng/undefined = CHƯA từng
   * sửa. Append-only, KHÔNG ghi đè. */
  editHistory?: RefundEditHistoryEntry[];
}

interface RawRefundMetadata {
  isRefundImage?: boolean;
  refundAmount?: number;
  refundImageHeightPx?: number;
  refundFields?: RefundReceiptPreview;
  amountStatusAtConfirm?: RefundAmountStatus;
  amountDiffAtConfirm?: number;
  requiredAmountAtConfirm?: number;
  recipientMatchStatus?: RecipientMatchStatus;
  recipientMatchMessage?: string;
  editHistory?: RefundEditHistoryEntry[];
}

/** Chuỗi JSON lưu vào `ChatMessage.metadataJson` lúc gửi/sửa tin nhắn hoàn tiền. */
export function buildRefundMetadataJson(meta: RefundMessageMeta): string {
  const raw: RawRefundMetadata = {
    isRefundImage: true,
    refundAmount: meta.amount,
    refundImageHeightPx: meta.imageHeightPx,
    refundFields: meta.refundFields,
    amountStatusAtConfirm: meta.amountStatusAtConfirm,
    amountDiffAtConfirm: meta.amountDiffAtConfirm,
    requiredAmountAtConfirm: meta.requiredAmountAtConfirm,
    recipientMatchStatus: meta.recipientMatchStatus,
    recipientMatchMessage: meta.recipientMatchMessage,
    editHistory: meta.editHistory
  };
  return JSON.stringify(raw);
}

/** Parse ngược `metadataJson` — trả `null` nếu KHÔNG phải tin nhắn hoàn tiền ĐỦ dữ liệu (CÙNG nguyên tắc
 * `parseBillMetadata()` bill-message-meta.ts — không throw khi JSON hỏng/thiếu field). */
export function parseRefundMetadata(metadataJson: string | null | undefined): RefundMessageMeta | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as RawRefundMetadata;
    if (
      parsed.isRefundImage !== true ||
      typeof parsed.refundAmount !== 'number' ||
      !(parsed.refundAmount > 0) ||
      typeof parsed.refundImageHeightPx !== 'number' ||
      !(parsed.refundImageHeightPx > 0) ||
      !parsed.refundFields ||
      typeof parsed.refundFields !== 'object'
    ) {
      return null;
    }
    return {
      refundFields: parsed.refundFields,
      amount: parsed.refundAmount,
      imageHeightPx: parsed.refundImageHeightPx,
      amountStatusAtConfirm: parsed.amountStatusAtConfirm ?? 'none',
      amountDiffAtConfirm: parsed.amountDiffAtConfirm ?? 0,
      requiredAmountAtConfirm: parsed.requiredAmountAtConfirm ?? 0,
      recipientMatchStatus: parsed.recipientMatchStatus ?? 'unread',
      recipientMatchMessage: parsed.recipientMatchMessage ?? '',
      editHistory: Array.isArray(parsed.editHistory) ? parsed.editHistory : undefined
    };
  } catch {
    return null;
  }
}
