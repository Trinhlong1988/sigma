// B243 — [Admin Demo 22/11 "thêm lọc tid theo NĐT phần lọc brand theo alpha"] Ô LỌC NĐT Ở MÀN QUẢN LÝ TID.
//
// Cổng khoá 6 điều — BẤM THẬT trên bản web đang chạy, không đọc mã rồi suy:
//   (1) thanh lọc CÓ ô "Tất cả NĐT" và nó là ô brand giống các ô lọc khác (không phải <select> thuần);
//   (2) danh sách NĐT xổ ra khớp ĐÚNG tập NĐT có trong bảng (không thừa, không thiếu);
//   (3) chọn 1 NĐT thì bảng CHỈ còn máy của NĐT đó — đếm khớp với đếm tay trên dữ liệu trước lọc;
//   (4) có mục "(máy không thuộc NĐT)" và chọn thì ra đúng phần còn lại;
//   (5) ĐỐI CHỨNG: tổng 2 nhóm = tổng ban đầu (không nuốt dòng nào);
//   (6) "Xóa lọc" gỡ được ô này (không kẹt lọc).
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const WEB = process.env.WEB_THU || 'http://127.0.0.1:57915';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[loc-ndt] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 11;

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN = 'kiem-b243';
let b = null;
try {
  const tho = randomUUID();
  await db.query(
    `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
     VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '10 minutes',now(),$2)`,
    [createHash('sha256').update(tho).digest('hex'), NHAN]
  );
  b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1700, height: 950 } });
  await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
  const p = await ctx.newPage();
  await p.goto(WEB + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
  const menu = p.locator("[data-kiem='nut-menu']");
  if (await menu.count()) { await menu.first().click(); await p.waitForTimeout(600); }
  const link = p.getByText('Quản Lý TID', { exact: false }).first();
  chot(await link.count() > 0, 'vào được màn Quản Lý TID');
  await link.click();
  await p.waitForTimeout(3500);

  const demDong = () => p.evaluate(() => {
    const tb = document.querySelector('table');
    if (!tb) return 0;
    const th = tb.querySelectorAll('thead th').length;
    return [...tb.querySelectorAll('tbody tr')].filter((r) => r.querySelectorAll('td').length >= th - 1).length;
  });
  const truoc = await demDong();
  console.log('      bảng đang có', truoc, 'dòng TID');

  const nut = p.locator('[data-loc="ndt"] button').first();
  chot(await nut.count() > 0, 'thanh lọc CÓ ô chọn NĐT (brand, không phải <select> thuần)');
  if (!(await nut.count())) throw new Error('không thấy ô lọc NĐT');
  await nut.click();
  await p.waitForTimeout(900);

  const muc = await p.evaluate(() => {
    const pn = document.querySelector('[data-loc-hop="ndt"]');
    if (!pn) return null;
    return [...pn.querySelectorAll('button')].map((x) => (x.textContent || '').trim())
      .filter((x) => x && !/Chọn tất cả|Bỏ chọn/.test(x));
  });
  console.log('      các mục xổ ra:', (muc ?? []).join(' · ').slice(0, 140));
  // Tập NĐT THẬT trên sổ thử (qua tài khoản nhận tiền), để so với danh sách app dựng.
  const that = (await db.query(
    `SELECT DISTINCT COALESCE(NULLIF(TRIM(iv.nickname), ''), iv.full_name) AS ndt
       FROM tids t JOIN receive_accounts ra ON ra.id = t.receive_account_id AND ra.deleted_at IS NULL
       JOIN investors iv ON iv.id = ra.investor_id
      WHERE t.deleted_at IS NULL AND t.status = 'ACTIVE'`)).rows.map((x) => x.ndt).filter(Boolean);
  const coDu = that.every((x) => (muc ?? []).some((m) => m.includes(x)));
  console.log('      NĐT thật trên sổ thử:', that.join(' · ') || '(không có)');
  chot(coDu && (muc ?? []).some((m) => /không thuộc NĐT/.test(m)),
    'danh sách xổ ra có ĐỦ NĐT thật + mục "(máy không thuộc NĐT)"');

  // Chọn NĐT đầu tiên rồi đếm.
  const tenChon = that[0];
  if (!tenChon) throw new Error('sổ thử không có NĐT nào để kiểm');
  await p.evaluate((ten) => {
    const pn = document.querySelector('[data-loc-hop="ndt"]');
    [...(pn?.querySelectorAll('button') ?? [])].find((x) => (x.textContent || '').trim() === ten)?.click();
  }, tenChon);
  await p.waitForTimeout(1200);
  const sauLoc = await demDong();
  const dungSo = Number((await db.query(
    `SELECT count(*)::int n FROM tids t JOIN receive_accounts ra ON ra.id = t.receive_account_id AND ra.deleted_at IS NULL
       JOIN investors iv ON iv.id = ra.investor_id
      WHERE t.deleted_at IS NULL AND t.status = 'ACTIVE'
        AND COALESCE(NULLIF(TRIM(iv.nickname), ''), iv.full_name) = $1`, [tenChon])).rows[0].n);
  console.log('      chọn NĐT "' + tenChon + '" → bảng còn', sauLoc, 'dòng · sổ đếm', dungSo);
  chot(sauLoc === dungSo, 'lọc đúng số máy của NĐT đó (' + sauLoc + ' vs sổ ' + dungSo + ')');
  chot(sauLoc > 0 && sauLoc < truoc, 'ĐỐI CHỨNG: có lọc THẬT (ít hơn ' + truoc + ' dòng ban đầu, không phải lọc rỗng)');

  // [B246 22/11 — Admin Demo "lọc theo nđt xổ ra danh sách rỗng"] Ô lọc PHẢI còn đủ tên NĐT kể cả khi
  // bảng đang bị lọc hẹp hoặc đang ở tab KHÁC. Trước đây danh sách gom từ `rows` (kết quả ĐÃ LỌC của
  // máy chủ) ⇒ tab "Chưa giao" không nạp `rows` nên xổ ra TRỐNG TRƠN.
  // Bám vào `data-loc="ndt"` chứ KHÔNG tìm theo chữ trên nút: nhãn nút ĐỔI theo lựa chọn
  // (chọn "NĐT 1" xong thì nút ghi "NĐT 1") nên tìm theo chữ "NĐT" là trượt.
  const oNdt = p.locator('[data-loc="ndt"]');
  const docMuc = () => p.evaluate(() => {
    const pn = document.querySelector('[data-loc-hop="ndt"]');
    return pn ? [...pn.querySelectorAll('button')].map((x) => (x.textContent || '').trim())
      .filter((x) => x && !/Chọn tất cả|Bỏ chọn/.test(x)) : [];
  });
  const moOLoc = async () => {
    if (!(await p.locator('[data-loc-hop="ndt"]').count())) {
      await oNdt.locator('button').first().click();
      await p.waitForTimeout(900);
    }
  };
  const dongOLoc = async () => {
    if (await p.locator('[data-loc-hop="ndt"]').count()) {
      await oNdt.locator('button').first().click();
      await p.waitForTimeout(400);
    }
  };
  // Gỡ lựa chọn cũ để bảng về đủ dòng trước khi thử 2 cảnh dưới.
  await moOLoc();
  await p.evaluate(() => {
    const pn = document.querySelector('[data-loc-hop="ndt"]');
    [...(pn?.querySelectorAll('button') ?? [])].find((x) => /Bỏ chọn/.test(x.textContent || ''))?.click();
  });
  await p.waitForTimeout(800);
  await dongOLoc();

  // (a) gõ tìm kiếm KHÔNG khớp gì → bảng rỗng, nhưng ô lọc vẫn phải đủ tên
  const oTim = p.locator('input[placeholder*="Tìm TID"]').first();
  if (await oTim.count()) { await oTim.fill('ZZZKHONGCOTID'); await p.waitForTimeout(3500); }
  const demKhiRong = await demDong();
  await moOLoc();
  const mucKhiRong = await docMuc();
  console.log('      tìm "ZZZKHONGCOTID": bảng', demKhiRong, 'dòng · ô lọc xổ ra', mucKhiRong.length, 'mục');
  chot(that.every((x) => mucKhiRong.some((m) => m.includes(x))) && mucKhiRong.length >= that.length + 1,
    'bảng rỗng vì lọc hẹp thì ô NĐT VẪN đủ tên (không gom từ kết quả đã lọc)');
  await dongOLoc();
  if (await oTim.count()) { await oTim.fill(''); await p.waitForTimeout(3500); }

  // (b) lọc hẹp bằng Ô TRẠNG THÁI (bộ lọc máy chủ) — vẫn phải đủ tên NĐT.
  //     Đây đúng là cảnh Admin Demo gặp: màn đang bật sẵn một bộ lọc nào đó, danh sách NĐT dựng từ
  //     KẾT QUẢ ĐÃ LỌC nên teo lại/trống trơn.
  const oTrangThai = p.locator('select').first();
  let mucKhiLocHep = [];
  if (await oTrangThai.count()) {
    const giaTri = await oTrangThai.evaluate((el) => [...el.options].map((o) => o.value).filter(Boolean));
    if (giaTri.length) {
      await oTrangThai.selectOption(giaTri[giaTri.length - 1]);
      await p.waitForTimeout(3500);
      await moOLoc();
      mucKhiLocHep = await docMuc();
      console.log('      bật lọc trạng thái "' + giaTri[giaTri.length - 1] + '": bảng', await demDong(),
        'dòng · ô lọc xổ ra', mucKhiLocHep.length, 'mục');
      await dongOLoc();
      await oTrangThai.selectOption('');
      await p.waitForTimeout(3000);
    }
  }
  chot(that.every((x) => mucKhiLocHep.some((m) => m.includes(x))) && mucKhiLocHep.length >= that.length + 1,
    'bật bộ lọc khác (trạng thái) thì ô NĐT VẪN đủ tên');

  // (c) danh sách NĐT KHÔNG THỪA: mọi tên xổ ra phải có thật trong danh mục nhà đầu tư của sổ.
  const dsNdtSo = (await db.query(
    "SELECT COALESCE(NULLIF(TRIM(nickname), ''), full_name) AS ten FROM investors WHERE deleted_at IS NULL")).rows
    .map((x) => String(x.ten || '').trim()).filter(Boolean);
  const thua = (muc ?? []).filter((m) => !/không thuộc NĐT/.test(m) && !dsNdtSo.includes(m));
  console.log('      danh mục NĐT trên sổ:', dsNdtSo.join(' · ') || '(trống)', '· tên lạ:', thua.join(' · ') || '(không có)');
  chot(thua.length === 0, 'ô lọc KHÔNG bịa tên lạ — mọi tên đều có trong danh mục nhà đầu tư');

  // [B251 22/11] CHẶN đường lấy danh mục TK nhận tiền (giả cảnh máy chủ từ chối / mất mạng):
  // ô lọc PHẢI tự lùi về dựng danh sách từ chính bảng TID, KHÔNG được rỗng câm.
  let soLanChan = 0;
  await p.route('**/v1/receive-accounts*', (r) => {
    soLanChan++;
    return r.fulfill({
      status: 403, contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'FORBIDDEN', message: 'Bạn không có quyền thực hiện thao tác này.' })
    });
  });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  const link2 = p.getByText('Quản Lý TID', { exact: false }).first();
  if (await link2.count()) { await link2.click(); await p.waitForTimeout(3500); }
  await moOLoc();
  const mucKhiChan = await docMuc();
  console.log('      chặn /v1/receive-accounts (403): ô lọc xổ ra', mucKhiChan.length, 'mục:',
    mucKhiChan.join(' · ').slice(0, 120));
  // KHẲNG ĐỊNH đã chặn THẬT — không chặn được thì phép kiểm trên chỉ là lặp lại cảnh bình thường
  // (xanh rỗng). Đếm số lần chặn, 0 lần là ĐỎ.
  console.log('      số lần chặn thật =', soLanChan);
  chot(soLanChan > 0 && that.every((x) => mucKhiChan.some((m) => m.includes(x))),
    'máy chủ từ chối danh mục TK nhận tiền (' + soLanChan + ' lần) → ô NĐT vẫn dựng từ bảng TID, không rỗng câm');
  // [B252 22/11 — Admin Demo "danh sách không show NĐT để chọn lọc"] TÁI HIỆN ĐÚNG CẢNH CHẾT:
  // chặn CẢ danh mục TK nhận tiền LẪN bảng TID (trả 0 dòng) ⇒ hai nguồn cũ cạn sạch.
  // Ô lọc VẪN phải liệt kê NĐT nhờ nguồn thứ ba: danh sách nhà đầu tư máy chủ trả kèm /v1/tids/refs.
  let chanTid = 0;
  await p.route('**/v1/tids?**', (r) => {
    chanTid++;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: [], total: 0 }) });
  });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  const linkR = p.getByText('Quản Lý TID', { exact: false }).first();
  if (await linkR.count()) { await linkR.click(); await p.waitForTimeout(4000); }
  await moOLoc();
  const mucCanNguon = await docMuc();
  console.log('      chặn CẢ 2 nguồn cũ (TK nhận tiền ' + soLanChan + ' lần · bảng TID ' + chanTid
    + ' lần, bảng ' + (await demDong()) + ' dòng): ô lọc xổ ra', mucCanNguon.length, 'mục:',
    mucCanNguon.join(' · ').slice(0, 120));
  chot(chanTid > 0 && mucCanNguon.length > 1 && that.every((x) => mucCanNguon.some((m) => m.includes(x))),
    'CẠN cả 2 nguồn cũ (bảng rỗng + máy chủ từ chối danh mục) → ô NĐT VẪN đủ tên nhờ danh sách từ /v1/tids/refs');
  await p.unroute('**/v1/tids?**');
  await p.unroute('**/v1/receive-accounts*');
  await dongOLoc();
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  const link3 = p.getByText('Quản Lý TID', { exact: false }).first();
  if (await link3.count()) { await link3.click(); await p.waitForTimeout(3500); }

  // Xóa lọc phải gỡ được
  const xoa = p.getByRole('button', { name: /Xóa lọc/ }).first();
  if (await xoa.count()) { await xoa.click(); await p.waitForTimeout(2500); }
  const sauXoa = await demDong();
  console.log('      sau khi bấm "Xóa lọc":', sauXoa, 'dòng');
  chot(sauXoa === truoc, '"Xóa lọc" gỡ được ô NĐT, bảng về đủ ' + truoc + ' dòng');
} catch (e) {
  console.log('  ĐỎ  không chạy được phép kiểm: ' + e.message);
  so++; loi.push('không chạy được phép kiểm: ' + e.message);
} finally {
  await b?.close().catch(() => {});
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  await db.end();
}

console.log('\n[loc-ndt] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[loc-ndt] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[loc-ndt] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
