// B225 — [Admin Demo 21/11] BẢNG DANH SÁCH BILL: cột Chênh lệch + 3 cột % chỉ để số.
//
// Ca thật khiến cổng này ra đời: sau khi B224 đổi % bán sang lấy ảnh chụp tỷ lệ, công thức cộng SỐ THỰC
// (0,225 + 1,155) ra 1,3800000000000001 ⇒ ô "% Bán" TRÀN ĐÈ sang cột bên. Số đo cột vẫn "đúng 23 cột,
// đúng bề ngang" — CHỈ NHÌN ẢNH MỚI THẤY. Nên cổng này đo CHIỀU DÀI CHỮ trong ô, không chỉ đếm cột.
//
// Khoá 7 điều:
//   (1) kỳ xem phải CÓ bill (bảng rỗng thì mọi phép đo vô nghĩa mà vẫn "xanh" — bài học 20/11);
//   (2) số ô tiêu đề = số ô dữ liệu (thêm cột mà quên một chỗ là lệch cả bảng — đã cắn ở B211);
//   (3) có cột "Chênh lệch" đứng NGAY SAU "Đã hoàn";
//   (4) trị số cột đó = đã hoàn − sau phí bán, ĐỌC TỪ CHÍNH 3 ô trên cùng một dòng;
//   (5) ba cột % CM · % Bán · % Mua KHÔNG còn dấu "%";
//   (6) KHÔNG ô % nào dài quá 6 ký tự (chống số thực tràn kiểu 1,3800000000000001);
//   (7) ĐỐI CHỨNG đo bề ngang: chữ trong ô % không rộng hơn chính ô đó (không đè cột bên).
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const WEB = process.env.WEB_THU || 'http://127.0.0.1:57915';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[bang-cot] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 7;
/** "−115.724.858" → -115724858 · "—" → 0. Dấu trừ trên màn là U+2212, không phải dấu trừ ASCII. */
const soVN = (t) => {
  const s = String(t ?? '').trim();
  if (!s || s === '—') return 0;
  const am = s.startsWith('−') || s.startsWith('-');
  const n = Number(s.replace(/[^0-9]/g, '') || '0');
  return am ? -n : n;
};

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN = 'kiem-b225';
let b = null;
try {
  const ngay = (await db.query(
    `SELECT to_char(COALESCE(bill_txn_date, created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') d, count(*)::int n
       FROM los WHERE status <> 'CANCELLED' GROUP BY 1 ORDER BY n DESC LIMIT 1`)).rows[0];
  chot(!!ngay && ngay.n > 0, 'chọn được kỳ xem CÓ bill để đo (' + (ngay?.d ?? '-') + ' · ' + (ngay?.n ?? 0) + ' bill)');
  if (!ngay) throw new Error('DB thử không có bill nào');

  const tho = randomUUID();
  await db.query(
    `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
     VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '10 minutes',now(),$2)`,
    [createHash('sha256').update(tho).digest('hex'), NHAN]
  );
  b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1600, height: 900 } });
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

  const d = await p.evaluate(() => {
    const tb = document.querySelector('table');
    if (!tb) return { loi: 'không thấy bảng' };
    const th = [...tb.querySelectorAll('thead th')].map((x) => (x.textContent || '').trim());
    const hang = [...tb.querySelectorAll('tbody tr')].filter((r) => r.querySelectorAll('td').length === th.length);
    if (!hang.length) return { loi: 'không có dòng dữ liệu nào khớp số cột' };
    const doc = (r) => [...r.querySelectorAll('td')].map((x) => (x.textContent || '').trim());
    const iCl = th.indexOf('Chênh lệch');
    const iHoan = th.indexOf('Đã hoàn');
    const iSau = th.indexOf('Sau phí bán');
    // [B266 25/11 — Admin Demo đảo cột] "% Mua ĐT" đổi lại tên thành "% Mua" (phí mua ĐỐI TÁC). 4 cột % vẫn đủ.
    const cotPct = ['% CM', '% Bán', '% Mua', '% Mua NĐT'].map((n) => th.indexOf(n)).filter((i) => i >= 0);
    const tran = [];
    const chuPct = [];
    for (const r of hang.slice(0, 40)) {
      const td = [...r.querySelectorAll('td')];
      for (const i of cotPct) {
        const o = td[i];
        if (!o) continue;
        chuPct.push((o.textContent || '').trim());
        if (o.scrollWidth > o.clientWidth + 1) tran.push(th[i] + '="' + (o.textContent || '').trim() + '"');
      }
    }
    return {
      soTieuDe: th.length,
      soODuLieu: hang[0].querySelectorAll('td').length,
      soCotPct: cotPct.length,
      iCl, iHoan, iSau, chuPct, tran,
      mau: hang.slice(0, 15).map(doc).map((td) => ({ hoan: td[iHoan], sau: td[iSau], lech: td[iCl] }))
    };
  });
  if (d.loi) throw new Error(d.loi);

  chot(d.soTieuDe === d.soODuLieu, 'số ô tiêu đề = số ô dữ liệu (' + d.soTieuDe + ' vs ' + d.soODuLieu + ')');
  chot(d.iCl >= 0 && d.iCl === d.iHoan + 1,
    'có cột "Chênh lệch" đứng NGAY SAU "Đã hoàn" (vị trí ' + d.iCl + ' vs ' + d.iHoan + ')');

  let sai = null;
  for (const m of d.mau) {
    // [B294 24/11 — ĐẢO CHIỀU theo L6] Quy ước Admin Demo chốt: CHÊNH LỆCH = SAU PHÍ BÁN − ĐÃ HOÀN
    // (>0 = còn hoàn thiếu, cùng chiều ô KPI). Bản cũ của cổng khẳng định chiều ngược (bệnh đã chữa).
    // Thấy lại số âm cho bill chưa hoàn = TÁI PHÁT → sửa app, cấm sửa cổng.
    if (soVN(m.lech) !== soVN(m.sau) - soVN(m.hoan)) { sai = m; break; }
  }
  console.log('      mẫu dòng đầu: đã hoàn=' + d.mau[0].hoan + ' · sau phí bán=' + d.mau[0].sau + ' · chênh lệch=' + d.mau[0].lech);
  chot(!sai, 'chênh lệch = SAU PHÍ BÁN − ĐÃ HOÀN trên MỌI dòng đã đo (quy ước B294)' + (sai ? ' (sai ở ' + JSON.stringify(sai) + ')' : ''));

  const conDau = d.chuPct.filter((x) => x.includes('%'));
  chot(d.soCotPct === 4 && conDau.length === 0,
    'bốn cột % CM · % Bán · % Mua · % Mua NĐT có đủ và KHÔNG còn dấu "%" (' + d.soCotPct + ' cột · ' + conDau.length + ' ô còn dấu)');

  const qua = d.chuPct.filter((x) => x !== '—' && x.length > 6);
  if (qua.length) console.log('      ô % quá dài:', [...new Set(qua)].slice(0, 5).join(' · '));
  chot(qua.length === 0, 'KHÔNG ô % nào dài quá 6 ký tự (' + qua.length + ') — chặn số thực kiểu 1,3800000000000001');

  if (d.tran.length) console.log('      ô bị tràn:', [...new Set(d.tran)].slice(0, 5).join(' · '));
  chot(d.tran.length === 0, 'ĐỐI CHỨNG đo bề ngang: chữ trong ô % KHÔNG rộng hơn chính ô đó (' + d.tran.length + ')');
} catch (e) {
  console.log('  ĐỎ  không chạy được phép kiểm: ' + e.message);
  so++; loi.push('không chạy được phép kiểm: ' + e.message);
} finally {
  await b?.close().catch(() => {});
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  await db.end();
}

console.log('\n[bang-cot] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[bang-cot] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[bang-cot] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
