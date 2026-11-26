// THỬ PHỤC HỒI TỪ BẢN SAO LƯU ĐÃ MÃ HOÁ (Admin Demo duyệt 7/11 — nhóm 1).
//
// Mã hoá xong mà chưa từng phục hồi thử thì không ai biết backup có dùng được không. Bộ này:
//   giải mã → tạo DB tạm → pg_restore → ĐẾM bảng + vài bảng xương sống → xoá DB tạm.
// Dùng: node scripts/thu-phuc-hoi-backup.mjs <file.dump.enc>
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '..');
const BIN = process.env.PG_BIN || '<PG_BIN>\\pgsql\\bin';
const TEN_TAM = 'sigma_thu_phuchoi';

const f = process.argv[2];
if (!f || !existsSync(f)) {
  console.error('[thu-phuc-hoi] Thiếu/không thấy file .enc. Dùng: node scripts/thu-phuc-hoi-backup.mjs <file.dump.enc>');
  process.exit(1);
}

function docUrl() {
  const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
  const m = /^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t);
  if (!m) throw new Error('Không đọc được DATABASE_URL');
  return m[1].replace(/^["']|["']$/g, '');
}

const URL_THAT = docUrl();
const urlTam = new URL(URL_THAT);
urlTam.pathname = '/' + TEN_TAM;
const tamDump = resolve(GOC, 'backup-phien', 'thu-phuc-hoi.dump');

const noi = async (u) => {
  const c = new pg.Client({ connectionString: u });
  await c.connect();
  return c;
};

try {
  // 1. Giải mã
  const g = spawnSync(process.execPath, [resolve(GOC, 'scripts/ma-hoa-backup.mjs'), '--giai-ma', f, tamDump], { encoding: 'utf8' });
  if (g.status !== 0) throw new Error('giải mã thất bại: ' + (g.stderr || g.stdout || '').slice(0, 400));
  console.log('[thu-phuc-hoi] đã giải mã →', tamDump);

  // 2. DB tạm
  let c = await noi(URL_THAT);
  await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`, [TEN_TAM]);
  await c.query(`DROP DATABASE IF EXISTS "${TEN_TAM}"`);
  await c.query(`CREATE DATABASE "${TEN_TAM}"`);
  await c.end();

  // 3. Phục hồi
  const r = spawnSync(resolve(BIN, 'pg_restore.exe'), ['--no-owner', '--no-privileges', '-d', urlTam.toString(), tamDump], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024
  });
  console.log('[thu-phuc-hoi] pg_restore mã thoát', r.status);
  if (r.status !== 0) console.log('[thu-phuc-hoi] (một số cảnh báo pg_restore là bình thường)', (r.stderr || '').slice(0, 300));

  // 4. Đếm — bằng chứng bản backup DÙNG ĐƯỢC, không chỉ "giải mã ra file"
  const d = await noi(urlTam.toString());
  const so = async (q) => Number((await d.query(q)).rows[0].n);
  const bang = await so(`SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public'`);
  const tx = await so('SELECT COUNT(*)::int n FROM transactions');
  const lo = await so('SELECT COUNT(*)::int n FROM los');
  const tid = await so('SELECT COUNT(*)::int n FROM tids');
  console.log(`[thu-phuc-hoi] PHỤC HỒI ĐƯỢC: ${bang} bảng · transactions ${tx} · los ${lo} · tids ${tid}`);
  await d.end();

  // 5. Dọn
  c = await noi(URL_THAT);
  await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`, [TEN_TAM]);
  await c.query(`DROP DATABASE "${TEN_TAM}"`);
  await c.end();
  try { unlinkSync(tamDump); } catch { /* bỏ qua */ }
  console.log('[thu-phuc-hoi] đã dọn DB tạm + file giải mã tạm.');

  const dat = bang > 100 && tx > 0 && lo > 0 && tid > 0;
  console.log('[thu-phuc-hoi] KẾT LUẬN:', dat ? 'BẢN BACKUP MÃ HOÁ DÙNG ĐƯỢC' : '*** SỐ LIỆU ĐÁNG NGỜ — kiểm lại ***');
  process.exitCode = dat ? 0 : 1;
} catch (e) {
  console.error('[thu-phuc-hoi] LỖI:', e?.message ?? e);
  process.exitCode = 1;
}
