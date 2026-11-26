// B257 — [Admin Demo 23/11 "fix triệt để"] CẤM CÂU SQL PHỤ THUỘC MÚI GIỜ CỦA PHIÊN.
//
// LỚP LỖI (đo thật 23/11, suýt làm mất bill trên sổ thật):
//   `($1::date) AT TIME ZONE 'Asia/Ho_Chi_Minh'`
// Postgres hiểu "date" ở đây là timestamptz rồi đổi sang GIỜ TREO TƯỜNG của vùng ⇒ kết quả ĐỔI THEO
// múi giờ PHIÊN: phiên Asia/Bangkok ra 00:00+07 (đúng), phiên UTC ra 07:00Z (lệch +7h) ⇒ cửa sổ "ngày
// hôm nay" trượt 7 tiếng, MẤT mọi bill quẹt trước 14:00 mà KHÔNG báo gì.
// Viết đúng: `($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'` — chốt nghĩa "00:00 giờ VN của
// ngày đó", cho ra CÙNG MỘT MỐC ở mọi phiên.
//
// Cổng này quét mã nguồn (không cần DB) + ĐO THẬT trên Postgres bằng 2 phiên khác múi giờ để chứng minh
// cách viết đúng cho cùng kết quả — tránh "xanh theo niềm tin".
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 4;

// ── (1) QUÉT MÃ NGUỒN ──
const BO_QUA = /node_modules|[\\/]dist|[\\/]out[\\/]|[\\/]generated[\\/]|_tam-/;
const DUOI = /\.(ts|tsx|mjs|mts|cjs)$/;
function quet(thuMuc, ra = []) {
  for (const ten of readdirSync(thuMuc)) {
    const p = join(thuMuc, ten);
    if (BO_QUA.test(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) quet(p, ra);
    else if (DUOI.test(ten)) ra.push(p);
  }
  return ra;
}
const tep = [...quet(join(GOC, 'apps')), ...quet(join(GOC, 'packages')), ...quet(join(GOC, 'scripts'))];
// Dạng SAI: ...::date) AT TIME ZONE   /   ...::date) + 1) AT TIME ZONE   (thiếu ::timestamp ở giữa)
const XAU = /::date\s*\)(?:\s*\+\s*1\s*\))?\s*AT TIME ZONE/;
const dinh = [];
for (const f of tep) {
  const noi = readFileSync(f, 'utf8').split('\n');
  noi.forEach((dong, i) => {
    if (!XAU.test(dong)) return;
    if (/::timestamp\s*AT TIME ZONE/.test(dong)) return; // đã viết đúng
    if (/^\s*(\/\/|--|\*)/.test(dong)) return;            // dòng chú thích
    if (/MAU_DOI_CHUNG/.test(dong)) return;                 // mẫu CỐ Ý sai để đối chứng (ngay trong cổng này)
    dinh.push(f.replace(GOC, '').replace(/\\/g, '/') + ':' + (i + 1));
  });
}
if (dinh.length) console.log('      chỗ dính:', dinh.slice(0, 8).join(' · '));
console.log('      đã quét', tep.length, 'tệp mã nguồn');
chot(tep.length > 200, 'quét được mã nguồn (' + tep.length + ' tệp — ít bất thường là quét hụt)');
chot(dinh.length === 0, 'KHÔNG còn câu SQL dạng "date AT TIME ZONE" phụ thuộc múi giờ phiên'
  + (dinh.length ? ' — còn ' + dinh.length + ' chỗ' : ''));

// ── (2) ĐO THẬT trên Postgres: 2 phiên khác múi giờ phải ra CÙNG MỘT MỐC ──
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[sql-mui-gio] DUNG: chi chay tren DB THU, dang tro "' + DB_TEN + '".');
  process.exit(3);
}
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
try {
  const docMoc = async (tz, sql) => {
    await db.query("SET TimeZone = '" + tz + "'");
    // ÉP ::timestamptz rồi mới lấy epoch — đúng như phép so trong câu thật (timestamptz >= timestamp
    // thì Postgres tự ép bằng múi giờ PHIÊN). Không ép thì epoch của "timestamp không múi giờ" bị coi
    // như UTC ⇒ đo ra số khác, phép kiểm đỏ oan (đã cắn ngay lần chạy đầu).
    const r = await db.query(`SELECT extract(epoch from (${sql})::timestamptz)::bigint AS e`, ['2026-11-23']);
    return Number(r.rows[0].e);
  };
  const SAI = "($1::date) AT TIME ZONE 'Asia/Ho_Chi_Minh'"; // MAU_DOI_CHUNG — cố ý viết SAI để đo
  const DUNG = "($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'";
  const sai1 = await docMoc('Asia/Bangkok', SAI);
  const sai2 = await docMoc('UTC', SAI);
  const dung1 = await docMoc('Asia/Bangkok', DUNG);
  const dung2 = await docMoc('UTC', DUNG);
  console.log('      cách CŨ : phiên Bangkok ' + sai1 + ' · phiên UTC ' + sai2 + ' → lệch ' + ((sai2 - sai1) / 3600) + 'h');
  console.log('      cách MỚI: phiên Bangkok ' + dung1 + ' · phiên UTC ' + dung2 + ' → lệch ' + ((dung2 - dung1) / 3600) + 'h');
  chot(sai1 !== sai2, 'ĐỐI CHỨNG: cách viết CŨ THẬT SỰ lệch theo múi giờ phiên (' + ((sai2 - sai1) / 3600) + 'h)');
  chot(dung1 === dung2 && dung1 === sai1,
    'cách viết MỚI cho CÙNG MỘT MỐC ở mọi phiên, và đúng bằng mốc 00:00 giờ VN');
} finally {
  await db.end();
}

console.log('\n[sql-mui-gio] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[sql-mui-gio] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[sql-mui-gio] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
