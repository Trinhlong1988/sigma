// [B331/F3-2 24/11 — agent soát #3] Băng cảnh báo DANH SÁCH BỊ CẮT. Máy chủ trả `total` (tổng thật trong
// kỳ/bộ lọc) nhưng danh sách có LIMIT; khi `total > số dòng hiện` mà màn không nói gì thì người dùng tưởng
// "chừng đó là tất cả" — mất dữ liệu câm (lớp B179/B180). Component dùng CHUNG: cắm vào mọi màn list.
import type { JSX } from 'react';

export function CanhBaoCatDanhSach({ soHienThi, tong, className }: { soHienThi: number; tong: number | null | undefined; className?: string }): JSX.Element | null {
  if (tong == null || soHienThi >= tong) return null;
  return (
    <div
      data-kiem="canh-bao-cat-danh-sach"
      className={'rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-[13px] font-medium text-amber-800 ' + (className ?? '')}
    >
      ⚠ Danh sách có {tong.toLocaleString('vi-VN')} dòng nhưng màn chỉ tải {soHienThi.toLocaleString('vi-VN')} — ĐANG THIẾU. Hãy thu hẹp bộ lọc (tìm kiếm / khoảng ngày) để xem đủ.
    </div>
  );
}
