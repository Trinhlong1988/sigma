// AUDIT ĐỐI KHÁNG #4 — LỌC (tự cộng tay đối chiếu), BẢNG ở bề ngang hẹp, BIỂU ĐỒ, BÁO CÁO MÁY, mốc kỳ tự nhảy.
import { moHarness, shot } from './_audit-lib.mjs';

const { page, browser, server, errs } = await moHarness();
const ok = [];
const log = (...a) => console.log(...a);
const so = (t) => Number(String(t || '0').replace(/[^\d-]/g, '')) || 0;

/** Đọc TẤT CẢ dòng đang hiện + tự cộng tay 3 cột tiền. */
const docBang = () => page.evaluate(() => {
  const ths = [...document.querySelectorAll('thead th')];
  const hien = ths.map((t) => getComputedStyle(t).display !== 'none');
  const idx = (ten) => ths.findIndex((t) => (t.textContent || '').trim() === ten);
  const iTruoc = idx('Trước phí'), iSau = idx('Sau phí bán'), iHoan = idx('Đã hoàn');
  const rows = [...document.querySelectorAll('tbody tr:not([aria-hidden])')];
  const n = (s) => Number(String(s || '0').replace(/\./g, '').replace('—', '0').replace('đ', '')) || 0;
  const d = rows.map((r) => { const td = r.querySelectorAll('td'); return { truoc: n(td[iTruoc]?.textContent), sau: n(td[iSau]?.textContent), hoan: n(td[iHoan]?.textContent) }; });
  const tf = [...document.querySelectorAll('tfoot tr td')].map((c) => (c.textContent || '').trim());
  const kpi = [...document.querySelectorAll('.grid.grid-cols-5 > div, .flex.flex-wrap.gap-1\\.5 > div')].map((x) => (x.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => /Doanh số trước phí|Sau phí bán|Đã hoàn tiền|Chênh lệch/.test(t));
  return {
    soDong: rows.length,
    tuCong: { truoc: d.reduce((t, x) => t + x.truoc, 0), sau: d.reduce((t, x) => t + x.sau, 0), hoan: d.reduce((t, x) => t + x.hoan, 0) },
    hangTong: tf.filter(Boolean),
    kpi,
    soCotRender: hien.filter(Boolean).length, soThTongCong: ths.length,
    cotAn: ths.filter((t, i) => !hien[i]).map((t) => (t.textContent || '').trim())
  };
});

async function tichLoc(nhan, muc) {
  await page.getByRole('button', { name: new RegExp('^' + nhan) }).first().click();
  await page.waitForTimeout(300);
  for (const m of muc) { await page.getByRole('button', { name: m, exact: true }).first().click(); await page.waitForTimeout(180); }
  await page.mouse.click(5, 5); await page.waitForTimeout(400);
}

try {
  // ══ F. LỌC + TỰ CỘNG TAY ══
  log('\n===== F. LOC & TU CONG TAY DOI CHIEU =====');
  await page.getByRole('button', { name: 'Xóa lọc' }).click(); await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Tháng này' }).click(); await page.waitForTimeout(500);
  const b0 = await docBang();
  log('  [khong loc, ky Thang nay] so dong =', b0.soDong);
  log('    tu cong tay    : truoc=' + b0.tuCong.truoc.toLocaleString('vi-VN') + ' sau=' + b0.tuCong.sau.toLocaleString('vi-VN') + ' hoan=' + b0.tuCong.hoan.toLocaleString('vi-VN'));
  log('    hang TONG      :', JSON.stringify(b0.hangTong));
  log('    KPI            :', JSON.stringify(b0.kpi));
  const tongKhop = so(b0.hangTong[1]) === b0.tuCong.truoc && so(b0.hangTong[2]) === b0.tuCong.sau && so(b0.hangTong[3]) === b0.tuCong.hoan;
  log('    -> hang TONG khop tu cong tay?', tongKhop);
  ok.push(['F1 hang TONG = tu cong tay', tongKhop]);

  // 2 ô lọc GIAO NHAU
  await tichLoc('Tất cả đại lý', ['Đại lý A']);
  const bA = await docBang();
  await tichLoc('Tất cả loại thẻ', ['Visa']);
  const bAB = await docBang();
  log('  [loc dai ly=Truong SG] dong =', bA.soDong, ' truoc phi =', bA.tuCong.truoc.toLocaleString('vi-VN'));
  log('  [+ loai the=Visa]      dong =', bAB.soDong, ' truoc phi =', bAB.tuCong.truoc.toLocaleString('vi-VN'));
  const giao = bAB.soDong <= bA.soDong && so(bAB.hangTong[1]) === bAB.tuCong.truoc;
  log('    -> giao nhau thu hep dung + TONG khop?', giao);
  ok.push(['F2 giao nhau nhieu o loc', giao]);
  // mọi dòng đang hiện có đúng đại lý + thẻ?
  const dungTap = await page.evaluate(() => {
    const ths = [...document.querySelectorAll('thead th')];
    const iDL = ths.findIndex((t) => (t.textContent || '').trim() === 'Đại lý');
    const iLT = ths.findIndex((t) => (t.textContent || '').trim() === 'LT');
    return [...document.querySelectorAll('tbody tr:not([aria-hidden])')].every((r) => {
      const td = r.querySelectorAll('td');
      return (td[iDL]?.textContent || '').trim() === 'Đại lý A' && (td[iLT]?.textContent || '').trim() === 'Visa';
    });
  });
  log('    -> moi dong dang hien dung CA HAI dieu kien?', dungTap);
  ok.push(['F3 tap loc dung ca 2 dieu kien', dungTap === true]);
  await shot(page, 'F-loc-giao-nhau.png');

  // ══ H. BIỂU ĐỒ phải khớp tổng của tập đang lọc ══
  log('\n===== H. BIEU DO KPI khop tap dang loc =====');
  const bLoc = await docBang();
  await page.getByRole('button', { name: 'KPI Doanh số' }).click(); await page.waitForTimeout(700);
  const bd = await page.evaluate(() => {
    const svg = [...document.querySelectorAll('.fixed.inset-0 svg')].find((x) => (x.getAttribute('viewBox') || '').startsWith('0 0 1180'));
    if (!svg) return null;
    const cot = [...svg.querySelectorAll('rect[fill="#5b9bd5"]')];
    const vach = [...svg.querySelectorAll('text')].map((t) => t.textContent).filter((t) => /^[\d.]+$/.test(t || ''));
    return { soCot: cot.length, vachY: vach.slice(0, 6) };
  });
  log('  so cot =', bd?.soCot, ' vach truc Y =', JSON.stringify(bd?.vachY));
  // hover từng cột đọc tooltip → tự cộng
  let tongBd = 0; let tongBill = 0;
  for (let i = 0; i < (bd?.soCot ?? 0); i++) {
    const bb = await page.locator('.fixed.inset-0 svg[viewBox] rect[fill="#5b9bd5"]').nth(i).boundingBox();
    if (!bb) continue;
    await page.mouse.move(bb.x + bb.width / 2, bb.y + Math.max(2, bb.height / 2));
    await page.waitForTimeout(150);
    const t = await page.evaluate(() => {
      const d = [...document.querySelectorAll('.fixed.inset-0 div')].filter((x) => (x.textContent || '').includes('Số hóa đơn:')).pop();
      if (!d) return null;
      const m = /Doanh thu:\s*([\d.]+)/.exec(d.textContent || '');
      const b = /Số hóa đơn:\s*(\d+)/.exec(d.textContent || '');
      return { tien: m ? Number(m[1].replace(/\./g, '')) : null, bill: b ? Number(b[1]) : null };
    });
    if (t?.tien != null) { tongBd += t.tien; tongBill += t.bill ?? 0; }
  }
  log('  tu cong TOOLTIP moi cot: tien =', tongBd.toLocaleString('vi-VN'), ' so bill =', tongBill);
  log('  tong cua DANH SACH dang loc: tien =', bLoc.tuCong.truoc.toLocaleString('vi-VN'), ' so bill =', bLoc.soDong);
  log('  ->', tongBd === bLoc.tuCong.truoc && tongBill === bLoc.soDong ? 'KHOP' : '*** LECH ***');
  ok.push(['H1 bieu do khop tap dang loc', tongBd === bLoc.tuCong.truoc && tongBill === bLoc.soDong]);
  await shot(page, 'H-bieu-do.png');
  // "Xem toàn bộ kỳ" rồi đóng → bộ lọc kỳ bị đổi?
  await page.getByRole('button', { name: 'Xem toàn bộ kỳ' }).click(); await page.waitForTimeout(600);
  const kyRong = await page.evaluate(() => [...document.querySelectorAll('input[type=date]')].map((i) => i.value));
  log('  sau "Xem toan bo ky": o tu-den =', JSON.stringify(kyRong));
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);

  // ══ F4. MỐC KỲ TỰ NHẢY sau 60 giây ══
  log('\n===== F4. moc ky TU NHAY sau 60 giay (interval 60s) =====');
  log('  o tu-den NGAY BAY GIO =', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('input[type=date]')].map((i) => i.value))));
  log('  ... cho 65 giay (dang do xem bo loc co tu doi khong) ...');
  await page.waitForTimeout(65000);
  const kySau = await page.evaluate(() => [...document.querySelectorAll('input[type=date]')].map((i) => i.value));
  log('  o tu-den SAU 65 giay  =', JSON.stringify(kySau));
  const hn = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const tuNhay = JSON.stringify(kyRong) !== JSON.stringify(kySau);
  log('  ->', tuNhay ? '*** BO LOC KY TU DOI (' + JSON.stringify(kyRong) + ' -> ' + JSON.stringify(kySau) + '), hom nay = ' + hn + ' ***' : 'khong tu doi');
  ok.push(['F4 bo loc ky khong tu doi sau 60s', !tuNhay]);
  await shot(page, 'F4-ky-tu-nhay.png');

  // ══ I. BÁO CÁO MÁY ══
  log('\n===== I. BAO CAO MAY CHAY / KHONG CHAY =====');
  await page.getByRole('button', { name: 'Xóa lọc' }).click(); await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Tháng này' }).click(); await page.waitForTimeout(500);
  const bKy = await docBang();
  await page.getByRole('button', { name: 'Máy không chạy' }).click(); await page.waitForTimeout(700);
  const bc = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('section')];
    const kc = secs.find((x) => (x.textContent || '').includes('Không phát sinh giao dịch'));
    const cc = secs.find((x) => (x.textContent || '').includes('Có phát sinh'));
    const n = (s) => Number(String(s || '0').replace(/\./g, '')) || 0;
    const rowsCC = [...cc.querySelectorAll('tbody tr')].map((r) => { const td = r.querySelectorAll('td'); return { tid: (td[0]?.textContent || '').trim(), bill: n(td[2]?.textContent), tien: n(td[3]?.textContent) }; });
    return {
      khongChay: [...kc.querySelectorAll('tbody tr')].map((r) => (r.querySelectorAll('td')[0]?.textContent || '').trim()),
      coChay: rowsCC,
      tongChanBang: n([...cc.querySelectorAll('tfoot td')].pop()?.textContent)
    };
  });
  log('  may KHONG chay =', JSON.stringify(bc.khongChay));
  log('  may CO chay    =', JSON.stringify(bc.coChay));
  const sumCC = bc.coChay.reduce((t, x) => t + x.tien, 0);
  const sumBill = bc.coChay.reduce((t, x) => t + x.bill, 0);
  log('  tu cong "co chay": tien =', sumCC.toLocaleString('vi-VN'), ' bill =', sumBill, ' | hang TONG bao cao =', bc.tongChanBang.toLocaleString('vi-VN'));
  log('  tong DANH SACH cung ky  : tien =', bKy.tuCong.truoc.toLocaleString('vi-VN'), ' bill =', bKy.soDong);
  log('  ->', sumCC === bKy.tuCong.truoc && sumBill === bKy.soDong ? 'KHOP danh sach' : '*** LECH so danh sach ***');
  ok.push(['I1 bao cao may khop tong danh sach cung ky', sumCC === bKy.tuCong.truoc && sumBill === bKy.soDong]);
  const giamDan = bc.coChay.every((x, i, a) => i === 0 || a[i - 1].tien >= x.tien);
  log('  sap xep cao->thap dung?', giamDan);
  await page.getByRole('button', { name: /Doanh số:/ }).click(); await page.waitForTimeout(500);
  const bc2 = await page.evaluate(() => {
    const cc = [...document.querySelectorAll('section')].find((x) => (x.textContent || '').includes('Có phát sinh'));
    const n = (s) => Number(String(s || '0').replace(/\./g, '')) || 0;
    return [...cc.querySelectorAll('tbody tr')].map((r) => n(r.querySelectorAll('td')[3]?.textContent));
  });
  log('  sau khi doi chieu =', JSON.stringify(bc2));
  ok.push(['I2 sap xep 2 chieu dung', giamDan && bc2.every((x, i, a) => i === 0 || a[i - 1] <= x)]);
  await shot(page, 'I-bao-cao-may.png');
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);

  // ══ G. BẢNG Ở BỀ NGANG HẸP (cột Giờ bị ẩn <1280px) ══
  log('\n===== G. CAU TRUC COT + CANH HANG TONG o 1440 vs 1150 =====');
  for (const w of [1920, 1440, 1150]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(700);
    const g = await page.evaluate(() => {
      const ths = [...document.querySelectorAll('thead th')];
      const hien = ths.filter((t) => getComputedStyle(t).display !== 'none');
      const hang1 = [...document.querySelectorAll('tbody tr:not([aria-hidden])')][0];
      const tdHien = hang1 ? [...hang1.querySelectorAll('td')].filter((t) => getComputedStyle(t).display !== 'none') : [];
      const tf = [...document.querySelectorAll('tfoot tr td')];
      const colspanTong = tf.reduce((t, c) => t + (c.colSpan || 1), 0);
      const x = (el) => Math.round(el.getBoundingClientRect().right);
      // mỗi ô TỔNG có SỐ phải thẳng mép phải với ô dữ liệu cùng cột
      const oSo = tf.filter((c) => /\d/.test(c.textContent || '') && !(c.textContent || '').includes('TỔNG'));
      const canh = oSo.map((c) => {
        const r = x(c);
        const k = hien.findIndex((h, i) => Math.abs(x(tdHien[i] || h) - r) <= 2);
        return { so: (c.textContent || '').trim(), thangCot: k >= 0 ? (hien[k].textContent || '').trim() : 'KHONG THANG COT NAO' };
      });
      return {
        soThTongCong: ths.length, soCotRender: hien.length,
        cotAn: ths.filter((t) => getComputedStyle(t).display === 'none').map((t) => (t.textContent || '').trim()),
        colspanHangTong: colspanTong, soTdRender: tdHien.length, canh
      };
    });
    log('  [' + w + 'px] th tong cong=' + g.soThTongCong + ' · cot THAT SU render=' + g.soCotRender + ' · cot bi an=' + JSON.stringify(g.cotAn)
      + ' · tong colspan hang TONG=' + g.colspanHangTong);
    log('        canh hang TONG:', JSON.stringify(g.canh));
    const datCanh = g.canh.every((c) => c.thangCot !== 'KHONG THANG COT NAO') && g.colspanHangTong === g.soCotRender;
    log('        ->', datCanh ? 'THANG COT' : '*** LECH COT (colspan ' + g.colspanHangTong + ' != so cot render ' + g.soCotRender + ') ***');
    ok.push(['G ' + w + 'px hang TONG thang cot', datCanh]);
    await shot(page, 'G-cot-' + w + '.png');
  }
} catch (e) { console.error('[audit4] LOI:', e.message, '\n', (e.stack || '').split('\n').slice(1, 3).join('\n')); }
finally {
  console.log('\n===== KET QUA #4 =====');
  ok.forEach(([t, v]) => console.log((v ? '  DAT  ' : '  DO   ') + t));
  if (errs.length) { console.log('  page errors:'); errs.slice(0, 8).forEach((e) => console.log('    ', e)); }
  await browser.close(); await server.close(); process.exit(0);
}
