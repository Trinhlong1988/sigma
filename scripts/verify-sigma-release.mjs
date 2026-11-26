#!/usr/bin/env node
// TRIỆT ĐỂ chống "làm 1 chỗ quên 1 chỗ" ở khâu PHÁT HÀNH SigMa (Admin Demo 8/8: "quên nhiều thế? triệt để thế nào?").
// 1 lệnh kiểm MỌI kênh phát hành có ĐỒNG BỘ đúng version đích không → không thể quên kênh nào.
// Dùng: node scripts/verify-sigma-release.mjs 0.4.56 56   (versionName versionCode)
// Exit 1 nếu BẤT KỲ kênh nào lệch (in đỏ). Chạy sau MỖI lần publish.
import { readFileSync } from 'node:fs';

const [, , wantName, wantCodeRaw] = process.argv;
if (!wantName) { console.error('Thiếu tham số: node verify-sigma-release.mjs <versionName> [versionCode]'); process.exit(2); }
const wantCode = wantCodeRaw ? Number(wantCodeRaw) : null;

const FEED = 'https://alpha-update.example.com/updates/sigma';
const LANDING = 'https://sigma.example.com/downloads';
const WEBAPP = 'https://chat.example.com';

async function get(url) {
  try { const r = await fetch(url, { redirect: 'follow' }); return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : '' }; }
  catch (e) { return { ok: false, status: 0, text: '', err: String(e?.message || e) }; }
}
async function head(url) {
  try { const r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } }); return { ok: r.status === 200 || r.status === 206, status: r.status }; }
  catch (e) { return { ok: false, status: 0, err: String(e?.message || e) }; }
}

const results = [];
function check(name, pass, detail) { results.push({ name, pass, detail }); }

// 1) FEED EXE (electron-updater latest.yml) — versionName.
{
  const r = await get(`${FEED}/latest.yml`);
  const m = r.text.match(/^version:\s*(.+)$/m);
  const v = m ? m[1].trim() : null;
  check('EXE feed latest.yml version', v === wantName, `got=${v} want=${wantName} (http ${r.status})`);
  const setup = await head(`${FEED}/SigMa-${wantName}-setup.exe`);
  check('EXE feed setup.exe tải được', setup.ok, `SigMa-${wantName}-setup.exe http ${setup.status}`);
}
// 2) LANDING setup.exe "latest" (nút tải trang landing) — CHỈ kiểm tải được (tên ổn định, không mang version).
{
  const s = await head(`${LANDING}/sigma-latest-setup.exe`);
  check('Landing sigma-latest-setup.exe tải được', s.ok, `http ${s.status} (⚠ tên ổn định — KHÔNG tự biết version, phải copy đè mỗi release)`);
}
// 3) APK manifest (self-update) — versionCode + versionName + url.
{
  const r = await get(`${LANDING}/sigma-version.json`);
  let j = null; try { j = JSON.parse(r.text); } catch {}
  check('APK manifest versionName', j?.versionName === wantName, `got=${j?.versionName} want=${wantName}`);
  if (wantCode != null) check('APK manifest versionCode', j?.versionCode === wantCode, `got=${j?.versionCode} want=${wantCode}`);
  const apk = await head(`${LANDING}/sigma-latest.apk`);
  check('APK file tải được', apk.ok, `sigma-latest.apk http ${apk.status}`);
}
// 4) WEB live = bản build local (so hash bundle index).
{
  let localHash = null;
  try { const idx = readFileSync(new URL('../apps/web-demo/dist/index.html', import.meta.url), 'utf8'); localHash = (idx.match(/assets\/index-[\w-]+\.js/) || [])[0]; } catch {}
  const r = await get(`${WEBAPP}/`);
  const liveHash = (r.text.match(/assets\/index-[\w-]+\.js/) || [])[0];
  check('WEB live = dist local (hash bundle)', !!localHash && localHash === liveHash, `live=${liveHash} local=${localHash}`);
}

let allPass = true;
console.log(`\n=== VERIFY PHÁT HÀNH SigMa v${wantName}${wantCode != null ? ` (code ${wantCode})` : ''} ===`);
for (const r of results) { console.log(`${r.pass ? '  ✓' : '  ✗ FAIL'}  ${r.name} — ${r.detail}`); if (!r.pass) allPass = false; }
console.log(allPass ? '\n✅ MỌI KÊNH ĐỒNG BỘ đúng version.\n' : '\n❌ CÓ KÊNH LỆCH — sửa chỗ FAIL ở trên rồi chạy lại.\n');
process.exit(allPass ? 0 : 1);
