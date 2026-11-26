// Debug: tái hiện ĐÚNG pipeline service cho bill QR + in RAW claude trả về.
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { readQrBillVision, ocrCacheGet } from '../src/vision-ocr.mjs';
import { bufferToPng } from '../src/image-normalize.mjs';

const file = process.argv[2];
const buf = await readFile(file);
const png = await bufferToPng(buf);
console.log('[1] png bytes =', png.length);

const cached = ocrCacheGet('qr', png, 'claude-sonnet-5@2400#qr1');
console.log('[2] CACHE qr hiện có?', cached === undefined ? 'KHÔNG' : JSON.stringify(cached));

// [3] pipeline thủ công y hệt readQrBillVision, nhưng IN RAW
const img = await sharp(png).resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
const tmp = join(tmpdir(), `vqr_dbg_${Date.now()}_${randomUUID()}.jpg`);
await writeFile(tmp, img);
console.log('[3] temp =', tmp, img.length, 'bytes');
const QR_PROMPT = `Đọc ảnh bill THANH TOÁN QUA QR — màn hình app "Thanh toán thành công" (có dấu tích ✓ tròn ở giữa trên). CHỈ trả DUY NHẤT 1 JSON (không markdown):
{"qr":[{"hkdName":"","amount":0,"date":"","time":"","ref":"","fromCard":""}]}
- hkdName = dòng "Nhà cung cấp". amount = dòng "Số tiền" (số nguyên VND). date+time từ "Ngày thực hiện" (HH:MM dd/mm/yyyy). ref = "Số giao dịch". fromCard = dòng "Từ".
- Nếu KHÔNG phải bill thanh toán QR → {"qr":[]}.`;
const raw = await new Promise((resolve) => {
  const p = spawn('claude', ['-p', '--model', 'claude-sonnet-5', '--output-format', 'json', '--permission-mode', 'bypassPermissions'], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
  let out = '', err = '';
  const t = setTimeout(() => { try { p.kill(); } catch {} resolve('__TIMEOUT__'); }, 120000);
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (c) => { clearTimeout(t); console.log('[4] exit code =', c, '| stderr:', String(err).slice(0, 300)); resolve(out); });
  p.stdin.write(`${QR_PROMPT}\nẢnh: ${tmp}`); p.stdin.end();
});
console.log('[5] RAW len =', raw.length);
try { const j = JSON.parse(raw); console.log('[6] is_error =', j.is_error, '| result =', JSON.stringify(j.result).slice(0, 500)); }
catch { console.log('[6] KHÔNG parse được raw:', raw.slice(0, 500)); }
await unlink(tmp).catch(() => {});

// [7] gọi CHÍNH hàm service dùng
const r = await readQrBillVision(png, { noCache: true });
console.log('[7] readQrBillVision =>', JSON.stringify(r));
