import { moHarness, shot } from './_audit-lib.mjs';
const { page, browser, server, errs } = await moHarness();
const M = '.fixed.inset-0';
await page.getByRole('button', { name: 'Thêm bill mới' }).click();
await page.waitForTimeout(600);
async function chonSS(ph, go) {
  await page.locator(M + ' input[placeholder="' + ph + '"]').click();
  await page.keyboard.type(go, { delay: 15 }); await page.waitForTimeout(300);
  await page.getByText(go, { exact: false }).last().click(); await page.waitForTimeout(350);
}
await chonSS('— Chọn ngân hàng — — gõ để tìm', 'MBV');
const ph = await page.evaluate((m) => [...document.querySelectorAll(m + ' input')].map((i) => i.placeholder).find((p) => /TID|HKD|Chọn ngân hàng trước/.test(p || '')), M);
console.log('placeholder TID =', JSON.stringify(ph));
await chonSS(ph, 'DEMO-TID-01');
console.log('--- truoc khi tich muon ---');
console.log(JSON.stringify(await page.evaluate((m) => ({
  cb: [...document.querySelectorAll(m + ' input[type=checkbox]')].map((c) => ({ cls: c.className, dis: c.disabled, chk: c.checked, nhan: (c.closest('label')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50) }))
}), M), null, 1));
await page.locator(M + ' input[type=checkbox]').first().check({ force: true });
await page.waitForTimeout(600);
console.log('--- sau khi tich muon ---');
console.log(JSON.stringify(await page.evaluate((m) => ({
  cb: [...document.querySelectorAll(m + ' input[type=checkbox]')].map((c) => ({ cls: c.className, chk: c.checked, nhan: (c.closest('label')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) })),
  inputs: [...document.querySelectorAll(m + ' input:not([type=checkbox])')].map((i) => i.placeholder || i.getAttribute('aria-label') || i.type),
  khoiMuon: [...document.querySelectorAll(m + ' div')].map((d) => (d.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => t.includes('MƯỢN máy')).slice(-1)[0]?.slice(0, 300)
}), M), null, 1));
await shot(page, 'debug-muon.png');
if (errs.length) console.log('errs', errs.slice(0, 3));
await browser.close(); await server.close(); process.exit(0);
