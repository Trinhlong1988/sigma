// Test PHÂN LOẠI ảnh bill bằng chữ (thay cho "ai đọc trước thì thắng").
// BUG THẬT 8/9 (Admin Demo): bill QR 20.650.000 bị báo "không phải bill QR — OCR ra bill POS".
// Fixture = text RapidOCR THẬT của bill QR (đã đối chiếu mắt) + text đại diện bill POS/CK.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBillLines } from '../src/local-bill-classify.mjs';

const L = (t) => ({ t });

const QR_THAT = [
  L('Thanh toan thanh cong'), L('So tièn'), L('29,998,000'), L('Nha cung cap'), L('HKD DEMO 40 Ha..'),
  L('Ngay thuc hien'), L('08:58 08/09/2026'), L('So giao dich'), L('6251VNIB024PKM8D'), L('Tur'), L('VIBRewards·..·O708')
];
const QR_FULL_MAN = [L('Hoa don'), L('Thanh toan thanh cong'), L('Chia se'), L('So tièn'), L('20,650,000'), L('Nha cung cap'), L('HKDTRAMYNGUYENHaNoi'), L('So giao dich'), L('6251VNIB024PXE5V')];
const POS = [L('MB BANK'), L('MERCHANT: HKD ABC'), L('TID 20281008'), L('MID 123456'), L('SO LO 000028'), L('SETTLEMENT - KET TOAN'), L('TONG CONG 14,000')];
const CK = [L('Chuyen tien thanh cong'), L('Nguoi nhan'), L('NGUYEN VAN A'), L('So tai khoan'), L('0123456789'), L('Noi dung chuyen khoan'), L('hoan tien dai ly')];

test('bill QR (ảnh cắt sát) → QR', () => {
  const r = classifyBillLines(QR_THAT);
  assert.equal(r.kind, 'QR');
  assert.ok(r.scores.QR > r.scores.POS);
});

test('bill QR chụp full màn (có "Hoá đơn"/"Chia sẻ") → QR — chính ca bill 20.650.000', () => {
  assert.equal(classifyBillLines(QR_FULL_MAN).kind, 'QR');
});

test('bill POS (TID/SỐ LÔ/SETTLEMENT) → POS, KHÔNG nhầm QR', () => {
  const r = classifyBillLines(POS);
  assert.equal(r.kind, 'POS');
  assert.equal(r.scores.QR, 0);
});

test('bill chuyển khoản → CK', () => {
  assert.equal(classifyBillLines(CK).kind, 'CK');
});

test('ảnh không có dấu hiệu nào → null (KHÔNG đoán, tầng trên giữ cách cũ)', () => {
  assert.equal(classifyBillLines([L('anh chup man hinh'), L('abc xyz')]).kind, null);
  assert.equal(classifyBillLines([]).kind, null);
});

test('điểm hoà nhau → null (không dám chốt)', () => {
  const hoa = [L('So lo'), L('Nha cung cap')]; // 1 dấu hiệu đặc trưng mỗi bên
  assert.equal(classifyBillLines(hoa).kind, null);
});

// [Admin Demo 10/9 — ảnh email VIB "Thông báo giao dịch VIB One Card"] Ảnh phía CHỦ THẺ (email/SMS ngân hàng), KHÔNG
// có tên HKD, KHÔNG có Số giao dịch → trước đây rơi nhánh POS rồi bị lọc vứt CÂM ("không OCR ra ở QR").
const THONG_BAO_THE = [
  L('Thong bao giao dich the tin dung'), L('Ngan Hang Quoc Te (VIB)'), L('Thong bao giao dich VIB One Card'),
  L('Kinh gui Quy khach hang'), L('So the: 4238***9742'), L('Chu the: KHACH HANG 15'),
  L('Giao dich: Thanh toan dich vu - hang hoa'), L('Gia tri: 10,500,000 VND'), L('Vao luc: 12:59 10/09/2026'), L('Tai VIB QR PUSH')
];

test('email thông báo giao dịch thẻ → CARD_NOTICE (không nhầm POS/QR)', () => {
  const r = classifyBillLines(THONG_BAO_THE);
  assert.equal(r.kind, 'CARD_NOTICE');
  assert.ok(r.scores.CARD_NOTICE > r.scores.POS);
  assert.ok(r.scores.CARD_NOTICE > r.scores.QR);
});

test('bill POS in "SỐ THẺ"/"CHỦ THẺ" vẫn là POS (không kéo sang CARD_NOTICE)', () => {
  const pos = [L('TID 20280818'), L('SO LO 000177'), L('SO THE 4238xxxx9742'), L('CHU THE NGUYEN VAN A'), L('TONG CONG 10,500,000')];
  assert.equal(classifyBillLines(pos).kind, 'POS');
});
