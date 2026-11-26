import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
await p.setViewportSize({ width: 1920, height: 1080 });
await p.goto('http://localhost:57912/harness-bill-le.html', { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
const d = await p.evaluate(() => {
  const head = [...document.querySelectorAll('thead th')].map((t) => (t.textContent || '').trim());
  const r = [...document.querySelectorAll('tbody tr')].find((x) => x.querySelectorAll('td').length > 5);
  const tds = [...r.querySelectorAll('td')];
  return head.map((ten, i) => {
    const c = tds[i];
    if (!c) return { ten, loi: 'khong co o' };
    const noi = c.firstElementChild && c.children.length === 1 ? c.firstElementChild : c;
    return {
      ten,
      rongO: Math.round(c.getBoundingClientRect().width),
      canNoiDung: Math.round(noi.scrollWidth),
      tran: Math.round(noi.scrollWidth - noi.clientWidth),
      coChu: getComputedStyle(c).fontSize,
      chu: (c.textContent || '').trim().slice(0, 18)
    };
  });
});
const { writeFileSync } = await import('node:fs');
writeFileSync('_do-cot.json', JSON.stringify(d, null, 1), 'utf8');
console.log('da ghi _do-cot.json');
await b.close();
