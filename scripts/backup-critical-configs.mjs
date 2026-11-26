// PHƯƠNG ÁN BẢO VỆ CHỐNG MẤT FILE (Admin Demo 12/8, sau data-loss xóa nhầm nhiều config gitignored) — snapshot MỌI
// file config/secret GITIGNORED mà build/app phụ thuộc → <BACKUP_DIR>\env-config\. Chạy: (a) sau khi tạo/đổi
// config; (b) TRƯỚC mọi thao tác rủi ro (git clean/reset/worktree remove, dọn thư mục). Idempotent, in bảng trạng thái.
// Dùng: node scripts/backup-critical-configs.mjs
import { existsSync, copyFileSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = '<BACKUP_DIR>\\env-config';
mkdirSync(DEST, { recursive: true });

// (nguồn tương đối repo → tên .bak ở kho backup). MỌI file gitignored mà thiếu = app/build vỡ.
const FILES = [
  ['apps/bot-api/.env', 'bot-api.env.bak'],
  ['apps/quanly-api/.env', 'quanly-api.env.bak'],
  ['apps/web-demo/.env.production', 'web-demo.env.production.bak'],
  ['apps/desktop/build/server-config.default.json', 'desktop.server-config.default.json.bak'],
  ['apps/web-demo/android/keystore.properties', 'android.keystore.properties.bak'],
  ['apps/web-demo/android/app/google-services.json', 'android.google-services.json.bak'],
  // Khoá Firebase service account (push FCM) — gitignored (apps/bot-api/secrets/), MẤT = push chết câm (đúng lỗi
  // 14/8: file 45feb mất phải chuyển hẳn dự án f0c56). BẮT BUỘC backup off-repo.
  ['apps/bot-api/secrets/firebase-service-account.json', 'bot-api.firebase-service-account.json.bak'],
];

// KEYSTORE ký APK — path đọc ĐỘNG từ keystore.properties (thường NGOÀI repo, vd C:/Users/.../alpha-keystore/).
// MẤT keystore = KHÔNG ký được update APK cùng key → user PHẢI gỡ+cài lại (thảm họa). Backup bắt buộc.
try {
  const kp = path.join(ROOT, 'apps/web-demo/android/keystore.properties');
  if (existsSync(kp)) {
    const sf = (readFileSync(kp, 'utf8').match(/^storeFile=(.+)$/m) || [])[1]?.trim();
    if (sf) {
      const cands = [sf, path.join(ROOT, 'apps/web-demo/android/app', sf), path.join(ROOT, 'apps/web-demo/android', sf)];
      const real = cands.find((p) => existsSync(p));
      if (real) FILES.push([path.relative(ROOT, real) || real, 'android.alpha-release.keystore.bak']);
      else FILES.push([sf, 'android.alpha-release.keystore.bak']); // sẽ báo THIẾU fail-loud
    }
  }
} catch { /* ignore */ }

console.log('KHO BACKUP:', DEST);
console.log('FILE | STATUS | bytes');
let missing = 0;
for (const [rel, bak] of FILES) {
  const src = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!existsSync(src)) { console.log(`${rel} | ❌ THIẾU (không backup được — khôi phục từ .bak/console TRƯỚC)`); missing++; continue; }
  copyFileSync(src, path.join(DEST, bak));
  console.log(`${rel} | ✓ backed up | ${statSync(src).size}`);
}
if (missing) { console.error(`\n⚠ ${missing} file THIẾU trên đĩa — kiểm khôi phục ngay (guard self-heal / transcript / dashboard).`); process.exit(1); }
console.log('\n✅ Đã snapshot toàn bộ config gitignored. An toàn để làm thao tác rủi ro (nhưng vẫn CẤM git-clean/reset khi tree dirty).');
