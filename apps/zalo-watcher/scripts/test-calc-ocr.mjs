// Test OCR ảnh MÁY TÍNH đại lý gửi (máy tính giảm giá / iPhone calc): số tiền gốc + phí% + sau phí.
// Vision đọc trực tiếp JPG (không cần decode JXL). Chạy trên 2 mẫu thật của Admin Demo.
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const PROMPT = `Đây là ảnh chụp MÁY TÍNH của đại lý (máy tính giảm giá HOẶC iPhone Calculator) tính phí quẹt thẻ.
Dạng: [số tiền gốc] − [phí %] = [số tiền sau phí]. VD "58.500-1,4% = 57.681" hoặc bảng "Giá gốc 69.871 / Phần trăm 1,4% / Giá cuối 68.893".
CHỈ trả DUY NHẤT 1 JSON (không markdown): {"amount":<số tiền gốc, số nguyên bỏ dấu chấm>,"feePct":<phí % dạng số thập phân, vd 1.4>,"net":<số sau phí, số nguyên>}
- amount/net: bỏ dấu phân cách nghìn (58.500→58500). feePct: đổi dấu phẩy thành chấm (1,4→1.4).
- Không đọc được trường nào để null. Nếu KHÔNG phải ảnh máy tính → {"amount":null,"feePct":null,"net":null}.`;

function runClaude(prompt, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const p = spawn('claude', ['-p', '--model', 'claude-haiku-4-5', '--output-format', 'json', '--permission-mode', 'bypassPermissions'], { stdio: ['pipe', 'pipe', 'ignore'], shell: true });
    let out = ''; const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(''); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => { clearTimeout(t); resolve(out); });
    p.on('error', () => { clearTimeout(t); resolve(''); });
    try { p.stdin.write(prompt); p.stdin.end(); } catch {}
  });
}
function parse(raw) { let r; try { r = JSON.parse(raw).result; } catch { r = raw; } const m = String(r || '').match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } }

for (const f of process.argv.slice(2)) {
  let img;
  try { img = await sharp(await readFile(f)).resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(); } catch (e) { console.log(f, 'sharp lỗi', e.message); continue; }
  const tmp = join(tmpdir(), `calc_${process.pid}_${Date.now()}.jpg`);
  await writeFile(tmp, img);
  const raw = await runClaude(`${PROMPT}\nẢnh: ${tmp}`);
  await unlink(tmp).catch(() => {});
  console.log(f.slice(-40), '→', JSON.stringify(parse(raw)));
}
