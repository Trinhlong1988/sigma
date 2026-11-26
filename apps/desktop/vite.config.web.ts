// Cấu hình Vite cho BẢN WEB SigMa (SPA) — TÁCH HẲN khỏi `electron.vite.config.ts`.
//
// Vì sao tách: electron-vite build 3 đích (main/preload/renderer) và cần Electron. Bản web chỉ cần 1 đích
// trình duyệt, lấy CHÍNH `src/renderer/src` làm UI (KHÔNG viết lại) + `src/web-shim` làm điểm vào và cầu `window.api`.
//
// Build: `npm run build:web --workspace @sigma/desktop` → `apps/desktop/dist-web`
// Đổi địa chỉ API: `VITE_SIGMA_API_BASE=https://... npm run build:web`.
// MẶC ĐỊNH = `same-origin` (12/11). TRƯỚC ĐÂY mặc định là rỗng ⇒ shim tự suy `<host trang>:8790`, nghĩa là
// QUÊN truyền biến một lần là bản web Ở MỌI CỔNG đều nói chuyện thẳng với 8790 = SỔ THẬT — kể cả cổng 57914
// vốn dành cho BẢN SAO. Tự tay dính bẫy này lúc 12/11: build lại không kèm biến, trang 57914 nhảy sang sổ thật.
// Mọi bản web đều chạy sau `infra/web-static/serve-webapp-quanly.mjs` (có proxy /v1/*) nên same-origin luôn đúng.
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };
const API_BASE_BUILD = process.env.VITE_SIGMA_API_BASE ?? 'same-origin';

/** Ghi RA ĐĨA địa chỉ API đã đóng vào bản build, để cổng kiểm đọc được CON SỐ THẬT.
 *  (Không dò chuỗi trong bundle: chuỗi 'same-origin' nằm sẵn trong câu so sánh của web-shim nên bản build
 *   SAI vẫn "có" chuỗi đó — đã tự dính bẫy đó 12/11, cổng báo ĐẠT cho bản trỏ thẳng 8790.) */
const ghiDauApiBase = {
  name: 'alpha-ghi-dau-api-base',
  closeBundle(): void {
    writeFileSync(resolve(__dirname, 'dist-web/_api-base.txt'), API_BASE_BUILD || '(rỗng → suy host:8790)', 'utf8');
  }
};

export default defineConfig({
  root: resolve(__dirname, 'src/web-shim'),
  // base tương đối './' để bản build chạy được cả khi phục vụ ở đường dẫn con (vd reverse proxy /quanly/).
  base: './',
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  plugins: [react(), tailwindcss(), ghiDauApiBase],
  define: {
    // Version THẬT của mã nguồn đang build (apps/desktop/package.json) — `window.api.getAppVersion()` trả số này.
    __SIGMA_WEB_VERSION__: JSON.stringify(pkg.version),
    // Địa chỉ quanly-api đóng vào bản build. `same-origin` ⇒ gọi /v1/* ngay trên chính cổng web (máy chủ tĩnh
    // chuyển tiếp sang API) — nhờ vậy cookie phiên đi được mà không cần `SameSite=None; Secure`.
    __SIGMA_WEB_API_BASE__: JSON.stringify(API_BASE_BUILD)
  },
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
    // exceljs (dựng Excel chuẩn nhà) + xlsx (đọc file nhập) đều NẶNG → chunk >500KB là BÌNH THƯỜNG ở đây.
    // Nâng ngưỡng cảnh báo để log build không bị nhiễu, KHÔNG phải để che lỗi.
    chunkSizeWarningLimit: 2600,
    sourcemap: true
  }
});
