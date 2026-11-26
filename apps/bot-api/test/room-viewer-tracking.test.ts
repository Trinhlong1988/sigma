// SIGMA Phase 6 dọn RC-dead-code (30/7) — test room-viewer-tracking.ts (refcount thuần, không I/O). Dời
// NGUYÊN VẸN từ test/rc-realtime-proxy.test.ts (file đó ĐÃ XÓA cùng src/rc-realtime-proxy.ts — xem
// BUGS_FIXED.md mục dọn RC-dead-code). `isAgentViewingRoom` VẪN LÀ CODE SỐNG THẬT (dùng bởi routes/
// rc-events.ts), chỉ đổi nơi ở — riêng `incrementRoomViewer`/`decrementRoomViewer` từ nay KHÔNG còn caller nào
// lúc runtime nữa (sole caller cũ `bridgeToRc`/rc-realtime-proxy.ts ĐÃ XÓA vì zero-caller từ phía client), nên
// `isAgentViewingRoom` trên thực tế sẽ LUÔN trả `false` trong production — nợ tiềm ẩn CÓ TRƯỚC đợt dọn này
// (attachRcRealtimeProxy vốn đã zero-caller từ client từ trước), ngoài phạm vi đợt dọn — xem ghi chú đầu
// src/room-viewer-tracking.ts + báo cáo LEAD. Test dưới đây VẪN giữ nguyên giá trị: xác nhận đúng hành vi
// refcount THUẦN của module (nếu tương lai có nguồn khác gọi increment/decrement lại, logic vẫn đúng).
import { beforeEach, describe, expect, it } from 'vitest';
import {
  decrementRoomViewer,
  incrementRoomViewer,
  isAgentViewingRoom,
  resetRoomViewerTrackingForTest
} from '../src/room-viewer-tracking.js';

describe('increment/decrementRoomViewer + isAgentViewingRoom (refcount thuần)', () => {
  beforeEach(() => {
    resetRoomViewerTrackingForTest();
  });

  it('chưa increment bao giờ → isAgentViewingRoom false', () => {
    expect(isAgentViewingRoom(1, 'room-x')).toBe(false);
  });

  it('increment 1 lần → true; decrement 1 lần → false lại (đúng đời sống 1 kết nối sub/unsub)', () => {
    incrementRoomViewer(1, 'room-x');
    expect(isAgentViewingRoom(1, 'room-x')).toBe(true);
    decrementRoomViewer(1, 'room-x');
    expect(isAgentViewingRoom(1, 'room-x')).toBe(false);
  });

  it('2 kết nối CÙNG agent+room (2 tab) → increment 2 lần, decrement 1 lần vẫn còn true (tab kia vẫn đang xem)', () => {
    incrementRoomViewer(1, 'room-x');
    incrementRoomViewer(1, 'room-x');
    decrementRoomViewer(1, 'room-x');
    expect(isAgentViewingRoom(1, 'room-x')).toBe(true);
    decrementRoomViewer(1, 'room-x');
    expect(isAgentViewingRoom(1, 'room-x')).toBe(false);
  });

  it('decrement key chưa từng increment → KHÔNG throw, KHÔNG tạo count âm', () => {
    expect(() => decrementRoomViewer(99, 'room-khong-ton-tai')).not.toThrow();
    expect(isAgentViewingRoom(99, 'room-khong-ton-tai')).toBe(false);
  });

  it('agentId/roomId KHÁC nhau → độc lập hoàn toàn, KHÔNG lẫn nhau', () => {
    incrementRoomViewer(1, 'room-x');
    expect(isAgentViewingRoom(2, 'room-x')).toBe(false);
    expect(isAgentViewingRoom(1, 'room-y')).toBe(false);
  });
});
