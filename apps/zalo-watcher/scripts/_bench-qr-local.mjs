import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readQrBillLocal } from '../src/vision-ocr.mjs';
import { fileToPng } from '../src/image-normalize.mjs';
const dir = '<REPO>/Desktop/bill/8.9/QR';
const files = (await readdir(dir)).filter(f => f.endsWith('.jpg'));
for (let round = 1; round <= 2; round++) {
  console.log(`\n─── vòng ${round} ───`);
  for (const f of files) {
    let t = Date.now(); const png = await fileToPng(join(dir, f)); const tPng = Date.now() - t;
    t = Date.now(); const r = await readQrBillLocal(png); const tOcr = Date.now() - t;
    console.log(`  ${f.slice(0,14)} | png ${tPng}ms | OCR local ${tOcr}ms | ${r?.isQr ? 'QR ' + r.qr.amount : 'không QR'} | warn=[${(r?.warnings||[]).join(',')}]`);
  }
}
process.exit(0);
