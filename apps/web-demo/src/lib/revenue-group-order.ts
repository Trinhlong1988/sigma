// [Admin Demo 10/9] "Doanh số theo nhóm: sắp xếp NĐT lên trước, lần lượt đến đại lý, rồi mới đến các nhóm có chữ QR
// bắt đầu." Danh sách phòng client nhận về CHỈ có tên (không có cờ NĐT/đại lý), nên phân loại theo QUY ƯỚC ĐẶT TÊN
// đang dùng thật trong hệ:
//   · Nhóm ĐẠI LÝ  : tên bắt đầu "ĐL" (vd "ĐL- Mr Nguyễn SG", "ĐL - Lộc SG", "DL-Nam Hà SG").
//   · Nhóm QR      : tên bắt đầu "QR".
//   · Còn lại      : nhóm NĐT (vd "Thông Thái Nguyên", "Trung CP") + nhóm nội bộ → lên ĐẦU theo yêu cầu.
// Hàm THUẦN để test khoá thứ tự (đổi tên nhóm kiểu khác thì test báo ngay).

/** Bỏ dấu + hoa/thường + ký tự trang trí → so khớp tiền tố ổn định ("ĐL- " → "DL"). */
export function chuanTen(raw: string | null | undefined): string {
  return (raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** 0 = NĐT/khác (đầu) · 1 = đại lý · 2 = nhóm QR (cuối). */
export function hangNhom(name: string | null | undefined): 0 | 1 | 2 {
  const t = chuanTen(name);
  if (t.startsWith('QR')) return 2;
  if (t.startsWith('DL')) return 1;
  return 0;
}

/** Sắp danh sách nhóm cho màn "Doanh số theo nhóm": NĐT → đại lý → QR; trong mỗi hạng xếp theo tên (tiếng Việt). */
export function xepNhomDoanhSo<T extends { name?: string | null }>(rooms: readonly T[]): T[] {
  return [...rooms].sort((a, b) => {
    const ha = hangNhom(a.name), hb = hangNhom(b.name);
    if (ha !== hb) return ha - hb;
    return (a.name ?? '').localeCompare(b.name ?? '', 'vi');
  });
}
