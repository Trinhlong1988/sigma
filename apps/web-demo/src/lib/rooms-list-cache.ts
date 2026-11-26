// B105 (2/8, Admin Demo yêu cầu "mở khung chat không chờ loading chặn màn hình, như Zalo") — cache TTL ngắn cho
// danh sách phòng chat, TÁCH RA từ ChatListScreen.tsx (trước đó là module-level state riêng CHỈ dùng nội bộ
// file đó) để App.tsx `ConversationRoute` cũng đọc được — cho phép mở 1 hội thoại HIỂN THỊ NGAY (0ms) nếu
// phòng đó đã có sẵn trong cache (trường hợp PHỔ BIẾN NHẤT: bấm vào 1 phòng từ ChatListScreen vừa tải xong),
// thay vì luôn luôn chờ 1 vòng fetch mới rồi mới render khung chat.
//
// AN TOÀN với bug đã né trước đây (xem comment cũ ChatListScreen.tsx) — NHƯNG LƯU Ý (review độc lập 2/8 chỉ
// đúng: 2 nơi dùng cache này KHÔNG cùng 1 nguyên tắc, cố ý khác nhau, không phải bất nhất):
//   - `App.tsx` ConversationRoute: cache HIT chỉ dùng để RENDER TẠM THỜI ngay lập tức — LUÔN LUÔN tự fetch lại
//     fresh ngay sau đó để cập nhật/xác nhận, nên phòng DIRECT vừa tạo (chưa kịp vào cache) vẫn tìm thấy đúng
//     qua nhánh fetch như cũ, KHÔNG mất guarantee "phòng mới phải xuất hiện ngay".
//   - `ChatListScreen.tsx`: NGƯỢC LẠI, cache HIT còn nóng (trong TTL) thì CHỦ ĐỘNG BỎ QUA refetch nền hoàn
//     toàn (đúng nguyên bản B86-tiếp — tối ưu tránh gọi mạng thừa khi bấm nhầm rồi Back ngay/điều hướng qua
//     lại nhanh) — danh sách phòng có thể cũ tới hết TTL (8s), tự làm mới ở lần remount kế tiếp sau khi
//     nguội. Đánh đổi CHẤP NHẬN ĐƯỢC vì đây chỉ là preview thứ tự/unread count, KHÔNG phải dữ liệu bắt buộc
//     phải tức thời như việc "phòng có tồn tại hay không" ở ConversationRoute.
import type { ChatRoom } from '../mock-data/types';

export const ROOMS_LIST_CACHE_TTL_MS = 8000;

// PERF (Admin Demo 15/8 "load danh sách chat chậm MỖI LẦN vào app / chuyển tab, ~chục cuộc") — GỐC đo được: cache
// CHỈ in-memory + TTL 8s + getFresh trả null khi nguội → mở app / quay lại tab sau >8s ⇒ rcRooms=null ⇒ spinner
// "Đang tải…" + đợi mạng MỖI lần. FIX SWR đúng nghĩa (như Zalo): (1) `getStaleRoomsListCache()` trả danh sách cũ
// BẤT KỂ tuổi → render NGAY, revalidate nền (ChatListScreen đã luôn refetch mỗi mount). (2) PERSIST sang
// sessionStorage → sống qua reload/resume WebView (không chỉ chuyển-tab trong-bộ-nhớ). sessionStorage (KHÔNG
// localStorage) để tự sạch khi đóng hẳn app + giảm rủi ro lộ chéo tài khoản; NGOÀI RA performLogout() xóa tường
// minh. getFresh giữ nguyên (TTL) cho consumer cần độ tươi.
const SS_KEY = 'sigma_rooms_list_cache_v1';

let cache: { data: ChatRoom[]; fetchedAt: number } | null = hydrateFromSession();

function hydrateFromSession(): { data: ChatRoom[]; fetchedAt: number } | null {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data: ChatRoom[]; fetchedAt: number };
    return Array.isArray(parsed?.data) ? parsed : null;
  } catch { return null; }
}

/** Trả dữ liệu cache nếu còn "nóng" (trong TTL), ngược lại `null` (nguội/chưa từng có). */
export function getFreshRoomsListCache(): ChatRoom[] | null {
  return cache && Date.now() - cache.fetchedAt < ROOMS_LIST_CACHE_TTL_MS ? cache.data : null;
}

/** Trả danh sách phòng đã cache LẦN CUỐI bất kể tuổi (kể cả nguội) — để render tức thời (stale-while-revalidate),
 * tránh spinner chặn màn mỗi lần mount. `null` chỉ khi CHƯA TỪNG có cache (lần chạy đầu tiên sau cài/đăng nhập). */
export function getStaleRoomsListCache(): ChatRoom[] | null {
  if (!cache) cache = hydrateFromSession();
  return cache ? cache.data : null;
}

export function setRoomsListCache(data: ChatRoom[]): void {
  cache = { data, fetchedAt: Date.now() };
  try { sessionStorage.setItem(SS_KEY, JSON.stringify(cache)); } catch { /* quota/priv — bỏ qua, vẫn còn memory */ }
}

/** Xóa cache — gọi sau hành động chắc chắn đổi danh sách phòng (tạo nhóm mới) + BẮT BUỘC lúc đăng xuất (chống
 * tài khoản kế thấy phòng của người trước trên cùng tab). */
export function clearRoomsListCache(): void {
  cache = null;
  try { sessionStorage.removeItem(SS_KEY); } catch { /* bỏ qua */ }
}
