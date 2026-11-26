// B252/B253 — [Admin Demo 22/11 "KO THẤY DANH SÁCH MÀY KHÔNG KIỂM CHỨNG À?"] KIỂM TRÊN CHÍNH BẢN EXE.
//
// Mọi cổng trước đây chạy trên BẢN WEB. Bản EXE (Electron) đi đường preload → httpCall, renderer nạp
// từ file:// — khác hẳn về CSP/cookie/quyền, nên "web xanh" KHÔNG chứng minh EXE chạy được.
// Cổng này mở ĐÚNG gói đã đóng (dist/win-unpacked), hồ sơ RIÊNG (không đụng phiên của Admin Demo),
// trỏ sang MÁY CHỦ THỬ, ĐĂNG NHẬP THẬT bằng tài khoản tạm, rồi:
//   (1) vào được màn Quản Lý TID;
//   (2) ô lọc NĐT xổ ra ĐỦ tên nhà đầu tư của sổ thử (không rỗng);
//   (3) nút lọc đủ RỘNG để không cắt tên dài (Admin Demo: "dãn rộng ô lọc ra") — đo px thật;
//   (4) chọn 1 NĐT thì bảng lọc THẬT.
// Tài khoản tạm được tạo trong DB THỬ và XOÁ ở cuối, dù chạy lỗi.
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const EXE = resolve(import.meta.dirname, '../dist/win-unpacked/SigMa.exe');
const API_THU = process.env.API_THU || 'http://127.0.0.1:8795';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
const CONG_GO = 9777;
const MAT_KHAU = 'KiemTra@2026';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[exe-ndt] DUNG: chi chay tren DB THU, dang tro "' + DB_TEN + '".');
  process.exit(3);
}
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 7;

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

const TEN_DN = 'kiemtra_' + randomUUID().slice(0, 6);
let b = null;
let con = null;
let hoSo = null;
try {
  if (!existsSync(EXE)) throw new Error('chưa có gói đã đóng: ' + EXE + ' (chạy `npm run dist` trước)');

  // Tài khoản tạm: mượn ĐÚNG bộ vai trò của adminroot để quyền giống người dùng thật.
  const bam = bcrypt.hashSync(MAT_KHAU, 10);
  const { rows: tao } = await db.query(
    `INSERT INTO users (username, password_hash, full_name, status, created_at, updated_at)
     VALUES ($1, $2, 'Tài khoản kiểm thử', 'ACTIVE', now(), now()) RETURNING id`, [TEN_DN, bam]);
  const uid = tao[0].id;
  await db.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, ur.role_id FROM user_roles ur JOIN users x ON x.id = ur.user_id WHERE x.username = 'adminroot'`,
    [uid]);
  const { rows: qn } = await db.query(
    `SELECT count(*)::int n FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = $1`,
    [uid]);
  console.log('      tài khoản tạm', TEN_DN, '·', qn[0].n, 'quyền (mượn vai trò của adminroot)');

  // Cấu hình máy chủ nằm ở `app.getPath('appData')/<thư mục bản>/server-config.json`.
  // `appData` trên Windows do Chromium quyết, KHÔNG theo biến APPDATA (thử rồi: app vẫn đọc cấu hình
  // thật, màn đăng nhập ghi "localhost:8790 · sigma"). Cách ĐÚNG: biến `SIGMA_INSTANCE_DIR` — nó
  // đổi TÊN THƯ MỤC bản, nên mình ghi cấu hình thử vào thư mục riêng, không đụng cấu hình thật.
  hoSo = mkdtempSync(join(tmpdir(), 'alpha-kiem-'));
  const THU_MUC_BAN = 'AlphaKiemThu';
  const thuMucCauHinh = join(process.env.APPDATA ?? hoSo, THU_MUC_BAN);
  mkdirSync(thuMucCauHinh, { recursive: true });
  const cauHinh = { host: '127.0.0.1', port: 5432, database: DB_TEN, user: 'postgres', password: 'x', apiBaseUrl: API_THU };
  writeFileSync(join(thuMucCauHinh, 'server-config.json'), JSON.stringify(cauHinh, null, 2), 'utf8');

  // App đọc cấu hình máy chủ ở `app.getPath('appData')/AlphaQuanLy/server-config.json` — `appData`
  // KHÔNG đổi theo `--user-data-dir` mà theo biến môi trường APPDATA. Không đặt APPDATA là app vẫn
  // đọc cấu hình THẬT (trỏ sổ thật) ⇒ đăng nhập bằng tài khoản của sổ THỬ sẽ 401 (đã cắn 19h30 22/11).
  con = spawn(EXE, ['--remote-debugging-port=' + CONG_GO, '--user-data-dir=' + hoSo], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, SIGMA_INSTANCE_DIR: THU_MUC_BAN }
  });
  await new Promise((r) => setTimeout(r, 14000));
  b = await chromium.connectOverCDP('http://127.0.0.1:' + CONG_GO);
  const ctx = b.contexts()[0];
  const p = ctx.pages().filter((x) => !x.url().startsWith('devtools://'))[0];
  if (!p) throw new Error('không thấy cửa sổ app');
  p.on('console', (m) => { if (m.type() === 'error') console.log('      [console]', m.text().slice(0, 160)); });

  // ĐĂNG NHẬP THẬT qua form.
  await p.waitForTimeout(2000);
  const chuMan = (await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 220)));
  console.log('      màn đăng nhập:', chuMan);
  const oTen = p.locator('input[name="username"], input[autocomplete="username"]').first();
  const oMk = p.locator('input[type="password"]').first();
  if (!(await oTen.count()) || !(await oMk.count())) throw new Error('không thấy ô đăng nhập');
  await oTen.fill(TEN_DN);
  await oMk.fill(MAT_KHAU);
  await p.getByRole('button', { name: /Đăng nhập/i }).first().click();
  await p.waitForTimeout(7000);
  // Bản EXE cũng bật hộp "Bộ nhớ sắp đầy" sau khi vào — lớp phủ nuốt mọi cú bấm (đo 23/11: cổng này
  // đỏ ở lượt chạy chung dù chạy riêng thì xanh). Cài người gác + dẹp hộp đang mở.
  await gacHopThoai(p);
  await dongHopThoaiChe(p);
  const daVao = await p.evaluate(() => !document.querySelector('input[type="password"]'));
  chot(daVao, 'ĐĂNG NHẬP được vào bản EXE (đường của người dùng, không phải web)');
  if (!daVao) throw new Error('đăng nhập không vào được');

  const menu = p.locator("[data-kiem='nut-menu']");
  if (await menu.count()) { await menu.first().click(); await p.waitForTimeout(800); }
  const link = p.getByText('Quản Lý TID', { exact: false }).first();
  if (await link.count()) { await link.click(); await p.waitForTimeout(6000); }
  const demDong = () => p.evaluate(() => {
    const tb = document.querySelector('table');
    if (!tb) return 0;
    const th = tb.querySelectorAll('thead th').length;
    return [...tb.querySelectorAll('tbody tr')].filter((r) => r.querySelectorAll('td').length >= th - 1).length;
  });
  const truoc = await demDong();
  chot(truoc > 0, 'vào được màn Quản Lý TID, bảng có ' + truoc + ' dòng');

  // Ô lọc NĐT trên EXE.
  const oNdt = p.locator('[data-loc="ndt"]');
  const rongNut = await p.evaluate(() => {
    const el = document.querySelector('[data-loc="ndt"] button');
    return el ? Math.round(el.getBoundingClientRect().width) : 0;
  });
  // Bấm rồi CHỜ hộp xổ xuất hiện thật; chạy trong lô (máy bận) có lần cú bấm đầu chưa ăn ⇒ bấm lại
  // 1 lần rồi mới kết luận. KHÔNG ngủ cứng mà đoán.
  await oNdt.locator('button').first().click();
  let moHop = await p.locator('[data-loc-hop="ndt"]').count().then((n) => n > 0).catch(() => false);
  if (!moHop) {
    await p.waitForTimeout(1200);
    await oNdt.locator('button').first().click({ force: true });
  }
  try { await p.waitForSelector('[data-loc-hop="ndt"]', { timeout: 8000 }); moHop = true; } catch { moHop = false; }
  console.log('      hộp xổ mở được:', moHop);
  await p.waitForTimeout(600);
  // [B254 22/11] ĐỌC DOM LÀ CHƯA ĐỦ — hộp xổ từng nằm trong khung cuộn nên BỊ CẮT: DOM có đủ mục mà
  // mắt không thấy gì (ảnh Admin Demo). Nay mỗi mục phải: (a) có trong DOM, (b) nằm TRONG màn hình,
  // (c) CHÍNH NÓ nhận được cú bấm tại tâm (elementFromPoint) — tức thực sự hiện ra, không bị che/cắt.
  const docMucThay = () => p.evaluate(() => {
    const pn = document.querySelector('[data-loc-hop="ndt"]') || document.querySelector('[data-loc="ndt"] div[class*="absolute"]');
    if (!pn) return { dom: [], thay: [], hop: null };
    const nut = [...pn.querySelectorAll('button')].filter((x) => !/Chọn tất cả|Bỏ chọn/.test(x.textContent || ''));
    const dom = nut.map((x) => (x.textContent || '').trim()).filter(Boolean);
    const thay = [];
    for (const x of nut) {
      const r = x.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) continue;
      const diem = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      if (diem && (diem === x || x.contains(diem))) thay.push((x.textContent || '').trim());
    }
    const rh = pn.getBoundingClientRect();
    return { dom, thay, hop: { top: Math.round(rh.top), bottom: Math.round(rh.bottom), cao: Math.round(rh.height) } };
  });
  const xem = await docMucThay();
  const muc = xem.dom;
  console.log('      hộp xổ:', JSON.stringify(xem.hop), '· trong DOM', xem.dom.length, 'mục · MẮT THẤY', xem.thay.length, 'mục');
  const ndtSo = (await db.query(
    "SELECT COALESCE(NULLIF(TRIM(nickname), ''), full_name) AS ten FROM investors WHERE deleted_at IS NULL"
  )).rows.map((x) => String(x.ten || '').trim()).filter(Boolean);
  console.log('      EXE · mục MẮT THẤY:', xem.thay.join(' · ').slice(0, 160));
  console.log('      sổ thử có', ndtSo.length, 'nhà đầu tư:', ndtSo.join(' · '));
  chot(ndtSo.every((x) => muc.some((m) => m.includes(x))) && muc.length >= ndtSo.length + 1,
    'TRÊN BẢN EXE: ô lọc NĐT có ĐỦ ' + ndtSo.length + ' nhà đầu tư + mục "(máy không thuộc NĐT)" trong DOM');
  // Phép kiểm QUAN TRỌNG NHẤT: mắt có thấy không.
  chot(ndtSo.every((x) => xem.thay.some((m) => m.includes(x))) && xem.thay.length === xem.dom.length,
    'TRÊN BẢN EXE: ' + xem.thay.length + '/' + xem.dom.length
      + ' mục THỰC SỰ HIỆN RA (không bị khung cuộn cắt) — đúng chỗ Admin Demo báo "không thấy danh sách"');
  // Ảnh chụp LÚC HỘP ĐANG XỔ và CHƯA chọn gì — đúng cảnh Admin Demo gửi (lúc đó trống trơn).
  mkdirSync(resolve(GOC, '_anh-kiem'), { recursive: true });
  await p.screenshot({ path: resolve(GOC, '_anh-kiem', 'b252-exe-hop-xo.png') });
  console.log('      bề ngang nút lọc NĐT =', rongNut, 'px');
  chot(rongNut >= 170, 'nút lọc NĐT đã DÃN RỘNG (' + rongNut + 'px ≥ 170px — tên dài không bị cắt)');

  // Chọn 1 NĐT có máy trong sổ thử → bảng phải lọc thật.
  const coMay = (await db.query(
    `SELECT COALESCE(NULLIF(TRIM(iv.nickname), ''), iv.full_name) AS ten, count(*)::int n
       FROM tids t JOIN receive_accounts ra ON ra.id = t.receive_account_id AND ra.deleted_at IS NULL
       JOIN investors iv ON iv.id = ra.investor_id
      WHERE t.deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1`)).rows[0];
  // Hộp xổ nay nằm ở <body> (portal) — tìm theo `data-loc-hop`, vẫn đỡ cả bản cũ để cổng không giòn.
  await p.evaluate((ten) => {
    const pn = document.querySelector('[data-loc-hop="ndt"]') || document.querySelector('[data-loc="ndt"] div[class*="absolute"]');
    [...(pn?.querySelectorAll('button') ?? [])].find((x) => (x.textContent || '').trim() === ten)?.click();
  }, coMay.ten);
  await p.waitForTimeout(1500);
  const sau = await demDong();
  console.log('      chọn "' + coMay.ten + '" → bảng còn', sau, 'dòng · sổ đếm', coMay.n);
  chot(sau === coMay.n, 'TRÊN BẢN EXE: lọc ra ĐÚNG số máy của NĐT đó (' + sau + '/' + coMay.n + ')');

  // [B255 22/11 — Admin Demo "% cài máy, sau phí cài máy đưa sang bên phải sau phí bán ... excell phải
  // đồng nhất"] Khoá THỨ TỰ CỘT ngay trên bản EXE (màn Doanh Số), không chỉ trên web.
  // KHÔNG bấm lại nút menu ở đây: nút đó là TOGGLE, bấm lần 2 là ĐÓNG thanh bên ⇒ cú bấm "Doanh Số"
  // rơi vào khoảng không và màn vẫn là Quản Lý TID (đã cắn 2 lần).
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
  // KHỚP CHÍNH XÁC "Doanh Số": ở màn TID có tab "Xếp hạng doanh số" — khớp lỏng là bấm nhầm sang tab
  // đó rồi đọc cột của bảng xếp hạng (đã cắn: thấy "Hạng · Chuỗi TID · …" thay vì cột bill).
  const linkDs = p.getByText('Doanh Số', { exact: true }).first();
  if (await linkDs.count()) { await linkDs.click(); }
  // CHỜ ĐÚNG MÀN: màn Doanh Số có ô KPI "Doanh số trước phí". Không chờ bằng ngủ cứng rồi đoán.
  try {
    await p.waitForFunction(() => document.body.innerText.includes('Doanh số trước phí'), null, { timeout: 15000 });
  } catch { /* để phép kiểm dưới báo đỏ kèm danh sách cột đọc được */ }
  await p.waitForTimeout(3000);
  const cotMan = await p.evaluate(() => {
    const tb = document.querySelector('table');
    return tb ? [...tb.querySelectorAll('thead th')].map((x) => (x.textContent || '').trim()).filter(Boolean) : [];
  });
  // [B266 25/11 — Admin Demo đảo cột] Cặp phí CÀI MÁY (% CM · Sau phí CM) nay đứng NGAY SAU "Trước phí".
  const iTruoc = cotMan.indexOf('Trước phí');
  if (iTruoc < 0) console.log('      (chưa vào đúng màn Doanh Số — không thấy cột "Trước phí")');
  console.log('      EXE · cột màn Doanh Số:', cotMan.join(' · ').slice(0, 200));
  chot(iTruoc >= 0 && cotMan[iTruoc + 1] === '% CM' && cotMan[iTruoc + 2] === 'Sau phí CM',
    'TRÊN BẢN EXE: "% CM" và "Sau phí CM" đứng NGAY SAU "Trước phí"');
  await p.screenshot({ path: resolve(GOC, '_anh-kiem', 'b255-exe-cot-doanhso.png') });

  const anh = resolve(GOC, '_anh-kiem', 'b252-exe-loc-ndt.png');
  mkdirSync(resolve(GOC, '_anh-kiem'), { recursive: true });
  await p.screenshot({ path: anh });
  console.log('      ảnh bản EXE: _anh-kiem/b252-exe-loc-ndt.png');
} catch (e) {
  console.log('  ĐỎ  không chạy được phép kiểm: ' + e.message);
  so++; loi.push('không chạy được phép kiểm: ' + e.message);
} finally {
  await b?.close().catch(() => {});
  try { if (con?.pid) process.kill(-con.pid); } catch { try { con?.kill(); } catch { /* */ } }
  await new Promise((r) => setTimeout(r, 1500));
  await db.query('DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE username = $1)', [TEN_DN]);
  await db.query('DELETE FROM login_sessions WHERE user_id IN (SELECT id FROM users WHERE username = $1)', [TEN_DN]);
  await db.query('DELETE FROM users WHERE username = $1', [TEN_DN]);
  const { rows: con2 } = await db.query('SELECT count(*)::int n FROM users WHERE username = $1', [TEN_DN]);
  console.log('      dọn tài khoản tạm:', con2[0].n === 0 ? 'sạch' : 'CÒN SÓT!');
  if (con2[0].n !== 0) { loi.push('không dọn được tài khoản tạm'); so++; }
  await db.end();
  if (hoSo) { try { rmSync(hoSo, { recursive: true, force: true }); } catch { /* app còn giữ file — bỏ qua */ } }
  // Dọn thư mục cấu hình THỬ (không đụng thư mục thật AlphaQuanLy).
  try { rmSync(join(process.env.APPDATA ?? '', 'AlphaKiemThu'), { recursive: true, force: true }); } catch { /* */ }
}
console.log('\n[exe-ndt] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[exe-ndt] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[exe-ndt] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
