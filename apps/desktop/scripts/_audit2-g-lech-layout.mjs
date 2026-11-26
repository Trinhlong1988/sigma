// AUDIT2-G — CHỨNG MINH bề ngang cột KHÔNG KHOÁ: 1 số tiền dài làm DÃN cột và XÊ DỊCH cả bảng.
// So bề ngang 21 cột TRƯỚC và SAU khi thêm 1 bill 999.999.999.999.
import { moTrang, anh, finding, ok, FINDINGS } from './_audit2-lib.mjs';

async function gan(page) {
  await page.evaluate(() => {
    for (const l of document.querySelectorAll('label')) {
      const sp = l.querySelector(':scope > span'); if (!sp) continue;
      const ten = (sp.textContent || '').replace('*', '').trim();
      const el = l.querySelector(':scope > input, :scope > select, :scope > div input, :scope > div button');
      if (el && ten) el.setAttribute('data-audit', ten);
      if (ten === 'Giờ quẹt') { const ii = l.querySelectorAll('input'); if (ii[0]) ii[0].setAttribute('data-audit', 'gio-h'); if (ii[1]) ii[1].setAttribute('data-audit', 'gio-m'); }
    }
  });
}
const O = (page, t) => page.locator(`[data-audit="${t}"]`);
async function dien(page, t, v) { const e = O(page, t); await e.click(); await e.press('Control+a'); if (String(v) !== '') await e.type(String(v), { delay: 8 }); else await e.press('Delete'); await page.waitForTimeout(150); }
async function chonSearch(page, ph, s) {
  const el = page.getByPlaceholder(ph);
  await el.click(); await el.fill(''); await el.type(s, { delay: 12 });
  await page.waitForTimeout(300);
  const d = page.locator('li', { hasText: s }).first();
  await d.waitFor({ state: 'visible', timeout: 8000 }); await d.dispatchEvent('mousedown');
  await page.waitForTimeout(350);
}
const doCot = (page) => page.evaluate(() => {
  const t = document.querySelector('[data-kiem="khung-bang"] table');
  return {
    cot: [...t.querySelectorAll('thead th')].map((x) => ({ ten: (x.textContent || '').trim(), rong: +x.getBoundingClientRect().width.toFixed(2) })),
    rongBang: +t.getBoundingClientRect().width.toFixed(2),
    cuonNgang: (() => { const k = document.querySelector('[data-kiem="khung-bang"]'); return k.scrollWidth - k.clientWidth; })()
  };
});

const { browser, page } = await moTrang(1920, 1080);
console.log('=== AUDIT2-G · bề ngang cột có KHOÁ không? ===');
const truoc = await doCot(page);
console.log('  TRƯỚC:', truoc.cot.map((c) => `${c.ten || 'tích'}=${c.rong}`).join(' · '));
console.log('  bảng', truoc.rongBang, 'px · cuộn ngang', truoc.cuonNgang, 'px');
await anh(page, 'G-truoc.png');

await page.locator('[data-nut="them"]').click();
await page.waitForTimeout(800);
await gan(page);
await chonSearch(page, '— Chọn ngân hàng —', 'AB Bank');
await chonSearch(page, '— Gõ tên HKD hoặc số TID —', 'DEMO-TID-02');
await gan(page);
const opts = await O(page, 'Loại thẻ').locator('option').allTextContents();
await O(page, 'Loại thẻ').selectOption({ index: opts.findIndex((x) => /Visa/.test(x)) });
await page.waitForTimeout(300);
await dien(page, 'Số hóa đơn', '123456');
await dien(page, 'Trước phí', '999999999999');
await O(page, 'gio-h').fill('11'); await O(page, 'gio-m').fill('11'); await O(page, 'gio-m').blur();
await page.waitForTimeout(500);
await page.locator('[data-nut="ghibill"]').click();
await page.waitForTimeout(1100);
await page.locator('button:has-text("Xong")').first().click().catch(() => {});
await page.waitForTimeout(700);

const sau = await doCot(page);
console.log('  SAU  :', sau.cot.map((c) => `${c.ten || 'tích'}=${c.rong}`).join(' · '));
console.log('  bảng', sau.rongBang, 'px · cuộn ngang', sau.cuonNgang, 'px');
await anh(page, 'G-sau.png');

const lech = sau.cot.map((c, i) => ({ ten: c.ten || 'tích', truoc: truoc.cot[i].rong, sau: c.rong, d: +(c.rong - truoc.cot[i].rong).toFixed(2) })).filter((x) => Math.abs(x.d) > 0.5);
console.log('  cột XÊ DỊCH:', JSON.stringify(lech));
if (lech.length)
  finding('VỪA', 'G-COT-KHONG-KHOA',
    'Bề ngang cột KHÔNG KHOÁ: bảng không dùng table-fixed/colgroup, chỉ đặt class w-[…] trên <th> ⇒ CHỈ CẦN 1 bill có số tiền dài là mọi cột XÊ DỊCH và bảng rộng thêm. Mọi số đo "chốt 6/11" (TID 101 · HKD 214 · tiền 130 · % 84) chỉ đúng với BỘ DỮ LIỆU MẪU; dữ liệu thật dài hơn là lệch hết (BillManualEntryPage.tsx:1332-1360)',
    `thêm 1 bill 999.999.999.999 → ${lech.length}/21 cột đổi bề ngang: ${lech.map((x) => `${x.ten} ${x.truoc}→${x.sau} (${x.d > 0 ? '+' : ''}${x.d})`).join(' · ')} · bảng ${truoc.rongBang}→${sau.rongBang}px · cuộn ngang ${truoc.cuonNgang}→${sau.cuonNgang}px`);
else ok('G-COT-KHONG-KHOA', 'Bề ngang cột khoá cứng — số tiền dài không làm xê dịch', `21/21 cột giữ nguyên, bảng ${sau.rongBang}px`);

console.log(`\n=== AUDIT2-G xong · ${FINDINGS.length} finding ===`);
await browser.close();
