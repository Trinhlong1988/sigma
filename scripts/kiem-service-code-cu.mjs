// GATE CHẠY ĐƯỢC — phát hiện SERVICE ĐANG CHẠY CODE CŨ.
//
// VÌ SAO (Admin Demo 27/9 "gate đâu? quy trình đâu sao tái diễn"): quanly-api chạy liên tục từ 21/9 trong khi
// mã nguồn đã vá nhiều lần (kỳ báo cáo theo ngày bill, tra soát, giá bán). Sửa code + test xanh nhưng
// KHÔNG restart ⇒ người dùng vẫn gặp bug cũ, còn mình tưởng đã xong. ĐÂY LÀ LẦN THỨ HAI (lần trước 18/9,
// cũng quanly-api, cũng 6 ngày). Nhắc nhở không chặn được — phải có thứ ĐỎ được.
//
// Cách kiểm: với mỗi service, so GIỜ KHỞI ĐỘNG tiến trình đang nghe cổng với LẦN SỬA CUỐI của mã nguồn
// mà nó nạp (thư mục app + các packages dùng chung). Tiến trình cũ hơn mã nguồn ⇒ ĐỎ.
//
// Chạy:  node scripts/kiem-service-code-cu.mjs
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Service chạy từ mã nguồn (tsx) — cổng nghe + thư mục mã nó nạp. */
const SERVICES = [
  { ten: 'bot-api', cong: 8788, nguon: ['apps/bot-api/src', 'packages/services/src', 'packages/business-rules/src'] },
  { ten: 'quanly-api', cong: 8790, nguon: ['apps/quanly-api/src', 'packages/services/src', 'packages/business-rules/src'] },
  { ten: 'ocr-http', cong: 8796, nguon: ['apps/zalo-watcher/src'] }
];

/** mtime MỚI NHẤT trong các thư mục nguồn (bỏ file test, dist, node_modules). */
function suaCuoi(thuMucs) {
  let max = 0, file = '';
  const di = (d) => {
    let ds;
    try { ds = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ds) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'test') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { di(p); continue; }
      if (!/\.(ts|mts|js|mjs)$/.test(e.name) || /\.test\./.test(e.name)) continue;
      const m = statSync(p).mtimeMs;
      if (m > max) { max = m; file = path.relative(ROOT, p); }
    }
  };
  for (const t of thuMucs) di(path.join(ROOT, t));
  return { ms: max, file };
}

/** Tiến trình đang nghe cổng → { pid, khoiDongMs } hoặc null. */
function tienTrinh(cong) {
  const ps = `$c = Get-NetTCPConnection -LocalPort ${cong} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
    `if ($c) { $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.OwningProcess); ` +
    `Write-Output ($p.ProcessId.ToString() + "|" + $p.CreationDate.ToUniversalTime().ToString("o")) }`;
  let out = '';
  try { out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000 }).trim(); }
  catch { return null; }
  if (!out.includes('|')) return null;
  const [pid, iso] = out.split('|');
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : { pid: Number(pid), khoiDongMs: ms };
}

export function kiemServiceCodeCu({ imLang = false } = {}) {
  const xau = [];
  for (const s of SERVICES) {
    const tt = tienTrinh(s.cong);
    const sc = suaCuoi(s.nguon);
    if (!tt) { if (!imLang) console.log(`[service] ${s.ten.padEnd(11)} cổng ${s.cong}: KHÔNG chạy — bỏ qua`); continue; }
    const treMin = Math.round((sc.ms - tt.khoiDongMs) / 60000);
    const nhan = `${s.ten.padEnd(11)} PID ${String(tt.pid).padEnd(6)} khởi động ${new Date(tt.khoiDongMs).toLocaleString('vi-VN')}`;
    if (sc.ms > tt.khoiDongMs) {
      xau.push({ ...s, ...tt, sc, treMin });
      if (!imLang) console.error(`[service] ✗ ${nhan} · mã nguồn mới hơn ${treMin} phút (${sc.file})`);
    } else if (!imLang) {
      console.log(`[service] ✓ ${nhan} · mới hơn mã nguồn`);
    }
  }
  if (xau.length === 0) { if (!imLang) console.log('[service] ✓ mọi service đang chạy đều đã nạp mã mới nhất'); return true; }
  if (!imLang) {
    console.error(`\n[service] ${xau.length} service ĐANG CHẠY CODE CŨ — sửa xong mà không nạp thì người dùng vẫn gặp bug cũ:`);
    for (const x of xau) console.error(`   Stop-ScheduledTask -TaskName 'SigMa_${x.ten === 'bot-api' ? 'BotApi' : x.ten === 'quanly-api' ? 'QuanlyApi' : 'OcrHttpService'}'; Start-ScheduledTask -TaskName '...'`);
  }
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(kiemServiceCodeCu() ? 0 : 1);
}
