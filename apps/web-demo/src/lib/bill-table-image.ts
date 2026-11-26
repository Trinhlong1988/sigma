// SIGMA (1/8) — vẽ bảng ảnh (canvas) THAY caption chữ dồn cục trong tin nhắn chat khi gửi bill đã quét
// (Admin Demo chê thật "chữ rất xấu" — xem ảnh chụp màn hình gửi kèm brief: tin nhắn cũ là 1 khối chữ trắng trên
// nền xanh dồn liền, không viền/bảng gì, do `buildBillCaptionExtraLines()` cũ nối `\n` — hàm đó ĐÃ XOÁ khỏi
// ocr-bill-fields-display.ts, module NÀY thay thế hoàn toàn). Dùng NGUYÊN xi 7 dòng
// `buildBillFieldDisplayRows()` (ocr-bill-fields-display.ts) + 1 dòng "Số tiền" (caller tự truyền, ĐÃ format
// sẵn qua formatVndGrouped() — module này KHÔNG parse/format số, chỉ vẽ text nhận vào NGUYÊN VĂN).
//
// CẬP NHẬT 1/8 (Admin Demo tường minh: "bảng thông tin khi quét ra và bill nằm trên 1 tin nhắn không tách" + "tên
// bill (file đặt theo TID - Số lô - Ngày)") — TRƯỚC ĐÂY module này chỉ có `renderBillTableImage()` tự tạo 1
// canvas RIÊNG chỉ vẽ bảng, `MessageComposer.tsx handleConfirmBillSend()` gửi 2 TIN NHẮN ẢNH LIÊN TIẾP (ảnh
// bill gốc rồi tới ảnh bảng). ĐÃ TÁCH LẠI thành 3 lớp để ghép được cả 2 phần lên CÙNG 1 canvas:
// 1) `computeBillTableLayout()` — TÍNH TOÁN THUẦN bố cục bảng (không đụng canvas thật, giữ NGUYÊN không đổi —
//    test cũ `bill-table-image.test.ts` vẫn áp dụng y hệt).
// 2) `drawBillTableAt()` — VẼ bảng (đã có `layout`/`renderRows` tính sẵn) lên 1 `CanvasRenderingContext2D` CÓ
//    SẴN tại toạ độ (offsetX, offsetY) bất kỳ — KHÔNG tự tạo canvas, chỉ vẽ.
// 3) `composeBillImage()` — hàm MỚI thay `renderBillTableImage()` cũ (ĐÃ XOÁ, không còn ai gọi): tự tạo 1
//    canvas DUY NHẤT, vẽ ảnh bill gốc (`drawImage`) ở TRÊN rồi gọi `drawBillTableAt()` vẽ bảng NGAY DƯỚI, trả
//    1 JPEG Blob DUY NHẤT. `OcrBillPreview.tsx handleSend()` gọi hàm này rồi `MessageComposer.tsx` chỉ còn gửi
//    ĐÚNG 1 tin nhắn ảnh (không còn 2 lần `uploadAndSend()` nữa).
// `buildBillFileName()` — đặt tên file ảnh ghép cuối cùng theo mẫu "NgânHàng-TênHKD-TID-SốLô-Ngày" (Admin Demo
// chốt SAU brief gốc "TID-SốLô-Ngày" — xem docstring hàm đó). Ảnh bill gốc LUÔN vẽ co lại về bề rộng bảng
// (`tableLayout.canvasWidth`, thường ~500 layout px → ~1000px thật sau SCALE x2, KHÔNG BAO GIỜ giữ full-res
// gốc — camera đã giới hạn 1600px từ `MessageComposer.tsx handleScanBillClick()`, ảnh chọn từ thư viện có thể
// lớn hơn nhiều nhưng vẫn LUÔN bị co xuống ĐÚNG bề rộng này khi `drawImage()`), đúng yêu cầu Admin Demo "size nhỏ
// đủ view, không quá nặng" — phần lớn dung lượng nằm ở ảnh bill (bảng chỉ là vector fillRect/fillText nhẹ).
//
// Màu sắc dùng ĐÚNG token hệ thống hiện có (apps/web-demo/src/styles.css @theme, KHÔNG bịa mã màu mới):
// --color-brand #0579cc (nền hàng "Số tiền" nổi bật nhất), --color-appbg #f4f6fa (nền zebra hàng lẻ), viền
// dùng #cbd5e1 (slate-300 — CÙNG màu track `.toggle-3d` đã dùng trong styles.css, đủ tương phản trên nền
// trắng, KHÔNG dùng --color-line #e5e9f0 vì quá nhạt để làm viền RÕ trên ảnh tĩnh không có anti-alias mượt
// như border CSS trình duyệt).
import { HKD_PREFIX_PATTERN, splitDateTime, type BillFieldDisplayRow, type RefundFieldDisplayRow } from './ocr-bill-fields-display';
import type { OcrBillFieldValue } from './agent-api-client';

const FONT_FAMILY = '"Be Vietnam Pro", ui-sans-serif, system-ui, sans-serif';

/** Font ĐO (luôn đậm + cỡ lớn nhất từng dùng trong bảng, kể cả hàng "Số tiền") — dùng CHUNG cho cả đo nhãn
 * lẫn giá trị để đảm bảo cột đủ rộng cho MỌI hàng, kể cả hàng vẽ đậm/cỡ to hơn lúc render thật. Đo HỤT = cắt
 * chữ (lỗi thật), đo DƯ chỉ tốn vài px khoảng trắng vô hại — luôn ưu tiên đo DƯ. */
const MEASURE_FONT = `700 16px ${FONT_FAMILY}`;

// B121 (2/8, "Phương án B — Lưới ô vuông", Admin Demo yêu cầu trực tiếp) — nhãn nhỏ TRÊN + giá trị to DƯỚI trong
// từng ô vuông (khác thiết kế CŨ "khối chữ dồn cục" 1 cột dài Nhãn|Giá trị 8 hàng liên tiếp). GIỮ NGUYÊN 2
// hàng nổi bật nhất (Số tiền/Hoàn tiền) — nền màu đậm chữ trắng, full-width — CÙNG font/độ nổi bật bản cũ.
const GRID_LABEL_FONT = `600 11px ${FONT_FAMILY}`;
const GRID_VALUE_FONT = `600 14px ${FONT_FAMILY}`;
const AMOUNT_FONT = `700 16px ${FONT_FAMILY}`;

const CELL_PADDING_X = 14;
const OUTER_MARGIN = 16;
const HERO_ROW_HEIGHT = 54; // "Số tiền"/"Hoàn tiền" — GIỮ NGUYÊN chiều cao bản cũ, không đổi độ nổi bật.
const FULL_ROW_HEIGHT = 52; // ô full-width "Tên Pos (HKD)" — 2 dòng xếp chồng (nhãn nhỏ trên, giá trị dưới).
const GRID_ROW_HEIGHT = 52; // MỖI ô vuông trong lưới 2 cột (Ngân hàng/TID/Ngày/Giờ/Số lô/Số hóa đơn).
const GRID_COLUMNS = 2;
const MIN_LABEL_COL_WIDTH = 90; // dùng làm sàn khi bảng RỖNG (edge-case duy nhất cần trị số này).
/** Bề rộng BẢNG (không tính margin ngoài) mong muốn tối thiểu — brief gợi ý tổng canvas ~500-600px vừa bubble
 * chat điện thoại. CHỈ ép RỘNG LÊN khi nội dung tự nhiên hẹp hơn mốc này (bảng ít hàng/giá trị ngắn không ra
 * ảnh nhỏ xíu) — KHÔNG ép HẸP XUỐNG nếu nội dung tự nhiên đã rộng hơn (ưu tiên tuyệt đối "không cắt chữ" hơn
 * "đúng khổ gợi ý", xem computeBillTableLayout()). Đây CŨNG LÀ bề rộng ảnh bill gốc vẽ trong composeBillImage()
 * bên dưới (ảnh co theo chiều rộng này, giữ tỉ lệ) — luôn ≥500px nên ảnh ghép không bao giờ ra khổ nhỏ xíu.
 */
const MIN_TABLE_WIDTH = 500 - OUTER_MARGIN * 2;

const BORDER_COLOR = '#cbd5e1';
const AMOUNT_BG = '#0579cc'; // --color-brand (styles.css) — FIX-DEMOCK 4/8: đồng bộ tone brand mới
// B107-tiếp (2/8) — hàng "Hoàn tiền" (số tiền sau phí) MỚI, Admin Demo yêu cầu tường minh 3 lần liên tiếp: "nền
// xanh chữ trắng rõ như số tiền quét được" — CÙNG ĐỘ NỔI BẬT hàng "Số tiền" nhưng màu KHÁC để phân biệt 2 con
// số. Dùng `--color-success` (styles.css) — xanh lá, đã là convention "kết quả/số tiền cuối cùng tích cực"
// toàn app (KHÔNG bịa màu mới).
const REFUND_BG = '#16a34a'; // --color-success (styles.css)
const LABEL_COLOR = '#334155'; // slate-700
const VALUE_COLOR = '#0f172a';
const MUTED_COLOR = '#94a3b8'; // slate-400, CÙNG màu OcrBillPreview.tsx dùng cho field muted (`text-slate-400`)

// B123 (2/8, tính năng "Hoàn tiền" MỚI + fix BUG THẬT Admin Demo phát hiện: "cảnh báo lúc xem trước biến mất sau
// khi gửi") — hàng CẢNH BÁO full-width, mới, dùng CHO CẢ bill gốc (mã đóng lô rủi ro settlementRisk — TRƯỚC ĐÂY
// CHỈ hiện trong preview React `BillSettlementRiskBanner`, KHÔNG BAO GIỜ được vẽ vào ảnh ghép gửi đi/lưu lại —
// đại lý xem lại tin nhắn CŨ sẽ KHÔNG còn thấy cảnh báo đã từng có, mất dấu vết rủi ro) LẪN tin nhắn hoàn tiền
// (số tiền lệch/tài khoản không khớp). 2 mức nghiêm trọng — `danger` (đỏ, mức cao nhất: mã đóng lô rủi ro/hoàn
// thừa/tài khoản không khớp) và `warning` (hổ phách, nhẹ hơn: hoàn thiếu — Admin Demo: "màu cảnh báo khác đỏ để
// phân biệt 2 loại lệch"). Nội dung có thể DÀI (câu cảnh báo đầy đủ) → PHẢI tự xuống dòng (wrapTextLines()
// dưới đây), KHÔNG được ép tràn ra ngoài bảng hay bị cắt cụt.
const WARNING_DANGER_BG = '#dc2626'; // red-600 — CÙNG mức nổi bật --color-danger dùng cho cảnh báo mức cao nhất toàn app.
const WARNING_AMBER_BG = '#d97706'; // amber-600 — cảnh báo NHẸ HƠN đỏ, phân biệt rõ 2 loại lệch (Admin Demo yêu cầu).
const WARNING_LABEL_FONT = `700 12px ${FONT_FAMILY}`;
const WARNING_BODY_FONT = `600 13px ${FONT_FAMILY}`;
const WARNING_LABEL_LINE_HEIGHT = 17;
const WARNING_BODY_LINE_HEIGHT = 18;
const WARNING_PADDING_Y = 10;

/** 1 hàng đầu vào cho bảng — 4 KIỂU (B121 hero/full/grid + B123 warning MỚI):
 * - `hero`: "Số tiền"/"Hoàn tiền" — full-width, nền màu đậm chữ trắng, nổi bật nhất (GIỮ NGUYÊN bản cũ).
 * - `full`: "Tên Pos (HKD)" — 1 ô full-width riêng (tên đại lý thường dài, xứng đáng cả hàng), nền trắng, nhãn
 *   nhỏ TRÊN + giá trị to DƯỚI.
 * - `grid`: 6 field còn lại (Ngân hàng/TID/Ngày/Giờ/Số lô/Số hóa đơn) — xếp 2 CỘT đều nhau, mỗi ô CÙNG kiểu
 *   nhãn-trên/giá-trị-dưới như `full` nhưng hẹp bằng 1/2 bảng.
 * - `warning` (B123, 2/8): full-width, nền đỏ/hổ phách chữ trắng, text TỰ XUỐNG DÒNG — LƯU LẠI VĨNH VIỄN cảnh
 *   báo vào ảnh gửi đi (KHÔNG chỉ hiện thoáng qua trong preview màn hình). */
export type BillTableRowInput =
  | { kind: 'hero'; label: string; value: string; color: 'amount' | 'refund' }
  | { kind: 'full'; label: string; value: string; muted: boolean }
  | { kind: 'grid'; label: string; value: string; muted: boolean }
  | { kind: 'warning'; label: string; text: string; severity: 'danger' | 'warning' };

export interface BillTableLayout {
  canvasWidth: number;
  canvasHeight: number;
  tableLeft: number;
  tableTop: number;
  gridCellWidth: number;
  gridCellHeight: number;
  gridColumns: number;
  /** CÙNG độ dài + THỨ TỰ `rows` đầu vào — toạ độ/kích thước TỪNG hàng (hero/full/warning = full table width;
   * grid = gridCellWidth, xen kẽ trái/phải theo cột). */
  rowTops: number[];
  rowLefts: number[];
  rowWidths: number[];
  rowHeights: number[];
  /** B123 (2/8) — dòng ĐÃ XUỐNG DÒNG SẴN cho từng hàng `warning` (CÙNG index `rows`) — `undefined` cho hàng
   * KHÔNG phải warning. Tính SẴN ở computeBillTableLayout() (đo bằng `measureText` injectable, test được) để
   * `drawBillTableAt()` KHÔNG cần đo lại (tránh lệch nếu ctx.font đọc khác lúc vẽ thật so với lúc đo layout). */
  rowWrappedLines: (string[] | undefined)[];
}

/** Xuống dòng THAM LAM (greedy word-wrap) theo TỪNG TỪ (tách khoảng trắng — đủ dùng cho câu tiếng Việt, không
 * cần thuật toán ngắt âm tiết phức tạp hơn) — trả mảng dòng KHÔNG dòng nào vượt `maxWidth` (đo qua
 * `measureText` injectable, CÙNG DI pattern `computeBillTableLayout()`). 1 TỪ ĐƠN LẺ dài hơn `maxWidth` (hiếm,
 * vd URL/số dài không khoảng trắng) vẫn giữ NGUYÊN trên 1 dòng riêng (chấp nhận tràn nhẹ hơn là cắt mất nội
 * dung — ưu tiên "không mất chữ" như mọi phép đo khác trong file này). Chuỗi rỗng → mảng rỗng. */
export function wrapTextLines(measureText: (text: string) => number, text: string, maxWidth: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`;
    if (measureText(candidate) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

/** Tính bố cục bảng LƯỚI Ô VUÔNG THUẦN (không đụng canvas) — nhận `measureText` (đo bề rộng px của 1 chuỗi
 * theo font ĐÃ set trước khi gọi, xem `MEASURE_FONT`) qua tham số để test được không cần canvas thật (vitest
 * environment 'node'). Bề rộng bảng lấy đủ chỗ cho: (a) nội dung DÀI NHẤT trong các ô `hero`/`full` (chiếm
 * TRỌN bề rộng bảng, không chia cột) VÀ (b) nội dung DÀI NHẤT trong 1 ô `grid` (Ô ĐƠN, vì lưới 2 cột đều
 * nhau — mỗi cột rộng = bề rộng bảng / 2) — lấy MAX của 2 mốc này rồi mới so với `MIN_TABLE_WIDTH`, đảm bảo
 * KHÔNG ô nào bị cắt chữ dù là hero/full/grid. */
export function computeBillTableLayout(rows: BillTableRowInput[], measureText: (text: string) => number): BillTableLayout {
  if (rows.length === 0) {
    const tableWidth = Math.max(MIN_TABLE_WIDTH, MIN_LABEL_COL_WIDTH);
    return {
      canvasWidth: tableWidth + OUTER_MARGIN * 2,
      canvasHeight: OUTER_MARGIN * 2,
      tableLeft: OUTER_MARGIN,
      tableTop: OUTER_MARGIN,
      gridCellWidth: tableWidth / GRID_COLUMNS,
      gridCellHeight: GRID_ROW_HEIGHT,
      gridColumns: GRID_COLUMNS,
      rowTops: [],
      rowLefts: [],
      rowWidths: [],
      rowHeights: [],
      rowWrappedLines: []
    };
  }

  // B123 (2/8) — hàng `warning` KHÔNG tham gia tính bề rộng bảng tự nhiên (text tự XUỐNG DÒNG theo bề rộng đã
  // chốt bởi hero/full/grid, KHÔNG được phép ép bảng rộng thêm chỉ vì 1 câu cảnh báo dài).
  const fullWidthTexts = rows.filter((r) => r.kind !== 'grid' && r.kind !== 'warning').flatMap((r) => [r.label, r.value]);
  const gridTexts = rows.filter((r) => r.kind === 'grid').flatMap((r) => [r.label, r.value]);
  const naturalFullWidth = fullWidthTexts.length > 0 ? Math.max(...fullWidthTexts.map((t) => measureText(t) + CELL_PADDING_X * 2)) : 0;
  const naturalGridColWidth = gridTexts.length > 0 ? Math.max(...gridTexts.map((t) => measureText(t) + CELL_PADDING_X * 2)) : 0;
  const naturalTableWidth = Math.max(naturalFullWidth, naturalGridColWidth * GRID_COLUMNS);
  const tableWidth = Math.max(naturalTableWidth, MIN_TABLE_WIDTH);
  const gridCellWidth = tableWidth / GRID_COLUMNS;

  const rowTops: number[] = [];
  const rowLefts: number[] = [];
  const rowWidths: number[] = [];
  const rowHeights: number[] = [];
  const rowWrappedLines: (string[] | undefined)[] = [];

  let cursorY = OUTER_MARGIN;
  let gridCol = 0;
  for (const row of rows) {
    if (row.kind === 'hero' || row.kind === 'full') {
      const height = row.kind === 'hero' ? HERO_ROW_HEIGHT : FULL_ROW_HEIGHT;
      rowTops.push(cursorY);
      rowLefts.push(OUTER_MARGIN);
      rowWidths.push(tableWidth);
      rowHeights.push(height);
      rowWrappedLines.push(undefined);
      cursorY += height;
      gridCol = 0; // hero/full/warning LUÔN bắt đầu 1 hàng lưới mới ngay sau đó (không xen giữa 2 ô lưới dở dang).
    } else if (row.kind === 'warning') {
      const wrapped = wrapTextLines(measureText, row.text, tableWidth - CELL_PADDING_X * 2);
      const height = WARNING_PADDING_Y * 2 + WARNING_LABEL_LINE_HEIGHT + Math.max(1, wrapped.length) * WARNING_BODY_LINE_HEIGHT;
      rowTops.push(cursorY);
      rowLefts.push(OUTER_MARGIN);
      rowWidths.push(tableWidth);
      rowHeights.push(height);
      rowWrappedLines.push(wrapped);
      cursorY += height;
      gridCol = 0;
    } else {
      rowTops.push(cursorY);
      rowLefts.push(OUTER_MARGIN + gridCol * gridCellWidth);
      rowWidths.push(gridCellWidth);
      rowHeights.push(GRID_ROW_HEIGHT);
      rowWrappedLines.push(undefined);
      gridCol += 1;
      if (gridCol === GRID_COLUMNS) {
        cursorY += GRID_ROW_HEIGHT;
        gridCol = 0;
      }
    }
  }
  if (gridCol !== 0) cursorY += GRID_ROW_HEIGHT; // hàng lưới CUỐI lẻ (số ô grid lẻ) vẫn tính đủ chiều cao.

  return {
    canvasWidth: tableWidth + OUTER_MARGIN * 2,
    canvasHeight: cursorY + OUTER_MARGIN,
    tableLeft: OUTER_MARGIN,
    tableTop: OUTER_MARGIN,
    gridCellWidth,
    gridCellHeight: GRID_ROW_HEIGHT,
    gridColumns: GRID_COLUMNS,
    rowTops,
    rowLefts,
    rowWidths,
    rowHeights,
    rowWrappedLines
  };
}

/** Vẽ bảng LƯỚI Ô VUÔNG lên 1 `CanvasRenderingContext2D` CÓ SẴN tại toạ độ (offsetX, offsetY) — hàm TÁCH RIÊNG
 * (1/8, giữ nguyên kiến trúc) phần "vẽ" khỏi phần "tự tạo canvas" để `composeBillImage()` bên dưới vẽ được
 * bảng NGAY DƯỚI ảnh bill gốc trên CÙNG 1 canvas thay vì 1 canvas riêng. `layout`/`renderRows` PHẢI là cặp ĐÃ
 * DÙNG CHUNG để tính ra nhau (`computeBillTableLayout(renderRows, ...)` → `layout`) — mọi mảng trong `layout`
 * khớp theo INDEX với `renderRows`, hàm này KHÔNG tự suy luận lại. Toạ độ vẽ trong `layout` là toạ độ CỤC BỘ
 * của bảng (gốc 0,0 = góc trên-trái bảng) — hàm này CỘNG THÊM offsetX/offsetY để ra toạ độ THẬT trên canvas
 * đích. CHỈ chạy được trong trình duyệt thật (cần `CanvasRenderingContext2D` thật) — KHÔNG test được ở vitest
 * environment 'node', xem `bill-table-image.test.ts` (chỉ test `computeBillTableLayout()`). */
export function drawBillTableAt(
  ctx: CanvasRenderingContext2D,
  layout: BillTableLayout,
  renderRows: BillTableRowInput[],
  offsetX: number,
  offsetY: number
): void {
  renderRows.forEach((row, i) => {
    const top = offsetY + layout.rowTops[i];
    const left = offsetX + layout.rowLefts[i];
    const width = layout.rowWidths[i];
    const height = layout.rowHeights[i];

    if (row.kind === 'hero') {
      // Hàng "Số tiền"/"Hoàn tiền" — GIỮ NGUYÊN độ nổi bật bản cũ: nền màu đậm, chữ trắng đậm, nhãn trái/giá
      // trị phải CÙNG 1 dòng, full-width.
      ctx.fillStyle = row.color === 'amount' ? AMOUNT_BG : REFUND_BG;
      ctx.fillRect(left, top, width, height);
      ctx.strokeStyle = BORDER_COLOR;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(left, top, width, height);
      const textY = top + height / 2;
      ctx.textBaseline = 'middle';
      ctx.font = AMOUNT_FONT;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.fillText(row.label, left + CELL_PADDING_X, textY);
      ctx.textAlign = 'right';
      ctx.fillText(row.value, left + width - CELL_PADDING_X, textY);
      return;
    }

    if (row.kind === 'warning') {
      // B123 (2/8) — hàng CẢNH BÁO full-width, nền đỏ/hổ phách tuỳ `severity`, text ĐÃ XUỐNG DÒNG SẴN
      // (layout.rowWrappedLines[i], tính 1 lần lúc computeBillTableLayout() — KHÔNG đo lại ở đây).
      ctx.fillStyle = row.severity === 'danger' ? WARNING_DANGER_BG : WARNING_AMBER_BG;
      ctx.fillRect(left, top, width, height);
      ctx.strokeStyle = BORDER_COLOR;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(left, top, width, height);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = WARNING_LABEL_FONT;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(row.label.toUpperCase(), left + CELL_PADDING_X, top + WARNING_PADDING_Y + WARNING_LABEL_LINE_HEIGHT - 4);
      ctx.font = WARNING_BODY_FONT;
      const wrapped = layout.rowWrappedLines[i] ?? [];
      wrapped.forEach((line, lineIdx) => {
        const lineY = top + WARNING_PADDING_Y + WARNING_LABEL_LINE_HEIGHT + (lineIdx + 1) * WARNING_BODY_LINE_HEIGHT - 5;
        ctx.fillText(line, left + CELL_PADDING_X, lineY);
      });
      return;
    }

    // Ô vuông thường (`full` = "Tên Pos (HKD)" full-width, `grid` = 6 field còn lại 2 cột) — CÙNG kiểu vẽ:
    // nhãn nhỏ HOA TRÊN + giá trị to DƯỚI, nền trắng, viền RÕ (Admin Demo: "bảng kẻ ô đẹp rõ").
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(left, top, width, height);
    ctx.strokeStyle = BORDER_COLOR;
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, width, height);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = GRID_LABEL_FONT;
    ctx.fillStyle = LABEL_COLOR;
    ctx.fillText(row.label.toUpperCase(), left + CELL_PADDING_X, top + 18);
    ctx.font = GRID_VALUE_FONT;
    ctx.fillStyle = row.muted ? MUTED_COLOR : VALUE_COLOR;
    ctx.fillText(row.value, left + CELL_PADDING_X, top + 38);
  });
}

/** B112 (2/8) — `composeBillImage()` giờ trả kèm `billImageHeightPx` (chiều cao PHYSICAL PIXEL, đã nhân SCALE,
 * của phần ẢNH BILL trong ảnh ghép cuối cùng) để caller lưu vào `metadataJson` (xem bill-message-meta.ts) —
 * dùng lúc "Sửa" bill đã gửi để cắt lại ĐÚNG phần ảnh bill khỏi ảnh ghép hiện có (`cropTopOfImage()` dưới),
 * KHÔNG cần lưu thêm 1 attachment riêng chỉ để giữ ảnh gốc (tốn thêm dung lượng/upload mỗi lần gửi bill). */
export interface ComposeBillImageResult {
  blob: Blob;
  billImageHeightPx: number;
}

/** Ghép ẢNH BILL GỐC (trên) + BẢNG kết quả OCR (dưới) vào CÙNG 1 canvas rồi trả JPEG Blob — thay hàm
 * `renderBillTableImage()` cũ (tự tạo canvas RIÊNG chỉ vẽ bảng, ĐÃ XOÁ 1/8) để gửi ĐÚNG 1 tin nhắn ảnh thay vì
 * 2 tin nhắn liên tiếp (yêu cầu tường minh Admin Demo: "bảng thông tin khi quét ra và bill nằm trên 1 tin nhắn
 * không tách"). Layout:
 * - Ảnh bill gốc vẽ ĐẦY chiều rộng canvas (= bề rộng bảng, `tableLayout.canvasWidth`, luôn ≥500px — xem
 *   `MIN_TABLE_WIDTH`), GIỮ TỈ LỆ gốc (co theo chiều rộng, KHÔNG crop/méo) — bill thường ảnh dọc (portrait)
 *   nên co theo chiều rộng vẫn đọc rõ toàn bộ nội dung.
 * - Bảng kết quả vẽ NGAY DƯỚI (offsetY = chiều cao ảnh đã co), TÁI DÙNG NGUYÊN `computeBillTableLayout()` +
 *   `drawBillTableAt()` — bảng tự có margin/padding riêng (`OUTER_MARGIN`) nên không cần thêm khoảng trắng
 *   đệm thủ công giữa ảnh và bảng.
 * JPEG quality 0.9 (KHÔNG PNG lossless — ảnh có photo thật bên trong, JPEG nhẹ hơn đáng kể; phần bảng vẽ
 * vector (fillRect/fillText) vẫn đủ nét ở quality 0.9, không cần lossless cho trường hợp này — đúng gợi ý
 * brief).
 * CHỈ chạy được trong trình duyệt thật (cần `document`/`createImageBitmap`) — KHÔNG test được ở vitest
 * environment 'node', CÙNG giới hạn `renderBillTableImage()` cũ (xem `bill-table-image.test.ts`, chỉ test
 * `computeBillTableLayout()`). */
/** B123 (2/8) — LÕI DÙNG CHUNG tách ra từ `composeBillImage()` gốc (KHÔNG đổi hành vi/pixel output cho caller
 * cũ — cùng thuật toán nguyên xi, chỉ đổi CHỖ xây `renderRows` ra ngoài hàm này) — `composeBillImage()` (bill
 * gốc) LẪN `composeRefundImage()` (hoàn tiền, MỚI) đều gọi hàm này, tránh 2 bản canvas-assembly trùng lặp. */
async function composeImageWithRows(billImageSource: Blob, renderRows: BillTableRowInput[]): Promise<ComposeBillImageResult> {
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    // Đợi font Be Vietnam Pro tải xong TRƯỚC khi đo/vẽ — tránh đo bằng font fallback (bề rộng khác Be Vietnam
    // Pro thật) rồi vẽ lệch cột, đặc biệt chữ có dấu tiếng Việt (i/ì/í/ỉ/ĩ/ị rộng khác nhau tuỳ font).
    await document.fonts.ready;
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Không tạo được canvas 2D context để ghép ảnh bill.');

  // Đo layout bảng TRƯỚC khi resize canvas.width/height bên dưới — gán canvas.width/height XOÁ TOÀN BỘ trạng
  // thái context hiện có (kể cả ctx.font vừa set), measureText() không phụ thuộc kích thước canvas thật nên
  // đo trên canvas mặc định (300x150) vẫn cho kết quả đúng — CÙNG cách renderBillTableImage() cũ đo trước khi
  // set kích thước canvas thật.
  ctx.font = MEASURE_FONT;
  const tableLayout = computeBillTableLayout(renderRows, (text) => ctx.measureText(text).width);

  const bitmap = await createImageBitmap(billImageSource);
  const compositeWidth = tableLayout.canvasWidth;
  const imageDrawHeight =
    bitmap.width > 0 && bitmap.height > 0 ? Math.round((bitmap.height / bitmap.width) * compositeWidth) : 0;
  const compositeHeight = imageDrawHeight + tableLayout.canvasHeight;

  // Vẽ ở độ phân giải x2 (SCALE) cho ảnh nét trên màn hình điện thoại retina — canvas.width/height thật =
  // kích thước * SCALE, rồi ctx.scale(SCALE, SCALE) để mọi toạ độ vẽ bên dưới vẫn dùng ĐÚNG số layout (không
  // cần nhân thủ công từng chỗ vẽ). CÙNG pattern renderBillTableImage() cũ.
  const SCALE = 2;
  canvas.width = compositeWidth * SCALE;
  canvas.height = compositeHeight * SCALE;
  ctx.scale(SCALE, SCALE);

  // Nền trắng toàn ảnh (khoảng đệm quanh bảng + viền ngoài ảnh bill nếu tỉ lệ lệch đôi chút do làm tròn px).
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, compositeWidth, compositeHeight);

  if (imageDrawHeight > 0) {
    ctx.drawImage(bitmap, 0, 0, compositeWidth, imageDrawHeight);
  }
  bitmap.close();

  drawBillTableAt(ctx, tableLayout, renderRows, 0, imageDrawHeight);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error('Không tạo được ảnh JPEG ghép bill (canvas.toBlob trả null).'));
      },
      'image/jpeg',
      0.9
    );
  });
  return { blob, billImageHeightPx: imageDrawHeight * SCALE };
}

export async function composeBillImage(
  billImageSource: Blob,
  rows: BillFieldDisplayRow[],
  amountText: string,
  /** B107-tiếp (2/8) — "Hoàn tiền" (số tiền sau phí), ĐÃ format sẵn (caller tự tính, module này KHÔNG tính
   * phí — CÙNG nguyên tắc amountText). `undefined` = KHÔNG hiện hàng này (giữ nguyên hành vi cũ cho caller
   * chưa nâng cấp/chưa có dữ liệu phí). */
  refundText?: string,
  /** B123 (2/8, FIX BUG THẬT Admin Demo phát hiện: "cảnh báo mã đóng lô rủi ro chỉ hiện lúc xem trước rồi mất
   * sau khi gửi") — câu cảnh báo `settlementRisk.message` (nếu có, ocr-bridge.ts checkSettlementRisk()) — LƯU
   * LẠI VĨNH VIỄN vào ảnh gửi đi bằng hàng `warning` màu đỏ, KHÔNG chỉ hiện thoáng qua trong
   * `BillSettlementRiskBanner` (React, chỉ tồn tại lúc xem preview). `undefined` = bill không có rủi ro đã
   * phát hiện, KHÔNG vẽ hàng này (giữ nguyên hành vi cũ cho bill hợp lệ). */
  settlementRiskWarning?: string,
  /** SIGMA 31/8 (feature "Quét bill gửi") — hàng grid PHỤ (vd "Phí bán" / "Phí cài máy" %), thêm SAU các
   *  field bill. Đại lý ↔ NĐT khác nhau (đại lý=phí bán, NĐT=phí cài) → truyền khác nhau. undefined = không thêm
   *  (giữ nguyên hành vi cũ cho mọi caller hiện tại). */
  extraGridRows?: { label: string; value: string; muted?: boolean }[]
): Promise<ComposeBillImageResult> {
  // B121 (2/8, "Phương án B — Lưới ô vuông") — "Tên Pos (HKD)" tách riêng thành 1 ô FULL-WIDTH (tên đại lý
  // thường dài nhất trong 7 field, xứng đáng cả hàng thay vì chung ô hẹp với field khác) — 6 field còn lại
  // (Ngân hàng/TID/Ngày/Giờ/Số lô/Số hóa đơn) xếp LƯỚI 2 CỘT. `rows` LUÔN đúng 7 phần tử ĐÚNG THỨ TỰ cố định
  // (buildBillFieldDisplayRows(), key thứ 2 luôn 'hkdName' — xem ocr-bill-fields-display.ts) nên tìm theo
  // `r.key === 'hkdName'` thay vì giả định vị trí, an toàn hơn nếu thứ tự đổi sau này.
  const hkdRow = rows.find((r) => r.key === 'hkdName');
  const gridFieldRows = rows.filter((r) => r.key !== 'hkdName');
  // [Admin Demo 8/9] THỨ TỰ MỚI của khối đối chiếu in trên ảnh bill:
  //   HKD (nổi XANH như số tiền) → TID · Ngày · Giờ · Số lô → SỐ TIỀN (+ Hoàn tiền) → Thẻ → Phí bán %.
  // Trước đây số tiền nằm trên cùng còn HKD chỉ là 1 dòng chữ thường → nhìn bill không biết ngay của HKD nào.
  const renderRows: BillTableRowInput[] = [
    ...(hkdRow ? [{ kind: 'hero' as const, label: 'HKD', value: hkdRow.text, color: 'amount' as const }] : []),
    // B123 — cảnh báo rủi ro đóng lô đặt SÁT ĐẦU (mức ưu tiên cao nhất, như banner trong màn xem trước).
    ...(settlementRiskWarning ? [{ kind: 'warning' as const, label: 'Cảnh báo', text: settlementRiskWarning, severity: 'danger' as const }] : []),
    ...gridFieldRows.map((r) => ({ kind: 'grid' as const, label: r.label, value: r.text, muted: r.muted })),
    { kind: 'hero', label: 'Số tiền', value: amountText, color: 'amount' },
    ...(refundText != null ? [{ kind: 'hero' as const, label: 'Hoàn tiền', value: refundText, color: 'refund' as const }] : []),
    ...(extraGridRows ?? []).map((r) => ({ kind: 'grid' as const, label: r.label, value: r.value, muted: r.muted ?? false }))
  ];
  return composeImageWithRows(billImageSource, renderRows);
}

// ── SIGMA (2/8, tính năng "Hoàn tiền" MỚI) — ghép ảnh biên lai chuyển khoản hoàn tiền + bảng kết quả OCR +
// trạng thái so khớp (CỘNG DỒN + đối chiếu Người nhận) — CÙNG kiến trúc composeBillImage() (canvas dùng chung
// composeImageWithRows()), KHÁC nội dung renderRows (5 field refund thay 6 field bill, 2 hero rows "Hoàn tiền
// lần này"/"Tổng đã hoàn", cảnh báo có thể NHIỀU HƠN 1 hàng — số tiền lệch VÀ/HOẶC tài khoản không khớp CÙNG
// lúc, xem RefundBillModal.tsx). */
export interface RefundImageWarningInput {
  label: string;
  text: string;
  severity: 'danger' | 'warning';
}

export async function composeRefundImage(
  refundImageSource: Blob,
  rows: RefundFieldDisplayRow[],
  /** Số tiền hoàn ĐÃ XÁC NHẬN lần này — ĐÃ format sẵn (caller tự tính). */
  thisTimeAmountText: string,
  /** "Đã hoàn: X/Y" — CÙNG hero row style "Hoàn tiền" bill gốc (nền xanh, CÙNG tông success đã dùng cho hero
   * "Hoàn tiền" bill gốc B111) — mức độ nghiêm trọng (thiếu/thừa) đã truyền đạt qua `warnings` (hàng riêng đỏ/
   * hổ phách bên dưới), hero này CHỈ hiển thị con số, KHÔNG cần đổi màu theo trạng thái (tránh 2 tín hiệu màu
   * chồng chéo trên cùng 1 bảng). `undefined` = ẩn hàng này (hiếm khi xảy ra, chỉ khi chưa tính được số phải
   * hoàn). */
  progressText: string | undefined,
  warnings: RefundImageWarningInput[]
): Promise<ComposeBillImageResult> {
  const renderRows: BillTableRowInput[] = [
    { kind: 'hero', label: 'Hoàn tiền (lần này)', value: thisTimeAmountText, color: 'amount' },
    ...(progressText != null ? [{ kind: 'hero' as const, label: 'Tổng cộng dồn', value: progressText, color: 'refund' as const }] : []),
    ...warnings.map((w) => ({ kind: 'warning' as const, label: w.label, text: w.text, severity: w.severity })),
    ...rows.map((r) => ({ kind: 'grid' as const, label: r.label, value: r.text, muted: r.muted }))
  ];
  return composeImageWithRows(refundImageSource, renderRows);
}

/** B112 (2/8) — Cắt phần TRÊN (ảnh bill gốc, KHÔNG lấy bảng) khỏi 1 ảnh ĐÃ GHÉP (`composeBillImage()` cũ) —
 * dùng khi "Sửa" bill đã gửi: tin nhắn CHỈ còn giữ ẢNH GHÉP cuối cùng (không lưu riêng ảnh gốc, xem comment
 * `ComposeBillImageResult` trên) nên phải cắt lại từ chính ảnh đã gửi. `heightPx` = `BillMessageMeta.
 * imageHeightPx` đã lưu lúc gửi lần đầu (bill-message-meta.ts) — cho biết CHÍNH XÁC ranh giới bill/bảng, KHÔNG
 * cần đoán lại. Trả JPEG Blob CÙNG bề rộng ảnh ghép gốc, cao đúng `heightPx` (clamp về `bitmap.height` nếu dữ
 * liệu cũ/hỏng cho giá trị lớn hơn ảnh thật — phòng thủ, KHÔNG throw ngay để vẫn cố hiển thị được gì đó). Dùng
 * làm `billImageSource` cho `composeBillImage()` MỚI (ghép lại với số tiền/bảng mới). CHỈ chạy được trình
 * duyệt thật (canvas), CÙNG giới hạn `composeBillImage()`. */
export async function cropTopOfImage(source: Blob, heightPx: number): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  const cropHeight = Math.max(1, Math.min(Math.round(heightPx), bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = cropHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Không tạo được canvas 2D context để cắt ảnh bill.');
  }
  ctx.drawImage(bitmap, 0, 0, bitmap.width, cropHeight, 0, 0, bitmap.width, cropHeight);
  bitmap.close();
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error('Không tạo được ảnh JPEG cắt bill (canvas.toBlob trả null).'));
      },
      'image/jpeg',
      0.92
    );
  });
}

// Chỉ loại ký tự THẬT SỰ không hợp lệ trong tên file (Windows nghiêm ngặt nhất: \/:*?"<>| + control char) —
// GIỮ khoảng trắng (Admin Demo cho ví dụ cụ thể "POS MB Thanh Toàn 2 - 57025362 - Lô 1 - 01/08/26", tên dễ đọc
// có khoảng trắng, KHÔNG viết liền như bản trước). Gộp nhiều khoảng trắng liên tiếp về 1 + trim 2 đầu.
// Hygiene fix tự phát hiện (1/8, audit trước khi báo cáo xong) — dải "control char" TRƯỚC ĐÂY bị gõ nhầm
// thành BYTE ĐIỀU KHIỂN THẬT (U+0000..U+001F) nằm trực tiếp trong source thay vì escape sequence `\x00-\x1f`
// — hành vi runtime giống hệt (KHÔNG phải bug logic, đã tự kiểm 2 lần bằng node -e trước/sau) nhưng khiến
// `grep`/`file`/1 số công cụ git nhận nhầm cả file là "binary" (tự phát hiện lúc audit — `grep` báo "Binary
// file ... matches" thay vì hiện dòng khớp bình thường). Đổi sang escape sequence chữ, an toàn hơn cho mọi
// tool xử lý file dạng text, hành vi không đổi.
function sanitizeFileNamePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** B106 (2/8, Admin Demo xác nhận LẶP LẠI 3 lần liên tiếp khi test thật) — mẫu ĐÃ CHỐT LẠI: "Tên Pos (HKD), TID,
 * Số lô, Ngày, Giờ" — dạng "POS <TênHKD> - <TID> - Lô <SốLô> - <Ngày> <Giờ>". SO VỚI mẫu 1/8 cũ ("POS
 * <NgânHàng> <TênHKD> - <TID> - Lô <SốLô> - <Ngày>"): BỎ tên ngân hàng (Admin Demo liệt kê danh sách field 3 lần
 * không có "ngân hàng"), THÊM giờ (đọc từ CÙNG field `dateTime` đã tách sẵn `splitDateTime()`, không cần field
 * mới). Tên HKD bóc bỏ tiền tố "HKD " (dùng LẠI `HKD_PREFIX_PATTERN` từ `ocr-bill-fields-display.ts` — CÙNG
 * regex đã áp cho phần HIỂN THỊ, KHÔNG viết lại logic strip lần 2). Ngày giữ format `dd-mm-yyyy` (đổi dấu `/`
 * gốc OCR sang `-` vì `/` KHÔNG hợp lệ trong tên file — dùng CHUNG cho cả tên file lẫn caption hiển thị để 2
 * nơi luôn khớp nhau, không lệch định dạng ngày). Giờ giữ nguyên `hh:mm:ss` từ OCR nhưng đổi `:` → `-` (KHÔNG
 * hợp lệ trong tên file Windows) CHỈ cho phần dùng làm filename — caption hiển thị (buildBillCaption) giữ
 * nguyên dấu `:` gốc (dễ đọc hơn, tên file không bị giới hạn đó). Trả về `null` (KHÔNG phải chuỗi fallback)
 * khi thiếu field/parse lỗi — CALLER tự quyết định fallback theo ngữ cảnh (filename vs caption khác fallback
 * nhau), tránh nhân đôi quyết định fallback ở đây. */
function buildBillLabelParts(
  hkdName: OcrBillFieldValue | null,
  tid: OcrBillFieldValue | null,
  batchNumber: OcrBillFieldValue | null,
  dateTime: OcrBillFieldValue | null
): { hkdPart: string; tidPart: string; batchPart: string; day: string; time: string } | null {
  if (!hkdName || !tid || !batchNumber || !dateTime) return null;

  const split = splitDateTime(dateTime.value);
  if (!split) return null;
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(split.date);
  if (!dateMatch) return null;
  const [, dd, mm, yyyy] = dateMatch;
  const day = `${dd}-${mm}-${yyyy}`;

  const hkdPart = sanitizeFileNamePart(hkdName.value.replace(HKD_PREFIX_PATTERN, ''));
  const tidPart = sanitizeFileNamePart(tid.value);
  const batchPart = sanitizeFileNamePart(batchNumber.value);
  // CHÚ Ý: KHÔNG dùng sanitizeFileNamePart() cho time — hàm đó xóa LUÔN dấu ":" (ký tự cấm trong tên file
  // Windows), nhưng ":" hợp lệ cho caption HIỂN THỊ (buildBillCaption giữ nguyên) — buildBillFileName() tự
  // đổi ":" → "-" RIÊNG lúc build tên file (bên dưới), không đụng ở đây. Chỉ lọc control char + gộp khoảng
  // trắng (KHÔNG đụng ký tự hợp lệ khác, kể cả ":").
  const time = split.time
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!hkdPart || !tidPart || !batchPart || !time) return null;

  return { hkdPart, tidPart, batchPart, day, time };
}

/** Đặt tên file ảnh ghép cuối cùng — xem `buildBillLabelParts()` cho mẫu. `fallbackTimestamp` dùng khi field
 * thiếu/parse lỗi (giữ NGUYÊN quy ước cũ "field thiếu → fallback tên cũ CHO CẢ FILE, không tạo tên nửa vời"). */
export function buildBillFileName(
  hkdName: OcrBillFieldValue | null,
  tid: OcrBillFieldValue | null,
  batchNumber: OcrBillFieldValue | null,
  dateTime: OcrBillFieldValue | null,
  fallbackTimestamp: number
): string {
  const parts = buildBillLabelParts(hkdName, tid, batchNumber, dateTime);
  if (!parts) return `bill-${fallbackTimestamp}.jpg`;
  const timeForFileName = parts.time.replace(/:/g, '-');
  return `POS ${parts.hkdPart} - ${parts.tidPart} - Lô ${parts.batchPart} - ${parts.day} ${timeForFileName}.jpg`;
}

/** B106 (2/8) — dòng chữ HIỂN THỊ dưới ảnh bill trong khung chat (message body), thay hẳn "Bill: <số tiền>đ"
 * cũ (Admin Demo xác nhận trực tiếp 3 lần: "thay dòng này bằng tên file đã thống nhất"). CÙNG mẫu
 * `buildBillFileName()` (field thiếu → fallback "Bill: <số tiền>đ" CŨ, giữ ít nhất còn số tiền dễ đọc thay vì
 * để trống/lỗi). `amountText` ĐÃ format sẵn (caller truyền, module này KHÔNG parse/format số — CÙNG nguyên tắc
 * `drawBillTableAt()`). */
export function buildBillCaption(
  hkdName: OcrBillFieldValue | null,
  tid: OcrBillFieldValue | null,
  batchNumber: OcrBillFieldValue | null,
  dateTime: OcrBillFieldValue | null,
  amountText: string
): string {
  const parts = buildBillLabelParts(hkdName, tid, batchNumber, dateTime);
  if (!parts) return `Bill: ${amountText}`;
  return `POS ${parts.hkdPart} - ${parts.tidPart} - Lô ${parts.batchPart} - ${parts.day} ${parts.time}`;
}
