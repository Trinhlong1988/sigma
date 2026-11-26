// Ghi nhớ PHÂN LOẠI đang lọc ở màn danh sách chat (Admin Demo 17/8: "vào phòng chat từ phân loại khách hàng, quay
// về thì phải quay về phân loại đó — hiện đang bị về Tất cả").
//
// GỐC BUG: `filter` là state CỤC BỘ của ChatListScreen. Bấm 1 phòng → navigate(chatRoom) UNMOUNT màn danh sách;
// bấm back → navigate(ROUTES.chat) MOUNT LẠI ChatListScreen mới → `filter` khởi tạo lại từ `?cat=` trên URL
// (rỗng ở ROUTES.chat thường) → luôn rơi về "Tất cả". Route chat KHÔNG mang theo query phân loại, và onBack ở
// ConversationRoute (App.tsx) không biết phân loại nào đang chọn để khôi phục.
//
// GIẢI PHÁP — CÙNG Ý TƯỞNG stale-first đã kiểm chứng ở rooms-list-cache/friends-cache: giữ lựa chọn trong bộ
// nhớ module + sessionStorage (bền qua remount/điều hướng trong CÙNG phiên tab), khôi phục lúc mount khi URL
// KHÔNG chỉ định `?cat=` cụ thể. Xóa lúc đăng xuất (performLogout) để tài khoản kế trên cùng tab không kế thừa
// bộ lọc của người trước — cùng lớp lo ngại clearRoomsListCache/clearFriendsCachePersist.
const KEY = 'sigma:chat:catFilter:v1';
let mem: string | undefined | null = null; // null = chưa hydrate; undefined = đã hydrate & không có bộ lọc

/** Phân loại đang được ghi nhớ (undefined nếu "Tất cả"/chưa từng chọn). Hydrate 1 lần từ sessionStorage. */
export function getPersistedCatFilter(): string | undefined {
  if (mem !== null) return mem;
  try {
    const v = sessionStorage.getItem(KEY);
    mem = v ? v : undefined;
  } catch {
    mem = undefined;
  }
  return mem;
}

/** Ghi nhớ phân loại vừa chọn (truyền undefined khi bấm "Tất cả" → xóa ghi nhớ). */
export function setPersistedCatFilter(id: string | undefined): void {
  mem = id;
  try {
    if (id) sessionStorage.setItem(KEY, id);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* sessionStorage không khả dụng — vẫn giữ được trong RAM qua `mem` cho điều hướng cùng phiên */
  }
}

/** Xóa ghi nhớ — gọi lúc đăng xuất (chống lộ chéo bộ lọc giữa 2 tài khoản trên cùng tab). */
export function clearPersistedCatFilter(): void {
  mem = undefined;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* bỏ qua */
  }
}
