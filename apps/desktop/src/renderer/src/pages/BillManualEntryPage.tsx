// NHẬP BILL LẺ THỦ CÔNG (Admin Demo 6/11) — màn nhập tay 1 bill lẻ khi KHÔNG có ảnh để OCR.
//
// NGUYÊN TẮC "CHUNG 1 NGUỒN" (Admin Demo chốt 6/11): bill nhập tay đi ĐÚNG đường của bill OCR —
// createLoFromBillTid() (apps/bot-api/src/lo-service.ts) → tạo LÔ có billKey → bridge sinh Transaction.
// KHÔNG tạo Transaction trần (sẽ vô hình với báo cáo lô + không dedup được với bill OCR gửi sau = doanh số x2).
//
// TIỀN HỦY (cùng luật bill OCR 0.6.180): doanh số ghi = TỔNG QUẸT − TIỀN HỦY; PHÍ tính trên số ĐÃ TRỪ,
// không phải trên tổng quẹt (không trừ thì ghi thừa đúng bằng phần đã hủy — ca thật lô 75 thừa 11.000đ).
//
// PHÍ BÁN (Admin Demo 6/11 "set riêng theo TID"): phí bán THỰC TẾ nằm ở tid_sell_fees khóa (TID × loại thẻ ×
// LOẠI PHÍ) ⇒ bảng phí đổi theo CẢ loại phí (Đối ứng / Tiền chờ / Uỷ quyền / Đầu tư) LẪN loại thẻ.
// Chọn loại thẻ bằng ô danh sách; bảng dưới chỉ để ĐỐI CHIẾU % của mọi thẻ.
//
// BỐ CỤC (Admin Demo 6/11): 2 chế độ trên CÙNG 1 trang, mỗi chế độ GỌN 1 TRANG, không tràn, không cuộn trang:
//   • DANH SÁCH bill (mặc định) — lọc theo TID / HKD / đại lý / NĐT / ngân hàng / loại thẻ / loại phí.
//   • NHẬP bill — mở bằng nút "Thêm bill mới"; ghi xong tự về danh sách, dòng mới tô sáng (cập nhật NGAY).
// Bảng dài cuộn TRONG khung riêng, KHÔNG cuộn cả trang (đúng khuôn .list-scroll của app).
//
// TRẠNG THÁI FILE NÀY: bản MẪU DEMO để Admin Demo nhìn/điền thử TRƯỚC khi wiring backend (R200 — gate ảnh cuối).
// CHƯA gắn vào App.tsx, CHƯA gọi route ghi thật. Nút "Ghi nhận" dựng payload + thêm vào danh sách tại chỗ;
// BẢN THẬT: ghi xong → nạp lại danh sách từ máy chủ + kênh realtime đẩy cho mọi máy đang mở.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type KeyboardEvent as RKeyboardEvent } from 'react';
import { Loader2, Receipt, Store, CreditCard, KeyRound, Eraser, Save, Hash, Plus, ArrowLeft, FileSpreadsheet, Pencil, Trash2, CheckCircle2, FilterX, RefreshCw, Activity, ArrowDownWideNarrow, ArrowUpNarrowWide, BarChart3, Minus, Maximize2, CalendarRange, TrendingUp } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { groupDigits } from '@sigma/shared';
// Phí tiền PHẢI tính bằng hàm dùng chung của backend (BigInt-safe), client CẤM tự chế công thức float.
// Nhập theo ĐƯỜNG CON: `@sigma/business-rules` (index) kéo theo backup.rules.ts dùng `node:crypto` nên
// rollup KHÔNG bundle được cho trình duyệt. transaction.rules là logic thuần, không chạm Node.
import { marginToAmount } from '@sigma/business-rules/transaction.rules';
import type { ConfigTidDto, CardTypeDto, FeeTypeDto, TidSellFeeRowDto, UserDto, BankDto } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { Field, inputCls } from '../components/Field.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { CardBrandBadge } from '../components/CardBrandBadge.js';
import { Button } from '../components/Button.js';
// [PHÍM TẮT 24/11] Logic THUẦN + cấu hình per-user (lib/shortcut.ts, có unit test số thật).
import {
  loadConfig as loadShortcutConfig,
  isKeyEnabled as ptBat,
  confirmPressesFor as ptSoLan,
  escAction as ptEsc,
  initPress as ptInit,
  pressOnce as ptPress,
  sortRefundByKey as ptSapNguoiHoan,
  refundDigitMapForOptions as ptDigitMap,
  refundDigitForUser as ptPhimCuaNguoi,
  type ShortcutConfig,
  type PressState
} from '../lib/shortcut.js';
import { SHORTCUT_CFG_EVENT } from './ShortcutConfigPage.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Modal } from '../components/Modal.js';
import { FilterBar, type FilterItem } from '../components/FilterBar.js';
import { MultiSelect } from '../components/MultiSelect.js';
import { thChuan, tdChuan, tdTien, tdTongChuan, trChuan, trTongChuan, theadChuan, tfootChuan } from '../components/BangChuan.js';
import { exportCsv, exportNhieuFile, exportNhieuSheet } from '../lib/exportCsv.js';

/** VND, nhóm 3 số bằng dấu chấm (KHÔNG toLocaleString — R_UI QA gate). Giữ dấu âm. */
function money(n: number): string {
  const neg = n < 0;
  const s = Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '−' : '') + s + 'đ';
}
/** CA TIỀN VỀ theo NGÂN HÀNG — mốc giờ lấy ĐÚNG từ packages/services/src/ca-tien.ts (nguồn duy nhất,
 *  Admin Demo cung cấp 5/9):  MB 09:40/16:40 · ABB 09:50/14:50 · MBV 11:50/17:50. Bank ngoài bảng → null.
 *  BẢN THẬT: ca do MÁY CHỦ trả trong DTO (gọi caCuaGio) — KHÔNG nhân bản mốc ở client như demo này. */
const MOC_CA: Record<string, [number, number]> = {
  MB: [9 * 60 + 40, 16 * 60 + 40],
  ABB: [9 * 60 + 50, 14 * 60 + 50],
  MBV: [11 * 60 + 50, 17 * 60 + 50]
};
function khoaBankCa(bank: string): string | null {
  const b = (bank ?? '').trim().toUpperCase();
  if (!b) return null;
  if (b === 'MBV' || b.startsWith('MBV')) return 'MBV';
  if (b === 'ABB' || b.startsWith('ABB') || b === 'AB BANK' || b.startsWith('AB ')) return 'ABB';
  if (b === 'MB' || b === 'MBB' || b.startsWith('MB ') || b === 'MBBANK') return 'MB';
  return null;
}
/** Phút-trong-ngày từ chuỗi giờ 'HH:MM'; đọc không ra → null. */
function phutCuaGio(gio: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(gio ?? '');
  if (!m) return null;
  const phut = Number(m[1]) * 60 + Number(m[2]);
  return phut >= 0 && phut <= 1439 ? phut : null;
}
/**
 * [B189 19/11 — Admin Demo "logic bắt buộc khi thêm bill mới vào giờ ca tiền nào hiện ca tiền đó"]
 * CA của bill. Ưu tiên MỐC CA KHAI TRONG MÀN QUẢN LÝ NGÂN HÀNG (`dsCa` của chính ngân hàng đó); ngân hàng
 * chưa khai ca thì rơi về bảng mốc CỨNG cũ (MB/ABB/MBV) để không đổi hành vi những máy đang chạy.
 * Trả `{ ten, thuTu }` — tên ca do người dùng tự đặt nên không ép về 1/2/3 nữa.
 */
/**
 * [B258 23/11 — Admin Demo "tất cả các lỗi khi thêm bill mà bị chặn phải hiển thị rõ lỗi, dễ hiểu để
 * người dùng fix"] BẢNG HƯỚNG DẪN SỬA theo MÃ LỖI máy chủ trả về.
 *
 * Luật: máy chủ nói CÁI GÌ SAI (message), bảng này nói SỬA Ở ĐÂU (cachSua). Người nhập bill không phải
 * đoán, không phải đi hỏi. Mã lỗi NÀO CŨNG phải có mục ở đây — cổng `_kiem-loi-them-bill-ro-rang.mjs`
 * đối chiếu với mã lỗi trong mã nguồn máy chủ, thiếu một mã là ĐỎ.
 */
/** Ký tự xuống dòng — viết thẳng 
 trong chuỗi bị công cụ sửa mã nuốt mất, gây lỗi chuỗi hở. */
const XUONG_DONG = String.fromCharCode(10);

const HUONG_DAN_LOI: Record<string, { tieuDe: string; cachSua: string }> = {
  VALIDATION: { tieuDe: 'Thiếu/sai thông tin trên form', cachSua: 'Sửa đúng ô vừa được nêu ở trên rồi bấm Ghi nhận bill lại.' },
  DONG_BO_GD_LOI: { tieuDe: 'Bill đã sửa nhưng GIAO DỊCH kèm theo chưa đồng bộ', cachSua: 'ĐỪNG ghi lại bill lần nữa (sẽ đếm hai lần). Chụp màn hình kèm mã lô rồi báo kỹ thuật — doanh số của bill này có thể chưa vào báo cáo cho tới khi giao dịch được hàn lại.' },
  SUA_BILL_THIEU_KHOA: { tieuDe: 'Bill đang sửa không có số lô/số hóa đơn để nhận dạng', cachSua: 'Điền SỐ LÔ thật (khác 0) hoặc SỐ HÓA ĐƠN in trên bill rồi ghi lại — thiếu cả hai thì máy chủ không biết sửa bill nào, dễ đẻ ra bill thứ hai.' },
  SO_LO_QUA_LON: { tieuDe: 'Số lô không ghi được vào sổ', cachSua: 'Gõ lại đúng số lô in trên bill: chỉ gồm chữ số, không dấu chấm/phẩy/khoảng trắng, tối đa 2.147.483.647. Số dài hơn thường là gõ nhầm sang mã giao dịch.' },
  SUA_BILL_LOI_GHI_PHU: { tieuDe: 'Sửa bill lỗi ở bước lưu thông tin phụ — bill CŨ VẪN CÒN', cachSua: 'Doanh số không mất gì cả. Kiểm lại các ô vừa đổi (hay gặp: SỐ LÔ hoặc SỐ HÓA ĐƠN gõ quá dài, ghi chú dán ký tự lạ) rồi bấm Ghi nhận bill lại.' },
  FORBIDDEN: { tieuDe: 'Tài khoản không đủ quyền', cachSua: 'Nhờ quản trị cấp quyền GHI DOANH SỐ (màn Quản Lý Nhân Sự → vai trò), rồi đăng nhập lại.' },
  NOT_FOUND: { tieuDe: 'Không tìm thấy dữ liệu liên quan', cachSua: 'Bấm "Làm mới" để tải lại danh sách TID/bill rồi thử lại. TID vừa xoá thì phải khai lại ở màn Quản Lý TID.' },
  NO_PARTNER: { tieuDe: 'TID chưa gắn đối tác', cachSua: 'Vào Quản Lý TID → sửa TID này → chọn ĐỐI TÁC, lưu rồi ghi bill lại.' },
  CARD_BANK_MISMATCH: { tieuDe: 'Loại thẻ không thuộc ngân hàng của TID', cachSua: 'Chọn lại LOẠI THẺ đúng ngân hàng của máy (bảng phí ngay dưới ô TID chỉ liệt kê thẻ hợp lệ).' },
  NO_FEE_RATE: { tieuDe: 'Chưa có biểu phí tại ngày bill', cachSua: 'Vào Quản Lý Ngân Hàng - Đối Tác → Biểu phí, khai PHÍ MUA và PHÍ CÀI MÁY có ngày hiệu lực ≤ ngày bill.' },
  NO_SELL_QUOTE: { tieuDe: 'Chưa có giá bán niêm yết tại ngày bill', cachSua: 'Vào Quản Lý Ngân Hàng - Đối Tác → Giá bán niêm yết, khai cho ĐÚNG loại phí + loại thẻ, hiệu lực ≤ ngày bill.' },
  NO_ACTUAL_SELL_FEE: { tieuDe: 'TID chưa có giá bán thực tế', cachSua: 'Bấm nút "Dùng giá niêm yết làm giá bán" ngay trên form này, hoặc vào Quản Lý TID → Phí bán thực tế để khai giá cho TID.' },
  TID_NOT_IN_AGENT_SCOPE: { tieuDe: 'TID không thuộc phạm vi đại lý', cachSua: 'Kiểm lại máy này đang giao cho đại lý nào (Quản Lý TID → Giao khách). Nếu là bill MƯỢN máy thì bật ô "Mượn TID" và chọn đại lý mượn.' },
  DUP_SUSPECT: { tieuDe: 'Nghi trùng doanh số — CHƯA ghi', cachSua: 'Đối chiếu số lô / số hóa đơn với bill đã có. Chắc chắn là bill khác thì tích ô "xác nhận trùng" rồi ghi lại.' },
  SO_LECH_SAU_GHI: { tieuDe: 'SỐ LỆCH SAU KHI GHI — kiểm tra ngay', cachSua: 'Bill ĐÃ vào sổ nhưng số khác màn hình. Bấm "Làm mới", đối chiếu bill vừa ghi; lệch thật thì báo ngay, ĐỪNG ghi lại kẻo thành 2 bill.' },
  MULTI_ROW_LO: { tieuDe: 'Lô có nhiều loại thẻ', cachSua: 'Bill tách thẻ phải sửa bằng chức năng tách thẻ trên chính bill đó, không ghi đè bằng bill thường.' },
  BILL_IMMUTABLE: { tieuDe: 'Bill đã khoá, không sửa được', cachSua: 'Bill đã đối soát/đã chốt kỳ. Muốn đổi phải yêu cầu hủy (có người duyệt) rồi nhập lại.' },
  TXN_CANCELLED: { tieuDe: 'Giao dịch đã bị hủy', cachSua: 'Bill này đã hủy — nhập bill MỚI thay vì sửa bill đã hủy.' },
  TXN_HAS_SETTLEMENT: { tieuDe: 'Giao dịch đã có đối soát', cachSua: 'Gỡ/đối chiếu lại phần đối soát trước, rồi mới sửa bill.' },
  ALREADY_CANCELLED: { tieuDe: 'Bill đã hủy trước đó', cachSua: 'Bấm "Làm mới" để thấy trạng thái mới nhất; cần số liệu thì nhập bill mới.' },
  CONFLICT: { tieuDe: 'Dữ liệu vừa bị người khác đổi', cachSua: 'Bấm "Làm mới" rồi thao tác lại trên dữ liệu mới nhất.' },
  CUSTOMER_INACTIVE: { tieuDe: 'Đại lý/khách đang ngừng hoạt động', cachSua: 'Bật lại khách ở màn Quản Lý Hồ Sơ/Khách hàng, hoặc chọn đại lý khác.' },
  QR_FEE_INVALID: { tieuDe: 'Phí mã QR không hợp lệ', cachSua: 'Khai lại phí cho mã QR ở màn QR → Giá bán, rồi ghi lại.' },
  NO_ROW: { tieuDe: 'Lô không có dòng dữ liệu', cachSua: 'Lỗi hệ thống — chụp màn hình gửi kỹ thuật, ĐỪNG ghi lại nhiều lần.' },
  EXCEPTION: { tieuDe: 'Máy chủ gặp lỗi khi ghi', cachSua: 'Chụp màn hình (có cả dòng lỗi) gửi kỹ thuật. Kiểm tra lại danh sách trước khi ghi lại để tránh ghi 2 lần.' },
  INTERNAL_ERROR: { tieuDe: 'Máy chủ gặp lỗi khi ghi', cachSua: 'Chụp màn hình (có cả dòng lỗi) gửi kỹ thuật. Kiểm tra lại danh sách trước khi ghi lại để tránh ghi 2 lần.' }
};

function caCuaBill(
  bank: string,
  gio: string,
  dsCa?: { ten: string; tuPhut: number; denPhut: number }[]
): { ten: string; thuTu: number } | null {
  const phut = phutCuaGio(gio);
  if (phut == null) return null;
  if (dsCa && dsCa.length > 0) {
    const sx = [...dsCa].sort((a, b) => a.tuPhut - b.tuPhut);
    const i = sx.findIndex((c) => phut >= c.tuPhut && phut <= c.denPhut);
    return i >= 0 ? { ten: sx[i].ten, thuTu: i + 1 } : null;
  }
  const k = khoaBankCa(bank);
  if (!k) return null;
  const [c1, c2] = MOC_CA[k];
  const n = phut <= c1 ? 1 : phut <= c2 ? 2 : 3;
  return { ten: 'Ca ' + n, thuTu: n };
}

/** Viết tắt LOẠI PHÍ cho bảng chật (Admin Demo 6/11): Đối ứng → Đ/Ư · Tiền chờ → T/C · Uỷ quyền → U/Q.
 *  Tên nào ngoài 3 loại này thì GIỮ NGUYÊN (không tự bịa viết tắt). */
function viTatLoaiPhi(ten: string): string {
  const t = (ten ?? '').trim().toLowerCase();
  if (t === 'đối ứng') return 'Đ/Ư';
  if (t === 'tiền chờ') return 'T/C';
  if (t === 'uỷ quyền' || t === 'ủy quyền') return 'U/Q';
  return ten;
}
/** 'YYYY-MM-DD' → 'DD/MM' (bảng chật nên bỏ năm; năm đầy đủ nằm ở tooltip dòng). */
function ngayNgan(iso: string): string {
  const p = (iso || '').split('-');
  return p.length === 3 ? p[2] + '/' + p[1] : iso;
}
/** % từ số thường (1.42 → "1,42%"); null → "—". Dấu phẩy thập phân kiểu VN. */
function pctText(v: number | null): string {
  if (v == null) return '—';
  return goNhieuSo(v) + '%';
}
/** LƯỚI AN TOÀN hiển thị số %: `String(1.38)` có thể ra "1.3800000000000001" nếu số sinh ra từ phép cộng
 *  số thực (đã cắn 21/11: cột % Bán tràn đè sang cột bên). Cắt tối đa 4 chữ số thập phân rồi bỏ số 0 thừa. */
function goNhieuSo(v: number): string {
  return Number(v.toFixed(4)).toString().replace('.', ',');
}
/**
 * [B233 22/11 — Admin Demo "ngoài visa mt quá dài để là ngoài thôi cho gọn"] RÚT GỌN TÊN THẺ khi xuất Excel.
 * Cắt phần sau dấu gạch: "Ngoài MB-Visa-Master" → "Ngoài MB". CỐ Ý GIỮ chữ sau "Ngoài" vì sổ thật có
 * BA loại khác nhau — Ngoài MB · Ngoài Napas · Ngoài VP — PHÍ KHÁC NHAU; rút trụi thành "Ngoài" là gộp
 * nhầm ba loại, nhìn báo cáo không biết đang tính phí nào.
 */
function tenTheNgan(s: string): string {
  const t = (s ?? '').trim();
  const i = t.indexOf('-');
  return i > 0 ? t.slice(0, i).trim() : t;
}
/** [B225 21/11 — Admin Demo "% cài máy bỏ % đi, để 1.21 chỉ để số thôi"] CHỈ SỐ, không đuôi %.
 *  Dùng cho 3 cột % CM · % Bán · % Mua — tiêu đề cột đã nói rõ là phần trăm rồi, lặp lại chỉ tốn bề ngang. */
function pctSo(v: number | null): string {
  if (v == null) return '—';
  return goNhieuSo(v);
}
/** SỐ LÔ HIỂN THỊ — khuôn loHienThi() của lo-service: có mã đóng lô → "84(95)", không có → "84". */
function loHienThi(lo: string, maDongLo: string): string {
  const b = lo.trim();
  const sc = maDongLo.replace(/[^0-9]/g, '');
  if (!b) return '';
  return sc ? b + '(' + sc + ')' : b;
}
/** Ngày HCM 'YYYY-MM-DD' — khuôn hcmDayKey() của lo-service (lô ngân hàng RESET mỗi ngày nên ngày nằm trong khóa). */
function hcmDayKey(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}
/**
 * Lọc ô NHẬP SỐ: chỉ giữ chuỗi chữ số từ ĐẦU, CẮT ở ký tự lạ đầu tiên.
 * KHÔNG dùng `replace(/[^\d]/g,'')` vì nó GHÉP các cụm số hai bên chữ cái: gõ nhầm "12abc34" ra
 * 1.234 — một số người dùng chưa từng gõ. Dấu trừ cũng bị nuốt im ("-5000000" thành 5.000.000).
 */
function chiSo(v: string): string {
  // Ô tiền HIỂN THỊ có dấu chấm nhóm nghìn (1.000). Gõ tiếp 1 chữ số thì chuỗi vào đây là "1.0005" —
  // nếu cắt ngay ở ký tự lạ đầu tiên thì còn "1", TIỀN BỐC HƠI ngay khi vượt 1.000 (Admin Demo bắt được
  // 7/11; bài kiểm cũ chỉ thử DÁN cả chuỗi nên không thấy). Phải BỎ dấu nhóm trước, rồi mới cắt.
  const khongDauNhom = v.replace(/[.,\s ]/g, '');
  const m = /^(\d*)/.exec(khongDauNhom);
  return m ? m[1] : '';
}
/** Chuẩn hoá số in trên bill (lô / số HĐ): bỏ khoảng trắng và số 0 dẫn đầu — DÙNG CHUNG cho cả
 *  XEM TRƯỚC khóa bill lẫn payload gửi máy chủ, để 2 bên không bao giờ lệch nhau (lỗi N4). */
function chuanSoBill(v: string): string {
  // [B271 24/11] Bỏ số 0 dẫn đầu nhưng GIỮ LẠI MỘT CHỮ SỐ: "007"→"7", nhưng "0"→"0" (trước đây ra chuỗi
  // RỖNG ⇒ khoá bill null ⇒ sửa bill là đẻ lô mới, doanh số đếm 2 lần).
  return (v || '').trim().replace(/^0+(?=\d)/, '');
}
/** XEM TRƯỚC khóa bill — khuôn buildBillKey() của lo-service: nat|<tid>|<lô(mã)>|<số HĐ>|<ngày>. */
function billKeyPreview(tid: string, lo: string, maDongLo: string, soHoaDon: string, ngay: string, gio: string): string | null {
  const norm = (s: string): string => s.trim().toLowerCase();
  // [N4] Phải chuẩn hoá ĐÚNG như payload gửi máy chủ (bỏ 0 dẫn đầu), nếu không khóa người ký duyệt
  // nhìn thấy khác khóa máy chủ dựng ⇒ dedup chống doanh số x2 lệch nhau.
  const batch = norm(loHienThi(chuanSoBill(lo), maDongLo));
  const invoice = norm(chuanSoBill(soHoaDon));
  if (!batch && !invoice) return null;
  const base = ['nat', norm(tid), batch, invoice].join('|');
  if (!ngay || !gio) return base;
  const d = new Date(ngay + 'T' + gio + ':00');
  return Number.isNaN(d.getTime()) ? base : base + '|' + hcmDayKey(d);
}

/** Ô GIỜ 24h tự chế (Admin Demo 6/11) — KHÔNG dùng <input type="time">: Chromium render theo locale máy nên ra
 *  "12:00 SA" (12 giờ sáng/chiều), trong khi bill POS in giờ 24h ⇒ người nhập dễ lệch buổi, mà giờ bill quyết
 *  định doanh số rơi vào ngày nào. Cùng khuôn DateInput của app (tách ô số, tự kiểm). value/onChange "HH:mm". */
function GioInput({ value, onChange, onLoi }: { value: string; onChange: (v: string) => void; onLoi?: (loi: boolean) => void }): JSX.Element {
  // LỖI (Admin Demo 6/11 "không điền được giờ"): bản trước ép padStart/clamp NGAY trong onChange ⇒ gõ "1" bị
  // biến thành "01" rồi maxLength=2 chặn chữ số thứ hai ⇒ không gõ nổi giờ. Nay giữ CHUỖI THÔ trong lúc gõ,
  // chỉ chuẩn hoá khi rời ô (blur); vẫn báo ra ngoài ngay khi đọc được số hợp lệ.
  const [hRaw, setHRaw] = useState(() => (value || '00:00').split(':')[0]);
  const [mRaw, setMRaw] = useState(() => (value || '00:00').split(':')[1] ?? '00');
  // [LỖI Admin Demo 6/11 lần 2 — "02:01", gõ chậm là hỏng] Effect này đồng bộ ngược từ `value`, mà mỗi lần gõ
  // 1 chữ số ta lại báo value ra ngoài ⇒ value quay lại đè chuỗi đang gõ ("1" → "01") rồi maxLength chặn chữ
  // số thứ hai. Chỉ đồng bộ khi value đổi TỪ BÊN NGOÀI (khác giá trị chính mình vừa báo) và KHÔNG đang gõ.
  const vuaBao = useRef('');
  const dangGo = useRef(false);
  useEffect(() => {
    if (dangGo.current || value === vuaBao.current) return;
    const [h, m] = (value || '00:00').split(':');
    setHRaw(h);
    setMRaw(m ?? '00');
  }, [value]);

  const bao = (h: string, m: string): void => {
    const hn = Number(h || 0);
    const mn = Number(m || 0);
    // [V3] KHÔNG kẹp khi đang SAI. Kẹp ở đây thì giá trị báo ra ngoài là 23:00 còn ô vẫn hiện 25 —
    // thu nhỏ rồi mở lại là ô dựng lại từ 23:00, giờ "tự đúng" và cảnh báo biến mất ÂM THẦM.
    // Giữ nguyên số sai để nó sống sót qua mọi lần dỡ/dựng; nút ghi đã bị `gioLoi` chặn rồi.
    const sai = hn > 23 || mn > 59;
    const H = sai ? Math.max(0, hn) : Math.min(23, Math.max(0, hn));
    const M = sai ? Math.max(0, mn) : Math.min(59, Math.max(0, mn));
    const v = String(H).padStart(2, '0') + ':' + String(M).padStart(2, '0');
    vuaBao.current = v;
    onChange(v);
  };
  const chuanHoa = (): void => {
    dangGo.current = false;
    const hn = Number(hRaw || 0);
    const mn = Number(mRaw || 0);
    // [V3] Rời ô mà giờ ĐANG SAI thì GIỮ NGUYÊN số sai + giữ cảnh báo đỏ. Bản trước kéo ngầm 25 → 23:
    // cảnh báo biến mất, bill ghi một giờ KHÁC giờ người nhập gõ mà không ai biết. Chỉ đệm 0 cho đẹp.
    const sai = hn > 23 || mn > 59;
    const H = sai ? hn : Math.min(23, Math.max(0, hn));
    const M = sai ? mn : Math.min(59, Math.max(0, mn));
    setHRaw(String(H).padStart(2, '0'));
    setMRaw(String(M).padStart(2, '0'));
    bao(String(H), String(M));
  };
  // [Admin Demo 6/11] Gõ 28 giờ / 75 phút phải BÁO ĐỎ NGAY, không đợi rời ô mới kéo về 23:59.
  const loiGio = hRaw !== '' && Number(hRaw) > 23;
  const loiPhut = mRaw !== '' && Number(mRaw) > 59;
  useEffect(() => {
    onLoi?.(loiGio || loiPhut);
  }, [loiGio, loiPhut, onLoi]);
  const o = inputCls + ' h-[38px] w-14 !border-slate-300 text-center tabular-nums shadow-sm';
  const oLoi = ' !border-danger ring-2 ring-danger/25';
  return (
    <div className="relative">
      <div className="flex items-center gap-1.5">
      <input
        className={o + (loiGio ? oLoi : '')}
        inputMode="numeric"
        maxLength={2}
        value={hRaw}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          dangGo.current = true;
          const v = e.target.value.replace(/[^\d]/g, '').slice(0, 2);
          setHRaw(v);
          if (v !== '') bao(v, mRaw);
        }}
        onBlur={chuanHoa}
        aria-label="Giờ"
      />
      <span className="text-slate-400">:</span>
      <input
        className={o + (loiPhut ? oLoi : '')}
        inputMode="numeric"
        maxLength={2}
        value={mRaw}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          dangGo.current = true;
          const v = e.target.value.replace(/[^\d]/g, '').slice(0, 2);
          setMRaw(v);
          if (v !== '') bao(hRaw, v);
        }}
        onBlur={chuanHoa}
        aria-label="Phút"
      />
      </div>
      {(loiGio || loiPhut) && (
        <span className="absolute left-0 top-full mt-0.5 whitespace-nowrap text-[11px] font-medium text-danger">
          {loiGio ? 'Giờ phải từ 00 đến 23' : 'Phút phải từ 00 đến 59'}
        </span>
      )}
    </div>
  );
}

/** 1 dòng số ở cột phải: nhãn trái — giá trị phải. */
function Dong({
  label,
  value,
  strong,
  danger,
  soc
}: {
  label: string;
  value: string;
  strong?: boolean;
  danger?: boolean;
  /** Dòng nền xen kẽ — để cột phải chia ô rõ, dễ dò (Admin Demo 6/11). */
  soc?: boolean;
}): JSX.Element {
  return (
    // Mỗi dòng = 1 HÀNG CÓ VIỀN THẬT, chia 2 ô (nhãn | số) — Admin Demo 6/11 "chia ô, cột rõ ràng".
    <div className={'grid grid-cols-[1fr_auto] items-stretch border-b border-slate-200 last:border-b-0 ' + (soc ? 'bg-slate-50' : 'bg-white')}>
      <span className="px-2.5 py-1.5 text-xs text-slate-600">{label}</span>
      <span
        className={
          'min-w-[124px] border-l border-slate-200 px-2.5 py-1.5 text-right text-sm tabular-nums ' +
          (strong ? 'font-bold text-brand' : danger ? 'font-semibold text-danger' : 'font-medium text-slate-800')
        }
      >
        {(value || '—').replace('đ', '')}
      </span>
    </div>
  );
}

/** Biểu đồ cột tăng trưởng — SVG thuần (không thư viện ngoài). Trục Y tự chia 5 vạch theo số lớn nhất;
 *  rê chuột vào cột hiện bảng nhỏ: mốc · doanh thu · số hóa đơn (đúng khuôn Admin Demo gửi). */
function BieuDoCot({ duLieu }: { duLieu: { khoa: string; nhan: string; tien: number; soBill: number }[] }): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  // Bộ số đổi (ngày↔tháng, đổi kỳ, đổi bộ lọc) ⇒ index đang rê chuột KHÔNG còn nghĩa gì. Phải xoá,
  // nếu không duLieu[hover] là undefined và cả biểu đồ sập (agent đối kháng 6/11, bug #5).
  useEffect(() => setHover(null), [duLieu]);
  if (duLieu.length === 0) return <p className="py-10 text-center text-sm text-slate-400">Không có dữ liệu trong kỳ đang chọn.</p>;
  const W = 1180;
  const H = 440;
  const LE_T = 110;
  const LE_P = 16;
  const LE_TREN = 14;
  const LE_DUOI = 42;
  const maxTien = Math.max(...duLieu.map((d) => d.tien), 1);
  const buocY = Math.ceil(maxTien / 5 / 1_000_000) * 1_000_000 || 1;
  const dinh = buocY * 5;
  const rongVung = W - LE_T - LE_P;
  const caoVung = H - LE_TREN - LE_DUOI;
  const bRong = Math.max(6, Math.min(40, (rongVung / duLieu.length) * 0.62));
  const khoang = rongVung / duLieu.length;
  const yCua = (v: number): number => LE_TREN + caoVung - (v / dinh) * caoVung;
  const soVn = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const oHover = hover != null ? duLieu[hover] ?? null : null;
  return (
    <div className="relative rounded-lg border border-line bg-white p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 'min(56vh, 460px)' }}>
        {Array.from({ length: 6 }, (_, i) => {
          const v = buocY * i;
          const y = yCua(v);
          return (
            <g key={i}>
              <line x1={LE_T} x2={W - LE_P} y1={y} y2={y} stroke="#e5e9f0" strokeWidth={1} />
              <text x={LE_T - 8} y={y + 4} textAnchor="end" fontSize={11} fill="#64748b">{soVn(v)}</text>
            </g>
          );
        })}
        <line x1={LE_T} x2={LE_T} y1={LE_TREN} y2={LE_TREN + caoVung} stroke="#cbd5e1" />
        {duLieu.map((d, i) => {
          const x = LE_T + khoang * i + (khoang - bRong) / 2;
          const y = yCua(d.tien);
          const cao = LE_TREN + caoVung - y;
          const buoc = Math.max(1, Math.ceil(duLieu.length / 22));
          return (
            <g key={d.khoa} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x} y={y} width={bRong} height={Math.max(1, cao)} fill={hover === i ? '#1763a5' : '#5b9bd5'} />
              <rect x={x} y={LE_TREN + caoVung - 4} width={bRong} height={4} fill="#e05252" />
              {i % buoc === 0 && (
                <text x={x + bRong / 2} y={H - 22} textAnchor="middle" fontSize={11} fill="#64748b">{d.nhan}</text>
              )}
              <rect x={LE_T + khoang * i} y={LE_TREN} width={khoang} height={caoVung} fill="transparent" />
            </g>
          );
        })}
      </svg>
      {/* Lớp chắn thứ 2 cho bug #5: chỉ vẽ bảng nổi khi hover TRỎ ĐÚNG một cột còn tồn tại. */}
      {oHover != null && (
        <div
          className="pointer-events-none absolute rounded-lg border border-line bg-white px-3 py-2 text-xs shadow-lg"
          style={{ left: `calc(${((LE_T + (rongVung / duLieu.length) * ((hover ?? 0) + 0.5)) / W) * 100}% - 90px)`, top: 12 }}
        >
          <div className="mb-1 text-center font-semibold text-slate-700">{oHover.nhan}</div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#5b9bd5]" />
            Doanh thu: <b className="tabular-nums text-slate-800">{soVn(oHover.tien)}</b>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#e05252]" />
            Số hóa đơn: <b className="tabular-nums text-slate-800">{oHover.soBill}</b>
          </div>
        </div>
      )}
    </div>
  );
}

/** Rút gọn VND sang "tỉ/tr" cho nhãn trục + ô to (giữ dấu chấm nghìn khi < 1 triệu). */
function tyGon(n: number): string {
  const a = Math.abs(n);
  const dau = n < 0 ? '−' : '';
  if (a >= 1_000_000_000) return dau + (a / 1_000_000_000).toFixed(a >= 10_000_000_000 ? 1 : 2).replace('.', ',') + ' tỉ';
  if (a >= 1_000_000) return dau + Math.round(a / 1_000_000).toString() + ' tr';
  return dau + Math.round(a).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * BIỂU ĐỒ CỘT KPI nhiều ngày — SVG THUẦN (không thư viện ngoài), nâng cấp từ BieuDoCot: gradient cột,
 * lưới ngang + nhãn trục Y (rút gọn tỉ/tr), nhãn trục X theo ngày, đỉnh cột bo góc, rê chuột hiện
 * doanh số + số hóa đơn. Mỗi NGÀY trong khoảng chọn = 1 cột (nguồn: /v1/kpi/doanh-so theoNgay).
 */
function BieuDoKpi({ duLieu }: { duLieu: { ngay: string; doanhSo: number; soBill: number }[] }): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => setHover(null), [duLieu]);
  if (duLieu.length === 0)
    return <p className="py-12 text-center text-sm text-slate-400">Không có bill nào trong khoảng ngày đang chọn.</p>;
  const W = 1180;
  const H = 440;
  const LE_T = 92;
  const LE_P = 18;
  const LE_TREN = 16;
  const LE_DUOI = 44;
  const maxTien = Math.max(...duLieu.map((d) => d.doanhSo), 1);
  const buocY = Math.ceil(maxTien / 5 / 1_000_000) * 1_000_000 || 1;
  const dinh = buocY * 5;
  const rongVung = W - LE_T - LE_P;
  const caoVung = H - LE_TREN - LE_DUOI;
  const khoang = rongVung / duLieu.length;
  const bRong = Math.max(6, Math.min(46, khoang * 0.64));
  const yCua = (v: number): number => LE_TREN + caoVung - (v / dinh) * caoVung;
  const oHover = hover != null ? duLieu[hover] ?? null : null;
  const buocNhan = Math.max(1, Math.ceil(duLieu.length / 24));
  const nhanNgay = (iso: string): string => iso.slice(8) + '/' + iso.slice(5, 7);
  return (
    <div className="relative rounded-xl border border-line bg-white p-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 'min(54vh, 440px)' }}>
        <defs>
          {/* [24/11 — Admin Demo "cột màu xấu"] Gradient brand SigMa 3 chặng: đỉnh sáng → thân → chân đậm,
              cho cột có chiều sâu/hiện đại thay vì phẳng 2 màu. */}
          <linearGradient id="kpiBar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6fb6f2" />
            <stop offset="45%" stopColor="#2f85cf" />
            <stop offset="100%" stopColor="#0f4e86" />
          </linearGradient>
          <linearGradient id="kpiBarHover" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#9ed0fb" />
            <stop offset="45%" stopColor="#3f93dd" />
            <stop offset="100%" stopColor="#0c3f6e" />
          </linearGradient>
          {/* Bóng đổ mềm dưới chân cột để tách khỏi nền trắng. */}
          <filter id="kpiBarShadow" x="-20%" y="-10%" width="140%" height="120%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="1.4" floodColor="#1763a5" floodOpacity="0.28" />
          </filter>
        </defs>
        {Array.from({ length: 6 }, (_, i) => {
          const v = buocY * i;
          const y = yCua(v);
          return (
            <g key={i}>
              <line x1={LE_T} x2={W - LE_P} y1={y} y2={y}
                stroke={i === 0 ? '#c3d3e3' : '#e7eff8'} strokeWidth={i === 0 ? 1.25 : 1}
                strokeDasharray={i === 0 ? undefined : '3 4'} />
              <text x={LE_T - 10} y={y + 4} textAnchor="end" fontSize={11} fontWeight={500} fill="#64748b">{tyGon(v)}</text>
            </g>
          );
        })}
        <line x1={LE_T} x2={LE_T} y1={LE_TREN} y2={LE_TREN + caoVung} stroke="#cbd5e1" />
        {duLieu.map((d, i) => {
          const x = LE_T + khoang * i + (khoang - bRong) / 2;
          const y = yCua(d.doanhSo);
          const cao = Math.max(2, LE_TREN + caoVung - y);
          const r = Math.min(5, bRong / 2);
          return (
            <g key={d.ngay} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x} y={y} width={bRong} height={cao} rx={r} ry={r}
                fill={hover === i ? 'url(#kpiBarHover)' : 'url(#kpiBar)'} filter="url(#kpiBarShadow)" />
              {i % buocNhan === 0 && (
                <text x={x + bRong / 2} y={H - 22} textAnchor="middle" fontSize={11} fill="#64748b">{nhanNgay(d.ngay)}</text>
              )}
              <rect x={LE_T + khoang * i} y={LE_TREN} width={khoang} height={caoVung} fill="transparent" />
            </g>
          );
        })}
      </svg>
      {oHover != null && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-line bg-white px-3 py-2 text-xs shadow-lg"
          style={{ left: `calc(${((LE_T + khoang * ((hover ?? 0) + 0.5)) / W) * 100}% - 96px)`, top: 14 }}
        >
          <div className="mb-1 text-center font-semibold text-slate-700">Ngày {nhanNgay(oHover.ngay)}</div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: 'linear-gradient(#6fb6f2,#0f4e86)' }} />
            Doanh số: <b className="tabular-nums text-slate-800">{money(oHover.doanhSo).replace('đ', '')}</b>
          </div>
          <div className="mt-0.5 text-slate-500">Số hóa đơn: <b className="tabular-nums text-slate-700">{oHover.soBill}</b></div>
        </div>
      )}
    </div>
  );
}

/** 1 bill đã ghi. BẢN THẬT: nạp từ máy chủ (lô của kỳ đang xem) + realtime đẩy thêm. */
interface BillDaGhi {
  id: string;
  ngay: string; // YYYY-MM-DD trên bill
  gio: string; // HH:mm trên bill
  tid: string;
  hkd: string;
  daiLy: string;
  ndt: string;
  bank: string;
  loaiThe: string;
  loaiPhi: string;
  lo: string;
  soHoaDon: string;
  tongQuet: number;
  tienHuy: number;
  tienLo: number;
  phiPct: number | null;
  caiMayPct: number | null; // % phí cài máy THEO LOẠI THẺ (fee_rates: đối tác × thẻ)
  muaPct: number | null; // % phí MUA (fee_rates) — dùng tính lãi: phí bán − phí mua
  /** [B236 22/11] % phí SigMa MUA của NĐT cho thẻ này (null = TID chưa khai). */
  phiMuaNdtPct?: number | null;
  /** [B237] Tiền còn lại sau khi trừ phí cài máy. */
  sauPhiCaiMay?: number | null;
  /** [B237] Tiền còn lại sau khi trừ phí mua NĐT (null = chưa khai phí mua NĐT). */
  sauMuaNdt?: number | null;
  /** Lãi NĐT = (phí mua NĐT − phí cài máy) × doanh số. Máy chủ tính — màn KHÔNG tính lại. */
  laiNdt?: number | null;
  /** SigMa thu phía bán = (phí bán − phí mua NĐT) × doanh số. */
  alphaBan?: number | null;
  /** SigMa thu phía đối tác = (phí mua đối tác − phí cài máy) × doanh số. */
  alphaDoiTac?: number | null;
  /** Tổng SigMa thu về = phía bán + phía đối tác. */
  alphaThu?: number | null;
  nhanVe: number;
  daHoan: number;
  nguoiHoan: string;
  nguoiHoanId?: number | null; // ID người hoàn — cần để mở Sửa mà KHÔNG mất vết ai trả tiền
  /** [B186 19/11] mã giao dịch của bill — cần để GỬI YÊU CẦU HỦY lên máy chủ (nút Xóa bill). */
  transactionId?: number | null;
  /** [B187 19/11] mã loại thẻ + mã ngân hàng — form SỬA nạp lại ĐÚNG thẻ/ngân hàng của bill.
   *  null ở cardTypeId = lô tách NHIỀU thẻ (không có một thẻ duy nhất để nạp). */
  cardTypeId?: number | null;
  bankId?: number | null;
  /** [B268 24/11] MÃ loại phí của bill — form SỬA nạp lại đúng loại phí (null = lô tách nhiều thẻ). */
  feeTypeId?: number | null;
  ghiChu: string;
  nguoiNhap: string; // ai gõ tay bill này (để truy vết, khác NGƯỜI HOÀN)
}

/** Giờ mặc định của form nhập bill — dùng CHUNG cho lúc khởi tạo và lúc dọn form. */
const GIO_MAC_DINH = '00:00';

/** HÔM NAY theo giờ TP.HCM — dữ liệu mẫu phải TRƯỢT theo ngày, cắm cứng ngày là qua nửa đêm màn trắng. */
const HOM_NAY_DEMO = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

// DỮ LIỆU MẪU DEMO — dựng từ TID/HKD/đại lý/NĐT/biểu phí THẬT đọc chỉ-đọc từ DB sigma ngày 6/11,
// để Admin Demo thử BỘ LỌC ngay mà không phải gõ tay. BẢN THẬT: danh sách nạp từ máy chủ.
const BILL_MAU: BillDaGhi[] = [
  { id: 'm1', ngay: HOM_NAY_DEMO, gio: '09:14', tid: 'DEMO-TID-01', hkd: 'HKD DEMO 1', daiLy: 'Đại lý A', ndt: 'NĐT 1', bank: 'MBV', loaiThe: 'Visa', loaiPhi: 'Đối ứng', lo: '82', soHoaDon: '000118', tongQuet: 30000000, tienHuy: 0, tienLo: 30000000, phiPct: 1.25, caiMayPct: 1.1, muaPct: 1.1, nhanVe: 29625000, daHoan: 29625000, nguoiHoan: 'Nhân viên A', nguoiHoanId: 91, ghiChu: 'khách gửi qua Zalo, không có ảnh', nguoiNhap: 'Nhân viên B' },
  { id: 'm2', ngay: HOM_NAY_DEMO, gio: '10:02', tid: 'DEMO-TID-01', hkd: 'HKD DEMO 1', daiLy: 'Đại lý A', ndt: 'NĐT 1', bank: 'MBV', loaiThe: 'Napas', loaiPhi: 'Đối ứng', lo: '83', soHoaDon: '000119', tongQuet: 20000000, tienHuy: 2000000, tienLo: 18000000, phiPct: 1.5, caiMayPct: 1.155, muaPct: 1.36, nhanVe: 17730000, daHoan: 10000000, nguoiHoan: 'Nhân viên C', nguoiHoanId: 92, ghiChu: 'bù bill thiếu của lô 82', nguoiNhap: 'Nhân viên C' },
  { id: 'm3', ngay: HOM_NAY_DEMO, gio: '11:30', tid: 'DEMO-TID-02', hkd: 'HKD DEMO 2', daiLy: 'Đại lý C', ndt: 'NĐT 2', bank: 'AB Bank', loaiThe: 'JCB', loaiPhi: 'Đối ứng', lo: '15(95)', soHoaDon: '000042', tongQuet: 45000000, tienHuy: 0, tienLo: 45000000, phiPct: 1.07, caiMayPct: 0.92, muaPct: 1.0, nhanVe: 44518500, daHoan: 0, nguoiHoan: '', ghiChu: '', nguoiNhap: 'Nhân viên D' },
  { id: 'm4', ngay: HOM_NAY_DEMO, gio: '13:05', tid: 'DEMO-TID-02', hkd: 'HKD DEMO 2', daiLy: 'Đại lý C', ndt: 'NĐT 2', bank: 'AB Bank', loaiThe: 'Visa', loaiPhi: 'Đối ứng', lo: '16', soHoaDon: '000043', tongQuet: 12000000, tienHuy: 0, tienLo: 12000000, phiPct: 1.17, caiMayPct: 1.02, muaPct: 1.1, nhanVe: 11859600, daHoan: 11859600, nguoiHoan: 'Nhân viên B', nguoiHoanId: 2, ghiChu: 'bill in mờ, nhập tay', nguoiNhap: 'Nhân viên B' },
  { id: 'm5', ngay: HOM_NAY_DEMO, gio: '14:40', tid: 'DEMO-TID-03', hkd: 'HKD DEMO 3', daiLy: 'Đại lý G', ndt: 'NĐT 2', bank: 'AB Bank', loaiThe: 'JCB', loaiPhi: 'Tiền chờ', lo: '9(95)', soHoaDon: '000210', tongQuet: 35000000, tienHuy: 1500000, tienLo: 33500000, phiPct: 1.15, caiMayPct: 0.92, muaPct: 1.0, nhanVe: 33114750, daHoan: 20000000, nguoiHoan: 'Nhân viên E', nguoiHoanId: 93, ghiChu: 'có 1 giao dịch hủy', nguoiNhap: 'Nhân viên E' },
  { id: 'm6', ngay: HOM_NAY_DEMO, gio: '15:22', tid: 'DEMO-TID-04', hkd: 'HKD DEMO 4', daiLy: 'Đại lý F', ndt: 'NĐT 2', bank: 'VP bank', loaiThe: 'VP', loaiPhi: 'Đối ứng', lo: '11', soHoaDon: '000007', tongQuet: 25000000, tienHuy: 0, tienLo: 25000000, phiPct: 1.42, caiMayPct: 1.08, muaPct: 1.16, nhanVe: 24645000, daHoan: 0, nguoiHoan: '', ghiChu: '', nguoiNhap: 'Nhân viên A' }
];

// Nhân thêm bản sao của 6 bill thật ở trên (đổi lô/số HĐ/giờ) CHỈ để demo có đủ dòng mà thử CUỘN + xem
// hàng TỔNG ghim đáy có đứng yên không. Không phải số liệu thật — bản thật nạp từ máy chủ.
/**
 * CHẾ ĐỘ DEMO — CHỈ bật trong bản dựng thử (harness đặt `window.__SIGMA_DEMO_BILL__ = true`).
 *
 * Vì sao phải gác: màn này ĐÃ nằm trong app thật nhưng CHƯA nối đường ghi của máy chủ. Nếu cứ nạp dữ
 * liệu mẫu thì app thật bày ra những dòng TIỀN KHÔNG CÓ THẬT — xoá đi, tải lại là chúng hiện về
 * (Admin Demo bắt được 7/11: "sao dữ liệu demo xóa đi vẫn còn?"). Nhìn nhầm thành doanh số thật là hỏng việc.
 * App thật: danh sách RỖNG + báo rõ "chưa nối máy chủ", không bịa một dòng nào.
 */
// ĐỌC LÚC CHẠY, không đọc lúc nạp module: `import` tĩnh chạy TRƯỚC câu lệnh đặt cờ trong bản dựng thử,
// nên nếu chốt ở cấp module thì cờ luôn là false và bản dựng thử mất sạch dữ liệu mẫu.
function laBanDemo(): boolean {
  return typeof window !== 'undefined' && (window as unknown as { __SIGMA_DEMO_BILL__?: boolean }).__SIGMA_DEMO_BILL__ === true;
}

const BILL_DEMO: BillDaGhi[] = [
  ...BILL_MAU,
  // Bản sao RẢI 20 NGÀY gần đây — CHỈ để xem biểu đồ tăng trưởng có hình dạng thật. Không phải số liệu thật.
  ...Array.from({ length: 60 }, (_, k) => {
    const g = BILL_MAU[k % BILL_MAU.length];
    const lui = Math.floor(k / 3) + 1; // mỗi ngày ~3 bill
    const d = new Date(HOM_NAY_DEMO + 'T00:00:00');
    d.setDate(d.getDate() - lui);
    const he = 0.6 + ((k * 37) % 90) / 100; // dao động cho cột cao thấp khác nhau
    const truoc = Math.round((g.tienLo * he) / 1000) * 1000;
    const ve = Math.round((truoc * (1 - (g.phiPct ?? 1.2) / 100)) / 100) * 100;
    return {
      ...g,
      id: 'n' + k,
      ngay: d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }),
      gio: String(8 + (k % 10)).padStart(2, '0') + ':' + String((k * 11) % 60).padStart(2, '0'),
      lo: String(200 + k),
      soHoaDon: String(800000 + k * 7).slice(-6),
      tongQuet: truoc,
      tienHuy: 0,
      tienLo: truoc,
      nhanVe: ve,
      daHoan: k % 3 === 0 ? ve : 0
    };
  }),
  ...Array.from({ length: 14 }, (_, k) => {
    const g = BILL_MAU[k % BILL_MAU.length];
    const h = 8 + (k % 10);
    return {
      ...g,
      id: 'd' + k,
      gio: String(h).padStart(2, '0') + ':' + String((k * 7) % 60).padStart(2, '0'),
      lo: g.lo.replace(/^(\d+)/, (m) => String(Number(m) + 100 + k)),
      soHoaDon: String(900000 + k * 13).slice(-6)
    };
  })
];

// ── GIỮ BẢN NHÁP BILL ĐANG GÕ (Admin Demo 16/11) ────────────────────────────────────────────────────────
// "hạ cửa sổ mini thêm bill, chuyển tác vụ khác, quay lại là MẤT luôn bill đang chuẩn bị thêm".
// Gốc: đổi menu ⇒ React tháo cả trang này ⇒ mọi useState bay sạch. Nay mỗi lần gõ là chép bản nháp ra
// localStorage; lúc trang dựng lại thì nạp về. XOÁ bản nháp khi: ghi xong 1 bill, hoặc người dùng bấm Xóa.
// CỐ Ý chỉ giữ Ô NGƯỜI DÙNG GÕ (không giữ danh sách/biểu phí — thứ đó phải nạp lại từ máy chủ cho tươi).
const KHOA_NHAP = 'alpha.bill-nhap-do';
interface BanNhapBill {
  cheDo: 'danhsach' | 'nhap';
  thuNho: boolean;
  bankChon: string; tidId: string; soHoaDon: string; soLo: string; maDongLo: string;
  ngay: string; gio: string; cardTypeId: string; feeTypeId: string;
  soTien: string; tienHuy: string; daHoan: string; nguoiHoanId: string; ghiChu: string;
  muonTid: boolean; daiLyMuonId: string; xacNhanMuon: boolean;
  tachThe: boolean; dongThe: { cardTypeId: string; tien: string }[];
  dangSuaId: string | null; gioDaDat: boolean;
}
function docBanNhap(): Partial<BanNhapBill> | null {
  try {
    const t = window.localStorage.getItem(KHOA_NHAP);
    if (!t) return null;
    const o = JSON.parse(t) as Partial<BanNhapBill>;
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null; // bản nháp hỏng KHÔNG được làm vỡ màn hình — bỏ qua, coi như chưa có
  }
}
function xoaBanNhap(): void {
  try { window.localStorage.removeItem(KHOA_NHAP); } catch { /* bộ nhớ trình duyệt bị chặn — bỏ qua */ }
}

export function BillManualEntryPage({
  user,
  nutMenu,
  cheDoTienCho = false
}: {
  user: AuthUser;
  /** Chỗ cắm cho nút 3 GẠCH khi màn chạy FULL (Dashboard truyền vào) — đặt CÙNG HÀNG với tiêu đề
   *  "DOANH SỐ" thay vì nút nổi đè lên nội dung (Admin Demo 7/11). */
  nutMenu?: ReactNode;
  /** [DOANH SỐ TIỀN CHỜ 24/11 — Admin Demo "clone ra màn Doanh Số"] Bật = màn "DOANH SỐ TIỀN CHỜ / công nợ
   *  phải thu Uỷ quyền": bảng + modal + bộ lọc Y HỆT Doanh Số, chỉ KHÁC CHỖ LỌC loại phí —
   *  chỉ hiển thị / nhập bill loại phí Tiền chờ(8) hoặc Uỷ quyền(9) (mặc định Uỷ quyền). */
  cheDoTienCho?: boolean;
}): JSX.Element {
  const toast = useToast();
  // Đọc 1 LẦN lúc dựng trang — dùng làm giá trị khởi tạo cho mọi ô người dùng gõ.
  const nhapCu = useRef<Partial<BanNhapBill> | null>(docBanNhap());
  const nc = nhapCu.current;
  const [cheDo, setCheDo] = useState<'danhsach' | 'nhap'>(nc?.cheDo === 'nhap' ? 'nhap' : 'danhsach');
  const [tids, setTids] = useState<ConfigTidDto[]>([]);
  // [DOANH SỐ TIỀN CHỜ 24/11 — Admin Demo] Tập tid_id ĐÃ KHAI GIÁ BÁN loại phí Tiền chờ(8)/Uỷ quyền(9).
  // null = chưa tải xong (ở chế độ tiền chờ) ⇒ picker CHƯA hiện TID nào (fail-safe, thà trống còn hơn cho chọn
  // TID chưa khai giá rồi mới báo lỗi). KHÔNG dùng khi không ở chế độ tiền chờ.
  const [tidIdsTienCho, setTidIdsTienCho] = useState<Set<number> | null>(null);
  // [B189] ngân hàng + MỐC CA do người dùng khai (màn Quản Lý Ngân Hàng). Rỗng = chưa khai ⇒ dùng mốc cũ.
  const [banks, setBanks] = useState<BankDto[]>([]);
  // [B181 19/11] ĐẾM LẦN TẢI — tăng lên là nạp lại MỌI dữ liệu nền (TID, loại phí, người dùng) lẫn
  // danh sách bill. Trước đây TID chỉ nạp ĐÚNG 1 LẦN lúc dựng trang và KHÔNG có đường nào làm mới:
  // app mở liên tục nhiều ngày thì máy mới giao đại lý hôm sau vẫn hiện "CHƯA giao đại lý" (ca thật
  // 19/11: TID 20281246 giao cho "Dũng YN HN" lúc 17/11 22:37, app mở từ 16/11 20:03 nên không thấy).
  const [lanTai, setLanTai] = useState(0);
  const [feeTypes, setFeeTypes] = useState<FeeTypeDto[]>([]);
  const [cards, setCards] = useState<CardTypeDto[]>([]);
  const [loading, setLoading] = useState(true);

  const [bankChon, setBankChon] = useState(nc?.bankChon ?? ''); // chọn NGÂN HÀNG trước, rồi mới ra danh sách TID
  const [tidId, setTidId] = useState(nc?.tidId ?? '');
  const [soHoaDon, setSoHoaDon] = useState(nc?.soHoaDon ?? '');
  const [soLo, setSoLo] = useState(nc?.soLo ?? '');
  const [maDongLo, setMaDongLo] = useState(nc?.maDongLo ?? '');
  // NGÀY mặc định = HÔM NAY (giờ máy, không qua ISO/UTC để khỏi lùi 1 ngày trước 7h sáng).
  // GIỜ mặc định = 00:00 (Admin Demo 6/11) — người nhập tự gõ giờ in trên bill, không mượn giờ hiện tại.
  const [ngay, setNgay] = useState(() => nc?.ngay ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const [gio, setGio] = useState(nc?.gio ?? GIO_MAC_DINH);
  const [cardTypeId, setCardTypeId] = useState(nc?.cardTypeId ?? '');
  const [feeTypeId, setFeeTypeId] = useState(nc?.feeTypeId ?? '');
  const [soTien, setSoTien] = useState(nc?.soTien ?? '');
  const [tienHuy, setTienHuy] = useState(nc?.tienHuy ?? '');
  // HOÀN TIỀN (Admin Demo 6/11) — số đã trả cho đại lý ngay tại ô nhập bill lẻ + AI trả. Để lại vết người thực
  // hiện (không để "ai đó đã hoàn" trôi nổi) và tính ngay phần CÒN PHẢI HOÀN.
  const [daHoan, setDaHoan] = useState(nc?.daHoan ?? '');
  const [nguoiHoanId, setNguoiHoanId] = useState(nc?.nguoiHoanId ?? '');
  const [users, setUsers] = useState<UserDto[]>([]);
  const [ghiChu, setGhiChu] = useState(nc?.ghiChu ?? '');
  // TOÀN BỘ dòng biểu phí của TID theo LOẠI PHÍ đang chọn (mỗi dòng = 1 loại thẻ).
  const [feeRows, setFeeRows] = useState<TidSellFeeRowDto[]>([]);
  const [danhSach, setDanhSach] = useState<BillDaGhi[]>(() => (laBanDemo() ? BILL_DEMO : []));
  const [dangTaiSo, setDangTaiSo] = useState(false);
  const [loiTaiSo, setLoiTaiSo] = useState<string | null>(null);
  const [vuaThem, setVuaThem] = useState<string | null>(null);
  const [daTich, setDaTich] = useState<Set<string>>(new Set()); // bill được tích để xóa hàng loạt
  const [ketQua, setKetQua] = useState<{ tid: string; lo: string; daiLy: string; nhanVe: number; maLo?: number | null } | null>(null);
  const [ketQuaExcel, setKetQuaExcel] = useState<{ path: string; soBill: number } | null>(null);
  // [B228 22/11 — Admin Demo] Tuỳ chọn trước khi xuất Excel. BA nút tích ĐỘC LẬP, không ràng buộc nhau.
  const [moTuyChonExcel, setMoTuyChonExcel] = useState(false);
  // [B247 22/11 — Admin Demo "thêm tích chọn NĐT để xuất file"] Chọn NHÀ ĐẦU TƯ nào được đưa vào file.
  // Rỗng = XUẤT HẾT (mặc định) — không bắt người dùng tích đủ mới xuất được như cũ.
  const [exNdtChon, setExNdtChon] = useState<string[]>([]);
  const [exAnDaiLy, setExAnDaiLy] = useState(false);
  const [exAnNguoiNhap, setExAnNguoiNhap] = useState(false);
  const [exTachSheetNdt, setExTachSheetNdt] = useState(false);
  // [B239 22/11 — Admin Demo "phần tích ẩn thì cho ẩn luôn % mua khi tích xuất file"] Ẩn PHÍ MUA ĐỐI TÁC
  // (giá vốn) khỏi file — dùng khi gửi file ra ngoài cho nhà đầu tư/đại lý.
  const [exAnMuaDt, setExAnMuaDt] = useState(false);
  const [moBieuDo, setMoBieuDo] = useState(false); // bảng nổi BIỂU ĐỒ tăng trưởng
  const [mocBieuDo, setMocBieuDo] = useState<'ngay' | 'thang'>('ngay');
  const [moBaoCao, setMoBaoCao] = useState(false); // bảng nổi "Máy chạy / không chạy" theo kỳ
  const [sapXep, setSapXep] = useState<'cao' | 'thap'>('cao'); // doanh số theo TID: cao→thấp | thấp→cao
  const [hoiXoa, setHoiXoa] = useState(false); // hộp xác nhận xóa bill (BẮT nhập mật khẩu)
  const [hoiDong, setHoiDong] = useState(false); // hỏi xác nhận khi đóng mà form còn dữ liệu
  const [moChuKy, setMoChuKy] = useState(false); // danh sách thả xuống chọn chu kỳ
  const [gioLoi, setGioLoi] = useState(false);
  // [V2] Giờ mặc định là 00:00 nên phép so "lô lớn mà giờ sớm" bắn oan trên GẦN NHƯ MỌI bill mới.
  // Cảnh báo kêu oan liên tục = cảnh báo đã chết (người nhập tích xác nhận theo phản xạ). Chỉ so khi
  // người dùng ĐÃ TỰ ĐẶT giờ.
  const [gioDaDat, setGioDaDat] = useState(nc?.gioDaDat ?? false); // ô giờ đang nhập sai (vd 28h) → chặn ghi
  const [thuNho, setThuNho] = useState(nc?.thuNho ?? false); // hạ bảng nhập xuống để xem danh sách, giữ nguyên dữ liệu đang gõ
  // MƯỢN TID (Admin Demo 6/11) — đại lý A quẹt nhờ máy của B. Doanh số + phí bill NÀY về nhà A.
  // Backend đã có sẵn: createLoFromBillTid({ borrowedByCustomerId }) — CHỈ áp cho đúng bill đang ghi,
  // bill sau tự quay về chủ máy (reset sau mỗi lần ghi).
  const [muonTid, setMuonTid] = useState(nc?.muonTid ?? false);
  const [daiLyMuonId, setDaiLyMuonId] = useState(nc?.daiLyMuonId ?? '');
  // Id bill đang SỬA — phải loại khỏi phép so trùng, nếu không bill tự báo trùng với chính nó.
  const [dangSuaId, setDangSuaId] = useState<string | null>(nc?.dangSuaId ?? null);
  // [B182 19/11] Tích khi tiền hoàn lớn hơn tiền về của bill này VÌ hoàn GỘP nhiều bill.
  const [xacNhanHoanGop, setXacNhanHoanGop] = useState(false);
  // [B183 19/11] KHOÁ BILL GỐC của bill đang sửa. Máy chủ nhận ra "sửa" hay "bill mới" CHỈ qua khoá
  // bill (nat|TID|lô|số HĐ|ngày). Giữ khoá gốc để: (a) biết người dùng có lỡ đổi 4 thứ đó không —
  // đổi là lô CŨ vẫn nằm đó còn lô MỚI mọc thêm (doanh số x2); (b) khoá không đổi thì cho ghi đè
  // thẳng, khỏi bị chặn "nghi trùng" vô lý vì bản trùng chính là bill đang sửa.
  const [khoaBillGoc, setKhoaBillGoc] = useState<string | null>(null);
  const [xacNhanMuon, setXacNhanMuon] = useState(nc?.xacNhanMuon ?? false);
  const [tachThe, setTachThe] = useState(nc?.tachThe ?? false); // bật/tắt tách nhiều loại thẻ trong cùng 1 lô
  const [dongThe, setDongThe] = useState<{ cardTypeId: string; tien: string }[]>(nc?.dongThe ?? []); // các dòng tách (dòng CUỐI tự tính)
  const [xacNhanTrung, setXacNhanTrung] = useState(false); // cố ý ghi dù trùng lô + trùng tiền
  const [busy, setBusy] = useState(false);
  // ── PHÍM TẮT (Admin Demo 24/11) — cấu hình per-user đọc từ localStorage, nạp lại khi màn Cấu hình lưu ──
  const ptUserId = (user as unknown as { id?: number }).id ?? null;
  const [cfgPt, setCfgPt] = useState<ShortcutConfig>(() => loadShortcutConfig(ptUserId));
  useEffect(() => {
    const nap = (): void => setCfgPt(loadShortcutConfig(ptUserId));
    window.addEventListener(SHORTCUT_CFG_EVENT, nap);
    window.addEventListener('focus', nap); // quay lại cửa sổ → đồng bộ nếu đổi ở tab khác
    return () => {
      window.removeEventListener(SHORTCUT_CFG_EVENT, nap);
      window.removeEventListener('focus', nap);
    };
  }, [ptUserId]);
  const pressRef = useRef<PressState>(ptInit());
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [enterConLai, setEnterConLai] = useState(0); // >0 = đang chờ bấm Enter lần nữa để GHI
  // Khung bảng — dùng để ép lăn chuột dừng ĐÚNG mép dòng (Admin Demo 6/11 "lăn chuột phải chẵn dòng").
  const khungRef = useRef<HTMLDivElement>(null);

  // ── Bộ lọc danh sách (Admin Demo 6/11) ──
  const [fTim, setFTim] = useState('');
  const [fTid, setFTid] = useState<string[]>([]);
  const [fHkd, setFHkd] = useState<string[]>([]);
  const [fDaiLy, setFDaiLy] = useState<string[]>([]);
  const [fNdt, setFNdt] = useState<string[]>([]);
  const [fBank, setFBank] = useState<string[]>([]);
  const [fCa, setFCa] = useState<string[]>([]);
  const homNayHCM = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const [fTu, setFTu] = useState(homNayHCM);
  const [fDen, setFDen] = useState(homNayHCM);
  // ── TAB KPI DOANH SỐ (full-view) — ĐỘC LẬP với bộ lọc màn Doanh Số (Admin Demo 24/11). ──────────────
  // Kỳ riêng (mặc định từ đầu tháng → hôm nay) + lọc theo CA. Số liệu lấy THẲNG từ /v1/kpi/doanh-so.
  const dauThangHCM = homNayHCM.slice(0, 8) + '01';
  const [moKpi, setMoKpi] = useState(false);
  const [kpiTu, setKpiTu] = useState(dauThangHCM);
  const [kpiDen, setKpiDen] = useState(homNayHCM);
  const [kpiCa, setKpiCa] = useState<number | null>(null); // null = mọi ca
  type KpiOk = Extract<Awaited<ReturnType<typeof window.api.kpiDoanhSo>>, { ok: true }>;
  const [kpiData, setKpiData] = useState<KpiOk['data'] | null>(null);
  const [kpiLoading, setKpiLoading] = useState(false);
  const [kpiErr, setKpiErr] = useState('');
  const [kpiDaiLyMo, setKpiDaiLyMo] = useState<number | 'none'>('none'); // đại lý đang bung chi tiết POS
  // [24/11 — Admin Demo "tách sang 1 tab riêng để khỏi cuộn"] 2 tab trong modal KPI: Biểu đồ | Bảng đại lý.
  const [kpiTab, setKpiTab] = useState<'bieudo' | 'bangdaily'>('bieudo');
  const [fThe, setFThe] = useState<string[]>([]);
  const [fPhi, setFPhi] = useState<string[]>([]);
  // Lọc theo SỐ LÔ / SỐ HÓA ĐƠN / LÔ ĐÓNG 95 (Admin Demo 6/11) — BỎ dropdown, chỉ GÕ SỐ là hiện.
  // Dropdown với hàng trăm số lô vừa dài vừa chậm chọn; gõ "82" ra ngay nhanh hơn nhiều.
  const [fLo, setFLo] = useState('');
  const [fSoHd, setFSoHd] = useState('');
  const [fChiDong95, setFChiDong95] = useState(false);
  const [fNguoiHoan, setFNguoiHoan] = useState<string[]>([]);

  const tid = tids.find((t) => t.id === Number(tidId)) ?? null;
  /** [B189] Mốc ca của NGÂN HÀNG gắn với 1 TID (theo bankId) — không có thì trả undefined để rơi về mốc cũ. */
  const caCuaBank = (bankId: number | null | undefined): { ten: string; tuPhut: number; denPhut: number }[] | undefined => {
    if (bankId == null) return undefined;
    const b = banks.find((x) => x.id === bankId);
    return b?.caTien && b.caTien.length > 0 ? b.caTien : undefined;
  };

  useEffect(() => {
    void (async () => {
      // [B189] tải kèm DANH SÁCH NGÂN HÀNG để lấy MỐC CA khai trong màn Quản Lý Ngân Hàng.
      const [rt, rf, ru, rb] = await Promise.all([
        window.api.tidConfigList({}), window.api.feeTypeList(), window.api.refundPeople(), window.api.bankList({})
      ]);
      if (rt.ok && rt.data) setTids(rt.data);
      if (rb.ok && rb.data) setBanks(rb.data);
      // NGƯỜI HOÀN (B206) = người được tích "Được hoàn tiền" (users.can_refund) ở màn Nhân sự.
      // [KẾ TOÁN NĐT 24/11 — phương án A] NGUỒN đổi sang route HẸP `refund-people` (chỉ id+tên, gác REVENUE_MANAGE)
      // thay cho `userList` (cần USER_READ): vai Kế toán NĐT KHÔNG có USER_READ nhưng vẫn phải chọn được người hoàn.
      // Route đã lọc sẵn ACTIVE + can_refund nên KHÔNG lọc lại ở client; map về khuôn UserDto cho dropdown dùng chung.
      if (ru.ok && ru.data)
        setUsers(ru.data.map((p) => ({ id: p.id, fullName: p.fullName, employeeCode: null, status: 'ACTIVE', canRefund: true } as unknown as UserDto)));
      if (rf.ok && rf.data) {
        setFeeTypes(rf.data);
        if (cheDoTienCho) {
          // [DOANH SỐ TIỀN CHỜ 24/11] Chỉ cho Tiền chờ(8)/Uỷ quyền(9); mặc định Uỷ quyền(9) (fallback Tiền chờ).
          // Đặt lại mỗi lần nạp để KHÔNG dính feeTypeId khác (bản nháp dùng chung localStorage với màn Doanh Số).
          const macDinh = rf.data.find((f) => f.id === 9) ?? rf.data.find((f) => f.id === 8);
          if (macDinh) setFeeTypeId(String(macDinh.id));
        } else if (rf.data[0]) {
          setFeeTypeId(String(rf.data[0].id));
        }
      }
      setLoading(false);
    })();
  }, [lanTai]);

  // TAB KPI: nạp lại từ máy chủ mỗi khi mở tab / đổi kỳ / đổi ca. Thất bại thì NÓI RÕ lỗi, không để
  // bảng trống câm (người dùng tưởng "kỳ này không có gì"). Chống race: chỉ nhận kết quả còn hiệu lực.
  useEffect(() => {
    if (!moKpi) return;
    let con = true;
    setKpiLoading(true);
    setKpiErr('');
    void (async () => {
      try {
        const r = await window.api.kpiDoanhSo(kpiTu, kpiDen, kpiCa);
        if (!con) return;
        if (r.ok) {
          setKpiData(r.data);
        } else {
          setKpiData(null);
          setKpiErr(r.message || r.error || 'Không tải được KPI.');
        }
      } catch (e) {
        if (con) {
          setKpiData(null);
          setKpiErr(e instanceof Error ? e.message : 'Lỗi kết nối khi tải KPI.');
        }
      } finally {
        if (con) setKpiLoading(false);
      }
    })();
    return () => {
      con = false;
    };
  }, [moKpi, kpiTu, kpiDen, kpiCa]);

  /** Kỳ nhanh cho tab KPI (tính theo giờ VN, không phụ thuộc TZ máy). */
  const kpiNgayLui = (n: number): string => {
    const d = new Date(homNayHCM + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const kpiKyThangTruoc = (): [string, string] => {
    const y = Number(homNayHCM.slice(0, 4));
    const m = Number(homNayHCM.slice(5, 7));
    const pm = m === 1 ? 12 : m - 1;
    const py = m === 1 ? y - 1 : y;
    const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    const mm = String(pm).padStart(2, '0');
    return [`${py}-${mm}-01`, `${py}-${mm}-${String(last).padStart(2, '0')}`];
  };
  const datKyKpi = (tu: string, den: string): void => {
    setKpiTu(tu);
    setKpiDen(den);
  };

  // [BỎ 6/11] Trước đây có setInterval 60 giây tự đẩy kỳ về "hôm nay". Nguy hiểm: người dùng đang đối
  // soát một ngày cũ, đứng yên hơn 1 phút là bảng tự đổi dữ liệu dưới tay mà không báo gì (đo thật:
  // 01/11 3 bill → 06/11 20 bill sau 65 giây). Kỳ chỉ đổi khi NGƯỜI DÙNG bấm.

  // ĐỌC DANH SÁCH TỪ SỔ theo kỳ đang chọn (Admin Demo 7/11). Bản dựng thử bỏ qua — nó dùng dữ liệu mẫu.
  // Thất bại thì NÓI RÕ trên màn, tuyệt đối không để bảng trống mà người dùng tưởng "kỳ này không có bill".
  useEffect(() => {
    if (laBanDemo() || !fTu || !fDen) return;
    let song = true;
    setDangTaiSo(true);
    setLoiTaiSo(null);
    void (async () => {
      try {
        const r = await window.api.billManualList(fTu, fDen, cheDoTienCho ? 'tiencho' : 'thuong');
        if (!song) return;
        if (r?.ok && Array.isArray(r.data)) {
          setDanhSach(r.data as unknown as BillDaGhi[]);
          // [B195 19/11] Máy chủ cắt bảng ở 2000 lô. Trước đây cắt ÂM THẦM ⇒ kỳ đông bill thì dòng TỔNG
          // thiếu tiền mà không ai biết. Nay nói thẳng để người dùng lọc hẹp kỳ lại.
          const rr = r as unknown as { total?: number; biCat?: boolean };
          if (rr.biCat) {
            setLoiTaiSo(
              `Kỳ này có ${rr.total} bill nhưng màn chỉ tải được ${r.data.length} — BẢNG ĐANG THIẾU, `
              + 'dòng TỔNG cũng thiếu theo. Hãy thu hẹp kỳ xem (vài ngày một) rồi đối chiếu lại.'
            );
          }
        } else {
          setLoiTaiSo(r?.message ?? 'Không đọc được danh sách bill từ máy chủ.');
          setDanhSach([]);
        }
      } catch (e) {
        if (song) {
          setLoiTaiSo('Lỗi khi đọc danh sách bill: ' + ((e as Error)?.message ?? 'không rõ'));
          setDanhSach([]);
        }
      } finally {
        if (song) setDangTaiSo(false);
      }
    })();
    return () => {
      song = false;
    };
  }, [fTu, fDen, lanTai]);

  // [DOANH SỐ TIỀN CHỜ 24/11 — Admin Demo] Nạp tập TID đã khai giá bán loại phí 8/9 để LỌC PICKER. Chỉ ở chế độ
  // tiền chờ. Tải lỗi ⇒ để tập RỖNG (không hiện TID nào) thay vì null kéo dài — fail-safe, nói rõ qua danh sách trống.
  useEffect(() => {
    if (!cheDoTienCho || laBanDemo()) return;
    let song = true;
    void window.api
      .billManualTidsTienCho()
      .then((r) => {
        if (!song) return;
        setTidIdsTienCho(new Set((r.ok && Array.isArray(r.data) ? r.data : []).map(Number)));
      })
      .catch(() => {
        if (song) setTidIdsTienCho(new Set());
      });
    return () => {
      song = false;
    };
  }, [cheDoTienCho, lanTai]);

  // Loại thẻ theo NGÂN HÀNG của TID đang chọn (đúng ràng buộc card_types.bank_id).
  useEffect(() => {
    if (!tid?.bankId) {
      setCards([]);
      return;
    }
    void window.api.cardTypeList({ bankId: tid.bankId }).then((r) => {
      if (r.ok && r.data) setCards(r.data);
    });
  }, [tid?.bankId]);

  // Biểu phí (TID × loại thẻ × loại phí) tra tại NGÀY+GIỜ TRÊN BILL (phí có nhiều kỳ hiệu lực).
  // Nạp CẢ BẢNG để hiện % của mọi loại thẻ cùng lúc.
  useEffect(() => {
    if (!tidId || !feeTypeId) {
      setFeeRows([]);
      return;
    }
    let alive = true;
    const d = ngay && gio ? new Date(ngay + 'T' + gio + ':00') : null;
    const at = d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
    void window.api.tidSellFeeList(Number(tidId), Number(feeTypeId), at).then((r) => {
      if (!alive) return;
      setFeeRows(r.ok && r.data ? r.data.rows : []);
    });
    return () => {
      alive = false;
    };
  }, [tidId, feeTypeId, ngay, gio]);

  // [Admin Demo 15-16/11] "không đặt giá bán thì mặc định giá niêm yết".
  // LUẬT TIỀN 20/8 (transaction.ts) vẫn giữ nguyên: doanh số CHỈ ăn giá bán THỰC TẾ, KHÔNG tự mượn niêm yết —
  // mượn ngầm thì về sau không ai biết bill đó tính theo giá nào. Nên ở đây làm đúng ý mà không phá luật:
  // bấm 1 nút ĐẶT giá niêm yết THÀNH giá bán thực tế (ghi hẳn vào TID, có vết), rồi ghi bill như thường.
  const [dangDatNiemYet, setDangDatNiemYet] = useState(false);
  async function datGiaNiemYetLamGiaBan(): Promise<void> {
    if (!tidId || !feeTypeId) return;
    const entries = feeRows
      .filter((r) => r.phiBanNiemYet != null && Number.isFinite(r.phiBanNiemYet))
      .map((r) => ({ cardTypeId: r.cardTypeId, phiBan: (r.hasOverride ? r.phiBanThucTe : r.phiBanNiemYet) as number }));
    if (entries.length === 0) { toast.alert('Loại phí này chưa có giá NIÊM YẾT hiệu lực để lấy làm giá bán.', 'Chưa đặt được'); return; }
    setDangDatNiemYet(true);
    const res = await window.api.tidSellFeeSet({ tidId: Number(tidId), feeTypeId: Number(feeTypeId), entries });
    setDangDatNiemYet(false);
    if (!res.ok) { toast.alert(res.message ?? 'Không đặt được giá bán.', 'Chưa đặt được'); return; }
    const d2 = ngay && gio ? new Date(ngay + 'T' + gio + ':00') : null;
    const at2 = d2 && !Number.isNaN(d2.getTime()) ? d2.toISOString() : undefined;
    const lai = await window.api.tidSellFeeList(Number(tidId), Number(feeTypeId), at2);
    const dsMoi = lai.ok && lai.data ? lai.data.rows : [];
    setFeeRows(dsMoi);
    // NÓI THẬT kết quả: ghi xong mà máy chủ VẪN coi là chưa có giá (mốc hiệu lực đọc lệch +7h — lỗi lớp đọc
    // thời gian đã đo được 16/11, đang chờ Admin Demo duyệt sửa) thì PHẢI báo, không được hô "xong" rồi để người
    // dùng bấm Ghi nhận bill và ăn lỗi NO_ACTUAL_SELL_FEE không hiểu vì sao.
    const dong = dsMoi.find((r) => r.cardTypeId === Number(cardTypeId));
    if (dong && !dong.hasOverride) {
      toast.alert(
        'Đã ghi giá bán vào TID (hiệu lực từ 00:00 hôm nay) NHƯNG máy chủ vẫn đọc là chưa hiệu lực — mốc hiệu lực đang bị lệch +7 giờ. ' +
          'Bill có giờ quẹt trước 07:00 sáng nay sẽ vẫn bị chặn. Báo Admin Demo để sửa lớp đọc thời gian.',
        'Ghi rồi nhưng CHƯA ăn'
      );
      return;
    }
    toast.success('Đã lấy giá niêm yết làm giá bán thực tế cho TID này.');
  }

  // [B197 — Admin Demo 19/11 "THÊM TID MỚI TIẾN DŨNG LẠI KHÔNG CÓ KHI CHỌN TID THÊM BILL"]
  // TID vừa khai báo nằm ở trạng thái UNASSIGNED (chưa giao khách, chưa đặt giá bán). Ô chọn TID trước đây lọc
  // THẲNG `status === 'ACTIVE'` nên TID mới BIẾN MẤT KHÔNG MỘT LỜI — người nhập tưởng app làm mất TID (đo 19/11
  // trên sổ thật: 3 TID "KHACH HANG 58" 50580458/59/60 đều UNASSIGNED, 0 dòng giá bán).
  // LUẬT: ẨN IM = NUỐT LỖI Ở LỚP GIAO DIỆN (R198). TID chưa đủ điều kiện VẪN hiện trong ô chọn (gõ tên là thấy)
  // nhưng mang dấu ⚠; chọn vào thì màn NÓI RÕ còn thiếu bước nào và CHẶN ghi (fail-closed) — vì bill của TID chưa
  // giao khách không biết doanh số về đại lý nào (đúng lỗi "không gán đại lý" đã gặp ở THANH TÙNG 06-2).
  const TID_CHUA_SAN = new Set(['UNASSIGNED', 'RECALLED']);
  const tidHienDuoc = (t: ConfigTidDto): boolean => t.status === 'ACTIVE' || TID_CHUA_SAN.has(t.status);
  /** Lý do một TID CHƯA nhập bill được — null = dùng được. Nói rõ phải làm gì, không chỉ "không hợp lệ". */
  const lyDoTidChuaDung = (t: ConfigTidDto | null): string | null => {
    if (!t || t.status === 'ACTIVE') return null;
    if (t.status === 'UNASSIGNED')
      return 'TID này MỚI khai báo, CHƯA giao cho khách nên chưa biết doanh số về đại lý nào. Vào màn "TID" → bấm "Giao cho khách" → đặt giá bán cho TID, rồi quay lại nhập bill.';
    if (t.status === 'RECALLED')
      return 'TID này ĐÃ THU HỒI khỏi khách. Vào màn "TID" → bấm "Giao lại cho khách" trước khi nhập bill.';
    return 'TID đang ở trạng thái ' + t.status + ' — không nhập bill được.';
  };

  // [DOANH SỐ TIỀN CHỜ 24/11 — Admin Demo] Ở chế độ tiền chờ, picker CHỈ hiện TID đã khai giá bán loại phí
  // Tiền chờ(8)/Uỷ quyền(9) (tập tidIdsTienCho). Chưa tải (null) ⇒ chưa hiện (fail-safe). Không ở chế độ
  // tiền chờ ⇒ không lọc (hành vi cũ nguyên vẹn).
  const tidHopLeTienCho = (t: ConfigTidDto): boolean =>
    !cheDoTienCho ? true : tidIdsTienCho != null && tidIdsTienCho.has(t.id);

  // [Admin Demo 6/11] Chọn TID qua 2 Ô: (1) Ngân hàng → (2) TID của chính ngân hàng đó. Gõ để gợi ý ở cả 2 ô.
  const bankOptions = useMemo(() => {
    const m = new Map<string, string>();
    // Ngân hàng chỉ có TID MỚI (chưa giao khách) cũng phải hiện — không thì TID mới không có đường nào chọn tới.
    // Chế độ tiền chờ: chỉ hiện ngân hàng CÓ ÍT NHẤT 1 TID đã khai giá 8/9 (khỏi chọn bank rồi thấy TID trống).
    for (const t of tids) if (tidHienDuoc(t) && tidHopLeTienCho(t) && t.bankId) m.set(String(t.bankId), t.bankCode ?? t.bankName ?? 'NH #' + t.bankId);
    return [...m.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'vi'));
  }, [tids, cheDoTienCho, tidIdsTienCho]);
  const tidOptions = useMemo(
    () =>
      tids
        .filter((t) => tidHienDuoc(t) && tidHopLeTienCho(t) && (!bankChon || String(t.bankId) === bankChon))
        .map((t) => ({
          value: String(t.id),
          // Nhãn: "<tên HKD> - <TID>" (ngân hàng đã chọn ở ô bên trái nên không lặp lại). TID chưa dùng được
          // mang dấu ⚠ ngay trên nhãn để thấy TRƯỚC khi chọn, không phải chọn rồi mới biết.
          label:
            (t.hkdName ?? 'chưa có HKD').replace(/^HKD\s*/i, '') +
            ' - ' +
            t.tid +
            (t.status === 'UNASSIGNED' ? '  ⚠ chưa giao khách' : t.status === 'RECALLED' ? '  ⚠ đã thu hồi' : '')
        })),
    [tids, bankChon, cheDoTienCho, tidIdsTienCho]
  );
  /** TID đang chọn có chặn ghi không (kèm lý do để hiện cho người nhập). */
  const tidChuaDung = useMemo(() => lyDoTidChuaDung(tid), [tid]);
  /** Số TID mới khai báo chưa giao khách — đếm để NÓI RA, không để người dùng tự đoán vì sao bảng thiếu máy. */
  const soTidChuaGiao = useMemo(() => tids.filter((t) => TID_CHUA_SAN.has(t.status)).length, [tids]);

  // NĐT của TID = chủ TÀI KHOẢN NHẬN TIỀN (ủy). owyType do tid-config.ts suy (INVESTOR/CUSTOMER/INTERNAL).
  const ndt = useMemo(() => {
    if (!tid) return { text: '—', nhanManh: false };
    if (tid.owyType === 'INVESTOR') return { text: tid.owyName ?? 'NĐT chưa đặt tên', nhanManh: true };
    if (tid.owyType === 'CUSTOMER') return { text: 'TK khách: ' + (tid.owyName ?? '—'), nhanManh: false };
    if (tid.owyType === 'INTERNAL') return { text: 'TK nội bộ SigMa', nhanManh: false };
    return { text: 'chưa gán TK nhận tiền', nhanManh: false };
  }, [tid]);

  // [Admin Demo 15/11] THẺ MẶC ĐỊNH của ngân hàng → chọn SẴN khi vừa có biểu phí, đỡ phải chọn mỗi lần thêm bill.
  // CHỈ điền khi người dùng CHƯA chọn gì (cardTypeId rỗng) — không bao giờ đè lựa chọn của người nhập.
  useEffect(() => {
    if (cardTypeId || feeRows.length === 0) return;
    const macDinh = cards.find((c) => c.isDefault);
    if (!macDinh) return;
    if (!feeRows.some((r) => r.cardTypeId === macDinh.id)) return; // thẻ mặc định không có trong biểu phí ⇒ để trống
    setCardTypeId(String(macDinh.id));
  }, [cards, feeRows, cardTypeId]);

  // P5 — doanh số CHỈ dùng phí bán THỰC TẾ (override theo TID), KHÔNG mượn niêm yết (gate NO_ACTUAL_SELL_FEE).
  const sellFee = feeRows.find((x) => x.cardTypeId === Number(cardTypeId)) ?? null;
  const thieuGiaBanThucTe = !!sellFee && !sellFee.hasOverride;
  const phiBanApplied = sellFee?.hasOverride ? sellFee.phiBanThucTe : null;
  const TRAN_TIEN = 100_000_000_000; // 100 tỉ/bill — trên mức này gần như chắc chắn gõ sai
  const tienQuet = Number(soTien) || 0;
  // Số vượt Number.MAX_SAFE_INTEGER bị LÀM TRÒN ngay khi hiển thị (gõ 17 chữ số → số khác hẳn hiện ra
  // mà không báo gì). Phải chặn tường minh, không dựa vào Number.isInteger (1e17 vẫn trả true).
  const tienQuaLon = !Number.isSafeInteger(tienQuet) || tienQuet > TRAN_TIEN || (Number(tienHuy) || 0) > TRAN_TIEN;
  const tienHuySo = Number(tienHuy) || 0;
  const huyVuot = tienHuySo > tienQuet;
  // TIỀN LÔ SAU HỦY = tổng quẹt − tiền hủy. Đây mới là số GHI DOANH SỐ và là gốc tính phí (luật bill OCR).
  const tienLo = Math.max(0, tienQuet - tienHuySo);
  /** Phí bán THỰC TẾ (%) của một loại thẻ — null nếu TID chưa set giá bán thực tế cho thẻ đó. */
  const phiBanCuaThe = (id: string | number): number | null => {
    const r = feeRows.find((x) => x.cardTypeId === Number(id));
    return r?.hasOverride ? r.phiBanThucTe : null;
  };
  /** Đổi % → milli (× 1000) đúng thang của backend (fee-config SCALE=1000). */
  const milli = (pct: number): number => Math.round(pct * 1000);
  // PHÍ CÀI MÁY THEO LOẠI THẺ (Admin Demo 6/11) — lấy ĐÚNG dòng thẻ đang chọn trong bảng phí (fee_rates theo
  // đối tác × loại thẻ, KHÔNG theo loại phí). Số này chốt per-GD khi ghi và là gốc tính tiền về nhà đầu tư.
  const phiCaiMayPct = sellFee?.phiCaiMayNiemYet ?? null;
  const tienCaiMay = phiCaiMayPct != null ? marginToAmount(tienLo, milli(phiCaiMayPct)) : null;
  const daHoanSo = Number(daHoan) || 0;
  const nguoiHoan = users.find((u) => String(u.id) === nguoiHoanId) ?? null;
  // [N8] Người hoàn GỐC của bill có thể KHÔNG thuộc vai trò kế toán/admin (vd nhà đầu tư đã trả tiền).
  // Nếu danh sách chỉ có kế toán/admin thì mở Sửa là buộc đổi người ⇒ MẤT vết. Luôn ghép người đang
  // được gán vào danh sách, đánh dấu rõ là ngoài vai trò.
  const dsNguoiHoan = useMemo(() => {
    const ds = users.map((u) => ({ value: String(u.id), label: u.fullName + (u.employeeCode ? ' · ' + u.employeeCode : '') }));
    if (nguoiHoanId && !ds.some((x) => x.value === nguoiHoanId)) {
      const b = danhSach.find((x) => String(x.nguoiHoanId ?? '') === nguoiHoanId);
      ds.unshift({ value: nguoiHoanId, label: (b?.nguoiHoan || 'Người hoàn cũ') + ' · (chưa được tích quyền hoàn tiền)' });
    }
    return ds;
  }, [users, nguoiHoanId, danhSach]);
  // [PHÍM TẮT 24/11] Khi bật phím số chọn người hoàn: sắp xếp danh sách THEO PHÍM (BỔ SUNG 3) + badge phím
  // cạnh tên + digitMap cho SearchSelect. Tắt → giữ nguyên thứ tự, không badge, không bắt phím số.
  const ptNguoiHoanBat = ptBat(cfgPt, 'nguoihoan-so');
  const dsNguoiHoanHienThi = useMemo(
    () => (ptNguoiHoanBat ? ptSapNguoiHoan(dsNguoiHoan, cfgPt) : dsNguoiHoan),
    [dsNguoiHoan, cfgPt, ptNguoiHoanBat]
  );
  const ptDigitMapNH = useMemo(
    () => (ptNguoiHoanBat ? ptDigitMap(dsNguoiHoan, cfgPt) : {}),
    [dsNguoiHoan, cfgPt, ptNguoiHoanBat]
  );
  // [PHÍM TẮT 24/11 — BỔ SUNG 5] Loại thẻ: option kèm LOGO thương hiệu (CardBrandBadge) đứng trước tên.
  const theOptions = useMemo(
    () =>
      feeRows.map((r) => ({
        value: String(r.cardTypeId),
        label:
          r.cardTypeName +
          (r.hasOverride && r.phiBanThucTe !== r.phiBanNiemYet
            ? ' · bán ' + pctText(r.phiBanThucTe)
            : ' · niêm yết ' + pctText(r.phiBanNiemYet))
      })),
    [feeRows]
  );
  const theLogo = useCallback(
    (value: string): ReactNode => {
      const r = feeRows.find((x) => String(x.cardTypeId) === value);
      if (!r) return null;
      return <CardBrandBadge name={r.cardTypeName} code={r.cardTypeCode} />;
    },
    [feeRows]
  );
  // ── 3 MỨC CẢNH BÁO SỐ LÔ (Admin Demo 6/11) ───────────────────────────────────────────────────────────
  // (1) TRÙNG HOÀN TOÀN: cùng TID + cùng lô + cùng NGÀY + cùng SỐ TIỀN ⇒ gần như chắc chắn gõ lại bill cũ.
  // (2) TRÙNG LÔ khác ngày/giờ/tiền ⇒ ĐƯỢC PHÉP (máy POS/ngân hàng có thể cấp lại số lô), nhưng vẫn phải
  //     xác nhận có chủ ý để lại vết.
  // (3) NGHỊCH THỨ TỰ: lô LỚN HƠN mà giờ lại SỚM HƠN lô nhỏ hơn trong cùng TID + cùng ngày ⇒ nghi gõ nhầm
  //     giờ hoặc nhầm lô, bắt kiểm lại trước khi ghi.
  const loSo = Number(soLo) || 0;
  const tienHienTai = Math.max(0, (Number(soTien) || 0) - (Number(tienHuy) || 0));
  const billCungTid = tid ? danhSach.filter((b) => b.tid === tid.tid && b.id !== dangSuaId) : [];
  const billTrung = tid
    ? billCungTid.find(
        (b) => b.lo === loHienThi(soLo, maDongLo) && b.ngay === ngay && b.tienLo === tienHienTai && tienHienTai > 0
      )
    : undefined;
  const trungLoKhacNgay = tid && !billTrung
    ? billCungTid.find((b) => b.lo === loHienThi(soLo, maDongLo) && loHienThi(soLo, maDongLo) !== '')
    : undefined;
  const nghichThuTu = tid && gioDaDat && loSo > 0 && gio
    ? billCungTid.find((b) => {
        const lo2 = Number(b.lo.replace(/\(.*\)/, '')) || 0;
        return b.ngay === ngay && lo2 > 0 && ((lo2 < loSo && b.gio > gio) || (lo2 > loSo && b.gio < gio));
      })
    : undefined;
  // (4) TRÙNG SỐ HÓA ĐƠN: cùng TID + cùng ngày + cùng số HĐ ⇒ gõ lại bill cũ, kể cả khi BỎ TRỐNG số lô.
  //     Thiếu nhánh này thì bill trùng y nguyên không-có-lô ghi được im lặng → doanh số x2.
  const trungSoHoaDon =
    tid && soHoaDon.trim()
      ? billCungTid.find((b) => b.ngay === ngay && (b.soHoaDon || '').replace(/^0+/, '') === soHoaDon.trim().replace(/^0+/, ''))
      : undefined;
  const canXacNhanLo = !!billTrung || !!trungLoKhacNgay || !!nghichThuTu || !!trungSoHoaDon;
  // Σ các dòng tách ĐÃ NHẬP (trừ dòng cuối) và phần CÒN LẠI tự gán cho dòng cuối.
  const tongDaNhapTach = dongThe.slice(0, -1).reduce((t, d) => t + (Number(d.tien) || 0), 0);
  const conLaiTach = Math.max(0, tienLo - tongDaNhapTach);
  const tachHopLe =
    !tachThe ||
    (dongThe.length >= 2 &&
      dongThe.every((d) => d.cardTypeId) &&
      new Set(dongThe.map((d) => d.cardTypeId)).size === dongThe.length &&
      tongDaNhapTach < tienLo);

  /** Tiền thực của từng dòng tách: dòng cuối nhận PHẦN CÒN LẠI (đúng như ô trên màn hiển thị). */
  const dongTheCoTien = dongThe.map((d, i) => ({
    cardTypeId: d.cardTypeId,
    tien: i === dongThe.length - 1 ? conLaiTach : Number(d.tien) || 0
  }));
  /** Mỗi dòng tách có đủ giá bán thực tế không — thiếu 1 dòng là KHÔNG được tính (cấm đoán số tiền). */
  const tachDuPhi = dongTheCoTien.every((d) => d.cardTypeId && phiBanCuaThe(d.cardTypeId) != null);
  // PHÍ BÁN (Admin Demo 6/11 + agent đối kháng): lô tách nhiều loại thẻ thì phí = Σ phí TỪNG DÒNG theo %
  // RIÊNG của thẻ dòng đó. Bản trước lấy % của MỘT thẻ áp cho CẢ lô ⇒ lô 100tr tách Visa 60tr (1,17%) +
  // JCB 40tr (1,07%) ra 98.830.000 trong khi đúng là 98.870.000 — THIẾU 40.000đ/lô cho đại lý, mà payload
  // `lines` gửi đi lại ĐÚNG 2 thẻ ⇒ số người ký duyệt khác số máy chủ ghi.
  const tienPhi =
    tachThe && tachHopLe
      ? tachDuPhi
        ? dongTheCoTien.reduce((t, d) => t + marginToAmount(d.tien, milli(phiBanCuaThe(d.cardTypeId) as number)), 0)
        : null
      : phiBanApplied != null
        ? marginToAmount(tienLo, milli(phiBanApplied))
        : null;
  const tienVe = tienPhi != null ? tienLo - tienPhi : null;

  // Đại lý có thể MƯỢN = mọi khách đang cầm TID trong hệ thống, TRỪ chính chủ máy đang chọn.
  const dsDaiLyMuon = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tids) if (t.customerId && t.customerName) m.set(String(t.customerId), t.customerName);
    if (tid?.customerId) m.delete(String(tid.customerId));
    return [...m.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'vi'));
  }, [tids, tid?.customerId]);
  const tenDaiLyMuon = dsDaiLyMuon.find((x) => x.value === daiLyMuonId)?.label ?? '';
  const muonChuaDu = muonTid && (!daiLyMuonId || !xacNhanMuon);
  // Đổi TID (hoặc đổi ngân hàng để lọc lại TID) ⇒ mọi cờ MƯỢN phải tắt. Cờ đổi-chủ-tiền mà sống sót
  // qua lần chọn máy khác là đúng lớp bug 25/9 (45 GD ~1,79 tỷ ghi sai nhà).
  useEffect(() => {
    setMuonTid(false);
    setDaiLyMuonId('');
    setXacNhanMuon(false);
  }, [tidId]);
  /** Doanh số bill này về nhà nào: mượn thì về nhà MƯỢN, không thì về chủ máy. */
  const veNha = muonTid && tenDaiLyMuon ? tenDaiLyMuon : tid?.customerName ?? '';

  // [B182 19/11] HOÀN GỘP NHIỀU BILL là nghiệp vụ THẬT (ô "Người hoàn" ghi rõ "dùng khi hoàn gộp nhiều bill
  // 1 lần"): gõ nhiều bill liền, các bill trước để hoàn 0đ, bill CUỐI nhập tiền hoàn GỘP ⇒ số đó ĐƯƠNG NHIÊN
  // lớn hơn tiền về của riêng bill cuối. Trước đây chặn CỨNG ⇒ không ghi nổi bill cuối.
  // Nay: không chặn, nhưng CẢNH BÁO + buộc tích xác nhận (chống gõ thừa số 0 mà không ai hay).
  const hoanVuot = tienVe != null && daHoanSo > tienVe;
  const conPhaiHoan = tienVe != null ? tienVe - daHoanSo : null;
  const theMacDinh = sellFee ?? feeRows.find((r) => r.hasOverride) ?? null;
  // Form "có dữ liệu" = đã gõ bất kỳ ô nào của bill (không tính TID/loại phí vốn giữ lại giữa các lần nhập).
  const coDuLieu = !!(soHoaDon || soLo || soTien || tienHuy || daHoan || ghiChu || maDongLo || tachThe);

  // GHI BẢN NHÁP mỗi khi có thay đổi — để đổi menu / thu nhỏ rồi quay lại vẫn còn nguyên bill đang gõ.
  // Chỉ ghi khi THỰC SỰ có gì để giữ (đang mở form, hoặc đã gõ dữ liệu); ngược lại XOÁ để lần sau mở ra sạch.
  useEffect(() => {
    const dangLam = cheDo === 'nhap' || thuNho || coDuLieu || !!tidId;
    if (!dangLam) { xoaBanNhap(); return; }
    const ban: BanNhapBill = {
      cheDo, thuNho, bankChon, tidId, soHoaDon, soLo, maDongLo, ngay, gio, cardTypeId, feeTypeId,
      soTien, tienHuy, daHoan, nguoiHoanId, ghiChu, muonTid, daiLyMuonId, xacNhanMuon,
      tachThe, dongThe, dangSuaId, gioDaDat
    };
    try { window.localStorage.setItem(KHOA_NHAP, JSON.stringify(ban)); } catch { /* hết chỗ / bị chặn — bỏ qua */ }
  }, [cheDo, thuNho, coDuLieu, bankChon, tidId, soHoaDon, soLo, maDongLo, ngay, gio, cardTypeId, feeTypeId,
      soTien, tienHuy, daHoan, nguoiHoanId, ghiChu, muonTid, daiLyMuonId, xacNhanMuon, tachThe, dongThe, dangSuaId, gioDaDat]);

  const khoaBill = tid ? billKeyPreview(tid.tid, soLo, maDongLo, soHoaDon, ngay, gio) : null;
  // VÌ SAO CHƯA GHI ĐƯỢC — liệt kê từng điều còn thiếu để hiện ngay cạnh nút. Nút khoá mà không nói lý do
  // là bắt người dùng đoán; chính tôi cũng mất thời gian dò khi lái giao diện thử (12/11).
  const thieuGi: string[] = [];
  if (!tid) thieuGi.push('chưa chọn TID');
  if (tidChuaDung) thieuGi.push(tid?.status === 'RECALLED' ? 'TID đã thu hồi, phải giao lại' : 'TID chưa giao cho khách');
  // Tách thẻ thì MỖI DÒNG đã có thẻ riêng — KHÔNG đòi ô "Loại thẻ" ở trên nữa.
  if (!tachThe && !cardTypeId) thieuGi.push('chưa chọn loại thẻ');
  if (!feeTypeId) thieuGi.push('chưa chọn loại phí');
  if (!soTien.trim() || tienLo <= 0) thieuGi.push('chưa nhập số tiền');
  if (tienQuaLon) thieuGi.push('số tiền vượt mức cho phép');
  if (!soLo.trim() && !soHoaDon.trim()) thieuGi.push('phải có số lô hoặc số hóa đơn');
  // [B270 24/11] Sổ lưu số lô kiểu INTEGER (tối đa 2.147.483.647). Gõ dài hơn là máy chủ ném lỗi
  // giữa chừng — trước đây còn kéo theo HỦY TRẮNG lô đang sửa (B269).
  if (soLo.trim() && Number(soLo) > 2147483647) thieuGi.push('số lô vượt giới hạn sổ (tối đa 2.147.483.647)');
  // [B290/F6] SỐ HÓA ĐƠN là cột CHỮ (tối đa 50 ký tự) — bản sáng 24/11 chặn oan hóa đơn >10 chữ số
  // trong khi máy chủ nhận bình thường (tái hiện: 20261124001 ghi sổ ok).
  if (soHoaDon.trim().length > 50) thieuGi.push('số hóa đơn quá dài (tối đa 50 ký tự)');
  if (!ngay) thieuGi.push('chưa chọn ngày');
  if (!gio || gio.length !== 5) thieuGi.push('chưa điền đủ giờ quẹt');
  if (gioLoi) thieuGi.push('giờ quẹt không hợp lệ');
  if (huyVuot) thieuGi.push('tiền hủy lớn hơn tổng quẹt');
  if (hoanVuot && !xacNhanHoanGop) thieuGi.push('tiền hoàn lớn hơn tiền về của bill này — tích xác nhận nếu là hoàn GỘP');
  if (daHoanSo > 0 && !nguoiHoanId) thieuGi.push('có tiền hoàn nhưng chưa chọn người hoàn');
  if (canXacNhanLo && !xacNhanTrung) thieuGi.push('phải tích xác nhận cảnh báo số lô');
  if (!tachHopLe) thieuGi.push('phần tách loại thẻ chưa hợp lệ');
  if (muonChuaDu) thieuGi.push('mượn TID: thiếu đại lý mượn hoặc chưa tích xác nhận');
  if (tienVe == null) thieuGi.push('chưa có giá bán thực tế cho thẻ này');
  const dayDu = thieuGi.length === 0;
  const tenLoaiPhi = feeTypes.find((f) => String(f.id) === feeTypeId)?.name ?? '';

  // ── Lọc danh sách ──
  const duyNhat = (lay: (b: BillDaGhi) => string): { value: string; label: string }[] =>
    [...new Set(danhSach.map(lay).filter(Boolean))].sort().map((v) => ({ value: v, label: v }));
  const danhSachLoc = useMemo(() => {
    const q = fTim.trim().toLowerCase();
    return danhSach.filter((b) => {
      if (fTid.length && !fTid.includes(b.tid)) return false;
      if (fHkd.length && !fHkd.includes(b.hkd)) return false;
      if (fDaiLy.length && !fDaiLy.includes(b.daiLy)) return false;
      if (fNdt.length && !fNdt.includes(b.ndt)) return false;
      if (fTu && b.ngay < fTu) return false;
      if (fDen && b.ngay > fDen) return false;
      if (fBank.length && !fBank.includes(b.bank)) return false;
      if (fCa.length && !fCa.includes(caCuaBill(b.bank, b.gio, caCuaBank(b.bankId))?.ten ?? '')) return false;
      // "Bị đóng 95" nhận ra bằng mã đóng lô trong số lô hiển thị, vd "84(95)".
      if (fThe.length && !fThe.includes(b.loaiThe)) return false;
      if (fPhi.length && !fPhi.includes(b.loaiPhi)) return false;
      // Gõ số lô: so phần SỐ của lô (bỏ hậu tố "(95)") — gõ "82" khớp cả "82" lẫn "82(95)".
      // Số lô THẬT = phần TRƯỚC hậu tố đóng lô. Bản trước bóc `replace(/\D/g,'')` nên "15(95)" thành
      // "1595" ⇒ gõ 159 ra bill lô 15 (số lô đó không tồn tại). Bỏ cả 0 dẫn đầu cho khớp cách ô Số HĐ làm.
      if (fLo) {
        const loThat = b.lo.replace(/\(.*\)/, '').replace(/\D/g, '').replace(/^0+/, '');
        if (!loThat.startsWith(fLo.replace(/^0+/, ''))) return false;
      }
      if (fSoHd && !(b.soHoaDon || '').replace(/^0+/, '').startsWith(fSoHd.replace(/^0+/, ''))) return false;
      if (fChiDong95 && !/\(95\)/.test(b.lo)) return false;
      // 2 mục đặc biệt tách riêng: CHƯA hoàn (bình thường) ≠ ĐÃ hoàn mà THIẾU vết ai trả (phải soi ngay).
      if (fNguoiHoan.length) {
        const khoaNH = !b.daHoan ? '__CHUA_HOAN__' : b.nguoiHoan ? b.nguoiHoan : '__THIEU_VET__';
        if (!fNguoiHoan.includes(khoaNH)) return false;
      }
      if (!q) return true;
      return [b.tid, b.hkd, b.daiLy, b.ndt, b.bank, b.loaiThe, b.loaiPhi, b.lo, b.soHoaDon].join(' ').toLowerCase().includes(q);
    });
  // [B279 24/11] deps PHẢI có `banks`: lọc CA đi qua caCuaBank(bankId) đọc mốc ca của ngân hàng —
  // thiếu dep thì đổi mốc ca xong bộ lọc vẫn dùng mốc cũ tới khi có state khác đổi (lớp lỗi B259/L7).
  }, [danhSach, banks, fTim, fTid, fHkd, fDaiLy, fNdt, fBank, fCa, fThe, fPhi, fLo, fSoHd, fChiDong95, fNguoiHoan, fTu, fDen]);
  const tongLoc = danhSachLoc.reduce((s, b) => s + b.tienLo, 0);
  // [B236 22/11 — Admin Demo "thiết kế cho tách theo tid, ngân hàng"] GOM LÃI NĐT theo NĐT → NGÂN HÀNG → TID.
  // Số do MÁY CHỦ tính sẵn theo công thức Admin Demo chốt; ở đây CHỈ CỘNG, không tính lại (tiền NĐT = cấm suy luận).
  const baoCaoNdt = useMemo(() => {
    const m = new Map<string, {
      ndt: string; bank: string; tid: string; soBill: number; doanhSo: number; sauPhi: number;
      lai: number; alphaBan: number; alphaDoiTac: number; chuaKhai: number;
    }>();
    for (const b of danhSachLoc) {
      const ndt = (b.ndt || '').trim() || 'Chưa gán NĐT';
      const k = ndt + '|' + b.bank + '|' + b.tid;
      const o = m.get(k) ?? { ndt, bank: b.bank, tid: b.tid, soBill: 0, doanhSo: 0, sauPhi: 0, lai: 0, alphaBan: 0, alphaDoiTac: 0, chuaKhai: 0 };
      o.soBill++;
      o.doanhSo += b.tienLo;
      o.sauPhi += b.nhanVe;
      o.alphaDoiTac += b.alphaDoiTac ?? 0;
      // [B295] alphaDoiTac null cũng là CHƯA KHAI — trước đây chỉ laiNdt/alphaBan được đếm, cột bên cạnh
      // cộng 0 câm (2 cột cùng bảng 2 cách xử lý — L7).
      if (b.laiNdt == null || b.alphaBan == null || b.alphaDoiTac == null) o.chuaKhai++;
      else { o.lai += b.laiNdt; o.alphaBan += b.alphaBan; }
      m.set(k, o);
    }
    return [...m.values()].sort((a, b) =>
      a.ndt.localeCompare(b.ndt) || a.bank.localeCompare(b.bank) || a.tid.localeCompare(b.tid));
  }, [danhSachLoc]);
  const tongBaoCaoNdt = useMemo(() => baoCaoNdt.reduce((t, x) => ({
    soBill: t.soBill + x.soBill, doanhSo: t.doanhSo + x.doanhSo, sauPhi: t.sauPhi + x.sauPhi,
    lai: t.lai + x.lai, alphaBan: t.alphaBan + x.alphaBan, alphaDoiTac: t.alphaDoiTac + x.alphaDoiTac,
    chuaKhai: t.chuaKhai + x.chuaKhai
  }), { soBill: 0, doanhSo: 0, sauPhi: 0, lai: 0, alphaBan: 0, alphaDoiTac: 0, chuaKhai: 0 }), [baoCaoNdt]);
  const [moBaoCaoNdt, setMoBaoCaoNdt] = useState(false);
  const tongVe = danhSachLoc.reduce((s, b) => s + b.nhanVe, 0);
  const tongSauMuaNdt = danhSachLoc.reduce((s, b) => s + (b.sauMuaNdt ?? 0), 0);
  // [B277 24/11 — audit doanh số] ĐẾM bill CHƯA KHAI phí mua NĐT/phí cài máy: tổng dùng `?? 0` nên thiếu
  // tiền trong IM LẶNG (đo sổ thật: 20 lô = 933 triệu doanh số chưa khai ⇒ tổng "Sau mua NĐT" hụt gần 1 tỷ
  // không một lời). Excel đã ghi "— n bill chưa khai" từ B237; màn phải NÓI Y HỆT (màn ≠ file là lớp lỗi L7).
  const soChuaKhaiMuaNdt = danhSachLoc.reduce((s, b) => s + (b.sauMuaNdt == null ? 1 : 0), 0);
  const soChuaKhaiCaiMay = danhSachLoc.reduce((s, b) => s + (b.sauPhiCaiMay == null ? 1 : 0), 0);
  // [B245 22/11 — Admin Demo "bảng thiếu tổng sau phí cm"] MỌI cột tiền phải có tổng ở đáy.
  const tongSauPhiCaiMay = danhSachLoc.reduce((s, b) => s + (b.sauPhiCaiMay ?? 0), 0);
  // [TIỀN CHỜ 25/11 — Admin Demo sửa công thức] PHẢI THU = LÃI SIGMA = (%phí BÁN − %phí MUA đối tác) × doanh số
  // trước phí. Chỉ tính bill có ĐỦ cả phiPct & muaPct ("—" / KHÔNG cộng khi thiếu — cấm bịa 0). Hàm dùng
  // CHUNG cho ô từng dòng + hàng TỔNG + Excel để không lệch.
  const phaiThuCuaBill = (b: BillDaGhi): number | null =>
    b.phiPct != null && b.muaPct != null ? Math.round((b.tienLo * (b.phiPct - b.muaPct)) / 100) : null;
  const tongPhaiThu = danhSachLoc.reduce((s, b) => s + (phaiThuCuaBill(b) ?? 0), 0);
  // Bill CHƯA tính được phải thu (thiếu % phí bán hoặc % phí mua đối tác) — đánh dấu để tổng không bị hiểu
  // nhầm là đã đủ (R198: cấm nuốt).
  const soThieuPhaiThu = danhSachLoc.reduce((s, b) => s + (phaiThuCuaBill(b) == null ? 1 : 0), 0);
  const tongDaHoan = danhSachLoc.reduce((s, b) => s + b.daHoan, 0);
  // CHÊNH LỆCH = tiền sau phí bán − đã hoàn.  > 0 ⇒ còn HOÀN THIẾU (xanh lá, bình thường)
  //                                            < 0 ⇒ HOÀN THỪA (đỏ, phải cảnh báo — tiền ra khỏi nhà)
  const chenhLech = tongVe - tongDaHoan;
  // LÃI của kỳ (Admin Demo 6/11): chênh lệch sau bán = phí bán − phí mua, tính trên tiền ĐÃ TRỪ hủy của từng bill.
  // [B295/F6 24/11] ĐẾM bill bị bỏ khỏi lãi kỳ (thiếu % phí) — cộng 0 câm là KPI thiếu tiền không ai biết.
  const soBoLaiKy = danhSachLoc.reduce((t, b) => t + (b.phiPct == null || b.muaPct == null ? 1 : 0), 0);
  const laiKy = danhSachLoc.reduce(
    (t, b) => t + (b.phiPct != null && b.muaPct != null ? Math.round((b.tienLo * (b.phiPct - b.muaPct) * 1000) / 100000) : 0),
    0
  );
  const hoanThua = chenhLech < 0;
  // ── BÁO CÁO MÁY CHẠY / KHÔNG CHẠY THEO KỲ (Admin Demo 6/11) ─────────────────────────────────────────
  // Chỉ lọc theo KỲ (từ ngày → đến ngày / hôm nay / tuần / tháng), KHÔNG áp bộ lọc TID — nếu áp thì
  // "máy không chạy" mất hết ý nghĩa. Đại lý/NĐT lấy từ chính cấu hình TID (nguồn tid-config).
  const billTrongKy = useMemo(
    () => danhSach.filter((b) => (!fTu || b.ngay >= fTu) && (!fDen || b.ngay <= fDen)),
    [danhSach, fTu, fDen]
  );
  const doanhSoTheoTid = useMemo(() => {
    const m = new Map<string, { tien: number; soBill: number }>();
    for (const b of billTrongKy) {
      const cu = m.get(b.tid) ?? { tien: 0, soBill: 0 };
      m.set(b.tid, { tien: cu.tien + b.tienLo, soBill: cu.soBill + 1 });
    }
    return m;
  }, [billTrongKy]);
  /** Mọi TID đang hoạt động, kèm doanh số trong kỳ (0 = KHÔNG phát sinh giao dịch). */
  const bangTid = useMemo(() => {
    const ndtCuaTid = (t: ConfigTidDto): string =>
      t.owyType === 'INVESTOR' ? t.owyName ?? 'NĐT chưa đặt tên' : t.owyType ? '—' : '—';
    return tids
      .filter((t) => t.status === 'ACTIVE')
      .map((t) => {
        const d = doanhSoTheoTid.get(t.tid);
        return {
          tid: t.tid,
          hkd: t.hkdName ?? '—',
          bank: t.bankCode ?? t.bankName ?? '—',
          daiLy: t.customerName ?? 'CHƯA giao đại lý',
          ndt: ndtCuaTid(t),
          tien: d?.tien ?? 0,
          soBill: d?.soBill ?? 0
        };
      });
  }, [tids, doanhSoTheoTid]);
  // [B259 23/11 — Admin Demo "thêm full trường lọc: Bank, tid, HKD, ngân hàng, NĐT... của cả 2 blog"]
  // BỘ LỌC DÙNG CHUNG cho CẢ HAI bảng (không chạy / có chạy) — cùng ô brand như thanh lọc Doanh Số.
  const [fMayTid, setFMayTid] = useState<string[]>([]);
  const [fMayHkd, setFMayHkd] = useState<string[]>([]);
  const [fMayBank, setFMayBank] = useState<string[]>([]);
  const [fMayDaiLy, setFMayDaiLy] = useState<string[]>([]);
  const [fMayNdt, setFMayNdt] = useState<string[]>([]);
  const locMay = useCallback(
    (ds: typeof bangTid): typeof bangTid =>
      ds.filter((x) =>
        (fMayTid.length === 0 || fMayTid.includes(x.tid))
        && (fMayHkd.length === 0 || fMayHkd.includes(x.hkd))
        && (fMayBank.length === 0 || fMayBank.includes(x.bank))
        && (fMayDaiLy.length === 0 || fMayDaiLy.includes(x.daiLy))
        && (fMayNdt.length === 0 || fMayNdt.includes(x.ndt))),
    [fMayTid, fMayHkd, fMayBank, fMayDaiLy, fMayNdt]
  );
  /** Danh sách chọn của 1 cột — rút TỪ CHÍNH dữ liệu đang có (giá trị = đúng chuỗi đem so, bài học B256). */
  const mucMay = useCallback(
    (lay: (x: (typeof bangTid)[number]) => string) =>
      [...new Set(bangTid.map(lay).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi')).map((v) => ({ value: v, label: v })),
    [bangTid]
  );
  const tidKhongChay = useMemo(() => locMay(bangTid.filter((x) => x.soBill === 0)), [bangTid, locMay]);
  const tidCoChay = useMemo(
    () => [...locMay(bangTid.filter((x) => x.soBill > 0))].sort((a, b) => (sapXep === 'cao' ? b.tien - a.tien : a.tien - b.tien)),
    // THIẾU `locMay` ở đây là bảng này KHÔNG lọc theo (giá trị cũ bị nhớ lại) — cổng đo thật bắt được:
    // bảng trái còn 9 dòng mà bảng phải vẫn 33 dòng y nguyên.
    [bangTid, sapXep, locMay]
  );
  const nhanKy = fTu || fDen ? (fTu ? ngayNgan(fTu) : '…') + (fTu === fDen ? '' : ' → ' + (fDen ? ngayNgan(fDen) : '…')) : 'Tất cả';

  // ── DỮ LIỆU BIỂU ĐỒ TĂNG TRƯỞNG (Admin Demo 6/11) ────────────────────────────────────────────────
  // Gom theo NGÀY hoặc theo THÁNG trên chính danh sách ĐANG LỌC (đổi bộ lọc/kỳ là đồ thị đổi theo).
  const duLieuBieuDo = useMemo(() => {
    const m = new Map<string, { tien: number; soBill: number }>();
    for (const b of danhSachLoc) {
      const k = mocBieuDo === 'ngay' ? b.ngay : b.ngay.slice(0, 7);
      const cu = m.get(k) ?? { tien: 0, soBill: 0 };
      m.set(k, { tien: cu.tien + b.tienLo, soBill: cu.soBill + 1 });
    }
    return [...m.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => ({
        khoa: k,
        nhan: mocBieuDo === 'ngay' ? k.slice(8) + '/' + k.slice(5, 7) : k.slice(5, 7) + '/' + k.slice(0, 4),
        ...v
      }));
  }, [danhSachLoc, mocBieuDo]);

  function xoaLoc(): void {
    setFTim('');
    setFTid([]);
    setFHkd([]);
    setFDaiLy([]);
    setFNdt([]);
    setFBank([]);
    setFCa([]);
    setFTu(homNayHCM);
    setFDen(homNayHCM);
    setFThe([]);
    setFPhi([]);
    setFLo('');
    setFSoHd('');
    setFChiDong95(false);
    setFNguoiHoan([]);
  }

  /** [B247] Các NĐT có mặt trong danh sách ĐANG LỌC, kèm số bill — để tích chọn lúc xuất file.
   *  Bill chưa gán NĐT gom vào một mục riêng (KHÔNG bỏ rơi, đúng luật "không nuốt dòng nào"). */
  const KHONG_NDT = 'Chưa gán NĐT';
  const dsNdtXuat = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of danhSachLoc) {
      const k = (b.ndt || '').trim() || KHONG_NDT;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'vi')).map(([ten, soBill]) => ({ ten, soBill }));
  }, [danhSachLoc]);
  /** Danh sách bill sẽ ĐƯA VÀO FILE sau khi áp tích chọn NĐT (không tích gì = lấy hết). */
  const danhSachXuat = useMemo(
    () => (exNdtChon.length === 0 ? danhSachLoc : danhSachLoc.filter((b) => exNdtChon.includes((b.ndt || '').trim() || KHONG_NDT))),
    [danhSachLoc, exNdtChon]
  );

  /** [B228] Dựng dữ liệu một sheet: bảng bill + 2 khối báo cáo TID xếp dưới cùng. */
  function dungSheet(ten: string, ds: typeof danhSachLoc): {
    sheetName: string; title: string; headers: string[];
    rows: (string | number | null | undefined)[][];
    khoiPhu: { tieuDe: string; headers: string[]; rows: (string | number | null | undefined)[][]; coHangTong?: boolean }[];
    cotTien: string[]; cotRong: string[]; cotGiua: string[];
  } {
    // [B238/B239 22/11] Cột xuất đi ĐÚNG THỨ TỰ bảng trên màn, và tôn trọng 3 ô tích ẩn.
    const caCua = (b: (typeof ds)[number]): string => caCuaBill(b.bank, b.gio, caCuaBank(b.bankId))?.ten ?? '';
    // [TIỀN CHỜ 25/11] File Excel PHẢI khớp bảng trên màn tiền chờ: ẩn 10 cột (Giờ · Ca · Lô · Số HĐ · % Mua
    // NĐT · Sau mua NĐT · Đã hoàn · Chênh lệch · Người hoàn · NĐT), "Ngày"→"Tháng" (YYYY-MM), thêm "Phải thu".
    const headers = cheDoTienCho
      ? [
          'Tháng',
          ...(exAnDaiLy ? [] : ['Đại lý']),
          'TID', 'HKD', 'NH', 'Thẻ',
          'Trước phí', '% CM', 'Sau phí CM',
          ...(exAnMuaDt ? [] : ['% Mua']),
          '% Bán', 'Sau phí bán', 'Phải thu',
          'Loại phí',
          ...(exAnNguoiNhap ? [] : ['Người nhập']),
          'Ghi chú'
        ]
      : [
      'Ngày', 'Giờ', 'Ca',
      ...(exAnDaiLy ? [] : ['Đại lý']),
      'TID', 'HKD', 'NH', 'Thẻ', 'Lô', 'Số HĐ',
      // [B266 25/11 — Admin Demo đảo cột, "excell phải đồng nhất"] Thứ tự cột file PHẢI khớp bảng trên màn:
      // Trước phí → % CM → Sau phí CM → % Mua → % Bán → Sau phí bán → % Mua NĐT → Sau mua NĐT → Đã hoàn.
      'Trước phí', '% CM', 'Sau phí CM',
      ...(exAnMuaDt ? [] : ['% Mua']),
      '% Bán', 'Sau phí bán',
      '% Mua NĐT', 'Sau mua NĐT', 'Đã hoàn', 'Chênh lệch', 'Người hoàn', 'NĐT',
      'Loại phí',
      ...(exAnNguoiNhap ? [] : ['Người nhập']),
      'Ghi chú'
    ];
    const rows = ds.map((b) => cheDoTienCho
      ? [
          b.ngay.slice(0, 7),
          ...(exAnDaiLy ? [] : [b.daiLy]),
          b.tid, b.hkd, b.bank, tenTheNgan(b.loaiThe),
          b.tienLo, b.caiMayPct, b.sauPhiCaiMay ?? '',
          ...(exAnMuaDt ? [] : [b.muaPct]),
          b.phiPct, b.nhanVe,
          phaiThuCuaBill(b) ?? '', // Phải thu = doanh số × (%bán − %mua đối tác)
          b.loaiPhi,
          ...(exAnNguoiNhap ? [] : [b.nguoiNhap]),
          b.ghiChu
        ]
      : [
      ngayNgan(b.ngay), b.gio, caCua(b),
      ...(exAnDaiLy ? [] : [b.daiLy]),
      b.tid, b.hkd, b.bank, tenTheNgan(b.loaiThe), b.lo, b.soHoaDon,
      // [B266 25/11] khớp header mới: Trước phí · % CM · Sau phí CM · % Mua · % Bán · Sau phí bán · % Mua NĐT · Sau mua NĐT · Đã hoàn.
      b.tienLo, b.caiMayPct, b.sauPhiCaiMay ?? '',
      ...(exAnMuaDt ? [] : [b.muaPct]),
      b.phiPct, b.nhanVe,
      b.phiMuaNdtPct ?? '', b.sauMuaNdt ?? '', b.daHoan, b.nhanVe - b.daHoan, b.nguoiHoan, b.ndt, // [B294] cùng quy ước chênh lệch với màn
      b.loaiPhi,
      ...(exAnNguoiNhap ? [] : [b.nguoiNhap]),
      b.ghiChu
    ]);

    // [B244 22/11 — Admin Demo "blog báo cáo phải có sau phí mua nhà đầu tư chứ"] Mọi khối báo cáo dưới
    // bảng đều phải có SAU PHÍ MUA NĐT, không chỉ doanh số trước phí.
    // Bill nào CHƯA KHAI phí mua NĐT thì KHÔNG được âm thầm cộng 0 — đếm riêng rồi ghi rõ ra ô
    // ("— 3 bill chưa khai"), nếu không tổng sẽ bị thổi lên mà người đọc không biết (R198: cấm nuốt).
    type GomTid = { tid: string; hkd: string; khoa: string; soBill: number; tien: number; sauPhi: number; sauNdt: number; thieu: number };
    const gom = (lay: (b: (typeof ds)[number]) => string): Map<string, GomTid> => {
      const m = new Map<string, GomTid>();
      for (const b of ds) {
        const khoa = lay(b);
        const k = b.tid + '|' + khoa;
        const o = m.get(k) ?? { tid: b.tid, hkd: b.hkd, khoa, soBill: 0, tien: 0, sauPhi: 0, sauNdt: 0, thieu: 0 };
        o.soBill++; o.tien += b.tienLo; o.sauPhi += b.nhanVe;
        if (b.sauMuaNdt == null) o.thieu++; else o.sauNdt += b.sauMuaNdt;
        m.set(k, o);
      }
      return m;
    };
    const oSauNdt = (x: GomTid): string | number =>
      x.thieu === x.soBill ? '— ' + x.thieu + ' bill chưa khai'
        : x.thieu ? x.sauNdt + ' (thiếu ' + x.thieu + ' bill)' : x.sauNdt;
    // KHỐI 1 — tổng doanh số từng TID THEO CA.
    const theoCa = gom((b) => caCua(b) || '(không rõ ca)');
    // KHỐI 2 — tổng doanh số từng TID THEO NGÀY.
    const theoNgay = gom((b) => ngayNgan(b.ngay));
    const sapTid = <T extends { tid: string }>(a: T, b: T): number => a.tid.localeCompare(b.tid);
    // [B248 22/11 — Admin Demo "thiếu hàng tổng dưới đáy blog này"] Khối nào có cột tiền thì phải có
    // hàng TỔNG ở đáy, y như bảng chính. Chỉ cộng khi khối có >1 dòng (1 dòng thì hàng tổng là thừa).
    const hangTongTid = (ds: GomTid[]): (string | number | null | undefined)[][] => {
      if (ds.length <= 1) return [];
      const thieu = ds.reduce((t, x) => t + x.thieu, 0);
      const sauNdt = ds.reduce((t, x) => t + x.sauNdt, 0);
      return [[
        'TỔNG ' + ds.length + ' dòng', '', '',
        ds.reduce((t, x) => t + x.soBill, 0),
        ds.reduce((t, x) => t + x.tien, 0),
        ds.reduce((t, x) => t + x.sauPhi, 0),
        // Giữ KIỂU SỐ khi không thiếu bill — `số + ''` ra chuỗi, Excel mất dấu ngăn nghìn.
        thieu ? sauNdt + ' (thiếu ' + thieu + ' bill)' : sauNdt
      ]];
    };
    return {
      sheetName: ten,
      title: 'Danh sách bill ' + nhanKy + (ten !== 'Dữ liệu' ? ' — NĐT ' + ten : ''),
      headers,
      rows,
      // [B232 22/11 — Admin Demo] Khai TƯỜNG MINH cột tiền / cột cần nới / cột căn giữa. KHÔNG đoán theo
      // "ô là số thì là tiền": cột % cũng là số, đoán nhầm thì 1,25% thành "1" và bị nới oan.
      cotTien: cheDoTienCho
        ? ['Trước phí', 'Sau phí bán', 'Sau phí CM', 'Phải thu']
        : ['Trước phí', 'Sau phí bán', 'Sau phí CM', 'Sau mua NĐT', 'Đã hoàn', 'Chênh lệch'],
      cotRong: ['HKD'],
      cotGiua: cheDoTienCho
        ? ['% CM', '% Bán', '% Mua', 'Tháng']
        : ['% CM', '% Bán', '% Mua', '% Mua NĐT', 'Ca', 'Ngày', 'Giờ'],
      // [TIỀN CHỜ] Bỏ các khối phụ (theo CA / lãi NĐT / theo NGÀY) — màn tiền chờ không có ca/NĐT; sheet
      // chính đã đủ. Tránh khối rỗng/sai ngữ cảnh.
      khoiPhu: cheDoTienCho ? [] : [
        {
          tieuDe: 'Tổng doanh số từng TID theo CA',
          coHangTong: theoCa.size > 1,
          headers: ['TID', 'HKD', 'Ca', 'Số bill', 'Doanh số trước phí', 'Sau phí bán', 'Sau phí mua NĐT'],
          rows: (() => {
            const ds = [...theoCa.values()].sort((a, b) => sapTid(a, b) || a.khoa.localeCompare(b.khoa));
            return [...ds.map((x) => [x.tid, x.hkd, x.khoa, x.soBill, x.tien, x.sauPhi, oSauNdt(x)]), ...hangTongTid(ds)];
          })()
        },
        {
          // [B236 22/11 — Admin Demo] LÃI NĐT & SIGMA THU VỀ, tách theo NĐT → NGÂN HÀNG → TID.
          // Số do MÁY CHỦ tính (công thức Admin Demo chốt 22/11) — ở đây chỉ gom, KHÔNG tính lại.
          tieuDe: 'Lãi nhà đầu tư và tiền SigMa thu về (theo TID)',
          coHangTong: true, // khối này tự thêm hàng TỔNG khi có >1 nhóm
          // [B244 22/11 — Admin Demo "blog excel phải hiện sau phí mua NĐT, % phí mua NĐT"] Khối này nay
          // có ĐỦ % MUA NĐT + SAU PHÍ MUA NĐT để đọc được mạch tiền: doanh số → sau phí bán →
          // sau phí mua NĐT → lãi NĐT / SigMa thu. Ô tích "Ẩn % mua đối tác" CHỈ giấu phần ĐỐI TÁC,
          // KHÔNG đụng tới cột NĐT.
          headers: ['Nhà đầu tư', 'Ngân hàng', 'TID', 'Số bill', 'Doanh số', 'Sau phí bán',
            '% Mua NĐT', 'Sau phí mua NĐT', 'Lãi NĐT', 'SigMa bán',
            ...(exAnMuaDt ? [] : ['SigMa đối tác']), 'SigMa tổng'],
          rows: (() => {
            const m = new Map<string, { ndt: string; bank: string; tid: string; soBill: number; doanhSo: number; sauPhi: number; sauNdt: number; pct: Set<number>; lai: number; aBan: number; aDt: number; chuaKhai: number }>();
            for (const b of ds) {
              const ndt = (b.ndt || '').trim() || 'Chưa gán NĐT';
              const k = ndt + '|' + b.bank + '|' + b.tid;
              const o = m.get(k) ?? { ndt, bank: b.bank, tid: b.tid, soBill: 0, doanhSo: 0, sauPhi: 0, sauNdt: 0, pct: new Set<number>(), lai: 0, aBan: 0, aDt: 0, chuaKhai: 0 };
              o.soBill++; o.doanhSo += b.tienLo; o.sauPhi += b.nhanVe; o.aDt += b.alphaDoiTac ?? 0;
              if (b.phiMuaNdtPct != null) o.pct.add(b.phiMuaNdtPct);
              if (b.sauMuaNdt != null) o.sauNdt += b.sauMuaNdt;
              if (b.laiNdt == null || b.alphaBan == null) o.chuaKhai++;
              else { o.lai += b.laiNdt; o.aBan += b.alphaBan; }
              m.set(k, o);
            }
            const ds2 = [...m.values()].sort((a, b) => a.ndt.localeCompare(b.ndt) || a.bank.localeCompare(b.bank) || a.tid.localeCompare(b.tid));
            // 1 TID có thể gồm NHIỀU loại thẻ ⇒ nhiều mức % mua NĐT khác nhau. Không gộp bừa thành
            // 1 số (sai), mà liệt kê các mức đang có để người đọc thấy ngay là nhóm thẻ hỗn hợp.
            const oPct = (x: (typeof ds2)[number]): string | number =>
              x.pct.size === 0 ? '— chưa khai' : x.pct.size === 1 ? [...x.pct][0] : [...x.pct].sort((a, b) => a - b).map((v) => pctSo(v)).join(' / ');
            const oSau = (x: (typeof ds2)[number]): string | number =>
              x.chuaKhai === x.soBill ? '— ' + x.chuaKhai + ' bill chưa khai'
                : x.chuaKhai ? x.sauNdt + ' (thiếu ' + x.chuaKhai + ' bill)' : x.sauNdt;
            const r: (string | number | null | undefined)[][] = ds2.map((x) => [
              x.ndt + (x.chuaKhai ? ' (' + x.chuaKhai + ' bill chưa khai phí mua NĐT)' : ''),
              x.bank, x.tid, x.soBill, x.doanhSo, x.sauPhi,
              oPct(x), oSau(x),
              x.chuaKhai === x.soBill ? '' : x.lai,
              x.chuaKhai === x.soBill ? '' : x.aBan,
              ...(exAnMuaDt ? [] : [x.aDt]),
              (x.chuaKhai === x.soBill ? 0 : x.aBan) + x.aDt
            ]);
            if (ds2.length > 1) {
              const thieuTong = ds2.reduce((t, x) => t + x.chuaKhai, 0);
              r.push(['TỔNG', '', '', ds2.reduce((t, x) => t + x.soBill, 0), ds2.reduce((t, x) => t + x.doanhSo, 0),
                ds2.reduce((t, x) => t + x.sauPhi, 0), '',
                // GIỮ KIỂU SỐ khi không thiếu bill — `số + ''` ra CHUỖI, Excel mất dấu ngăn nghìn.
                thieuTong
                  ? ds2.reduce((t, x) => t + x.sauNdt, 0) + ' (thiếu ' + thieuTong + ' bill)'
                  : ds2.reduce((t, x) => t + x.sauNdt, 0),
                ds2.reduce((t, x) => t + x.lai, 0),
                ds2.reduce((t, x) => t + x.aBan, 0),
                ...(exAnMuaDt ? [] : [ds2.reduce((t, x) => t + x.aDt, 0)]),
                ds2.reduce((t, x) => t + x.aBan + x.aDt, 0)]);
            }
            return r;
          })()
        },
        {
          tieuDe: 'Tổng doanh số từng TID theo NGÀY',
          coHangTong: theoNgay.size > 1,
          headers: ['TID', 'HKD', 'Ngày', 'Số bill', 'Doanh số trước phí', 'Sau phí bán', 'Sau phí mua NĐT'],
          rows: (() => {
            const ds = [...theoNgay.values()].sort((a, b) => sapTid(a, b) || a.khoa.localeCompare(b.khoa));
            return [...ds.map((x) => [x.tid, x.hkd, x.khoa, x.soBill, x.tien, x.sauPhi, oSauNdt(x)]), ...hangTongTid(ds)];
          })()
        }
      ]
    };
  }

  async function xuatExcel(): Promise<void> {
    if (danhSachLoc.length === 0) return toast.alert('Không có bill nào trong bộ lọc để xuất.', 'Danh sách rỗng');
    setMoTuyChonExcel(true); // [B228] mở hộp tích chọn trước, bấm "Xuất" mới chạy thật
  }

  /**
   * [B227 22/11 — Admin Demo "lỗi không xuất được excel"] TRƯỚC ĐÂY nút gọi `window.api.exportBillLeExcel` —
   * hàm CHỈ TỒN TẠI trong bản demo (`_mock-api-alpha.ts`), KHÔNG có trong preload/main/web-shim, nên app
   * thật luôn rơi vào nhánh "Bản demo chưa nối API xuất Excel" ⇒ nút CHƯA TỪNG xuất được (lỗi "làm xong
   * nhưng không cắm dây"). Nay đi `exportCsv()` — đường .xlsx chuẩn nhà đã chạy thật ở các màn khác.
   */
  async function xuatExcelThat(): Promise<void> {
    // [B247] Tích chọn NĐT mà ra 0 bill thì DỪNG và nói rõ, không ghi ra file rỗng.
    if (danhSachXuat.length === 0) {
      return toast.alert('Các nhà đầu tư đang tích không có bill nào trong kỳ này.', 'Không có gì để xuất');
    }
    setMoTuyChonExcel(false);
    if (!exTachSheetNdt) {
      const sh = dungSheet('Dữ liệu', danhSachXuat);
      return exportCsv('doanh-so-bill', sh.headers, sh.rows, sh.title, sh.khoiPhu, { cotTien: sh.cotTien, cotRong: sh.cotRong, cotGiua: sh.cotGiua });
    }
    // [B231 22/11 — Admin Demo "mỗi NĐT 1 file"] Tách thành NHIỀU FILE, mỗi nhà đầu tư một file .xlsx.
    // Bill chưa gán NĐT gom vào file riêng, KHÔNG bỏ rơi.
    const nhom = new Map<string, typeof danhSachLoc>();
    for (const b of danhSachXuat) {
      const k = (b.ndt || '').trim() || 'Chưa gán NĐT';
      nhom.set(k, [...(nhom.get(k) ?? []), b]);
    }
    const ngayXuat = new Date();
    const dauNgay = ngayXuat.getDate() + '.' + (ngayXuat.getMonth() + 1) + '.' + ngayXuat.getFullYear();
    // Ký tự Windows KHÔNG nhận trong tên file. Tên NĐT do người dùng đặt nên phải lọc.
    const KY_TU_CAM_TEN_FILE = new RegExp('[' + String.fromCharCode(92) + '/:*?"<>|]', 'g');
    const files = [...nhom.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([ten, ds]) => ({
      // Tên file CẤM ký tự Windows không nhận (\ / : * ? " < > |) — tên NĐT do người dùng đặt, không tin được.
      fileName: ('Danh sách bill - ' + ten + ' ' + dauNgay).replace(KY_TU_CAM_TEN_FILE, '-') + '.xlsx',
      sheet: dungSheet(ten, ds)
    }));
    await exportNhieuFile(files);
  }

  /** Xuất Excel BÁO CÁO MÁY (không chạy + doanh số theo TID) — cùng đường xuất thật với danh sách bill. */
  async function xuatExcelMay(): Promise<void> {
    if (tidKhongChay.length === 0 && tidCoChay.length === 0) {
      return toast.alert('Kỳ này không có máy nào để xuất.', 'Danh sách rỗng');
    }
    // Tên trường phải lấy ĐÚNG từ `bangTid` (tien · soBill), KHÔNG đoán: viết `doanhSo` thì tsc vẫn xanh
    // (vì kiểu khai báo tại chỗ) mà cột doanh số xuất ra TOÀN SỐ 0 — sai số tiền mà không ai báo.
    // [B261 23/11 — Admin Demo "không chạy 1 sheet, có chạy 1 sheet riêng đúng brand alpha"]
    // Thứ tự cột GIỐNG HỆT bảng trên màn (HKD → TID → NH → Đại lý → NĐT …) để đọc file không phải dò lại.
    const COT_CHUNG = ['HKD', 'TID', 'NH', 'Đại lý cầm', 'NĐT'];
    const dongChung = (m: (typeof bangTid)[number]): (string | number)[] => [m.hkd, m.tid, m.bank, m.daiLy, m.ndt];
    await exportNhieuSheet(
      'bao-cao-may',
      [
        {
          sheetName: 'Không chạy',
          title: 'Máy KHÔNG phát sinh giao dịch — kỳ ' + nhanKy,
          headers: COT_CHUNG,
          rows: tidKhongChay.map(dongChung),
          cotRong: ['HKD']
        },
        {
          sheetName: 'Có chạy',
          title: 'Máy CÓ phát sinh — theo doanh số — kỳ ' + nhanKy,
          headers: [...COT_CHUNG, 'Số bill', 'Doanh số trước phí'],
          rows: tidCoChay.map((m) => [...dongChung(m), m.soBill, m.tien]),
          cotTien: ['Doanh số trước phí'],
          cotRong: ['HKD']
        }
      ],
      'Báo cáo máy ' + nhanKy
    );
  }

  async function moFileExcel(): Promise<void> {
    const api = window.api as unknown as { openFile?: (p: string) => Promise<unknown> };
    if (ketQuaExcel && api.openFile) await api.openFile(ketQuaExcel.path);
    setKetQuaExcel(null);
  }

  /** Kỳ nhanh (Admin Demo 6/11): hôm nay · tuần này (T2→CN) · tháng này. Mốc tính theo giờ HCM. */
  function chonKy(ky: 'homnay' | 'tuan' | 'thang'): void {
    const hcm = (d: Date): string => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    const nay = new Date();
    if (ky === 'homnay') {
      setFTu(hcm(nay));
      setFDen(hcm(nay));
      return;
    }
    if (ky === 'tuan') {
      const thu = (nay.getDay() + 6) % 7; // 0 = thứ Hai
      const t2 = new Date(nay);
      t2.setDate(nay.getDate() - thu);
      const cn = new Date(t2);
      cn.setDate(t2.getDate() + 6);
      setFTu(hcm(t2));
      setFDen(hcm(cn));
      return;
    }
    const dau = new Date(nay.getFullYear(), nay.getMonth(), 1);
    const cuoi = new Date(nay.getFullYear(), nay.getMonth() + 1, 0);
    setFTu(hcm(dau));
    setFDen(hcm(cuoi));
  }

  function doiTich(id: string): void {
    setDaTich((cu) => {
      const m = new Set(cu);
      if (m.has(id)) m.delete(id);
      else m.add(id);
      return m;
    });
  }
  /** DEMO: bỏ khỏi danh sách tại chỗ. BẢN THẬT: bill là CHỨNG TỪ — hủy phải qua DUYỆT
   *  (khuôn Transaction P1.2: CANCEL_PENDING → CANCELLED), KHÔNG xóa cứng. */
  /** NGƯỠNG BẢO MẬT (Admin Demo 6/11): sửa/xóa từ 10 bill trở lên trong NGÀY phải có quyền cao.
   *  Dùng đúng khuôn các thao tác nguy hiểm khác của SigMa (xóa TID/POS): hỏi mật khẩu + kiểm quyền. */
  const NGUONG_BILL_NGAY = 10;
  const coQuyenHangLoat =
    (user.permissions ?? []).includes('TXN_MANAGE') || (user.roles ?? []).includes('ADMIN');
  const [daSuaXoaHomNay, setDaSuaXoaHomNay] = useState(0);
  // Chỉ những bill ĐANG HIỆN mới được phép xóa. Nếu không cắt, tập tích giữ id của tập cũ.
  const idDangHien = useMemo(() => new Set(danhSachLoc.map((b) => b.id)), [danhSachLoc]);
  const tichHopLe = useMemo(() => [...daTich].filter((id) => idDangHien.has(id)), [daTich, idDangHien]);
  const billSapXoa = useMemo(() => danhSachLoc.filter((b) => daTich.has(b.id)), [danhSachLoc, daTich]);
  // Bộ lọc đổi ⇒ dọn luôn tập tích cho khớp cái đang thấy, để con số trên nút không bao giờ nói dối.
  useEffect(() => {
    setDaTich((cu) => {
      const moi = new Set([...cu].filter((id) => idDangHien.has(id)));
      return moi.size === cu.size ? cu : moi;
    });
  }, [idDangHien]);
  const vuotNguong = daSuaXoaHomNay + tichHopLe.length > NGUONG_BILL_NGAY;

  function moHopXoa(): void {
    if (tichHopLe.length === 0) return;
    if (vuotNguong && !coQuyenHangLoat)
      return toast.alert(
        'Hôm nay đã sửa/xóa ' + daSuaXoaHomNay + ' bill. Từ ' + NGUONG_BILL_NGAY + ' bill/ngày trở lên phải có QUYỀN BẢO MẬT (TXN_MANAGE hoặc Admin) — báo quản lý cấp quyền.',
        'Vượt ngưỡng, cần cấp quyền'
      );
    setHoiXoa(true);
  }
  /** [B186 19/11 — Admin Demo "tích chọn xóa bill xong chuyển màn khác bill ko xóa được vẫn còn nguyên"]
   *  TRƯỚC ĐÂY hàm này CHỈ lọc dòng khỏi mảng trên màn hình, KHÔNG gọi máy chủ một lần nào, lại còn báo
   *  "DEMO — đã bỏ N bill" ⇒ người dùng tin là đã xóa; đổi màn (danh sách nạp lại từ sổ) thì bill còn nguyên
   *  và DOANH SỐ VẪN ĐANG TÍNH. Bill là CHỨNG TỪ nên không xóa cứng: nay GỬI YÊU CẦU HỦY lên máy chủ
   *  (POST /v1/cancel-requests) đúng khuôn duyệt hủy, rồi NẠP LẠI danh sách từ sổ để màn khớp sổ. */
  async function xoaDaTich(lyDo?: string): Promise<void> {
    const canXoa = tichHopLe.slice(); // CHỈ bill đang hiện — không bao giờ đụng bill ngoài tầm nhìn
    const n = canXoa.length;
    if (n === 0) return;
    const ghiChuHuy = (lyDo ?? '').trim();
    if (ghiChuHuy.length < 4) {
      toast.alert('Phải ghi LÝ DO hủy (ít nhất 4 ký tự) — yêu cầu hủy bill cần người duyệt đọc được lý do.', 'Thiếu lý do hủy');
      return;
    }
    const thieuGd = canXoa.filter((id) => !danhSach.find((b) => b.id === id)?.transactionId);
    if (thieuGd.length > 0) {
      toast.alert(
        'Có ' + thieuGd.length + ' bill chưa có mã giao dịch nên chưa gửi yêu cầu hủy được. Hãy bấm "Làm mới" rồi thử lại.',
        'Chưa gửi được yêu cầu hủy'
      );
      return;
    }
    setBusy(true);
    let xong = 0;
    const loiGui: string[] = [];
    for (const id of canXoa) {
      const b = danhSach.find((x) => x.id === id);
      if (!b?.transactionId) continue;
      try {
        const r = await window.api.cancelRequest(b.transactionId, ghiChuHuy);
        if (r?.ok) xong++;
        else loiGui.push('Bill lô ' + b.lo + ': ' + ((r as { message?: string })?.message ?? 'máy chủ từ chối'));
      } catch (e) {
        loiGui.push('Bill lô ' + b.lo + ': ' + String(e));
      }
    }
    setBusy(false);
    setDaTich(new Set());
    setHoiXoa(false);
    setDaSuaXoaHomNay((x) => x + xong);
    setLanTai((x) => x + 1); // nạp lại từ SỔ — màn phải khớp sổ, không tự ý giấu dòng
    if (loiGui.length > 0) {
      toast.alert(
        'Đã gửi ' + xong + '/' + n + ' yêu cầu hủy. Chưa gửi được: ' + loiGui.slice(0, 3).join(' · '),
        'Một số bill chưa gửi được yêu cầu hủy'
      );
    } else {
      toast.success('Đã gửi ' + xong + ' YÊU CẦU HỦY lên máy chủ — bill chỉ mất khỏi doanh số SAU KHI được duyệt ở màn "Quản lý dữ liệu yêu cầu duyệt hủy".');
    }
  }

  /** Sửa 1 bill: nạp số liệu trở lại form nhập. BẢN THẬT đi qua editBillParams (mật khẩu + ghi vết). */
  function suaBill(b: BillDaGhi): void {
    // [B316 24/11 — agent phản biện #C, NẶNG] LÔ TÁCH NHIỀU THẺ: form nạp về chế độ 1 thẻ với loại
    // thẻ/phí TỒN DƯ của bill trước đó ⇒ bấm Ghi là máy chủ DỰNG LẠI GD theo cơ cấu SAI "đúng quy
    // trình" (tái hiện: 2 thẻ → 1 thẻ, install per-thẻ về 0, không cảnh báo). Chặn rõ việc phải làm.
    if (b.cardTypeId == null && b.loaiThe === 'nhiều thẻ') {
      toast.alert(
        'Bill này TÁCH NHIỀU LOẠI THẺ — màn Sửa chưa nạp lại được từng dòng thẻ, sửa tiếp sẽ ghi đè '
          + 'thành bill 1 thẻ sai cơ cấu.' + XUONG_DONG + XUONG_DONG
          + 'CÁCH SỬA: bấm nút Xóa bill (gửi yêu cầu hủy) rồi nhập lại bill mới với tách thẻ đúng.',
        'Bill nhiều thẻ — chưa sửa trực tiếp được'
      );
      return;
    }
    if (daSuaXoaHomNay + 1 > NGUONG_BILL_NGAY && !coQuyenHangLoat) {
      toast.alert(
        'Hôm nay đã sửa/xóa ' + daSuaXoaHomNay + ' bill — từ ' + NGUONG_BILL_NGAY + ' bill/ngày phải có QUYỀN BẢO MẬT.',
        'Vượt ngưỡng, cần cấp quyền'
      );
      return;
    }
    // [V6] KHÔNG cộng ngưỡng ở đây. Mở form Sửa rồi bỏ ra 12 lần mà chưa sửa gì vẫn bị báo "đã sửa 12
    // bill" — ngưỡng chỉ được cộng khi thao tác THÀNH CÔNG (ghiNhan / xoaDaTich).
    setDangSuaId(b.id);
    // [B183] chốt khoá bill GỐC ngay lúc mở form sửa (tính từ chính bill, không phụ thuộc state đang đổi).
    const moGoc = /\((\d+)\)/.exec(b.lo);
    setKhoaBillGoc(billKeyPreview(b.tid, b.lo.replace(/\(.*\)/, ''), moGoc ? moGoc[1] : '', b.soHoaDon, b.ngay, b.gio));
    setGioDaDat(true); // bill cũ đã có giờ thật ⇒ phép so thứ tự lô/giờ có nghĩa
    setTachThe(false);
    setDongThe([]);
    setXacNhanTrung(false);
    setXacNhanHoanGop(false);
    // [B187 19/11] TUYỆT ĐỐI KHÔNG xoá `dangSuaId`/`khoaBillGoc` ở đây — vừa đặt ở trên xong. Bản vá trước
    // dán nhầm 2 dòng reset (vốn thuộc hàm GHI) vào đây ⇒ chế độ Sửa chết hẳn: chặn đổi khoá bill mất tác
    // dụng, và sửa bill rồi đổi số lô lại đẻ LÔ MỚI ⇒ doanh số đếm 2 lần (agent audit tái hiện: 1 bill
    // 3.444.000đ hoá 2 lô = 6.888.000đ).
    setMuonTid(false);
    setDaiLyMuonId('');
    setXacNhanMuon(false);
    // [N7] Nạp lại NGƯỜI HOÀN của bill. Thiếu bước này thì form Sửa luôn báo "phải chọn NGƯỜI HOÀN",
    // nút ghi bị khóa, buộc người dùng gán người KHÁC ⇒ GHI ĐÈ vết ai đã trả tiền.
    setNguoiHoanId(b.nguoiHoanId != null ? String(b.nguoiHoanId) : '');
    const t = tids.find((x) => x.tid === b.tid);
    // [B187] nạp lại NGÂN HÀNG rồi mới tới TID (ô TID bị khoá khi chưa chọn ngân hàng) và LOẠI THẺ của
    // chính bill — thiếu 2 bước này thì mở Sửa là màn báo "chưa chọn loại thẻ · chưa có giá bán thực tế".
    const maBank = b.bankId ?? (t?.bankId ?? null);
    if (maBank != null) setBankChon(String(maBank));
    if (t) setTidId(String(t.id));
    if (b.cardTypeId != null) setCardTypeId(String(b.cardTypeId));
    // [B268] nạp lại LOẠI PHÍ của chính bill. Thiếu bước này thì mở Sửa là ô loại phí nhảy về mặc
    // định, bấm ghi một phát là đổi phí bill cũ mà không ai thấy.
    if (b.feeTypeId != null) setFeeTypeId(String(b.feeTypeId));
    const mo = /\((\d+)\)/.exec(b.lo);
    setSoLo(b.lo.replace(/\(.*\)/, ''));
    setMaDongLo(mo ? mo[1] : '');
    setSoHoaDon(b.soHoaDon);
    setSoTien(String(b.tongQuet));
    setTienHuy(String(b.tienHuy));
    setDaHoan(String(b.daHoan));
    setGhiChu(b.ghiChu);
    setNgay(b.ngay);
    setGio(b.gio);
    setCheDo('nhap');
  }

  /** Lăn chuột = cuộn TRÒN SỐ DÒNG: mỗi nấc 3 dòng, điểm dừng luôn là bội số chiều cao 1 dòng.
   *  Phải gắn bằng addEventListener({passive:false}) — onWheel của React là listener THỤ ĐỘNG nên
   *  preventDefault() trong đó bị trình duyệt bỏ qua (console báo "Unable to preventDefault"). */
  useEffect(() => {
    const k = khungRef.current;
    if (!k) return;
    const xuLy = (e: WheelEvent): void => {
      const dong = k.querySelector('tbody tr');
      const cao = dong ? Math.round(dong.getBoundingClientRect().height) : 0;
      if (cao <= 0 || k.scrollHeight <= k.clientHeight) return;
      e.preventDefault();
      // [Admin Demo 6/11] Tiêu đề ghim trên nằm TRONG luồng cuộn (sticky), nên scrollTop là BỘI SỐ chiều cao
      // dòng là đủ để mép dòng khít ngay dưới tiêu đề — KHÔNG được trừ thêm chiều cao tiêu đề (thử rồi: lệch 1px
      // khiến dòng trên bị che 32px). Giữ bội số dòng, và làm tròn LÊN/XUỐNG theo chiều lăn.
      const nac = (e.deltaY > 0 ? 1 : -1) * 3;
      const dich = (Math.round(k.scrollTop / cao) + nac) * cao;
      k.scrollTop = Math.max(0, Math.min(dich, k.scrollHeight - k.clientHeight));
    };
    k.addEventListener('wheel', xuLy, { passive: false });
    return () => k.removeEventListener('wheel', xuLy);
  }, [cheDo, loading]);


  // ── PHÍM TẮT: hành vi màn Nhập bill (Admin Demo 24/11) ─────────────────────────────────────────────────
  function ptResetEnter(): void {
    if (pressTimerRef.current) { clearTimeout(pressTimerRef.current); pressTimerRef.current = null; }
    pressRef.current = ptInit();
    setEnterConLai(0);
  }
  // Enter trên nút "Xác nhận thêm bill": bấm đủ số lần (mặc định 2) mới GHI — chống lỡ tay (BỔ SUNG 7).
  function ptEnterGhiBill(e: RKeyboardEvent<HTMLButtonElement>): void {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    // [vá audit F1 NẶNG] BỎ QUA auto-repeat: giữ Enter sinh nhiều keydown ~30ms → lọt chốt "bấm N lần" (chỉ xét
    // cửa sổ thời gian) ⇒ 1 nhịp GIỮ phím ghi bill ngoài ý. Chỉ đếm keydown GỐC (người bấm thật từng lần).
    if (e.repeat) return;
    if (!ptBat(cfgPt, 'ghibill')) return; // phím tắt tắt → để nút hành xử NATIVE (Enter = 1 lần click)
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    const req = ptSoLan(cfgPt, 'ghibill');
    const r = ptPress(pressRef.current, Date.now(), req, 1500);
    pressRef.current = r.state;
    if (pressTimerRef.current) { clearTimeout(pressTimerRef.current); pressTimerRef.current = null; }
    if (r.fired) {
      setEnterConLai(0);
      void ghiNhan();
    } else {
      setEnterConLai(r.remaining);
      // Quá lâu không bấm tiếp → reset về 0 (phải bấm lại từ đầu). Khớp cửa sổ 1500ms của máy trạng thái.
      pressTimerRef.current = setTimeout(() => ptResetEnter(), 1600);
    }
  }
  // Mở màn nhập / quay lại nhập → focus nút "Xác nhận thêm bill" để Enter sẵn sàng (BỔ SUNG 4).
  useEffect(() => {
    if (cheDo !== 'nhap' || thuNho) { ptResetEnter(); return; }
    const t = setTimeout(() => (document.querySelector('[data-nut="ghibill"]') as HTMLElement | null)?.focus(), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cheDo, thuNho]);
  // Esc 2 NẤC: nấc 1 thu nhỏ, nấc 2 (đã thu nhỏ) mở hộp xác nhận thoát. CẤM thoát câm (dữ liệu chưa lưu).
  // Capture + stopImmediatePropagation để chạy TRƯỚC listener Esc của <Modal> (tránh đóng ngay). Phím tắt
  // 'esc' tắt → KHÔNG chặn, Modal tự xử Esc như cũ (onClose hỏi lại nếu còn dữ liệu).
  useEffect(() => {
    if (cheDo !== 'nhap' || hoiDong) return;
    if (!ptBat(cfgPt, 'esc')) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // [vá audit F2] Nếu đang mở dropdown SearchSelect (ô tìm đang focus) → Esc ĐÓNG dropdown trước (phản xạ
      // tự nhiên), KHÔNG thu nhỏ cả form oan. Đóng bằng cơ chế outside-mousedown sẵn có của SearchSelect.
      const ae = document.activeElement as HTMLElement | null;
      if (ae?.getAttribute?.('data-kiem') === 'searchselect-input') {
        e.preventDefault();
        e.stopImmediatePropagation();
        ae.blur();
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (ptEsc(thuNho) === 'thunho') setThuNho(true);
      else setHoiDong(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cheDo, thuNho, hoiDong, cfgPt]);

  function formMoi(): void {
    // GIỜ cũng phải về mặc định. Bỏ sót chỗ này thì bill KẾ TIẾP thừa hưởng giờ của bill trước — tệ nhất
    // là thừa hưởng một giờ ĐANG SAI (vd 25:35) nên nút ghi bị khóa mà không ai hiểu vì sao.
    setGio(GIO_MAC_DINH);
    setGioLoi(false);
    setGioDaDat(false);
    setSoHoaDon('');
    setSoLo('');
    setMaDongLo('');
    setSoTien('');
    setTienHuy('');
    setDaHoan('');
    setNguoiHoanId('');
    setGhiChu('');
  }
  function xoaForm(): void {
    // [B187] reset CỜ XÁC NHẬN khi xoá form — nếu không, người dùng tích "hoàn gộp" ở bill trước rồi bấm
    // Xóa, gõ bill mới thì ô vẫn ĐÃ TÍCH SẴN ⇒ gõ thừa số 0 không còn ai chặn (agent tái hiện được).
    setXacNhanHoanGop(false);
    setXacNhanTrung(false);
    setKhoaBillGoc(null);
    // Mọi cờ "mở cổng" hoặc "đổi cách tính tiền" PHẢI tự tiêu khi xóa form — nếu không bill kế tiếp
    // thừa hưởng trạng thái nguy hiểm của bill trước (tách thẻ còn bật, ô xác nhận trùng còn tích).
    setTachThe(false);
    setDongThe([]);
    setXacNhanTrung(false);
    setDangSuaId(null);
    setGioDaDat(false);
    setBankChon('');
    setMuonTid(false);
    setDaiLyMuonId('');
    setXacNhanMuon(false);
    setTidId('');
    setCardTypeId('');
    setFeeRows([]);
    formMoi();
    xoaBanNhap(); // xoá hẳn bản nháp — người dùng đã chủ động dọn form
  }

  async function ghiNhan(): Promise<void> {
    // [B258] Nói MỘT LẦN đủ mọi thứ còn thiếu, kèm chỗ sửa — thay vì bắt người dùng bấm 5 lần để
    // lòi ra 5 câu khác nhau.
    if (thieuGi.length > 0) {
      return toast.alert(
        'Bill chưa ghi được vì còn thiếu: ' + thieuGi.join(' · ') + '.'
          + XUONG_DONG + XUONG_DONG + 'CÁCH SỬA: điền nốt các mục vừa nêu ngay trên bảng nhập này '
          + '(ô nào thiếu đang có dấu * đỏ), rồi bấm Ghi nhận bill lại.',
        'Thiếu ' + thieuGi.length + ' thông tin bắt buộc'
      );
    }
    if (tidChuaDung) {
      return toast.alert(
        tidChuaDung + XUONG_DONG + XUONG_DONG
          + 'CÁCH SỬA: vào Quản Lý TID → tìm máy này → làm nốt bước còn thiếu (giao khách / đặt giá bán), '
          + 'rồi quay lại ghi bill.',
        'TID chưa đủ điều kiện ghi bill'
      );
    }
    if (thieuGiaBanThucTe) {
      return toast.alert(
        'TID này chưa có GIÁ BÁN THỰC TẾ cho loại thẻ đang chọn nên không ghi được doanh số '
          + '(doanh số không được phép mượn giá niêm yết).'
          + XUONG_DONG + XUONG_DONG + 'CÁCH SỬA: bấm nút "Dùng giá niêm yết làm giá bán" ngay trên bảng '
          + 'phí phía dưới, hoặc vào Quản Lý TID → Phí bán thực tế để khai giá cho máy này.',
        'Chưa có giá bán thực tế'
      );
    }
    if (!tid) return toast.alert('Chọn TID (máy POS) trước.', 'Thiếu thông tin');
    // B197 — chặn ở lớp ghi luôn, không chỉ dựa vào nút mờ (nút có thể bị bỏ qua khi khôi phục bản nháp).
    if (tidChuaDung) return toast.alert(tidChuaDung, 'TID chưa nhập bill được');
    if (!soLo.trim() && !soHoaDon.trim())
      return toast.alert('Phải có SỐ LÔ hoặc SỐ HÓA ĐƠN — không có thì không dựng được khóa chống trùng.', 'Thiếu khóa bill');
    // Khi TÁCH THẺ, mỗi DÒNG đã mang loại thẻ riêng — ô "Loại thẻ" ở trên không còn ý nghĩa, đòi thêm là
    // khoá cứng người dùng trong khi màn đã hiện đủ số (bắt được 12/11 khi lái giao diện thật).
    if (!tachThe && !cardTypeId) return toast.alert('Chọn loại thẻ trong bảng phí để tra phí bán.', 'Thiếu thông tin');
    const amt = Number(soTien);
    if (!soTien.trim() || !Number.isFinite(amt) || amt <= 0 || !Number.isInteger(amt))
      return toast.alert('Số tiền quẹt phải là số nguyên lớn hơn 0.', 'Số tiền không hợp lệ');
    if (huyVuot) return toast.alert('Tiền hủy lớn hơn tổng quẹt — kiểm lại bill.', 'Tiền hủy không hợp lệ');
    if (tienLo <= 0) return toast.alert('Trừ hủy xong còn 0đ — không có doanh số để ghi.', 'Lô rỗng sau hủy');
    if (thieuGiaBanThucTe)
      return toast.alert('TID chưa có giá bán thực tế — đặt phí bán cho TID trước khi ghi doanh số.', 'Chưa có giá bán thực tế');
    if (muonTid && !daiLyMuonId) return toast.alert('Đã bật MƯỢN TID thì phải chọn đại lý mượn.', 'Thiếu đại lý mượn');
    if (muonTid && !xacNhanMuon)
      return toast.alert('Bill mượn TID ghi doanh số về nhà khác — phải tích xác nhận trước khi ghi.', 'Cần xác nhận mượn TID');
    if (tienQuaLon)
      return toast.alert(
        'Số tiền vượt mức cho phép (tối đa 100 tỉ/bill). Số quá lớn bị làm tròn sai ngay khi hiển thị — kiểm lại.',
        'Số tiền quá lớn'
      );
    if (!gio || gio.length < 5)
      return toast.alert('Chưa điền đủ GIỜ QUẸT (giờ:phút) — bill tiền không được để trống giờ.', 'Thiếu giờ quẹt');
    if (gioLoi) return toast.alert('Giờ quẹt không hợp lệ (giờ 00–23, phút 00–59) — sửa lại trước khi ghi.', 'Giờ sai');
    if (canXacNhanLo && !xacNhanTrung)
      return toast.alert('Còn cảnh báo về SỐ LÔ chưa xác nhận — đọc kỹ rồi tích ô xác nhận mới ghi được.', 'Cần xác nhận số lô');
    if (tachThe && !tachHopLe)
      return toast.alert('Tách thẻ chưa hợp lệ: mỗi dòng phải chọn LOẠI THẺ KHÁC NHAU và tổng các dòng đã nhập phải NHỎ HƠN tiền lô.', 'Tách thẻ không hợp lệ');
    // [B188 19/11] BỎ chặn "đang sửa thì cấm đổi khoá bill" của B183 — Admin Demo yêu cầu SỬA ĐƯỢC số lô,
    // số hóa đơn, số tiền, loại thẻ, loại phí, tiền hoàn, người hoàn. Nay màn gửi kèm MÃ LÔ ĐANG SỬA và
    // máy chủ đổi khoá của chính lô đó (có kiểm: lô còn PENDING, chưa đối soát, khoá mới chưa thuộc bill khác).
    if (hoanVuot && !xacNhanHoanGop)
      return toast.alert(
        'Tiền hoàn (' + money(daHoanSo) + ') lớn hơn tiền về của BILL NÀY (' + money(tienVe ?? 0) + '). '
          + 'Nếu đây là HOÀN GỘP cho nhiều bill, hãy tích ô xác nhận ngay dưới ô tiền hoàn rồi ghi lại.',
        'Cần xác nhận hoàn gộp'
      );
    if (daHoanSo > 0 && !nguoiHoanId) return toast.alert('Có tiền đã hoàn thì phải chọn NGƯỜI HOÀN.', 'Thiếu người hoàn');
    setBusy(true);
    // BẢN THẬT: POST → createLoFromBillTid({ tidString, cardTypeId, amountBeforeFee=tienLo, billKey, txnDate,
    // settlementCode, nguon:'MANUAL' }) → ghi xong NẠP LẠI danh sách từ máy chủ + realtime đẩy mọi máy đang mở.
    const payload = {
      tidString: tid.tid,
      cardTypeId: Number(cardTypeId),
      // TÁCH THẺ: Σ lines PHẢI = amountBeforeFee (server fail-closed nếu lệch). Dòng cuối = phần còn lại.
      lines: tachThe
        ? dongThe.map((d, i) => ({
            cardTypeId: Number(d.cardTypeId),
            amountBeforeFee: i === dongThe.length - 1 ? conLaiTach : Number(d.tien) || 0
          }))
        : undefined,
      feeTypeId: Number(feeTypeId),
      totalAmount: amt,
      voidAmount: tienHuySo,
      amountBeforeFee: tienLo, // = totalAmount − voidAmount, ĐÚNG số ghi doanh số
      // MƯỢN TID: chỉ áp cho ĐÚNG bill này (undefined = giữ nguyên chủ máy).
      borrowedByCustomerId: muonTid && daiLyMuonId ? Number(daiLyMuonId) : undefined,
      receiptNumber: soHoaDon.trim() ? Number(soHoaDon) : null,
      bankReportedLoNumber: soLo.trim() ? Number(soLo) : null,
      settlementCode: maDongLo.trim() || null,
      // [TIỀN CHỜ 25/11 — Admin Demo "có chọn tháng để nhập bill"] Màn tiền chờ chọn THÁNG ghi sổ (state `ngay` giữ
      // YYYY-MM-01 của tháng chọn), ngày ghi = MÙNG 1 tháng đó, giờ 00:00 giờ VN. Màn thường giữ ngày + giờ người nhập.
      txnDate: cheDoTienCho
        ? new Date(ngay.slice(0, 7) + '-01T00:00:00').toISOString()
        : new Date(ngay + 'T' + gio + ':00').toISOString(),
      phiCaiMayPct, // % cài máy theo LOẠI THẺ — chốt per-GD khi ghi (gốc tính tiền về nhà đầu tư)
      refundedAmount: daHoanSo,
      refundedByUserId: nguoiHoanId ? Number(nguoiHoanId) : null,
      note: ghiChu || null
    };
    // ── GHI THẬT VÀO SỔ (Admin Demo chốt 7/11) ────────────────────────────────────────────────────────
    // Đi CHUNG đường với bill OCR: POST /v1/bills/manual → createLoFromBillTid. Máy chủ ĐỌC LẠI từ DB rồi
    // so với số trên màn; lệch là trả lỗi, KHÔNG để "ghi xong coi như xong".
    // Bản dựng thử không có đường ghi → bỏ qua, chỉ thêm vào danh sách trong phiên.
    let maLo: number | null = null;
    if (!laBanDemo()) {
      // [B182 19/11] Mất mạng / máy chủ chết giữa chừng thì lời gọi NÉM lỗi — không bắt là nút kẹt loading
      // y như trường hợp bị từ chối. Bắt tại đây, nói rõ, và luôn tắt trạng thái đang ghi.
      let r;
      try {
        r = await window.api.billManualCreate({
        tidString: payload.tidString,
        cardTypeId: tachThe ? undefined : payload.cardTypeId,
        amountBeforeFee: payload.amountBeforeFee,
        lines: payload.lines,
        billKey: khoaBill,
        // [B188] Đang sửa ⇒ "bản trùng" chính là bill đang sửa, cho ghi đè thẳng (máy chủ đã kiểm bằng
        // mã lô, không tin mỗi khoá do màn dựng). Gửi kèm mã lô để máy chủ sửa ĐÚNG lô đó.
        allowDuplicate: xacNhanTrung || !!dangSuaId,
        editingLoId: dangSuaId ? Number(String(dangSuaId).replace(/^lo/, '')) || undefined : undefined,
        settlementCode: payload.settlementCode,
        bankReportedLoNumber: payload.bankReportedLoNumber ?? undefined,
        borrowedByCustomerId: payload.borrowedByCustomerId ?? null,
        txnDate: payload.txnDate,
        expectedAmountAfterFee: tienVe ?? undefined,
        // [B172] GỬI tiền hoàn + người hoàn lên máy chủ. Trước đây 2 ô này chỉ nằm trong bộ nhớ màn hình
        // (API không nhận, danh sách trả cứng 0/rỗng) ⇒ nhập xong tải lại là mất sạch, không báo gì.
        refundedAmount: payload.refundedAmount,
        refundedByUserId: payload.refundedByUserId,
        // [B177] GỬI ghi chú lên máy chủ — ô này có trên form từ lâu nhưng chưa bao giờ được gửi đi.
        ghiChu: ghiChu || undefined,
        // [B178] TIỀN HỦY + SỐ HÓA ĐƠN. `voidAmount`/`totalAmount` KHÔNG đổi số tính tiền (`amountBeforeFee`
        // vẫn là tổng quẹt ĐÃ trừ hủy) — gửi lên để lưu VẾT và để máy chủ khẳng định bất biến
        // `totalAmount − voidAmount === amountBeforeFee`, lệch thì từ chối ghi.
        totalAmount: payload.totalAmount,
        voidAmount: payload.voidAmount,
        // [B268 24/11 — audit doanh số, CHẶN SHIP] GỬI LOẠI PHÍ. B190 đã thêm trường này vào kiểu
        // preload và vào máy chủ, nhưng lời gọi THẬT chưa bao giờ truyền ⇒ máy chủ nhận undefined rồi
        // lấy loại phí nhỏ nhất làm mặc định. Đo trên sổ thật: 596/596 dòng lô đều fee_type_id=1 dù
        // TID có khai loại khác; TID 53550072 thẻ MB 100tr lệch 400.000đ/bill (1,5% vs 1,1%).
        feeTypeId: payload.feeTypeId || undefined,
          soHoaDon: soHoaDon || undefined
        });
      } catch (e) {
        toast.alert('Không gọi được máy chủ: ' + String(e) + '. Bill CHƯA được ghi — kiểm tra mạng rồi ghi lại.', 'Mất kết nối khi ghi bill');
        setBusy(false);
        return;
      }
      if (!r.ok) {
        const m = (r as { message?: string }).message ?? 'Không ghi được doanh số.';
        // [B258 23/11 — Admin Demo "chặn thêm phải show rõ lý do và hướng dẫn fix"] MỌI lần bị chặn đều
        // hiện: LÝ DO (máy chủ) + CÁCH SỬA (bảng HUONG_DAN_LOI) + MÃ LỖI (để báo kỹ thuật cho nhanh).
        // Mã lạ chưa có trong bảng vẫn phải nói rõ là mã lạ, KHÔNG im lặng kiểu "Không ghi được".
        const ma = String((r as { error?: string }).error ?? '');
        const hd = HUONG_DAN_LOI[ma];
        const them = ma === 'DUP_SUSPECT' && dangSuaId
          ? ' Đang SỬA bill: tích ô "xác nhận trùng" rồi ghi lại — máy chủ sẽ cập nhật đúng bill cũ.'
          : '';
        const noiDung = m + them
          + XUONG_DONG + XUONG_DONG + 'CÁCH SỬA: ' + (hd?.cachSua ?? 'Chụp màn hình gửi kỹ thuật kèm mã lỗi bên dưới.')
          + XUONG_DONG + '(mã lỗi: ' + (ma || 'KHÔNG RÕ') + ')';
        toast.alert(noiDung, hd?.tieuDe ?? ('Chưa ghi được bill — mã ' + (ma || 'KHÔNG RÕ')));
        // [B182 19/11] BẮT BUỘC tắt trạng thái "đang ghi" TRƯỚC KHI thoát. Thiếu đúng dòng này nên mọi lần
        // máy chủ từ chối (hay gặp nhất: SỬA bill ⇒ nghi trùng) là nút "Ghi nhận bill" KẸT LOADING vĩnh viễn,
        // bấm nữa cũng không được, người dùng tưởng app treo. Xem cổng kiem-luat-nut-khong-ket.mjs.
        setBusy(false);
        return;
      }
      maLo = r.data.loId;
    }
    const id = maLo != null ? 'lo' + maLo : 'x' + Date.now();
    if (!laBanDemo()) {
      // [B276 24/11 — audit doanh số] GHI THẬT xong thì NẠP LẠI TỪ MÁY CHỦ, không tự chèn dòng vào bảng.
      // Trước đây `setDanhSach([dòng mới, ...cũ])` gây 2 lỗi đo được: (1) khi SỬA, id trùng dòng cũ ⇒ bảng
      // có HAI dòng cùng bill, hàng TỔNG cộng 2 lần cho tới khi bấm Làm mới; (2) dòng tự chèn THIẾU các cột
      // máy chủ tính (sauPhiCaiMay/sauMuaNdt/laiNdt/alphaBan) ⇒ các tổng dùng `?? 0` tụt câm. Nạp lại từ sổ
      // là một nguồn số duy nhất — đúng nguyên tắc "màn phải khớp sổ" (xem xoaDaTich).
      setLanTai((x) => x + 1);
    } else {
      // BẢN DỰNG THỬ không có máy chủ — giữ cách chèn tay để demo vẫn thấy dòng mới.
      setDanhSach((cu) => [
      {
        id,
        ngay,
        gio,
        tid: tid.tid,
        hkd: tid.hkdName ?? '—',
        daiLy: veNha || '—',
        ndt: ndt.text,
        bank: tid.bankCode ?? tid.bankName ?? '—',
        loaiThe: sellFee?.cardTypeName ?? '—',
        loaiPhi: tenLoaiPhi,
        lo: loHienThi(soLo, maDongLo),
        soHoaDon,
        tongQuet: tienQuet,
        tienHuy: tienHuySo,
        tienLo,
        phiPct: phiBanApplied,
        caiMayPct: phiCaiMayPct,
        muaPct: sellFee?.phiMuaNiemYet ?? null,
        daHoan: daHoanSo,
        nguoiHoan: nguoiHoan?.fullName ?? '',
        nguoiHoanId: nguoiHoanId ? Number(nguoiHoanId) : null,
        ghiChu: muonTid && tenDaiLyMuon ? (ghiChu ? ghiChu + ' · ' : '') + 'MƯỢN TID của ' + (tid.customerName ?? '') : ghiChu,
        nguoiNhap: user.fullName,
        nhanVe: tienVe ?? 0
      },
      ...cu
    ]);
    }
    setVuaThem(id);
    setTimeout(() => setVuaThem(null), 3000);
    setBusy(false);
    setXacNhanTrung(false);
    setXacNhanHoanGop(false);
    setDangSuaId(null);
    setKhoaBillGoc(null);
    setMuonTid(false);
    setDaiLyMuonId('');
    setXacNhanMuon(false);
    setThuNho(false);
    setTachThe(false);
    setDongThe([]);
    formMoi(); // giữ TID + loại phí để nhập tiếp bill kế của CÙNG máy
    setCheDo('danhsach');
    // Thông báo NGẮN (toast dài che mất góc bảng — lỗi nhìn thấy 6/11); payload in ra console để đối chiếu.
    console.log('[bill-le DEMO] payload sẽ gửi:', payload);
    // Đóng BẢNG NỔI rồi bật POPUP báo thành công (Admin Demo 6/11) — không dùng toast nữa.
    setKetQua({ tid: tid.tid, lo: loHienThi(soLo, maDongLo), daiLy: veNha || '—', nhanVe: tienVe ?? 0, maLo });
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Đang tải cấu hình…
      </div>
    );
  }

  // Ô nhập trong BẢNG NỔI: viền đậm hơn + bóng nhẹ cho NỔI RÕ, và ép CÙNG CHIỀU CAO (h-[38px])
  // để các ô trên một hàng không so le.
  const oNhap = inputCls + ' h-[38px] w-full !border-slate-300 shadow-sm';
  const nhanNhom = 'mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500';
  // Kiểu bảng lấy từ MODULE DÙNG CHUNG (components/BangChuan.tsx) — màn này là bản MẪU đã được duyệt,
  // nên định nghĩa phải nằm ở chỗ dùng chung, không nằm riêng trong trang.
  // BẢNG CỘT — NGUỒN DUY NHẤT của bề ngang và SỐ CỘT. <colgroup> + `table-fixed` khoá CỨNG bề ngang
  // (đặt w-[..] trên <th> của bảng auto-layout chỉ là GỢI Ý: dữ liệu dài là cột tự phình, đo được
  // 129,38 → 133,66px khi thêm 1 bill 12 chữ số). colSpan ở đây cũng tính từ mảng, không gõ tay nữa.
  /**
   * [B222 20/11 — Admin Demo "mục người hoàn để tắt là KT Demo hoặc tên người hoàn, bỏ họ và tên đi"]
   * Lấy TÊN GỌI (chữ cuối) của họ tên: "Nhân viên B" → "KT Demo". Cột chỉ rộng 90px nên để cả họ tên
   * thì luôn bị cắt dở; tên gọi vừa đủ nhận ra người. Họ tên ĐẦY ĐỦ vẫn còn ở chú thích rê chuột.
   * Giữ nguyên các nhãn hệ thống (vd "THIẾU") và chuỗi rỗng.
   */
  const tenGoi = (hoTen: string): string => {
    const t = (hoTen ?? '').trim().replace(/\s+/g, ' ');
    if (!t || t === 'THIẾU' || t === '—') return t;
    // KHÔNG cắt tên TÀI KHOẢN HỆ THỐNG — "Quản trị hệ thống" mà cắt chữ cuối thành "thống" thì vô nghĩa
    // (đo thật 20/11 trên dữ liệu thử). Chỉ cắt khi trông như HỌ TÊN người.
    if (/quản trị|hệ thống|admin|system|bot/i.test(t)) return t;
    const phan = t.split(' ');
    return phan[phan.length - 1];
  };

  // [DOANH SỐ TIỀN CHỜ 25/11] Màn tiền chờ = CÔNG NỢ PHẢI THU của đại lý, KHÔNG có hoàn tiền khách,
  // KHÔNG phí mua NĐT, KHÔNG chia ca, KHÔNG lô/số hoá đơn, nhập theo THÁNG. Nên nó ẨN 10 cột (Giờ · Ca ·
  // Lô · Số HĐ · % Mua NĐT · Sau mua NĐT · Đã hoàn · Chênh lệch · Người hoàn · NĐT), đổi "Ngày"→"Tháng", và
  // THÊM cột "Phải thu" (= Sau phí CM − Sau phí bán = phí bán − phí cài). Danh sách cột khai 2 NHÁNH tường
  // minh để NHÁNH THƯỜNG giữ y nguyên bản gốc (so khớp từng dòng) và nhánh tiền chờ không lỡ sót cột.
  // header th / body td / hàng TỔNG / Excel đều GATE theo `cheDoTienCho` khớp đúng mảng này — thiếu/lệch một
  // chỗ là số rơi sang cột khác.
  const COT: { ten: string; rong: number }[] = cheDoTienCho
    ? [
        { ten: '', rong: 32 },
        { ten: 'Tháng', rong: 64 },
        { ten: 'Đại lý', rong: 111 },
        { ten: 'TID', rong: 83 },
        { ten: 'HKD', rong: 159 },
        { ten: 'NH', rong: 46 },
        { ten: 'THẺ', rong: 71 },
        { ten: 'Trước phí', rong: 98 },
        { ten: '% CM', rong: 55 },
        { ten: 'Sau phí CM', rong: 98 },
        { ten: '% Mua', rong: 66 },
        { ten: '% Bán', rong: 55 },
        { ten: 'Sau phí bán', rong: 98 },
        { ten: 'Phải thu', rong: 110 },
        { ten: 'Loại phí', rong: 86 },
        { ten: 'Người nhập', rong: 110 },
        { ten: 'Ghi chú', rong: 150 }
      ]
    : [
    { ten: '', rong: 32 },
    // [B214 20/11 — Admin Demo "Ngày · Giờ · Ca lấy cột Ca làm kích thước chuẩn, giảm 10%"]
    // Ca đang 56px → chuẩn mới 50px, áp cho cả ba cột.
    { ten: 'Ngày', rong: 50 },
    { ten: 'Giờ', rong: 50 },
    { ten: 'Ca', rong: 50 },
    // [B227 22/11 — Admin Demo "giảm 20% chiều ngang cột đại lý"] 139 → 111. Ô đã có cắt chữ + chú thích
    // rê chuột nên tên dài không đè cột bên.
    { ten: 'Đại lý', rong: 111 },
    // [B214 20/11 — Admin Demo] TID giảm 15% (98 → 83); NH và HKD giảm 10% (66 → 59; 208 → 187).
    { ten: 'TID', rong: 83 },
    // [B225 21/11 — Admin Demo "giảm 15% chiều ngang tên HKD, ngân hàng"] 187 → 159; 54 → 46.
    { ten: 'HKD', rong: 159 },
    { ten: 'NH', rong: 46 },
    // [B212 20/11 — Admin Demo "THẺ · % CM · Lô · Số HĐ cho bằng nhau, giảm 15% chiều ngang"]
    // 118/82/83/82 → cùng 76px (Admin Demo chốt số 20/11). Tên thẻ dài nhất đang dùng là "Ngoài MB-Napas"
    // (đo 109px) nên sẽ bị cắt gọn — đã có cắt chữ + chú thích rê chuột từ B203 nên KHÔNG đè sang cột bên.
    { ten: 'THẺ', rong: 71 },
    // [B240 22/11 — Admin Demo "số lô số HĐ đưa sang bên phải cột thẻ"] Lô/Số HĐ là thông tin NHẬN DẠNG bill,
    // đứng cạnh THẺ cho liền mạch; nhóm % và tiền dồn về sau.
    // [B225 — Admin Demo "giảm 10% kích thước Số HĐ, Lô"] 61 → 55.
    { ten: 'Lô', rong: 55 },
    { ten: 'Số HĐ', rong: 55 },
    // [B241 22/11 — Admin Demo "% mua ĐT đưa qua bên trái % CM"] Phí MUA của đối tác đứng ngay trước phí
    // CÀI MÁY — hai số này đi cặp với nhau (SigMa đối tác = mua ĐT − cài máy).
    // "% Mua ĐT" = phí mua của ĐỐI TÁC — chữ ĐT để không lẫn với phí mua của NĐT.
    // [B266 25/11 — Admin Demo đảo cột] THỨ TỰ MỚI: Trước phí → % CM → Sau phí CM → % Mua → % Bán → Sau phí bán
    // → % Mua NĐT → Sau mua NĐT → Đã hoàn. "% Mua ĐT" đổi tên thành "% Mua" (phí mua của ĐỐI TÁC).
    // Bảng trên màn + FILE EXCEL + body td phải CÙNG một thứ tự.
    { ten: 'Trước phí', rong: 98 },
    { ten: '% CM', rong: 55 },
    { ten: 'Sau phí CM', rong: 98 },
    { ten: '% Mua', rong: 66 },
    { ten: '% Bán', rong: 55 },
    { ten: 'Sau phí bán', rong: 98 },
    { ten: '% Mua NĐT', rong: 66 },
    { ten: 'Sau mua NĐT', rong: 98 },
    { ten: 'Đã hoàn', rong: 98 },
    // [B225 21/11 — Admin Demo "thêm cột chênh lệch = tiền hoàn − sau phí bán, để bên phải cột Đã hoàn"]
    // Âm = còn phải hoàn cho khách; dương = đã hoàn dư. Bằng bề ngang nhóm tiền để nhìn thẳng cột.
    { ten: 'Chênh lệch', rong: 98 },
    { ten: 'Người hoàn', rong: 90 },
    // [B217 20/11 — Admin Demo "đưa NĐT về cạnh người hoàn"] NĐT đổi chỗ với Loại phí.
    // [B218 20/11 — Admin Demo "cột NĐT bằng cột người hoàn và giảm 10% cả 2"]
    // Lấy Người hoàn (122) làm chuẩn → cả hai = 110px.
    { ten: 'NĐT', rong: 90 },
    { ten: 'Loại phí', rong: 86 },
    { ten: 'Người nhập', rong: 110 },
    { ten: 'Ghi chú', rong: 150 }
  ];
  const SO_COT = COT.length;
  const BE_NGANG_BANG = COT.reduce((t, c) => t + c.rong, 0);
  // [B229 22/11 — Admin Demo "chữ ở hàng tiêu đề giảm 1px"] Bảng đang 11px (B216) ⇒ hàng TIÊU ĐỀ còn 10px.
  // Chỉ đụng hàng tiêu đề của ĐÚNG bảng này, không sửa `thChuan` dùng chung cho mọi màn.
  const th = thChuan + ' text-[10px]';
  const td = tdChuan;
  // [B266 25/11 — Admin Demo "giảm hàng tổng 1px"] Cỡ chữ hàng TỔNG nhỏ hơn 1px + padding ngang hẹp để số lớn
  // (chục tỉ + dấu *marker) KHÔNG TRÀN sang cột bên ở cột "Sau mua NĐT" / "Đã hoàn".
  const tdTong = tdTongChuan + ' !px-0.5 text-[11px]';

  return (
    <>
      {/* Nút chữ nhật bo góc nhẹ (~4px) thay vì viên thuốc — phạm vi TRANG NÀY. */}
      {/* NÚT (Admin Demo 6/11): chữ nhật bo góc = 10% CHIỀU CAO nút, và GIẢM KÍCH THƯỚC 15%
          (đệm ngang/dọc × 0,85 · cỡ chữ × 0,85 · icon × 0,85). Chiều cao thật + bo góc đo ở harness.
          Phạm vi TRANG NÀY — brand.css là file auto-sinh, đổi toàn app phải sửa brand.tokens.json + brand:sync. */}
      {/* MẪU CHỐT 6/11: toàn bộ luật nút/thanh cuộn/màu đã chuyển sang `src/renderer/src/mau-moi.css`
          (nạp ở main.tsx) để MỌI trang dùng chung 1 nguồn. Trang chỉ cần `data-nut-vuong` ở thẻ bọc. */}
    <div data-nut-vuong data-trang-full data-man="doanhso" className="page-enter flex h-full min-h-0 w-full flex-col px-[0.3cm] pb-0.5 min-[1280px]:px-[0.5cm]">
      {/* Tiêu đề — 1 dòng */}
      <div className="mb-1 flex shrink-0 flex-nowrap items-center gap-1.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-tint text-brand">
          <Receipt className="h-4 w-4" />
        </span>
        {nutMenu}
        <h2 className="shrink-0 whitespace-nowrap text-base font-bold uppercase tracking-wide text-slate-800">{cheDoTienCho ? 'DOANH SỐ TIỀN CHỜ' : 'DOANH SỐ'}</h2>
        {/* Thanh công cụ TRÊN CÙNG (Admin Demo 6/11): Xóa lọc · Làm mới · Xóa bill chọn · Xuất Excel · Thêm bill mới. */}
        {/* Kỳ xem: từ ngày → đến ngày + 3 nút chu kỳ, đặt ngay TRƯỚC "Xóa lọc" (Admin Demo 6/11). */}
        <div className="flex items-center gap-1 text-xs text-slate-500">
          <input type="date" className={inputCls + ' !px-2 !py-1 text-xs'} value={fTu} onChange={(e) => setFTu(e.target.value)} aria-label="Từ ngày" />
          <span>→</span>
          <input type="date" className={inputCls + ' !px-2 !py-1 text-xs'} value={fDen} onChange={(e) => setFDen(e.target.value)} aria-label="Đến ngày" />
        </div>
        {/* 3 nút kỳ gộp thành 1 nút + danh sách thả xuống cho gọn (Admin Demo 6/11). */}
        <div className="relative">
          <Button variant="soft" size="sm" data-nut="chuky" onClick={() => setMoChuKy((x) => !x)} icon={<CalendarRange className="h-4 w-4" />}>
            Chọn chu kỳ
          </Button>
          {moChuKy && (
            <div className="absolute left-0 z-50 mt-1 w-44 rounded-lg border border-line bg-white p-1 shadow-xl">
              {([
                ['homnay', 'Hôm nay'],
                ['tuan', 'Tuần này'],
                ['thang', 'Tháng này']
              ] as const).map(([ky, nhan]) => (
                <button
                  key={ky}
                  type="button"
                  className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-brand-tint"
                  onClick={() => {
                    chonKy(ky);
                    setMoChuKy(false);
                  }}
                >
                  {nhan}
                </button>
              ))}
            </div>
          )}
        </div>
        <Button variant="soft" size="sm" data-nut="xoaloc" onClick={xoaLoc} title="Xóa toàn bộ bộ lọc, đưa về mặc định" icon={<FilterX className="h-4 w-4" />}>
          Xóa lọc
        </Button>
        {/* [B181 19/11] NÚT NÀY TRƯỚC ĐÂY LÀ NÚT GIẢ — trình xử lý rỗng, bấm xong KHÔNG làm gì, trong khi
            mách nước vẫn ghi "Tải lại dữ liệu mới nhất". Người dùng bấm rồi tin là dữ liệu đã mới. */}
        <Button variant="soft" size="sm" data-nut="lammoi" onClick={() => setLanTai((x) => x + 1)} title="Tải lại dữ liệu mới nhất (giữ nguyên bộ lọc)" icon={<RefreshCw className="h-4 w-4" />}>
          Làm mới
        </Button>
        <Button variant="danger" size="sm" data-nut="xoabill" onClick={moHopXoa} disabled={tichHopLe.length === 0} icon={<Trash2 className="h-4 w-4" />}>
          {tichHopLe.length > 0 ? 'Xóa ' + tichHopLe.length + ' bill' : 'Xóa bill chọn'}
        </Button>
        <Button variant="soft" size="sm" data-nut="kpi" onClick={() => setMoKpi(true)} icon={<BarChart3 className="h-4 w-4" />}>
          KPI Doanh Số
        </Button>
        {/* [25/11 — Admin Demo "bỏ Tăng trưởng vô nghĩa"] Nút "Tăng trưởng" (biểu đồ cũ) đã BỎ ở MỌI màn doanh số —
            KPI Doanh Số đã có biểu đồ đẹp hơn. */}
        <Button variant="soft" size="sm" data-nut="baocao" onClick={() => setMoBaoCao(true)} icon={<Activity className="h-4 w-4" />}>
          Máy không chạy
        </Button>
        {/* [B236 22/11 — Admin Demo "thêm button tính toán phần này trong bảng doanh số để hiển thị trực quan"] */}
        {/* [TIỀN CHỜ] Bỏ nút "Lãi NĐT" — màn công nợ không có NĐT. */}
        {!cheDoTienCho && (
          <Button variant="soft" size="sm" data-nut="laindt" onClick={() => setMoBaoCaoNdt(true)} icon={<TrendingUp className="h-4 w-4" />}>
            Lãi NĐT
          </Button>
        )}
        <Button variant="soft" size="sm" data-nut="excel" onClick={xuatExcel} icon={<FileSpreadsheet className="h-4 w-4" />}>
          Xuất Excel
        </Button>
        {/* [B220 20/11 — Admin Demo "thêm nút tắt bên cạnh Xuất Excel để vào danh sách TID và được thao tác
            chỉnh sửa TID"] Lối tắt sang màn TID; nếu đang lọc theo đúng MỘT máy thì mang luôn số TID sang
            để màn kia tự tìm — khỏi gõ lại. */}
        <Button
          variant="soft"
          size="sm"
          data-nut="dstid"
          title="Mở màn Quản Lý TID để sửa máy, giao khách, đặt giá bán"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent('alpha:di-toi-trang', {
                detail: { trang: 'tid', tim: fTid.length === 1 ? fTid[0] : '' }
              })
            )
          }
          icon={<CreditCard className="h-4 w-4" />}
        >
          Danh sách TID
        </Button>
      </div>

      {/* DANH SÁCH luôn hiện — "Thêm bill mới" mở BẢNG NỔI đè lên, KHÔNG chuyển màn (Admin Demo 6/11). */}

        <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-white px-2 pb-1 pt-1.5">
          {/* KPI (Admin Demo 6/11) — theo ĐÚNG bộ lọc đang bật, không phải toàn bộ danh sách. */}
          <div className="mb-1 flex shrink-0 items-stretch gap-1.5">
            <div className="flex flex-wrap gap-1.5">
            {(cheDoTienCho
              ? [
                  // [TIỀN CHỜ] Chỉ 3 thẻ: Doanh số trước phí · Sau phí bán · Chênh phí thu (= Σ cột Phải thu =
                  // lợi nhuận SigMa = Σ doanh số × (%bán − %mua đối tác)). Bỏ Đã hoàn / lãi kỳ / còn hoàn thiếu.
                  { nhan: 'Doanh số trước phí', so: tongLoc, mau: 'text-slate-800', nen: 'bg-slate-50 border-slate-200' },
                  { nhan: 'Sau phí bán', so: tongVe, mau: 'text-brand', nen: 'bg-brand-tint border-brand/25' },
                  {
                    nhan: 'Chênh phí thu',
                    thieu: soThieuPhaiThu,
                    so: tongPhaiThu,
                    mau: 'text-brand-deep',
                    nen: 'bg-brand-tint border-brand/25',
                    dauRo: false
                  }
                ]
              : [
              { nhan: 'Doanh số trước phí', so: tongLoc, mau: 'text-slate-800', nen: 'bg-slate-50 border-slate-200' },
              { nhan: 'Sau phí bán', so: tongVe, mau: 'text-brand', nen: 'bg-brand-tint border-brand/25' },
              { nhan: 'Đã hoàn tiền', so: tongDaHoan, mau: 'text-success', nen: 'bg-emerald-50 border-emerald-200' },
              {
                // [B295] cảnh báo bill-bị-bỏ để ở dấu *n + tooltip (B318-fix: nối vào nhãn làm ô KPI wrap
                // 2 dòng → cao 50px, vỡ cổng B260 "ô KPI cao đúng 40,3px"). Nhãn GIỮ NGẮN.
                nhan: 'Chênh lệch sau bán (lãi kỳ)',
                thieu: soBoLaiKy,
                so: laiKy,
                mau: laiKy >= 0 ? 'text-brand-deep' : 'text-danger',
                nen: laiKy >= 0 ? 'bg-brand-tint border-brand/25' : 'bg-red-50 border-danger/40',
                dauRo: true
              },
              {
                nhan: hoanThua ? 'HOÀN THỪA (cảnh báo)' : 'Chênh lệch — còn hoàn thiếu',
                so: chenhLech,
                mau: hoanThua ? 'text-danger' : 'text-success',
                nen: hoanThua ? 'bg-red-50 border-danger/40' : 'bg-emerald-50 border-emerald-200',
                dauRo: true
              }
            ]).map((k) => (
              // [B260 23/11 — Admin Demo "tăng chiều cao các button này lên 5px"] py-0.5 (2px/phía) →
              // py-[4.5px] ⇒ ô KPI cao thêm đúng 5px. Đo bằng cổng, không ước lượng bằng mắt.
              <div key={k.nhan} data-kiem="o-kpi" title={(k as { thieu?: number }).thieu ? (k as { thieu?: number }).thieu + ' bill chưa đủ % phí — chưa tính vào lãi kỳ' : undefined} className={'w-[164px] rounded-lg border px-2 py-[4.5px] text-center transition hover:-translate-y-0.5 hover:shadow-md ' + k.nen}>
                <div className="text-[10px] leading-none text-slate-500">{k.nhan}</div>
                <div className={'text-sm font-bold leading-snug tabular-nums ' + k.mau}>
                  {k.dauRo ? (k.so > 0 ? '+' : k.so < 0 ? '−' : '') + money(Math.abs(k.so)) : money(k.so)}
                  {(k as { thieu?: number }).thieu ? <span data-kiem="kpi-thieu" className="ml-0.5 text-[10px] font-semibold text-amber-600">*{(k as { thieu?: number }).thieu}</span> : null}
                </div>
              </div>
            ))}
            </div>
            <div className="flex-1" />
            {/* [B181 19/11] MỞ hộp nhập là lúc CẦN dữ liệu tươi nhất (máy vừa giao đại lý, vừa đặt giá bán…)
                ⇒ nạp lại danh sách TID ngay tại đây, không chờ người dùng nhớ bấm "Làm mới". */}
            <Button variant="confirm" data-nut="them" onClick={() => { setLanTai((x) => x + 1); setCheDo('nhap'); }} icon={<Plus className="h-4 w-4" />} className="shrink-0 self-center">
              Thêm bill mới
            </Button>
          </div>
          <FilterBar
            coChuNho
            search={fTim}
            onSearch={setFTim}
            searchPlaceholder="Tìm TID, HKD, đại lý, lô, số HĐ…"
            // [24/11 — Admin Demo chốt thứ tự thanh lọc] Đại lý → TID → HKD → Ngân hàng → Số lô → Số HĐ →
            // Loại thẻ → Ca → Loại phí → NĐT → Người hoàn (Ca XUỐNG SAU Loại thẻ; Số lô/Số HĐ chen GIỮA
            // Ngân hàng và Loại thẻ). Dùng mảng TRỘN `items` của FilterBar để chốt đúng thứ tự này.
            // Hành vi lọc GIỮ NGUYÊN — state fLo/fSoHd/… không đổi, chỉ đổi THỨ TỰ hiển thị ô.
            items={([
              { loai: 'multi', key: 'dl', nhan: 'Đại lý', value: fDaiLy, options: duyNhat((b) => b.daiLy), onChange: setFDaiLy },
              { loai: 'multi', key: 'tid', nhan: 'TID', value: fTid, options: duyNhat((b) => b.tid), onChange: setFTid },
              { loai: 'multi', key: 'hkd', nhan: 'HKD', value: fHkd, options: duyNhat((b) => b.hkd), onChange: setFHkd },
              { loai: 'multi', key: 'bank', nhan: 'Ngân hàng', value: fBank, options: duyNhat((b) => b.bank), onChange: setFBank },
              { loai: 'so', key: 'lo', nhan: 'Số lô', value: fLo, onChange: setFLo, rong: 'w-[84px]' },
              { loai: 'so', key: 'sohd', nhan: 'Số HĐ', value: fSoHd, onChange: setFSoHd, rong: 'w-[84px]' },
              { loai: 'multi', key: 'the', nhan: 'Loại thẻ', value: fThe, options: duyNhat((b) => b.loaiThe), onChange: setFThe },
              {
                // [B256 23/11 — Admin Demo "lọc NĐT doanh số xong lọc theo ca không ra"] TRƯỚC ĐÂY ô này
                // dựng cứng value = "1"/"2"/"3" trong khi phép lọc so với TÊN CA ("Ca 1", hoặc tên do
                // người dùng tự đặt ở màn Quản Lý Ngân Hàng) ⇒ KHÔNG BAO GIỜ khớp ⇒ chọn ca là bảng
                // rỗng, bất kể có lọc NĐT hay không. Nay danh sách ca rút TỪ CHÍNH dữ liệu như các ô
                // lọc khác — value = đúng chuỗi đem đi so.
                loai: 'multi',
                key: 'ca',
                nhan: 'Ca',
                value: fCa,
                options: duyNhat((b) => caCuaBill(b.bank, b.gio, caCuaBank(b.bankId))?.ten ?? ''),
                onChange: setFCa
              },
              { loai: 'multi', key: 'phi', nhan: 'Loại phí', value: fPhi, options: duyNhat((b) => b.loaiPhi), onChange: setFPhi },
              { loai: 'multi', key: 'ndt', nhan: 'NĐT', value: fNdt, options: duyNhat((b) => b.ndt), onChange: setFNdt },
              {
                loai: 'multi',
                key: 'nguoihoan',
                nhan: 'Người hoàn',
                value: fNguoiHoan,
                options: [
                  ...[...new Set(danhSach.filter((b) => b.daHoan && b.nguoiHoan).map((b) => b.nguoiHoan))]
                    .sort((a, c) => a.localeCompare(c, 'vi'))
                    .map((v) => ({ value: v, label: v })),
                  { value: '__CHUA_HOAN__', label: '(chưa hoàn tiền)' },
                  { value: '__THIEU_VET__', label: '(đã hoàn — THIẾU vết ai trả)' }
                ],
                onChange: setFNguoiHoan,
                mauTheoGiaTri: { __THIEU_VET__: 'text-danger font-semibold' }
              },
              { loai: 'tich', key: 'dong95', nhan: 'Chỉ lô đóng 95', value: fChiDong95, onChange: setFChiDong95, title: 'Chỉ hiện bill có lô bị đóng 95' }
            ] as FilterItem[]).filter((it) => !cheDoTienCho || !['phi', 'ca', 'ndt', 'nguoihoan', 'lo', 'sohd', 'dong95'].includes(it.key))/* [TIỀN CHỜ] Thanh lọc chỉ còn: Tìm · Đại lý · TID · HKD · Ngân hàng · Loại thẻ. Bỏ Loại phí/Ca/NĐT/Người hoàn/Số lô/Số HĐ/Chỉ lô đóng 95 (không áp cho tiền chờ). */}
            selects={[]}
            // [B202 19/11] Màn này LỌC NGAY khi đổi ô nên không có việc gì để "áp dụng" — nút Lọc ở đây là
            // NÚT GIẢ (bấm không làm gì) và còn bị khoảng đệm co giãn đẩy ra tận mép phải, trôi hẳn ra ngoài
            // bảng. Bỏ nút + bỏ khoảng đệm; thanh lọc nay tự xuống dòng khi màn hẹp.
            onApply={() => undefined /* màn này lọc ngay tại chỗ khi đổi ô — không có nút Lọc */}
            onReset={xoaLoc}
            hideReset
            hideRefresh
            hideApply
          />
          {/* Bảng GỌN trong bề ngang thật: gộp "Ngân hàng · Loại thẻ" và "Lô · Số HĐ" (14 cột → 12) để 2 cột
              TIỀN quan trọng nhất (Tiền lô, Nhận về) KHÔNG bị đẩy khuất phải — lỗi đã bắt được bằng mắt 6/11,
              bài kiểm cũ đo tràn ở cấp TRANG nên không thấy; nay đo thêm tràn TRONG khung bảng. */}
          {/* [B275 24/11 — audit doanh số] BĂNG CẢNH BÁO ĐỘC LẬP VỚI SỐ DÒNG. Trước đây lời cảnh báo
              "bảng bị cắt 2000 lô" chỉ render trong nhánh BẢNG RỖNG — mà lúc bị cắt thì bảng đang đầy
              2000 dòng ⇒ không bao giờ hiện, hàng TỔNG thiếu tiền trong im lặng (đúng thứ B195 định chặn). */}
          {loiTaiSo && danhSachLoc.length > 0 && (
            <div data-kiem="canh-bao-tai-so" className="mb-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-[13px] font-medium text-amber-800">
              ⚠ {loiTaiSo}
            </div>
          )}
          <div data-kiem="khung-bang" ref={khungRef} className="min-h-0 flex-1 overflow-auto rounded-lg border border-line">
            {/* [B216 20/11 — Admin Demo "giảm kích thước chữ xuống toàn thể bảng 1 PX"] 12px → 11px cho CẢ bảng
                  (tiêu đề + ô dữ liệu + hàng TỔNG đều kế thừa cỡ chữ của thẻ bảng này). */}
            <table className="h-full w-full table-fixed text-[11px]" style={{ minWidth: BE_NGANG_BANG }}>
              <colgroup>
                {COT.map((c, i) => (
                  <col key={i} style={{ width: c.rong }} />
                ))}
              </colgroup>
              <thead className="sticky top-0 z-20 text-xs uppercase tracking-wide shadow-sm">
                <tr>
                  <th className={th + ' !px-1.5'}>
                    <input
                      type="checkbox"
                      className="accent-brand"
                      aria-label="Chọn tất cả"
                      checked={danhSachLoc.length > 0 && danhSachLoc.every((b) => daTich.has(b.id))}
                      onChange={(e) => setDaTich(e.target.checked ? new Set(danhSachLoc.map((b) => b.id)) : new Set())}
                    />
                  </th>
                  <th className={th}>{cheDoTienCho ? 'Tháng' : 'Ngày'}</th>
                  {/* [TIỀN CHỜ] Giờ + Ca chỉ có ở màn Doanh Số thường. */}
                  {!cheDoTienCho && (
                    <>
                      <th className={th}>Giờ</th>
                      <th className={th}>Ca</th>
                    </>
                  )}
                  <th className={th}>Đại lý</th>
                  <th className={th}>TID</th>
                  <th className={th}>HKD</th>
                  {/* Ngân hàng NẰM CẠNH tên HKD (Admin Demo 6/11) */}
                  <th className={th} title="Ngân hàng">NH</th>
                  {/* thẻ → loại phí → % phí bán (Admin Demo 6/11) */}
                  <th className={th} title="Loại thẻ">THẺ</th>
                  {/* [TIỀN CHỜ] Lô + Số HĐ chỉ có ở màn Doanh Số thường (tiền chờ nhập TỔNG tháng, không lô/số HĐ). */}
                  {!cheDoTienCho && (
                    <>
                      <th className={th}>Lô</th>
                      <th className={th}>Số HĐ</th>
                    </>
                  )}
                  {/* [B266 25/11 — Admin Demo đảo cột] Tiêu đề viết TAY — PHẢI khớp ĐỦ 4 chỗ (COT width, th, td, hàng TỔNG).
                      THỨ TỰ: Trước phí → % CM → Sau phí CM → % Mua → % Bán → Sau phí bán → % Mua NĐT → Sau mua NĐT → Đã hoàn. */}
                  <th className={th}>Trước phí</th>
                  <th className={th} title="% phí cài máy theo loại thẻ">% CM</th>
                  <th className={th} title="Tiền còn lại sau khi trừ phí cài máy">Sau phí CM</th>
                  <th className={th} title="Phí mua của ĐỐI TÁC theo biểu phí, hiệu lực tại ngày bill">% Mua</th>
                  <th className={th}>% Bán</th>
                  <th className={th}>Sau phí bán</th>
                  {/* [TIỀN CHỜ] PHẢI THU = Sau phí CM − Sau phí bán = (phí bán − phí cài) × doanh số. Số CỐT LÕI
                      của màn công nợ, đặt NGAY SAU "Sau phí bán". */}
                  {cheDoTienCho && (
                    <th className={th} title="Công nợ phải thu từ đại lý = Sau phí cài máy − Sau phí bán (= phí bán − phí cài)">Phải thu</th>
                  )}
                  {/* [TIỀN CHỜ] % Mua NĐT · Sau mua NĐT · Đã hoàn · Chênh lệch · Người hoàn · NĐT chỉ có ở màn Doanh Số thường. */}
                  {!cheDoTienCho && (
                    <>
                      <th className={th} title="% SigMa mua của NHÀ ĐẦU TƯ cho loại thẻ này — khai ở màn TID → Phí bán thực tế">% Mua NĐT</th>
                      <th className={th} title="Tiền còn lại sau khi trừ phí mua NĐT">Sau mua NĐT</th>
                      <th className={th}>Đã hoàn</th>
                      {/* [B225 21/11] Tiêu đề viết TAY từng ô — thêm cột phải sửa ĐỦ BA chỗ: danh sách cột,
                          tiêu đề, hàng dữ liệu (và ô bù ở hàng TỔNG). Thiếu một chỗ là lệch cả bảng. */}
                      <th className={th} title="Đã hoàn − Sau phí bán. Âm = còn phải hoàn cho khách; dương = hoàn dư.">Chênh lệch</th>
                      <th className={th} title="Người đã trả tiền hoàn — để lại vết ai trả">Người hoàn</th>
                      {/* [B217 20/11] NĐT đứng ngay sau "Người hoàn" (Admin Demo đổi ý so với 6/11). */}
                      <th className={th}>NĐT</th>
                    </>
                  )}
                  <th className={th}>Loại phí</th>
                  <th className={th}>Người nhập</th>
                  <th className={th}>Ghi chú</th>
                </tr>
              </thead>
              <tbody>
                {danhSachLoc.length === 0 && (
                  <tr>
                    <td colSpan={SO_COT} className="px-3 py-6 text-center text-sm text-slate-400">
                      {dangTaiSo ? (
                        'Đang đọc danh sách từ máy chủ…'
                      ) : loiTaiSo ? (
                        <span className="text-danger">
                          <b>KHÔNG đọc được danh sách từ máy chủ.</b> {loiTaiSo} — đừng coi bảng trống là
                          &quot;kỳ này không có bill&quot;.
                        </span>
                      ) : (
                        'Không có bill nào khớp bộ lọc.'
                      )}
                    </td>
                  </tr>
                )}
                {/* SỌC NGỰA VẰN (Admin Demo 6/11): 1 dòng trắng – 1 dòng xanh nhạt cho dễ dò ngang 16 cột.
                    Dòng vừa ghi vẫn thắng màu (tô đậm brand-tint) để thấy ngay. */}
                {danhSachLoc.map((b, i) => (
                  <tr
                    key={b.id}
                    className={
                      'border-t border-line transition hover:bg-appbg ' +
                      (vuaThem === b.id ? 'bg-amber-100' : i % 2 === 1 ? 'bg-brand-tint' : 'bg-white')
                    }
                  >
                    <td className={td + ' !px-1.5'}>
                      <input type="checkbox" className="accent-brand" aria-label={'Chọn bill ' + b.tid} checked={daTich.has(b.id)} onChange={() => doiTich(b.id)} />
                    </td>
                    {/* [TIỀN CHỜ] Cột đầu: THÁNG (YYYY-MM) thay cho Ngày; KHÔNG có Giờ/Ca. */}
                    {cheDoTienCho ? (
                      <td className={td + ' text-center text-slate-600 tabular-nums'} title={'Tháng ' + b.ngay.slice(0, 7)}>{b.ngay.slice(0, 7)}</td>
                    ) : (
                      <>
                        <td className={td + ' text-center text-slate-600'}>{ngayNgan(b.ngay)}</td>
                        <td className={td + ' text-center text-slate-500'}>{b.gio}</td>
                        <td className={td + ' text-center'}>
                          {caCuaBill(b.bank, b.gio, caCuaBank(b.bankId)) ? (
                            <span className="text-slate-600">{caCuaBill(b.bank, b.gio, caCuaBank(b.bankId))?.ten}</span>
                          ) : (
                            <span className="text-slate-300">-</span>
                          )}
                        </td>
                      </>
                    )}
                    <td className={td + ' truncate text-center text-slate-600'} title={b.daiLy}>{b.daiLy}</td>
                    <td className={td + ' text-center font-medium text-slate-700'} title={'Bill lúc ' + b.gio + ' ngày ' + ngayNgan(b.ngay)}>{b.tid}</td>
                    <td className={td + ' truncate text-slate-600'} title={b.hkd}>{b.hkd}</td>
                    {/* [B203 19/11 — Admin Demo "chữ đè lên nhau"] 2 ô này THIẾU cắt chữ trong khi ô Đại lý/HKD
                        thì có ⇒ tên dài tràn khỏi ô và ĐÈ sang cột bên cạnh (mắt thấy: "Ngoài MB-Napas" đè
                        "1,55%" của cột % CM; mã ngân hàng dài kiểu "BK1789121022116" cũng tràn y vậy). */}
                    <td className={td + ' truncate text-center text-slate-600'} title={b.bank}>{b.bank}</td>
                    <td className={td + ' truncate text-center text-slate-600'} title={b.loaiThe}>{b.loaiThe}</td>
                    {/* [TIỀN CHỜ] KHÔNG có cột Lô/Số HĐ. Ở màn thường: Số lô ở giữa, nút sửa GHIM MÉP PHẢI của ô
                        (không dính vào số) — Admin Demo 6/11. */}
                    {!cheDoTienCho && (
                      <>
                        <td className={td + ' tabular-nums text-slate-600'}>
                          <span className="flex w-full items-center justify-between">
                            <span className={'flex-1 text-center ' + (/\(95\)/.test(b.lo) ? 'font-semibold text-danger' : '')}>{b.lo || '—'}</span>
                            <button
                              type="button"
                              title={'Sửa bill lô ' + b.lo}
                              aria-label={'Sửa bill lô ' + b.lo}
                              onClick={() => suaBill(b)}
                              className="flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded p-0 leading-none text-warning transition hover:bg-warning/10"
                            >
                              <Pencil className="block h-2.5 w-2.5" />
                            </button>
                          </span>
                        </td>
                        <td className={td + ' text-center tabular-nums text-slate-600'}>{b.soHoaDon || '—'}</td>
                      </>
                    )}
                    {/* [B266 25/11 — Admin Demo đảo cột] body td theo THỨ TỰ MỚI khớp header:
                        Trước phí → % CM → Sau phí CM → % Mua → % Bán → Sau phí bán → % Mua NĐT → Sau mua NĐT → Đã hoàn. */}
                    {/* TIỀN TRƯỚC PHÍ = số ĐÃ TRỪ tiền hủy (Admin Demo 6/11 bỏ cột Hủy) — đúng amountBeforeFee của backend. */}
                    <td className={td + ' text-right tabular-nums text-slate-800'} title={b.tienHuy ? 'Quẹt ' + money(b.tongQuet) + ' − hủy ' + money(b.tienHuy) : 'Không có giao dịch hủy'}>
                      {money(b.tienLo).replace('đ', '')}
                    </td>
                    <td className={td + ' text-center tabular-nums text-slate-600'}>{pctSo(b.caiMayPct)}</td>
                    <td className={td + ' text-right tabular-nums text-slate-600'}>{b.sauPhiCaiMay != null ? money(b.sauPhiCaiMay).replace('đ', '') : '—'}</td>
                    <td className={td + ' text-center tabular-nums text-slate-600'} title="Phí mua của ĐỐI TÁC cho loại thẻ này, theo biểu phí đối tác hiệu lực tại ngày bill">{pctSo(b.muaPct)}</td>
                    <td className={td + ' text-center tabular-nums text-slate-600'}>{pctSo(b.phiPct)}</td>
                    <td className={td + ' text-right tabular-nums text-slate-800'}>{money(b.nhanVe).replace('đ', '')}</td>
                    {/* [TIỀN CHỜ] PHẢI THU = LÃI SIGMA = doanh số × (%phí bán − %phí mua đối tác). "—" khi thiếu
                        phiPct/muaPct (cấm bịa 0). In ĐẬM brand — số cốt lõi của màn công nợ. */}
                    {cheDoTienCho && (() => {
                      const pt = phaiThuCuaBill(b);
                      return (
                        <td className={td + ' text-right tabular-nums font-semibold text-brand'} title="Phải thu (lãi SigMa) = doanh số × (% phí bán − % phí mua đối tác)">
                          {pt != null ? money(pt).replace('đ', '') : '—'}
                        </td>
                      );
                    })()}
                    {/* [TIỀN CHỜ] % Mua NĐT · Sau mua NĐT · Đã hoàn · Chênh lệch · Người hoàn · NĐT — chỉ màn thường. */}
                    {!cheDoTienCho && (
                      <>
                        <td className={td + ' text-center tabular-nums text-slate-600'} title={b.phiMuaNdtPct == null ? 'TID này chưa khai phí mua NĐT' : undefined}>{b.phiMuaNdtPct != null ? pctSo(b.phiMuaNdtPct) : '—'}</td>
                        <td className={td + ' text-right tabular-nums text-slate-600'}>{b.sauMuaNdt != null ? money(b.sauMuaNdt).replace('đ', '') : '—'}</td>
                        <td className={td + ' text-right tabular-nums ' + (b.daHoan ? 'text-success' : 'text-slate-300')} title={b.nguoiHoan ? 'Người hoàn: ' + b.nguoiHoan : 'Chưa hoàn'}>{b.daHoan ? money(b.daHoan).replace('đ', '') : '—'}</td>
                        {(() => {
                          // [B294/F5 24/11 — agent phản biện CHỤP MÀU chứng minh] CHÊNH LỆCH phải CÙNG QUY ƯỚC
                          // với ô KPI trên đầu màn (Admin Demo chốt): = SAU PHÍ BÁN − ĐÃ HOÀN; >0 = còn HOÀN THIẾU
                          // (xanh, bình thường) · <0 = HOÀN THỪA (đỏ, tiền ra khỏi nhà). Bản cũ tính NGƯỢC dấu
                          // ngược màu ⇒ cùng một kỳ KPI xanh +32,9 tỷ mà hàng TỔNG đỏ −32,9 tỷ.
                          const lech = b.nhanVe - b.daHoan;
                          return (
                            <td
                              className={td + ' text-right tabular-nums ' + (lech === 0 ? 'text-slate-400' : lech < 0 ? 'text-danger' : 'text-success')}
                              title={lech === 0 ? 'Đã hoàn đủ' : lech > 0 ? 'Còn phải hoàn ' + money(lech) : 'Hoàn DƯ ' + money(-lech)}
                            >
                              {lech === 0 ? '0' : (lech < 0 ? '−' : '+') + money(Math.abs(lech)).replace('đ', '')}
                            </td>
                          );
                        })()}
                        {/* Có tiền hoàn mà THIẾU tên người hoàn ⇒ tô ĐỎ, vì đây là vết bắt buộc (Admin Demo 6/11). */}
                        <td
                          className={td + ' truncate text-center ' + (b.nguoiHoan ? 'text-slate-600' : b.daHoan ? 'font-semibold text-danger' : 'text-slate-300')}
                          title={b.nguoiHoan
                            ? 'Người hoàn: ' + b.nguoiHoan + (b.daHoan ? '' : ' (bill này hoàn 0đ — tiền hoàn GỘP nằm ở bill khác)')
                            : b.daHoan ? 'THIẾU người hoàn — bill đã hoàn tiền mà không có vết ai trả' : 'Chưa hoàn'}
                        >
                          {/* [B182 19/11] TRƯỚC ĐÂY: `b.daHoan ? … : '—'` ⇒ hoàn 0đ là KHÔNG BAO GIỜ hiện tên,
                              dù chính ô nhập ghi "Chọn được cả khi hoàn 0đ — dùng khi hoàn gộp nhiều bill".
                              Người dùng chọn người hoàn, sổ lưu đúng, mà cột vẫn trống ⇒ tưởng mất dữ liệu. */}
                          {b.nguoiHoan ? tenGoi(b.nguoiHoan) : b.daHoan ? 'THIẾU' : '—'}
                        </td>
                        {/* [B217] NĐT trước, Loại phí sau — khớp thứ tự tiêu đề. */}
                        <td className={td + ' truncate text-center text-slate-600'} title={b.ndt}>{b.ndt}</td>
                      </>
                    )}
                    <td className={td + ' text-center'}>
                      <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-900" title={b.loaiPhi}>
                        {viTatLoaiPhi(b.loaiPhi)}
                      </span>
                    </td>
                    <td className={td + ' truncate text-center text-slate-500'} title={b.nguoiNhap}>{b.nguoiNhap || '—'}</td>
                    <td className={td + ' truncate text-center text-slate-500'} title={b.ghiChu}>{b.ghiChu || '—'}</td>
                  </tr>
                ))}
                {/* HÀNG ĐỆM: hàng TỔNG ghim đáy NỔI TRÊN nội dung nên che mất dòng cuối khi cuộn tới đáy
                    (LEAD thấy bằng mắt ở ảnh 1920). Chừa đúng 1 hàng trống bằng chiều cao hàng tổng. */}
                <tr aria-hidden className="h-full">
                  <td colSpan={SO_COT} className="h-9" />
                </tr>
              </tbody>
              {/* TỔNG KHÓA CỨNG Ở ĐÁY khung bảng (Admin Demo 6/11): cuộn/lăn chuột bao nhiêu dòng vẫn thấy tổng.
                  sticky bottom-0 nằm TRONG khung cuộn nên không chiếm thêm chiều cao trang. */}
              <tfoot className="sticky bottom-0 z-10">
                <tr className="border-t-2 border-brand">
                  {/* [B266 25/11 — Admin Demo đảo cột] Hàng TỔNG khớp THỨ TỰ CỘT MỚI:
                      1 chọn · 2 Ngày · 3 Giờ · 4 Ca · 5 Đại lý · 6 TID · 7 HKD · 8 NH · 9 Thẻ · 10 Lô · 11 Số HĐ ·
                      12 Trước phí · 13 % CM · 14 Sau phí CM · 15 % Mua · 16 % Bán · 17 Sau phí bán ·
                      18 % Mua NĐT · 19 Sau mua NĐT · 20 Đã hoàn · 21 Chênh lệch · (còn lại).
                      MỌI cột tiền (12·14·17·19·20·21) PHẢI có ô tổng — thiếu/lệch một ô là số rơi sang cột khác. */}
                  <td className={tdTong + ' font-semibold text-brand-deep'} colSpan={2}>
                    TỔNG {danhSachLoc.length} bill
                  </td>
                  {/* Khối RỖNG giữa (checkbox+Ngày/Tháng) và "Trước phí": màn thường = Giờ→Số HĐ (cột 3→11, 9 ô),
                      màn TIỀN CHỜ = Đại lý→Thẻ (cột 3→7, 5 ô — đã ẩn Giờ/Ca/Lô/Số HĐ). */}
                  <td className={tdTong} colSpan={cheDoTienCho ? 5 : 9} />
                  {/* Trước phí */}
                  <td className={tdTong + ' text-right font-bold tabular-nums text-slate-800'}>{money(tongLoc).replace('đ', '')}</td>
                  {/* % CM */}
                  <td className={tdTong} />
                  {/* Sau phí CM */}
                  <td className={tdTong + ' text-right font-bold tabular-nums text-slate-600'} title={soChuaKhaiCaiMay > 0 ? soChuaKhaiCaiMay + ' bill chưa khai phí cài máy — tổng này THIẾU phần của chúng' : undefined}>{money(tongSauPhiCaiMay).replace('đ', '')}{soChuaKhaiCaiMay > 0 && <span data-kiem="chua-khai-cm" className="ml-0.5 font-semibold text-amber-600">*{soChuaKhaiCaiMay}</span>}</td>
                  {/* % Mua */}
                  <td className={tdTong} />
                  {/* % Bán */}
                  <td className={tdTong} />
                  {/* Sau phí bán */}
                  <td className={tdTong + ' text-right font-bold tabular-nums text-brand'}>{money(tongVe).replace('đ', '')}</td>
                  {/* [TIỀN CHỜ] TỔNG Phải thu = Σ doanh số × (%bán − %mua đối tác). *N = N bill chưa đủ % để tính. */}
                  {cheDoTienCho && (
                    <td className={tdTong + ' text-right font-bold tabular-nums text-brand'} title={soThieuPhaiThu > 0 ? soThieuPhaiThu + ' bill thiếu % phí bán/mua — tổng phải thu THIẾU phần của chúng' : undefined}>{money(tongPhaiThu).replace('đ', '')}{soThieuPhaiThu > 0 && <span className="ml-0.5 font-semibold text-amber-600">*{soThieuPhaiThu}</span>}</td>
                  )}
                  {/* [TIỀN CHỜ] % Mua NĐT · Sau mua NĐT · Đã hoàn · Chênh lệch — chỉ màn thường. */}
                  {!cheDoTienCho && (
                    <>
                      {/* % Mua NĐT */}
                      <td className={tdTong} />
                      {/* Sau mua NĐT */}
                      <td className={tdTong + ' text-right font-bold tabular-nums text-slate-600'} title={soChuaKhaiMuaNdt > 0 ? soChuaKhaiMuaNdt + ' bill chưa khai phí mua NĐT — tổng này THIẾU phần của chúng' : undefined}>{money(tongSauMuaNdt).replace('đ', '')}{soChuaKhaiMuaNdt > 0 && <span data-kiem="chua-khai-ndt" className="ml-0.5 font-semibold text-amber-600">*{soChuaKhaiMuaNdt}</span>}</td>
                      {/* Đã hoàn */}
                      <td className={tdTong + ' text-right font-bold tabular-nums text-success'}>{money(tongDaHoan).replace('đ', '')}</td>
                      {/* Chênh lệch */}
                      <td className={tdTong + ' text-right font-bold tabular-nums ' + (chenhLech === 0 ? 'text-slate-400' : chenhLech < 0 ? 'text-danger' : 'text-success')}>
                        {/* [B294] dùng CHUNG biến chenhLech với ô KPI — một quy ước, hết ngược dấu ngược màu. */}
                        {chenhLech === 0 ? '0' : (chenhLech < 0 ? '−' : '+') + money(Math.abs(chenhLech)).replace('đ', '')}
                      </td>
                    </>
                  )}
                  {/* Cột đuôi không tổng: màn thường = Người hoàn·NĐT·Loại phí·Người nhập·Ghi chú (SO_COT−21=5);
                      màn TIỀN CHỜ = Loại phí·Người nhập·Ghi chú (3). */}
                  <td className={tdTong} colSpan={cheDoTienCho ? 3 : SO_COT - 21} />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

      {cheDo === 'nhap' && !thuNho && (
        <Modal
          title="Thêm Bill"
          width="max-w-[98vw]"
          // [B263 24/11 — Admin Demo "chiều cao màn nhập bill FULL chiều cao màn hình"] 90vh → 100vh.
          // Khung hộp thoại vốn có lề p-4 nên vẫn còn viền mỏng, không dính mép màn.
          // [B263 lần 3] fullHeight: khung CAO CỐ ĐỊNH gần hết màn ở MỌI cỡ (cổng đo 1280×650 + 1700×950:
          // không tràn, nút ✕ bấm được, cao ≥80% màn — max-h đơn thuần làm hộp lùn khi màn cao).
          fullHeight
          bodyPad="p-3"
          dongMauDo
          headerExtra={
            <button
              type="button"
              title="Thu nhỏ để xem danh sách (giữ nguyên dữ liệu đang nhập)"
              data-nut="thunho"
              onClick={() => setThuNho(true)}
              className="rounded p-1 text-slate-400 hover:bg-appbg hover:text-brand"
            >
              <Minus className="h-5 w-5" />
            </button>
          }
          onClose={() => {
            if (coDuLieu) {
              setHoiDong(true); // còn dữ liệu → HỎI LẠI, không đóng ngay
              return;
            }
            setCheDo('danhsach');
            setThuNho(false);
          }}
        >
        <div className="grid min-h-0 flex-1 content-start gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-line bg-white p-4 lg:col-span-2">
            {/* Nhóm 1 — máy POS & đại lý */}
            <h3 className={nhanNhom}>
              <Store className="h-3.5 w-3.5 text-brand" /> Máy POS &amp; đại lý cầm máy
            </h3>
          <div className="grid grid-cols-2 items-end gap-x-4">
            <Field label="Ngân hàng" required hint="Gõ để tìm nhanh ngân hàng">
              <SearchSelect
                value={bankChon}
                onChange={(v) => {
                  setBankChon(v);
                  setTidId('');
                  setCardTypeId('');
                }}
                options={bankOptions}
                placeholder="— Chọn ngân hàng —"
              />
            </Field>
            <Field label="TID (máy POS)" required hint={bankChon ? 'Chỉ TID của ngân hàng đã chọn' : 'Chọn ngân hàng trước'}>
              <SearchSelect
                value={tidId}
                onChange={(v) => {
                  setTidId(v);
                  setCardTypeId('');
                }}
                options={tidOptions}
                placeholder={bankChon ? '— Gõ tên HKD hoặc số TID —' : '— Chọn ngân hàng trước —'}
                disabled={!bankChon}
              />
            </Field>
          </div>
            {/* B197 — TID chọn vào mà chưa đủ điều kiện: NÓI RÕ thiếu bước nào. Trước đây TID loại này bị ẩn im. */}
            {tidChuaDung && (
              <p className="mt-2 rounded-lg border border-danger/50 bg-danger/5 px-3 py-2 text-[12px] leading-snug text-danger">
                <b>Chưa nhập bill được cho TID này.</b> {tidChuaDung}
              </p>
            )}
            {/* [B208 19/11 — Admin Demo "bỏ dòng này đi"] BỎ dòng đếm "Có N TID chưa giao cho khách": dấu ⚠ ngay
                trên nhãn TID đã đủ nói, thêm một dòng chữ nữa chỉ tốn chiều cao form (đang phải chống tràn). */
}
            {/* Dải thông tin TID — thứ tự Admin Demo chốt 6/11: Đại lý · HKD · Ngân hàng · Phí bán · NĐT · Đối tác.
              Mỗi ô tách bạch bằng viền trắng; tên dài rê chuột xem đủ. */}
          <div className={'mt-2.5 grid gap-1.5 ' + (cheDoTienCho ? 'grid-cols-[1.1fr_1.9fr_0.8fr_0.9fr_0.9fr]' : 'grid-cols-[1.1fr_1.9fr_0.8fr_0.9fr_1fr_0.9fr]')}>
            <div className="rounded-lg bg-brand px-3 py-2 text-center shadow-sm" title={tid?.customerName ?? ''}>
              <div className="text-[11px] text-white/80">Đại lý cầm TID</div>
              <div className="truncate text-sm font-semibold text-white">{tid ? tid.customerName ?? 'CHƯA giao đại lý' : '—'}</div>
            </div>
            <div className="rounded-lg bg-brand px-3 py-2 text-center shadow-sm" title={tid?.hkdName ?? ''}>
              <div className="text-[11px] text-white/80">Hộ kinh doanh</div>
              <div className="truncate text-sm font-medium text-white">{tid?.hkdName ?? '—'}</div>
            </div>
            <div className="rounded-lg bg-brand px-3 py-2 text-center shadow-sm" title={tid ? tid.bankName ?? '' : ''}>
              <div className="text-[11px] text-white/80">Ngân hàng</div>
              <div className="truncate text-sm font-medium text-white">{tid ? tid.bankCode ?? tid.bankName ?? '—' : '—'}</div>
            </div>
            {/* PHÍ BÁN của thẻ đang chọn; chưa chọn thì lấy thẻ ĐẦU TIÊN đã đặt giá bán (mặc định). */}
            <div className="rounded-lg bg-brand px-3 py-2 text-center shadow-sm" title={theMacDinh ? 'Theo loại thẻ ' + theMacDinh.cardTypeName : ''}>
              <div className="text-[11px] text-white/80">Phí bán{theMacDinh ? ' · ' + theMacDinh.cardTypeName : ''}</div>
              <div className="truncate text-sm font-semibold text-white">
                {theMacDinh?.hasOverride
                  ? pctText(theMacDinh.phiBanThucTe)
                  : tid
                    ? theMacDinh?.phiBanNiemYet != null
                      ? pctText(theMacDinh.phiBanNiemYet) + ' (niêm yết)'
                      : 'chưa có giá'
                    : '—'}
              </div>
            </div>
            {/* [TIỀN CHỜ] BỎ thẻ "Nhà đầu tư (ủy)" — màn tiền chờ không nhắc NĐT ở bất cứ đâu. */}
            {!cheDoTienCho && (
              <div className="rounded-lg bg-brand px-3 py-2 text-center shadow-sm" title={tid?.receiveAccountLabel ?? ''}>
                <div className="text-[11px] text-white/80">Nhà đầu tư (ủy)</div>
                <div className={'truncate text-sm text-white ' + (ndt.nhanManh ? 'font-semibold' : 'font-medium opacity-90')}>{ndt.text}</div>
              </div>
            )}
            <div className="rounded-lg bg-brand px-3 py-2 text-center shadow-sm" title={tid?.partnerName ?? ''}>
              <div className="text-[11px] text-white/80">Đối tác</div>
              <div className="truncate text-sm font-medium text-white">{tid?.partnerName ?? '—'}</div>
            </div>
          </div>


          {/* MƯỢN TID (Admin Demo 6/11) — như luồng bill OCR: doanh số bill NÀY về nhà mượn, bill sau tự về chủ máy. */}
          <div className="mt-2 min-h-[64px] rounded-lg border border-line bg-appbg/40 px-3 py-2">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-700">
                <input
                  type="checkbox"
                  className="accent-brand"
                  checked={muonTid}
                  onChange={(e) => {
                    setMuonTid(e.target.checked);
                    if (!e.target.checked) {
                      setDaiLyMuonId('');
                      setXacNhanMuon(false);
                    }
                  }}
                  disabled={!tid}
                />
                Bill này đại lý khác MƯỢN máy
              </label>
              {muonTid && (
                <>
                  <div className="w-64">
                    <SearchSelect
                      value={daiLyMuonId}
                      onChange={setDaiLyMuonId}
                      options={dsDaiLyMuon}
                      placeholder="— Chọn đại lý mượn —"
                    />
                  </div>
                  <label className="flex items-center gap-1.5 text-xs font-medium text-amber-800">
                    <input type="checkbox" className="accent-warning" checked={xacNhanMuon} onChange={(e) => setXacNhanMuon(e.target.checked)} />
                    Xác nhận doanh số bill này ghi cho <b>{tenDaiLyMuon || '…'}</b>, không phải chủ máy
                  </label>
                </>
              )}
            </div>
            {muonTid && (
              <p className="mt-1 text-[11px] text-slate-500">
                Chỉ áp cho ĐÚNG bill này theo giờ quẹt đã nhập; bill kế tiếp tự quay về đại lý gắn TID ({tid?.customerName ?? '—'}).
              </p>
            )}
          </div>

          {/* Nhóm 2 — số liệu in trên bill: 1 HÀNG NGANG (Admin Demo 6/11) */}
          {/* [TIỀN CHỜ] BỎ TRỌN nhóm này: tiền chờ nhập TỔNG theo tháng, không có Số lô · Số HĐ · Ngày · Giờ ·
              Ca · Mã đóng lô. Ngày ghi sổ tự = HÔM NAY (00:00), set ở payload txnDate. */}
          {!cheDoTienCho && (
          <>
          <div className="my-2 border-t border-line" />
          <h3 className={nhanNhom}>
            <Hash className="h-3.5 w-3.5 text-brand" /> Số liệu in trên bill
          </h3>
          <div className="grid grid-cols-6 items-end gap-x-3 gap-y-2.5">
            {/* [Admin Demo 16/11] SỐ LÔ đứng TRƯỚC số hoá đơn — nhập theo đúng thứ tự người ta đọc trên bill. */}
            <Field label="Số lô">
              <input
                className={oNhap + ' tabular-nums'}
                inputMode="numeric"
                value={soLo}
                onChange={(e) => setSoLo(chiSo(e.target.value))}
                placeholder="vd 84"
              />
            </Field>
            <Field label="Số hóa đơn">
              <input
                className={oNhap + ' tabular-nums'}
                inputMode="numeric"
                value={soHoaDon}
                onChange={(e) => setSoHoaDon(chiSo(e.target.value))}
                placeholder="vd 000123"
              />
            </Field>
            <Field label="Ngày trên bill" required>
              <input type="date" className={oNhap} value={ngay} onChange={(e) => setNgay(e.target.value)} />
            </Field>
            <Field label="Giờ quẹt" required>
              <GioInput
                value={gio}
                onChange={(v) => {
                  setGio(v);
                  setGioDaDat(true); // người dùng tự đặt giờ ⇒ mới bật phép so "nghịch thứ tự lô ↔ giờ"
                }}
                onLoi={setGioLoi}
              />
            </Field>
            {/* CA tự suy từ giờ + ngân hàng của TID (mốc ca-tien.ts) — Admin Demo 6/11 thay cho chữ "24h". */}
            <Field label="Ca (tự tính)">
              <input
                readOnly
                tabIndex={-1}
                className={oNhap + ' cursor-default bg-brand-tint/60 text-center font-semibold tabular-nums text-brand'}
                value={tid ? caCuaBill(tid.bankCode ?? tid.bankName ?? '', gio, caCuaBank(tid.bankId))?.ten ?? '' : ''}
                placeholder={tid ? 'ngân hàng chưa khai ca' : 'chọn TID'}
              />
            </Field>
            {/* MÃ ĐÓNG LÔ là Ô TÍCH — mặc định KHÔNG đóng; tích thì lô hiện "84(95)". */}
            <Field label="Mã đóng lô">
              <label className={oNhap + ' flex cursor-pointer items-center gap-2'}>
                <input
                  type="checkbox"
                  className={maDongLo === '95' ? 'accent-danger' : 'accent-brand'}
                  checked={maDongLo === '95'}
                  onChange={(e) => setMaDongLo(e.target.checked ? '95' : '')}
                />
                <span className={maDongLo === '95' ? 'font-semibold text-danger' : 'text-slate-500'}>
                  {maDongLo === '95' ? 'Bị đóng 95' : 'Bill hợp lệ'}
                </span>
              </label>
            </Field>
          </div>
          </>
          )}

          {/* Nhóm 3 — tiền & phí */}
          <div className="my-2 border-t border-line" />
          {/* [TIỀN CHỜ 25/11 — Admin Demo "có chọn tháng để nhập bill"] Màn tiền chờ chọn THÁNG ghi sổ (ngày = mùng 1
              tháng đó). Màn thường dùng ô "Ngày trên bill" ở nhóm trên (đã ẩn ở tiền chờ). */}
          {cheDoTienCho && (
            <div className="mb-3 max-w-[220px]">
              <Field label="Tháng ghi sổ" required hint="Công nợ tiền chờ ghi theo tháng">
                <input type="month" className={oNhap} value={ngay.slice(0, 7)} onChange={(e) => setNgay(e.target.value + '-01')} />
              </Field>
            </div>
          )}
          <h3 className={nhanNhom}>
            <CreditCard className="h-3.5 w-3.5 text-brand" /> Số tiền &amp; phí bán (theo TID × loại phí × loại thẻ)
          </h3>
          {/* [BỔ SUNG 5 — 24/11] Loại thẻ CHIẾM 2 cột để đủ rộng cho LOGO thương hiệu + tên + % không bị cắt. */}
          <div className="grid grid-cols-6 items-end gap-x-4 gap-y-2.5">
            {/* [B266 25/11 — Admin Demo "lệch dòng"] BỎ hint: hint render thêm 1 dòng dưới input làm ô Loại thẻ CAO hơn
                các ô cạnh → với grid items-end, input bị lệch đáy. Logo + gõ-để-tìm đã tự rõ, không cần hint. */}
            <div className="col-span-2">
            <Field label="Loại thẻ" required>
              {/* data-kiem/data-gia-tri: cổng tự kiểm đọc giá trị ĐÃ CHỌN (Loại thẻ nay là SearchSelect, không còn <select>). */}
              <div data-kiem="o-loai-the" data-gia-tri={cardTypeId}>
                <SearchSelect
                  value={cardTypeId}
                  onChange={setCardTypeId}
                  options={theOptions}
                  leading={theLogo}
                  placeholder={feeRows.length ? '— Chọn loại thẻ —' : '— Chọn TID trước —'}
                  disabled={!feeRows.length}
                />
              </div>
            </Field>
            </div>
            <Field label="Loại phí" required>
              <select
                className={oNhap}
                value={feeTypeId}
                onChange={(e) => {
                  setFeeTypeId(e.target.value);
                  setCardTypeId('');
                }}
              >
                <option value="">— Chọn loại phí —</option>
                {/* [DOANH SỐ TIỀN CHỜ 24/11] Màn tiền chờ CHỈ cho chọn Tiền chờ(8)/Uỷ quyền(9). */}
                {feeTypes
                  .filter((f) => !cheDoTienCho || f.id === 8 || f.id === 9)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Trước phí" required>
              <input
                className={oNhap + ' text-right tabular-nums'}
                inputMode="numeric"
                value={groupDigits(soTien)}
                onChange={(e) => setSoTien(chiSo(e.target.value))}
                placeholder="0"
              />
            </Field>
            {/* [TIỀN CHỜ] BỎ ô "Tiền hủy" — tiền chờ không có giao dịch hủy (tienHuy giữ rỗng ⇒ voidAmount=0). */}
            {!cheDoTienCho && (
              <Field label="Tiền hủy">
                <input
                  className={oNhap + ' text-right tabular-nums' + (huyVuot ? ' border-danger focus:border-danger focus:ring-danger/25' : '')}
                  inputMode="numeric"
                  value={groupDigits(tienHuy)}
                  onChange={(e) => setTienHuy(chiSo(e.target.value))}
                  placeholder="0"
                />
              </Field>
            )}
            {/* Ô KHÓA — TỰ tính: (trước phí − hủy) − phí bán. */}
            <Field label="Sau phí bán">
              <input
                readOnly
                tabIndex={-1}
                className={oNhap + ' cursor-default bg-brand-tint/60 text-right font-semibold tabular-nums text-brand'}
                value={soTien.trim() && tienVe != null ? money(tienVe).replace('đ', '') : ''}
                title={tienHuySo ? 'Đã trừ hủy ' + money(tienHuySo) + ' trước khi tính phí' : ''}
                placeholder="tự tính"
              />
            </Field>
          </div>

          {/* Tóm tắt phí của ĐÚNG thẻ đang chọn (bỏ bảng phí cho khỏi bấm nhầm dòng). */}
          <div className="mt-2 rounded-lg border border-line bg-appbg/60 px-3 py-2 text-sm text-slate-600">
            {!tidId || !cardTypeId ? (
              <span className="text-slate-400">Chọn TID và loại thẻ để xem biểu phí đã cài.</span>
            ) : (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <b className="text-slate-800">{sellFee?.cardTypeName}</b>
                <span>Phí mua <b className="tabular-nums text-slate-800">{pctText(sellFee?.phiMuaNiemYet ?? null)}</b></span>
                <span>Cài máy <b className="tabular-nums text-slate-800">{pctText(sellFee?.phiCaiMayNiemYet ?? null)}</b></span>
                <span>Niêm yết <b className="tabular-nums text-slate-800">{pctText(sellFee?.phiBanNiemYet ?? null)}</b></span>
                <span>
                  Bán áp dụng{' '}
                  {thieuGiaBanThucTe ? (
                    <b className="text-warning">{pctText(sellFee?.phiBanNiemYet ?? null)} (niêm yết — chưa đặt làm giá bán)</b>
                  ) : (
                    <b className="tabular-nums text-brand">{pctText(phiBanApplied)}</b>
                  )}
                </span>
              </span>
            )}
          </div>

          {/* TÁCH NHIỀU LOẠI THẺ TRONG 1 LÔ — vd lô 1 tỉ: Visa 500tr, phần còn lại tự sang thẻ kia. */}
          {/* [B204 19/11 — Admin Demo "giảm chiều cao blog này để chống tràn"] TRƯỚC: `min-h-[164px]` LUÔN chiếm
              164px dù CHƯA tích tách thẻ ⇒ ở màn cao 768px, form cao 888px trong khung 691px nên hàng "Đã
              hoàn / Người hoàn" và nút "Ghi nhận bill" rơi xuống dưới mép, phải cuộn mới thấy.
              NAY: chỉ giữ chiều cao tối thiểu KHI đã bật tách thẻ (lúc đó mới cần chỗ cho các dòng thẻ). */}
          <div className={'mt-2 rounded-lg border border-line bg-appbg/40 px-3 py-2' + (tachThe ? ' min-h-[164px]' : '')}>
            <label className="flex items-center gap-2 text-xs font-medium text-slate-700">
              <input
                type="checkbox"
                className="accent-brand"
                checked={tachThe}
                onChange={(e) => {
                  setTachThe(e.target.checked);
                  // Dòng 2 phải khác dòng 1 theo GIÁ TRỊ THẬT của dòng 1. Bản trước so với `cardTypeId`
                  // (có thể đang RỖNG) nên khi chưa chọn loại thẻ thì 2 dòng tách ra CÙNG MỘT THẺ
                  // ⇒ khối tách lập tức không hợp lệ, không ai hiểu vì sao nút ghi bị khóa.
                  const the1 = cardTypeId || String(feeRows[0]?.cardTypeId ?? '');
                  const the2 = String(feeRows.find((r) => String(r.cardTypeId) !== the1)?.cardTypeId ?? '');
                  setDongThe(e.target.checked ? [{ cardTypeId: the1, tien: '' }, { cardTypeId: the2, tien: '' }] : []);
                }}
              />
              Lô này quẹt NHIỀU loại thẻ — tách tiền theo thẻ
            </label>
            {tachThe && (
              <div className="mt-2 space-y-1.5">
                {dongThe.map((d, i) => {
                  const cuoi = i === dongThe.length - 1;
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <select
                        className={inputCls + ' !py-1 w-56 text-xs'}
                        value={d.cardTypeId}
                        onChange={(e) => setDongThe((cu) => cu.map((x, k) => (k === i ? { ...x, cardTypeId: e.target.value } : x)))}
                      >
                        <option value="">— Chọn loại thẻ —</option>
                        {feeRows.map((r) => (
                          <option key={r.cardTypeId} value={r.cardTypeId}>
                            {r.cardTypeName}
                          </option>
                        ))}
                      </select>
                      {cuoi ? (
                        <input
                          readOnly
                          tabIndex={-1}
                          className={inputCls + ' !py-1 w-44 cursor-default bg-brand-tint/60 text-right text-xs font-semibold tabular-nums text-brand'}
                          value={tienLo ? money(conLaiTach).replace('đ', '') : ''}
                          title="Phần còn lại của lô, tự tính"
                        />
                      ) : (
                        <input
                          className={inputCls + ' !py-1 w-44 text-right text-xs tabular-nums'}
                          inputMode="numeric"
                          value={groupDigits(d.tien)}
                          onChange={(e) => setDongThe((cu) => cu.map((x, k) => (k === i ? { ...x, tien: chiSo(e.target.value) } : x)))}
                          placeholder="0"
                        />
                      )}
                      <span className="text-[11px] text-slate-400">{cuoi ? 'phần còn lại (tự tính)' : 'tiền của thẻ này'}</span>
                      {!cuoi && dongThe.length > 2 && (
                        <button
                          type="button"
                          className="rounded p-0.5 text-danger hover:bg-danger/10"
                          title="Bỏ dòng này"
                          onClick={() => setDongThe((cu) => cu.filter((_, k) => k !== i))}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
                <Button data-nut="them"
                  variant="soft"
                  size="xs"
                  onClick={() => setDongThe((cu) => [...cu.slice(0, -1), { cardTypeId: '', tien: '' }, cu[cu.length - 1]])}
                  icon={<Plus className="h-3 w-3" />}
                >
                  Thêm loại thẻ
                </Button>
                {!tachHopLe && (
                  <p className="text-[11px] font-medium text-danger">
                    Mỗi dòng phải chọn loại thẻ KHÁC NHAU và tổng các dòng đã nhập phải nhỏ hơn tiền lô ({money(tienLo)}).
                  </p>
                )}
              </div>
            )}
          </div>

          {/* HOÀN TIỀN — ai hoàn, bao nhiêu, còn lại bao nhiêu */}
          {/* [TIỀN CHỜ] BỎ TRỌN nhóm hoàn tiền (Đã hoàn · Người hoàn · Còn phải hoàn): tiền chờ là CÔNG NỢ
              phải thu, KHÔNG có hoàn tiền khách (daHoan giữ rỗng ⇒ refundedAmount=0, refundedByUserId=null). */}
          {!cheDoTienCho && (
          <div className="mt-2 grid grid-cols-3 items-end gap-x-4 gap-y-2">
            <Field label="Đã hoàn">
              <input
                className={oNhap + ' text-right tabular-nums' + (hoanVuot ? ' border-danger focus:border-danger focus:ring-danger/25' : '')}
                inputMode="numeric"
                value={groupDigits(daHoan)}
                onChange={(e) => setDaHoan(chiSo(e.target.value))}
                placeholder="0"
              />
            </Field>
            {/* [Admin Demo 16/11] Ô này KHÔNG khoá theo số tiền: thực tế hoàn GỘP nhiều bill 1 lần, nên bill lẻ
                có "đã hoàn" = 0 vẫn cần ghi AI là người hoàn. Vẫn giữ luật: có tiền hoàn thì BẮT BUỘC chọn. */}
            {/* [B205 19/11 — Admin Demo "các ô phải cùng hàng chứ"] TRƯỚC: ô này có DÒNG MÁCH NƯỚC phía dưới mà
                2 ô bên cạnh không có, cả hàng lại căn theo ĐÁY ⇒ ba ô so le cao thấp. Nay chuyển mách nước
                thành chú thích rê chuột: ba ô cùng cấu trúc nên thẳng hàng, và bớt được chiều cao cho form. */}
            {/* [B266 25/11 — Admin Demo "Còn phải hoàn lệch dòng"] BỎ hint phím-số (làm ô cao hơn Đã hoàn/Còn phải hoàn
                → lệch đáy). Gợi ý phím-số chuyển thành title rê chuột để 3 ô cùng chiều cao, thẳng hàng. */}
            <Field label="Người hoàn" required={daHoanSo > 0}>
              <div title={(ptNguoiHoanBat && Object.keys(ptDigitMapNH).length > 0 ? 'Mở danh sách, ô tìm rỗng → bấm phím số để chọn nhanh. ' : '') + 'Chọn được cả khi hoàn 0đ — dùng khi hoàn gộp nhiều bill 1 lần'}>
                <SearchSelect
                  value={nguoiHoanId}
                  onChange={setNguoiHoanId}
                  options={dsNguoiHoanHienThi}
                  placeholder="— Người được hoàn tiền —"
                  digitMap={ptNguoiHoanBat ? ptDigitMapNH : undefined}
                  badgeOf={
                    ptNguoiHoanBat
                      ? (v) => {
                          const d = ptPhimCuaNguoi(cfgPt, Number(v));
                          return d ? (
                            <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded bg-brand px-1 text-xs font-bold text-white" title={'Phím ' + d}>
                              {d}
                            </span>
                          ) : null;
                        }
                      : undefined
                  }
                />
              </div>
            </Field>
            <Field label="Còn phải hoàn">
              <input
                readOnly
                tabIndex={-1}
                className={oNhap + ' cursor-default bg-brand-tint/60 text-right font-semibold tabular-nums text-brand'}
                value={conPhaiHoan != null && tienLo ? money(conPhaiHoan).replace('đ', '') : ''}
                placeholder="tự tính"
              />
            </Field>
          </div>
          )}
          </div>

          {/* ── PHẢI: chốt số ── */}
          <div className="flex flex-col gap-2">
            <section className="overflow-hidden rounded-xl border border-line bg-white">
              <h3 className="border-b border-line bg-slate-200 px-2.5 py-1.5 text-xs font-bold uppercase tracking-wide text-slate-900">Sẽ ghi nhận</h3>
              <Dong label={muonTid ? 'Về đại lý (MƯỢN)' : 'Về đại lý'} value={veNha} strong />
              {/* [TIỀN CHỜ] Panel bỏ NĐT · Lô · Số hóa đơn · Trừ hủy (không có trong tiền chờ). */}
              {!cheDoTienCho && <Dong soc label="Nhà đầu tư" value={tid ? ndt.text : ''} />}
              {!cheDoTienCho && <Dong label="Lô" value={loHienThi(soLo, maDongLo)} />}
              {!cheDoTienCho && <Dong soc label="Số hóa đơn" value={soHoaDon} />}

              <Dong label="Tiền trước phí bán" value={tienQuet ? money(tienQuet) : ''} />
              <Dong soc label="% phí bán" value={phiBanApplied != null ? pctText(phiBanApplied) : ''} />
              {!cheDoTienCho && <Dong label="Trừ hủy" value={tienHuySo ? '−' + money(tienHuySo) : ''} danger={tienHuySo > 0} />}
              <Dong soc label={cheDoTienCho ? 'Doanh số ghi' : 'Doanh số ghi (đã trừ hủy)'} value={tienQuet ? money(tienLo) : ''} strong />
              <div className="grid grid-cols-[1fr_auto] items-stretch border-y-2 border-brand bg-brand-tint">
                <span className="px-2.5 py-1.5 text-xs font-semibold text-slate-700">Sau phí bán — đại lý nhận</span>
                <span className="min-w-[124px] border-l border-brand/30 px-2.5 py-1.5 text-right text-base font-bold tabular-nums text-brand">
                  {tienVe != null && tienLo ? money(tienVe).replace('đ', '') : '—'}
                </span>
              </div>

              {/* [TIỀN CHỜ] Dòng chốt = PHẢI THU (công nợ) = Sau phí cài máy − Sau phí bán = (phí bán − phí cài)
                  × doanh số. Màn thường vẫn là Đã hoàn / Còn phải hoàn. */}
              {cheDoTienCho ? (
                <div className="grid grid-cols-[1fr_auto] items-stretch border-t-2 border-brand-deep bg-brand-tint">
                  <span className="px-2.5 py-1.5 text-xs font-semibold text-slate-700">Phải thu (công nợ)</span>
                  <span className="min-w-[124px] border-l border-brand/30 px-2.5 py-1.5 text-right text-base font-bold tabular-nums text-brand-deep">
                    {tienCaiMay != null && tienVe != null && tienLo ? money(tienLo - tienCaiMay - tienVe).replace('đ', '') : '—'}
                  </span>
                </div>
              ) : (
                <>
                  <Dong label={'Đã hoàn' + (nguoiHoan ? ' · ' + nguoiHoan.fullName : '')} value={daHoanSo ? '−' + money(daHoanSo) : ''} danger={daHoanSo > 0} />
                  <div className="grid grid-cols-[1fr_auto] items-stretch border-t-2 border-brand-deep bg-brand-tint">
                    <span className="px-2.5 py-1.5 text-xs font-semibold text-slate-700">Còn phải hoàn</span>
                    <span className="min-w-[124px] border-l border-brand/30 px-2.5 py-1.5 text-right text-base font-bold tabular-nums text-brand-deep">
                      {conPhaiHoan != null && tienLo ? money(conPhaiHoan).replace('đ', '') : '—'}
                    </span>
                  </div>
                </>
              )}
              {khoaBill && (
                <div className="flex items-start gap-1.5 px-2.5 py-1.5">
                  <KeyRound className="mt-0.5 h-3 w-3 shrink-0 text-[#0d4a7a]" />
                  <code className="block break-all text-[10px] leading-tight text-slate-500">{khoaBill}</code>
                </div>
              )}
            </section>

            {hoanVuot && (
              <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <div className="font-medium">
                  Tiền hoàn ({money(daHoanSo)}) lớn hơn tiền về của BILL NÀY ({money(tienVe ?? 0)}).
                </div>
                <label className="mt-1.5 flex items-start gap-1.5">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    data-kiem="xac-nhan-hoan-gop"
                    checked={xacNhanHoanGop}
                    onChange={(e) => setXacNhanHoanGop(e.target.checked)}
                  />
                  <span>
                    Đây là <b>hoàn GỘP</b> cho nhiều bill (các bill trước để hoàn 0đ) — tôi xác nhận số tiền này đúng.
                  </span>
                </label>
              </div>
            )}
            {daHoanSo > 0 && !nguoiHoanId && (
              <div className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-700">Có tiền đã hoàn thì phải chọn NGƯỜI HOÀN — để lại vết ai trả.</div>
            )}
            {huyVuot && (
              <div className="mt-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-medium text-danger">
                Tiền hủy ({money(tienHuySo)}) lớn hơn tổng quẹt ({money(tienQuet)}) — kiểm lại bill.
              </div>
            )}
            {thieuGiaBanThucTe && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
                <span>
                  Loại thẻ đang chọn chưa có giá bán thực tế cho loại phí “{tenLoaiPhi}” — doanh số KHÔNG tự mượn giá niêm yết
                  (luật tiền), phải đặt giá bán cho TID rồi mới ghi được.
                </span>
                {/* [KẾ TOÁN NĐT 24/11] Vai không có TID_MANAGE (kế toán NĐT) KHÔNG được đặt giá — giá do SigMa quản
                    (dùng chung). Backend đã 403; ẩn nút để khỏi ra toast khó hiểu, thay bằng hướng dẫn liên hệ. */}
                {/* Ẩn nút đặt giá CHỈ với vai Kế toán NĐT (họ KHÔNG được đặt giá — backend đã 403). Mọi vai khác
                    (admin/kế toán thường) vẫn thấy. Gate theo VAI, không theo literal TID_MANAGE vì admin cấp quyền
                    qua vai nên mảng permissions có thể không liệt kê TID_MANAGE. */}
                {!(user.roles ?? []).includes('R_KETOAN_NDT') ? (
                  <button
                    type="button"
                    data-kiem="nut-dat-gia-niem-yet"
                    disabled={dangDatNiemYet}
                    onClick={() => void datGiaNiemYetLamGiaBan()}
                    className="rounded-md border border-amber-400 bg-white px-2 py-1 font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                  >
                    {dangDatNiemYet ? 'Đang đặt…' : 'Dùng giá niêm yết làm giá bán'}
                  </button>
                ) : (
                  <span data-kiem="nhac-lien-he-alpha-dat-gia" className="font-semibold text-amber-800">
                    TID này chưa được SigMa khai giá bán — vui lòng liên hệ kế toán SigMa để khai giá (bạn không có quyền đặt giá).
                  </span>
                )}
              </div>
            )}
            {canXacNhanLo && (
            <div
              className={
                'mt-2 rounded-lg border px-3 py-2 text-xs ' +
                (billTrung ? 'border-danger/40 bg-red-50 text-danger' : 'border-warning/50 bg-amber-50 text-amber-800')
              }
            >
              {billTrung && (
                <p>
                  <b>TRÙNG HOÀN TOÀN:</b> máy {tid?.tid} đã có bill lô <b>{billTrung.lo}</b> ngày{' '}
                  <b>{ngayNgan(billTrung.ngay)}</b> cùng số tiền <b>{money(billTrung.tienLo)}</b> (lúc {billTrung.gio}). Gần
                  như chắc chắn là gõ lại bill cũ.
                </p>
              )}
              {!billTrung && trungLoKhacNgay && (
                <p>
                  <b>TRÙNG SỐ LÔ:</b> máy {tid?.tid} đã có lô <b>{trungLoKhacNgay.lo}</b> ngày{' '}
                  <b>{ngayNgan(trungLoKhacNgay.ngay)}</b> lúc {trungLoKhacNgay.gio} ({money(trungLoKhacNgay.tienLo)}). Khác
                  ngày/giờ/tiền thì VẪN GHI ĐƯỢC — ngân hàng có thể cấp lại số lô — nhưng phải xác nhận có chủ ý.
                </p>
              )}
              {!billTrung && trungSoHoaDon && (
                <p className={trungLoKhacNgay ? 'mt-1' : ''}>
                  <b>TRÙNG SỐ HÓA ĐƠN:</b> máy {tid?.tid} đã có bill số HĐ <b>{trungSoHoaDon.soHoaDon}</b> ngày{' '}
                  <b>{ngayNgan(trungSoHoaDon.ngay)}</b> lúc {trungSoHoaDon.gio} ({money(trungSoHoaDon.tienLo)}). Máy chủ
                  dựng khóa bill từ lô HOẶC số hóa đơn, nên ghi tiếp là doanh số tính HAI LẦN.
                </p>
              )}
              {nghichThuTu && (
                <p className={billTrung || trungLoKhacNgay || trungSoHoaDon ? 'mt-1' : ''}>
                  <b>NGHỊCH THỨ TỰ LÔ ↔ GIỜ:</b> cùng ngày, máy này đã có lô{' '}
                  <b>{nghichThuTu.lo}</b> lúc <b>{nghichThuTu.gio}</b>, trong khi lô <b>{soLo}</b> đang nhập lúc{' '}
                  <b>{gio}</b>. Lô lớn hơn mà giờ sớm hơn là bất thường — kiểm lại GIỜ hoặc SỐ LÔ trước khi ghi.
                </p>
              )}
              <label className="mt-1.5 flex items-center gap-1.5 font-medium">
                <input
                  type="checkbox"
                  className={billTrung ? 'accent-danger' : 'accent-warning'}
                  checked={xacNhanTrung}
                  onChange={(e) => setXacNhanTrung(e.target.checked)}
                />
                Tôi đã kiểm tra, đây là bill ĐÚNG — vẫn ghi nhận
              </label>
            </div>
            )}
            {/* GHI CHÚ chuyển sang cột phải, ngay dưới khối chốt số (Admin Demo 6/11). */}
            <div className="rounded-xl border border-line bg-white p-3">
              <Field label="Ghi chú">
                <input className={oNhap} value={ghiChu} onChange={(e) => setGhiChu(e.target.value)} placeholder="vd: khách gửi bằng tin nhắn" />
              </Field>
            </div>

            {!dayDu && thieuGi.length > 0 && (
              <p className="rounded-lg border border-warning/40 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-snug text-amber-800">
                <b>Chưa ghi được vì:</b> {thieuGi.join(' · ')}
              </p>
            )}
            {/* [BỔ SUNG 4 — 24/11] Bill HỢP LỆ → tích xanh lá + chữ xanh lá "sẵn sàng ghi" (khớp Enter-xác-nhận). */}
            {dayDu && (
              <p className="flex items-center gap-1.5 rounded-lg border border-success/40 bg-success/10 px-2.5 py-1.5 text-[12px] font-semibold text-success">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Sẵn sàng ghi{ptBat(cfgPt, 'ghibill') ? ' — bấm Enter ' + (ptSoLan(cfgPt, 'ghibill') > 1 ? ptSoLan(cfgPt, 'ghibill') + ' lần' : '') + ' để ghi bill' : ''}
              </p>
            )}
            {/* [25/11 — Admin Demo "ấn 2 enter là ok rồi, ko cần xác nhận"] BỎ nhắc "Bấm Enter lần nữa": vẫn giữ cơ
                chế 2 Enter chống lỡ tay, nhưng KHÔNG hiện bước xác nhận trung gian — 2 Enter nhanh là ghi luôn. */}
            {/* [B207 19/11 — Admin Demo "đẩy cả khối bên dưới bao gồm ghi nhận bill và xóa lên cao"] TRƯỚC:
                `mt-auto` ĐẨY hàng nút xuống ĐÁY cột, nên ở màn cao 768px nút "Ghi nhận bill" nằm ở y=782 —
                NGOÀI màn, phải cuộn mới bấm được. Nay nút bám ngay dưới ô cảnh báo, luôn trong tầm mắt. */}
            <div className="mt-2 flex justify-end gap-2">
              <Button
                variant="confirm"
                data-nut="ghibill"
                onClick={ghiNhan}
                onKeyDown={ptEnterGhiBill}
                // [B258 23/11 — Admin Demo "chặn thêm phải show rõ lý do và hướng dẫn fix"] TRƯỚC ĐÂY nút
                // bị KHOÁ CÂM khi form thiếu thứ gì: bấm không ra gì, người nhập đứng hình không biết
                // thiếu cái nào. Nay chỉ khoá lúc ĐANG GHI; thiếu gì thì bấm vào là NÓI RÕ thiếu gì.
                disabled={busy}
                icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              >
                Ghi nhận bill
              </Button>
              <Button variant="danger" data-nut="xoaform" onClick={xoaForm} icon={<Eraser className="h-4 w-4" />}>
                Xóa
              </Button>
            </div>
            <p className="text-center text-[11px] text-slate-400">Người nhập: {user.fullName}</p>
          </div>
        </div>
        </Modal>
      )}

      {/* BIỂU ĐỒ TĂNG TRƯỞNG DOANH SỐ (Admin Demo 6/11) — cột theo NGÀY hoặc THÁNG, rê chuột hiện
          doanh thu + số hóa đơn. Vẽ bằng SVG thuần: không kéo thêm thư viện vào gói cài. */}
      {moBieuDo && (
        <Modal title="KPI Doanh số — tăng trưởng theo kỳ" width="max-w-[98vw]" bodyMaxH="max-h-[86vh]" onClose={() => setMoBieuDo(false)}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Button variant={mocBieuDo === 'ngay' ? 'confirm' : 'soft'} size="sm" onClick={() => setMocBieuDo('ngay')}>Theo ngày</Button>
            <Button variant={mocBieuDo === 'thang' ? 'confirm' : 'soft'} size="sm" onClick={() => setMocBieuDo('thang')}>Theo tháng</Button>
            <span className="text-xs text-slate-400">Đồ thị chạy theo ĐÚNG bộ lọc + kỳ đang chọn</span>
            <div className="flex-1" />
            <Button variant="soft" size="sm" onClick={() => { setFTu(''); setFDen(''); }}>Xem toàn bộ kỳ</Button>
          </div>
          <BieuDoCot duLieu={duLieuBieuDo} />
          <p className="mt-1.5 text-[11px] text-slate-400">
            Cột xanh = doanh số (tiền trước phí, đã trừ hủy) · chấm đỏ dưới chân = số hóa đơn trong mốc đó.
          </p>
        </Modal>
      )}

      {/* ── TAB KPI DOANH SỐ (full-view, Admin Demo 24/11) — ĐỘC LẬP kỳ/ca với bộ lọc màn Doanh Số. ──── */}
      {moKpi && (
        <Modal title="KPI Doanh Số" width="max-w-[98vw]" bodyMaxH="max-h-[90vh]" onClose={() => setMoKpi(false)}>
          {/* Thanh chọn kỳ (độc lập) + ca */}
          <div className="flex flex-wrap items-end gap-3 border-b border-line pb-3" data-kiem="kpi-thanh-loc">
            <label className="flex flex-col text-[11px] font-medium text-slate-500">
              Từ ngày
              <input type="date" value={kpiTu} max={kpiDen} onChange={(e) => setKpiTu(e.target.value)}
                className="mt-0.5 rounded-md border border-line px-2 py-1 text-sm text-slate-800" />
            </label>
            <label className="flex flex-col text-[11px] font-medium text-slate-500">
              Đến ngày
              <input type="date" value={kpiDen} min={kpiTu} max={homNayHCM} onChange={(e) => setKpiDen(e.target.value)}
                className="mt-0.5 rounded-md border border-line px-2 py-1 text-sm text-slate-800" />
            </label>
            <div className="flex items-center gap-1.5">
              <Button variant="soft" size="sm" onClick={() => datKyKpi(homNayHCM, homNayHCM)}>Hôm nay</Button>
              <Button variant="soft" size="sm" onClick={() => datKyKpi(kpiNgayLui(6), homNayHCM)}>7 ngày</Button>
              <Button variant="soft" size="sm" onClick={() => datKyKpi(dauThangHCM, homNayHCM)}>Tháng này</Button>
              <Button variant="soft" size="sm" onClick={() => { const [a, b] = kpiKyThangTruoc(); datKyKpi(a, b); }}>Tháng trước</Button>
            </div>
            <div className="ml-1 flex items-center gap-1 border-l border-line pl-3">
              <span className="text-[11px] font-medium text-slate-500">Ca:</span>
              {[null, 1, 2, 3].map((c) => (
                <Button key={c ?? 'all'} variant={kpiCa === c ? 'confirm' : 'soft'} size="sm" onClick={() => setKpiCa(c)}>
                  {c == null ? 'Mọi ca' : 'Ca ' + c}
                </Button>
              ))}
            </div>
            <div className="flex-1" />
            {kpiData && (
              <span className="text-[11px] text-slate-400">
                Kỳ {ngayNgan(kpiData.from)} → {ngayNgan(kpiData.to)} · {kpiData.soNgayKy} ngày · {kpiData.soBill} bill
              </span>
            )}
          </div>

          {kpiLoading && <p className="py-12 text-center text-sm text-slate-400">Đang tải KPI…</p>}
          {kpiErr && !kpiLoading && (
            <p className="my-4 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
              Không tải được KPI: {kpiErr}
            </p>
          )}

          {kpiData && !kpiLoading && (
            <>
              {/* [24/11 — Admin Demo "tách sang 1 tab riêng để khỏi cuộn"] 2 TAB: Biểu đồ | Bảng đại lý.
                  Mỗi tab render RIÊNG nên không cuộn chung tab kia. */}
              <div className="mt-3 flex gap-1 border-b border-line" data-kiem="kpi-tab">
                <button type="button" onClick={() => setKpiTab('bieudo')}
                  className={'-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition ' + (kpiTab === 'bieudo' ? 'border-brand text-brand-deep' : 'border-transparent text-slate-500 hover:text-slate-700')}>
                  Biểu đồ
                </button>
                <button type="button" onClick={() => setKpiTab('bangdaily')}
                  className={'-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition ' + (kpiTab === 'bangdaily' ? 'border-brand text-brand-deep' : 'border-transparent text-slate-500 hover:text-slate-700')}>
                  Bảng đại lý
                </button>
              </div>

              {kpiTab === 'bieudo' && (
              <div data-kiem="kpi-tab-bieudo">
              {/* Thẻ tổng */}
              <div className="my-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4" data-kiem="kpi-the-tong">
                <div className="rounded-lg border border-line bg-white px-3 py-2">
                  <div className="text-[11px] text-slate-500">Tổng doanh số (quẹt)</div>
                  <div className="text-lg font-bold tabular-nums text-brand">{money(kpiData.tongDoanhSo).replace('đ', '')}</div>
                </div>
                <div className="rounded-lg border border-line bg-white px-3 py-2">
                  <div className="text-[11px] text-slate-500">Lãi kỳ (chênh sau bán)</div>
                  <div className="text-lg font-bold tabular-nums text-brand-deep">{money(kpiData.tongLai).replace('đ', '')}</div>
                  {kpiData.soBillChuaKhaiLai > 0 && (
                    <div className="text-[10px] text-amber-600" title="Bill thiếu % phí — chưa cộng vào lãi (không cộng 0 câm)">
                      {kpiData.soBillChuaKhaiLai} bill chưa đủ % phí
                    </div>
                  )}
                </div>
                <div className="rounded-lg border border-line bg-white px-3 py-2">
                  <div className="text-[11px] text-slate-500">Số ngày kỳ</div>
                  <div className="text-lg font-bold tabular-nums text-slate-700">{kpiData.soNgayKy}</div>
                  <div className="text-[10px] text-slate-400">quy đổi tháng × {kpiData.heSoQuyDoiThang.toFixed(2).replace('.', ',')}</div>
                </div>
                <div className="rounded-lg border border-line bg-white px-3 py-2">
                  <div className="text-[11px] text-slate-500">Số đại lý · POS</div>
                  <div className="text-lg font-bold tabular-nums text-slate-700">
                    {kpiData.theoDaiLy.filter((d) => d.daiLyId != null).length}
                    <span className="text-sm font-normal text-slate-400"> · {kpiData.theoDaiLy.reduce((s, d) => s + d.posCam, 0)} POS</span>
                  </div>
                </div>
              </div>

              {/* Biểu đồ cột nhiều ngày */}
              <BieuDoKpi duLieu={kpiData.theoNgay} />
              <p className="mb-3 mt-1.5 text-[11px] text-slate-400">
                Mỗi cột = 1 ngày có bill trong khoảng chọn · cao = doanh số quẹt (trước phí, đã trừ hủy). Rê chuột xem chi tiết.
              </p>
              </div>
              )}

              {kpiTab === 'bangdaily' && (
              <div data-kiem="kpi-tab-bangdaily" className="mt-3">
              {/* Bảng KPI từng đại lý — BẢNG CHUẨN (zebra mỗi dòng 1 màu + kẻ cột + hàng TỔNG nổi bật) */}
              <div className="overflow-x-auto rounded-lg border border-line" data-kiem="kpi-bang-dai-ly">
                <table className="min-w-full text-sm">
                  <thead className={theadChuan}>
                    <tr>
                      <th className={thChuan}>Đại lý</th>
                      <th className={thChuan}>Doanh số</th>
                      <th className={thChuan}>Lãi kỳ</th>
                      <th className={thChuan} title="Số POS (TID đang hoạt động) đại lý đang cầm">POS cầm</th>
                      <th className={thChuan} title="POS 0 bill trong kỳ">Không chạy</th>
                      <th className={thChuan} title="POS quy đổi < 5 tỉ/tháng">Thấp &lt;5t/th</th>
                      <th className={thChuan} title="POS quy đổi ≥ 13 tỉ/tháng">Đạt hạn mức ≥13t/th</th>
                      <th className={thChuan} />
                    </tr>
                  </thead>
                  <tbody>
                    {kpiData.theoDaiLy.map((d, i) => {
                      const key = d.daiLyId ?? -1;
                      const mo = kpiDaiLyMo === key;
                      return (
                        <Fragment key={key}>
                          <tr className={trChuan(i)}>
                            <td className={tdChuan + ' font-medium text-slate-800'}>
                              {d.daiLyId == null ? <span className="text-slate-400 italic">{d.ten}</span> : d.ten}
                            </td>
                            <td className={tdTien}>{money(d.doanhSo).replace('đ', '')}</td>
                            <td className={tdTien}>
                              {money(d.lai).replace('đ', '')}
                              {d.soBillChuaKhaiLai > 0 && (
                                <span className="ml-1 text-[10px] text-amber-600" title={d.soBillChuaKhaiLai + ' bill chưa đủ % phí'}>*</span>
                              )}
                            </td>
                            <td className={tdChuan + ' text-center tabular-nums font-semibold text-slate-700'}>{d.posCam}</td>
                            <td className={tdChuan + ' text-center tabular-nums'}>
                              {d.posKhongChay > 0 ? <span className="rounded bg-slate-200 px-1.5 py-0.5 font-semibold text-slate-600">{d.posKhongChay}</span> : <span className="text-slate-300">0</span>}
                            </td>
                            <td className={tdChuan + ' text-center tabular-nums'}>
                              {d.posThap > 0 ? <span className="rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-700">{d.posThap}</span> : <span className="text-slate-300">0</span>}
                            </td>
                            <td className={tdChuan + ' text-center tabular-nums'}>
                              {d.posDatHanMuc > 0 ? <span className="rounded bg-orange-100 px-1.5 py-0.5 font-semibold text-orange-700">{d.posDatHanMuc}</span> : <span className="text-slate-300">0</span>}
                            </td>
                            <td className={tdChuan + ' text-center'}>
                              {d.chiTietPos.length > 0 && (
                                <button type="button" className="text-xs text-brand hover:underline" onClick={() => setKpiDaiLyMo(mo ? 'none' : key)}>
                                  {mo ? 'Ẩn' : 'POS'}
                                </button>
                              )}
                            </td>
                          </tr>
                          {mo && (
                            <tr className="border-t border-line bg-brand/[0.06]">
                              <td colSpan={8} className="px-3 py-2">
                                <div className="flex flex-wrap gap-1.5">
                                  {d.chiTietPos.map((p) => {
                                    const mau =
                                      p.phanLoai === 'khong_chay' ? 'bg-slate-200 text-slate-600'
                                        : p.phanLoai === 'thap' ? 'bg-amber-100 text-amber-700'
                                          : p.phanLoai === 'dat_han_muc' ? 'bg-orange-100 text-orange-700'
                                            : p.phanLoai === 'da_thu_hoi' ? 'bg-rose-100 text-rose-700 line-through decoration-rose-400'
                                              : p.phanLoai === 'moi_giao' ? 'bg-sky-100 text-sky-700'
                                                : 'bg-emerald-50 text-emerald-700';
                                    const nhan =
                                      p.phanLoai === 'khong_chay' ? 'không chạy'
                                        : p.phanLoai === 'thap' ? 'thấp'
                                          : p.phanLoai === 'dat_han_muc' ? 'đạt hạn mức'
                                            : p.phanLoai === 'da_thu_hoi' ? 'đã thu hồi'
                                              : p.phanLoai === 'moi_giao' ? 'mới giao' : 'bình thường';
                                    return (
                                      <span key={p.tid} className={'rounded-md px-2 py-1 text-[11px] ' + mau}
                                        title={`Kỳ: ${money(p.doanhSoKy)} · quy đổi/tháng: ${money(p.doanhSoThang)} · ${p.soBill} bill`}>
                                        <b className="tabular-nums">{p.tid}</b> · {tyGon(p.doanhSoKy)} · <i>{nhan}</i>
                                      </span>
                                    );
                                  })}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    {kpiData.theoDaiLy.length === 0 && (
                      <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">Không có đại lý nào trong kỳ.</td></tr>
                    )}
                  </tbody>
                  {kpiData.theoDaiLy.length > 0 && (
                    <tfoot className={tfootChuan}>
                      <tr className={trTongChuan}>
                        <td className={tdTongChuan + ' font-bold text-slate-800'}>TỔNG</td>
                        <td className={tdTongChuan + ' text-right tabular-nums font-bold text-brand'}>{money(kpiData.tongDoanhSo).replace('đ', '')}</td>
                        <td className={tdTongChuan + ' text-right tabular-nums font-bold text-brand-deep'}>{money(kpiData.tongLai).replace('đ', '')}</td>
                        <td className={tdTongChuan + ' text-center tabular-nums font-bold'}>{kpiData.theoDaiLy.reduce((s, d) => s + d.posCam, 0)}</td>
                        <td className={tdTongChuan + ' text-center tabular-nums font-bold'}>{kpiData.theoDaiLy.reduce((s, d) => s + d.posKhongChay, 0)}</td>
                        <td className={tdTongChuan + ' text-center tabular-nums font-bold'}>{kpiData.theoDaiLy.reduce((s, d) => s + d.posThap, 0)}</td>
                        <td className={tdTongChuan + ' text-center tabular-nums font-bold'}>{kpiData.theoDaiLy.reduce((s, d) => s + d.posDatHanMuc, 0)}</td>
                        <td className={tdTongChuan} />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                Ngưỡng CHUNG mọi ngân hàng (Admin Demo): POS <b>&lt; 5 tỉ/tháng = thấp</b>, <b>≥ 13 tỉ/tháng = đạt hạn mức</b>.
                Khi kỳ ≠ 1 tháng, ngưỡng so trên doanh số <b>quy đổi/tháng</b> = doanh số trong kỳ ÷ số ngày kỳ × 30
                (bung "POS" để xem cả số thật lẫn số quy đổi). "Không chạy" = POS đang cầm nhưng 0 bill trong kỳ;
                "mới giao" = POS giao trong kỳ (chạy ít là bình thường, không tính thấp); "đã thu hồi" = TID đã thu hồi/đóng nhưng còn doanh số trong kỳ.
                <b> Lưu ý:</b> lô MƯỢN TID tính doanh số theo <b>chủ máy</b> (khác bảng Doanh Số tính theo người mượn) — tổng toàn kỳ vẫn khớp.
                KPI gom theo <b>chủ máy</b> (lô mượn tính về chủ máy) — tổng vẫn khớp bảng Doanh Số. Dấu <b>*</b> = bill chưa đủ % phí, chưa tính lãi.
              </p>
              </div>
              )}
            </>
          )}
        </Modal>
      )}

      {/* BÁO CÁO MÁY CHẠY / KHÔNG CHẠY THEO KỲ (Admin Demo 6/11) — bảng nổi trên danh sách. */}
      {moBaoCao && (
        <Modal title={'Máy chạy / không chạy — kỳ ' + nhanKy} width="max-w-[98vw]" bodyMaxH="max-h-[90vh]" onClose={() => setMoBaoCao(false)}>
          <div className="flex flex-wrap items-center gap-2 pb-2">
            <Button variant="soft" size="sm" onClick={() => chonKy('homnay')}>Hôm nay</Button>
            <Button variant="soft" size="sm" onClick={() => chonKy('tuan')}>Tuần này</Button>
            <Button variant="soft" size="sm" onClick={() => chonKy('thang')}>Tháng này</Button>
            <span className="text-xs text-slate-400">Đổi kỳ là bảng dưới đổi theo</span>
            <div className="flex-1" />
            <Button variant="soft" size="sm" data-nut="excel" onClick={xuatExcelMay} icon={<FileSpreadsheet className="h-3.5 w-3.5" />}>
              Xuất Excel
            </Button>
            <Button
              variant="soft"
              size="sm"
              onClick={() => setSapXep(sapXep === 'cao' ? 'thap' : 'cao')}
              icon={sapXep === 'cao' ? <ArrowDownWideNarrow className="h-3.5 w-3.5" /> : <ArrowUpNarrowWide className="h-3.5 w-3.5" />}
            >
              {sapXep === 'cao' ? 'Doanh số: cao → thấp' : 'Doanh số: thấp → cao'}
            </Button>
          </div>

          {/* [B259 23/11 — Admin Demo "thêm full trường lọc ... của cả 2 blog ... như brand của alpha"]
              Ô lọc BRAND (cùng component với thanh lọc Doanh Số), áp CHO CẢ HAI bảng cùng lúc. */}
          <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-appbg px-2 py-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Lọc cả 2 bảng:</span>
            <MultiSelect khoa="may-bank" nhan="Ngân hàng" coChuNho rong="w-[150px]"
              value={fMayBank} options={mucMay((x) => x.bank)} onChange={setFMayBank}
              khiRong="Kỳ này chưa có máy nào." />
            <MultiSelect khoa="may-tid" nhan="TID" coChuNho rong="w-[150px]"
              value={fMayTid} options={mucMay((x) => x.tid)} onChange={setFMayTid}
              khiRong="Kỳ này chưa có máy nào." />
            <MultiSelect khoa="may-hkd" nhan="HKD" coChuNho rong="w-[190px]"
              value={fMayHkd} options={mucMay((x) => x.hkd)} onChange={setFMayHkd}
              khiRong="Kỳ này chưa có máy nào." />
            <MultiSelect khoa="may-daily" nhan="Đại lý cầm" coChuNho rong="w-[170px]"
              value={fMayDaiLy} options={mucMay((x) => x.daiLy)} onChange={setFMayDaiLy}
              khiRong="Kỳ này chưa có máy nào." />
            <MultiSelect khoa="may-ndt" nhan="NĐT" coChuNho rong="w-[170px]"
              value={fMayNdt} options={mucMay((x) => x.ndt)} onChange={setFMayNdt}
              khiRong="Kỳ này chưa có máy nào." />
            <Button
              variant="soft"
              size="sm"
              data-nut="may-xoaloc"
              onClick={() => { setFMayTid([]); setFMayHkd([]); setFMayBank([]); setFMayDaiLy([]); setFMayNdt([]); }}
            >
              Xóa lọc
            </Button>
            <span className="ml-auto text-[11px] text-slate-500">
              đang xem {tidKhongChay.length + tidCoChay.length}/{bangTid.length} máy
            </span>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            {/* MÁY KHÔNG CHẠY */}
            <section className="rounded-lg border border-danger/30">
              <div className="flex items-center gap-2 rounded-t-lg bg-red-50 px-3 py-1.5">
                <span className="text-xs font-bold uppercase tracking-wide text-danger">Không phát sinh giao dịch</span>
                <span className="rounded-full bg-danger px-2 py-0.5 text-[11px] font-bold text-white">{tidKhongChay.length}</span>
                {soTidChuaGiao > 0 && (
                  <span className="ml-1 text-[11px] font-normal text-slate-500">(+{soTidChuaGiao} TID mới chưa giao khách, chưa tính vào bảng)</span>
                )}
              </div>
              <div className="max-h-[70vh] overflow-auto">
                {/* [24/11 — Admin Demo "kẻ cột đâu"] BẢNG CHUẨN: tdChuan kẻ cột + nenDong zebra mỗi dòng 1 màu. */}
                <table className="w-full text-xs">
                  <thead className={theadChuan}>
                    {/* [B259c 23/11 — Admin Demo "đảo vị trí HKD LÊN TRƯỚC ĐẾN TID, NGÂN HÀNG, ĐẠI LÝ"] */}
                    <tr>
                      <th className={thChuan}>HKD</th>
                      <th className={thChuan}>TID</th>
                      <th className={thChuan}>NH</th>
                      <th className={thChuan}>Đại lý cầm</th>
                      <th className={thChuan}>NĐT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tidKhongChay.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-2 py-4 text-center text-slate-400">Mọi máy đều có giao dịch trong kỳ.</td>
                      </tr>
                    )}
                    {tidKhongChay.map((x, i) => (
                      <tr key={x.tid} className={trChuan(i)}>
                        <td className={tdChuan + ' max-w-[190px] truncate text-slate-600'} title={x.hkd}>{x.hkd}</td>
                        <td className={tdChuan + ' text-center font-medium text-slate-700'}>{x.tid}</td>
                        <td className={tdChuan + ' text-center text-slate-600'}>{x.bank}</td>
                        <td className={tdChuan + ' text-center font-medium text-brand'}>{x.daiLy}</td>
                        <td className={tdChuan + ' text-center text-slate-600'}>{x.ndt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* MÁY CÓ CHẠY — xếp theo doanh số */}
            <section className="rounded-lg border border-brand/30">
              <div className="flex items-center gap-2 rounded-t-lg bg-brand-tint px-3 py-1.5">
                <span className="text-xs font-bold uppercase tracking-wide text-brand-deep">Có phát sinh — theo doanh số</span>
                <span className="rounded-full bg-brand px-2 py-0.5 text-[11px] font-bold text-white">{tidCoChay.length}</span>
              </div>
              <div className="max-h-[70vh] overflow-auto">
                {/* [24/11 — Admin Demo "kẻ cột đâu"] BẢNG CHUẨN: tdChuan kẻ cột + nenDong zebra + hàng TỔNG nổi bật. */}
                <table className="w-full text-xs">
                  <thead className={theadChuan}>
                    {/* [B259b 23/11 — Admin Demo "Có phát sinh — theo doanh số phải có TID, tên HKD"] */}
                    <tr>
                      <th className={thChuan}>HKD</th>
                      <th className={thChuan}>TID</th>
                      <th className={thChuan}>NH</th>
                      <th className={thChuan}>Đại lý cầm</th>
                      <th className={thChuan}>NĐT</th>
                      <th className={thChuan}>Bill</th>
                      <th className={thChuan}>Doanh số</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tidCoChay.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-2 py-4 text-center text-slate-400">Kỳ này chưa có máy nào phát sinh.</td>
                      </tr>
                    )}
                    {tidCoChay.map((x, i) => (
                      <tr key={x.tid} className={trChuan(i)}>
                        <td className={tdChuan + ' max-w-[190px] truncate text-slate-600'} title={x.hkd}>{x.hkd}</td>
                        <td className={tdChuan + ' text-center font-medium text-slate-700'}>{x.tid}</td>
                        <td className={tdChuan + ' text-center text-slate-600'}>{x.bank}</td>
                        <td className={tdChuan + ' max-w-[130px] truncate text-center font-medium text-brand'} title={x.daiLy}>{x.daiLy}</td>
                        <td className={tdChuan + ' text-center text-slate-600'}>{x.ndt}</td>
                        <td className={tdChuan + ' text-center tabular-nums text-slate-600'}>{x.soBill}</td>
                        <td className={tdChuan + ' text-right font-semibold tabular-nums text-slate-800'}>{money(x.tien).replace('đ', '')}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className={tfootChuan}>
                    <tr className={trTongChuan}>
                      <td className={tdTongChuan + ' font-bold text-brand-deep'} colSpan={6}>TỔNG {tidCoChay.length} máy</td>
                      <td className={tdTongChuan + ' text-right font-bold tabular-nums text-brand'}>
                        {money(tidCoChay.reduce((t, x) => t + x.tien, 0)).replace('đ', '')}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            "Không phát sinh" = máy đang hoạt động nhưng KHÔNG có bill nào trong kỳ đang chọn. Đổi kỳ ở trên hoặc ở ô từ-đến ngoài danh sách.
          </p>
        </Modal>
      )}

      {/* Đã THU NHỎ bảng nhập — dữ liệu đang gõ vẫn giữ nguyên, bấm để mở lại (Admin Demo 6/11). */}
      {cheDo === 'nhap' && thuNho && (
        <div className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-lg border border-brand/40 bg-white px-3 py-2 shadow-xl">
          <span className="text-xs text-slate-600">
            Đang nhập bill{tid ? ' · máy ' + tid.tid : ''}
            {soLo ? ' · lô ' + soLo : ''}
          </span>
          <Button variant="confirm" size="sm" onClick={() => setThuNho(false)} icon={<Maximize2 className="h-3.5 w-3.5" />}>
            Mở lại
          </Button>
          <Button variant="soft" size="sm" onClick={() => { setThuNho(false); setCheDo('danhsach'); }}>
            Bỏ
          </Button>
        </div>
      )}

      {hoiXoa && (
        <ConfirmDialog
          title={'Xóa ' + tichHopLe.length + ' bill?'}
          message={
            'Bill là chứng từ tiền — xóa phải nhập mật khẩu và sẽ ghi vết người thực hiện. SẼ XÓA ĐÚNG ' +
            tichHopLe.length +
            ' bill: ' +
            billSapXoa
              .slice(0, 10)
              .map((b) => b.tid + '/lô ' + (b.lo || '—') + '/HĐ ' + (b.soHoaDon || '—') + '/' + ngayNgan(b.ngay) + ' ' + b.gio + '/' + money(b.tienLo))
              .join('  ·  ') +
            (billSapXoa.length > 10 ? '  ·  … và ' + (billSapXoa.length - 10) + ' bill nữa' : '') +
            (vuotNguong
              ? ' — CẢNH BÁO: hôm nay đã sửa/xóa ' +
                daSuaXoaHomNay +
                ' bill, cộng ' +
                tichHopLe.length +
                ' bill này là ' +
                (daSuaXoaHomNay + tichHopLe.length) +
                ', vượt ngưỡng ' +
                NGUONG_BILL_NGAY +
                '/ngày.'
              : '')
          }
          confirmLabel="Xóa bill"
          danger
          requirePassword
          onCancel={() => setHoiXoa(false)}
          onConfirm={(mk) => xoaDaTich(mk)}
        />
      )}

      {/* Hỏi lại khi đóng mà form còn dữ liệu (Admin Demo 6/11 "tránh thoát nhầm mất công"). */}
      {hoiDong && (
        <Modal title="Đóng phần nhập bill?" width="max-w-sm" onClose={() => setHoiDong(false)}>
          <p className="text-sm text-slate-600">
            Bill đang nhập dở{tid ? ' cho máy ' + tid.tid : ''}
            {soLo ? ', lô ' + soLo : ''} sẽ <b className="text-danger">mất hết</b> nếu đóng. Muốn giữ lại thì bấm
            “Thu nhỏ” để xem danh sách rồi quay lại nhập tiếp.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="soft" onClick={() => setHoiDong(false)}>Quay lại nhập</Button>
            <Button
              variant="soft"
              onClick={() => {
                setHoiDong(false);
                setThuNho(true);
              }}
              icon={<Minus className="h-4 w-4" />}
            >
              Thu nhỏ
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setHoiDong(false);
                setThuNho(false);
                setCheDo('danhsach');
                xoaForm();
              }}
            >
              Đóng, bỏ dữ liệu
            </Button>
          </div>
        </Modal>
      )}

      {/* [B236 22/11] BẢNG LÃI NĐT & SIGMA THU VỀ — tách theo NĐT → ngân hàng → TID. */}
      {moBaoCaoNdt && (
        <Modal title={'Lãi NĐT & SigMa thu về — ' + nhanKy} width="max-w-5xl" onClose={() => setMoBaoCaoNdt(false)}>
          <div className="mb-3 rounded-lg bg-brand-tint px-3 py-2 text-[13px] leading-snug text-slate-600">
            <b>Lãi NĐT</b> = (phí mua NĐT − phí cài máy) × doanh số &nbsp;·&nbsp;
            <b>SigMa bán</b> = (phí bán khách − phí mua NĐT) × doanh số &nbsp;·&nbsp;
            <b>SigMa đối tác</b> = (phí mua đối tác − phí cài máy) × doanh số
            {tongBaoCaoNdt.chuaKhai > 0 && (
              <div className="mt-1 font-medium text-danger">
                {tongBaoCaoNdt.chuaKhai} bill CHƯA khai phí mua NĐT cho máy — lãi NĐT của các bill đó để TRỐNG,
                app không bịa số. Vào màn TID → Phí bán thực tế → cột “Phí mua NĐT” để khai.
              </div>
            )}
          </div>
          <div className="max-h-[60vh] overflow-auto rounded-lg border border-line">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 z-10">
                <tr>
                  {['NĐT', 'Ngân hàng', 'TID', 'Số bill', 'Doanh số', 'Sau phí bán', 'Lãi NĐT', 'SigMa bán', 'SigMa đối tác', 'SigMa tổng'].map((h) => (
                    <th key={h} className={thChuan}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {baoCaoNdt.map((x, i) => (
                  <tr key={x.ndt + x.bank + x.tid} className={'border-t border-line ' + (i % 2 === 1 ? 'bg-brand-tint' : 'bg-white')}>
                    <td className={tdChuan + ' text-slate-700'}>{x.ndt}</td>
                    <td className={tdChuan + ' text-center text-slate-600'}>{x.bank}</td>
                    <td className={tdChuan + ' text-center font-medium text-slate-700'}>{x.tid}</td>
                    <td className={tdChuan + ' text-center tabular-nums text-slate-600'}>{x.soBill}</td>
                    <td className={tdChuan + ' text-right tabular-nums text-slate-800'}>{money(x.doanhSo).replace('đ', '')}</td>
                    <td className={tdChuan + ' text-right tabular-nums text-slate-600'}>{money(x.sauPhi).replace('đ', '')}</td>
                    <td className={tdChuan + ' text-right tabular-nums font-semibold text-success'}>
                      {x.chuaKhai === x.soBill ? <span className="text-slate-300">chưa khai</span> : money(x.lai).replace('đ', '')}
                    </td>
                    <td className={tdChuan + ' text-right tabular-nums text-brand'}>
                      {x.chuaKhai === x.soBill ? <span className="text-slate-300">—</span> : money(x.alphaBan).replace('đ', '')}
                    </td>
                    <td className={tdChuan + ' text-right tabular-nums text-brand'}>{money(x.alphaDoiTac).replace('đ', '')}</td>
                    <td className={tdChuan + ' text-right tabular-nums font-semibold text-brand-deep'}>
                      {money(x.alphaBan + x.alphaDoiTac).replace('đ', '')}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 z-10">
                <tr className="border-t-2 border-brand">
                  <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={3}>TỔNG {baoCaoNdt.length} máy</td>
                  <td className={tdTongChuan + ' text-center font-bold tabular-nums'}>{tongBaoCaoNdt.soBill}</td>
                  <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{money(tongBaoCaoNdt.doanhSo).replace('đ', '')}</td>
                  <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-600'}>{money(tongBaoCaoNdt.sauPhi).replace('đ', '')}</td>
                  <td className={tdTongChuan + ' text-right font-bold tabular-nums text-success'}>{money(tongBaoCaoNdt.lai).replace('đ', '')}</td>
                  <td className={tdTongChuan + ' text-right font-bold tabular-nums text-brand'}>{money(tongBaoCaoNdt.alphaBan).replace('đ', '')}</td>
                  <td className={tdTongChuan + ' text-right font-bold tabular-nums text-brand'}>{money(tongBaoCaoNdt.alphaDoiTac).replace('đ', '')}</td>
                  <td className={tdTongChuan + ' text-right font-bold tabular-nums text-brand-deep'}>{money(tongBaoCaoNdt.alphaBan + tongBaoCaoNdt.alphaDoiTac).replace('đ', '')}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Modal>
      )}

      {/* [B228 22/11 — Admin Demo] HỘP TÍCH CHỌN TRƯỚC KHI XUẤT. Ba nút tích RIÊNG, không ràng buộc nhau:
          ẩn tên đại lý · ẩn tên người nhập · tách mỗi NĐT một sheet. */}
      {moTuyChonExcel && (
        <Modal title="Xuất Excel — chọn kiểu xuất" width="max-w-xl" onClose={() => setMoTuyChonExcel(false)}>
          {/* [B234 22/11 — Admin Demo "brand chọn tích xấu, làm bảng như brand button alpha đẹp"]
              Ô tích trần của trình duyệt nhìn lạc lõng giữa app. Dựng thành BẢNG chọn kiểu brand SigMa:
              mỗi dòng là một ô bấm cả hàng, có viền + nền brand khi bật, dấu tích vẽ bằng SVG. */}
          <div className="flex flex-col gap-3 py-1 text-sm">
            <p className="text-slate-600">
              Sẽ xuất <b>{danhSachXuat.length}</b>{danhSachXuat.length !== danhSachLoc.length ? '/' + danhSachLoc.length : ''} bill đang hiện ({nhanKy}).
            </p>
            {/* [B247 22/11 — Admin Demo "làm bảng rõ ràng các phần tích chọn theo brand"] Hộp này nay có
                HAI KHỐI tách bạch, mỗi khối có thanh tiêu đề brand: (1) kiểu xuất, (2) chọn nhà đầu tư. */}
            <div className="overflow-hidden rounded-xl border border-line">
              <div className="flex items-center justify-between bg-brand px-3 py-2 text-[13px] font-semibold text-white">
                <span>KIỂU XUẤT</span>
                <span className="text-[12px] font-normal text-white/85">tích vào dòng để bật</span>
              </div>
              {[
                { nut: 'ex-an-daily', bat: exAnDaiLy, dat: setExAnDaiLy, ten: 'Ẩn tên đại lý', phu: 'Bỏ hẳn cột "Đại lý" khỏi file' },
                { nut: 'ex-an-nguoinhap', bat: exAnNguoiNhap, dat: setExAnNguoiNhap, ten: 'Ẩn tên người nhập', phu: 'Bỏ hẳn cột "Người nhập" khỏi file' },
                { nut: 'ex-an-muadt', bat: exAnMuaDt, dat: setExAnMuaDt, ten: 'Ẩn % mua đối tác', phu: 'Bỏ hẳn cột "% Mua ĐT" (giá vốn) khỏi file' },
                { nut: 'ex-tach-sheet', bat: exTachSheetNdt, dat: setExTachSheetNdt, ten: 'Mỗi nhà đầu tư một file', phu: 'Chọn thư mục một lần, app ghi hết các file vào đó' }
              ].map((m, i) => (
                <label
                  key={m.nut}
                  data-nut={m.nut}
                  className={
                    'flex cursor-pointer items-center gap-3 px-3 py-2.5 transition border-t border-line ' +
                    (i > 0 ? '' : '') +
                    (m.bat ? 'bg-brand-tint' : 'bg-white hover:bg-brand/10')
                  }
                >
                  <input type="checkbox" className="sr-only" checked={m.bat} onChange={(e) => m.dat(e.target.checked)} />
                  <span
                    className={
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition ' +
                      (m.bat ? 'border-brand bg-brand text-white' : 'border-slate-300 bg-white')
                    }
                  >
                    {m.bat && (
                      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={3}>
                        <path d="M4 10l4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="flex-1">
                    <span className={'block font-medium ' + (m.bat ? 'text-brand-deep' : 'text-slate-700')}>{m.ten}</span>
                    <span className="block text-[12px] text-slate-500">{m.phu}</span>
                  </span>
                </label>
              ))}
            </div>
            {/* KHỐI 2 — CHỌN NHÀ ĐẦU TƯ. Không tích gì = xuất HẾT (ghi rõ ngay trên thanh tiêu đề để
                không ai phải đoán). Mỗi dòng ghi kèm SỐ BILL để biết tích vào là lấy bao nhiêu. */}
            <div className="overflow-hidden rounded-xl border border-line">
              <div className="flex items-center justify-between bg-brand px-3 py-2 text-[13px] font-semibold text-white">
                <span>NHÀ ĐẦU TƯ ĐƯA VÀO FILE</span>
                <span className="text-[12px] font-normal text-white/85">
                  {exNdtChon.length === 0 ? 'chưa tích = xuất TẤT CẢ' : 'đang tích ' + exNdtChon.length + '/' + dsNdtXuat.length}
                </span>
              </div>
              <div className="flex items-center gap-3 border-t border-line bg-appbg px-3 py-1.5 text-[12px]">
                <button type="button" className="text-brand hover:underline" data-nut="ex-ndt-tatca"
                  onClick={() => setExNdtChon(dsNdtXuat.map((x) => x.ten))}>Chọn tất cả</button>
                <button type="button" className="text-danger hover:underline" data-nut="ex-ndt-bochon"
                  onClick={() => setExNdtChon([])}>Bỏ chọn (xuất hết)</button>
                <span className="ml-auto text-slate-500">{danhSachXuat.length} bill sẽ vào file</span>
              </div>
              <div className="max-h-56 overflow-auto">
                {dsNdtXuat.map((x) => {
                  const bat = exNdtChon.includes(x.ten);
                  return (
                    <label
                      key={x.ten}
                      data-nut={'ex-ndt'}
                      data-ndt={x.ten}
                      className={'flex cursor-pointer items-center gap-3 border-t border-line px-3 py-2 transition '
                        + (bat ? 'bg-brand-tint' : 'bg-white hover:bg-brand/10')}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={bat}
                        onChange={(e) => setExNdtChon((cu5) => (e.target.checked ? [...cu5, x.ten] : cu5.filter((t2) => t2 !== x.ten)))}
                      />
                      <span className={'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition '
                        + (bat ? 'border-brand bg-brand text-white' : 'border-slate-300 bg-white')}>
                        {bat && (
                          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={3}>
                            <path d="M4 10l4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      <span className={'flex-1 ' + (bat ? 'font-medium text-brand-deep' : 'text-slate-700')}>{x.ten}</span>
                      <span className="tabular-nums text-[12px] text-slate-500">{x.soBill} bill</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <p className="rounded-lg bg-brand-tint px-3 py-2 text-[13px] text-slate-600">
              {/* DÍNH CHỮ: viết <b>lãi NĐT</b> rồi xuống dòng là JSX bỏ luôn khoảng trắng ⇒ hiện ra
                  "lãi NĐTvà" (nhìn ảnh mới thấy, đo kích thước không bắt được). Giữ dấu cách tường minh. */}
              Mỗi file đều có thêm <b>dưới cùng</b>: tổng doanh số từng TID <b>theo ca</b>, khối{' '}
              <b>lãi NĐT</b> và tổng doanh số từng TID <b>theo ngày</b>.
            </p>
            <div className="mt-1 flex justify-end gap-2">
              <Button variant="soft" size="sm" onClick={() => setMoTuyChonExcel(false)}>Hủy</Button>
              <Button variant="confirm" size="sm" data-nut="ex-xuat" onClick={() => void xuatExcelThat()} icon={<FileSpreadsheet className="h-4 w-4" />}>
                Xuất Excel
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* POPUP XUẤT EXCEL (Admin Demo 6/11): báo thành công + đường dẫn đã lưu + mở file ngay. */}
      {ketQuaExcel && (
        <Modal title="Đã xuất Excel" width="max-w-md" onClose={() => setKetQuaExcel(null)}>
          <div className="flex flex-col items-center gap-2 py-1 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 text-success">
              <CheckCircle2 className="h-6 w-6" />
            </span>
            <p className="text-sm text-slate-600">
              Đã xuất <b className="text-slate-800">{ketQuaExcel.soBill}</b> bill ra file Excel
            </p>
            <code className="block w-full break-all rounded-lg bg-appbg px-2.5 py-1.5 text-[11px] text-slate-600">{ketQuaExcel.path}</code>
            <div className="mt-2 flex gap-2">
              <Button variant="soft" onClick={() => setKetQuaExcel(null)}>Đóng</Button>
              <Button variant="confirm" onClick={moFileExcel} icon={<FileSpreadsheet className="h-4 w-4" />}>Mở file</Button>
            </div>
          </div>
        </Modal>
      )}

      {/* POPUP BÁO THÀNH CÔNG (Admin Demo 6/11) — nói rõ bill nào, về nhà ai, bao nhiêu tiền. */}
      {ketQua && (
        <Modal title={ketQua.maLo != null ? 'Đã ghi vào sổ' : 'Bill mới — CHƯA ghi vào sổ'} width="max-w-md" onClose={() => setKetQua(null)}>
          <div className="flex flex-col items-center gap-2 py-1 text-center">
            <span className={'flex h-11 w-11 items-center justify-center rounded-full ' + (ketQua.maLo != null ? 'bg-emerald-50 text-success' : 'bg-amber-50 text-warning')}>
              <CheckCircle2 className="h-6 w-6" />
            </span>
            <p className="text-sm text-slate-600">
              Bill máy <b className="text-slate-800">{ketQua.tid}</b> lô <b className="text-slate-800">{ketQua.lo}</b>
            </p>
            <p className="text-sm text-slate-600">
              Về đại lý <b className="text-brand">{ketQua.daiLy}</b> · <b className="tabular-nums text-brand">{money(ketQua.nhanVe)}</b>
            </p>
            {ketQua.maLo != null ? (
              <p className="rounded-lg border border-success/40 bg-emerald-50 px-2.5 py-1.5 text-[11px] leading-snug text-emerald-800">
                <b>ĐÃ GHI VÀO SỔ — mã lô {ketQua.maLo}.</b> Máy chủ đã đọc lại từ cơ sở dữ liệu và số liệu khớp với
                màn hình. Bill đi CHUNG một đường với bill OCR nên không bị tính doanh số hai lần.
              </p>
            ) : (
              <p className="rounded-lg border border-warning/40 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-snug text-amber-800">
                <b>BẢN DỰNG THỬ — CHƯA ghi vào sổ.</b> Bill chỉ nằm trong phiên làm việc, tải lại trang là mất.
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <Button variant="soft" onClick={() => { setKetQua(null); setCheDo('nhap'); }}>Nhập bill tiếp</Button>
              <Button variant="confirm" onClick={() => setKetQua(null)}>Xong</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
    </>
  );
}
