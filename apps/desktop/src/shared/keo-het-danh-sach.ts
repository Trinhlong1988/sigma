// [B180 16/11 — Admin Demo "xử lý triệt để đi"] CHỐNG MẤT DỮ LIỆU CÂM DO PHÂN TRANG MẶC ĐỊNH.
//
// Chuyện đã xảy ra (B179): màn Quản Lý TID gọi `/v1/tids` không truyền phân trang ⇒ máy chủ trả pageSize
// mặc định 100; sổ có 114 TID ⇒ **14 TID biến mất, app không báo một câu nào** (Admin Demo phát hiện vì thiếu
// 3 TID "Xuân Đoàn"). Vá riêng màn TID là chưa đủ: 6 service khác cũng cắt 100 và hàng chục màn gọi
// `xxxList({})` y hệt — chỉ chưa lộ vì dữ liệu còn dưới 100 dòng.
//
// Cách xử lý TRIỆT ĐỂ, đặt ở LỚP GỌI API (dùng chung cho CẢ 2 lớp: preload Electron và web-shim):
//   • Màn KHÔNG tự phân trang  → tự kéo HẾT các trang rồi gộp lại, kèm `total` để màn đối chiếu.
//   • Màn CÓ tự phân trang     → tôn trọng, trả đúng trang nó xin (không đổi hành vi sẵn có).
//   • Kéo mãi không hết (vượt trần vòng lặp) → trả `dayDu: false` để màn BÁO LÊN, tuyệt đối không im.
// Giữ nguyên việc máy chủ vẫn cắt trang (FIX-PERF B132) — không nới trần ở máy chủ.

/** Những đường dẫn danh sách mà MÁY CHỦ có cắt trang mặc định (service khai PAGE_SIZE_DEFAULT = 100). */
export const DUONG_DAN_CAT_TRANG = [
  '/v1/tids',
  '/v1/customers',
  '/v1/receive-accounts',
  '/v1/dossiers',
  '/v1/products',
  '/v1/bill-explains',
  '/v1/cash-entries'
] as const;

/** pageSize lớn nhất máy chủ chấp nhận (mọi service đều khai PAGE_SIZE_MAX = 500). */
export const BO_MOI_TRANG = 500;
/** Trần số vòng — 40 × 500 = 20.000 dòng. Chạm trần là bất thường ⇒ phải báo, không im. */
export const TRAN_SO_TRANG = 40;

export interface KetQuaDanhSach {
  ok: boolean;
  data?: unknown[];
  error?: string;
  message?: string;
  total?: number;
  page?: number;
  pageSize?: number;
  /** false = CHƯA kéo hết (chạm trần vòng lặp) ⇒ màn phải cảnh báo người dùng. */
  dayDu?: boolean;
}

/**
 * Kéo HẾT danh sách. `goi` là hàm gọi 1 trang (đã gắn sẵn đường dẫn).
 * Generic để GIỮ NGUYÊN kiểu trả về của từng endpoint (CustomerListResult, TidListResult…) — nếu hạ xuống
 * `unknown[]` thì mọi màn mất kiểu và lỗi kiểu sẽ chỉ lộ lúc chạy.
 * Màn đã tự truyền `page`/`pageSize` thì trả nguyên trang đó — không tự ý đổi ý người gọi.
 */
export async function keoHetTrang<T>(
  goi: (filter: Record<string, unknown>) => Promise<T>,
  filter: unknown
): Promise<T> {
  const f = (filter ?? {}) as Record<string, unknown>;
  if (f['page'] != null || f['pageSize'] != null) return goi(f);

  const gom: unknown[] = [];
  let tong: number | null = null;
  let chamTran = false;
  for (let trang = 1; trang <= TRAN_SO_TRANG; trang++) {
    const r = await goi({ ...f, page: trang, pageSize: BO_MOI_TRANG });
    const k = r as unknown as KetQuaDanhSach;
    // Lỗi hoặc hình dạng lạ ⇒ trả NGUYÊN kết quả, không nuốt, không bịa mảng rỗng.
    if (!k || k.ok !== true || !Array.isArray(k.data)) return r;
    gom.push(...k.data);
    if (typeof k.total === 'number') tong = k.total;
    if (k.data.length < BO_MOI_TRANG) break;          // trang cuối (chưa đầy ⇒ hết thật)
    if (tong != null && gom.length >= tong) break;    // đã đủ theo máy chủ
    if (trang === TRAN_SO_TRANG) chamTran = true;      // [B329/F3-3] chạm trần mà trang cuối VẪN ĐẦY = CÒN NỮA
  }
  // [B329/F3-3 24/11 — agent soát] Chạm trần + trang cuối còn đầy ⇒ CHẮC CHẮN bị cắt, dù máy chủ không
  // trả `total`. Trước đây `tong==null` cho dayDu=true (báo "đầy đủ") ⇒ mất dữ liệu câm — trái cam kết.
  const dayDu = !chamTran && (tong == null || gom.length >= tong);
  return { ok: true, data: gom, total: tong ?? gom.length, page: 1, pageSize: gom.length, dayDu } as unknown as T;
}
