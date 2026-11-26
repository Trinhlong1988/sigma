// SigMa PC — Cập nhật phần mềm tích hợp (electron-updater qua Cloudflare feed).
// PORT plain-CommonJS từ apps/desktop/src/main/update-service.ts (đã tôi luyện G11/B85) — GIỮ nguyên các chốt:
//  [H1] quitAndInstall(true,true): cài IM (/S) + tự mở lại. (false,true) sẽ BUNG wizard NSIS — SAI.
//  [H2] Boot result (success/failed) KHÔNG push (renderer chưa mount → rơi) — renderer PULL qua update:getBootResult.
//  [H2b] Bản mới nhất đã biết PULL qua update:getLastAvailable (check() chạy lúc ready, push có thể rơi trước mount).
//  [H4] Xoá marker ở CẢ nhánh success VÀ failed (không xoá nhánh failed = báo đỏ vô hạn).
//  [M4] cờ downloading chống double-download. [M6] JSON hỏng → none, KHÔNG throw. offline-safe: nuốt lỗi mạng.
//  autoDownload=false (chỉ tải khi user bấm) — luồng Admin Demo: "có bản mới → xác nhận → tải % → tự cài + mở lại".
//  interop autoUpdater: electron-updater xuất qua getter (điểm mù CJS→ESM) → thử cả mod.autoUpdater lẫn default.
'use strict';
const { existsSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { app, ipcMain } = require('electron');

// [SELF-HEAL null-byte 2/9] Nội dung app-update.yml ĐÚNG (khớp electron-builder.yml publish + updaterCacheDirName).
const GOOD_APP_UPDATE_YML = "provider: generic\nurl: https://alpha-update.example.com/updates/sigma/\nchannel: latest\nupdaterCacheDirName: '@alphasigma-pc-updater'\n";
/** TỰ SỬA app-update.yml nếu hỏng (Admin Demo 2/9 "null byte is not allowed in input (1:1)"): bản auto-update CŨ có thể
 *  ghi lẫn byte \0 vào file này → electron-updater (js-yaml) ném "null byte (1:1)" MỖI lần mở app → không cập nhật được.
 *  Chạy TRƯỚC khi electron-updater đọc → ghi đè bản SẠCH (utf-8 no BOM). resources/ của per-user install ghi được.
 *  Đã tái hiện + chứng minh: file có \0 đầu → js-yaml ném đúng lỗi này; ghi đè sạch → hết. Trả true nếu đã sửa. */
function healAppUpdateConfig() {
  try {
    const p = join(process.resourcesPath || '', 'app-update.yml');
    if (!existsSync(p)) return false;
    const buf = readFileSync(p);
    const corrupt = buf.includes(0x00) || buf.length === 0; // \0 bất kỳ vị trí, hoặc rỗng.
    if (!corrupt) return false;
    writeFileSync(p, GOOD_APP_UPDATE_YML, { encoding: 'utf8' });
    // eslint-disable-next-line no-console
    console.log('[update] app-update.yml hỏng (null byte) → đã ghi đè SẠCH (self-heal)');
    return true;
  } catch { return false; }
}

function parseSemver(v) {
  const core = String(v).trim().replace(/^v/i, '').split(/[-+]/)[0];
  return core.split('.').map((x) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : 0; });
}
function isNewer(cur, next) {
  const a = parseSemver(cur), b = parseSemver(next), len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) { const x = a[i] ?? 0, y = b[i] ?? 0; if (y > x) return true; if (y < x) return false; }
  return false;
}
function markerPath() { return join(app.getPath('userData'), 'update-result.json'); }
function readMarker(file) {
  if (!existsSync(file)) return null;
  try {
    const m = JSON.parse(readFileSync(file, 'utf8'));
    if (!m || typeof m.targetVersion !== 'string' || !m.targetVersion) return null;
    return { targetVersion: m.targetVersion, fromVersion: String(m.fromVersion ?? ''), startedAt: String(m.startedAt ?? '') };
  } catch { return null; }
}
function clearMarker(file) { try { if (existsSync(file)) rmSync(file, { force: true }); } catch { /* nuốt */ } }
function evalMarker(curVersion, file) {
  if (!existsSync(file)) return { kind: 'none' };
  const m = readMarker(file);
  if (!m) { clearMarker(file); return { kind: 'none' }; }
  clearMarker(file); // H4: xoá NGAY ở MỌI nhánh.
  if (curVersion === m.targetVersion) return { kind: 'success', version: curVersion, at: new Date().toISOString() };
  return { kind: 'failed', fromVersion: m.fromVersion || curVersion, targetVersion: m.targetVersion };
}
/** Dọn CACHE electron-updater (pending dở + blockmap cũ) — self-heal khi cache hỏng gây parse-error. Cache Windows =
 *  %LOCALAPPDATA%\<updaterCacheDirName>. Nuốt lỗi (best-effort). Trả true nếu đã xoá được gì đó. */
function clearUpdaterCache(cacheDirName) {
  try {
    const local = process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local');
    const dir = join(local, cacheDirName || '@alphasigma-pc-updater');
    if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); return true; }
  } catch { /* nuốt */ }
  return false;
}
/** Lỗi PARSE/hỏng cache (null byte, yaml, unexpected token, gzip) — KHÁC lỗi mạng/đĩa. Gặp là dọn cache + thử lại. */
function isCorruptCacheError(raw) {
  return /null byte|yaml|unexpected (token|end)|incorrect header check|invalid.*(block|distance)|unexpected end of (file|json|input)|is not valid JSON/i.test(String(raw));
}
function humanizeUpdateError(err) {
  const raw = (err && err.message ? err.message : String(err)) || 'Lỗi không xác định';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return 'Không tìm thấy máy chủ cập nhật (kiểm tra kết nối mạng).';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|net::|ENETUNREACH/i.test(raw)) return 'Không kết nối được máy chủ cập nhật (server tắt hoặc mất mạng).';
  if (/ENOSPC/i.test(raw)) return 'Ổ đĩa không đủ dung lượng để tải bản cập nhật.';
  if (/sha512|checksum|integrity/i.test(raw)) return 'File cập nhật tải về bị hỏng (sai mã kiểm tra). Vui lòng thử lại.';
  // [FIX null-byte 2/9] cache/parse hỏng → đã tự dọn, mời thử lại (KHÔNG phun chuỗi kỹ thuật "null byte..." cho user).
  if (isCorruptCacheError(raw)) return 'Bộ nhớ tạm cập nhật bị lỗi — đã tự dọn. Vui lòng bấm Cập nhật lại.';
  return 'Cập nhật lỗi: ' + raw;
}

// startUpdater — nhận updater (autoUpdater thật/mock) + getWindow. Trả controller cho IPC.
function startUpdater(deps) {
  const { updater, getWindow } = deps;
  const marker = deps.markerFile || markerPath();
  const currentVersion = deps.currentVersion || '0.0.0';
  const intervalMs = deps.intervalMs || 60 * 60 * 1000;
  let downloading = false, installing = false, pendingVersion = null, timer, lastAvailable = null;

  const send = (channel, payload) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) { try { w.webContents.send(channel, payload); } catch { /* cửa sổ đóng */ } }
  };

  updater.autoDownload = false;            // chỉ tải khi user bấm.
  updater.autoInstallOnAppQuit = true;
  // [FIX null-byte 2/9] TẮT differential download (Admin Demo "Cập nhật lỗi: null byte is not allowed in input (1:1)",
  // cấm tái diễn): differential đọc/parse blockmap + diff theo block — path MONG MANH, blockmap cache cũ/pending dở
  // (vd bản 0.6.21 pending còn sót) làm electron-updater parse ra chuỗi có \0 → js-yaml ném "null byte (1:1)". Tải
  // FULL 83MB đơn giản + chắc, KHÔNG parse blockmap → hết hẳn lớp lỗi này. try/catch: bản electron-updater cũ có thể
  // không có field này (no-op an toàn).
  try { updater.disableDifferentialDownload = true; } catch { /* field không có ở bản cũ */ }

  updater.on('update-available', (info) => { const version = (info && info.version) || ''; lastAvailable = { version }; send('update-available', { version }); });
  updater.on('download-progress', (p) => send('download-progress', { percent: (p && p.percent) || 0 }));
  updater.on('update-downloaded', (info) => { pendingVersion = (info && info.version) || pendingVersion; send('update-downloaded', { version: pendingVersion || '' }); });
  updater.on('error', (err) => {
    downloading = false;
    const raw = (err && err.message) ? err.message : String(err);
    if (isCorruptCacheError(raw)) clearUpdaterCache(deps.updaterCacheDirName); // self-heal: lần bấm sau tải sạch.
    send('update-error', { message: humanizeUpdateError(err) });
  });

  const check = async () => { try { await updater.checkForUpdates(); } catch { /* offline-safe */ } };
  const start = async () => {
    if (downloading) return;
    downloading = true;
    try { await updater.downloadUpdate(); }
    catch (err) {
      downloading = false;
      const raw = (err && err.message) ? err.message : String(err);
      if (isCorruptCacheError(raw)) clearUpdaterCache(deps.updaterCacheDirName);
      send('update-error', { message: humanizeUpdateError(err) });
    }
  };
  const installNow = () => {
    if (installing) return;
    installing = true;
    try { writeFileSync(marker, JSON.stringify({ targetVersion: pendingVersion || '', fromVersion: currentVersion, startedAt: new Date().toISOString() }), 'utf8'); } catch { /* vẫn cài */ }
    updater.quitAndInstall(true, true); // [H1]
  };

  void check();
  timer = setInterval(() => void check(), intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    check, start, installNow,
    isDownloading: () => downloading,
    getLastAvailable: () => lastAvailable,
    stop: () => { if (timer) clearInterval(timer); }
  };
}

function dummyUpdater() {
  return { autoDownload: false, autoInstallOnAppQuit: true, on: () => undefined, checkForUpdates: async () => null, downloadUpdate: async () => null, quitAndInstall: () => {} };
}

let registered = false;
// registerUpdateService — index/main gọi 1 lần sau app ready.
async function registerUpdateService(deps) {
  if (registered) return;
  registered = true;

  healAppUpdateConfig(); // [SELF-HEAL] sửa app-update.yml hỏng (null byte) TRƯỚC khi electron-updater đọc → hết "null byte (1:1)".

  const bootResult = evalMarker(deps.version, markerPath()); // đánh giá + xoá marker NGAY (H4).
  let bootConsumed = false;
  let controller;

  if (deps.isPackaged) {
    let updater;
    try {
      // interop getter (B85): thử cả mod.autoUpdater lẫn mod.default.autoUpdater.
      const mod = require('electron-updater');
      const resolved = mod.autoUpdater || (mod.default && mod.default.autoUpdater);
      if (!resolved) throw new Error('electron-updater không có autoUpdater (khóa: ' + Object.keys(mod).join(',') + ')');
      updater = resolved;
    } catch (err) {
      console.error('[update] không nạp được electron-updater:', err);
      controller = startUpdater({ updater: dummyUpdater(), getWindow: deps.getWindow, currentVersion: deps.version });
      wireIpc(); return;
    }
    controller = startUpdater({ updater, getWindow: deps.getWindow, currentVersion: deps.version });
  } else {
    // Dev (chưa đóng gói) — updater rỗng, KHÔNG check mạng, tránh crash dev.
    controller = { check: async () => {}, start: async () => {}, installNow: () => {}, isDownloading: () => false, getLastAvailable: () => null, stop: () => {} };
  }
  wireIpc();

  function wireIpc() {
    ipcMain.handle('update:check', async () => controller.check());
    ipcMain.handle('update:start', async () => controller.start());
    ipcMain.handle('update:installNow', async () => controller.installNow());
    ipcMain.handle('update:getBootResult', async () => { if (bootConsumed) return null; bootConsumed = true; return bootResult.kind === 'none' ? null : bootResult; });
    ipcMain.handle('update:getLastAvailable', async () => controller.getLastAvailable());
    ipcMain.handle('app:getVersion', async () => deps.version);
  }
}

module.exports = { isNewer, readMarker, clearMarker, evalMarker, humanizeUpdateError, isCorruptCacheError, clearUpdaterCache, healAppUpdateConfig, GOOD_APP_UPDATE_YML, startUpdater, dummyUpdater, registerUpdateService, markerPath };
