// SIGMA PRESENCE (6/8, Admin Demo chốt CẢ 1+2) — unit test THUẦN cho presence-service.ts: throttle FCM-ping-on-
// view (shouldSendPresencePing/planPresencePings) + payload broadcastPresenceUpdate kèm lastSeenAt. KHÔNG cần DB
// thật: collectPresenceAudience dùng db duck-typed (stub findMany), broadcastToAgent bắt qua conn giả lập.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  planPresencePings,
  shouldSendPresencePing,
  resetPresencePingThrottleForTest,
  broadcastPresenceUpdate
} from '../src/presence-service.js';
import { registerAgentConnection, resetChatRealtimeHubForTest, type ChatRealtimeConnection } from '../src/chat-realtime-hub.js';
import type { Db } from '@sigma/database';

function fakeConn(agentId: number): ChatRealtimeConnection & { sent: string[] } {
  const sent: string[] = [];
  return { agentId, sessionId: `s-${agentId}`, sent, ws: { readyState: 1, send: (t: string) => sent.push(t) } } as unknown as ChatRealtimeConnection & { sent: string[] };
}

/** db duck-typed tối thiểu cho collectPresenceAudience: friendRequest.findMany + chatRoomMember.findMany. */
function fakeDb(friends: Array<{ fromAgentId: number; toAgentId: number }>, myRooms: Array<{ roomId: string }> = [], coMembers: Array<{ agentId: number }> = []): Db {
  return {
    friendRequest: { findMany: vi.fn().mockResolvedValue(friends) },
    chatRoomMember: {
      findMany: vi
        .fn()
        // lần 1 = myRooms (theo agentId), lần 2 = coMembers (theo roomId in).
        .mockResolvedValueOnce(myRooms)
        .mockResolvedValueOnce(coMembers)
    }
  } as unknown as Db;
}

describe('presence-service — FCM-ping-on-view throttle + plan', () => {
  beforeEach(() => {
    resetPresencePingThrottleForTest();
    resetChatRealtimeHubForTest();
  });

  it('shouldSendPresencePing: lần đầu true; lần 2 trong 30s bị chặn; sau đúng 30s cho lại', () => {
    expect(shouldSendPresencePing(1, 0)).toBe(true);
    expect(shouldSendPresencePing(1, 10_000)).toBe(false);
    expect(shouldSendPresencePing(1, 29_999)).toBe(false);
    expect(shouldSendPresencePing(1, 30_000)).toBe(true); // đúng mép ngưỡng → cho ping lại.
  });

  it('planPresencePings: BỎ target đang có WS (không cần đánh thức) + throttle + dedupe input', () => {
    const hasWs = (id: number): boolean => id === 2; // agent 2 đang có WS sống.
    const targets = planPresencePings([1, 2, 3, 3], hasWs, 0);
    expect([...targets].sort((a, b) => a - b)).toEqual([1, 3]); // 2 loại (WS), 3 dedupe.
    // Gọi lại NGAY (trong 30s) → 1,3 đã throttle → không ping ai.
    expect(planPresencePings([1, 3], hasWs, 5_000)).toEqual([]);
    // Sau 30s kể từ mốc ghi (0) → cho ping lại.
    expect(planPresencePings([1, 3], hasWs, 30_000).sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('broadcastPresenceUpdate offline → payload kèm lastSeenAt (mốc "vừa xong")', async () => {
    const audience = fakeConn(99);
    registerAgentConnection(99, audience);
    await broadcastPresenceUpdate(fakeDb([{ fromAgentId: 7, toAgentId: 99 }]), 7, false, { nowIso: '2026-08-06T00:00:00.000Z' });
    expect(audience.sent).toHaveLength(1);
    expect(JSON.parse(audience.sent[0])).toMatchObject({
      msg: 'presence-update',
      agentId: 7,
      online: false,
      at: '2026-08-06T00:00:00.000Z',
      lastSeenAt: '2026-08-06T00:00:00.000Z'
    });
  });

  it('broadcastPresenceUpdate online → lastSeenAt=null (client bỏ qua khi đang online)', async () => {
    const audience = fakeConn(99);
    registerAgentConnection(99, audience);
    await broadcastPresenceUpdate(fakeDb([{ fromAgentId: 7, toAgentId: 99 }]), 7, true, { nowIso: '2026-08-06T00:00:00.000Z' });
    const payload = JSON.parse(audience.sent[0]);
    expect(payload.online).toBe(true);
    expect(payload.lastSeenAt).toBeNull();
  });
});
