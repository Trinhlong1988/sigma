// Trích đoạn ngắn nội dung 1 tin nhắn để hiện trong preview "Trả lời" kiểu Zalo (1/8) — dùng ở CẢ 2 nơi:
// thanh preview phía trên MessageComposer (ConversationScreen.tsx, khi đang soạn trả lời) VÀ khối trích dẫn
// trong chính bong bóng tin trả lời (ChatBubble.tsx, khi tin gốc đã resolve được từ `messages` state). Hàm
// THUẦN (không I/O) — test được không cần dựng cây React, CÙNG pattern voice-message-mapping.test.ts.
//
// Input là UiChatMessage (mock-data/types.ts, KHÁC hẳn shape `ChatRoomLastMessagePreview` mà
// `previewTextForLastMessage()` (chat-client.ts) xử lý — không tái dùng được hàm đó, viết riêng ở đây với
// input rút gọn `Pick<ChatMessage,'type'|'text'>` để không phụ thuộc field không cần.
import type { ChatMessage, ChatMessageType } from '../mock-data/types';

const TYPE_PREVIEW_VI: Partial<Record<ChatMessageType, string>> = {
  image: '[Hình ảnh]',
  file: '[Tệp đính kèm]',
  voice: '[Tin nhắn thoại]',
  location: '[Vị trí]',
  qr: '[Mã QR]',
  system: 'Tin nhắn đã bị xóa'
};

/** Cắt bớt trích đoạn text dài — thanh preview nhỏ (1 dòng), không cần hiện nguyên văn tin dài. */
const REPLY_PREVIEW_MAX_CHARS = 80;

/** Trích đoạn ngắn nội dung 1 tin nhắn cho preview "Trả lời": tin TEXT (hoặc bất kỳ type nào CÓ caption
 * `text`, vd ảnh có chú thích) → nguyên văn/cắt bớt kèm "…" nếu vượt `REPLY_PREVIEW_MAX_CHARS`; tin KHÔNG có
 * `text` (ảnh trơn/file/voice/vị trí/QR/đã xóa) → nhãn ngắn gọn tiếng Việt theo `type` (server không tự sinh
 * caption hiển thị, CÙNG tinh thần `previewTextForLastMessage()` chat-client.ts). `type` lạ/không map được →
 * chuỗi rỗng (KHÔNG throw — đây chỉ là hiển thị phụ, không phải dữ liệu nghiệp vụ bắt buộc). */
export function replyPreviewText(message: Pick<ChatMessage, 'type' | 'text'>): string {
  const text = message.text?.trim();
  if (text) {
    return text.length > REPLY_PREVIEW_MAX_CHARS ? `${text.slice(0, REPLY_PREVIEW_MAX_CHARS)}…` : text;
  }
  return TYPE_PREVIEW_VI[message.type] ?? '';
}
