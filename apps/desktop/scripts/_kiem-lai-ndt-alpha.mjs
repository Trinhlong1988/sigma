// B236 — [Admin Demo 22/11] LÃI NĐT & TIỀN SIGMA THU VỀ.
//
// Mô hình tiền Admin Demo chốt 22/11 (CẤM đổi nếu không có lệnh):
//     lãi NĐT            = (phí mua NĐT    − phí cài máy)   × doanh số
//     SigMa thu phía bán = (phí bán khách  − phí mua NĐT)   × doanh số
//     SigMa thu phía ĐT  = (phí mua đối tác − phí cài máy)  × doanh số
// Cộng lãi NĐT + SigMa phía bán = (phí bán − phí cài máy) × doanh số = đúng phần chênh hệ thống vẫn ghi.
//
// Cổng này BỒI DỮ LIỆU THẬT rồi khẳng định TỪNG SỐ (không đọc mã rồi suy):
//   (1) khai được phí mua NĐT cho 1 TID qua API đặt giá bán;
//   (2) API danh sách bill trả đúng % phí mua NĐT vừa khai;
//   (3) lãi NĐT = (phí mua NĐT − phí cài máy) × doanh số — khớp ĐẾN TỪNG ĐỒNG;
//   (4) SigMa phía bán = (phí bán − phí mua NĐT) × doanh số — khớp đến từng đồng;
//   (5) BẤT BIẾN: lãi NĐT + SigMa phía bán = tiền phí bán thu của khách (trước phí − sau phí);
//   (6) SigMa phía đối tác = (phí mua đối tác − phí cài máy) × doanh số;
//   (7) ĐỐI CHỨNG: TID CHƯA khai phí mua NĐT ⇒ lãi NĐT để TRỐNG (null), KHÔNG bịa 0.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[lai-ndt] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 8;
/** Cùng cách làm tròn với marginToAmount (nửa lên) — để so ĐẾN TỪNG ĐỒNG. */
const tien = (goc, milli) => Math.round((goc * milli) / 100000);

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

const NHAN = 'kiem-b236';
const daTao = new Set();
let chup = [];
let cu = null;
const homNay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
try {
  const m = (await db.query(
    `SELECT s.id, s.tid_id, t.tid, s.card_type_id, s.fee_type_id
       FROM tid_sell_fees s JOIN tids t ON t.id = s.tid_id
      WHERE s.deleted_at IS NULL AND t.status='ACTIVE' AND t.customer_id IS NOT NULL AND t.partner_id IS NOT NULL
        AND s.effective_from <= $1
      ORDER BY s.id DESC LIMIT 1`, [homNay + 'T00:00:00+07:00'])).rows[0];
  chot(!!m, 'DB thử có TID dùng được để kiểm (' + (m?.tid ?? 'không có') + ')');
  if (!m) throw new Error('thiếu dữ liệu dựng cảnh');
  cu = m;
  chup = (await db.query('SELECT id, phi_ban, phi_mua_ndt, effective_from, deleted_at FROM tid_sell_fees WHERE tid_id=$1', [m.tid_id])).rows;

  const tho = randomUUID();
  await db.query(
    `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
     VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
    [createHash('sha256').update(tho).digest('hex'), NHAN]
  );
  const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };

  // Phí cài máy + phí bán đang hiệu lực của thẻ này → chọn phí mua NĐT NẰM GIỮA để cả 2 vế đều dương.
  const r0 = (await db.query(
    `SELECT fr.phi_cai_may, fr.phi_mua, s.phi_ban
       FROM tid_sell_fees s JOIN tids t ON t.id = s.tid_id
       JOIN fee_rates fr ON fr.partner_id = t.partner_id AND fr.card_type_id = s.card_type_id AND fr.deleted_at IS NULL
      WHERE s.id = $1 ORDER BY fr.effective_from DESC LIMIT 1`, [m.id])).rows[0];
  chot(!!r0 && r0.phi_cai_may != null, 'tra được phí cài máy + phí bán của thẻ kiểm');
  if (!r0) throw new Error('thiếu biểu phí');
  const caiMay = Number(r0.phi_cai_may);
  const banMilli = Number(r0.phi_ban);
  const muaNdtMilli = Math.round((caiMay + banMilli) / 2); // nằm giữa cài máy và giá bán
  const muaDoiTac = Number(r0.phi_mua);
  console.log('      phí cài máy', caiMay / 1000 + '%', '· phí bán', banMilli / 1000 + '%',
    '· ĐẶT phí mua NĐT', muaNdtMilli / 1000 + '%', '· phí mua đối tác', muaDoiTac / 1000 + '%');

  // (1) Khai phí mua NĐT qua API đặt giá bán.
  const rPut = await fetch(API + '/v1/tids/' + m.tid_id + '/sell-fees', {
    method: 'PUT', headers: H,
    body: JSON.stringify({
      feeTypeId: m.fee_type_id, effectiveFrom: homNay,
      entries: [{ cardTypeId: m.card_type_id, phiBan: banMilli / 1000, phiMuaNdt: muaNdtMilli / 1000 }]
    })
  });
  const jPut = await rPut.json().catch(() => ({}));
  console.log('      khai phí mua NĐT →', rPut.status, String(jPut.error ?? '').slice(0, 60));
  const daGhi = (await db.query(
    `SELECT phi_mua_ndt FROM tid_sell_fees WHERE tid_id=$1 AND card_type_id=$2 AND deleted_at IS NULL
       AND phi_mua_ndt IS NOT NULL ORDER BY effective_from DESC, id DESC LIMIT 1`,
    [m.tid_id, m.card_type_id])).rows[0];
  chot(rPut.status === 200 && daGhi != null && Number(daGhi.phi_mua_ndt) === muaNdtMilli,
    'khai được phí mua NĐT và sổ lưu ĐÚNG số (' + (daGhi ? Number(daGhi.phi_mua_ndt) / 1000 : '—') + '%)');

  // Ghi 1 bill để có số kiểm.
  const TIEN = 70_000_000;
  const lo = 7741;
  const rBill = await fetch(API + '/v1/bills/manual', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      tidString: m.tid, cardTypeId: m.card_type_id, feeTypeId: m.fee_type_id, amountBeforeFee: TIEN,
      billKey: ['nat', String(m.tid).toLowerCase(), String(lo), String(lo), homNay].join('|'),
      bankReportedLoNumber: lo, txnDate: new Date(homNay + 'T10:00:00+07:00').toISOString()
    })
  });
  const jBill = await rBill.json();
  if (!jBill?.data?.loId) console.log('      [ghi bill] HỎNG ' + rBill.status + ' · ' + (jBill.error ?? '') + ' · ' + String(jBill.message ?? '').slice(0, 120));
  chot(!!jBill?.data?.loId, 'ghi được bill ' + TIEN.toLocaleString('vi') + 'đ để kiểm số');
  if (!jBill?.data?.loId) throw new Error('dựng cảnh hỏng');
  daTao.add(jBill.data.loId);

  const ds = await (await fetch(API + '/v1/bills/manual?from=' + homNay + '&to=' + homNay + '&limit=500', { headers: H })).json();
  const hang = (ds.data ?? []).find((x) => x.loId === jBill.data.loId);
  if (!hang) throw new Error('không thấy bill vừa ghi trong danh sách');

  const mongLai = tien(TIEN, muaNdtMilli - caiMay);
  const mongBan = tien(TIEN, banMilli - muaNdtMilli);
  const mongDt = tien(TIEN, muaDoiTac - caiMay);
  const phiThuKhach = hang.tienLo - hang.nhanVe;
  console.log('      app trả: % mua NĐT =', hang.phiMuaNdtPct, '· lãi NĐT =', hang.laiNdt, '· SigMa bán =', hang.alphaBan, '· SigMa ĐT =', hang.alphaDoiTac);
  console.log('      mong đợi: lãi =', mongLai, '· SigMa bán =', mongBan, '· SigMa ĐT =', mongDt, '· phí thu khách =', phiThuKhach);

  chot(hang.phiMuaNdtPct === muaNdtMilli / 1000, 'danh sách bill trả ĐÚNG % phí mua NĐT vừa khai');
  chot(hang.laiNdt === mongLai, 'lãi NĐT = (phí mua NĐT − phí cài máy) × doanh số, khớp từng đồng (' + hang.laiNdt + ' vs ' + mongLai + ')');
  chot(hang.alphaBan === mongBan, 'SigMa phía bán = (phí bán − phí mua NĐT) × doanh số, khớp từng đồng (' + hang.alphaBan + ' vs ' + mongBan + ')');
  // BẤT BIẾN ĐÚNG: lãi NĐT + SigMa bán = (phí bán − phí cài máy) × doanh số.
  // KHÔNG bằng "phí bán thu của khách" — phần phí CÀI MÁY là tiền trả cho bên thứ ba, không thuộc SigMa
  // cũng không thuộc NĐT. (Lần đầu viết sai bất biến này, cổng ra đỏ oan 241.500 vs 1.050.000.)
  const mongChenh = tien(TIEN, banMilli - caiMay);
  chot(hang.laiNdt + hang.alphaBan === mongChenh,
    'BẤT BIẾN: lãi NĐT + SigMa bán = (phí bán − phí cài máy) × doanh số (' + (hang.laiNdt + hang.alphaBan) + ' vs ' + mongChenh + ')');
  console.log('      [đối chiếu] phí bán thu của khách =', phiThuKhach, '· trong đó trả bên thứ ba (phí cài máy) =', phiThuKhach - mongChenh);
  chot(hang.alphaDoiTac === mongDt, 'SigMa phía đối tác = (phí mua đối tác − phí cài máy) × doanh số (' + hang.alphaDoiTac + ' vs ' + mongDt + ')');

  // (7) ĐỐI CHỨNG — xoá khai báo thì lãi NĐT phải để TRỐNG, không bịa 0.
  await db.query('UPDATE tid_sell_fees SET phi_mua_ndt = NULL WHERE tid_id=$1 AND card_type_id=$2', [m.tid_id, m.card_type_id]);
  const ds2 = await (await fetch(API + '/v1/bills/manual?from=' + homNay + '&to=' + homNay + '&limit=500', { headers: H })).json();
  const hang2 = (ds2.data ?? []).find((x) => x.loId === jBill.data.loId);
  console.log('      sau khi XOÁ khai báo: lãi NĐT =', hang2?.laiNdt, '· SigMa bán =', hang2?.alphaBan, '· SigMa ĐT =', hang2?.alphaDoiTac);
  chot(hang2 != null && hang2.laiNdt === null && hang2.alphaBan === null && hang2.alphaDoiTac === mongDt,
    'ĐỐI CHỨNG: chưa khai phí mua NĐT ⇒ lãi NĐT để TRỐNG (không bịa 0), phần đối tác vẫn tính được');
} catch (e) {
  console.log('  ĐỎ  không chạy được phép kiểm: ' + e.message);
  so++; loi.push('không chạy được phép kiểm: ' + e.message);
} finally {
  const buoc = async (ten, fn) => { try { await fn(); } catch (e) { console.log('      [TRẢ NGUYÊN TRẠNG] HỎNG ' + ten + ': ' + e.message); loi.push('trả nguyên trạng hỏng: ' + ten); } };
  for (const id of daTao) {
    await buoc('xoá lô ' + id, async () => {
      const tx = (await db.query('SELECT transaction_id FROM los WHERE id=$1', [id])).rows[0]?.transaction_id;
      await db.query('DELETE FROM lo_rows WHERE lo_id=$1', [id]);
      await db.query('DELETE FROM los WHERE id=$1', [id]);
      if (tx) await db.query('DELETE FROM transactions WHERE id=$1', [tx]);
    });
  }
  if (cu) {
    const giu = chup.map((x) => x.id);
    if (giu.length) await buoc('xoá kỳ mới sinh', () => db.query('DELETE FROM tid_sell_fees WHERE tid_id=$1 AND NOT (id = ANY($2::int[]))', [cu.tid_id, giu]));
    for (const x of chup) {
      await buoc('kỳ #' + x.id, () => db.query(
        'UPDATE tid_sell_fees SET phi_ban=$2, phi_mua_ndt=$3, effective_from=$4, deleted_at=$5 WHERE id=$1',
        [x.id, x.phi_ban, x.phi_mua_ndt, x.effective_from, x.deleted_at]));
    }
    const song = Number((await db.query('SELECT count(*)::text c FROM tid_sell_fees WHERE tid_id=$1 AND deleted_at IS NULL', [cu.tid_id])).rows[0].c);
    const songChup = chup.filter((x) => x.deleted_at === null).length;
    so++;
    if (song === songChup) console.log('  ĐẠT trả NGUYÊN TRẠNG giá bán đúng ' + song + ' kỳ còn sống');
    else { console.log('  ĐỎ  trả nguyên trạng LỆCH: còn sống ' + song + ', lúc chụp ' + songChup); loi.push('trả nguyên trạng lệch'); }
  }
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  await db.end();
}

console.log('\n[lai-ndt] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[lai-ndt] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[lai-ndt] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
