// [KHOÁ CHỐNG TÁI DIỄN 12/9 — Admin Demo "chống tái diễn chặt chẽ"] Lớp bug "prompt bảo model đọc field X nhưng
// mapper whitelist VỨT CÂM X" (statusText #p4, 11/9 — 40 bill prod 0/40 có field). Test bóc JSON template trong
// prompt → bơm object đủ mọi key qua mapper → key nào biến mất = ĐỎ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapTransferFields, mapQrFields, PROMPT_CACHE_REGISTRY } from '../src/vision-ocr.mjs';

/** Bóc DANH SÁCH KEY của object mẫu ĐẦU TIÊN trong JSON template của prompt (dòng {"x":[{...}]}). */
function templateKeys(prompt) {
  const m = prompt.match(/\{"[a-zA-Z]+":\[\{([\s\S]*?)\}\]\}/);
  assert.ok(m, 'prompt phải có JSON template {"kind":[{...}]}');
  return [...m[1].matchAll(/"([a-zA-Z0-9_]+)":/g)].map((x) => x[1]);
}
function sampleFrom(keys) {
  const o = {};
  for (const k of keys) o[k] = k === 'amount' ? 12345 : `GIA_TRI_${k}`;
  return o;
}

test('TRANSFER: mọi key trong prompt template PHẢI sống sót qua mapTransferFields', () => {
  const keys = templateKeys(PROMPT_CACHE_REGISTRY.transfer.prompt);
  assert.ok(keys.includes('statusText'), 'prompt #p5 phải còn statusText');
  const out = mapTransferFields(sampleFrom(keys));
  for (const k of keys) assert.ok(out[k] !== undefined, `mapTransferFields VỨT CÂM key "${k}" (lớp bug statusText #p4)`);
});

test('QR: mọi key trong prompt template PHẢI sống sót qua mapQrFields', () => {
  const keys = templateKeys(PROMPT_CACHE_REGISTRY.qr.prompt);
  const out = mapQrFields(sampleFrom(keys));
  for (const k of keys) assert.ok(out[k] !== undefined, `mapQrFields VỨT CÂM key "${k}"`);
});
