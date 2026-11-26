// ĐIỂM VÀO của BẢN WEB SigMa (SPA, cổng 57913).
//
// THỨ TỰ LÀ BẮT BUỘC:
//   1) `capDatWindowApi()` — gắn `window.api` (shim fetch) + cờ `window.__SIGMA_WEB__`.
//   2) MỚI import App/ToastProvider và mount React.
// Vì sao: `App.tsx` gọi `window.api.serverConfigGet()` ngay trong useEffect đầu tiên, và `lib/platform.ts` đọc
// `window.__SIGMA_WEB__` lúc MODULE LOAD. Nếu mount trước khi gắn shim → `window.api` undefined → trang trắng,
// và `coDesktop` sẽ bị tính SAI (hiện nút cửa sổ/updater vô nghĩa trên web).
// `import()` động ở đây giữ đúng thứ tự đó (import tĩnh bị hoisted lên trước mọi câu lệnh).
import React from 'react';
import { createRoot } from 'react-dom/client';
// KHÔNG import thẳng `../renderer/src/styles.css`: phải qua `styles-web.css` để khai báo @source cho Tailwind v4
// (xem chú thích trong file đó — thiếu nó là CSS rụng 80% mà build vẫn xanh).
import './styles-web.css';
import { capDatWindowApi } from './api.js';

capDatWindowApi();

async function khoiDong(): Promise<void> {
  const [{ App }, { ToastProvider }] = await Promise.all([
    import('../renderer/src/App.js'),
    import('../renderer/src/lib/toast.js')
  ]);
  const root = document.getElementById('root');
  if (!root) {
    // R198 — không nuốt lỗi: thiếu #root thì nói thẳng ra màn hình, đừng để trang trắng không lý do.
    document.body.textContent = 'Lỗi khởi động: không tìm thấy phần tử #root trong trang.';
    console.error('[web] Không tìm thấy #root — không mount được React.');
    return;
  }
  createRoot(root).render(
    <React.StrictMode>
      <ToastProvider>
        <App />
      </ToastProvider>
    </React.StrictMode>
  );
}

void khoiDong();
