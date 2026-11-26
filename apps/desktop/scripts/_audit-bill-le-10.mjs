// AUDIT ĐỐI KHÁNG #10 — BIỂU ĐỒ: tự cộng tooltip từng cột, so với tổng danh sách đang lọc.
// (Chọn cột qua <g> chứa rect — KHÔNG qua fill, vì cột đang hover ĐỔI MÀU nên NodeList co lại.)
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

async function doBieuDo(nhan) {
  const b = await docBang();
  log('  [' + nhan + '] danh sach: ' + b.soDong + ' bill · ' + b.truoc.toLocaleString('vi-VN') + 'd');
  const n = await page.evaluate(() => {
    const s = [...document.querySelectorAll('svg')].find((x) => (x.getAttribute('viewBox') || '').startsWith('0 0 1180'));
    return s ? [...s.querySelectorAll('g')].filter((g) => g.querySelector('rect')).length : 0;
  });
  log('     so cot (g chua rect) =', n);
  const kq = [];
  for (let i = 0; i < n; i++) {
    await page.evaluate((i) => {
      const s = [...document.querySelectorAll('svg')].find((x) => (x.getAttribute('viewBox') || '').startsWith('0 0 1180'));
      const g = [...s.querySelectorAll('g')].filter((x) => x.querySelector('rect'))[i];
      g.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    }, i);
    await page.waitForTimeout(130);
    const t = await page.evaluate(() => {
      const d = [...document.querySelectorAll('div')].filter((x) => (x.textContent || '').includes('Số hóa đơn:')).pop();
      if (!d) return null;
      const txt = (d.textContent || '').replace(/\u00a0/g, ' ');
      const m = /Doanh thu:\s*([\d.]+)/.exec(txt); const bb = /Số hóa đơn:\s*(\d+)/.exec(txt);
      return { nhan: (d.querySelector('div')?.textContent || '').trim(), tien: m ? Number(m[1].replace(/\./g, '')) : null, bill: bb ? Number(bb[1]) : null };
    });
    kq.push(t);
    await page.evaluate((i) => {
      const s = [...document.querySelectorAll('svg')].find((x) => (x.getAttribute('viewBox') || '').startsWith('0 0 1180'));
      const g = [...s.querySelectorAll('g')].filter((x) => x.querySelector('rect'))[i];
      g.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    }, i);
    await page.waitForTimeout(60);
  }
  log('     tooltip:', JSON.stringify(kq.map((x) => (x ? x.nhan + '=' + x.tien + '/' + x.bill : null))));
  const tT = kq.reduce((a, x) => a + (x && x.tien ? x.tien : 0), 0);
  const tB = kq.reduce((a, x) => a + (x && x.bill ? x.bill : 0), 0);
  log('     tu cong tooltip: tien =', tT.toLocaleString('vi-VN'), ' bill =', tB);
  const dat = tT === b.truoc && tB === b.soDong;
  log('     ->', dat ? 'KHOP danh sach' : '*** LECH ' + (b.truoc - tT).toLocaleString('vi-VN') + 'd / ' + (b.soDong - tB) + ' bill ***');
  ok.push(['H ' + nhan + ' bieu do khop danh sach', dat]);
  return kq;
}

try {
  log('\n===== H. BIEU DO KPI =====');
  await page.getByRole('button', { name: 'Xóa lọc' }).click(); await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Tháng này' }).click(); await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'KPI Doanh số' }).click(); await page.waitForTimeout(900);
  await doBieuDo('thang nay / theo ngay');
  await shot(page, 'H10-ngay.png');
  await page.getByRole('button', { name: 'Theo tháng' }).click(); await page.waitForTimeout(600);
  await doBieuDo('thang nay / theo thang');
  await shot(page, 'H10-thang.png');
  // Xem toàn bộ kỳ (bỏ trống từ-đến) → biểu đồ theo tháng phải gồm CẢ thang 10
  await page.getByRole('button', { name: 'Xem toàn bộ kỳ' }).click(); await page.waitForTimeout(900);
  await doBieuDo('toan bo ky / theo thang');
  await shot(page, 'H10-toanbo-thang.png');
  await page.getByRole('button', { name: 'Theo ngày' }).click(); await page.waitForTimeout(700);
  await doBieuDo('toan bo ky / theo ngay');
  await shot(page, 'H10-toanbo-ngay.png');
  // kiểm tooltip cột ĐẦU và cột CUỐI có tràn khỏi khung không
  for (const i of [0, 'cuoi']) {
    const idx = await page.evaluate((i) => {
      const s = [...document.querySelectorAll('svg')].find((x) => (x.getAttribute('viewBox') || '').startsWith('0 0 1180'));
      const gs = [...s.querySelectorAll('g')].filter((x) => x.querySelector('rect'));
      const k = i === 'cuoi' ? gs.length - 1 : i;
      gs[k].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return k;
    }, i);
    await page.waitForTimeout(250);
    const tip = await page.evaluate(() => {
      const d = [...document.querySelectorAll('div')].filter((x) => (x.textContent || '').includes('Số hóa đơn:')).pop();
      if (!d) return null;
      const k = d.parentElement.getBoundingClientRect(); const b = d.getBoundingClientRect();
      return { tranTrai: Math.round(k.left - b.left), tranPhai: Math.round(b.right - k.right) };
    });
    log('  tooltip cot', idx, '=> tran trai', tip && tip.tranTrai, 'px · tran phai', tip && tip.tranPhai, 'px',
      tip && (tip.tranTrai > 0 || tip.tranPhai > 0) ? '*** KHACH HANG 48 ***' : '(trong khung)');
    ok.push(['H tooltip cot ' + idx + ' khong tran', !!tip && tip.tranTrai <= 0 && tip.tranPhai <= 0]);
  }
  await shot(page, 'H10-tooltip-bien.png');
} catch (e) { console.error('[audit10] LOI:', e.message, '\n', (e.stack || '').split('\n').slice(1, 3).join('\n')); }
finally {
  console.log('\n===== KET QUA #10 =====');
  ok.forEach(([t, v]) => console.log((v ? '  DAT  ' : '  DO   ') + t));
  if (errs.length) { console.log('  page errors:'); errs.slice(0, 8).forEach((e) => console.log('    ', e)); }
  await browser.close(); await server.close(); process.exit(0);
}
