// B245 — [Admin Demo 22/11 "tất cả cột tiền trên danh sách bill và excel phải có tổng dưới đáy,
// bảng thiếu tổng sau phí cm"] MỌI CỘT TIỀN PHẢI CÓ TỔNG, TRÊN MÀN LẪN TRONG FILE.
//
// Cổng bấm thật trên bản web đang chạy rồi mở file xuất ra bằng thư viện Excel thật:
//   (1) hàng TỔNG trên màn có ô ở ĐÚNG CỘT của từng cột tiền — thiếu 1 ô là cả hàng lệch cột,
//       số rơi sang cột khác mà mắt vẫn thấy "có số";
//   (2) số ở hàng TỔNG = cộng tay các dòng ĐANG HIỆN;
//   (3) file Excel có hàng TỔNG dưới bảng chính, khớp số trên màn, có dấu ngăn nghìn.
// Đếm phép kiểm ĐỘNG theo số cột tiền — cấm hard-code (R198).
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const WEB = process.env.WEB_THU || 'http://127.0.0.1:57915';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[tong-tien] DUNG: chi chay tren DB THU, dang tro "' + DB_TEN + '".');
  process.exit(3);
}
const COT_TIEN = ['Sau phí CM', 'Trước phí', 'Sau phí bán', 'Sau mua NĐT', 'Đã hoàn', 'Chênh lệch'];
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const hoa = (x) => String(x ?? '').trim().toUpperCase();
// "−12.813.070" / "+49.803.538" / "—" → số. Dấu trừ trên màn là U+2212, không phải '-'.
const doSo = (t) => {
  // [B277 24/11] ô tổng "Sau phí CM"/"Sau mua NĐT" nay có thể mang đuôi "*n" (n bill chưa khai —
  // hành vi MỚI, đúng yêu cầu "không cộng 0 câm"). Cắt đuôi * trước khi đọc số, kẻo đỏ oan.
  const s = String(t ?? '').replace(/\*\d+\s*$/, '').replace(/−/g, '-').replace(/[^0-9.,-]/g, '').replace(/\./g, '');
  if (!s || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN = 'kiem-b245';
let b = null;
let chupPhi = null;
try {
  const ngay = (await db.query(
    "SELECT to_char(COALESCE(bill_txn_date, created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') d, count(*)::int n"
    + " FROM los WHERE status <> 'CANCELLED' GROUP BY 1 ORDER BY n DESC LIMIT 1")).rows[0];
  if (!ngay) throw new Error('DB thu khong co bill nao');
  // Bồi phí mua NĐT để cột "Sau mua NĐT" có số thật (sổ thử chưa khai) — TRẢ LẠI ở finally.
  chupPhi = (await db.query('SELECT id, phi_mua_ndt FROM tid_sell_fees')).rows;
  await db.query('UPDATE tid_sell_fees SET phi_mua_ndt = 1200 WHERE deleted_at IS NULL AND phi_mua_ndt IS NULL');
  // Một TID có NHIỀU loại thẻ ⇒ khai lệch 1 loại để khối Lãi NĐT sinh ô "0,98 / 1,2" (chữ chứa số).
  // Phải chọn TID CÓ BILL NHIỀU LOẠI THẺ trong kỳ đang xem, nếu không ô đó không bao giờ xuất hiện
  // và phép kiểm "căn phải ô % nhiều mức" chạy trên 0 ô = xanh RỖNG (đã cắn 17h 22/11).
  const tidNhieuThe = (await db.query(
    `SELECT tx.tid_id, min(tx.card_type_id) AS ct
       FROM los l JOIN transactions tx ON tx.id = l.transaction_id
      WHERE l.status <> 'CANCELLED'
        AND to_char(COALESCE(l.bill_txn_date, l.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') = $1
      GROUP BY tx.tid_id
     HAVING count(DISTINCT tx.card_type_id) > 1
      ORDER BY count(*) DESC LIMIT 1`, [ngay.d])).rows[0];
  if (tidNhieuThe) {
    await db.query(
      'UPDATE tid_sell_fees SET phi_mua_ndt = 980 WHERE deleted_at IS NULL AND tid_id = $1 AND card_type_id = $2',
      [tidNhieuThe.tid_id, tidNhieuThe.ct]);
    console.log('      bồi % lệch cho TID', tidNhieuThe.tid_id, 'loại thẻ', tidNhieuThe.ct, '→ 0,98');
  }

  const tho = randomUUID();
  await db.query(
    'INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)'
    + " VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '10 minutes',now(),$2)",
    [createHash('sha256').update(tho).digest('hex'), NHAN]);
  b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1700, height: 950 }, acceptDownloads: true });
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
  await p.waitForTimeout(3000);

  // Đọc bảng: tên cột, các dòng, và hàng TỔNG ở tfoot — kèm VỊ TRÍ CỘT THẬT của từng ô tổng
  // (tfoot dùng colSpan nên phải cộng dồn colSpan mới ra cột thật, không đếm theo thứ tự ô).
  const man = await p.evaluate(() => {
    const tb = document.querySelector('table');
    const th = [...tb.querySelectorAll('thead th')].map((x) => (x.textContent || '').trim());
    const hang = [...tb.querySelectorAll('tbody tr')]
      .filter((r) => r.querySelectorAll('td').length === th.length)
      .map((r) => [...r.querySelectorAll('td')].map((c) => (c.textContent || '').trim()));
    const oTong = {};
    const ft = tb.querySelector('tfoot tr');
    let i = 0;
    for (const td of ft ? [...ft.querySelectorAll('td')] : []) {
      const n = Number(td.getAttribute('colspan') || 1);
      if (n === 1) oTong[i] = (td.textContent || '').trim();
      i += n;
    }
    return { th, hang, oTong, soO: ft ? ft.querySelectorAll('td').length : 0 };
  });
  console.log('      bang:', man.hang.length, 'dong ·', man.th.length, 'cot · hang TONG co', man.soO, 'o');
  if (!man.hang.length) throw new Error('bang khong co dong nao de cong');

  const viTri = COT_TIEN.map((ten) => ({ ten, i: man.th.indexOf(ten) }));
  const thieuCot = viTri.filter((x) => x.i < 0);
  chot(!thieuCot.length, 'bảng có đủ ' + COT_TIEN.length + ' cột tiền'
    + (thieuCot.length ? ' — THIẾU: ' + thieuCot.map((x) => x.ten).join(', ') : ''));

  const tongMan = {};
  for (const { ten, i } of viTri) {
    if (i < 0) { chot(false, 'cột "' + ten + '" không có trên bảng nên không kiểm được ô tổng'); continue; }
    const congTay = man.hang.reduce((t2, r) => t2 + (doSo(r[i]) ?? 0), 0);
    const oT = doSo(man.oTong[i]);
    tongMan[ten] = congTay;
    console.log('      ' + ten + ' · cong tay = ' + congTay.toLocaleString('vi')
      + ' · o TONG = ' + (man.oTong[i] === undefined ? '(KHONG CO O)' : man.oTong[i]));
    chot(oT !== null && oT === congTay,
      'cột "' + ten + '" CÓ ô tổng đúng cột và bằng tổng các dòng đang hiện ('
        + congTay.toLocaleString('vi') + ')');
  }

  // ── FILE EXCEL: hàng TỔNG dưới bảng chính ──
  await p.locator('[data-nut="excel"]').first().click();
  await p.waitForTimeout(900);
  const [tai] = await Promise.all([
    p.waitForEvent('download', { timeout: 60000 }),
    p.locator('[data-nut="ex-xuat"]').first().click()
  ]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(await tai.path());
  const ws = wb.worksheets[0];
  let hTieuDe = 0;
  for (let r = 1; r <= Math.min(12, ws.rowCount); r++) {
    if (ws.getRow(r).values.map(hoa).includes('TID')) { hTieuDe = r; break; }
  }
  const cotF = ws.getRow(hTieuDe).values.map(hoa);
  const dongTong = hTieuDe + man.hang.length + 1;
  const nhan = String(ws.getRow(dongTong).getCell(1).value ?? '');
  console.log('      dong TONG trong file = dong', dongTong, '· nhan o A =', JSON.stringify(nhan));
  chot(/^TỔNG\s+\d+\s+dòng$/.test(nhan.trim()),
    'file Excel CÓ hàng TỔNG ngay dưới bảng chính (nhãn "' + nhan.trim() + '")');
  for (const { ten } of viTri) {
    const ci = cotF.indexOf(hoa(ten));
    const o = ci > 0 ? ws.getRow(dongTong).getCell(ci) : null;
    const v = o ? o.value : null;
    const fmt = o ? o.numFmt : null;
    console.log('      file · ' + ten + ' = ' + (typeof v === 'number' ? v.toLocaleString('vi') : JSON.stringify(v)) + ' · dinh dang ' + fmt);
    chot(typeof v === 'number' && v === tongMan[ten] && fmt === '#,##0',
      'file: tổng cột "' + ten + '" KHỚP số trên màn (' + (tongMan[ten] ?? 0).toLocaleString('vi') + ') và có dấu ngăn nghìn');
  }
  // Hàng TỔNG không được dính liền khối báo cáo bên dưới.
  const sauTong = ws.getRow(dongTong + 1).values.map(hoa).join('').trim();
  chot(sauTong === '', 'dưới hàng TỔNG còn 1 dòng trắng ngăn với khối báo cáo');

  // ── [B248 22/11 — Admin Demo "thiếu hàng tổng dưới đáy blog này" + "tổng đấy cho in đậm với brand
  //    alpha" + "0,98 / 1,26 căn phải"] MỌI KHỐI BÁO CÁO cũng phải có hàng TỔNG, in đậm nền brand,
  //    và ô % dạng chữ ("1,22 / 1,35") vẫn căn phải. ──
  const chuSheet = [];
  for (let r = 1; r <= ws.rowCount; r++) chuSheet.push(ws.getRow(r).values.map(hoa).join(' '));
  const moKhoi = [
    ['TỔNG DOANH SỐ TỪNG TID THEO CA', 'theo CA'],
    ['LÃI NHÀ ĐẦU TƯ', 'Lãi NĐT'],
    ['TỔNG DOANH SỐ TỪNG TID THEO NGÀY', 'theo NGÀY']
  ];
  for (const [dauHieu, ten] of moKhoi) {
    const i = chuSheet.findIndex((x) => x.includes(dauHieu));
    if (i < 0) { chot(false, 'khối "' + ten + '" KHÔNG có trong file'); continue; }
    // Khối ghi vào Ô GỘP ⇒ mỗi cột chỉ có giá trị ở ô ĐẦU nhóm. Lấy ĐÚNG các cột đó từ hàng tên cột
    // rồi đọc dữ liệu theo CHÍNH các cột ấy. (Lọc bỏ ô rỗng như trước là sai: hàng TỔNG có ô trống ở
    // giữa nên mảng bị dồn trái ⇒ so nhầm cột, đọc "doanh số" ra số của cột bên cạnh.)
    const hdr = ws.getRow(i + 2);
    const cols = [];
    for (let c = 1; c <= ws.columnCount; c++) if (String(hdr.getCell(c).value ?? '').trim() !== '') cols.push(c);
    const cot = cols.map((c) => hoa(hdr.getCell(c).value));
    const hang = [];
    for (let r = i + 3; r <= ws.rowCount; r++) {
      const v = cols.map((c) => ws.getRow(r).getCell(c).value);
      if (v.every((x) => x === null || x === undefined || String(x).trim() === '')) break;
      hang.push({ r, v });
    }
    const cuoi = hang[hang.length - 1];
    // So chữ Việt phải CHUẨN HOÁ Unicode cả hai phía ("Ổ" có thể là 1 ký tự dựng sẵn hoặc O + dấu
    // tổ hợp) — so thẳng là trượt mà nhìn hai chuỗi y hệt. Đã cắn đúng bẫy này lúc 17h 22/11.
    const nfc = (x) => String(x ?? '').normalize('NFC').trim();
    const laTong = nfc(cuoi?.v[0]).startsWith(nfc('TỔNG'));
    // Ô đầu hàng TỔNG nằm trong vùng GỘP — đọc ô A của hàng đó mới ra giá trị thật.
    const oDau = cuoi ? ws.getRow(cuoi.r).getCell(1) : null;
    const dam = oDau?.font?.bold === true;
    const nen = String(oDau?.fill?.fgColor?.argb ?? '');
    console.log('      khối ' + ten + ': ' + hang.length + ' hàng · hàng cuối = '
      + JSON.stringify(String(cuoi?.v[0] ?? '')).slice(0, 40) + ' · đậm=' + dam + ' · nền=' + nen);
    chot(laTong && dam && /^FF(EAF4FB|D2E7F7)$/.test(nen),
      'khối "' + ten + '" CÓ hàng TỔNG ở đáy, IN ĐẬM + nền brand');
    // Số trong hàng TỔNG = cộng các hàng phía trên của CHÍNH khối đó.
    // Tìm cột doanh số theo TIỀN TỐ (có khối ghi "DOANH SỐ TRƯỚC PHÍ", khối khác ghi "DOANH SỐ").
    const iTien = cot.findIndex((x) => String(x).startsWith('DOANH S'));
    if (laTong && iTien >= 0) {
      const cong = hang.slice(0, -1).reduce((t2, h) => t2 + (Number(h.v[iTien]) || 0), 0);
      const oTong2 = Number(cuoi.v[iTien]) || 0;
      console.log('      khối ' + ten + ': cộng các hàng = ' + cong.toLocaleString('vi')
        + ' · hàng TỔNG = ' + oTong2.toLocaleString('vi'));
      chot(cong > 0 && cong === oTong2,
        'khối "' + ten + '" hàng TỔNG cộng ĐÚNG doanh số các dòng (' + oTong2.toLocaleString('vi') + ')');
    } else {
      chot(false, 'khối "' + ten + '" không đọc được cột doanh số để đối chứng hàng TỔNG');
    }
  }
  // Ô % dạng chữ (nhiều mức "1,22 / 1,35") phải CĂN PHẢI.
  const iLai2 = chuSheet.findIndex((x) => x.includes('LÃI NHÀ ĐẦU TƯ'));
  const cotLai2 = iLai2 >= 0 ? ws.getRow(iLai2 + 2).values.map(hoa) : [];
  const ciPct = cotLai2.indexOf('% MUA NĐT');
  let lech = 0, soChu = 0;
  if (ciPct > 0) {
    for (let r = iLai2 + 3; r <= ws.rowCount; r++) {
      const o = ws.getRow(r).getCell(ciPct);
      if (o.value == null || String(o.value).trim() === '') break;
      if (typeof o.value === 'string' && /^[0-9][0-9.,\s/]*$/.test(o.value.trim())) {
        soChu++;
        if (o.alignment?.horizontal !== 'right') lech++;
      }
    }
  }
  console.log('      ô "% Mua NĐT" dạng chữ (nhiều mức): ' + soChu + ' ô · căn sai ' + lech);
  chot(lech === 0, 'ô % nhiều mức ("1,22 / 1,35") CĂN PHẢI như ô số (' + soChu + ' ô)');
} catch (e) {
  console.log('  ĐỎ  không chạy được phép kiểm: ' + e.message);
  so++; loi.push('không chạy được phép kiểm: ' + e.message);
} finally {
  await b?.close().catch(() => {});
  if (chupPhi) for (const x of chupPhi) await db.query('UPDATE tid_sell_fees SET phi_mua_ndt=$2 WHERE id=$1', [x.id, x.phi_mua_ndt]);
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  await db.end();
}
// ĐẾM ĐỘNG: 1 (đủ cột) + 1 ô tổng/cột tiền + 1 (có hàng tổng) + 1 số/cột tiền + 1 (dòng trắng)
// + 3 khối báo cáo × 2 phép (có hàng TỔNG in đậm · cộng đúng) + 1 (căn phải ô % nhiều mức).
const CAN = 3 + COT_TIEN.length * 2 + 3 * 2 + 1;
console.log('\n[tong-tien] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[tong-tien] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[tong-tien] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
