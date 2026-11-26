// Presence #22c HYSTERESIS (chống nháy) + "X phút trước" — test THUẦN presence-store.ts với vi.useFakeTimers cho
// phần debounce online-ổn-định. Bao: blip online↔offline <4.5s KHÔNG flash xanh; online ổn định >4.5s → xanh;
// offline NGAY; lastSeen cập nhật tươi; seed (trustOffline) qua hysteresis; parse/format/tone.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setPresence,
  getPresence,
  seedPresence,
  subscribePresence,
  parsePresenceUpdate,
  formatLastSeen,
  resolveOnlineDotTone,
  ONLINE_STABLE_MS,
  __resetPresenceStoreForTest
} from './presence-store';

beforeEach(() => {
  vi.useFakeTimers();
  __resetPresenceStoreForTest();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#22c hysteresis — online cần ỔN ĐỊNH ~4.5s mới hiện xanh', () => {
  it('online → CHƯA xanh ngay (unknown), sau ONLINE_STABLE_MS → xanh', () => {
    setPresence(1, true);
    expect(getPresence(1)).toBeUndefined(); // chưa xác nhận → OnlineDot xám-neutral
    vi.advanceTimersByTime(ONLINE_STABLE_MS - 1);
    expect(getPresence(1)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(getPresence(1)).toEqual({ online: true, lastSeenAt: null });
  });

  it('offline → đổi hiển thị NGAY (không chờ)', () => {
    setPresence(2, false, '2026-08-06T10:00:00Z');
    expect(getPresence(2)).toEqual({ online: false, lastSeenAt: '2026-08-06T10:00:00Z' });
  });

  it('BLIP online→offline<4.5s → KHÔNG flash xanh (giữ offline)', () => {
    setPresence(3, true); // pending
    vi.advanceTimersByTime(2000);
    setPresence(3, false, 'seen-a'); // offline ngay (huỷ pending)
    expect(getPresence(3)).toEqual({ online: false, lastSeenAt: 'seen-a' });
    vi.advanceTimersByTime(5000); // timer online cũ đã bị huỷ → KHÔNG bao giờ xanh
    expect(getPresence(3)).toEqual({ online: false, lastSeenAt: 'seen-a' });
  });

  it('CHUỖI blip liên tục (online/offline mỗi ~3s) → KHÔNG bao giờ xanh', () => {
    setPresence(4, true); // t0 pending
    vi.advanceTimersByTime(3000);
    setPresence(4, false, 'a'); // t3000 offline (huỷ)
    vi.advanceTimersByTime(1000);
    setPresence(4, true); // t4000 pending mới
    vi.advanceTimersByTime(3000);
    setPresence(4, false, 'b'); // t7000 offline (huỷ)
    vi.advanceTimersByTime(6000); // t13000
    expect(getPresence(4)).toEqual({ online: false, lastSeenAt: 'b' }); // xám ổn định, không nháy
  });

  it('online LIÊN TỤC >4.5s → xanh (mở app thật)', () => {
    setPresence(5, true);
    vi.advanceTimersByTime(2000);
    setPresence(5, true); // nhắc lại online — KHÔNG reset timer (tính từ lần đầu)
    vi.advanceTimersByTime(ONLINE_STABLE_MS - 2000);
    expect(getPresence(5)).toEqual({ online: true, lastSeenAt: null });
  });

  it('đã xanh rồi → giữ xanh + cập nhật lastSeen ngay (không cần chờ lại)', () => {
    setPresence(6, true);
    vi.advanceTimersByTime(ONLINE_STABLE_MS);
    expect(getPresence(6)?.online).toBe(true);
    setPresence(6, true, '2026-08-06T12:00:00Z');
    expect(getPresence(6)).toEqual({ online: true, lastSeenAt: '2026-08-06T12:00:00Z' });
  });

  it('#4 — lastSeen cập nhật NGAY khi đang chờ xanh (giữ offline hiển thị, X phút trước tươi)', () => {
    setPresence(7, false, 'old'); // offline
    setPresence(7, true, 'new'); // online pending → giữ offline nhưng lastSeen đổi 'new'
    expect(getPresence(7)).toEqual({ online: false, lastSeenAt: 'new' });
    vi.advanceTimersByTime(ONLINE_STABLE_MS);
    expect(getPresence(7)).toEqual({ online: true, lastSeenAt: 'new' });
  });

  it('subscriber được gọi khi hiển thị đổi (offline ngay, và lúc xanh sau chờ); unknown→pending KHÔNG emit', () => {
    let calls = 0;
    const off = subscribePresence(() => calls++);
    setPresence(8, false, 'x'); // +1
    expect(calls).toBe(1);
    setPresence(9, true); // pending → hiển thị vẫn unknown → không emit
    expect(calls).toBe(1);
    vi.advanceTimersByTime(ONLINE_STABLE_MS); // xanh → +1
    expect(calls).toBe(2);
    off();
  });
});

describe('#22b seed qua hysteresis — trustOffline', () => {
  it('cache-offline (trustOffline:false) → BỎ QUA (undefined = neutral)', () => {
    seedPresence([[1, false, 'x']], { trustOffline: false });
    expect(getPresence(1)).toBeUndefined();
  });

  it('cache-online (trustOffline:false) → pending → xanh sau 4.5s (không nháy)', () => {
    seedPresence([[1, true]], { trustOffline: false });
    expect(getPresence(1)).toBeUndefined();
    vi.advanceTimersByTime(ONLINE_STABLE_MS);
    expect(getPresence(1)?.online).toBe(true);
  });

  it('fresh-offline (mặc định) → offline NGAY (X phút trước)', () => {
    seedPresence([[2, false, '2026-08-06T00:00:00Z']]);
    expect(getPresence(2)).toEqual({ online: false, lastSeenAt: '2026-08-06T00:00:00Z' });
  });

  it('LUỒNG #22b: cache-offline soft (neutral) → fresh-online → xanh sau ổn định (không kẹt đỏ)', () => {
    seedPresence([[42, false]], { trustOffline: false });
    expect(getPresence(42)).toBeUndefined();
    seedPresence([[42, true]]); // fresh online
    vi.advanceTimersByTime(ONLINE_STABLE_MS);
    expect(getPresence(42)?.online).toBe(true);
  });
});

describe('parsePresenceUpdate — validate + lastSeenAt/at', () => {
  it('hợp lệ với lastSeenAt', () => {
    expect(parsePresenceUpdate({ agentId: 5, online: false, lastSeenAt: '2026-08-06T00:00:00Z' })).toEqual({
      agentId: 5,
      online: false,
      lastSeenAt: '2026-08-06T00:00:00Z'
    });
  });
  it('fallback field cũ `at`', () => {
    expect(parsePresenceUpdate({ agentId: 5, online: false, at: '2026-08-06T01:00:00Z' })).toEqual({
      agentId: 5,
      online: false,
      lastSeenAt: '2026-08-06T01:00:00Z'
    });
  });
  it('online=true không lastSeenAt → null', () => {
    expect(parsePresenceUpdate({ agentId: 5, online: true })).toEqual({ agentId: 5, online: true, lastSeenAt: null });
  });
  it('shape sai → null', () => {
    expect(parsePresenceUpdate({ agentId: '5', online: true })).toBeNull();
    expect(parsePresenceUpdate({ agentId: 5, online: 'yes' })).toBeNull();
    expect(parsePresenceUpdate({ agentId: Number.NaN, online: true })).toBeNull();
    expect(parsePresenceUpdate({ agentId: 5 })).toBeNull();
  });
});

describe('formatLastSeen — nhãn Zalo mọi mốc + biên', () => {
  const NOW = Date.parse('2026-08-06T12:00:00Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it('online → "Đang hoạt động"', () => {
    expect(formatLastSeen(true, null, NOW)).toBe('Đang hoạt động');
  });
  it('offline không lastSeenAt / iso hỏng → "Ngoại tuyến"', () => {
    expect(formatLastSeen(false, null, NOW)).toBe('Ngoại tuyến');
    expect(formatLastSeen(false, 'không-phải-iso', NOW)).toBe('Ngoại tuyến');
  });
  it('< 60s → "Vừa truy cập" (gồm biên 0 + mốc tương lai)', () => {
    expect(formatLastSeen(false, ago(0), NOW)).toBe('Vừa truy cập');
    expect(formatLastSeen(false, ago(59_000), NOW)).toBe('Vừa truy cập');
    expect(formatLastSeen(false, new Date(NOW + 10_000).toISOString(), NOW)).toBe('Vừa truy cập');
  });
  it('phút/giờ/ngày + biên', () => {
    expect(formatLastSeen(false, ago(60_000), NOW)).toBe('1 phút trước');
    expect(formatLastSeen(false, ago(59 * 60_000), NOW)).toBe('59 phút trước');
    expect(formatLastSeen(false, ago(60 * 60_000), NOW)).toBe('1 giờ trước');
    expect(formatLastSeen(false, ago(23 * 60 * 60_000), NOW)).toBe('23 giờ trước');
    expect(formatLastSeen(false, ago(24 * 60 * 60_000), NOW)).toBe('1 ngày trước');
    expect(formatLastSeen(false, ago(6 * 24 * 60 * 60_000), NOW)).toBe('6 ngày trước');
  });
  it('≥ 7 ngày → "dd/mm"', () => {
    const d = new Date(NOW - 10 * 24 * 60 * 60_000);
    const expected = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    expect(formatLastSeen(false, ago(10 * 24 * 60 * 60_000), NOW)).toBe(expected);
  });
});

describe('resolveOnlineDotTone', () => {
  it('agent-tracked + store chưa biết → unknown (xám)', () => {
    expect(resolveOnlineDotTone(true, undefined, true)).toBe('unknown');
  });
  it('agent-tracked + store biết → theo store', () => {
    expect(resolveOnlineDotTone(true, true, false)).toBe('online');
    expect(resolveOnlineDotTone(true, false, true)).toBe('offline');
  });
  it('không agentId → theo prop', () => {
    expect(resolveOnlineDotTone(false, undefined, true)).toBe('online');
    expect(resolveOnlineDotTone(false, undefined, false)).toBe('offline');
  });
});
