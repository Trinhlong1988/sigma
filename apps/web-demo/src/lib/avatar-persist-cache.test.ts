// #23 (6/8) — test THUẦN avatar-persist-cache.ts: pickAvatarRender (logic quyết định chống nháy) + round-trip
// read/write/remove qua Storage inject (fake). Bất biến chính: có-ảnh→'image', chắc-chắn-không-ảnh→'color',
// chưa-biết→'skeleton' (KHÔNG bao giờ nháy ô-màu trước khi ảnh có về).
import { describe, it, expect } from 'vitest';
import {
  pickAvatarRender,
  readPersistedAvatar,
  writePersistedAvatar,
  removePersistedAvatar,
  avatarStorageKey
} from './avatar-persist-cache';

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear() {
      m.clear();
    },
    getItem(k: string) {
      return m.has(k) ? (m.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      m.set(k, String(v));
    },
    removeItem(k: string) {
      m.delete(k);
    },
    key(i: number) {
      return [...m.keys()][i] ?? null;
    }
  } as Storage;
}

describe('pickAvatarRender — quyết định render (trọng tâm #23)', () => {
  it('có data URL ảnh → "image" (KHÔNG hiện ô-màu)', () => {
    expect(pickAvatarRender('data:image/png;base64,AAAA')).toBe('image');
  });

  it('null = CHẮC CHẮN không ảnh (404) → "color" (ô-màu đúng, item 7)', () => {
    expect(pickAvatarRender(null)).toBe('color');
  });

  it('undefined = CHƯA biết (đang tải) → "skeleton" (KHÔNG đoán ô-màu → không nháy)', () => {
    expect(pickAvatarRender(undefined)).toBe('skeleton');
  });

  it('chuỗi rỗng → "skeleton" (không coi là ảnh hợp lệ)', () => {
    expect(pickAvatarRender('')).toBe('skeleton');
  });
});

describe('persistent cache — round-trip qua Storage inject (bền qua reload)', () => {
  it('write ảnh → read trả đúng data URL (reload hiện ngay)', () => {
    const store = fakeStorage();
    writePersistedAvatar(270, undefined, { kind: 'image', dataUrl: 'data:image/jpeg;base64,ZZZ' }, store);
    expect(readPersistedAvatar(270, undefined, store)).toEqual({ kind: 'image', dataUrl: 'data:image/jpeg;base64,ZZZ' });
    // Render từ persisted = 'image' (không nháy ô-màu).
    expect(pickAvatarRender(readPersistedAvatar(270, undefined, store)?.kind === 'image' ? 'data:image/jpeg;base64,ZZZ' : null)).toBe('image');
  });

  it('write "none" → read trả kind none (reload hiện ô-màu ngay, không skeleton)', () => {
    const store = fakeStorage();
    writePersistedAvatar(384, undefined, { kind: 'none' }, store);
    expect(readPersistedAvatar(384, undefined, store)).toEqual({ kind: 'none' });
  });

  it('chưa lưu → read null (CHƯA biết → skeleton)', () => {
    const store = fakeStorage();
    expect(readPersistedAvatar(999, undefined, store)).toBeNull();
  });

  it('version khác → key khác (cache-bust own-avatar sau upload)', () => {
    const store = fakeStorage();
    writePersistedAvatar(1, 'v1', { kind: 'image', dataUrl: 'data:img,OLD' }, store);
    expect(readPersistedAvatar(1, 'v2', store)).toBeNull(); // version mới chưa có → tải lại
    expect(avatarStorageKey(1, 'v1')).not.toBe(avatarStorageKey(1, 'v2'));
  });

  it('removePersistedAvatar xóa MỌI version của agent', () => {
    const store = fakeStorage();
    writePersistedAvatar(5, undefined, { kind: 'image', dataUrl: 'data:img,A' }, store);
    writePersistedAvatar(5, 'v9', { kind: 'image', dataUrl: 'data:img,B' }, store);
    writePersistedAvatar(6, undefined, { kind: 'image', dataUrl: 'data:img,C' }, store);
    removePersistedAvatar(5, store);
    expect(readPersistedAvatar(5, undefined, store)).toBeNull();
    expect(readPersistedAvatar(5, 'v9', store)).toBeNull();
    expect(readPersistedAvatar(6, undefined, store)).not.toBeNull(); // agent khác KHÔNG bị xóa
  });

  it('store null (storage thiếu/chặn) → best-effort: read null, write/remove no-op không ném', () => {
    expect(readPersistedAvatar(1, undefined, null)).toBeNull();
    expect(() => writePersistedAvatar(1, undefined, { kind: 'none' }, null)).not.toThrow();
    expect(() => removePersistedAvatar(1, null)).not.toThrow();
  });
});
