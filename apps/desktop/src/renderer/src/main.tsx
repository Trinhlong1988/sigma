import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
// MẪU CHỐT 6/11 — nạp SAU styles.css để thắng luật cũ (nút viên thuốc, thanh cuộn mảnh…).
import './mau-moi.css';
import { App } from './App.js';
import { ToastProvider } from './lib/toast.js';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>
);
