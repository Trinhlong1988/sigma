// B210 — [Admin Demo 19/11 "fix lỗi 7 tiếng"] SO MỐC THỜI GIAN PHẢI CÙNG MỘT HỆ QUY CHIẾU.
//
// GỐC (đo 3 lần): thư viện gửi mốc xuống dạng giờ UTC NHƯNG KHÔNG kèm múi giờ; máy chủ đặt TimeZone=
// Asia/Bangkok nên gán +07 ⇒ mọi mốc do chương trình ghi bị lưu SỚM 7 TIẾNG. Lúc đọc thì sai ngược lại
// nên app nhìn thấy đúng — lỗi sống nhiều tháng. Nó CHỈ lộ khi so với now() của máy chủ.
//
// HẬU QUẢ THẬT đã tìm ra: chốt chống GỬI TRÙNG BILL dùng `sent_at < now() - interval '10 min'`. Vì `sent_at`
// lưu sớm 7 tiếng nên điều kiện đó LUÔN ĐÚNG ⇒ mọi chỗ giữ chỗ đều bị coi là "mồ côi quá 10 phút" ⇒ chốt
// mất tác dụng, bill có thể gửi hai lần ⇒ doanh số đếm đôi.
//
// Cổng này khoá 2 điều:
//   (1) không còn câu lệnh nào so cột mốc với now() của máy chủ trong lớp chạy thật;
//   (2) ĐO THẬT trên DB thử: một dòng vừa ghi KHÔNG được coi là "cũ hơn 10 phút".
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, extname, relative } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[cung-he] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 6;

// ── (1) QUÉT MÃ: lớp chạy thật không được so cột mốc với now() của máy chủ ──
const VUNG = ['packages/services/src', 'apps/bot-api/src', 'apps/quanly-api/src'];
const MAU = /(?:_at|_date|_from)\s*[<>]=?\s*now\(\)|now\(\)\s*[-+]\s*interval[^)]*\)\s*[<>]/i;
function quet(thu, ra) {
  let d;
  try { d = readdirSync(thu); } catch { return ra; }
  for (const x of d) {
    const p = join(thu, x);
    if (statSync(p).isDirectory()) quet(p, ra);
    else if (extname(x) === '.ts' && !/\.test\.ts$/.test(x)) ra.push(p);
  }
  return ra;
}
const tep = VUNG.flatMap((v) => quet(resolve(GOC, v), []));
chot(tep.length > 50, 'quét được ' + tep.length + ' tệp lớp chạy thật (quá ít là bộ quét hỏng)');
const dinh = [];
for (const f of tep) {
  const dong = readFileSync(f, 'utf8').split('\n');
  for (let i = 0; i < dong.length; i++) {
    const sach = dong[i].trim();
    if (sach.startsWith('//') || sach.startsWith('*') || sach.startsWith('/*')) continue; // chú thích không phải mã
    if (!MAU.test(dong[i])) continue;
    if (/so-voi-now-co-chu-y:/.test(dong[i - 1] ?? '') || /so-voi-now-co-chu-y:/.test(dong[i])) continue;
    dinh.push(relative(GOC, f) + ':' + (i + 1));
  }
}
if (dinh.length) console.log('      còn so với now():', dinh.join(' · '));
chot(dinh.length === 0,
  'KHÔNG còn chỗ nào so cột mốc với now() của máy chủ (' + dinh.length + ') — muốn cố ý thì ghi chú `so-voi-now-co-chu-y:`');

// ── (2) ĐO THẬT trên DB thử: phép so CÙNG HỆ phân biệt đúng "mới" và "cũ" ──
// KHÔNG đo bằng cách bắt chước độ lệch: thư viện pg thuần ghi ĐÚNG, chỉ lớp adapter của Prisma mới
// lệch — bắt chước ở đây là đo nhầm (đã cắn ngay lần chạy đầu: ra 0.00h rồi kết luận sai).
// Thay vào đó dựng 2 dòng có tuổi RÕ RÀNG rồi khẳng định phép so phân loại đúng.
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN = 'kiem-b210-' + Date.now();
try {
  const uid = (await db.query('SELECT id FROM users ORDER BY id LIMIT 1')).rows[0].id;
  for (const [hau, moc] of [['moi', new Date()], ['cu', new Date(Date.now() - 20 * 60 * 1000)]]) {
    await db.query(
      `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
       VALUES ($1,$2,$3,now()+interval '1 hour',$3,$4)`, [NHAN + '-' + hau, uid, moc, NHAN]
    );
  }
  const nguong = new Date(Date.now() - 10 * 60 * 1000);
  const r = await db.query(
    `SELECT id, (created_at < $2) AS cu FROM login_sessions WHERE device_info = $1`, [NHAN, nguong]);
  const bang = new Map(r.rows.map((x) => [x.id.endsWith('-cu') ? 'cu' : 'moi', x.cu]));
  console.log('      dòng vừa ghi → coi là cũ?', bang.get('moi'), '· dòng 20 phút trước → coi là cũ?', bang.get('cu'));
  chot(bang.get('moi') === false, 'dòng VỪA ghi KHÔNG bị coi là cũ (chốt chống gửi trùng còn tác dụng)');
  chot(bang.get('cu') === true, 'dòng 20 PHÚT TRƯỚC ĐÚNG LÀ cũ (chốt vẫn tự gỡ được chỗ giữ mồ côi)');
  const lechHe = new Date(nguong.getTime() + 7 * 3600 * 1000);
  const r2 = await db.query(`SELECT (created_at < $2) AS cu FROM login_sessions WHERE id = $1`, [NHAN + '-moi', lechHe]);
  console.log('      [đối chứng] so bằng mốc lệch 7 tiếng → dòng vừa ghi bị coi là cũ?', r2.rows[0].cu);
  chot(r2.rows[0].cu === true,
    'ĐỐI CHỨNG: lệch hệ quy chiếu 7 tiếng ĐÚNG LÀ làm phân loại sai — nên mới phải truyền mốc cùng hệ');
} finally {
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  await db.end();
}

// ── (3) ĐỔI HẠ TẦNG MỐC THỜI GIAN PHẢI NẰM SAU CÔNG TẮC TẮT-MẶC-ĐỊNH ──
// Ca thật 19/11 20:07: sửa ép múi giờ UTC vào lớp kết nối mà KHÔNG có công tắt; máy chủ tự khởi động
// lại theo vòng lặp và NẠP LUÔN bản sửa trong khi dữ liệu cũ chưa dịch ⇒ kỳ xem lệch 7 tiếng,
// Admin Demo mở app chỉ còn thấy 1 bill trên 8. KHÔNG mất dữ liệu nhưng làm gián đoạn công việc thật.
// LUẬT: mọi thay đổi hạ tầng mốc thời gian ở lớp kết nối PHẢI nằm sau một công tắt, MẶC ĐỊNH TẮT.
const nguon = readFileSync(resolve(GOC, 'packages/database/src/client.ts'), 'utf8');
const coEp = /options:\s*'-c timezone=/.test(nguon);
const coCongTac = /process\.env\[['"]SIGMA_GIO_UTC['"]\]\s*===\s*'1'/.test(nguon);
console.log('      lớp kết nối: có ép múi giờ?', coEp, '· có công tắt?', coCongTac);
chot(!coEp || coCongTac,
  'ép múi giờ ở lớp kết nối PHẢI nằm sau công tắt SIGMA_GIO_UTC (mặc định tắt) — bật thẳng là lệch kỳ xem ngay');

console.log('\n[cung-he] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[cung-he] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[cung-he] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
