// Phân loại nhóm chat (mục 21 — như Zalo, Admin Demo bổ sung 23/7).
//
// Cutover 31/7 (việc #4) — Phase 0 mock-only (mảng `CATEGORIES` mutable + pub-sub
// `subscribeCategoriesChanged`/`notifyCategoriesChanged`) đã BỊ XÓA khỏi file này: dữ liệu phân loại nay
// sống THẬT ở apps/bot-api (bảng ChatCategory, `/v1/me/categories`, xem agent-api-client.ts
// `ChatCategoryDto`/`listChatCategories`/`subscribeChatCategoriesChanged`) — CategoryManagerModal.tsx/
// Sidebar.tsx/ChatListScreen.tsx/ChatList.tsx đều đã đổi sang gọi API thật, KHÔNG còn nơi nào import
// `CATEGORIES`/`categoryById`/`subscribeCategoriesChanged`/`notifyCategoriesChanged` (đã grep xác nhận trước
// khi xóa). CHỈ giữ lại `CATEGORY_SWATCHES` — bảng màu gợi ý cho form tạo/sửa phân loại ở
// CategoryManagerModal.tsx (backend KHÔNG validate hex, chỉ FE gợi ý).
export const CATEGORY_SWATCHES: string[] = [
  '#16a34a', // xanh lá
  '#0579cc', // xanh brand
  '#f59e0b', // cam
  '#dc2626', // đỏ
  '#7c3aed', // tím
  '#0891b2', // xanh cyan
  '#db2777', // hồng
  '#ca8a04', // vàng đậm
  '#059669', // xanh ngọc
  '#64748b' // xám slate
];
