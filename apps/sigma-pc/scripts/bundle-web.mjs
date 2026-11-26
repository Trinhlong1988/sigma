// Build web-demo (prod) và copy dist → apps/sigma-pc/renderer (tài nguyên đóng gói).
// Chạy: npm run bundle:web  (từ apps/sigma-pc)
import { execSync } from 'node:child_process';
import { cpSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));           // apps/sigma-pc/scripts
const pcDir = path.resolve(here, '..');                              // apps/sigma-pc
const webDemoDir = path.resolve(pcDir, '..', 'web-demo');            // apps/web-demo
const rendererDir = path.join(pcDir, 'renderer');

// KHÓA ĐA TẦNG (12/8) — .env.production (gitignored) từng MẤT trong data-loss → build bake nhầm localhost.
// Self-heal từ backup off-repo trước khi dừng (cùng cơ chế check-env bot-api/quanly-api).
const envProd = path.join(webDemoDir, '.env.production');
const envProdBackup = '<BACKUP_DIR>\\env-config\\web-demo.env.production.bak';
if (!existsSync(envProd)) {
  if (existsSync(envProdBackup)) {
    console.error('[bundle-web] .env.production MẤT — TỰ KHÔI PHỤC từ backup', envProdBackup);
    copyFileSync(envProdBackup, envProd);
  } else {
    console.error('THIẾU apps/web-demo/.env.production (gitignored) + không có backup. Copy từ repo chính trước khi build.');
    process.exit(1);
  }
}

console.log('[bundle-web] vite build --mode production  (web-demo, base "/")');
// base mặc định "/" — OK vì app phục vụ qua HTTP nội bộ 127.0.0.1 (xem src/main.js).
execSync('npx vite build --mode production', { cwd: webDemoDir, stdio: 'inherit' });

const dist = path.join(webDemoDir, 'dist');
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('[bundle-web] Build xong nhưng không thấy dist/index.html — dừng.');
  process.exit(1);
}

console.log('[bundle-web] copy dist →', rendererDir);
rmSync(rendererDir, { recursive: true, force: true });
cpSync(dist, rendererDir, { recursive: true });
console.log('[bundle-web] XONG.');
