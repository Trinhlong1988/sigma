import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';

// Khởi tạo theme trước khi render để tránh nháy sáng/tối (FOUC).
const stored = localStorage.getItem('sigma-theme');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = stored ?? (prefersDark ? 'dark' : 'light');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
