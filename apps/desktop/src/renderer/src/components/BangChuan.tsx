import { forwardRef, type ReactNode } from 'react';

/**
 * BẢNG CHUẨN — MẪU CHỐT 6/11/2026 (Admin Demo).
 *
 * NGUỒN DUY NHẤT cho kiểu bảng của toàn bộ SigMa. Màn "DOANH SỐ" là bản mẫu đã được Admin Demo
 * duyệt bằng mắt + đo số; mọi màn khác PHẢI import từ đây, **CẤM chép lại chuỗi class vào từng trang**
 * — chép là chắc chắn lệch dần (đã xảy ra thật với `brand.css`: file tự sinh bị sửa tay, chạy lại
 * generator là mất bản vá).
 *
 * Luật kiểu nút / thanh cuộn / màu nền nằm ở `src/renderer/src/mau-moi.css` (nạp trong `main.tsx`);
 * trang chỉ cần đặt `data-nut-vuong` trên thẻ bọc ngoài cùng.
 */

/** Ô TIÊU ĐỀ: nền xám đậm, chữ đen in đậm, CĂN GIỮA cả ngang lẫn dọc, có kẻ dọc giữa các cột. */
export const thChuan =
  'bg-slate-200 px-1 py-2 text-center align-middle font-bold whitespace-nowrap text-slate-900 border-r border-slate-300 last:border-r-0';

/** Ô DỮ LIỆU: chiều cao dòng 7,5px mỗi bên (đã +10% theo yêu cầu 6/11), kẻ dọc mờ hơn tiêu đề. */
export const tdChuan = 'px-1 py-[7.5px] align-middle whitespace-nowrap border-r border-slate-200 last:border-r-0';

/** Ô HÀNG TỔNG: cùng nền với hàng tiêu đề (Admin Demo chốt 6/11) để 2 đầu bảng cân nhau. */
export const tdTongChuan = tdChuan + ' bg-slate-200';

/** Cột TIỀN: căn phải, chữ số đều bề ngang, màu đen, KHÔNG in đậm. */
export const tdTien = tdChuan + ' text-right tabular-nums text-slate-800';

/** Cột PHẦN TRĂM: căn giữa, 12px như mọi cột số, màu xám đậm, KHÔNG in đậm. */
export const tdPhanTram = tdChuan + ' text-center tabular-nums text-slate-600';

/** Nền SỌC NGỰA VẰN cho dòng thứ i (0-based): trắng / xanh nhạt, để dò ngang bảng nhiều cột. */
export function nenDong(i: number, noiBat?: boolean): string {
  if (noiBat) return 'bg-amber-100';
  // [Admin Demo 16/11] "mỗi dòng 1 màu theo brand" — `brand-tint` (#eaf4fb ≈ brand @9%) NHẠT QUÁ, đo ảnh thật
  // màn Máy POS 17 cột thấy gần như trắng hết ⇒ dò ngang bảng bị lạc dòng. Đậm lên brand @18% (#d5e6f8):
  // vẫn đúng hệ màu brand, nhưng mắt tách được dòng ngay. Đổi Ở ĐÂY nên MỌI bảng cùng đổi — không lệch màn.
  return i % 2 === 1 ? 'bg-brand/[0.18]' : 'bg-white';
}

/** Class đầy đủ cho `<tr>` của một dòng dữ liệu. */
export function trChuan(i: number, noiBat?: boolean): string {
  return 'border-t border-line transition hover:bg-appbg ' + nenDong(i, noiBat);
}

/**
 * Lớp cho `<thead>`: TIÊU ĐỀ GHIM TRÊN, nằm TRONG khung cuộn (mẫu chốt 6/11 §1).
 * Bổ sung 6/11 (nhóm A) — trước đây mỗi trang tự chép chuỗi này; nay 1 nguồn.
 */
export const theadChuan = 'sticky top-0 z-20 text-xs uppercase tracking-wide shadow-sm';

/** Lớp cho `<tfoot>`: HÀNG TỔNG GHIM ĐÁY, nằm TRONG khung cuộn nên không chiếm thêm chiều cao trang. */
export const tfootChuan = 'sticky bottom-0 z-10';

/** Lớp cho `<tr>` của hàng TỔNG: gạch đậm màu brand tách hẳn khỏi vùng dữ liệu. */
export const trTongChuan = 'border-t-2 border-brand';

/**
 * Ô "đang tải" / "không có dữ liệu". LUÔN đi kèm `colSpan` = ĐÚNG số `<th>` đang render —
 * lệch `colSpan` là lỗi đã gặp thật (hàng rỗng co lại, hàng TỔNG lệch cột).
 */
export const tdTrong = 'px-3 py-6 text-center text-sm text-slate-400';

/**
 * HÀNG ĐỆM cuối `<tbody>`: hàng TỔNG `sticky bottom-0` NỔI TRÊN nội dung nên che mất dòng cuối
 * khi cuộn tới đáy. Chừa đúng 1 hàng trống (h-9) bằng chiều cao hàng tổng.
 * Đóng thành component để `colSpan` luôn là 1 biến duy nhất — không còn chép số bằng tay.
 */
export function HangDem({ soCot }: { soCot: number }): JSX.Element {
  return (
    <tr aria-hidden>
      <td colSpan={soCot} className="h-9" />
    </tr>
  );
}

/**
 * KHUNG BẢNG: khung cuộn chiếm hết chiều cao còn lại của trang, viền bo, thanh cuộn TO dễ kéo
 * (luật `[data-kiem="khung-bang"]` trong mau-moi.css). Tiêu đề ghim trên, hàng TỔNG ghim đáy —
 * cả hai nằm TRONG khung này nên không chiếm thêm chiều cao trang.
 *
 * `beNgangToiThieu`: đặt khi bảng có nhiều cột và muốn cuộn ngang chủ ý (vd 'min-w-[2142px]').
 */
export const KhungBang = forwardRef<HTMLDivElement, { children: ReactNode; className?: string }>(
  function KhungBang({ children, className }, ref) {
    return (
      <div
        data-kiem="khung-bang"
        ref={ref}
        className={'min-h-0 flex-1 overflow-auto rounded-lg border border-line ' + (className ?? '')}
      >
        {children}
      </div>
    );
  }
);
