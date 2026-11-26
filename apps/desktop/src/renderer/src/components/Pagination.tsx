/**
 * Thanh phân trang TRÌNH BÀY dùng chung (chỉ UI) — 1 nguồn style cho CẢ client-side (usePagination) LẪN server-side
 * (RevenuePage refetch từng trang) để đồng bộ FONT/UI toàn app (Admin Demo 12/8 — trước RevenuePage tự chế "Trước/Sau"
 * lệch: không mũi tên, không "Hiển thị a–b / tổng N"). Không tự quản state — cha truyền page/onPrev/onNext.
 */
export function PaginationBar({
  page, pageCount, from, to, total, onPrev, onNext
}: { page: number; pageCount: number; from: number; to: number; total: number; onPrev: () => void; onNext: () => void }): JSX.Element {
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
      <span>Hiển thị <b className="text-slate-700">{from}–{to}</b> / tổng <b className="text-slate-700">{total}</b></span>
      <div className="flex items-center gap-1">
        <button onClick={onPrev} disabled={page <= 1} className="rounded-md border border-line px-3 py-1 text-slate-600 enabled:hover:bg-appbg disabled:opacity-40">← Trước</button>
        <span className="px-2">Trang <b className="text-slate-700">{page}</b>/{pageCount}</span>
        <button onClick={onNext} disabled={page >= pageCount} className="rounded-md border border-line px-3 py-1 text-slate-600 enabled:hover:bg-appbg disabled:opacity-40">Sau →</button>
      </div>
    </div>
  );
}

/**
 * DANH SÁCH ĐẦY ĐỦ — **KHÔNG CÒN PHÂN TRANG CLIENT-SIDE** (Admin Demo 13/11:
 * "không để 2 trang 3 trang mà chỉ để cuộn").
 *
 * Trước đây hook này cắt danh sách 50 dòng/trang rồi vẽ thanh "← Trước · Trang 1/2 · Sau →".
 * Nay trả NGUYÊN danh sách đã lọc: bảng vẽ hết dòng, người dùng CUỘN trong khung bảng
 * (`[data-kiem='khung-bang']` — ô cuộn DUY NHẤT của trang, xem `KhungBang` trong BangChuan.tsx).
 *
 * `bar` cố tình trả `null` (giữ nguyên hình dạng trả về để nơi gọi cũ không vỡ kiểu):
 * số lượng đã có sẵn ở **hàng TỔNG ghim đáy** bên TRONG khung cuộn ("TỔNG 68 TID",
 * "TỔNG 47 máy"...). Thêm một thanh nữa BÊN DƯỚI bảng sẽ ăn mất chiều cao của trang full-height
 * và đẻ ra thanh cuộn thứ hai — đúng thứ vừa dọn xong.
 *
 * Tham số `pageSize` giữ lại (không dùng) để nơi gọi cũ `usePagination(rows, 50)` vẫn biên dịch.
 */
export function useDanhSachDayDu<T>(rows: T[], _pageSize = 50): { pageRows: T[]; bar: JSX.Element | null } {
  return { pageRows: rows, bar: null };
}

/**
 * @deprecated Tên cũ, giữ làm bí danh cho nơi gọi chưa đổi (vd `components/ExportRequestPanel.tsx`).
 * Hành vi nay = `useDanhSachDayDu`: KHÔNG phân trang nữa. Nơi gọi mới hãy dùng thẳng tên mới.
 */
export const usePagination = useDanhSachDayDu;
