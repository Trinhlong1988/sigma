import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--disable-features=OverlayScrollbar,FluentOverlayScrollbar,FluentScrollbar'] });
const p = await b.newPage();
await p.setViewportSize({ width: 1920, height: 1080 });
await p.goto('http://localhost:57912/harness-bill-le.html', { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
console.log(JSON.stringify(await p.evaluate(() => {
  const k = document.querySelector('[data-kiem="khung-bang"]');
  const cs = getComputedStyle(k);
  let coRule = false;
  for (const ss of document.styleSheets) { try { for (const r of ss.cssRules) if (String(r.cssText).includes('webkit-scrollbar')) coRule = true; } catch (e) {} }
  return {
    rect: Math.round(k.getBoundingClientRect().height),
    clientH: k.clientHeight, offsetH: k.offsetHeight, scrollW: k.scrollWidth, clientW: k.clientWidth,
    overflow: cs.overflow, border: cs.borderTopWidth + '/' + cs.borderBottomWidth,
    coRuleScrollbar: coRule, soStyleTag: document.querySelectorAll('style').length
  };
}), null, 1));
await b.close();
