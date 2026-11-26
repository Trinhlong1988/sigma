// OCR N bill POS mới nhất của 1 group → in TID đọc được (để xác minh nhóm thuộc đại lý nào).
import fs from 'node:fs';
import path from 'node:path';
import { fileToPng } from '../src/image-normalize.mjs';
import { readBillVision } from '../src/vision-ocr.mjs';

const GROUP_DIR = process.argv[2];
const N = Number(process.argv[3] || 6);
const SINCE = new Date(process.argv[4] || '2026-08-25T00:00:00');
const pic = path.join(GROUP_DIR, 'picture');
const files = fs.readdirSync(pic).filter((f) => !f.startsWith('.') && /\.(jxl|jpg|jpeg|png)$/i.test(f))
  .map((f) => ({ f, p: path.join(pic, f), t: fs.statSync(path.join(pic, f)).mtime }))
  .filter((x) => x.t >= SINCE).sort((a, b) => b.t - a.t).slice(0, N);
console.log(`${path.basename(GROUP_DIR)}: ${files.length} bill`);
const tids = {};
for (const x of files) {
  let png; try { png = await fileToPng(x.p); } catch { continue; }
  const r = await readBillVision(png);
  const t = (r.bills || []).map((b) => b.tid).filter(Boolean);
  for (const y of t) tids[y] = (tids[y] || 0) + 1;
  if (t.length) console.log(`  ${x.t.toISOString().slice(5, 16)} → TID ${t.join(',')}`);
}
console.log('  TID tổng hợp:', Object.keys(tids).length ? JSON.stringify(tids) : 'không đọc được');
