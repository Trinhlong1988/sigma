// P3+P5 (6/8) — regression test cho messages-cache.ts (cache tin nhắn theo phòng + SWR). Hàm THUẦN (Map
// module-level, KHÔNG DOM/mạng) — cùng lớp "pure-logic test" env node của vitest.config.ts gốc.
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../mock-data/types';
import {
  MESSAGES_CACHE_MAX_ROOMS,
  clearMessagesCache,
  clearRoomMessagesCache,
  getCachedRoomMessages,
  setCachedRoomMessages
} from './messages-cache';

function msg(id: string): ChatMessage {
  return { id, roomId: 'r1', senderId: '10', senderName: '', type: 'text', text: id, time: '10:00', status: 'sent' };
}

describe('messages-cache', () => {
  afterEach(() => clearMessagesCache());

  it('MISS khi chưa từng cache → null', () => {
    expect(getCachedRoomMessages('room-x')).toBeNull();
  });

  it('SET rồi GET → trả đúng messages + hasMoreOlder', () => {
    setCachedRoomMessages('room-a', [msg('m1'), msg('m2')], true);
    const hit = getCachedRoomMessages('room-a');
    expect(hit).not.toBeNull();
    expect(hit!.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(hit!.hasMoreOlder).toBe(true);
    expect(typeof hit!.cachedAt).toBe('number');
  });

  it('SET lại → GHI ĐÈ (không cộng dồn)', () => {
    setCachedRoomMessages('room-a', [msg('m1')], false);
    setCachedRoomMessages('room-a', [msg('m9'), msg('m10')], true);
    const hit = getCachedRoomMessages('room-a');
    expect(hit!.messages.map((m) => m.id)).toEqual(['m9', 'm10']);
    expect(hit!.hasMoreOlder).toBe(true);
  });

  it('LỌC tin chỉ-cục-bộ (pending-/local-/fwd-) khi ghi cache — chỉ giữ tin server thật', () => {
    setCachedRoomMessages('room-a', [msg('real-1'), msg('pending-1001'), msg('local-sticker-2'), msg('fwd-3'), msg('real-2')], false);
    const hit = getCachedRoomMessages('room-a');
    expect(hit!.messages.map((m) => m.id)).toEqual(['real-1', 'real-2']);
  });

  it('clearRoomMessagesCache xóa đúng 1 phòng, phòng khác còn nguyên', () => {
    setCachedRoomMessages('room-a', [msg('a1')], false);
    setCachedRoomMessages('room-b', [msg('b1')], false);
    clearRoomMessagesCache('room-a');
    expect(getCachedRoomMessages('room-a')).toBeNull();
    expect(getCachedRoomMessages('room-b')).not.toBeNull();
  });

  it('clearMessagesCache xóa TOÀN BỘ (chống rò tin giữa 2 tài khoản lúc đăng xuất)', () => {
    setCachedRoomMessages('room-a', [msg('a1')], false);
    setCachedRoomMessages('room-b', [msg('b1')], false);
    clearMessagesCache();
    expect(getCachedRoomMessages('room-a')).toBeNull();
    expect(getCachedRoomMessages('room-b')).toBeNull();
  });

  it('LRU — vượt MAX_ROOMS thì trục xuất phòng CŨ NHẤT (ít truy cập gần đây nhất)', () => {
    // Ghi MAX+1 phòng khác nhau → phòng đầu tiên (room-0) bị trục xuất.
    for (let i = 0; i <= MESSAGES_CACHE_MAX_ROOMS; i++) {
      setCachedRoomMessages(`room-${i}`, [msg(`m-${i}`)], false);
    }
    expect(getCachedRoomMessages('room-0')).toBeNull();
    expect(getCachedRoomMessages('room-1')).not.toBeNull();
    expect(getCachedRoomMessages(`room-${MESSAGES_CACHE_MAX_ROOMS}`)).not.toBeNull();
  });

  it('LRU — GET làm tươi độ-mới: phòng vừa đọc KHÔNG bị trục xuất khi thêm phòng mới', () => {
    for (let i = 0; i < MESSAGES_CACHE_MAX_ROOMS; i++) {
      setCachedRoomMessages(`room-${i}`, [msg(`m-${i}`)], false);
    }
    // Chạm lại room-0 (đưa lên "mới nhất") rồi thêm 1 phòng mới → phòng bị trục xuất phải là room-1, KHÔNG phải room-0.
    getCachedRoomMessages('room-0');
    setCachedRoomMessages('room-new', [msg('m-new')], false);
    expect(getCachedRoomMessages('room-0')).not.toBeNull();
    expect(getCachedRoomMessages('room-1')).toBeNull();
  });
});
