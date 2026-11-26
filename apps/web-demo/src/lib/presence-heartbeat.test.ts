// SIGMA PRESENCE client heartbeat (6/8) — test THUẦN cho startPresenceHeartbeat()/sendPresenceOffline()
// (presence-heartbeat.ts). Chạy env 'node' (repo CHƯA có jsdom — xem vitest-include-guard.test.ts): tự giả lập
// window/document tối thiểu (addEventListener/removeEventListener/dispatch) + inject `post` (không fetch thật) +
// vi.useFakeTimers cho lịch ping. KHÔNG override `navigator` (builtin node, onLine=undefined → coi như online).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPresenceHeartbeat, sendPresenceOffline, PRESENCE_PING_INTERVAL_MS } from './presence-heartbeat';

const PING = '/v1/presence/ping';
const OFFLINE = '/v1/presence/offline';

interface FakeTarget {
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
  dispatch: (type: string) => void;
  count: (type: string) => number;
}
function makeTarget(): FakeTarget {
  const map: Record<string, Set<() => void>> = {};
  return {
    addEventListener: (t, f) => {
      (map[t] ??= new Set()).add(f);
    },
    removeEventListener: (t, f) => {
      map[t]?.delete(f);
    },
    dispatch: (t) => {
      map[t]?.forEach((f) => f());
    },
    count: (t) => map[t]?.size ?? 0
  };
}

describe('presence-heartbeat', () => {
  let posts: string[];
  let fakeWin: FakeTarget;
  let fakeDoc: FakeTarget & { visibilityState: string };
  let stop: (() => void) | undefined;
  const post = (p: string): Promise<void> => {
    posts.push(p);
    return Promise.resolve();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    posts = [];
    fakeWin = makeTarget();
    fakeDoc = Object.assign(makeTarget(), { visibilityState: 'visible' });
    (globalThis as unknown as { window: unknown }).window = fakeWin;
    (globalThis as unknown as { document: unknown }).document = fakeDoc;
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
    delete (globalThis as unknown as { window?: unknown }).window;
    delete (globalThis as unknown as { document?: unknown }).document;
  });

  it('ping NGAY khi start + lặp theo interval', () => {
    stop = startPresenceHeartbeat({ intervalMs: 1000, post });
    expect(posts).toEqual([PING]);
    vi.advanceTimersByTime(1000);
    expect(posts).toEqual([PING, PING]);
    vi.advanceTimersByTime(2000);
    expect(posts).toEqual([PING, PING, PING, PING]);
  });

  it('offline event → gọi /offline NGAY + DỪNG ping', () => {
    stop = startPresenceHeartbeat({ intervalMs: 1000, post });
    posts.length = 0;
    fakeWin.dispatch('offline');
    expect(posts).toEqual([OFFLINE]);
    vi.advanceTimersByTime(5000);
    expect(posts).toEqual([OFFLINE]); // mất mạng → không còn ping.
  });

  it('online lại → ping NGAY + tiếp tục lặp', () => {
    stop = startPresenceHeartbeat({ intervalMs: 1000, post });
    fakeWin.dispatch('offline');
    posts.length = 0;
    fakeWin.dispatch('online');
    expect(posts).toEqual([PING]); // ping tức thì.
    vi.advanceTimersByTime(1000);
    expect(posts).toEqual([PING, PING]); // vòng lặp chạy lại.
  });

  it('visibilitychange (visible) → ping bắt kịp (không cần chờ hết chu kỳ)', () => {
    stop = startPresenceHeartbeat({ intervalMs: 100000, post });
    posts.length = 0;
    fakeDoc.dispatch('visibilitychange');
    expect(posts).toEqual([PING]);
  });

  it('stop() gỡ mọi listener + dừng timer', () => {
    stop = startPresenceHeartbeat({ intervalMs: 1000, post });
    posts.length = 0;
    stop!();
    stop = undefined;
    vi.advanceTimersByTime(5000);
    expect(posts).toEqual([]); // timer đã dừng.
    fakeWin.dispatch('offline'); // listener đã gỡ → không post.
    expect(posts).toEqual([]);
    expect(fakeWin.count('online')).toBe(0);
    expect(fakeWin.count('offline')).toBe(0);
  });

  it('sendPresenceOffline() gọi đúng /offline (dùng cho App.tsx cleanup logout)', async () => {
    await sendPresenceOffline(post);
    expect(posts).toEqual([OFFLINE]);
  });

  // FIX PRESENCE 11/8 — khóa hằng chu kỳ ping = 15s (trước là 45s gây nháy offline). BẤT BIẾN với server:
  // 2×PING ≤ PRESENCE_HEARTBEAT_TTL_MS(40s phía chat-realtime-hub.ts) → rớt 1 nhịp KHÔNG nháy offline. Nếu ai
  // đổi hằng này PHẢI giữ 2×giá-trị ≤ TTL server (đổi cả 2 nơi cùng lúc) — test lock để không drift âm thầm.
  it('PRESENCE_PING_INTERVAL_MS = 15s (2×ping ≤ TTL server 40s)', () => {
    expect(PRESENCE_PING_INTERVAL_MS).toBe(15_000);
    expect(2 * PRESENCE_PING_INTERVAL_MS).toBeLessThanOrEqual(40_000); // TTL heartbeat phía server.
  });

  it('mặc định (không truyền intervalMs) → lặp theo PRESENCE_PING_INTERVAL_MS', () => {
    stop = startPresenceHeartbeat({ post }); // dùng interval mặc định.
    expect(posts).toEqual([PING]); // ping ngay lúc start.
    vi.advanceTimersByTime(PRESENCE_PING_INTERVAL_MS - 1);
    expect(posts).toEqual([PING]); // chưa tới chu kỳ.
    vi.advanceTimersByTime(1);
    expect(posts).toEqual([PING, PING]); // đúng 15s → nhịp kế.
  });
});
