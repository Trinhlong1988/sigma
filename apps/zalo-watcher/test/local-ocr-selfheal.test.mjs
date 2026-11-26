// [Admin Demo 11/9 — dọn nợ 3] LUẬT TREO THEO IM LẶNG. Bài học kép: test cũ từng KHOÁ ĐÚNG CON BUG
// (assert "3 việc chờ → không treo" trong khi chính điều đó làm daemon treo thật không bao giờ bị giết khi client
// quét 3 ảnh song song — phản biện #4 đo: 120s, 0 lần giết). Test mới khoá đúng bản chất: IM LẶNG + có việc = treo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { laDaemonTreo, LOCAL_OCR_TIMEOUT_MS, LOCAL_OCR_SILENCE_MS, LOCAL_OCR_MAX_CHO } from '../src/vision-ocr.mjs';

test('mốc: im lặng 12s = treo · trần chờ 2 việc · quá hạn tổng 40s', () => {
  assert.equal(LOCAL_OCR_SILENCE_MS, 12000);
  assert.equal(LOCAL_OCR_MAX_CHO, 2);
  assert.equal(LOCAL_OCR_TIMEOUT_MS, 40000);
});

test('TREO khi im lặng quá ngưỡng — BẤT KỂ bao nhiêu việc đang chờ (3 ảnh song song vẫn phải giết)', () => {
  assert.equal(laDaemonTreo({ imLangMs: 12000, soViecDangCho: 1 }), true);
  assert.equal(laDaemonTreo({ imLangMs: 12000, soViecDangCho: 3 }), true, 'luật cũ tha ca này → daemon treo sống mãi');
  assert.equal(laDaemonTreo({ imLangMs: 60000, soViecDangCho: 5 }), true);
});

test('KHÔNG treo: daemon còn phát tín hiệu (im < ngưỡng) hoặc không có việc nào chờ', () => {
  assert.equal(laDaemonTreo({ imLangMs: 3000, soViecDangCho: 3 }), false, 'đang xếp hàng nhưng còn nhả tín hiệu');
  assert.equal(laDaemonTreo({ imLangMs: 999999, soViecDangCho: 0 }), false, 'rảnh thì im bao lâu cũng kệ');
  assert.equal(laDaemonTreo({ imLangMs: 11999, soViecDangCho: 2 }), false);
});
