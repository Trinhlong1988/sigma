// B189 — [Admin Demo 19/11 "thêm trường set ca tiền trong quản lý ngân hàng · chọn ca, thêm ca, set giờ đến giờ ·
// logic bắt buộc khi thêm bill mới vào giờ ca tiền nào hiện ca tiền đó · nhồi dữ liệu thật check thật"]
//
// TRƯỚC ĐÂY mốc ca nằm CỨNG trong mã nguồn (`packages/services/src/ca-tien.ts`), chỉ 3 ngân hàng MB/ABB/MBV;
// muốn đổi giờ phải sửa code + ship, còn ngân hàng khác (VP, BVB, SHI…) KHÔNG có ca nên báo cáo lọc theo ca
// loại sạch bill của họ mà không báo gì.
//
// Bài kiểm NHỒI DỮ LIỆU THẬT qua ĐÚNG API màn hình gọi: khai ca cho 1 ngân hàng chưa có ca → đọc lại →
// ghi bill ở từng khung giờ → khẳng định rơi ĐÚNG ca. Có ĐỐI CHỨNG: giờ nằm NGOÀI mọi ca ⇒ không xếp ca;
// khai ca CHỒNG GIỜ ⇒ máy chủ từ chối. Dọn sạch sau khi xong.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[ca-tien] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 12;

const cot = (await db.query(
  "SELECT table_name FROM information_schema.tables WHERE table_name='bank_ca_tien'"
)).rowCount;
chot(cot === 1, 'schema-ensure đã tạo bảng bank_ca_tien');

const tho = randomUUID();
const NHAN = 'kiem-ca-tien';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };

// Ngân hàng để kiểm: lấy bank của 1 TID đã đặt giá bán (để còn ghi được bill thật).
const sf = (await db.query(
  `SELECT s.tid_id, s.card_type_id, t.tid, t.bank_id, b.code, b.name
     FROM tid_sell_fees s JOIN tids t ON t.id = s.tid_id JOIN banks b ON b.id = t.bank_id
    WHERE s.deleted_at IS NULL AND t.status='ACTIVE' ORDER BY s.id DESC LIMIT 1`
)).rows[0];
chot(!!sf, 'DB thử có TID + ngân hàng để kiểm (' + (sf?.code ?? '—') + ')');
const caCu = (await db.query('SELECT id, ten, tu_phut, den_phut FROM bank_ca_tien WHERE bank_id=$1 AND deleted_at IS NULL ORDER BY thu_tu', [sf.bank_id])).rows;
console.log('      ngân hàng kiểm:', sf.code, '· ca đang khai:', caCu.length);

const daTao = new Set();
const gio = (p) => String(Math.floor(p / 60)).padStart(2, '0') + ':' + String(p % 60).padStart(2, '0');

try {
  // ── (1) KHAI 3 CA qua ĐÚNG API màn Quản Lý Ngân Hàng gọi ──
  const CA = [
    { ten: 'Ca sáng', tuPhut: 0, denPhut: 11 * 60 + 50 },
    { ten: 'Ca chiều', tuPhut: 11 * 60 + 51, denPhut: 17 * 60 + 50 },
    { ten: 'Ca tối', tuPhut: 17 * 60 + 51, denPhut: 23 * 60 + 59 }
  ];
  const r1 = await fetch(`${API}/v1/banks/${sf.bank_id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ caTien: CA }) });
  const j1 = await r1.json();
  console.log('      khai 3 ca →', r1.status, JSON.stringify(j1).slice(0, 110));
  chot(r1.status === 200 && j1.ok, 'khai được 3 ca cho ngân hàng (' + r1.status + ')');

  const trongSo = (await db.query(
    'SELECT ten, tu_phut, den_phut, thu_tu FROM bank_ca_tien WHERE bank_id=$1 AND deleted_at IS NULL ORDER BY thu_tu', [sf.bank_id]
  )).rows;
  console.log('      sổ lưu:', trongSo.map((x) => `${x.ten} ${gio(x.tu_phut)}–${gio(x.den_phut)}`).join(' | '));
  chot(trongSo.length === 3, 'SỔ lưu đúng 3 ca (' + trongSo.length + ')');
  chot(trongSo[0].ten === 'Ca sáng' && Number(trongSo[0].den_phut) === 710, 'ca đầu đúng tên + đúng giờ kết thúc');

  // ── (2) ĐỌC LẠI qua API danh sách ngân hàng (đường màn hình dùng) ──
  const ds = await (await fetch(`${API}/v1/banks`, { headers: H })).json();
  const bank = (ds.data ?? []).find((x) => x.id === sf.bank_id);
  console.log('      API trả về ca:', JSON.stringify(bank?.caTien ?? []).slice(0, 160));
  chot(Array.isArray(bank?.caTien) && bank.caTien.length === 3, 'API danh sách ngân hàng TRẢ LẠI đủ 3 ca');
  chot(bank?.caTien?.[1]?.ten === 'Ca chiều', 'tên ca người dùng tự đặt được giữ nguyên');

  // ── (3) CHẶN khai ca CHỒNG GIỜ ──
  const r2 = await fetch(`${API}/v1/banks/${sf.bank_id}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ caTien: [{ ten: 'A', tuPhut: 0, denPhut: 600 }, { ten: 'B', tuPhut: 500, denPhut: 900 }] })
  });
  const j2 = await r2.json();
  console.log('      khai ca chồng giờ →', r2.status, (j2.message ?? '').slice(0, 90));
  chot(r2.status === 400 && !j2.ok, 'CHẶN khai ca CHỒNG GIỜ (' + r2.status + ')');
  const conNguyen = (await db.query('SELECT count(*)::int n FROM bank_ca_tien WHERE bank_id=$1 AND deleted_at IS NULL', [sf.bank_id])).rows[0].n;
  chot(conNguyen === 3, 'bị chặn thì 3 ca cũ CÒN NGUYÊN (' + conNguyen + ')');

  // ── (4) CHẶN giờ bắt đầu ≥ giờ kết thúc ──
  const r3 = await fetch(`${API}/v1/banks/${sf.bank_id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ caTien: [{ ten: 'X', tuPhut: 600, denPhut: 600 }] })
  });
  chot(r3.status === 400, 'CHẶN ca có giờ bắt đầu ≥ giờ kết thúc (' + r3.status + ')');

  // ── (5) GHI BILL THẬT ở từng khung giờ ⇒ phải rơi ĐÚNG ca ──
  // [20/11] KHÔNG neo ngày CỨNG trong bài kiểm: giá bán của TID có KỲ HIỆU LỰC, ngày cứng trôi vào quá khứ
  // là rơi ra ngoài kỳ ⇒ ghi bill trả 422 và cổng đỏ vì lý do chẳng liên quan tới thứ nó đang kiểm.
  const NGAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
  const mongDoi = [
    { gio: '08:00', ca: 'Ca sáng' },
    { gio: '13:00', ca: 'Ca chiều' },
    { gio: '20:00', ca: 'Ca tối' }
  ];
  let lech = 0;
  for (let i = 0; i < mongDoi.length; i++) {
    const m = mongDoi[i];
    const lo = 9300 + i;
    const g = await fetch(API + '/v1/bills/manual', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        tidString: sf.tid, cardTypeId: sf.card_type_id, amountBeforeFee: 2_000_000 + i,
        billKey: ['nat', String(sf.tid).toLowerCase(), String(lo), String(lo), NGAY].join('|'),
        bankReportedLoNumber: lo, txnDate: new Date(`${NGAY}T${m.gio}:00+07:00`).toISOString()
      })
    });
    const jg = await g.json();
    if (jg?.data?.loId) daTao.add(jg.data.loId);
    // Tính ca y hệt cách màn hình làm: tìm ca chứa phút-trong-ngày.
    const phut = Number(m.gio.slice(0, 2)) * 60 + Number(m.gio.slice(3, 5));
    const caTinh = trongSo.find((c) => phut >= Number(c.tu_phut) && phut <= Number(c.den_phut))?.ten ?? null;
    const khop = caTinh === m.ca;
    if (!khop) lech++;
    console.log(`      bill ${m.gio} → ca tính ra "${caTinh}" (mong đợi "${m.ca}") ${khop ? 'KHỚP' : '>>> LỆCH <<<'}`);
  }
  chot(lech === 0, 'bill ở 3 khung giờ rơi ĐÚNG 3 ca đã khai (' + lech + ' lệch)');

  // ── (6) ĐỐI CHỨNG: ngân hàng KHÔNG khai ca ⇒ không xếp ca ──
  await fetch(`${API}/v1/banks/${sf.bank_id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ caTien: [] }) });
  const sauXoa = (await db.query('SELECT count(*)::int n FROM bank_ca_tien WHERE bank_id=$1 AND deleted_at IS NULL', [sf.bank_id])).rows[0].n;
  const ds2 = await (await fetch(`${API}/v1/banks`, { headers: H })).json();
  const bank2 = (ds2.data ?? []).find((x) => x.id === sf.bank_id);
  console.log('      sau khi xoá hết ca — sổ còn:', sauXoa, '· API trả:', (bank2?.caTien ?? []).length);
  chot(sauXoa === 0 && (bank2?.caTien ?? []).length === 0, 'ĐỐI CHỨNG: xoá hết ca thì ngân hàng về trạng thái CHƯA KHAI (không xếp ca)');
} finally {
  for (const id of daTao) {
    const tx = (await db.query('SELECT transaction_id FROM los WHERE id=$1', [id])).rows[0]?.transaction_id;
    await db.query('DELETE FROM lo_rows WHERE lo_id=$1', [id]);
    await db.query('DELETE FROM los WHERE id=$1', [id]);
    if (tx) await db.query('DELETE FROM transactions WHERE id=$1', [tx]);
  }
  // trả ca về đúng như trước khi kiểm
  await db.query('DELETE FROM bank_ca_tien WHERE bank_id=$1', [sf.bank_id]);
  for (let i = 0; i < caCu.length; i++) {
    const c = caCu[i];
    await db.query('INSERT INTO bank_ca_tien (bank_id, ten, tu_phut, den_phut, thu_tu) VALUES ($1,$2,$3,$4,$5)',
      [sf.bank_id, c.ten, c.tu_phut, c.den_phut, i]);
  }
  console.log('      đã dọn', daTao.size, 'lô kiểm · trả ca về nguyên trạng (' + caCu.length + ' ca)');
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
}

console.log('\n[ca-tien] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[ca-tien] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[ca-tien] KHÔNG phép kiểm nào đỏ');
await db.end();
if (loi.length) process.exitCode = 1;
