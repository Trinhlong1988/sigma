// [Phản biện 11/9 — BUG CONFIRMED statusText chết câm] Prompt TRANSFER #p4 thêm statusText ("chỉ bill THÀNH CÔNG
// mới được tính") nhưng map kết quả trong ocrTransfer VỨT field (không có trong whitelist) → 100% bill CK tới
// bot-api thiếu statusText → cờ ⚠ nổi oan mọi bill + gate mất hết tín hiệu (thành công/thất bại cùng 1 cờ).
// Vá 3 tầng: (1) mapTransferFields export + giữ statusText; (2) bump cache transfer #p4→#p5 (entry #p4 nhiễm);
// (3) cache consensus #cons1 KHÔNG bump → self-heal: entry TRANSFER thiếu field statusText → vứt, đọc lại.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapTransferFields, readBillOrTransferConsensus, ocrCacheSet , CONSENSUS_CVAR_DEFAULT } from '../src/vision-ocr.mjs';

test('(1) mapTransferFields GIỮ statusText (bug gốc: field bị vứt)', () => {
  const t = mapTransferFields({ receiverName: 'KHACH HANG 01', amount: '5.000.000', ref: 'FT2609X', statusText: ' Chuyển tiền thành công ' });
  assert.equal(t.statusText, 'Chuyển tiền thành công'); // trim, còn sống qua map
  assert.equal(t.amount, 5000000);
  assert.equal(t.ref, 'FT2609X');
});

test('(1b) không có statusText trên bill → null tường minh (đã-đọc-không-thấy), KHÔNG undefined', () => {
  const t = mapTransferFields({ receiverName: 'A', amount: 1000, statusText: '' });
  assert.equal(t.statusText, null);
  assert.ok('statusText' in t, 'field phải TỒN TẠI (phân biệt với cache cũ chưa từng đọc)');
});

const CVAR = CONSENSUS_CVAR_DEFAULT(); // [21/9] variant THẬT từ source (ghép tag registry) — hardcode là test tự khen xanh khi variant đổi
const cấm = async () => { throw new Error('KHÔNG được đọc lại — phải trả từ cache'); };

test('(3) [ĐẢO LUẬT 16/9 Admin Demo "cấm gọi lại API ngầm"] entry TRANSFER thiếu statusText → VẪN trả cache (hết tự-lành), Quét lại tay mới đọc mới', async () => {
  // Luật cũ 11/9: entry thiếu statusText → VỨT cache tự đọc lại (self-heal). Admin Demo 16/9 CẤM MỌI gọi API ngầm
  // khi xem lại → bỏ self-heal; entry cổ hiện cờ ⚠ cho tới khi người dùng TỰ bấm Quét lại (noCache) — test (3c2).
  const buf = Buffer.from('ck-statusfield-heal-' + Date.now() + Math.random());
  ocrCacheSet('consensus', buf, { kind: 'TRANSFER', bills: [], transfers: [{ receiverName: 'KETOAN', amount: 5_000_000, ref: 'FT111' }], consensus: { ok: true } }, CVAR);
  const r = await readBillOrTransferConsensus(buf, { _read: cấm }); // cấm nổ = có gọi API ngầm → FAIL
  assert.equal(r.transfers[0].ref, 'FT111', 'phải trả đúng bản cache (kể cả thiếu statusText)');
  // Quét lại TAY (noCache) → đọc mới có statusText + ghi đè cache.
  const moi = { bills: [], transfers: [{ receiverName: 'KETOAN', amount: 5_000_000, ref: 'FT111', statusText: 'Giao dịch thành công' }], kind: 'TRANSFER', failed: false };
  const r2 = await readBillOrTransferConsensus(buf, { noCache: true, _read: async () => moi });
  assert.equal(r2.transfers[0].statusText, 'Giao dịch thành công', 'Quét lại tay phải ra bản mới');
});

test('(3b) KHÔNG heal bừa: entry TRANSFER ĐÃ CÓ statusText (kể cả null tường minh) → vẫn trả cache, không re-OCR', async () => {
  const buf = Buffer.from('ck-statusfield-keep-' + Date.now() + Math.random());
  ocrCacheSet('consensus', buf, { kind: 'TRANSFER', bills: [], transfers: [{ receiverName: 'KETOAN', amount: 5_000_000, ref: 'FT222', statusText: null }], consensus: { ok: true } }, CVAR);
  const r = await readBillOrTransferConsensus(buf, { _read: cấm }); // cấm chứng minh không đọc lại
  assert.equal(r.transfers[0].ref, 'FT222');
});

test('(3c) entry POS không liên quan → vẫn trả cache như cũ (không đụng đường POS)', async () => {
  const buf = Buffer.from('pos-statusfield-noop-' + Date.now() + Math.random());
  ocrCacheSet('consensus', buf, { kind: 'POS', bills: [{ tid: '5350003', totalAmount: 1_000_000, type: 'SALE' }], transfers: [], consensus: { ok: true } }, CVAR);
  const r = await readBillOrTransferConsensus(buf, { _read: cấm });
  assert.equal(r.bills[0].tid, '5350003');
});
