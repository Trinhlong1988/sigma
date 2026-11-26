// Định vị menu ngữ cảnh (chuột-phải desktop / long-press mobile ở ChatBubble.tsx) theo BUBBLE tin nhắn được
// nhấn giữ — kiểu Zalo (Admin Demo yêu cầu 1/8, kèm ảnh tham chiếu): menu bám sát bubble thay vì tọa độ con
// trỏ/ngón tay thô.
//
// Thay thế luôn cho BUG vị trí menu (Admin Demo báo thật kèm ảnh chụp màn hình 1/8): `handleTouchStart()` cũ ở
// ChatBubble.tsx cast `TouchEvent` thành `React.MouseEvent` rồi đọc `e.clientX`/`e.clientY` — 2 field đó
// KHÔNG tồn tại trên `TouchEvent` (chỉ có trên `e.touches[0]`) nên luôn `undefined` → CSS
// `left`/`top` nhận giá trị invalid → trình duyệt bỏ qua → menu rơi về vị trí "static" trong DOM flow (đè
// lên khung nhập tin) thay vì cạnh tin nhắn. Thay vì chỉ vá lại việc đọc tọa độ ngón tay (`e.touches[0]`),
// module này loại bỏ HẲN việc dùng tọa độ con trỏ/ngón tay cho vị trí menu — CẢ 2 đường (chuột-phải VÀ
// long-press) đều tự đọc `getBoundingClientRect()` của bubble qua ref (xem ChatBubble.tsx) rồi gọi hàm THUẦN
// dưới đây, nên bug "tọa độ cast sai kiểu" không còn đường nào để tái phát (không còn chỗ nào đọc
// clientX/clientY của sự kiện chạm/chuột nữa).
//
// Hàm THUẦN (không I/O) — test được không cần dựng cây React, CÙNG pattern voice-message-mapping.test.ts/
// ocr-preview-ui.test.ts.
export interface ContextMenuAnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface ComputeContextMenuPositionInput {
  /** `getBoundingClientRect()` của bubble tin nhắn tại thời điểm mở menu. */
  bubbleRect: ContextMenuAnchorRect;
  viewportWidth: number;
  viewportHeight: number;
  /** Kích thước ước lượng của menu (ConversationScreen.tsx tự tính theo số mục đang hiện — Reply/Chuyển
   * tiếp/Copy/Thu hồi thay đổi tùy tin nhắn, xem comment ở đó) — module này KHÔNG đo DOM thật (tránh 2-pass
   * render/flicker), chỉ nhận số ước lượng từ caller. */
  menuWidth: number;
  menuHeight: number;
}

export interface ContextMenuPosition {
  left: number;
  top: number;
}

/** Khoảng cách tối thiểu tới mép màn hình — tránh menu dính sát cạnh không còn khoảng thở. */
const VIEWPORT_MARGIN = 8;
/** Khoảng cách giữa menu và bubble (phía trên hoặc phía dưới, tùy `openAbove`). */
const BUBBLE_GAP = 6;

/** Clamp `value` vào [min, max]. Nếu `max < min` (viewport nhỏ hơn menu — hiếm, màn hình cực hẹp/thấp) trả
 * về `min` (ưu tiên mép trên/trái, chấp nhận menu tràn nhẹ mép còn lại thay vì layout âm/vỡ hẳn). */
function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/** Tính `{left, top}` cho menu `position:fixed`, neo theo bubble + clamp trong viewport:
 * - Dọc: bubble nằm nửa DƯỚI màn hình (điểm giữa `bubbleRect` > `viewportHeight/2`) → menu mở LÊN TRÊN bubble
 *   (tránh tràn xuống mép dưới/bị che bởi composer); nửa TRÊN → mở XUỐNG DƯỚI bubble. Luôn clamp lại trong
 *   `[VIEWPORT_MARGIN, viewportHeight - menuHeight - VIEWPORT_MARGIN]` để không tràn mép trên/dưới dù bubble
 *   nằm sát mép.
 * - Ngang: mặc định căn theo mép trái bubble (`bubbleRect.left`), clamp trong
 *   `[VIEWPORT_MARGIN, viewportWidth - menuWidth - VIEWPORT_MARGIN]` — bubble "mine" (căn phải, gần mép phải
 *   màn hình hẹp) và bubble người khác (căn trái, gần mép trái) đều không bị tràn ra ngoài viewport. */
export function computeContextMenuPosition(input: ComputeContextMenuPositionInput): ContextMenuPosition {
  const { bubbleRect, viewportWidth, viewportHeight, menuWidth, menuHeight } = input;
  const bubbleMidY = (bubbleRect.top + bubbleRect.bottom) / 2;
  const openAbove = bubbleMidY > viewportHeight / 2;
  const rawTop = openAbove ? bubbleRect.top - menuHeight - BUBBLE_GAP : bubbleRect.bottom + BUBBLE_GAP;
  const top = clamp(rawTop, VIEWPORT_MARGIN, viewportHeight - menuHeight - VIEWPORT_MARGIN);
  const left = clamp(bubbleRect.left, VIEWPORT_MARGIN, viewportWidth - menuWidth - VIEWPORT_MARGIN);
  return { left, top };
}
