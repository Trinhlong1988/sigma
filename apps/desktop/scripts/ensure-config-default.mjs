// KHÓA ĐA TẦNG (Admin Demo 12/8 "siết lại quy trình") — chạy predist TRƯỚC khi đóng gói. server-config.default.json
// (gitignored, chứa mật khẩu + apiBaseUrl) là fallback giúp MÁY NGOÀI mở-là-chạy KHÔNG hỏi cấu hình. File này
// từng MẤT trong data-loss → 0.2.94 build ra thiếu → máy ngoài hỏi cấu hình. Tự khôi phục từ backup off-repo;
// thiếu cả backup → LỖI TO + exit 1 (cấm đóng gói bản thiếu config, im lặng ship bug).
import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '..', 'build', 'server-config.default.json');
const backup = '<BACKUP_DIR>\\env-config\\desktop.server-config.default.json.bak';

if (!existsSync(target)) {
  if (existsSync(backup)) { console.error('[ensure-config] server-config.default.json MẤT — TỰ KHÔI PHỤC từ', backup); copyFileSync(backup, target); }
  else { console.error('[ensure-config] LỖI: build/server-config.default.json THIẾU + không có backup. Máy ngoài sẽ bị hỏi cấu hình. Tạo file (host/db/user/password/apiBaseUrl) trước khi build.'); process.exit(1); }
}
// Xác thực đủ field + có apiBaseUrl (nếu không, máy ngoài lại hỏi cấu hình).
try {
  const c = JSON.parse(readFileSync(target, 'utf8'));
  const miss = ['host', 'database', 'user', 'password', 'apiBaseUrl'].filter((k) => !c[k]);
  if (miss.length) { console.error('[ensure-config] LỖI: thiếu field', miss.join(','), '→ máy ngoài có thể vẫn hỏi cấu hình.'); process.exit(1); }
  console.error('[ensure-config] OK — server-config.default.json đủ field, apiBaseUrl =', c.apiBaseUrl);
} catch (e) { console.error('[ensure-config] LỖI đọc/parse server-config.default.json:', e.message); process.exit(1); }
