// B175 — [Admin Demo 16/11] "tên đại lý theo đúng TÊN ĐẶT chứ không phải HỌ TÊN ở danh sách bill nhập".
//
// Chuyện đã xảy ra: cột "Đại lý" của danh sách bill nhập in `customers.full_name` ("Đại lý F")
// trong khi cả hệ thống gọi khách đó bằng tên đặt `nickname` ("Mr Nguyễn SG") — khuôn nickname||full_name
// đã là luật ở tid-config.ts:277, chỉ route /v1/bills/manual còn lệch.
//
// Kiểm 2 tầng: (1) API thật — so TỪNG DÒNG với kỳ vọng tính ĐỘC LẬP bằng SQL riêng (không chép câu SQL của
// route); (2) MÀN THẬT — đọc chữ trên cột "Đại lý" neo theo TIÊU ĐỀ cột + chụp ảnh để LEAD tự nhìn (R200).
// Có ĐỐI CHỨNG ÂM: không một ô nào được phép là họ tên khai sinh của khách có tên đặt khác.
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/ten-dai-ly-ten-dat-16-11');
mkdirSync(RA, { recursive: true });
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const WEB = process.env.WEB_THU || 'http://127.0.0.1:57915';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 16; // chốt đủ số phép kiểm — script tự nuốt nhánh là lỗi đã gặp 16/11 (đếm ĐỘNG, R198)

// KỲ XEM chọn ĐỘNG: ngày có nhiều lô MƯỢN TID nhất (để nhánh "mượn" chắc chắn được kiểm), lấy 6 ngày.
const ngayMuon = (await db.query(
  `SELECT to_char(COALESCE(l.bill_txn_date, l.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') AS ngay,
          count(*) AS n
     FROM los l WHERE l.status <> 'CANCELLED' AND l.borrowed_by_customer_id IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 1`
)).rows[0];
chot(!!ngayMuon, 'DB thử CÓ lô mượn TID để kiểm được nhánh khách mượn (không có thì nhánh mượn là vô nghĩa)');
const TU = ngayMuon.ngay;
const DEN = new Date(Date.parse(TU + 'T00:00:00Z') + 5 * 86400000).toISOString().slice(0, 10);
console.log('      kỳ xem:', TU, '→', DEN, '· lô mượn trong ngày đầu:', ngayMuon.n);

// KỲ VỌNG tính ĐỘC LẬP: chủ máy c (theo TID của dòng đầu lô), hoặc khách mượn cm nếu lô có mượn.
const kv = await db.query(
  `SELECT l.id AS lo_id,
          CASE WHEN cm.id IS NOT NULL THEN COALESCE(NULLIF(TRIM(cm.nickname),''), cm.full_name)
               ELSE COALESCE(NULLIF(TRIM(c.nickname),''), c.full_name) END AS ten_dat,
          CASE WHEN cm.id IS NOT NULL THEN cm.full_name ELSE c.full_name END AS ho_ten,
          (cm.id IS NOT NULL) AS la_muon
     FROM los l
     JOIN LATERAL (SELECT r.tid_id FROM lo_rows r WHERE r.lo_id = l.id ORDER BY r.id LIMIT 1) r1 ON TRUE
     LEFT JOIN tids t       ON t.id = r1.tid_id
     LEFT JOIN customers c  ON c.id = t.customer_id
     LEFT JOIN customers cm ON cm.id = l.borrowed_by_customer_id
    WHERE l.status <> 'CANCELLED'
      AND COALESCE(l.bill_txn_date, l.created_at) >= ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
      AND COALESCE(l.bill_txn_date, l.created_at) <  (($2::date) + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`,
  [TU, DEN]
);
const mapKv = new Map(kv.rows.map((r) => [Number(r.lo_id), r]));
const soKhac = kv.rows.filter((r) => r.ten_dat && r.ho_ten && r.ten_dat !== r.ho_ten).length;
console.log('      lô trong kỳ:', kv.rows.length, '· lô mà TÊN ĐẶT khác HỌ TÊN:', soKhac);
chot(kv.rows.length > 0, 'kỳ xem CÓ lô để so (' + kv.rows.length + ')');
chot(soKhac > 0, 'kỳ xem CÓ lô mà tên đặt KHÁC họ tên — không có thì phép kiểm không phân biệt được gì (' + soKhac + ')');

// ---- TẦNG 1: API thật ----
const tho = randomUUID();
const NHAN = 'kiem-ten-dai-ly';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1' };
const r = await fetch(`${API}/v1/bills/manual?from=${TU}&to=${DEN}`, { headers: H });
const j = await r.json();
chot(r.status === 200 && j.ok, 'API /v1/bills/manual trả 200 ok (' + r.status + ')');
const ds = j.data ?? [];
chot(ds.length > 0, 'API trả về dòng bill (' + ds.length + ')');

let lech = 0, hoTenLot = 0, soDoiChieu = 0, muonDung = 0, muonCo = 0;
const viDuLech = [];
for (const b of ds) {
  const e = mapKv.get(Number(b.loId));
  if (!e || !e.ten_dat) continue;
  soDoiChieu++;
  if ((b.daiLy ?? '') !== e.ten_dat) {
    lech++;
    if (viDuLech.length < 3) viDuLech.push('lô ' + b.loId + ': API "' + b.daiLy + '" ≠ tên đặt "' + e.ten_dat + '"');
  }
  if (e.ten_dat !== e.ho_ten && (b.daiLy ?? '') === e.ho_ten) hoTenLot++;
  if (e.la_muon) { muonCo++; if ((b.daiLy ?? '') === e.ten_dat) muonDung++; }
}
console.log('      đối chiếu', soDoiChieu, 'dòng · lệch:', lech, '· lọt họ tên:', hoTenLot, '· lô mượn:', muonCo, '(đúng ' + muonDung + ')');
if (viDuLech.length) console.log('      ví dụ lệch: ' + viDuLech.join(' | '));
chot(soDoiChieu >= 10, 'đối chiếu được ít nhất 10 dòng (' + soDoiChieu + ')');
chot(lech === 0, 'MỌI dòng API trả TÊN ĐẶT đúng (' + lech + ' lệch)');
chot(hoTenLot === 0, 'ĐỐI CHỨNG ÂM: không dòng nào còn in HỌ TÊN khai sinh (' + hoTenLot + ')');
chot(muonCo > 0 && muonDung === muonCo, 'lô MƯỢN TID lấy tên đặt của KHÁCH MƯỢN, không phải chủ máy (' + muonDung + '/' + muonCo + ')');

// ---- TẦNG 2: màn thật + ảnh ----
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1920, height: 1040 } })).newPage();
const loiTrang = [];
p.on('pageerror', (e) => loiTrang.push('pageerror: ' + e.message));
await p.goto(WEB, { waitUntil: 'domcontentloaded' });
  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
await p.context().addCookies([{ name: 'ql_session', value: tho, url: WEB }]);
await p.goto(WEB, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
// Vào màn qua MENU BÊN (aside) — bẫy 16/11: `button:hasText('Doanh Số')` khớp luôn nút "KPI Doanh số"
// trong trang ⇒ mở hộp KPI che hết, nút "Thêm bill" không bấm được và script treo 30s rồi chết.
const nm = p.locator("[data-kiem='nut-menu']");
if (await nm.count()) {
  const hien = await p.locator('aside').first().isVisible().catch(() => false);
  if (!hien) { await nm.first().click(); await p.waitForTimeout(600); }
}
const menu = p.locator('aside button', { hasText: 'Doanh Số' }).first();
chot((await menu.count()) > 0, 'thấy mục menu "Doanh Số" ở thanh bên');
if (await menu.count()) { await menu.click(); await p.waitForTimeout(3500); }
const nutThem = p.locator('button', { hasText: 'Thêm bill' }).first();
chot((await nutThem.count()) > 0, 'vào được màn Doanh Số và thấy nút "Thêm bill"');
// KHÔNG mở hộp "Thêm Bill": bảng danh sách nằm NGAY trên màn, mở hộp chỉ che mất bảng (đo 16/11).
// Kỳ mặc định là HÔM NAY ⇒ DB thử 0 bill ⇒ bảng rỗng. Phải kéo kỳ về đúng kỳ vừa đối chiếu bằng API.
const oTu = p.locator('input[aria-label="Từ ngày"]').first();
const oDen = p.locator('input[aria-label="Đến ngày"]').first();
chot((await oTu.count()) > 0 && (await oDen.count()) > 0, 'thấy 2 ô kỳ xem Từ ngày / Đến ngày');
await oTu.fill(TU); await p.waitForTimeout(400);
await oDen.fill(DEN); await p.waitForTimeout(4000);
await p.screenshot({ path: resolve(RA, '01-danh-sach-bill.png'), fullPage: false });

// Đọc cột "Đại lý" NEO THEO TIÊU ĐỀ (bài học 16/11: selector chung chung bắt sai bảng).
const cot = await p.evaluate(() => {
  for (const tb of document.querySelectorAll('table')) {
    const th = [...tb.querySelectorAll('thead th')].map((x) => (x.textContent ?? '').trim());
    const i = th.findIndex((x) => x === 'Đại lý');
    if (i < 0) continue;
    const ra = [];
    for (const tr of tb.querySelectorAll('tbody tr')) {
      const td = tr.querySelectorAll('td');
      if (td.length !== th.length) continue; // bỏ dòng "không khớp"/colspan
      ra.push((td[i].textContent ?? '').trim());
    }
    if (ra.length) return { chiSo: i, soCot: th.length, o: ra };
  }
  return null;
});
chot(!!cot && cot.o.length > 0, 'đọc được cột "Đại lý" trên bảng danh sách bill (' + (cot?.o.length ?? 0) + ' dòng)');
if (cot) {
  const khach = (await db.query("SELECT nickname, full_name FROM customers WHERE deleted_at IS NULL AND nickname <> full_name")).rows;
  const hoTen = new Set(khach.map((x) => x.full_name.trim()));
  const tenDat = new Set(khach.map((x) => x.nickname.trim()));
  const oHoTen = cot.o.filter((x) => hoTen.has(x));
  const oTenDat = cot.o.filter((x) => tenDat.has(x));
  console.log('      [màn thật] ô là HỌ TÊN:', oHoTen.length, oHoTen.slice(0, 3).join(' · '),
    '· ô là TÊN ĐẶT:', oTenDat.length, oTenDat.slice(0, 3).join(' · '));
  chot(oHoTen.length === 0, 'màn thật: KHÔNG ô nào trong cột Đại lý là họ tên khai sinh (' + oHoTen.length + ')');
  chot(oTenDat.length > 0, 'màn thật: CÓ ô hiện tên đặt — không phải cột trắng trơn (' + oTenDat.length + ')');
}
chot(loiTrang.length === 0, 'không có lỗi trang (' + (loiTrang[0] ?? 'sạch') + ')');

console.log('\n[ten-dai-ly] ẢNH ở: ' + RA);
console.log('[ten-dai-ly] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) {
  loi.push('THIEU PHEP KIEM: chay ' + so + '/' + CAN + ' — co nhanh bi bo qua im lang (R198)');
  console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY');
}
console.log(loi.length ? '[ten-dai-ly] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[ten-dai-ly] KHÔNG phép kiểm nào đỏ');

await b.close();
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
await db.end();
if (loi.length) process.exitCode = 1;
