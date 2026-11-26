// AUDIT ĐỐI KHÁNG #2 — cảnh báo SỐ LÔ (lọt / báo oan), MƯỢN TID, SỬA BILL, ô GIỜ.
import { moHarness, batPayload, docPayloads, shot, nutGhi } from './_audit-lib.mjs';

const { page, browser, server, errs } = await moHarness();
await batPayload(page);
const ok = [];
const log = (...a) => console.log(...a);
const M = '.fixed.inset-0';
const oTien = (i) => page.locator(M + ' input[placeholder="0"]').nth(i);

async function moForm() { await page.getByRole('button', { name: 'Thêm bill mới' }).click(); await page.waitForTimeout(500); }
async function chonSS(ph, go) {
  await page.locator(M + ' input[placeholder="' + ph + '"]').click();
  await page.keyboard.type(go, { delay: 15 }); await page.waitForTimeout(300);
  await page.getByText(go, { exact: false }).last().click(); await page.waitForTimeout(350);
}
async function chonMay(bank, tid) {
  await chonSS('— Chọn ngân hàng — — gõ để tìm', bank); await page.waitForTimeout(300);
  const ph = await page.evaluate((m) => [...document.querySelectorAll(m + ' input')].map((i) => i.placeholder).find((p) => /tên HKD hoặc số TID|Chọn ngân hàng trước/.test(p || '')), M);
  await chonSS(ph, tid);
}
async function chonPhiThe(phi, the) {
  await page.locator(M + ' select').nth(1).selectOption({ label: phi }); await page.waitForTimeout(400);
  await page.locator(M + ' select').first().selectOption(the); await page.waitForTimeout(350);
}
const canhBao = () => page.evaluate((m) => [...document.querySelectorAll(m + ' p')].map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => /TRÙNG HOÀN TOÀN|TRÙNG SỐ LÔ|NGHỊCH THỨ TỰ/.test(t)).map((t) => t.slice(0, 150)), M);
const gio = async (h, m) => {
  await page.locator(M + ' input[aria-label="Giờ"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type(h, { delay: 40 });
  await page.locator(M + ' input[aria-label="Phút"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type(m, { delay: 40 });
  await page.keyboard.press('Tab'); await page.waitForTimeout(350);
};
const docDong = (nhan) => page.evaluate(([m, n]) => {
  const el = [...document.querySelectorAll(m + ' span')].find((s) => (s.textContent || '').trim() === n);
  return el?.parentElement?.querySelector('span:last-child')?.textContent?.trim() ?? null;
}, [M, nhan]);
async function dongForm() {
  await page.locator(M + ' button[title="Đóng"]').first().click().catch(() => {});
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Đóng, bỏ dữ liệu' }).click().catch(() => {});
  await page.waitForTimeout(400);
}

try {
  // ══ D1. TRÙNG SỐ HÓA ĐƠN mà KHÔNG có số lô → có cảnh báo không? (BILL_DEMO m1 có HĐ 000118) ══
  log('\n===== D1. TRUNG SO HOA DON, KHONG co so lo =====');
  await page.getByRole('button', { name: 'Xóa lọc' }).click(); await page.waitForTimeout(400);
  await moForm();
  await chonMay('MBV', 'DEMO-TID-01');
  await chonPhiThe('Đối ứng', '13');
  await page.locator(M + ' input[placeholder="vd 000123"]').fill('000118'); // == bill m1 (lo 82, 30tr, 06/11)
  await oTien(0).fill('30000000');
  await gio('09', '14');
  await page.waitForTimeout(600);
  const d1 = { canh: await canhBao(), chan: await nutGhi(page), khoa: await page.evaluate((m) => document.querySelector(m + ' code')?.textContent?.trim(), M) };
  log('  go LAI y nguyen bill m1 (TID DEMO-TID-01, HD 000118, 30tr, 06/11 09:14) nhung BO TRONG so lo:');
  log('    canh bao =', JSON.stringify(d1.canh), ' nut ghi bi chan =', d1.chan);
  log('    khoa bill =', d1.khoa);
  log('  ->', d1.canh.length === 0 ? '*** LOT: TRUNG y nguyen ma IM LANG, ghi duoc ngay ***' : 'co canh bao');
  ok.push(['D1 canh bao trung khi chi co so hoa don', d1.canh.length > 0]);
  await shot(page, 'D1-trung-so-hoa-don-im-lang.png');
  await dongForm();

  // ══ D5. TRÙNG LÔ CÙNG NGÀY khác tiền → nhãn nói "khác ngày/giờ/tiền" đúng không? ══
  log('\n===== D5. TRUNG LO CUNG NGAY, khac tien =====');
  await moForm();
  await chonMay('MBV', 'DEMO-TID-01');
  await chonPhiThe('Đối ứng', '13');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('82'); // m1 co lo 82 ngay 06/11
  await oTien(0).fill('31000000'); // khac tien
  await gio('09', '14');
  await page.waitForTimeout(600);
  const d5 = { canh: await canhBao(), chan: await nutGhi(page) };
  log('  lo 82 CUNG NGAY 06/11, tien khac ->', JSON.stringify(d5.canh));
  log('  nut ghi bi chan =', d5.chan);
  await shot(page, 'D5-trung-lo-cung-ngay.png');
  await dongForm();

  // ══ D4. NGHỊCH THỨ TỰ lô ↔ giờ ══
  log('\n===== D4. NGHICH THU TU lo <-> gio =====');
  await moForm();
  await chonMay('MBV', 'DEMO-TID-01');
  await chonPhiThe('Đối ứng', '13');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('999'); // lo LON hon 82/83
  await oTien(0).fill('5000000');
  await gio('08', '00'); // gio SOM hon 09:14 cua lo 82
  await page.waitForTimeout(600);
  const d4 = { canh: await canhBao(), chan: await nutGhi(page) };
  log('  lo 999 luc 08:00 (da co lo 82 luc 09:14) ->', JSON.stringify(d4.canh), ' chan =', d4.chan);
  ok.push(['D4 bat nghich thu tu lo-gio', d4.canh.some((t) => t.includes('NGHỊCH')) && d4.chan === true]);
  // tích xác nhận → mở khóa?
  await page.locator(M + ' input[type=checkbox].accent-warning, ' + M + ' input[type=checkbox].accent-danger').first().check({ force: true });
  await page.waitForTimeout(400);
  log('  sau khi tich xac nhan -> nut chan =', await nutGhi(page));
  ok.push(['D4b tich xac nhan mo khoa', (await nutGhi(page)) === false]);
  await shot(page, 'D4-nghich-thu-tu.png');

  // ══ D3. RÒ xacNhanTrung sang bill KẾ ══
  log('\n===== D3. RO o "xac nhan" sang bill KE =====');
  await page.locator(M + ' button[data-nut="xoaform"]').click(); await page.waitForTimeout(500);
  await dongForm();
  await moForm();
  await chonMay('MBV', 'DEMO-TID-01');
  await chonPhiThe('Đối ứng', '13');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('82');
  await oTien(0).fill('30000000');
  await gio('09', '14');
  await page.waitForTimeout(700);
  const d3 = await page.evaluate((m) => {
    const cb = [...document.querySelectorAll(m + ' input[type=checkbox].accent-danger, ' + m + ' input[type=checkbox].accent-warning')];
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Ghi nhận bill'));
    return { soOxacNhan: cb.length, daTichSan: cb.map((c) => c.checked), nutChan: b ? b.disabled : null };
  }, M);
  log('  bill MOI trung hoan toan lo 82 30tr ->', JSON.stringify(d3));
  log('  canh bao =', JSON.stringify(await canhBao()));
  log('  ->', d3.daTichSan[0] === true ? '*** O XAC NHAN DA TICH SAN tu bill truoc, cong chan mo luon ***' : 'o xac nhan sach');
  ok.push(['D3 o xac nhan khong ro sang bill ke', d3.daTichSan[0] !== true]);
  await shot(page, 'D3-ro-o-xac-nhan.png');
  await page.locator(M + ' button[data-nut="xoaform"]').click(); await page.waitForTimeout(400);
  await dongForm();

  // (C/E chuyen sang probe 5/7)
} catch (e) { console.error('[audit12] LOI:', e.message, '\n', (e.stack || '').split('\n').slice(1, 3).join('\n')); }
finally {
  console.log('\n===== KET QUA #12 =====');
  ok.forEach(([t, v]) => console.log((v ? '  DAT  ' : '  DO   ') + t));
  if (errs.length) { console.log('  page errors:'); errs.slice(0, 8).forEach((e) => console.log('    ', e)); }
  await browser.close(); await server.close(); process.exit(0);
}
