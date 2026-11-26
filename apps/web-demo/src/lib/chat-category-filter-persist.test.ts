// REGRESSION (Admin Demo 17/8) — "vào phòng chat từ 1 phân loại khách hàng → back thì phải quay về ĐÚNG phân loại
// đó; hiện đang bị nhảy về Tất cả" (áp cả khi mở 'thông tin hội thoại' rồi back — cùng gốc: ChatListScreen
// remount làm mất state filter cục bộ). Module này GIỮ lựa chọn qua remount + xóa lúc đăng xuất.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getPersistedCatFilter, setPersistedCatFilter, clearPersistedCatFilter
} from './chat-category-filter-persist';

describe('chat-category-filter-persist — giữ phân loại đang lọc qua remount', () => {
  beforeEach(() => clearPersistedCatFilter());
  afterEach(() => clearPersistedCatFilter());

  it('chưa chọn gì → undefined ("Tất cả")', () => {
    expect(getPersistedCatFilter()).toBeUndefined();
  });

  it('chọn 1 phân loại → lần đọc kế (mô phỏng ChatListScreen MOUNT lại sau back) trả đúng phân loại đó', () => {
    setPersistedCatFilter('cat-khach-vip');
    // getPersistedCatFilter() = thứ ChatListScreen gọi ở useState init mỗi lần mount → phải khôi phục đúng.
    expect(getPersistedCatFilter()).toBe('cat-khach-vip');
  });

  it('bấm "Tất cả" (set undefined) → xóa ghi nhớ, không còn khôi phục phân loại cũ', () => {
    setPersistedCatFilter('cat-a');
    setPersistedCatFilter(undefined);
    expect(getPersistedCatFilter()).toBeUndefined();
  });

  it('đổi phân loại → ghi nhớ giá trị MỚI NHẤT', () => {
    setPersistedCatFilter('cat-a');
    setPersistedCatFilter('cat-b');
    expect(getPersistedCatFilter()).toBe('cat-b');
  });

  it('đăng xuất (clear) → xóa sạch (chống tài khoản kế thừa bộ lọc người trước trên cùng tab)', () => {
    setPersistedCatFilter('cat-a');
    clearPersistedCatFilter();
    expect(getPersistedCatFilter()).toBeUndefined();
  });

  it('bền qua sessionStorage (nếu môi trường có) — ghi khóa để tab cùng phiên khôi phục được', () => {
    setPersistedCatFilter('cat-persist');
    if (typeof sessionStorage !== 'undefined') {
      expect(sessionStorage.getItem('sigma:chat:catFilter:v1')).toBe('cat-persist');
      setPersistedCatFilter(undefined);
      expect(sessionStorage.getItem('sigma:chat:catFilter:v1')).toBeNull();
    } else {
      // môi trường không có sessionStorage — vẫn phải giữ được trong RAM
      expect(getPersistedCatFilter()).toBe('cat-persist');
    }
  });
});
