// AUDIT ĐỐI KHÁNG #8 — BIỂU ĐỒ (hover bằng event thật), hàng TỔNG ở 1150 trông thế nào, ô trống colSpan,
// dán CHỮ vào ô tiền, 0 dẫn đầu ô tiền, hoàn vượt, rò gioLoi, chồng lấn khi cuộn ở 1150.
import { moHarness, shot, nutGhi } from './_audit-lib.mjs';

const { page, browser, server, errs } = await moHarness();
const ok = [];
const log = (...a) => console.log(...a);
const M = '.fixed.inset-0';
const oTien = (i) => page.locator(M + ' input[placeholder="0"]').nth(i);

const docBang = () => page.evaluate(() => {
  const ths = [...document.querySelectorAll('thead th')];
  const idx = (t) => ths.findIndex((x) => (x.textContent || '').trim() === t);
  const n = (s) => Number(String(s || '0').replace(/\./g, '').replace('—', '0')) || 0;
  const iT = idx('Trước phí');
  const rows = [...document.querySelectorAll('tbody tr:not([aria-hidden])')];
  return { soDong: rows.length, truoc: rows.reduce((a, r) => a + n(r.querySelectorAll('td')[iT]?.textContent), 0) };
});

try {
  // (phan H chuyen sang _audit-bill-le-11.mjs)
  // ══ G2. ảnh hàng TỔNG ở 1150 + hàng rỗng colSpan ══
  log('\n===== G2. hang TONG @1150 + hang "khong co bill" =====');
  await page.setViewportSize({ width: 1150, height: 820 }); await page.waitForTimeout(800);
  const g2 = await page.evaluate(() => {
    const ths = [...document.querySelectorAll('thead th')].filter((t) => getComputedStyle(t).display !== 'none');
    const tf = [...document.querySelectorAll('tfoot tr td')];
    const x = (el) => Math.round(el.getBoundingClientRect().left) + '-' + Math.round(el.getBoundingClientRect().right);
    return { cot: ths.map((t) => (t.textContent || '').trim() + '[' + x(t) + ']'), oTong: tf.map((c) => ((c.textContent || '').trim() || '(trong)') + '[' + x(c) + ']') };
  });
  log('  cot render @1150 :', JSON.stringify(g2.cot));
  log('  o hang TONG      :', JSON.stringify(g2.oTong));
  await shot(page, 'G2-tong-lech-1150.png');
  // chồng lấn khi cuộn ở 1150
  await page.evaluate(() => { const k = document.querySelector('[data-kiem="khung-bang"]'); k.scrollTop = k.scrollHeight; });
  await page.waitForTimeout(500);
  const chong = await page.evaluate(() => {
    const k = document.querySelector('[data-kiem="khung-bang"]');
    const th = k.querySelector('thead').getBoundingClientRect();
    const tf = k.querySelector('tfoot tr').getBoundingClientRect();
    const rows = [...k.querySelectorAll('tbody tr:not([aria-hidden])')];
    const hien = rows.filter((r) => { const bb = r.getBoundingClientRect(); return bb.bottom > th.bottom && bb.top < tf.top; });
    const cuoi = rows[rows.length - 1].getBoundingClientRect();
    return { cheTren: hien[0] ? Math.round(th.bottom - hien[0].getBoundingClientRect().top) : 0, cheDuoi: Math.round(cuoi.bottom - tf.top), dongCuoiBiChe: cuoi.bottom > tf.top + 1 && cuoi.top < tf.bottom };
  });
  log('  cuon den cuoi @1150: che tren =', chong.cheTren + 'px · dong cuoi bi hang TONG che =', chong.dongCuoiBiChe);
  ok.push(['G2 dong cuoi khong bi hang TONG che @1150', chong.dongCuoiBiChe === false]);
  await shot(page, 'G2-cuon-cuoi-1150.png');
  // hàng "không có bill" — lọc rỗng
  await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(500);
  await page.locator('input[placeholder^="Tìm TID"]').fill('zzz-khong-ton-tai'); await page.waitForTimeout(700);
  const rong = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('tbody tr')].find((r) => (r.textContent || '').includes('Không có bill'));
    const ths = [...document.querySelectorAll('thead th')].filter((t) => getComputedStyle(t).display !== 'none').length;
    return { colSpan: tr?.querySelector('td')?.colSpan ?? null, soCotRender: ths, tf: [...document.querySelectorAll('tfoot tr td')].map((c) => (c.textContent || '').trim()).filter(Boolean) };
  });
  log('  hang "Khong co bill": colSpan =', rong.colSpan, '· so cot render =', rong.soCotRender, '· hang TONG =', JSON.stringify(rong.tf));
  ok.push(['G3 colSpan hang rong = so cot', rong.colSpan === rong.soCotRender]);
  await shot(page, 'G3-loc-rong.png');
  await page.locator('input[placeholder^="Tìm TID"]').fill(''); await page.waitForTimeout(600);

  // ══ A. ô tiền: dán CHỮ, 0 dẫn đầu, dấu chấm ══
  log('\n===== A1/A2. o tien: dan CHU / 0 dan dau / dau cham =====');
  await page.getByRole('button', { name: 'Thêm bill mới' }).click(); await page.waitForTimeout(600);
  const chonSS = async (ph, go) => { await page.locator(M + ' input[placeholder="' + ph + '"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type(go, { delay: 15 }); await page.waitForTimeout(350); await page.getByText(go, { exact: false }).last().click(); await page.waitForTimeout(400); };
  await chonSS('— Chọn ngân hàng — — gõ để tìm', 'AB Bank');
  const phTid = await page.evaluate((m) => [...document.querySelectorAll(m + ' input')].map((i) => i.placeholder).find((p) => /tên HKD hoặc số TID/.test(p || '')), M);
  await chonSS(phTid, 'DEMO-TID-03');
  await page.locator(M + ' select').nth(1).selectOption({ label: 'Tiền chờ' }); await page.waitForTimeout(400);
  await page.locator(M + ' select').first().selectOption('21'); await page.waitForTimeout(350);
  await page.locator(M + ' input[placeholder="vd 84"]').fill('8801');
  const docSo = () => page.evaluate((m) => {
    const ds = [...document.querySelectorAll(m + ' span')];
    const g = (nm) => { const e = ds.find((s) => (s.textContent || '').trim() === nm); return e?.parentElement?.querySelector('span:last-child')?.textContent?.trim() ?? null; };
    return { oTruoc: [...document.querySelectorAll(m + ' input[placeholder="0"]')][0].value, doanhSo: g('Doanh số ghi (đã trừ hủy)'), sauPhi: g('Sau phí bán — đại lý nhận') };
  }, M);
  for (const v of ['abc', '12abc34', '00035000000', '35.000.000', '-5000000', '0']) {
    await oTien(0).fill(''); await page.waitForTimeout(150);
    await oTien(0).type(v, { delay: 8 }); await page.waitForTimeout(500);
    log('  go "' + v + '" ->', JSON.stringify(await docSo()), ' nut chan =', await nutGhi(page));
  }
  // hoàn vượt
  await oTien(0).fill(''); await oTien(0).type('35000000'); await page.waitForTimeout(500);
  await oTien(2).fill('99000000'); await page.waitForTimeout(600);
  const hv = await page.evaluate((m) => ({
    canh: [...document.querySelectorAll(m + ' div')].map((d) => (d.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => t.length < 140 && /Đã hoàn .* nhieu hon|Đã hoàn .* nhiều hơn/.test(t))[0] ?? null,
    conPhaiHoan: [...document.querySelectorAll(m + ' input[readonly]')].map((x) => x.value)
  }), M);
  log('  hoan 99tr > duoc nhan 34,6tr ->', JSON.stringify(hv), ' nut chan =', await nutGhi(page));
  ok.push(['A7 hoan vuot bi chan + bao do', (await nutGhi(page)) === true && !!hv.canh]);
  await shot(page, 'A7-hoan-vuot.png');
  // ══ J3. rò gioLoi sau khi THU NHỎ rồi mở lại ══
  log('\n===== J3. ro co loi GIO qua Thu nho / mo lai =====');
  await oTien(2).fill('0'); await page.waitForTimeout(300);
  await page.locator(M + ' input[aria-label="Giờ"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type('28', { delay: 60 });
  await page.waitForTimeout(400);
  log('  dang loi 28h: nut chan =', await nutGhi(page));
  await page.locator(M + ' button[data-nut="thunho"]').click(); await page.waitForTimeout(500);
  log('  da thu nho (form bi unmount) · co the bam Mo lai?', await page.evaluate(() => !!document.querySelector('button')));
  await page.getByRole('button', { name: 'Mở lại' }).click(); await page.waitForTimeout(700);
  const j3 = await page.evaluate((m) => ({
    h: document.querySelector(m + ' input[aria-label="Giờ"]').value,
    p: document.querySelector(m + ' input[aria-label="Phút"]').value,
    loi: [...document.querySelectorAll(m + ' span')].map((s) => (s.textContent || '').trim()).filter((t) => /Giờ phải từ/.test(t)),
    truocPhi: [...document.querySelectorAll(m + ' input[placeholder="0"]')][0].value
  }), M);
  log('  sau "Mo lai":', JSON.stringify(j3), ' nut chan =', await nutGhi(page));
  log('  -> gio 28 bi am tham keo ve', j3.h, '(nguoi nhap tuong da ghi 28h?)');
  await shot(page, 'J3-thu-nho-mo-lai.png');
} catch (e) { console.error('[audit8] LOI:', e.message, '\n', (e.stack || '').split('\n').slice(1, 3).join('\n')); }
finally {
  console.log('\n===== KET QUA #8 =====');
  ok.forEach(([t, v]) => console.log((v ? '  DAT  ' : '  DO   ') + t));
  if (errs.length) { console.log('  page errors:'); errs.slice(0, 8).forEach((e) => console.log('    ', e)); }
  await browser.close(); await server.close(); process.exit(0);
}
