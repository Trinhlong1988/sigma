// Regression guard (7/8, Admin Demo "exe không nhận push") — GỐC bug: cửa sổ SigMa bấm X thu vào tray (chạy
// nền để giữ WS chat sống), NHƯNG webPreferences THIẾU `backgroundThrottling: false` → Chromium bóp ga renderer
// khi cửa sổ ẩn → handler realtime WS + dispatch OS Notification không chạy kịp → không hiện push. Bug này
// KHÔNG lọt qua unit-test renderer (thuộc main process Electron) nên đặt guard TĨNH đọc thẳng main.js +
// electron-builder.yml để đảm bảo các BẤT BIẾN sống-còn của app chat-chạy-nền không bị gỡ nhầm lần sau.
//
// R198: check phải THỰC SỰ chạy — mỗi assert đọc file thật (fail-loud nếu không đọc được), không nuốt lỗi.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PC_DIR = path.resolve(HERE, '../../../sigma-pc');
const mainJs = readFileSync(path.join(PC_DIR, 'src', 'main.js'), 'utf8');
const builderYml = readFileSync(path.join(PC_DIR, 'electron-builder.yml'), 'utf8');

describe('SigMa PC — bất biến main process (app chat chạy nền/tray)', () => {
  it('TẮT backgroundThrottling để renderer nhận WS + bắn push khi ở nền/tray (GỐC bug push 7/8)', () => {
    // Chấp nhận khoảng trắng linh hoạt quanh dấu hai chấm; chặn cả trường hợp bị đặt lại thành true.
    expect(mainJs).toMatch(/backgroundThrottling\s*:\s*false/);
    expect(mainJs).not.toMatch(/backgroundThrottling\s*:\s*true/);
  });

  it('AppUserModelId KHỚP appId cài đặt (nếu lệch → Windows nuốt toast im, không hiện thông báo)', () => {
    const m = mainJs.match(/setAppUserModelId\(\s*['"]([^'"]+)['"]\s*\)/);
    expect(m, 'main.js phải gọi setAppUserModelId(...)').not.toBeNull();
    const aumid = m![1];
    const appIdMatch = builderYml.match(/^appId:\s*(\S+)/m);
    expect(appIdMatch, 'electron-builder.yml phải khai báo appId').not.toBeNull();
    expect(aumid).toBe(appIdMatch![1]);
  });

  it('Giữ IPC handler bắn thông báo OS + badge chưa đọc (đường push của EXE)', () => {
    expect(mainJs).toMatch(/ipcMain\.handle\(\s*['"]sigmapc:notify['"]/);
    expect(mainJs).toMatch(/ipcMain\.handle\(\s*['"]sigmapc:set-unread-badge['"]/);
  });

  it('save-file KHỬ path traversal (Agent-B 1/9): basename tên do người gửi + containment fail-closed trong Downloads', () => {
    // GỐC: fileName = tên tin FILE (dto.body, do NGƯỜI GỬI đặt) → `../../Startup/evil.bat` ghi ngoài Downloads = RCE.
    // Handler PHẢI basename() khử thành phần thư mục + kiểm target nằm TRONG downloads (startsWith) trước writeFile.
    const seg = mainJs.match(/sigmapc:save-file[\s\S]{0,1500}?writeFileSync/);
    expect(seg, 'phải có handler save-file').not.toBeNull();
    const body = seg![0];
    expect(body).toMatch(/basename\(\s*String\(\s*fileName\s*\)\s*\)/); // khử thư mục từ tên NGƯỜI GỬI
    expect(body).toMatch(/startsWith\(\s*resolvedDir\s*\+\s*pathm\.sep\s*\)/); // containment fail-closed
    // KHÔNG được join THẲNG fileName thô vào path (regression: dòng cũ `join(dir, fileName)`)
    expect(body).not.toMatch(/pathm\.join\(\s*dir\s*,\s*fileName\s*\)/);
  });

  it('Tự dọn cookie phiên TRÙNG lúc khởi động (GỐC bug login exe văng ra 7/8) — chống tái diễn', () => {
    // Jar dùng chung tích tụ >1 cookie sigma_ws (host + dot-domain) → server nhận nhầm cookie rác → 401 →
    // văng ra. main.js PHẢI có hàm dọn + GỌI nó trong whenReady trước createWindow.
    expect(mainJs).toMatch(/healDuplicateSessionCookies/);
    expect(mainJs).toMatch(/\.get\(\s*\{\s*name:\s*WS_COOKIE_NAME/);
    expect(mainJs).toMatch(/\.remove\(/);
    // phải remove khi có >1 (không đụng khi chỉ 1 → giữ auto-login)
    expect(mainJs).toMatch(/list\.length\s*<=\s*1/);
    // phải gọi trong whenReady TRƯỚC createWindow
    expect(mainJs).toMatch(/healDuplicateSessionCookies\(\)[\s\S]{0,120}createWindow\(\)/);
  });
});
