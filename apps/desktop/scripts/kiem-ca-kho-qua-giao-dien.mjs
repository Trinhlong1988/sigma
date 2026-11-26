// LÁI GIAO DIỆN THẬT — 3 CA KHÓ (Admin Demo 12/11): TÁCH 2 THẺ · MƯỢN TID · GÕ LẠI BILL TRÙNG.
//
// Chạy TRÊN BẢN SAO (`sigma_thu`, qua cổng web 57914 → API 8795). Không chạm sổ thật.
// Tự tạo phiên tạm → lái UI như người dùng → ĐỌC LẠI SỔ đối chiếu từng con số → xoá phiên.
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const DIA_CHI = process.env.URL_THU || 'http://127.0.0.1:57914/';
const RA = resolve(import.meta.dirname, '../screenshots/ca-kho');
mkdirSync(RA, { recursive: true });

let datHet = true;
const chot = (ok, ten) => {
  if (!ok) {
    datHet = false;
    console.log('  >>> PHÉP KIỂM ĐỎ — ' + ten);
  }
};
const soTu = (v) => Number(String(v ?? '').replace(/[^\d]/g, '') || 0);

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/sigma_thu';

const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
let phienId = null;
let browser = null;

/** Mở form, chọn ngân hàng + TID + loại phí + loại thẻ. */
async function moFormVaChon(page, mau) {
  await page.getByRole('button', { name: 'Thêm bill mới' }).click();
  await page.waitForTimeout(900);
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
  const sel = page.locator('.fixed.inset-0 select');
  await sel.nth(1).selectOption({ label: mau.loai_phi });
  // Biểu phí nạp BẤT ĐỒNG BỘ — phải CHỜ ô loại thẻ có mục thật rồi mới chọn, đừng đoán bằng waitForTimeout.
  await page
    .waitForFunction(() => {
      const s0 = document.querySelector('.fixed.inset-0 select');
      return !!s0 && s0.options.length > 1;
    }, { timeout: 15000 })
    .catch(() => undefined);
  const idxThe = await page.evaluate((ten) => {
    const s0 = document.querySelector('.fixed.inset-0 select');
    return [...s0.options].findIndex((o) => (o.textContent || '').trim().startsWith(ten));
  }, mau.the1);
  if (idxThe < 1) throw new Error('Không thấy loại thẻ "' + mau.the1 + '" trong ô chọn');
  await sel.nth(0).selectOption({ index: idxThe });
  await page.waitForTimeout(500);
}

const docChotSo = (page) =>
  page.evaluate(() => {
    const o = [...document.querySelectorAll('.fixed.inset-0 div')].filter((d) => String(d.className).includes('grid-cols-[1fr_auto]'));
    const lay = (ten) => {
      const h = o.find((d) => ((d.querySelectorAll('span')[0] || {}).textContent || '').includes(ten));
      return h ? (h.querySelectorAll('span')[1] || {}).textContent?.trim() : null;
    };
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Ghi nhận bill'));
    return { truocPhi: lay('Tiền trước phí bán'), sauPhi: lay('Sau phí bán'), veNha: lay('Về đại lý'), nutBiChan: b ? b.disabled : null };
  });

async function bamGhi(page) {
  const oXN = page.locator('.fixed.inset-0 input[type=checkbox].accent-warning, .fixed.inset-0 input[type=checkbox].accent-danger');
  for (let i = 0; i < (await oXN.count()); i++) await oXN.nth(i).check({ force: true }).catch(() => undefined);
  await page.waitForTimeout(300);
  const vanChan = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Ghi nhận bill'));
    if (!b || !b.disabled) return null;
    const f = document.querySelector('.fixed.inset-0');
    const t2 = (f?.textContent || '').replace(/\s+/g, ' ');
    return {
      oTich: [...document.querySelectorAll('.fixed.inset-0 input[type=checkbox]')].map((c) => c.checked),
      dongTach: [...document.querySelectorAll('.fixed.inset-0 select')].map((sl) => (sl.options[sl.selectedIndex] || {}).textContent),
      oReadonly: [...document.querySelectorAll('.fixed.inset-0 input[readonly]')].map((i) => i.value),
      canhBao: ['TRÙNG HOÀN TOÀN', 'TRÙNG SỐ LÔ', 'TRÙNG SỐ HÓA ĐƠN', 'NGHỊCH THỨ TỰ', 'NGƯỜI HOÀN', 'chưa đặt giá bán', 'lớn hơn'].filter((k) => t2.includes(k)),
      doDai: t2.length
    };
  });
  if (vanChan) console.log('     [dbg VÌ SAO NÚT CÒN BỊ CHẶN]', JSON.stringify(vanChan));
  await page.getByRole('button', { name: 'Ghi nhận bill' }).click({ timeout: 8000 });
  await page.waitForTimeout(2500);
  return page.evaluate(() => {
    const h = [...document.querySelectorAll('h3')].find((x) => /Đã ghi vào sổ|CHƯA ghi vào sổ/.test(x.textContent || ''));
    const m = /mã lô (\d+)/i.exec(document.body.innerText);
    // Không có bảng nổi thành công ⇒ nhiều khả năng là hộp BÁO LỖI. Lấy nguyên văn để biết vì sao.
    const hopNoi = [...document.querySelectorAll('.fixed.inset-0')].map((d) => (d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220));
    return { tieuDe: h ? h.textContent.trim() : null, maLo: m ? Number(m[1]) : null, hopNoi };
  });
}

async function dongPopup(page) {
  for (let i = 0; i < 4; i++) {
    const con = await page.evaluate(() => !!document.querySelector('.fixed.inset-0'));
    if (!con) return;
    await page.getByRole('button', { name: 'Xong' }).click({ timeout: 1500 }).catch(() => undefined);
    await page.getByRole('button', { name: /^Đóng$|Đã hiểu|OK/ }).click({ timeout: 1500 }).catch(() => undefined);
    await page.locator('.fixed.inset-0 button[title="Đóng"]').first().click({ timeout: 1500 }).catch(() => undefined);
    await page.getByRole('button', { name: /Đóng, bỏ dữ liệu/ }).click({ timeout: 1500 }).catch(() => undefined);
    await page.waitForTimeout(400);
  }
}

try {
  const nguoi = (
    await db.query(
      `SELECT u.id, u.username FROM users u JOIN user_roles ur ON ur.user_id=u.id
         JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id
        WHERE p.code='REVENUE_MANAGE' AND u.deleted_at IS NULL AND u.status='ACTIVE'
        GROUP BY u.id,u.username ORDER BY u.id LIMIT 1`
    )
  ).rows[0];
  phienId = randomUUID();
  await db.query(
    `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
     VALUES ($1,$2,now(),now()+interval '2 hours',now(),$3)`,
    [phienId, nguoi.id, 'kiem-ca-kho (bản sao)']
  );
  console.log(`[ca-kho] phiên tạm cho ${nguoi.username}`);

  // TID có ≥2 loại thẻ cùng loại phí (để tách thẻ)
  const r = await db.query(
    `SELECT t.tid, b.name AS bank, ft.name AS loai_phi,
            array_agg(ct.name ORDER BY ct.id) AS the, array_agg(f.phi_ban ORDER BY ct.id) AS pct
       FROM tid_sell_fees f
       JOIN tids t ON t.id=f.tid_id JOIN banks b ON b.id=t.bank_id
       JOIN fee_types ft ON ft.id=f.fee_type_id JOIN card_types ct ON ct.id=f.card_type_id
      WHERE t.deleted_at IS NULL AND f.deleted_at IS NULL AND f.phi_ban IS NOT NULL
      GROUP BY t.tid,b.name,ft.name HAVING COUNT(*)>=2 ORDER BY t.tid LIMIT 1`
  );
  if (!r.rowCount) throw new Error('Bản sao không có TID nào đặt giá bán cho ≥2 loại thẻ');
  const mau = { tid: r.rows[0].tid, bank: r.rows[0].bank, loai_phi: r.rows[0].loai_phi, the1: r.rows[0].the[0], the2: r.rows[0].the[1] };
  const pct1 = Number(r.rows[0].pct[0]) / 1000;
  const pct2 = Number(r.rows[0].pct[1]) / 1000;
  console.log(`[ca-kho] TID ${mau.tid} · ${mau.bank} · ${mau.loai_phi} · ${mau.the1} ${pct1}% + ${mau.the2} ${pct2}%`);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addCookies([{ name: 'ql_session', value: phienId, domain: '127.0.0.1', path: '/', httpOnly: true }]);
  const page = await ctx.newPage();
  const loi = [];
  page.on('pageerror', (e) => loi.push(String(e)));
  await page.goto(DIA_CHI, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const dau = Date.now() % 1000;

  // ═════ CA 1: TÁCH 2 LOẠI THẺ ═════
  console.log('\n── CA 1: TÁCH 2 LOẠI THẺ ──');
  const TONG = 100_000_000;
  const PHAN1 = 60_000_000;
  await moFormVaChon(page, mau);
  await page.getByLabel('Số hóa đơn').fill(String(770000 + dau));
  await page.getByLabel('Số lô').fill(String(8100 + dau));
  await page.getByLabel('Trước phí').fill(String(TONG));
  await page.getByLabel('Giờ', { exact: true }).fill('09');
  await page.getByLabel('Phút', { exact: true }).fill('15');
  await page.waitForTimeout(500);
  await page.getByText('Lô này quẹt NHIỀU loại thẻ', { exact: false }).click();
  await page.waitForTimeout(600);
  const oTien = page.locator('.fixed.inset-0 input[inputmode="numeric"][class*="w-44"]:not([readonly])');
  await oTien.first().fill(String(PHAN1));
  await page.waitForTimeout(700);
  const man1 = await docChotSo(page);
  await page.screenshot({ path: resolve(RA, 'ca1-tach-the.png') });
  console.log('  màn:', JSON.stringify(man1));
  const kq1 = await bamGhi(page);
  console.log('  kết quả:', JSON.stringify(kq1));
  chot(/Đã ghi vào sổ/.test(kq1.tieuDe ?? ''), 'CA1 ghi được vào sổ');
  if (kq1.maLo) {
    const rows = (await db.query('SELECT card_type_id, amount_before_fee::text a, amount_after_fee::text s FROM lo_rows WHERE lo_id=$1 ORDER BY id', [kq1.maLo])).rows;
    const sTruoc = rows.reduce((x, y) => x + Number(y.a), 0);
    const sSau = rows.reduce((x, y) => x + Number(y.s), 0);
    const mong = PHAN1 - Math.round((PHAN1 * Math.round(pct1 * 1000)) / 100000) + (TONG - PHAN1) - Math.round(((TONG - PHAN1) * Math.round(pct2 * 1000)) / 100000);
    console.log(`  sổ: ${rows.length} dòng · trước ${sTruoc} · về ${sSau} || tính độc lập ${mong} || màn ${soTu(man1.sauPhi)}`);
    chot(rows.length === 2, 'CA1 sổ có ĐÚNG 2 dòng thẻ');
    chot(sTruoc === TONG, 'CA1 Σ trước phí = tổng bill');
    chot(sSau === mong, 'CA1 tiền về tính theo % RIÊNG từng thẻ');
    chot(sSau === soTu(man1.sauPhi), 'CA1 sổ KHỚP màn');
  }
  await dongPopup(page);

  // ═════ CA 2: MƯỢN TID ═════
  console.log('\n── CA 2: MƯỢN TID ──');
  await moFormVaChon(page, mau);
  await page.getByText('Bill này đại lý khác MƯỢN máy', { exact: false }).click();
  await page.waitForTimeout(500);
  await page.getByPlaceholder('— Chọn đại lý mượn —').click();
  await page.keyboard.type('n', { delay: 40 });
  await page.waitForTimeout(600);
  const tenMuon = await page.evaluate(() => {
    const ds = [...document.querySelectorAll('[role="listbox"] li, [role="option"], .fixed.inset-0 ul li')]
      .map((x) => (x.textContent || '').trim())
      .filter(Boolean);
    return ds[0] ?? null;
  });
  if (!tenMuon) throw new Error('CA2: không lấy được tên đại lý mượn từ danh sách thả xuống');
  await page.getByText(tenMuon, { exact: true }).last().click();
  await page.waitForTimeout(600);
  await page.getByLabel('Số hóa đơn').fill(String(771000 + dau));
  await page.getByLabel('Số lô').fill(String(8200 + dau));
  await page.getByLabel('Trước phí').fill('20000000');
  await page.getByLabel('Giờ', { exact: true }).fill('10');
  await page.getByLabel('Phút', { exact: true }).fill('20');
  await page.waitForTimeout(700);
  const man2 = await docChotSo(page);
  await page.screenshot({ path: resolve(RA, 'ca2-muon-tid.png') });
  console.log('  đại lý mượn =', tenMuon, '· màn:', JSON.stringify(man2));
  const kq2 = await bamGhi(page);
  console.log('  kết quả:', JSON.stringify(kq2));
  chot(/Đã ghi vào sổ/.test(kq2.tieuDe ?? ''), 'CA2 ghi được vào sổ');
  if (kq2.maLo) {
    const l = (await db.query('SELECT borrowed_by_customer_id b, (SELECT full_name FROM customers WHERE id=l.borrowed_by_customer_id) ten FROM los l WHERE l.id=$1', [kq2.maLo])).rows[0];
    const soLo = (await db.query('SELECT COUNT(*)::int n FROM los WHERE bill_key=(SELECT bill_key FROM los WHERE id=$1) AND status<>\'CANCELLED\'', [kq2.maLo])).rows[0].n;
    console.log('  sổ: nhà mượn =', l?.ten, '(id', l?.b, ') · số lô cùng khoá =', soLo);
    chot(l?.b != null, 'CA2 sổ ghi ĐÚNG nhà mượn');
    chot(soLo === 1, 'CA2 chỉ 1 lô, KHÔNG ghi 2 bên');
    if (tenMuon) chot((l?.ten ?? '') === tenMuon, `CA2 nhà mượn trong sổ khớp màn (${l?.ten} vs ${tenMuon})`);
  }
  await dongPopup(page);

  // ═════ CA 3: GÕ LẠI ĐÚNG BILL ĐÃ GHI ═════
  console.log('\n── CA 3: GÕ LẠI BILL TRÙNG ──');
  const soLoTrung = String(8100 + dau);
  const soHdTrung = String(770000 + dau);
  await moFormVaChon(page, mau);
  await page.getByLabel('Số hóa đơn').fill(soHdTrung);
  await page.getByLabel('Số lô').fill(soLoTrung);
  await page.getByLabel('Trước phí').fill(String(TONG));
  await page.getByLabel('Giờ', { exact: true }).fill('09');
  await page.getByLabel('Phút', { exact: true }).fill('15');
  await page.waitForTimeout(900);
  const canhBao = await page.evaluate(() => {
    const t2 = (document.querySelector('.fixed.inset-0') || {}).textContent || '';
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Ghi nhận bill'));
    return {
      trungHoanToan: /TRÙNG HOÀN TOÀN/.test(t2),
      trungSoLo: /TRÙNG SỐ LÔ/.test(t2),
      trungSoHD: /TRÙNG SỐ HÓA ĐƠN/.test(t2),
      nutBiChan: b ? b.disabled : null
    };
  });
  await page.screenshot({ path: resolve(RA, 'ca3-bill-trung.png') });
  console.log('  cảnh báo:', JSON.stringify(canhBao));
  chot(canhBao.trungHoanToan || canhBao.trungSoLo || canhBao.trungSoHD, 'CA3 có CẢNH BÁO trùng');
  chot(canhBao.nutBiChan === true, 'CA3 nút ghi BỊ CHẶN tới khi người dùng xác nhận');
  const soLoTruoc = (await db.query('SELECT COUNT(*)::int n FROM los WHERE status<>\'CANCELLED\'')).rows[0].n;
  const kq3 = await bamGhi(page);
  const soLoSau = (await db.query('SELECT COUNT(*)::int n FROM los WHERE status<>\'CANCELLED\'')).rows[0].n;
  console.log('  kết quả:', JSON.stringify(kq3), '· số lô trong sổ', soLoTruoc, '→', soLoSau);
  chot(soLoSau === soLoTruoc, 'CA3 gõ lại bill trùng KHÔNG tạo thêm lô (không nhân đôi doanh số)');
  if (kq3.maLo) chot(kq3.maLo === kq1.maLo, `CA3 trả về ĐÚNG lô cũ (${kq3.maLo} vs ${kq1.maLo})`);

  if (loi.length) {
    datHet = false;
    console.log('\n*** CÓ ' + loi.length + ' LỖI RUNTIME ***');
    loi.slice(0, 5).forEach((x) => console.log('   ', x));
  }
} catch (e) {
  console.error('[ca-kho] LỖI:', e?.message ?? e);
  datHet = false;
} finally {
  if (browser) await browser.close();
  if (phienId) {
    await db.query('DELETE FROM login_sessions WHERE id=$1', [phienId]);
    console.log('\n[ca-kho] đã XOÁ phiên tạm.');
  }
  await db.end();
  console.log('[ca-kho] ảnh ở:', RA);
  console.log('[ca-kho] KẾT LUẬN:', datHet ? 'không phép kiểm nào đỏ' : '*** CÒN PHÉP KIỂM ĐỎ ***');
  process.exitCode = datHet ? 0 : 1;
}
