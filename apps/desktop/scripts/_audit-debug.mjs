import { moHarness, shot } from './_audit-lib.mjs';
const { page, browser, server, errs } = await moHarness();
await page.getByRole('button', { name: 'Thêm bill mới' }).click();
await page.waitForTimeout(900);
const d = await page.evaluate(() => ({
  nhanField: [...document.querySelectorAll('.fixed.inset-0 label')].map((l) => (l.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 30),
  select: [...document.querySelectorAll('.fixed.inset-0 select')].map((s) => ({ nhan: s.closest('div')?.previousElementSibling?.textContent?.trim() ?? s.getAttribute('aria-label') ?? '?', opts: [...s.options].map((o) => o.text).slice(0, 6), val: s.value })),
  checkbox: [...document.querySelectorAll('.fixed.inset-0 input[type=checkbox]')].map((c) => ({ cls: c.className, nhan: (c.closest('label')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) })),
  input: [...document.querySelectorAll('.fixed.inset-0 input:not([type=checkbox])')].map((i) => ({ al: i.getAttribute('aria-label'), ph: i.placeholder, ro: i.hasAttribute('readonly'), t: i.type })),
  nutModal: [...document.querySelectorAll('.fixed.inset-0 button')].map((b) => (b.textContent || '').trim() || (b.getAttribute('title') || '[icon]')).slice(0, 25)
}));
console.log(JSON.stringify(d, null, 1));
await shot(page, 'debug-form.png');
if (errs.length) console.log('errs', errs.slice(0, 5));
await browser.close(); await server.close(); process.exit(0);
