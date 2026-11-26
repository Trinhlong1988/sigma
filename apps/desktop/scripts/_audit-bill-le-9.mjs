// AUDIT ĐỐI KHÁNG #9 — NGƯỠNG BẢO MẬT 10 bill/ngày (đếm ở đâu, reset khi nào), TÍCH CHỌN sống sót qua
// đổi bộ lọc (xóa bill KHÔNG nhìn thấy), "Xóa lọc" đặt kỳ = hôm nay.
import { moHarness, shot } from './_audit-lib.mjs';

const { page, browser, server, errs } = await moHarness();
const ok = [];
const log = (...a) => console.log(...a);
const M = '.fixed.inset-0';

const nhanNutXoa = () => page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /Xóa \d+ bill|Xóa bill chọn/.test(x.textContent || ''));
  return b ? { nhan: b.textContent.trim(), mo: b.disabled } : null;
});
const soDong = () => page.evaluate(() => document.querySelectorAll('tbody tr:not([aria-hidden])').length);
async function tichLoc(nhan, muc) {
  await page.getByRole('button', { name: new RegExp('^' + nhan) }).first().click();
  await page.waitForTimeout(300);
  for (const m of muc) { await page.getByRole('button', { name: m, exact: true }).first().click(); await page.waitForTimeout(180); }
  await page.mouse.click(5, 5); await page.waitForTimeout(400);
}

try {
  // ══ S1. TÍCH CHỌN sống sót qua ĐỔI BỘ LỌC ══
  log('\n===== S1. TICH CHON song sot qua doi bo loc =====');
  await page.getByRole('button', { name: 'Xóa lọc' }).click(); await page.waitForTimeout(400);
  await tichLoc('Tất cả đại lý', ['Đại lý A']);
  const nA = await soDong();
  await page.locator('thead input[type=checkbox]').check(); await page.waitForTimeout(500);
  log('  loc dai ly = Truong SG: ' + nA + ' dong, bam "Chon tat ca" ->', JSON.stringify(await nhanNutXoa()));
  // đổi bộ lọc sang đại lý KHÁC
  await page.locator('[aria-label="Bỏ chọn"]').first().click(); await page.waitForTimeout(500);
  await tichLoc('Tất cả đại lý', ['Đại lý C']);
  const nB = await soDong();
  const sau = await nhanNutXoa();
  const conTich = await page.evaluate(() => [...document.querySelectorAll('tbody input[type=checkbox]')].filter((c) => c.checked).length);
  log('  doi loc sang Đại lý C: ' + nB + ' dong hien · nut xoa ->', JSON.stringify(sau), '· o tich CON THAY TREN MAN =', conTich);
  const soTrongNut = Number((sau?.nhan || '').replace(/\D/g, '')) || 0;
  log('  ->', soTrongNut > conTich
    ? '*** nut xoa dang nam ' + soTrongNut + ' bill nhung tren man chi thay ' + conTich + ' o tich -> xoa ca bill KHONG NHIN THAY ***'
    : 'tich chon da duoc don theo bo loc');
  ok.push(['S1 tich chon khong giu bill ngoai bo loc', soTrongNut <= conTich]);
  await shot(page, 'S1-tich-chon-ngoai-bo-loc.png');
  // thử XÓA xem có xóa đúng số đó không
  await page.getByRole('button', { name: /Xóa \d+ bill/ }).click(); await page.waitForTimeout(600);
  const hopXoa = await page.evaluate(() => {
    const h = [...document.querySelectorAll('h3,h2')].map((x) => (x.textContent || '').trim()).find((t) => /Xóa \d+ bill/.test(t));
    const msg = [...document.querySelectorAll('.fixed p, .fixed div')].map((x) => (x.textContent || '').replace(/\s+/g, ' ').trim()).find((t) => t.includes('chứng từ tiền'));
    const coOmatKhau = !!document.querySelector('.fixed input[type=password]');
    return { tieuDe: h, loiNhan: msg?.slice(0, 200), coOmatKhau };
  });
  log('  hop xac nhan xoa =', JSON.stringify(hopXoa));
  ok.push(['S2 hop xoa co o mat khau', hopXoa.coOmatKhau === true]);
  await shot(page, 'S2-hop-xoa.png');
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Hủy' }).click().catch(() => {});
  await page.waitForTimeout(400);

  // ══ S3. NGƯỠNG 10 bill/ngày — đếm khi MỞ form sửa, và RESET khi tải lại trang ══
  log('\n===== S3. NGUONG 10 bill/ngay: dem luc nao, reset khi nao =====');
  await page.getByRole('button', { name: 'Xóa lọc' }).click(); await page.waitForTimeout(400);
  // mở form SỬA rồi ĐÓNG BỎ, 12 lần — không sửa gì cả
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => { document.querySelector('tbody button[title^="Sửa bill"]').click(); });
    await page.waitForTimeout(260);
    await page.locator(M + ' button[title="Đóng"]').first().click().catch(() => {});
    await page.waitForTimeout(220);
    await page.getByRole('button', { name: 'Đóng, bỏ dữ liệu' }).click().catch(() => {});
    await page.waitForTimeout(220);
  }
  // đọc bộ đếm qua hộp xóa (message có "hôm nay đã sửa/xóa N bill")
  await page.locator('tbody input[type=checkbox]').first().check(); await page.waitForTimeout(400);
  await page.getByRole('button', { name: /Xóa \d+ bill/ }).click(); await page.waitForTimeout(600);
  const dem1 = await page.evaluate(() => [...document.querySelectorAll('.fixed *')].map((x) => (x.textContent || '').replace(/\s+/g, ' ').trim()).find((t) => t.includes('hôm nay đã sửa/xóa')) ?? '(khong co canh bao nguong)');
  log('  sau 12 lan MO form sua roi BO (khong sua gi):', JSON.stringify(dem1.slice(0, 220)));
  log('  -> bo dem tang theo so lan MO FORM, khong theo so bill THUC SU sua?',
    /đã sửa\/xóa 1[0-9]|đã sửa\/xóa 12/.test(dem1) ? '*** CO ***' : '(doc lai)');
  await shot(page, 'S3-nguong-dem-mo-form.png');
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  // TẢI LẠI TRANG → bộ đếm còn không?
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(900);
  await page.locator('tbody input[type=checkbox]').first().check(); await page.waitForTimeout(400);
  await page.getByRole('button', { name: /Xóa \d+ bill/ }).click(); await page.waitForTimeout(600);
  const dem2 = await page.evaluate(() => [...document.querySelectorAll('.fixed *')].map((x) => (x.textContent || '').replace(/\s+/g, ' ').trim()).find((t) => t.includes('hôm nay đã sửa/xóa')) ?? '(khong co canh bao nguong)');
  log('  SAU KHI TAI LAI TRANG (F5):', JSON.stringify(dem2.slice(0, 180)));
  log('  ->', dem2.includes('hôm nay đã sửa/xóa') ? 'bo dem con' : '*** BO DEM VE 0 — nguong 10 bill/ngay bi vo hieu chi bang F5 / chuyen trang ***');
  ok.push(['S3 nguong 10 bill/ngay song sot qua F5', dem2.includes('hôm nay đã sửa/xóa')]);
  await shot(page, 'S3-sau-F5.png');
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);

  // ══ S4. "Xóa lọc" đặt kỳ = HÔM NAY (không phải "tất cả") ══
  log('\n===== S4. "Xoa loc" dat ky = hom nay =====');
  const d1 = page.locator('input[type=date]');
  await d1.nth(0).fill('2026-10-01'); await d1.nth(1).fill('2026-11-30'); await page.waitForTimeout(600);
  log('  tu dat ky 01/10 -> 30/11: so dong =', await soDong());
  await page.getByRole('button', { name: 'Xóa lọc' }).click(); await page.waitForTimeout(600);
  const sauXoaLoc = await page.evaluate(() => [...document.querySelectorAll('input[type=date]')].map((i) => i.value));
  log('  bam "Xoa loc" -> o tu-den =', JSON.stringify(sauXoaLoc), ' so dong =', await soDong());
  log('  -> "Xoa loc" KHONG xoa ky ma DAT ky = hom nay (nguoi dung de tuong mat du lieu)');
} catch (e) { console.error('[audit9] LOI:', e.message, '\n', (e.stack || '').split('\n').slice(1, 3).join('\n')); }
finally {
  console.log('\n===== KET QUA #9 =====');
  ok.forEach(([t, v]) => console.log((v ? '  DAT  ' : '  DO   ') + t));
  if (errs.length) { console.log('  page errors:'); errs.slice(0, 8).forEach((e) => console.log('    ', e)); }
  await browser.close(); await server.close(); process.exit(0);
}
