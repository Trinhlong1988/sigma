// Badge-fix (6/8) — test THUẦN unread-badge.ts: đọc 1 phòng → tổng giảm ĐÚNG phần phòng đó NGAY (không cần
// server); tin mới → tổng tăng ngay; đọc HẾT → 0. Tái hiện đúng 3 lỗi Admin Demo báo (icon lệch / không clear).
import { describe, it, expect } from 'vitest';
import { buildUnreadMap, sumUnread, markRoomRead, incrementRoomUnread } from './unread-badge';

describe('buildUnreadMap + sumUnread — baseline từ server', () => {
  it('chỉ giữ phòng có unread > 0, tổng = cộng dồn', () => {
    const map = buildUnreadMap([
      { id: 'a', unreadCount: 3 },
      { id: 'b', unreadCount: 1 },
      { id: 'c', unreadCount: 0 } // đã đọc hết → không đưa vào map
    ]);
    expect(map.size).toBe(2);
    expect(sumUnread(map)).toBe(4);
  });

  it('map rỗng → tổng 0', () => {
    expect(sumUnread(buildUnreadMap([]))).toBe(0);
  });
});

describe('markRoomRead — đọc 1 phòng, tổng giảm ĐÚNG phần phòng đó NGAY (không server)', () => {
  it('4 (3+1) → đọc phòng a (3) → còn 1', () => {
    const map = buildUnreadMap([{ id: 'a', unreadCount: 3 }, { id: 'b', unreadCount: 1 }]);
    const changed = markRoomRead(map, 'a');
    expect(changed).toBe(true);
    expect(sumUnread(map)).toBe(1);
  });

  it('đọc phòng vốn đã 0 / không tồn tại → không đổi (trả false, không render thừa)', () => {
    const map = buildUnreadMap([{ id: 'a', unreadCount: 2 }]);
    expect(markRoomRead(map, 'a')).toBe(true); // lần đầu clear
    expect(markRoomRead(map, 'a')).toBe(false); // đã 0 → không đổi (chống "phải làm 2 lần")
    expect(markRoomRead(map, 'khong-ton-tai')).toBe(false);
    expect(sumUnread(map)).toBe(0);
  });

  it('đọc HẾT mọi phòng → tổng về 0 (icon clear)', () => {
    const map = buildUnreadMap([{ id: 'a', unreadCount: 3 }, { id: 'b', unreadCount: 1 }]);
    markRoomRead(map, 'a');
    markRoomRead(map, 'b');
    expect(sumUnread(map)).toBe(0);
  });
});

describe('incrementRoomUnread — tin mới realtime, tổng tăng NGAY', () => {
  it('+1 cho phòng đã có trong map', () => {
    const map = buildUnreadMap([{ id: 'a', unreadCount: 2 }]);
    incrementRoomUnread(map, 'a');
    expect(sumUnread(map)).toBe(3);
  });

  it('+1 cho phòng MỚI (chưa có trong map)', () => {
    const map = buildUnreadMap([]);
    incrementRoomUnread(map, 'moi');
    expect(sumUnread(map)).toBe(1);
  });

  it('luồng THẬT: baseline 4 → đọc a(3) còn 1 → tin mới phòng b → 2 → tin mới phòng c(mới) → 3', () => {
    const map = buildUnreadMap([{ id: 'a', unreadCount: 3 }, { id: 'b', unreadCount: 1 }]);
    expect(sumUnread(map)).toBe(4);
    markRoomRead(map, 'a');
    expect(sumUnread(map)).toBe(1);
    incrementRoomUnread(map, 'b');
    expect(sumUnread(map)).toBe(2);
    incrementRoomUnread(map, 'c');
    expect(sumUnread(map)).toBe(3);
  });
});
