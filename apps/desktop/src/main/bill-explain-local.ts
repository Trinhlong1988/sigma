// Bill giải trình — phần CỤC BỘ PER-MACHINE (R201 21/8). Máy client API-mode KHÔNG có DB → resolve đường dẫn
// template/thư-mục-xuất + đọc/ghi mẫu riêng KHÔNG được đi qua getDb() (ném). Các hàm ở đây CHỈ dùng Electron
// app-path + fs (KHÔNG DB): main render file .xlsx cục bộ dùng chúng; phần DB (số HĐ) đi qua quanly-api.
//
// outputDir = per-machine (mỗi máy tự chọn thư mục xuất) → GIỮ CỤC BỘ, KHÔNG centralize vào AppSetting dùng
// chung (tránh máy A ghi path máy A vào DB, máy B đọc trỏ sai). Lưu override ở userData/billexplain-local.json.
// Template riêng vẫn copy vào userData (billExplain:importTemplate desktop cũ) — path deterministic per-machine.
import { app, dialog, BrowserWindow } from 'electron';
import path from 'node:path';
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, unlink } from 'node:fs/promises';

const CUSTOM_TEMPLATE_FILE = 'billexplain-custom-template.xlsx'; // KHỚP bill-explain-service.ts (import mẫu riêng)
const LOCAL_CONFIG_FILE = 'billexplain-local.json'; // override outputDir per-machine

/** Template MẶC ĐỊNH đóng gói kèm app (extraResources). Dev đọc từ build/. KHỚP defaultTemplatePath desktop cũ. */
export function defaultTemplatePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'billexplain-template.xlsx')
    : path.join(app.getAppPath(), 'build', 'billexplain-template.xlsx');
}
/** Đường dẫn mẫu riêng (nếu user import) — cố định trong userData máy này. */
export function customTemplatePath(): string {
  return path.join(app.getPath('userData'), CUSTOM_TEMPLATE_FILE);
}
export function customTemplateExists(): boolean {
  try { return existsSync(customTemplatePath()); } catch { return false; }
}
/** Template thực dùng để render: mẫu riêng cục bộ (nếu có) → mặc định đóng gói. */
export function resolveLocalTemplatePath(): string {
  const c = customTemplatePath();
  if (existsSync(c)) return c;
  return defaultTemplatePath();
}

function localConfigPath(): string {
  return path.join(app.getPath('userData'), LOCAL_CONFIG_FILE);
}
export function getLocalOutputDirOverride(): string | null {
  try {
    const p = localConfigPath();
    if (!existsSync(p)) return null;
    const cfg = JSON.parse(readFileSync(p, 'utf8')) as { outputDir?: unknown };
    return typeof cfg.outputDir === 'string' && cfg.outputDir.trim() ? cfg.outputDir : null;
  } catch {
    return null;
  }
}
/** Thư mục xuất bill (override per-machine nếu có, else mặc định documents/GLB-BillGiaiTrinh). KHỚP desktop cũ. */
export function resolveLocalOutputDir(): string {
  const o = getLocalOutputDirOverride();
  return o && o.trim() ? o : path.join(app.getPath('documents'), 'GLB-BillGiaiTrinh');
}
/** Đặt outputDir per-machine. LOW-C: nếu path đã tồn tại PHẢI là thư mục (chặn trỏ .exe → openFolder RCE). */
export function setLocalOutputDir(dir: string): { ok: boolean; error?: string; message?: string } {
  const d = String(dir ?? '').trim();
  if (d && existsSync(d)) {
    try { if (!statSync(d).isDirectory()) return { ok: false, error: 'VALIDATION', message: 'Đường dẫn lưu bill phải là thư mục.' }; } catch { /* không stat được → để render/mkdir xử lý sau */ }
  }
  try {
    writeFileSync(localConfigPath(), JSON.stringify({ outputDir: d }), 'utf8');
  } catch (e) {
    return { ok: false, error: 'WRITE_FAILED', message: e instanceof Error ? e.message : 'Không lưu được cấu hình thư mục.' };
  }
  return { ok: true };
}

// ── R201: thao tác MẪU hóa đơn RIÊNG — phần CỤC BỘ (dialog + copy/xóa file userData). Con trỏ DB (K_TEMPLATE_PATH)
//    do preload ghi qua PUT /v1/bill-explain/config (PRODUCT_MANAGE). Cũ importInvoiceTemplate/... dùng getDb → chết.
/** Import mẫu riêng: dialog chọn .xlsx → validate (TemplateZip) → copy vào userData. Trả path userData để set con trỏ DB. */
export async function importTemplateFileLocal(): Promise<{ ok: boolean; error?: string; message?: string; templatePath?: string }> {
  const win = BrowserWindow.getFocusedWindow();
  const opts: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'Excel', extensions: ['xlsx'] }], title: 'Chọn mẫu hóa đơn (.xlsx)' };
  const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (pick.canceled || !pick.filePaths[0]) return { ok: false, error: 'CANCELLED' };
  const src = pick.filePaths[0];
  // Kiểm nhanh file .xlsx hợp lệ (zip có sheet1) — thử load bằng engine để chặn file hỏng. GIỮ NGUYÊN desktop cũ.
  try {
    const { TemplateZip } = await import('./billexplain/template-zip.js');
    await TemplateZip.fromFile(src);
  } catch (e) {
    return { ok: false, error: 'INVALID_TEMPLATE', message: 'File không phải mẫu Excel hợp lệ: ' + (e instanceof Error ? e.message : '') };
  }
  const dst = customTemplatePath();
  try {
    await copyFile(src, dst);
  } catch (e) {
    return { ok: false, error: 'COPY_FAILED', message: e instanceof Error ? e.message : 'Không sao chép được mẫu.' };
  }
  return { ok: true, templatePath: dst };
}
/** Về mẫu mặc định: XÓA file mẫu riêng userData (nếu có). Con trỏ DB do preload xóa qua config route. */
export async function resetTemplateFileLocal(): Promise<{ ok: boolean; error?: string; message?: string }> {
  const dst = customTemplatePath();
  try {
    if (existsSync(dst)) await unlink(dst);
  } catch (e) {
    return { ok: false, error: 'DELETE_FAILED', message: e instanceof Error ? e.message : 'Không xóa được mẫu riêng.' };
  }
  return { ok: true };
}
/** Xuất mẫu ĐANG DÙNG (riêng-nếu-có else mặc định) ra file người dùng chọn. THUẦN LOCAL (không DB). */
export async function exportTemplateFileLocal(): Promise<{ ok: boolean; error?: string; message?: string; file?: string }> {
  const src = resolveLocalTemplatePath();
  if (!existsSync(src)) return { ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy mẫu hóa đơn hiện tại.' };
  const win = BrowserWindow.getFocusedWindow();
  const opts: Electron.SaveDialogOptions = { defaultPath: 'MAU_HOA_DON.xlsx', filters: [{ name: 'Excel', extensions: ['xlsx'] }], title: 'Xuất mẫu hóa đơn' };
  const pick = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (pick.canceled || !pick.filePath) return { ok: false, error: 'CANCELLED' };
  try {
    await copyFile(src, pick.filePath);
  } catch (e) {
    return { ok: false, error: 'COPY_FAILED', message: e instanceof Error ? e.message : 'Không xuất được mẫu.' };
  }
  return { ok: true, file: pick.filePath };
}
