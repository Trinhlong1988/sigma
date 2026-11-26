// B122 (2/8, Admin Demo báo trực tiếp "chỉ 1 người trong trò chuyện mà load mất mấy giây" — điều tra Playwright
// network trace THẬT xác nhận GET /v1/me/categories bắn 4 LẦN cho 1 lần mở /app/chat rỗng) — CÙNG PATTERN
// friends-cache.ts (B86-tiếp, 1/8): `Sidebar.tsx` (LUÔN mount trong AppShell) VÀ `ChatListScreen.tsx` (mount
// khi vào /app/chat) mỗi bên tự gọi `listChatCategories()` RIÊNG, KHÔNG chia sẻ cache/dedupe — dữ liệu phân
// loại hiếm khi đổi (chỉ đổi khi CHÍNH MÌNH tạo/sửa/xóa/gán qua CategoryManagerModal.tsx).
//
// THIẾT KẾ — GIỐNG HỆT friends-cache.ts (tái dùng ý tưởng ĐÃ KIỂM CHỨNG, không tự nghĩ biến thể mới): cache VÔ
// THỜI HẠN (KHÔNG TTL mù) + invalidate CHỦ ĐỘNG. ĐIỂM KHÁC 1 CHỖ: thay vì mỗi call site tự nhớ gọi
// `invalidateChatCategoriesCache()` sau khi ghi (dễ quên — CategoryManagerModal.tsx đã CÓ SẴN
// `notifyChatCategoriesChanged()` gọi sau MỌI thao tác ghi thành công), module này TỰ ĐĂNG KÝ làm listener của
// bus đó ngay lúc import (`subscribeChatCategoriesChanged(invalidateChatCategoriesCache)` ở cuối file) — đăng
// ký NGAY LÚC MODULE NẠP (trước khi bất kỳ component nào mount effect của nó), nên LUÔN chạy invalidate TRƯỚC
// các listener `load()` của Sidebar/ChatListScreen (Set giữ thứ tự chèn) → 2 màn đó luôn thấy cache đã nguội
// đúng lúc notify bắn ra, không đọc nhầm dữ liệu vừa bị coi là cũ. `CategoryManagerModal.tsx` CỐ Ý giữ nguyên
// gọi `listChatCategories()` THÔ cho các lần đọc nội bộ của chính nó (`loadCategories()`, đọc lại NGAY sau ghi
// — cần chắc chắn 100% tươi, không phụ thuộc timing cache) — KHÔNG đổi file đó, chỉ thêm 1 module mới.
import { listChatCategories, subscribeChatCategoriesChanged, type AgentApiResult, type ChatCategoryDto } from './agent-api-client';

let cached: ChatCategoryDto[] | null = null;
let inflight: Promise<AgentApiResult<ChatCategoryDto[]>> | null = null;
// Cùng cơ chế race-guard epoch như friends-cache.ts — xem docstring getCachedFriends() cho giải thích đầy đủ.
let epoch = 0;

/** Trả kết quả CÙNG SHAPE với `listChatCategories()`. Cache HIT → trả ngay, không gọi mạng. Cache MISS →
 * gọi thật, nhiều lệnh gọi đồng thời dùng CHUNG 1 promise (dedupe request đang bay). CHỈ cache khi `ok:true`. */
export async function getCachedChatCategories(): Promise<AgentApiResult<ChatCategoryDto[]>> {
  if (cached) return { ok: true, data: cached };
  if (inflight) return inflight;

  const myEpoch = epoch;
  const promise: Promise<AgentApiResult<ChatCategoryDto[]>> = listChatCategories().then((res) => {
    if (inflight === promise) inflight = null;
    if (res.ok && myEpoch === epoch) cached = res.data;
    return res;
  });
  inflight = promise;
  return promise;
}

/** Xóa cache — gọi khi danh sách phân loại vừa đổi. Tự động qua subscription bên dưới; export riêng chỉ để
 * test tiêm trực tiếp (regression test, KHÔNG cần đi qua bus thật). */
export function invalidateChatCategoriesCache(): void {
  cached = null;
  inflight = null;
  epoch += 1;
}

// Đăng ký NGAY LÚC MODULE NẠP — xem giải thích đầy đủ ở docstring đầu file.
subscribeChatCategoriesChanged(invalidateChatCategoriesCache);
