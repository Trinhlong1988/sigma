// REGRESSION (Admin Demo 6/9) — "re-scan folder LẠI OCR thay vì cache" = thất bại quy trình. readBillOrTransferConsensus
// (đường /ocr cho MỌI bill POS/CK/QR, auto+thủ công) trước đây LUÔN đọc lần 2 (noCache) để so chữ ký tiền → re-scan
// re-OCR toàn bộ. FIX: cache KẾT QUẢ ĐỒNG THUẬN → re-scan trả ngay từ cache, KHÔNG gọi claude. "Quét lại"(noCache) mới đọc mới.
// Khẳng định: (a) đã có cache consensus → gọi lại (không noCache) TRẢ CACHE, KHÔNG chạm claude (nhanh < 500ms);
// (b) noCache=true → BỎ cache (sẽ đọc mới — ở đây không gọi claude thật, chỉ khẳng định KHÔNG trả entry cache).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBillOrTransferConsensus, ocrCacheSet , CONSENSUS_CVAR_DEFAULT } from '../src/vision-ocr.mjs';

const CVAR = CONSENSUS_CVAR_DEFAULT(); // [21/9] variant THẬT từ source (ghép tag registry) — hardcode là test tự khen xanh khi variant đổi
function seed(buf, res) { ocrCacheSet('consensus', buf, res, CVAR); }

test('(a) re-scan (không noCache) HIT cache consensus → trả ngay, KHÔNG re-OCR', async () => {
  const buf = Buffer.from('bill-cache-hit-' + Date.now() + Math.random());
  const cached = { kind: 'POS', bills: [{ tid: '5350003', totalAmount: 12_345_000, type: 'SETTLEMENT' }], consensus: { ok: true } };
  seed(buf, cached);
  const t0 = Date.now();
  const r = await readBillOrTransferConsensus(buf, {}); // model mặc định sonnet → variant khớp
  const ms = Date.now() - t0;
  assert.equal(r.kind, 'POS');
  assert.equal(r.bills[0].tid, '5350003');
  assert.equal(r.consensus.ok, true);
  assert.ok(ms < 500, `phải trả từ cache tức thì (không gọi claude), nhưng mất ${ms}ms`);
});

test('(b) cache GIỮ cả cờ đỏ ok:false (lệch tiền) → re-scan vẫn hiện cờ, không re-OCR', async () => {
  const buf = Buffer.from('bill-flag-' + Date.now() + Math.random());
  const cached = { kind: 'POS', bills: [{ tid: '9', totalAmount: 1 }], consensus: { ok: false, first: 'a', second: 'b' } };
  seed(buf, cached);
  const r = await readBillOrTransferConsensus(buf, {});
  assert.equal(r.consensus.ok, false);
  assert.equal(r.consensus.first, 'a');
});

// ── [Phản biện 11/9] CACHE STALE SAU "QUÉT LẠI" — đọc-ép (noCache) thành công PHẢI GHI ĐÈ cache consensus.
// Bug gốc: force/Opus đọc ra số ĐÚNG nhưng không ghi cache → re-scan sau (không force) trả lại số SAI cũ →
// "sửa xong OCR lại ra thông số cũ" ở tầng cache (trước cả lớp bản-sửa-theo-ảnh, vốn chỉ cứu bill ĐÃ GỬI).
// _read = TEST SEAM (không spawn claude/daemon thật).
import { ocrCacheGet } from '../src/vision-ocr.mjs';

const cấm = async () => { throw new Error('KHÔNG được đọc lại — phải trả từ cache'); };

test('(c) "Quét lại" (noCache) đọc ra số MỚI → GHI ĐÈ cache; re-scan sau trả số MỚI, không re-OCR', async () => {
  const buf = Buffer.from('bill-stale-fix-' + Date.now() + Math.random());
  seed(buf, { kind: 'POS', bills: [{ tid: '5350003', totalAmount: 19_040_000, type: 'SETTLEMENT' }], consensus: { ok: true } }); // bản CŨ SAI (8→0)
  const đúng = { bills: [{ tid: '5350003', batchNumber: '165', totalAmount: 19_048_000, type: 'SETTLEMENT' }], transfers: [], kind: 'POS', failed: false };
  const r1 = await readBillOrTransferConsensus(buf, { noCache: true, _read: async () => đúng });
  assert.equal(r1.bills[0].totalAmount, 19_048_000, 'đọc-ép phải trả số mới');
  // Re-scan (không force, không seam): PHẢI trả từ cache số MỚI — _read=cấm chứng minh không đọc lại.
  const r2 = await readBillOrTransferConsensus(buf, { _read: cấm });
  assert.equal(r2.bills[0].totalAmount, 19_048_000, 'cache phải là bản MỚI (đã ghi đè), không phải 19.040.000 cũ');
});

test('(d) "Đọc lại bằng Opus" (model khác) → ghi đè CẢ variant MẶC ĐỊNH — đường re-scan Sonnet hết ôm entry độc', async () => {
  const buf = Buffer.from('bill-opus-heal-' + Date.now() + Math.random());
  seed(buf, { kind: 'POS', bills: [{ tid: '59930062', totalAmount: 1, type: 'SALE' }], consensus: { ok: true } }); // sonnet-variant cũ SAI
  const đúng = { bills: [{ tid: '59930002', batchNumber: '7', totalAmount: 5_000_000, type: 'SALE' }], transfers: [], kind: 'POS', failed: false };
  await readBillOrTransferConsensus(buf, { noCache: true, model: 'claude-opus-4-8', _read: async () => đúng });
  const r = await readBillOrTransferConsensus(buf, { _read: cấm }); // model mặc định (sonnet) — phải HIT bản Opus mới
  assert.equal(r.bills[0].tid, '59930002');
  assert.equal(r.bills[0].totalAmount, 5_000_000);
});

test('(e) chiều SAI: đọc-ép FAILED/UNKNOWN → KHÔNG được ghi đè cache tốt đang có', async () => {
  const buf = Buffer.from('bill-fail-keep-' + Date.now() + Math.random());
  const tốt = { kind: 'POS', bills: [{ tid: '5350003', totalAmount: 12_345_000, type: 'SETTLEMENT' }], consensus: { ok: true } };
  seed(buf, tốt);
  const hụt = { bills: [], transfers: [], kind: 'UNKNOWN', failed: true, failReason: 'OCR nghẽn' };
  const r1 = await readBillOrTransferConsensus(buf, { noCache: true, _read: async () => hụt });
  assert.equal(r1.failed, true, 'đọc-ép hụt phải báo hụt');
  assert.equal(ocrCacheGet('consensus', buf, CVAR).bills[0].totalAmount, 12_345_000, 'cache tốt phải GIỮ NGUYÊN (failed không được đè)');
  const r2 = await readBillOrTransferConsensus(buf, { _read: cấm });
  assert.equal(r2.bills[0].totalAmount, 12_345_000, 're-scan vẫn trả bản tốt');
});

// ── [Admin Demo 16/9 "đã quét rồi CHỈ xem cache, CẤM gọi lại API — chỉ bấm tay Quét lại mới đọc mới"] ──
// GỠ 2 cửa tự-đọc-lại ngầm: cache UNKNOWN (luật 8/9) + tự-lành statusText (11/9). Kết quả HỤT cũng cache
// (không đè bản tốt — luật (e) giữ nguyên). Đây chính là ca thật 16/9: bug vỏ Gemini đẻ hàng loạt UNKNOWN
// không-cache → "OCR lại folder chậm như quét từ đầu" (mỗi lần xem = đốt API lại).

test('(f) cache là UNKNOWN → VẪN trả cache, KHÔNG tự đọc lại (chỉ force mới đọc)', async () => {
  const buf = Buffer.from('bill-unknown-serve-' + Date.now() + Math.random());
  seed(buf, { kind: 'UNKNOWN', bills: [], transfers: [], failed: false, failReason: 'đọc không ra', consensus: { ok: true, singleRead: true } });
  const t0 = Date.now();
  const r = await readBillOrTransferConsensus(buf, { _read: cấm }); // _read nổ = có gọi API → FAIL
  assert.equal(r.kind, 'UNKNOWN');
  assert.equal(r.failReason, 'đọc không ra');
  assert.ok(Date.now() - t0 < 500, 'UNKNOWN phải trả từ cache tức thì');
});

test('(g) đọc ra HỤT (UNKNOWN, chưa có cache) → ĐƯỢC cache; lần xem sau không gọi API nữa', async () => {
  const buf = Buffer.from('bill-unknown-write-' + Date.now() + Math.random());
  let calls = 0;
  const đọcHụt = async () => { calls += 1; return { kind: 'UNKNOWN', bills: [], transfers: [], failed: false, failReason: 'mờ quá' }; };
  const r1 = await readBillOrTransferConsensus(buf, { _read: đọcHụt });
  assert.equal(r1.kind, 'UNKNOWN');
  const r2 = await readBillOrTransferConsensus(buf, { _read: cấm }); // lần 2 PHẢI từ cache
  assert.equal(r2.kind, 'UNKNOWN');
  assert.equal(r2.failReason, 'mờ quá');
  assert.ok(calls >= 1, 'lần đầu phải đọc thật');
  assert.equal(ocrCacheGet('consensus', buf, CVAR).kind, 'UNKNOWN', 'kết quả hụt phải nằm trong cache');
});

test('(h) client HỦY giữa chừng (signal aborted) → KHÔNG cache kết quả cụt', async () => {
  const buf = Buffer.from('bill-abort-nocache-' + Date.now() + Math.random());
  const ac = new AbortController(); ac.abort();
  await readBillOrTransferConsensus(buf, { signal: ac.signal, _read: async () => ({ kind: 'UNKNOWN', bills: [], transfers: [], failed: true, failReason: 'bị hủy' }) });
  assert.equal(ocrCacheGet('consensus', buf, CVAR), undefined, 'kết quả lúc hủy không được nằm vào cache');
});
