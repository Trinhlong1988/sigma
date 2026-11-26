// B188 — [Admin Demo 19/11 "sửa bill phải sửa được số tiền, người hoàn, số tiền hoàn, số lô, số hóa đơn,
// loại phí loại thẻ; chỉ trường nào gán cố định mới không sửa được"]
//
// Vì sao phải có bài kiểm này: máy chủ nhận ra "sửa" hay "bill mới" CHỈ qua KHOÁ BILL (TID|lô|số HĐ|ngày).
// Đổi số lô là đổi khoá ⇒ trước đây đẻ LÔ MỚI mà lô cũ vẫn nằm nguyên ⇒ DOANH SỐ ĐẾM 2 LẦN (agent audit
// tái hiện: 1 bill 3.444.000đ hoá 2 lô = 6.888.000đ). Nay màn gửi kèm MÃ LÔ ĐANG SỬA.
//
// Kiểm đi TRỌN luồng qua ĐÚNG API màn gọi. Sau MỖI lần sửa đều khẳng định: vẫn đúng MỘT lô, và số trong sổ
// đúng bằng số vừa sửa. ĐỐI CHỨNG: sửa mà KHÔNG gửi mã lô (kiểu cũ) thì phải thấy lô thứ 2 mọc ra.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[sua-bill] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 14;
const daTao = new Set();

const nguoi = (await db.query("SELECT id, full_name FROM users WHERE username='adminroot' AND deleted_at IS NULL")).rows[0];
const nguoi2 = (await db.query("SELECT id, full_name FROM users WHERE deleted_at IS NULL AND id <> $1 ORDER BY id LIMIT 1", [nguoi.id])).rows[0];
// TID có ÍT NHẤT 2 loại thẻ đã đặt giá bán → mới kiểm được việc ĐỔI LOẠI THẺ.
const the = (await db.query(
  `SELECT s.tid_id, t.tid, array_agg(DISTINCT s.card_type_id) AS cards
     FROM tid_sell_fees s JOIN tids t ON t.id = s.tid_id
    WHERE s.deleted_at IS NULL AND t.status='ACTIVE'
    GROUP BY s.tid_id, t.tid HAVING count(DISTINCT s.card_type_id) >= 2
    ORDER BY s.tid_id DESC LIMIT 1`
)).rows[0];
chot(!!the, 'DB thử có TID đặt giá bán cho ≥2 loại thẻ (để kiểm việc ĐỔI loại thẻ)');
chot(!!nguoi2, 'DB thử có ≥2 tài khoản để kiểm ĐỔI người hoàn');

const tho = randomUUID();
const NHAN = 'kiem-sua-bill';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,$2,now(),now()+interval '20 minutes',now(),$3)`,
  [createHash('sha256').update(tho).digest('hex'), nguoi.id, NHAN]
);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };
// [20/11] KHÔNG neo ngày CỨNG trong bài kiểm: giá bán của TID có KỲ HIỆU LỰC, ngày cứng trôi vào quá khứ
// là rơi ra ngoài kỳ ⇒ ghi bill trả 422 và cổng đỏ vì lý do chẳng liên quan tới thứ nó đang kiểm.
const NGAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
const khoa = (lo, hd, ngay) => ['nat', String(the.tid).toLowerCase(), String(lo), String(hd), ngay].join('|');
const demLo = async () => Number((await db.query("SELECT count(*) n FROM los WHERE status <> 'CANCELLED'")).rows[0].n);

async function ghi(body) {
  const r = await fetch(API + '/v1/bills/manual', { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json();
  if (j?.data?.loId) daTao.add(j.data.loId);
  return { ma: r.status, j };
}
const soiLo = async (id) => (await db.query(
  `SELECT l.bill_key, l.bank_reported_lo_number AS so_lo, l.invoice_no, l.void_amount::text AS huy,
          l.refunded_amount::text AS hoan, l.refunded_by_user_id AS nguoi_hoan,
          (SELECT SUM(amount_before_fee)::text FROM lo_rows WHERE lo_id=l.id) AS tien,
          (SELECT string_agg(DISTINCT card_type_id::text, ',') FROM lo_rows WHERE lo_id=l.id) AS the,
          (SELECT count(*)::int FROM lo_rows WHERE lo_id=l.id) AS so_dong
     FROM los l WHERE l.id = $1`, [id]
)).rows[0];

try {
  const [c1, c2] = the.cards;
  // ── (1) GHI BILL GỐC ──
  const g = await ghi({
    tidString: the.tid, cardTypeId: c1, amountBeforeFee: 10_000_000,
    billKey: khoa(8101, 8101, NGAY), bankReportedLoNumber: 8101, soHoaDon: '8101',
    totalAmount: 10_000_000, voidAmount: 0,
    refundedAmount: 1_000_000, refundedByUserId: nguoi.id,
    txnDate: new Date(`${NGAY}T10:00:00+07:00`).toISOString()
  });
  chot(g.ma === 200 && g.j.ok, 'ghi được bill gốc (' + g.ma + ')');
  const loId = g.j?.data?.loId;
  const demSauGhi = await demLo();
  console.log('      lô gốc:', loId, '·', JSON.stringify(await soiLo(loId)));

  // ── (2) SỬA ĐỦ 7 THỨ CÙNG LÚC, có gửi MÃ LÔ ĐANG SỬA ──
  const s2 = await ghi({
    tidString: the.tid, cardTypeId: c2, amountBeforeFee: 7_000_000, // đổi THẺ + GIẢM tiền
    billKey: khoa(8202, 8202, NGAY), bankReportedLoNumber: 8202, soHoaDon: '8202', // đổi SỐ LÔ + SỐ HĐ
    totalAmount: 8_000_000, voidAmount: 1_000_000, // thêm TIỀN HỦY
    refundedAmount: 2_500_000, refundedByUserId: nguoi2.id, // đổi TIỀN HOÀN + NGƯỜI HOÀN
    ghiChu: 'sua bill B188',
    txnDate: new Date(`${NGAY}T10:00:00+07:00`).toISOString(),
    allowDuplicate: true, editingLoId: loId
  });
  console.log('      sửa →', s2.ma, JSON.stringify(s2.j).slice(0, 150));
  chot(s2.ma === 200 && s2.j.ok, 'SỬA được bill (' + s2.ma + ')');
  chot(s2.j?.data?.loId === loId, 'sửa xong vẫn là ĐÚNG LÔ CŨ (' + s2.j?.data?.loId + ' vs ' + loId + ')');
  const demSauSua = await demLo();
  console.log('      số lô trong sổ:', demSauGhi, '→', demSauSua);
  chot(demSauSua === demSauGhi, 'KHÔNG đẻ bill thứ hai dù đã đổi số lô (' + demSauGhi + ' → ' + demSauSua + ')');

  const sau = await soiLo(loId);
  console.log('      sổ sau khi sửa:', JSON.stringify(sau));
  chot(Number(sau.tien) === 7_000_000, 'sửa được SỐ TIỀN, kể cả GIẢM xuống (' + sau.tien + ')');
  chot(String(sau.the) === String(c2), 'sửa được LOẠI THẺ (' + sau.the + ' vs ' + c2 + ')');
  chot(Number(sau.so_lo) === 8202, 'sửa được SỐ LÔ (' + sau.so_lo + ')');
  chot(sau.invoice_no === '8202', 'sửa được SỐ HÓA ĐƠN (' + sau.invoice_no + ')');
  chot(Number(sau.huy) === 1_000_000, 'sửa được TIỀN HỦY (' + sau.huy + ')');
  chot(Number(sau.hoan) === 2_500_000, 'sửa được SỐ TIỀN HOÀN (' + sau.hoan + ')');
  chot(sau.nguoi_hoan === nguoi2.id, 'sửa được NGƯỜI HOÀN (' + sau.nguoi_hoan + ' vs ' + nguoi2.id + ')');

  // ── (3) ĐỐI CHỨNG: sửa KIỂU CŨ (không gửi mã lô) thì PHẢI đẻ lô mới ──
  const demTruocDC = await demLo();
  const dc = await ghi({
    tidString: the.tid, cardTypeId: c2, amountBeforeFee: 7_000_000,
    billKey: khoa(8303, 8303, NGAY), bankReportedLoNumber: 8303, soHoaDon: '8303',
    txnDate: new Date(`${NGAY}T10:00:00+07:00`).toISOString(), allowDuplicate: true
  });
  const demSauDC = await demLo();
  console.log('      [đối chứng] ghi không kèm mã lô →', dc.ma, '· số lô:', demTruocDC, '→', demSauDC);
  chot(demSauDC === demTruocDC + 1,
    'ĐỐI CHỨNG: không gửi mã lô thì ĐÚNG LÀ đẻ lô mới (' + demTruocDC + ' → ' + demSauDC + ') — chứng tỏ phép kiểm trên có ý nghĩa');

  // ── (4) CHẶN: sửa sang khoá ĐÃ THUỘC bill khác ⇒ phải từ chối, không gộp nhầm ──
  const demTruocChan = await demLo();
  const chan = await ghi({
    tidString: the.tid, cardTypeId: c2, amountBeforeFee: 7_000_000,
    billKey: khoa(8303, 8303, NGAY), bankReportedLoNumber: 8303, soHoaDon: '8303',
    txnDate: new Date(`${NGAY}T10:00:00+07:00`).toISOString(), allowDuplicate: true, editingLoId: loId
  });
  const demSauChan = await demLo();
  console.log('      sửa sang khoá của bill khác →', chan.ma, JSON.stringify(chan.j).slice(0, 160));
  chot(chan.ma === 409 && !chan.j.ok, 'CHẶN sửa sang số lô/số HĐ đã thuộc bill khác (' + chan.ma + ')');
  chot(demSauChan === demTruocChan, 'bị chặn thì KHÔNG lô nào mọc thêm (' + demTruocChan + ' → ' + demSauChan + ')');
} finally {
  for (const id of daTao) {
    const tx = (await db.query('SELECT transaction_id FROM los WHERE id=$1', [id])).rows[0]?.transaction_id;
    await db.query('DELETE FROM lo_rows WHERE lo_id=$1', [id]);
    await db.query('DELETE FROM los WHERE id=$1', [id]);
    if (tx) await db.query('DELETE FROM transactions WHERE id=$1', [tx]);
  }
  console.log('      đã dọn', daTao.size, 'lô kiểm');
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
}

console.log('\n[sua-bill] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[sua-bill] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[sua-bill] KHÔNG phép kiểm nào đỏ');
await db.end();
if (loi.length) process.exitCode = 1;
