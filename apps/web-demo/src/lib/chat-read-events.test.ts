import { describe, it, expect, vi } from 'vitest';
import { emitRoomRead, subscribeRoomRead, emitAllRead, subscribeAllRead } from './chat-read-events';

// ĐỒNG BỘ ĐÃ-ĐỌC ĐA THIẾT BỊ (7/8, Admin Demo) — máy khác đọc phòng/đọc-tất-cả → WS room-read-self/all-read-self →
// gọi emitRoomRead/emitAllRead → mọi listener (AppShell badge, ChatList bubble, App.tsx notification) clear.

describe('chat-read-events — pub-sub đã-đọc (đồng bộ đa thiết bị)', () => {
  it('emitRoomRead gọi đúng listener với roomId, hủy thì hết nhận', () => {
    const fn = vi.fn();
    const off = subscribeRoomRead(fn);
    emitRoomRead('room-x');
    expect(fn).toHaveBeenCalledWith('room-x');
    off();
    emitRoomRead('room-y');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('emitAllRead gọi mọi listener all-read (không tham số), hủy thì hết nhận', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeAllRead(a);
    const offB = subscribeAllRead(b);
    emitAllRead();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    emitAllRead();
    expect(a).toHaveBeenCalledTimes(1); // đã hủy
    expect(b).toHaveBeenCalledTimes(2);
    offB();
  });

  it('room-read và all-read là 2 kênh riêng (không lẫn)', () => {
    const room = vi.fn();
    const all = vi.fn();
    const offR = subscribeRoomRead(room);
    const offA = subscribeAllRead(all);
    emitRoomRead('r1');
    expect(all).not.toHaveBeenCalled();
    emitAllRead();
    expect(room).toHaveBeenCalledTimes(1); // room không bị all-read kích hoạt
    offR();
    offA();
  });

  it('1 listener ném lỗi KHÔNG chặn listener khác (best-effort)', () => {
    const bad = vi.fn(() => { throw new Error('x'); });
    const good = vi.fn();
    const off1 = subscribeAllRead(bad);
    const off2 = subscribeAllRead(good);
    expect(() => emitAllRead()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    off1();
    off2();
  });
});
