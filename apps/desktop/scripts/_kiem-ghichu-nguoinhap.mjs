// B177 — [Admin Demo 16/11, đào sâu sau "phí cm đâu?"] Ô GHI CHÚ và cột NGƯỜI NHẬP của danh sách bill nhập.
//
// Lỗi cùng lớp B172/B176: ô "Ghi chú" có trên form từ lâu nhưng màn hình KHÔNG gửi lên, API KHÔNG nhận,
// danh sách trả CỨNG '' ⇒ gõ xong tải lại là mất, không báo gì. Lô tạo qua `createLoFromBillTid` mang danh
// nghĩa tài khoản bot nên `los.created_by` để trống ⇒ cột "Người nhập" rỗng, không truy được ai gõ bill.
//
// Kiểm đi TRỌN luồng: ghi bill qua ĐÚNG API màn hình gọi → soi thẳng DB → đọc lại bằng chính API danh sách.
// ĐỐI CHỨNG: bill KHÔNG gửi ghi chú thì note phải TRỐNG (không bịa), nhưng người nhập VẪN phải có.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 10;

const nguoi = (await db.query("SELECT id, full_name FROM users WHERE username='adminroot' AND deleted_at IS NULL")).rows[0];
chot(!!nguoi, 'có tài khoản adminroot để đóng vai NGƯỜI NHẬP');

const tho = randomUUID();
const NHAN = 'kiem-ghichu';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,$2,now(),now()+interval '20 minutes',now(),$3)`,
  [createHash('sha256').update(tho).digest('hex'), nguoi.id, NHAN]
);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };

// TID + loại thẻ CÓ giá bán thực tế — không có thì rớt NO_ACTUAL_SELL_FEE, không tạo được lô để kiểm.
const sf = (await db.query(
  `SELECT s.tid_id, s.card_type_id, t.tid FROM tid_sell_fees s JOIN tids t ON t.id = s.tid_id
    WHERE s.deleted_at IS NULL AND t.status='ACTIVE' ORDER BY s.id DESC LIMIT 1`
)).rows[0];
chot(!!sf, 'DB thử có TID đã đặt giá bán thực tế để ghi được bill');

const GHI_CHU = 'kiem B177 ' + randomUUID().slice(0, 8) + ' — ghi chú người nhập gõ';
async function ghiBill(them, tien) {
  const r = await fetch(API + '/v1/bills/manual', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      tidString: sf.tid, cardTypeId: sf.card_type_id, amountBeforeFee: tien,
      billKey: 'kiem-b177-' + randomUUID().slice(0, 8),
      txnDate: new Date().toISOString(), ...them
    })
  });
  return { ma: r.status, j: await r.json() };
}

// (1) CÓ gửi ghi chú
const a = await ghiBill({ ghiChu: GHI_CHU }, 7_000_000);
console.log('      ghi bill (có ghi chú):', a.ma, JSON.stringify(a.j).slice(0, 140));
chot(a.ma === 200 && a.j.ok, 'ghi được bill kèm ghi chú (' + a.ma + ')');
const loId = a.j?.data?.loId;

if (loId) {
  const d = (await db.query(
    `SELECT l.created_by, u.full_name AS nguoi, tx.note
       FROM los l LEFT JOIN users u ON u.id = l.created_by
       LEFT JOIN transactions tx ON tx.id = l.transaction_id WHERE l.id = $1`, [loId]
  )).rows[0];
  console.log('      DB:', JSON.stringify(d));
  chot(d.note === GHI_CHU, 'DB lưu ĐÚNG ghi chú (không cắt, không đổi chữ)');
  chot(d.created_by === nguoi.id, 'DB ghi ĐÚNG người nhập = tài khoản đang đăng nhập (' + d.created_by + ')');

  const hn = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const ds = await (await fetch(`${API}/v1/bills/manual?from=${hn}&to=${hn}`, { headers: H })).json();
  const dong = (ds.data ?? []).find((x) => x.loId === loId);
  console.log('      API danh sách:', JSON.stringify(dong ? { ghiChu: dong.ghiChu, nguoiNhap: dong.nguoiNhap, caiMayPct: dong.caiMayPct } : null));
  chot(!!dong && dong.ghiChu === GHI_CHU, 'API danh sách TRẢ LẠI đúng ghi chú (hết trả cứng rỗng)');
  chot(!!dong && dong.nguoiNhap === nguoi.full_name, 'API danh sách trả đúng TÊN người nhập');
}

// (2) ĐỐI CHỨNG — KHÔNG gửi ghi chú: note phải TRỐNG, nhưng người nhập VẪN phải có.
const b = await ghiBill({}, 7_111_000);
chot(b.ma === 200 && b.j.ok, 'ghi được bill đối chứng (không gửi ghi chú)');
const loId2 = b.j?.data?.loId;
if (loId2) {
  const d2 = (await db.query(
    `SELECT l.created_by, tx.note FROM los l LEFT JOIN transactions tx ON tx.id = l.transaction_id WHERE l.id = $1`,
    [loId2]
  )).rows[0];
  console.log('      DB đối chứng:', JSON.stringify(d2));
  chot((d2.note ?? '') === '', 'ĐỐI CHỨNG: không gửi ghi chú thì DB để TRỐNG, không bịa chữ');
  chot(d2.created_by === nguoi.id, 'ĐỐI CHỨNG: người nhập VẪN được ghi (' + d2.created_by + ')');
}

console.log('\n[b177] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[b177] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[b177] KHÔNG phép kiểm nào đỏ');

// Dọn 2 lô kiểm (chỉ lô do chính script này tạo).
for (const id of [loId, loId2].filter(Boolean)) {
  const tx = (await db.query('SELECT transaction_id FROM los WHERE id=$1', [id])).rows[0]?.transaction_id;
  await db.query('DELETE FROM lo_rows WHERE lo_id=$1', [id]);
  await db.query('DELETE FROM los WHERE id=$1', [id]);
  if (tx) await db.query('DELETE FROM transactions WHERE id=$1', [tx]);
}
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
await db.end();
if (loi.length) process.exitCode = 1;
