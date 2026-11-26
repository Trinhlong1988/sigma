// KHÓA ĐA TẦNG (Admin Demo 12/8, sau sự cố mất .env bot-api) — preflight chạy TRƯỚC `npm start` trong run-bot-api.cmd.
// Tầng 1: nếu apps/quanly-api/.env MẤT hoặc thiếu DATABASE_URL → TỰ khôi phục từ backup off-repo (self-heal) rồi tiếp.
// Tầng 2: thiếu key CORE sau khi self-heal → in LỖI TO + exit 1 (launcher hiện rõ, KHÔNG crash im mơ hồ).
// Tầng 3: liệt kê key class-B (Firebase/ESMS/SMTP/GOOGLE_CLIENT_SECRET...) đang rỗng để cảnh báo tính năng tắt.
// KHÔNG in giá trị secret ra log — chỉ tên key + độ dài.
import fs from 'node:fs';

const ENV = '<REPO>/apps/quanly-api/.env';
const BACKUP = '<BACKUP_DIR>/env-config/quanly-api.env.bak';
const CORE = ['DATABASE_URL', 'PORT']; // thiếu 1 trong đây = quanly-api KHÔNG chạy được (getBotDb throw).
const FEATURE = []; // quanly-api chỉ cần CORE (DATABASE_URL/PORT); không có secret bên thứ 3.

const parse = (txt) => Object.fromEntries(txt.split(/\r?\n/).filter(l => l.includes('=') && !l.trimStart().startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1)]; }));

let txt = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
let env = parse(txt);
const coreMissing = () => CORE.filter(k => !env[k]);

if (coreMissing().length && fs.existsSync(BACKUP)) {
  console.error(`[check-env] .env THIẾU CORE (${coreMissing().join(',')}) — TỰ KHÔI PHỤC từ ${BACKUP}`);
  fs.copyFileSync(BACKUP, ENV);
  txt = fs.readFileSync(ENV, 'utf8');
  env = parse(txt);
}

const stillMissing = coreMissing();
if (stillMissing.length) {
  console.error('==================================================================');
  console.error(`[check-env] LỖI NGHIÊM TRỌNG: apps/quanly-api/.env thiếu key CORE: ${stillMissing.join(', ')}`);
  console.error(`[check-env] Backup không có/không đủ (${BACKUP}). quanly-api KHÔNG THỂ khởi động tới khi có .env hợp lệ.`);
  console.error('==================================================================');
  process.exit(1);
}

const emptyFeature = FEATURE.filter(k => !env[k]);
if (emptyFeature.length) {
  console.error(`[check-env] Cảnh báo: ${emptyFeature.length} biến TÍNH NĂNG đang rỗng -> tính năng liên quan TẮT: ${emptyFeature.join(', ')}`);
}
console.error(`[check-env] OK — CORE đủ; ${FEATURE.length - emptyFeature.length}/${FEATURE.length} biến tính năng có giá trị.`);
process.exit(0);
