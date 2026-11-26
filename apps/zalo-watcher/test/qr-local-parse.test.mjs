// Test bóc trường bill QR từ OCR LOCAL. FIXTURE = text THẬT do RapidOCR đọc 3 ảnh bill QR ngày 8/9
// (đối chiếu MẮT: 29.998.000 / 20.550.000 / 22.030.000) — không bịa dữ liệu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQrBillLines, diffQrReads, normLabel } from '../src/qr-local-parse.mjs';

/** helper: dựng dòng OCR {y,x,y2,x2,t,s} cho gọn. */
const L = (y, x, t, s = 0.97, h = 40) => ({ y, x, y2: y + h, x2: x + 300, t, s });

// Ảnh 1 — TÊN HKD BỊ APP CẮT ("HKD DEMO 40 Ha..") → chính ca làm chết OCR ngày 8/9.
const ANH1 = [
  L(568, 167, 'Thanh toan thanh cong'),
  L(766, 50, 'So tièn', 0.78), L(771, 716, '29,998,000 ', 0.96),
  L(928, 53, 'Nha cung cap', 0.99), L(929, 414, 'HKD DEMO 40 Ha..', 0.92),
  L(1136, 55, 'Ngay thuc hien', 0.96), L(1134, 607, '08:58 08/09/2026', 0.96),
  L(1287, 53, 'So giao dich', 0.95), L(1293, 553, '6251VNIB024PKM8D', 0.99),
  L(1443, 52, 'Tur', 0.88), L(1448, 508, 'VIBRewards·..·O708', 0.85)
];

// Ảnh 2 — chụp full màn (có "Hoa don"/"Chia se"), tên HKD ĐỦ nhưng OCR dính chữ; ngày+giờ DÍNH LIỀN.
const ANH2 = [
  L(154, 366, 'Hoa don'), L(417, 186, 'Thanh toan thanh cong'), L(522, 400, 'Chia se'),
  L(658, 33, 'So tièn', 0.82), L(660, 633, '20,550,000 g', 0.97),
  L(763, 35, 'Nha cung cap', 0.99), L(767, 407, 'HKDTRAMYNGUYENHaNoi', 0.99),
  L(900, 37, 'Ngay thuc hien', 0.97), L(900, 564, '08:5308/09/2026', 0.98),
  L(998, 35, 'So giao dich', 0.97), L(1004, 532, '6251VNIB024PGSSN', 0.99),
  L(1105, 497, 'VIBRewards·...5573', 0.90)
];

test('normLabel bỏ dấu + gộp: nhãn OCR đọc lệch dấu vẫn khớp', () => {
  assert.equal(normLabel('Số tiền'), 'sotien');
  assert.equal(normLabel('So tièn'), 'sotien');
  assert.equal(normLabel('Ngày thực hiện'), 'ngaythuchien');
});

test('ảnh 1 (tên HKD bị cắt): VẪN ra bill, tiền/ngày/giờ/số GD đúng, cảnh báo TEN_HKD_BI_CAT', () => {
  const r = parseQrBillLines(ANH1);
  assert.equal(r.isQr, true);
  assert.equal(r.qr.amount, 29998000);
  assert.equal(r.qr.date, '08/09/2026');
  assert.equal(r.qr.time, '08:58');
  assert.equal(r.qr.ref, '6251VNIB024PKM8D');
  assert.equal(r.qr.hkdName, 'HKD DEMO 40 Ha'); // giữ phần đọc được, KHÔNG rỗng
  assert.equal(r.qr.hkdTruncated, true);
  assert.ok(r.warnings.includes('TEN_HKD_BI_CAT'));
  // Tên bị cắt là do ẢNH, Claude đọc lại cũng không hơn → KHÔNG tốn lượt Claude.
  assert.equal(r.needsClaude, false);
});

test('ảnh 2 (ngày giờ dính liền): tách đúng giờ và ngày', () => {
  const r = parseQrBillLines(ANH2);
  assert.equal(r.isQr, true);
  assert.equal(r.qr.amount, 20550000);
  assert.equal(r.qr.time, '08:53');
  assert.equal(r.qr.date, '08/09/2026');
  assert.equal(r.qr.ref, '6251VNIB024PGSSN');
  assert.equal(r.needsClaude, false);
});

test('CỔNG TIỀN: số tiền đọc không chắc → cảnh báo + BẮT BUỘC đọc lại bằng Claude', () => {
  const lines = ANH2.map((l) => (l.t === '20,550,000 g' ? { ...l, s: 0.62 } : l));
  const r = parseQrBillLines(lines);
  assert.ok(r.warnings.includes('SO_TIEN_DOC_KHONG_CHAC'));
  assert.equal(r.needsClaude, true);
});

test('CỔNG TIỀN: số tiền lẻ bất thường (không tròn nghìn) → đọc lại bằng Claude', () => {
  const lines = ANH2.map((l) => (l.t === '20,550,000 g' ? { ...l, t: '20,550,007 g' } : l));
  const r = parseQrBillLines(lines);
  assert.ok(r.warnings.includes('SO_TIEN_LE_BAT_THUONG'));
  assert.equal(r.needsClaude, true);
});

test('CỔNG TIỀN: số giao dịch sai dạng (quá ngắn) → đọc lại bằng Claude', () => {
  const lines = ANH2.map((l) => (l.t === '6251VNIB024PGSSN' ? { ...l, t: '6251VN' } : l));
  const r = parseQrBillLines(lines);
  assert.ok(r.warnings.includes('SO_GIAO_DICH_SAI_DANG'));
  assert.equal(r.needsClaude, true);
});

test('THIẾU số tiền → cảnh báo thiếu + đọc lại', () => {
  const r = parseQrBillLines(ANH2.filter((l) => l.t !== '20,550,000 g'));
  assert.ok(r.warnings.includes('THIEU_SO_TIEN'));
  assert.equal(r.needsClaude, true);
});

test('KHÔNG phải bill QR (bill POS) → isQr=false, không tốn lượt Claude cho QR', () => {
  const pos = [L(100, 50, 'MB BANK'), L(200, 50, 'TID 20281008'), L(300, 50, 'SO LO 000028'), L(400, 50, 'TONG CONG 14,000')];
  const r = parseQrBillLines(pos);
  assert.equal(r.isQr, false);
  assert.equal(r.needsClaude, false);
});

// [Admin Demo 8/9 — cảnh báo GIẢ đã gặp thật: "local 0 ≠ Claude 38.020.000"] Local KHÔNG đọc được = THIẾU, không
// phải LỆCH. Báo đỏ ở ca này làm nhiễu và bào mòn niềm tin vào cờ đỏ thật.
test('diffQrReads: local KHÔNG đọc được trường → KHÔNG báo lệch (chỉ thiếu)', () => {
  const claude = { amount: 38020000, ref: '6251VNIB024PPQ28', date: '08/09/2026', time: '10:47' };
  assert.deepEqual(diffQrReads({ amount: 0, ref: null, date: null, time: null }, claude), []);
  assert.deepEqual(diffQrReads({ ...claude, amount: 0 }, claude), []);
  assert.deepEqual(diffQrReads({ ...claude, ref: '' }, claude), []);
});

test('diffQrReads bắt lệch 2 lần đọc trên trường TIỀN', () => {
  const a = { amount: 29998000, ref: '6251VNIB024PKM8D', date: '08/09/2026', time: '08:58' };
  assert.deepEqual(diffQrReads(a, a), []);
  const b = { ...a, amount: 29988000 };
  assert.equal(diffQrReads(a, b).length, 1);
  const c = { ...a, ref: '6251VNIB024PKM8O' };
  assert.ok(diffQrReads(a, c)[0].startsWith('số GD'));
});
