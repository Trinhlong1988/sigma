// AUDIT2-D2 — chạy lại 3 phép kiểm bị hỏng ở D (sửa lỗi hàm chẩn đoán) + chứng minh NGƯỠNG cộng khi MỞ form.
import { moTrang, anh, finding, ok, FINDINGS } from './_audit2-lib.mjs';

const THU = [];
async function thu(ten, fn) {
  console.log(`\n── ${ten} ──`);
  try { await fn(); THU.push([ten, 'chạy']); }
  catch (e) { THU.push([ten, 'LỖI PHÉP KIỂM']); finding('VỪA', 'D2-KIEM-HONG:' + ten, 'PHÉP KIỂM KHÔNG CHẠY ĐƯỢC (R198)', String(e.message).split('\n')[0].slice(0, 200)); }
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
async function chanDoan(page) {
  return page.evaluate(() => {
    const g = (s) => document.querySelector(`[data-audit="${s}"]`);
    const RE = /TRÙNG HOÀN TOÀN|TRÙNG SỐ LÔ|NGHỊCH THỨ TỰ|chưa đặt giá bán|Tách thẻ chưa|nhiều hơn số đại lý|Giờ phải từ|Phút phải từ|phải chọn NGƯỜI HOÀN|Mỗi dòng phải chọn/;
    const canhBao = [...new Set([...document.querySelectorAll('p,span,div')].map((x) => (x.textContent || '').trim()).filter((s) => RE.test(s) && s.length < 320))];
    return {
      loaiThe: g('Loại thẻ')?.value, loaiPhi: g('Loại phí')?.value,
      soLo: g('Số lô')?.value, soHd: g('Số hóa đơn')?.value,
      truocPhi: g('Trước phí')?.value, tienHuy: g('Tiền hủy')?.value, daHoan: g('Đã hoàn')?.value,
      gio: (g('gio-h')?.value ?? '') + ':' + (g('gio-m')?.value ?? ''), ngay: g('Ngày trên bill')?.value,
      nguoiHoan: document.querySelector('input[placeholder="— Kế toán / Admin —"]')?.value ?? null,
      canhBao: canhBao.slice(0, 4),
      tichXacNhan: [...document.querySelectorAll('label')].filter((l) => /Tôi đã kiểm tra/.test(l.textContent || '')).map((l) => l.querySelector('input').checked),
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
async function dongForm(page) {
  await page.locator('button[title="Đóng"]').first().click().catch(() => {});
  await page.waitForTimeout(400);
  const h = page.locator('button:has-text("Đóng, bỏ dữ liệu")');
  if (await h.count()) { await h.click(); await page.waitForTimeout(500); }
}

const { browser, page, log } = await moTrang(1920, 1080);
console.log('=== AUDIT2-D2 ===');

// ── 1. SỬA bill lô 82 ──────────────────────────────────────────────────────────────────────────
await thu('1. Mở Sửa bill lô 82 (đã hoàn 29.625.000 bởi Nhân viên A)', async () => {
  await page.locator('button[title="Sửa bill lô 82"]').first().click();
  await page.waitForTimeout(900);
  await gan(page);
  const d = await chanDoan(page);
  console.log('   trạng thái form sau khi mở Sửa:', JSON.stringify(d));
  await anh(page, 'D2-sua-bill-82.png');
  if (d.canhBao.some((t) => /TRÙNG HOÀN TOÀN/.test(t)))
    finding('NẶNG', 'D12-SUA-BAO-OAN-TRUNG',
      'Bấm "Sửa" 1 bill thì màn báo oan "TRÙNG HOÀN TOÀN" với CHÍNH NÓ: billTrung quét cả `danhSach` mà không loại bill đang sửa (không có state "đang sửa id") ⇒ người sửa buộc tích "Tôi đã kiểm tra… vẫn ghi" mỗi lần, cảnh báo trùng mất tác dụng (BillManualEntryPage.tsx:574-578 + suaBill 863-879)',
      `mở Sửa bill lô 82, chưa đổi gì → "${d.canhBao.find((t) => /TRÙNG HOÀN TOÀN/.test(t))?.slice(0, 230)}"`);
  else ok('D12-SUA-BAO-OAN-TRUNG', 'Sửa bill không báo oan trùng', JSON.stringify(d.canhBao));

  const daHoanSo = Number(String(d.daHoan || '').replace(/\D/g, '')) || 0;
  if (daHoanSo > 0 && !d.nguoiHoan)
    finding('NẶNG', 'D13-SUA-MAT-NGUOI-HOAN',
      'Sửa bill nạp lại số "Đã hoàn" nhưng KHÔNG nạp NGƯỜI HOÀN (suaBill thiếu setNguoiHoanId — BillManualEntryPage.tsx:863-879) ⇒ nút ghi bị chặn bởi chính luật "có tiền hoàn phải có người hoàn"; người sửa buộc chọn lại ⇒ VẾT ai trả bị GHI ĐÈ sang người khác',
      `bảng ghi "Nhân viên A" hoàn 29.625.000 · sau khi mở Sửa: ô Đã hoàn = "${d.daHoan}", ô Người hoàn = ${JSON.stringify(d.nguoiHoan)} (rỗng) · nút ghi disabled = ${d.ghiDisabled} · cảnh báo "${d.canhBao.find((t) => /NGƯỜI HOÀN/.test(t)) ?? '—'}"`);
  else ok('D13-SUA-MAT-NGUOI-HOAN', 'Sửa bill nạp lại người hoàn', String(d.nguoiHoan));

  // người hoàn gốc có nằm trong danh sách chọn được không?
  const oNH = page.getByPlaceholder('— Kế toán / Admin —');
  if (await oNH.count()) {
    await oNH.click().catch(() => {});
    await page.waitForTimeout(300);
    const ds = await page.evaluate(() => [...document.querySelectorAll('li')].map((x) => (x.textContent || '').trim()).filter(Boolean));
    console.log('   danh sách NGƯỜI HOÀN chọn được:', JSON.stringify(ds));
    if (ds.length && !ds.some((x) => /Nhân viên A/.test(x)))
      finding('NẶNG', 'D13b-NGUOI-HOAN-GOC-KHONG-CO',
        'NGƯỜI HOÀN GỐC của bill KHÔNG nằm trong danh sách được chọn: màn lọc users còn vai trò ACCOUNTANT/ADMIN, mà "Nhân viên A" là R_INVESTOR ⇒ sửa bill đã hoàn bởi người ngoài 2 vai trò đó thì KHÔNG THỂ giữ nguyên vết, buộc đổi sang người khác hoặc không ghi được (BillManualEntryPage.tsx:523-524)',
        `vết gốc "Nhân viên A" · danh sách chọn được = ${JSON.stringify(ds)}`);
    else ok('D13b-NGUOI-HOAN-GOC-KHONG-CO', 'Người hoàn gốc có trong danh sách', JSON.stringify(ds).slice(0, 160));
    await page.keyboard.press('Escape');
  }
});

// ── 2. NGƯỠNG: cộng khi MỞ form Sửa (chứng minh bằng thông điệp hộp xóa) ───────────────────────
await thu('2. NGƯỠNG cộng NGAY lúc MỞ form Sửa — chứng minh bằng số in trong hộp xóa', async () => {
  await dongForm(page);
  // đọc số ban đầu: tích 1 bill rồi mở hộp xóa (ngưỡng chưa vượt nên không in câu CẢNH BÁO) → tích 11 bill
  const tichN = async (n) => {
    await page.evaluate((k) => {
      const cb = [...document.querySelectorAll('tbody input[type=checkbox]')];
      cb.slice(0, k).forEach((c) => { if (!c.checked) c.click(); });
    }, n);
    await page.waitForTimeout(350);
  };
  await tichN(11);
  await page.locator('[data-nut="xoabill"]').click();
  await page.waitForTimeout(500);
  const m0 = await page.evaluate(() => (document.body.textContent || '').match(/hôm nay đã sửa\/xóa (\d+) bill/));
  console.log('   CHƯA mở Sửa lần nào → hộp xóa in:', JSON.stringify(m0 && m0[0]));
  await page.locator('button:has-text("Hủy")').first().click().catch(() => {});
  await page.waitForTimeout(400);
  // MỞ form Sửa 5 lần, KHÔNG ghi gì
  for (let i = 0; i < 5; i++) {
    await page.locator('button[title^="Sửa bill lô"]').nth(i).click();
    await page.waitForTimeout(400);
    await dongForm(page);
  }
  await tichN(11);
  await page.locator('[data-nut="xoabill"]').click();
  await page.waitForTimeout(500);
  const m1 = await page.evaluate(() => (document.body.textContent || '').match(/hôm nay đã sửa\/xóa (\d+) bill/));
  console.log('   sau khi MỞ Sửa 5 lần (không sửa, không ghi) → hộp xóa in:', JSON.stringify(m1 && m1[0]));
  await anh(page, 'D2-nguong-sau-5-lan-mo.png');
  const n0 = Number(m0?.[1] ?? -1), n1 = Number(m1?.[1] ?? -1);
  if (n1 > n0)
    finding('VỪA', 'D10-NGUONG-MO-FORM',
      'Ngưỡng 10 bill/ngày CỘNG NGAY lúc MỞ form Sửa (setDaSuaXoaHomNay(x=>x+1) ở đầu suaBill) chứ không phải lúc GHI ⇒ chỉ MỞ XEM bill là đã bị tính; thêm nữa `daSuaXoaHomNay` chỉ là useState trong component nên F5 / đổi màn là về 0 ⇒ ngưỡng bảo mật vô hiệu (BillManualEntryPage.tsx:838-862)',
      `chưa mở Sửa: "đã sửa/xóa ${n0} bill" → MỞ Sửa 5 lần không ghi gì → "đã sửa/xóa ${n1} bill" (+${n1 - n0})`);
  else ok('D10-NGUONG-MO-FORM', 'Mở Sửa không cộng ngưỡng', `${n0} → ${n1}`);
  await page.locator('button:has-text("Hủy")').first().click().catch(() => {});
  await page.waitForTimeout(300);
  // F5 → về 0?
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('tbody tr');
  await page.waitForTimeout(600);
  await tichN(11);
  await page.locator('[data-nut="xoabill"]').click();
  await page.waitForTimeout(500);
  const m2 = await page.evaluate(() => (document.body.textContent || '').match(/hôm nay đã sửa\/xóa (\d+) bill/));
  console.log('   sau F5 → hộp xóa in:', JSON.stringify(m2 && m2[0]));
  if (Number(m2?.[1] ?? -1) === 0 && n1 > 0)
    finding('VỪA', 'D10b-NGUONG-MAT-KHI-F5', 'Đếm ngưỡng MẤT khi F5 (chỉ là useState, không lưu máy chủ/ổ đĩa) ⇒ ai muốn sửa/xóa quá ngưỡng chỉ cần F5 (BillManualEntryPage.tsx:838)', `trước F5 = ${n1} → sau F5 = ${m2?.[1]}`);
  await page.locator('button:has-text("Hủy")').first().click().catch(() => {});
  await page.waitForTimeout(300);
});

// ── 3. Ô "Tôi đã kiểm tra… vẫn ghi" giữ tích sang bill kế ──────────────────────────────────────
await thu('3. Ô "Tôi đã kiểm tra… vẫn ghi" giữ tích sang bill kế?', async () => {
  await page.locator('[data-nut="them"]').click();
  await page.waitForTimeout(800);
  await gan(page);
  await chonSearch(page, '— Chọn ngân hàng —', 'MBV');
  await chonSearch(page, '— Gõ tên HKD hoặc số TID —', 'DEMO-TID-01');
  await gan(page);
  const opts = await O(page, 'Loại thẻ').locator('option').allTextContents();
  await O(page, 'Loại thẻ').selectOption({ index: opts.findIndex((x) => /Visa/.test(x)) });
  await page.waitForTimeout(250);
  await dien(page, 'Số lô', '82');
  await dien(page, 'Số hóa đơn', '990001');
  await dien(page, 'Trước phí', '7000000');
  await O(page, 'gio-h').fill('16'); await O(page, 'gio-m').fill('00'); await O(page, 'gio-m').blur();
  await page.waitForTimeout(500);
  let d = await chanDoan(page);
  console.log('   bill 1 (lô 82 trùng lô):', JSON.stringify({ canhBao: d.canhBao, tich: d.tichXacNhan, disabled: d.ghiDisabled }));
  const xn = CB(page, 'Tôi đã kiểm tra, đây là bill ĐÚNG');
  if (await xn.count()) await xn.check();
  await page.waitForTimeout(350);
  d = await chanDoan(page);
  console.log('   sau khi tích:', JSON.stringify({ tich: d.tichXacNhan, disabled: d.ghiDisabled }));
  if (d.ghiDisabled) { console.log('   CHẨN ĐOÁN đầy đủ:', JSON.stringify(d)); throw new Error('nút ghi vẫn tắt dù đã tích — xem chẩn đoán'); }
  await page.locator('[data-nut="ghibill"]').click();
  await page.waitForTimeout(1100);
  const nut = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter((t) => /Nhập bill tiếp|Xong/.test(t)));
  console.log('   nút trên popup:', JSON.stringify(nut));
  const tiep = page.locator('button:has-text("Nhập bill tiếp")');
  if (await tiep.count()) { await tiep.click(); await page.waitForTimeout(900); }
  else { await page.locator('button:has-text("Xong")').first().click(); await page.waitForTimeout(700); await page.locator('[data-nut="them"]').click(); await page.waitForTimeout(800); }
  await gan(page);
  await dien(page, 'Số lô', '82');
  await dien(page, 'Số hóa đơn', '990002');
  await dien(page, 'Trước phí', '7000000');
  await page.waitForTimeout(600);
  d = await chanDoan(page);
  console.log('   bill KẾ (lô 82 lại trùng):', JSON.stringify({ canhBao: d.canhBao, tich: d.tichXacNhan, disabled: d.ghiDisabled }));
  await anh(page, 'D2-o-xacnhan-bill-ke.png');
  if (d.tichXacNhan.some((x) => x === true))
    finding('VỪA', 'D9-O-XACNHAN-GIU-TICH', 'Ô "Tôi đã kiểm tra… vẫn ghi" GIỮ TÍCH sang bill kế ⇒ bill sau bỏ qua cảnh báo trùng mà người nhập không hề đọc', `bill kế: tích = ${JSON.stringify(d.tichXacNhan)}, nút ghi disabled=${d.ghiDisabled}`);
  else ok('D9-O-XACNHAN-GIU-TICH', 'Ô xác nhận reset sau mỗi lần ghi (ghiNhan gọi setXacNhanTrung(false))', JSON.stringify(d.tichXacNhan));
});

// ── 4. GIỜ RỖNG có chặn ghi THẬT không (tách khỏi cảnh báo lô) ─────────────────────────────────
await thu('4. XÓA TRỐNG ô giờ — có chặn ghi thật không (bill KHÔNG vướng cảnh báo lô)', async () => {
  await dongForm(page);
  await page.locator('[data-nut="them"]').click();
  await page.waitForTimeout(800);
  await gan(page);
  await chonSearch(page, '— Chọn ngân hàng —', 'MBV');
  await chonSearch(page, '— Gõ tên HKD hoặc số TID —', '20130241');
  await gan(page);
  const opts = await O(page, 'Loại thẻ').locator('option').allTextContents();
  console.log('   loại thẻ của 20130241:', JSON.stringify(opts));
  const i = opts.findIndex((x) => /bán \d/.test(x));
  if (i < 0) {
    // máy này chưa có giá bán → dùng DEMO-TID-01 với SỐ LÔ chưa tồn tại để tránh cảnh báo
    await chonSearch(page, '— Gõ tên HKD hoặc số TID —', 'DEMO-TID-01');
    await gan(page);
    const o2 = await O(page, 'Loại thẻ').locator('option').allTextContents();
    await O(page, 'Loại thẻ').selectOption({ index: o2.findIndex((x) => /bán \d/.test(x)) });
  } else await O(page, 'Loại thẻ').selectOption({ index: i });
  await page.waitForTimeout(300);
  await dien(page, 'Số lô', '');
  await dien(page, 'Số hóa đơn', '777777');
  await dien(page, 'Trước phí', '5000000');
  await O(page, 'gio-h').fill('11'); await O(page, 'gio-m').fill('22'); await O(page, 'gio-m').blur();
  await page.waitForTimeout(500);
  let d = await chanDoan(page);
  console.log('   bill sạch (không lô, HĐ 777777, 11:22):', JSON.stringify({ canhBao: d.canhBao, disabled: d.ghiDisabled }));
  // giờ XÓA TRỐNG cả 2 ô giờ bằng cách gõ rồi Backspace (không blur giữa 2 ô)
  await page.evaluate(() => {
    for (const s of ['gio-h', 'gio-m']) {
      const el = document.querySelector(`[data-audit="${s}"]`);
      el.focus();
      el.setSelectionRange(0, el.value.length);
    }
  });
  const h = O(page, 'gio-h');
  await h.click(); await h.press('Control+a'); await h.press('Backspace');
  await page.waitForTimeout(250);
  const m = O(page, 'gio-m');
  await m.click(); await m.press('Control+a'); await m.press('Backspace');
  await page.waitForTimeout(400);
  const hv = await h.inputValue(), mv = await m.inputValue();
  d = await chanDoan(page);
  console.log(`   sau khi xóa trống: ô giờ = "${hv}" : "${mv}" · nút ghi disabled = ${d.ghiDisabled} · cảnh báo = ${JSON.stringify(d.canhBao)}`);
  await anh(page, 'D2-gio-rong.png');
  if (!d.ghiDisabled && (hv === '' || mv === '')) {
    // ghi thật xem txnDate ra giờ nào
    await page.evaluate(() => { window.__PL = []; const g = console.log.bind(console); console.log = (...a) => { if (typeof a[0] === 'string' && a[0].includes('payload sẽ gửi')) { try { window.__PL.push(JSON.parse(JSON.stringify(a[1]))); } catch { /* bỏ */ } } g(...a); }; });
    await page.locator('[data-nut="ghibill"]').click();
    await page.waitForTimeout(1000);
    const p = await page.evaluate(() => (window.__PL || []).slice(-1)[0] ?? null);
    console.log('   payload txnDate khi ô giờ RỖNG:', p?.txnDate);
    finding('VỪA', 'C16-GIO-TRONG',
      'XÓA TRỐNG ô giờ KHÔNG chặn ghi: hRaw/mRaw rỗng không báo onLoi và `bao()` chỉ gọi khi v!=="" ⇒ state `gio` giữ GIÁ TRỊ CŨ, dayDu vẫn true ⇒ ghi được bill với giờ KHÁC hẳn giờ người nhập đang thấy trên ô (BillManualEntryPage.tsx:159-170 + 177-189)',
      `ô giờ hiện "${hv}":"${mv}" (rỗng) · nút Ghi nhận BẬT · ghi xong payload txnDate = ${p?.txnDate} (tức vẫn 11:22 giờ cũ)`);
    await page.locator('button:has-text("Xong")').first().click().catch(() => {});
  } else ok('C16-GIO-TRONG', 'Ô giờ rỗng chặn ghi hoặc tự điền lại', `"${hv}":"${mv}" disabled=${d.ghiDisabled}`);
});

const loi = log.filter((x) => x.type === 'error' || x.type === 'pageerror');
console.log(`\n  console error/pageerror: ${loi.length}`);
loi.slice(0, 5).forEach((x) => console.log('   ', x.type, x.text.slice(0, 220)));
console.log('\n  TRẠNG THÁI:', JSON.stringify(THU));
console.log(`=== AUDIT2-D2 xong · ${FINDINGS.length} finding ===`);
await browser.close();
