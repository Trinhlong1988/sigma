// [Admin Demo 10/9] Ảnh "Thông báo giao dịch VIB One Card" → hàng bill QR chưa biết HKD (khớp báo-có sau).
// Fixture = ĐÚNG nội dung ảnh thật Admin Demo gửi (10.500.000đ, 12:59 10/09/2026, KHACH HANG 15, thẻ 4238***9742).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapThongBaoTheSangQr, tienTuChuoi, moTaThe } from '../src/card-notice.mjs';

const ANH_THAT = [{
  amount: '10,500,000 VND', date: '10/09/2026', time: '12:59',
  cardHolder: 'KHACH HANG 15', cardLast4: '4238***9742', merchantHint: 'VIB QR PUSH', bank: 'VIB'
}];

test('ảnh thật → 1 hàng: tiền/ngày/giờ/tên chủ thẻ đúng, HKD và số GD để TRỐNG', () => {
  const [q] = mapThongBaoTheSangQr(ANH_THAT);
  assert.equal(q.amount, 10500000);
  assert.equal(q.date, '10/09/2026');
  assert.equal(q.time, '12:59');
  assert.equal(q.payerName, 'KHACH HANG 15');
  assert.equal(q.fromCard, 'VIB ••••9742');
  assert.equal(q.noticeMerchant, 'VIB QR PUSH');
  assert.equal(q.noticeOnly, true);
  assert.equal(q.hkdName, null, 'CẤM đoán tên HKD từ ảnh này');
  assert.equal(q.ref, null, 'CẤM đoán số giao dịch từ ảnh này');
});

test('không có tiền → bỏ hàng (không đối soát được gì)', () => {
  assert.deepEqual(mapThongBaoTheSangQr([{ amount: '', cardHolder: 'A' }]), []);
  assert.deepEqual(mapThongBaoTheSangQr(null), []);
});

test('tiền đọc từ chuỗi: bỏ dấu phân cách, không làm tròn sai', () => {
  assert.equal(tienTuChuoi('10.500.000đ'), 10500000);
  assert.equal(tienTuChuoi('49,805,000 VND'), 49805000);
  assert.equal(tienTuChuoi('abc'), 0);
});

test('mô tả thẻ: thiếu bank/last4 vẫn không vỡ', () => {
  assert.equal(moTaThe('VIB', '4238***9742'), 'VIB ••••9742');
  assert.equal(moTaThe(null, '9742'), '••••9742');
  assert.equal(moTaThe('MB', ''), 'MB');
  assert.equal(moTaThe(null, null), null);
});
