// [Admin Demo 28/9 — bill VPBank "TID: R3600138"] KHOÁ: TID có CHỮ CÁI phải giữ nguyên.
//
// LỖI THẬT: máy VPBank mới thêm có TID "R3600138". Code chuẩn hoá strip `[^0-9]` ⇒ còn "3600138" ⇒ không
// khớp máy nào ⇒ mỗi lần quét đều bắn cảnh báo "OCR đọc TID 3600138 KHÔNG có trong hệ thống — đã SUY từ tên
// HKD DEMO 36", bắt người dùng tự xác nhận, dễ gửi nhầm máy.
// Prompt cũng góp phần: viết "tid = SỐ ngay sau TID:" nên model có xu hướng bỏ chữ.
//
// LUẬT: nhận dạng <=3 chữ cái đầu + 6..12 chữ số thì GIỮ NGUYÊN; chuỗi khác dạng đó (rác OCR như
// "53550076/SEQ:000647") vẫn rơi về hành vi cũ "chỉ chữ số" — không nới lỏng cho rác.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chuanHoaTid } from '../src/vision-ocr.mjs';

test('TID VPBank có chữ đầu → GIỮ NGUYÊN (ca thật R3600138)', () => {
  assert.equal(chuanHoaTid('R3600138'), 'R3600138');
  assert.equal(chuanHoaTid('r3600138'), 'R3600138');    // OCR trả chữ thường
  assert.equal(chuanHoaTid(' R3600138 '), 'R3600138');
  assert.equal(chuanHoaTid('R 3600138'), 'R3600138');   // OCR chèn khoảng trắng
});

test('TID thuần số vẫn như cũ', () => {
  assert.equal(chuanHoaTid('53550076'), '53550076');
  assert.equal(chuanHoaTid('DEMO-TID-01'), 'DEMO-TID-01');
});

test('rác OCR dính SEQ → KHÔNG thành mã chữ+số bừa, rơi về chỉ-số như cũ', () => {
  // hành vi CŨ giữ nguyên: bỏ ký tự không phải số rồi CẮT CÒN 12 ký tự
  assert.equal(chuanHoaTid('53550076/SEQ:000647'), '600000000005');
  assert.equal(chuanHoaTid('TID:53550076'), '53550076');
});

test('rỗng / không đọc được → null', () => {
  assert.equal(chuanHoaTid(''), null);
  assert.equal(chuanHoaTid(null), null);
  assert.equal(chuanHoaTid('   '), null);
});

test('chuỗi TOÀN CHỮ không được nhận làm TID', () => {
  assert.equal(chuanHoaTid('KHONGDOCDUOC'), null);
});
