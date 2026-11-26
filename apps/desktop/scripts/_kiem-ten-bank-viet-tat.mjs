// [Admin Demo 16/11] "tất cả hiển thị viết tắt của bank ở tất cả các trường, không full tên".
//
// Kiểm bằng cách QUÉT THẬT nhiều màn trên bản web: tìm mọi chỗ còn in TÊN PHÁP NHÂN dài
// ("NH TMCP …", "NH TNHH …", "CTY TNHH …") — đáng lẽ chỉ còn ở ĐÚNG màn khai báo danh mục Ngân hàng.
// Không đoán theo code: đọc chữ hiện trên màn, chỉ ra đúng thẻ nào còn tên dài, kèm ảnh.
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/ten-bank-viet-tat-16-11');
mkdirSync(RA, { recursive: true });
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

// Danh sách tên dài LẤY TỪ SỔ, không gõ tay (sổ đổi tên là bài kiểm vẫn đúng).
const banks = (await db.query("SELECT code, name FROM banks WHERE deleted_at IS NULL AND name <> code")).rows;
const tenDai = banks.map((b) => b.name).filter((x) => (x ?? '').length > 12);
console.log('      tên dài đang có trong danh mục:', tenDai.length, '·', tenDai.slice(0, 3).join(' | '));
chot(tenDai.length > 0, 'danh mục có tên pháp nhân dài để mà kiểm (nếu 0 thì phép kiểm vô nghĩa)');

const NHAN = 'kiem-ten-bank';
const tho = randomUUID();
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
const loiTrang = [];
p.on('pageerror', (e) => loiTrang.push('pageerror: ' + e.message));
await p.goto(WEB + '/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);

  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
async function vaoMan(ten) {
  const nm = p.locator("[data-kiem='nut-menu']");
  if (await nm.count()) {
    const hien = await p.locator('aside').first().isVisible().catch(() => false);
    if (!hien) { await nm.first().click(); await p.waitForTimeout(600); }
  }
  const m = p.locator('aside button', { hasText: ten }).first();
  if (!(await m.count())) throw new Error('không thấy menu: ' + ten);
  await m.click();
  await p.waitForTimeout(3500);
}

/** Đếm số Ô/THẺ còn in nguyên tên dài — trả cả mẫu để biết sửa ở đâu, không chỉ con số. */
async function demTenDai(dsTen) {
  return p.evaluate((ten) => {
    const o = [];
    const el = document.querySelectorAll('td, th, option, label, span, div, input');
    for (const e of el) {
      if (e.children.length > 0 && e.tagName !== 'OPTION') continue; // chỉ lấy thẻ LÁ, tránh đếm trùng cha-con
      const chu = (e.tagName === 'INPUT' ? e.value : e.textContent) ?? '';
      for (const t of ten) if (chu.includes(t)) { o.push({ the: e.tagName, chu: chu.trim().slice(0, 70) }); break; }
    }
    return o;
  }, dsTen);
}

// KỲ XEM phải kéo về ngày CÓ BILL. Bẫy đo 16/11: kỳ mặc định là HÔM NAY ⇒ DB thử 0 bill ⇒ bảng rỗng ⇒
// script kết luận "màn Doanh Số không hiện mã viết tắt" trong khi thực tế mắt nhìn ảnh thấy MB/MBV/VP đầy đủ.
const ngayCoBill = (await db.query(
  `SELECT to_char(COALESCE(l.bill_txn_date, l.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') AS ngay,
          count(*) AS n
     FROM los l WHERE l.status <> 'CANCELLED' GROUP BY 1 ORDER BY 2 DESC LIMIT 1`
)).rows[0];
chot(!!ngayCoBill, 'DB thử có ngày nào đó CÓ bill để kéo kỳ xem về (nếu không, màn Doanh Số rỗng là vô nghĩa)');
console.log('      kỳ xem dùng cho màn Doanh Số:', ngayCoBill?.ngay);

/** Màn nào có 2 ô kỳ xem thì kéo về ngày có bill, rồi chờ bảng nạp lại. */
async function datKy() {
  const oTu = p.locator('input[aria-label="Từ ngày"]').first();
  const oDen = p.locator('input[aria-label="Đến ngày"]').first();
  if (!(await oTu.count()) || !(await oDen.count()) || !ngayCoBill) return false;
  await oTu.fill(ngayCoBill.ngay); await p.waitForTimeout(400);
  await oDen.fill(ngayCoBill.ngay); await p.waitForTimeout(4000);
  return true;
}

const MAN = [
  ['Quản Lý TID', '01-tid'],
  ['Quản Lý Máy POS', '02-pos'],
  ['Doanh Số', '03-doanh-so'],
  ['Quản Lý Ngân Hàng - Đối Tác', '04-ngan-hang']
];
for (const [ten, anh] of MAN) {
  await vaoMan(ten);
  if (ten === 'Doanh Số') chot(await datKy(), 'màn Doanh Số: kéo được kỳ xem về ngày có bill (bảng mới có chữ để soi)');
  await p.screenshot({ path: resolve(RA, anh + '.png'), fullPage: false });
  const con = await demTenDai(tenDai);
  const maThay = await p.evaluate((ma) => {
    const chu = document.body.innerText;
    return ma.filter((m) => new RegExp('(^|[^A-Za-z0-9])' + m + '([^A-Za-z0-9]|$)').test(chu));
  }, banks.map((x) => x.code));
  console.log('      [' + ten + '] ô còn tên dài:', con.length, con.slice(0, 3).map((x) => x.the + ':' + x.chu).join(' · '),
    '· mã viết tắt thấy:', maThay.slice(0, 6).join(',') || '(không)');
  if (ten !== 'Quản Lý Ngân Hàng - Đối Tác') chot(maThay.length > 0, 'màn "' + ten + '" CÓ hiện mã viết tắt (' + (maThay.join(',') || 'KHÔNG CÓ') + ')');
  if (ten === 'Quản Lý Ngân Hàng - Đối Tác') {
    // Màn KHAI BÁO danh mục thì PHẢI còn tên đầy đủ — đây là đối chứng dương, nếu mất tên ở đây là sửa quá tay.
    chot(con.length > 0, 'ĐỐI CHỨNG: màn khai báo Ngân hàng VẪN giữ tên pháp nhân đầy đủ (' + con.length + ' ô)');
  } else {
    chot(con.length === 0, 'màn "' + ten + '" KHÔNG còn ô nào in tên pháp nhân dài (' + con.length + ')');
  }
}

// Màn Thêm bill: mở ra rồi soi cả danh sách bill lẫn thẻ ngân hàng trên đầu.
await vaoMan('Doanh Số');
await datKy();
const nutThem = p.locator('button', { hasText: 'Thêm bill' }).first();
if (await nutThem.count()) { await nutThem.click(); await p.waitForTimeout(2500); }
await p.screenshot({ path: resolve(RA, '05-them-bill.png') });
const conBill = await demTenDai(tenDai);
console.log('      [Thêm bill] ô còn tên dài:', conBill.length, conBill.slice(0, 3).map((x) => x.the + ':' + x.chu).join(' · '));
chot(conBill.length === 0, 'màn Thêm bill KHÔNG còn ô nào in tên pháp nhân dài (' + conBill.length + ')');

// Mã viết tắt PHẢI thật sự xuất hiện (nếu trắng trơn thì cũng là hỏng, không phải "đã ngắn gọn").
const maThemBill = await p.evaluate((ma) => {
  const chu = document.body.innerText;
  return ma.filter((m) => new RegExp('(^|[^A-Za-z0-9])' + m + '([^A-Za-z0-9]|$)').test(chu));
}, banks.map((x) => x.code));
console.log('      [Thêm bill] mã viết tắt thấy:', maThemBill.slice(0, 6).join(',') || '(không)');
chot(maThemBill.length > 0, 'màn Thêm bill CÓ hiện mã viết tắt (' + (maThemBill.join(',') || 'KHÔNG CÓ') + ')');

chot(loiTrang.length === 0, 'không có lỗi trang (' + (loiTrang[0] ?? 'sạch') + ')');

console.log('\n[ten-bank] ẢNH ở: ' + RA);
console.log('[ten-bank] SO PHEP KIEM (dem dong) = ' + so);
if (so < 13) { loi.push('THIEU PHEP KIEM: chay ' + so + '/13 — co nhanh bi bo qua im lang (R198)'); console.log('  ĐỎ  đủ 13 phép kiểm phải CHẠY'); }
console.log(loi.length ? '[ten-bank] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[ten-bank] KHÔNG phép kiểm nào đỏ');

await b.close();
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
await db.end();
if (loi.length) process.exitCode = 1;
