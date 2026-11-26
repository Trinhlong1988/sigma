// THÊM LOẠI THẺ CHO MỌI NGÂN HÀNG (Admin Demo 13/11: "phải có thêm JCB all… napas all… áp dụng tất cả các bank").
//
// Đi qua ĐÚNG ĐƯỜNG CỦA APP (`POST /v1/card-types`) chứ KHÔNG chèn thẳng DB:
//   · chạy đủ luật nghiệp vụ + kiểm quyền,
//   · có ghi NHẬT KÝ (audit) đúng như người dùng tự bấm,
//   · trùng tên trong cùng ngân hàng thì chính API chặn, không cần tự chế luật.
// Phiên tạm tự dọn ở cuối. Mặc định CHẠY THỬ; thêm `--that` mới ghi.
//
// Biến: THE='JCB,Napas' (mặc định) · DB_DICH=sigma · API=http://127.0.0.1:8790
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '..');
const THAT = process.argv.includes('--that');
const DB = process.env.DB_DICH || 'sigma';
const API = process.env.API || 'http://127.0.0.1:8790';
const THE = (process.env.THE || 'JCB,Napas').split(',').map((x) => x.trim()).filter(Boolean);
// Ngân hàng rác do nhập thử (tên/mã sinh tự động) — KHÔNG thêm thẻ vào, nhưng PHẢI in ra để Admin Demo biết.
const LA_RAC = (ten, ma) => /\d{10,}/.test(String(ten)) || /\d{10,}/.test(String(ma));

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

const banks = (await db.query('SELECT id, name, code FROM banks WHERE deleted_at IS NULL ORDER BY name')).rows;
const dangCo = (await db.query('SELECT bank_id, name FROM card_types WHERE deleted_at IS NULL')).rows;
const coSan = new Set(dangCo.map((r) => r.bank_id + '|' + String(r.name).trim().toLowerCase()));

const viec = [];
const boQua = [];
for (const b of banks) {
  if (LA_RAC(b.name, b.code)) { boQua.push(b); continue; }
  for (const ten of THE) {
    if (coSan.has(b.id + '|' + ten.toLowerCase())) continue;
    viec.push({ bankId: b.id, bank: b.name, maNh: b.code, name: ten, code: ten });
  }
}

console.log('SỔ ĐÍCH : ' + DB + (DB === 'sigma' ? '   *** SỔ THẬT ***' : '   (bản sao)'));
console.log('CHẾ ĐỘ  : ' + (THAT ? '*** GHI THẬT ***' : 'chạy thử — thêm --that để ghi thật'));
console.log('LOẠI THẺ: ' + THE.join(' · '));
console.log('\nNgân hàng đang có: ' + banks.length + ' · sẽ thêm ' + viec.length + ' loại thẻ');
for (const v of viec) console.log('   + ' + v.name.padEnd(8) + '→ ' + v.bank + ' [' + v.maNh + ']');
if (boQua.length) {
  console.log('\nBỎ QUA (ngân hàng trông như dữ liệu nhập thử — tên/mã có chuỗi số dài):');
  for (const b of boQua) console.log('   · ' + b.name + ' [' + b.code + '] id=' + b.id);
  console.log('   → muốn thêm cả nhóm này thì chạy lại với THEM_RAC=1');
}
if (process.env.THEM_RAC === '1') {
  for (const b of boQua) for (const ten of THE) {
    if (!coSan.has(b.id + '|' + ten.toLowerCase())) viec.push({ bankId: b.id, bank: b.name, maNh: b.code, name: ten, code: ten });
  }
  console.log('   (THEM_RAC=1 — đã gộp nhóm trên vào danh sách, tổng ' + viec.length + ')');
}
if (!viec.length) { console.log('\nKhông có gì để thêm.'); await db.end(); process.exit(0); }

if (!THAT) {
  console.log('\n[chạy thử] CHƯA ghi gì. Chạy lại kèm --that để ghi thật.');
  await db.end();
  process.exit(0);
}

// Phiên tạm — đi đúng đường API để có nhật ký và luật nghiệp vụ.
const NHAN = 'them-loai-the (tự dọn)';
const tho = randomUUID();
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '15 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);

const truoc = (await db.query('SELECT count(*)::int n FROM card_types WHERE deleted_at IS NULL')).rows[0].n;
let ok = 0;
const hong = [];
try {
  for (const v of viec) {
    const r = await fetch(API + '/v1/card-types', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-SigMa-Client': '1', cookie: 'ql_session=' + tho },
      body: JSON.stringify({ bankId: v.bankId, name: v.name, code: v.code })
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok !== false) { ok++; console.log('   ĐẠT  ' + v.name + ' → ' + v.bank); }
    else { hong.push(v.bank + '/' + v.name + ': HTTP ' + r.status + ' ' + (j.error || '') + ' ' + (j.message || '')); console.log('   ĐỎ   ' + v.name + ' → ' + v.bank + ' :: ' + (j.message || r.status)); }
  }
} finally {
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
}

// CỔNG KIỂM SAU KHI GHI
const sau = (await db.query('SELECT count(*)::int n FROM card_types WHERE deleted_at IS NULL')).rows[0].n;
let soKiem = 0;
const loi = [];
const chot = (dieu, ten) => { soKiem++; if (!dieu) loi.push(ten); };
chot(sau === truoc + ok, `số loại thẻ: ${truoc} → ${sau} (thêm ${ok}, đáng lẽ ${truoc + ok})`);
chot(hong.length === 0, hong.length + ' lượt tạo HỎNG: ' + hong.slice(0, 5).join(' | '));
// Mỗi ngân hàng (trừ nhóm bỏ qua) phải có ĐỦ các loại thẻ đã yêu cầu
const sauDs = (await db.query('SELECT bank_id, name FROM card_types WHERE deleted_at IS NULL')).rows;
const sauSet = new Set(sauDs.map((r) => r.bank_id + '|' + String(r.name).trim().toLowerCase()));
for (const b of banks) {
  if (LA_RAC(b.name, b.code) && process.env.THEM_RAC !== '1') continue;
  for (const ten of THE) chot(sauSet.has(b.id + '|' + ten.toLowerCase()), `${b.name} còn THIẾU loại thẻ "${ten}"`);
}
const sot = (await db.query('SELECT count(*)::int n FROM login_sessions WHERE device_info=$1', [NHAN])).rows[0].n;
chot(sot === 0, 'còn sót ' + sot + ' phiên kiểm thử');

console.log('\n— KIỂM SAU KHI GHI — đã chạy ' + soKiem + ' phép kiểm (đếm động)');
if (loi.length) { for (const x of loi) console.log('   ĐỎ  ' + x); console.log('KẾT LUẬN: ' + loi.length + ' phép kiểm ĐỎ'); process.exitCode = 1; }
else console.log('KẾT LUẬN: không phép kiểm nào đỏ — đã thêm ' + ok + ' loại thẻ.');
await db.end();
