// AUDIT ĐỐI KHÁNG #2 — cảnh báo SỐ LÔ (lọt / báo oan), MƯỢN TID, SỬA BILL, ô GIỜ.
import { moHarness, batPayload, docPayloads, shot, nutGhi } from './_audit-lib.mjs';

const { page, browser, server, errs } = await moHarness();
await batPayload(page);
const ok = [];
const log = (...a) => console.log(...a);
const M = '.fixed.inset-0';
const oTien = (i) => page.locator(M + ' input[placeholder="0"]').nth(i);

async function moForm() { await page.getByRole('button', { name: 'Thêm bill mới' }).click(); await page.waitForTimeout(500); }
async function chonSS(ph, go) {
  await page.locator(M + ' input[placeholder="' + ph + '"]').click();
  await page.keyboard.type(go, { delay: 15 }); await page.waitForTimeout(300);
  await page.getByText(go, { exact: false }).last().click(); await page.waitForTimeout(350);
}
async function chonMay(bank, tid) {
  await chonSS('— Chọn ngân hàng — — gõ để tìm', bank); await page.waitForTimeout(250);
  const ph = await page.evaluate((m) => [...document.querySelectorAll(m + ' input')].map((i) => i.placeholder).find((p) => /TID|HKD|Chọn ngân hàng trước/.test(p || '')), M);
  await chonSS(ph, tid);
}
async function chonPhiThe(phi, the) {
  await page.locator(M + ' select').nth(1).selectOption({ label: phi }); await page.waitForTimeout(400);
  await page.locator(M + ' select').first().selectOption(the); await page.waitForTimeout(350);
}
const canhBao = () => page.evaluate((m) => [...document.querySelectorAll(m + ' p')].map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => /TRÙNG HOÀN TOÀN|TRÙNG SỐ LÔ|NGHỊCH THỨ TỰ/.test(t)).map((t) => t.slice(0, 150)), M);
const gio = async (h, m) => {
  await page.locator(M + ' input[aria-label="Giờ"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type(h, { delay: 40 });
  await page.locator(M + ' input[aria-label="Phút"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type(m, { delay: 40 });
  await page.keyboard.press('Tab'); await page.waitForTimeout(350);
};
const docDong = (nhan) => page.evaluate(([m, n]) => {
  const el = [...document.querySelectorAll(m + ' span')].find((s) => (s.textContent || '').trim() === n);
  return el?.parentElement?.querySelector('span:last-child')?.textContent?.trim() ?? null;
}, [M, nhan]);
async function dongForm() {
  await page.locator(M + ' button[title="Đóng"]').first().click().catch(() => {});
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Đóng, bỏ dữ liệu' }).click().catch(() => {});
  await page.waitForTimeout(400);
}

try {
  // ══ D1. TRÙNG SỐ HÓA ĐƠN mà KHÔNG có số lô → có cảnh báo không? (BILL_DEMO m1 có HĐ 000118) ══
  log('\n===== D1. TRUNG SO HOA DON, KHONG co so lo =====');
  await page.getByRole('button', { name: 'Xóa lọc' }).click(); await page.waitForTimeout(400);
  await moForm();
  await chonMay('MBV', 'DEMO-TID-01');
  await chonPhiThe('Đối ứng', '13');
  await page.locator(M + ' input[placeholder="vd 000123"]').fill('000118'); // == bill m1 (lo 82, 30tr, 06/11)
  await oTien(0).fill('30000000');
  await gio('09', '14');
  await page.waitForTimeout(600);
  const d1 = { canh: await canhBao(), chan: await nutGhi(page), khoa: await page.evaluate((m) => document.querySelector(m + ' code')?.textContent?.trim(), M) };
  log('  go LAI y nguyen bill m1 (TID DEMO-TID-01, HD 000118, 30tr, 06/11 09:14) nhung BO TRONG so lo:');
  log('    canh bao =', JSON.stringify(d1.canh), ' nut ghi bi chan =', d1.chan);
  log('    khoa bill =', d1.khoa);
  log('  ->', d1.canh.length === 0 ? '*** LOT: TRUNG y nguyen ma IM LANG, ghi duoc ngay ***' : 'co canh bao');
  ok.push(['D1 canh bao trung khi chi co so hoa don', d1.canh.length > 0]);
  await shot(page, 'D1-trung-so-hoa-don-im-lang.png');
  await dongForm();

  // ══ D5. TRÙNG LÔ CÙNG NGÀY khác tiền → nhãn nói "khác ngày/giờ/tiền" đúng không? ══
  log('\n===== D5. TRUNG LO CUNG NGAY, khac tien =====');
  await moForm();
  await chonMay('MBV', 'DEMO-TID-01');
  await chonPhiThe('Đối ứng', '13');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('82'); // m1 co lo 82 ngay 06/11
  await oTien(0).fill('31000000'); // khac tien
  await gio('09', '14');
  await page.waitForTimeout(600);
  const d5 = { canh: await canhBao(), chan: await nutGhi(page) };
  log('  lo 82 CUNG NGAY 06/11, tien khac ->', JSON.stringify(d5.canh));
  log('  nut ghi bi chan =', d5.chan);
  await shot(page, 'D5-trung-lo-cung-ngay.png');
  await dongForm();

  // ══ D4. NGHỊCH THỨ TỰ lô ↔ giờ ══
  log('\n===== D4. NGHICH THU TU lo <-> gio =====');
  await moForm();
  await chonMay('MBV', 'DEMO-TID-01');
  await chonPhiThe('Đối ứng', '13');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('999'); // lo LON hon 82/83
  await oTien(0).fill('5000000');
  await gio('08', '00'); // gio SOM hon 09:14 cua lo 82
  await page.waitForTimeout(600);
  const d4 = { canh: await canhBao(), chan: await nutGhi(page) };
  log('  lo 999 luc 08:00 (da co lo 82 luc 09:14) ->', JSON.stringify(d4.canh), ' chan =', d4.chan);
  ok.push(['D4 bat nghich thu tu lo-gio', d4.canh.some((t) => t.includes('NGHỊCH')) && d4.chan === true]);
  // tích xác nhận → mở khóa?
  await page.locator(M + ' input[type=checkbox].accent-warning, ' + M + ' input[type=checkbox].accent-danger').first().check({ force: true });
  await page.waitForTimeout(400);
  log('  sau khi tich xac nhan -> nut chan =', await nutGhi(page));
  ok.push(['D4b tich xac nhan mo khoa', (await nutGhi(page)) === false]);
  await shot(page, 'D4-nghich-thu-tu.png');

  // ══ D3. RÒ xacNhanTrung sang bill KẾ ══
  log('\n===== D3. RO o "xac nhan" sang bill KE =====');
  await page.locator(M + ' button[data-nut="xoaform"]').click(); await page.waitForTimeout(500);
  await dongForm();
  await moForm();
  await chonMay('MBV', 'DEMO-TID-01');
  await chonPhiThe('Đối ứng', '13');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('82');
  await oTien(0).fill('30000000');
  await gio('09', '14');
  await page.waitForTimeout(700);
  const d3 = await page.evaluate((m) => {
    const cb = [...document.querySelectorAll(m + ' input[type=checkbox].accent-danger, ' + m + ' input[type=checkbox].accent-warning')];
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Ghi nhận bill'));
    return { soOxacNhan: cb.length, daTichSan: cb.map((c) => c.checked), nutChan: b ? b.disabled : null };
  }, M);
  log('  bill MOI trung hoan toan lo 82 30tr ->', JSON.stringify(d3));
  log('  canh bao =', JSON.stringify(await canhBao()));
  log('  ->', d3.daTichSan[0] === true ? '*** O XAC NHAN DA TICH SAN tu bill truoc, cong chan mo luon ***' : 'o xac nhan sach');
  ok.push(['D3 o xac nhan khong ro sang bill ke', d3.daTichSan[0] !== true]);
  await shot(page, 'D3-ro-o-xac-nhan.png');
  await page.locator(M + ' button[data-nut="xoaform"]').click(); await page.waitForTimeout(400);
  await dongForm();

  // ══ C. MƯỢN TID ══
  log('\n===== C. MUON TID =====');
  const truocMuon = await page.evaluate(() => document.querySelectorAll('tbody tr:not([aria-hidden])').length);
  await moForm();
  await chonMay('MBV', 'DEMO-TID-01'); // chu may = Truong SG
  await page.getByText('Bill này đại lý khác MƯỢN máy', { exact: false }).click();
  await page.waitForTimeout(400);
  await chonSS('— Chọn đại lý mượn —', 'Đại lý C');
  await page.locator(M + ' input[type=checkbox].accent-warning').first().check({ force: true });
  await page.waitForTimeout(300);
  await chonPhiThe('Đối ứng', '13');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('7001');
  await oTien(0).fill('10000000');
  await gio('10', '00');
  await page.waitForTimeout(600);
  log('  cot phai "Ve dai ly (MUON)" =', await docDong('Về đại lý (MƯỢN)'));
  await page.locator(M + ' input[type=checkbox].accent-warning, ' + M + ' input[type=checkbox].accent-danger').first().check({ force: true }).catch(() => {});
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Ghi nhận bill' }).click();
  await page.waitForTimeout(1000);
  const pop = await page.evaluate(() => {
    const h = [...document.querySelectorAll('h3')].find((x) => (x.textContent || '').includes('Đã thêm bill'));
    return h ? (h.parentElement.parentElement.textContent || '').replace(/\s+/g, ' ').trim() : null;
  });
  log('  POPUP bao thanh cong =', JSON.stringify(pop));
  const sai = /Về đại lý Đại lý A/.test(pop || '');
  log('  ->', sai ? '*** POPUP noi "Ve dai ly Truong SG" (CHU MAY) trong khi doanh so ve Đại lý C ***' : 'popup dung nha muon');
  ok.push(['C1 popup bao dung nha MUON', !sai]);
  await shot(page, 'C1-popup-muon-sai-nha.png');
  await page.getByRole('button', { name: 'Xong' }).click().catch(() => {});
  await page.waitForTimeout(400);
  const pm = (await docPayloads(page)).at(-1);
  const row = await page.evaluate(() => {
    const rs = [...document.querySelectorAll('tbody tr:not([aria-hidden])')];
    const m = rs.filter((r) => (r.textContent || '').includes('7001'));
    return { tong: rs.length, soDong: m.length, daiLy: (m[0]?.querySelectorAll('td')[4]?.textContent || '').trim(), ghiChu: (m[0]?.querySelectorAll('td')[19]?.textContent || '').trim() };
  });
  log('  payload borrowedByCustomerId =', pm?.borrowedByCustomerId, ' (Đại lý C = 223)');
  log('  bang:', JSON.stringify(row), ' tong truoc =', truocMuon);
  ok.push(['C2 muon TID chi 1 dong, ve nha muon', row.soDong === 1 && row.daiLy === 'Đại lý C' && row.tong === truocMuon + 1]);

  // ══ C3. ĐỔI TID SAU KHI đã chọn người mượn ══
  log('\n===== C3. DOI TID SAU KHI da chon nguoi muon =====');
  await moForm();
  await chonMay('MBV', 'DEMO-TID-01'); // chu may Truong SG
  await page.getByText('Bill này đại lý khác MƯỢN máy', { exact: false }).click();
  await page.waitForTimeout(400);
  await chonSS('— Chọn đại lý mượn —', 'Đại lý F');
  await page.locator(M + ' input[type=checkbox].accent-warning').first().check({ force: true });
  await page.waitForTimeout(300);
  const truocDoi = await docDong('Về đại lý (MƯỢN)');
  // doi sang TID 20130241 — chu may CHINH LA Nguyen Minh Hoang
  const phTid = await page.evaluate((m) => [...document.querySelectorAll(m + ' input')].map((i) => i.placeholder).find((p) => /TID|HKD/.test(p || '')), M);
  await page.locator(M + ' input[placeholder="' + phTid + '"]').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('20130241', { delay: 15 });
  await page.waitForTimeout(350);
  await page.getByText('20130241', { exact: false }).last().click();
  await page.waitForTimeout(600);
  const c3 = await page.evaluate((m) => {
    const lab = [...document.querySelectorAll(m + ' label')].map((l) => (l.textContent || '').replace(/\s+/g, ' ').trim()).find((t) => t.includes('Xác nhận doanh số'));
    const cb = document.querySelector(m + ' input[type=checkbox].accent-warning');
    const o = document.querySelector(m + ' input[placeholder="— Chọn đại lý mượn —"]');
    return { nhanXacNhan: lab, conTich: cb ? cb.checked : null, oDaiLyMuon: o ? o.value : '(khong con o)' };
  }, M);
  log('  "Ve dai ly (MUON)" truoc khi doi TID =', truocDoi);
  log('  sau khi doi TID sang 20130241 (chu may CHINH LA Nguyen Minh Hoang):');
  log('    nhan xac nhan =', JSON.stringify(c3.nhanXacNhan));
  log('    o tich van tich =', c3.conTich, ' o chon dai ly muon =', JSON.stringify(c3.oDaiLyMuon));
  log('    "Ve dai ly (MUON)" =', await docDong('Về đại lý (MƯỢN)'));
  await chonPhiThe('Đối ứng', '13');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('7002');
  await oTien(0).fill('8000000');
  await gio('11', '00');
  await page.waitForTimeout(600);
  log('    nut ghi bi chan =', await nutGhi(page));
  await shot(page, 'C3-doi-tid-sau-khi-chon-muon.png');
  if (!(await nutGhi(page))) {
    await page.getByRole('button', { name: 'Ghi nhận bill' }).click(); await page.waitForTimeout(1000);
    await page.getByRole('button', { name: 'Xong' }).click().catch(() => {});
    await page.waitForTimeout(400);
    const p3 = (await docPayloads(page)).at(-1);
    const r3 = await page.evaluate(() => { const m = [...document.querySelectorAll('tbody tr:not([aria-hidden])')].filter((r) => (r.textContent || '').includes('7002')); return { soDong: m.length, daiLy: (m[0]?.querySelectorAll('td')[4]?.textContent || '').trim(), ghiChu: (m[0]?.querySelectorAll('td')[19]?.textContent || '').trim() }; });
    log('    payload borrowedByCustomerId =', p3?.borrowedByCustomerId, '(210 = Nguyen Minh Hoang = CHINH CHU MAY)');
    log('    bang hien dai ly =', JSON.stringify(r3));
    log('    -> *** payload van gui co MUON cho chinh chu may; nhan xac nhan hien RONG ***');
    ok.push(['C3 doi TID phai reset nguoi muon', p3?.borrowedByCustomerId === undefined]);
  }

  // ══ E. Ô GIỜ ══
  log('\n===== E. O GIO 24h =====');
  await moForm();
  await chonMay('MBV', 'DEMO-TID-01');
  const thuGio = async (ten, fn) => { await fn(); const v = await page.evaluate((m) => ({ h: document.querySelector(m + ' input[aria-label="Giờ"]').value, p: document.querySelector(m + ' input[aria-label="Phút"]').value, loi: [...document.querySelectorAll(m + ' span')].map((s) => (s.textContent || '').trim()).filter((t) => /Giờ phải từ|Phút phải từ/.test(t)) }), M); log('  ' + ten + ' ->', JSON.stringify(v)); return v; };
  await thuGio('go NHANH "1435" (delay 0)', async () => { await page.locator(M + ' input[aria-label="Giờ"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type('14', { delay: 0 }); await page.locator(M + ' input[aria-label="Phút"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type('35', { delay: 0 }); await page.waitForTimeout(300); });
  await thuGio('go CHAM "0905" (delay 400ms)', async () => { await page.locator(M + ' input[aria-label="Giờ"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type('09', { delay: 400 }); await page.locator(M + ' input[aria-label="Phút"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type('05', { delay: 400 }); await page.waitForTimeout(300); });
  await thuGio('DAN "23" vao gio (paste)', async () => { await page.locator(M + ' input[aria-label="Giờ"]').click(); await page.keyboard.press('Control+a'); await page.evaluate(() => navigator.clipboard?.writeText?.('23')).catch(() => {}); await page.locator(M + ' input[aria-label="Giờ"]').fill('23'); await page.waitForTimeout(300); });
  await thuGio('go 28 gio (chua roi o)', async () => { await page.locator(M + ' input[aria-label="Giờ"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type('28', { delay: 60 }); await page.waitForTimeout(350); });
  log('    nut ghi khi dang loi 28h =', await nutGhi(page));
  await thuGio('99 phut (chua roi o)', async () => { await page.locator(M + ' input[aria-label="Phút"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type('99', { delay: 60 }); await page.waitForTimeout(350); });
  await thuGio('XOA TRONG o gio (chua roi o)', async () => { await page.locator(M + ' input[aria-label="Giờ"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace'); await page.waitForTimeout(350); });
  const gioTrong = await page.evaluate((m) => ({ khoa: document.querySelector(m + ' code')?.textContent?.trim() ?? null, ca: [...document.querySelectorAll(m + ' input[readonly]')].map((x) => x.value) }), M);
  log('    khi o gio RONG: khoa bill =', JSON.stringify(gioTrong.khoa), ' (state gio van giu gia tri cu?)');
  await thuGio('chi 1 chu so "7" roi Tab', async () => { await page.locator(M + ' input[aria-label="Giờ"]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type('7'); await page.keyboard.press('Tab'); await page.waitForTimeout(350); });
  await shot(page, 'E-o-gio.png');
} catch (e) { console.error('[audit2] LOI:', e.message, '\n', (e.stack || '').split('\n').slice(1, 3).join('\n')); }
finally {
  console.log('\n===== KET QUA #2 =====');
  ok.forEach(([t, v]) => console.log((v ? '  DAT  ' : '  DO   ') + t));
  if (errs.length) { console.log('  page errors:'); errs.slice(0, 8).forEach((e) => console.log('    ', e)); }
  await browser.close(); await server.close(); process.exit(0);
}
