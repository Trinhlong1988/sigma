// B247 — [Admin Demo 22/11 "thêm tích chọn nđt để xuất file, lúc xuất file làm bảng rõ ràng các phần
// tích chọn theo brand"] HỘP XUẤT EXCEL CÓ BẢNG TÍCH CHỌN NHÀ ĐẦU TƯ.
//
// Cổng bấm thật rồi mở file ra đối chiếu:
//   (1) hộp xuất có 2 KHỐI tiêu đề brand (KIỂU XUẤT · NHÀ ĐẦU TƯ ĐƯA VÀO FILE);
//   (2) khối NĐT liệt kê ĐÚNG các NĐT đang có trong bảng, kèm số bill khớp đếm tay;
//   (3) chưa tích gì = XUẤT HẾT (không bắt tích mới cho xuất);
//   (4) tích 1 NĐT → file CHỈ chứa bill của NĐT đó, số dòng khớp;
//   (5) "Bỏ chọn (xuất hết)" trả về đủ bill.
// Kèm CHỤP ẢNH hộp chọn để người duyệt nhìn bằng mắt (R200) — không chỉ tin số.
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
const THU_MUC_ANH = process.env.THU_MUC_ANH || resolve(import.meta.dirname, '../../../_anh-kiem');
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[tich-ndt] DUNG: chi chay tren DB THU, dang tro "' + DB_TEN + '".');
  process.exit(3);
}
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const hoa = (x) => String(x ?? '').trim().toUpperCase();
const CAN = 6;

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN = 'kiem-b247';
let b = null;
try {
  const ngay = (await db.query(
    "SELECT to_char(COALESCE(bill_txn_date, created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') d, count(*)::int n"
    + " FROM los WHERE status <> 'CANCELLED' GROUP BY 1 ORDER BY n DESC LIMIT 1")).rows[0];
  if (!ngay) throw new Error('DB thu khong co bill nao');
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

  // Đếm tay trên màn: mỗi NĐT bao nhiêu bill (bill chưa gán gom vào "Chưa gán NĐT").
  const man = await p.evaluate(() => {
    const tb = document.querySelector('table');
    const th = [...tb.querySelectorAll('thead th')].map((x) => (x.textContent || '').trim());
    const i = th.indexOf('NĐT');
    const dem = {};
    let tong = 0;
    for (const r of [...tb.querySelectorAll('tbody tr')].filter((x) => x.querySelectorAll('td').length === th.length)) {
      const v = (r.querySelectorAll('td')[i].textContent || '').trim() || 'Chưa gán NĐT';
      dem[v] = (dem[v] ?? 0) + 1;
      tong++;
    }
    return { dem, tong };
  });
  console.log('      trên màn:', man.tong, 'bill ·', JSON.stringify(man.dem));

  await p.locator('[data-nut="excel"]').first().click();
  await p.waitForTimeout(900);
  const tieuDeKhoi = await p.evaluate(() =>
    [...document.querySelectorAll('div')].map((x) => (x.textContent || '').trim())
      .filter((x) => x.length < 60 && /KIỂU XUẤT|NHÀ ĐẦU TƯ ĐƯA VÀO FILE/.test(x)).length);
  chot(tieuDeKhoi >= 2, 'hộp xuất có ĐỦ 2 khối tiêu đề brand (KIỂU XUẤT · NHÀ ĐẦU TƯ ĐƯA VÀO FILE)');

  const dong = await p.evaluate(() => [...document.querySelectorAll('[data-nut="ex-ndt"]')]
    .map((x) => ({ ten: x.getAttribute('data-ndt'), chu: (x.textContent || '').trim() })));
  console.log('      khối NĐT trong hộp:', dong.map((x) => x.chu).join(' | ').slice(0, 160));
  const tenMan = Object.keys(man.dem).sort();
  const tenHop = dong.map((x) => x.ten).sort();
  chot(JSON.stringify(tenMan) === JSON.stringify(tenHop),
    'khối NĐT liệt kê ĐÚNG các NĐT đang có (' + tenHop.join(', ') + ')');
  // Chữ trong dòng dính liền ("NĐT 2137 bill") nên KHÔNG dùng \b — giữa chữ cái và chữ số không có
  // ranh giới từ, phép kiểm sẽ đỏ oan. Bắt theo "ký tự không-phải-số đứng trước" mới đúng.
  const soSai = dong.filter((x) => !new RegExp('(^|[^0-9])' + man.dem[x.ten] + ' bill').test(x.chu));
  chot(soSai.length === 0, 'mỗi dòng ghi ĐÚNG số bill của NĐT đó'
    + (soSai.length ? ' — lệch: ' + soSai.map((x) => x.ten).join(', ') : ''));

  // Ảnh để nhìn bằng mắt (R200) — không thay cho số, nhưng số không thay được mắt.
  await p.screenshot({ path: resolve(THU_MUC_ANH, 'b247-hop-chon-ndt.png'), fullPage: false });
  console.log('      ảnh hộp chọn: _anh-kiem/b247-hop-chon-ndt.png');

  // (3) CHƯA tích gì → xuất HẾT
  const docDong = async (tai) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(await tai.path());
    const ws = wb.worksheets[0];
    let h = 0;
    for (let r = 1; r <= Math.min(12, ws.rowCount); r++) if (ws.getRow(r).values.map(hoa).includes('TID')) { h = r; break; }
    const ci = ws.getRow(h).values.map(hoa).indexOf('NĐT');
    const ten = new Set();
    let n = 0;
    for (let r = h + 1; r <= ws.rowCount; r++) {
      const v = ws.getRow(r).getCell(1).value;
      if (v == null || String(v).startsWith('TỔNG')) break;
      n++;
      if (ci > 0) ten.add(String(ws.getRow(r).getCell(ci).value ?? '').trim() || 'Chưa gán NĐT');
    }
    return { n, ten: [...ten] };
  };
  const [taiHet] = await Promise.all([
    p.waitForEvent('download', { timeout: 60000 }),
    p.locator('[data-nut="ex-xuat"]').first().click()
  ]);
  const het = await docDong(taiHet);
  console.log('      chưa tích gì → file có', het.n, 'dòng');
  chot(het.n === man.tong, 'chưa tích NĐT nào = xuất HẾT (' + het.n + '/' + man.tong + ' bill)');

  // (4) tích 1 NĐT → chỉ bill của NĐT đó
  const chon = tenMan[0];
  await p.locator('[data-nut="excel"]').first().click();
  await p.waitForTimeout(900);
  await p.locator('[data-nut="ex-ndt"][data-ndt="' + chon + '"]').click();
  await p.waitForTimeout(500);
  const [taiMot] = await Promise.all([
    p.waitForEvent('download', { timeout: 60000 }),
    p.locator('[data-nut="ex-xuat"]').first().click()
  ]);
  const mot = await docDong(taiMot);
  console.log('      tích "' + chon + '" → file có', mot.n, 'dòng · NĐT trong file:', mot.ten.join(', '));
  chot(mot.n === man.dem[chon] && mot.ten.length === 1 && mot.ten[0] === chon,
    'tích 1 NĐT thì file CHỈ có bill của NĐT đó (' + mot.n + '/' + man.dem[chon] + ')');

  // (5) Bỏ chọn → xuất hết trở lại
  await p.locator('[data-nut="excel"]').first().click();
  await p.waitForTimeout(900);
  await p.locator('[data-nut="ex-ndt-bochon"]').click();
  await p.waitForTimeout(400);
  const [taiLai] = await Promise.all([
    p.waitForEvent('download', { timeout: 60000 }),
    p.locator('[data-nut="ex-xuat"]').first().click()
  ]);
  const lai = await docDong(taiLai);
  console.log('      sau "Bỏ chọn (xuất hết)" → file có', lai.n, 'dòng');
  chot(lai.n === man.tong, '"Bỏ chọn (xuất hết)" trả về đủ bill (' + lai.n + '/' + man.tong + ')');
} catch (e) {
  console.log('  ĐỎ  không chạy được phép kiểm: ' + e.message);
  so++; loi.push('không chạy được phép kiểm: ' + e.message);
} finally {
  await b?.close().catch(() => {});
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  await db.end();
}
console.log('\n[tich-ndt] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[tich-ndt] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[tich-ndt] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
