// B112 (2/8, Admin Demo "bill sau khi đã gửi chưa có nút sửa?") — metadata bill ĐẦY ĐỦ lưu trong
// `ChatMessage.metadataJson` lúc gửi ẢNH BILL đã ghép bảng (`composeBillImage()`, bill-table-image.ts). B106
// (2/8, TRƯỚC B112) chỉ lưu `{isBillImage:true}` — ĐỦ để ChatBubble.tsx chọn khung hiển thị rộng-không-crop,
// nhưng KHÔNG ĐỦ dữ liệu để "Sửa" lại sau khi gửi (không có billFields OCR gốc để hiện lại bảng, không có số
// tiền đã xác nhận, không có ranh giới ảnh-bill/bảng trong ảnh ghép để cắt lại ảnh gốc). Module này là NGUỒN
// DUY NHẤT build/parse metadataJson bill — CẢ lúc gửi lần đầu (ConversationScreen.tsx sendAttachment()) LẪN
// lúc sửa (EditBillMessageModal.tsx) đều gọi qua đây, tránh lệch field 2 nơi (đúng bài học B106 retro "sửa 1
// nơi quên nơi khác").
//
// Backend mirror THỦ CÔNG (apps/bot-api/src/services/chat-message-service.ts editMessage(), field
// `isBillImage`/`billAmount` PHẢI khớp CHÍNH XÁC tên field ở đây — đổi 1 bên phải đổi bên kia tay, CÙNG quy ước
// OcrBillPreview/MyLoViolation đã áp dụng cho mọi type mirror khác trong file agent-api-client.ts).
import type { OcrBillPreview } from './agent-api-client';

/** B123 (2/8, tính năng "Hoàn tiền" MỚI, Admin Demo chốt bổ sung: "mọi lần sửa PHẢI ghi lại ai/lúc nào") — CÙNG
 * shape `RefundEditHistoryEntry` (refund-message-meta.ts), lặp lại ở đây (KHÔNG import chéo 2 module lib cùng
 * cấp — giữ 2 metadata bill/hoàn tiền độc lập nhau, tránh phụ thuộc vòng nếu 1 trong 2 đổi cấu trúc sau này). */
export interface BillEditHistoryEntry {
  editedByAgentId: number;
  editedByName: string;
  editedAt: string; // ISO
}

export interface BillMessageMeta {
  /** 6 trường OCR gốc (bank/tên HKD/TID/ngày giờ/số lô/số hóa đơn) + cảnh báo rủi ro đóng lô — lưu NGUYÊN VĂN
   * từ lúc quét lần đầu, để "Sửa" KHÔNG cần chạy lại OCR (đúng yêu cầu tường minh). */
  billFields: OcrBillPreview;
  /** Số tiền ĐÃ XÁC NHẬN (người dùng gõ/sửa tay trong OcrBillPreview, KHÔNG nhất thiết = billFields.parsedAmount
   * gốc OCR) — dùng làm giá trị khởi tạo ô "Số tiền" lúc mở panel "Sửa". */
  amount: number;
  /** Chiều cao PHYSICAL PIXEL (đã nhân SCALE=2, xem bill-table-image.ts) của phần ẢNH BILL GỐC (không tính
   * bảng) trong ảnh ghép cuối cùng đã gửi — `composeBillImage()` trả kèm giá trị này. Lúc "Sửa", giá trị này
   * cho biết CHÍNH XÁC ranh giới bill/bảng trong ảnh ghép hiện có để cắt lại đúng phần ảnh bill (KHÔNG lẫn
   * bảng cũ), xem `cropTopOfImage()` bill-table-image.ts — KHÔNG suy luận lại từ ảnh (bảng có thể đổi số hàng
   * giữa 2 lần gửi/sửa nếu billFields khác, con số PHẢI chốt từ đúng lúc ghép). */
  imageHeightPx: number;
  /** (21/8) — LOẠI THẺ đã chọn lúc gửi (Admin Demo "thêm tùy chọn thẻ kèm giá bán"). Lưu để mở "Sửa" khôi phục ĐÚNG
   * thẻ gốc → dòng "Hoàn tiền" không bị reset về Visa-Master mặc định (lệch giá thực tế giao dịch gốc). undefined =
   * bill cũ trước tính năng này (Sửa sẽ rơi về mặc định — chấp nhận, không có dữ liệu thẻ để khôi phục). */
  cardTypeId?: number;
  /** B123 (2/8) — lịch sử MỌI lần sửa (append-only, KHÔNG ghi đè) — rỗng/undefined = chưa từng sửa. */
  editHistory?: BillEditHistoryEntry[];
}

interface RawBillMetadata {
  isBillImage?: boolean;
  billAmount?: number;
  billImageHeightPx?: number;
  billFields?: OcrBillPreview;
  billCardTypeId?: number;
  editHistory?: BillEditHistoryEntry[];
}

/** Chuỗi JSON lưu vào `ChatMessage.metadataJson` lúc gửi/sửa ảnh bill. */
export function buildBillMetadataJson(meta: BillMessageMeta): string {
  const raw: RawBillMetadata = {
    isBillImage: true,
    billAmount: meta.amount,
    billImageHeightPx: meta.imageHeightPx,
    billFields: meta.billFields,
    billCardTypeId: meta.cardTypeId,
    editHistory: meta.editHistory
  };
  return JSON.stringify(raw);
}

/** Parse ngược `metadataJson` — trả `null` nếu KHÔNG phải bill đã ghép ĐỦ dữ liệu để sửa (bill gửi qua nhánh
 * fallback ảnh gốc chưa ghép — cực hiếm, xem `hasAnyExtendedFieldRead()` OcrBillPreview.tsx — chỉ có
 * `{isBillImage:true}` kiểu B106 cũ, KHÔNG đủ field mới) — nút "Sửa" KHÔNG hiện trong trường hợp đó (xem
 * `canEditBillMessage()` chat-client.ts). KHÔNG throw khi JSON hỏng/thiếu field, CÙNG nguyên tắc mọi nhánh
 * parse hiển thị phụ khác trong `mapChatMessage()` (chat-client.ts) — đây không phải check bảo mật bắt buộc. */
export function parseBillMetadata(metadataJson: string | null | undefined): BillMessageMeta | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as RawBillMetadata;
    if (
      parsed.isBillImage !== true ||
      typeof parsed.billAmount !== 'number' ||
      !(parsed.billAmount > 0) ||
      typeof parsed.billImageHeightPx !== 'number' ||
      !(parsed.billImageHeightPx > 0) ||
      !parsed.billFields ||
      typeof parsed.billFields !== 'object'
    ) {
      return null;
    }
    return {
      billFields: parsed.billFields,
      amount: parsed.billAmount,
      imageHeightPx: parsed.billImageHeightPx,
      cardTypeId: typeof parsed.billCardTypeId === 'number' && parsed.billCardTypeId > 0 ? parsed.billCardTypeId : undefined,
      editHistory: Array.isArray(parsed.editHistory) ? parsed.editHistory : undefined
    };
  } catch {
    return null;
  }
}
