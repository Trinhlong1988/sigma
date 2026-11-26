// Truy NGƯỢC file ảnh từ HASH trong ocr-cache (cache khoá theo hash ảnh CHUẨN HOÁ, không lưu đường dẫn).
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileToPng } from '../src/image-normalize.mjs';

const TARGET = process.argv[2];
const roots = process.argv.slice(3);
const anh = [];
async function quet(dir, sau = 0) {
  if (sau > 3) return;
  let ds; try { ds = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const d of ds) {
    const p = join(dir, d.name);
    if (d.isDirectory()) await quet(p, sau + 1);
    else if (/\.(jpe?g|png|webp|jxl)$/i.test(d.name)) anh.push(p);
  }
}
for (const r of roots) await quet(r);
console.log('quét', anh.length, 'ảnh…');
for (const p of anh) {
  try {
    const png = await fileToPng(p);
    const h = createHash('sha256').update(png).digest('hex');
    if (h === TARGET) { const s = await stat(p); console.log('✅ TRÙNG HASH:', p, '|', Math.round(s.size / 1024) + 'KB |', s.mtime.toLocaleString('vi-VN')); process.exit(0); }
  } catch { /* bỏ ảnh hỏng */ }
}
console.log('❌ không thấy ảnh nào khớp hash trong các thư mục đã quét');
