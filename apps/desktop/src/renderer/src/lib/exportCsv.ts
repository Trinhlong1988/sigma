// XUẤT EXCEL (R38/R39 Admin Demo 11/7) — GIỮ NGUYÊN chữ ký exportCsv(filename, headers, rows, title?) để 28 nơi
// gọi KHÔNG phải sửa, nhưng bên trong nay đi qua IPC dựng .xlsx THẬT chuẩn nhà sigma (exceljs, main process)
// → LƯU qua hộp thoại HĐH (chọn nơi lưu) → hỏi "Mở / Không mở" (hộp thoại DÙNG CHUNG). Không còn .xls-HTML giả.
import { getDialogBridge } from './dialogBridge.js';

type Cell = string | number | null | undefined;

// Khóa kỹ thuật (filename cũ) → tên tiếng Việt chuẩn để đặt tên file + tiêu đề bảng (sẽ IN HOA).
const NAME_MAP: Record<string, string> = {
  ngan_hang: 'Danh sách ngân hàng',
  loai_the: 'Danh sách loại thẻ',
  doi_tac: 'Danh sách đối tác',
  bieu_phi: 'Bảng biểu phí',
  loai_phi: 'Danh sách loại phí',
  nha_cung_cap: 'Danh sách nhà cung cấp',
  chung_loai_pos: 'Danh sách chủng loại máy POS',
  trang_thai_nhap: 'Danh sách trạng thái nhập máy',
  nhap_kho_pos: 'Danh sách máy POS nhập kho',
  nguon_tk: 'Danh sách nguồn tài khoản nhận tiền',
  tk_nhan_tien: 'Danh sách tài khoản nhận tiền',
  nguon_ho_so: 'Danh sách nguồn hồ sơ',
  ho_so_hkd: 'Danh sách hồ sơ HKD',
  trang_thai_tid: 'Danh sách trạng thái TID',
  cau_hinh_tid: 'Danh sách cấu hình TID',
  nganh_nghe: 'Danh sách ngành nghề',
  danh_muc_thu_chi: 'Danh mục thu chi',
  quy: 'Danh sách quỹ',
  bao_cao_thu_chi: 'Báo cáo thu chi',
  khach_hang: 'Danh sách khách hàng',
  nhan_su: 'Danh sách nhân sự',
  vai_tro: 'Danh sách vai trò',
  nhat_ky: 'Nhật ký hệ thống',
  thung_rac: 'Thùng rác',
  doanh_thu: 'Báo cáo doanh thu',
  cong_no: 'Báo cáo công nợ',
  xep_hang_doanh_so_tid: 'Xếp hạng doanh số TID',
  duyet_huy_bill: 'Danh sách duyệt hủy bill'
};

// Biến filename kỹ thuật lạ ("abc_xyz") thành tên đẹp ("Abc xyz") khi không có trong NAME_MAP.
function prettify(filename: string): string {
  const base = filename.replace(/\.(csv|xls|xlsx)$/i, '').replace(/[_-]+/g, ' ').trim();
  if (!base) return 'Bảng dữ liệu';
  return base.charAt(0).toUpperCase() + base.slice(1);
}
function todayStamp(): string {
  const d = new Date();
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`; // ví dụ 11.7.2026 (không thêm số 0)
}

/**
 * Xuất bảng ra Excel .xlsx chuẩn nhà. `filename` = khóa kỹ thuật cũ (tra NAME_MAP ra tên Việt); `title`
 * (nếu truyền) ưu tiên làm tiêu đề bảng (ví dụ báo cáo dòng lỗi). Bất đồng bộ nhưng nơi gọi onClick khỏi await.
 */
export async function exportCsv(
  filename: string,
  headers: string[],
  rows: Cell[][],
  title?: string,
  /** [B228 22/11] Khối phụ xếp DƯỚI CÙNG bảng (vd tổng doanh số từng TID theo ca / theo ngày). */
  khoiPhu?: { tieuDe: string; headers: string[]; rows: Cell[][] }[],
  /** [B232] cột tiền (định dạng #,##0 + nới 30%) · cột nới rộng · cột căn giữa. */
  them?: { cotTien?: string[]; cotRong?: string[]; cotGiua?: string[] }
): Promise<void> {
  const dlg = getDialogBridge();
  const fileBase = NAME_MAP[filename] ?? title ?? prettify(filename);
  const reportTitle = title ?? NAME_MAP[filename] ?? prettify(filename);
  const fileName = `${fileBase} ${todayStamp()}.xlsx`;
  let res;
  try {
    res = await window.api.reportExport({ kind: 'report', fileBase, fileName, title: reportTitle, headers, rows, khoiPhu, ...(them ?? {}) });
  } catch (e) {
    return dlg.alert('Không xuất được Excel: ' + (e instanceof Error ? e.message : String(e)), 'Xuất Excel thất bại');
  }
  if (!res.ok) return dlg.alert(res.message ?? 'Không xuất được Excel.', 'Xuất Excel thất bại');
  if (res.canceled || !res.path) return; // người dùng bấm Hủy ở hộp thoại lưu — im lặng.
  const open = await dlg.confirm(`Đã lưu tại:\n${res.path}\n\nMở file ngay bây giờ?`, { title: 'Xuất Excel thành công', okLabel: 'Mở file', cancelLabel: 'Không mở' });
  if (open) {
    const o = await window.api.openFilePath(res.path);
    if (!o.ok) dlg.alert(o.message ?? 'Không mở được file.', 'Không mở được file');
  }
}


/**
 * [B231 22/11 — Admin Demo "thay vì tách sheet theo NĐT thì mỗi NĐT 1 file"] Xuất MỖI NĐT MỘT FILE .xlsx.
 * Desktop: hỏi THƯ MỤC một lần rồi ghi hết vào đó (không bắt bấm "lưu" N lần).
 * Web: tải lần lượt từng file về thư mục Tải xuống.
 * Đi CHUNG một đường `reportExportNhieuFile` nên hai nền hành xử như nhau.
 */
export async function exportNhieuFile(
  files: { fileName: string; sheet: { sheetName?: string; title: string; headers: string[]; rows: Cell[][]; summary?: string; khoiPhu?: { tieuDe: string; headers: string[]; rows: Cell[][] }[]; cotTien?: string[]; cotRong?: string[]; cotGiua?: string[] } }[]
): Promise<void> {
  const dlg = getDialogBridge();
  if (!files.length) return dlg.alert('Khong co du lieu de xuat.', 'Xuat Excel');
  let res;
  try {
    res = await window.api.reportExportNhieuFile({ files });
  } catch (e) {
    return dlg.alert('Khong xuat duoc Excel: ' + (e instanceof Error ? e.message : String(e)), 'Xuat Excel that bai');
  }
  if (!res.ok) return dlg.alert(res.message ?? 'Khong xuat duoc Excel.', 'Xuat Excel that bai');
  if (res.canceled) return;
  if (!res.thuMuc) {
    return dlg.alert('Da tai ' + (res.soFile ?? files.length) + ' file ve thu muc Tai xuong cua trinh duyet.', 'Xuat Excel xong');
  }
  const open = await dlg.confirm(
    'Da luu ' + (res.soFile ?? files.length) + ' file tai:' + String.fromCharCode(10) + res.thuMuc + String.fromCharCode(10, 10) + 'Mo file dau tien ngay bay gio?',
    { title: 'Xuat Excel thanh cong', okLabel: 'Mo file', cancelLabel: 'Khong mo' }
  );
  if (open && res.path) {
    const o = await window.api.openFilePath(res.path);
    if (!o.ok) dlg.alert(o.message ?? 'Khong mo duoc file.', 'Khong mo duoc file');
  }
}

/**
 * [B261 23/11 — Admin Demo "xuất excel ra phải cho không chạy 1 sheet, có chạy 1 sheet riêng đúng brand
 * alpha"] Xuất NHIỀU SHEET trong CÙNG MỘT FILE .xlsx (khác `exportNhieuFile` — cái đó mỗi NĐT một file).
 * Mỗi sheet đi qua `buildReportWorkbook` nên giữ nguyên brand nhà: tiêu đề xanh, hàng tên cột, dải
 * xen kẽ, cột tiền có dấu ngăn nghìn.
 */
export async function exportNhieuSheet(
  filename: string,
  sheets: { sheetName: string; title: string; headers: string[]; rows: Cell[][]; cotTien?: string[]; cotRong?: string[]; cotGiua?: string[] }[],
  title?: string
): Promise<void> {
  const dlg = getDialogBridge();
  if (!sheets.length) return dlg.alert('Không có dữ liệu để xuất.', 'Xuất Excel');
  const fileBase = NAME_MAP[filename] ?? title ?? prettify(filename);
  const fileName = `${fileBase} ${todayStamp()}.xlsx`;
  let res;
  try {
    res = await window.api.reportExport({ kind: 'report', fileBase, fileName, title: title ?? fileBase, headers: [], sheets });
  } catch (e) {
    return dlg.alert('Không xuất được Excel: ' + (e instanceof Error ? e.message : String(e)), 'Xuất Excel thất bại');
  }
  if (!res.ok) return dlg.alert(res.message ?? 'Không xuất được Excel.', 'Xuất Excel thất bại');
  if (res.canceled || !res.path) return;
  const open = await dlg.confirm(`Đã lưu tại:
${res.path}

Mở file ngay bây giờ?`, { title: 'Xuất Excel thành công', okLabel: 'Mở file', cancelLabel: 'Không mở' });
  if (open) {
    const o = await window.api.openFilePath(res.path);
    if (!o.ok) dlg.alert(o.message ?? 'Không mở được file.', 'Không mở được file');
  }
}
