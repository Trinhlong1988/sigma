import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { initFontLevel } from './font-scale';
import { PcTitleBar, isSigMaPc } from './components/PcTitleBar';
import { UpdateBanner } from './components/UpdateBanner';
import { ApkUpdateBanner } from './components/ApkUpdateBanner'; // Việc #5 — banner tự cập nhật cho nền APK (song song UpdateBanner của exe).
import 'flag-icons/css/flag-icons.min.css'; // VIỆC #4 — cờ quốc gia CSS sprite cho ô SĐT (Windows/EXE không render emoji cờ).
import './styles.css';

// Mục 22 — áp cỡ chữ đã lưu (localStorage) ngay khi app mount, trước render.
initFontLevel();

// SigMa PC (Electron, frame:false) — bật lớp bù layout `pc-shell` (styles.css trừ 32px chiều cao titlebar)
// + render thanh tiêu đề nút Mac. isSigMaPc() false trên web/APK → KHÔNG thêm class, KHÔNG render gì.
if (isSigMaPc()) document.documentElement.classList.add('pc-shell');

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

// [Admin Demo 25/9 — R200] CỬA HARNESS DEV: ?harness=<tên> mount THẲNG 1 component để LEAD tự render + nhìn ảnh.
// CHỈ chạy khi URL có tham số này (người dùng thật không bao giờ có) — không đụng luồng app.
const _h = new URLSearchParams(window.location.search).get('harness');
if (_h) {
  void (async (): Promise<void> => {
    if (_h === 'huy-modal') (await import('./_huy-modal-harness')).mount();
    if (_h === 'sos') (await import('./_sos-harness')).mount();
  })();
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <BrowserRouter>
      <PcTitleBar />
      <UpdateBanner />
      <ApkUpdateBanner />
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
