// QUY TRÌNH PUBLISH SigMa (desktop) ATOMIC (Admin Demo 12/8 "siết quy trình" — trước publish TAY dễ sót).
// MỘT lệnh ghi đủ + verify + warm cache:
//   1) EXE alpha-<ver>-setup.exe(+blockmap)+latest.yml → <UPDATES_DIR>\ (feed auto-update, 8687 → alpha-update.example.com/updates/)
//   2) EXE → D:\alpha-downloads\alpha-<ver>-setup.exe + alpha-latest-setup.exe (tên ổn định cho landing)
//   3) VERIFY feed công khai latest.yml == version
//   4) WARM CF cache tên ổn định (tránh user đầu cold-cache chậm)
// Dùng: node scripts/publish-quanly-alpha.mjs <versionName>   (đã `npm run dist` ở apps/desktop trước)
import { existsSync, copyFileSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const versionName = process.argv[2];
if (!versionName) { console.error('Dùng: node scripts/publish-quanly-alpha.mjs <versionName>'); process.exit(1); }

// [Admin Demo 18/9 "dọn tất cả nợ cũ"] Script này TRƯỚC ĐÂY KHÔNG CÓ GATE TEST NÀO — SigMa ship được kể cả
// khi test đỏ toàn bộ, trong khi SigMa đã có gate từ 12/9. Cùng một repo, cùng lõi tiền (packages/services)
// mà hai cửa ship khắt khe khác nhau = lỗ hổng theo đúng nghĩa. Nay dùng CHUNG gate với SigMa.
const { chayGateTest } = await import('./gate-test.mjs');
chayGateTest('SigMa');
if (process.env.PUBLISH_TEST_GATE_ONLY === '1') { console.log('[publish-ql] GATE-ONLY xong — thoát (không publish).'); process.exit(0); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEED = '<UPDATES_DIR>';
const DOWNLOADS = 'D:\\alpha-downloads';
const dist = path.join(ROOT, 'apps', 'desktop', 'dist');
const exeName = `alpha-${versionName}-setup.exe`;

const must = (p, what) => { if (!existsSync(p)) { console.error(`[publish-ql] THIẾU ${what}: ${p} — chạy \`npm run dist\` (apps/desktop) trước.`); process.exit(1); } return p; };
must(path.join(dist, exeName), 'EXE'); must(path.join(dist, 'latest.yml'), 'latest.yml');
// verify latest.yml == version (không publish nhầm bản)
const ly = readFileSync(path.join(dist, 'latest.yml'), 'utf8');
if (!new RegExp(`version:\\s*${versionName.replace(/\./g, '\\.')}\\b`).test(ly)) { console.error(`[publish-ql] latest.yml KHÔNG khớp version ${versionName}. DỪNG.`); process.exit(1); }
mkdirSync(FEED, { recursive: true }); mkdirSync(DOWNLOADS, { recursive: true });

// 1) feed — CỐ Ý KHÔNG đẩy .blockmap (3/9): electron-updater differential parse blockmap → máy bản cũ sinh chuỗi
// có \0 → "null byte is not allowed in input (1:1)", systemic MỌI máy cũ (incident 2/9). Không có blockmap trong
// feed → electron-updater FALLBACK full download (đúng cơ chế). Client cũng đặt disableDifferentialDownload=true.
copyFileSync(path.join(dist, exeName), path.join(FEED, exeName));
// XOÁ mọi .blockmap cũ còn sót trong feed (chống tái diễn — cấm blockmap tái xuất giữa các bản).
try {
  for (const f of readdirSync(FEED)) if (f.endsWith('.blockmap')) { rmSync(path.join(FEED, f)); console.log('[publish-ql] ⌫ xoá blockmap cũ', f); }
} catch (e) { console.error('[publish-ql] ⚠ dọn blockmap lỗi (không chặn):', e.message); }
copyFileSync(path.join(dist, 'latest.yml'), path.join(FEED, 'latest.yml'));
console.log('[publish-ql] ✓ EXE+latest.yml → feed (KHÔNG blockmap — full download)', FEED);
// 2) downloads
copyFileSync(path.join(dist, exeName), path.join(DOWNLOADS, exeName));
copyFileSync(path.join(dist, exeName), path.join(DOWNLOADS, 'alpha-latest-setup.exe'));
console.log('[publish-ql] ✓ EXE → downloads', exeName, '+ alpha-latest-setup.exe');
// 2b) versions.json (same-origin cho landing đọc động — "cấm tái diễn" landing kẹt version cũ, Admin Demo 15/8).
try {
  const vp = path.join(DOWNLOADS, 'versions.json');
  const cur = existsSync(vp) ? JSON.parse(readFileSync(vp, 'utf8')) : {};
  writeFileSync(vp, JSON.stringify({ ...cur, mgmt: versionName }, null, 2) + '\n');
  console.log('[publish-ql] ✓ versions.json mgmt →', versionName);
} catch (e) { console.error('[publish-ql] ⚠ ghi versions.json lỗi (không chặn):', e.message); }
// 3) verify public feed
try {
  const r = await fetch('https://alpha-update.example.com/updates/latest.yml');
  const txt = await r.text();
  const got = (txt.match(/version:\s*([0-9.]+)/) || [])[1];
  if (got === versionName) console.log(`[publish-ql] ✓ VERIFY feed công khai = ${got}`);
  else { console.error(`[publish-ql] ✗ feed công khai = ${got} ≠ ${versionName} (Cloudflare cache/tunnel?). Kiểm lại.`); process.exit(1); }
} catch (e) { console.error('[publish-ql] ⚠ không verify được feed công khai:', e.message); }
// 4) warm cache tên ổn định
try { const t0 = Number(process.hrtime.bigint()/1000000n); const r = await fetch('https://sigma.example.com/downloads/alpha-latest-setup.exe'); await r.arrayBuffer(); console.log(`[publish-ql] warm alpha-latest-setup.exe http ${r.status} cf=${r.headers.get('cf-cache-status')||'-'} (${Number(process.hrtime.bigint()/1000000n)-t0}ms)`); } catch (e) { console.error('[publish-ql] ⚠ warm lỗi (không chặn):', e.message); }
console.log('[publish-ql] ✅ HOÀN TẤT publish SigMa', versionName, '— landing đọc version ĐỘNG từ versions.json (không cần bump/rebuild landing).');
