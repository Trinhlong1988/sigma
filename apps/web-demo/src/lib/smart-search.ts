// "Lọc tin nhắn phải lọc thông minh như đã làm với GLB không phân biệt hoa thường" (Admin Demo 25/7, panel
// thông tin nhóm chat).
//
// ĐÃ TỰ TRA CỨU TRƯỚC KHI VIẾT FILE NÀY (KHÔNG suy đoán, KHÔNG bịa thuật toán) — đọc thật
// `<REPO>\tools\quan-ly-glb\apps\desktop\src\main\global-search-service.ts` (nơi DUY NHẤT GLB có tìm
// kiếm "thông minh" — top-bar global search) và grep toàn bộ `apps/desktop/src` cho
// search-utils/smart-search/normalize/toLowerCase/unaccent: GLB **KHÔNG có 1 hàm TypeScript "smart search"
// dùng chung** nào tái sử dụng qua nhiều màn. Cơ chế "thông minh" (không phân biệt hoa/thường LẪN không phân
// biệt dấu tiếng Việt, vd "duc dung"/"ĐỨC DŨNG"/"đức dũng" khớp nhau) mà GLB có được là nhờ chạy SQL PostgreSQL
// `lower(unaccent(cột)) LIKE lower(unaccent(:pattern))` (dùng extension `unaccent`, xem db.ts dòng bootstrap
// `CREATE EXTENSION IF NOT EXISTS unaccent`) — lặp lại thủ công ở TỪNG câu truy vấn trong
// global-search-service.ts, KHÔNG phải 1 utility. Component `SearchSelect.tsx` (combobox dùng chung nhiều nơi)
// thì NGƯỢC LẠI — chỉ `.toLowerCase().includes()` THUẦN, KHÔNG bỏ dấu (gõ "duc" sẽ KHÔNG khớp "Đức").
//
// Ở đây (`apps/web-demo`) KHÔNG có tầng DB cho tin nhắn Rocket.Chat — messages đã tải hết về trình duyệt
// (getRoomHistory), lọc theo ngày + từ khóa chạy trên mảng JS, không có SQL nào để chạy. Vì vậy KHÔNG "port"
// được nguyên file nào (không tồn tại file JS nào ở GLB để port) — viết 1 hàm JS làm ĐÚNG NGHĨA mà
// `lower(unaccent())` tạo ra phía SQL (bỏ hoa/thường + bỏ dấu tiếng Việt), giữ cùng Ý NGHĨA "thông minh" GLB
// đang dùng, áp dụng lại cho ngữ cảnh JS thay vì SQL.

/** Dải Unicode "combining diacritical marks" (U+0300–U+036F) — phần dấu thanh tách rời sau khi `normalize('NFD')`
 * phân rã 1 ký tự có dấu (vd "ế" → "e" + dấu mũ tổ hợp + dấu sắc tổ hợp). Viết bằng \u escape tường minh
 * (dùng \u escape thay vì gõ literal ký tự tổ hợp trong source) để tránh mơ hồ/rủi ro encoding khi file được mở lại bằng editor
 * khác. */
const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;

/** Chuẩn hoá 1 chuỗi tiếng Việt để so khớp không phân biệt hoa/thường + không phân biệt dấu — tương đương ý
 * nghĩa `lower(unaccent(s))` của PostgreSQL. NFD tách ký tự có dấu thành ký tự gốc + dấu tổ hợp rồi xoá phần
 * dấu — riêng "Đ/đ" KHÔNG tách qua NFD (là 1 codepoint độc lập trong Unicode, không phải "D" + dấu gạch ngang
 * tổ hợp) nên phải thay tay. */
export function normalizeForSearch(input: string): string {
  return input
    .normalize('NFD')
    .replace(COMBINING_MARKS_RE, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

/** true nếu `haystack` chứa `needle` sau khi chuẩn hoá cả 2 (không phân biệt hoa/thường + không phân biệt
 * dấu). `needle` rỗng/toàn khoảng trắng → luôn true (đúng UX ô tìm kiếm trống = không lọc gì, cùng hành vi
 * SearchSelect.tsx/global-search-service.ts khi query rỗng). */
export function smartIncludes(haystack: string | undefined | null, needle: string): boolean {
  if (!needle.trim()) return true;
  if (!haystack) return false;
  return normalizeForSearch(haystack).includes(normalizeForSearch(needle));
}
