// [Admin Demo 16/9 "CẤM TÁI DIỄN MỌI OCR"] Canh OCR máy (RapidOCR daemon) KHÔNG BAO GIỜ sống lại.
// 3 lớp: (1) nguồn phải còn khoá cứng `const OCR_MAY_BAT = false` (không env, không cờ);
// (2) warmLocalOcr() phải trả false (không spawn python); (3) readQrBillLocal() phải trả null
// và localOcrDangSong() vẫn false sau khi gọi (không tiến trình daemon nào được tạo).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { readQrBillLocal, localOcrDangSong, warmLocalOcr } from '../src/vision-ocr.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'vision-ocr.mjs');

test('nguồn còn khoá cứng OCR_MAY_BAT = false (cấm đổi sang env/cờ)', () => {
  const s = readFileSync(SRC, 'utf8');
  assert.match(s, /const OCR_MAY_BAT = false/, 'OCR_MAY_BAT phải là hằng false — lệnh Admin Demo 16/9 cấm tái diễn mọi OCR máy');
  assert.doesNotMatch(s, /OCR_MAY_BAT = process\.env/, 'CẤM gắn OCR_MAY_BAT vào env — đó là cửa hồi sinh');
});

test('warmLocalOcr trả false — không spawn daemon python', async () => {
  assert.equal(await warmLocalOcr(), false);
  assert.equal(localOcrDangSong(), false);
});

test('readQrBillLocal trả null + không daemon nào được tạo', async () => {
  const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).png().toBuffer();
  assert.equal(await readQrBillLocal(png), null);
  assert.equal(localOcrDangSong(), false);
});
