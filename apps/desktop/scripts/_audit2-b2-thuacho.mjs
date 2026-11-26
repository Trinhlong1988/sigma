// AUDIT2-B2 — "… dù THỪA CHỖ": max-w-[…] của td nhỏ hơn bề ngang THẬT của cột (bảng auto-layout dãn 1,71%)
// ⇒ chữ bị ba-chấm sớm hơn cần thiết. + đo lại THANH CUỘN (overlay vs chiếm chỗ).
import { moTrang, anh, finding, ok, FINDINGS } from './_audit2-lib.mjs';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { OUT } from './_audit2-lib.mjs';

const { browser, page } = await moTrang(1920, 1080);
await page.locator('input[aria-label="Từ ngày"]').fill('2026-01-01');
await page.locator('input[aria-label="Đến ngày"]').fill('2026-12-31');
await page.waitForTimeout(300);

const d = await page.evaluate(() => {
  const t = document.querySelector('[data-kiem="khung-bang"] table');
  const ths = [...t.querySelectorAll('thead th')];
  const ten = ths.map((x) => (x.textContent || '').trim());
  const rongCot = ths.map((x) => +x.getBoundingClientRect().width.toFixed(2));
  const tr = [...t.querySelectorAll('tbody tr')].find((r) => (r.textContent || '').includes('Đại lý F'));
  const ra = [];
  [...t.querySelectorAll('tbody tr')].forEach((row) => {
    [...row.querySelectorAll('td')].forEach((td, i) => {
      const cs = getComputedStyle(td);
      const mw = cs.maxWidth;
      const rongThat = +td.getBoundingClientRect().width.toFixed(2);
      const noiDung = td.scrollWidth;
      const oTrong = td.clientWidth;
      const bachamOTd = cs.textOverflow === 'ellipsis' && noiDung > oTrong;
      // span.truncate con
      const sp = td.querySelector('.truncate');
      const bachamOSpan = sp && sp.scrollWidth > sp.clientWidth;
      if ((mw !== 'none' && parseFloat(mw) < rongCot[i] - 0.5) && (bachamOTd || bachamOSpan))
        ra.push({
          cot: ten[i], text: (td.textContent || '').trim().slice(0, 32),
          maxWidthKhai: mw, cotRongThat: rongCot[i],
          thuaCho: +(rongCot[i] - parseFloat(mw)).toFixed(2),
          noiDungCan: sp ? sp.scrollWidth : noiDung, oChoPhep: sp ? sp.clientWidth : oTrong,
          thieu: (sp ? sp.scrollWidth - sp.clientWidth : noiDung - oTrong)
        });
    });
  });
  // gom theo cột + text
  const gom = {};
  for (const r of ra) { const k = r.cot + '|' + r.text; gom[k] = gom[k] || { ...r, lan: 0 }; gom[k].lan++; }
  return { ten, rongCot, bacham: Object.values(gom) };
});

console.log('=== AUDIT2-B2 · "…" DÙ THỪA CHỖ ===');
for (const b of d.bacham)
  console.log(`  cột ${b.cot}: "${b.text}" · max-w khai ${b.maxWidthKhai} nhưng CỘT rộng thật ${b.cotRongThat}px (thừa ${b.thuaCho}px) · nội dung cần ${b.noiDungCan}px, chỉ cho ${b.oChoPhep}px → thiếu ${b.thieu}px · ${b.lan} dòng`);

const tuThua = d.bacham.filter((b) => b.thieu <= b.thuaCho);
if (tuThua.length)
  finding(
    'VỪA',
    'B2-BACHAM-THUA-CHO',
    'Ô bị "…" DÙ CÒN CHỖ: td khai max-w-[…] theo số CŨ, còn bảng auto-layout đã dãn cột rộng hơn ⇒ ba-chấm sớm. Chỉ cần nới max-w bằng bề ngang cột thật (hoặc dùng table-fixed + colgroup) là hết (BillManualEntryPage.tsx:1392,1424,1428,1430)',
    tuThua.map((b) => `${b.cot} "${b.text}": thiếu ${b.thieu}px mà cột còn thừa ${b.thuaCho}px`).join(' · ')
  );
else ok('B2-BACHAM-THUA-CHO', 'Không ô nào bị "…" trong khi cột còn thừa chỗ', `${d.bacham.length} ô bị "…"`);

// các ô bị "…" nhưng THẬT SỰ không đủ chỗ (ghi chú dài) — chỉ ghi nhận
const thatThieu = d.bacham.filter((b) => b.thieu > b.thuaCho);
if (thatThieu.length) console.log('  (ô thật sự không đủ chỗ — có title tooltip, chấp nhận):', thatThieu.map((b) => `${b.cot} thiếu ${b.thieu}px`).join(' · '));

// ── THANH CUỘN: đo ở 2 chế độ (mặc định headless vs tắt overlay-scrollbar) ──
async function doScroll(args) {
  const b2 = await chromium.launch({ args });
  const p = await b2.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto('http://localhost:57912/harness-bill-le.html', { waitUntil: 'networkidle' });
  await p.waitForSelector('tbody tr');
  await p.waitForTimeout(500);
  const r = await p.evaluate(() => {
    const k = document.querySelector('[data-kiem="khung-bang"]');
    const cs = getComputedStyle(k);
    const vienT = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const vienN = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    return {
      caoThanhNgang: k.offsetHeight - k.clientHeight - vienT,
      rongThanhDoc: k.offsetWidth - k.clientWidth - vienN,
      vienT, vienN,
      coCuonNgang: k.scrollWidth > k.clientWidth,
      coCuonDoc: k.scrollHeight > k.clientHeight,
      scrollbarWidthCss: cs.scrollbarWidth, scrollbarColorCss: cs.scrollbarColor
    };
  });
  await p.screenshot({ path: resolve(OUT, 'B2-scrollbar-' + (args.length ? 'tat-overlay' : 'macdinh') + '.png') });
  await b2.close();
  return r;
}
const s1 = await doScroll([]);
const s2 = await doScroll(['--disable-features=OverlayScrollbar,FluentOverlayScrollbar', '--enable-features=FluentScrollbar']);
console.log('\n  thanh cuộn (headless mặc định):', JSON.stringify(s1));
console.log('  thanh cuộn (tắt overlay):     ', JSON.stringify(s2));
const cao = Math.max(s1.caoThanhNgang, s2.caoThanhNgang);
if (cao <= 0)
  finding('NHẸ', 'B2-SCROLLBAR-0', 'Thanh cuộn ngang KHÔNG chiếm chỗ layout trong Chromium đo được (overlay) ⇒ khai `::-webkit-scrollbar{height:16px}` không được xác nhận bằng số đo ở môi trường này — PHẢI đo lại trong Electron ship thật', `đo mặc định ${s1.caoThanhNgang}px · tắt overlay ${s2.caoThanhNgang}px · có cuộn ngang: ${s1.coCuonNgang} · scrollbar-width CSS="${s1.scrollbarWidthCss}"`);
else if (Math.abs(cao - 16) > 1)
  finding('NHẸ', 'B2-SCROLLBAR-16', 'Thanh cuộn ngang không cao 16px', `đo ${cao}px`);
else ok('B2-SCROLLBAR-16', 'Thanh cuộn ngang cao 16px', cao + 'px');

await anh(page, 'B2-bang-1920.png');
console.log(`\n=== AUDIT2-B2 xong · ${FINDINGS.length} finding ===`);
await browser.close();
