// Gác trước start/dist: bảo đảm renderer/ (bản web đã build) tồn tại, nếu chưa thì build.
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pcDir = path.resolve(here, '..');
const indexHtml = path.join(pcDir, 'renderer', 'index.html');

if (!existsSync(indexHtml)) {
  console.log('[ensure-renderer] renderer/ chưa có — chạy bundle:web...');
  execSync('node scripts/bundle-web.mjs', { cwd: pcDir, stdio: 'inherit' });
} else {
  console.log('[ensure-renderer] renderer/ OK.');
}
