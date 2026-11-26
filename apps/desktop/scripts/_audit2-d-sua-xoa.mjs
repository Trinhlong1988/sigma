// AUDIT2-D — SỬA bill · XÓA hàng loạt · NGƯỠNG 10 bill/ngày · hộp xóa · popup Excel · ô xác nhận giữ tích
// · kỳ tự nhảy sau 60s · MultiSelect nhãn. ĐIỀU KHIỂN THẬT + chẩn đoán vì sao nút ghi bị tắt.
import { moTrang, anh, docBang, finding, ok, FINDINGS } from './_audit2-lib.mjs';

const THU = [];
async function thu(ten, fn) {
  console.log(`\n── ${ten} ──`);
  try { await fn(); THU.push([ten, 'chạy']); }
  catch (e) { THU.push([ten, 'LỖI PHÉP KIỂM']); finding('VỪA', 'D-KIEM-HONG:' + ten, 'PHÉP KIỂM KHÔNG CHẠY ĐƯỢC (R198: không coi là PASS)', String(e.message).split('\n')[0].slice(0, 200)); }
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
const CB = (page, n) => page.locator(`label:has-text(${JSON.stringify(n)}) input[type=checkbox]`).first();
async function dien(page, t, v) { const e = O(page, t); await e.click(); await e.press('Control+a'); if (String(v) !== '') await e.type(String(v), { delay: 8 }); else await e.press('Delete'); await page.waitForTimeout(150); }
/** Chẩn đoán vì sao nút "Ghi nhận bill" bị tắt — đọc từng ô trên màn. */
async function chanDoan(page) {
  return page.evaluate(() => {
    const g = (s) => document.querySelector(`[data-audit="${s}"]`);
    const txt = (sel, re) => [...document.querySelectorAll(sel)].map((x) => (x.textContent || '').trim()).filter((t) => re.test(t));
    return {
      tid: g('TID (máy POS)') ? g('TID (máy POS)').value : document.querySelector('input[placeholder*="HKD hoặc số TID"]')?.value,
      loaiThe: g('Loại thẻ')?.value, loaiPhi: g('Loại phí')?.value,
      soLo: g('Số lô')?.value, soHd: g('Số hóa đơn')?.value,
      truocPhi: g('Trước phí')?.value, tienHuy: g('Tiền hủy')?.value, daHoan: g('Đã hoàn')?.value,
      gio: (g('gio-h')?.value ?? '') + ':' + (g('gio-m')?.value ?? ''),
      ngay: g('Ngày trên bill')?.value,
      canhBao: txt('p,div', /TRÙNG HOÀN TOÀN|TRÙNG SỐ LÔ|NGHỊCH THỨ TỰ|chưa đặt giá bán|Tách thẻ|nhiều hơn số đại lý|Giờ phải từ|Phút phải từ|phải chọn NGƯỜI HOÀN|Mỗi dòng phải chọn/.test(t) && t.length < 300).slice(0, 5),
      coOXacNhan: !!document.querySelector('input.accent-danger, input.accent-warning'),
      tichXacNhan: [...document.querySelectorAll('label')].filter((l) => /Tôi đã kiểm tra/.test(l.textContent || '')).map((l) => l.querySelector('input').checked),
      tachThe: [...document.querySelectorAll('label')].filter((l) => /Lô này quẹt NHIỀU/.test(l.textContent || '')).map((l) => l.querySelector('input').checked),
      muon: [...document.querySelectorAll('label')].filter((l) => /đại lý khác MƯỢN máy/.test(l.textContent || '')).map((l) => l.querySelector('input').checked),
      ghiDisabled: document.querySelector('[data-nut="ghibill"]')?.disabled
    };
  });
}
async function chonSearch(page, ph, s) {
  const el = page.getByPlaceholder(ph);
  await el.click(); await el.fill(''); await el.type(s, { delay: 12 });
  await page.waitForTimeout(300);
  const d = page.locator('li', { hasText: s }).first();
  await d.waitFor({ state: 'visible', timeout: 8000 });
  await d.dispatchEvent('mousedown');
  await page.waitForTimeout(350);
}

const { browser, page, log } = await moTrang(1920, 1080);
await page.evaluate(() => { window.__PL = []; const g = console.log.bind(console); console.log = (...a) => { if (typeof a[0] === 'string' && a[0].includes('payload sẽ gửi')) { try { window.__PL.push(JSON.parse(JSON.stringify(a[1], (k, v) => (v === undefined ? '__undefined__' : v)))); } catch { /* bỏ */ } } g(...a); }; });
console.log('=== AUDIT2-D · SỬA / XÓA / NGƯỠNG / KỲ ===');

// ══════════ 1. SỬA bill → báo oan "TRÙNG HOÀN TOÀN" với chính nó + không nạp NGƯỜI HOÀN ══════════
await thu('1. Bấm Sửa bill m1 (lô 82, đã hoàn 29.625.000 bởi Nhân viên A)', async () => {
  const truocKhiSua = await page.evaluate(() => {
    const t = document.querySelector('[data-kiem="khung-bang"] table');
    const tr = [...t.querySelectorAll('tbody tr')].find((r) => /\b82\b/.test((r.querySelectorAll('td')[10]?.textContent || '')));
    return tr ? [...tr.querySelectorAll('td')].map((x) => (x.textContent || '').trim()) : null;
  });
  console.log('   dòng bill lô 82 trong bảng:', JSON.stringify(truocKhiSua && { lo: truocKhiSua[10], truocPhi: truocKhiSua[12], daHoan: truocKhiSua[15], nguoiHoan: truocKhiSua[16] }));
  await page.locator('button[title="Sửa bill lô 82"]').first().click();
  await page.waitForTimeout(900);
  await gan(page);
  const d = await chanDoan(page);
  console.log('   sau khi mở Sửa:', JSON.stringify(d, null, 0));
  await anh(page, 'D1-sua-bill-82.png');
  const trungOan = d.canhBao.some((t) => /TRÙNG HOÀN TOÀN/.test(t));
  if (trungOan)
    finding('NẶNG', 'D12-SUA-BAO-OAN-TRUNG',
      'Bấm "Sửa" 1 bill thì màn báo oan "TRÙNG HOÀN TOÀN" với CHÍNH NÓ: billTrung quét cả `danhSach` mà không loại trừ bill đang sửa (không có state "đang sửa id") ⇒ người sửa buộc phải tích "Tôi đã kiểm tra… vẫn ghi", biến cảnh báo trùng thành thao tác vô nghĩa (BillManualEntryPage.tsx:574-578, suaBill 863-879)',
      `mở Sửa bill lô 82 (không đổi gì) → cảnh báo: ${JSON.stringify(d.canhBao.filter((t) => /TRÙNG/.test(t))[0]).slice(0, 220)}`);
  else ok('D12-SUA-BAO-OAN-TRUNG', 'Sửa bill không báo oan trùng', JSON.stringify(d.canhBao));

  // NGƯỜI HOÀN có được nạp lại không?
  const nh = await page.getByPlaceholder('— Kế toán / Admin —').inputValue().catch(() => '(không đọc được)');
  const dsNh = await page.evaluate(() => {
    const i = document.querySelector('input[placeholder="— Kế toán / Admin —"]');
    return { value: i?.value ?? null, disabled: i?.disabled ?? null };
  });
  console.log(`   ô "Đã hoàn" = "${d.daHoan}" · ô NGƯỜI HOÀN = "${nh}" (${JSON.stringify(dsNh)})`);
  if ((Number(String(d.daHoan).replace(/\D/g, '')) || 0) > 0 && !nh)
    finding('NẶNG', 'D13-SUA-MAT-NGUOI-HOAN',
      'Sửa bill NẠP LẠI số "Đã hoàn" nhưng KHÔNG nạp NGƯỜI HOÀN (suaBill không setNguoiHoanId — BillManualEntryPage.tsx:863-879) ⇒ nút ghi bị chặn bởi chính luật "có tiền hoàn phải có người hoàn", và nếu người sửa chọn lại thì VẾT ai trả bị GHI ĐÈ sang người khác',
      `bill lô 82 đã hoàn ${d.daHoan} bởi "Nhân viên A" → sau khi mở Sửa, ô Người hoàn = "${nh}" (rỗng); nút ghi disabled=${d.ghiDisabled}`);
  else ok('D13-SUA-MAT-NGUOI-HOAN', 'Sửa bill nạp lại người hoàn', nh);

  // ngưỡng có cộng ngay lúc MỞ form Sửa?
  console.log('   → kiểm ngưỡng: mở Sửa 10 lần xem có bị chặn dù chưa sửa gì');
});

// ══════════ 2. NGƯỠNG 10 bill/ngày cộng NGAY khi MỞ form Sửa ══════════
await thu('2. NGƯỠNG 10 bill/ngày — cộng ngay lúc MỞ form Sửa (chưa sửa gì)', async () => {
  // đóng form đang mở
  await page.locator('button[title="Đóng"]').first().click().catch(() => {});
  await page.waitForTimeout(400);
  const hoi = page.locator('button:has-text("Đóng, bỏ dữ liệu")');
  if (await hoi.count()) { await hoi.click(); await page.waitForTimeout(500); }
  let chan = null;
  for (let i = 0; i < 12; i++) {
    const nut = page.locator('button[title^="Sửa bill lô"]').nth(i % 6);
    await nut.click();
    await page.waitForTimeout(400);
    const toast = await page.evaluate(() => [...document.querySelectorAll('div')].map((x) => (x.textContent || '').trim()).filter((t) => /Vượt ngưỡng|đã sửa\/xóa/.test(t) && t.length < 300)[0] ?? null);
    if (toast) { chan = { lan: i + 1, toast }; break; }
    await page.locator('button[title="Đóng"]').first().click().catch(() => {});
    await page.waitForTimeout(350);
    const h2 = page.locator('button:has-text("Đóng, bỏ dữ liệu")');
    if (await h2.count()) { await h2.click(); await page.waitForTimeout(400); }
  }
  console.log('   kết quả:', JSON.stringify(chan));
  await anh(page, 'D2-nguong-10-bill.png');
  if (chan)
    finding('VỪA', 'D10-NGUONG-MO-FORM',
      'Ngưỡng 10 bill/ngày CỘNG NGAY lúc MỞ form Sửa (setDaSuaXoaHomNay(x=>x+1) đầu suaBill) chứ không phải lúc GHI ⇒ chỉ cần MỞ xem 11 bill (không sửa gì) là bị chặn; thêm nữa `daSuaXoaHomNay` chỉ là useState nên F5 là về 0 — ngưỡng bảo mật vô hiệu (BillManualEntryPage.tsx:852-862)',
      `mở form Sửa ${chan.lan} lần (không sửa gì, không ghi gì) → bị chặn: "${String(chan.toast).slice(0, 180)}"`);
  else ok('D10-NGUONG-MO-FORM', 'Mở Sửa 12 lần không bị chặn oan', '12 lần');
  // F5 → mất đếm
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('tbody tr');
  await page.waitForTimeout(600);
  const sauF5 = await page.evaluate(() => !!document.querySelector('button[title^="Sửa bill lô"]'));
  console.log('   sau F5: nút Sửa còn dùng được =', sauF5, '(đếm daSuaXoaHomNay về 0 vì chỉ là useState)');
});

// ══════════ 3. XÓA bill không nhìn thấy: tích "Chọn tất cả" rồi đổi lọc rồi XÓA THẬT ══════════
await thu('3. Tích "Chọn tất cả" → đổi lọc → XÓA THẬT: bill nào biến mất?', async () => {
  await page.locator('input[aria-label="Từ ngày"]').fill('2026-01-01');
  await page.locator('input[aria-label="Đến ngày"]').fill('2026-12-31');
  await page.waitForTimeout(350);
  const truoc = await docBang(page);
  await page.locator('input[aria-label="Chọn tất cả"]').check();
  await page.waitForTimeout(300);
  const el = page.getByPlaceholder('Số lô', { exact: true });
  await el.click(); await el.type('82', { delay: 15 });
  await page.waitForTimeout(350);
  const dangThay = await docBang(page);
  const nut = (await page.locator('[data-nut="xoabill"]').innerText()).trim();
  console.log(`   toàn kỳ ${truoc.rows.length} bill → tích tất cả → lọc lô 82 còn ${dangThay.rows.length} bill hiện · nút: "${nut}"`);
  await page.locator('[data-nut="xoabill"]').click();
  await page.waitForTimeout(500);
  const hopXoa = await page.evaluate(() => {
    const h = [...document.querySelectorAll('div,h3,p')].map((x) => (x.textContent || '').trim()).filter((t) => /Xóa \d+ bill\?|Bill là chứng từ tiền/.test(t) && t.length < 400);
    return h.slice(0, 3);
  });
  console.log('   HỘP XÓA:', JSON.stringify(hopXoa));
  await anh(page, 'D3-hop-xoa.png');
  const mk = page.locator('input[type=password]');
  if (await mk.count()) {
    await mk.fill('matkhau123');
    await page.locator('button:has-text("Xóa bill")').last().click();
    await page.waitForTimeout(900);
  }
  await el.fill('');
  await page.waitForTimeout(450);
  const sau = await docBang(page);
  console.log(`   sau khi xóa: toàn kỳ còn ${sau.rows.length} bill (trước ${truoc.rows.length}) ⇒ đã xóa ${truoc.rows.length - sau.rows.length} bill`);
  await anh(page, 'D3-sau-xoa.png');
  if (truoc.rows.length - sau.rows.length > dangThay.rows.length)
    finding('CHẶN SHIP', 'D2-XOA-BILL-VO-HINH',
      'XÓA BILL KHÔNG NHÌN THẤY: tích "Chọn tất cả" rồi đổi bộ lọc, daTich vẫn giữ id của tập CŨ ⇒ bấm "Xóa N bill" xóa cả bill KHÔNG hiện trên màn. Đây là thao tác MẤT CHỨNG TỪ TIỀN, chỉ chặn bằng ô mật khẩu ở client (BillManualEntryPage.tsx:1346 tbody-checkbox + xoaDaTich 842-854)',
      `tích tất cả ở toàn kỳ (${truoc.rows.length} bill) → lọc còn ${dangThay.rows.length} bill hiện → bấm "${nut}" → thực tế BIẾN MẤT ${truoc.rows.length - sau.rows.length} bill (${truoc.rows.length - sau.rows.length - dangThay.rows.length} bill vô hình)`);
  else ok('D2-XOA-BILL-VO-HINH', 'Xóa đúng số bill đang thấy', `${truoc.rows.length - sau.rows.length} = ${dangThay.rows.length}`);
});

// ══════════ 4. Thông điệp hộp xóa in daSuaXoaHomNay (tự mâu thuẫn) ══════════
await thu('4. Thông điệp hộp xóa dùng số nào', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('tbody tr');
  await page.waitForTimeout(600);
  await page.locator('input[aria-label="Từ ngày"]').fill('2026-01-01');
  await page.locator('input[aria-label="Đến ngày"]').fill('2026-12-31');
  await page.waitForTimeout(350);
  await page.locator('input[aria-label="Chọn tất cả"]').check(); // 80 bill > ngưỡng 10
  await page.waitForTimeout(300);
  await page.locator('[data-nut="xoabill"]').click();
  await page.waitForTimeout(500);
  const t = await page.evaluate(() => [...document.querySelectorAll('div,p,h3')].map((x) => (x.textContent || '').trim()).filter((s) => /Bill là chứng từ tiền|Xóa \d+ bill\?|CẢNH BÁO/.test(s) && s.length < 500).slice(0, 3));
  console.log('   HỘP XÓA (đã tích 80 bill, ngưỡng 10):', JSON.stringify(t));
  await anh(page, 'D4-hop-xoa-vuot-nguong.png');
  const co = t.join(' ');
  const m = /đã sửa\/xóa (\d+) bill/.exec(co);
  if (m && m[1] === '0')
    finding('VỪA', 'D18-HOP-XOA-TU-MAU-THUAN',
      'Thông điệp hộp xóa TỰ MÂU THUẪN: tiêu đề "Xóa 80 bill?" nhưng câu cảnh báo in `daSuaXoaHomNay` (= 0, số đã sửa/xóa TRƯỚC ĐÓ) thay vì tổng daSuaXoaHomNay + daTich.size đang vượt ngưỡng ⇒ "hôm nay đã sửa/xóa 0 bill, vượt ngưỡng 10/ngày" (BillManualEntryPage.tsx:2140-2145)',
      `nguyên văn: "${co.match(/CẢNH BÁO[^"]*/)?.[0] ?? co.slice(0, 200)}"`);
  else if (m) console.log('   (số in ra =', m[1], ')');
  else ok('D18-HOP-XOA-TU-MAU-THUAN', 'Không thấy câu tự mâu thuẫn', JSON.stringify(t).slice(0, 160));
  await page.locator('button:has-text("Hủy"), button:has-text("Quay lại")').first().click().catch(() => {});
  await page.waitForTimeout(400);
});

// ══════════ 5. POPUP "Đã xuất Excel" — đường dẫn ══════════
await thu('5. Popup "Đã xuất Excel" — đường dẫn có hỏng ký tự?', async () => {
  await page.locator('[data-nut="excel"]').click();
  await page.waitForTimeout(900);
  const p = await page.evaluate(() => {
    const c = document.querySelector('code.break-all');
    return c ? (c.textContent || '') : null;
  });
  console.log('   đường dẫn in ra:', JSON.stringify(p));
  await anh(page, 'D5-popup-excel.png');
  if (p && !/\\<REPO>\\/.test(p))
    finding('NHẸ', 'D19-DUONG-DAN-HONG',
      'Đường dẫn trong popup "Đã xuất Excel" BỊ HỎNG KÝ TỰ: chuỗi nguồn dùng nháy đơn nên "\\t" / "\\q" thành TAB và ký tự lạ ⇒ người dùng copy đường dẫn là mở không ra (harness-bill-le.tsx exportBillLeExcel; bản thật phải dùng String.raw hoặc escape \\\\)',
      `in ra: ${JSON.stringify(p)} — thiếu "\\<REPO>\\", có ký tự TAB = ${/\t/.test(p)}`);
  else ok('D19-DUONG-DAN-HONG', 'Đường dẫn popup Excel nguyên vẹn', JSON.stringify(p));
  await page.locator('button:has-text("Đóng")').first().click().catch(() => {});
  await page.waitForTimeout(400);
});

// ══════════ 6. Ô "Tôi đã kiểm tra… vẫn ghi" có giữ tích sang bill kế? ══════════
await thu('6. Ô "Tôi đã kiểm tra… vẫn ghi" giữ tích sang bill kế?', async () => {
  await page.locator('[data-nut="them"]').click();
  await page.waitForTimeout(800);
  await gan(page);
  await chonSearch(page, '— Chọn ngân hàng —', 'MBV');
  await chonSearch(page, '— Gõ tên HKD hoặc số TID —', 'DEMO-TID-01');
  await gan(page);
  const opts = await O(page, 'Loại thẻ').locator('option').allTextContents();
  await O(page, 'Loại thẻ').selectOption({ index: opts.findIndex((x) => /Visa/.test(x)) });
  await dien(page, 'Số lô', '82'); // trùng lô 82 → bật cảnh báo
  await dien(page, 'Số hóa đơn', '990001');
  await dien(page, 'Trước phí', '7000000');
  await O(page, 'gio-h').fill('16'); await O(page, 'gio-m').fill('00'); await O(page, 'gio-m').blur();
  await page.waitForTimeout(500);
  let d = await chanDoan(page);
  console.log('   bill 1 (lô 82 trùng):', JSON.stringify({ canhBao: d.canhBao.slice(0, 2), tich: d.tichXacNhan, ghiDisabled: d.ghiDisabled }));
  const xn = CB(page, 'Tôi đã kiểm tra, đây là bill ĐÚNG');
  if (await xn.count()) await xn.check();
  await page.waitForTimeout(300);
  d = await chanDoan(page);
  console.log('   sau khi tích:', JSON.stringify({ tich: d.tichXacNhan, ghiDisabled: d.ghiDisabled }));
  if (d.ghiDisabled) { console.log('   CHẨN ĐOÁN vì sao vẫn tắt:', JSON.stringify(d)); throw new Error('nút ghi vẫn tắt — xem chẩn đoán ở trên'); }
  await page.locator('[data-nut="ghibill"]').click();
  await page.waitForTimeout(1000);
  // bấm "Nhập bill tiếp" để sang bill kế
  const tiep = page.locator('button:has-text("Nhập bill tiếp")');
  if (await tiep.count()) { await tiep.click(); await page.waitForTimeout(800); }
  else { await page.locator('button:has-text("Xong")').first().click(); await page.waitForTimeout(600); await page.locator('[data-nut="them"]').click(); await page.waitForTimeout(800); }
  await gan(page);
  await dien(page, 'Số lô', '82');
  await dien(page, 'Số hóa đơn', '990002');
  await dien(page, 'Trước phí', '7000000');
  await page.waitForTimeout(500);
  d = await chanDoan(page);
  console.log('   bill KẾ (lô 82 lại trùng):', JSON.stringify({ canhBao: d.canhBao.slice(0, 2), tich: d.tichXacNhan, ghiDisabled: d.ghiDisabled }));
  await anh(page, 'D6-o-xac-nhan-bill-ke.png');
  if (d.tichXacNhan.some((x) => x === true))
    finding('VỪA', 'D9-O-XACNHAN-GIU-TICH', 'Ô "Tôi đã kiểm tra… vẫn ghi" GIỮ TÍCH sang bill kế ⇒ bill sau bỏ qua cảnh báo trùng mà người nhập không hề đọc', `bill kế: tích = ${JSON.stringify(d.tichXacNhan)}`);
  else ok('D9-O-XACNHAN-GIU-TICH', 'Ô xác nhận được reset sau mỗi lần ghi', JSON.stringify(d.tichXacNhan));
});

// ══════════ 7. KỲ tự nhảy về hôm nay sau 60 giây ══════════
await thu('7. Bộ lọc kỳ tự nhảy về hôm nay sau 60s', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('tbody tr');
  await page.waitForTimeout(500);
  // đặt kỳ = 1 NGÀY CŨ (từ == đến, khác hôm nay) — đúng điều kiện tu===den && tu!==nay
  await page.locator('input[aria-label="Từ ngày"]').fill('2026-11-01');
  await page.locator('input[aria-label="Đến ngày"]').fill('2026-11-01');
  await page.waitForTimeout(400);
  const n0 = (await docBang(page)).rows.length;
  console.log('   đặt kỳ 01/11 → 01/11 ·', n0, 'bill. Chờ 65 giây (interval 60s của trang)…');
  // ĐẨY đồng hồ ảo: không can thiệp được setInterval đã chạy ⇒ chờ THẬT 65s
  await page.waitForTimeout(65_000);
  const tu = await page.locator('input[aria-label="Từ ngày"]').inputValue();
  const den = await page.locator('input[aria-label="Đến ngày"]').inputValue();
  const n1 = (await docBang(page)).rows.length;
  console.log(`   sau 65s: kỳ = ${tu} → ${den} · ${n1} bill`);
  await anh(page, 'D7-ky-sau-65s.png');
  if (tu !== '2026-11-01' || den !== '2026-11-01')
    finding('NẶNG', 'D8-KY-TU-NHAY',
      'Bộ lọc KỲ TỰ NHẢY về hôm nay sau 60 giây: setInterval 60s ép fTu/fDen = ngày hôm nay khi fTu===fDen ⇒ đang xem/đếm doanh số 1 ngày cũ thì bảng tự đổi dữ liệu dưới tay người dùng, không hề báo (BillManualEntryPage.tsx:498-509)',
      `đặt kỳ 2026-11-01 → 2026-11-01 (${n0} bill) · sau 65 giây KHÔNG thao tác gì → kỳ thành ${tu} → ${den} (${n1} bill)`);
  else ok('D8-KY-TU-NHAY', 'Kỳ không tự nhảy sau 65s', `${tu} → ${den}`);
});

// ══════════ 8. MultiSelect: nhãn vs giá trị thô ══════════
await thu('8. MultiSelect hiện NHÃN khi chọn 1 mục · tooltip khi chọn nhiều', async () => {
  const btn = page.locator('button:has-text("Tất cả ca")').first();
  await btn.click();
  await page.waitForTimeout(300);
  await page.locator('button:has-text("Ca 1")').last().click();
  await page.waitForTimeout(300);
  const nhan1 = (await page.locator('button[title]').filter({ hasText: /^Ca 1$/ }).first().innerText().catch(() => '')).trim();
  const d1 = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button[title]')].find((x) => /Ca 1|^1$/.test((x.textContent || '').trim()));
    return b ? { text: (b.textContent || '').trim(), title: b.getAttribute('title') } : null;
  });
  console.log('   chọn 1 ca →', JSON.stringify(d1));
  if (d1 && d1.text.replace(/\s/g, '') === '1') finding('NHẸ', 'D-MS-GIATRI-THO', 'MultiSelect hiện GIÁ TRỊ THÔ thay vì nhãn khi chọn 1 mục', JSON.stringify(d1));
  else ok('D-MS-NHAN', 'MultiSelect hiện NHÃN khi chọn 1 mục', JSON.stringify(d1));
  if (d1 && d1.title === '1')
    finding('NHẸ', 'D-MS-TOOLTIP-THO', 'Tooltip MultiSelect in GIÁ TRỊ THÔ (value) chứ không phải nhãn: `title={value.join(", ")}` ⇒ lọc Ca hiện tooltip "1, 2" thay vì "Ca 1, Ca 2" (MultiSelect.tsx:62)', `title="${d1.title}" trong khi nhãn là "${d1.text}"`);
  // chọn thêm 1 ca nữa → xem tooltip
  await page.locator('button:has-text("Ca 2")').last().click().catch(() => {});
  await page.waitForTimeout(300);
  const d2 = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button[title]')].find((x) => /ca: 2/.test((x.textContent || '').trim()));
    return b ? { text: (b.textContent || '').trim(), title: b.getAttribute('title') } : null;
  });
  console.log('   chọn 2 ca →', JSON.stringify(d2));
  if (d2 && /^\d+(, \d+)+$/.test(d2.title))
    finding('NHẸ', 'D-MS-TOOLTIP-THO2', 'Tooltip MultiSelect in GIÁ TRỊ THÔ khi chọn nhiều mục: `title={value.join(", ")}` (MultiSelect.tsx:62)', `title="${d2.title}" trong khi nhãn phải là "Ca 1, Ca 2"`);
  await anh(page, 'D8-multiselect-ca.png');
});

const loi = log.filter((x) => x.type === 'error' || x.type === 'pageerror');
console.log(`\n  console error/pageerror: ${loi.length}`);
loi.slice(0, 6).forEach((x) => console.log('   ', x.type, x.text.slice(0, 250)));
if (loi.length) finding('NẶNG', 'D-CONSOLE', 'Lỗi console/pageerror', loi.slice(0, 3).map((x) => x.text.slice(0, 150)).join(' | '));
console.log('\n  TRẠNG THÁI phép thử:', JSON.stringify(THU));
console.log(`=== AUDIT2-D xong · ${FINDINGS.length} finding ===`);
await browser.close();
