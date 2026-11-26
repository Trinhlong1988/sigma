/**
 * [B280 24/11 — Admin Demo "tất cả lỗi khi nhập bill, sửa bill, thêm máy, giao máy, lỗi vận hành app
 * phải hiển thị rõ và có hướng dẫn xử lý, cấm lỗi câm, cấm chung chung khó hiểu"]
 *
 * MỘT NGUỒN DUY NHẤT dựng thông điệp lỗi cho MỌI màn: LÝ DO (máy chủ nói gì) + CÁCH SỬA (bảng dưới)
 * + MÃ LỖI (báo kỹ thuật cho nhanh). Màn Doanh Số đã có bảng riêng từ B258 (mã đặc thù luồng bill);
 * bảng này là phần DÙNG CHUNG cho các màn còn lại — thêm mã mới ở máy chủ thì BẮT BUỘC thêm mục ở đây
 * (cổng _kiem-loi-ro-rang-toan-app.mjs đối chiếu tự động).
 */

const XD = String.fromCharCode(10);

/** Hướng dẫn sửa theo MÃ LỖI máy chủ — phần dùng chung toàn app. */
export const HUONG_DAN_LOI_CHUNG: Record<string, { tieuDe: string; cachSua: string }> = {
  VALIDATION: {
    tieuDe: 'Thiếu hoặc sai thông tin trên form',
    cachSua: 'Đọc câu lý do ở trên — nó nêu đúng ô đang sai. Sửa ô đó rồi bấm lưu lại.'
  },
  FORBIDDEN: {
    tieuDe: 'Tài khoản không đủ quyền',
    cachSua: 'Nhờ quản trị cấp quyền tương ứng ở màn Quản Lý Nhân Sự → vai trò, rồi đăng xuất đăng nhập lại.'
  },
  NOT_FOUND: {
    tieuDe: 'Dữ liệu liên quan không còn',
    cachSua: 'Bấm nút Làm mới để tải lại danh sách — bản ghi có thể vừa bị máy khác xoá/sửa. Nếu vẫn lỗi, kiểm tra ở Thùng rác.'
  },
  CONFLICT: {
    tieuDe: 'Thao tác va vào ràng buộc dữ liệu',
    cachSua: 'Đọc câu lý do ở trên — thường là bản ghi đang được chỗ khác dùng (máy đã giao, TID đang gắn, bill đã đối soát). Gỡ ràng buộc đó trước rồi làm lại.'
  },
  DUPLICATE: {
    tieuDe: 'Trùng với bản ghi đã có',
    cachSua: 'Giá trị vừa nhập (seri/TID/mã…) đã tồn tại. Tìm bản ghi cũ bằng ô tìm kiếm — cần sửa thì sửa bản cũ, đừng tạo thêm bản mới.'
  },
  DUPLICATE_TRASH: {
    tieuDe: 'Trùng với bản ghi đang nằm trong Thùng rác',
    cachSua: 'Vào màn Thùng rác: hoặc KHÔI PHỤC bản cũ để dùng lại, hoặc xoá vĩnh viễn nó rồi tạo mới.'
  },
  INVALID_STATE: {
    tieuDe: 'Trạng thái hiện tại không cho phép thao tác này',
    cachSua: 'Xem cột trạng thái của bản ghi — làm đúng bước trước đã (vd máy phải THU HỒI về kho rồi mới xoá/giao nhà khác).'
  },
  ALREADY_DELIVERED: {
    tieuDe: 'Máy/TID đã giao rồi',
    cachSua: 'Không giao lại được khi đang giao. Muốn đổi nơi giao: thu hồi trước (Quản Lý Máy POS → Thu hồi) rồi giao lại.'
  },
  DEVICE_HAS_TID: {
    tieuDe: 'Máy đang gắn TID',
    cachSua: 'Gỡ TID khỏi máy trước (màn Quản Lý TID → bỏ gán), rồi mới thao tác tiếp với máy.'
  },
  TID_ON_DEVICE: {
    tieuDe: 'TID đang gắn trên máy khác',
    cachSua: 'Một TID chỉ nằm trên một máy. Gỡ TID khỏi máy cũ trước, hoặc chọn TID khác.'
  },
  BANK_MISMATCH: {
    tieuDe: 'Ngân hàng không khớp',
    cachSua: 'TID/thẻ/máy phải cùng ngân hàng. Kiểm tra lại ngân hàng của từng bên rồi chọn cho khớp.'
  },
  MACHINE_BLANK: {
    tieuDe: 'Máy chưa cài app ngân hàng',
    cachSua: 'Vào phiếu nhập máy (Quản Lý Nhập Máy POS) khai "Cài app" cho máy này trước, rồi làm lại.'
  },
  NO_WAREHOUSE: {
    tieuDe: 'Chưa có kho để nhận máy',
    cachSua: 'Tạo/kích hoạt kho ở màn Quản Lý Kho trước, rồi thu hồi/nhập máy lại.'
  },
  WAREHOUSE_NO_ADDRESS: {
    tieuDe: 'Kho chưa khai địa chỉ',
    cachSua: 'Vào màn Quản Lý Kho điền địa chỉ cho kho này rồi làm lại.'
  },
  USE_SALE_FLOW: {
    tieuDe: 'Thao tác này phải đi đường BÁN MÁY',
    cachSua: 'Dùng nút Bán máy (có giá bán + người mua) thay vì giao thường — hệ thống cần ghi tiền bán.'
  },
  SO_LECH_SAU_GHI: {
    tieuDe: 'ĐÃ ghi vào sổ nhưng số đọc lại KHÔNG khớp màn hình',
    cachSua: 'KHÔNG ghi lại lần nữa. Chụp màn hình kèm mã lô trong câu lý do rồi báo kỹ thuật đối chiếu ngay.'
  },
  IN_USE: {
    tieuDe: 'Bản ghi đang được nơi khác dùng',
    cachSua: 'Không xoá/đổi được khi còn chỗ khác trỏ tới (máy đang gắn TID, danh mục đang có bản ghi dùng…). Gỡ hết chỗ đang dùng trước rồi làm lại.'
  },
  INTERNAL_ERROR: {
    tieuDe: 'Máy chủ gặp lỗi khi xử lý',
    cachSua: 'Bấm Làm mới kiểm tra thao tác đã vào sổ chưa TRƯỚC KHI làm lại (tránh ghi 2 lần). Lặp lại ≥2 lần thì chụp màn hình báo kỹ thuật.'
  },
  UNAUTHORIZED: {
    tieuDe: 'Phiên đăng nhập đã hết',
    cachSua: 'Đăng nhập lại. Dữ liệu đang gõ dở trên form sẽ mất — chụp màn hình lại nếu cần.'
  }
};

export interface KetQuaLoi { ok?: boolean; error?: string; message?: string }

/**
 * Dựng thông điệp lỗi ĐẦY ĐỦ: lý do + CÁCH SỬA + mã lỗi. `viecGi` là việc đang làm ("Giao máy",
 * "Lưu máy POS") để câu mở đầu không chung chung. `bangRieng` cho màn có mã đặc thù (vd Doanh Số).
 */
export function dungThongDiepLoi(
  res: KetQuaLoi | null | undefined,
  viecGi: string,
  bangRieng?: Record<string, { tieuDe: string; cachSua: string }>
): { tieuDe: string; noiDung: string } {
  const ma = String(res?.error ?? '');
  const hd = (bangRieng && bangRieng[ma]) || HUONG_DAN_LOI_CHUNG[ma];
  const lyDo = res?.message
    ?? (ma
      ? viecGi + ' bị máy chủ từ chối (không kèm lý do chi tiết).'
      : viecGi + ' không nhận được trả lời hợp lệ từ máy chủ — có thể mất mạng giữa chừng hoặc app/máy chủ lệch phiên bản.');
  const cachSua = hd?.cachSua
    ?? (ma
      ? 'Mã lỗi này chưa có hướng dẫn — chụp màn hình kèm mã lỗi bên dưới gửi kỹ thuật.'
      : 'Kiểm tra mạng, bấm Làm mới xem thao tác đã vào sổ chưa rồi mới làm lại. Vẫn lỗi thì chụp màn hình báo kỹ thuật.');
  return {
    tieuDe: hd?.tieuDe ?? (viecGi + ' thất bại' + (ma ? ' — mã ' + ma : '')),
    noiDung: lyDo + XD + XD + 'CÁCH SỬA: ' + cachSua + XD + '(mã lỗi: ' + (ma || 'KHÔNG RÕ') + ')'
  };
}

/** Gọi thẳng với toast: `baoLoi(toast.alert, res, 'Giao máy')`. */
export function baoLoi(
  alert: (message: string, title?: string) => void,
  res: KetQuaLoi | null | undefined,
  viecGi: string,
  bangRieng?: Record<string, { tieuDe: string; cachSua: string }>
): void {
  const t = dungThongDiepLoi(res, viecGi, bangRieng);
  alert(t.noiDung, t.tieuDe);
}
