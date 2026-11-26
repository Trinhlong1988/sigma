// AUDIT2-A — TẤN CÔNG BỘ LỌC Ô ĐIỀN SỐ + Ô TÍCH 95 + HÀNG TỔNG + KPI (tự cộng tay từ DOM).
// ĐIỀU KHIỂN THẬT bằng Playwright. CHỈ ĐỌC trang 57912.
import { moTrang, anh, docBang, docKpi, goOSo, soTuChuoi, finding, ok, FINDINGS } from './_audit2-lib.mjs';

const C = { ngay: 1, gio: 2, ca: 3, daiLy: 4, tid: 5, hkd: 6, nh: 7, the: 8, cm: 9, lo: 10, sohd: 11, truocPhi: 12, pctBan: 13, sauPhi: 14, daHoan: 15, nguoiHoan: 16, loaiPhi: 17, ndt: 18, nguoiNhap: 19, ghiChu: 20 };

function congTay(rows) {
  let truoc = 0, sau = 0, hoan = 0;
  for (const r of rows) {
    truoc += soTuChuoi(r[C.truocPhi]);
    sau += soTuChuoi(r[C.sauPhi]);
    hoan += r[C.daHoan] === '—' ? 0 : soTuChuoi(r[C.daHoan]);
  }
  return { truoc, sau, hoan, n: rows.length };
}

async function doiKy(page, tu, den) {
  await page.locator('input[aria-label="Từ ngày"]').fill(tu);
  await page.locator('input[aria-label="Đến ngày"]').fill(den);
  await page.waitForTimeout(250);
}

/** So hàng TỔNG + KPI với tổng CỘNG TAY từ DOM. */
async function soTong(page, nhan) {
  const b = await docBang(page);
  const k = await docKpi(page);
  const tay = congTay(b.rows);
  const foot = b.foot.map((f) => f.text);
  const nBill = Number((foot[0].match(/TỔNG (\d+) bill/) || [])[1] ?? -1);
  const fTruoc = soTuChuoi(foot[2]);
  const fSau = soTuChuoi(foot[4] ?? '');
  const fHoan = soTuChuoi(foot[5] ?? '');
  const kTruoc = soTuChuoi(k[0]?.so ?? '');
  const kSau = soTuChuoi(k[1]?.so ?? '');
  const kHoan = soTuChuoi(k[2]?.so ?? '');
  const lech = [];
  if (nBill !== tay.n) lech.push(`số bill TỔNG=${nBill} vs DOM=${tay.n}`);
  if (fTruoc !== tay.truoc) lech.push(`trước phí TỔNG=${fTruoc} vs cộng tay=${tay.truoc} (lệch ${fTruoc - tay.truoc})`);
  if (fSau !== tay.sau) lech.push(`sau phí TỔNG=${fSau} vs cộng tay=${tay.sau} (lệch ${fSau - tay.sau})`);
  if (fHoan !== tay.hoan) lech.push(`đã hoàn TỔNG=${fHoan} vs cộng tay=${tay.hoan} (lệch ${fHoan - tay.hoan})`);
  if (kTruoc !== tay.truoc) lech.push(`KPI trước phí=${kTruoc} vs cộng tay=${tay.truoc}`);
  if (kSau !== tay.sau) lech.push(`KPI sau phí=${kSau} vs cộng tay=${tay.sau}`);
  if (kHoan !== tay.hoan) lech.push(`KPI đã hoàn=${kHoan} vs cộng tay=${tay.hoan}`);
  if (lech.length) finding('NẶNG', 'A-TONG:' + nhan, 'Hàng TỔNG / KPI không khớp tổng cộng tay từ DOM', lech.join(' · '));
  else ok('A-TONG:' + nhan, 'TỔNG + KPI khớp cộng tay', `${tay.n} bill · trước ${tay.truoc} · sau ${tay.sau} · hoàn ${tay.hoan}`);
  return { b, k, tay, nBill };
}

const { browser, page, log } = await moTrang(1920, 1080);
console.log('\n=== AUDIT2-A · LỌC Ô SỐ + Ô TÍCH 95 + HÀNG TỔNG ===');

// ── 0. Mốc gốc: kỳ hôm nay (mặc định) ───────────────────────────────────────────────────────
const g0 = await soTong(page, 'mặc định(hôm nay)');
console.log('  mốc gốc:', g0.nBill, 'bill ·', JSON.stringify(g0.tay));

// Mở rộng kỳ ra toàn bộ để có nhiều dữ liệu mà tấn công
await doiKy(page, '2026-01-01', '2026-12-31');
const gFull = await soTong(page, 'toàn-kỳ');
console.log('  toàn kỳ:', gFull.nBill, 'bill');
const TAT_CA = gFull.b.rows;

// ── 1. Ô "Số lô": khớp theo ĐẦU SỐ ──────────────────────────────────────────────────────────
async function thuLo(v, nhan) {
  await goOSo(page, 'Số lô', v);
  const b = await docBang(page);
  // Kỳ vọng theo ĐÚNG mã trang: b.lo.replace(/\D/g,'').startsWith(v)
  const kv = TAT_CA.filter((r) => r[C.lo].replace(/[^\d]/g, '').startsWith(String(v)));
  const thuc = b.rows.map((r) => r[C.lo]).sort();
  const mong = kv.map((r) => r[C.lo]).sort();
  const khop = JSON.stringify(thuc) === JSON.stringify(mong);
  return { b, kv, khop, thuc, mong, nhan };
}

// 1a. gõ "82" — phải ra cả "82" lẫn "82(95)" nếu có
let r = await thuLo('82', 'lô=82');
console.log(`  lọc lô "82": ${r.b.rows.length} dòng → ${JSON.stringify([...new Set(r.thuc)])}`);
if (!r.khop) finding('NẶNG', 'A-LO-82', 'Lọc lô theo đầu số không khớp kỳ vọng', `thực ${JSON.stringify(r.thuc)} vs mong ${JSON.stringify(r.mong)}`);

// 1b. BẪY HẬU TỐ (95): lô "15(95)" → chuỗi số là "1595" ⇒ gõ "1595" KHỚP, gõ "15" cũng khớp.
//     Nhưng gõ "159" (không tồn tại lô nào) cũng khớp "15(95)" → LỌC SAI.
r = await thuLo('159', 'lô=159');
const loThat159 = [...new Set(r.thuc)];
console.log(`  lọc lô "159": ${r.b.rows.length} dòng → ${JSON.stringify(loThat159)}`);
const coLoBatThuong = loThat159.some((x) => !x.replace(/\(.*\)/, '').startsWith('159'));
if (coLoBatThuong)
  finding(
    'NẶNG',
    'A-LO-HAUTO-95',
    'Ô lọc số lô DÁN hậu tố đóng lô vào số lô: lọc theo b.lo.replace(/\\D/g,"") nên "15(95)" biến thành chuỗi "1595" ⇒ gõ số lô KHÔNG TỒN TẠI vẫn ra bill (BillManualEntryPage.tsx:633)',
    `gõ "159" → ${r.b.rows.length} dòng, số lô thật = ${JSON.stringify(loThat159)} (không có lô nào bắt đầu bằng 159)`
  );
await anh(page, 'A-lo-159.png');

// 1c. 0 DẪN ĐẦU ở ô lọc số lô
await goOSo(page, 'Số lô', '082');
let b = await docBang(page);
console.log(`  lọc lô "082": ${b.rows.length} dòng`);
if (b.rows.length === 0)
  finding('VỪA', 'A-LO-0DAN', 'Ô lọc số lô KHÔNG bỏ 0 dẫn đầu (khác hẳn ô Số HĐ ngay bên cạnh có bỏ) ⇒ gõ "082" ra rỗng dù có lô 82', `gõ "082" → 0 dòng; gõ "82" → ${r ? '' : ''}có dòng (xem A-LO-82)`);

// 1d. gõ số không tồn tại
await goOSo(page, 'Số lô', '99999');
b = await docBang(page);
const rong = b.rows.length === 0;
const txtRong = await page.locator('tbody').innerText();
console.log(`  lọc lô "99999": ${b.rows.length} dòng · có câu "Không có bill nào khớp": ${/Không có bill nào khớp/.test(txtRong)}`);
if (rong && !/Không có bill nào khớp/.test(txtRong)) finding('VỪA', 'A-LO-RONG', 'Lọc ra rỗng mà không hiện dòng "Không có bill nào khớp"', '0 dòng, không có thông điệp');
// hàng TỔNG khi rỗng
await soTong(page, 'lô=99999(rỗng)');
await anh(page, 'A-lo-99999-rong.png');

// 1e. gõ rồi XÓA → phải quay về đủ
await goOSo(page, 'Số lô', '');
b = await docBang(page);
if (b.rows.length !== TAT_CA.length)
  finding('NẶNG', 'A-LO-XOA', 'Xóa ô lọc số lô không trả lại đủ danh sách', `sau xóa ${b.rows.length} vs gốc ${TAT_CA.length}`);
else ok('A-LO-XOA', 'Xóa ô lọc lô trả lại đủ danh sách', `${b.rows.length} = ${TAT_CA.length}`);

// 1f. ô lọc chặn chữ?
const elLo = page.getByPlaceholder('Số lô', { exact: true });
await elLo.click();
await elLo.fill('');
await elLo.type('12abc34', { delay: 15 });
await page.waitForTimeout(250);
const vLo = await elLo.inputValue();
console.log(`  gõ "12abc34" vào ô lọc lô → ô giữ "${vLo}"`);
if (vLo !== '1234') finding('NHẸ', 'A-LO-CHU', 'Ô lọc số lô không lọc đúng chữ', `giữ "${vLo}"`);
else ok('A-LO-CHU', 'Ô lọc lô bỏ chữ, giữ số', `"12abc34" → "${vLo}" (ghép thành 1234 — xem A-LO-GHEPSO)`);
if (vLo === '1234')
  finding('NHẸ', 'A-LO-GHEPSO', 'Ô lọc số lô GHÉP chữ số hai bên chữ cái thành số khác (12abc34 → 1234) thay vì cắt ở ký tự lạ — cùng lớp lỗi với ô tiền #20', `"12abc34" → "${vLo}"`);
await elLo.fill('');
await page.waitForTimeout(250);

// ── 2. Ô "Số HĐ" ────────────────────────────────────────────────────────────────────────────
await goOSo(page, 'Số HĐ', '118');
b = await docBang(page);
console.log(`  lọc số HĐ "118": ${b.rows.length} dòng → ${JSON.stringify(b.rows.map((x) => x[C.sohd]))}`);
const mongHd = TAT_CA.filter((x) => x[C.sohd].replace(/^0+/, '').startsWith('118'));
if (b.rows.length !== mongHd.length)
  finding('NẶNG', 'A-HD-118', 'Lọc số HĐ không khớp kỳ vọng', `thực ${b.rows.length} vs mong ${mongHd.length}`);
else ok('A-HD-118', 'Lọc số HĐ theo đầu số (đã bỏ 0 dẫn đầu) đúng', `${b.rows.length} dòng`);

await goOSo(page, 'Số HĐ', '000118');
b = await docBang(page);
console.log(`  lọc số HĐ "000118" (0 dẫn đầu): ${b.rows.length} dòng`);
if (b.rows.length !== mongHd.length)
  finding('VỪA', 'A-HD-0DAN', 'Lọc số HĐ với 0 dẫn đầu khác kết quả không có 0', `"000118" → ${b.rows.length} vs "118" → ${mongHd.length}`);
else ok('A-HD-0DAN', 'Ô lọc số HĐ bỏ 0 dẫn đầu như nhau', `cả hai → ${b.rows.length} dòng`);
await goOSo(page, 'Số HĐ', '');

// ── 3. Ô TÍCH "Chỉ lô đóng 95" ───────────────────────────────────────────────────────────────
const tich95 = page.getByText('Chỉ lô đóng 95', { exact: false }).locator('input[type=checkbox]');
await tich95.check();
await page.waitForTimeout(250);
b = await docBang(page);
const sai95 = b.rows.filter((x) => !/\(95\)/.test(x[C.lo]));
console.log(`  tích "Chỉ lô đóng 95": ${b.rows.length} dòng · dòng KHÔNG có (95): ${sai95.length}`);
if (sai95.length) finding('NẶNG', 'A-95', 'Ô tích "Chỉ lô đóng 95" để lọt bill không bị đóng 95', `${sai95.length}/${b.rows.length} dòng sai: ${JSON.stringify(sai95.slice(0, 3).map((x) => x[C.lo]))}`);
else ok('A-95', 'Ô tích 95 lọc đúng', `${b.rows.length} dòng, tất cả có (95)`);
await soTong(page, 'chỉ-95');
await anh(page, 'A-tich-95.png');

// 3b. GIAO NHAU: ô tích 95 + ô số lô
await goOSo(page, 'Số lô', '15');
b = await docBang(page);
const mongGiao = TAT_CA.filter((x) => /\(95\)/.test(x[C.lo]) && x[C.lo].replace(/[^\d]/g, '').startsWith('15'));
console.log(`  95 + lô "15": ${b.rows.length} dòng (mong ${mongGiao.length})`);
if (b.rows.length !== mongGiao.length) finding('NẶNG', 'A-GIAO-95-LO', 'Giao 2 bộ lọc (95 + số lô) sai', `thực ${b.rows.length} vs mong ${mongGiao.length}`);
else ok('A-GIAO-95-LO', 'Giao ô tích 95 + ô số lô đúng', `${b.rows.length} dòng`);
await soTong(page, '95+lô15');
await goOSo(page, 'Số lô', '');
await tich95.uncheck();
await page.waitForTimeout(250);

// ── 4. GIAO NHAU nhiều điều kiện: MultiSelect TID + ô số lô + kỳ hẹp ────────────────────────
// Mở MultiSelect "Tất cả TID" rồi tích 1 TID
async function moMulti(nhan) {
  await page.locator('button', { hasText: nhan }).first().click().catch(() => {});
  await page.waitForTimeout(200);
}
const btnTid = page.locator('button:has-text("Tất cả TID")').first();
if (await btnTid.count()) {
  await btnTid.click();
  await page.waitForTimeout(250);
  const opt = page.locator('label:has-text("DEMO-TID-01")').last();
  if (await opt.count()) {
    await opt.click();
    await page.waitForTimeout(250);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    b = await docBang(page);
    const saiTid = b.rows.filter((x) => x[C.tid] !== 'DEMO-TID-01');
    console.log(`  MultiSelect TID=DEMO-TID-01: ${b.rows.length} dòng · sai TID ${saiTid.length}`);
    if (saiTid.length) finding('NẶNG', 'A-MS-TID', 'MultiSelect TID lọc sai', `${saiTid.length} dòng sai`);
    // nhãn hiện ra khi chọn 1 mục
    const nhanMs = (await page.locator('button:has-text("DEMO-TID-01")').first().innerText().catch(() => '')).trim();
    console.log(`  nhãn MultiSelect sau khi chọn 1: "${nhanMs}"`);
    await soTong(page, 'TID-đơn');
    await anh(page, 'A-ms-tid.png');
    // bỏ chọn lại
    await page.locator('button:has-text("DEMO-TID-01")').first().click();
    await page.waitForTimeout(200);
    const o2 = page.locator('label:has-text("DEMO-TID-01")').last();
    if (await o2.count()) await o2.click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
}

// ── 5. QUÉT NaN/undefined/Infinity/null trong MỌI ô bảng, ở nhiều tổ hợp lọc ────────────────
async function quetXau(nhan) {
  const bb = await docBang(page);
  const xau = [];
  bb.rows.forEach((row, i) => row.forEach((c, j) => { if (/NaN|undefined|Infinity|\bnull\b/.test(c)) xau.push(`dòng${i} cột${j}="${c}"`); }));
  bb.foot.forEach((f, j) => { if (/NaN|undefined|Infinity|\bnull\b/.test(f.text)) xau.push(`TỔNG cột${j}="${f.text}"`); });
  const kk = await docKpi(page);
  kk.forEach((k) => { if (/NaN|undefined|Infinity|\bnull\b/.test(k.so)) xau.push(`KPI ${k.nhan}="${k.so}"`); });
  if (xau.length) finding('NẶNG', 'A-XAU:' + nhan, 'Ô bảng/TỔNG/KPI chứa NaN/undefined/Infinity/null', xau.slice(0, 6).join(' · '));
  else ok('A-XAU:' + nhan, 'Không có NaN/undefined/Infinity/null', `${bb.rows.length} dòng × ${bb.soCotHead} cột`);
}
await doiKy(page, '2026-01-01', '2026-12-31');
await quetXau('toàn-kỳ');
await doiKy(page, '2026-11-07', '2026-11-01'); // KỲ NGHỊCH (từ > đến)
b = await docBang(page);
const kNghich = await docKpi(page);
console.log(`  kỳ NGHỊCH (từ 07/11 → đến 01/11): ${b.rows.length} dòng · KPI = ${JSON.stringify(kNghich.map((x) => x.so))}`);
await quetXau('kỳ-nghịch');
await anh(page, 'A-ky-nghich.png');
if (b.rows.length === 0) {
  const dd = kNghich.map((x) => x.so).join(' ');
  if (!/^(\s|0đ|\+0đ|−0đ)+$/.test(dd.replace(/[^\d+−0đ\s]/g, '')) && /[1-9]/.test(dd))
    finding('VỪA', 'A-KY-NGHICH', 'Kỳ nghịch (từ > đến) không cảnh báo gì, bảng rỗng nhưng KPI vẫn có số', `KPI=${JSON.stringify(kNghich.map((x) => x.so))}`);
  else ok('A-KY-NGHICH', 'Kỳ nghịch cho bảng rỗng + KPI 0', JSON.stringify(kNghich.map((x) => x.so)));
}
await doiKy(page, '2026-01-01', '2026-12-31');

// ── 6. "Chọn tất cả" rồi ĐỔI BỘ LỌC (lỗi cũ #2) ─────────────────────────────────────────────
const chonTatCa = page.locator('input[aria-label="Chọn tất cả"]');
await chonTatCa.check();
await page.waitForTimeout(250);
let nutXoa = (await page.locator('[data-nut="xoabill"]').innerText()).trim();
const tongTruoc = (await docBang(page)).rows.length;
console.log(`  chọn tất cả ở toàn kỳ (${tongTruoc} bill) → nút: "${nutXoa}"`);
await goOSo(page, 'Số lô', '82');
const sauLoc = await docBang(page);
nutXoa = (await page.locator('[data-nut="xoabill"]').innerText()).trim();
console.log(`  sau khi lọc lô 82 (${sauLoc.rows.length} bill hiện) → nút vẫn: "${nutXoa}"`);
const nTrongNut = Number((nutXoa.match(/Xóa (\d+) bill/) || [])[1] ?? -1);
if (nTrongNut > sauLoc.rows.length)
  finding(
    'CHẶN SHIP',
    'A-TICH-TRON',
    'Tích "Chọn tất cả" rồi đổi bộ lọc: nút xóa vẫn giữ N của tập CŨ ⇒ bấm xóa sẽ xóa bill KHÔNG nhìn thấy trên màn (daTich không được lọc lại theo danhSachLoc — BillManualEntryPage.tsx:1346 + 412)',
    `nút "Xóa ${nTrongNut} bill" trong khi màn chỉ hiện ${sauLoc.rows.length} bill → ${nTrongNut - sauLoc.rows.length} bill vô hình bị kéo theo`
  );
await anh(page, 'A-tich-tron-loc.png');
// ô "Chọn tất cả" lúc này
const ttc = await chonTatCa.isChecked();
console.log(`  ô "Chọn tất cả" sau lọc: checked=${ttc}`);
await goOSo(page, 'Số lô', '');
await chonTatCa.uncheck().catch(() => {});
await page.waitForTimeout(200);

// ── 7. Nút "Xóa lọc" có xóa KỲ không (lỗi cũ #21) ───────────────────────────────────────────
await doiKy(page, '2026-01-01', '2026-12-31');
const nTruocXoaLoc = (await docBang(page)).rows.length;
await page.locator('[data-nut="xoaloc"]').click();
await page.waitForTimeout(350);
const tu = await page.locator('input[aria-label="Từ ngày"]').inputValue();
const den = await page.locator('input[aria-label="Đến ngày"]').inputValue();
const nSauXoaLoc = (await docBang(page)).rows.length;
console.log(`  "Xóa lọc": kỳ → ${tu} … ${den} · ${nTruocXoaLoc} → ${nSauXoaLoc} bill`);
if (tu !== '' || den !== '')
  finding('VỪA', 'A-XOALOC-KY', 'Nút "Xóa lọc" KHÔNG xóa kỳ mà ĐẶT kỳ = hôm nay ⇒ danh sách THU HẸP lại thay vì mở ra (xoaLoc() BillManualEntryPage.tsx:717-718)', `sau Xóa lọc kỳ = "${tu}" → "${den}", số bill ${nTruocXoaLoc} → ${nSauXoaLoc}`);
await anh(page, 'A-sau-xoa-loc.png');

// ── 8. Lỗi console / pageerror trong suốt phiên ─────────────────────────────────────────────
const loi = log.filter((x) => x.type === 'error' || x.type === 'pageerror');
console.log(`\n  console error/pageerror: ${loi.length}`);
loi.slice(0, 5).forEach((x) => console.log('   ', x.type, x.text.slice(0, 200)));
if (loi.length) finding('NẶNG', 'A-CONSOLE', 'Có lỗi console/pageerror khi tấn công bộ lọc', loi.slice(0, 3).map((x) => x.type + ': ' + x.text.slice(0, 120)).join(' | '));

console.log(`\n=== AUDIT2-A xong · ${FINDINGS.length} finding ===`);
await browser.close();
