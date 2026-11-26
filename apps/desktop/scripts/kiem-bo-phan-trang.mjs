// KIỂM "BỎ PHÂN TRANG — CHỈ CUỘN" (Admin Demo 13/11: "không để 2 trang 3 trang mà chỉ để cuộn").
//
// Lái GIAO DIỆN THẬT trên BẢN SAO: web http://127.0.0.1:57914/ → quanly-api → DB `sigma_thu`.
// Khuôn phiên tạm + dọn phiên lấy từ `kiem-mot-thanh-cuon.mjs` (cùng thư mục).
//
// Mỗi màn kiểm (đếm ĐỘNG, không hard-code số phép kiểm):
//   1) KHÔNG còn nút "Sau →"           4) số <tr> dữ liệu == tổng bản ghi THẬT đếm từ DB
//   2) KHÔNG còn nút "← Trước"         5) hàng TỔNG ghim đáy vẫn nói đúng số lượng
//   3) KHÔNG còn chữ "Trang x/y"       6) ĐÚNG 1 ô cuộn dọc · 7) TRANG không tự cuộn
//   8) không pageerror · 9) không console.error · 10) chụp được ảnh
// Kèm ĐO THẬT thời gian dựng bảng (từ lúc bấm menu tới lúc đủ số dòng được vẽ xong 1 khung hình).
//
// Chạy:  node apps/desktop/scripts/kiem-bo-phan-trang.mjs
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/bo-phan-trang');
mkdirSync(RA, { recursive: true });

// ----- nối DB BẢN SAO (sigma_thu) -----
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/sigma_thu';
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

// ----- TỔNG BẢN GHI THẬT: đếm từ DB, KHÔNG lấy con số do chính giao diện khoe ra -----
const demDb = async (sql) => Number((await db.query(sql)).rows[0].count);
const MAN = [
  {
    menu: 'Quản Lý TID',
    tong: await demDb('select count(*) from tids where deleted_at is null'),
    nhanTong: /TỔNG\s+(\d+)\s+TID/
  },
  {
    menu: 'Quản Lý Máy POS',
    tong: await demDb('select count(*) from pos_devices where deleted_at is null'),
    nhanTong: /TỔNG\s+(\d+)\s+máy/
  }
];

// ----- phiên tạm (tự xoá cuối bài) -----
const NHAN = 'kiem-bo-phan-trang';
const tho = randomUUID();
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);

let soKiem = 0;
const loi = [];
const chot = (ok, ten) => {
  soKiem++;
  console.log((ok ? '  [ĐẠT] ' : '  [ĐỎ ] ') + ten);
  if (!ok) loi.push(ten);
};

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
const loiChay = [];
p.on('pageerror', (e) => loiChay.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') loiChay.push('console.error: ' + m.text().slice(0, 200)); });

await p.goto('http://127.0.0.1:57914/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);

for (const man of MAN) {
  console.log('\n===== ' + man.menu + ' (DB: ' + man.tong + ' bản ghi) =====');
  const truoc = loiChay.length;

  // mở menu trái nếu đang thu
  const nm = p.locator("[data-kiem='nut-menu']");
  if (await nm.count()) {
    const hien = await p.locator('aside').first().isVisible().catch(() => false);
    if (!hien) { await nm.first().click(); await p.waitForTimeout(700); }
  }
  const m = p.locator('aside button', { hasText: man.menu }).first();
  if (!(await m.count())) { chot(false, man.menu + ': KHÔNG vào được màn'); continue; }

  // ĐO THẬT: bấm menu → chờ bảng vẽ đủ số dòng → đo tới khung hình kế tiếp (đã paint xong).
  const t0 = Date.now();
  await m.click();
  let dungDuoc = true;
  try {
    await p.waitForFunction(
      (n) => {
        const k = [...document.querySelectorAll("[data-kiem='khung-bang']")];
        return k.some((x) => x.querySelectorAll('tbody tr:not([aria-hidden])').length >= n);
      },
      man.tong,
      { timeout: 30000 }
    );
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  } catch { dungDuoc = false; }
  const msDung = Date.now() - t0;
  console.log('  · ĐO: bấm menu → bảng vẽ xong ' + man.tong + ' dòng = ' + msDung + ' ms' + (dungDuoc ? '' : ' (QUÁ HẠN 30s)'));

  await p.waitForTimeout(600);
  await p.mouse.move(1500, 930);
  await p.waitForTimeout(300);

  const d = await p.evaluate(() => {
    const main = document.querySelector('main') ?? document.body;
    const chu = (main.innerText || '');
    // số dòng dữ liệu ở khung bảng có NHIỀU dòng nhất (bỏ hàng đệm aria-hidden)
    const khung = [...document.querySelectorAll("[data-kiem='khung-bang']")];
    const soDong = khung.map((x) => x.querySelectorAll('tbody tr:not([aria-hidden])').length);
    const tfoot = khung.map((x) => (x.querySelector('tfoot')?.innerText || '').replace(/\s+/g, ' ').trim());
    // ô cuộn dọc trong vùng nội dung
    const cuon = [];
    const duyet = (e) => {
      const c = getComputedStyle(e);
      if ((c.overflowY === 'auto' || c.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 2) {
        cuon.push({ dau: e.getAttribute('data-kiem') || e.tagName.toLowerCase(), du: e.scrollHeight - e.clientHeight });
      }
      for (const x of e.children) duyet(x);
    };
    duyet(main);
    const tv = document.documentElement;
    return {
      coSau: chu.includes('Sau →'),
      coTruoc: chu.includes('← Trước'),
      coTrangXY: /Trang\s*\d+\s*\/\s*\d+/.test(chu),
      soDong, tfoot, cuon,
      trangCuon: tv.scrollHeight > tv.clientHeight + 2,
      mainDu: main.scrollHeight - main.clientHeight
    };
  });

  const maxDong = Math.max(0, ...d.soDong);
  const iMax = d.soDong.indexOf(maxDong);
  const tf = iMax >= 0 ? d.tfoot[iMax] : '';
  console.log('  · dòng dữ liệu vẽ ra: ' + JSON.stringify(d.soDong) + ' · hàng TỔNG: "' + tf + '"');
  console.log('  · ô cuộn dọc: ' + JSON.stringify(d.cuon));

  chot(!d.coSau, man.menu + ': KHÔNG còn nút "Sau →"');
  chot(!d.coTruoc, man.menu + ': KHÔNG còn nút "← Trước"');
  chot(!d.coTrangXY, man.menu + ': KHÔNG còn chữ "Trang x/y"');
  chot(dungDuoc && maxDong === man.tong, man.menu + ': vẽ ĐỦ ' + man.tong + ' dòng (thấy ' + maxDong + ')');
  const soTf = man.nhanTong.exec(tf);
  chot(!!soTf && Number(soTf[1]) === man.tong, man.menu + ': hàng TỔNG nói đúng ' + man.tong + ' (thấy "' + tf + '")');
  chot(d.cuon.length === 1, man.menu + ': ĐÚNG 1 ô cuộn dọc (thấy ' + d.cuon.length + ')');
  chot(!d.trangCuon, man.menu + ': TRANG không tự cuộn (dư ' + d.mainDu + 'px)');
  const moi = loiChay.slice(truoc);
  chot(moi.length === 0, man.menu + ': không lỗi runtime (' + moi.length + ': ' + moi.join(' | ').slice(0, 300) + ')');

  const anh = resolve(RA, man.menu.replace(/[^A-Za-zÀ-ỹ0-9]+/g, '-').toLowerCase() + '.png');
  let chupOk = true;
  await p.screenshot({ path: anh, timeout: 20000 }).catch(() => { chupOk = false; });
  chot(chupOk, man.menu + ': chụp được ảnh → ' + anh);

  // cuộn xuống ĐÁY bảng rồi chụp thêm 1 ảnh (chứng minh dòng cuối tới được bằng CUỘN)
  // PHẢI cuộn ĐÚNG ô đang cuộn THẬT. Trước đây cứ cuộn `[data-kiem='khung-bang']` — ở màn POS ô cuộn
  // lại là <main> nên ảnh "đáy bảng" chụp ra y hệt ảnh đầu (bẫy: phép kiểm xanh mà ảnh vô nghĩa).
  const oCuon = await p.evaluate(() => {
    const main = document.querySelector('main') ?? document.body;
    const ds = [];
    const duyet = (e) => {
      const c = getComputedStyle(e);
      if ((c.overflowY === 'auto' || c.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 2) ds.push(e);
      for (const x of e.children) duyet(x);
    };
    duyet(main);
    if (main.scrollHeight > main.clientHeight + 2) ds.push(main);
    const k = ds.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
    if (!k) return 'KHÔNG có ô nào cuộn';
    k.scrollTop = k.scrollHeight;
    return (k.getAttribute('data-kiem') || k.tagName.toLowerCase()) + ' → scrollTop=' + Math.round(k.scrollTop);
  });
  console.log('  · cuộn xuống đáy ở ô: ' + oCuon);
  await p.waitForTimeout(700);
  const anhDay = resolve(RA, man.menu.replace(/[^A-Za-zÀ-ỹ0-9]+/g, '-').toLowerCase() + '-day.png');
  let chupDay = true;
  await p.screenshot({ path: anhDay, timeout: 20000 }).catch(() => { chupDay = false; });
  chot(chupDay, man.menu + ': chụp được ảnh ĐÁY bảng → ' + anhDay);
}

// ===== TAB "Yêu cầu xuất kho TID" (components/ExportRequestPanel.tsx) =====
// Panel này ăn theo bí danh `usePagination` nên cũng hết phân trang. ⚠️ BẢN SAO sigma_thu đang có
// 0 phiếu (`select count(*) from export_requests` = 0) ⇒ CHỈ kiểm được "không còn thanh phân trang +
// không lỗi runtime", KHÔNG kiểm được "vẽ đủ N dòng". Nói thẳng ra đây để không ai tưởng đã phủ.
{
  const ten = 'Yêu cầu xuất kho TID';
  console.log('\n===== Quản Lý TID → tab "' + ten + '" (DB: 0 phiếu — chỉ kiểm được một phần) =====');
  const truoc = loiChay.length;
  await p.locator('aside button', { hasText: 'Quản Lý TID' }).first().click();
  await p.waitForTimeout(1800);
  const tabBtn = p.locator('button', { hasText: ten }).first();
  if (!(await tabBtn.count())) chot(false, ten + ': KHÔNG thấy tab');
  else {
    await tabBtn.click();
    await p.waitForTimeout(2200);
    const d = await p.evaluate(() => {
      const chu = (document.querySelector('main') ?? document.body).innerText || '';
      return { coSau: chu.includes('Sau →'), coTrangXY: /Trang\s*\d+\s*\/\s*\d+/.test(chu) };
    });
    chot(!d.coSau && !d.coTrangXY, ten + ': KHÔNG còn thanh phân trang');
    chot(loiChay.slice(truoc).length === 0, ten + ': không lỗi runtime');
    let ok = true;
    const anh = resolve(RA, 'tab-yeu-cau-xuat-kho-tid.png');
    await p.screenshot({ path: anh, timeout: 20000 }).catch(() => { ok = false; });
    chot(ok, ten + ': chụp được ảnh → ' + anh);
  }
}

// ===== Quản Lý Doanh Thu & Công Nợ — NAY LÀ CUỘN TẢI DẦN (Admin Demo chốt 13/11: "cuộn tải dần") =====
// Lịch sử: sáng 13/11 đo thấy vẽ hết 3.276 dòng mất ~4,1 GIÂY nên TẠM giữ phân trang. Chiều Admin Demo chốt
// cuộn-tải-dần: lô đầu 300 dòng (mở màn ~560 ms), cuộn gần đáy thì nạp tiếp.
// ⇒ Phép kiểm ở đây KHÔNG còn khẳng định "giữ phân trang" nữa — để nguyên là cổng đỏ vĩnh viễn, và tệ hơn
//   là người sau đọc sẽ tưởng phân trang mới là yêu cầu đúng.
// Bài kiểm sâu cho cơ chế cuộn-tải-dần nằm riêng: scripts/kiem-cuon-tai-dan-doanh-thu.mjs (28 phép kiểm).
{
  const menu = 'Quản Lý Doanh Thu & Công Nợ';
  console.log('\n===== ' + menu + ' (CUỘN TẢI DẦN) =====');
  const truoc = loiChay.length;
  const m = p.locator('aside button', { hasText: menu }).first();
  if (!(await m.count())) chot(false, menu + ': KHÔNG vào được màn');
  else {
    await m.click();
    await p.waitForTimeout(4000);
    const d = await p.evaluate(() => {
      const main = document.querySelector('main') ?? document.body;
      const chu = main.innerText || '';
      const khung = [...document.querySelectorAll("[data-kiem='khung-bang']")];
      return {
        coSau: chu.includes('Sau →'),
        coTrangXY: /Trang\s*\d+\s*\/\s*\d+/.test(chu),
        soDong: khung.map((x) => x.querySelectorAll('tbody tr:not([aria-hidden])').length)
      };
    });
    const nhieuNhat = Math.max(0, ...d.soDong);
    console.log('  · dòng dữ liệu vẽ ra: ' + JSON.stringify(d.soDong));
    chot(!d.coSau && !d.coTrangXY, menu + ': KHÔNG còn thanh phân trang');
    chot(nhieuNhat > 50, menu + ': lô đầu vẽ NHIỀU HƠN 50 dòng (thấy ' + nhieuNhat + ') — không còn kẹp theo trang');
    chot(loiChay.slice(truoc).length === 0, menu + ': không lỗi runtime');
    let ok = true;
    const anh = resolve(RA, 'doanh-thu-cong-no-CUON-TAI-DAN.png');
    await p.screenshot({ path: anh, timeout: 20000 }).catch(() => { ok = false; });
    chot(ok, menu + ': chụp được ảnh → ' + anh);
  }
}

console.log('\n[bo-phan-trang] SỐ PHÉP KIỂM (đếm động) = ' + soKiem);
console.log('[bo-phan-trang] ảnh: ' + RA);
console.log(loi.length ? '[bo-phan-trang] KẾT LUẬN: ' + loi.length + ' ĐỎ\n  - ' + loi.join('\n  - ')
                       : '[bo-phan-trang] KẾT LUẬN: không phép kiểm nào đỏ');

await b.close();
// DỌN phiên tạm + ĐẾM LẠI xem còn sót không (R198: không nuốt lỗi dọn dẹp).
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
const sot = Number((await db.query('SELECT count(*) FROM login_sessions WHERE device_info=$1', [NHAN])).rows[0].count);
console.log('[bo-phan-trang] phiên tạm còn sót = ' + sot + (sot === 0 ? ' (đã dọn sạch)' : ' ← CÒN SÓT, phải xoá tay!'));
await db.end();
if (loi.length || sot !== 0) process.exitCode = 1;
