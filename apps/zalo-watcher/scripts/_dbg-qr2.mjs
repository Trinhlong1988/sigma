// Dùng ĐÚNG QR_PROMPT thật (copy nguyên văn từ vision-ocr.mjs) để xem claude trả gì.
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process'; import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { bufferToPng } from '../src/image-normalize.mjs';

const QR_PROMPT = `Đọc ảnh bill THANH TOÁN QUA QR — màn hình app "Thanh toán thành công" (có dấu tích ✓ tròn ở giữa trên). CHỈ trả DUY NHẤT 1 JSON (không markdown):
{"qr":[{"hkdName":"","amount":0,"date":"","time":"","ref":"","fromCard":""}]}
QUY TẮC (đây là TIỀN doanh số — đọc CỰC KỲ cẩn thận, sai 1 chữ số là sai lớn):
- hkdName = giá trị dòng "Nhà cung cấp" (tên Hộ Kinh Doanh, vd "HKD DEMO 35 Ha Noi"). Giữ NGUYÊN VĂN.
- amount = giá trị dòng "Số tiền" (con số kèm "đ"). VND nguyên (bỏ dấu . , và chữ đ). ĐỌC KỸ TỪNG CHỮ SỐ.
- date + time = dòng "Ngày thực hiện" dạng "HH:MM dd/mm/yyyy" → date="dd/mm/yyyy", time="HH:MM".
- ref = dòng "Số giao dịch" (chuỗi chữ+số liền, vd "6247VNIB024EN8TK"). GIỮ NGUYÊN, KHÔNG bỏ/đổi ký tự nào.
- fromCard = dòng "Từ" (thẻ khách trả, vd "VIB Cash Back •••• 5721").
- Đọc KHÔNG chắc để "". Nếu KHÔNG phải bill thanh toán QR (không có dòng "Nhà cung cấp" + "Số giao dịch") → {"qr":[]}.`;

const png = await bufferToPng(await readFile(process.argv[2]));
const img = await sharp(png).resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
const tmp = join(tmpdir(), `vqr_p_${Date.now()}_${randomUUID()}.jpg`);
await writeFile(tmp, img);
const raw = await new Promise((res) => {
  const p = spawn('claude', ['-p', '--model', 'claude-sonnet-5', '--output-format', 'json', '--permission-mode', 'bypassPermissions'], { stdio: ['pipe','pipe','pipe'], shell: true });
  let o = '', e = ''; const t = setTimeout(() => { try { p.kill(); } catch {} res('__TIMEOUT__'); }, 120000);
  p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
  p.on('close', c => { clearTimeout(t); console.log('exit', c, '| stderr:', String(e).slice(0,200)); res(o); });
  p.stdin.write(`${QR_PROMPT}\nẢnh: ${tmp}`); p.stdin.end();
});
await unlink(tmp).catch(()=>{});
let result; try { result = JSON.parse(raw).result; } catch { result = raw; }
console.log('RESULT >>>', JSON.stringify(result).slice(0, 800));
const m = String(result || '').match(/\{[\s\S]*\}/);
console.log('REGEX bắt được?', !!m, m ? JSON.stringify(m[0]).slice(0,400) : '');
