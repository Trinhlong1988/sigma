// AUDIT ĐỐI KHÁNG #3 — MƯỢN TID (popup/đổi TID), SỬA BILL (báo oan + nhân bản), ô CA.
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
async function chonMay(bank, tid) { await chonSS('— Chọn ngân hàng — — gõ để tìm', bank); await page.waitForTimeout(250); await chonSS(await phTid(), tid); }
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
const canhBao = () => page.evaluate((m) => [...document.querySelectorAll(m + ' p')].map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => /TRÙNG HOÀN TOÀN|TRÙNG SỐ LÔ|NGHỊCH THỨ TỰ/.test(t)).map((t) => t.slice(0, 110)), M);
async function tichHet() {
  const o = page.locator(M + ' input[type=checkbox].accent-warning, ' + M + ' input[type=checkbox].accent-danger');
  for (let i = 0; i < (await o.count()); i++) await o.nth(i).check({ force: true }).catch(() => {});
  await page.waitForTimeout(250);
}
async function dongForm() {
  await page.locator(M + ' button[title="Đóng"]').first().click().catch(() => {});
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Đóng, bỏ dữ liệu' }).click().catch(() => {});
  await page.waitForTimeout(450);
}

try {
  await page.getByRole('button', { name: 'Xóa lọc' }).click(); await page.waitForTimeout(400);

  // ══ C1/C2. MƯỢN TID ══
  log('\n===== C1/C2. MUON TID =====');
  const truocMuon = await page.evaluate(() => document.querySelectorAll('tbody tr:not([aria-hidden])').length);
  await moForm();
  await chonMay('MBV', 'DEMO-TID-01'); // chu may = Truong SG
  await page.locator(M + ' input[type=checkbox]').first().check({ force: true });
  await page.waitForTimeout(500);
  await chonSS(PH_MUON, 'Đại lý C');
  await page.locator(M + ' input[type=checkbox].accent-warning').first().check({ force: true });
  await page.waitForTimeout(300);
  await chonPhiThe('Đối ứng', '13');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('7001');
  await oTien(0).fill('10000000');
  await gioFill('10', '00');
  await page.waitForTimeout(600);
  log('  o CA (tu tinh) hien =', JSON.stringify(await page.evaluate((m) => [...document.querySelectorAll(m + ' input[readonly]')].map((x) => ({ v: x.value, ph: x.placeholder })), M)));
  log('  cot phai "Ve dai ly (MUON)" =', await docDong('Về đại lý (MƯỢN)'));
  await tichHet();
  await page.getByRole('button', { name: 'Ghi nhận bill' }).click();
  await page.waitForTimeout(1100);
  const pop = await page.evaluate(() => {
    const h = [...document.querySelectorAll('h3')].find((x) => (x.textContent || '').includes('Đã thêm bill'));
    return h ? (h.parentElement.parentElement.textContent || '').replace(/\s+/g, ' ').trim() : null;
  });
  log('  POPUP =', JSON.stringify(pop));
  const sai = /Về đại lý\s*Đại lý A/.test(pop || '');
  log('  ->', sai ? '*** POPUP ghi "Ve dai ly Truong SG" (CHU MAY) trong khi doanh so ve Đại lý C ***' : 'popup dung nha muon');
  ok.push(['C1 popup bao dung nha MUON', !sai]);
  await shot(page, 'C1-popup-muon-sai-nha.png');
  await page.getByRole('button', { name: 'Xong' }).click().catch(() => {});
  await page.waitForTimeout(450);
  const pm = (await docPayloads(page)).at(-1);
  const row = await page.evaluate(() => {
    const rs = [...document.querySelectorAll('tbody tr:not([aria-hidden])')];
    const m = rs.filter((r) => (r.textContent || '').includes('7001'));
    const td = (i) => (m[0]?.querySelectorAll('td')[i]?.textContent || '').trim();
    return { tong: rs.length, soDong: m.length, daiLy: td(4), tid: td(5), ghiChu: td(19) };
  });
  log('  payload borrowedByCustomerId =', pm?.borrowedByCustomerId, '(Đại lý C = 223)');
  log('  bang =', JSON.stringify(row), ' tong truoc =', truocMuon);
  ok.push(['C2 muon TID: 1 dong, ve nha muon', row.soDong === 1 && row.daiLy === 'Đại lý C' && row.tong === truocMuon + 1]);

  // ══ C3. ĐỔI TID SAU KHI chọn người mượn ══
  log('\n===== C3. DOI TID SAU KHI da chon nguoi muon =====');
  await moForm();
  await chonMay('MBV', 'DEMO-TID-01');
  await page.locator(M + ' input[type=checkbox]').first().check({ force: true });
  await page.waitForTimeout(500);
  await chonSS(PH_MUON, 'Đại lý F');
  await page.locator(M + ' input[type=checkbox].accent-warning').first().check({ force: true });
  await page.waitForTimeout(400);
  log('  truoc khi doi TID: "Ve dai ly (MUON)" =', await docDong('Về đại lý (MƯỢN)'));
  await chonSS(await phTid(), '20130241'); // chu may CHINH LA Nguyen Minh Hoang
  await page.waitForTimeout(700);
  const c3 = await page.evaluate((m) => {
    const lab = [...document.querySelectorAll(m + ' label')].map((l) => (l.textContent || '').replace(/\s+/g, ' ').trim()).find((t) => t.includes('Xác nhận doanh số'));
    const cb = document.querySelector(m + ' input[type=checkbox].accent-warning');
    const o = [...document.querySelectorAll(m + ' input')].find((i) => /đại lý mượn/.test(i.placeholder || ''));
    return { nhan: lab, conTich: cb ? cb.checked : null, oMuon: o ? o.value : '(khong con o)' };
  }, M);
  log('  sau khi doi sang TID 20130241 (chu may = Nguyen Minh Hoang):');
  log('    nhan xac nhan =', JSON.stringify(c3.nhan));
  log('    o tich van tich =', c3.conTich, ' o chon dai ly muon =', JSON.stringify(c3.oMuon));
  log('    "Ve dai ly (MUON)" =', await docDong('Về đại lý (MƯỢN)'));
  await chonPhiThe('Đối ứng', '13');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('7002');
  await oTien(0).fill('8000000');
  await gioFill('11', '00');
  await page.waitForTimeout(600);
  await tichHet();
  log('    nut ghi bi chan =', await nutGhi(page));
  await shot(page, 'C3-doi-tid-sau-khi-chon-muon.png');
  if (!(await nutGhi(page))) {
    await page.getByRole('button', { name: 'Ghi nhận bill' }).click(); await page.waitForTimeout(1100);
    await page.getByRole('button', { name: 'Xong' }).click().catch(() => {});
    await page.waitForTimeout(450);
    const p3 = (await docPayloads(page)).at(-1);
    const r3 = await page.evaluate(() => { const m = [...document.querySelectorAll('tbody tr:not([aria-hidden])')].filter((r) => (r.textContent || '').includes('7002')); const td = (i) => (m[0]?.querySelectorAll('td')[i]?.textContent || '').trim(); return { soDong: m.length, daiLy: td(4), ghiChu: td(19) }; });
    log('    payload borrowedByCustomerId =', p3?.borrowedByCustomerId, '(210 = Nguyen Minh Hoang = CHINH CHU MAY)');
    log('    bang =', JSON.stringify(r3));
    ok.push(['C3 doi TID phai reset nguoi muon', p3?.borrowedByCustomerId === undefined]);
  } else { log('    -> bi chan (tot)'); ok.push(['C3 doi TID phai reset nguoi muon', true]); }

  // ══ D2. SỬA BILL (nút bút chì) ══
  log('\n===== D2. SUA BILL (nut but chi) =====');
  const truocSua = await page.evaluate(() => document.querySelectorAll('tbody tr:not([aria-hidden])').length);
  const billGoc = await page.evaluate(() => {
    const r = [...document.querySelectorAll('tbody tr:not([aria-hidden])')].find((x) => (x.textContent || '').includes('000118'));
    const td = (i) => (r?.querySelectorAll('td')[i]?.textContent || '').trim();
    return { lo: td(10), hd: td(11), truocPhi: td(12), nhanVe: td(14) };
  });
  log('  bill goc chon sua =', JSON.stringify(billGoc), ' tong dong truoc =', truocSua);
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('tbody tr:not([aria-hidden])')].find((x) => (x.textContent || '').includes('000118'));
    r.querySelector('button[title^="Sửa bill"]').click();
  });
  await page.waitForTimeout(900);
  const d2 = await page.evaluate((m) => {
    const inp = [...document.querySelectorAll(m + ' input')];
    const g = (ph) => inp.find((i) => i.placeholder === ph)?.value ?? null;
    const sel = [...document.querySelectorAll(m + ' select')].map((s) => ({ val: s.value, text: s.options[s.selectedIndex]?.text }));
    const cb = [...document.querySelectorAll(m + ' input[type=checkbox]')].map((c) => ({ cls: c.className, chk: c.checked }));
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Ghi nhận bill'));
    return {
      bank: inp.find((i) => /Chọn ngân hàng/.test(i.placeholder || ''))?.value ?? null,
      tid: inp.find((i) => /tên HKD hoặc số TID|Chọn ngân hàng trước/.test(i.placeholder || ''))?.value ?? null,
      soHD: g('vd 000123'), soLo: g('vd 84'), truocPhi: g('0'),
      select: sel, checkbox: cb, nutChan: b ? b.disabled : null,
      canh: [...document.querySelectorAll(m + ' p')].map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => /TRÙNG|NGHỊCH/.test(t)).map((t) => t.slice(0, 110)),
      canhKhac: [...document.querySelectorAll(m + ' div')].map((d) => (d.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => t.length < 120 && /phải chọn NGƯỜI HOÀN|chưa có giá bán/.test(t))
    };
  }, M);
  log('  form sau khi bam Sua:', JSON.stringify(d2, null, 1));
  log('  -> canh bao TRUNG voi CHINH NO?', d2.canh.some((t) => t.includes('TRÙNG HOÀN TOÀN')) ? '*** CO — BAO OAN ***' : 'khong');
  ok.push(['D2 sua bill khong bao trung voi chinh no', !d2.canh.some((t) => t.includes('TRÙNG HOÀN TOÀN'))]);
  log('  -> loai the / loai phi co nap lai?', JSON.stringify(d2.select.map((s) => s.text)));
  ok.push(['D2b sua bill nap lai loai the', d2.select[0]?.val !== '']);
  await shot(page, 'D2-sua-bill-bao-oan.png');
  // ghi lại xem có NHÂN BẢN
  await page.locator(M + ' select').nth(1).selectOption({ label: 'Đối ứng' }); await page.waitForTimeout(400);
  await page.locator(M + ' select').first().selectOption('13'); await page.waitForTimeout(350);
  const nguoiHoanCan = await page.evaluate((m) => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Ghi nhận bill')); return b.disabled; }, M);
  log('  nut ghi (chua chon nguoi hoan, da hoan nap tu bill cu) =', nguoiHoanCan);
  await page.locator(M + ' input[placeholder="— Kế toán / Admin —"]').click().catch(() => {});
  await page.waitForTimeout(350);
  await page.getByText('Nhân viên B', { exact: false }).last().click().catch(() => {});
  await page.waitForTimeout(400);
  await tichHet();
  log('  nut ghi sau khi chon nguoi hoan + tich xac nhan =', await nutGhi(page));
  if (!(await nutGhi(page))) {
    await page.getByRole('button', { name: 'Ghi nhận bill' }).click(); await page.waitForTimeout(1100);
    await page.getByRole('button', { name: 'Xong' }).click().catch(() => {});
    await page.waitForTimeout(500);
    const sau = await page.evaluate(() => {
      const rs = [...document.querySelectorAll('tbody tr:not([aria-hidden])')];
      return { tong: rs.length, soBill118: rs.filter((r) => (r.textContent || '').includes('000118')).length };
    });
    log('  SAU khi "ghi" bill da sua: tong dong =', sau.tong, '(truoc =', truocSua + ') · so dong co HD 000118 =', sau.soBill118);
    log('  ->', sau.tong > truocSua ? '*** SUA BILL TAO DONG MOI, bill cu VAN CON -> doanh so X2 ***' : 'thay the dung');
    ok.push(['D2c sua bill phai thay the, khong nhan ban', sau.tong === truocSua]);
    await shot(page, 'D2c-sua-bill-nhan-ban.png');
  }
} catch (e) { console.error('[audit3] LOI:', e.message, '\n', (e.stack || '').split('\n').slice(1, 3).join('\n')); }
finally {
  console.log('\n===== KET QUA #3 =====');
  ok.forEach(([t, v]) => console.log((v ? '  DAT  ' : '  DO   ') + t));
  if (errs.length) { console.log('  page errors:'); errs.slice(0, 8).forEach((e) => console.log('    ', e)); }
  await browser.close(); await server.close(); process.exit(0);
}
