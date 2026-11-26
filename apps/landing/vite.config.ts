import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// SigMa landing (trang giới thiệu) — thuần frontend tĩnh, KHÔNG backend. Cùng stack với apps/web-demo
// (Vite + React 19 + Tailwind v4) để đồng bộ brand token/hiệu ứng.
export default defineConfig({
  root: __dirname,
  // KHÔNG xoá dist khi build — file cài lớn ở dist/downloads (cũ) có thể bị antivirus khoá gây EPERM.
  // Downloads thật giờ phục vụ từ D:\alpha-downloads (serve-landing.mjs), dist/downloads bị bỏ qua.
  build: { emptyOutDir: false },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  server: {
    port: 5273
  }
});
