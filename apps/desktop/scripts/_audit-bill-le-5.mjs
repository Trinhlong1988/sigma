// AUDIT ĐỐI KHÁNG #5 — MƯỢN TID: popup báo sai nhà + trạng thái mượn SỐNG SÓT qua đổi TID / qua nút Sửa.
import { moHarness, batPayload, docPayloads, shot, nutGhi } from './_audit-lib.mjs';

const { page, browser, server, errs } = await moHarness();
await batPayload(page);
const ok = [];
const log = (...a) => console.log(...a);
const M = '.fixed.inset-0';
const oTien = (i) => page.locator(M + ' input[placeholder="0"]').nth(i);
const PH_MUON = '— Chọn đại lý mượn — — gõ để tìm';

async function moForm() { await page.getByRole('button', { name: 'Thêm bill mới' }).click(); await page.waitForTimeout(550); }
async function chonSS(ph, go) {
  await page.locator(M + ' input[placeholder="' + ph + '"]').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(go, { delay: 15 }); await page.waitForTimeout(350);
  await page.getByText(go, { exact: false }).last().click(); await page.waitForTimeout(400);
}
const phTid = () => page.evaluate((m) => [...document.querySelectorAll(m + ' input')].map((i) => i.placeholder).find((p) => /tên HKD hoặc số TID|Chọn ngân hàng trước/.test(p || '')), M);
async function chonPhiThe(phi, the) {
  await page.locator(M + ' select').nth(1).selectOption({ label: phi }); await page.waitForTimeout(400);
  await page.locator(M + ' select').first().selectOption(the); await page.waitForTimeout(350);
}
const gioFill = async (h, m) => {
  await page.locator(M + ' input[aria-label="Giờ"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type(h, { delay: 50 });
  await page.locator(M + ' input[aria-label="Phút"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type(m, { delay: 50 });
  await page.keyboard.press('Tab'); await page.waitForTimeout(350);
};
const docDong = (nhan) => page.evaluate(([m, n]) => {
  const el = [...document.querySelectorAll(m + ' span')].find((s) => (s.textContent || '').trim() === n);
  return el?.parentElement?.querySelector('span:last-child')?.textContent?.trim() ?? null;
}, [M, nhan]);
async function tichHet() {
  const o = page.locator(M + ' input[type=checkbox].accent-warning, ' + M + ' input[type=checkbox].accent-danger');
  for (let i = 0; i < (await o.count()); i++) await o.nth(i).check({ force: true }).catch(() => {});
  await page.waitForTimeout(250);
}
const trangThaiMuon = () => page.evaluate((m) => {
  const cb0 = document.querySelector(m + ' input[type=checkbox]');
  const cbW = document.querySelector(m + ' input[type=checkbox].accent-warning');
  const o = [...document.querySelectorAll(m + ' input')].find((i) => /đại lý mượn/.test(i.placeholder || ''));
  const lab = [...document.querySelectorAll(m + ' label')].map((l) => (l.textContent || '').replace(/\s+/g, ' ').trim()).find((t) => t.includes('Xác nhận doanh số'));
  return { oTichMuon: cb0 ? cb0.checked : null, oXacNhanMuon: cbW ? cbW.checked : null, oChonDaiLy: o ? o.value : '(khong hien)', nhan: lab ?? null };
}, M);

try {
  await page.getByRole('button', { name: 'Xóa lọc' }).click(); await page.waitForTimeout(400);

  // ══ C1. POPUP báo nhà nào ══
  log('\n===== C1. MUON TID -> popup bao nha nao =====');
  const truoc = await page.evaluate(() => document.querySelectorAll('tbody tr:not([aria-hidden])').length);
  await moForm();
  await chonSS('— Chọn ngân hàng — — gõ để tìm', 'MBV');
  await chonSS(await phTid(), 'DEMO-TID-01'); // chu may = Truong SG
  await page.locator(M + ' input[type=checkbox]').first().check({ force: true });
  await page.waitForTimeout(500);
  await chonSS(PH_MUON, 'Đại lý C');
  await page.locator(M + ' input[type=checkbox].accent-warning').first().check({ force: true });
  await page.waitForTimeout(300);
  await chonPhiThe('Đối ứng', '13');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('7501');
  await oTien(0).fill('10000000');
  await gioFill('10', '00');
  await page.waitForTimeout(600);
  log('  o CA (tu tinh) =', JSON.stringify(await page.evaluate((m) => [...document.querySelectorAll(m + ' input[readonly]')].map((x) => x.value), M)));
  log('  cot phai "Ve dai ly (MUON)" =', await docDong('Về đại lý (MƯỢN)'));
  await tichHet();
  log('  nut ghi =', await nutGhi(page));
  await page.getByRole('button', { name: 'Ghi nhận bill' }).click();
  await page.waitForTimeout(1200);
  const pop = await page.evaluate(() => {
    const h = [...document.querySelectorAll('h3')].find((x) => (x.textContent || '').includes('Đã thêm bill'));
    return h ? (h.parentElement.parentElement.textContent || '').replace(/\s+/g, ' ').trim() : null;
  });
  log('  POPUP =', JSON.stringify(pop));
  const sai = /Về đại lý\s*Đại lý A/.test(pop || '');
  log('  ->', sai ? '*** POPUP ghi "Ve dai ly Truong SG" (CHU MAY) trong khi doanh so ghi cho Đại lý C ***' : 'popup dung nha muon');
  ok.push(['C1 popup bao dung nha MUON', !sai]);
  await shot(page, 'C1-popup-muon-sai-nha.png');
  await page.getByRole('button', { name: 'Xong' }).click().catch(() => {});
  await page.waitForTimeout(500);
  const pm = (await docPayloads(page)).at(-1);
  const row = await page.evaluate(() => {
    const rs = [...document.querySelectorAll('tbody tr:not([aria-hidden])')];
    const m = rs.filter((r) => (r.textContent || '').includes('7501'));
    const td = (i) => (m[0]?.querySelectorAll('td')[i]?.textContent || '').trim();
    return { tong: rs.length, soDong: m.length, daiLy: td(4), ndt: td(17), ghiChu: td(19) };
  });
  log('  payload borrowedByCustomerId =', pm?.borrowedByCustomerId, '(Đại lý C = 223)');
  log('  bang =', JSON.stringify(row), ' tong truoc =', truoc);
  ok.push(['C2 muon TID: 1 dong, ve nha muon', row.soDong === 1 && row.daiLy === 'Đại lý C' && row.tong === truoc + 1]);

  // ══ C4. TRẠNG THÁI MƯỢN sống sót qua ĐỔI TID ══
  log('\n===== C4. doi TID sau khi da chon nguoi muon (muon != chu may moi) =====');
  await moForm();
  await chonSS('— Chọn ngân hàng — — gõ để tìm', 'MBV');
  await chonSS(await phTid(), 'DEMO-TID-01');
  await page.locator(M + ' input[type=checkbox]').first().check({ force: true });
  await page.waitForTimeout(500);
  await chonSS(PH_MUON, 'Đại lý C');
  await page.locator(M + ' input[type=checkbox].accent-warning').first().check({ force: true });
  await page.waitForTimeout(400);
  log('  truoc khi doi TID :', JSON.stringify(await trangThaiMuon()));
  await chonSS(await phTid(), '20130241'); // chu may = Nguyen Minh Hoang (khac Đại lý C)
  await page.waitForTimeout(700);
  const tt = await trangThaiMuon();
  log('  SAU khi doi TID   :', JSON.stringify(tt));
  log('  "Ve dai ly (MUON)" =', await docDong('Về đại lý (MƯỢN)'));
  log('  ->', tt.oTichMuon && tt.oXacNhanMuon ? '*** o tich MUON + o XAC NHAN van giu nguyen cho MAY MOI, nguoi dung khong he xac nhan lai ***' : 'da reset');
  ok.push(['C4 doi TID phai reset o muon + o xac nhan', !(tt.oTichMuon && tt.oXacNhanMuon)]);
  await shot(page, 'C4-doi-tid-giu-trang-thai-muon.png');
  // đổi sang TID mà chủ máy CHÍNH LÀ người mượn
  await chonSS(await phTid(), '20130245'); // chu may = Truong SG
  await page.waitForTimeout(700);
  const tt2 = await trangThaiMuon();
  log('  doi tiep sang TID 20130245 (chu may = Truong SG):', JSON.stringify(tt2));
  log('  "Ve dai ly (MUON)" =', await docDong('Về đại lý (MƯỢN)'));

  // ══ C5. nút SỬA mang theo trạng thái MƯỢN của lần nhập trước ══
  log('\n===== C5. nut SUA bill mang theo trang thai MUON =====');
  await page.locator(M + ' button[title="Đóng"]').first().click().catch(() => {});
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Đóng, bỏ dữ liệu' }).click().catch(() => {});
  await page.waitForTimeout(500);
  const sachSau = await page.evaluate(() => !document.querySelector('.fixed.inset-0'));
  log('  da dong form =', sachSau);
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('tbody tr:not([aria-hidden])')].find((x) => (x.textContent || '').includes('000119'));
    r.querySelector('button[title^="Sửa bill"]').click();
  });
  await page.waitForTimeout(900);
  const tt3 = await trangThaiMuon();
  log('  bam SUA bill 000119 (bill thuong, KHONG muon) -> trang thai muon:', JSON.stringify(tt3));
  log('  "Ve dai ly" cot phai =', await docDong('Về đại lý (MƯỢN)'), '/', await docDong('Về đại lý'));
  log('  ->', tt3.oTichMuon ? '*** SUA BILL mo len voi o MUON dang BAT tu lan nhap truoc ***' : 'sach');
  ok.push(['C5 nut Sua khong ro trang thai muon', tt3.oTichMuon !== true]);
  await shot(page, 'C5-sua-bill-ro-muon.png');
} catch (e) { console.error('[audit5] LOI:', e.message, '\n', (e.stack || '').split('\n').slice(1, 3).join('\n')); }
finally {
  console.log('\n===== KET QUA #5 =====');
  ok.forEach(([t, v]) => console.log((v ? '  DAT  ' : '  DO   ') + t));
  if (errs.length) { console.log('  page errors:'); errs.slice(0, 8).forEach((e) => console.log('    ', e)); }
  await browser.close(); await server.close(); process.exit(0);
}
