// SIGMA (1/8) — test THUẦN cho phần TÍNH TOÁN bố cục bảng ảnh (computeBillTableLayout) + đặt tên file
// (buildBillFileName) trong bill-table-image.ts — KHÔNG test composeBillImage()/drawBillTableAt() (cần canvas
// thật/`document.fonts`/`createImageBitmap`, vitest environment 'node' KHÔNG có, CÙNG giới hạn
// context-menu-position.test.ts đã ghi ở đó cho phần DOM thật).
import { describe, expect, it } from 'vitest';
import { buildBillFileName, buildBillCaption, computeBillTableLayout, wrapTextLines, type BillTableRowInput } from './bill-table-image';
import type { OcrBillFieldValue } from './agent-api-client';

function field(value: string): OcrBillFieldValue {
  return { value, uncertain: false };
}

/** measureText GIẢ LẬP đơn giản (KHÔNG cần canvas thật) — mỗi ký tự rộng 8px, đủ để test bố cục co giãn theo
 * độ dài text, KHÔNG cần đúng pixel font thật (đó là việc của renderBillTableImage() lúc chạy trong trình
 * duyệt thật, không test được ở môi trường node này). */
function fakeMeasure(text: string): number {
  return text.length * 8;
}

// B121 (2/8, "Phương án B — Lưới ô vuông") — makeRows() giờ dựng đúng cấu trúc THẬT composeBillImage() tạo ra:
// 1 hero (Số tiền) + 1 full-width (Tên Pos/HKD) + 6 ô lưới 2 cột (Ngân hàng/TID/Ngày/Giờ/Số lô/Số hóa đơn).
function makeRows(): BillTableRowInput[] {
  return [
    { kind: 'hero', label: 'Số tiền', value: '140.000.000đ', color: 'amount' },
    { kind: 'full', label: 'Tên Pos (HKD)', value: 'HKD DEMOMAY 1', muted: false },
    { kind: 'grid', label: 'Ngân hàng', value: 'MB', muted: false },
    { kind: 'grid', label: 'TID', value: '50550759', muted: false },
    { kind: 'grid', label: 'Ngày', value: '21/11/2025', muted: false },
    { kind: 'grid', label: 'Giờ', value: '10:39:56', muted: false },
    { kind: 'grid', label: 'Số lô', value: '000189', muted: false },
    { kind: 'grid', label: 'Số hóa đơn', value: '001283', muted: true }
  ];
}

describe('computeBillTableLayout', () => {
  it('8 hàng đủ dữ liệu → rowHeights đúng số lượng, hero CAO hơn full/grid, full/grid CAO BẰNG NHAU', () => {
    const layout = computeBillTableLayout(makeRows(), fakeMeasure);
    expect(layout.rowHeights).toHaveLength(8);
    expect(layout.rowHeights[0]).toBeGreaterThan(layout.rowHeights[1]);
    const fullGridHeights = layout.rowHeights.slice(1);
    expect(new Set(fullGridHeights).size).toBe(1);
  });

  it('rowLefts/rowWidths: hero+full CHIẾM TRỌN bề rộng bảng, 6 ô grid xen kẽ TRÁI/PHẢI đúng nửa bảng mỗi ô', () => {
    const layout = computeBillTableLayout(makeRows(), fakeMeasure);
    const tableWidth = layout.canvasWidth - layout.tableLeft * 2;
    // rows[0]=hero, rows[1]=full — cả 2 rộng = TRỌN bảng, bắt đầu tại tableLeft.
    expect(layout.rowWidths[0]).toBe(tableWidth);
    expect(layout.rowWidths[1]).toBe(tableWidth);
    expect(layout.rowLefts[0]).toBe(layout.tableLeft);
    expect(layout.rowLefts[1]).toBe(layout.tableLeft);
    // rows[2..7] = 6 ô grid — xen kẽ trái/phải, mỗi ô rộng đúng 1/2 bảng.
    expect(layout.rowWidths[2]).toBe(layout.gridCellWidth);
    expect(layout.rowLefts[2]).toBe(layout.tableLeft); // ô grid ĐẦU TIÊN — cột trái
    expect(layout.rowLefts[3]).toBe(layout.tableLeft + layout.gridCellWidth); // ô grid THỨ 2 — cột phải
    expect(layout.rowLefts[4]).toBe(layout.tableLeft); // ô grid THỨ 3 — quay lại cột trái (hàng lưới mới)
  });

  it('rowTops: hero/full/hàng-lưới nối tiếp đúng theo chiều cao, 2 ô CÙNG 1 hàng lưới CÙNG rowTop', () => {
    const layout = computeBillTableLayout(makeRows(), fakeMeasure);
    expect(layout.rowTops[1]).toBe(layout.rowTops[0] + layout.rowHeights[0]); // full ngay sau hero
    expect(layout.rowTops[2]).toBe(layout.rowTops[1] + layout.rowHeights[1]); // hàng lưới ĐẦU ngay sau full
    expect(layout.rowTops[2]).toBe(layout.rowTops[3]); // 2 ô CÙNG hàng lưới (trái/phải) CÙNG rowTop
    expect(layout.rowTops[4]).toBe(layout.rowTops[2] + layout.gridCellHeight); // hàng lưới THỨ 2 nối tiếp đúng
  });

  it('gridCellWidth đủ rộng cho GIÁ TRỊ/NHÃN dài nhất trong 1 Ô GRID ĐƠN (không cắt chữ dù chỉ chiếm 1/2 bảng)', () => {
    const rows = makeRows();
    // B123 (2/8) — thêm biến thể `warning` (không có field `value`) vào union BillTableRowInput khiến spread
    // trực tiếp `rows[3]` (TS không tự narrow theo INDEX cụ thể) mơ hồ kiểu — ép kiểu rõ ràng về đúng biến thể
    // 'grid' đã biết chắc tại index này (makeRows() luôn trả rows[3] là ô grid "TID"), KHÔNG đổi hành vi test.
    rows[3] = { ...(rows[3] as Extract<BillTableRowInput, { kind: 'grid' }>), value: '99999999999999999999' }; // TID rất dài — vẫn chỉ 1 ô grid.
    const layout = computeBillTableLayout(rows, fakeMeasure);
    expect(layout.gridCellWidth).toBeGreaterThanOrEqual(fakeMeasure('99999999999999999999') + 14 * 2);
  });

  it('nội dung "full" (Tên Pos/HKD) RẤT DÀI → canvasWidth đủ rộng cho TRỌN 1 dòng (không cắt chữ)', () => {
    const longAgencyName = 'HKD DEMO 10 DICH VU TONG HOP RAT DAI DE KIEM TRA KHONG CAT CHU';
    const rows = makeRows();
    rows[1] = { ...(rows[1] as Extract<BillTableRowInput, { kind: 'full' }>), value: longAgencyName };
    const layout = computeBillTableLayout(rows, fakeMeasure);
    const tableWidth = layout.canvasWidth - layout.tableLeft * 2;
    expect(tableWidth).toBeGreaterThanOrEqual(fakeMeasure(longAgencyName) + 14 * 2 - 1);
  });

  it('dữ liệu NGẮN (giá trị/nhãn ít ký tự) → canvasWidth vẫn đạt mốc tối thiểu gợi ý ~500px (không ra ảnh nhỏ xíu)', () => {
    const rows: BillTableRowInput[] = [
      { kind: 'hero', label: 'A', value: '1', color: 'amount' },
      { kind: 'grid', label: 'B', value: '2', muted: false }
    ];
    const layout = computeBillTableLayout(rows, fakeMeasure);
    expect(layout.canvasWidth).toBeGreaterThanOrEqual(500);
  });

  it('canvasHeight khớp CHÍNH XÁC margin + tổng chiều cao (hero+full+3 hàng lưới, 6 ô grid = 3 hàng)', () => {
    const layout = computeBillTableLayout(makeRows(), fakeMeasure);
    const expectedHeight = layout.tableTop + layout.rowHeights[0] + layout.rowHeights[1] + layout.gridCellHeight * 3 + layout.tableTop;
    expect(layout.canvasHeight).toBe(expectedHeight);
  });

  it('số Ô GRID LẺ (hàng lưới cuối chỉ 1 ô) → VẪN tính đủ chiều cao cho hàng lưới cuối đó (không cắt cụt)', () => {
    const rows: BillTableRowInput[] = [
      { kind: 'hero', label: 'Số tiền', value: '1', color: 'amount' },
      { kind: 'grid', label: 'A', value: '1', muted: false },
      { kind: 'grid', label: 'B', value: '2', muted: false },
      { kind: 'grid', label: 'C', value: '3', muted: false } // ô LẺ — 1 mình 1 hàng, cột phải hàng đó bỏ trống.
    ];
    const layout = computeBillTableLayout(rows, fakeMeasure);
    const expectedHeight = layout.tableTop + layout.rowHeights[0] + layout.gridCellHeight * 2 + layout.tableTop;
    expect(layout.canvasHeight).toBe(expectedHeight);
    expect(layout.rowLefts[3]).toBe(layout.tableLeft); // ô lẻ vẫn nằm cột TRÁI hàng mới, không tràn lệch.
  });

  it('mảng rows rỗng → KHÔNG throw, trả kích thước tối thiểu hợp lệ (0 hàng, canvas vẫn dương)', () => {
    const layout = computeBillTableLayout([], fakeMeasure);
    expect(layout.rowHeights).toEqual([]);
    expect(layout.rowTops).toEqual([]);
    expect(layout.rowLefts).toEqual([]);
    expect(layout.rowWidths).toEqual([]);
    expect(layout.canvasWidth).toBeGreaterThan(0);
    expect(layout.canvasHeight).toBeGreaterThan(0);
  });
});

describe('buildBillFileName', () => {
  // B106 (2/8, Admin Demo xác nhận LẶP LẠI 3 lần khi test thật) — mẫu ĐỔI LẠI: BỎ tên ngân hàng, THÊM giờ. Chữ ký
  // hàm cũng bỏ hẳn tham số bankName (không còn dùng, tránh tham số chết gây hiểu lầm).
  it('đủ CẢ 4 field hợp lệ → tên "POS <TênHKD> - <TID> - Lô <SốLô> - <dd-mm-yyyy> <hh-mm-ss>.jpg" (fixture bill thật: HKD "HKD DEMOMAY 1")', () => {
    const name = buildBillFileName(field('HKD DEMOMAY 1'), field('50550759'), field('000189'), field('21/11/2025 10:39:56'), 1234567890);
    expect(name).toBe('POS DEMOMAY 1 - 50550759 - Lô 000189 - 21-11-2025 10-39-56.jpg');
  });

  it('ví dụ tường minh Admin Demo chốt 1/8 (giữ khoảng trắng trong tên HKD, đủ 4 chữ số năm thay vì rút gọn 2 số như minh hoạ)', () => {
    const name = buildBillFileName(field('HKD Thanh Toàn 2'), field('57025362'), field('1'), field('01/08/2026 09:00:00'), 1234567890);
    expect(name).toBe('POS Thanh Toàn 2 - 57025362 - Lô 1 - 01-08-2026 09-00-00.jpg');
  });

  it('hkdName có tiền tố "HKD " → BÓC BỎ tiền tố (dùng lại HKD_PREFIX_PATTERN, KHÔNG lặp 2 lần "HKD" trong tên file)', () => {
    const name = buildBillFileName(field('HKD THANH TOAN 2'), field('50550759'), field('000189'), field('21/11/2025 10:39:56'), 1234567890);
    expect(name).toBe('POS THANH TOAN 2 - 50550759 - Lô 000189 - 21-11-2025 10-39-56.jpg');
  });

  it('hkdName KHÔNG có tiền tố "HKD " → giữ nguyên, không đụng phần còn lại', () => {
    const name = buildBillFileName(field('DEMOMAY 1'), field('50550759'), field('000189'), field('21/11/2025 10:39:56'), 1234567890);
    expect(name).toBe('POS DEMOMAY 1 - 50550759 - Lô 000189 - 21-11-2025 10-39-56.jpg');
  });

  it('thiếu hkdName (null) → fallback NGUYÊN "bill-<timestamp>.jpg" cho CẢ file, không ghép nửa vời', () => {
    const name = buildBillFileName(null, field('50550759'), field('000189'), field('21/11/2025 10:39:56'), 1234567890);
    expect(name).toBe('bill-1234567890.jpg');
  });

  it('thiếu tid (null) → fallback', () => {
    const name = buildBillFileName(field('HKD DEMOMAY 1'), null, field('000189'), field('21/11/2025 10:39:56'), 1234567890);
    expect(name).toBe('bill-1234567890.jpg');
  });

  it('thiếu batchNumber (null) → fallback', () => {
    const name = buildBillFileName(field('HKD DEMOMAY 1'), field('50550759'), null, field('21/11/2025 10:39:56'), 1234567890);
    expect(name).toBe('bill-1234567890.jpg');
  });

  it('thiếu dateTime (null) → fallback', () => {
    const name = buildBillFileName(field('HKD DEMOMAY 1'), field('50550759'), field('000189'), null, 1234567890);
    expect(name).toBe('bill-1234567890.jpg');
  });

  it('dateTime không tách được ngày/giờ (không có khoảng trắng) → fallback', () => {
    const name = buildBillFileName(field('HKD DEMOMAY 1'), field('50550759'), field('000189'), field('khong-doc-duoc'), 1234567890);
    expect(name).toBe('bill-1234567890.jpg');
  });

  it('phần ngày KHÔNG đúng định dạng dd/mm/yyyy (OCR đọc lệch, thiếu số 0 đệm) → fallback', () => {
    const name = buildBillFileName(field('HKD DEMOMAY 1'), field('50550759'), field('000189'), field('1/8/2025 10:39:56'), 1234567890);
    expect(name).toBe('bill-1234567890.jpg');
  });

  it('tid lẫn ký tự KHÔNG hợp lệ trong tên file Windows (\\/:*?"<>|) → LỌC BỎ, giữ nguyên phần còn lại (kể cả khoảng trắng)', () => {
    const name = buildBillFileName(field('HKD DEMOMAY 1'), field('5055/0759'), field('000189'), field('21/11/2025 10:39:56'), 1234567890);
    expect(name).toBe('POS DEMOMAY 1 - 50550759 - Lô 000189 - 21-11-2025 10-39-56.jpg');
  });

  it('batchNumber lẫn ký tự điều khiển (control char, VD tab do OCR/paste lỗi) → LỌC BỎ, KHÔNG để lại khoảng trắng thừa', () => {
    const name = buildBillFileName(field('HKD DEMOMAY 1'), field('50550759'), field('000\t189'), field('21/11/2025 10:39:56'), 1234567890);
    expect(name).toBe('POS DEMOMAY 1 - 50550759 - Lô 000189 - 21-11-2025 10-39-56.jpg');
  });

  it('hkdName chỉ có tiền tố "HKD " rồi hết (sau bóc tiền tố + trim rỗng) → fallback', () => {
    const name = buildBillFileName(field('HKD   '), field('50550759'), field('000189'), field('21/11/2025 10:39:56'), 1234567890);
    expect(name).toBe('bill-1234567890.jpg');
  });

  it('hkdName nhiều khoảng trắng liên tiếp bên trong (sau bóc tiền tố) → GỘP về 1 khoảng trắng, KHÔNG viết liền và KHÔNG giữ nguyên khoảng trắng thừa', () => {
    const name = buildBillFileName(field('HKD   DEMOMAY   1'), field('50550759'), field('000189'), field('21/11/2025 10:39:56'), 1234567890);
    expect(name).toBe('POS DEMOMAY 1 - 50550759 - Lô 000189 - 21-11-2025 10-39-56.jpg');
  });

  it('giờ đọc được nhưng lẫn ký tự lạ (control char) → LỌC BỎ, giữ dạng hh:mm:ss còn lại rồi mới đổi ":" → "-"', () => {
    const name = buildBillFileName(field('HKD DEMOMAY 1'), field('50550759'), field('000189'), field('21/11/2025 10:3\t9:56'), 1234567890);
    expect(name).toBe('POS DEMOMAY 1 - 50550759 - Lô 000189 - 21-11-2025 10-39-56.jpg');
  });
});

describe('buildBillCaption', () => {
  // B106 (2/8) — dòng chữ HIỂN THỊ dưới ảnh trong khung chat, thay "Bill: <số tiền>đ" cũ, CÙNG mẫu
  // buildBillFileName() nhưng giữ nguyên dấu ":" trong giờ (dễ đọc hơn, không bị giới hạn tên file).
  it('đủ 4 field hợp lệ → "POS <TênHKD> - <TID> - Lô <SốLô> - <dd-mm-yyyy> <hh:mm:ss>" (giữ nguyên dấu hai chấm giờ)', () => {
    const caption = buildBillCaption(field('HKD DEMOMAY 1'), field('50550759'), field('000189'), field('21/11/2025 10:39:56'), '140.000.000đ');
    expect(caption).toBe('POS DEMOMAY 1 - 50550759 - Lô 000189 - 21-11-2025 10:39:56');
  });

  it('thiếu field (VD hkdName null) → fallback "Bill: <amountText>" CŨ, giữ ít nhất số tiền dễ đọc', () => {
    const caption = buildBillCaption(null, field('50550759'), field('000189'), field('21/11/2025 10:39:56'), '140.000.000đ');
    expect(caption).toBe('Bill: 140.000.000đ');
  });

  it('dateTime không tách được → fallback "Bill: <amountText>"', () => {
    const caption = buildBillCaption(field('HKD DEMOMAY 1'), field('50550759'), field('000189'), field('khong-doc-duoc'), '79.829.000đ');
    expect(caption).toBe('Bill: 79.829.000đ');
  });
});

// B123 (2/8, tính năng "Hoàn tiền" MỚI + fix bug "cảnh báo biến mất sau khi gửi") — wrapTextLines() + hàng
// `warning` trong computeBillTableLayout().
describe('wrapTextLines', () => {
  it('chuỗi rỗng → mảng rỗng', () => {
    expect(wrapTextLines(fakeMeasure, '', 200)).toEqual([]);
    expect(wrapTextLines(fakeMeasure, '   ', 200)).toEqual([]);
  });

  it('chuỗi ngắn vừa đủ 1 dòng → 1 phần tử NGUYÊN VĂN', () => {
    expect(wrapTextLines(fakeMeasure, 'Bill hợp lệ', 500)).toEqual(['Bill hợp lệ']);
  });

  it('chuỗi dài xuống NHIỀU dòng, KHÔNG dòng nào vượt maxWidth, KHÔNG mất từ nào', () => {
    const text = 'Bill có mã đóng lô ĐÓNG(95) — CẢNH BÁO rủi ro hoàn tiền/hủy giao dịch sau khi đã nhận tiền.';
    const maxWidth = 200; // 200/8 = 25 ký tự/dòng tối đa (fakeMeasure 8px/ký tự)
    const lines = wrapTextLines(fakeMeasure, text, maxWidth);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(fakeMeasure(line)).toBeLessThanOrEqual(maxWidth);
    // Ghép lại (nối khoảng trắng) PHẢI khớp NGUYÊN VĂN — không rớt/lặp từ nào.
    expect(lines.join(' ')).toBe(text);
  });

  it('1 TỪ ĐƠN LẺ dài hơn maxWidth (hiếm) → vẫn giữ nguyên trên 1 dòng riêng, KHÔNG cắt mất', () => {
    const text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const lines = wrapTextLines(fakeMeasure, text, 50); // 50/8 ≈ 6 ký tự — ngắn hơn hẳn từ dài 37 ký tự.
    expect(lines).toEqual([text]);
  });
});

describe('computeBillTableLayout — hàng warning (B123)', () => {
  it('có hàng warning → rowWrappedLines[i] là mảng dòng KHÔNG rỗng, height > 0', () => {
    const rows: BillTableRowInput[] = [
      ...makeRows(),
      { kind: 'warning', label: 'Cảnh báo', text: 'Bill có mã đóng lô ĐÓNG(95) — rủi ro hoàn tiền sau khi đã nhận tiền.', severity: 'danger' }
    ];
    const layout = computeBillTableLayout(rows, fakeMeasure);
    const warningIdx = rows.length - 1;
    expect(layout.rowWrappedLines[warningIdx]).toBeDefined();
    expect((layout.rowWrappedLines[warningIdx] as string[]).length).toBeGreaterThan(0);
    expect(layout.rowHeights[warningIdx]).toBeGreaterThan(0);
    // full-width CÙNG hero/full, KHÔNG chia cột.
    const tableWidth = layout.canvasWidth - layout.tableLeft * 2;
    expect(layout.rowWidths[warningIdx]).toBe(tableWidth);
  });

  it('hàng warning KHÔNG tham gia tính bề rộng bảng tự nhiên — 1 câu cảnh báo RẤT DÀI vẫn KHÔNG ép bảng rộng thêm (tự xuống dòng thay vì giãn bảng)', () => {
    const shortRows = makeRows();
    const layoutWithoutWarning = computeBillTableLayout(shortRows, fakeMeasure);
    const veryLongWarning = 'X'.repeat(500); // dài hơn NHIỀU so với mọi field khác trong makeRows().
    const rowsWithWarning: BillTableRowInput[] = [...shortRows, { kind: 'warning', label: 'Cảnh báo', text: veryLongWarning, severity: 'danger' }];
    const layoutWithWarning = computeBillTableLayout(rowsWithWarning, fakeMeasure);
    expect(layoutWithWarning.canvasWidth).toBe(layoutWithoutWarning.canvasWidth);
  });

  it('2 hàng warning liên tiếp (vd hoàn thừa + tài khoản không khớp CÙNG LÚC) → cả 2 đều có wrappedLines riêng, tổng chiều cao bảng CỘNG DỒN cả 2', () => {
    const rows: BillTableRowInput[] = [
      { kind: 'hero', label: 'Hoàn tiền (lần này)', value: '1.000.000đ', color: 'amount' },
      { kind: 'warning', label: 'Cảnh báo', text: 'Hoàn thừa 15.000đ so với số phải hoàn.', severity: 'danger' },
      { kind: 'warning', label: 'Cảnh báo', text: 'Tên người nhận KHÔNG khớp dữ liệu đã cấu hình.', severity: 'warning' }
    ];
    const layout = computeBillTableLayout(rows, fakeMeasure);
    expect(layout.rowWrappedLines[1]).toBeDefined();
    expect(layout.rowWrappedLines[2]).toBeDefined();
    expect(layout.rowTops[2]).toBe(layout.rowTops[1] + layout.rowHeights[1]);
    expect(layout.canvasHeight).toBeGreaterThan(layout.rowHeights[0] + layout.rowHeights[1] + layout.rowHeights[2]);
  });
});
