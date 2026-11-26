# SigMa PC (Windows)

Vỏ **Electron tối giản** bọc web app chat **SigMa** (`apps/web-demo`), đóng gói thành
installer `.exe` (NSIS) có icon/brand SigMa.

> KHÁC `apps/desktop` (app **SigMa**, `com.sigma.app`). App NÀY = client chat
> SigMa cho Windows, phần "PC" của bộ SigMa (web + android + **pc** + ios).

## Cấu trúc

```
apps/sigma-pc/
├─ package.json            # version 0.3.6 (khớp APK), main = src/main.js
├─ electron-builder.yml    # win/NSIS → SigMa-<ver>-setup.exe, appId com.sigma.pc
├─ build/
│  ├─ icon.ico             # brand SigMa (tái dùng từ apps/desktop/build/icon.ico — logo α xanh)
│  └─ icon-512.png
├─ src/
│  ├─ main.js              # process chính: cửa sổ "SigMa" + máy chủ tĩnh nội bộ
│  └─ preload.js           # contextIsolation ON, chỉ phơi marker SigMaPC
├─ scripts/
│  ├─ bundle-web.mjs       # vite build web-demo (prod) → copy dist vào renderer/
│  └─ ensure-renderer.mjs  # gác pre-start/pre-dist: build nếu renderer/ chưa có
└─ renderer/               # (sinh ra) bản web-demo đã build, đóng gói kèm app
```

## HẰNG SỐ đổi nguồn nội dung  (bundled ⇄ live URL)

Trong `src/main.js`, đầu file:

```js
const CONTENT_MODE = process.env.SIGMA_CONTENT || 'bundled'; // 'bundled' | 'live'
const LIVE_URL = 'https://chat.example.com';            // ← bản web live
```

- `bundled` (mặc định): nạp `renderer/` (web-demo đã build, API trỏ
  `https://sigma-api.example.com` qua `.env.production`). Phục vụ qua **HTTP nội bộ
  127.0.0.1** (KHÔNG `file://` — vì web-demo dùng `BrowserRouter`, `file://` làm hỏng
  routing SPA và biến OAuth origin thành `null`). `127.0.0.1` vẫn là secure-context nên
  Google Sign-In / API HTTPS chạy bình thường.
- `live`: nạp thẳng `LIVE_URL`. Đổi **1 dòng** `CONTENT_MODE = 'live'` (hoặc đặt biến môi
  trường `SIGMA_CONTENT=live`) khi bản web chat đã deploy.

## Chạy / đóng gói

```bash
# từ apps/sigma-pc  (deps electron + electron-builder hoisted ở node_modules gốc monorepo)
npm run bundle:web   # build web-demo prod → renderer/
npm start            # chạy thử (Electron)
npm run pack         # build win-unpacked (không tạo installer)
npm run dist         # build installer  → dist/SigMa-0.3.6-setup.exe
```

Yêu cầu: `apps/web-demo/.env.production` (gitignored) phải có mặt — copy từ repo chính nếu thiếu.

## Ký số

**CHƯA ký.** Không có certificate desktop tái dùng cho app này → installer chưa ký;
Windows SmartScreen có thể cảnh báo "Unknown publisher".
