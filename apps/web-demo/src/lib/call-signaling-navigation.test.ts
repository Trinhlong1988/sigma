// Nợ độ tin cậy đánh thức cuộc gọi (30/7) — test buildIncomingCallNavigation() (call-signaling-client.ts),
// hàm THUẦN dùng bởi AppShell.tsx (global listener 'incoming_call'). Hàm THUẦN (không gọi WebSocket/DOM thật)
// — chạy qua ROOT vitest config (vitest.config.ts include đã thêm file này), CÙNG quy ước "pure-logic test"
// như rc-message-split.test.ts/lunar-calendar.test.ts (repo CHƯA có hạ tầng render component
// @testing-library/react — tách hàm thuần khỏi component là cách test được mà KHÔNG cần dựng cây React thật).
import { describe, expect, it } from 'vitest';
import { buildContactCallNavigation, buildIncomingCallNavigation, buildStartCallNavigation, type CallSignalingMessage } from './call-signaling-client';
import { ROUTES } from '../routes';

describe('buildIncomingCallNavigation', () => {
  it("type 'incoming_call' → trả về path=ROUTES.incomingCall + state ĐẦY ĐỦ callId/callerAgentId/callerName/kind", () => {
    const msg: CallSignalingMessage = {
      type: 'incoming_call',
      callId: 'call-abc-123',
      callerAgentId: 42,
      callerName: 'Trần Thị Hồng',
      kind: 'VOICE'
    };
    expect(buildIncomingCallNavigation(msg)).toEqual({
      path: ROUTES.incomingCall,
      state: { callId: 'call-abc-123', callerAgentId: 42, callerName: 'Trần Thị Hồng', kind: 'VOICE' }
    });
  });

  it("type 'incoming_call' kind VIDEO → giữ nguyên kind trong state (không hardcode)", () => {
    const msg: CallSignalingMessage = {
      type: 'incoming_call',
      callId: 'call-xyz',
      callerAgentId: 7,
      callerName: 'Nguyễn Văn Khôi',
      kind: 'VIDEO'
    };
    const result = buildIncomingCallNavigation(msg);
    expect(result?.state.kind).toBe('VIDEO');
  });

  // Chống double-navigate/double-ring: MỌI message signaling KHÁC (đang trong 1 cuộc gọi khác đã biết callId)
  // PHẢI trả về null — CallScreen/IncomingCallScreen tự lọc các type này theo callId riêng, global listener ở
  // AppShell.tsx KHÔNG được phép điều hướng thêm lần nào cho chúng.
  it.each(['call_ringing', 'call_accepted', 'call_rejected', 'offer', 'answer', 'ice_candidate', 'call_end', 'call_timeout', 'call_answered_elsewhere', 'call_busy', 'call_error'])(
    "type '%s' (KHÔNG PHẢI incoming_call) → null, KHÔNG điều hướng",
    (type) => {
      expect(buildIncomingCallNavigation({ type, callId: 'call-1' })).toBeNull();
    }
  );
});

// fix-call-wiring (31/7) — regression test cho bug "bấm Gọi thoại/Gọi video từ 1 hội thoại THẬT KHÔNG BAO GIỜ
// đổ chuông đối phương" (App.tsx ConversationRoute trước đây chỉ navigate {roomId}, không hề truyền
// calleeAgentId). buildStartCallNavigation() giờ là NƠI DUY NHẤT quyết định path+state khi bấm nút gọi từ
// ConversationScreen.tsx, xem comment hàm đó.
describe('buildStartCallNavigation', () => {
  it('phòng DIRECT + peerAgentId đã resolve → path=ROUTES.call(kind) + state {roomId, calleeAgentId}', () => {
    const result = buildStartCallNavigation('voice', { id: 'room-1', isGroup: false }, 42);
    expect(result).toEqual({ path: ROUTES.call('voice'), state: { roomId: 'room-1', calleeAgentId: 42 } });
  });

  it("kind 'video' → giữ đúng path video (không hardcode voice)", () => {
    const result = buildStartCallNavigation('video', { id: 'room-2', isGroup: false }, 7);
    expect(result?.path).toBe(ROUTES.call('video'));
  });

  it('phòng DIRECT nhưng peerAgentId null (chưa resolve được) → vẫn điều hướng, state KHÔNG có calleeAgentId (CallScreen tự rơi về chế độ xem trước, không throw)', () => {
    const result = buildStartCallNavigation('voice', { id: 'room-3', isGroup: false }, null);
    expect(result).toEqual({ path: ROUTES.call('voice'), state: { roomId: 'room-3' } });
    expect(result?.state).not.toHaveProperty('calleeAgentId');
  });

  it('phòng GROUP → null (KHÔNG điều hướng) dù có peerAgentId — Phase 4 chỉ làm gọi 1-1, không có "gọi nhóm"', () => {
    expect(buildStartCallNavigation('voice', { id: 'room-nhom', isGroup: true }, 42)).toBeNull();
    expect(buildStartCallNavigation('video', { id: 'room-nhom', isGroup: true }, null)).toBeNull();
  });

  // fix-call-name (31/7, B67) — regression test cho bug "gọi 1 người thật (vd 'Hải Nam') nhưng CallScreen hiện
  // sai tên 'Trần Thị Hồng'" — App.tsx CallRoute trước đây tra CHAT_ROOMS (mock tĩnh) bằng roomId, GẦN NHƯ LUÔN
  // miss với phòng DIRECT thật → luôn rơi về CHAT_ROOMS[0]. Fix: thread tên thật qua state.calleeName.
  it('có calleeName → state kèm đúng calleeName (để CallRoute hiện tên thật thay vì tra CHAT_ROOMS mock)', () => {
    const result = buildStartCallNavigation('voice', { id: 'room-dm-hai-nam', isGroup: false }, 42, 'Hải Nam');
    expect(result).toEqual({ path: ROUTES.call('voice'), state: { roomId: 'room-dm-hai-nam', calleeAgentId: 42, calleeName: 'Hải Nam' } });
  });

  it('KHÔNG truyền calleeName → state KHÔNG có field calleeName (undefined, CallRoute tự fallback tên mock, giữ nguyên hành vi cũ)', () => {
    const result = buildStartCallNavigation('voice', { id: 'room-4', isGroup: false }, 42);
    expect(result).toEqual({ path: ROUTES.call('voice'), state: { roomId: 'room-4', calleeAgentId: 42 } });
    expect(result?.state).not.toHaveProperty('calleeName');
  });
});

// fix-contacts-call (31/7) — regression test cho bug "bấm Gọi/Video từ hồ sơ 1 bạn bè trong Danh bạ KHÔNG BAO
// GIỜ đổ chuông đối phương" (App.tsx ContactsRoute.onCall trước đây tra bảng tĩnh AGENT_TO_ROOM chỉ map sẵn 3
// phòng mock 'a1'/'a2'/'a3' — bạn bè thật/mới KHÔNG BAO GIỜ có trong bảng này, luôn rơi về /app/chat; ngay cả
// khi map trúng, navigate cũng KHÔNG kèm calleeAgentId nên CallScreen vẫn rơi "chế độ xem trước" — CÙNG lớp
// bug B59 đã sửa cho ConversationRoute, B59 tự ghi lại "phát hiện phụ chưa sửa" cho đúng chỗ này).
// buildContactCallNavigation() giờ là NƠI DUY NHẤT quyết định path+state khi bấm nút gọi từ ContactsScreen.tsx.
describe('buildContactCallNavigation', () => {
  it('phòng DIRECT thật (từ createOrGetDirectRoom) + peerAgentId ĐÃ BIẾT (agentId người trong Danh bạ) → path=ROUTES.call(kind) + state {roomId, calleeAgentId}', () => {
    const result = buildContactCallNavigation('voice', { id: 'room-dm-99', type: 'DIRECT' }, 99);
    expect(result).toEqual({ path: ROUTES.call('voice'), state: { roomId: 'room-dm-99', calleeAgentId: 99 } });
  });

  it("kind 'video' → giữ đúng path video (không hardcode voice)", () => {
    const result = buildContactCallNavigation('video', { id: 'room-dm-7', type: 'DIRECT' }, 7);
    expect(result?.path).toBe(ROUTES.call('video'));
  });

  it('agentId KHÔNG nằm trong bảng tĩnh AGENT_TO_ROOM cũ (vd 1 friend mới kết bạn, id lớn/lạ) → VẪN điều hướng đúng — chứng minh KHÔNG còn phụ thuộc bảng tĩnh nữa', () => {
    const result = buildContactCallNavigation('voice', { id: 'room-dm-mới', type: 'DIRECT' }, 555);
    expect(result).toEqual({ path: ROUTES.call('voice'), state: { roomId: 'room-dm-mới', calleeAgentId: 555 } });
  });

  it('room.type GROUP (không nên xảy ra với createOrGetDirectRoom, nhưng kiểm tường minh không giả định) → null, KHÔNG điều hướng', () => {
    expect(buildContactCallNavigation('voice', { id: 'room-x', type: 'GROUP' }, 42)).toBeNull();
  });

  // fix-call-name (31/7, B67) — CÙNG regression đã thêm cho buildStartCallNavigation() ở trên, cho entry point
  // Danh bạ (ContactsScreen.tsx truyền profile.nickname ?? profile.agentName làm calleeName).
  it('có calleeName → state kèm đúng calleeName (hiện tên hồ sơ Danh bạ thật thay vì tra CHAT_ROOMS mock)', () => {
    const result = buildContactCallNavigation('video', { id: 'room-dm-99', type: 'DIRECT' }, 99, 'Hải Nam');
    expect(result).toEqual({ path: ROUTES.call('video'), state: { roomId: 'room-dm-99', calleeAgentId: 99, calleeName: 'Hải Nam' } });
  });

  it('KHÔNG truyền calleeName → state KHÔNG có field calleeName (undefined, giữ nguyên hành vi cũ)', () => {
    const result = buildContactCallNavigation('voice', { id: 'room-dm-7', type: 'DIRECT' }, 7);
    expect(result?.state).not.toHaveProperty('calleeName');
  });
});
