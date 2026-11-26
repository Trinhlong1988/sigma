// AUDIT ĐỐI KHÁNG #6 — BIỂU ĐỒ khớp tập lọc, BÁO CÁO MÁY khớp danh sách, CẤU TRÚC CỘT ở 3 bề ngang,
// mốc kỳ TỰ NHẢY sau 60s, popup Xuất Excel.
import { moHarness, shot } from './_audit-lib.mjs';

const { page, browser, server, errs } = await moHarness();
const ok = [];
const log = (...a) => console.log(...a);

const docBang = () => page.evaluate(() => {
  const ths = [...document.querySelectorAll('thead th')];
  const idx = (t) => ths.findIndex((x) => (x.textContent || '').trim() === t);
  const iT = idx('Trước phí'), iS = idx('Sau phí bán'), iH = idx('Đã hoàn');
  const n = (s) => Number(String(s || '0').replace(/\./g, '').replace('—', '0')) || 0;
  const rows = [...document.querySelectorAll('tbody tr:not([aria-hidden])')];
  const d = rows.map((r) => { const td = r.querySelectorAll('td'); return { t: n(td[iT]?.textContent), s: n(td[iS]?.textContent), h: n(td[iH]?.textContent) }; });
  return { soDong: rows.length, truoc: d.reduce((a, x) => a + x.t, 0), sau: d.reduce((a, x) => a + x.s, 0), hoan: d.reduce((a, x) => a + x.h, 0) };
});

try {
  // ══ H. BIỂU ĐỒ ══
  log('\n===== H. BIEU DO KPI khop tap dang loc =====');
  await page.getByRole('button', { name: 'Xóa lọc' }).click(); await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Tháng này' }).click(); await page.waitForTimeout(600);
  const bLoc = await docBang();
  log('  danh sach dang loc: ' + bLoc.soDong + ' bill · truoc phi = ' + bLoc.truoc.toLocaleString('vi-VN'));
  await page.getByRole('button', { name: 'KPI Doanh số' }).click(); await page.waitForTimeout(800);
  const toaDo = await page.evaluate(() => {
    const svg = [...document.querySelectorAll('svg')].find((x) => (x.getAttribute('viewBox') || '').startsWith('0 0 1180'));
    if (!svg) return [];
    return [...svg.querySelectorAll('rect[fill="#5b9bd5"]')].map((r) => {
      const b = r.getBoundingClientRect();
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + Math.min(b.height - 2, 6)), w: Math.round(b.width), h: Math.round(b.height) };
    });
  });
  log('  so cot =', toaDo.length, ' (be rong moi cot =', toaDo[0]?.w + 'px)');
  let tTien = 0, tBill = 0; const chiTiet = [];
  for (const t of toaDo) {
    await page.mouse.move(t.x, t.y); await page.waitForTimeout(180);
    const v = await page.evaluate(() => {
      const d = [...document.querySelectorAll('div')].filter((x) => (x.textContent || '').includes('Số hóa đơn:') && x.children.length >= 2).pop();
      if (!d) return null;
      const m = /Doanh thu:\s*([\d.]+)/.exec(d.textContent || '');
      const b = /Số hóa đơn:\s*(\d+)/.exec(d.textContent || '');
      const nhan = d.querySelector('div')?.textContent?.trim();
      return { nhan, tien: m ? Number(m[1].replace(/\./g, '')) : null, bill: b ? Number(b[1]) : null };
    });
    if (v?.tien != null) { tTien += v.tien; tBill += v.bill ?? 0; chiTiet.push(v.nhan + '=' + v.tien.toLocaleString('vi-VN') + '/' + v.bill + 'bill'); }
    else chiTiet.push('(khong doc duoc tooltip)');
  }
  log('  tooltip tung cot:', JSON.stringify(chiTiet));
  log('  tu cong tooltip : tien =', tTien.toLocaleString('vi-VN'), ' bill =', tBill);
  log('  ->', tTien === bLoc.truoc && tBill === bLoc.soDong ? 'KHOP danh sach' : '*** LECH: danh sach ' + bLoc.truoc.toLocaleString('vi-VN') + '/' + bLoc.soDong + 'bill ***');
  ok.push(['H1 bieu do khop tap dang loc', tTien === bLoc.truoc && tBill === bLoc.soDong]);
  // tooltip cột ĐẦU có bị tràn ra ngoài khung không
  if (toaDo[0]) {
    await page.mouse.move(toaDo[0].x, toaDo[0].y); await page.waitForTimeout(250);
    const tip = await page.evaluate(() => {
      const d = [...document.querySelectorAll('div')].filter((x) => (x.textContent || '').includes('Số hóa đơn:') && x.children.length >= 2).pop();
      const k = d?.parentElement?.getBoundingClientRect();
      const b = d?.getBoundingClientRect();
      return b && k ? { tranTrai: Math.round(k.left - b.left), tranPhai: Math.round(b.right - k.right) } : null;
    });
    log('  tooltip cot DAU: tran trai =', tip?.tranTrai + 'px · tran phai =', tip?.tranPhai + 'px');
    ok.push(['H2 tooltip khong tran khung', (tip?.tranTrai ?? 0) <= 0 && (tip?.tranPhai ?? 0) <= 0]);
  }
  await shot(page, 'H-bieu-do.png');
  await page.getByRole('button', { name: 'Theo tháng' }).click(); await page.waitForTimeout(500);
  log('  doi "Theo thang" -> so cot =', await page.evaluate(() => { const s = [...document.querySelectorAll('svg')].find((x) => (x.getAttribute('viewBox') || '').startsWith('0 0 1180')); return s ? s.querySelectorAll('rect[fill="#5b9bd5"]').length : null; }));
  await shot(page, 'H-bieu-do-thang.png');
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);

  // ══ I. BÁO CÁO MÁY ══
  log('\n===== I. BAO CAO MAY CHAY / KHONG CHAY =====');
  const bKy = await docBang();
  await page.getByRole('button', { name: 'Máy không chạy' }).click(); await page.waitForTimeout(800);
  const doc = () => page.evaluate(() => {
    const secs = [...document.querySelectorAll('section')];
    const kc = secs.find((x) => (x.textContent || '').includes('Không phát sinh giao dịch'));
    const cc = secs.find((x) => (x.textContent || '').includes('Có phát sinh'));
    const n = (s) => Number(String(s || '0').replace(/\./g, '')) || 0;
    return {
      khongChay: [...kc.querySelectorAll('tbody tr')].map((r) => (r.querySelectorAll('td')[0]?.textContent || '').trim()),
      coChay: [...cc.querySelectorAll('tbody tr')].map((r) => { const td = r.querySelectorAll('td'); return { tid: (td[0]?.textContent || '').trim(), bill: n(td[2]?.textContent), tien: n(td[3]?.textContent) }; }),
      tongFoot: n([...cc.querySelectorAll('tfoot td')].pop()?.textContent)
    };
  });
  const bc = await doc();
  log('  may KHONG chay (' + bc.khongChay.length + ') =', JSON.stringify(bc.khongChay));
  log('  may CO chay    (' + bc.coChay.length + ') =', JSON.stringify(bc.coChay));
  const sT = bc.coChay.reduce((a, x) => a + x.tien, 0), sB = bc.coChay.reduce((a, x) => a + x.bill, 0);
  log('  tu cong "co chay": tien =', sT.toLocaleString('vi-VN'), ' bill =', sB, ' | hang TONG trong bao cao =', bc.tongFoot.toLocaleString('vi-VN'));
  log('  danh sach cung ky : tien =', bKy.truoc.toLocaleString('vi-VN'), ' bill =', bKy.soDong);
  log('  ->', sT === bKy.truoc && sB === bKy.soDong ? 'KHOP' : '*** LECH ' + (bKy.truoc - sT).toLocaleString('vi-VN') + 'd / ' + (bKy.soDong - sB) + ' bill ***');
  ok.push(['I1 bao cao may khop danh sach cung ky', sT === bKy.truoc && sB === bKy.soDong]);
  const giam = bc.coChay.every((x, i, a) => i === 0 || a[i - 1].tien >= x.tien);
  await page.getByRole('button', { name: /Doanh số:/ }).click(); await page.waitForTimeout(600);
  const bc2 = await doc();
  const tang = bc2.coChay.every((x, i, a) => i === 0 || a[i - 1].tien <= x.tien);
  log('  cao->thap dung =', giam, ' · sau khi doi chieu thap->cao dung =', tang);
  ok.push(['I2 sap xep 2 chieu dung', giam && tang]);
  // máy không chạy có TRÙNG máy có chạy không
  const trung = bc.khongChay.filter((t) => bc.coChay.some((x) => x.tid === t));
  log('  TID nam o CA HAI bang =', JSON.stringify(trung));
  ok.push(['I3 khong TID nao nam o ca 2 bang', trung.length === 0]);
  await shot(page, 'I-bao-cao-may.png');
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);

  // ══ Popup XUẤT EXCEL ══
  log('\n===== Xuat Excel: duong dan hien trong popup =====');
  await page.getByRole('button', { name: 'Xuất Excel' }).first().click(); await page.waitForTimeout(900);
  const ex = await page.evaluate(() => {
    const c = document.querySelector('code');
    const h = [...document.querySelectorAll('h3')].find((x) => (x.textContent || '').includes('Đã xuất Excel'));
    return { coPopup: !!h, duongDan: c ? c.textContent : null, maHoa: c ? [...c.textContent].map((ch) => ch.charCodeAt(0)).slice(0, 40).join(',') : null };
  });
  log('  popup =', ex.coPopup, ' duong dan =', JSON.stringify(ex.duongDan));
  const coTab = (ex.duongDan || '').includes('\t');
  log('  ->', coTab ? '*** DUONG DAN BI HONG: chua ky tu TAB, mat dau \\ (chuoi JS khong escape) ***' : 'duong dan binh thuong');
  ok.push(['X1 duong dan Excel hien dung', !coTab]);
  await shot(page, 'X-popup-excel.png');
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);

  // ══ G. CẤU TRÚC CỘT + CANH HÀNG TỔNG ở 3 bề ngang ══
  log('\n===== G. CAU TRUC COT + CANH HANG TONG =====');
  for (const w of [1920, 1440, 1150]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(800);
    const g = await page.evaluate(() => {
      const ths = [...document.querySelectorAll('thead th')];
      const hien = ths.filter((t) => getComputedStyle(t).display !== 'none');
      const r1 = [...document.querySelectorAll('tbody tr:not([aria-hidden])')][0];
      const tdHien = r1 ? [...r1.querySelectorAll('td')].filter((t) => getComputedStyle(t).display !== 'none') : [];
      const tf = [...document.querySelectorAll('tfoot tr td')];
      const x = (el) => Math.round(el.getBoundingClientRect().right);
      const oSo = tf.filter((c) => /\d/.test(c.textContent || '') && !(c.textContent || '').includes('TỔNG'));
      const canh = oSo.map((c) => {
        const r = x(c);
        const k = hien.findIndex((h, i) => Math.abs(x(tdHien[i] || h) - r) <= 2);
        return { so: (c.textContent || '').trim(), thangCot: k >= 0 ? (hien[k].textContent || '').trim() : 'KHONG THANG COT NAO' };
      });
      return {
        soTh: ths.length, soCotRender: hien.length,
        cotAn: ths.filter((t) => getComputedStyle(t).display === 'none').map((t) => (t.textContent || '').trim()),
        colspanTong: tf.reduce((t, c) => t + (c.colSpan || 1), 0), soTdRender: tdHien.length, canh
      };
    });
    log('  [' + w + 'px] th khai bao=' + g.soTh + ' · cot THAT SU render=' + g.soCotRender + ' · cot bi an=' + JSON.stringify(g.cotAn) + ' · tong colspan hang TONG=' + g.colspanTong);
    log('        canh hang TONG =', JSON.stringify(g.canh));
    const dat = g.canh.every((c) => c.thangCot !== 'KHONG THANG COT NAO') && g.colspanTong === g.soCotRender;
    log('        ->', dat ? 'THANG COT' : '*** LECH: colspan ' + g.colspanTong + ' != so cot render ' + g.soCotRender + ' ***');
    ok.push(['G ' + w + 'px hang TONG thang cot', dat]);
    await shot(page, 'G-cot-' + w + '.png');
  }
} catch (e) { console.error('[audit6] LOI:', e.message, '\n', (e.stack || '').split('\n').slice(1, 3).join('\n')); }
finally {
  console.log('\n===== KET QUA #6 =====');
  ok.forEach(([t, v]) => console.log((v ? '  DAT  ' : '  DO   ') + t));
  if (errs.length) { console.log('  page errors:'); errs.slice(0, 8).forEach((e) => console.log('    ', e)); }
  await browser.close(); await server.close(); process.exit(0);
}
