// [B197 19/11 — Admin Demo "tại sao cứ lỗi vậy? tùm lum thế?"] CHẠY TRỌN BỘ CỔNG GIAO DIỆN.
//
// Vì sao có file này: 15 cổng `_kiem-*.mjs` được viết ra sau từng lỗi thật, nhưng KHÔNG cái nào được nối vào
// cổng ship — chạy tay, nhớ thì chạy, quên thì thôi. Đúng lớp "làm ra mà không cắm dây" (tool built ≠ wired):
// cổng tồn tại mà không chặn được gì. Nay gom một mối, chạy MỘT lệnh, và nối vào cổng ship.
//
// LUẬT (R198): môi trường thử KHÔNG lên được thì phải ĐỎ + nói rõ, CẤM bỏ qua im lặng rồi báo "không có lỗi".
import { execFileSync } from 'node:child_process';
import { readdirSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';

const THUMUC = import.meta.dirname;
const WEB = process.env.WEB_THU || 'http://127.0.0.1:57915';
const API = process.env.API_THU || 'http://127.0.0.1:8795';

// Chỉ nhận đúng các cổng kiểm (tiền tố `_kiem-`), bỏ các file đo/chụp/audit một lần.
const CHI_CHAY = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const BAI = readdirSync(THUMUC)
  .filter((f) => f.startsWith('_kiem-') && f.endsWith('.mjs'))
  .filter((f) => CHI_CHAY.length === 0 || CHI_CHAY.some((k) => f.includes(k)))
  .sort();

console.log('[cong-giao-dien] sẽ chạy ' + BAI.length + ' cổng · web thử ' + WEB + ' · API thử ' + API);

// ── Môi trường thử phải SỐNG, không thì chặn ngay (fail-closed) ──
async function song(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return r.status > 0;
  } catch {
    return false;
  }
}
const okWeb = await song(WEB + '/');
const okApi = await song(API + '/v1/health');
if (!okWeb || !okApi) {
  console.error('[cong-giao-dien] ✗ MÔI TRƯỜNG THỬ CHƯA LÊN — web ' + (okWeb ? 'ok' : 'CHẾT') + ' · API ' + (okApi ? 'ok' : 'CHẾT'));
  console.error('[cong-giao-dien]   Bật lại rồi chạy lại. KHÔNG được coi đây là "không có lỗi".');
  process.exit(3);
}

// ── BƯỚC 0: DỰNG LẠI BẢN WEB THỬ TỪ MÃ HIỆN TẠI ──
// Các cổng dưới lái bản web ĐÃ ĐÓNG GÓI. Không dựng lại là kiểm nhầm bản cũ rồi báo xanh (lớp lỗi "bản dựng
// cũ" đã cắn nhiều lần). BO_QUA_BUILD=1 chỉ dùng khi vừa dựng xong ở bước trước.
if (process.env.BO_QUA_BUILD !== '1') {
  const DESKTOP = resolve(THUMUC, '..');
  console.log('[cong-giao-dien] dựng lại bản web thử từ mã hiện tại…');
  try {
    execFileSync('npx', ['vite', 'build', '--config', 'vite.config.web.ts'], { cwd: DESKTOP, stdio: 'inherit', shell: true });
  } catch {
    console.error('[cong-giao-dien] ✗ KHÔNG dựng được bản web — CHẶN (không kiểm bản cũ rồi báo xanh).');
    process.exit(3);
  }
  cpSync(resolve(DESKTOP, 'dist-web'), resolve(DESKTOP, 'dist-web-thu'), { recursive: true, force: true });
  console.log('[cong-giao-dien] đã chép bản vừa dựng sang dist-web-thu');
}

const ket = [];
for (const f of BAI) {
  const t0 = Date.now();
  process.stdout.write('\n══ ' + f + ' ══\n');
  let ma = 0;
  try {
    execFileSync(process.execPath, [resolve(THUMUC, f)], { stdio: 'inherit' });
  } catch (e) {
    ma = typeof e.status === 'number' ? e.status : 1;
  }
  ket.push({ f, ma, giay: ((Date.now() - t0) / 1000).toFixed(0) });
}

console.log('\n══════ TỔNG KẾT CỔNG GIAO DIỆN ══════');
for (const k of ket) console.log('  ' + (k.ma === 0 ? 'XANH' : 'ĐỎ  ') + '  ' + k.f + '  (' + k.giay + 's, mã ' + k.ma + ')');
const do_ = ket.filter((k) => k.ma !== 0);
console.log('  → ' + (ket.length - do_.length) + '/' + ket.length + ' xanh');
if (do_.length) {
  console.error('[cong-giao-dien] ✗ ' + do_.length + ' cổng ĐỎ: ' + do_.map((k) => k.f).join(', '));
  process.exit(1);
}
console.log('[cong-giao-dien] ✓ toàn bộ cổng giao diện xanh');
