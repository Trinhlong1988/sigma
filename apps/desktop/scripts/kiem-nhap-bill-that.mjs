// LÁI GIAO DIỆN THẬT ĐỂ NHẬP 1 BILL — TRÊN BẢN SAO SỔ (Admin Demo duyệt 7/11).
//
// Không dùng mật khẩu: tự tạo 1 PHIÊN TẠM trong bản sao, gắn cookie cho trình duyệt, lái UI như người dùng,
// rồi XOÁ phiên. Chỉ chạm `sigma_thu` — KHÔNG đụng sổ thật.
//
// Dùng: node scripts/kiem-nhap-bill-that.mjs
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const DIA_CHI = process.env.URL_THU || 'http://127.0.0.1:57914/';
const RA = resolve(import.meta.dirname, '../screenshots/nhap-bill-that');
mkdirSync(RA, { recursive: true });

let datHet = true;
const chot = (ok, ten) => {
  if (!ok) {
    datHet = false;
    console.log('  >>> PHÉP KIỂM ĐỎ — ' + ten);
  }
};

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const m = /^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t);
const u = new URL(m[1].replace(/^["']|["']$/g, ''));
u.pathname = '/sigma_thu'; // CHỈ bản sao — chặn cứng, không cho trỏ sổ thật
if (!u.pathname.endsWith('_thu')) {
  console.error('[nhap-bill] DỪNG: chỉ được chạy trên bản sao.');
  process.exit(1);
}

const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
let phienId = null;
let browser = null;

try {
  // ── 1. Tạo phiên tạm cho 1 user CÓ QUYỀN GHI ──
  const nguoi = (
    await db.query(
      `SELECT u.id, u.username, u.full_name FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE p.code = 'REVENUE_MANAGE' AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
        GROUP BY u.id, u.username, u.full_name ORDER BY u.id LIMIT 1`
    )
  ).rows[0];
  if (!nguoi) throw new Error('Bản sao không có tài khoản nào có quyền REVENUE_MANAGE');
  phienId = randomUUID();
  await db.query(
    `INSERT INTO login_sessions (id, user_id, created_at, expires_at, last_seen_at, device_info)
     VALUES ($1, $2, now(), now() + interval '2 hours', now(), $3)`,
    [phienId, nguoi.id, 'kiem-thu-nhap-bill (bản sao)']
  );
  console.log(`[nhap-bill] phiên tạm cho ${nguoi.username} (${nguoi.full_name}), hạn 2 giờ`);

  // ── 2. Chọn TID + loại phí + thẻ CÓ giá bán thực tế, để không vướng gate NO_ACTUAL_SELL_FEE ──
  const mau = (
    await db.query(
      `SELECT t.tid, b.name AS bank, ft.name AS loai_phi, ct.name AS the, f.phi_ban
         FROM tid_sell_fees f
         JOIN tids t ON t.id = f.tid_id
         JOIN banks b ON b.id = t.bank_id
         JOIN fee_types ft ON ft.id = f.fee_type_id
         JOIN card_types ct ON ct.id = f.card_type_id
        WHERE t.deleted_at IS NULL AND f.deleted_at IS NULL AND f.phi_ban IS NOT NULL
        ORDER BY t.id LIMIT 1`
    )
  ).rows[0];
  if (!mau) throw new Error('Bản sao không có TID nào đặt giá bán thực tế');
  const pct = Number(mau.phi_ban) / 1000;
  console.log(`[nhap-bill] dùng TID ${mau.tid} · ${mau.bank} · ${mau.loai_phi} · thẻ ${mau.the} · bán ${pct}%`);

  const TIEN = 12_345_000;
  const SO_LO = String(7000 + (Date.now() % 900));
  const SO_HD = String(880000 + (Date.now() % 9000));

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addCookies([{ name: 'ql_session', value: phienId, domain: '127.0.0.1', path: '/', httpOnly: true }]);
  const page = await ctx.newPage();
  const loi = [];
  page.on('pageerror', (e) => loi.push(String(e)));

  await page.goto(DIA_CHI, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: resolve(RA, '1-vao-app.png') });
  const vaoDuoc = await page.evaluate(() => !/Tên đăng nhập/.test(document.body.innerText));
  console.log('  [vào app bằng phiên tạm]', vaoDuoc ? 'ĐƯỢC' : 'KHÔNG ĐƯỢC');
  chot(vaoDuoc, 'vào thẳng app bằng phiên tạm (không qua màn đăng nhập)');
  if (!vaoDuoc) throw new Error('Không vào được app — dừng.');

  // ── 3. Mở form, điền, ghi ──
  await page.getByRole('button', { name: 'Thêm bill mới' }).click();
  await page.waitForTimeout(900);
  // Ngân hàng + TID là ô TÌM-CHỌN (không phải <select>) — dùng ĐÚNG khuôn chonTid của bộ bài kiểm chính.
  await page.getByPlaceholder('— Chọn ngân hàng —').click();
  await page.keyboard.type(mau.bank, { delay: 25 });
  await page.waitForTimeout(350);
  await page.getByText(mau.bank, { exact: false }).last().click();
  await page.waitForTimeout(450);
  await page.getByPlaceholder('— Gõ tên HKD hoặc số TID —').click();
  await page.keyboard.type(mau.tid, { delay: 25 });
  await page.waitForTimeout(350);
  await page.getByText(mau.tid, { exact: false }).last().click();
  await page.waitForTimeout(600);
  // <select> trong bảng nổi: [0] loại thẻ, [1] loại phí. Chọn LOẠI PHÍ trước thì biểu phí mới nạp.
  const selects = page.locator('.fixed.inset-0 select');
  await selects.nth(1).selectOption({ label: mau.loai_phi });
  await page.waitForTimeout(800);
  await selects.nth(0).selectOption({ label: new RegExp('^' + mau.the) }).catch(async () => {
    await selects.nth(0).selectOption({ index: 1 }).catch(() => undefined);
  });
  await page.waitForTimeout(500);
  await page.getByLabel('Số hóa đơn').fill(SO_HD);
  await page.getByLabel('Số lô').fill(SO_LO);
  await page.getByLabel('Trước phí').fill(String(TIEN));
  await page.getByLabel('Giờ', { exact: true }).fill('10');
  await page.getByLabel('Phút', { exact: true }).fill('45');
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(RA, '2-da-dien.png') });

  console.log('  [dbg các ô chọn]', JSON.stringify(await page.evaluate(() =>
    [...document.querySelectorAll('.fixed.inset-0 select')].map((sl, i) => ({
      i,
      dangChon: (sl.options[sl.selectedIndex] || {}).textContent,
      muc: [...sl.options].map((o) => o.textContent).slice(0, 6)
    }))
  )));
  const truocKhiGhi = await page.evaluate(() => {
    const o = [...document.querySelectorAll('.fixed.inset-0 div')].filter((d) => String(d.className).includes('grid-cols-[1fr_auto]'));
    const lay = (ten) => {
      const h = o.find((d) => ((d.querySelectorAll('span')[0] || {}).textContent || '').includes(ten));
      return h ? (h.querySelectorAll('span')[1] || {}).textContent?.trim() : null;
    };
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Ghi nhận bill'));
    return { truocPhi: lay('Tiền trước phí bán'), sauPhi: lay('Sau phí bán'), phanTram: lay('% phí bán'), nutBiChan: b ? b.disabled : null };
  });
  console.log('  [màn hiện trước khi ghi]', JSON.stringify(truocKhiGhi));
  chot(truocKhiGhi.nutBiChan === false, 'nút Ghi nhận mở được (đủ dữ liệu + có giá bán)');

  // ô xác nhận cảnh báo (nếu có)
  const oXN = page.locator('.fixed.inset-0 input[type=checkbox].accent-warning, .fixed.inset-0 input[type=checkbox].accent-danger');
  for (let i = 0; i < (await oXN.count()); i++) await oXN.nth(i).check({ force: true }).catch(() => undefined);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Ghi nhận bill' }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: resolve(RA, '3-sau-khi-ghi.png') });

  const kq = await page.evaluate(() => {
    const h = [...document.querySelectorAll('h3')].find((x) => /Đã ghi vào sổ|CHƯA ghi vào sổ/.test(x.textContent || ''));
    const t2 = document.body.innerText;
    const mLo = /mã lô (\d+)/i.exec(t2);
    return { tieuDe: h ? h.textContent.trim() : null, maLo: mLo ? Number(mLo[1]) : null, toan: t2.replace(/\s+/g, ' ').slice(0, 260) };
  });
  console.log('  [kết quả ghi]', JSON.stringify(kq));
  chot(/Đã ghi vào sổ/.test(kq.tieuDe ?? ''), 'popup báo ĐÃ GHI VÀO SỔ');
  chot(kq.maLo != null, 'popup có mã lô để tra sổ');

  // ── 4. ĐỐI CHIẾU VỚI SỔ ──
  if (kq.maLo != null) {
    const rows = (await db.query('SELECT amount_before_fee::text a, fee_applied::text f, amount_after_fee::text s FROM lo_rows WHERE lo_id=$1', [kq.maLo])).rows;
    const sTruoc = rows.reduce((x, r) => x + Number(r.a), 0);
    const sSau = rows.reduce((x, r) => x + Number(r.s), 0);
    const soMan = (v) => Number(String(v ?? '').replace(/[^\d]/g, '') || 0);
    console.log(`  [đối chiếu] SỔ: trước ${sTruoc} · về ${sSau}   ||   MÀN: trước ${soMan(truocKhiGhi.truocPhi)} · về ${soMan(truocKhiGhi.sauPhi)}`);
    chot(sTruoc === TIEN, `sổ ghi đúng tiền trước phí (${sTruoc} vs ${TIEN})`);
    chot(sSau === soMan(truocKhiGhi.sauPhi), 'tiền về đại lý trong sổ KHỚP số trên màn');
    const lo = (await db.query('SELECT bank_reported_lo_number n, bill_key k FROM los WHERE id=$1', [kq.maLo])).rows[0];
    console.log('  [sổ] số lô =', lo?.n, '· khoá bill =', lo?.k);
    chot(String(lo?.n ?? '') === SO_LO, `sổ ghi đúng số lô (${lo?.n} vs ${SO_LO})`);
  }

  if (loi.length) {
    datHet = false;
    console.log('  *** CÓ ' + loi.length + ' LỖI RUNTIME ***');
    loi.slice(0, 5).forEach((x) => console.log('    ', x));
  }
} catch (e) {
  console.error('[nhap-bill] LỖI:', e?.message ?? e);
  datHet = false;
} finally {
  if (browser) await browser.close();
  if (phienId) {
    await db.query('DELETE FROM login_sessions WHERE id = $1', [phienId]);
    console.log('[nhap-bill] đã XOÁ phiên tạm.');
  }
  await db.end();
  console.log('[nhap-bill] ảnh ở:', RA);
  console.log('[nhap-bill] KẾT LUẬN:', datHet ? 'không phép kiểm nào đỏ' : '*** CÒN PHÉP KIỂM ĐỎ ***');
  process.exitCode = datHet ? 0 : 1;
}
