// B86-tiếp (1/8, việc 1 — cache friends dùng chung) — audit tốc độ B86 đo THẬT thấy ContactsScreen.tsx VÀ
// (gián tiếp qua `buildAgentNameResolver()`, chat-client.ts) ConversationScreen.tsx/ChatListScreen.tsx/
// GroupInfoPanel.tsx MỖI MÀN ĐỘC LẬP gọi lại `GET /v1/me/friends` mỗi lần mount/điều hướng tới, dù danh sách
// bạn bè hiếm khi đổi (chỉ đổi khi CHÍNH MÌNH thao tác: gửi/chấp nhận/từ chối lời mời, unfriend, đặt biệt
// danh, đổi phân loại, chặn/bỏ chặn — KHÔNG có real-time push riêng cho friend-list; "người khác chấp nhận lời
// mời của mình" hoặc "người khác đổi tên hiển thị" vẫn cần điều hướng lại/tải lại trang mới thấy — CHẤP NHẬN
// ĐƯỢC vì đây thuần là optimization tránh gọi THỪA, không phải sai lệch dữ liệu bảo mật/tài chính).
//
// THIẾT KẾ (ưu tiên theo đúng brief): cache VÔ THỜI HẠN (KHÔNG TTL mù) + invalidate CHỦ ĐỘNG ngay sau MỌI hành
// động đổi danh sách bạn bè — chính xác hơn TTL vì không có khoảng "vừa đổi xong nhưng cache vẫn cũ trong N
// giây". Cache sống theo vòng đời tab (module-level state, KHÔNG persist localStorage — dữ liệu bạn bè gắn với
// phiên đăng nhập RC, tải lại trang/đóng tab thì phiên cũng cần xác thực lại nên cache nguội theo là hợp lý).
import { listMyFriends, type AgentApiResult, type FriendListResult } from './agent-api-client';

// PERF (Admin Demo 15/8 "danh bạ load vẫn lâu") — GỐC: ContactsScreen invalidate + fetch MỖI lần mount (để bắt lời
// mời kết bạn mới) ⇒ spinner + đợi mạng mỗi lần. FIX SWR: giữ 1 bản "LAST-KNOWN" bền (sessionStorage) để render
// NGAY (peek) khi mở lại, trong khi vẫn revalidate nền (invalidate chỉ xoá cache-điều-khiển-fetch `cached`, KHÔNG
// xoá last-known) → lời mời mới vẫn hiện sau ~1 vòng fetch, KHÔNG spinner chặn. Last-known xoá khi ĐĂNG XUẤT
// (clearFriendsCachePersist, gọi ở performLogout) để tài khoản kế KHÔNG thấy bạn bè người trước.
const LK_KEY = 'sigma_friends_last_known_v1';

let cached: FriendListResult | null = null;
// `lastKnown` = bản danh bạ tải thành công GẦN NHẤT — TÁCH khỏi `cached` để invalidate (mỗi lần mở Danh bạ, buộc
// fetch mới) KHÔNG xoá nó → peek vẫn có để render tức thời (in-memory, chạy cả nơi không có sessionStorage).
let lastKnown: FriendListResult | null = null;
let inflight: Promise<AgentApiResult<FriendListResult>> | null = null;

function readLastKnown(): FriendListResult | null {
  try { const raw = sessionStorage.getItem(LK_KEY); return raw ? (JSON.parse(raw) as FriendListResult) : null; } catch { return null; }
}
function rememberLastKnown(data: FriendListResult): void {
  lastKnown = data;
  try { sessionStorage.setItem(LK_KEY, JSON.stringify(data)); } catch { /* quota/priv — vẫn còn memory */ }
}

/** Bản danh bạ biết-lần-cuối (memory `lastKnown`, fallback sessionStorage khi reload) để render TỨC THỜI khi mở
 * lại — BẤT KỂ đã invalidate. `null` chỉ khi chưa từng tải lần nào (sau cài/đăng nhập). */
export function peekCachedFriends(): FriendListResult | null {
  return cached ?? lastKnown ?? readLastKnown();
}

/** Xoá bản last-known (memory + bền) — gọi lúc ĐĂNG XUẤT (chống lộ chéo tài khoản trên cùng tab). */
export function clearFriendsCachePersist(): void {
  cached = null;
  lastKnown = null;
  inflight = null;
  epoch += 1;
  try { sessionStorage.removeItem(LK_KEY); } catch { /* bỏ qua */ }
}
// Tăng mỗi lần invalidate() — dùng để CHẶN 1 request ĐANG BAY (bắt đầu TRƯỚC lúc invalidate) ghi ĐÈ cache bằng
// dữ liệu CŨ sau khi nó về muộn (xem race bên dưới trong getCachedFriends()).
let epoch = 0;

/** Trả kết quả CÙNG SHAPE với `listMyFriends()` (`AgentApiResult<FriendListResult>`):
 * - Cache HIT (đã có dữ liệu, chưa invalidate) → trả NGAY, KHÔNG gọi mạng.
 * - Cache MISS (nguội lần đầu / vừa invalidate) → gọi `listMyFriends()` thật; NHIỀU lệnh gọi đồng thời lúc
 *   đang nguội (vd 2 component cùng mount 1 lúc) dùng CHUNG 1 promise `inflight` — chỉ 1 request HTTP thật sự
 *   bay đi, không bắn N request trùng.
 * - CHỈ lưu cache khi `ok:true` — lỗi mạng/phiên hết hạn KHÔNG cache (lần gọi kế tiếp tự thử lại thật, tránh
 *   "đóng băng" mãi ở trạng thái lỗi).
 *
 * Race đã xử lý (adversarial checklist): nếu `invalidateFriendsCache()` được gọi TRONG LÚC 1 request cũ (bắt
 * đầu TRƯỚC đó) vẫn đang bay, request cũ đó khi về (mang dữ liệu CŨ, trước thời điểm invalidate) sẽ KHÔNG được
 * phép ghi vào `cached` nữa — so `epoch` chụp lúc BẮT ĐẦU request với `epoch` HIỆN TẠI lúc response về; lệch
 * nhau = đã bị invalidate giữa chừng = bỏ, không ghi đè cache bằng dữ liệu cũ hơn thao tác vừa làm. */
export async function getCachedFriends(): Promise<AgentApiResult<FriendListResult>> {
  if (cached) return { ok: true, data: cached };
  if (inflight) return inflight;

  const myEpoch = epoch;
  const promise: Promise<AgentApiResult<FriendListResult>> = listMyFriends().then((res) => {
    if (inflight === promise) inflight = null;
    if (res.ok && myEpoch === epoch) { cached = res.data; rememberLastKnown(res.data); } // last-known cho stale-first
    return res;
  });
  inflight = promise;
  return promise;
}

/** Xóa cache — gọi NGAY SAU mọi hành động đổi danh sách bạn bè THÀNH CÔNG (gửi/chấp nhận/từ chối lời mời kết
 * bạn, unfriend, đặt biệt danh, đổi phân loại Gia đình/Công việc, chặn/bỏ chặn — xem ContactsScreen.tsx). Lần
 * `getCachedFriends()` kế tiếp (BẤT KỲ màn nào đang dùng cache này) sẽ tự fetch lại thật, không cần biết ai vừa
 * gọi invalidate. */
export function invalidateFriendsCache(): void {
  cached = null;
  inflight = null;
  epoch += 1;
}
