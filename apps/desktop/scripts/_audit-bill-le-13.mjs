// AUDIT #13 — SẬP BIỂU ĐỒ: đang rê chuột trên 1 cột rồi đổi mốc (ngày↔tháng) / đổi kỳ ⇒ `hover` trỏ ra
// ngoài mảng mới ⇒ duLieu[hover].nhan = undefined.nhan ⇒ TypeError, cây React của bảng nổi sập.
import { moHarness, shot } from './_audit-lib.mjs';

const { page, browser, server, errs } = await moHarness();
const log = (...a) => console.log(...a);
const ok = [];

const hover = (i) => page.evaluate((i) => {
  const s = [...document.querySelectorAll('svg')].find((x) => (x.getAttribute('viewBox') || '').startsWith('0 0 1180'));
  if (!s) return -1;
  const gs = [...s.querySelectorAll('g')].filter((x) => x.querySelector('rect'));
  if (!gs[i]) return -1;
  gs[i].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  return gs.length;
}, i);

try {
  log('\n===== SAP BIEU DO khi dang hover ma doi moc =====');
  await page.getByRole('button', { name: 'KPI Doanh số' }).click(); await page.waitForTimeout(900);
  await page.getByRole('button', { name: 'Xem toàn bộ kỳ' }).click(); await page.waitForTimeout(900);
  const n = await hover(0);
  log('  mo bieu do "Theo ngay": so cot =', n);
  // rê chuột lên cột CUỐI (index n-1), roi bam "Theo thang" (chi con 1 cot)
  await hover(n - 1); await page.waitForTimeout(250);
  const tipTruoc = await page.evaluate(() => {
    const d = [...document.querySelectorAll('div')].filter((x) => (x.textContent || '').includes('Doanh thu:') && (x.textContent || '').includes('Số hóa đơn:')).pop();
    return d ? (d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : null;
  });
  log('  dang hover cot cuoi (index', n - 1, '), tooltip =', JSON.stringify(tipTruoc));
  const truocLoi = errs.length;
  await page.getByRole('button', { name: 'Theo tháng' }).click();
  await page.waitForTimeout(900);
  const sauLoi = errs.slice(truocLoi);
  const conSong = await page.evaluate(() => {
    const s = [...document.querySelectorAll('svg')].find((x) => (x.getAttribute('viewBox') || '').startsWith('0 0 1180'));
    const nut = [...document.querySelectorAll('button')].filter((b) => /Theo ngày|Theo tháng|Xem toàn bộ kỳ/.test(b.textContent || '')).length;
    return { conSvg: !!s, soCot: s ? [...s.querySelectorAll('g')].filter((x) => x.querySelector('rect')).length : 0, soNutTrongBangNoi: nut, conBangNoi: !!document.querySelector('.fixed.inset-0') };
  });
  log('  SAU khi bam "Theo thang":', JSON.stringify(conSong));
  log('  loi moi phat sinh      :', JSON.stringify(sauLoi.slice(0, 2).map((x) => String(x).split('\n')[0])));
  const sap = sauLoi.some((e) => /reading 'nhan'|Cannot read properties of undefined/.test(String(e)));
  log('  ->', sap ? "*** SAP: TypeError duLieu[hover].nhan — bang noi bieu do bi pha ***" : 'khong sap');
  ok.push(['K1 doi moc khi dang hover khong lam sap bieu do', !sap]);
  await shot(page, 'K1-sap-bieu-do.png');

  // kịch bản 2: hover rồi bấm "Xem toàn bộ kỳ" (đổi dữ liệu dưới chân)
  await page.getByRole('button', { name: 'Theo ngày' }).click(); await page.waitForTimeout(700);
  const n2 = await hover(0);
  await hover(n2 - 1); await page.waitForTimeout(250);
  const truoc2 = errs.length;
  await page.getByRole('button', { name: 'Theo tháng' }).click(); await page.waitForTimeout(700);
  const sau2 = errs.slice(truoc2);
  log('  kich ban 2 (hover cot cuoi ->  Theo thang) loi =', JSON.stringify(sau2.slice(0, 1).map((x) => String(x).split('\n')[0])));
  await shot(page, 'K1-sap-bieu-do-2.png');
} catch (e) { console.error('[audit13] LOI:', e.message); }
finally {
  console.log('\n===== KET QUA #13 =====');
  ok.forEach(([t, v]) => console.log((v ? '  DAT  ' : '  DO   ') + t));
  console.log('  TONG SO page error ghi nhan =', errs.length);
  errs.slice(0, 3).forEach((e) => console.log('    ', String(e).split('\n')[0]));
  await browser.close(); await server.close(); process.exit(0);
}
