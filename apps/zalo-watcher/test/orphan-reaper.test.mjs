// REGRESSION (Admin Demo 6/9) — root-cause kẹt OCR = claude orphan (SIGKILL giết cmd wrapper, claude con sống nền, tích
// tụ zombie → ngốn hạn mức API → treo). Backstop reaper giết claude.exe có PARENT ĐÃ CHẾT. Khẳng định hàm thuần
// findOrphanClaudePids: (a) claude parent chết = orphan → giết; (b) claude parent SỐNG (phiên đang dùng) = GIỮ;
// (c) không nhầm process khác; (d) parse CSV wmic thật (dòng header/rỗng bỏ qua).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOrphanClaudePids } from '../src/vision-ocr.mjs';

// mô phỏng output `wmic process get ProcessId,ParentProcessId,Name /format:csv`: Node,Name,ParentProcessId,ProcessId
const csv = [
  'Node,Name,ParentProcessId,ProcessId',
  'HOST,cmd.exe,111,1000',              // cmd sống (parent của phiên claude sống)
  'HOST,claude.exe,1000,1001',          // parent 1000 SỐNG → phiên đang dùng → GIỮ
  'HOST,claude.exe,9999,2002',          // parent 9999 KHÔNG có trong danh sách (CHẾT) → ORPHAN
  'HOST,claude.exe,8888,2003',          // parent 8888 CHẾT → ORPHAN
  'HOST,node.exe,111,3003',             // process khác, parent chết → KHÔNG phải claude → bỏ qua
  '',                                    // dòng rỗng
].join('\n');

test('(a)(b) orphan = claude parent chết; GIỮ claude parent sống', () => {
  const orphans = findOrphanClaudePids(csv);
  assert.deepEqual(orphans.sort(), ['2002', '2003']);      // 2 orphan
  assert.ok(!orphans.includes('1001'));                     // phiên sống KHÔNG bị giết
});

test('(c) không nhầm process không phải claude.exe', () => {
  const orphans = findOrphanClaudePids('Node,Name,ParentProcessId,ProcessId\nH,node.exe,9999,5005');
  assert.deepEqual(orphans, []);                            // node.exe parent chết ≠ claude → không đụng
});

test('(d) input rỗng/hỏng → [] (không ném)', () => {
  assert.deepEqual(findOrphanClaudePids(''), []);
  assert.deepEqual(findOrphanClaudePids(null), []);
  assert.deepEqual(findOrphanClaudePids(undefined), []);
});

test('mọi parent đều sống → 0 orphan (không giết oan phiên nào)', () => {
  const csvAllLive = [
    'Node,Name,ParentProcessId,ProcessId',
    'H,cmd.exe,1,100',
    'H,claude.exe,100,101',
    'H,claude.exe,100,102'
  ].join('\n');
  assert.deepEqual(findOrphanClaudePids(csvAllLive), []);
});
