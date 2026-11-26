// Đo TỪNG CHẶNG khi đọc 1 bill POS: chuẩn hoá ảnh · OCR máy (phân loại) · đọc POS bằng Claude.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileToPng } from '../src/image-normalize.mjs';
import { readQrBillLocal, readBillForSend, readBillOrTransfer } from '../src/vision-ocr.mjs';
import { classifyBillLines } from '../src/local-bill-classify.mjs';

const dir = process.argv[2];
const files = (await readdir(dir)).filter((f) => /\.(jpe?g|png)$/i.test(f)).slice(0, 2);
for (const f of files) {
  const p = join(dir, f);
  let t = Date.now(); const png = await fileToPng(p); const tPng = Date.now() - t;
  t = Date.now(); const loc = await readQrBillLocal(png); const tLoc = Date.now() - t;
  const cls = loc?.lines ? classifyBillLines(loc.lines).kind : null;
  t = Date.now(); const pos = await readBillForSend(png, { retries: 1, noCache: true }); const tPos = Date.now() - t;
  t = Date.now(); const all = await readBillOrTransfer(png, { noCache: true }); const tAll = Date.now() - t;
  console.log(`${f.slice(0, 16)} | png ${tPng}ms | OCR máy ${tLoc}ms (phân loại: ${cls}) | POS-claude ${(tPos / 1000).toFixed(1)}s (${(pos.bills ?? []).length} bill) | TRỌN luồng ${(tAll / 1000).toFixed(1)}s → ${all.kind}`);
}
process.exit(0);
