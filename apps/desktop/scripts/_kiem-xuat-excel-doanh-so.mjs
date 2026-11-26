// B227 — [Admin Demo 22/11 "lỗi không xuất được excel"] NÚT XUẤT EXCEL Ở MÀN DOANH SỐ PHẢI RA FILE THẬT.
//
// Ca thật: nút gọi `window.api.exportBillLeExcel` — hàm CHỈ CÓ trong bản demo (`_mock-api-alpha.ts`),
// KHÔNG có trong preload/main/web-shim. Trên app thật luôn rơi vào nhánh "Bản demo chưa nối API xuất
// Excel" ⇒ nút CHƯA TỪNG xuất được. Đúng lớp lỗi "làm xong nhưng không cắm dây".
//
// Cổng khoá 6 điều — TẢI FILE THẬT RỒI MỞ RA ĐỌC, không đọc mã rồi suy:
//   (1) mã KHÔNG còn gọi hàm chỉ-có-trong-demo;
//   (2) bấm nút trên bản web đang chạy thì trình duyệt NHẬN ĐƯỢC file .xlsx (không im lặng);
//   (3) file mở ra được bằng thư viện Excel thật;
//   (4) số dòng = số bill đang hiện trên màn;
//   (5) có đủ cột, trong đó có cột "Chênh lệch" mới thêm;
//   (6) ĐỐI CHỨNG số tiền: ô "Trước phí" dòng đầu KHỚP số trên màn (chống xuất ra cột rỗng/số 0 câm).
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import ExcelJS from 'exceljs';

const GOC = resolve(import.meta.dirname, '../../..');
const WEB = process.env.WEB_THU || 'http://127.0.0.1:57915';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[xuat-excel] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 20;

// ── (1) Quét mã: không còn gọi hàm chỉ-có-trong-demo ──
const trang = readFileSync(resolve(GOC, 'apps/desktop/src/renderer/src/pages/BillManualEntryPage.tsx'), 'utf8');
// BỎ QUA dòng chú thích — chính chú thích giải thích lỗi cũ có chứa tên hàm, quét cả chú thích là ĐỎ OAN
// (đã cắn đúng lỗi này ở cổng B210 hồi 19/11).
const XUONG_DONG = String.fromCharCode(10);
const maThat = trang.split(XUONG_DONG).filter((d) => {
  const x = d.trim();
  return !(x.startsWith('//') || x.startsWith('*') || x.startsWith('/*'));
}).join(XUONG_DONG);
const conDemo = /api\.exportBillLeExcel|exportBillLeExcel\?\./.test(maThat);
chot(!conDemo && /exportCsv\(/.test(trang),
  'nút xuất dùng đường xuất THẬT (exportCsv), không gọi hàm chỉ có trong bản demo');

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN = 'kiem-b227';
let b = null;
let chupPhi = null; // [B244] bản chụp phí mua NĐT trước khi BỒI dữ liệu, để trả sổ thử về nguyên trạng
try {
  const ngay = (await db.query(
    `SELECT to_char(COALESCE(bill_txn_date, created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') d, count(*)::int n
       FROM los WHERE status <> 'CANCELLED' GROUP BY 1 ORDER BY n DESC LIMIT 1`)).rows[0];
  if (!ngay) throw new Error('DB thử không có bill nào để xuất');
  console.log('      kỳ xem', ngay.d, '·', ngay.n, 'bill trong sổ');

  // [B244 22/11] BỒI DỮ LIỆU: sổ thử chưa khai phí mua NĐT nào ⇒ cột "Sau phí mua NĐT" toàn chữ
  // "— n bill chưa khai", phép đối chứng sẽ thành 0 = 0 (xanh RỖNG, không chứng minh được gì).
  // Khai 1,2% cho mọi biểu phí đang hiệu lực, chạy xong TRẢ LẠI NGUYÊN TRẠNG ở khối finally.
  chupPhi = (await db.query('SELECT id, phi_mua_ndt FROM tid_sell_fees')).rows;
  await db.query('UPDATE tid_sell_fees SET phi_mua_ndt = 1200 WHERE deleted_at IS NULL AND phi_mua_ndt IS NULL');
  console.log('      bồi phí mua NĐT 1,2% cho', chupPhi.length, 'dòng biểu phí (sẽ trả lại sau khi kiểm)');

  const tho = randomUUID();
  await db.query(
    `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
     VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '10 minutes',now(),$2)`,
    [createHash('sha256').update(tho).digest('hex'), NHAN]
  );
  b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, acceptDownloads: true });
  await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
  const p = await ctx.newPage();
  await p.goto(WEB + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
  const menu = p.locator("[data-kiem='nut-menu']");
  if (await menu.count()) { await menu.first().click(); await p.waitForTimeout(600); }
  const link = p.getByText('Doanh Số', { exact: false }).first();
  if (await link.count()) { await link.click(); await p.waitForTimeout(2000); }
  for (const o of await p.locator('input[type="date"]').all()) { await o.fill(ngay.d); await p.waitForTimeout(350); }
  await p.waitForTimeout(2500);

  // Số bill + số tiền ĐANG HIỆN trên màn — để đối chiếu với file xuất ra.
  const tren = await p.evaluate(() => {
    const tb = document.querySelector('table');
    const th = [...tb.querySelectorAll('thead th')].map((x) => (x.textContent || '').trim());
    const hang = [...tb.querySelectorAll('tbody tr')].filter((r) => r.querySelectorAll('td').length === th.length);
    const i = th.indexOf('Trước phí');
    return { soDong: hang.length, truocPhiDong1: (hang[0]?.querySelectorAll('td')[i]?.textContent || '').trim() };
  });
  console.log('      trên màn:', tren.soDong, 'dòng · "Trước phí" dòng đầu =', tren.truocPhiDong1);

  // [B228] Bấm "Xuất Excel" mở HỘP TÍCH CHỌN trước; phải bấm "Xuất Excel" trong hộp mới ra file.
  await p.locator('[data-nut="excel"]').first().click();
  await p.waitForTimeout(900);
  const coHop = await p.locator('[data-nut="ex-tach-sheet"]').count();
  chot(coHop === 1 && (await p.locator('[data-nut="ex-an-daily"]').count()) === 1
    && (await p.locator('[data-nut="ex-an-nguoinhap"]').count()) === 1,
    'bấm "Xuất Excel" hiện HỘP TÍCH CHỌN đủ 3 nút tích RIÊNG (ẩn đại lý · ẩn người nhập · tách sheet)');
  const [tai] = await Promise.all([
    p.waitForEvent('download', { timeout: 30000 }).catch(() => null),
    p.locator('[data-nut="ex-xuat"]').first().click()
  ]);
  chot(!!tai, 'bấm "Xuất Excel" thì trình duyệt NHẬN ĐƯỢC file (không im lặng)');
  if (!tai) throw new Error('không có file nào được tải về');
  const duong = await tai.path();
  console.log('      tên file:', tai.suggestedFilename());

  const wb = new ExcelJS.Workbook();
  let ws = null;
  try {
    await wb.xlsx.readFile(duong);
    ws = wb.worksheets[0];
  } catch (e) {
    console.log('      KHÔNG mở được file:', e.message);
  }
  chot(!!ws, 'file mở ra được bằng thư viện Excel thật (.xlsx hợp lệ)');
  if (!ws) throw new Error('file hỏng');

  // Dò hàng tiêu đề (bản mẫu có tiêu đề/khoảng trắng phía trên).
  // Bản mẫu chuẩn nhà viết TÊN CỘT IN HOA (buildReportWorkbook: headers.map(toUpperCase)) và đặt ở
  // hàng 3 (hàng 1 tiêu đề, hàng 2 tổng hợp). So chữ phải BỎ QUA hoa/thường, nếu không là đỏ oan.
  const hoa = (x) => String(x ?? '').trim().toUpperCase();
  let hTieuDe = 0;
  for (let r = 1; r <= Math.min(12, ws.rowCount); r++) {
    const v = ws.getRow(r).values.map(hoa);
    if (v.includes('TRƯỚC PHÍ') && v.includes('TID')) { hTieuDe = r; break; }
  }
  const tieuDe = hTieuDe ? ws.getRow(hTieuDe).values.map(hoa).filter(Boolean) : [];
  console.log('      cột trong file:', tieuDe.join(' · ').slice(0, 160));
  chot(tieuDe.includes('CHÊNH LỆCH') && tieuDe.includes('% BÁN') && tieuDe.includes('HKD'),
    'file có đủ cột, gồm cả cột "Chênh lệch" mới thêm');

  // Đếm PHẢI DỪNG ở dòng trống đầu tiên: dưới bảng chính còn 2 khối báo cáo TID, quét hết sheet là
  // đếm lẫn (276 thay vì 179) rồi báo đỏ oan.
  // [B255 22/11 — Admin Demo "excell phải đồng nhất"] THỨ TỰ CỘT TRÊN MÀN = THỨ TỰ CỘT TRONG FILE.
  // Không chỉ "có đủ cột": đổi chỗ cột mà quên sửa file là người đọc dò ngang sai hàng.
  const cotMan = await p.evaluate(() => {
    const tb = document.querySelector('table');
    return [...tb.querySelectorAll('thead th')].map((x) => (x.textContent || '').trim())
      .filter((x) => x !== ''); // bỏ ô tích chọn (không có chữ)
  });
  const cotFile = ws.getRow(hTieuDe).values.map(hoa).filter((x) => x !== '' && x != null);
  console.log('      cột trên màn:', cotMan.join(' · ').slice(0, 200));
  console.log('      cột trong file:', cotFile.join(' · ').slice(0, 200));
  const khopThuTu = JSON.stringify(cotMan.map(hoa)) === JSON.stringify(cotFile);
  if (!khopThuTu) {
    const n = Math.max(cotMan.length, cotFile.length);
    for (let i = 0; i < n; i++) {
      if (hoa(cotMan[i]) !== cotFile[i]) { console.log('      LỆCH ở cột thứ ' + (i + 1) + ': màn="' + (cotMan[i] ?? '—') + '" vs file="' + (cotFile[i] ?? '—') + '"'); break; }
    }
  }
  chot(khopThuTu, 'THỨ TỰ CỘT trong file KHỚP TỪNG CỘT với bảng trên màn (' + cotMan.length + ' cột)');
  // [B266 25/11 — Admin Demo đảo cột] Cặp phí CÀI MÁY (% CM · Sau phí CM) đứng NGAY SAU "Trước phí".
  const iTruoc = cotFile.indexOf('TRƯỚC PHÍ');
  chot(iTruoc >= 0 && cotFile[iTruoc + 1] === '% CM' && cotFile[iTruoc + 2] === 'SAU PHÍ CM',
    '"% CM" và "Sau phí CM" đứng NGAY SAU "Trước phí" (cả màn lẫn file)');

  // [B245 22/11] DỪNG luôn ở hàng "TỔNG n dòng" — hàng tổng mới thêm cũng có đủ ô nên nếu không loại
  // trừ sẽ bị đếm thành 1 bill (đo thật: 180 vs 179 ⇒ cổng đỏ oan).
  let soDong = 0;
  for (let r = hTieuDe + 1; r <= ws.rowCount; r++) {
    const v = ws.getRow(r).values.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (v.length < 5) break;
    if (/^TỔNG\s+\d+\s+dòng$/.test(String(ws.getRow(r).getCell(1).value ?? '').trim())) break;
    soDong++;
  }
  console.log('      số dòng trong file =', soDong, '· trên màn =', tren.soDong);
  chot(soDong === tren.soDong, 'số dòng trong file KHỚP số bill trên màn (' + soDong + ' vs ' + tren.soDong + ')');

  // `row.values` của exceljs là mảng 1-based có ô rỗng ⇒ KHÔNG được `.filter()` rồi lấy theo chỉ số:
  // lọc xong thứ tự lệch, lấy nhầm ô bên cạnh (đã cắn: lấy ra 1.1 của cột % CM thay vì 117.166.000).
  const vals = ws.getRow(hTieuDe).values;
  const cot = vals.findIndex((v) => hoa(v) === 'TRƯỚC PHÍ');
  const oTien = ws.getRow(hTieuDe + 1).getCell(cot).value;
  const soMan = Number(String(tren.truocPhiDong1).replace(/[^0-9]/g, ''));
  console.log('      "Trước phí" dòng đầu: file =', oTien, '· màn =', soMan);
  chot(Number(oTien) === soMan,
    'ĐỐI CHỨNG số tiền: ô "Trước phí" dòng đầu trong file KHỚP số trên màn (chống xuất cột rỗng/0 câm)');

  // ── [B228] KHỐI BÁO CÁO TID DƯỚI CÙNG mỗi sheet ──
  const chuSheet = [];
  for (let r = 1; r <= ws.rowCount; r++) chuSheet.push(ws.getRow(r).values.map(hoa).join(' '));
  const ca = chuSheet.findIndex((x) => x.includes('TỔNG DOANH SỐ TỪNG TID THEO CA'));
  const ngayK = chuSheet.findIndex((x) => x.includes('TỔNG DOANH SỐ TỪNG TID THEO NGÀY'));
  console.log('      khối "theo CA" ở dòng', ca + 1, '· khối "theo NGÀY" ở dòng', ngayK + 1, '· hết bảng chính dòng', 3 + tren.soDong);
  chot(ca > 3 + tren.soDong + 1 && ngayK > ca,
    'mỗi sheet CÓ 2 khối báo cáo TID xếp DƯỚI CÙNG bảng chính (theo ca rồi theo ngày)');
  // [B244 22/11] Đọc khối theo TÊN CỘT chứ không theo "ô cuối hàng": khối nay có thêm cột
  // "Sau phí mua NĐT" ở cuối ⇒ cách đọc cũ (lấy ô cuối) sẽ cộng nhầm sang cột khác.
  // Khối ghi vào các ô GỘP nên hàng trả về ô trống xen kẽ — lọc bỏ rỗng để lấy đúng thứ tự cột.
  // `chuSheet` đếm từ 0 còn `getRow` đếm từ 1 ⇒ dòng tiêu đề khối = chỉ số + 1,
  // dòng TÊN CỘT = +2, dữ liệu từ +3. (Lần chạy đầu lệch đúng 1 dòng nên đọc ra toàn tên khối.)
  const docKhoi = (iTieuDe) => {
    const cot = ws.getRow(iTieuDe + 2).values.map(hoa).filter((x) => x !== '' && x != null);
    const hang = [];
    for (let r = iTieuDe + 3; r <= ws.rowCount; r++) {
      const v = ws.getRow(r).values.filter((x) => x !== null && x !== undefined && String(x).trim() !== '');
      if (!v.length) break;
      hang.push(v);
    }
    return { cot, hang };
  };
  // [B248 22/11] Khối nay CÓ hàng TỔNG ở đáy ⇒ phải loại nó ra khi cộng, nếu không tổng bị NHÂN ĐÔI
  // (cổng đỏ oan đúng kiểu này lúc 18h). Chuẩn hoá Unicode trước khi so chữ "TỔNG".
  const nfc = (x) => String(x ?? '').normalize('NFC').trim();
  const boHangTong = (k) => ({ ...k, hang: k.hang.filter((v) => !nfc(v[0]).startsWith(nfc('TỔNG'))) });
  const kCa = boHangTong(docKhoi(ca));
  const kNgay = boHangTong(docKhoi(ngayK));
  const lai = chuSheet.findIndex((x) => x.includes('LÃI NHÀ ĐẦU TƯ'));
  const kLai = lai > 0 ? boHangTong(docKhoi(lai)) : { cot: [], hang: [] };
  console.log('      cột khối theo CA:', kCa.cot.join(' · '));
  console.log('      cột khối Lãi NĐT:', kLai.cot.join(' · '));
  chot(kCa.cot.includes('SAU PHÍ MUA NĐT') && kNgay.cot.includes('SAU PHÍ MUA NĐT'),
    'khối TID theo CA và theo NGÀY đều CÓ cột "Sau phí mua NĐT"');
  chot(kLai.cot.includes('% MUA NĐT') && kLai.cot.includes('SAU PHÍ MUA NĐT'),
    'khối Lãi NĐT CÓ cả "% Mua NĐT" lẫn "Sau phí mua NĐT"');
  chot(kCa.cot.includes('SAU PHÍ BÁN') && kNgay.cot.includes('SAU PHÍ BÁN'),
    'khối TID vẫn giữ "Sau phí bán" để đọc được mạch tiền');

  // Đối chứng SỐ: tổng doanh số trong khối "theo ngày" phải bằng tổng cột Trước phí của bảng chính.
  const cotTruoc = vals.findIndex((v) => hoa(v) === 'TRƯỚC PHÍ');
  let tongChinh = 0;
  for (let r = hTieuDe + 1; r <= hTieuDe + tren.soDong; r++) tongChinh += Number(ws.getRow(r).getCell(cotTruoc).value) || 0;
  const iDs = kNgay.cot.indexOf('DOANH SỐ TRƯỚC PHÍ');
  const tongKhoi = kNgay.hang.reduce((t, v) => t + (Number(v[iDs]) || 0), 0);
  console.log('      tổng bảng chính =', tongChinh.toLocaleString('vi'), '· tổng khối theo ngày =', tongKhoi.toLocaleString('vi'));
  chot(tongChinh > 0 && tongKhoi === tongChinh,
    'ĐỐI CHỨNG TIỀN: tổng khối "theo ngày" KHỚP tổng cột Trước phí của bảng chính');

  // ĐỐI CHỨNG cột mới: tổng "Sau phí mua NĐT" của khối = tổng cột "Sau mua NĐT" bảng chính.
  // Ô của bill CHƯA KHAI phí mua NĐT là CHỮ ("— n bill chưa khai") nên Number() ra NaN → bỏ qua,
  // đúng ý: không cộng 0 giả cho bill chưa khai (R198 cấm nuốt im).
  const cotSauNdt = vals.findIndex((v) => hoa(v) === 'SAU MUA NĐT');
  let chinhSauNdt = 0;
  for (let r = hTieuDe + 1; r <= hTieuDe + tren.soDong; r++) chinhSauNdt += Number(ws.getRow(r).getCell(cotSauNdt).value) || 0;
  const iSau = kNgay.cot.indexOf('SAU PHÍ MUA NĐT');
  const khoiSauNdt = kNgay.hang.reduce((t, v) => t + (Number(v[iSau]) || 0), 0);
  console.log('      sau mua NĐT: bảng chính =', chinhSauNdt.toLocaleString('vi'), '· khối theo ngày =', khoiSauNdt.toLocaleString('vi'));
  chot(khoiSauNdt === chinhSauNdt && chinhSauNdt > 0 && chinhSauNdt < tongChinh,
    'ĐỐI CHỨNG TIỀN: "Sau phí mua NĐT" trong khối KHỚP cột "Sau mua NĐT" bảng chính ('
      + khoiSauNdt.toLocaleString('vi') + ') và nhỏ hơn doanh số trước phí (số THẬT, không rỗng)');

  // ── [B231 22/11 — Admin Demo "mỗi NĐT 1 file"] TÁCH THÀNH NHIỀU FILE + ẨN 2 cột ──
  await p.locator('[data-nut="excel"]').first().click();
  await p.waitForTimeout(800);
  // Bấm vào CẢ HÀNG như người dùng (ô tích thật được ẩn, dấu tích vẽ bằng SVG theo brand) rồi KHẲNG ĐỊNH
  // nó đã bật — bấm mà không kiểm là có ngày bấm trượt vẫn báo xanh.
  for (const nut of ['ex-an-daily', 'ex-an-nguoinhap', 'ex-an-muadt', 'ex-tach-sheet']) {
    const o = p.locator('[data-nut="' + nut + '"]');
    if (!(await o.locator('input').isChecked())) await o.click();
    await p.waitForTimeout(250);
  }
  const batHet = (await p.locator('[data-nut="ex-an-daily"] input').isChecked())
    && (await p.locator('[data-nut="ex-an-nguoinhap"] input').isChecked())
    && (await p.locator('[data-nut="ex-tach-sheet"] input').isChecked());
  chot(batHet, 'bấm vào hàng thì ô tích BẬT thật (không phải chỉ đổi màu)');
  // Bản web tải LẦN LƯỢT nhiều file → phải hứng NHIỀU sự kiện tải, không chỉ một.
  const dsTai = [];
  p.on('download', (d) => dsTai.push(d));
  await p.locator('[data-nut="ex-xuat"]').first().click();
  for (let i = 0; i < 40 && dsTai.length === 0; i++) await p.waitForTimeout(500);
  await p.waitForTimeout(4000); // chờ các file sau (web-shim giãn 400ms/file)
  const soNdt = new Set((await p.evaluate(() => {
    const tb = document.querySelector('table');
    const th = [...tb.querySelectorAll('thead th')].map((x) => (x.textContent || '').trim());
    const i = th.indexOf('NĐT');
    return [...tb.querySelectorAll('tbody tr')]
      .filter((r) => r.querySelectorAll('td').length === th.length)
      .map((r) => (r.querySelectorAll('td')[i].textContent || '').trim());
  })).map((x) => x || 'Chưa gán NĐT')).size;
  console.log('      số FILE tải về =', dsTai.length, '· số NĐT trên màn =', soNdt,
    '· tên file:', dsTai.map((d) => d.suggestedFilename()).join(' · ').slice(0, 140));
  chot(dsTai.length === soNdt && soNdt > 0,
    'tách đúng MỖI NĐT MỘT FILE (' + dsTai.length + ' file vs ' + soNdt + ' NĐT)');
  chot(dsTai.every((d) => /\.xlsx$/i.test(d.suggestedFilename()))
    && new Set(dsTai.map((d) => d.suggestedFilename())).size === dsTai.length,
    'mỗi file là .xlsx và tên file KHÔNG trùng nhau');

  if (dsTai.length) {
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.readFile(await dsTai[0].path());
    const ws2 = wb2.worksheets[0];
    let hd = 0;
    for (let r = 1; r <= Math.min(12, ws2.rowCount); r++) {
      const v = ws2.getRow(r).values.map(hoa);
      if (v.includes('TID')) { hd = r; break; }
    }
    const cot2 = ws2.getRow(hd).values.map(hoa).filter(Boolean);
    console.log('      cột khi ẩn 2 thông tin:', cot2.join(' · ').slice(0, 150));
    chot(!cot2.includes('ĐẠI LÝ') && !cot2.includes('NGƯỜI NHẬP') && cot2.includes('TID'),
      'tích ẩn thì file KHÔNG còn cột "Đại lý" và "Người nhập" (bỏ hẳn cột, không để trống)');
    // [B239 22/11 — Admin Demo "cho ẩn luôn % mua khi tích xuất file"] GIÁ VỐN không được lọt ra ngoài.
    chot(!cot2.includes('% MUA') && cot2.includes('% MUA NĐT') && cot2.includes('SAU MUA NĐT'),
      'tích ẩn % mua đối tác thì file KHÔNG còn "% Mua", nhưng VẪN giữ "% Mua NĐT" + "Sau mua NĐT"');
    // [B244] Ô tích CHỈ giấu phần ĐỐI TÁC — khối Lãi NĐT phải mất cột "SigMa đối tác" mà vẫn đủ
    // mạch NĐT. Trước đây khối này không theo ô tích ⇒ giá vốn đối tác vẫn lọt ra ngoài qua khối phụ.
    const chuF0 = [];
    for (let r = 1; r <= ws2.rowCount; r++) chuF0.push(ws2.getRow(r).values.map(hoa).join(' '));
    const iLai = chuF0.findIndex((x) => x.includes('LÃI NHÀ ĐẦU TƯ'));
    const cotLai = iLai > 0 ? ws2.getRow(iLai + 2).values.map(hoa).filter((x) => x !== '' && x != null) : [];
    console.log('      cột khối Lãi NĐT khi ẩn ĐT:', cotLai.join(' · '));
    chot(iLai > 0 && !cotLai.includes('SIGMA ĐỐI TÁC')
      && cotLai.includes('% MUA NĐT') && cotLai.includes('SAU PHÍ MUA NĐT'),
      'khi ẩn % mua ĐT: khối Lãi NĐT bỏ cột "SigMa đối tác" nhưng GIỮ đủ cột NĐT');
    const chuF = [];
    for (let r = 1; r <= ws2.rowCount; r++) chuF.push(ws2.getRow(r).values.map(hoa).join(' '));
    chot(chuF.some((x) => x.includes('TỔNG DOANH SỐ TỪNG TID THEO CA'))
      && chuF.some((x) => x.includes('TỔNG DOANH SỐ TỪNG TID THEO NGÀY')),
      'file tách riêng VẪN có đủ 2 khối báo cáo TID dưới cùng');
  }
} catch (e) {
  console.log('  ĐỎ  không chạy được phép kiểm: ' + e.message);
  so++; loi.push('không chạy được phép kiểm: ' + e.message);
} finally {
  await b?.close().catch(() => {});
  // TRẢ phí mua NĐT về đúng như trước khi kiểm — bỏ bước này là bài kiểm sau đọc phải dữ liệu bẩn
  // (đã cắn 21/11: cổng bị tôi giết giữa chừng để lại 101 khách tạm, lượt sau đỏ oan).
  if (chupPhi) {
    for (const x of chupPhi) await db.query('UPDATE tid_sell_fees SET phi_mua_ndt=$2 WHERE id=$1', [x.id, x.phi_mua_ndt]);
    const con = Number((await db.query('SELECT count(*)::int n FROM tid_sell_fees WHERE phi_mua_ndt = 1200')).rows[0].n)
      - chupPhi.filter((x) => Number(x.phi_mua_ndt) === 1200).length;
    console.log('      đã trả lại phí mua NĐT' + (con ? ' — CÒN SÓT ' + con + ' dòng!' : ' (sạch)'));
    if (con) { loi.push('không trả lại được dữ liệu bồi: còn ' + con + ' dòng'); so++; }
  }
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  await db.end();
}

console.log('\n[xuat-excel] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[xuat-excel] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[xuat-excel] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
