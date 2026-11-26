// AUDIT ĐỐI KHÁNG #7 — ô GIỜ (gõ nhanh/chậm/dán/biên/bỏ trống), TIỀN HỦY biên, LÀM TRÒN 1đ hiện trên màn,
// mốc kỳ TỰ NHẢY sau 60s.
import { moHarness, batPayload, docPayloads, shot, nutGhi } from './_audit-lib.mjs';

const { page, browser, server, errs } = await moHarness();
await batPayload(page);
const ok = [];
const log = (...a) => console.log(...a);
const M = '.fixed.inset-0';
const oTien = (i) => page.locator(M + ' input[placeholder="0"]').nth(i);

async function moForm() { await page.getByRole('button', { name: 'Thêm bill mới' }).click(); await page.waitForTimeout(550); }
async function chonSS(ph, go) {
  await page.locator(M + ' input[placeholder="' + ph + '"]').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(go, { delay: 15 }); await page.waitForTimeout(350);
  await page.getByText(go, { exact: false }).last().click(); await page.waitForTimeout(400);
}
const phTid = () => page.evaluate((m) => [...document.querySelectorAll(m + ' input')].map((i) => i.placeholder).find((p) => /tên HKD hoặc số TID|Chọn ngân hàng trước/.test(p || '')), M);
async function chonPhiThe(phi, the) {
  await page.locator(M + ' select').nth(1).selectOption({ label: phi }); await page.waitForTimeout(400);
  await page.locator(M + ' select').first().selectOption(the); await page.waitForTimeout(350);
}
const docGio = () => page.evaluate((m) => ({
  h: document.querySelector(m + ' input[aria-label="Giờ"]').value,
  p: document.querySelector(m + ' input[aria-label="Phút"]').value,
  loi: [...document.querySelectorAll(m + ' span')].map((s) => (s.textContent || '').trim()).filter((t) => /Giờ phải từ|Phút phải từ/.test(t)),
  ca: [...document.querySelectorAll(m + ' input[readonly]')][0]?.value ?? null,
  khoa: document.querySelector(m + ' code')?.textContent?.trim() ?? null
}), M);
const docDong = (nhan) => page.evaluate(([m, n]) => {
  const el = [...document.querySelectorAll(m + ' span')].find((s) => (s.textContent || '').trim() === n);
  return el?.parentElement?.querySelector('span:last-child')?.textContent?.trim() ?? null;
}, [M, nhan]);

try {
  // ══ E. Ô GIỜ ══
  log('\n===== E. O GIO 24h =====');
  await moForm();
  await chonSS('— Chọn ngân hàng — — gõ để tìm', 'AB Bank');
  await chonSS(await phTid(), 'DEMO-TID-03');
  await chonPhiThe('Tiền chờ', '21');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('8800');
  await oTien(0).fill('35000000');
  await page.waitForTimeout(400);

  const go = async (sel, s, delay) => { await page.locator(M + ' input[aria-label="' + sel + '"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type(s, { delay }); await page.waitForTimeout(300); };
  await go('Giờ', '14', 0); await go('Phút', '35', 0);
  log('  go NHANH (delay 0ms) "14:35"      ->', JSON.stringify(await docGio()));
  await go('Giờ', '09', 450); await go('Phút', '05', 450);
  log('  go CHAM  (delay 450ms) "09:05"    ->', JSON.stringify(await docGio()));
  await page.locator(M + ' input[aria-label="Giờ"]').fill('23'); await page.locator(M + ' input[aria-label="Phút"]').fill('59'); await page.waitForTimeout(400);
  log('  DAN (fill) "23:59"                ->', JSON.stringify(await docGio()));
  await go('Giờ', '28', 80);
  const e28 = await docGio();
  log('  go 28 gio (CHUA roi o)            ->', JSON.stringify(e28), ' nut ghi chan =', await nutGhi(page));
  ok.push(['E1 28h bao do + chan ghi', e28.loi.length > 0 && (await nutGhi(page)) === true]);
  await page.keyboard.press('Tab'); await page.waitForTimeout(400);
  log('  sau khi roi o                     ->', JSON.stringify(await docGio()));
  await go('Phút', '99', 80);
  const e99 = await docGio();
  log('  99 phut (CHUA roi o)              ->', JSON.stringify(e99), ' nut ghi chan =', await nutGhi(page));
  ok.push(['E2 99 phut bao do + chan ghi', e99.loi.length > 0 && (await nutGhi(page)) === true]);
  await page.keyboard.press('Tab'); await page.waitForTimeout(400);
  // BỎ TRỐNG ô giờ: màn hiện rỗng nhưng khóa bill/ca dùng giá trị NÀO?
  await page.locator(M + ' input[aria-label="Giờ"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace'); await page.waitForTimeout(400);
  const eTrong = await docGio();
  log('  XOA TRONG o gio (CHUA roi o)      ->', JSON.stringify(eTrong));
  log('  -> o gio TRONG nhung Ca/khoa bill van tinh theo gio CU:', eTrong.h === '' && eTrong.ca ? '*** CO (man noi 1 dang, so chot noi 1 dang) ***' : 'khong');
  ok.push(['E3 o gio trong khong duoc im lang dung gio cu', !(eTrong.h === '' && !!eTrong.ca)]);
  log('     nut ghi khi o gio TRONG =', await nutGhi(page));
  await shot(page, 'E-o-gio-trong.png');
  await go('Giờ', '7', 100); await page.keyboard.press('Tab'); await page.waitForTimeout(400);
  log('  chi 1 chu so "7" roi Tab          ->', JSON.stringify(await docGio()));

  // ══ A4. TIỀN HỦY biên ══
  log('\n===== A4. TIEN HUY bien =====');
  await go('Giờ', '10', 60); await go('Phút', '00', 60); await page.keyboard.press('Tab'); await page.waitForTimeout(300);
  const thuHuy = async (v) => {
    await oTien(1).fill(v); await page.waitForTimeout(500);
    return {
      doanhSoGhi: await docDong('Doanh số ghi (đã trừ hủy)'),
      truHuy: await docDong('Trừ hủy'),
      sauPhi: await docDong('Sau phí bán — đại lý nhận'),
      chan: await nutGhi(page),
      canhDo: await page.evaluate((m) => [...document.querySelectorAll(m + ' div')].map((d) => (d.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => t.length < 130 && /Tiền hủy .* lớn hơn tổng quẹt/.test(t))[0] ?? null, M)
    };
  };
  log('  quet 35tr, huy = 0            ->', JSON.stringify(await thuHuy('0')));
  log('  quet 35tr, huy = 35tr (TOAN BO)->', JSON.stringify(await thuHuy('35000000')));
  log('  quet 35tr, huy = 99tr (> quet) ->', JSON.stringify(await thuHuy('99000000')));
  const huyVuot = await thuHuy('99000000');
  ok.push(['A4a huy > quet bi chan + bao do', huyVuot.chan === true && !!huyVuot.canhDo]);
  const huyHet = await thuHuy('35000000');
  ok.push(['A4b huy = toan bo bi chan', huyHet.chan === true]);
  await oTien(1).fill('0'); await page.waitForTimeout(400);

  // ══ A5. LÀM TRÒN: so số MÀN HIỆN với backend marginToAmount ══
  log('\n===== A5. LAM TRON 1 dong (man vs backend marginToAmount) =====');
  const backend = (a, m) => { const p = a * m; if (!Number.isSafeInteger(p)) { const A = BigInt(Math.round(a)), Mi = BigInt(Math.round(m)), D = 100000n, n = A * Mi, q = n / D, r = n % D; return Number((r < 0n ? -r : r) * 2n >= D ? q + (n < 0n ? -1n : 1n) : q); } return Math.round(p / 100000); };
  for (const amt of [10487000, 3000, 35000000]) {
    await oTien(0).fill(String(amt)); await page.waitForTimeout(550);
    const sauPhi = await docDong('Sau phí bán — đại lý nhận');
    const manPhi = amt - Number(String(sauPhi).replace(/\./g, ''));
    const bePhi = backend(amt, 1150); // TID DEMO-TID-03 / JCB / Tien cho = 1,15% = 1150 milli
    log('  lo ' + amt.toLocaleString('vi-VN') + ' @1,15%: man hien "sau phi"=' + sauPhi + ' => phi man=' + manPhi + 'd · backend ghi phi=' + bePhi + 'd · LECH=' + (bePhi - manPhi) + 'd');
    ok.push(['A5 lam tron khop backend @' + amt, manPhi === bePhi]);
  }
  await shot(page, 'A5-lam-tron.png');
  await page.locator(M + ' button[title="Đóng"]').first().click().catch(() => {});
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Đóng, bỏ dữ liệu' }).click().catch(() => {});
  await page.waitForTimeout(450);

  // ══ F4. MỐC KỲ TỰ NHẢY sau 60 giây ══
  log('\n===== F4. moc ky TU NHAY sau 60 giay =====');
  await page.evaluate(() => { const ds = [...document.querySelectorAll('input[type=date]')]; });
  // chọn 1 NGÀY QUA KHU (05/11) cho CA HAI o tu-den, roi cho 65s
  const dsDate = page.locator('input[type=date]');
  await dsDate.nth(0).fill('2026-11-05');
  await dsDate.nth(1).fill('2026-11-05');
  await page.waitForTimeout(700);
  const truoc = await page.evaluate(() => [...document.querySelectorAll('input[type=date]')].map((i) => i.value));
  const dongTruoc = await page.evaluate(() => document.querySelectorAll('tbody tr:not([aria-hidden])').length);
  log('  chon ky = 05/11 -> 05/11 :', JSON.stringify(truoc), ' so dong =', dongTruoc);
  log('  ... cho 65 giay ...');
  await page.waitForTimeout(65000);
  const sau = await page.evaluate(() => [...document.querySelectorAll('input[type=date]')].map((i) => i.value));
  const dongSau = await page.evaluate(() => document.querySelectorAll('tbody tr:not([aria-hidden])').length);
  const hn = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  log('  SAU 65 giay              :', JSON.stringify(sau), ' so dong =', dongSau, ' (hom nay =', hn + ')');
  const nhay = JSON.stringify(truoc) !== JSON.stringify(sau);
  log('  ->', nhay ? '*** BO LOC KY TU DOI khi nguoi dung khong bam gi ***' : 'dung yen');
  ok.push(['F4 ky khong tu doi sau 60s', !nhay]);
  await shot(page, 'F4-ky-tu-nhay.png');
} catch (e) { console.error('[audit7] LOI:', e.message, '\n', (e.stack || '').split('\n').slice(1, 3).join('\n')); }
finally {
  console.log('\n===== KET QUA #7 =====');
  ok.forEach(([t, v]) => console.log((v ? '  DAT  ' : '  DO   ') + t));
  if (errs.length) { console.log('  page errors:'); errs.slice(0, 8).forEach((e) => console.log('    ', e)); }
  await browser.close(); await server.close(); process.exit(0);
}
