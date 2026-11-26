// B184 — [agent audit 19/11, LEAD xác nhận trên SỔ THẬT] GIỜ BILL IN RA LỆCH +7h ⇒ SỬA BILL LÀM DOANH SỐ x2.
//
// Gốc: route trả cột thời gian THÔ rồi để JavaScript quy đổi bằng Intl. Driver đọc timestamptz qua $queryRaw
// đã cộng +7h (giờ treo tường dán "Z"), Intl quy sang Asia/Ho_Chi_Minh CỘNG THÊM 7h nữa.
// Đo trên SỔ THẬT 19/11: lô 3588 giờ thật 14:56 mà màn hiện 21:56; lô 3587 06:00 → 13:00.
// Nguy hiểm nhất: bill quẹt từ 17:00 bị đẩy sang NGÀY HÔM SAU ⇒ khoá bill màn hình dựng ra (nat|tid|lô|hđ|NGÀY)
// lệch khoá đang nằm trong sổ ⇒ bấm Sửa rồi lưu là máy chủ tạo LÔ MỚI, bill cũ vẫn còn ⇒ DOANH SỐ ĐẾM 2 LẦN.
//
// Cổng này khoá 2 việc: (1) giờ API in ra == giờ thật trong sổ, ở 4 mốc gồm nửa đêm và tối muộn;
// (2) đi TRỌN luồng "ghi → mở sửa → ghi lại y nguyên" phải vẫn là MỘT lô.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[gio-bill] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
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
const daTao = [];

const sf = (await db.query(
  `SELECT s.tid_id, s.card_type_id, t.tid FROM tid_sell_fees s JOIN tids t ON t.id = s.tid_id
    WHERE s.deleted_at IS NULL AND t.status='ACTIVE' ORDER BY s.id DESC LIMIT 1`
)).rows[0];
chot(!!sf, 'DB thử có TID đã đặt giá bán để ghi bill kiểm');

const tho = randomUUID();
const NHAN = 'kiem-gio-bill';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };

/** Khoá bill y khuôn màn hình dựng: nat|tid|lô|số HĐ|ngày (ngày lấy từ NGÀY MÀN HÌNH ĐANG HIỆN). */
const khoaTu = (tid, lo, hd, ngay) => ['nat', String(tid).toLowerCase(), String(lo), String(hd), ngay].join('|');

async function ghi(body) {
  const r = await fetch(API + '/v1/bills/manual', { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { ma: r.status, j: await r.json() };
}
async function danhSach(tu, den) {
  const r = await fetch(`${API}/v1/bills/manual?from=${tu}&to=${den}`, { headers: H });
  return (await r.json()).data ?? [];
}

try {
  // ── (1) 4 MỐC GIỜ: giờ API in ra phải TRÙNG giờ thật trong sổ ──
  // [20/11] KHÔNG neo ngày CỨNG: giá bán của TID có KỲ HIỆU LỰC, ngày cứng trôi vào quá khứ là rơi ra
  // ngoài kỳ ⇒ ghi bill trả 422 và cổng đỏ vì lý do chẳng liên quan gì tới thứ nó đang kiểm (đã cắn 20/11).
  // Dùng NGÀY HÔM NAY theo giờ Việt Nam — luôn nằm trong kỳ đang hiệu lực.
  const NGAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
  const MOC = ['00:00', '06:30', '13:45', '23:30'];
  let lech = 0;
  const chiTiet = [];
  for (let i = 0; i < MOC.length; i++) {
    const gio = MOC[i];
    const lo = 7100 + i;
    const a = await ghi({
      tidString: sf.tid, cardTypeId: sf.card_type_id, amountBeforeFee: 1_000_000 + i,
      billKey: khoaTu(sf.tid, lo, lo, NGAY), bankReportedLoNumber: lo,
      txnDate: new Date(`${NGAY}T${gio}:00+07:00`).toISOString()
    });
    if (a.ma !== 200 || !a.j.ok) { chiTiet.push(`${gio}: GHI HỎNG ${a.ma}`); lech++; continue; }
    daTao.push(a.j.data.loId);
    const that = (await db.query(
      `SELECT to_char(COALESCE(bill_txn_date, created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD HH24:MI') g
         FROM los WHERE id=$1`, [a.j.data.loId]
    )).rows[0].g;
    const ds = await danhSach(NGAY, NGAY);
    const dong = ds.find((x) => x.loId === a.j.data.loId);
    const api = dong ? dong.ngay + ' ' + dong.gio : '(KHÔNG THẤY TRONG DANH SÁCH)';
    const khop = that === api;
    if (!khop) lech++;
    chiTiet.push(`${gio} → sổ ${that} | API ${api} ${khop ? 'KHỚP' : '>>> LỆCH <<<'}`);
  }
  for (const d of chiTiet) console.log('      ' + d);
  chot(lech === 0, 'GIỜ API in ra TRÙNG giờ thật trong sổ ở cả 4 mốc (' + lech + ' lệch)');

  // ── (2) Mốc 23:30 KHÔNG được nhảy sang ngày hôm sau ──
  const ds2 = await danhSach(NGAY, NGAY);
  const bill2330 = ds2.find((x) => daTao.includes(x.loId) && x.gio === '23:30');
  console.log('      bill 23:30 nằm ở ngày:', bill2330 ? bill2330.ngay : '(không thấy)');
  chot(!!bill2330, 'tìm thấy bill mốc 23:30 trong danh sách');
  chot(!!bill2330 && bill2330.ngay === NGAY, 'bill 23:30 vẫn thuộc ĐÚNG ngày ' + NGAY + ' (không bị đẩy sang hôm sau)');

  // ── (3) ĐI TRỌN LUỒNG SỬA: mở sửa rồi ghi lại Y NGUYÊN ⇒ vẫn MỘT lô ──
  const demTruoc = Number((await db.query("SELECT count(*) n FROM los WHERE status <> 'CANCELLED'")).rows[0].n);
  const goc = ds2.find((x) => daTao.includes(x.loId) && x.gio === '23:30');
  chot(!!goc, 'lấy được bill 23:30 để dựng lại cảnh SỬA');
  if (goc) {
    // Màn hình dựng khoá từ ĐÚNG những gì nó đang hiện (ngày/lô/số HĐ) — nếu giờ hiển thị sai thì khoá sai theo.
    const khoaManHinh = khoaTu(goc.tid, goc.lo.replace(/\(.*\)/, ''), goc.soHoaDon || goc.lo.replace(/\(.*\)/, ''), goc.ngay);
    const khoaSo = (await db.query('SELECT bill_key FROM los WHERE id=$1', [goc.loId])).rows[0].bill_key;
    console.log('      khoá màn hình dựng:', khoaManHinh);
    console.log('      khoá đang nằm sổ  :', khoaSo);
    chot(khoaManHinh === khoaSo, 'khoá bill màn hình dựng TRÙNG khoá trong sổ (lệch là sửa bill sẽ đẻ lô mới)');

    const b = await ghi({
      tidString: goc.tid, cardTypeId: sf.card_type_id, amountBeforeFee: goc.tienLo,
      billKey: khoaManHinh, bankReportedLoNumber: Number(goc.lo.replace(/\(.*\)/, '')),
      txnDate: new Date(`${goc.ngay}T${goc.gio}:00+07:00`).toISOString(), allowDuplicate: true
    });
    if (b.j?.data?.loId) daTao.push(b.j.data.loId);
    const demSau = Number((await db.query("SELECT count(*) n FROM los WHERE status <> 'CANCELLED'")).rows[0].n);
    console.log('      ghi lại y nguyên →', b.ma, '| lô trả về:', b.j?.data?.loId, '| số lô trong sổ:', demTruoc, '→', demSau);
    chot(b.ma === 200 && b.j?.data?.loId === goc.loId, 'ghi lại Y NGUYÊN trả về ĐÚNG lô cũ (' + b.j?.data?.loId + ' vs ' + goc.loId + ')');
    chot(demSau === demTruoc, 'KHÔNG sinh lô mới khi sửa mà không đổi gì (' + demTruoc + ' → ' + demSau + ')');

    const thatSau = (await db.query(
      `SELECT to_char(COALESCE(bill_txn_date, created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD HH24:MI') g
         FROM los WHERE id=$1`, [goc.loId]
    )).rows[0].g;
    console.log('      mốc quẹt trong sổ sau khi ghi lại:', thatSau);
    chot(thatSau === `${NGAY} 23:30`, 'mốc quẹt KHÔNG bị dời sau khi ghi lại (' + thatSau + ')');
  }
} finally {
  for (const id of [...new Set(daTao)]) {
    const tx = (await db.query('SELECT transaction_id FROM los WHERE id=$1', [id])).rows[0]?.transaction_id;
    await db.query('DELETE FROM lo_rows WHERE lo_id=$1', [id]);
    await db.query('DELETE FROM los WHERE id=$1', [id]);
    if (tx) await db.query('DELETE FROM transactions WHERE id=$1', [tx]);
  }
  console.log('      đã dọn', new Set(daTao).size, 'lô kiểm');
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
}

console.log('\n[gio-bill] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[gio-bill] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[gio-bill] KHÔNG phép kiểm nào đỏ');
await db.end();
if (loi.length) process.exitCode = 1;
