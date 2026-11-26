// QUY TRÌNH PUBLISH SigMa ATOMIC (Admin Demo 12/8 "quy trình đâu?", sau khi publish tay SÓT sigma-version.json
// → Android không nhận update). MỘT lệnh ghi ĐỦ mọi kênh, KHÔNG copy tay từng file (tránh sót bước):
//   1) EXE  : sigma-pc/dist/SigMa-<ver>-setup.exe(+blockmap)+latest.yml → <UPDATES_DIR>\sigma\ (feed auto-update)
//   2) EXE  : → D:\alpha-downloads\sigma-latest-setup.exe (tên ổn định cho landing)
//   3) APK  : web-demo/android/.../app-release.apk → D:\alpha-downloads\sigma-latest.apk
//   4) MANIFEST: D:\alpha-downloads\sigma-version.json {versionCode,versionName,url,notes} (APK in-app update ĐỌC file này — BƯỚC HAY BỊ SÓT)
//   5) verify-sigma-release.mjs cuối (fail-loud nếu kênh nào lệch).
// Dùng: node scripts/publish-sigma.mjs <versionName> <versionCode> ["notes"]
import { existsSync, copyFileSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const [versionName, versionCodeRaw, notes] = process.argv.slice(2);
if (!versionName || !versionCodeRaw) { console.error('Dùng: node scripts/publish-sigma.mjs <versionName> <versionCode> ["notes"]'); process.exit(1); }
const versionCode = Number(versionCodeRaw);
if (!Number.isInteger(versionCode) || versionCode < 1) { console.error('versionCode phải là số nguyên'); process.exit(1); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEED = '<UPDATES_DIR>\\sigma';
const DOWNLOADS = 'D:\\alpha-downloads';
const exeDist = path.join(ROOT, 'apps', 'sigma-pc', 'dist');
const apkPath = path.join(ROOT, 'apps', 'web-demo', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
// [KHOÁ CHỐNG TÁI DIỄN 12/9 — Admin Demo "chống tái diễn chặt chẽ"] Lớp bug "SHIP khi test đỏ" (11/9: đổi chính
// sách CK chỉ chạy 1 file test, 3 test NGHI-TRÙNG đỏ không biết).
// [MỞ RỘNG 18/9] Gate cũ ở ĐÂY chỉ chạy bot-api + services ⇒ 137 file test (web-demo 84, quanly-api 20,
// desktop 10, business-rules 10, zalo-watcher 13) chưa từng chặn được bản ship nào; ca thật 18/9: 2 test
// web-demo nằm ngoài include vitest.config vẫn qua mọi cổng. Nay gọi gate DÙNG CHUNG với publish SigMa
// (scripts/gate-test.mjs) — 1 nguồn, không còn 2 bản trôi khỏi nhau.
import { chayGateTest } from './gate-test.mjs';
chayGateTest('SigMa');
if (process.env.PUBLISH_TEST_GATE_ONLY === '1') { console.log('[publish] GATE-ONLY xong — thoát (không publish).'); process.exit(0); }

const exeName = `SigMa-${versionName}-setup.exe`;

const must = (p, what) => { if (!existsSync(p)) { console.error(`[publish] THIẾU ${what}: ${p} — build trước khi publish.`); process.exit(1); } return p; };
must(path.join(exeDist, exeName), 'EXE'); must(path.join(exeDist, 'latest.yml'), 'latest.yml'); must(apkPath, 'APK');

// [GUARD null-byte 2/9 — cấm tái diễn] app-update.yml trong bản build KHÔNG được có byte \0 (nguồn lỗi "null byte is
// not allowed in input (1:1)" — user đọc file này bằng js-yaml lúc mở app). Kiểm win-unpacked/resources/app-update.yml
// (cùng nguồn với bản đóng gói) — có \0/rỗng = CHẶN publish (không ship file hỏng cho user nữa).
const appUpdCfg = path.join(exeDist, 'win-unpacked', 'resources', 'app-update.yml');
if (existsSync(appUpdCfg)) {
  const b = readFileSync(appUpdCfg);
  if (b.includes(0) || b.length === 0) { console.error(`[publish] ✗ app-update.yml CÓ NULL BYTE/rỗng (${appUpdCfg}) — CHẶN publish, build lại (nguồn lỗi update null-byte).`); process.exit(1); }
  // latest.yml feed cũng phải parse được (không \0)
  const ly = readFileSync(path.join(exeDist, 'latest.yml'));
  if (ly.includes(0)) { console.error('[publish] ✗ latest.yml có NULL BYTE — CHẶN publish.'); process.exit(1); }
  console.log('[publish] ✓ GUARD: app-update.yml + latest.yml sạch (0 null byte)');
}

// [GUARD hash 11/9 — cấm tái diễn "sai mã kiểm tra"] 0.6.127 ship EXE 67MB trong khi latest.yml mô tả 83.6MB
// (2 build chồng nhau: exe của build sau, yml của build trước) → electron-updater báo "File cập nhật tải về bị hỏng".
// TRƯỚC publish: sha512(EXE thật) + size PHẢI khớp latest.yml, lệch = DỪNG (build lại sạch 1 lần).
{
  const exeBuf = readFileSync(path.join(exeDist, exeName));
  const exeSha = createHash('sha512').update(exeBuf).digest('base64');
  const lyTxt = readFileSync(path.join(exeDist, 'latest.yml'), 'utf8');
  const shaM = /sha512:\s*(\S+)/.exec(lyTxt);
  const sizeM = /size:\s*(\d+)/.exec(lyTxt);
  if (!shaM || !sizeM) { console.error('[publish] ✗ latest.yml không đọc được sha512/size — CHẶN publish.'); process.exit(1); }
  if (shaM[1] !== exeSha) { console.error(`[publish] ✗ SHA512 LỆCH: latest.yml=${shaM[1].slice(0, 16)}… ≠ EXE thật=${exeSha.slice(0, 16)}… — EXE và latest.yml KHÁC BUILD (build chồng nhau?). CHẶN publish, chạy lại npm run dist 1 lần sạch.`); process.exit(1); }
  if (Number(sizeM[1]) !== exeBuf.length) { console.error(`[publish] ✗ SIZE LỆCH: latest.yml=${sizeM[1]} ≠ EXE thật=${exeBuf.length} — CHẶN publish.`); process.exit(1); }
  console.log(`[publish] ✓ GUARD HASH: sha512+size EXE khớp latest.yml (${exeBuf.length} bytes)`);
}

// GUARD KIỂM CHỨNG APK (Admin Demo 12/8 "không kiểm chứng apk à?") — build incremental gradle CÓ THỂ ra APK versionCode
// CŨ (manifest cache) → vòng lặp "cài lại bản mới". ĐỌC versionCode THẬT gradle ghi (output-metadata.json) + ASSERT
// khớp tham số. Lệch = DỪNG (chưa clean-rebuild đúng Java 21). Đây là bằng chứng bắt buộc trước publish.
const metaPath = path.join(path.dirname(apkPath), 'output-metadata.json');
if (!existsSync(metaPath)) { console.error('[publish] THIẾU output-metadata.json cạnh APK — không xác thực được versionCode.'); process.exit(1); }
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
const el = (meta.elements && meta.elements[0]) || {};
if (Number(el.versionCode) !== versionCode || String(el.versionName) !== versionName) {
  console.error(`[publish] ✗ APK THỰC = code ${el.versionCode}/${el.versionName} ≠ mong đợi ${versionCode}/${versionName}.`);
  console.error('[publish]   → build incremental dùng manifest CŨ. CLEAN rebuild với JAVA_HOME=JDK21 rồi publish lại.');
  process.exit(1);
}
console.log(`[publish] ✓ KIỂM CHỨNG APK: versionCode ${el.versionCode}/${el.versionName} (khớp, không lặp update)`);
mkdirSync(FEED, { recursive: true }); mkdirSync(DOWNLOADS, { recursive: true });

// 1) EXE feed
copyFileSync(path.join(exeDist, exeName), path.join(FEED, exeName));
// [FIX null-byte 2/9] CỐ Ý KHÔNG copy .blockmap lên feed (Admin Demo "khắc phục triệt để"): differential download của
// electron-updater parse blockmap/diff → sinh "null byte is not allowed in input (1:1)" cho MÁY CŨ (systemic, không
// phải cache 1 máy). Không có blockmap trên feed → electron-updater fallback FULL download (an toàn, source AppUpdater.js
// "Cannot download differentially, fallback to full download"). Kèm client 0.6.26+ đã disableDifferentialDownload.
// Xoá blockmap cũ còn sót trên feed (idempotent) để máy đang chạy bản cũ cũng full-download.
for (const bm of (existsSync(FEED) ? readdirSync(FEED).filter((f) => f.endsWith('.blockmap')) : [])) { try { rmSync(path.join(FEED, bm), { force: true }); } catch { /* nuốt */ } }
copyFileSync(path.join(exeDist, 'latest.yml'), path.join(FEED, 'latest.yml'));
console.log('[publish] ✓ EXE → feed', FEED);
// 2) EXE downloads (tên ổn định)
copyFileSync(path.join(exeDist, exeName), path.join(DOWNLOADS, 'sigma-latest-setup.exe'));
console.log('[publish] ✓ EXE → downloads sigma-latest-setup.exe');
// 3) APK downloads — tên kèm CONTENT-HASH (mỗi build = URL DUY NHẤT chưa từng cache → CF KHÔNG BAO GIỜ phục vụ
//    nhầm bản cũ, kể cả khi từng lỡ warm nội dung sai vào tên version cũ). + tên ổn định cho landing.
const apkSha8 = createHash('sha256').update(readFileSync(apkPath)).digest('hex').slice(0, 8);
const apkVersioned = `sigma-${versionName}-${apkSha8}.apk`;
copyFileSync(apkPath, path.join(DOWNLOADS, apkVersioned));
copyFileSync(apkPath, path.join(DOWNLOADS, 'sigma-latest.apk'));
console.log('[publish] ✓ APK → downloads', apkVersioned, '+ sigma-latest.apk');
// 4) MANIFEST (bước hay sót) — url trỏ tên CÓ-VERSION+HASH (immutable, cache-safe tuyệt đối).
const apkUrl = `https://sigma.example.com/downloads/${apkVersioned}`;
const manifest = { versionCode, versionName, url: apkUrl, notes: notes || `Cập nhật ${versionName}.` };
writeFileSync(path.join(DOWNLOADS, 'sigma-version.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('[publish] ✓ MANIFEST sigma-version.json (versionCode', versionCode, '→', apkVersioned + ')');
// 5) verify
console.log('[publish] chạy verify-sigma-release.mjs...');
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-sigma-release.mjs'), versionName, String(versionCode)], { stdio: 'inherit' });
} catch { console.error('[publish] ⚠ VERIFY FAIL — kiểm lại kênh lệch phía trên.'); process.exit(1); }

// 6) WARM CACHE Cloudflare — fetch qua public để edge cache lại NGAY (tránh user đầu tiên gặp cold-cache = CF
//    fetch origin bị giới hạn upload máy chủ ~1-4MB/s). URL có-version immutable nên warm an toàn, phục vụ HIT.
//    A1 (Agent 4 phản biện 12/8): warm CẢ tên-ổn-định `sigma-latest.apk` + `sigma-latest-setup.exe`
//    (nút TẢI landing dùng) — TRƯỚC chỉ warm URL-hash → nút landing có thể còn cache bản CŨ tới khi hết hạn 4h.
const warmUrls = [
  apkUrl,
  'https://sigma.example.com/downloads/sigma-latest.apk',
  'https://sigma.example.com/downloads/sigma-latest-setup.exe',
  'https://alpha-update.example.com/updates/sigma/' + exeName
];
for (const u of warmUrls) {
  try {
    const t0 = Number(process.hrtime.bigint() / 1000000n);
    const r = await fetch(u);
    await r.arrayBuffer(); // đọc hết body để CF cache toàn file
    console.log(`[publish] warm ${u.split('/').pop()} http ${r.status} cf=${r.headers.get('cf-cache-status') || '-'} (${Number(process.hrtime.bigint()/1000000n) - t0}ms)`);
  } catch (e) { console.error('[publish] ⚠ warm lỗi (không chặn):', u, e.message); }
}
console.log('[publish] ✅ HOÀN TẤT publish SigMa', versionName);
