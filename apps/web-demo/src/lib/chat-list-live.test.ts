// Bug E (6/8) — kiểm biến đổi danh sách phòng khi có tin MỚI realtime (chat-notify): +1 chưa đọc, đổi preview
// + giờ, đưa lên đầu; phòng vắng mặt → found=false (caller refetch). KHÔNG mutate đầu vào.
import { describe, expect, it } from 'vitest';
import { applyIncomingMessageToRooms } from './chat-list-live';
import type { ChatRoom } from '../mock-data/types';

function room(id: string, unread: number, last: string): ChatRoom {
  return { id, name: id, isGroup: false, avatarColor: '#000', lastMessage: last, lastTime: '00:00', unreadCount: unread };
}

describe('applyIncomingMessageToRooms (bug E — badge chưa đọc realtime)', () => {
  it('phòng có trong danh sách: +1 chưa đọc, đổi preview + giờ, ĐƯA lên đầu', () => {
    const rooms = [room('a', 0, 'cũ-a'), room('b', 2, 'cũ-b'), room('c', 0, 'cũ-c')];
    const { rooms: next, found } = applyIncomingMessageToRooms(rooms, 'b', 'tin mới', '08:21');
    expect(found).toBe(true);
    expect(next[0].id).toBe('b'); // lên đầu
    expect(next[0].unreadCount).toBe(3); // 2 + 1
    expect(next[0].lastMessage).toBe('tin mới');
    expect(next[0].lastTime).toBe('08:21');
    // Các phòng khác giữ nguyên, đủ 3 phòng, không trùng.
    expect(next.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('phòng đang ở đầu vẫn +1 đúng (không nhân đôi/không mất phòng)', () => {
    const rooms = [room('a', 5, 'cũ-a'), room('b', 0, 'cũ-b')];
    const { rooms: next } = applyIncomingMessageToRooms(rooms, 'a', 'x', '09:00');
    expect(next.map((r) => r.id)).toEqual(['a', 'b']);
    expect(next[0].unreadCount).toBe(6);
    expect(next.length).toBe(2);
  });

  it('phòng KHÔNG có trong danh sách → found=false, danh sách giữ nguyên (caller refetch)', () => {
    const rooms = [room('a', 0, 'cũ-a')];
    const { rooms: next, found } = applyIncomingMessageToRooms(rooms, 'zzz', 'x', '10:00');
    expect(found).toBe(false);
    expect(next).toBe(rooms); // KHÔNG tạo mảng mới khi không đổi.
  });

  it('KHÔNG mutate mảng/đối tượng đầu vào', () => {
    const rooms = [room('a', 1, 'cũ-a'), room('b', 0, 'cũ-b')];
    const snapshotUnread = rooms[0].unreadCount;
    applyIncomingMessageToRooms(rooms, 'a', 'x', '11:00');
    expect(rooms[0].unreadCount).toBe(snapshotUnread); // đối tượng gốc không đổi
    expect(rooms.map((r) => r.id)).toEqual(['a', 'b']); // thứ tự gốc không đổi
  });
});
