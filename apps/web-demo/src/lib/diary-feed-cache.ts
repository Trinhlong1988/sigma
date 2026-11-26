// PERF SWR (Admin Demo 15/8 "load nhật ký cũng lỗi tương tự profile — chuyển tab phải load lại") — GỐC: DiaryScreen
// mount là setPosts([])+setLoading(true)+fetch → spinner + đợi mạng MỖI lần vào tab Nhật ký. Cache TRANG ĐẦU feed
// CỦA CHÍNH MÌNH (own feed) để render tức thời khi mở lại, revalidate nền. CHỈ own feed (tab Nhật ký hay dùng);
// feed của agent KHÁC (xem hồ sơ) giữ nguyên. Persist sessionStorage (sống qua reload/resume). Xóa lúc đăng xuất.
import type { PostDto } from './diary-api';

const SS_KEY = 'sigma_diary_own_feed_v1';

let cache: PostDto[] | null = hydrate();

function hydrate(): PostDto[] | null {
  try { const raw = sessionStorage.getItem(SS_KEY); const p = raw ? JSON.parse(raw) : null; return Array.isArray(p) ? p : null; } catch { return null; }
}

/** Trang đầu feed-của-mình đã cache lần cuối (bất kể tuổi) để render tức thời. `null` = chưa từng tải. */
export function getStaleDiaryFeed(): PostDto[] | null {
  if (!cache) cache = hydrate();
  return cache;
}

export function setDiaryFeedCache(posts: PostDto[]): void {
  cache = posts;
  try { sessionStorage.setItem(SS_KEY, JSON.stringify(posts)); } catch { /* quota/priv — vẫn còn memory */ }
}

/** Xóa — gọi lúc ĐĂNG XUẤT (chống lộ chéo tài khoản trên cùng tab). */
export function clearDiaryFeedCache(): void {
  cache = null;
  try { sessionStorage.removeItem(SS_KEY); } catch { /* bỏ qua */ }
}
