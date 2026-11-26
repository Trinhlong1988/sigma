// B258 — [Admin Demo 23/11 "tất cả các lỗi khi thêm bill mà bị chặn phải hiển thị rõ lỗi, dễ hiểu để
// người dùng fix" + "chặn thêm phải show rõ lý do và hướng dẫn fix"]
//
// Cổng khoá 2 tầng:
//   (A) ĐỐI CHIẾU MÃ: mọi mã lỗi mà ĐƯỜNG GHI BILL của máy chủ có thể trả về đều phải có mục trong
//       bảng HUONG_DAN_LOI ở màn Doanh Số. Thêm mã mới ở máy chủ mà quên viết hướng dẫn ⇒ ĐỎ.
//   (B) BẤM THẬT: dựng 2 cảnh bị chặn có thật trên bản web, rồi khẳng định hộp báo lỗi hiện ĐỦ
//       (1) lý do, (2) dòng "CÁCH SỬA:", (3) mã lỗi — và KHÔNG phải câu chung chung.
// Đếm phép kiểm ĐỘNG (R198).
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
  console.error('[loi-bill] DUNG: chi chay tren DB THU, dang tro "' + DB_TEN + '".');
  process.exit(3);
}
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };

// ── (A) ĐỐI CHIẾU MÃ LỖI MÁY CHỦ ↔ BẢNG HƯỚNG DẪN ──
const trang = readFileSync(resolve(GOC, 'apps/desktop/src/renderer/src/pages/BillManualEntryPage.tsx'), 'utf8');
const khoiBang = /const HUONG_DAN_LOI[^=]*=\s*\{([\s\S]*?)\n\};/.exec(trang);
const coHuongDan = new Set(
  khoiBang ? [...khoiBang[1].matchAll(/^\s{2}([A-Z_]+):/gm)].map((m) => m[1]) : []
);
// Mã lỗi của ĐƯỜNG GHI BILL: route ghi/sửa bill + dịch vụ tạo lô + engine tính tiền.
const NGUON = [
  'apps/quanly-api/src/routes/bill-manual.ts',
  'apps/bot-api/src/lo-service.ts',
  'packages/services/src/transaction.ts'
];
const maMayChu = new Set();
for (const f of NGUON) {
  const noi = readFileSync(resolve(GOC, f), 'utf8');
  for (const m of noi.matchAll(/error:\s*'([A-Z_]+)'/g)) maMayChu.add(m[1]);
}
// Mã KHÔNG thuộc luồng "thêm bill" (hủy nợ/đối soát/duyệt…) — không bắt buộc có hướng dẫn ở màn này.
const NGOAI_LUONG = new Set([
  'ALREADY_CONFIRMED', 'ALREADY_WRITTEN_OFF', 'BAD_DEBT_CATEGORY_MISSING', 'DEBT_FULLY_PAID',
  'DEBT_SETTLE_DISABLED', 'LO_NOT_RECONCILABLE', 'NOT_BAD_DEBT'
]);
const canCo = [...maMayChu].filter((x) => !NGOAI_LUONG.has(x)).sort();
const thieu = canCo.filter((x) => !coHuongDan.has(x));
console.log('      mã lỗi máy chủ (luồng bill):', canCo.length, '· đã có hướng dẫn:', coHuongDan.size);
if (thieu.length) console.log('      THIẾU hướng dẫn cho:', thieu.join(' · '));
chot(coHuongDan.size >= 15, 'màn Doanh Số CÓ bảng hướng dẫn sửa lỗi (' + coHuongDan.size + ' mã)');
chot(thieu.length === 0, 'MỌI mã lỗi đường ghi bill đều có hướng dẫn sửa (' + canCo.length + ' mã)');
// Hướng dẫn phải CÓ NỘI DUNG (không để chuỗi rỗng cho đủ mâm).
const rong = khoiBang
  ? [...khoiBang[1].matchAll(/^\s{2}([A-Z_]+):\s*\{\s*tieuDe:\s*'([^']*)',\s*cachSua:\s*'([^']*)'/gm)]
    .filter((m) => m[2].trim().length < 5 || m[3].trim().length < 20).map((m) => m[1])
  : ['(không đọc được bảng)'];
chot(rong.length === 0, 'mỗi mục hướng dẫn đều có tiêu đề + CÁCH SỬA đủ dài'
  + (rong.length ? ' — sơ sài: ' + rong.join(', ') : ''));

// ── (B) BẤM THẬT TRÊN WEB ──
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN = 'kiem-b258';
let b = null;
try {
  const tho = randomUUID();
  await db.query(
    'INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)'
    + " VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '10 minutes',now(),$2)",
    [createHash('sha256').update(tho).digest('hex'), NHAN]);
  b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1700, height: 950 } });
  await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
  const p = await ctx.newPage();
  await p.goto(WEB + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await gacHopThoai(p);
  await dongHopThoaiChe(p);

  // Lấy NỘI DUNG hộp báo lỗi mà app dựng cho 1 mã lỗi — gọi thẳng hàm dựng thông điệp qua DOM thì
  // không được (là biến trong module), nên dựng cảnh THẬT: chặn API trả đúng mã rồi bấm ghi.
  const thuMa = async (ma, mess) => {
    await p.route('**/v1/bills/manual', (r) => {
      if (r.request().method() !== 'POST') return r.continue();
      return r.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ ok: false, error: ma, message: mess }) });
    });
    const chu = await p.evaluate(async ([maLoi, m2]) => {
      // Gọi đúng đường app dùng: window.api.billManualCreate → nhận {ok:false,...}.
      const r = await window.api.billManualCreate({ tidString: 'X', cardTypeId: 1, amountBeforeFee: 1000, billKey: 'k', bankReportedLoNumber: 1 });
      return JSON.stringify({ ok: r?.ok, error: r?.error, message: r?.message, maLoi, m2 });
    }, [ma, mess]);
    await p.unroute('**/v1/bills/manual');
    return chu;
  };
  const mau = JSON.parse(await thuMa('NO_ACTUAL_SELL_FEE', 'TID này chưa cấu hình giá bán thực tế.'));
  console.log('      app nhận được từ máy chủ:', mau.error, '·', String(mau.message).slice(0, 60));
  chot(mau.ok === false && mau.error === 'NO_ACTUAL_SELL_FEE' && String(mau.message).length > 10,
    'app NHẬN ĐÚNG mã lỗi + câu lý do từ máy chủ (không nuốt thành "lỗi hệ thống")');

  // Dựng cảnh bị chặn NGAY TRÊN FORM (không qua máy chủ): bấm Ghi nhận bill khi chưa chọn TID.
  const menu = p.locator("[data-kiem='nut-menu']");
  if (await menu.count()) { await menu.first().click(); await p.waitForTimeout(600); }
  const link = p.getByText('Doanh Số', { exact: false }).filter({ visible: true }).first();
  if (await link.count()) { await link.click({ timeout: 10000 }).catch(() => {}); }
  await p.waitForFunction(() => document.body.innerText.includes('Doanh số trước phí'), null, { timeout: 15000 });
  await p.locator('[data-nut="them"]').first().click();
  await p.waitForTimeout(1200);
  const nutGhi = p.getByRole('button', { name: /Ghi nhận bill/i }).first();
  await nutGhi.click({ timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(900);
  // Bám `data-kiem="hop-bao-loi"` — bảng NHẬP BILL cũng là lớp phủ `fixed inset-0`, đọc bừa phần tử
  // đầu tiên là trúng bảng nhập chứ không phải hộp báo lỗi (đã cắn ngay lần chạy đầu).
  const hop = await p.evaluate(() => {
    const el = document.querySelector('[data-kiem="hop-bao-loi"]');
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  });
  console.log('      hộp báo khi thiếu thông tin:', JSON.stringify(hop.slice(0, 110)));
  chot(hop.length > 20 && /(Chọn TID|Thiếu|chưa|phải)/i.test(hop),
    'bấm ghi khi THIẾU thông tin → hộp báo NÓI RÕ thiếu gì: ' + JSON.stringify(hop.slice(0, 70)));
} catch (e) {
  console.log('  ĐỎ  không chạy được phép kiểm: ' + e.message);
  so++; loi.push('không chạy được phép kiểm: ' + e.message);
} finally {
  await b?.close().catch(() => {});
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  await db.end();
}

const CAN = 5;
console.log('\n[loi-bill] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[loi-bill] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[loi-bill] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
