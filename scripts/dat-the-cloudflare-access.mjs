// ĐẶT THẺ DỊCH VỤ CLOUDFLARE ACCESS CHO 1 MÁY (Admin Demo duyệt 7/11 — bước chuẩn bị cho việc gác API).
//
// Chạy TRÊN TỪNG MÁY desktop (hoặc dùng server-config.default.json đóng gói trong bản cài để máy mới tự có).
// Ghi 2 trường `cfAccessClientId` / `cfAccessClientSecret` vào %APPDATA%\AlphaQuanLy\server-config.json.
//
// 3 TẦNG như luật R202 (ghi vào file cấu hình đang dùng thật):
//   1) SAO LƯU file cũ ra bản timestamped TRƯỚC khi ghi;
//   2) CHỈ THÊM/CẬP NHẬT đúng 2 trường thẻ — không đụng host/port/database/user/password/apiBaseUrl;
//   3) CỔNG QA: đọc lại file, so TỪNG trường cũ phải y nguyên, 2 trường mới phải đúng.
//
// Dùng:
//   node scripts/dat-the-cloudflare-access.mjs --xem
//   node scripts/dat-the-cloudflare-access.mjs --dat --id <client-id> --secret <client-secret>
//   node scripts/dat-the-cloudflare-access.mjs --go        (gỡ thẻ, quay về như cũ)
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const DUONG =
  process.env.SIGMA_SERVER_CONFIG ||
  resolve(process.env.APPDATA || resolve(process.env.USERPROFILE || '.', 'AppData/Roaming'), 'AlphaQuanLy', 'server-config.json');

const arg = (ten) => {
  const i = process.argv.indexOf(ten);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const che = (v) => (typeof v === 'string' && v ? v.slice(0, 4) + '…' + v.slice(-4) : '(chưa có)');

function doc() {
  if (!existsSync(DUONG)) return {};
  try {
    return JSON.parse(readFileSync(DUONG, 'utf8'));
  } catch (e) {
    console.error('[the-cf] File cấu hình hỏng, KHÔNG ghi đè:', e.message);
    process.exit(1);
  }
}

const cu = doc();

if (process.argv.includes('--xem')) {
  console.log('[the-cf] File:', DUONG, existsSync(DUONG) ? '' : '(CHƯA CÓ)');
  console.log('[the-cf] apiBaseUrl      =', cu.apiBaseUrl ?? '(chưa đặt → app dùng domain mặc định)');
  console.log('[the-cf] cfAccessClientId     =', che(cu.cfAccessClientId));
  console.log('[the-cf] cfAccessClientSecret =', che(cu.cfAccessClientSecret));
  process.exit(0);
}

const go = process.argv.includes('--go');
const id = arg('--id');
const secret = arg('--secret');
if (!go && (!id || !secret)) {
  console.error('[the-cf] Thiếu --id / --secret. Xem hướng dẫn ở đầu file.');
  process.exit(1);
}
if (!go && (id.length < 8 || secret.length < 16)) {
  console.error('[the-cf] Thẻ trông không hợp lệ (id ≥8, secret ≥16 ký tự) → DỪNG, không ghi bừa.');
  process.exit(1);
}

// ── TẦNG 1: sao lưu ──
mkdirSync(dirname(DUONG), { recursive: true });
let sao = null;
if (existsSync(DUONG)) {
  sao = DUONG + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(DUONG, sao);
  if (readFileSync(sao, 'utf8') !== readFileSync(DUONG, 'utf8')) {
    console.error('[the-cf] Bản sao không khớp bản gốc → DỪNG.');
    process.exit(1);
  }
  console.log('[the-cf] Đã sao lưu →', sao);
}

// ── TẦNG 2: chỉ đụng 2 trường thẻ ──
const moi = { ...cu };
if (go) {
  delete moi.cfAccessClientId;
  delete moi.cfAccessClientSecret;
} else {
  moi.cfAccessClientId = id;
  moi.cfAccessClientSecret = secret;
}
writeFileSync(DUONG, JSON.stringify(moi, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });

// ── TẦNG 3: cổng QA — mọi trường CŨ phải y nguyên ──
const doLai = doc();
const loi = [];
for (const k of Object.keys(cu)) {
  if (k === 'cfAccessClientId' || k === 'cfAccessClientSecret') continue;
  if (JSON.stringify(doLai[k]) !== JSON.stringify(cu[k])) loi.push(`trường "${k}" BỊ ĐỔI: ${JSON.stringify(cu[k])} → ${JSON.stringify(doLai[k])}`);
}
if (go) {
  if (doLai.cfAccessClientId || doLai.cfAccessClientSecret) loi.push('gỡ thẻ nhưng vẫn còn trong file');
} else {
  if (doLai.cfAccessClientId !== id) loi.push('cfAccessClientId ghi không đúng');
  if (doLai.cfAccessClientSecret !== secret) loi.push('cfAccessClientSecret ghi không đúng');
}
if (loi.length) {
  if (sao) copyFileSync(sao, DUONG);
  console.error('[the-cf] *** CỔNG QA KHÔNG ĐẠT → ĐÃ HOÀN NGUYÊN ***');
  for (const x of loi) console.error('   ·', x);
  process.exit(1);
}
console.log('[the-cf] ĐẠT.', go ? 'Đã GỠ thẻ.' : `Đã đặt thẻ ${che(id)} / ${che(secret)}.`);
console.log('[the-cf] Mở lại app để nhận thẻ mới (preload đọc 1 lần lúc khởi động).');
