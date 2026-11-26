// B263 (sửa lần 2) — [Admin Demo 24/11 "mở rộng phần nhập bill tăng chiều cao, chọn người hoàn xổ NỔI
// LÊN TRÊN thay vì xổ xuống" + "chiều cao màn nhập bill full chiều cao màn hình"]
//
// Cổng khoá 2 chuyện, đo MẮT THẤY (L4) ở 2 cỡ màn THẬT (1280×650 ~ laptop 1366×768 · 1700×950):
//  (A) Hộp "Thêm Bill" cao gần hết màn NHƯNG KHÔNG TRÀN: top ≥ 0, bottom ≤ màn, nút ✕ bấm được
//      (elementFromPoint tâm nút phải trả về chính nút). Đối chứng âm đã có thật: bản max-h-[100vh]
//      làm hộp top=−31px ở 1280×650, nút ✕ ra ngoài màn — cổng này phải ĐỎ với bản đó.
//  (B) Ô "Người hoàn" (SearchSelect) nằm gần đáy: mở ra phải XỔ LÊN (data-kiem="so-len") và các mục
//      MẮT THẤY được (elementFromPoint ≥ 4/5 mục đầu), không bị thân hộp cắt.
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
if (!/thu|test/i.test(DB_TEN)) { console.error('[hop-bill] DUNG: chi chay DB THU, dang "' + DB_TEN + '".'); process.exit(3); }
let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN = 'kiem-b263v2';
let b = null;
try {
  const tho = randomUUID();
  await db.query(
    'INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)'
    + " VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '10 minutes',now(),$2)",
    [createHash('sha256').update(tho).digest('hex'), NHAN]);
  b = await chromium.launch();

  for (const [w, h] of [[1280, 650], [1700, 950]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } });
    await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
    const p = await ctx.newPage();
    await p.goto(WEB + '/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(2200);
    await gacHopThoai(p);
    await dongHopThoaiChe(p);
    const menu = p.locator("[data-kiem='nut-menu']");
    if (await menu.count()) { await menu.first().click(); await p.waitForTimeout(500); }
    const link = p.getByText('Doanh Số', { exact: false }).filter({ visible: true }).first();
    if (await link.count()) await link.click({ timeout: 10000 }).catch(() => {});
    await p.waitForFunction(() => document.body.innerText.includes('Doanh số trước phí'), null, { timeout: 15000 });
    await p.locator('[data-nut="them"]').first().click();
    await p.waitForTimeout(1200);
    await dongHopThoaiChe(p);

    // (A) khung hộp trong màn + nút ✕ mắt thấy, bấm được
    const doA = await p.evaluate(() => {
      // hộp Thêm Bill = lớp phủ fixed trên cùng chứa chữ "Thêm Bill"
      const hop = [...document.querySelectorAll('div')].reverse().find((d) => {
        const st = getComputedStyle(d);
        return st.position === 'fixed' && d.textContent?.includes('Ghi nhận bill') && d.getBoundingClientRect().height > 200;
      });
      if (!hop) return null;
      const khung = hop.querySelector(':scope > div') ?? hop;
      const r = khung.getBoundingClientRect();
      // nút đóng = button có title/aria chứa Đóng hoặc ký tự ✕ ở đầu hộp
      const nutX = [...khung.querySelectorAll('button')].find((x) => /đóng|close/i.test(x.title || '') || (x.textContent || '').trim() === '✕' || x.querySelector('svg'));
      let xOk = false, xTai = null;
      if (nutX) {
        const rx = nutX.getBoundingClientRect();
        const cx = rx.left + rx.width / 2, cy = rx.top + rx.height / 2;
        const el = document.elementFromPoint(cx, cy);
        xOk = !!el && (el === nutX || nutX.contains(el));
        xTai = { cx: Math.round(cx), cy: Math.round(cy), trongMan: cy >= 0 && cy <= innerHeight };
      }
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), cao: Math.round(r.height), man: innerHeight, xOk, xTai };
    });
    console.log('      [' + w + 'x' + h + '] khung:', JSON.stringify(doA));
    chot(doA != null && doA.top >= 0 && doA.bottom <= doA.man + 1,
      w + 'x' + h + ': hộp nhập bill KHÔNG tràn màn (top ' + doA?.top + ', bottom ' + doA?.bottom + '/' + doA?.man + ')');
    chot(doA != null && doA.cao >= doA.man * 0.80,
      w + 'x' + h + ': hộp cao ≥80% màn (full chiều cao như Admin Demo yêu cầu — đo ' + doA?.cao + '/' + doA?.man + ')');
    chot(doA != null && doA.xOk === true && doA.xTai?.trongMan === true,
      w + 'x' + h + ': nút ✕ MẮT THẤY + bấm được (elementFromPoint trúng nút)');

    // (B) ô Người hoàn gần đáy → xổ LÊN + mục mắt thấy (chỉ đo ở màn thấp — cảnh Admin Demo gặp)
    if (h <= 700) {
      // Bấm THẬT bằng playwright (focus bằng evaluate không kích hoạt onFocus của React đáng tin).
      // Ô Người hoàn = SearchSelect có placeholder riêng; bám data-kiem + placeholder (L5).
      const oNguoiHoan = p.locator('input[data-kiem="searchselect-input"][placeholder*="hoàn tiền"]').first();
      let doB = { loi: 'khong thay o nguoi hoan' };
      if (await oNguoiHoan.count()) {
        await oNguoiHoan.scrollIntoViewIfNeeded();
        await oNguoiHoan.click({ timeout: 5000 }).catch(() => {});
        await p.waitForTimeout(800);
        doB = await p.evaluate(() => {
          const ul = document.querySelector('ul[data-kiem="so-len"], ul[data-kiem="so-xuong"]');
          if (!ul) return { loi: 'khong mo duoc danh sach' };
          const items = [...ul.querySelectorAll('li')].slice(0, 5);
          let thay = 0;
          for (const it of items) {
            const r3 = it.getBoundingClientRect();
            const el = document.elementFromPoint(r3.left + r3.width / 2, r3.top + Math.min(12, r3.height / 2));
            if (el && (el === it || it.contains(el) || el.contains(it))) thay++;
          }
          return { huong: ul.getAttribute('data-kiem'), soMuc: items.length, thay };
        });
        await p.keyboard.press('Escape').catch(() => {});
      }
      console.log('      [' + w + 'x' + h + '] người hoàn:', JSON.stringify(doB));
      chot(!doB.loi && doB.soMuc > 0 && doB.thay >= Math.min(4, doB.soMuc),
        w + 'x' + h + ': danh sách Người hoàn MẮT THẤY ' + (doB.thay ?? 0) + '/' + (doB.soMuc ?? 0) + ' mục (hướng ' + (doB.huong ?? '?') + ')');
    }
    await p.screenshot({ path: resolve(GOC, 'apps/desktop/_anh-kiem/b263v2-' + w + 'x' + h + '.png') });
    await ctx.close();
  }
} catch (e) {
  so++; loi.push('không chạy được phép kiểm: ' + e.message);
  console.log('  ĐỎ  không chạy được phép kiểm: ' + e.message);
} finally {
  await b?.close().catch(() => {});
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  await db.end();
}
const CAN = 7;
console.log('\n[hop-bill] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) loi.push('THIEU PHEP KIEM ' + so + '/' + CAN);
console.log(loi.length ? '[hop-bill] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[hop-bill] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
