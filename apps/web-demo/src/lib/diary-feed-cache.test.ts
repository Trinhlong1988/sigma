// REGRESSION (Admin Demo 15/8 "load nhật ký cũng lỗi tương tự profile") — SWR cache trang đầu feed-của-mình:
// getStale trả bài đã cache để render tức thời; clear (đăng xuất) xóa sạch.
import { describe, it, expect, beforeEach } from 'vitest';
import { getStaleDiaryFeed, setDiaryFeedCache, clearDiaryFeedCache } from './diary-feed-cache';
import type { PostDto } from './diary-api';

const POST = { id: 'p1', content: 'Xin chào nhật ký' } as unknown as PostDto;

describe('diary-feed-cache — SWR own feed', () => {
  beforeEach(() => clearDiaryFeedCache());

  it('chưa cache → getStale null', () => {
    expect(getStaleDiaryFeed()).toBeNull();
  });

  it('set → getStale trả đúng bài (render tức thời)', () => {
    setDiaryFeedCache([POST]);
    expect(getStaleDiaryFeed()).toEqual([POST]);
  });

  it('clear (đăng xuất) → getStale null', () => {
    setDiaryFeedCache([POST]);
    clearDiaryFeedCache();
    expect(getStaleDiaryFeed()).toBeNull();
  });
});
