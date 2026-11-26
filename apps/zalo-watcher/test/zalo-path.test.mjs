// Regression (Admin Demo 25/8) — KHOÁ bug "watcher chỉ quét cấu trúc CŨ, bỏ sót bill active resource/g<N>/picture".
// Chạy: node --test test/zalo-path.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveZaloGroupId, isBillCandidateFile, canonicalGroupId } from '../src/zalo-path.mjs';

test('canonicalGroupId chuẩn hoá mọi dạng về g<N>', () => {
  assert.equal(canonicalGroupId('123'), 'g123');
  assert.equal(canonicalGroupId('123_group'), 'g123');
  assert.equal(canonicalGroupId('g123'), 'g123');
  assert.equal(canonicalGroupId('  456_group '), 'g456');
  assert.equal(canonicalGroupId(''), null);
  assert.equal(canonicalGroupId(null), null);
  assert.equal(canonicalGroupId('lạ-không-số'), 'lạ-không-số'); // dạng lạ giữ nguyên
});

test('deriveZaloGroupId — cấu trúc ACTIVE (resource/g<N>/picture, groupId trong tên file)', () => {
  const p = 'C:/U/AppData/Roaming/ZaloData/media/698/ZaloDownloads/resource/gDEMOGROUP0000000004/picture/1787655941016_6606000467353336881_gDEMOGROUP0000000004_a5c4.jxl';
  assert.equal(deriveZaloGroupId(p), 'gDEMOGROUP0000000004');
  assert.equal(isBillCandidateFile(p), true);
});

test('deriveZaloGroupId — cấu trúc CŨ (picture/<N>_group) chuẩn hoá về g<N>', () => {
  const p = 'C:/x/ZaloDownloads/picture/1602514254983635361_group/z7944185084494_ee.jpg';
  assert.equal(deriveZaloGroupId(p), 'gDEMOGROUP0000000001');
  assert.equal(isBillCandidateFile(p), true);
});

test('deriveZaloGroupId — resource folder g<N> khi tên file không có token', () => {
  const p = 'C:/x/ZaloDownloads/resource/g555/picture/plainname.jxl';
  assert.equal(deriveZaloGroupId(p), 'g555');
});

test('isBillCandidateFile — loại thumbnail + file ngoài ZaloDownloads', () => {
  assert.equal(isBillCandidateFile('C:/x/ZaloDownloads/resource/g1/thumb/a_g1_b.jpg'), false);
  assert.equal(isBillCandidateFile('C:/x/ZaloDownloads/resource/g1/picture/a_g1_b.txt'), false); // ext không phải ảnh
  assert.equal(isBillCandidateFile('C:/x/Other/picture/a.jpg'), false); // ngoài ZaloDownloads
});

test('active + old CÙNG nhóm (numeric core) → CÙNG canonical', () => {
  const active = deriveZaloGroupId('C:/x/ZaloDownloads/resource/g777/picture/1_2_g777_h.jxl');
  const old = deriveZaloGroupId('C:/x/ZaloDownloads/picture/777_group/z1_h.jxl');
  assert.equal(active, old);
  assert.equal(active, 'g777');
});
