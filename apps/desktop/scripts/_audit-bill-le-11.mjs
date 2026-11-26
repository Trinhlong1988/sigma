// AUDIT #11 — BIỂU ĐỒ: đọc tooltip bằng cách lấy ĐÚNG hộp tooltip (div chứa CẢ "Doanh thu:" lẫn "Số hóa đơn:").
import { moHarness, shot } from './_audit-lib.mjs';

const { page, browser, server, errs } = await moHarness();
const ok = [];
const log = (...a) => console.log(...a);

const docBang = () => page.evaluate(() => {
  const ths = [...document.querySelectorAll('thead th')];
  const i = ths.findIndex((x) => (x.textContent || '').trim() === 'Trước phí');
  const n = (s) => Number(String(s || '0').replace(/\./g, '').replace('—', '0')) || 0;
  const rows = [...document.querySelectorAll('tbody tr:not([aria-hidden])')];
  return { soDong: rows.length, truoc: rows.reduce((a, r) => a + n(r.querySelectorAll('td')[i]?.textContent), 0) };
});

const barGs = (i, evt) => page.evaluate(([i, evt]) => {
  const s = [...document.querySelectorAll('svg')].find((x) => (x.getAttribute('viewBox') || '').startsWith('0 0 1180'));
  const gs = [...s.querySelectorAll('g')].filter((x) => x.querySelector('rect'));
  if (!gs[i]) return 0;
  gs[i].dispatchEvent(new MouseEvent(evt, { bubbles: true }));
  return gs.length;
}, [i, evt]);

const readTip = () => page.evaluate(() => {
  const all = [...document.querySelectorAll('div')];
  const d = all.filter((x) => { const t = x.textContent || ''; return t.includes('Doanh thu:') && t.includes('Số hóa đơn:'); }).pop();
  if (!d) return { raw: null };
  const txt = (d.textContent || '').replace(/\u00a0/g, ' ');
  const m = /Doanh thu:\s*([\d.]+)/.exec(txt);
  const b = /Số hóa đơn:\s*(\d+)/.exec(txt);
  return { raw: txt.slice(0, 70), nhan: (d.querySelector('div')?.textContent || '').trim(), tien: m ? Number(m[1].replace(/\./g, '')) : null, bill: b ? Number(b[1]) : null };
});

async function doBieuDo(nhan) {
  const bg = await docBang();
  const n = await barGs(0, 'mouseout');
  log('  [' + nhan + '] danh sach: ' + bg.soDong + ' bill · ' + bg.truoc.toLocaleString('vi-VN') + 'd · so cot = ' + n);
  const kq = [];
  for (let i = 0; i < n; i++) {
    await barGs(i, 'mouseover'); await page.waitForTimeout(130);
    kq.push(await readTip());
    await barGs(i, 'mouseout'); await page.waitForTimeout(50);
  }
  log('     raw tooltip cot 0 =', JSON.stringify(kq[0]?.raw));
  log('     tung cot:', JSON.stringify(kq.map((x) => x.nhan + '=' + x.tien + '/' + x.bill + 'bill')));
  const tT = kq.reduce((a, x) => a + (x.tien || 0), 0), tB = kq.reduce((a, x) => a + (x.bill || 0), 0);
  log('     TU CONG tooltip: tien =', tT.toLocaleString('vi-VN'), '· bill =', tB);
  const dat = tT === bg.truoc && tB === bg.soDong;
  log('     ->', dat ? 'KHOP danh sach' : '*** LECH ' + (bg.truoc - tT).toLocaleString('vi-VN') + 'd / ' + (bg.soDong - tB) + ' bill ***');
  ok.push(['H ' + nhan, dat]);
}

try {
  log('\n===== H. BIEU DO KPI (tu cong tooltip) =====');
  await page.getByRole('button', { name: 'Xóa lọc' }).click(); await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Tháng này' }).click(); await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'KPI Doanh số' }).click(); await page.waitForTimeout(900);
  await doBieuDo('thang nay/theo ngay');
  await shot(page, 'H11-ngay.png');
  await page.getByRole('button', { name: 'Theo tháng' }).click(); await page.waitForTimeout(600);
  await doBieuDo('thang nay/theo thang');
  await page.getByRole('button', { name: 'Xem toàn bộ kỳ' }).click(); await page.waitForTimeout(900);
  await doBieuDo('toan bo ky/theo thang');
  await page.getByRole('button', { name: 'Theo ngày' }).click(); await page.waitForTimeout(700);
  await doBieuDo('toan bo ky/theo ngay');
  await shot(page, 'H11-toanbo-ngay.png');
  // lọc 1 đại lý rồi so lại
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  await page.getByRole('button', { name: /^Tất cả đại lý/ }).first().click(); await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Mạnh', exact: true }).first().click(); await page.waitForTimeout(250);
  await page.mouse.click(5, 5); await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'KPI Doanh số' }).click(); await page.waitForTimeout(900);
  await doBieuDo('loc dai ly Manh/theo ngay');
  await shot(page, 'H11-loc-manh.png');
} catch (e) { console.error('[audit11] LOI:', e.message, '\n', (e.stack || '').split('\n').slice(1, 3).join('\n')); }
finally {
  console.log('\n===== KET QUA #11 =====');
  ok.forEach(([t, v]) => console.log((v ? '  DAT  ' : '  DO   ') + t));
  if (errs.length) { console.log('  page errors:'); errs.slice(0, 8).forEach((e) => console.log('    ', e)); }
  await browser.close(); await server.close(); process.exit(0);
}
