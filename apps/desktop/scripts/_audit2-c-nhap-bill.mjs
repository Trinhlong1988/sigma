// AUDIT2-C — ĐIỀU KHIỂN THẬT bảng nhập bill. Mỗi phép thử bọc try/catch riêng để 1 phép hỏng không
// nuốt các phép còn lại (R198: phép kiểm ném lỗi PHẢI thành finding, không im lặng).
// Payload đọc bằng cách CHẶN console.log trong trang (JSON) — console preview của Playwright CẮT bớt.
import { moTrang, anh, finding, ok, FINDINGS } from './_audit2-lib.mjs';

const THU = [];
async function thu(ten, fn) {
  console.log(`\n── ${ten} ──`);
  try { await fn(); THU.push([ten, 'chạy']); }
  catch (e) {
    THU.push([ten, 'LỖI PHÉP KIỂM']);
    finding('VỪA', 'C-KIEM-HONG:' + ten, 'PHÉP KIỂM KHÔNG CHẠY ĐƯỢC (không được coi là PASS — R198)', String(e.message).split('\n')[0].slice(0, 200));
  }
}

async function gan(page) {
  await page.evaluate(() => {
    for (const l of document.querySelectorAll('label')) {
      const sp = l.querySelector(':scope > span');
      if (!sp) continue;
      const ten = (sp.textContent || '').replace('*', '').trim();
      const el = l.querySelector(':scope > input, :scope > select, :scope > div input, :scope > div button');
      if (el && ten) el.setAttribute('data-audit', ten);
      if (ten === 'Giờ quẹt') {
        const ii = l.querySelectorAll('input');
        if (ii[0]) ii[0].setAttribute('data-audit', 'gio-h');
        if (ii[1]) ii[1].setAttribute('data-audit', 'gio-m');
      }
    }
  });
}
const O = (page, ten) => page.locator(`[data-audit="${ten}"]`);
async function dien(page, ten, v) {
  const el = O(page, ten);
  await el.click();
  await el.press('Control+a');
  if (String(v) !== '') await el.type(String(v), { delay: 8 });
  else await el.press('Delete');
  await page.waitForTimeout(150);
}
async function chonSearch(page, placeholder, chuoi) {
  const el = page.getByPlaceholder(placeholder);
  await el.click();
  await el.fill('');
  await el.type(chuoi, { delay: 12 });
  await page.waitForTimeout(300);
  const dong = page.locator('li', { hasText: chuoi }).first();
  await dong.waitFor({ state: 'visible', timeout: 8000 });
  await dong.dispatchEvent('mousedown');
  await page.waitForTimeout(350);
}
async function chotSo(page) {
  return page.evaluate(() => {
    const kq = {};
    for (const g of document.querySelectorAll('div.grid.grid-cols-\\[1fr_auto\\]')) {
      const a = g.children[0], b = g.children[1];
      if (a && b) kq[(a.textContent || '').trim()] = (b.textContent || '').trim();
    }
    const code = document.querySelector('code.break-all');
    if (code) kq.__khoaBill = (code.textContent || '').trim();
    return kq;
  });
}
const so = (s) => Number(String(s || '').replace(/[^\d]/g, '') || 0);
const CB = (page, nhan) => page.locator(`label:has-text(${JSON.stringify(nhan)}) input[type=checkbox]`).first();
async function dongPopup(page) {
  for (const n of ['Xong', 'Đóng']) {
    const b = page.locator(`button:has-text("${n}")`).first();
    if (await b.count()) { await b.click().catch(() => {}); await page.waitForTimeout(450); return; }
  }
}
async function moForm(page) {
  if (await page.locator('[data-nut="ghibill"]').count()) { await gan(page); return; }
  await page.locator('[data-nut="them"]').click({ timeout: 10000 });
  await page.waitForTimeout(700);
  await gan(page);
}
const layPayload = (page) => page.evaluate(() => (window.__PL || []).slice(-1)[0] ?? null);

const { browser, page, log } = await moTrang(1920, 1080);
await page.evaluate(() => {
  window.__PL = [];
  const g = console.log.bind(console);
  console.log = (...a) => {
    if (typeof a[0] === 'string' && a[0].includes('payload sẽ gửi')) {
      try { window.__PL.push(JSON.parse(JSON.stringify(a[1], (k, v) => (v === undefined ? '__undefined__' : v)))); }
      catch { window.__PL.push({ loi: 'không serialize được' }); }
    }
    g(...a);
  };
});
console.log('=== AUDIT2-C · NHẬP BILL (điều khiển thật) ===');

// ══════════ 1. TÁCH THẺ ══════════
await thu('1. TÁCH THẺ 100tr = Visa 60tr(1,17%) + JCB 40tr(1,07%)', async () => {
  await moForm(page);
  await chonSearch(page, '— Chọn ngân hàng —', 'AB Bank');
  await chonSearch(page, '— Gõ tên HKD hoặc số TID —', 'DEMO-TID-02');
  await gan(page);
  const opts = await O(page, 'Loại thẻ').locator('option').allTextContents();
  console.log('   loại thẻ:', JSON.stringify(opts));
  await O(page, 'Loại thẻ').selectOption({ index: opts.findIndex((x) => /Visa/.test(x)) });
  await page.waitForTimeout(250);
  await dien(page, 'Số lô', '777');
  await dien(page, 'Số hóa đơn', '555001');
  await dien(page, 'Trước phí', '100000000');
  await page.waitForTimeout(300);
  const truoc = await chotSo(page);
  console.log('   trước khi tách: "Sau phí bán — đại lý nhận" =', truoc['Sau phí bán — đại lý nhận']);
  await CB(page, 'Lô này quẹt NHIỀU loại thẻ').check();
  await page.waitForTimeout(400);
  const sel = page.locator('select.w-56');
  await sel.nth(0).selectOption({ label: 'Visa' });
  await sel.nth(1).selectOption({ label: 'JCB' });
  const o1 = page.locator('input.w-44.text-right:not([readonly])').first();
  await o1.click(); await o1.type('60000000', { delay: 8 });
  await page.waitForTimeout(450);
  const sau = await chotSo(page);
  const man = so(sau['Sau phí bán — đại lý nhận']);
  const DUNG = 100000000 - (Math.round(60000000 * 1170 / 100000) + Math.round(40000000 * 1070 / 100000));
  const conLai = await page.locator('input.w-44[readonly]').first().inputValue();
  console.log(`   sau tách: màn ${man} · đúng ${DUNG} · lệch ${man - DUNG} · dòng cuối tự tính "${conLai}"`);
  await anh(page, 'C1-tach-the.png');
  if (man !== DUNG)
    finding('CHẶN SHIP', 'C1-TACH-THE-SAI-TIEN',
      'TÁCH NHIỀU LOẠI THẺ: "Sau phí bán" vẫn lấy % của MỘT thẻ áp cho CẢ lô (tienPhi = tienLo × phiBanApplied) — không cộng phí từng dòng tách (BillManualEntryPage.tsx:552)',
      `lô 100.000.000 = Visa 60tr@1,17% + JCB 40tr@1,07% → màn hiện ${man.toLocaleString('vi')}đ, đúng ${DUNG.toLocaleString('vi')}đ ⇒ LỆCH ${(man - DUNG).toLocaleString('vi')}đ/lô`);
  else ok('C1-TACH-THE-SAI-TIEN', 'Tách thẻ tính phí đúng', String(man));
});

// ══════════ 2. 0 DẪN ĐẦU + payload ══════════
await thu('2. 0 DẪN ĐẦU số lô "0777" / số HĐ "000555"', async () => {
  await dien(page, 'Số lô', '0777');
  await dien(page, 'Số hóa đơn', '000555');
  await page.waitForTimeout(350);
  const k = await chotSo(page);
  console.log('   khóa bill trên màn:', k.__khoaBill);
  await CB(page, 'Lô này quẹt NHIỀU loại thẻ').uncheck();
  await page.waitForTimeout(250);
  await O(page, 'gio-h').fill('14'); await O(page, 'gio-m').fill('30'); await O(page, 'gio-m').blur();
  await page.waitForTimeout(300);
  const xn = CB(page, 'Tôi đã kiểm tra, đây là bill ĐÚNG');
  if (await xn.count()) await xn.check();
  await page.waitForTimeout(250);
  const ghi = page.locator('[data-nut="ghibill"]');
  console.log('   nút ghi disabled =', await ghi.isDisabled());
  await ghi.click();
  await page.waitForTimeout(1000);
  const p = await layPayload(page);
  console.log('   PAYLOAD:', JSON.stringify(p));
  await anh(page, 'C2-popup.png');
  const pop = await page.evaluate(() => [...document.querySelectorAll('p')].map((x) => (x.textContent || '').trim()).filter((t) => /Đã thêm bill|Về đại lý/.test(t)));
  console.log('   POPUP:', JSON.stringify(pop));
  if (p) {
    if (String(p.bankReportedLoNumber) !== '0777' || String(p.receiptNumber) !== '000555')
      finding('NẶNG', 'C5-0DANDAU',
        'Số lô/số HĐ có 0 DẪN ĐẦU: khóa bill TRÊN MÀN giữ "0777|000555" nhưng payload gửi Number(...) ⇒ khóa chống trùng người nhập THẤY khác khóa máy chủ DỰNG (BillManualEntryPage.tsx:941-942 vs 611)',
        `màn: ${k.__khoaBill} · payload: bankReportedLoNumber=${p.bankReportedLoNumber} (${typeof p.bankReportedLoNumber}), receiptNumber=${p.receiptNumber} (${typeof p.receiptNumber})`);
    else ok('C5-0DANDAU', 'Payload giữ nguyên 0 dẫn đầu', JSON.stringify([p.bankReportedLoNumber, p.receiptNumber]));
    console.log('   lines =', JSON.stringify(p.lines), '· txnDate =', p.txnDate);
  }
  await dongPopup(page);
});

// ══════════ 3. MƯỢN TID sống sót qua đổi TID ══════════
await thu('3. MƯỢN TID — sống sót qua ĐỔI TID', async () => {
  await moForm(page);
  await chonSearch(page, '— Chọn ngân hàng —', 'AB Bank');
  await chonSearch(page, '— Gõ tên HKD hoặc số TID —', 'DEMO-TID-02');
  await gan(page);
  const chuMay = () => page.evaluate(() => {
    const d = [...document.querySelectorAll('div')].find((x) => /^Đại lý cầm TID/.test((x.textContent || '').trim()) && x.children.length === 2);
    return d ? (d.children[1].textContent || '').trim() : '?';
  });
  const chu1 = await chuMay();
  await CB(page, 'Bill này đại lý khác MƯỢN máy').check();
  await page.waitForTimeout(350);
  await chonSearch(page, '— Chọn đại lý mượn —', 'Mạnh');
  await CB(page, 'Xác nhận doanh số bill này ghi cho').check();
  await page.waitForTimeout(300);
  const v1 = (await chotSo(page))['Về đại lý (MƯỢN)'];
  console.log(`   chủ máy DEMO-TID-02 = "${chu1}" · bật mượn "Mạnh" → chốt số = "${v1}"`);
  await anh(page, 'C3-muon-bat.png');
  await chonSearch(page, '— Gõ tên HKD hoặc số TID —', 'DEMO-TID-03');
  await gan(page);
  await page.waitForTimeout(400);
  const conTich = await CB(page, 'Bill này đại lý khác MƯỢN máy').isChecked();
  const chu2 = await chuMay();
  const c2 = await chotSo(page);
  console.log(`   ĐỔI sang TID DEMO-TID-03 (chủ máy "${chu2}") · ô MƯỢN vẫn tích = ${conTich} · chốt số = ${JSON.stringify(c2['Về đại lý (MƯỢN)'] ?? c2['Về đại lý'])}`);
  await anh(page, 'C3-muon-sau-doi-tid.png');
  if (conTich)
    finding('NẶNG', 'C3-MUON-SONG-SOT',
      'Cờ MƯỢN TID + đại lý mượn + ô xác nhận SỐNG SÓT qua ĐỔI TID (onChange ô TID chỉ setTidId/setCardTypeId — BillManualEntryPage.tsx:1512-1516) ⇒ bill của máy MỚI âm thầm ghi doanh số về nhà mượn của máy CŨ',
      `chủ máy "${chu1}" → "${chu2}" mà ô mượn vẫn tích; chốt số vẫn "Về đại lý (MƯỢN)" = ${JSON.stringify(c2['Về đại lý (MƯỢN)'])}`);
  else ok('C3-MUON-SONG-SOT', 'Đổi TID tắt cờ mượn', 'checked=false');
});

// ══════════ 4. POPUP sai nhà khi mượn ══════════
await thu('4. POPUP "Đã thêm bill" báo nhà nào khi MƯỢN TID', async () => {
  await gan(page);
  await O(page, 'Loại phí').selectOption({ label: 'Tiền chờ' });
  await page.waitForTimeout(500);
  await gan(page);
  const opts = await O(page, 'Loại thẻ').locator('option').allTextContents();
  console.log('   loại thẻ (Tiền chờ):', JSON.stringify(opts));
  const i = opts.findIndex((x) => /bán \d/.test(x));
  if (i < 0) throw new Error('TID DEMO-TID-03 không có thẻ nào đã đặt giá bán ở loại phí Tiền chờ');
  await O(page, 'Loại thẻ').selectOption({ index: i });
  await page.waitForTimeout(300);
  await dien(page, 'Số lô', '888');
  await dien(page, 'Số hóa đơn', '888001');
  await dien(page, 'Trước phí', '50000000');
  await O(page, 'gio-h').fill('13'); await O(page, 'gio-m').fill('45'); await O(page, 'gio-m').blur();
  await page.waitForTimeout(400);
  const cb = CB(page, 'Bill này đại lý khác MƯỢN máy');
  if (!(await cb.isChecked())) await cb.check();
  await page.waitForTimeout(250);
  const oM = page.getByPlaceholder('— Chọn đại lý mượn —');
  if (await oM.count()) { const v = await oM.inputValue(); if (!v) await chonSearch(page, '— Chọn đại lý mượn —', 'Đại lý C'); }
  const cbX = CB(page, 'Xác nhận doanh số bill này ghi cho');
  if ((await cbX.count()) && !(await cbX.isChecked())) await cbX.check();
  const xn = CB(page, 'Tôi đã kiểm tra, đây là bill ĐÚNG');
  if (await xn.count()) await xn.check();
  await page.waitForTimeout(350);
  const veNha = (await chotSo(page))['Về đại lý (MƯỢN)'];
  const ghi = page.locator('[data-nut="ghibill"]');
  console.log(`   chốt số "Về đại lý (MƯỢN)" = "${veNha}" · nút ghi disabled = ${await ghi.isDisabled()}`);
  await ghi.click();
  await page.waitForTimeout(1000);
  const p = await layPayload(page);
  const pop = await page.evaluate(() => [...document.querySelectorAll('p')].map((x) => (x.textContent || '').trim()).filter((t) => /Đã thêm bill|Về đại lý/.test(t)));
  console.log('   POPUP:', JSON.stringify(pop), '· payload borrowedByCustomerId =', p?.borrowedByCustomerId);
  await anh(page, 'C4-popup-muon.png');
  const nhaPopup = (pop.find((t) => /^Về đại lý/.test(t)) || '').replace(/^Về đại lý\s*/, '').split('·')[0].trim();
  if (nhaPopup && veNha && nhaPopup !== veNha)
    finding('NẶNG', 'C6-POPUP-SAI-NHA',
      'Popup "Đã thêm bill" báo SAI NHÀ khi mượn TID: in tid.customerName (CHỦ MÁY) thay vì veNha (nhà MƯỢN) — setKetQua({ daiLy: tid.customerName }) BillManualEntryPage.tsx:995',
      `bill ghi về "${veNha}" (payload borrowedByCustomerId=${p?.borrowedByCustomerId}) nhưng popup báo "${nhaPopup}"`);
  else ok('C6-POPUP-SAI-NHA', 'Popup báo đúng nhà', `${nhaPopup} = ${veNha}`);
  await dongPopup(page);
  const dongMoi = await page.evaluate(() => {
    const tr = document.querySelector('tbody tr.bg-amber-100');
    return tr ? [...tr.querySelectorAll('td')].map((t) => (t.textContent || '').trim()) : null;
  });
  console.log('   dòng mới trong bảng: Đại lý =', JSON.stringify(dongMoi && dongMoi[4]), '· Ghi chú =', JSON.stringify(dongMoi && dongMoi[dongMoi.length - 1]));
});

// ══════════ 5. Ô TIỀN ══════════
await thu('5. Ô TIỀN: dấu âm · trộn chữ-số · 17 chữ số · 12 chữ số trong bảng', async () => {
  await moForm(page);
  await chonSearch(page, '— Chọn ngân hàng —', 'AB Bank');
  await chonSearch(page, '— Gõ tên HKD hoặc số TID —', 'DEMO-TID-02');
  await gan(page);
  const opts = await O(page, 'Loại thẻ').locator('option').allTextContents();
  await O(page, 'Loại thẻ').selectOption({ index: opts.findIndex((x) => /Visa/.test(x)) });
  await page.waitForTimeout(250);

  await dien(page, 'Trước phí', '-5000000');
  let v = await O(page, 'Trước phí').inputValue();
  console.log(`   "-5000000" → "${v}"`);
  if (!/^[−-]/.test(v)) finding('VỪA', 'C20-AM', 'Ô tiền NUỐT dấu âm: "-5000000" thành 5.000.000 (dương) mà không báo gì (replace(/[^\\d]/g,"") — BillManualEntryPage.tsx:1697)', `gõ "-5000000" → ô hiện "${v}"`);

  await dien(page, 'Trước phí', '12abc34');
  v = await O(page, 'Trước phí').inputValue();
  console.log(`   "12abc34" → "${v}"`);
  if (v.replace(/\./g, '') === '1234') finding('VỪA', 'C20-TRON-CHU', 'Ô tiền GHÉP 2 cụm số hai bên chữ thành số khác: "12abc34" → 1.234 (không chặn, không cắt)', `"12abc34" → "${v}"`);

  await dien(page, 'Trước phí', '99999999999999999');
  v = await O(page, 'Trước phí').inputValue();
  await page.waitForTimeout(400);
  const c = await chotSo(page);
  const doRong = await page.evaluate(() => { const i = document.querySelector('[data-audit="Trước phí"]'); return { sw: i.scrollWidth, cw: i.clientWidth }; });
  const nSo = v.replace(/\D/g, '').length;
  const n17 = Number(v.replace(/\D/g, ''));
  console.log(`   17 chữ số → ô "${v}" (${nSo} số) · ô thiếu ${doRong.sw - doRong.cw}px · doanh số "${c['Doanh số ghi (đã trừ hủy)']}" · sau phí "${c['Sau phí bán — đại lý nhận']}"`);
  await anh(page, 'C5-17-chu-so.png');
  if (nSo >= 17)
    finding('NẶNG', 'C11-17-CHU-SO',
      'Ô tiền KHÔNG có maxLength/trần tiền: gõ 17 chữ số vẫn nhận, Number() vượt MAX_SAFE_INTEGER ⇒ giá trị SAI ngay từ client; ghiNhan() chỉ kiểm Number.isInteger (vẫn true với 1e17) nên KHÔNG chặn (BillManualEntryPage.tsx:905-907, 1694-1699)',
      `gõ 99.999.999.999.999.999 (${nSo} số) · Number = ${n17} (MAX_SAFE_INTEGER = ${Number.MAX_SAFE_INTEGER}) · SAI ${n17 - 99999999999999999}đ · ô nhập tràn ${doRong.sw - doRong.cw}px`);

  await dien(page, 'Trước phí', '999999999999');
  await dien(page, 'Số lô', '910');
  await dien(page, 'Số hóa đơn', '910001');
  await O(page, 'gio-h').fill('10'); await O(page, 'gio-m').fill('10'); await O(page, 'gio-m').blur();
  await page.waitForTimeout(400);
  const xn = CB(page, 'Tôi đã kiểm tra, đây là bill ĐÚNG');
  if (await xn.count()) await xn.check();
  await page.waitForTimeout(250);
  const ghi = page.locator('[data-nut="ghibill"]');
  if (await ghi.isDisabled()) { console.log('   (nút ghi disabled — bỏ phần đo cột bảng)'); return; }
  await ghi.click();
  await page.waitForTimeout(1000);
  await dongPopup(page);
  const d = await page.evaluate(() => {
    const t = document.querySelector('[data-kiem="khung-bang"] table');
    const tr = t.querySelector('tbody tr.bg-amber-100') ?? t.querySelector('tbody tr');
    const tds = [...tr.querySelectorAll('td')];
    return {
      cot: [12, 14, 15].map((i) => ({ i, text: (tds[i].textContent || '').trim(), sw: tds[i].scrollWidth, cw: tds[i].clientWidth, thieu: tds[i].scrollWidth - tds[i].clientWidth })),
      tfoot: [...t.querySelectorAll('tfoot td')].map((x) => ({ text: (x.textContent || '').trim(), sw: x.scrollWidth, cw: x.clientWidth, thieu: x.scrollWidth - x.clientWidth })).filter((x) => /\d/.test(x.text))
    };
  });
  console.log('   dòng 12 chữ số:', JSON.stringify(d.cot));
  console.log('   hàng TỔNG:', JSON.stringify(d.tfoot));
  await anh(page, 'C5-12-chu-so-bang.png');
  const cat = [...d.cot, ...d.tfoot].filter((x) => x.thieu > 0.5);
  if (cat.length)
    finding('NẶNG', 'C4-CAT-SO-TIEN', 'Cột tiền 129px CẮT MẤT CHỮ SỐ với số tiền 12 chữ số (và hàng TỔNG cũng tràn) — không có overflow/ellipsis nên số bị che KHÔNG có dấu hiệu gì', cat.map((x) => `"${x.text}" cần ${x.sw}px chỉ có ${x.cw}px (thiếu ${x.thieu}px)`).join(' · '));
  else ok('C4-CAT-SO-TIEN', 'Số 12 chữ số vẫn vừa cột tiền', JSON.stringify(d.cot.map((x) => x.text)));
});

// ══════════ 6. TRÙNG bill chỉ có SỐ HÓA ĐƠN ══════════
await thu('6. TRÙNG y nguyên mà BỎ TRỐNG số lô (chỉ có số HĐ)', async () => {
  await moForm(page);
  await chonSearch(page, '— Chọn ngân hàng —', 'MBV');
  await chonSearch(page, '— Gõ tên HKD hoặc số TID —', 'DEMO-TID-01');
  await gan(page);
  const opts = await O(page, 'Loại thẻ').locator('option').allTextContents();
  await O(page, 'Loại thẻ').selectOption({ index: opts.findIndex((x) => /Visa/.test(x)) });
  await page.waitForTimeout(250);
  await dien(page, 'Số lô', '');
  await dien(page, 'Số hóa đơn', '000118');
  await dien(page, 'Trước phí', '30000000');
  await O(page, 'gio-h').fill('09'); await O(page, 'gio-m').fill('14'); await O(page, 'gio-m').blur();
  await page.waitForTimeout(500);
  const c = await chotSo(page);
  const canhBao = await page.evaluate(() => [...document.querySelectorAll('p')].map((x) => (x.textContent || '').trim()).filter((t) => /TRÙNG HOÀN TOÀN|TRÙNG SỐ LÔ|NGHỊCH THỨ TỰ/.test(t)));
  const ghi = page.locator('[data-nut="ghibill"]');
  console.log('   bill y nguyên m1 (TID DEMO-TID-01 · HĐ 000118 · 30tr · hôm nay 09:14) nhưng BỎ TRỐNG lô');
  console.log('   khóa bill:', c.__khoaBill, '· cảnh báo:', JSON.stringify(canhBao.slice(0, 2)).slice(0, 200));
  console.log('   nút ghi disabled =', await ghi.isDisabled());
  await anh(page, 'C6-trung-khong-lo.png');
  if (canhBao.length === 0)
    finding('NẶNG', 'C4-TRUNG-KHONG-LO',
      'Bill TRÙNG Y NGUYÊN (cùng TID + ngày + tiền + số HĐ) mà BỎ TRỐNG số lô thì KHÔNG cảnh báo gì: cả 3 mức cảnh báo đều so b.lo === loHienThi(soLo,maDongLo) — lô trống thành "" nên không bao giờ khớp; SỐ HÓA ĐƠN không tham gia so trùng (BillManualEntryPage.tsx:574-586)',
      `nút "Ghi nhận bill" bật (disabled=${await ghi.isDisabled()}), 0/3 cảnh báo hiện ra, khóa bill = ${c.__khoaBill}`);
  else ok('C4-TRUNG-KHONG-LO', 'Có cảnh báo trùng khi bỏ trống lô', JSON.stringify(canhBao[0]).slice(0, 140));
});

// ══════════ 7. NGHỊCH THỨ TỰ báo oan ══════════
await thu('7. NGHỊCH THỨ TỰ: giờ mặc định 00:00 báo oan', async () => {
  await gan(page);
  await dien(page, 'Số lô', '500');
  await dien(page, 'Số hóa đơn', '500001');
  await dien(page, 'Trước phí', '1000000');
  await O(page, 'gio-h').fill('00'); await O(page, 'gio-m').fill('00'); await O(page, 'gio-m').blur();
  await page.waitForTimeout(500);
  const cb = await page.evaluate(() => [...document.querySelectorAll('p')].map((x) => (x.textContent || '').trim()).filter((t) => /NGHỊCH THỨ TỰ/.test(t)));
  console.log('   lô 500 @00:00 →', JSON.stringify(cb).slice(0, 350));
  await anh(page, 'C7-nghich-thu-tu.png');
  if (cb.length)
    finding('VỪA', 'C17-NGHICH-OAN',
      'Cảnh báo "NGHỊCH THỨ TỰ LÔ ↔ GIỜ" báo OAN vì GIỜ mặc định form là 00:00: lô mới (số lớn) luôn "giờ sớm hơn" mọi lô cũ ⇒ phải tích xác nhận MỖI bill, cảnh báo mất tác dụng (nghichThuTu dòng 583-589 + gio mặc định dòng 384)',
      `lô 500 lúc 00:00, chưa sửa gì → ${JSON.stringify(cb[0]).slice(0, 240)}`);
  else ok('C17-NGHICH-OAN', 'Giờ 00:00 không báo oan nghịch thứ tự', '0 cảnh báo');
});

// ══════════ 8. GIỜ: thu nhỏ/mở lại · xóa trống ══════════
await thu('8. GIỜ: thu nhỏ → mở lại · xóa trống ô giờ', async () => {
  await gan(page);
  await O(page, 'gio-h').fill('25'); await page.waitForTimeout(350);
  const loi25 = await page.evaluate(() => [...document.querySelectorAll('span')].map((x) => (x.textContent || '').trim()).filter((t) => /Giờ phải từ|Phút phải từ/.test(t)));
  console.log('   gõ giờ "25" →', JSON.stringify(loi25), '· nút ghi disabled =', await page.locator('[data-nut="ghibill"]').isDisabled());
  await page.locator('[data-nut="thunho"]').click();
  await page.waitForTimeout(450);
  await page.locator('button:has-text("Mở lại")').click();
  await page.waitForTimeout(650);
  await gan(page);
  const h = await O(page, 'gio-h').inputValue(), mi = await O(page, 'gio-m').inputValue();
  const loiSau = await page.evaluate(() => [...document.querySelectorAll('span')].map((x) => (x.textContent || '').trim()).filter((t) => /Giờ phải từ|Phút phải từ/.test(t)));
  console.log(`   sau thu nhỏ → mở lại: ô giờ "${h}:${mi}" · cảnh báo ${loiSau.length ? 'còn' : 'MẤT'}`);
  await anh(page, 'C8-thu-nho-mo-lai.png');
  if (h !== '25')
    finding('VỪA', 'C15-THUNHO-SUA-GIO',
      'Thu nhỏ → Mở lại ÂM THẦM SỬA giờ đang sai: GioInput bị unmount/mount lại nên khởi tạo từ `value` (đã bị bao() kẹp về 23) ⇒ số người nhập gõ bị đổi mà KHÔNG báo gì — giờ quyết định bill rơi vào ngày/ca nào (BillManualEntryPage.tsx:110-112)',
      `gõ "25" (đang báo đỏ) → thu nhỏ → mở lại → ô giờ thành "${h}:${mi}", cảnh báo ${loiSau.length ? 'còn' : 'MẤT'}`);
  else ok('C15-THUNHO-SUA-GIO', 'Thu nhỏ/mở lại giữ nguyên giờ đang gõ', `${h}:${mi}`);

  await O(page, 'gio-h').fill(''); await O(page, 'gio-m').fill('');
  await page.waitForTimeout(450);
  const hh = await O(page, 'gio-h').inputValue(), mm2 = await O(page, 'gio-m').inputValue();
  const dis = await page.locator('[data-nut="ghibill"]').isDisabled();
  const c = await chotSo(page);
  console.log(`   xóa trống ô giờ → "${hh}:${mm2}" · nút ghi disabled = ${dis} · khóa bill = ${c.__khoaBill}`);
  await anh(page, 'C8-gio-trong.png');
  if (!dis)
    finding('VỪA', 'C16-GIO-TRONG',
      'XÓA TRỐNG ô giờ KHÔNG chặn ghi: hRaw/mRaw rỗng không báo onLoi, `gio` giữ giá trị CŨ (bao() chỉ gọi khi v!==""), dayDu vẫn true ⇒ ghi được bill với giờ KHÁC giờ người nhập đang thấy (BillManualEntryPage.tsx:159-170)',
      `2 ô giờ rỗng "${hh}:${mm2}" mà nút Ghi nhận vẫn bật (disabled=${dis}); khóa bill vẫn dựng = ${c.__khoaBill}`);
  else ok('C16-GIO-TRONG', 'Ô giờ rỗng chặn ghi', `disabled=${dis}`);
});

// ══════════ 9. "Xóa" / "Đóng, bỏ dữ liệu" không tắt TÁCH THẺ ══════════
await thu('9. "Xóa" và "Đóng, bỏ dữ liệu" có tắt TÁCH THẺ?', async () => {
  await gan(page);
  await CB(page, 'Lô này quẹt NHIỀU loại thẻ').check();
  await page.waitForTimeout(450);
  console.log('   bật tách thẻ, số dòng =', await page.locator('select.w-56').count());
  await page.locator('[data-nut="xoaform"]').click();
  await page.waitForTimeout(650);
  const conTach = await CB(page, 'Lô này quẹt NHIỀU loại thẻ').isChecked();
  const nDong = await page.locator('select.w-56').count();
  console.log(`   sau "Xóa": tách thẻ tích = ${conTach} · còn ${nDong} dòng tách`);
  await anh(page, 'C9-xoa-form-tach-the.png');
  if (conTach)
    finding('VỪA', 'C14-XOA-KHONG-TAT-TACH',
      'Nút "Xóa" (xoaForm) KHÔNG tắt TÁCH THẺ: reset TID/thẻ/số liệu nhưng để nguyên tachThe + dongThe ⇒ bill kế thừa cấu hình tách của bill trước, dòng tách còn giữ thẻ của NGÂN HÀNG CŨ; coDuLieu cũng vẫn true (dòng 613) nên đóng form còn bị hỏi lại (BillManualEntryPage.tsx:880-889)',
      `sau "Xóa": tachThe=${conTach}, còn ${nDong} dòng tách`);
  else ok('C14-XOA-KHONG-TAT-TACH', 'Nút Xóa tắt tách thẻ', 'unchecked');

  await page.locator('button[title="Đóng"]').first().click().catch(() => {});
  await page.waitForTimeout(550);
  const coHoi = await page.locator('text=Đóng phần nhập bill?').count();
  console.log('   bấm X → hộp "Đóng phần nhập bill?" =', coHoi > 0);
  if (coHoi) {
    await page.locator('button:has-text("Đóng, bỏ dữ liệu")').click();
    await page.waitForTimeout(650);
    await page.locator('[data-nut="them"]').click();
    await page.waitForTimeout(750);
    const tach2 = await CB(page, 'Lô này quẹt NHIỀU loại thẻ').isChecked();
    console.log('   form mới sau "Đóng, bỏ dữ liệu": tách thẻ tích =', tach2);
    if (tach2) finding('VỪA', 'C14b-DONG-KHONG-TAT-TACH', '"Đóng, bỏ dữ liệu" cũng KHÔNG tắt tách thẻ — form mới vẫn còn bật', `tachThe=${tach2}`);
    else ok('C14b-DONG-KHONG-TAT-TACH', '"Đóng, bỏ dữ liệu" đã tắt tách thẻ', 'unchecked');
  }
});

const loi = log.filter((x) => x.type === 'error' || x.type === 'pageerror');
console.log(`\n  console error/pageerror: ${loi.length}`);
loi.slice(0, 6).forEach((x) => console.log('   ', x.type, x.text.slice(0, 250)));
if (loi.length) finding('NẶNG', 'C-CONSOLE', 'Lỗi console/pageerror khi điều khiển bảng nhập', loi.slice(0, 3).map((x) => x.text.slice(0, 150)).join(' | '));

console.log('\n  TRẠNG THÁI 9 phép thử:', JSON.stringify(THU));
console.log(`=== AUDIT2-C xong · ${FINDINGS.length} finding ===`);
await browser.close();
