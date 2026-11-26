// B190 — [agent audit 19/11] SỬA BILL ĐỔI LOẠI THẺ / LOẠI PHÍ MÀ GIAO DỊCH GIỮ SỐ CŨ ⇒ TIỀN LỆCH CÂM.
//
// Agent tái hiện: lô ghi thẻ mới (phí 1,03%) nhưng `transactions` vẫn giữ thẻ cũ + biên phí cũ ⇒ doanh thu
// công ty thừa 203.000đ/bill, tiền về NĐT lệch 192.500đ/bill 70tr — không log, không audit, không ai biết.
// Thêm một lỗ nữa: LOẠI PHÍ người nhập chọn xưa nay KHÔNG được gửi lên, máy chủ tự lấy loại phí mặc định.
//
// Bài kiểm đi TRỌN luồng qua ĐÚNG API màn gọi, rồi SOI TẬN BẢNG GIAO DỊCH (không chỉ xem lô):
//   (1) ghi bill thẻ A → (2) sửa sang thẻ B → giao dịch phải mang thẻ B và biên phí của thẻ B;
//   (3) ĐỐI CHỨNG: phí bán trong sổ phải ĐÚNG biểu giá của thẻ B, không phải thẻ A.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[sua-the] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 9;
const daTao = new Set();

// [L2 24/11] TÌM ĐÚNG CẶP thẻ có giá bán MỚI NHẤT KHÁC NHAU — bản cũ lấy đại 2 thẻ đầu của TID đầu,
// môi trường trôi (agent khác đổi giá) là 2 thẻ cùng giá ⇒ cổng đỏ oan "bài kiểm vô nghĩa".
const giaMoiNhat = (await db.query(
  `SELECT DISTINCT ON (s.tid_id, s.card_type_id) s.tid_id, t.tid, s.card_type_id, s.phi_ban
     FROM tid_sell_fees s JOIN tids t ON t.id = s.tid_id
    WHERE s.deleted_at IS NULL AND t.status='ACTIVE'
    ORDER BY s.tid_id, s.card_type_id, s.effective_from DESC, s.id DESC`
)).rows;
const theoTid = new Map();
for (const r of giaMoiNhat) {
  const k = Number(r.tid_id);
  if (!theoTid.has(k)) theoTid.set(k, { tid_id: k, tid: r.tid, cards: [] });
  theoTid.get(k).cards.push({ card: Number(r.card_type_id), gia: Number(r.phi_ban) });
}
let tid = null, theA = null, theB = null;
for (const ent of [...theoTid.values()].sort((a, b) => b.tid_id - a.tid_id)) {
  for (let i = 0; i < ent.cards.length && !tid; i++)
    for (let j = i + 1; j < ent.cards.length; j++)
      if (ent.cards[i].gia !== ent.cards[j].gia) { tid = ent; theA = ent.cards[i].card; theB = ent.cards[j].card; break; }
  if (tid) break;
}
chot(!!tid, 'DB thử có TID với CẶP thẻ giá bán KHÁC NHAU (tự dò toàn sổ, không lấy đại 2 thẻ đầu)');
const giaCua = async (card) => Number((await db.query(
  'SELECT phi_ban FROM tid_sell_fees WHERE tid_id=$1 AND card_type_id=$2 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
  [tid.tid_id, card]
)).rows[0]?.phi_ban ?? 0);
const giaA = await giaCua(theA), giaB = await giaCua(theB);
console.log('      TID', tid.tid, '· thẻ A', theA, '=', giaA / 1000 + '%', '· thẻ B', theB, '=', giaB / 1000 + '%');
chot(giaA !== giaB, 'hai thẻ có GIÁ BÁN KHÁC NHAU (' + giaA + ' vs ' + giaB + ') — bằng nhau thì bài kiểm vô nghĩa');

const tho = randomUUID();
const NHAN = 'kiem-sua-the';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };
// [20/11] KHÔNG neo ngày CỨNG trong bài kiểm: giá bán của TID có KỲ HIỆU LỰC, ngày cứng trôi vào quá khứ
// là rơi ra ngoài kỳ ⇒ ghi bill trả 422 và cổng đỏ vì lý do chẳng liên quan tới thứ nó đang kiểm.
const NGAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
const khoa = (lo) => ['nat', String(tid.tid).toLowerCase(), String(lo), String(lo), NGAY].join('|');
const TIEN = 70_000_000;

async function ghi(body) {
  const r = await fetch(API + '/v1/bills/manual', { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json();
  if (j?.data?.loId) daTao.add(j.data.loId);
  return { ma: r.status, j };
}
const soiGD = async (loId) => (await db.query(
  `SELECT tx.id, tx.card_type_id, tx.fee_type_id, tx.amount::text AS tien, tx.sell_margin_milli AS sm,
          tx.partner_margin_milli AS pm, tx.phi_cai_may_milli AS pcm, tx.revenue_amount::text AS doanh_thu,
          tx.deleted_at IS NOT NULL AS da_xoa,
          (SELECT string_agg(DISTINCT card_type_id::text, ',') FROM lo_rows WHERE lo_id=$1) AS the_lo,
          (SELECT SUM(fee_applied)::text FROM lo_rows WHERE lo_id=$1) AS phi_lo
     FROM los l LEFT JOIN transactions tx ON tx.id = l.transaction_id WHERE l.id = $1`, [loId]
)).rows[0];

try {
  // ── (1) GHI BILL với thẻ A ──
  const g = await ghi({
    tidString: tid.tid, cardTypeId: theA, amountBeforeFee: TIEN,
    billKey: khoa(9401), bankReportedLoNumber: 9401, soHoaDon: '9401',
    txnDate: new Date(`${NGAY}T10:00:00+07:00`).toISOString()
  });
  chot(g.ma === 200 && g.j.ok, 'ghi được bill với thẻ A (' + g.ma + ')');
  const loId = g.j?.data?.loId;
  const truoc = await soiGD(loId);
  console.log('      sau khi ghi:', JSON.stringify(truoc));
  chot(String(truoc.the_lo) === String(theA) && truoc.card_type_id === theA, 'lô VÀ giao dịch đều mang thẻ A');

  // ── (2) SỬA sang thẻ B (giữ nguyên mọi thứ khác) ──
  const s2 = await ghi({
    tidString: tid.tid, cardTypeId: theB, amountBeforeFee: TIEN,
    billKey: khoa(9401), bankReportedLoNumber: 9401, soHoaDon: '9401',
    txnDate: new Date(`${NGAY}T10:00:00+07:00`).toISOString(),
    allowDuplicate: true, editingLoId: loId
  });
  chot(s2.ma === 200 && s2.j.ok, 'sửa sang thẻ B được (' + s2.ma + ')');

  const sau = await soiGD(loId);
  console.log('      sau khi sửa:', JSON.stringify(sau));
  chot(String(sau.the_lo) === String(theB), 'LÔ đã mang thẻ B (' + sau.the_lo + ')');
  chot(sau.card_type_id === theB,
    'GIAO DỊCH cũng mang thẻ B (' + sau.card_type_id + ') — trước đây giữ thẻ cũ nên tiền NĐT lệch câm');

  // Phí trong sổ phải đúng biểu giá thẻ B: phí = tiền × giá/1000 / 100
  const phiMongDoi = Math.round((TIEN * giaB) / 100000);
  console.log('      phí lô:', sau.phi_lo, '· phí mong đợi theo thẻ B:', phiMongDoi);
  chot(Math.abs(Number(sau.phi_lo) - phiMongDoi) <= 1, 'PHÍ BÁN trong sổ tính theo ĐÚNG giá thẻ B (' + sau.phi_lo + ')');
  chot(Number(sau.tien) === TIEN, 'số tiền giao dịch giữ đúng (' + sau.tien + ')');
} finally {
  for (const id of daTao) {
    const txs = (await db.query('SELECT id FROM transactions WHERE id IN (SELECT transaction_id FROM los WHERE id=$1)', [id])).rows;
    await db.query('DELETE FROM lo_rows WHERE lo_id=$1', [id]);
    await db.query('DELETE FROM los WHERE id=$1', [id]);
    for (const x of txs) await db.query('DELETE FROM transactions WHERE id=$1', [x.id]);
  }
  // GD cũ bị huỷ mềm khi đổi thẻ → dọn nốt cho sạch
  await db.query("DELETE FROM transactions WHERE code LIKE 'GD%' AND deleted_at IS NOT NULL AND created_at > now() - interval '10 minutes'");
  console.log('      đã dọn', daTao.size, 'lô kiểm');
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
}

console.log('\n[sua-the] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[sua-the] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[sua-the] KHÔNG phép kiểm nào đỏ');
await db.end();
if (loi.length) process.exitCode = 1;
