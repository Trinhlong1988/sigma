// Item 3 (6/8) — test store toast tin nhắn kiểu Zalo (toast-store.ts): logic THUẦN (insertAndCap/shouldChimeNow)
// + hành vi store (stack theo thời gian, cap đẩy cũ nhất, auto-ẩn theo timer, remove/clear/subscribe). Chạy ở
// environment 'node' (không DOM) — dùng vi.useFakeTimers cho phần hẹn giờ tự ẩn.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  insertAndCap,
  shouldChimeNow,
  pushToast,
  removeToast,
  clearAllToasts,
  subscribeToasts,
  getToastsSnapshot,
  MAX_TOASTS,
  __resetToastStoreForTest,
  type ToastItem
} from './toast-store';

function makeItem(seq: number, createdAtMs: number): ToastItem {
  return {
    id: `t-${seq}`,
    roomId: `room-${seq}`,
    title: `Tiêu đề ${seq}`,
    body: `Nội dung ${seq}`,
    avatarColor: '#000',
    avatarLabel: 'A',
    createdAtMs,
    seq
  };
}

describe('insertAndCap — xếp theo (createdAtMs, seq) tăng dần + cắt cũ nhất khi tràn', () => {
  it('chèn giữ thứ tự thời gian TĂNG DẦN (tin cũ ở đầu/trên)', () => {
    const a = makeItem(0, 100);
    const b = makeItem(1, 300);
    const { list } = insertAndCap([a, b], makeItem(2, 200), 4);
    expect(list.map((t) => t.createdAtMs)).toEqual([100, 200, 300]);
  });

  it('tie-break bằng seq khi createdAtMs trùng (giữ đúng thứ tự đến)', () => {
    const a = makeItem(0, 100);
    const { list } = insertAndCap([a], makeItem(1, 100), 4);
    expect(list.map((t) => t.seq)).toEqual([0, 1]);
  });

  it('vượt cap → đẩy CŨ NHẤT (đầu danh sách) ra + trả về trong dropped', () => {
    let list: ToastItem[] = [];
    for (let i = 0; i < 3; i++) list = insertAndCap(list, makeItem(i, i * 10), 3).list;
    const res = insertAndCap(list, makeItem(3, 30), 3);
    expect(res.list.length).toBe(3);
    expect(res.dropped.map((t) => t.seq)).toEqual([0]); // seq 0 (cũ nhất) bị đẩy.
    expect(res.list.map((t) => t.seq)).toEqual([1, 2, 3]);
  });
});

describe('shouldChimeNow — throttle chime 1 lần/lô', () => {
  it('chưa từng chime (null) → luôn true', () => {
    expect(shouldChimeNow(null, 1000)).toBe(true);
  });
  it('trong khoảng gap → false (chống kêu chồng)', () => {
    expect(shouldChimeNow(1000, 1200, 500)).toBe(false);
  });
  it('quá gap → true', () => {
    expect(shouldChimeNow(1000, 1600, 500)).toBe(true);
  });
});

describe('store — push/remove/clear/subscribe + auto-ẩn', () => {
  beforeEach(() => {
    __resetToastStoreForTest();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const base = { title: 'T', body: 'B', avatarColor: '#000', avatarLabel: 'A' };

  it('push thêm toast, snapshot phản ánh + reference đổi khi có thay đổi', () => {
    const before = getToastsSnapshot();
    pushToast({ ...base, roomId: 'r1', createdAtMs: 100 }, 5000);
    const after = getToastsSnapshot();
    expect(after).not.toBe(before);
    expect(after.length).toBe(1);
    expect(after[0].roomId).toBe('r1');
  });

  it('nhiều tin → STACK xếp thời gian tăng dần (tin trước ở TRÊN)', () => {
    pushToast({ ...base, roomId: 'r2', createdAtMs: 200 }, 5000);
    pushToast({ ...base, roomId: 'r1', createdAtMs: 100 }, 5000); // đến sau nhưng thời gian sớm hơn
    expect(getToastsSnapshot().map((t) => t.roomId)).toEqual(['r1', 'r2']);
  });

  it('vượt MAX_TOASTS → cũ nhất tự bị đẩy ra', () => {
    for (let i = 0; i < MAX_TOASTS + 2; i++) {
      pushToast({ ...base, roomId: `r${i}`, createdAtMs: i * 10 }, 5000);
    }
    const snap = getToastsSnapshot();
    expect(snap.length).toBe(MAX_TOASTS);
    expect(snap[0].roomId).toBe('r2'); // r0, r1 (cũ nhất) đã bị đẩy.
  });

  it('tự ẩn sau durationMs (timer)', () => {
    pushToast({ ...base, roomId: 'r1', createdAtMs: 100 }, 6000);
    expect(getToastsSnapshot().length).toBe(1);
    vi.advanceTimersByTime(5999);
    expect(getToastsSnapshot().length).toBe(1);
    vi.advanceTimersByTime(2);
    expect(getToastsSnapshot().length).toBe(0);
  });

  it('removeToast bỏ đúng toast + huỷ timer (không ẩn lại lần 2)', () => {
    const id = pushToast({ ...base, roomId: 'r1', createdAtMs: 100 }, 6000);
    removeToast(id);
    expect(getToastsSnapshot().length).toBe(0);
    // timer cũ nếu còn sẽ cố removeToast lần 2 — đảm bảo không ném/không đổi state.
    vi.advanceTimersByTime(10000);
    expect(getToastsSnapshot().length).toBe(0);
  });

  it('clearAllToasts xoá sạch + huỷ mọi timer', () => {
    pushToast({ ...base, roomId: 'r1', createdAtMs: 100 }, 6000);
    pushToast({ ...base, roomId: 'r2', createdAtMs: 200 }, 6000);
    clearAllToasts();
    expect(getToastsSnapshot().length).toBe(0);
    vi.advanceTimersByTime(10000);
    expect(getToastsSnapshot().length).toBe(0);
  });

  it('avatarUrl (item 12) — giữ nguyên qua push khi có', () => {
    pushToast({ ...base, roomId: 'r1', createdAtMs: 100, avatarUrl: 'http://x/v1/agents/5/avatar' }, 5000);
    expect(getToastsSnapshot()[0].avatarUrl).toBe('http://x/v1/agents/5/avatar');
  });

  it('avatarUrl (item 12) — KHÔNG truyền → undefined (ToastHost fallback ô màu+chữ)', () => {
    pushToast({ ...base, roomId: 'r1', createdAtMs: 100 }, 5000);
    expect(getToastsSnapshot()[0].avatarUrl).toBeUndefined();
  });

  it('subscribeToasts được gọi khi có thay đổi + huỷ đăng ký dừng nhận', () => {
    let calls = 0;
    const off = subscribeToasts(() => {
      calls++;
    });
    pushToast({ ...base, roomId: 'r1', createdAtMs: 100 }, 6000);
    expect(calls).toBe(1);
    off();
    pushToast({ ...base, roomId: 'r2', createdAtMs: 200 }, 6000);
    expect(calls).toBe(1); // đã huỷ → không tăng.
  });
});
