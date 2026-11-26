// ╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗
// ║ BÀI KIỂM — CUỘN TẢI DẦN ở màn "Quản Lý Doanh Thu & Công Nợ" (Admin Demo 13/11)                          ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝
//
// LÁI GIAO DIỆN THẬT bằng Playwright trên BẢN SAO:  web http://127.0.0.1:57914/  ·  API 8795  ·  DB sigma_thu.
// TUYỆT ĐỐI KHÔNG đụng sổ thật: có CỔNG NHẬN DẠNG DB ngay đầu bài, sai là DỪNG (exit 2).
// Bài này CHỈ ĐỌC — không bấm nút ghi nào.
//
// Kịch bản:
//   A  mở màn → ĐO thời gian tới khi LÔ ĐẦU vẽ xong (mục tiêu ≤ 1,5 s)
//   B  KHÔNG còn "Sau →" / "← Trước" / "Trang x/y"
//   C  DÒ Ô CUỘN THẬT lúc chạy + IN RA tên ô và scrollTop (không in = "ảnh đáy bảng" có thể là ảnh rỗng)
//   D  cuộn xuống đáy ≥ 3 lần — MỖI LẦN số <tr> dữ liệu phải TĂNG
//   E  cuộn tới hết → số dòng == tổng bản ghi THẬT đếm từ DB, và chân danh sách hiện "Đã hết"
//   F  đổi bộ lọc (chọn 1 TID) → danh sách RESET về lô đầu, đúng số dòng của bộ lọc mới
//   G  0 lỗi runtime (pageerror / console.error)
//   H  dọn phiên tạm + ĐẾM LẠI xem còn sót không (R198: cấm nuốt lỗi dọn dẹp)
//
// Chạy:  node apps/desktop/scripts/kiem-cuon-tai-dan-doanh-thu.mjs
// Biến:  WEB_THU (mặc định http://127.0.0.1:57914/)
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/cuon-tai-dan-doanh-thu');
mkdirSync(RA, { recursive: true });

const WEB = process.env.WEB_THU || 'http://127.0.0.1:57914/';
const NHAN = 'kiem-cuon-tai-dan-doanh-thu';
const TEN_DB_THU = 'sigma_thu';
const MENU = 'Quản Lý Doanh Thu & Công Nợ';
const SO_DONG_MOI_LO = 300;   // PHẢI khớp hằng cùng tên trong RevenuePage.tsx
const MUC_TIEU_MS = 1500;     // mục tiêu Admin Demo đặt cho LÔ ĐẦU

// ── Đếm ĐỘNG số phép kiểm (R198: cấm hard-code) ───────────────────────────────────────────────────────
let soKiem = 0;
const loi = [];
const chot = (ok, ten, chiTiet = '') => {
  soKiem++;
  console.log(`  [${String(soKiem).padStart(2, '0')}] ${ok ? 'ĐẠT ' : 'ĐỎ  '} — ${ten}${chiTiet ? '  → ' + chiTiet : ''}`);
  if (!ok) loi.push(ten + (chiTiet ? ' → ' + chiTiet : ''));
};
const dung = (ly) => { console.error('\n*** DỪNG BÀI (fail-closed): ' + ly + '\n'); process.exit(2); };

// ── Nối DB BẢN SAO ────────────────────────────────────────────────────────────────────────────────────
const envTxt = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const urlThat = /^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(envTxt)[1].replace(/^["']|["']$/g, '');
const u = new URL(urlThat);
const TEN_DB_THAT = u.pathname.replace(/^\//, '');
if (TEN_DB_THAT === TEN_DB_THU) dung('Tên DB thật TRÙNG tên bản sao — không phân biệt được, cấm chạy.');
u.pathname = '/' + TEN_DB_THU;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const dbDangNoi = (await db.query('select current_database() as d')).rows[0].d;
chot(dbDangNoi === TEN_DB_THU, 'CỔNG AN TOÀN: nối đúng BẢN SAO (không phải sổ thật)', `current_database()=${dbDangNoi}, sổ thật=${TEN_DB_THAT}`);
if (dbDangNoi !== TEN_DB_THU) dung('Nối nhầm DB.');

// ── TỔNG BẢN GHI THẬT: đếm từ DB, KHÔNG tin con số giao diện khoe ra ──────────────────────────────────
const dem = async (sql, p = []) => Number((await db.query(sql, p)).rows[0].count);
const TONG_GD = await dem('select count(*) from transactions where deleted_at is null');
const TONG_HUY = await dem("select count(*) from transactions where deleted_at is null and status='CANCELLED'");
// TID đem ra thử bộ lọc: chọn TID có nhiều GD nhất nhưng VẪN < 1 lô (để lọc xong là "Đã hết" ngay).
const tidThu = (await db.query(
  `select t.tid_id as id, d.tid, count(*)::int as c
     from transactions t join tids d on d.id = t.tid_id
    where t.deleted_at is null
    group by 1,2 having count(*) < $1 order by c desc limit 1`, [SO_DONG_MOI_LO]
)).rows[0];
if (!tidThu) dung('Không tìm được TID nào có < 1 lô giao dịch để thử bộ lọc.');
console.log(`\n[nền] BẢN SAO ${TEN_DB_THU}: ${TONG_GD} giao dịch còn sống (${TONG_HUY} đã hủy) · lô = ${SO_DONG_MOI_LO} dòng`);
console.log(`[nền] TID đem thử bộ lọc: id=${tidThu.id} tid=${tidThu.tid} → ${tidThu.c} giao dịch`);

// ── Phiên tạm ─────────────────────────────────────────────────────────────────────────────────────────
const tho = randomUUID();
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '30 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
const loiChay = [];
p.on('pageerror', (e) => loiChay.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') loiChay.push('console.error: ' + m.text().slice(0, 200)); });

// CHỨNG MINH "chống nạp chồng": ghi lại MỌI lượt gọi /v1/transactions (danh sách) kèm page/pageSize.
// Nếu khoá hỏng, một cú lăn chuột sẽ bắn vài lượt CÙNG page → thấy ngay ở đây.
const goiDs = [];
p.on('request', (r) => {
  const url = r.url();
  if (!/\/v1\/transactions(\?|$)/.test(url)) return; // bỏ /revenue-by-fee-type, /v1/transactions/<id>…
  const q = new URL(url).searchParams;
  goiDs.push({ lo: Number(q.get('page') || 1), cho: Number(q.get('pageSize') || 0), tid: q.get('tidId') || '' });
});

const anh = async (ten) => { const f = resolve(RA, ten + '.png'); await p.screenshot({ path: f, timeout: 20000 }); return f; };

/** Số <tr> DỮ LIỆU đang vẽ (dòng giao dịch mang data-kiem='dong-gd'). */
const soDong = () => p.evaluate(() => document.querySelectorAll("tr[data-kiem='dong-gd']").length);
/** Tổng số <tr> trong tbody bảng GD — in kèm để thấy cả dòng chân + hàng đệm, không giấu gì. */
const soTrTbody = () => p.evaluate(() => {
  const r = document.querySelector("tr[data-kiem='dong-gd']");
  return r ? r.closest('tbody').querySelectorAll('tr').length : 0;
});
/** Chữ ở CHÂN danh sách ("Đang tải thêm…" / "Đã hết …" / "Cuộn xuống…"). */
const chuChan = () => p.evaluate(() => (document.querySelector("tr[data-kiem='chan-cuon']")?.innerText || '').replace(/\s+/g, ' ').trim());
/** Chữ ở hàng TỔNG ghim đáy. */
const chuTong = () => p.evaluate(() => {
  const r = document.querySelector("tr[data-kiem='dong-gd']");
  return r ? (r.closest('table').querySelector('tfoot')?.innerText || '').replace(/\s+/g, ' ').trim() : '';
});

/**
 * DÒ Ô CUỘN THẬT rồi CUỘN XUỐNG ĐÁY. Trả tên ô + scrollTop + scrollHeight.
 * BẮT BUỘC in ra: bẫy đã dính thật — cuộn nhầm ô thì "ảnh đáy bảng" y hệt ảnh đầu mà phép kiểm vẫn xanh.
 */
const cuonDay = () => p.evaluate(() => {
  const main = document.querySelector('main') ?? document.body;
  const ds = [];
  const duyet = (e) => {
    const c = getComputedStyle(e);
    if ((c.overflowY === 'auto' || c.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 2) ds.push(e);
    for (const x of e.children) duyet(x);
  };
  duyet(main);
  if (main.scrollHeight > main.clientHeight + 2) ds.push(main);
  const tv = document.scrollingElement;
  if (tv && tv.scrollHeight > tv.clientHeight + 2) ds.push(tv);
  const k = ds.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
  if (!k) return { o: 'KHÔNG có ô nào cuộn', top: 0, cao: 0 };
  k.scrollTop = k.scrollHeight;
  const ten = k.getAttribute('data-kiem') || (k.tagName.toLowerCase() + (k.className ? '.' + String(k.className).split(/\s+/)[0] : ''));
  return { o: ten, top: Math.round(k.scrollTop), cao: k.scrollHeight, nhin: k.clientHeight };
});

/** Chờ số dòng VƯỢT `mốc` (hoặc hết giờ). Trả số dòng cuối cùng đọc được. */
const choTang = async (moc, ms = 15000) => {
  const het = Date.now() + ms;
  let n = await soDong();
  while (n <= moc && Date.now() < het) { await p.waitForTimeout(150); n = await soDong(); }
  return n;
};

let maChot = 0;
try {
  await p.goto(WEB, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2000);

  // ── A. Mở màn + ĐO thời gian LÔ ĐẦU ─────────────────────────────────────────────────────────────────
  console.log('\n===== A · mở màn + đo thời gian LÔ ĐẦU =====');
  const nutMenu = p.locator("[data-kiem='nut-menu']");
  if (await nutMenu.count()) {
    const hien = await p.locator('aside').first().isVisible().catch(() => false);
    if (!hien) { await nutMenu.first().click(); await p.waitForTimeout(700); }
  }
  const muc = p.locator('aside button', { hasText: MENU }).first();
  if (!(await muc.count())) dung('Không thấy mục menu "' + MENU + '".');

  const t0 = Date.now();
  await muc.click();
  let kipLo1 = true;
  try {
    // "vẽ xong lô đầu" = đủ SO_DONG_MOI_LO dòng ĐÃ PAINT (chờ thêm 2 khung hình).
    await p.waitForFunction((n) => document.querySelectorAll("tr[data-kiem='dong-gd']").length >= n, SO_DONG_MOI_LO, { timeout: 30000 });
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  } catch { kipLo1 = false; }
  const msLo1 = Date.now() - t0;
  const dong1 = await soDong();
  console.log(`  · ĐO: bấm menu → vẽ xong lô đầu (${dong1} dòng) = ${msLo1} ms${kipLo1 ? '' : ' (QUÁ HẠN 30s)'}`);
  console.log(`  · <tr> trong tbody (gồm dòng chân + hàng đệm) = ${await soTrTbody()}`);
  chot(kipLo1 && dong1 === SO_DONG_MOI_LO, `LÔ ĐẦU nạp đúng ${SO_DONG_MOI_LO} dòng`, `thấy ${dong1}`);
  chot(msLo1 <= MUC_TIEU_MS, `thời gian mở màn (lô đầu) ≤ ${MUC_TIEU_MS} ms`, `đo được ${msLo1} ms`);
  console.log('  · chân danh sách: "' + (await chuChan()) + '"');
  console.log('  · hàng TỔNG    : "' + (await chuTong()) + '"');
  chot(/đang xem\s*300\s*\/\s*3?\d*/i.test(await chuTong()) || (await chuTong()).includes('đang xem ' + dong1 + '/' + TONG_GD),
    'hàng TỔNG nói rõ "đang xem N / tổng M"', `"${await chuTong()}"`);
  console.log('  · ảnh: ' + (await anh('a-mo-man-lo-dau')));

  // ── B. Không còn thanh phân trang ──────────────────────────────────────────────────────────────────
  console.log('\n===== B · không còn nút chuyển trang =====');
  const dPhanTrang = await p.evaluate(() => {
    const chu = (document.querySelector('main') ?? document.body).innerText || '';
    return { sau: chu.includes('Sau →'), truoc: chu.includes('← Trước'), trangXY: /Trang\s*\d+\s*\/\s*\d+/.test(chu) };
  });
  chot(!dPhanTrang.sau, 'KHÔNG còn nút "Sau →"');
  chot(!dPhanTrang.truoc, 'KHÔNG còn nút "← Trước"');
  chot(!dPhanTrang.trangXY, 'KHÔNG còn chữ "Trang x/y"');

  // ── C + D. Cuộn xuống đáy ≥ 3 lần, mỗi lần số dòng PHẢI TĂNG ────────────────────────────────────────
  console.log('\n===== C+D · cuộn xuống đáy ≥ 3 lần, mỗi lần số dòng phải TĂNG =====');
  // D0 — chỉ báo "Đang tải thêm…" phải THẤY ĐƯỢC BẰNG MẮT, không chỉ tồn tại trong DOM 200 ms.
  //      Lô kế về sau ~300 ms nên chụp tay là ĐUA: ảnh chụp xong thì dữ liệu đã tới, bảng dài ra,
  //      chỗ đang nhìn trôi lên giữa bảng → ảnh VÔ NGHĨA (đã dính thật ở lần chạy đầu).
  //      ⇒ CHỦ ĐỘNG giữ phản hồi của máy chủ lại 1,5 s để trạng thái "đang tải" đứng yên mà chụp.
  //      CHỈ làm chậm ĐÚNG MỘT lượt; các lượt sau cho qua ngay (và nuốt lỗi "Route is already handled"
  //      của lượt còn treo lúc gỡ route — không để nó giết cả bài kiểm).
  let daCham = false;
  const giuCham = async (route) => {
    if (!daCham) { daCham = true; await new Promise((r) => setTimeout(r, 1500)); }
    await route.continue().catch(() => {});
  };
  await p.route(/\/v1\/transactions\?/, giuCham);
  const c0 = await cuonDay();
  await p.waitForTimeout(450);
  const chanTai = await chuChan();
  const anhTai = await anh('d0-dang-tai-them');
  console.log(`  · D0: cuộn ở ô [${c0.o}] scrollTop=${c0.top} · chân lúc đang nạp: "${chanTai}"`);
  console.log('  · ảnh "đang tải thêm": ' + anhTai);
  const thayDangTai = chanTai.includes('Đang tải thêm') ? chanTai : '';
  let truoc = await choTang(dong1);

  for (let i = 1; i <= 3; i++) {
    const c = await cuonDay();
    console.log(`  · lần ${i}: cuộn ở ô [${c.o}] · scrollTop=${c.top} · scrollHeight=${c.cao} · clientHeight=${c.nhin}`);
    chot(c.o !== 'KHÔNG có ô nào cuộn' && c.top > 0, `lần ${i}: CUỘN THẬT được (in rõ ô + scrollTop)`, `ô=${c.o}, scrollTop=${c.top}`);
    const sau = await choTang(truoc);
    console.log(`    dòng: ${truoc} → ${sau} · chân: "${await chuChan()}"`);
    chot(sau > truoc, `lần ${i}: số <tr> dữ liệu TĂNG sau khi cuộn`, `${truoc} → ${sau}`);
    truoc = sau;
  }
  chot(!!thayDangTai, 'chỉ báo "Đang tải thêm…" hiện ra VÀ GIỮ ĐỦ LÂU để chụp được ảnh', thayDangTai || 'không bắt được');
  await p.unroute(/\/v1\/transactions\?/, giuCham).catch(() => {});
  console.log('  · ảnh: ' + (await anh('d-sau-3-lan-cuon')));

  // ── E. Cuộn tới hết ────────────────────────────────────────────────────────────────────────────────
  console.log('\n===== E · cuộn tới hết =====');
  let vong = 0;
  let chan = await chuChan();
  while (!chan.includes('Đã hết') && vong < 40) {
    vong++;
    const c = await cuonDay();
    const sau = await choTang(truoc, 8000);
    if (sau === truoc && !(await chuChan()).includes('Đang tải thêm')) {
      // không tăng + không đang tải → hoặc đã hết, hoặc kẹt; đọc lại chân rồi thoát vòng
      chan = await chuChan();
      if (chan.includes('Đã hết')) break;
      if (vong > 3 && sau === truoc) { console.log(`    (kẹt ở ${sau} dòng, ô cuộn=${c.o}, scrollTop=${c.top})`); break; }
    }
    truoc = sau;
    chan = await chuChan();
  }
  const cuoi = await cuonDay();
  const dongCuoi = await soDong();
  chan = await chuChan();
  const tongChu = await chuTong();
  console.log(`  · sau ${vong} vòng cuộn: ${dongCuoi} dòng · ô cuộn [${cuoi.o}] scrollTop=${cuoi.top}/${cuoi.cao}`);
  console.log(`  · chân danh sách: "${chan}"`);
  console.log(`  · hàng TỔNG    : "${tongChu}"`);
  chot(dongCuoi === TONG_GD, `cuộn hết → số <tr> dữ liệu == tổng bản ghi THẬT trong DB (${TONG_GD})`, `thấy ${dongCuoi}`);
  chot(chan.includes('Đã hết'), 'chân danh sách hiện "Đã hết"', `"${chan}"`);
  chot(chan.includes(String(TONG_GD)), `chân danh sách nói đúng ${TONG_GD}`, `"${chan}"`);
  chot(tongChu.includes('đang xem ' + TONG_GD + '/' + TONG_GD), 'hàng TỔNG: "đang xem N/M" đã về N==M', `"${tongChu}"`);
  const mTong = /TỔNG\s+(\d+)\s+giao dịch/.exec(tongChu);
  chot(!!mTong && Number(mTong[1]) === TONG_GD - TONG_HUY,
    `hàng TỔNG đếm theo TOÀN BỘ bộ lọc (${TONG_GD - TONG_HUY} GD không tính bill đã hủy)`, `"${tongChu}"`);
  console.log('  · ảnh: ' + (await anh('e-cuon-toi-het')));

  // ── E2. CHỐNG NẠP CHỒNG + đúng trần máy chủ ────────────────────────────────────────────────────────
  console.log('\n===== E2 · chống nạp chồng (soi lượt gọi máy chủ) =====');
  const soLo = Math.ceil(TONG_GD / SO_DONG_MOI_LO);
  const demLo = new Map();
  for (const g of goiDs) demLo.set(g.lo, (demLo.get(g.lo) ?? 0) + 1);
  const trung = [...demLo.entries()].filter(([, n]) => n > 1).map(([lo, n]) => `lô ${lo} gọi ${n} lần`);
  console.log(`  · tổng lượt gọi /v1/transactions = ${goiDs.length} · lô đã xin = [${[...demLo.keys()].sort((a, b) => a - b).join(', ')}]`);
  chot(trung.length === 0, 'KHÔNG lô nào bị xin trùng (khoá chống nạp chồng chạy)', trung.join('; '));
  chot(demLo.size === soLo, `xin đúng ${soLo} lô để phủ ${TONG_GD} bản ghi`, `thấy ${demLo.size} lô`);
  const quaTran = goiDs.filter((g) => g.cho > 500);
  chot(quaTran.length === 0, 'mọi lượt gọi đều pageSize ≤ 500 (trần máy chủ)', `pageSize đang dùng = ${goiDs[0]?.cho}`);

  // ── F. Đổi bộ lọc → reset về lô đầu ────────────────────────────────────────────────────────────────
  console.log('\n===== F · đổi bộ lọc → danh sách RESET =====');
  const oTid = p.locator('select').filter({ has: p.locator('option', { hasText: 'Tất cả TID' }) }).first();
  chot(await oTid.count() > 0, 'thấy ô lọc TID');
  await oTid.selectOption(String(tidThu.id));
  await p.locator("button[data-nut='loc']").first().click();
  await p.waitForTimeout(2500);
  const dongLoc = await soDong();
  const chanLoc = await chuChan();
  const tongLoc = await chuTong();
  console.log(`  · sau khi lọc TID ${tidThu.tid}: ${dongLoc} dòng · chân "${chanLoc}"`);
  console.log(`  · hàng TỔNG: "${tongLoc}"`);
  chot(dongLoc === tidThu.c, `lọc 1 TID → đúng ${tidThu.c} dòng (DB đếm), KHÔNG giữ lại dòng cũ`, `thấy ${dongLoc}`);
  chot(chanLoc.includes('Đã hết'), 'lọc xong hiện "Đã hết" ngay (bộ lọc gọn hơn 1 lô)', `"${chanLoc}"`);
  console.log('  · ảnh: ' + (await anh('f-doi-bo-loc')));

  // Trả về "Tất cả TID" để màn không còn dính bộ lọc của bài kiểm (bài CHỈ ĐỌC, không ghi gì vào DB).
  await oTid.selectOption('');
  await p.locator("button[data-nut='loc']").first().click();
  await p.waitForTimeout(2500);
  const dongVe = await soDong();
  chot(dongVe === SO_DONG_MOI_LO, `bỏ lọc → quay lại LÔ ĐẦU ${SO_DONG_MOI_LO} dòng`, `thấy ${dongVe}`);

  // ── G. Không lỗi runtime ───────────────────────────────────────────────────────────────────────────
  console.log('\n===== G · lỗi runtime =====');
  chot(loiChay.length === 0, 'không có pageerror / console.error', loiChay.join(' | ').slice(0, 400));
} catch (e) {
  chot(false, 'BÀI KIỂM NÉM LỖI', e instanceof Error ? e.message : String(e));
  maChot = 1;
} finally {
  await b.close();
  // ── H. Dọn phiên tạm + ĐẾM LẠI ───────────────────────────────────────────────────────────────────
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  const sot = await dem('SELECT count(*) FROM login_sessions WHERE device_info=$1', [NHAN]);
  chot(sot === 0, 'dọn phiên tạm sạch (đếm lại sau khi xoá)', `còn sót ${sot}`);
  await db.end();
}

console.log('\n[cuon-tai-dan] SỐ PHÉP KIỂM (đếm ĐỘNG) = ' + soKiem);
console.log('[cuon-tai-dan] ảnh: ' + RA);
console.log(loi.length ? '[cuon-tai-dan] KẾT LUẬN: ' + loi.length + ' ĐỎ\n  - ' + loi.join('\n  - ')
                       : '[cuon-tai-dan] KẾT LUẬN: không phép kiểm nào đỏ');
if (loi.length || maChot) process.exitCode = 1;
