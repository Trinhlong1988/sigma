// SigMa PC — preload tối giản. contextIsolation BẬT, nodeIntegration TẮT.
// Phơi marker (renderer biết đang chạy trong vỏ Electron PC) + điều khiển cửa sổ cho thanh tiêu đề tự vẽ
// (nút Mac tròn — frame:false ở main.js). KHÔNG cấp Node API thô, chỉ 4 lệnh cửa sổ qua ipcRenderer.invoke.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('SigMaPC', {
  platform: 'pc',
  isElectron: true,
  version: process.env.npm_package_version || null,
  // Điều khiển cửa sổ (thanh tiêu đề tự vẽ kiểu Mac). Trả Promise; toggleMaximize trả trạng thái maximized mới.
  windowMinimize: () => ipcRenderer.invoke('sigmapc:window-minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('sigmapc:window-toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('sigmapc:window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('sigmapc:window-is-maximized'),
  // Chọn folder bill (feature "Quét bill gửi" tự động) — mở hộp thoại chọn thư mục Windows, trả đường dẫn hoặc null.
  pickFolder: () => ipcRenderer.invoke('sigmapc:pick-folder'),
  readFolderImages: (dirPath) => ipcRenderer.invoke('sigmapc:read-folder-images', dirPath),
  // [Admin Demo 16/9 tối] Chọn ẢNH bill (1/nhiều) qua dialog Electron → [{name, path}] — có PATH nên tab Thủ công
  // đổi được tên file sau OCR (input type=file của web KHÔNG cho biết đường dẫn).
  pickBillFiles: () => ipcRenderer.invoke('sigmapc:pick-bill-files'),
  // [Admin Demo 8/9] Đổi tên ảnh bill sau OCR: "<STT> - Đã thành công - <HKD/TID/Người CK>" hoặc "<STT> - Chưa thành công".
  // Chỉ đổi TÊN trong CHÍNH thư mục đó (main lọc ký tự + chặn thoát thư mục). Trả {ok, path, name}.
  renameBillFile: (filePath, newBaseName) => ipcRenderer.invoke('sigmapc:rename-bill-file', { filePath, newBaseName }),
  // Đọc 1 ảnh khi tới lượt OCR (đọc lười, chống freeze — không giữ cả folder base64 trong RAM).
  readImageFile: (filePath) => ipcRenderer.invoke('sigmapc:read-image-file', filePath),
  // TẢI FILE THẬT (Admin Demo 1/9 "Excel báo tải xong sớm + không có nút mở") — lưu base64 vào Downloads (fallback
  // showSaveDialog), trả {ok, path?} SAU KHI ghi xong (không sớm). openFile mở bằng app mặc định (shell.openPath).
  saveFile: (base64, fileName, mimeType) => ipcRenderer.invoke('sigmapc:save-file', { base64, fileName, mimeType }),
  openFile: (filePath) => ipcRenderer.invoke('sigmapc:open-file', filePath),
  // Google native (Electron) — mở cửa sổ đăng nhập Google, trả {ok, error?}. Sau ok: renderer re-fetch phiên.
  googleSignIn: () => ipcRenderer.invoke('sigmapc:google-signin'),

  // Thông báo OS khi app Ở NỀN (item 3, 6/8) — renderer gọi khi có tin mới lúc cửa sổ không focus; main TỰ kiểm
  // `!win.isFocused()` rồi dựng `new Notification` (góc phải-dưới cạnh đồng hồ). Click → main gửi lại
  // 'sigmapc:notify-clicked' để renderer điều hướng vào phòng. payload = {title, body, roomId, iconDataUrl?} —
  // iconDataUrl (item 12, 6/8) = avatar người gửi/nhóm (data URL) làm icon thông báo; forward NGUYÊN payload.
  notify: (payload) => ipcRenderer.invoke('sigmapc:notify', payload),

  // BUG#8b (6/8, Admin Demo "badge trên ICON app desktop") — renderer gọi khi TỔNG số tin chưa đọc đổi; main đặt
  // app.setBadgeCount(n) + overlay icon trên taskbar (Windows). n=0 → xóa badge. Bù trừ realtime KHÔNG trễ vì
  // renderer gọi ngay khi unreadChat state đổi (AppShell.tsx refreshUnread/emitRoomRead).
  setUnreadBadge: (n) => ipcRenderer.invoke('sigmapc:set-unread-badge', n),
  onNotifyClicked: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('sigmapc:notify-clicked', listener);
    return () => ipcRenderer.removeListener('sigmapc:notify-clicked', listener);
  },
  onWindowMaximized: (cb) => {
    const listener = (_e, val) => cb(!!val);
    ipcRenderer.on('sigmapc:window-maximized-changed', listener);
    return () => ipcRenderer.removeListener('sigmapc:window-maximized-changed', listener);
  },

  // TRẠNG THÁI FOREGROUND THẬT (7/8, Admin Demo "exe không có push") — main đẩy foreground (focus+visible+!minimize)
  // mỗi khi đổi. Renderer dùng để quyết định inBackground CHÍNH XÁC (thay document.hasFocus() không tin cậy trong
  // Electron) → foreground → toast trong app; ở nền/tray → OS-toast góc phải desktop. Xem os-notification.ts.
  onForegroundChanged: (cb) => {
    const listener = (_e, fg) => cb(!!fg);
    ipcRenderer.on('sigmapc:foreground-changed', listener);
    return () => ipcRenderer.removeListener('sigmapc:foreground-changed', listener);
  },

  // ── Cập nhật tích hợp (electron-updater) — cùng surface với SigMa Quản Lý (window.api.*), banner UpdateBanner
  //    dùng qua SigMaPC.*. Luồng: có bản mới (push/pull) → user bấm tải (thanh %) → tải xong → cài + mở lại.
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  startUpdate: () => ipcRenderer.invoke('update:start'),
  installUpdateNow: () => ipcRenderer.invoke('update:installNow'),
  getUpdateBootResult: () => ipcRenderer.invoke('update:getBootResult'),
  getLastAvailableUpdate: () => ipcRenderer.invoke('update:getLastAvailable'),
  appGetVersion: () => ipcRenderer.invoke('app:getVersion'),
  onUpdateAvailable: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('update-available', h);
    return () => ipcRenderer.removeListener('update-available', h);
  },
  onDownloadProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('download-progress', h);
    return () => ipcRenderer.removeListener('download-progress', h);
  },
  onUpdateDownloaded: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('update-downloaded', h);
    return () => ipcRenderer.removeListener('update-downloaded', h);
  },
  onUpdateError: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('update-error', h);
    return () => ipcRenderer.removeListener('update-error', h);
  }
});
