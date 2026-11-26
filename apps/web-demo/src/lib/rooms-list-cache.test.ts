// REGRESSION (Admin Demo 15/8 "load danh sách chat chậm mỗi lần vào app/chuyển tab") — SWR: getStale trả danh sách
// cũ BẤT KỂ tuổi (render tức thời, không spinner) trong khi getFresh vẫn null khi quá TTL; persist sessionStorage;
// clear (đăng xuất) xóa sạch cả memory lẫn sessionStorage (chống lộ chéo tài khoản).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getFreshRoomsListCache, getStaleRoomsListCache, setRoomsListCache, clearRoomsListCache, ROOMS_LIST_CACHE_TTL_MS
} from './rooms-list-cache';
import type { ChatRoom } from '../mock-data/types';

const ROOM = { id: 'r1', name: 'Phòng A', isGroup: false } as unknown as ChatRoom;

describe('rooms-list-cache — SWR stale-first + persist', () => {
  beforeEach(() => { clearRoomsListCache(); vi.useRealTimers(); });
  afterEach(() => { clearRoomsListCache(); vi.useRealTimers(); });

  it('chưa có cache → cả fresh lẫn stale đều null', () => {
    expect(getFreshRoomsListCache()).toBeNull();
    expect(getStaleRoomsListCache()).toBeNull();
  });

  it('set xong → fresh + stale đều trả data', () => {
    setRoomsListCache([ROOM]);
    expect(getFreshRoomsListCache()).toEqual([ROOM]);
    expect(getStaleRoomsListCache()).toEqual([ROOM]);
  });

  it('QUÁ TTL 8s → fresh null (nguội) NHƯNG stale VẪN trả data (đây là fix chống spinner)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:00Z'));
    setRoomsListCache([ROOM]);
    vi.setSystemTime(new Date(Date.now() + ROOMS_LIST_CACHE_TTL_MS + 5000)); // +13s
    expect(getFreshRoomsListCache()).toBeNull();      // nguội theo TTL
    expect(getStaleRoomsListCache()).toEqual([ROOM]); // vẫn có để render ngay
  });

  it('clear (đăng xuất) → xóa cache (chống lộ chéo tài khoản)', () => {
    setRoomsListCache([ROOM]);
    clearRoomsListCache();
    expect(getStaleRoomsListCache()).toBeNull();
    expect(getFreshRoomsListCache()).toBeNull();
  });
});
