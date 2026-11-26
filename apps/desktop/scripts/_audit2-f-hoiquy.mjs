// AUDIT2-F — HỒI QUY 4 lỗi đã sửa + tấn công bổ sung:
//  (a) sập bảng nổi KPI khi đang rê chuột 1 cột rồi đổi mốc ngày↔tháng
//  (b) hàng TỔNG lệch cột ở <1280px (đo mép TRÁI thật của từng ô TỔNG so cột)
//  (c) ô "NaN" ở cột Lô
//  (d) colSpan hàng rỗng / hàng đệm
//  + cuộn ngang GIỮA đường (không chỉ 2 đầu) · tiêu đề "THẺ" · ghi bill 12 chữ số đo cột tiền.
import { moTrang, anh, docBang, finding, ok, FINDINGS } from './_audit2-lib.mjs';

const THU = [];
async function thu(ten, fn) {
  console.log(`\n── ${ten} ──`);
  try { await fn(); THU.push([ten, 'chạy']); }
  catch (e) { THU.push([ten, 'LỖI PHÉP KIỂM']); finding('VỪA', 'F-KIEM-HONG:' + ten, 'PHÉP KIỂM KHÔNG CHẠY ĐƯỢC (R198)', String(e.message).split('\n')[0].slice(0, 200)); }
}
async function gan(page) {
  await page.evaluate(() => {
    for (const l of document.querySelectorAll('label')) {
      const sp = l.querySelector(':scope > span');
      if (!sp) continue;
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
  await d.waitFor({ state: 'visible', timeout: 8000 });
  await d.dispatchEvent('mousedown');
  await page.waitForTimeout(350);
}

console.log('=== AUDIT2-F · HỒI QUY 4 LỖI ĐÃ SỬA + TẤN CÔNG BỔ SUNG ===');

// ══════════ (a) KPI: rê chuột cột rồi đổi mốc ngày↔tháng ══════════
{
  const { browser, page, log } = await moTrang(1920, 1080);
  await thu('(a) HỒI QUY: rê chuột 1 cột biểu đồ rồi đổi ngày↔tháng (lỗi cũ TypeError reading "nhan")', async () => {
    await page.locator('input[aria-label="Từ ngày"]').fill('2026-01-01');
    await page.locator('input[aria-label="Đến ngày"]').fill('2026-12-31');
    await page.waitForTimeout(350);
    await page.locator('[data-nut="bieudo"]').click();
    await page.waitForTimeout(900);
    const nCot = await page.locator('svg g rect').count();
    console.log('   mở KPI Doanh số, số rect trong svg =', nCot);
    // rê chuột vào cột CUỐI (index lớn) — khi đổi sang "Theo tháng" chỉ còn 1-2 cột ⇒ index cũ vượt mảng
    const g = page.locator('svg g').filter({ has: page.locator('rect') });
    const nG = await g.count();
    await g.nth(nG - 1).hover();
    await page.waitForTimeout(400);
    const coBang = await page.evaluate(() => !!document.querySelector('.pointer-events-none.absolute'));
    console.log('   đã rê chuột cột cuối · bảng nổi hiện =', coBang);
    await anh(page, 'F-a-hover-cot-cuoi.png');
    // ĐỔI mốc sang THÁNG trong khi chuột vẫn ở cột đó (không rời) → dùng click vào nút "Theo tháng"
    await page.locator('button:has-text("Theo tháng")').click();
    await page.waitForTimeout(700);
    const sau = await page.evaluate(() => ({
      loi: !!document.querySelector('.error'),
      coSvg: !!document.querySelector('svg'),
      soCot: document.querySelectorAll('svg g rect').length,
      bangNoi: document.querySelector('.pointer-events-none.absolute')?.textContent?.trim() ?? null,
      body: (document.body.textContent || '').slice(0, 60)
    }));
    console.log('   sau khi đổi "Theo tháng":', JSON.stringify(sau));
    await anh(page, 'F-a-sau-doi-thang.png');
    // đổi ngược lại + rê chuột liên tục
    for (let i = 0; i < 4; i++) {
      await page.locator('button:has-text("Theo ngày")').click();
      await page.waitForTimeout(250);
      const gg = page.locator('svg g').filter({ has: page.locator('rect') });
      const n = await gg.count();
      if (n > 2) await gg.nth(n - 1).hover();
      await page.waitForTimeout(200);
      await page.locator('button:has-text("Theo tháng")').click();
      await page.waitForTimeout(250);
    }
    // đổi KỲ trong khi đang hover
    await page.locator('button:has-text("Theo ngày")').click();
    await page.waitForTimeout(300);
    const gg2 = page.locator('svg g').filter({ has: page.locator('rect') });
    const n2 = await gg2.count();
    if (n2 > 2) await gg2.nth(n2 - 1).hover();
    await page.waitForTimeout(250);
    await page.locator('button:has-text("Xem toàn bộ kỳ")').click();
    await page.waitForTimeout(600);
    const loi = log.filter((x) => x.type === 'pageerror' || (x.type === 'error' && /nhan|undefined|TypeError/.test(x.text)));
    const conSvg = await page.evaluate(() => !!document.querySelector('svg'));
    console.log('   sau 4 vòng đổi mốc + đổi kỳ khi đang hover: còn svg =', conSvg, '· pageerror =', loi.length);
    await anh(page, 'F-a-sau-4-vong.png');
    if (loi.length || !conSvg)
      finding('NẶNG', 'F-A-KPI-SAP', 'HỒI QUY: bảng nổi KPI vẫn sập khi đổi mốc/kỳ trong lúc rê chuột', `pageerror ${loi.length}: ${loi.slice(0, 2).map((x) => x.text.slice(0, 160)).join(' | ')} · còn svg=${conSvg}`);
    else ok('F-A-KPI-SAP', 'ĐÃ SỬA THẬT: đổi mốc ngày↔tháng + đổi kỳ trong lúc hover 4 vòng → không sập, không pageerror', `${loi.length} lỗi · svg còn ${conSvg}`);
    await page.keyboard.press('Escape');
  });

  // ══════════ (c) NaN ở cột Lô + (d) colSpan ══════════
  await thu('(c)+(d) HỒI QUY: NaN ở cột Lô · colSpan hàng rỗng / hàng đệm / hàng TỔNG', async () => {
    await page.locator('button[title="Đóng"]').first().click().catch(() => {});
    await page.waitForTimeout(400);
    await page.locator('input[aria-label="Từ ngày"]').fill('2026-01-01');
    await page.locator('input[aria-label="Đến ngày"]').fill('2026-12-31');
    await page.waitForTimeout(400);
    const d = await page.evaluate(() => {
      const t = document.querySelector('[data-kiem="khung-bang"] table');
      const soTh = t.querySelectorAll('thead th').length;
      const dem = [...t.querySelectorAll('tbody tr')].filter((r) => r.hasAttribute('aria-hidden')).map((r) => [...r.querySelectorAll('td')].map((x) => x.colSpan));
      const foot = [...t.querySelectorAll('tfoot td')].map((x) => x.colSpan);
      const lo = [...t.querySelectorAll('tbody tr')].filter((r) => r.querySelectorAll('td').length > 3).map((r) => (r.querySelectorAll('td')[10].textContent || '').trim());
      return { soTh, dem, foot, tongFoot: foot.reduce((a, b) => a + b, 0), lo: [...new Set(lo)] };
    });
    console.log(`   thead có ${d.soTh} cột · hàng đệm colSpan ${JSON.stringify(d.dem)} · hàng TỔNG colSpan ${JSON.stringify(d.foot)} (tổng ${d.tongFoot})`);
    console.log('   các giá trị cột Lô:', JSON.stringify(d.lo.slice(0, 30)));
    const xau = d.lo.filter((x) => /NaN|undefined|null|Infinity/.test(x));
    if (xau.length) finding('NẶNG', 'F-C-NAN-LO', 'HỒI QUY: cột Lô còn giá trị NaN/undefined', JSON.stringify(xau));
    else ok('F-C-NAN-LO', 'ĐÃ SỬA THẬT: cột Lô không còn NaN', `${d.lo.length} giá trị khác nhau, không có NaN/undefined/null`);
    const saiSpan = [];
    d.dem.forEach((r, i) => { const s = r.reduce((a, b) => a + b, 0); if (s !== d.soTh) saiSpan.push(`hàng đệm ${i}: ${s} ≠ ${d.soTh}`); });
    if (d.tongFoot !== d.soTh) saiSpan.push(`hàng TỔNG: ${d.tongFoot} ≠ ${d.soTh}`);
    // hàng rỗng (lọc ra 0 bill)
    const el = page.getByPlaceholder('Số lô', { exact: true });
    await el.click(); await el.type('99999', { delay: 15 });
    await page.waitForTimeout(400);
    const dr = await page.evaluate(() => {
      const t = document.querySelector('[data-kiem="khung-bang"] table');
      return [...t.querySelectorAll('tbody tr td')].map((x) => ({ colSpan: x.colSpan, text: (x.textContent || '').trim().slice(0, 40) }));
    });
    console.log('   hàng rỗng:', JSON.stringify(dr));
    dr.forEach((x) => { if (x.text && x.colSpan !== d.soTh) saiSpan.push(`hàng rỗng colSpan ${x.colSpan} ≠ ${d.soTh}`); });
    await el.fill('');
    await page.waitForTimeout(300);
    if (saiSpan.length) finding('NẶNG', 'F-D-COLSPAN', 'HỒI QUY: colSpan không bằng số cột thead', saiSpan.join(' · '));
    else ok('F-D-COLSPAN', 'ĐÃ SỬA THẬT: colSpan hàng rỗng + hàng đệm + hàng TỔNG đều = số cột thead', `${d.soTh} cột`);
  });

  // ══════════ tiêu đề "THẺ" ══════════
  await thu('Tiêu đề cột "LT" → "THẺ"', async () => {
    const b = await docBang(page);
    console.log('   tiêu đề 21 cột:', JSON.stringify(b.head));
    if (b.head.includes('LT')) finding('NHẸ', 'F-THE', 'Còn tiêu đề "LT" chưa đổi thành "THẺ"', JSON.stringify(b.head));
    else if (!b.head.includes('THẺ')) finding('NHẸ', 'F-THE2', 'Không thấy cột "THẺ" trong tiêu đề', JSON.stringify(b.head));
    else ok('F-THE', 'Tiêu đề cột đã là "THẺ" (và _xuat-excel-mau-bill-le.mjs:70 cũng ghi "THẺ")', JSON.stringify(b.head.filter((x) => /THẺ|LT/.test(x))));
  });
  await browser.close();
}

// ══════════ (b) hàng TỔNG lệch cột ở <1280px — đo mép TRÁI thật ══════════
for (const w of [1279, 1150]) {
  const { browser, page } = await moTrang(w, 820);
  await thu(`(b) HỒI QUY: hàng TỔNG có lệch cột ở ${w}px? (đo mép trái thật)`, async () => {
    await page.locator('input[aria-label="Từ ngày"]').fill('2026-01-01');
    await page.locator('input[aria-label="Đến ngày"]').fill('2026-12-31');
    await page.waitForTimeout(400);
    const d = await page.evaluate(() => {
      const k = document.querySelector('[data-kiem="khung-bang"]');
      const t = k.querySelector('table');
      const o = t.getBoundingClientRect().left;
      const cot = [...t.querySelectorAll('thead th')].map((x) => ({ ten: (x.textContent || '').trim(), trai: +(x.getBoundingClientRect().left - o).toFixed(2), phai: +(x.getBoundingClientRect().right - o).toFixed(2) }));
      const foot = [...t.querySelectorAll('tfoot td')].map((x) => ({ text: (x.textContent || '').trim(), colSpan: x.colSpan, trai: +(x.getBoundingClientRect().left - o).toFixed(2), phai: +(x.getBoundingClientRect().right - o).toFixed(2) }));
      return { cot, foot };
    });
    // mỗi ô TỔNG phải bắt đầu đúng mép trái của cột đầu nó bao, và kết thúc đúng mép phải cột cuối nó bao
    let i = 0; const lech = [];
    for (const f of d.foot) {
      const dauCot = d.cot[i], cuoiCot = d.cot[i + f.colSpan - 1];
      if (!dauCot || !cuoiCot) { lech.push(`ô TỔNG "${f.text}" vượt số cột`); break; }
      if (Math.abs(f.trai - dauCot.trai) > 1) lech.push(`"${f.text || '(trống)'}" mép trái ${f.trai} ≠ cột ${dauCot.ten} ${dauCot.trai}`);
      if (Math.abs(f.phai - cuoiCot.phai) > 1) lech.push(`"${f.text || '(trống)'}" mép phải ${f.phai} ≠ cột ${cuoiCot.ten} ${cuoiCot.phai}`);
      i += f.colSpan;
    }
    console.log(`   ô TỔNG: ${d.foot.map((f) => `[${f.colSpan}]${f.text || '·'}@${f.trai}`).join(' ')}`);
    console.log(`   đã bao ${i}/${d.cot.length} cột`);
    if (i !== d.cot.length) lech.push(`tổng colSpan ${i} ≠ ${d.cot.length} cột`);
    // 3 ô tiền TỔNG phải thẳng với 3 cột tiền
    for (const ten of ['Trước phí', 'Sau phí bán', 'Đã hoàn']) {
      const c = d.cot.find((x) => x.ten === ten);
      const f = d.foot.find((x) => Math.abs(x.trai - c.trai) < 1 && x.colSpan === 1);
      if (!f) lech.push(`không có ô TỔNG nào thẳng cột ${ten} (${c.trai})`);
      else console.log(`   cột ${ten} @${c.trai} ↔ ô TỔNG "${f.text}" @${f.trai} · KHỚP`);
    }
    await anh(page, `F-b-${w}-hang-tong.png`);
    if (lech.length) finding('NẶNG', 'F-B-TONG-LECH@' + w, 'HỒI QUY: hàng TỔNG lệch cột', lech.join(' · '));
    else ok('F-B-TONG-LECH@' + w, `ĐÃ SỬA THẬT: hàng TỔNG thẳng cột ở ${w}px (đo mép trái + mép phải từng ô)`, `${d.foot.length} ô TỔNG bao đủ ${i}/${d.cot.length} cột`);

    // cuộn ngang GIỮA ĐƯỜNG (không chỉ 2 đầu) — tiêu đề ghim còn thẳng cột?
    const buoc = [0, 0.17, 0.33, 0.5, 0.66, 0.83, 1];
    const saiGiua = [];
    for (const p of buoc) {
      const r = await page.evaluate((pp) => {
        const k = document.querySelector('[data-kiem="khung-bang"]');
        k.scrollLeft = Math.round((k.scrollWidth - k.clientWidth) * pp);
        const kr = k.getBoundingClientRect();
        const th = [...k.querySelectorAll('thead th')].map((x) => +(x.getBoundingClientRect().left - kr.left).toFixed(1));
        const row = [...k.querySelectorAll('tbody tr')].find((rr) => rr.querySelectorAll('td').length > 3);
        const td = [...row.querySelectorAll('td')].map((x) => +(x.getBoundingClientRect().left - kr.left).toFixed(1));
        const tf = [...k.querySelectorAll('tfoot td')].map((x) => +(x.getBoundingClientRect().left - kr.left).toFixed(1));
        return { sl: k.scrollLeft, lechThTd: th.map((v, i) => +(v - td[i]).toFixed(1)).filter((v) => Math.abs(v) > 0.6).length, thTrai: th[0], tfTrai: tf[0] };
      }, p);
      if (r.lechThTd) saiGiua.push(`scrollLeft=${r.sl}: ${r.lechThTd} cột lệch`);
      if (Math.abs(r.thTrai - r.tfTrai) > 0.6) saiGiua.push(`scrollLeft=${r.sl}: thead@${r.thTrai} vs tfoot@${r.tfTrai}`);
    }
    console.log('   cuộn ngang 7 mốc:', saiGiua.length ? JSON.stringify(saiGiua) : 'thead ≡ td ≡ tfoot ở cả 7 mốc');
    if (saiGiua.length) finding('NẶNG', 'F-CUON-GIUA@' + w, 'Cuộn ngang giữa đường làm tiêu đề ghim / hàng TỔNG lệch cột', saiGiua.join(' · '));
    else ok('F-CUON-GIUA@' + w, `Cuộn ngang 7 mốc (0→100%) ở ${w}px: tiêu đề + hàng TỔNG luôn thẳng cột`, '7/7 mốc');
  });
  await browser.close();
}

// ══════════ Ghi bill 12 chữ số (bill SẠCH, không vướng cảnh báo) → đo cột tiền ══════════
{
  const { browser, page, log } = await moTrang(1920, 1080);
  await thu('Ghi bill 999.999.999.999 (12 chữ số) rồi ĐO cột tiền + hàng TỔNG', async () => {
    await page.locator('[data-nut="them"]').click();
    await page.waitForTimeout(800);
    await gan(page);
    await chonSearch(page, '— Chọn ngân hàng —', 'AB Bank');
    await chonSearch(page, '— Gõ tên HKD hoặc số TID —', 'DEMO-TID-02');
    await gan(page);
    const opts = await O(page, 'Loại thẻ').locator('option').allTextContents();
    await O(page, 'Loại thẻ').selectOption({ index: opts.findIndex((x) => /Visa/.test(x)) });
    await page.waitForTimeout(300);
    await dien(page, 'Số lô', ''); // BỎ TRỐNG lô để không vướng cảnh báo trùng/nghịch
    await dien(page, 'Số hóa đơn', '123456');
    await dien(page, 'Trước phí', '999999999999');
    await O(page, 'gio-h').fill('11'); await O(page, 'gio-m').fill('11'); await O(page, 'gio-m').blur();
    await page.waitForTimeout(500);
    const dis = await page.locator('[data-nut="ghibill"]').isDisabled();
    console.log('   nút ghi disabled =', dis);
    if (dis) {
      const cb = await page.evaluate(() => [...document.querySelectorAll('p,span,div')].map((x) => (x.textContent || '').trim()).filter((t) => /TRÙNG|NGHỊCH|chưa đặt|Giờ phải|NGƯỜI HOÀN|Tách thẻ|nhiều hơn/.test(t) && t.length < 250).slice(0, 3));
      throw new Error('nút ghi bị tắt, cảnh báo: ' + JSON.stringify(cb));
    }
    await page.locator('[data-nut="ghibill"]').click();
    await page.waitForTimeout(1100);
    await page.locator('button:has-text("Xong")').first().click().catch(() => {});
    await page.waitForTimeout(600);
    const d = await page.evaluate(() => {
      const t = document.querySelector('[data-kiem="khung-bang"] table');
      const tr = t.querySelector('tbody tr.bg-amber-100') ?? t.querySelector('tbody tr');
      const tds = [...tr.querySelectorAll('td')];
      return {
        truocPhi: (tds[12].textContent || '').trim(), sauPhi: (tds[14].textContent || '').trim(),
        cot: [12, 14, 15].map((i) => ({ ten: i, text: (tds[i].textContent || '').trim(), sw: tds[i].scrollWidth, cw: tds[i].clientWidth, thieu: tds[i].scrollWidth - tds[i].clientWidth })),
        tfoot: [...t.querySelectorAll('tfoot td')].map((x) => ({ text: (x.textContent || '').trim(), sw: x.scrollWidth, cw: x.clientWidth, thieu: x.scrollWidth - x.clientWidth })).filter((x) => /\d/.test(x.text)),
        kpi: [...document.querySelectorAll('div.w-\\[172px\\]')].map((x) => ({ nhan: (x.children[0].textContent || '').trim(), so: (x.children[1].textContent || '').trim(), sw: x.children[1].scrollWidth, cw: x.children[1].clientWidth }))
      };
    });
    console.log('   dòng mới · Trước phí =', d.truocPhi, '· Sau phí bán =', d.sauPhi);
    console.log('   đo ô:', JSON.stringify(d.cot));
    console.log('   hàng TỔNG:', JSON.stringify(d.tfoot));
    console.log('   KPI:', JSON.stringify(d.kpi));
    await anh(page, 'F-12-chu-so.png');
    const cat = [...d.cot, ...d.tfoot, ...d.kpi.map((k) => ({ text: k.nhan + '=' + k.so, sw: k.sw, cw: k.cw, thieu: k.sw - k.cw }))].filter((x) => x.thieu > 0.5);
    if (cat.length)
      finding('NẶNG', 'F-CAT-SO-TIEN', 'Số tiền 12 chữ số làm CẮT MẤT CHỮ SỐ ở cột tiền / hàng TỔNG / ô KPI (không có ellipsis, không có dấu hiệu gì — người đọc thấy số ngắn hơn số thật)', cat.map((x) => `"${x.text}" cần ${x.sw}px chỉ có ${x.cw}px (thiếu ${x.thieu}px)`).join(' · '));
    else ok('F-CAT-SO-TIEN', 'Số 12 chữ số vẫn vừa cột tiền + hàng TỔNG + ô KPI', JSON.stringify(d.cot.map((x) => x.text)) + ' · KPI ' + JSON.stringify(d.kpi.map((k) => k.so)));
  });
  const loi = log.filter((x) => x.type === 'error' || x.type === 'pageerror');
  if (loi.length) finding('NẶNG', 'F-CONSOLE', 'Lỗi console', loi.slice(0, 3).map((x) => x.text.slice(0, 150)).join(' | '));
  await browser.close();
}

console.log('\n  TRẠNG THÁI:', JSON.stringify(THU));
console.log(`=== AUDIT2-F xong · ${FINDINGS.length} finding ===`);
