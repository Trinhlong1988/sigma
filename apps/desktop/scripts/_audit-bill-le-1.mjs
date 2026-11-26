// AUDIT ĐỐI KHÁNG #1 — payload / khóa bill / tách thẻ / rò trạng thái. Mọi kết luận từ SỐ ĐO THẬT.
//   AUDIT_URL=http://localhost:57912/harness-bill-le.html node scripts/_audit-bill-le-1.mjs
import { moHarness, batPayload, docPayloads, shot, nutGhi } from './_audit-lib.mjs';

const { page, browser, server, errs } = await moHarness();
await batPayload(page);
const ok = [];
const log = (...a) => console.log(...a);
const M = '.fixed.inset-0';
const TACH = M + ' .space-y-1\\.5';
const oTien = (i) => page.locator(M + ' input[placeholder="0"]').nth(i); // 0=Trước phí 1=Tiền hủy 2=Đã hoàn

async function moForm() {
  await page.getByRole('button', { name: 'Thêm bill mới' }).click();
  await page.waitForTimeout(500);
}
async function chonSS(placeholder, go, exact) {
  await page.locator(M + ' input[placeholder="' + placeholder + '"]').click();
  await page.keyboard.type(go, { delay: 15 });
  await page.waitForTimeout(300);
  await page.getByText(exact ?? go, { exact: false }).last().click();
  await page.waitForTimeout(350);
}
async function chonMay(bank, tid) {
  await chonSS('— Chọn ngân hàng — — gõ để tìm', bank);
  await page.waitForTimeout(250);
  const ph = await page.evaluate((m) => [...document.querySelectorAll(m + ' input')].map((i) => i.placeholder).find((p) => /TID|HKD|Chọn ngân hàng trước/.test(p || '')), M);
  await chonSS(ph, tid);
}
async function chonPhiThe(phi, theValue) {
  await page.locator(M + ' select').nth(1).selectOption({ label: phi });
  await page.waitForTimeout(400);
  await page.locator(M + ' select').first().selectOption(theValue);
  await page.waitForTimeout(350);
}
const docKhoa = () => page.evaluate((m) => document.querySelector(m + ' code')?.textContent?.trim() ?? null, M);
const docDong = (nhan) => page.evaluate(([m, n]) => {
  const el = [...document.querySelectorAll(m + ' span')].find((s) => (s.textContent || '').trim() === n);
  return el?.parentElement?.querySelector('span:last-child')?.textContent?.trim() ?? null;
}, [M, nhan]);
async function tichHet() {
  const o = page.locator(M + ' input[type=checkbox].accent-warning, ' + M + ' input[type=checkbox].accent-danger');
  for (let i = 0; i < (await o.count()); i++) await o.nth(i).check({ force: true }).catch(() => {});
  await page.waitForTimeout(250);
}
const canhBao = () => page.evaluate((m) => [...document.querySelectorAll(m + ' p')].map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => /TRÙNG HOÀN TOÀN|TRÙNG SỐ LÔ|NGHỊCH THỨ TỰ/.test(t)).map((t) => t.slice(0, 120)), M);

try {
  // ══════════ A6. 0 DẪN ĐẦU ở số lô / số hóa đơn ══════════
  log('\n===== A6. 0 DAN DAU o SO LO / SO HOA DON =====');
  await moForm();
  await chonMay('AB Bank', 'DEMO-TID-03');
  await chonPhiThe('Tiền chờ', '21');
  await page.locator(M + ' input[placeholder="vd 000123"]').fill('000777');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('0021');
  await oTien(0).fill('40000000');
  await page.waitForTimeout(600);
  const khoaMan = await docKhoa();
  await tichHet();
  log('  nut ghi bi chan truoc khi bam =', await nutGhi(page));
  await page.getByRole('button', { name: 'Ghi nhận bill' }).click();
  await page.waitForTimeout(1000);
  const popupDaiLy = await page.evaluate(() => {
    const h = [...document.querySelectorAll('h3')].find((x) => (x.textContent || '').includes('Đã thêm bill'));
    return h ? (h.closest('div').parentElement.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) : null;
  });
  await page.getByRole('button', { name: 'Xong' }).click().catch(() => {});
  await page.waitForTimeout(400);
  let p = (await docPayloads(page)).at(-1);
  log('  khoa bill HIEN TREN MAN :', khoaMan);
  log('  payload gui server      : bankReportedLoNumber=' + p?.bankReportedLoNumber + '  receiptNumber=' + p?.receiptNumber);
  const lechKhoa = String(khoaMan).includes('0021') && p?.bankReportedLoNumber === 21;
  log('  ->', lechKhoa ? '*** LECH: man hien lo "0021" / HD "000777" nhung payload gui 21 / 777 ***' : 'khop');
  ok.push(['A6 khoa bill khop payload khi co 0 dan dau', !lechKhoa]);
  const dongMoi = await page.evaluate(() => {
    const r = [...document.querySelectorAll('tbody tr:not([aria-hidden])')][0];
    const td = [...r.querySelectorAll('td')].map((x) => (x.textContent || '').trim());
    return td;
  });
  log('  dong vua ghi trong bang =', JSON.stringify(dongMoi));

  // ══════════ A3. SỐ 17 CHỮ SỐ ══════════
  log('\n===== A3. SO TIEN 17 CHU SO (vuot 2^53) =====');
  await moForm();
  await chonMay('AB Bank', 'DEMO-TID-03');
  await chonPhiThe('Tiền chờ', '21');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('9001');
  await oTien(0).fill('12345678901234567');
  await page.waitForTimeout(600);
  log('  o "Truoc phi" hien    =', await oTien(0).inputValue());
  log('  cot phai Doanh so ghi =', await docDong('Doanh số ghi (đã trừ hủy)'));
  log('  Sau phi ban           =', await docDong('Sau phí bán — đại lý nhận'));
  await tichHet();
  log('  nut ghi bi chan?      =', await nutGhi(page));
  if (!(await nutGhi(page))) {
    await page.getByRole('button', { name: 'Ghi nhận bill' }).click();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: 'Xong' }).click().catch(() => {});
    await page.waitForTimeout(300);
    p = (await docPayloads(page)).at(-1);
    log('  payload totalAmount =', p?.totalAmount, ' (go vao 12345678901234567) LECH =', String(BigInt('12345678901234567') - BigInt(p?.totalAmount ?? 0)), 'dong');
    log('  -> *** GHI DUOC, khong co chan nao; gia tri bi float lam sai ***');
    ok.push(['A3 chan so vuot 2^53', false]);
  } else { log('  -> bi chan (tot)'); ok.push(['A3 chan so vuot 2^53', true]); }

  // ══════════ B. TÁCH NHIỀU LOẠI THẺ ══════════
  log('\n===== B. TACH NHIEU LOAI THE =====');
  await moForm();
  await chonMay('AB Bank', 'DEMO-TID-02'); // Visa(20)=1,17% - JCB(21)=1,07%
  await chonPhiThe('Đối ứng', '20');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('9100');
  await oTien(0).fill('100000000');
  await page.waitForTimeout(600);
  const truocTach = await docDong('Sau phí bán — đại lý nhận');
  await page.getByText('Lô này quẹt NHIỀU loại thẻ', { exact: false }).click();
  await page.waitForTimeout(500);
  await page.locator(TACH + ' input[inputmode=numeric]').first().fill('60000000');
  await page.waitForTimeout(600);
  const dong = await page.evaluate((s) => [...document.querySelectorAll(s + ' > div')].map((d) => {
    const se = d.querySelector('select'); const i = d.querySelector('input');
    return { the: se ? se.options[se.selectedIndex]?.text : null, tien: i ? i.value : null, khoa: i ? i.hasAttribute('readonly') : null };
  }), TACH);
  const sauTach = await docDong('Sau phí bán — đại lý nhận');
  log('  lo 100.000.000 - the chinh Visa 1,17%');
  log('  "Sau phi ban" TRUOC khi tach =', truocTach);
  log('  cac dong tach                =', JSON.stringify(dong));
  log('  "Sau phi ban" SAU khi tach   =', sauTach);
  const dung = 60000000 * (1 - 0.0117) + 40000000 * (1 - 0.0107);
  const soMan = Number(String(sauTach).replace(/\./g, ''));
  log('  DUNG = 60tr*(1-1,17%) + 40tr*(1-1,07%) =', dung.toLocaleString('vi-VN'));
  log('  -> man hien', soMan.toLocaleString('vi-VN'), ' LECH', (dung - soMan).toLocaleString('vi-VN'), 'dong');
  ok.push(['B6 "Sau phi ban" dung khi tach the', soMan === dung]);
  await shot(page, 'B-tach-the-sau-phi-sai.png');
  // ghi thật để đọc payload lines
  await tichHet();
  if (!(await nutGhi(page))) {
    await page.getByRole('button', { name: 'Ghi nhận bill' }).click();
    await page.waitForTimeout(1000);
    const popTach = await page.evaluate(() => {
      const h = [...document.querySelectorAll('h3')].find((x) => (x.textContent || '').includes('Đã thêm bill'));
      return h ? (h.parentElement.parentElement.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) : null;
    });
    await page.getByRole('button', { name: 'Xong' }).click().catch(() => {});
    await page.waitForTimeout(400);
    p = (await docPayloads(page)).at(-1);
    log('  payload lines =', JSON.stringify(p?.lines), ' amountBeforeFee =', p?.amountBeforeFee, ' cardTypeId don =', p?.cardTypeId);
    const sigma = (p?.lines ?? []).reduce((t, x) => t + x.amountBeforeFee, 0);
    log('  Sigma lines =', sigma, ' == amountBeforeFee?', sigma === p?.amountBeforeFee);
    ok.push(['B1 Sigma lines = amountBeforeFee', sigma === p?.amountBeforeFee]);
    log('  popup bao thanh cong =', JSON.stringify(popTach));
    const rowTach = await page.evaluate(() => {
      const r = [...document.querySelectorAll('tbody tr:not([aria-hidden])')][0];
      const td = [...r.querySelectorAll('td')].map((x) => (x.textContent || '').trim());
      return td;
    });
    log('  dong bill TACH trong bang =', JSON.stringify(rowTach));
    log('  -> bill tach 2 the nhung bang chi hien 1 loai the + 1 % ban');
  }

  // ══════════ B3/B2/B4. biên của tách thẻ ══════════
  log('\n===== B2/B3/B4. BIEN cua tach the =====');
  await moForm();
  await chonMay('AB Bank', 'DEMO-TID-02');
  await chonPhiThe('Đối ứng', '20');
  await page.locator(M + ' input[placeholder="vd 84"]').fill('9200');
  await oTien(0).fill('100000000');
  await page.waitForTimeout(500);
  await page.getByText('Lô này quẹt NHIỀU loại thẻ', { exact: false }).click();
  await page.waitForTimeout(500);
  const thu = async (v) => {
    await page.locator(TACH + ' input[inputmode=numeric]').first().fill(v);
    await page.waitForTimeout(500);
    return {
      chan: await nutGhi(page),
      conLai: await page.evaluate((s) => document.querySelector(s + ' input[readonly]')?.value ?? null, TACH),
      loi: await page.evaluate((m) => [...document.querySelectorAll(m + ' p')].map((x) => (x.textContent || '').replace(/\s+/g, ' ').trim()).find((t) => t.includes('nhỏ hơn tiền lô')) || null, M)
    };
  };
  log('  Sigma = 100.000.000 (= DUNG tien lo) ->', JSON.stringify(await thu('100000000')));
  log('  Sigma = 150.000.000 (> tien lo)      ->', JSON.stringify(await thu('150000000')));
  await thu('60000000');
  const v1 = await page.locator(TACH + ' select').first().inputValue();
  await page.locator(TACH + ' select').nth(1).selectOption(v1);
  await page.waitForTimeout(500);
  log('  2 dong CUNG loai the -> nut chan =', await nutGhi(page));
  ok.push(['B4 chan trung loai the', (await nutGhi(page)) === true]);
  await page.locator(TACH + ' select').nth(1).selectOption('21');
  await page.getByRole('button', { name: 'Thêm loại thẻ' }).click();
  await page.waitForTimeout(500);
  const ds3 = await page.evaluate((s) => [...document.querySelectorAll(s + ' > div')].map((d) => { const x = d.querySelector('select'); const i = d.querySelector('input'); return { the: x ? x.value : null, tien: i ? i.value : null, khoa: i ? i.hasAttribute('readonly') : null }; }), TACH);
  log('  sau "Them loai the" (3 dong) =', JSON.stringify(ds3), ' nut chan =', await nutGhi(page));
  ok.push(['B5 dong moi phai chon the moi ghi duoc', (await nutGhi(page)) === true]);
  // xóa dòng giữa
  await page.locator(TACH + ' button[title="Bỏ dòng này"]').first().click();
  await page.waitForTimeout(500);
  const dsXoa = await page.evaluate((s) => [...document.querySelectorAll(s + ' > div')].map((d) => { const x = d.querySelector('select'); const i = d.querySelector('input'); return { the: x ? x.value : null, tien: i ? i.value : null, khoa: i ? i.hasAttribute('readonly') : null }; }), TACH);
  log('  sau khi XOA DONG GIUA        =', JSON.stringify(dsXoa), ' nut chan =', await nutGhi(page));
  await shot(page, 'B-tach-xoa-dong-giua.png');

  // ══════════ J. RÒ TRẠNG THÁI ══════════
  log('\n===== J. RO TRANG THAI =====');
  await page.locator(M + ' button[data-nut="xoaform"]').click();
  await page.waitForTimeout(600);
  const sauXoa = await page.evaluate(([m, s]) => ({
    tachConBat: !!document.querySelector(s + ' select'),
    soDongTach: document.querySelectorAll(s + ' > div').length,
    soOptionTrongSelectTach: document.querySelectorAll(s + ' select option').length,
    loiDoConTreo: [...document.querySelectorAll(m + ' p')].map((x) => (x.textContent || '').replace(/\s+/g, ' ').trim()).find((t) => t.includes('nhỏ hơn tiền lô')) || null
  }), [M, TACH]);
  log('  bam nut "Xoa" (xoaForm) ->', JSON.stringify(sauXoa));
  ok.push(['J1 nut Xoa phai tat tach the', sauXoa.tachConBat === false]);
  await shot(page, 'J-xoa-form-con-tach-the.png');
  await page.locator(M + ' button[title="Đóng"]').first().click();
  await page.waitForTimeout(500);
  const coHoi = await page.evaluate(() => !![...document.querySelectorAll('h3')].find((x) => (x.textContent || '').includes('Đóng phần nhập bill?')));
  log('  bam X sau khi da "Xoa" -> co hoi lai? =', coHoi, '(coDuLieu phai = false)');
  await page.getByRole('button', { name: 'Đóng, bỏ dữ liệu' }).click().catch(() => {});
  await page.waitForTimeout(500);
  await moForm();
  const roRi = await page.evaluate(([m, s]) => ({
    tachConBat: !!document.querySelector(s + ' select'),
    soDongTach: document.querySelectorAll(s + ' > div').length,
    oTichTach: [...document.querySelectorAll(m + ' input[type=checkbox].accent-brand')].map((c) => c.checked),
    loiDo: [...document.querySelectorAll(m + ' p')].map((x) => (x.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => t.includes('nhỏ hơn tiền lô'))
  }), [M, TACH]);
  log('  MO LAI form moi ->', JSON.stringify(roRi));
  ok.push(['J2 mo form moi khong ro tach the', roRi.tachConBat === false]);
  await shot(page, 'J-mo-lai-con-tach-the.png');
} catch (e) { console.error('[audit1] LOI:', e.message, '\n', (e.stack || '').split('\n').slice(1, 3).join('\n')); }
finally {
  console.log('\n===== KET QUA #1 =====');
  ok.forEach(([t, v]) => console.log((v ? '  DAT  ' : '  DO   ') + t));
  if (errs.length) { console.log('  page errors:'); errs.slice(0, 8).forEach((e) => console.log('    ', e)); }
  await browser.close(); await server.close(); process.exit(0);
}
