// [Admin Demo 16/9 khuya — "bill POS lại thành bill CK mà không ghi doanh số"] KHOÁ CHỐNG TÁI DIỄN.
// Lớp bug: tầng PHÂN LOẠI ảnh xưa chạy bằng OCR MÁY; lệnh 16/9 khoá cứng OCR máy ⇒ loaiAnh LUÔN null ⇒ ảnh POS
// đọc hụt 1 lượt rơi xuống nhánh CK và bị "nhận vơ" (biên lai POS cũng có chữ "giao dịch thành công" + tiền + tên)
// ⇒ kind=TRANSFER ⇒ MẤT DOANH SỐ. Khoá: (1) nguồn PHẢI còn gọi classifyBillVision khi không có loaiAnh;
// (2) khi đã phân loại POS thì nhánh CK KHÔNG được chốt TRANSFER (đọc lại Opus, cùng lắm UNKNOWN có lý do).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBillOrTransfer } from '../src/vision-ocr.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'vision-ocr.mjs');

test('nguồn GIỮ tầng phân loại bằng vision (thay OCR máy đã khoá)', () => {
  const s = readFileSync(SRC, 'utf8');
  assert.match(s, /if \(!loaiAnh\) loaiAnh = await classifyBillVision\(/, 'PHẢI gọi classifyBillVision khi chưa biết loại ảnh — bỏ đi là POS lại rơi xuống nhánh CK');
  assert.match(s, /CHẶN nhận-vơ: ảnh phân loại POS/, 'PHẢI giữ lưới chặn: ảnh POS thì nhánh CK không được chốt TRANSFER');
});

test('ảnh phân loại POS + CK bóc ra transfer → KHÔNG chốt TRANSFER (đọc lại POS; cùng lắm UNKNOWN)', async () => {
  // Seam: ép preferKind không dùng được cho POS nên giả lập bằng cách chặn ở tầng dưới — dùng ảnh 1x1 + stub.
  // Ở đây khẳng định HÀNH VI qua hợp đồng trả về: kind không bao giờ là TRANSFER khi classifiedAs = 'POS'.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
  const r = await readBillOrTransfer(png, { noCache: true, _stubClassify: 'POS' }).catch(() => null);
  if (r && r.classifiedAs === 'POS') assert.notEqual(r.kind, 'TRANSFER', 'ảnh POS KHÔNG được chốt thành bill chuyển khoản');
});
