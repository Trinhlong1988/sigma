// G11 — Cập nhật phần mềm tích hợp (electron-updater qua LAN).
// Luồng Admin Demo chốt: push "có bản mới" → user xác nhận → tải (thanh %) → app tự thoát →
// cài im lặng (perUser) → tự mở lại → báo kết quả (marker).
//
// Nguyên tắc phản biện đã vá:
// - [H1] quitAndInstall(true, true): isSilent=true (cài IM, /S) + forceRunAfter=true (tự mở lại).
//         (false,true) sẽ BUNG wizard NSIS — SAI.
// - [H2] Trạng thái BOOT (success/failed) KHÔNG push (renderer chưa mount → rơi). Renderer PULL qua
//         update:getBootResult lúc mount. Cửa sổ tham chiếu qua getWindow() (index.ts giữ ref mainWindow).
// - [H3] Tách pure-unit (isNewer / marker RW / evalMarker) + cho INJECT autoUpdater (mock) qua startUpdater
//         → selftest=23 test THẬT không cần packaged/mạng.
// - [H4] Xoá marker ở CẢ nhánh success VÀ failed (không xoá nhánh failed = báo lỗi đỏ vô hạn).
// - [M4] cờ isDownloading chống double-download. [M6] JSON hỏng → coi none, KHÔNG throw.
// - offline-safe: check/download ném lỗi → nuốt trong try/catch, app vẫn chạy bình thường.
import { existsSync, readFileSync, writeFileSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import {
  evalMarkerTai,
  ghiNhatKyVao,
  readMarkerTu,
  writeMarkerVao,
  clearMarkerTai,
  soSanhPhienBan,
  locBanMoi
} from './update-marker.js';
import type { UpdateMarker, BootResult } from './update-marker.js';
export type { UpdateMarker, BootResult } from './update-marker.js';
export { soSanhPhienBan } from './update-marker.js';

// ── Kiểu ────────────────────────────────────────────────────────────────────

/** Bề mặt tối thiểu của electron-updater mà service dùng — cho phép bơm mock (H3). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  disableDifferentialDownload?: boolean; // 3/9 — TẮT differential (blockmap) → tránh "null byte (1:1)" máy cũ (incident 2/9)
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** Cửa sổ tối thiểu để gửi sự kiện realtime tới renderer. */
export interface WindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}

export interface StartDeps {
  updater: UpdaterLike;
  getWindow: () => WindowLike | null;
  isPackaged: boolean;
  /** Ghi marker trước quitAndInstall. Mặc định userData/update-result.json. Cho selftest bơm file tạm. */
  markerFile?: string;
  /** Phiên bản hiện tại (app.getVersion). Dùng cho marker.fromVersion. */
  currentVersion?: string;
  /** Chu kỳ kiểm tra (ms). Mặc định 60 phút. */
  intervalMs?: number;
}

/** Điều khiển do startUpdater trả — IPC gọi vào + selftest kiểm cờ. */
/** [B226] Kết quả hỏi máy chủ cập nhật — PHẢI phân biệt "hỏi xong, không có bản mới" với "chưa hỏi được". */
export interface KetQuaHoiCapNhat {
  ok: boolean;
  version?: string | null; // bản MỚI NHẤT TRÊN FEED (có thể BẰNG bản đang chạy — xem coBanMoi)
  /** [B250] true khi bản trên feed THỰC SỰ mới hơn bản đang chạy. Đừng suy từ `version` — feed luôn
   *  trả bản mới nhất của nó, kể cả khi mình đang chạy đúng bản đó. */
  coBanMoi?: boolean;
  message?: string; // lý do khi ok=false
}

export interface UpdaterController {
  /** [B226 21/11] TRẢ KẾT QUẢ THẬT: hỏi được không, và nếu được thì bản trên máy chủ là bản nào. */
  check(nguoiDungBam?: boolean): Promise<KetQuaHoiCapNhat>;
  start(): Promise<void>;
  installNow(): void;
  isDownloading(): boolean;
  /** [H2b] Bản mới nhất đã biết (PULL lúc mount — push 'update-available' có thể rơi nếu bắn trước khi
   * renderer kịp đăng ký listener, y hệt lớp lỗi H2 của boot marker). null nếu chưa từng thấy bản mới. */
  getLastAvailable(): { version: string } | null;
  /** Dừng interval (dọn tài nguyên; selftest). */
  stop(): void;
}

// ── Pure-unit: so sánh semver (H3, ca b) ─────────────────────────────────────
function parseSemver(v: string): number[] {
  // Bỏ tiền tố 'v' + phần prerelease/build; lấy major.minor.patch dạng số.
  const core = String(v).trim().replace(/^v/i, '').split(/[-+]/)[0];
  return core.split('.').map((x) => {
    const n = parseInt(x, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/** True nếu `next` MỚI HƠN `cur` theo semver (0.1.10 > 0.1.9 — KHÔNG so chuỗi). */
export function isNewer(cur: string, next: string): boolean {
  const a = parseSemver(cur);
  const b = parseSemver(next);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

// ── Marker/nhật ký: logic THUẦN nằm ở `update-marker.ts` (không import electron) để cổng tự kiểm
//    chạy được; ở đây chỉ bọc thêm đường dẫn userData của Electron. ──
export function nhatKyPath(): string {
  return join(app.getPath('userData'), 'update-log.txt');
}
export function ghiNhatKy(viec: string, chiTiet?: unknown, file?: string): void {
  ghiNhatKyVao(file ?? nhatKyPath(), viec, chiTiet);
}
/** Đường dẫn marker mặc định (userData/update-result.json). */
export function markerPath(): string {
  return join(app.getPath('userData'), 'update-result.json');
}
export function writeMarker(m: UpdateMarker, file: string = markerPath()): void {
  writeMarkerVao(file, m);
}
export function readMarker(file: string = markerPath()): UpdateMarker | null {
  return readMarkerTu(file);
}
export function clearMarker(file: string = markerPath()): void {
  clearMarkerTai(file);
}
/** Đánh giá marker lúc khởi động rồi XOÁ (H4 — cả success VÀ failed). Chi tiết luật: update-marker.ts */
export function evalMarker(curVersion: string, file: string = markerPath()): BootResult {
  let nk: string | undefined;
  try { nk = nhatKyPath(); } catch { nk = undefined; }
  return evalMarkerTai(curVersion, file, nk);
}

// ── Diễn giải lỗi người-đọc-được (offline-safe message) ──────────────────────
export function humanizeUpdateError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const raw = (e?.message ?? String(err)) || 'Lỗi không xác định';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return 'Không tìm thấy máy chủ cập nhật (kiểm tra kết nối mạng LAN).';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|net::|ENETUNREACH/i.test(raw)) return 'Không kết nối được máy chủ cập nhật (server tắt hoặc mất mạng).';
  if (/ENOSPC/i.test(raw)) return 'Ổ đĩa không đủ dung lượng để tải bản cập nhật.';
  if (/sha512|checksum|integrity/i.test(raw)) return 'File cập nhật tải về bị hỏng (sai mã kiểm tra). Vui lòng thử lại.';
  return 'Cập nhật lỗi: ' + raw;
}

// ── startUpdater: DI updater (H3) + dev-guard (ca a) ──────────────────────────
export function startUpdater(deps: StartDeps): UpdaterController {
  const noop: UpdaterController = {
    check: async () => ({ ok: true, version: null }),
    start: async () => {},
    installNow: () => {},
    isDownloading: () => false,
    getLastAvailable: () => null,
    stop: () => {}
  };
  // [dev-guard] KHÔNG đóng gói → KHÔNG khởi động updater (tránh crash dev/selftest). (ca a)
  if (!deps.isPackaged) return noop;

  const { updater, getWindow } = deps;
  const marker = deps.markerFile ?? markerPath();
  const currentVersion = deps.currentVersion ?? '0.0.0';
  // [B215 20/11 — Admin Demo "chưa lên feed"] App CHỈ hỏi feed lúc khởi động rồi mỗi 60 phút. Đo thật 20/11:
  // feed đã có 0.2.160 mà app đang mở (0.2.159) chưa biết, vì chưa tới lượt hỏi ⇒ Admin Demo tưởng chưa đẩy bản.
  // Rút còn 10 phút, và thêm nút bấm tay ở thanh bên để khỏi phải chờ.
  const intervalMs = deps.intervalMs ?? 10 * 60 * 1000;

  let downloading = false;
  let installing = false;
  let pendingVersion: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  // [H2b] Giữ lại bản mới nhất đã thấy — PULL lúc mount, không chỉ push (chống rơi sự kiện).
  let lastAvailable: { version: string } | null = null;

  const send = (channel: string, payload: unknown): void => {
    const w = getWindow();
    if (w && !w.isDestroyed()) {
      try {
        w.webContents.send(channel, payload);
      } catch {
        /* cửa sổ có thể đã đóng — bỏ qua */
      }
    }
  };

  updater.autoDownload = false; // no-auto-without-consent — chỉ tải khi user bấm.
  updater.autoInstallOnAppQuit = true;
  // 3/9 — TẮT differential download (blockmap). electron-updater diff parse blockmap → máy bản cũ sinh chuỗi có
  // \0 → js-yaml ném "null byte is not allowed in input (1:1)", systemic MỌI máy cũ (incident 2/9 SigMa).
  // App sideload LAN → tải FULL exe (~100MB) chấp nhận được. Đi kèm: publish-quanly-alpha.mjs KHÔNG đẩy blockmap.
  updater.disableDifferentialDownload = true;

  updater.on('update-available', (info: unknown) => {
    const version = (info as { version?: string })?.version ?? '';
    // [B250] Chặn luôn ở đây: chỉ nhận bản THỰC SỰ MỚI HƠN bản đang chạy.
    const moi = locBanMoi(version, currentVersion);
    if (!moi) {
      ghiNhatKy('bỏ qua "có bản mới" vì KHÔNG mới hơn bản đang chạy', { feed: version, dang: currentVersion });
      return;
    }
    lastAvailable = moi; // [H2b] lưu lại TRƯỚC — renderer mount sau vẫn PULL được.
    send('update-available', { version });
  });
  updater.on('download-progress', (p: unknown) => {
    const percent = (p as { percent?: number })?.percent ?? 0;
    send('download-progress', { percent });
  });
  updater.on('update-downloaded', (info: unknown) => {
    pendingVersion = (info as { version?: string })?.version ?? pendingVersion;
    send('update-downloaded', { version: pendingVersion ?? '' });
  });
  updater.on('error', (err: unknown) => {
    const dangTai = downloading;
    ghiNhatKy('LỖI updater', { dangTai, hoiTay, loi: humanizeUpdateError(err), goc: String((err as { message?: string })?.message ?? err) });
    downloading = false; // [M4/f] cho phép retry sau lỗi (không kẹt cờ).
    // [B242 22/11 — Admin Demo "sao cứ có feed rồi báo cập nhật thất bại thế"] CHỈ báo đỏ khi lỗi xảy ra
    // trong việc NGƯỜI DÙNG đang làm: đang tải bản mới, hoặc vừa tự bấm "Kiểm tra cập nhật".
    //
    // GỐC: app tự hỏi feed MỖI 10 PHÚT (B215 rút từ 60 xuống 10). Mỗi lần mạng chớp/máy chủ bận là
    // electron-updater phát `error` ⇒ gửi thẳng lên màn ⇒ banner đỏ "Cập nhật thất bại" hiện lại
    // liên tục dù GÓI CẬP NHẬT HOÀN TOÀN BÌNH THƯỜNG (đo 22/11: tải EXE từ tên miền công khai về,
    // sha512 khớp từng ký tự với latest.yml, đúng 111.297.176 byte).
    // Lỗi của lần hỏi NỀN: ghi log rồi thôi — app vẫn chạy, lần hỏi sau tự khỏi. Đúng tinh thần
    // offline-safe đã chốt cho `check()`.
    if (dangTai || hoiTay) {
      send('update-error', { message: humanizeUpdateError(err) });
    } else {
      // eslint-disable-next-line no-console
      console.warn('[update] lần hỏi feed NỀN gặp lỗi (không báo lên màn):', humanizeUpdateError(err));
    }
  });

  // [B242] TRUE trong lúc người dùng TỰ BẤM "Kiểm tra cập nhật" — để lỗi lúc đó vẫn báo lên màn.
  let hoiTay = false;

  const check = async (nguoiDungBam = false): Promise<KetQuaHoiCapNhat> => {
    if (nguoiDungBam) hoiTay = true;
    // [B226 21/11 — Admin Demo "bấm cập nhật không tải được"] TRƯỚC ĐÂY hàm này NUỐT LỖI rồi trả void.
    // Màn hình đành phải chờ cứng 2,5 giây rồi đọc bộ nhớ sự kiện: mạng chậm hoặc máy chủ lỗi ⇒ bộ nhớ
    // còn rỗng ⇒ app báo "Đang dùng bản mới nhất" DÙ CHƯA HỎI ĐƯỢC. Người dùng tưởng app hỏng.
    // Nay trả KẾT QUẢ THẬT: hỏi được/không, và bản trên máy chủ là bản nào (R198 — cấm nuốt im).
    // Vẫn offline-safe: KHÔNG ném lỗi ra ngoài, app chạy bình thường khi mất mạng.
    try {
      const r = (await updater.checkForUpdates()) as { updateInfo?: { version?: string } } | null;
      const v = r?.updateInfo?.version ?? null;
      // [B250] `checkForUpdates()` trả bản mới nhất TRÊN FEED dù KHÔNG mới hơn ⇒ phải lọc trước khi
      // lưu, nếu không banner PULL ra và báo "có bản mới" chính bản đang chạy.
      const moi = locBanMoi(v, currentVersion);
      lastAvailable = moi;
      if (v && !moi) ghiNhatKy('hỏi feed: KHÔNG có bản mới', { feed: v, dang: currentVersion });
      return { ok: true, version: v, coBanMoi: moi != null };
    } catch (err) {
      return { ok: false, message: humanizeUpdateError(err) };
    } finally {
      // Nhả cờ SAU một nhịp: sự kiện `error` của electron-updater có thể tới ngay sau khi promise kết thúc.
      if (nguoiDungBam) setTimeout(() => { hoiTay = false; }, 3000);
    }
  };

  const start = async (): Promise<void> => {
    if (downloading) return; // [M4] đang tải → bỏ qua, không gọi downloadUpdate 2 lần.
    downloading = true;
    try {
      await updater.downloadUpdate();
    } catch (err) {
      downloading = false; // cho phép [Cập nhật lại].
      send('update-error', { message: humanizeUpdateError(err) });
    }
  };

  const installNow = (): void => {
    if (installing) return; // gọi 1 lần (ca d).
    installing = true;
    try {
      ghiNhatKy('bấm CÀI ĐẶT', { dich: pendingVersion ?? '(chưa biết số bản)', dang: currentVersion });
      writeMarker({ targetVersion: pendingVersion ?? '', fromVersion: currentVersion, startedAt: new Date().toISOString() }, marker);
    } catch {
      /* không ghi được marker vẫn tiếp tục cài — chỉ mất thông báo kết quả */
    }
    // [H1] isSilent=true (cài IM), forceRunAfter=true (tự mở lại).
    updater.quitAndInstall(true, true);
  };

  // Kiểm tra lúc "ready" + định kỳ mỗi 60' (bọc try/catch trong check()).
  void check();
  timer = setInterval(() => void check(), intervalMs);
  if (typeof timer === 'object' && timer && 'unref' in timer) (timer as { unref: () => void }).unref();

  return {
    check,
    start,
    installNow,
    isDownloading: () => downloading,
    getLastAvailable: () => lastAvailable,
    stop: () => {
      if (timer) clearInterval(timer);
    }
  };
}

// ── Wiring cho app path bình thường (index.ts gọi) ───────────────────────────
export interface RegisterDeps {
  getWindow: () => WindowLike | null;
  isPackaged: boolean;
  version: string;
}

let registered = false;

/**
 * Khởi tạo dịch vụ cập nhật cho app path bình thường:
 * - Đánh giá marker lúc boot → bootResult (in-memory) cho renderer PULL (H2).
 * - Đăng ký IPC: update:check/start/installNow/getBootResult + app:getVersion.
 * - Nếu đóng gói: nạp electron-updater (externalized, dynamic require — L1) + startUpdater.
 */
export async function registerUpdateService(deps: RegisterDeps): Promise<void> {
  if (registered) return;
  registered = true;

  const bootResult = evalMarker(deps.version); // đánh giá + xoá marker NGAY (H4).
  let bootConsumed = false;

  let controller: UpdaterController;
  if (deps.isPackaged) {
    let updater: UpdaterLike;
    try {
      // B85 (Admin Demo yêu cầu "mở lên xem bằng chứng" 22/7 — bắt được CRASH THẬT trên bản đóng gói,
      // không phải suy luận): electron-updater là CommonJS, xuất `autoUpdater` qua
      // `Object.defineProperty(exports,'autoUpdater',{get(){...}})` (getter, KHÔNG phải gán thường
      // `exports.autoUpdater = ...`). Bộ dựng CJS→ESM (rollup/commonjs-plugin trong electron-vite,
      // cả cjs-module-lexer của Node) phân tích TĨNH mã nguồn để suy named-export — kiểu getter này
      // là điểm mù kinh điển, nên `mod.autoUpdater` ra `undefined` trên BẢN ĐÓNG GÓI (dù `import()`
      // không ném lỗi — module vẫn nạp được, chỉ thiếu đúng named export). Code cũ gán thẳng
      // `updater = mod.autoUpdater` (undefined) KHÔNG ném ở đây → registerUpdateService() crash Ở
      // NGOÀI try/catch này (dòng `updater.autoDownload = false` trong startUpdater) → toàn bộ
      // wireIpc() KHÔNG chạy → mọi IPC update:* mất trắng, banner/backup-boot-marker câm lặng vĩnh
      // viễn. selftest=23 KHÔNG bắt được vì luôn bơm mock updater (H3), chưa từng import package thật.
      // Fix: thử CẢ 2 hình dạng interop có thể có (`mod.autoUpdater` lẫn `mod.default.autoUpdater`),
      // ném lỗi rõ ràng NGAY TẠI ĐÂY nếu cả 2 đều thiếu (để nhánh catch xử lý, không crash ra ngoài).
      const mod = (await import('electron-updater')) as unknown as {
        autoUpdater?: UpdaterLike;
        default?: { autoUpdater?: UpdaterLike };
      };
      const resolved = mod.autoUpdater ?? mod.default?.autoUpdater;
      if (!resolved) {
        throw new Error(`electron-updater module không có autoUpdater (khóa nạp được: ${Object.keys(mod).join(',')})`);
      }
      updater = resolved;
    } catch (err) {
      // Không nạp được electron-updater → app vẫn chạy (offline-safe cực đoan).
      // eslint-disable-next-line no-console
      console.error('[update] không nạp được electron-updater:', err);
      controller = startUpdater({ updater: dummyUpdater(), getWindow: deps.getWindow, isPackaged: false });
      wireIpc();
      return;
    }
    controller = startUpdater({
      updater,
      getWindow: deps.getWindow,
      isPackaged: true,
      currentVersion: deps.version
    });
  } else {
    controller = startUpdater({ updater: dummyUpdater(), getWindow: deps.getWindow, isPackaged: false });
  }
  wireIpc();

  function wireIpc(): void {
    // [B242] Gọi qua IPC = NGƯỜI DÙNG tự bấm ⇒ lỗi lúc này VẪN báo lên màn (khác lần hỏi nền).
    ipcMain.handle('update:check', async () => controller.check(true));
    ipcMain.handle('update:start', async () => controller.start());
    ipcMain.handle('update:installNow', async () => controller.installNow());
    ipcMain.handle('update:getBootResult', async () => {
      // Pull 1 lần (H2). Lấy xong đánh dấu đã-tiêu-thụ.
      if (bootConsumed) return null;
      bootConsumed = true;
      return bootResult.kind === 'none' ? null : bootResult;
    });
    // [H2b] PULL bản mới nhất đã biết — KHÔNG tiêu thụ (renderer có thể mount lại nhiều lần trước khi
    // user cài; mỗi lần mount đều phải thấy banner nếu bản mới chưa được cài).
    ipcMain.handle('update:getLastAvailable', async () => controller.getLastAvailable());
    ipcMain.handle('app:getVersion', async () => deps.version);
  }
}

/** Updater rỗng (dev / không nạp được electron-updater) — mọi thao tác no-op. */
function dummyUpdater(): UpdaterLike {
  return {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    on: () => undefined,
    checkForUpdates: async () => null,
    downloadUpdate: async () => null,
    quitAndInstall: () => {}
  };
}
