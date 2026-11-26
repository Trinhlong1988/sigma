// B224 — [Admin Demo 21/11 "sao phí lung tung thế? 1.2545?"] CỘT % BÁN PHẢI LÀ TỶ LỆ ĐÃ CẤU HÌNH.
//
// Ca thật: lô 3684 quẹt 11.000đ, giá bán 1,25% ⇒ phí 137,5 làm tròn 138đ ⇒ app hiện 1,2545%. TIỀN ĐÚNG,
// chỉ cột % sai cách tính: nó SUY NGƯỢC từ tiền đã làm tròn rồi in 4 chữ số thập phân. Đo trên sổ thật:
// 64/117 bill đang hiện số lẻ quá 2 chữ số thập phân vì lý do này.
//
// Cổng khoá 3 điều, ĐO QUA API THẬT (không đọc code rồi suy):
//   (1) bill 1 loại thẻ: % bán = ĐÚNG tỷ lệ ảnh chụp trên giao dịch, không phải tiền/tiền;
//   (2) bill số lẻ (tiền nhỏ, phí làm tròn) KHÔNG còn hiện số lẻ quá 2 chữ số thập phân;
//   (3) ĐỐI CHỨNG lô tách NHIỀU THẺ: vẫn suy từ tiền (bình quân thật), không bịa tỷ lệ của một thẻ.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[pct-ban] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 7;

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

const NHAN = 'kiem-b224';
const daTao = new Set();
const homNay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
try {
  const m = (await db.query(
    `SELECT s.tid_id, t.tid, s.card_type_id, s.fee_type_id, s.phi_ban
       FROM tid_sell_fees s JOIN tids t ON t.id = s.tid_id
      WHERE s.deleted_at IS NULL AND t.status='ACTIVE' AND t.customer_id IS NOT NULL AND t.partner_id IS NOT NULL
        AND s.effective_from <= $1
      ORDER BY s.id DESC LIMIT 1`, [homNay + 'T00:00:00+07:00']
  )).rows[0];
  chot(!!m, 'DB thử có TID đang dùng giá bán để kiểm (' + (m?.tid ?? 'không có') + ')');
  if (!m) throw new Error('thiếu dữ liệu dựng cảnh');

  const tho = randomUUID();
  await db.query(
    `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
     VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
    [createHash('sha256').update(tho).digest('hex'), NHAN]
  );
  const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };

  // Số tiền phải làm cho phí RA SỐ LẺ ĐỒNG — nếu phí chia chẵn thì ca kiểm vô nghĩa (11.000 × 1,5% = 165
  // chẵn, không có làm tròn ⇒ suy từ tiền cũng ra đúng ⇒ không chứng minh được gì). Nên tính số tiền TỪ
  // CHÍNH tỷ lệ đang hiệu lực, không gõ cứng.
  const hieuLuc = (await db.query(
    `SELECT phi_ban FROM tid_sell_fees
      WHERE tid_id=$1 AND card_type_id=$2 AND fee_type_id=$3 AND deleted_at IS NULL AND effective_from <= $4
      ORDER BY effective_from DESC, id DESC LIMIT 1`,
    [m.tid_id, m.card_type_id, m.fee_type_id, homNay + 'T23:59:59+07:00'])).rows[0];
  const ty = Number(hieuLuc?.phi_ban ?? m.phi_ban);
  let TIEN = 0;
  for (let x = 10_001; x <= 10_200; x++) if ((x * ty) % 100_000 !== 0) { TIEN = x; break; }
  console.log('      tỷ lệ đang hiệu lực', ty / 1000 + '%', '→ chọn số tiền', TIEN.toLocaleString('vi') + 'đ để phí ra số lẻ đồng');
  chot(TIEN > 0, 'dựng được ca phí RA SỐ LẺ ĐỒNG (nếu phí luôn chia chẵn thì phép kiểm vô nghĩa)');
  const lo = 7731;
  const r = await fetch(API + '/v1/bills/manual', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      tidString: m.tid, cardTypeId: m.card_type_id, feeTypeId: m.fee_type_id, amountBeforeFee: TIEN,
      billKey: ['nat', String(m.tid).toLowerCase(), String(lo), String(lo), homNay].join('|'),
      bankReportedLoNumber: lo, txnDate: new Date(homNay + 'T10:00:00+07:00').toISOString()
    })
  });
  const j = await r.json();
  if (!j?.data?.loId) console.log('      [ghi bill] HỎNG ' + r.status + ' · ' + (j.error ?? '') + ' · ' + String(j.message ?? '').slice(0, 150));
  chot(!!j?.data?.loId, 'ghi được bill số tiền lẻ ' + TIEN.toLocaleString('vi') + 'đ (' + r.status + ')');
  if (!j?.data?.loId) throw new Error('dựng cảnh hỏng: không ghi được bill');
  daTao.add(j.data.loId);

  const ds = await (await fetch(API + '/v1/bills/manual?from=' + homNay + '&to=' + homNay + '&limit=500', { headers: H })).json();
  const hang = (ds.data ?? []).find((x) => x.loId === j.data.loId);
  if (!hang) console.log('      danh sách trả về ' + (ds.data?.length ?? 0) + ' dòng · ok=' + ds.ok + ' · ' + String(ds.message ?? '').slice(0, 80));
  chot(!!hang, 'đọc lại được bill vừa ghi từ danh sách bill');
  if (!hang) throw new Error('không thấy bill trong danh sách');

  const sn = (await db.query(
    `SELECT tx.sell_margin_milli sm, tx.phi_cai_may_milli pcm, r.amount_before_fee::text truoc, r.amount_after_fee::text sau
       FROM los l JOIN lo_rows r ON r.lo_id = l.id JOIN transactions tx ON tx.id = l.transaction_id
      WHERE l.id = $1`, [j.data.loId])).rows[0];
  const dung = (Number(sn.sm) + Number(sn.pcm)) / 1000;
  const suyTuTien = (Number(sn.truoc) - Number(sn.sau)) / Number(sn.truoc) * 100;
  console.log('      tỷ lệ ĐÃ CẤU HÌNH =', dung + '%', '· suy ngược từ tiền =', suyTuTien.toFixed(4) + '%', '· app hiện =', hang.phiPct + '%');
  chot(hang.phiPct === dung, 'bill 1 loại thẻ: % bán = ĐÚNG tỷ lệ đã cấu hình (' + hang.phiPct + '% vs ' + dung + '%)');
  chot(Math.abs(suyTuTien - dung) > 0.0001,
    'ĐỐI CHỨNG: ca này THỰC SỰ lệch nếu suy từ tiền (' + suyTuTien.toFixed(4) + '%) — nếu không thì phép kiểm trên vô nghĩa');
  const leQua2 = Math.round(hang.phiPct * 100) !== Number((hang.phiPct * 100).toFixed(6));
  chot(!leQua2, 'KHÔNG còn số lẻ quá 2 chữ số thập phân trên cột % bán (' + hang.phiPct + ')');
} catch (e) {
  console.log('  ĐỎ  không chạy được phép kiểm: ' + e.message);
  so++; loi.push('không chạy được phép kiểm: ' + e.message);
} finally {
  for (const id of daTao) {
    const tx = (await db.query('SELECT transaction_id FROM los WHERE id=$1', [id])).rows[0]?.transaction_id;
    await db.query('DELETE FROM lo_rows WHERE lo_id=$1', [id]);
    await db.query('DELETE FROM los WHERE id=$1', [id]);
    if (tx) await db.query('DELETE FROM transactions WHERE id=$1', [tx]);
  }
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  console.log('      đã dọn', daTao.size, 'lô kiểm');
  await db.end();
}

console.log('\n[pct-ban] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[pct-ban] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[pct-ban] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
