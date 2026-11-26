// Fix "số chưa đọc không cộng dồn theo tin, lệch với icon" (7/8, Admin Demo: "1-1 cùng 1 người + nhóm nhiều người
// vs icon xem"). GỐC: AppShell (luôn mount) +1 icon-badge nhưng KHÔNG đồng bộ cache danh sách phòng → khi
// ChatListScreen unmount (đang ở phòng khác/tab khác) lúc tin tới, cache giữ số CŨ → mở lại danh sách trong 8s
// TTL thấy bubble số cũ dù icon đã +đúng. FIX: AppShell patch cache CÙNG applyIncomingMessageToRooms khi list
// không mount. Test này khẳng định LOGIC patch cache cộng dồn per-message (1-1 & nhóm) + trừ về 0 khi đọc.
import { describe, expect, it, beforeEach } from 'vitest';
import { applyIncomingMessageToRooms } from './chat-list-live';
import { getFreshRoomsListCache, setRoomsListCache, clearRoomsListCache } from './rooms-list-cache';
import type { ChatRoom } from '../mock-data/types';

function room(id: string, unread: number, isGroup: boolean): ChatRoom {
  return { id, name: id, isGroup, avatarColor: '#000', lastMessage: '', lastTime: '00:00', unreadCount: unread };
}

// Mô phỏng đúng việc AppShell làm khi list KHÔNG mount + có tin mới cho phòng roomId.
function appShellSyncOnMessage(roomId: string): void {
  const cached = getFreshRoomsListCache();
  if (!cached) return;
  const patched = applyIncomingMessageToRooms(cached, roomId, 'tin', '08:00');
  if (patched.found) setRoomsListCache(patched.rooms);
  else clearRoomsListCache();
}
// Mô phỏng AppShell khi đọc phòng (đọc tại máy này hoặc room-read-self từ máy khác).
function appShellSyncOnRead(roomId: string): void {
  const cached = getFreshRoomsListCache();
  if (!cached) return;
  setRoomsListCache(cached.map((r) => (r.id === roomId && r.unreadCount > 0 ? { ...r, unreadCount: 0 } : r)));
}

const unreadOf = (id: string): number => getFreshRoomsListCache()?.find((r) => r.id === id)?.unreadCount ?? -1;

describe('AppShell đồng bộ cache khi list unmount — số chưa đọc cộng dồn per-message (1-1 & nhóm)', () => {
  beforeEach(() => clearRoomsListCache());

  it('1-1: cùng 1 người gửi 3 tin → cache phòng đó = 3 (không kẹt 1)', () => {
    setRoomsListCache([room('dm', 0, false), room('grp', 0, true)]);
    appShellSyncOnMessage('dm');
    appShellSyncOnMessage('dm');
    appShellSyncOnMessage('dm');
    expect(unreadOf('dm')).toBe(3);
    expect(unreadOf('grp')).toBe(0); // phòng khác không bị đụng
  });

  it('nhóm nhiều người: các tin dồn vào 1 nhóm → cộng dồn đúng số tin (giống 1-1)', () => {
    setRoomsListCache([room('dm', 0, false), room('grp', 0, true)]);
    for (let i = 0; i < 5; i++) appShellSyncOnMessage('grp');
    expect(unreadOf('grp')).toBe(5);
  });

  it('đọc phòng (kể cả từ máy khác) → cache phòng đó về 0; cộng dồn tiếp sau đó vẫn đúng', () => {
    setRoomsListCache([room('grp', 4, true)]);
    appShellSyncOnRead('grp');
    expect(unreadOf('grp')).toBe(0);
    appShellSyncOnMessage('grp');
    appShellSyncOnMessage('grp');
    expect(unreadOf('grp')).toBe(2); // trừ về 0 rồi cộng lại đúng logic Zalo
  });

  it('phòng chưa có trong cache (tin đầu) → clear cache (buộc refetch lần mở kế, không bịa phòng)', () => {
    setRoomsListCache([room('dm', 0, false)]);
    appShellSyncOnMessage('room-moi-toanh');
    expect(getFreshRoomsListCache()).toBeNull();
  });
});
