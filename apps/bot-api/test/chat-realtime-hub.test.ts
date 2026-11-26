// SIGMA Phase 3 "real-time" (29/7) — unit test THUẦN cho chat-realtime-hub.ts (Map<roomId,Set<connection>>
// broadcast nội bộ RAM, KHÔNG cần WebSocket/HTTP/DB thật — dùng object giả lập tối thiểu {ws:{send,readyState},
// agentId, sessionId} khớp interface ChatRealtimeConnection). CÙNG khuôn "increment/decrementRoomViewer +
// isAgentViewingRoom (refcount thuần)" ở rc-realtime-proxy.test.ts — test đúng phần THUẦN, không I/O.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  broadcastToRoom,
  getRoomSubscriberCountForTest,
  resetChatRealtimeHubForTest,
  subscribeToRoom,
  unsubscribeAllForConnection,
  unsubscribeFromRoom,
  registerAgentConnection,
  unregisterAgentConnection,
  broadcastToAgent,
  agentHasOpenConnection,
  getAgentConnectionCountForTest,
  type ChatRealtimeConnection
} from '../src/chat-realtime-hub.js';

/** WebSocket giả lập tối thiểu — CHỈ 2 field hub thật sự đọc (`send`/`readyState`, xem broadcastToRoom()).
 * `readyState: 1` === WebSocket.OPEN (hub so sánh literal `1` để tránh import cả class `ws` chỉ để so sánh
 * hằng số, xem chat-realtime-hub.ts). */
function fakeConn(agentId: number, sessionId = `sess-${agentId}`): ChatRealtimeConnection & { sent: string[] } {
  const sent: string[] = [];
  return {
    agentId,
    sessionId,
    sent,
    ws: {
      readyState: 1,
      send: vi.fn((text: string) => sent.push(text))
    }
  } as unknown as ChatRealtimeConnection & { sent: string[] };
}

describe('chat-realtime-hub — subscribe/unsubscribe/broadcast (thuần, không I/O)', () => {
  beforeEach(() => {
    resetChatRealtimeHubForTest();
  });

  it('subscribeToRoom rồi broadcastToRoom → connection nhận đúng payload JSON', () => {
    const conn = fakeConn(1);
    subscribeToRoom('room-a', conn);
    broadcastToRoom('room-a', { msg: 'new-message', roomId: 'room-a', message: { id: 'm1' } });
    expect(conn.sent).toHaveLength(1);
    expect(JSON.parse(conn.sent[0])).toEqual({ msg: 'new-message', roomId: 'room-a', message: { id: 'm1' } });
  });

  it('subscribe 2 lần CÙNG connection/room → idempotent (Set tự loại trùng), broadcast chỉ nhận đúng 1 lần', () => {
    const conn = fakeConn(1);
    subscribeToRoom('room-a', conn);
    subscribeToRoom('room-a', conn);
    expect(getRoomSubscriberCountForTest('room-a')).toBe(1);
    broadcastToRoom('room-a', { msg: 'ping' });
    expect(conn.sent).toHaveLength(1);
  });

  it('broadcast tới phòng KHÔNG ai subscribe → KHÔNG throw, KHÔNG gửi gì', () => {
    expect(() => broadcastToRoom('room-trong', { msg: 'ping' })).not.toThrow();
  });

  it('2 connection CÙNG phòng → cả 2 đều nhận broadcast', () => {
    const connA = fakeConn(1);
    const connB = fakeConn(2);
    subscribeToRoom('room-a', connA);
    subscribeToRoom('room-a', connB);
    broadcastToRoom('room-a', { msg: 'new-message', roomId: 'room-a' });
    expect(connA.sent).toHaveLength(1);
    expect(connB.sent).toHaveLength(1);
  });

  it('unsubscribeFromRoom → connection đó KHÔNG còn nhận broadcast phòng đó, nhưng KHÔNG ảnh hưởng phòng khác', () => {
    const conn = fakeConn(1);
    subscribeToRoom('room-a', conn);
    subscribeToRoom('room-b', conn);
    unsubscribeFromRoom('room-a', conn);
    broadcastToRoom('room-a', { msg: 'ping' });
    broadcastToRoom('room-b', { msg: 'ping' });
    expect(conn.sent).toHaveLength(1); // chỉ room-b tới.
  });

  it('unsubscribeFromRoom cho cặp connection/roomId CHƯA từng subscribe → KHÔNG throw', () => {
    const conn = fakeConn(1);
    expect(() => unsubscribeFromRoom('room-khong-ton-tai', conn)).not.toThrow();
  });

  it('unsubscribeAllForConnection → dọn sạch MỌI phòng của connection đó, các connection khác trong CÙNG phòng KHÔNG bị ảnh hưởng', () => {
    const connA = fakeConn(1);
    const connB = fakeConn(2);
    subscribeToRoom('room-a', connA);
    subscribeToRoom('room-b', connA);
    subscribeToRoom('room-a', connB);

    unsubscribeAllForConnection(connA);
    broadcastToRoom('room-a', { msg: 'ping' });
    broadcastToRoom('room-b', { msg: 'ping' });

    expect(connA.sent).toHaveLength(0);
    expect(connB.sent).toHaveLength(1); // vẫn còn subscribe room-a, KHÔNG bị connA kéo theo.
    expect(getRoomSubscriberCountForTest('room-b')).toBe(0); // room-b hết người → Set rỗng bị dọn khỏi Map.
  });

  it('unsubscribeAllForConnection gọi 2 lần liên tiếp (hoặc cho connection chưa từng subscribe gì) → KHÔNG throw', () => {
    const conn = fakeConn(1);
    subscribeToRoom('room-a', conn);
    unsubscribeAllForConnection(conn);
    expect(() => unsubscribeAllForConnection(conn)).not.toThrow();
    const neverSubscribed = fakeConn(99);
    expect(() => unsubscribeAllForConnection(neverSubscribed)).not.toThrow();
  });

  it('broadcastToRoom với excludeAgentId → loại đúng agent đó (mọi connection của agentId này), KHÔNG loại người khác', () => {
    const senderTabA = fakeConn(1, 'sess-1a');
    const senderTabB = fakeConn(1, 'sess-1b'); // cùng agentId=1, 2 tab/kết nối khác nhau.
    const otherAgent = fakeConn(2);
    subscribeToRoom('room-a', senderTabA);
    subscribeToRoom('room-a', senderTabB);
    subscribeToRoom('room-a', otherAgent);

    broadcastToRoom('room-a', { msg: 'typing-indicator', roomId: 'room-a', agentId: 1, isTyping: true }, { excludeAgentId: 1 });

    expect(senderTabA.sent).toHaveLength(0);
    expect(senderTabB.sent).toHaveLength(0);
    expect(otherAgent.sent).toHaveLength(1);
  });

  it('kết nối đã đóng (readyState !== OPEN) lúc broadcast → tự dọn khỏi Set, KHÔNG throw, connection khác vẫn nhận', () => {
    const deadConn: ChatRealtimeConnection = { agentId: 1, sessionId: 's1', ws: { readyState: 3, send: vi.fn() } } as unknown as ChatRealtimeConnection; // 3 = CLOSED
    const aliveConn = fakeConn(2);
    subscribeToRoom('room-a', deadConn);
    subscribeToRoom('room-a', aliveConn);

    expect(() => broadcastToRoom('room-a', { msg: 'ping' })).not.toThrow();
    expect(aliveConn.sent).toHaveLength(1);
    expect(getRoomSubscriberCountForTest('room-a')).toBe(1); // deadConn đã bị dọn khỏi Set.
  });

  it('ws.send() ném lỗi (connection hỏng giữa chừng) → KHÔNG throw ra ngoài broadcastToRoom, tự dọn khỏi Set', () => {
    const throwingConn: ChatRealtimeConnection = {
      agentId: 1,
      sessionId: 's1',
      ws: {
        readyState: 1,
        send: () => {
          throw new Error('socket hư giữa chừng');
        }
      }
    } as unknown as ChatRealtimeConnection;
    const aliveConn = fakeConn(2);
    subscribeToRoom('room-a', throwingConn);
    subscribeToRoom('room-a', aliveConn);

    expect(() => broadcastToRoom('room-a', { msg: 'ping' })).not.toThrow();
    expect(aliveConn.sent).toHaveLength(1);
    expect(getRoomSubscriberCountForTest('room-a')).toBe(1);
  });

  it('resetChatRealtimeHubForTest() dọn sạch mọi Map giữa các test', () => {
    subscribeToRoom('room-a', fakeConn(1));
    expect(getRoomSubscriberCountForTest('room-a')).toBe(1);
    resetChatRealtimeHubForTest();
    expect(getRoomSubscriberCountForTest('room-a')).toBe(0);
  });
});

// B115-tiếp (2/8) — registry cấp-agent MỚI (registerAgentConnection/unregisterAgentConnection/broadcastToAgent/
// agentHasOpenConnection), SONG SONG roomSubscribers ở trên — CÙNG khuôn test thuần, object giả lập tối thiểu.
describe('chat-realtime-hub — registry cấp-agent (B115-tiếp, thuần, không I/O)', () => {
  beforeEach(() => {
    resetChatRealtimeHubForTest();
  });

  it('registerAgentConnection rồi broadcastToAgent → connection nhận đúng payload, KHÔNG cần subscribe phòng nào', () => {
    const conn = fakeConn(7);
    registerAgentConnection(7, conn);
    broadcastToAgent(7, { msg: 'chat-notify', roomId: 'room-x' });
    expect(conn.sent).toHaveLength(1);
    expect(JSON.parse(conn.sent[0])).toEqual({ msg: 'chat-notify', roomId: 'room-x' });
  });

  it('agentHasOpenConnection: false khi chưa đăng ký/đã unregister, true khi còn ít nhất 1 kết nối', () => {
    const conn = fakeConn(7);
    expect(agentHasOpenConnection(7)).toBe(false);
    registerAgentConnection(7, conn);
    expect(agentHasOpenConnection(7)).toBe(true);
    unregisterAgentConnection(7, conn);
    expect(agentHasOpenConnection(7)).toBe(false);
  });

  it('nhiều tab/thiết bị CÙNG agentId → cả 2 đều nhận broadcastToAgent, unregister 1 cái KHÔNG ảnh hưởng cái còn lại', () => {
    const tabA = fakeConn(7, 'sess-a');
    const tabB = fakeConn(7, 'sess-b');
    registerAgentConnection(7, tabA);
    registerAgentConnection(7, tabB);
    expect(getAgentConnectionCountForTest(7)).toBe(2);

    broadcastToAgent(7, { msg: 'ping' });
    expect(tabA.sent).toHaveLength(1);
    expect(tabB.sent).toHaveLength(1);

    unregisterAgentConnection(7, tabA);
    expect(agentHasOpenConnection(7)).toBe(true); // tabB vẫn còn.
    broadcastToAgent(7, { msg: 'ping-2' });
    expect(tabA.sent).toHaveLength(1); // không nhận thêm.
    expect(tabB.sent).toHaveLength(2);
  });

  it('broadcastToAgent cho agentId KHÔNG có kết nối nào → KHÔNG throw, KHÔNG gửi gì', () => {
    expect(() => broadcastToAgent(999, { msg: 'ping' })).not.toThrow();
  });

  it('broadcastToAgent KHÔNG lẫn giữa các agentId khác nhau (mỗi agent chỉ nhận payload gửi cho chính mình)', () => {
    const connA = fakeConn(1);
    const connB = fakeConn(2);
    registerAgentConnection(1, connA);
    registerAgentConnection(2, connB);
    broadcastToAgent(1, { msg: 'chat-notify', roomId: 'room-a' });
    expect(connA.sent).toHaveLength(1);
    expect(connB.sent).toHaveLength(0);
  });

  it('kết nối đã đóng (readyState !== OPEN) lúc broadcastToAgent → tự dọn khỏi Set, KHÔNG throw', () => {
    const deadConn: ChatRealtimeConnection = { agentId: 1, sessionId: 's1', ws: { readyState: 3, send: vi.fn() } } as unknown as ChatRealtimeConnection;
    registerAgentConnection(1, deadConn);
    expect(() => broadcastToAgent(1, { msg: 'ping' })).not.toThrow();
    expect(agentHasOpenConnection(1)).toBe(false); // đã tự dọn.
  });

  it('unregisterAgentConnection gọi 2 lần liên tiếp (hoặc cho connection chưa từng đăng ký) → KHÔNG throw', () => {
    const conn = fakeConn(1);
    registerAgentConnection(1, conn);
    unregisterAgentConnection(1, conn);
    expect(() => unregisterAgentConnection(1, conn)).not.toThrow();
    expect(() => unregisterAgentConnection(999, fakeConn(999))).not.toThrow();
  });

  it('resetChatRealtimeHubForTest() dọn sạch CẢ registry cấp-agent lẫn roomSubscribers', () => {
    registerAgentConnection(1, fakeConn(1));
    subscribeToRoom('room-a', fakeConn(2));
    resetChatRealtimeHubForTest();
    expect(getAgentConnectionCountForTest(1)).toBe(0);
    expect(getRoomSubscriberCountForTest('room-a')).toBe(0);
  });
});
