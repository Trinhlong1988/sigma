// Đọc bill CHUYỂN KHOẢN tạm ứng NĐT trong nhóm Zalo (Nguoi Dung Demo/KT Demo) bằng vision-LLM. Lấy N bill mới nhất của
// 1 group folder → decode JXL→PNG → claude -p đọc người nhận/STK/số tiền/ngày/giờ/mã GD. In JSON để đối chiếu tay.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileToPng } from '../src/image-normalize.mjs';
import sharp from 'sharp';

const GROUP_DIR = process.argv[2];
const N = Number(process.argv[3] || 4);
const SINCE = process.argv[4] ? new Date(process.argv[4]) : new Date('2026-08-25T00:00:00');

const PROMPT = `Đọc ảnh bill CHUYỂN KHOẢN ngân hàng (có thể là biên lai app bank). CHỈ trả DUY NHẤT 1 JSON (không markdown):
{"transfers":[{"receiverName":"","receiverAccount":"","receiverBank":"","senderName":"","amount":0,"date":"","time":"","ref":""}]}
QUY TẮC:
- receiverName = TÊN người/tài khoản NHẬN tiền (vd "NGUYEN VAN A", "KHACH HANG 01").
- receiverAccount = SỐ tài khoản nhận. receiverBank = ngân hàng nhận.
- senderName = tên người GỬI. amount = số tiền VND nguyên (bỏ . , đ VND).
- date = ngày (dd/mm/yyyy hoặc như bill). time = giờ (HH:mm:ss). ref = mã giao dịch/số tham chiếu/mã GD.
- KHÔNG chắc để "". Nếu KHÔNG phải bill chuyển khoản (vd bill POS) → {"transfers":[]}.`;

// [Admin Demo 6/9] killTree: Windows shell:true → SIGKILL chỉ giết cmd wrapper, claude con thành orphan (root-cause kẹt
// OCR). Giết CẢ CÂY (taskkill /F /T) → không tích tụ zombie.
function killTree(p) {
  if (!p || p.killed) return;
  try {
    if (process.platform === 'win32' && p.pid) { const tk = spawn('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore', shell: false }); tk.on('error', () => { try { p.kill('SIGKILL'); } catch {} }); }
    else p.kill('SIGKILL');
  } catch { try { p.kill('SIGKILL'); } catch {} }
}
function runClaude(prompt, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const p = spawn('claude', ['-p', '--model', 'claude-haiku-4-5', '--output-format', 'json', '--permission-mode', 'bypassPermissions'], { stdio: ['pipe', 'pipe', 'ignore'], shell: true });
    let out = '';
    const t = setTimeout(() => { killTree(p); resolve(''); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => { clearTimeout(t); resolve(out); });
    p.on('error', () => { clearTimeout(t); resolve(''); });
    try { p.stdin.write(prompt); p.stdin.end(); } catch {}
  });
}
function parse(raw) {
  let result; try { result = JSON.parse(raw).result; } catch { result = raw; }
  const m = String(result || '').match(/\{[\s\S]*\}/);
  if (!m) return { transfers: [], raw: String(result || '').slice(0, 200) };
  try { return JSON.parse(m[0]); } catch { return { transfers: [], raw: m[0].slice(0, 200) }; }
}

const pic = path.join(GROUP_DIR, 'picture');
const files = fs.readdirSync(pic)
  .filter((f) => !f.startsWith('.') && /\.(jxl|jpg|jpeg|png)$/i.test(f))
  .map((f) => ({ f, p: path.join(pic, f), t: fs.statSync(path.join(pic, f)).mtime }))
  .filter((x) => x.t >= SINCE)
  .sort((a, b) => b.t - a.t)
  .slice(0, N);

console.log(`Group: ${path.basename(GROUP_DIR)} | ${files.length} bill từ ${SINCE.toISOString().slice(0, 10)}`);
for (const x of files) {
  let png;
  try { png = await fileToPng(x.p); } catch (e) { console.log(`  [${x.f.slice(0, 30)}] decode LỖI: ${e.message}`); continue; }
  let img;
  try { img = await sharp(png).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer(); } catch { img = png; }
  const tmp = path.join(tmpdir(), `adv_${process.pid}_${Date.now()}.jpg`);
  await writeFile(tmp, img);
  const raw = await runClaude(`${PROMPT}\nẢnh: ${tmp}`);
  await unlink(tmp).catch(() => {});
  const r = parse(raw);
  console.log(`\n  [${x.t.toISOString().slice(5, 16)}] ${x.f.slice(0, 28)}`);
  console.log('   ', JSON.stringify(r.transfers?.length ? r.transfers : r));
}
