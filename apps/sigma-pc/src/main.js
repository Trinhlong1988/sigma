// SigMa PC (Windows) — vỏ Electron tối giản bọc web app SigMa (apps/web-demo).
// KHÁC apps/desktop (app "SigMa"). App NÀY chỉ là client chat SigMa cho Windows.
//
// ─────────────────────────────────────────────────────────────────────────────
//  HẰNG SỐ ĐỔI NGUỒN NỘI DUNG  (bundled  ⇄  live URL)
// ─────────────────────────────────────────────────────────────────────────────
//  CONTENT_MODE = 'bundled' : nạp bản web-demo ĐÃ BUILD đóng gói kèm app
//                             (thư mục ./renderer). Phục vụ qua HTTP nội bộ
//                             127.0.0.1 (KHÔNG dùng file:// vì web-demo dùng
//                             BrowserRouter — file:// làm hỏng routing + OAuth
//                             origin "null"). API trỏ https://sigma-api.example.com
//                             (đã nhúng lúc `vite build --mode production`).
//  CONTENT_MODE = 'live'    : nạp thẳng bản web live qua LIVE_URL (khi domain
//                             chat đã lên). ĐỔI DUY NHẤT 1 dòng bên dưới.
//
//  Đổi nhanh không sửa code: đặt biến môi trường SIGMA_CONTENT=live
// ─────────────────────────────────────────────────────────────────────────────
const CONTENT_MODE = process.env.SIGMA_CONTENT || 'bundled'; // 'bundled' | 'live'
const LIVE_URL = 'https://chat.example.com'; // ← bản web SigMa live (đổi khi deploy)
// API công khai — dùng cho Google native (Authorization Code flow phía server). Cửa sổ Google mở tới
// /v1/auth/google/start; server set cookie phiên (SameSite=None) vào CHUNG session jar (không đặt partition) →
// app đọc được ngay. KHÁC origin bundled 127.0.0.1 nên tránh origin_mismatch của GIS token-flow.
const API_BASE = process.env.SIGMA_API || 'https://sigma-api.example.com';

const { app, BrowserWindow, shell, ipcMain, Notification, nativeImage, Tray, Menu, session, screen } = require('electron');
const path = require('node:path');

// GỐC bug "đăng nhập exe bị văng ra / phiên hết hạn dù không đăng nhập máy khác" (Admin Demo 7/8, TÁI HIỆN THẬT):
// jar cookie tích tụ NHIỀU cookie `sigma_ws` TRÙNG TÊN khác domain — 1 host (`sigma-api.example.com`,
// đúng, do server set) + 1 dot-domain (`.sigma-api.example.com`, rác, KHÔNG bao giờ bị server xóa vì
// clearWebSessionCookie chỉ xóa host). Khi gửi request, CẢ HAI cùng khớp → trình duyệt gửi kèm cả 2 →
// cookie-parser server lấy CÁI ĐẦU (rác) → getWebSession=null → 401 SESSION_INVALID → client "hết hạn" → văng
// ra, và login mới cũng bị che vĩnh viễn. FIX + CHỐNG TÁI DIỄN: mỗi lần khởi động, nếu có >1 cookie
// `sigma_ws` → DỌN SẠCH mọi biến thể (buộc đăng nhập lại đúng 1 lần, tự lành); nếu chỉ 1 → GIỮ NGUYÊN
// (auto-login còn nguyên). Best-effort, nuốt lỗi im (không chặn khởi động).
const WS_COOKIE_NAME = 'sigma_ws';
async function healDuplicateSessionCookies() {
  try {
    const ck = session.defaultSession.cookies;
    const list = await ck.get({ name: WS_COOKIE_NAME });
    if (list.length <= 1) return; // 0 hoặc 1 cookie = bình thường, không đụng (giữ auto-login).
    for (const c of list) {
      const scheme = c.secure ? 'https' : 'http';
      const host = (c.domain || '').replace(/^\./, '');
      if (!host) continue;
      try { await ck.remove(`${scheme}://${host}${c.path || '/'}`, WS_COOKIE_NAME); } catch (_) { /* bỏ qua từng cái */ }
    }
    bootMark(`[cookie-heal] phát hiện ${list.length} cookie ${WS_COOKIE_NAME} trùng → đã dọn sạch (đăng nhập lại 1 lần)`);
  } catch (err) {
    console.error('[cookie-heal] dọn cookie phiên trùng thất bại (best-effort):', err);
  }
}
const fs = require('node:fs');
const http = require('node:http');
const { registerUpdateService } = require('./update-service');

// [H2] Giữ ref cửa sổ chính ở module để update-service gửi sự kiện (webContents.send) — banner cập nhật realtime.
let mainWindow = null;

// CHẠY ẨN / THU TRAY (6/8, Admin Demo "bấm X phải thu về góc phải taskbar như Zalo, chạy nền giữ online"). Giữ ref
// Tray ở module (tránh bị GC → biến mất khỏi khay). `app.isQuitting` = cờ phân biệt X-thu-ẩn (false → chặn close,
// win.hide()) vs THOÁT THẬT (true → cho close, quit). Đặt true khi: menu tray "Thoát", hoặc mọi 'before-quit'
// (auto-update quitAndInstall / Cmd+Q / OS shutdown) — để KHÔNG chặn nhầm việc thoát/cài bản mới.
let tray = null;
app.isQuitting = false;
let hasShownTrayHint = false; // chỉ hiện gợi ý "vẫn chạy nền" 1 lần đầu thu tray.

// SPLASH (6/8, Admin Demo "cài/cập nhật xong ĐƠ TRẮNG 1 lúc mới ra app, icon đơ trắng"). Nguyên nhân: cửa sổ chính
// `show:false`, CHỈ hiện khi renderer vẽ xong ('ready-to-show') — lần đầu sau cài (cache đĩa nguội, parse bundle
// SPA) mất vài giây → KHÔNG cửa sổ nào hiện → user thấy trắng/không icon. FIX chống tái diễn MỌI máy: bật cửa sổ
// splash brand NGAY khi app ready (có icon taskbar + spinner), đóng khi cửa sổ chính sẵn sàng.
let splashWin = null;
function createSplash() {
  // 7/8 (Admin Demo) — GỐC lỗi "logo tách khỏi nền app": TRƯỚC đây splash là cửa sổ 300×300 NHỎ (1 ô vuông nhỏ nổi
  // giữa desktop, KHÔNG khớp cửa sổ app 1280×860) → trông tách rời. (Bản transparent-chỉ-logo cũng SAI: mất nền
  // trắng app.) ĐÚNG = cửa sổ splash NỀN TRẮNG + KÍCH THƯỚC BẰNG cửa sổ app + logo GIỮA → như app đang mở, nền
  // trắng đầy đủ kiểu Zalo, KHÔNG còn ô vuông nhỏ tách rời. Khớp width/height/center với createWindow bên dưới.
  splashWin = new BrowserWindow({
    width: 1280,
    height: 860,
    frame: false,
    resizable: false,
    show: false,
    center: true,
    backgroundColor: '#ffffff',
    icon: app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : path.join(app.getAppPath(), 'build', 'icon.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  // NHÂN BẢN ĐÚNG thiết kế AppSplash của Admin Demo (logo tile + DẢI SÁNG QUÉT + chữ SigMa) — src/splash.html
  // + src/../desktop/src/renderer/src/assets/sigma-logo.svg (đều nằm trong `files: src/**` nên được đóng gói). KHÔNG spinner (đã bị Admin Demo nhắc).
  splashWin.loadFile(path.join(__dirname, 'splash.html'));
  splashWin.once('ready-to-show', () => { if (splashWin && !splashWin.isDestroyed()) splashWin.show(); });
}
function destroySplash() {
  try { if (splashWin && !splashWin.isDestroyed()) splashWin.destroy(); } catch { /* đã đóng */ }
  splashWin = null;
}

// Thư mục chứa bản web-demo đã build (đóng gói cạnh app). Khi đóng gói (asar) đường dẫn
// là app.getAppPath()/renderer; khi chạy dev từ source cũng cùng vị trí (apps/sigma-pc/renderer).
const RENDERER_DIR = path.join(app.getAppPath(), 'renderer');

// Icon brand cho cửa sổ/splash/thông báo OS — packaged: resources/icon.ico (extraResources unpacked); dev: build/icon.ico.
function appIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(app.getAppPath(), 'build', 'icon.ico');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm'
};

let serverBaseUrl = null;

/**
 * Máy chủ tĩnh nội bộ phục vụ ./renderer với SPA-fallback (mọi route không phải file
 * → trả index.html để BrowserRouter tự xử lý). Chỉ lắng nghe 127.0.0.1.
 *
 * #26 (6/8, Admin Demo "tắt app mở lại BẮT ĐĂNG NHẬP LẠI — phải giữ phiên như Zalo") — GỐC: phiên đăng nhập lưu ở
 * `localStorage['sigma_session']` (renderer, xem lib/session.ts), mà localStorage keyed theo ORIGIN
 * (scheme+host+CỔNG). Trước đây server nghe cổng NGẪU NHIÊN (listen(0)) → mỗi lần mở app origin
 * `http://127.0.0.1:<cổng-mới>` KHÁC → localStorage RỖNG → getSession()=null → bắt đăng nhập lại (dù cookie
 * `sigma_ws` ở domain bot-api VẪN sống trong session persistent mặc định). FIX: nghe CỔNG CỐ ĐỊNH → origin ổn
 * định qua restart → localStorage (phiên) sống → mở lại VẪN đăng nhập. Single-instance lock đã đảm bảo không có 2
 * app tranh cổng; nếu cổng vẫn bận (hiếm, tiến trình treo) → fallback cổng ngẫu nhiên (chấp nhận mất phiên lần đó).
 */
const BUNDLED_PORT = 43117; // cố định để origin http://127.0.0.1:43117 ổn định qua restart (giữ localStorage phiên).

// Đo thời gian khởi động (Admin Demo 6/8 "sao 5-6s mới vào app") — mốc từ lúc main process nạp xong (≈ process
// start, trừ init native trước JS). Ghi mốc từng pha ra log để có SỐ THẬT trên máy người dùng, không đoán.
const BOOT_T0 = Date.now();
function bootMark(label) {
  const line = `[boot] +${Date.now() - BOOT_T0}ms ${label}`;
  console.log(line);
  // Ghi RA FILE (console.log của exe đóng gói không hiện ra đâu) — userData/boot-timing.log để đọc số THẬT trên
  // máy người dùng. Best-effort, KHÔNG bao giờ để lỗi ghi log làm chết khởi động.
  try {
    if (app.isReady()) fs.appendFileSync(path.join(app.getPath('userData'), 'boot-timing.log'), new Date().toISOString() + ' ' + line + '\n');
  } catch { /* bỏ qua */ }
}
function startBundledServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
        let rel = urlPath.replace(/^\/+/, '');
        if (rel === '') rel = 'index.html';

        // Chống path traversal: chuẩn hoá và ép nằm trong RENDERER_DIR.
        let filePath = path.normalize(path.join(RENDERER_DIR, rel));
        if (!filePath.startsWith(RENDERER_DIR)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        // Nếu file không tồn tại và không có đuôi mở rộng → SPA fallback về index.html.
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          if (path.extname(filePath)) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          filePath = path.join(RENDERER_DIR, 'index.html');
        }

        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
      } catch (err) {
        res.writeHead(500);
        res.end('Server error: ' + (err && err.message));
      }
    });

    const onListening = () => {
      const { port } = server.address();
      serverBaseUrl = `http://127.0.0.1:${port}/`;
      resolve(serverBaseUrl);
    };
    // AUTO-LOGIN 24/7 (7/8, Admin Demo "thoát tray mở lại mất đăng nhập" — TÁI HIỆN THẬT: 43117 bận → fallback cổng
    // ngẫu nhiên → origin đổi → localStorage phiên MẤT → về login). GỐC: mở lại NHANH khi instance cũ chưa nhả kịp
    // 43117 (socket đang đóng). FIX: khi EADDRINUSE → RETRY ĐÚNG 43117 nhiều lần (chờ instance cũ nhả, TIME_WAIT
    // socket lắng nghe nhả trong vài giây) TRƯỚC KHI đành fallback ngẫu nhiên. Giữ nguyên origin 43117 → localStorage
    // phiên SỐNG → auto-login. Chỉ fallback (mất phiên 1 lần) nếu 43117 bị app KHÁC giữ thật sự (rất hiếm).
    const MAX_PORT_RETRY = 12;      // ~ 12 × 400ms = 4.8s chờ instance cũ nhả cổng.
    const PORT_RETRY_DELAY_MS = 400;
    let portRetries = 0;
    const tryFixedPort = () => {
      server.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE' && portRetries < MAX_PORT_RETRY) {
          portRetries++;
          console.error(`[bundled-server] cổng ${BUNDLED_PORT} bận, chờ instance cũ nhả — thử lại ${portRetries}/${MAX_PORT_RETRY}…`);
          setTimeout(tryFixedPort, PORT_RETRY_DELAY_MS);
          return;
        }
        if (err && err.code === 'EADDRINUSE') {
          // Đã retry hết mà vẫn bận → app khác giữ 43117 thật → đành fallback (chấp nhận mất phiên lần này).
          console.error(`[bundled-server] ${BUNDLED_PORT} vẫn bận sau ${MAX_PORT_RETRY} lần → fallback cổng ngẫu nhiên (mất phiên lần này).`);
          server.once('error', reject);
          server.listen(0, '127.0.0.1', onListening);
          return;
        }
        reject(err);
      });
      server.listen(BUNDLED_PORT, '127.0.0.1', onListening);
    };
    tryFixedPort();
  });
}

async function resolveStartUrl() {
  if (CONTENT_MODE === 'live') return LIVE_URL;
  if (!fs.existsSync(path.join(RENDERER_DIR, 'index.html'))) {
    throw new Error(
      'Không tìm thấy bản web đã build tại ' + RENDERER_DIR +
      ' — chạy `npm run bundle:web` trước khi build/chạy app.'
    );
  }
  return startBundledServer();
}

async function createWindow() {
  bootMark('createWindow bắt đầu');
  createSplash(); // hiện splash brand NGAY (trước khi load renderer chậm) — hết "đơ trắng" lần đầu.
  bootMark('splash hiện');
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 640,
    title: 'SigMa',
    // 4/8 (Admin Demo "thiết kế các button như Mac... sao vẫn vuông - x?") — BỎ khung cửa sổ Windows mặc định
    // (nút vuông + X), dùng thanh tiêu đề TỰ VẼ nút tròn kiểu Mac trong renderer (web-demo PcTitleBar) đồng bộ
    // với SigMa. Điều khiển qua IPC sigmapc:window-* (xem preload.js + ipcMain bên dưới).
    frame: false,
    // 4/8 FIX lag "màn xanh" lúc mở: KHÔNG hiện cửa sổ tới khi renderer vẽ xong khung đầu (ready-to-show) —
    // trước đây show:true mặc định + nền brand xanh #0579cc khiến user thấy màn XANH đứng yên vài giây trong
    // lúc SPA tải/parse bundle rồi mới ra màn đăng nhập. show:false + show() ở ready-to-show = mở ra là thấy
    // app luôn, không chớp xanh. backgroundColor đổi sang nền sáng khớp màn đăng nhập (tránh chớp màu lạ nếu có).
    show: false,
    backgroundColor: '#f1f5f9',
    // Icon cửa sổ/taskbar = brand SigMa. Khi đóng gói: icon.ico nằm ở resources (extraResources,
    // unpacked — icon load từ asar không đáng tin). Khi dev: đọc từ build/icon.ico trong source.
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.ico')
      : path.join(app.getAppPath(), 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // GỐC bug "exe không nhận push khi ở nền/tray" (Admin Demo 7/8): mặc định Chromium throttle renderer khi cửa
      // sổ ẩn/minimize (bấm X = win.hide() thu tray) → event loop JS chậm ~1 tick/phút → handler realtime WS +
      // dispatch OS Notification (AppShell) KHÔNG chạy kịp → thông báo không hiện. App chat PHẢI nhận tin realtime
      // khi ở nền → TẮT throttle để renderer chạy full tốc độ dù cửa sổ ẩn/tray.
      backgroundThrottling: false
    }
  });

  win.setMenuBarVisibility(false);

  // Chỉ hiện cửa sổ khi renderer đã sẵn sàng vẽ (hết chớp nền xanh). Fallback: nếu ready-to-show không bắn
  // (trường hợp hiếm) vẫn hiện sau khi loadURL xong ở dưới để không kẹt cửa sổ ẩn.
  win.once('ready-to-show', () => { bootMark('ready-to-show (renderer vẽ khung đầu) → hiện cửa sổ'); win.show(); destroySplash(); });
  win.webContents.once('did-finish-load', () => bootMark('did-finish-load (renderer tải xong)'));

  // Mở link ngoài (mailto, http khác domain) bằng trình duyệt hệ thống, không nuốt trong app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith(LIVE_URL)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Giữ tiêu đề "SigMa" dù trang web tự đổi document.title.
  win.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle('SigMa');
  });

  // Báo renderer khi trạng thái maximize đổi (đồng bộ icon nút phóng to/khôi phục ở thanh tiêu đề tự vẽ).
  const emitMax = () => {
    if (!win.isDestroyed()) win.webContents.send('sigmapc:window-maximized-changed', win.isMaximized());
  };
  win.on('maximize', emitMax);
  win.on('unmaximize', emitMax);

  // TRẠNG THÁI FOREGROUND THẬT (Admin Demo 7/8 "exe không có push") — GỐC: renderer dùng document.hasFocus() KHÔNG
  // tin cậy trong Electron → tưởng "ở nền" lúc đang foreground → đi nhánh OS-toast → main LẠI chặn (isFocused) →
  // RỚT sạch (không toast trong app, không Windows toast). FIX: main là NGUỒN CHÂN LÝ, đẩy foreground xuống
  // renderer mỗi khi đổi để renderer quyết định inBackground chính xác (xem os-notification.ts wireForegroundTracking).
  // foreground = đang focus + hiện + không minimize. Khi ẩn tray/minimize/mất focus → false → renderer bắn OS-toast.
  const emitForeground = () => {
    if (win.isDestroyed()) return;
    const fg = win.isFocused() && win.isVisible() && !win.isMinimized();
    win.webContents.send('sigmapc:foreground-changed', fg);
  };
  win.on('focus', emitForeground);
  win.on('blur', emitForeground);
  win.on('minimize', emitForeground);
  win.on('restore', emitForeground);
  win.on('show', emitForeground);
  win.on('hide', emitForeground);
  win.webContents.on('did-finish-load', emitForeground); // đồng bộ trạng thái ban đầu cho renderer.

  // THU TRAY thay vì thoát khi bấm X (Admin Demo: "như Zalo") — app chạy nền, WS chat SỐNG → GIỮ ONLINE (đúng
  // presence mới). Chỉ đóng THẬT khi app.isQuitting=true (menu tray "Thoát" / before-quit / auto-update). Nếu
  // KHÔNG tạo được tray (hiếm) → cho đóng bình thường để KHÔNG "nhốt" cửa sổ (không có cách mở lại).
  win.on('close', (e) => {
    if (app.isQuitting || !tray) return; // thoát thật / không có tray → cho đóng.
    e.preventDefault();
    win.hide();
    if (!hasShownTrayHint) {
      hasShownTrayHint = true;
      showTrayHint();
    }
  });

  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });

  const startUrl = await resolveStartUrl();
  bootMark('resolveStartUrl xong (server bundle sẵn sàng)');
  await win.loadURL(startUrl);
  bootMark('loadURL xong');
  // Fallback an toàn: nếu vì lý do nào đó 'ready-to-show' không bắn, vẫn hiện cửa sổ sau khi tải xong.
  if (!win.isVisible()) win.show();
  destroySplash();
  return win;
}

// Hiện lại + focus cửa sổ chính (từ tray click / menu "Mở SigMa" / mở app lần 2). Khôi phục nếu đang minimize
// và show() nếu đang ẩn (thu tray). Function declaration → hoisted, dùng được ở mọi nơi bên dưới.
function showMainWindow() {
  const w = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

// Gợi ý 1 LẦN đầu khi thu tray — cho người dùng biết app vẫn chạy nền (Windows: balloon của Tray; nền khác:
// Notification). Best-effort, nuốt lỗi im (chỉ là gợi ý UX).
function showTrayHint() {
  try {
    if (tray && process.platform === 'win32' && typeof tray.displayBalloon === 'function') {
      tray.displayBalloon({
        title: 'SigMa vẫn chạy nền',
        content: 'Bấm biểu tượng khay (góc phải taskbar) để mở lại. Chọn "Thoát" ở menu khay để đóng hẳn.'
      });
      return;
    }
    if (Notification.isSupported()) {
      new Notification({
        title: 'SigMa vẫn chạy nền',
        body: 'Bấm biểu tượng khay để mở lại.',
        icon: appIconPath(),
        silent: true
      }).show();
    }
  } catch (err) {
    console.error('[tray] hiện gợi ý chạy nền thất bại', err);
  }
}

// Tạo Tray (khay hệ thống góc phải taskbar) — icon brand + tooltip + menu chuột phải (Mở/Thoát) + click mở lại.
// Gọi 1 LẦN sau khi cửa sổ chính sẵn sàng. Best-effort: lỗi tạo tray KHÔNG crash app (close handler tự nhận biết
// tray=null để cho đóng bình thường, tránh nhốt cửa sổ).
function createTray() {
  if (tray) return;
  try {
    const iconPath = appIconPath();
    const img = nativeImage.createFromPath(iconPath);
    tray = new Tray(img.isEmpty() ? iconPath : img);
    tray.setToolTip('SigMa');
    const menu = Menu.buildFromTemplate([
      { label: 'Mở SigMa', click: () => showMainWindow() },
      { type: 'separator' },
      // "Thoát" = đóng THẬT: set cờ để close handler KHÔNG chặn, rồi quit.
      { label: 'Thoát', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
  } catch (err) {
    console.error('[tray] tạo tray thất bại — X sẽ đóng app như cũ (không thu tray)', err);
    tray = null;
  }
}

// Thoát THẬT sự (Cmd+Q / auto-update quitAndInstall / OS shutdown / menu tray "Thoát") — set cờ để 'close' của cửa
// sổ KHÔNG chặn (nếu không, quitAndInstall/relaunch bị hide() nuốt → không cài được bản mới). Idempotent.
app.on('before-quit', () => { app.isQuitting = true; });

// 1 phiên bản duy nhất (single instance) — mở lại app chỉ hiện + focus cửa sổ cũ (kể cả khi đang thu tray/ẩn).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow(); // hiện lại (show) cả khi đang ẩn dưới tray, không chỉ focus.
  });

  // IPC điều khiển cửa sổ cho thanh tiêu đề tự vẽ (nút Mac). Tác động lên cửa sổ GỬI request (sender), an toàn
  // đa cửa sổ. Đăng ký 1 lần (module scope) — KHÔNG trong createWindow để tránh trùng handler khi 'activate'.
  const senderWin = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle('sigmapc:window-minimize', (e) => { senderWin(e)?.minimize(); });
  ipcMain.handle('sigmapc:window-close', (e) => { senderWin(e)?.close(); });
  ipcMain.handle('sigmapc:window-is-maximized', (e) => senderWin(e)?.isMaximized() ?? false);
  ipcMain.handle('sigmapc:window-toggle-maximize', (e) => {
    const w = senderWin(e);
    if (!w) return false;
    if (w.isMaximized()) { w.unmaximize(); return false; }
    w.maximize(); return true;
  });

  // CHỌN FOLDER (Admin Demo 30/8 — feature "Quét bill gửi" tự động): mở hộp thoại chọn thư mục THẬT của Windows,
  // trả đường dẫn tuyệt đối (hoặc null nếu huỷ). Chỉ PC (Electron) có; web/mobile gõ tay.
  ipcMain.handle('sigmapc:pick-folder', async (e) => {
    const { dialog } = require('electron');
    const w = senderWin(e);
    const res = await dialog.showOpenDialog(w, { title: 'Chọn folder bill tải về', properties: ['openDirectory'] });
    return res.canceled || !res.filePaths || !res.filePaths.length ? null : res.filePaths[0];
  });

  // [Admin Demo 16/9 tối "ocr thủ công chưa đổi tên file"] CHỌN ẢNH BILL (1 hoặc nhiều) — GỐC lỗi: tab Thủ công dùng
  // <input type=file> của trình duyệt, KHÔNG có đường dẫn thật ⇒ renameBillFile không có gì để đổi tên. Dialog
  // Electron trả PATH tuyệt đối ⇒ tab Thủ công trên EXE đổi tên được y như tab Tự động. Trả [] nếu huỷ.
  ipcMain.handle('sigmapc:pick-bill-files', async (e) => {
    const { dialog } = require('electron');
    const w = senderWin(e);
    const res = await dialog.showOpenDialog(w, {
      title: 'Chọn ảnh bill',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Ảnh bill', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'jxl', 'heic'] }]
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return [];
    const path = require('node:path');
    return res.filePaths.slice(0, 300).map((p) => ({ name: path.basename(p), path: p }));
  });

  // ĐỌC DANH SÁCH ẢNH TRONG FOLDER (Admin Demo 31/8) — EXE đọc TRỰC TIẾP qua fs. FIX FREEZE 31/8: TRẢ CHỈ {name,path}
  // (KHÔNG base64) — trước đây đọc HẾT tới 300 ảnh thành base64 giữ trong renderer (hàng trăm MB) → chuyển tab ĐƠ.
  // Renderer đọc TỪNG ảnh khi tới lượt qua 'read-image-file' (RAM chỉ ~1 ảnh). Cap 300 ảnh.
  ipcMain.handle('sigmapc:read-folder-images', async (_e, dirPath) => {
    const { listFolderImages } = require('./folder-images.js'); // logic THUẦN + có test (folder-images.test.js)
    return listFolderImages(dirPath);
  });

  // ĐỔI TÊN ẢNH BILL SAU KHI OCR (Admin Demo 8/9) — "1 - Đã thành công - <TÊN>" / "1 - Chưa thành công" để nhìn thư mục
  // là biết bill nào đã đọc được, bill nào phải kiểm tay. CHỈ đổi TÊN, GIỮ NGUYÊN thư mục + phần mở rộng.
  // BẢO MẬT (bài học B2 path-traversal save-file): tên mới bị lọc sạch ký tự phân cách/cấm của Windows + dấu chấm
  // đầu, và path đích PHẢI nằm đúng thư mục cũ (so sánh sau resolve) — không thì từ chối.
  ipcMain.handle('sigmapc:rename-bill-file', async (_e, payload) => {
    const { renameBillFile } = require('./rename-bill-file.js'); // logic THUẦN + có test (rename-bill-file.test.js)
    const { filePath, newBaseName } = payload || {};
    return renameBillFile(filePath, newBaseName);
  });

  // ĐỌC 1 ẢNH (base64) khi tới lượt OCR (fix freeze — đọc lười, không giữ cả folder trong RAM). Chỉ nhận file ẢNH.
  ipcMain.handle('sigmapc:read-image-file', async (_e, filePath) => {
    const fsm = require('fs');
    try {
      if (!filePath || !/\.(jpe?g|png|webp|jxl)$/i.test(filePath)) return { ok: false, error: 'Đường dẫn ảnh không hợp lệ.' };
      if (!fsm.existsSync(filePath) || !fsm.statSync(filePath).isFile()) return { ok: false, error: 'Ảnh không tồn tại (đã xoá/đổi tên?).' };
      const buf = fsm.readFileSync(filePath);
      const mime = /\.png$/i.test(filePath) ? 'image/png' : /\.webp$/i.test(filePath) ? 'image/webp' : 'image/jpeg';
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });

  // TẢI FILE THẬT (Admin Demo 1/9 "Excel báo tải xong sớm + thiếu nút mở") — ghi base64 vào Downloads (chống đè: thêm
  // (1),(2)...), trả path SAU KHI ghi xong (đồng bộ → không báo sớm). Renderer showDownloadDone → nút "Mở file".
  ipcMain.handle('sigmapc:save-file', async (_e, payload) => {
    const fsm = require('fs'); const pathm = require('path');
    try {
      const { base64, fileName } = payload || {};
      if (!base64 || !fileName) return { ok: false, error: 'Thiếu dữ liệu file.' };
      const buf = Buffer.from(base64, 'base64');
      const dir = app.getPath('downloads');
      // BẢO MẬT (Agent-B 1/9): `fileName` do NGƯỜI GỬI đặt (tên tin FILE = dto.body). basename() khử MỌI thành phần
      // thư mục → chống path traversal (`../../Startup/evil.bat` → ghi ngoài Downloads vào Startup = RCE lúc đăng nhập).
      // Khử ký tự điều khiển; rỗng sau khử → tên mặc định. FAIL-CLOSED: kiểm target nằm TRONG Downloads mới ghi.
      const safeName = pathm.basename(String(fileName)).replace(/[\x00-\x1f]/g, '').trim() || 'download';
      const ext = pathm.extname(safeName); const stem = pathm.basename(safeName, ext);
      let target = pathm.join(dir, safeName); let i = 1;
      while (fsm.existsSync(target)) { target = pathm.join(dir, `${stem} (${i++})${ext}`); }
      const resolvedDir = pathm.resolve(dir);
      if (!pathm.resolve(target).startsWith(resolvedDir + pathm.sep)) return { ok: false, error: 'Tên file không hợp lệ.' };
      fsm.writeFileSync(target, buf); // GHI XONG rồi mới trả (không báo tải-xong sớm).
      return { ok: true, path: target };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  // MỞ file vừa tải bằng app mặc định (shell.openPath trả '' nếu ok, hoặc chuỗi lỗi).
  // BẢO MẬT (deep-audit 1/9 LOW): CHỈ mở file TRONG thư mục Downloads (đồng nhất save-file) + CHẶN đuôi thực thi —
  // chống renderer bị chi phối truyền path exe/ngoài Downloads → chạy mã. Luồng hợp lệ chỉ mở file vừa lưu Downloads.
  ipcMain.handle('sigmapc:open-file', async (_e, filePath) => {
    try {
      const pathm = require('path');
      const p = pathm.resolve(String(filePath || ''));
      const dir = pathm.resolve(app.getPath('downloads'));
      if (!p.startsWith(dir + pathm.sep)) return { ok: false, error: 'Chỉ mở được file trong thư mục Tải xuống.' };
      if (/\.(exe|bat|cmd|ps1|msi|vbs|js|scr|lnk|com|jar)$/i.test(p)) return { ok: false, error: 'Không mở file thực thi.' };
      const r = await shell.openPath(p); return r ? { ok: false, error: r } : { ok: true };
    }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });

  // Google native (Electron) — mở cửa sổ đăng nhập Google thật, bắt URL /v1/auth/google/finish để đóng + trả
  // kết quả. Cookie phiên do server set (SameSite=None) nằm CHUNG session mặc định → app đọc được ngay sau khi
  // renderer re-fetch phiên. KHÔNG đặt partition (để dùng chung cookie jar với cửa sổ app).
  ipcMain.handle('sigmapc:google-signin', (e) => {
    return new Promise((resolve) => {
      const parent = senderWin(e);
      const authWin = new BrowserWindow({
        width: 480,
        height: 660,
        parent: parent || undefined,
        modal: !!parent,
        show: false,
        title: 'Đăng nhập Google',
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, spellcheck: false }
      });
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        try { if (!authWin.isDestroyed()) authWin.close(); } catch { /* đã đóng */ }
        resolve(result);
      };
      const check = (url) => {
        if (!url || url.indexOf('/v1/auth/google/finish') === -1) return;
        try {
          const u = new URL(url);
          const status = u.searchParams.get('status');
          done({ ok: status === 'ok', error: status === 'ok' ? undefined : (u.searchParams.get('msg') || 'Đăng nhập Google thất bại.') });
        } catch {
          done({ ok: false, error: 'Lỗi phản hồi từ máy chủ.' });
        }
      };
      authWin.webContents.on('did-redirect-navigation', (_ev, url) => check(url));
      authWin.webContents.on('did-navigate', (_ev, url) => check(url));
      authWin.on('closed', () => { if (!settled) { settled = true; resolve({ ok: false, error: 'cancelled' }); } });
      authWin.once('ready-to-show', () => authWin.show());
      authWin.loadURL(`${API_BASE}/v1/auth/google/start`).catch(() => done({ ok: false, error: 'Không mở được đăng nhập Google.' }));
    });
  });

  // ── POPUP THÔNG BÁO TỰ-VẼ (7/8, Admin Demo "exe không push — Zalo tự vẽ popup riêng, không dùng toast Windows") ──
  // GỐC: máy Admin Demo `ToastEnabled=0` (thông báo Windows TẮT) → `new Notification` bị Windows nuốt. Zalo/Telegram
  // né vấn đề này bằng cách TỰ vẽ 1 cửa sổ popup nhỏ góc phải-dưới, không phụ thuộc cài đặt Windows. Ta làm y vậy:
  // 1 cửa sổ frameless/transparent/always-on-top/skipTaskbar/không-cướp-focus, nội dung notification.html, main
  // đẩy mảng tin qua 'notif:data'. THAY hẳn toast Windows (không bắn cả 2 → không chồng đè khi máy bật thông báo).
  const NOTIF_W = 352;
  const NOTIF_MAX = 4;
  const NOTIF_TTL_MS = 6000;
  let notifWin = null;
  let notifItems = []; // {id, roomId, title, body, iconDataUrl}
  const notifTimers = new Map();
  let notifSeq = 0;

  function positionNotifWindow(height) {
    if (!notifWin || notifWin.isDestroyed()) return;
    try {
      // ĐA MÀN HÌNH (7/8, Admin Demo "app ở màn nào thông báo ở màn đó") — popup GHIM góc phải-DƯỚI của ĐÚNG màn
      // hình đang chứa cửa sổ chính (getDisplayMatching), KHÔNG cố định primary. Nếu chưa có cửa sổ chính → primary.
      const mw = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const disp = mw ? screen.getDisplayMatching(mw.getBounds()) : screen.getPrimaryDisplay();
      const wa = disp.workArea; // vùng làm việc (trừ taskbar) của ĐÚNG màn đó.
      const h = Math.max(1, Math.min(height || 120, wa.height - 20));
      notifWin.setBounds({ x: wa.x + wa.width - NOTIF_W - 12, y: wa.y + wa.height - h - 12, width: NOTIF_W, height: h });
    } catch (e) { /* best-effort */ }
  }

  function ensureNotifWindow() {
    if (notifWin && !notifWin.isDestroyed()) return notifWin;
    notifWin = new BrowserWindow({
      width: NOTIF_W, height: 120, show: false, frame: false, transparent: true, resizable: false,
      movable: false, minimizable: false, maximizable: false, skipTaskbar: true, focusable: false,
      alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000', icon: appIconPath(),
      // ⚠️ BẢO MẬT (deep-audit 1/9 LOW): cửa sổ notif chạy nodeIntegration (require Node). Nội dung tin (title/body)
      // đến từ NGƯỜI KHÁC → notification.html PHẢI render bằng `textContent` (đã đúng), TUYỆT ĐỐI CẤM `innerHTML`/
      // template string chèn HTML ở đây = RCE trực tiếp từ 1 tin chat. Nếu cần HTML động → chuyển contextIsolation:true.
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    notifWin.setAlwaysOnTop(true, 'screen-saver'); // nổi trên cả app fullscreen khác.
    notifWin.setVisibleOnAllWorkspaces(true);
    notifWin.loadFile(path.join(__dirname, 'notification.html'));
    notifWin.on('closed', () => { notifWin = null; });
    return notifWin;
  }

  // `chimeSeq` (Admin Demo 8/8 "1 tin 1 chuông, dồn dập không nuốt") — tín hiệu KÊU CHUÔNG theo notifSeq (tăng MỖI
  // tin), KHÔNG dựa số item hiển thị (bị cap NOTIF_MAX → burst >4 sẽ nuốt chuông). dismiss gọi renderNotif() không
  // kèm chimeSeq → KHÔNG kêu lại. notification.html kêu khi chimeSeq tăng.
  function renderNotif(chimeSeq) {
    if (notifItems.length === 0) {
      if (notifWin && !notifWin.isDestroyed()) notifWin.hide();
      return;
    }
    const w = ensureNotifWindow();
    const push = () => { if (w && !w.isDestroyed()) w.webContents.send('notif:data', { items: notifItems, chimeSeq: chimeSeq || 0 }); };
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', push);
    else push();
    if (!w.isVisible()) { positionNotifWindow(120); w.showInactive(); } // showInactive: KHÔNG cướp focus.
  }

  function dismissNotif(id) {
    const t = notifTimers.get(id);
    if (t) { clearTimeout(t); notifTimers.delete(id); }
    notifItems = notifItems.filter((it) => it.id !== id);
    renderNotif();
  }

  function showNotifPopup(payload) {
    const id = 'n' + (++notifSeq);
    const item = {
      id,
      roomId: (payload && payload.roomId) || '',
      title: (payload && payload.title) || 'SigMa',
      body: (payload && payload.body) || '',
      iconDataUrl: (payload && typeof payload.iconDataUrl === 'string' && payload.iconDataUrl) ? payload.iconDataUrl : null,
      // 7/8 — cờ ÂM THANH từ Cài đặt (isAudioEnabled). Mặc định true nếu payload cũ không kèm (giữ có chuông).
      playSound: !payload || payload.playSound !== false
    };
    notifItems.push(item);
    while (notifItems.length > NOTIF_MAX) { const drop = notifItems.shift(); const dt = notifTimers.get(drop.id); if (dt) { clearTimeout(dt); notifTimers.delete(drop.id); } }
    notifTimers.set(id, setTimeout(() => dismissNotif(id), NOTIF_TTL_MS));
    renderNotif(notifSeq); // kèm chimeSeq = notifSeq (tăng mỗi tin) → notification.html kêu 1 chuông/tin, kể cả khi bị cap.
  }

  ipcMain.on('notif:height', (_e, h) => positionNotifWindow(h));
  ipcMain.on('notif:dismiss', (_e, id) => dismissNotif(id));
  ipcMain.on('notif:click', (_e, data) => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('sigmapc:notify-clicked', { roomId: data && data.roomId });
    }
    if (data && data.id) dismissNotif(data.id); else { notifItems = []; renderNotif(); }
  });

  // Thông báo khi app Ở NỀN (renderer AppShell gọi lúc cửa sổ KHÔNG focus). Cửa sổ ĐANG focus → no-op (banner
  // trong app lo). Ở nền → showNotifPopup() (popup tự-vẽ, xem trên). Click → focus cửa sổ + điều hướng phòng.
  ipcMain.handle('sigmapc:notify', (_e, payload) => {
    try {
      // Admin Demo chốt "1" (7/8) — EXE LUÔN dùng popup góc Windows, KỂ CẢ khi app đang focus (miễn không ở đúng
      // phòng đó — renderer AppShell đã gate `isCurrentRoom && !inBackground` trước khi gọi). BỎ gate isFocused cũ
      // (trước đây foreground → toast trong-app; nay 1 kiểu 1 vị trí nhất quán như Zalo). Popup tự-vẽ THAY
      // `new Notification` Windows (máy ToastEnabled=0 chặn). Xem showNotifPopup / notification.html.
      showNotifPopup(payload);
    } catch (err) {
      console.error('[notify] hiện popup thông báo thất bại', err);
    }
  });

  // BUG#8b (6/8, Admin Demo "badge trên ICON app desktop") — đặt TỔNG số tin chưa đọc lên icon taskbar/dock.
  // app.setBadgeCount(n) phủ macOS/Linux; Windows KHÔNG hiện badge số từ setBadgeCount nên THÊM overlay icon
  // (chấm đỏ) qua win.setOverlayIcon khi n>0, xóa (null) khi n=0 → khớp + clear tức thì khi đọc hết, bù trừ
  // realtime KHÔNG trễ (renderer gọi ngay lúc tổng unread đổi). Chấm đỏ 16×16 nhúng base64 (không cần asset rời).
  const UNREAD_OVERLAY = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAO0lEQVR4nGNgoAV4KOvxHxumSDNRhhDSjNcQYjVjNYRUzRiGjBpABQMojkaqJCRiDcGrmZAhRGkmFQAALgtiHGCA4UUAAAAASUVORK5CYII='
  );
  ipcMain.handle('sigmapc:set-unread-badge', (_e, rawCount) => {
    try {
      const n = Math.max(0, Math.floor(Number(rawCount) || 0));
      app.setBadgeCount(n); // macOS/Linux hiện số; Windows bỏ qua (không lỗi).
      const w = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      if (w && typeof w.setOverlayIcon === 'function') {
        // Windows: chấm đỏ = có tin chưa đọc; null = sạch. description cho screen-reader/hover.
        if (n > 0) w.setOverlayIcon(UNREAD_OVERLAY, `${n} tin chưa đọc`);
        else w.setOverlayIcon(null, '');
      }
    } catch (err) {
      console.error('[unread-badge] đặt badge icon thất bại', err);
    }
  });

  app.whenReady().then(() => {
    bootMark('app.whenReady (Electron init xong)');
    // AppUserModelID → Windows gom taskbar + hiển thị đúng icon/brand.
    app.setAppUserModelId('com.sigma.pc');
    // GỐC bug login văng ra (7/8) — dọn cookie phiên TRÙNG trước khi nạp renderer (xem healDuplicateSessionCookies).
    // await để renderer boot với jar sạch (không đua với request đầu tiên đọc cookie rác).
    healDuplicateSessionCookies()
      .catch(() => {})
      .then(() => createWindow())
      .then(() => {
        // Tạo tray SAU khi cửa sổ chính sẵn sàng → bấm X thu về khay giữ app chạy nền (WS/online). Nếu tạo tray
        // lỗi, close handler tự cho đóng bình thường (không nhốt cửa sổ).
        createTray();
        // Cập nhật tích hợp (electron-updater) — feed Cloudflare. Chỉ chạy thật khi đóng gói; dev = no-op.
        registerUpdateService({
          getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
          isPackaged: app.isPackaged,
          version: app.getVersion()
        }).catch((err) => console.error('[update] registerUpdateService failed', err));
      })
      .catch((err) => {
        destroySplash();
        const { dialog } = require('electron');
        dialog.showErrorBox('SigMa — lỗi khởi động', String(err && err.stack ? err.stack : err));
        app.quit();
      });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showMainWindow(); // đang thu tray/ẩn → hiện lại (macOS dock click / kích hoạt lại).
    });
  });

  app.on('window-all-closed', () => {
    // macOS: giữ app sống khi đóng cửa sổ (thói quen nền tảng). Windows/Linux: với tray, bấm X chỉ ẩn cửa sổ
    // (không đóng) nên event này chỉ xảy ra khi THẬT SỰ thoát (isQuitting). Không có tray (fallback hiếm) → quit
    // như hành vi cũ để không kẹt tiến trình nền không cửa sổ.
    if (process.platform === 'darwin') return;
    if (app.isQuitting || !tray) app.quit();
  });
}
