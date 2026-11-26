// B259/B260 — [Admin Demo 23/11 "mở to view này ra, mỗi dòng 1 màu của máy tid như brand, thêm full
// trường lọc: Bank, tid, HKD, ngân hàng, NĐT... của cả 2 blog, mở rộng ra full view như thêm bill,
// đảm bảo kiểm chứng các trường lọc như brand của alpha, cấm láo" + "tăng chiều cao các button này
// lên 5px"]
//
// Cổng ĐO THẬT trên bản web đang chạy (không đọc mã rồi suy):
//   (1) hộp "Máy chạy / không chạy" mở ra RỘNG gần hết màn (≥ 92% bề ngang) như bảng thêm bill;
//   (2) có ĐỦ 5 ô lọc brand (Ngân hàng · TID · HKD · Đại lý cầm · NĐT) — là ô brand chọn-nhiều,
//       KHÔNG phải <select> xám;
//   (3) chọn 1 giá trị thì CẢ HAI bảng cùng lọc, mọi dòng còn lại đúng giá trị đó;
//   (4) "Xóa lọc" trả về đủ dòng;
//   (5) dải xen kẽ MẮT THẤY ĐƯỢC ở cả 2 bảng (đo chênh màu so nền trắng ≥ 8/255);
//   (6) ô KPI cao hơn bản cũ ĐÚNG 5px (ghi số đo ra log).
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const WEB = process.env.WEB_THU || 'http://127.0.0.1:57915';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[may-chay] DUNG: chi chay tren DB THU, dang tro "' + DB_TEN + '".');
  process.exit(3);
}
const O_LOC = [
  { khoa: 'may-bank', ten: 'Ngân hàng', cot: 'NH' },
  { khoa: 'may-tid', ten: 'TID', cot: 'TID' },
  { khoa: 'may-hkd', ten: 'HKD', cot: 'HKD' },
  { khoa: 'may-daily', ten: 'Đại lý cầm', cot: 'Đại lý cầm' },
  { khoa: 'may-ndt', ten: 'NĐT', cot: 'NĐT' }
];
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 4 + O_LOC.length + 2 + 3; // khung + 1/ô lọc + 2 dải màu + 3 phép XUẤT EXCEL 2 SHEET

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN = 'kiem-b259';
let b = null;
try {
  const ngay = (await db.query(
    "SELECT to_char(COALESCE(bill_txn_date, created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') d, count(*)::int n"
    + " FROM los WHERE status <> 'CANCELLED' GROUP BY 1 ORDER BY n DESC LIMIT 1")).rows[0];
  const tho = randomUUID();
  await db.query(
    'INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)'
    + " VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '10 minutes',now(),$2)",
    [createHash('sha256').update(tho).digest('hex'), NHAN]);
  b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1700, height: 950 }, acceptDownloads: true });
  await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
  const p = await ctx.newPage();
  await p.goto(WEB + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await gacHopThoai(p);
  await dongHopThoaiChe(p);
  const menu = p.locator("[data-kiem='nut-menu']");
  if (await menu.count()) { await menu.first().click(); await p.waitForTimeout(600); }
  const link = p.getByText('Doanh Số', { exact: false }).filter({ visible: true }).first();
  if (await link.count()) { await link.click({ timeout: 10000 }).catch(() => {}); }
  await p.waitForFunction(() => document.body.innerText.includes('Doanh số trước phí'), null, { timeout: 15000 });
  if (ngay) for (const o of await p.locator('input[type="date"]').all()) { await o.fill(ngay.d); await p.waitForTimeout(300); }
  await p.waitForTimeout(2500);

  // (6) CHIỀU CAO Ô KPI — đo trước khi mở hộp.
  const caoKpi = await p.evaluate(() => {
    const el = document.querySelector('[data-kiem="o-kpi"]');
    return el ? Math.round(el.getBoundingClientRect().height * 10) / 10 : 0;
  });
  // Bản cũ `py-0.5` (2px mỗi phía) đo được 35,3px. Yêu cầu +5px ⇒ `py-[4.5px]` (4,5px mỗi phía) = 40,3px.
  console.log('      chiều cao ô KPI =', caoKpi, 'px (bản cũ 35,3px → cần ~40,3px)');
  chot(Math.abs(caoKpi - 40.3) <= 0.7, 'ô KPI cao thêm ĐÚNG 5px (' + caoKpi + 'px, cũ 35,3px)');

  await p.getByRole('button', { name: /Máy không chạy/i }).first().click();
  await p.waitForTimeout(1500);
  const khung = await p.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((x) => /Máy chạy \/ không chạy/.test(x.textContent || '')
      && /max-w/.test(x.className || ''));
    const r = el?.getBoundingClientRect();
    return r ? { rong: Math.round(r.width), man: window.innerWidth } : null;
  });
  console.log('      bề ngang hộp:', khung ? khung.rong + '/' + khung.man + 'px' : '(không đo được)');
  chot(!!khung && khung.rong / khung.man >= 0.92,
    'hộp "Máy chạy / không chạy" mở RỘNG gần hết màn (' + (khung ? Math.round(khung.rong / khung.man * 100) : 0) + '% bề ngang)');

  const demBang = () => p.evaluate(() => {
    const bang = [...document.querySelectorAll('section table')];
    return bang.map((tb) => [...tb.querySelectorAll('tbody tr')].filter((r) => r.querySelectorAll('td').length > 1).length);
  });
  const banDau = await demBang();
  console.log('      2 bảng ban đầu:', banDau.join(' + '), 'dòng');
  chot(banDau.length === 2 && banDau[0] + banDau[1] > 0, 'có ĐỦ 2 bảng (không chạy · có chạy) với dữ liệu');

  const coDu = [];
  for (const x of O_LOC) if (await p.locator('[data-loc="' + x.khoa + '"]').count()) coDu.push(x.ten);
  console.log('      ô lọc brand thấy được:', coDu.join(' · '));
  chot(coDu.length === O_LOC.length, 'có ĐỦ ' + O_LOC.length + ' ô lọc brand cho cả 2 bảng');

  for (const x of O_LOC) {
    if (!(await p.locator('[data-loc="' + x.khoa + '"]').count())) { chot(false, 'thiếu ô lọc ' + x.ten); continue; }
    await p.locator('[data-loc="' + x.khoa + '"] button').first().click();
    await p.waitForTimeout(600);
    const muc = await p.evaluate((k) => {
      const pn = document.querySelector('[data-loc-hop="' + k + '"]');
      return pn ? [...pn.querySelectorAll('button')].map((y) => (y.textContent || '').trim())
        .filter((y) => y && !/Chọn tất cả|Bỏ chọn/.test(y)) : [];
    }, x.khoa);
    if (!muc.length) { chot(false, 'ô lọc "' + x.ten + '" xổ ra RỖNG'); continue; }
    const chon = muc[0];
    await p.evaluate(([k, ten]) => {
      const pn = document.querySelector('[data-loc-hop="' + k + '"]');
      [...(pn?.querySelectorAll('button') ?? [])].find((y) => (y.textContent || '').trim() === ten)?.click();
    }, [x.khoa, chon]);
    await p.waitForTimeout(900);
    // Đóng hộp xổ: KHÔNG dùng Escape (đóng luôn cả hộp thoại lớn — đo thật: bảng về 0 dòng), cũng
    // KHÔNG bấm lại nút (hộp xổ vẽ portal nằm ĐÈ lên nút ⇒ treo 30s). Bấm vào NHÃN "Lọc cả 2 bảng:"
    // — nằm trong hộp thoại, ngoài hộp xổ.
    await p.getByText('Lọc cả 2 bảng:').first().click({ timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(400);
    const lech = await p.evaluate((cot) => {
      const ra = [];
      for (const tb of document.querySelectorAll('section table')) {
        const th = [...tb.querySelectorAll('thead th')].map((y) => (y.textContent || '').trim());
        const ci = th.indexOf(cot);
        if (ci < 0) continue; // bảng kia không có cột này
        for (const r of tb.querySelectorAll('tbody tr')) {
          const td = r.querySelectorAll('td');
          // Dòng "trống" (colSpan) KHÔNG phải dữ liệu — đếm vào là đỏ oan ("Kỳ này chưa có máy nào…").
          if (td.length <= ci || td.length < th.length) continue;
          ra.push((td[ci].textContent || '').trim());
        }
      }
      return ra;
    }, x.cot);
    const sai = lech.filter((v) => v !== chon);
    if (sai.length) console.log('      ô KHÔNG khớp:', JSON.stringify(sai.slice(0, 3)));
    const sauLoc = await demBang();
    if (!sauLoc.length) { chot(false, 'hộp thoại bị ĐÓNG giữa chừng khi lọc "' + x.ten + '" — không kiểm tiếp được'); break; }
    console.log('      lọc ' + x.ten + ' = "' + chon + '" → 2 bảng còn ' + sauLoc.join(' + ')
      + ' dòng · ô cột "' + x.cot + '" sai: ' + sai.length);
    chot(sai.length === 0 && sauLoc[0] + sauLoc[1] > 0,
      'lọc "' + x.ten + '" ăn CẢ 2 BẢNG, mọi dòng đúng giá trị "' + chon + '"');
    await p.locator('[data-nut="may-xoaloc"]').first().click();
    await p.waitForTimeout(700);
  }
  const veNhu = await demBang();
  chot(JSON.stringify(veNhu) === JSON.stringify(banDau),
    '"Xóa lọc" trả về đủ dòng như ban đầu (' + veNhu.join(' + ') + ')');

  // (5) DẢI XEN KẼ phải THẤY ĐƯỢC — đo màu nền dòng chẵn/lẻ của từng bảng.
  const mau = await p.evaluate(() => {
    const doc = (tb) => {
      const r = [...tb.querySelectorAll('tbody tr')].filter((x) => x.querySelectorAll('td').length > 1).slice(0, 2);
      return r.map((x) => getComputedStyle(x).backgroundColor);
    };
    return [...document.querySelectorAll('section table')].map(doc);
  });
  const soHoa = (css) => (css.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  for (const [i, cap] of mau.entries()) {
    if (cap.length < 2) { chot(false, 'bảng ' + (i + 1) + ': không đủ 2 dòng để đo dải màu'); continue; }
    const a = soHoa(cap[0]), b2 = soHoa(cap[1]);
    const chenh = Math.max(...[0, 1, 2].map((k) => Math.abs((a[k] ?? 255) - (b2[k] ?? 255))));
    console.log('      bảng ' + (i + 1) + ': dòng 1 ' + cap[0] + ' · dòng 2 ' + cap[1] + ' → chênh ' + chenh + '/255');
    chot(chenh >= 8, 'bảng ' + (i + 1) + ': dải xen kẽ MẮT THẤY ĐƯỢC (chênh ' + chenh + '/255, cần ≥ 8)');
  }
  // ── XUẤT EXCEL: "Không chạy" 1 sheet · "Có chạy" 1 sheet, đúng brand nhà ──
  const [tai] = await Promise.all([
    p.waitForEvent('download', { timeout: 60000 }),
    // CÓ HAI nút cùng `data-nut="excel"`: một ở thanh Doanh Số (bị hộp thoại che), một trong hộp này.
    // Lấy nút NẰM TRONG hộp thoại, nếu không thì bấm trúng nút bị che → treo 30 giây.
    p.locator('.fixed.inset-0 [data-nut="excel"]').last().click()
  ]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(await tai.path());
  const ten = wb.worksheets.map((w) => w.name);
  console.log('      file xuất ra có sheet:', ten.join(' · '));
  chot(ten.length === 2 && /Không chạy/i.test(ten[0]) && /Có chạy/i.test(ten[1]),
    'file Excel có ĐÚNG 2 sheet riêng: "Không chạy" và "Có chạy"');
  const docCot = (w) => {
    for (let r = 1; r <= Math.min(8, w.rowCount); r++) {
      const v = w.getRow(r).values.map((x) => String(x ?? '').trim()).filter(Boolean);
      if (v.includes('TID')) return v;
    }
    return [];
  };
  const c1 = docCot(wb.worksheets[0]);
  const c2 = docCot(wb.worksheets[1]);
  console.log('      cột sheet 1:', c1.join(' · '), '| sheet 2:', c2.join(' · '));
  chot(c1[0] === 'HKD' && c1[1] === 'TID' && c2[0] === 'HKD' && c2[1] === 'TID',
    'thứ tự cột trong file GIỐNG trên màn (HKD → TID → NH → Đại lý cầm → NĐT)');
  const o = wb.worksheets[0].getCell('A1');
  chot(String(o.value ?? '').toUpperCase().includes('KHÔNG PHÁT SINH')
    && String(o.fill?.fgColor?.argb ?? '').toUpperCase() === 'FF1877D6',
    'sheet mang brand SigMa: tiêu đề nền xanh brand (' + (o.fill?.fgColor?.argb ?? 'không nền') + ')');

  mkdirSync(resolve(GOC, '_anh-kiem'), { recursive: true });
  await p.screenshot({ path: resolve(GOC, '_anh-kiem', 'b259-bang-may-chay.png') });
  console.log('      ảnh: _anh-kiem/b259-bang-may-chay.png');
} catch (e) {
  console.log('  ĐỎ  không chạy được phép kiểm: ' + e.message);
  so++; loi.push('không chạy được phép kiểm: ' + e.message);
} finally {
  await b?.close().catch(() => {});
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  await db.end();
}
console.log('\n[may-chay] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[may-chay] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[may-chay] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
