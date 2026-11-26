// SIGMA Phase 6 dọn RC-dead-code (30/7) — theo dõi BEST-EFFORT "agent nào đang thực sự MỞ (sub realtime)
// đúng phòng nào" để routes/rc-events.ts có thể BỎ QUA gửi push cho người đã thấy tin nhắn ngay qua kênh
// realtime. Trước đây sống ở rc-realtime-proxy.ts (relay DDP browser⇄Rocket.Chat, file đó ĐÃ XÓA —
// `attachRcRealtimeProxy`/`bridgeToRc` xác nhận zero-caller thật, xem BUGS_FIXED.md mục dọn RC-dead-code) —
// `bridgeToRc` (đã xóa) là nơi DUY NHẤT từng gọi `incrementRoomViewer`/`decrementRoomViewer` lúc runtime, vì
// vậy `activeRoomViewersByKey` từ nay KHÔNG còn đường nào được ghi giá trị nữa (isAgentViewingRoom() sẽ LUÔN
// trả `false`) — đây KHÔNG PHẢI hành vi MỚI do đợt dọn này gây ra: `attachRcRealtimeProxy` vốn đã zero-caller
// từ phía client TRƯỚC KHI đợt dọn này chạy (không ai từng mở kết nối `/v1/rc-realtime-proxy`), nên
// `isAgentViewingRoom` TRÊN THỰC TẾ đã luôn trả `false` trong production từ trước. Dời `isAgentViewingRoom` +
// state phụ trợ sang file trung lập này (KHÔNG xóa) vì `routes/rc-events.ts` (ngoài phạm vi đợt dọn RC Phase
// 6 này — vẫn "armed", nhận webhook RC thật, xem BUGS_FIXED.md) vẫn import nó thật — chỉ dọn code THẬT SỰ
// unreachable (`attachRcRealtimeProxy`/`bridgeToRc`/bộ đếm kết nối đồng thời/`parseRoomTrackingAction`), KHÔNG
// đụng tới quyết định nghiệp vụ "isAgentViewingRoom luôn false" (đó là nợ tiềm ẩn CÓ TRƯỚC đợt dọn này, ngoài
// phạm vi được duyệt — cờ lại cho LEAD ở BUGS_FIXED.md/báo cáo, không tự sửa).
const activeRoomViewersByKey = new Map<string, number>();

function roomViewerKey(agentId: number, roomId: string): string {
  return `${agentId}:${roomId}`;
}

/** Export riêng cho test (refcount thuần, không I/O). */
export function incrementRoomViewer(agentId: number, roomId: string): void {
  const key = roomViewerKey(agentId, roomId);
  activeRoomViewersByKey.set(key, (activeRoomViewersByKey.get(key) ?? 0) + 1);
}

export function decrementRoomViewer(agentId: number, roomId: string): void {
  const key = roomViewerKey(agentId, roomId);
  const cur = activeRoomViewersByKey.get(key);
  if (cur === undefined) return;
  if (cur <= 1) activeRoomViewersByKey.delete(key);
  else activeRoomViewersByKey.set(key, cur - 1);
}

/** Agent CÓ đang mở đúng phòng này trên ÍT NHẤT 1 kết nối realtime đang sống không — dùng để bỏ qua gửi push
 * trùng lặp khi người dùng đã thấy tin nhắn NGAY qua kênh realtime. Xem push-notification-service.ts/
 * routes/rc-events.ts. */
export function isAgentViewingRoom(agentId: number, roomId: string): boolean {
  return activeRoomViewersByKey.has(roomViewerKey(agentId, roomId));
}

/** Cho test dọn sạch state giữa các case (đếm trong RAM, không tự reset qua module boundary của vitest). */
export function resetRoomViewerTrackingForTest(): void {
  activeRoomViewersByKey.clear();
}
