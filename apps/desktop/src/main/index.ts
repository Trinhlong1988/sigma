// Electron main entry (SigMa). Security: contextIsolation on, nodeIntegration off, sandbox off
// (sandbox must be off so the preload can use ipcRenderer via require in electron-vite CJS preload).
import './bigint-json.js'; // R48 — PHẢI import ĐẦU TIÊN: dạy JSON.stringify serialize BigInt (cột tiền int8).
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import { initDb, isApiMode } from './db.js';
import { registerIpc, setDbReady } from './ipc.js';
import * as auth from './auth-service.js';

const isDev = !app.isPackaged;

// Admin Demo 13/7 — ô <input type="date"> native của Chromium hiển thị theo LOCALE HĐH (Windows en-US = mm/dd/yyyy).
// Ép locale renderer về vi-VN để MỌI ô ngày (ngày cấp TID, thao tác POS, biểu phí…) hiện dd/mm/yyyy đồng nhất
// với fmtDate. PHẢI gọi TRƯỚC app.whenReady() (Chromium đọc --lang lúc khởi tạo). Áp 1 điểm, không sửa từng ô.
app.commandLine.appendSwitch('lang', 'vi-VN');

// Admin Demo 16/7 — "icon app trên taskbar không đồng bộ icon bản chuẩn": Windows cần AppUserModelID KHỚP appId
// bộ cài (`com.sigma.app`, xem electron-builder.yml — đổi theo rebrand SigMa) để liên kết tiến trình đang
// chạy với shortcut đã cài → taskbar/pin dùng ĐÚNG icon chuẩn (thay vì icon Electron mặc định hoặc nhóm sai).
// PHẢI đặt trước khi tạo cửa sổ. (B80 bug class: appId và AppUserModelId LỆCH nhau → icon taskbar sai/không đồng bộ.)
if (process.platform === 'win32') app.setAppUserModelId('com.sigma.app');

// [H2] Giữ ref cửa sổ chính ở module để update-service gửi sự kiện (webContents.send).
// `win` cục bộ trong createWindow không gửi được từ nơi khác.
let mainWindow: BrowserWindow | null = null;

// Admin Demo 12/7 — "mở app bị bé": cửa sổ +20% (1180×760 → 1416×912) + zoom chữ 1.15 (to đều, không lệch design).
// Chống tràn màn nhỏ: kẹp theo vùng làm việc màn chính (trừ ~48px cho taskbar/viền).
const BASE_ZOOM = 1.15;
async function createWindow(): Promise<void> {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1416, wa.width - 48),
    height: Math.min(912, wa.height - 48),
    minWidth: Math.min(1120, wa.width - 48),
    minHeight: Math.min(720, wa.height - 48),
    show: false,
    autoHideMenuBar: true,
    // Admin Demo 16/7 — icon cửa sổ/taskbar = icon shield chuẩn (build/icon.ico). Packaged: đọc từ resources
    // (đóng gói qua extraResources); dev: đọc trực tiếp trong build/. Thiếu file → Electron tự lùi về icon exe.
    icon: app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(__dirname, '../../build/icon.ico'),
    // Admin Demo 15/7 — ẩn khung/nút cửa sổ gốc để tự vẽ 3 nút tròn kiểu Mac (đỏ/vàng/lục). Windows vẫn
    // giữ viền kéo giãn (khác frame:false), thanh tiêu đề tự vẽ có vùng kéo -webkit-app-region:drag.
    titleBarStyle: 'hidden',
    backgroundColor: '#F4F6FA',
    title: 'SigMa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Nút cửa sổ tự vẽ (Mac traffic-light) → phát trạng thái phóng to để renderer đổi icon.
  win.on('maximize', () => win.webContents.send('window:maximized', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized', false));

  win.once('ready-to-show', () => win.show()); // Admin Demo 11/8: mở ở size thường (màn LOGIN mini); maximize SAU khi đăng nhập (IPC window:maximize)
  // Zoom chữ +15% đồng đều (áp sau mỗi lần tải xong để dính chắc, kể cả reload SPA).
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(BASE_ZOOM));

  win.webContents.setWindowOpenHandler(({ url }) => {
    // R48 — chỉ mở http/https ra trình duyệt ngoài; chặn scheme lạ (file:/ms-*/…) — footgun Electron.
    try {
      const scheme = new URL(url).protocol;
      if (scheme === 'http:' || scheme === 'https:') shell.openExternal(url);
    } catch {
      /* URL không hợp lệ → bỏ qua */
    }
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devUrl) {
    await win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// [B302/F4 24/11 — agent Electron] KHOÁ 1 BẢN CHẠY. Mở 2 cửa sổ app cùng hồ sơ là: cookie phiên ghi
// đè chéo (đăng nhập cửa sổ 2 đá văng cửa sổ 1 — đúng triệu chứng "đá phiên" 9/8), bản nháp bill
// localStorage đè nhau, và 2 cửa sổ cùng bấm Ghi = 2 lô. SigMa PC đã có khoá này từ lâu.
// Harness/selftest mở nhiều instance qua --user-data-dir RIÊNG nên không bị ảnh hưởng.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  // Harness guard (B04, G10): self-test 2+ mutate the DB. Trên PostgreSQL mỗi selftest phải chạy trên
  // 1 DB throwaway RIÊNG (createdb → migrate deploy → drop) để không nhiễm DB dev/prod dùng chung.
  // Bắt buộc: SIGMA_DB_URL=postgresql://…<tmpdb> + SIGMA_ROLE=server (để initDb seed admin/permissions).
  // [M3] selftest=23 (update wiring) test pure-unit + autoUpdater mock → KHÔNG đụng Postgres.
  //      Miễn khỏi 2 gác SIGMA_DB_URL/SIGMA_ROLE (nếu không app.exit(2) trước khi test chạy).
  const st = process.env['SIGMA_SELFTEST'];
  if (st && st !== '1' && st !== '23' && !process.env['SIGMA_DB_URL']) {
    // eslint-disable-next-line no-console
    console.error(
      `SELFTEST${st} ABORT | phải set SIGMA_DB_URL trỏ tới DB PostgreSQL throwaway đã migrate ` +
        `+ SIGMA_ROLE=server. Ví dụ: createdb tmp; DATABASE_URL=postgresql://…/tmp prisma migrate deploy; ` +
        `SIGMA_SELFTEST=${st} SIGMA_ROLE=server SIGMA_DB_URL=postgresql://…/tmp electron apps/desktop; dropdb tmp.`
    );
    app.exit(2);
    return;
  }
  if (st && st !== '1' && st !== '23' && process.env['SIGMA_ROLE'] !== 'server') {
    // eslint-disable-next-line no-console
    console.error(
      `SELFTEST${st} ABORT | thiếu SIGMA_ROLE=server → initDb sẽ KHÔNG seed (admin/permissions rỗng) ` +
        `và selftest fail ở bước đăng nhập. Đặt SIGMA_ROLE=server khi chạy selftest.`
    );
    app.exit(2);
    return;
  }
  // 4/8 (Admin Demo "máy ngoài không có Postgres, mở-là-chạy") — 2 CHẾ ĐỘ BOOT theo readApiBaseUrl():
  //  • Chế độ API (đã cấu hình apiBaseUrl): KHÔNG gọi initDb — dữ liệu đi qua REST (preload httpCall). Boot
  //    thẳng vào đăng nhập, KHÔNG để initDb chặn/treo. Đây là chế độ cho MÁY NGOÀI + máy thường.
  //  • Chế độ Postgres (không có apiBaseUrl): giữ nguyên initDb như cũ (máy chủ / bản cũ nối DB trực tiếp).
  if (isApiMode()) {
    // eslint-disable-next-line no-console
    console.log('[main] API-mode: bỏ qua initDb, dùng apiBaseUrl (dữ liệu qua máy chủ API).');
    // Mở khóa IPC dữ liệu: đa số handler đã chuyển httpCall (không đụng main IPC); vài handler CHƯA migrate
    // còn gọi getDb() sẽ tự ném lỗi tiếng Việt rõ (fail-graceful) thay vì bị chặn bằng thông điệp "DB chưa sẵn sàng".
    setDbReady(true);
  } else {
    try {
      // 4/8 (Admin Demo "cài xong rất lâu chưa lên app", "gỡ báo running") — GỐC: `await initDb()` TREO khi nối DB
      // qua cầu Cloudflare bị chậm/treo → createWindow (phía dưới) KHÔNG chạy → cửa sổ KHÔNG lên (process vẫn
      // sống → gỡ báo "running"). BỌC timeout 12s: dù initDb treo, sau 12s vẫn đi tiếp mở cửa sổ (fail-closed →
      // màn "Cấu hình máy chủ" để người dùng sửa/thử lại). initDb chạy tiếp ngầm, nếu xong sau đó thì lần mở kế OK.
      await Promise.race([
        initDb(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('initDb timeout 12s — nối DB quá lâu')), 12_000))
      ]);
      setDbReady(true); // P1-01: DB OK → mở khóa IPC dữ liệu
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[main] DB init failed:', err);
      // P1-01 FAIL-CLOSED: KHÔNG set dbReady → mọi IPC dữ liệu bị chặn; chỉ serverConfig/window/update dùng được
      // để người dùng sửa cấu hình kết nối. App vẫn mở (hiện màn cấu hình máy chủ) thay vì chạy trên DB hỏng.
    }
  }
  registerIpc();

  // Điều khiển cửa sổ tự vẽ (Mac traffic-light). Thao tác trên đúng cửa sổ gửi lệnh (fromWebContents).
  ipcMain.handle('window:minimize', (e) => { BrowserWindow.fromWebContents(e.sender)?.minimize(); });
  ipcMain.handle('window:toggle-maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return false;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return w.isMaximized();
  });
  ipcMain.handle('window:maximize', (e) => { BrowserWindow.fromWebContents(e.sender)?.maximize(); }); // gọi sau đăng nhập → full màn hình
  ipcMain.handle('window:close', (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); });
  ipcMain.handle('window:is-maximized', (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false);

  // R48 Pha 2 — SELFTEST: coi admin đã "đổi mật khẩu lần đầu" (bỏ forceChangePassword) để test thao tác;
  // nếu không, guard mới (R48 #4) sẽ CHẶN mọi thao tác của adminroot khi cờ còn bật. Chỉ DB throwaway.
  if (process.env['SIGMA_SELFTEST'] && process.env['SIGMA_SELFTEST'] !== '1' && process.env['SIGMA_SELFTEST'] !== '23') {
    try {
      const { getDb } = await import('./db.js');
      await getDb().user.updateMany({ where: { username: 'adminroot' }, data: { forceChangePassword: false } });
    } catch {
      /* bỏ qua — nếu lỗi, selftest sẽ tự báo */
    }
  }

  // Headless smoke test (CI / audit): SIGMA_SELFTEST=1 exercises the real login path then exits.
  if (process.env['SIGMA_SELFTEST'] === '1') {
    await runSelfTest();
    app.exit(0);
    return;
  }
  // Phase B integration self-test: drives role/user/audit/backup services through the real DB.
  if (process.env['SIGMA_SELFTEST'] === '2') {
    const { runServiceSelfTest } = await import('./selftest-phaseb.js');
    const code = await runServiceSelfTest();
    app.exit(code);
    return;
  }
  // G-POS.1 integration self-test: customer/POS/TID/code services + event log.
  if (process.env['SIGMA_SELFTEST'] === '3') {
    const { runGposSelfTest } = await import('./selftest-gpos.js');
    const code = await runGposSelfTest();
    app.exit(code);
    return;
  }
  // G-CFG.1 Cấu hình ngân hàng self-test: 50 đúng + 50 sai (Ngân hàng/Loại thẻ/Đối tác + liên kết).
  if (process.env['SIGMA_SELFTEST'] === '4') {
    const { runBankConfigSelfTest } = await import('./selftest-gcfg.js');
    const code = await runBankConfigSelfTest();
    app.exit(code);
    return;
  }
  // G-CFG.2 Cấu hình cung ứng POS self-test: 50 đúng + 50 sai (NCC/chủng loại/nhập kho).
  if (process.env['SIGMA_SELFTEST'] === '5') {
    const { runPosSupplySelfTest } = await import('./selftest-gcfg2.js');
    const code = await runPosSupplySelfTest();
    app.exit(code);
    return;
  }
  // G-CFG.3 Cấu hình phí self-test: 50 đúng + 50 sai (loại phí + biểu phí % + chênh lệch).
  if (process.env['SIGMA_SELFTEST'] === '7') {
    const { runFeeConfigSelfTest } = await import('./selftest-gcfg3.js');
    const code = await runFeeConfigSelfTest();
    app.exit(code);
    return;
  }
  if (process.env['SIGMA_SELFTEST'] === '8') {
    const { runReceiveAccountSelfTest } = await import('./selftest-gcfg4.js');
    const code = await runReceiveAccountSelfTest();
    app.exit(code);
    return;
  }
  if (process.env['SIGMA_SELFTEST'] === '9') {
    const { runDossierSelfTest } = await import('./selftest-gcfg5.js');
    const code = await runDossierSelfTest();
    app.exit(code);
    return;
  }
  if (process.env['SIGMA_SELFTEST'] === '10') {
    const { runTidConfigSelfTest } = await import('./selftest-gcfg6.js');
    const code = await runTidConfigSelfTest();
    app.exit(code);
    return;
  }
  // E4 Thùng rác self-test: 50 đúng + 50 sai (soft-delete → trash → restore + link warning).
  if (process.env['SIGMA_SELFTEST'] === '6') {
    const { runTrashSelfTest } = await import('./selftest-trash.js');
    const code = await runTrashSelfTest();
    app.exit(code);
    return;
  }
  // Nhóm A Bảo mật & tài khoản self-test: khóa 5 lần + reset đếm + đổi/đặt lại mật khẩu + hòm thư.
  if (process.env['SIGMA_SELFTEST'] === '11') {
    const { runNhomASelfTest } = await import('./selftest-nhoma.js');
    const code = await runNhomASelfTest();
    app.exit(code);
    return;
  }
  // Nhóm A #3 self-test: pass cấp 2 (đặt/đổi/khóa) + xóa vĩnh viễn + dọn sạch thùng rác.
  if (process.env['SIGMA_SELFTEST'] === '12') {
    const { runNhomA2SelfTest } = await import('./selftest-nhoma2.js');
    const code = await runNhomA2SelfTest();
    app.exit(code);
    return;
  }
  // Nhóm A #4 self-test: thùng rác per-user (deletedBy scope) + tên người xóa.
  if (process.env['SIGMA_SELFTEST'] === '13') {
    const { runNhomA3SelfTest } = await import('./selftest-nhoma3.js');
    const code = await runNhomA3SelfTest();
    app.exit(code);
    return;
  }
  // Nhóm B self-test: dashboard stats (KPI + tăng trưởng + bộ đếm theo chiều).
  if (process.env['SIGMA_SELFTEST'] === '14') {
    const { runDashboardSelfTest } = await import('./selftest-dashboard.js');
    const code = await runDashboardSelfTest();
    app.exit(code);
    return;
  }
  if (process.env['SIGMA_SELFTEST'] === '15') {
    const { runRevenueSelfTest } = await import('./selftest-revenue.js');
    const code = await runRevenueSelfTest();
    app.exit(code);
    return;
  }
  if (process.env['SIGMA_SELFTEST'] === '16') {
    const { runStorageSelfTest } = await import('./selftest-storage.js');
    const code = await runStorageSelfTest();
    app.exit(code);
    return;
  }
  if (process.env['SIGMA_SELFTEST'] === '17') {
    const { runHealthScanSelfTest } = await import('./selftest-healthscan.js');
    const code = await runHealthScanSelfTest();
    app.exit(code);
    return;
  }
  if (process.env['SIGMA_SELFTEST'] === '18') {
    const { runApprovalSelfTest } = await import('./selftest-approval.js');
    const code = await runApprovalSelfTest();
    app.exit(code);
    return;
  }
  // F-NOTIF self-test: đẩy thông báo sự kiện hủy bill vào hòm thư (đúng người nhận + idempotent).
  if (process.env['SIGMA_SELFTEST'] === '19') {
    const { runNotifySelfTest } = await import('./selftest-notify.js');
    const code = await runNotifySelfTest();
    app.exit(code);
    return;
  }
  // G10.5 stress-race tương tranh THẬT trên Postgres (=20): N client GHI ĐỒNG THỜI (Promise.all)
  // → guard G10.C phải giữ 1-winner; mã KH/NV không trùng. Đo bằng SELECT count/distinct DB thật.
  if (process.env['SIGMA_SELFTEST'] === '20') {
    const { runConcurrencySelfTest } = await import('./selftest-concurrency.js');
    const code = await runConcurrencySelfTest();
    app.exit(code);
    return;
  }
  // G10.C concurrency-correctness self-test (guard-logic tất định): conditional transition +
  // $transaction cho request/approve/reject (=21, race THẬT ở =20).
  if (process.env['SIGMA_SELFTEST'] === '21') {
    const { runGuardSelfTest } = await import('./selftest-guard.js');
    const code = await runGuardSelfTest();
    app.exit(code);
    return;
  }
  // G10.3 Cấu hình máy chủ self-test: testServerConfig (pg OK/lỗi) + validate gating +
  // saveServerConfig (ghi file round-trip + reinit) + getServerConfig phân loại trạng thái.
  if (process.env['SIGMA_SELFTEST'] === '22') {
    const { runServerConfigSelfTest } = await import('./selftest-servercfg.js');
    const code = await runServerConfigSelfTest();
    app.exit(code);
    return;
  }
  // G11 update wiring self-test (=23): pure-unit + autoUpdater mock (H3), KHÔNG cần DB/mạng/packaged (M3).
  if (process.env['SIGMA_SELFTEST'] === '23') {
    const { runUpdateSelfTest } = await import('./selftest-update.js');
    const code = await runUpdateSelfTest();
    app.exit(code);
    return;
  }
  // G-CFG.7 §11 Pha I1 Cấu hình ngành nghề self-test (=24): CRUD + audit + FORBIDDEN + "DB tiến hóa" quyền.
  if (process.env['SIGMA_SELFTEST'] === '24') {
    const { runIndustrySelfTest } = await import('./selftest-industry.js');
    const code = await runIndustrySelfTest();
    app.exit(code);
    return;
  }

  // PHASE H1 Thu–Chi: danh mục thu/chi self-test (=25): CRUD + affectsPnl I#12 + isSystem lock +
  // seed idempotent + audit + FORBIDDEN + "DB tiến hóa" quyền CASHCAT_*.
  if (process.env['SIGMA_SELFTEST'] === '25') {
    const { runCashCategorySelfTest } = await import('./selftest-cash-category.js');
    const code = await runCashCategorySelfTest();
    app.exit(code);
    return;
  }

  // PHASE H2-core Thu–Chi: Quỹ + Phiếu thu/chi + lợi nhuận accrual self-test (=26): I#1/I#3/I#4/I#10/I#13
  // + mã QU/PT/PC + IN_USE + hủy phiếu + FORBIDDEN + "DB tiến hóa" quyền FUND_*/CASHENTRY_*.
  if (process.env['SIGMA_SELFTEST'] === '26') {
    const { runCashEntrySelfTest } = await import('./selftest-cashentry.js');
    const code = await runCashEntrySelfTest();
    app.exit(code);
    return;
  }

  // PHASE H2-debt Thu công nợ: net-of-settlement (I#2) + DEBT_OVERPAY + settled hệ quả + quỹ (I#1)
  // + lợi nhuận không đổi (I#13) + hủy hoàn settlement + create thường chặn DEBT_* + H5 toggle vô hiệu.
  if (process.env['SIGMA_SELFTEST'] === '27') {
    const { runDebtReceiptSelfTest } = await import('./selftest-debtreceipt.js');
    const code = await runDebtReceiptSelfTest();
    app.exit(code);
    return;
  }

  // PHASE H2b Phân loại chất lượng công nợ + Ghi giảm nợ xấu self-test (=28): classify ghi log+audit,
  // chặn classify GD thu đủ (DEBT_FULLY_PAID), history, debtByQuality tổng net theo mức, write-off BAD →
  // CashEntry CHI "Chi phí nợ xấu" affectsPnl=true = nợ net, GD rớt khỏi công nợ, lợi nhuận GIẢM đúng,
  // idempotent (ALREADY_WRITTEN_OFF), sai mk (WRONG_ACTOR_PASSWORD), non-BAD chặn, SALES FORBIDDEN,
  // DB-evolution grant idempotent.
  if (process.env['SIGMA_SELFTEST'] === '28') {
    const { runDebtQualitySelfTest } = await import('./selftest-debtquality.js');
    const code = await runDebtQualitySelfTest();
    app.exit(code);
    return;
  }

  // PHASE K1 Hợp nhất POS self-test (=29): createPosIntake upsert PosDevice IN_STOCK + STOCK_IN
  // (desync #22), gán TID lên máy vừa nhập kho, backfill idempotent, recallPos/retirePos gỡ TID +
  // reportDamage/sendRepair giữ TID (Q-P6), concurrency 2 intake cùng serial, mọi máy có STOCK_IN.
  if (process.env['SIGMA_SELFTEST'] === '29') {
    const { runPosUnifySelfTest } = await import('./selftest-posunify.js');
    const code = await runPosUnifySelfTest();
    app.exit(code);
    return;
  }

  // PHASE K2 Hợp nhất TID self-test (=30): 4 tổ hợp Gán×Giao (gồm máy khách "chưa gán + đã giao"),
  // tạo chưa gán → assign sau, giao khi chưa gán (customerId+toAgentId+customerDeviceSerial), sự kiện
  // Giao đủ field, tidTimeline đúng thứ tự, regression assign/replace/recall/deliver, K1 compat
  // (recallPos→reassign / recallTid→RECALLED→assign FORBIDDEN), chưa-giao loại lifecycle+soft-delete
  // khớp badge, quyền vai (WAREHOUSE tạo+tidRefs OK / assign+SALES FORBIDDEN), D4 recallTid clear posSerial.
  if (process.env['SIGMA_SELFTEST'] === '30') {
    const { runTidUnifySelfTest } = await import('./selftest-tidunify.js');
    const code = await runTidUnifySelfTest();
    app.exit(code);
    return;
  }

  // PHASE IMPORT (#9) Nhập liệu hàng loạt từ Excel self-test (=31): 6 entity × (3 hợp lệ / thiếu bắt
  // buộc / FK không tồn tại / FK mơ hồ / partial 2+1 / sai vai FORBIDDEN) qua runImport → create THẬT.
  if (process.env['SIGMA_SELFTEST'] === '31') {
    const { runImportSelfTest } = await import('./selftest-import.js');
    const code = await runImportSelfTest();
    app.exit(code);
    return;
  }
  if (process.env['SIGMA_SELFTEST'] === '32') {
    const { runStatusSelfTest } = await import('./selftest-status.js');
    const code = await runStatusSelfTest();
    app.exit(code);
    return;
  }
  if (process.env['SIGMA_SELFTEST'] === '33') {
    const { runTidSellFeeSelfTest } = await import('./selftest-tidsellfee.js');
    const code = await runTidSellFeeSelfTest();
    app.exit(code);
    return;
  }
  if (process.env['SIGMA_SELFTEST'] === '34') {
    const { runEntityCancelSelfTest } = await import('./selftest-entity-cancel.js');
    const code = await runEntityCancelSelfTest();
    app.exit(code);
    return;
  }
  if (process.env['SIGMA_SELFTEST'] === '35') {
    const { runSessionSelfTest } = await import('./selftest-session.js');
    const code = await runSessionSelfTest();
    app.exit(code);
    return;
  }
  if (process.env['SIGMA_SELFTEST'] === '36') {
    const { runBackupSelfTest } = await import('./selftest-backup.js');
    const code = await runBackupSelfTest();
    app.exit(code);
    return;
  }
  // R48 #2 optimistic-lock (chống 2 người sửa đè): mốc updatedAt cũ → STALE_WRITE; mốc mới → ok; không mốc → ok.
  if (process.env['SIGMA_SELFTEST'] === '37') {
    const { runOptLockSelfTest } = await import('./selftest-optlock.js');
    const code = await runOptLockSelfTest();
    app.exit(code);
    return;
  }
  // R48 Pha 4 realtime: version change-token tăng đúng miền (targetType), không nhiễu chéo; pendingCancels hợp lệ.
  if (process.env['SIGMA_SELFTEST'] === '38') {
    const { runRealtimeSelfTest } = await import('./selftest-realtime.js');
    const code = await runRealtimeSelfTest();
    app.exit(code);
    return;
  }
  if (process.env['SIGMA_SELFTEST'] === '39') {
    const { runPosLifecycleSelfTest } = await import('./selftest-poslifecycle.js');
    const code = await runPosLifecycleSelfTest();
    app.exit(code);
    return;
  }
  if (process.env['SIGMA_SELFTEST'] === '40') {
    const { runWarehouseSelfTest } = await import('./selftest-warehouse.js');
    const code = await runWarehouseSelfTest();
    app.exit(code);
    return;
  }
  if (process.env['SIGMA_SELFTEST'] === '41') {
    const { runDeviceSaleSelfTest } = await import('./selftest-devicesale.js');
    const code = await runDeviceSaleSelfTest();
    app.exit(code);
    return;
  }
  // LOẠI GIAO MÁY (Admin Demo): Bán/Cho thuê/Mượn/Cọc — mô hình tiền theo loại giao + hoàn cọc khi recall.
  if (process.env['SIGMA_SELFTEST'] === '42') {
    const { runHandoverSelfTest } = await import('./selftest-handover.js');
    const code = await runHandoverSelfTest();
    app.exit(code);
    return;
  }
  // PHASE 1 (Admin Demo 13/7): Yêu cầu xuất kho POS/TID → Duyệt → đối trừ tồn kho (money-exact).
  if (process.env['SIGMA_SELFTEST'] === '43') {
    const { runExportRequestSelfTest } = await import('./selftest-export-request.js');
    const code = await runExportRequestSelfTest();
    app.exit(code);
    return;
  }
  // Bill giải trình (Admin Demo 16/7): thư viện SP CRUD/import + sinh bill money-exact + theo dõi + guard quyền.
  if (process.env['SIGMA_SELFTEST'] === '44') {
    const { runBillExplainSelfTest } = await import('./selftest-billexplain.js');
    const code = await runBillExplainSelfTest();
    app.exit(code);
    return;
  }

  await createWindow();
  startHousekeeping();

  // G11: dịch vụ cập nhật tích hợp — đánh giá marker (H4) + IPC (H2 pull) + updater khi đóng gói.
  // Lỗi được nuốt để KHÔNG làm chết app (offline-safe cực đoan).
  try {
    const { registerUpdateService } = await import('./update-service.js');
    await registerUpdateService({
      getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
      isPackaged: app.isPackaged,
      version: app.getVersion()
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[update] registerUpdateService failed', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Storage-Guard (Nhóm E): backup định kỳ 1 lần/ngày + kiểm tra ngưỡng bộ nhớ mỗi giờ.
// Chạy 1 lần khi khởi động, sau đó lặp mỗi giờ. Lỗi được nuốt để không làm sập app.
let housekeepingTimer: ReturnType<typeof setInterval> | undefined;
function startHousekeeping(): void {
  const tick = async (): Promise<void> => {
    try {
      const { getDb, isServerRole } = await import('./db.js');
      // A1 (Admin Demo 16/7): bảo trì nền (backup định kỳ / dọn dẹp / đo ổ đĩa) CHỈ chạy trên MÁY CHỦ.
      // Máy trạm không có pg_dump + data_directory là đường dẫn máy khác → bỏ qua để không sinh lỗi/cảnh báo sai.
      if (!isServerRole()) return;
      const { systemBackupIfDue, systemStorageCheck, systemWeeklyMaintenanceIfDue, backupWatchdog } = await import('./storage-service.js');
      const db = getDb();
      await systemBackupIfDue(db);
      await systemWeeklyMaintenanceIfDue(db);
      await backupWatchdog(db); // C2 (R48): cảnh báo nếu bản sao lưu quá hạn (chống "sót backup")
      await systemStorageCheck(db);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[housekeeping] tick failed', err);
    }
  };
  void tick();
  if (housekeepingTimer) clearInterval(housekeepingTimer);
  housekeepingTimer = setInterval(() => void tick(), 60 * 60 * 1000);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

async function runSelfTest(): Promise<void> {
  const log = (o: unknown): void => console.log('SELFTEST ' + JSON.stringify(o));
  // 1) wrong password → deny, must not leak status
  const bad = await auth.login('adminroot', 'wrongpassword');
  log({ step: 'wrong_password', ok: bad.ok, error: bad.error });
  // 2) correct default admin → allow + mustChangePassword
  const good = await auth.login('adminroot', 'Admin@123456');
  log({
    step: 'admin_login',
    ok: good.ok,
    mustChange: good.mustChangePassword,
    roles: good.user?.roles,
    perms: good.user?.permissions.length
  });
  // 3) change password (then restore so the test is repeatable)
  const NEW = 'Demo@2026new';
  const chg = await auth.login && (await auth.changePassword('Admin@123456', NEW));
  log({ step: 'change_password', ok: chg?.ok, error: chg?.error });
  if (chg?.ok) {
    const restore = await auth.changePassword(NEW, 'Admin@123456');
    log({ step: 'restore_password', ok: restore.ok });
  }
  // 4) me() reflects logged-in user
  log({ step: 'me', user: auth.me()?.username ?? null });
}
