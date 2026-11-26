// B256 — [Admin Demo 23/11 "vì sao lọc NĐT doanh số danh sách bill xong lọc theo ca không ra? đào sâu
// fix sạch lỗi tương tự"] QUÉT MỌI Ô LỌC Ở MÀN DOANH SỐ, KHÔNG CHỈ Ô CA.
//
// LỚP LỖI: ô lọc dựng danh sách bằng GIÁ TRỊ TỰ ĐẶT ("1","2","3") trong khi phép lọc đem so với CHUỖI
// KHÁC (tên ca "Ca 1" / tên ca người dùng tự đặt) ⇒ chọn vào là bảng RỖNG, không báo lỗi gì.
// Cổng này không kiểm riêng ô Ca mà DUYỆT TỪNG Ô LỌC brand trên màn: chọn mục ĐẦU TIÊN rồi khẳng định
//   (1) bảng CÒN DÒNG (không rỗng) — đúng triệu chứng Admin Demo gặp;
//   (2) MỌI dòng còn lại đều mang đúng giá trị vừa chọn ở ĐÚNG CỘT tương ứng (lọc ĐÚNG, không lọc bừa);
//   (3) bỏ chọn thì bảng về đủ như cũ.
// Thêm ô lọc mới mà quên nối cột -> cổng này đỏ ngay.
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
  console.error('[o-loc] DUNG: chi chay tren DB THU, dang tro "' + DB_TEN + '".');
  process.exit(3);
}
// Ô lọc brand (data-loc) → CỘT trên bảng dùng để đối chứng giá trị đã chọn.
// Ô nào giá trị KHÔNG hiện thành cột (vd "Người hoàn" có mục đặc biệt) thì để null: chỉ kiểm không rỗng.
const O_LOC = [
  { khoa: 'dl', ten: 'Đại lý', cot: 'Đại lý' },
  { khoa: 'tid', ten: 'TID', cot: 'TID' },
  { khoa: 'hkd', ten: 'HKD', cot: 'HKD' },
  { khoa: 'bank', ten: 'Ngân hàng', cot: 'NH' },
  { khoa: 'ca', ten: 'Ca', cot: 'Ca' },
  { khoa: 'the', ten: 'Loại thẻ', cot: 'THẺ' },
  { khoa: 'phi', ten: 'Loại phí', cot: 'Loại phí' },
  { khoa: 'ndt', ten: 'NĐT', cot: 'NĐT' },
  { khoa: 'nguoihoan', ten: 'Người hoàn', cot: null }
];
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
// 3 phép kiểm cho mỗi ô lọc + 1 phép đếm số ô lọc tìm thấy.
const CAN = O_LOC.length * 3 + 1;

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN = 'kiem-b256';
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
  const ctx = await b.newContext({ viewport: { width: 1700, height: 950 } });
  await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
  const p = await ctx.newPage();
  await p.goto(WEB + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
  // Màn vừa mở có thể đang bật HỘP THOẠI (lớp phủ `fixed inset-0`) — vd cảnh báo "danh sách chưa đủ".
  // Lớp phủ đó CHẶN mọi cú bấm; không dẹp trước thì cổng treo 30s rồi đỏ vì lý do chẳng liên quan.
  for (let i = 0; i < 4; i++) {
    const phu = await p.locator('div.fixed.inset-0').filter({ visible: true }).count();
    if (!phu) break;
    const chu = await p.evaluate(() => {
      const el = [...document.querySelectorAll('div.fixed.inset-0')].find((x) => x.offsetParent !== null || x.getClientRects().length);
      return el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    });
    console.log('      có hộp thoại che màn:', JSON.stringify(chu), '→ đóng');
    const nut = await p.evaluate(() => {
      const el = [...document.querySelectorAll('div.fixed.inset-0')].find((x) => x.getClientRects().length);
      return el ? [...el.querySelectorAll('button')].map((b2) => (b2.textContent || '').trim() || b2.getAttribute('aria-label') || '(không chữ)') : [];
    });
    console.log('      nút trong hộp thoại:', JSON.stringify(nut));
    // Bấm nút CUỐI (thường là "Đóng"/"Để sau"); không có nút thì bấm ra ngoài lớp phủ rồi Escape.
    const daBam = await p.evaluate(() => {
      const el = [...document.querySelectorAll('div.fixed.inset-0')].find((x) => x.getClientRects().length);
      if (!el) return false;
      const bs = [...el.querySelectorAll('button')];
      const dong2 = bs.find((b2) => /Đóng|Để sau|Bỏ qua|Đã hiểu|OK|Hủy/i.test(b2.textContent || ''))
        ?? bs[bs.length - 1];
      if (dong2) { dong2.click(); return true; }
      return false;
    });
    if (!daBam) await p.keyboard.press('Escape');
    await p.waitForTimeout(800);
  }

  const menu = p.locator("[data-kiem='nut-menu']");
  if (await menu.count()) { await menu.first().click(); await p.waitForTimeout(600); }
  // Vào màn Doanh Số: ưu tiên mục THẤY ĐƯỢC trong thanh bên (exact:true có khi trúng phần tử ẩn
  // → click treo 30s). Bấm xong CHỜ ô KPI "Doanh số trước phí" chứ không ngủ cứng.
  const link = p.getByText('Doanh Số', { exact: false }).filter({ visible: true }).first();
  if (await link.count()) { await link.click({ timeout: 10000 }).catch(() => {}); }
  try {
    await p.waitForFunction(() => document.body.innerText.includes('Doanh số trước phí'), null, { timeout: 15000 });
  } catch {
    throw new Error('không vào được màn Doanh Số (không thấy ô KPI "Doanh số trước phí")');
  }
  for (const o of await p.locator('input[type="date"]').all()) { await o.fill(ngay.d); await p.waitForTimeout(350); }
  await p.waitForTimeout(3000);

  const docBang = () => p.evaluate(() => {
    const tb = document.querySelector('table');
    const th = [...tb.querySelectorAll('thead th')].map((x) => (x.textContent || '').trim());
    const hang = [...tb.querySelectorAll('tbody tr')]
      .filter((r) => r.querySelectorAll('td').length === th.length)
      .map((r) => [...r.querySelectorAll('td')].map((c) => (c.textContent || '').trim()));
    return { th, hang };
  });
  const banDau = await docBang();
  console.log('      bảng ban đầu:', banDau.hang.length, 'dòng ·', banDau.th.length, 'cột');
  if (!banDau.hang.length) throw new Error('kỳ xem không có bill nào để kiểm');

  const coODau = [];
  for (const x of O_LOC) if (await p.locator('[data-loc="' + x.khoa + '"]').count()) coODau.push(x.khoa);
  console.log('      thấy', coODau.length + '/' + O_LOC.length, 'ô lọc brand:', coODau.join(' · '));
  chot(coODau.length === O_LOC.length,
    'thanh lọc có ĐỦ ' + O_LOC.length + ' ô lọc brand (thiếu ô nào là danh sách khoá đã lạc hậu)');

  const mo = async (khoa) => {
    if (!(await p.locator('[data-loc-hop="' + khoa + '"]').count())) {
      await p.locator('[data-loc="' + khoa + '"] button').first().click();
      await p.waitForTimeout(700);
    }
  };
  const dong = async (khoa) => {
    if (await p.locator('[data-loc-hop="' + khoa + '"]').count()) {
      await p.locator('[data-loc="' + khoa + '"] button').first().click();
      await p.waitForTimeout(400);
    }
  };

  for (const x of O_LOC) {
    console.log('   ── ô lọc "' + x.ten + '"');
    if (!coODau.includes(x.khoa)) {
      chot(false, 'ô lọc "' + x.ten + '" KHÔNG có trên màn');
      chot(false, 'ô lọc "' + x.ten + '": không kiểm được giá trị (thiếu ô)');
      chot(false, 'ô lọc "' + x.ten + '": không kiểm được bỏ chọn (thiếu ô)');
      continue;
    }
    await mo(x.khoa);
    const muc = await p.evaluate((k) => {
      const pn = document.querySelector('[data-loc-hop="' + k + '"]');
      return pn ? [...pn.querySelectorAll('button')].map((y) => (y.textContent || '').trim())
        .filter((y) => y && !/Chọn tất cả|Bỏ chọn/.test(y)) : [];
    }, x.khoa);
    if (!muc.length) {
      chot(false, 'ô lọc "' + x.ten + '" xổ ra RỖNG (không có mục nào để chọn)');
      chot(false, 'ô lọc "' + x.ten + '": không kiểm được giá trị (ô rỗng)');
      chot(false, 'ô lọc "' + x.ten + '": không kiểm được bỏ chọn (ô rỗng)');
      await dong(x.khoa);
      continue;
    }
    const chon = muc[0];
    await p.evaluate(([k, ten]) => {
      const pn = document.querySelector('[data-loc-hop="' + k + '"]');
      [...(pn?.querySelectorAll('button') ?? [])].find((y) => (y.textContent || '').trim() === ten)?.click();
    }, [x.khoa, chon]);
    await p.waitForTimeout(1200);
    await dong(x.khoa);
    const sau = await docBang();
    console.log('      chọn "' + chon + '" → bảng còn ' + sau.hang.length + '/' + banDau.hang.length + ' dòng');
    chot(sau.hang.length > 0,
      'ô lọc "' + x.ten + '": chọn "' + chon + '" VẪN RA DÒNG (không rỗng câm) — đúng lỗi Admin Demo gặp');
    if (x.cot) {
      const ci = sau.th.indexOf(x.cot);
      // Cột "Loại phí" hiện VIẾT TẮT (Đối ứng → Đ/Ư · Tiền chờ → T/C · Uỷ quyền → U/Q) trong khi ô lọc
      // dùng tên đầy đủ ⇒ so thẳng là đỏ OAN. Quy về cùng dạng rồi mới so.
      const viTat = { 'Đối ứng': 'Đ/Ư', 'Tiền chờ': 'T/C', 'Uỷ quyền': 'U/Q', 'Ủy quyền': 'U/Q' };
      const mong = viTat[chon] ?? chon;
      const lech = ci < 0 ? ['KHÔNG thấy cột "' + x.cot + '"']
        : sau.hang.filter((r) => r[ci] !== chon && r[ci] !== mong).map((r) => r[ci]).slice(0, 3);
      if (lech.length) console.log('      dòng lệch (cột ' + x.cot + '):', lech.join(' | '));
      chot(ci >= 0 && lech.length === 0,
        'ô lọc "' + x.ten + '": MỌI dòng còn lại đúng giá trị "' + chon + '" ở cột ' + x.cot);
    } else {
      chot(sau.hang.length <= banDau.hang.length,
        'ô lọc "' + x.ten + '": lọc có tác dụng (không nhiều hơn số dòng ban đầu)');
    }
    // Bỏ chọn → về như cũ
    await mo(x.khoa);
    await p.evaluate((k) => {
      const pn = document.querySelector('[data-loc-hop="' + k + '"]');
      [...(pn?.querySelectorAll('button') ?? [])].find((y) => /Bỏ chọn/.test(y.textContent || ''))?.click();
    }, x.khoa);
    await p.waitForTimeout(900);
    await dong(x.khoa);
    const ve = await docBang();
    chot(ve.hang.length === banDau.hang.length,
      'ô lọc "' + x.ten + '": bỏ chọn thì bảng về đủ ' + banDau.hang.length + ' dòng');
  }
} catch (e) {
  console.log('  ĐỎ  không chạy được phép kiểm: ' + e.message);
  so++; loi.push('không chạy được phép kiểm: ' + e.message);
} finally {
  await b?.close().catch(() => {});
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  await db.end();
}
console.log('\n[o-loc] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[o-loc] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[o-loc] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
