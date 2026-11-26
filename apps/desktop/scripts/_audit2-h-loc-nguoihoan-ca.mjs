// AUDIT2-H — lọc "(chưa có người hoàn)" có tách được BILL ĐÃ HOÀN MÀ THIẾU VẾT không · cột Ca có đúng luật
// ca-tien không · KPI "Chênh lệch" có = Sau phí − Đã hoàn không (cộng tay từ DOM).
import { moTrang, anh, docBang, docKpi, soTuChuoi, finding, ok, FINDINGS } from './_audit2-lib.mjs';

const C = { ngay: 1, gio: 2, ca: 3, daiLy: 4, tid: 5, hkd: 6, nh: 7, the: 8, cm: 9, lo: 10, sohd: 11, truocPhi: 12, pctBan: 13, sauPhi: 14, daHoan: 15, nguoiHoan: 16 };
// mốc ca lấy ĐÚNG từ packages/services/src/ca-tien.ts như trang khai (MB 09:40/16:40 · ABB 09:50/14:50 · MBV 11:50/17:50)
const MOC = { MB: [580, 1000], ABB: [590, 890], MBV: [710, 1070] };
function khoa(b) {
  const x = (b || '').trim().toUpperCase();
  if (!x) return null;
  if (x === 'MBV' || x.startsWith('MBV')) return 'MBV';
  if (x === 'ABB' || x.startsWith('ABB') || x === 'AB BANK' || x.startsWith('AB ')) return 'ABB';
  if (x === 'MB' || x === 'MBB' || x.startsWith('MB ') || x === 'MBBANK') return 'MB';
  return null;
}
function caDung(bank, gio) {
  const k = khoa(bank); const m = /^(\d{1,2}):(\d{2})/.exec(gio || '');
  if (!k || !m) return null;
  const p = +m[1] * 60 + +m[2];
  return p <= MOC[k][0] ? 1 : p <= MOC[k][1] ? 2 : 3;
}

const { browser, page } = await moTrang(1920, 1080);
console.log('=== AUDIT2-H ===');
await page.locator('input[aria-label="Từ ngày"]').fill('2026-01-01');
await page.locator('input[aria-label="Đến ngày"]').fill('2026-12-31');
await page.waitForTimeout(400);
const b0 = await docBang(page);

// ── 1. CỘT CA ────────────────────────────────────────────────────────────────────────────────
const saiCa = [];
for (const r of b0.rows) {
  const mong = caDung(r[C.nh], r[C.gio]);
  const thuc = r[C.ca] === '-' ? null : Number(r[C.ca]);
  if ((mong ?? null) !== (thuc ?? null)) saiCa.push(`${r[C.nh]} ${r[C.gio]} → màn "${r[C.ca]}" vs luật ${mong}`);
}
console.log(`  cột Ca: kiểm ${b0.rows.length} dòng · sai ${saiCa.length}`);
if (saiCa.length) finding('NẶNG', 'H-CA', 'Cột Ca không khớp mốc ca-tien.ts', saiCa.slice(0, 5).join(' · '));
else ok('H-CA', 'Cột Ca khớp mốc ca-tien.ts trên mọi dòng (MB 09:40/16:40 · ABB 09:50/14:50 · MBV 11:50/17:50)', `${b0.rows.length} dòng`);
// bank ngoài bảng ca → "-"
const nganhVp = b0.rows.filter((r) => /VP/.test(r[C.nh]));
console.log(`  bill VP bank (ngoài bảng ca): ${nganhVp.length} dòng, cột Ca = ${JSON.stringify([...new Set(nganhVp.map((r) => r[C.ca]))])}`);

// ── 2. KPI Chênh lệch = Sau phí − Đã hoàn ────────────────────────────────────────────────────
const k = await docKpi(page);
let sau = 0, hoan = 0;
for (const r of b0.rows) { sau += soTuChuoi(r[C.sauPhi]); hoan += r[C.daHoan] === '—' ? 0 : soTuChuoi(r[C.daHoan]); }
const kpiChenh = soTuChuoi(k[4].so);
console.log(`  KPI "${k[4].nhan}" = ${k[4].so} · cộng tay (sau phí ${sau} − đã hoàn ${hoan}) = ${sau - hoan}`);
if (Math.abs(kpiChenh) !== Math.abs(sau - hoan)) finding('NẶNG', 'H-KPI-CHENH', 'KPI chênh lệch không bằng (Sau phí bán − Đã hoàn) cộng tay', `KPI ${kpiChenh} vs cộng tay ${sau - hoan}`);
else ok('H-KPI-CHENH', 'KPI chênh lệch = Sau phí − Đã hoàn (cộng tay khớp)', `${kpiChenh}`);

// ── 3. Lọc "(chưa có người hoàn)" ─────────────────────────────────────────────────────────────
const btn = page.locator('button:has-text("Tất cả người hoàn")').first();
await btn.click();
await page.waitForTimeout(350);
const ds = await page.evaluate(() => [...document.querySelectorAll('button')].map((x) => (x.textContent || '').trim()).filter((t) => t && t.length < 40 && !/Chọn tất cả|Bỏ chọn/.test(t)));
console.log('  mục trong dropdown "người hoàn":', JSON.stringify(ds.filter((x) => /hoàn|KT Demo|ND Demo|KH Demo/.test(x))));
await page.locator('button:has-text("(chưa có người hoàn)")').last().click();
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const b1 = await docBang(page);
const chuaHoanGi = b1.rows.filter((r) => r[C.daHoan] === '—');
const daHoanThieuVet = b1.rows.filter((r) => r[C.daHoan] !== '—' && /THIẾU/.test(r[C.nguoiHoan]));
console.log(`  lọc "(chưa có người hoàn)": ${b1.rows.length} dòng · trong đó CHƯA HOÀN GÌ = ${chuaHoanGi.length} · ĐÃ HOÀN mà THIẾU vết = ${daHoanThieuVet.length}`);
await anh(page, 'H-loc-chua-co-nguoi-hoan.png');
if (chuaHoanGi.length && !daHoanThieuVet.length)
  finding('VỪA', 'H-LOC-NGUOIHOAN-GOP',
    'Mục lọc "(chưa có người hoàn)" GỘP 2 việc khác hẳn nhau: bill CHƯA HOÀN ĐỒNG NÀO và bill ĐÃ HOÀN MÀ THIẾU VẾT ai trả — vì biểu thức lọc là `b.daHoan ? b.nguoiHoan || "" : ""` nên bill daHoan=0 cũng map thành "" ⇒ KHÔNG CÓ cách nào lọc riêng ô đỏ "THIẾU" (chính là ô nguy hiểm cần soi) (BillManualEntryPage.tsx:641)',
    `chọn "(chưa có người hoàn)" → ${b1.rows.length} dòng, trong đó ${chuaHoanGi.length} dòng chỉ là CHƯA HOÀN (cột Đã hoàn = "—"), ${daHoanThieuVet.length} dòng là ĐÃ HOÀN mà thiếu vết`);
else ok('H-LOC-NGUOIHOAN-GOP', 'Mục lọc "(chưa có người hoàn)" tách đúng', `${b1.rows.length} dòng`);
// hàng TỔNG của tập này
const kk = await docKpi(page);
let s2 = 0; for (const r of b1.rows) s2 += soTuChuoi(r[C.truocPhi]);
const f2 = soTuChuoi(b1.foot[2].text);
console.log(`  hàng TỔNG của tập lọc: ${b1.foot[0].text} · trước phí ${b1.foot[2].text} · cộng tay ${s2}`);
if (f2 !== s2) finding('NẶNG', 'H-TONG-NGUOIHOAN', 'Hàng TỔNG không khớp tập đã lọc theo người hoàn', `TỔNG ${f2} vs cộng tay ${s2}`);
else ok('H-TONG-NGUOIHOAN', 'Hàng TỔNG khớp tập lọc theo người hoàn', `${f2} = ${s2} · ${b1.rows.length} bill`);

console.log(`\n=== AUDIT2-H xong · ${FINDINGS.length} finding ===`);
await browser.close();
