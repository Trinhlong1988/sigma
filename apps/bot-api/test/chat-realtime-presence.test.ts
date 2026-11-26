// SIGMA PRESENCE (6/8, Admin Demo: online = "còn đăng nhập + thiết bị còn kết nối được", KHÔNG phải "app đang
// mở") — unit test THUẦN cho agentPresenceOnline() + markAgentSeen/markAgentOffline (chat-realtime-hub.ts). Map
// in-RAM, KHÔNG cần WebSocket/HTTP/DB thật (dùng conn giả lập tối thiểu như chat-realtime-hub.test.ts). Tiêm mốc
// thời gian tất định qua tham số nowEpochMs/atEpochMs (KHÔNG dùng Date.now() thật để test cửa sổ grace ổn định).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentPresenceOnline,
  markAgentSeen,
  markAgentOffline,
  getAgentLastSeen,
  registerAgentConnection,
  unregisterAgentConnection,
  resetChatRealtimeHubForTest,
  setPresenceGraceOfflineHandler,
  PRESENCE_STALE_MS,
  PRESENCE_HEARTBEAT_TTL_MS,
  type ChatRealtimeConnection
} from '../src/chat-realtime-hub.js';

function fakeConn(agentId: number, sessionId = `sess-${agentId}`): ChatRealtimeConnection {
  return {
    agentId,
    sessionId,
    ws: { readyState: 1, send: vi.fn() }
  } as unknown as ChatRealtimeConnection;
}

describe('agentPresenceOnline — nguồn presence "WS sống HOẶC nhịp sống gần đây"', () => {
  beforeEach(() => {
    resetChatRealtimeHubForTest();
  });

  it('WS đang mở → online=true (bất kể lastSeen)', () => {
    const agentId = 101;
    expect(agentPresenceOnline(agentId)).toBe(false); // chưa có gì → offline.
    registerAgentConnection(agentId, fakeConn(agentId));
    expect(agentPresenceOnline(agentId)).toBe(true);
  });

  it('KHÔNG WS + nhịp heartbeat MỚI (trong cửa sổ TTL heartbeat) → online=true', () => {
    const agentId = 102;
    const t0 = 1_000_000;
    markAgentSeen(agentId, t0);
    // FIX 11/8: nguồn heartbeat REST dùng PRESENCE_HEARTBEAT_TTL_MS (40s), KHÔNG còn bị cửa sổ grace WS 10s rút
    // ngắn. Nửa cửa sổ + sát mép trong ngưỡng → vẫn online.
    expect(agentPresenceOnline(agentId, t0 + PRESENCE_HEARTBEAT_TTL_MS / 2)).toBe(true);
    expect(agentPresenceOnline(agentId, t0 + PRESENCE_HEARTBEAT_TTL_MS - 1)).toBe(true);
  });

  it('KHÔNG WS + nhịp heartbeat CŨ hơn TTL → offline=false (mép TTL heartbeat, KHÔNG phải grace WS 10s)', () => {
    const agentId = 103;
    const t0 = 2_000_000;
    markAgentSeen(agentId, t0);
    // FIX 11/8 (đây chính là hồi quy chống tái diễn bug): TRƯỚC vá agent bị offline từ mốc PRESENCE_STALE_MS=10s
    // (vì heartbeat dùng chung cửa sổ 10s) → nháy offline giữa 2 nhịp ping 45s. SAU vá vẫn ONLINE tới sát 40s.
    expect(agentPresenceOnline(agentId, t0 + PRESENCE_STALE_MS)).toBe(true); // 10s: TRƯỚC vá = false (bug), SAU = true.
    expect(agentPresenceOnline(agentId, t0 + PRESENCE_HEARTBEAT_TTL_MS - 1)).toBe(true); // sát mép 40s vẫn online.
    // đúng mép ngưỡng TTL (now - hb === TTL) → KHÔNG còn "< ngưỡng" → offline.
    expect(agentPresenceOnline(agentId, t0 + PRESENCE_HEARTBEAT_TTL_MS)).toBe(false);
    expect(agentPresenceOnline(agentId, t0 + PRESENCE_HEARTBEAT_TTL_MS + 5_000)).toBe(false);
  });

  it('đã logout (markAgentOffline) + KHÔNG WS → offline=false NGAY (không chờ ngưỡng)', () => {
    const agentId = 104;
    const t0 = 3_000_000;
    markAgentSeen(agentId, t0);
    expect(agentPresenceOnline(agentId, t0 + 5_000)).toBe(true); // đang online...
    markAgentOffline(agentId);
    expect(agentPresenceOnline(agentId, t0 + 5_000)).toBe(false); // ...offline tức thì sau markAgentOffline.
  });

  it('logout nhưng CÒN WS khác đang mở → vẫn online (WS thắng)', () => {
    const agentId = 105;
    registerAgentConnection(agentId, fakeConn(agentId));
    markAgentSeen(agentId, 4_000_000);
    markAgentOffline(agentId); // xóa nhịp sống...
    expect(agentPresenceOnline(agentId, 4_000_000)).toBe(true); // ...nhưng WS còn → online.
    unregisterAgentConnection(agentId, fakeConn(agentId)); // conn KHÁC object → KHÔNG gỡ được cái đã đăng ký
    // (giống hành vi Set theo tham chiếu) — chứng minh registry theo object; vẫn còn 1 kết nối → online.
    expect(agentPresenceOnline(agentId, 4_000_000)).toBe(true);
  });

  it('reset dọn sạch lastSeen giữa các case', () => {
    const agentId = 106;
    markAgentSeen(agentId, 5_000_000);
    resetChatRealtimeHubForTest();
    expect(agentPresenceOnline(agentId, 5_000_000)).toBe(false);
  });

  it('getAgentLastSeen: trả mốc markAgentSeen; null nếu chưa từng thấy hoặc đã markAgentOffline', () => {
    const agentId = 107;
    expect(getAgentLastSeen(agentId)).toBeNull(); // chưa từng thấy.
    markAgentSeen(agentId, 123_456);
    expect(getAgentLastSeen(agentId)).toBe(123_456);
    markAgentOffline(agentId); // đăng xuất/mất mạng chủ động → xóa.
    expect(getAgentLastSeen(agentId)).toBeNull();
  });
});

// GRACE-TIMER WS-close (6/8, phương án 1 Admin Demo) — WS đóng KHÔNG offline ngay mà chờ grace 10s; đồng bộ 2 hướng
// (người đang xem qua timer + người mới mở qua agentPresenceOnline dùng CHUNG PRESENCE_STALE_MS). Dùng fake timers.
describe('grace-timer WS-close — đồng bộ online 10s rồi offline', () => {
  let offlineCalls: Array<{ agentId: number; closedAtMs: number }>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetChatRealtimeHubForTest();
    offlineCalls = [];
    setPresenceGraceOfflineHandler((agentId, closedAtMs) => offlineCalls.push({ agentId, closedAtMs }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('WS đóng → trong 10s vẫn online + CHƯA phát offline; sau 10s không reconnect → phát offline ĐÚNG 1 lần + offline', () => {
    const agentId = 300;
    const conn = fakeConn(agentId);
    registerAgentConnection(agentId, conn);
    expect(agentPresenceOnline(agentId)).toBe(true);

    unregisterAgentConnection(agentId, conn); // WS CUỐI đóng → hẹn grace 10s (KHÔNG offline ngay).
    vi.advanceTimersByTime(PRESENCE_STALE_MS - 1);
    expect(agentPresenceOnline(agentId)).toBe(true); // vẫn online trong grace (đồng bộ với người mới mở).
    expect(offlineCalls).toEqual([]); // CHƯA phát offline.

    vi.advanceTimersByTime(1); // đủ 10s.
    expect(offlineCalls).toHaveLength(1);
    expect(offlineCalls[0].agentId).toBe(agentId);
    expect(agentPresenceOnline(agentId)).toBe(false); // offline, KHỚP với thời điểm phát.
  });

  it('reconnect trong 10s → HỦY grace timer, KHÔNG phát offline', () => {
    const agentId = 301;
    const conn1 = fakeConn(agentId);
    registerAgentConnection(agentId, conn1);
    unregisterAgentConnection(agentId, conn1); // hẹn grace.
    vi.advanceTimersByTime(5_000);
    registerAgentConnection(agentId, fakeConn(agentId)); // reconnect → hủy timer.
    vi.advanceTimersByTime(PRESENCE_STALE_MS * 2);
    expect(offlineCalls).toEqual([]); // KHÔNG bao giờ offline.
    expect(agentPresenceOnline(agentId)).toBe(true); // có WS.
  });

  it('POST /offline (markAgentOffline) → offline NGAY bỏ grace + hủy timer (không double-broadcast)', () => {
    const agentId = 302;
    const conn = fakeConn(agentId);
    registerAgentConnection(agentId, conn);
    unregisterAgentConnection(agentId, conn); // hẹn grace.
    markAgentOffline(agentId); // offline tường minh → hủy grace, đi ngay.
    expect(agentPresenceOnline(agentId)).toBe(false); // offline NGAY (không chờ 10s).
    vi.advanceTimersByTime(PRESENCE_STALE_MS * 2);
    expect(offlineCalls).toEqual([]); // grace timer đã hủy → KHÔNG phát offline lần nữa.
  });

  it('đa thiết bị: đóng 1 trong 2 WS → KHÔNG hẹn grace (còn WS khác)', () => {
    const agentId = 303;
    const c1 = fakeConn(agentId);
    const c2 = fakeConn(agentId);
    registerAgentConnection(agentId, c1);
    registerAgentConnection(agentId, c2);
    unregisterAgentConnection(agentId, c1); // còn c2 → chưa phải WS cuối.
    vi.advanceTimersByTime(PRESENCE_STALE_MS * 2);
    expect(offlineCalls).toEqual([]);
    expect(agentPresenceOnline(agentId)).toBe(true);
  });

  it('đua logout: markAgentOffline TRƯỚC khi WS-close → WS-close KHÔNG re-online/hẹn lại grace', () => {
    const agentId = 304;
    const conn = fakeConn(agentId);
    registerAgentConnection(agentId, conn);
    markAgentOffline(agentId); // /offline tới TRƯỚC (WS còn mở).
    unregisterAgentConnection(agentId, conn); // rồi WS mới đóng.
    expect(agentPresenceOnline(agentId)).toBe(false); // vẫn offline (cờ chống đua).
    vi.advanceTimersByTime(PRESENCE_STALE_MS * 2);
    expect(offlineCalls).toEqual([]); // KHÔNG hẹn grace mới → không phát offline lần 2.
  });
});

// FIX PRESENCE 11/8 — HỒI QUY chống tái diễn bug "thiết bị mở app không giữ WS thường trực (APK nền) bị nháy
// offline". Tách 2 cửa sổ độc lập: heartbeat REST 40s (PRESENCE_HEARTBEAT_TTL_MS) vs grace WS-close 10s
// (PRESENCE_STALE_MS). Dùng HÀM HUB THẬT + tiêm mốc thời gian tất định (KHÔNG mock, KHÔNG suy luận).
describe('FIX presence — heartbeat REST 40s độc lập với grace WS-close 10s', () => {
  // Fake timers + setSystemTime để mốc WS-close (unregisterAgentConnection dùng Date.now() nội bộ cho closedAtMs)
  // KHỚP với mốc nowEpochMs tiêm vào agentPresenceOnline — nếu không, 2 đồng hồ lệch (giả t0 vs real ~1.7e12).
  beforeEach(() => {
    vi.useFakeTimers();
    resetChatRealtimeHubForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('A ping t=0, B đọc A ở t=0/9999/10000/20000/39999/40000/44000 — online SUỐT tới sát 40s rồi offline', () => {
    const A = 501;
    const t0 = 10_000_000;
    markAgentSeen(A, t0); // A gửi POST /v1/presence/ping tại t=0 (KHÔNG có WS thường trực — APK nền).

    // B (account khác) đọc trạng thái A qua CÙNG hàm agentPresenceOnline mà friend-service/chat routes dùng.
    expect(agentPresenceOnline(A, t0 + 0)).toBe(true);
    // t=9999/10000: TRƯỚC vá B thấy offline từ 10s (bug: heartbeat dùng chung cửa sổ 10s). SAU vá vẫn online.
    expect(agentPresenceOnline(A, t0 + 9_999)).toBe(true);
    expect(agentPresenceOnline(A, t0 + 10_000)).toBe(true); // mốc bug cũ — nay ONLINE.
    expect(agentPresenceOnline(A, t0 + 20_000)).toBe(true);
    expect(agentPresenceOnline(A, t0 + (PRESENCE_HEARTBEAT_TTL_MS - 1))).toBe(true); // 39999: sát mép còn online.
    expect(agentPresenceOnline(A, t0 + PRESENCE_HEARTBEAT_TTL_MS)).toBe(false); // 40000: hết TTL → offline.
    expect(agentPresenceOnline(A, t0 + 44_000)).toBe(false);
  });

  it('BẤT BIẾN 2×ping ≤ TTL: rớt ĐÚNG 1 nhịp (ping 15s → nhịp kế 30s) KHÔNG nháy offline', () => {
    const A = 502;
    const t0 = 20_000_000;
    const PING = 15_000; // = PRESENCE_PING_INTERVAL_MS phía client (web-demo).
    markAgentSeen(A, t0); // nhịp 1.
    // nhịp 2 tại t0+15s bị RỚT (OS bóp timer nền / mất gói). Nhịp thật kế tiếp mãi t0+30s.
    // Trong toàn khoảng [0, 30s) B đọc A: now − hb ≤ 30s < 40s → LUÔN online (không có mốc nào offline).
    for (const dt of [0, PING - 1, PING, 2 * PING - 1]) {
      expect(agentPresenceOnline(A, t0 + dt)).toBe(true);
    }
    markAgentSeen(A, t0 + 2 * PING); // nhịp thật t0+30s → cửa sổ tươi lại.
    expect(agentPresenceOnline(A, t0 + 2 * PING + (PRESENCE_HEARTBEAT_TTL_MS - 1))).toBe(true);
  });

  it('KHÔNG ghost-online: agent CÓ WS + có ping REST, WS CUỐI đóng → chỉ grace 10s, KHÔNG kéo dài 40s nhờ heartbeat cũ', () => {
    const A = 503;
    const t0 = 30_000_000;
    vi.setSystemTime(t0); // để unregisterAgentConnection ghi closedAtMs = Date.now() = t0.
    const conn = fakeConn(A);
    registerAgentConnection(A, conn); // web/exe: giữ WS...
    markAgentSeen(A, t0); // ...VÀ ping REST (đặt agentHeartbeatAt=t0).
    expect(agentPresenceOnline(A, t0)).toBe(true); // (a) WS.

    unregisterAgentConnection(A, conn); // WS CUỐI đóng tại t0 → xóa agentHeartbeatAt + set agentLastSeenAt=t0 (grace).
    expect(agentPresenceOnline(A, t0 + (PRESENCE_STALE_MS - 1))).toBe(true); // trong grace 10s vẫn online.
    // Nếu KHÔNG xóa heartbeat cũ, nhánh (b) sẽ giữ online tới 40s (ghost). Kiểm mốc 10s..40s PHẢI offline:
    expect(agentPresenceOnline(A, t0 + PRESENCE_STALE_MS)).toBe(false); // hết grace 10s → offline NGAY (đứt WS nhanh).
    expect(agentPresenceOnline(A, t0 + 20_000)).toBe(false);
    expect(agentPresenceOnline(A, t0 + (PRESENCE_HEARTBEAT_TTL_MS - 1))).toBe(false); // KHÔNG ghost tới ~40s.
  });

  it('sau khi đứt WS + hết grace, nhịp ping THẬT kế tiếp (thiết bị còn mạng) → online LẠI qua heartbeat 40s', () => {
    const A = 504;
    const t0 = 40_000_000;
    vi.setSystemTime(t0); // closedAtMs = Date.now() = t0.
    const conn = fakeConn(A);
    registerAgentConnection(A, conn);
    markAgentSeen(A, t0);
    unregisterAgentConnection(A, conn); // WS đóng t0.
    expect(agentPresenceOnline(A, t0 + PRESENCE_STALE_MS)).toBe(false); // offline sau grace.
    markAgentSeen(A, t0 + 12_000); // nhịp ping REST kế (≤15s) khi thiết bị còn mạng nhưng chưa reconnect WS.
    expect(agentPresenceOnline(A, t0 + 12_000)).toBe(true); // online lại qua (b).
    expect(agentPresenceOnline(A, t0 + 12_000 + (PRESENCE_HEARTBEAT_TTL_MS - 1))).toBe(true);
  });
});
