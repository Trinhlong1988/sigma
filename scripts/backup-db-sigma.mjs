// BACKUP TOÀN BỘ DB sigma (Admin Demo 18/9, sau khi phát hiện SSD Lexar 1TB reset liên tục — Event 129 stornvme).
//
// VÌ SAO GẤP: máy chỉ có ĐÚNG 1 ổ vật lý; C: và D: đều nằm trên nó, kể cả <PG_BIN>\data. Ổ chết = mất toàn
// bộ dữ liệu tiền (lô, bill, doanh số, tạm ứng NĐT). Trước nay <BACKUP_DIR> chỉ có dump JSON TỪNG PHẦN, chưa
// từng có bản full nào nằm ngoài ổ này.
//
// Dùng: node scripts/backup-db-sigma.mjs [thư-mục-đích-phụ]
//   vd: node scripts/backup-db-sigma.mjs \\127.0.0.1\backup
// Không truyền đích phụ → chỉ ghi <BACKUP_DIR>\db (CÙNG ổ, chỉ chống xoá nhầm, KHÔNG chống hỏng ổ).
import { spawnSync } from 'node:child_process';
import { fileURLToPath as _fu } from 'node:url';
import { existsSync, mkdirSync, readFileSync, statSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG_DUMP = '<PG_BIN>\\pgsql\\bin\\pg_dump.exe';
const DEST = '<BACKUP_DIR>\\db';
const GIU_LAI = 5; // giữ 5 bản gần nhất (ổ đang chật, không để backup ăn hết chỗ)

function doc(url) {
  // Lấy user/pass/host/port/db từ DATABASE_URL — KHÔNG in mật khẩu ra màn hình/log.
  const m = /^postgres(?:ql)?:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/(.+?)(\?|$)/.exec(url.trim());
  if (!m) throw new Error('DATABASE_URL trong apps/bot-api/.env không đúng định dạng.');
  return { user: m[1], pass: m[2], host: m[3], port: m[4], db: m[5] };
}

// [15/11] TRƯỚC: chỉ đọc apps/bot-api/.env. File đó biến mất ⇒ backup CHẾT CÂM 2 ngày (task chạy đúng giờ,
// trả mã 1, không ai biết) — sổ tiền không có bản mới nào trong khi máy chỉ có 1 ổ vật lý.
// NAY: dò nhiều nguồn như máy chủ đang dùng. Mất 1 file KHÔNG được phép làm mất backup.
function timUrl() {
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, nguon: 'biến môi trường' };
  for (const f of ['apps/bot-api/.env', 'apps/quanly-api/.env', '.env']) {
    const fp = path.join(ROOT, f);
    if (!existsSync(fp)) continue;
    // Tách dòng bằng mã ký tự (10 = xuống dòng) rồi trim — tránh regex có dấu thoát, và chịu được CRLF.
    const d = readFileSync(fp, 'utf8').split(String.fromCharCode(10)).map((x) => x.trim()).find((l) => l.startsWith('DATABASE_URL='));
    if (d) return { url: d.slice('DATABASE_URL='.length).replace(/^["']|["']$/g, ''), nguon: f };
  }
  return null;
}
const nguonUrl = timUrl();
if (!nguonUrl) {
  console.error('THIẾU DATABASE_URL — đã tìm: biến môi trường, apps/bot-api/.env, apps/quanly-api/.env, .env');
  process.exit(1);
}
console.log(`[backup] lấy chuỗi kết nối từ: ${nguonUrl.nguon}`);
const cn = doc(nguonUrl.url);

if (!existsSync(PG_DUMP)) { console.error(`THIẾU pg_dump: ${PG_DUMP}`); process.exit(1); }
mkdirSync(DEST, { recursive: true });

const d = new Date();
const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
const out = path.join(DEST, `${cn.db}-${stamp}.dump`);

console.log(`[backup] pg_dump ${cn.db} @ ${cn.host}:${cn.port} → ${out}`);
const t0 = Date.now();
// -Fc = định dạng nén custom (khôi phục bằng pg_restore, chọn lọc được bảng). --no-owner để restore máy khác dễ.
const r = spawnSync(PG_DUMP, ['-U', cn.user, '-h', cn.host, '-p', cn.port, '-d', cn.db, '-Fc', '--no-owner', '-f', out], {
  env: { ...process.env, PGPASSWORD: cn.pass },
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024
});
if (r.status !== 0) {
  console.error(`[backup] ✗ pg_dump LỖI (mã ${r.status}):\n${(r.stderr || '').slice(0, 2000)}`);
  process.exit(1);
}
let mb = statSync(out).size / 1024 / 1024;
console.log(`[backup] ✓ xong ${mb.toFixed(1)} MB trong ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── MÃ HOÁ (Admin Demo duyệt 7/11) ────────────────────────────────────────────────────────────────────
// Bản dump THÔ đọc được ngay bằng pg_restore — ai lấy được file là có trọn dữ liệu tiền. Mã hoá AES-256-GCM
// rồi mới đem đi, và CHỈ xoá bản thô SAU KHI cổng QA của ma-hoa-backup.mjs chứng minh giải mã ra đúng nguyên bản.
// Thiếu khoá → DỪNG HẲN, KHÔNG âm thầm để lại bản thô (R198: cấm nuốt lỗi rồi báo xong).
let outCuoi = out;
{
  const maHoa = path.join(ROOT, 'scripts', 'ma-hoa-backup.mjs');
  const rm = spawnSync(process.execPath, [maHoa, '--ma-hoa', out], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(rm.stdout || '');
  if (rm.status !== 0) {
    console.error('[backup] ✗ MÃ HOÁ THẤT BẠI → DỪNG. Bản thô vẫn ở', out, '— KHÔNG đem đi khi chưa mã hoá.');
    console.error((rm.stderr || '').slice(0, 1200));
    process.exit(4);
  }
  outCuoi = out + '.enc';
  try {
    unlinkSync(out); // cổng QA đã khẳng định giải mã ra đúng nguyên bản ⇒ mới được bỏ bản thô
    console.log('[backup] đã xoá bản THÔ, chỉ giữ bản mã hoá:', path.basename(outCuoi));
  } catch (e) {
    console.error('[backup] ⚠ KHÔNG xoá được bản thô:', e.message);
  }
  mb = statSync(outCuoi).size / 1024 / 1024;
}

// Đích phụ = Ổ/MÁY KHÁC. Đây mới là bản thật sự chống hỏng ổ — bản ở D: chỉ chống xoá nhầm.
const phu = process.argv[2];
if (phu) {
  try {
    mkdirSync(phu, { recursive: true });
    const dich = path.join(phu, path.basename(outCuoi));
    const t1 = Date.now();
    copyFileSync(outCuoi, dich);
    const okMb = statSync(dich).size / 1024 / 1024;
    if (Math.abs(okMb - mb) > 0.01) throw new Error(`kích thước lệch: nguồn ${mb.toFixed(1)}MB ≠ đích ${okMb.toFixed(1)}MB`);
    console.log(`[backup] ✓ đã chép sang ${dich} (${okMb.toFixed(1)} MB, ${((Date.now() - t1) / 1000).toFixed(1)}s) — ĐÃ nằm ngoài ổ đang lỗi`);
  } catch (e) {
    console.error(`[backup] ⚠ KHÔNG chép được sang ${phu}: ${e.message}`);
    console.error('[backup] ⚠ Bản dump hiện CHỈ nằm trên ổ đang lỗi — chưa an toàn.');
    process.exit(2);
  }
} else {
  console.log('[backup] ⚠ Chưa truyền đích phụ → bản dump nằm CÙNG ổ với DB. Chống xoá nhầm, KHÔNG chống hỏng ổ.');
}

// Dọn bản cũ (ổ đang chật).
const cu = readdirSync(DEST).filter((f) => f.startsWith(`${cn.db}-`) && (f.endsWith('.dump') || f.endsWith('.dump.enc'))).sort().reverse().slice(GIU_LAI);
for (const f of cu) { try { unlinkSync(path.join(DEST, f)); console.log(`[backup] dọn bản cũ ${f}`); } catch { /* bỏ qua */ } }
