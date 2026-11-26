// B178 — [Admin Demo 16/11 "làm tiền hủy và số hóa đơn luôn đi"] 2 ô cuối cùng của màn Thêm bill chưa được lưu.
//
// ĐIỂM PHẢI CẨN THẬN: tiền hủy nghe như đụng doanh số, nhưng ĐO THẬT thì KHÔNG — màn hình gửi
// `amountBeforeFee = tổng quẹt − tiền hủy` (BillManualEntryPage.tsx:1257), nên số vào sổ xưa nay vẫn đúng.
// Cái thiếu chỉ là VẾT "hủy bao nhiêu / hóa đơn số mấy" để đối soát với sao kê (sao kê in TỔNG QUẸT).
//
// Kiểm: đi TRỌN luồng qua đúng API màn hình gọi, soi DB, đọc lại bằng API danh sách. 3 ĐỐI CHỨNG:
//  (1) số mâu thuẫn (tổng quẹt − hủy ≠ số ghi doanh số) ⇒ API phải TỪ CHỐI, không ghi gì;
//  (2) không gửi 2 trường ⇒ DB để TRỐNG, không bịa 0/'';
//  (3) tiền vào sổ KHÔNG đổi khi có tiền hủy (amount_before_fee đúng bằng số màn hình gửi).
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
const CAN = 15;

const cot = (await db.query(
  "SELECT column_name FROM information_schema.columns WHERE table_name='los' AND column_name IN ('void_amount','invoice_no')"
)).rows.map((r) => r.column_name).sort();
console.log('      cột phụ trên sổ:', cot.join(', ') || '(chưa có)');
chot(cot.length === 2, 'schema-ensure đã tạo đủ 2 cột void_amount + invoice_no');

const nguoi = (await db.query("SELECT id, full_name FROM users WHERE username='adminroot' AND deleted_at IS NULL")).rows[0];
const tho = randomUUID();
const NHAN = 'kiem-b178';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,$2,now(),now()+interval '20 minutes',now(),$3)`,
  [createHash('sha256').update(tho).digest('hex'), nguoi.id, NHAN]
);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };

const sf = (await db.query(
  `SELECT s.tid_id, s.card_type_id, t.tid FROM tid_sell_fees s JOIN tids t ON t.id = s.tid_id
    WHERE s.deleted_at IS NULL AND t.status='ACTIVE' ORDER BY s.id DESC LIMIT 1`
)).rows[0];
chot(!!sf, 'DB thử có TID đã đặt giá bán thực tế để ghi được bill');

async function ghiBill(them, tienVaoSo) {
  const r = await fetch(API + '/v1/bills/manual', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      tidString: sf.tid, cardTypeId: sf.card_type_id, amountBeforeFee: tienVaoSo,
      billKey: 'kiem-b178-' + randomUUID().slice(0, 8),
      txnDate: new Date().toISOString(), ...them
    })
  });
  return { ma: r.status, j: await r.json() };
}

// ── (1) CÓ tiền hủy + số hóa đơn, số liệu KHỚP bất biến ──
const QUET = 9_000_000, HUY = 1_000_000, VAO_SO = QUET - HUY, SO_HD = '000' + Math.floor(Math.random() * 900 + 100);
const a = await ghiBill({ totalAmount: QUET, voidAmount: HUY, soHoaDon: SO_HD }, VAO_SO);
console.log('      ghi bill (quẹt', QUET, '· hủy', HUY, '· HĐ', SO_HD + '):', a.ma, JSON.stringify(a.j).slice(0, 130));
chot(a.ma === 200 && a.j.ok, 'ghi được bill có tiền hủy + số hóa đơn (' + a.ma + ')');
const loId = a.j?.data?.loId;

if (loId) {
  const d = (await db.query(
    `SELECT l.void_amount::text AS huy, l.invoice_no AS hd,
            (SELECT SUM(amount_before_fee)::text FROM lo_rows WHERE lo_id = l.id) AS vao_so
       FROM los l WHERE l.id = $1`, [loId]
  )).rows[0];
  console.log('      DB:', JSON.stringify(d));
  chot(Number(d.huy) === HUY, 'DB lưu ĐÚNG tiền hủy (' + d.huy + ')');
  chot(d.hd === SO_HD, 'DB lưu ĐÚNG số hóa đơn, GIỮ số 0 ở đầu (' + d.hd + ')');
  chot(Number(d.vao_so) === VAO_SO, 'TIỀN VÀO SỔ KHÔNG ĐỔI = đúng số màn hình gửi (' + d.vao_so + '), tiền hủy chỉ là VẾT');

  const hn = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const ds = await (await fetch(`${API}/v1/bills/manual?from=${hn}&to=${hn}`, { headers: H })).json();
  const dong = (ds.data ?? []).find((x) => x.loId === loId);
  console.log('      API danh sách:', JSON.stringify(dong ? { tongQuet: dong.tongQuet, tienHuy: dong.tienHuy, tienLo: dong.tienLo, soHoaDon: dong.soHoaDon } : null));
  chot(!!dong && dong.tienHuy === HUY, 'API trả đúng TIỀN HỦY (hết trả cứng 0)');
  chot(!!dong && dong.soHoaDon === SO_HD, 'API trả đúng SỐ HÓA ĐƠN (hết trả cứng rỗng)');
  chot(!!dong && dong.tienLo === VAO_SO, 'API trả tienLo = số đã vào sổ (' + dong?.tienLo + ')');
  chot(!!dong && dong.tongQuet === QUET, 'API trả tongQuet = tienLo + tienHuy = TỔNG QUẸT trên bill (' + dong?.tongQuet + ')');
}

// ── (2) ĐỐI CHỨNG: số MÂU THUẪN phải bị TỪ CHỐI, và không được ghi lô nào ──
const truocKhi = Number((await db.query("SELECT count(*) n FROM los WHERE status <> 'CANCELLED'")).rows[0].n);
const x = await ghiBill({ totalAmount: 9_000_000, voidAmount: 1_000_000, soHoaDon: '999' }, 8_500_000); // lệch 500k
console.log('      bill mâu thuẫn (9tr − 1tr ≠ 8,5tr):', x.ma, JSON.stringify(x.j).slice(0, 150));
chot(x.ma === 400 && !x.j.ok, 'API TỪ CHỐI số mâu thuẫn (' + x.ma + ')');
const sauKhi = Number((await db.query("SELECT count(*) n FROM los WHERE status <> 'CANCELLED'")).rows[0].n);
chot(sauKhi === truocKhi, 'bị từ chối thì KHÔNG lô nào được ghi (' + truocKhi + ' → ' + sauKhi + ')');

// ── (3) ĐỐI CHỨNG: không gửi 2 trường ⇒ DB để TRỐNG ──
const b = await ghiBill({}, 6_123_000);
chot(b.ma === 200 && b.j.ok, 'ghi được bill đối chứng (không gửi hủy/hóa đơn)');
const loId2 = b.j?.data?.loId;
if (loId2) {
  const d2 = (await db.query('SELECT void_amount, invoice_no FROM los WHERE id=$1', [loId2])).rows[0];
  console.log('      DB đối chứng:', JSON.stringify(d2));
  chot(d2.void_amount === null && d2.invoice_no === null, 'ĐỐI CHỨNG: không gửi thì để TRỐNG, không bịa 0/rỗng');
  const hn = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const ds2 = await (await fetch(`${API}/v1/bills/manual?from=${hn}&to=${hn}`, { headers: H })).json();
  const dong2 = (ds2.data ?? []).find((y) => y.loId === loId2);
  chot(!!dong2 && dong2.tienHuy === 0 && dong2.tongQuet === dong2.tienLo,
    'lô không có hủy: tongQuet = tienLo (không cộng thừa)');
}

console.log('\n[b178] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[b178] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[b178] KHÔNG phép kiểm nào đỏ');

for (const id of [loId, loId2].filter(Boolean)) {
  const tx = (await db.query('SELECT transaction_id FROM los WHERE id=$1', [id])).rows[0]?.transaction_id;
  await db.query('DELETE FROM lo_rows WHERE lo_id=$1', [id]);
  await db.query('DELETE FROM los WHERE id=$1', [id]);
  if (tx) await db.query('DELETE FROM transactions WHERE id=$1', [tx]);
}
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
await db.end();
if (loi.length) process.exitCode = 1;
