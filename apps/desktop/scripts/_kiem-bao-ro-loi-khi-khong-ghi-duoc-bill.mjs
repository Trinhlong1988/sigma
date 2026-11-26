// B200 — [Admin Demo 19/11 "phải báo rõ lỗi khi không thêm được bill"]
//
// Ca thật: Admin Demo không ghi được bill, và những gì máy chủ trả về là:
//   · "TID id=208 không thuộc đại lý đang gọi."  ← mã nội bộ + thuật ngữ của luồng BOT, người nhập tay không hiểu
//   · "Bạn không có quyền thực hiện thao tác này." ← không nói thao tác nào, thiếu quyền gì, nhờ ai
// Chặn là ĐÚNG (không có giá bán thì tiền về đại lý/NĐT sẽ sai), nhưng chặn mà không nói rõ thì người dùng
// đứng im không biết làm gì — đúng họ với lỗi "ẩn im" đã sửa ở B197.
//
// LUẬT cổng này khoá: MỌI câu từ chối ở đường ghi bill phải nói đủ 3 ý —
//   (1) CHUYỆN GÌ (nêu đích danh số TID / loại thẻ, KHÔNG dùng mã nội bộ "id=");
//   (2) VÌ SAO;
//   (3) LÀM GÌ TIẾP (vào màn nào, bấm nút nào).
// Có ĐỐI CHỨNG: cùng TID đó sau khi đủ điều kiện thì ghi được 200 — chứng tỏ chặn không chặn oan.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[bao-ro-loi] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 14;
const daTao = new Set();

/** Một câu báo lỗi ĐẠT khi: nêu đích danh TID · không lộ mã nội bộ · có chỉ dẫn việc phải làm. */
function soiCau(cau, soTid, nhan) {
  const coTid = cau.includes(String(soTid));
  const loMaNoiBo = /\bid=\d+/.test(cau);
  const coChiDan = /Vào màn|bấm|chọn lại|bật ô|Nhờ /i.test(cau);
  chot(coTid, nhan + ': câu báo nêu ĐÍCH DANH số TID (' + (coTid ? 'có' : 'KHÔNG có ' + soTid) + ')');
  chot(!loMaNoiBo, nhan + ': KHÔNG lộ mã nội bộ kiểu "id=208"' + (loMaNoiBo ? ' — ĐANG LỘ' : ''));
  chot(coChiDan, nhan + ': có chỉ dẫn VIỆC PHẢI LÀM' + (coChiDan ? '' : ' — câu cụt, người đọc không biết làm gì'));
}

const bank = (await db.query(
  `SELECT t.bank_id, count(*) n FROM tids t
    WHERE t.deleted_at IS NULL AND t.status='ACTIVE' AND t.customer_id IS NOT NULL AND t.partner_id IS NOT NULL
    GROUP BY 1 ORDER BY n DESC LIMIT 1`
)).rows[0];
const tidDu = (await db.query(
  `SELECT t.id, t.tid, s.card_type_id, s.fee_type_id
     FROM tids t JOIN tid_sell_fees s ON s.tid_id=t.id AND s.deleted_at IS NULL
    WHERE t.deleted_at IS NULL AND t.status='ACTIVE' AND t.customer_id IS NOT NULL AND t.partner_id IS NOT NULL
      AND t.bank_id=$1 ORDER BY t.id DESC LIMIT 1`, [bank?.bank_id ?? 0]
)).rows[0];
chot(!!tidDu, 'DB thử có TID ĐỦ điều kiện để làm đối chứng (' + (tidDu?.tid ?? 'không có') + ')');

// Thẻ của NGÂN HÀNG KHÁC — để kiểm câu "thẻ không thuộc ngân hàng của TID".
const theKhacBank = (await db.query(
  `SELECT id, name FROM card_types WHERE deleted_at IS NULL AND bank_id IS NOT NULL AND bank_id <> $1 ORDER BY id LIMIT 1`,
  [bank.bank_id]
)).rows[0];
chot(!!theKhacBank, 'DB thử có loại thẻ của ngân hàng KHÁC để kiểm câu báo sai thẻ');

// TID mới tinh, chưa giao khách.
const TEN_KIEM = 'KIEM BAO RO LOI B200';
const SO_TID = '98' + String(Date.now()).slice(-6);
await db.query('DELETE FROM tids WHERE hkd_name = $1', [TEN_KIEM]);
await db.query(
  `INSERT INTO tids (tid, hkd_name, bank_id, status, created_at, updated_at)
   VALUES ($1,$2,$3,'UNASSIGNED',now(),now())`, [SO_TID, TEN_KIEM, bank.bank_id]
);

const tho = randomUUID();
const NHAN = 'kiem-b200';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };
// [20/11] KHÔNG neo ngày CỨNG trong bài kiểm: giá bán của TID có KỲ HIỆU LỰC, ngày cứng trôi vào quá khứ
// là rơi ra ngoài kỳ ⇒ ghi bill trả 422 và cổng đỏ vì lý do chẳng liên quan tới thứ nó đang kiểm.
const NGAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
async function ghi(body) {
  const r = await fetch(API + '/v1/bills/manual', { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json();
  if (j?.data?.loId) daTao.add(j.data.loId);
  return { ma: r.status, j };
}

try {
  // ── (1) TID CHƯA GIAO KHÁCH ──
  const a = await ghi({
    tidString: SO_TID, cardTypeId: tidDu.card_type_id, amountBeforeFee: 3_000_000,
    billKey: ['nat', SO_TID, '9801', '9801', NGAY].join('|'), bankReportedLoNumber: 9801,
    txnDate: new Date(`${NGAY}T10:00:00+07:00`).toISOString()
  });
  console.log('      [chưa giao khách] ' + a.ma + ' · ' + (a.j.message ?? ''));
  chot(a.ma >= 400 && !a.j.ok, 'TID chưa giao khách: VẪN bị chặn (' + a.ma + ')');
  soiCau(String(a.j.message ?? ''), SO_TID, 'chưa giao khách');

  // ── (2) TID ĐỦ ĐIỀU KIỆN nhưng LOẠI THẺ chưa đặt giá bán ──
  const theChuaGia = (await db.query(
    `SELECT c.id, c.name FROM card_types c
      WHERE c.deleted_at IS NULL AND c.bank_id = $1
        AND NOT EXISTS (SELECT 1 FROM tid_sell_fees s WHERE s.tid_id=$2 AND s.card_type_id=c.id AND s.deleted_at IS NULL)
      ORDER BY c.id LIMIT 1`, [bank.bank_id, tidDu.id]
  )).rows[0];
  if (theChuaGia) {
    const b = await ghi({
      tidString: tidDu.tid, cardTypeId: theChuaGia.id, feeTypeId: tidDu.fee_type_id, amountBeforeFee: 3_000_000,
      billKey: ['nat', String(tidDu.tid).toLowerCase(), '9802', '9802', NGAY].join('|'), bankReportedLoNumber: 9802,
      txnDate: new Date(`${NGAY}T10:00:00+07:00`).toISOString()
    });
    console.log('      [thẻ ' + theChuaGia.name + ' chưa có giá bán] ' + b.ma + ' · ' + (b.j.message ?? ''));
    chot(b.ma >= 400 && !b.j.ok, 'thẻ chưa đặt giá bán: VẪN bị chặn (' + b.ma + ')');
    soiCau(String(b.j.message ?? ''), tidDu.tid, 'thiếu giá bán');
    chot(String(b.j.message ?? '').includes(theChuaGia.name),
      'thiếu giá bán: câu báo gọi ĐÚNG TÊN LOẠI THẺ đang chọn ("' + theChuaGia.name + '")');
  } else {
    chot(false, 'DB thử có loại thẻ CHƯA đặt giá bán để dựng cảnh (không tìm được)');
    so += 3; // giữ số phép kiểm cố định — thiếu dữ liệu vẫn phải lộ ra là ĐỎ, không im
  }

  // ── (3) LOẠI THẺ SAI NGÂN HÀNG ──
  const c = await ghi({
    tidString: tidDu.tid, cardTypeId: theKhacBank.id, amountBeforeFee: 3_000_000,
    billKey: ['nat', String(tidDu.tid).toLowerCase(), '9803', '9803', NGAY].join('|'), bankReportedLoNumber: 9803,
    txnDate: new Date(`${NGAY}T10:00:00+07:00`).toISOString()
  });
  // [B209 19/11 — Admin Demo "kể cả thẻ khác bank khác"] LUẬT ĐỔI: thẻ khác ngân hàng KHÔNG còn bị chặn.
  // Nó vẫn có thể dừng ở bước GIÁ BÁN (chưa đặt giá cho thẻ đó) — nhưng KHÔNG được dừng vì "khác ngân hàng".
  console.log('      [thẻ khác ngân hàng] ' + c.ma + ' · ' + (c.j.message ?? ''));
  chot(c.j.error !== 'CARD_BANK_MISMATCH',
    'thẻ khác ngân hàng KHÔNG còn bị chặn vì khác ngân hàng (mã lỗi: ' + (c.j.error ?? 'không lỗi') + ')');
  chot(c.ma === 200 || /giá bán/i.test(String(c.j.message ?? '')),
    'nếu còn dừng thì phải vì THIẾU GIÁ BÁN, và câu báo nói rõ điều đó');

  // ── (4) ĐỐI CHỨNG NGƯỢC: đủ điều kiện thì ghi được ──
  const d = await ghi({
    tidString: tidDu.tid, cardTypeId: tidDu.card_type_id, feeTypeId: tidDu.fee_type_id, amountBeforeFee: 3_000_000,
    billKey: ['nat', String(tidDu.tid).toLowerCase(), '9804', '9804', NGAY].join('|'), bankReportedLoNumber: 9804,
    txnDate: new Date(`${NGAY}T10:00:00+07:00`).toISOString()
  });
  console.log('      [ĐỐI CHỨNG đủ điều kiện] ' + d.ma + ' · ' + JSON.stringify(d.j).slice(0, 120));
  chot(d.ma === 200 && d.j.ok === true, 'ĐỐI CHỨNG: TID đủ điều kiện VẪN ghi bill bình thường (' + d.ma + ')');
} finally {
  for (const id of daTao) {
    const tx = (await db.query('SELECT transaction_id FROM los WHERE id=$1', [id])).rows[0]?.transaction_id;
    await db.query('DELETE FROM lo_rows WHERE lo_id=$1', [id]);
    await db.query('DELETE FROM los WHERE id=$1', [id]);
    if (tx) await db.query('DELETE FROM transactions WHERE id=$1', [tx]);
  }
  await db.query('DELETE FROM tids WHERE hkd_name = $1', [TEN_KIEM]);
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  console.log('      đã dọn', daTao.size, 'lô kiểm + TID kiểm');
}

console.log('\n[bao-ro-loi] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[bao-ro-loi] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[bao-ro-loi] KHÔNG phép kiểm nào đỏ');
await db.end();
if (loi.length) process.exitCode = 1;
