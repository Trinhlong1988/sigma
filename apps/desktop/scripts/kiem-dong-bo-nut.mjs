// ĐỒNG BỘ BUTTON TOÀN APP theo brand Doanh Số — CỔNG ĐO (Admin Demo 12/11).
//
// Lái giao diện THẬT trên BẢN SAO (cổng web 57914 → API 8795 → DB sigma_thu). Không chạm sổ thật.
// Đi QUA TỪNG MỤC MENU, mỗi màn:
//   1. Không có lỗi runtime (pageerror / console.error).
//   2. MỌI nút mang data-nut phải đúng BẢNG MÀU CHỐT (chữ + viền) — bảng nằm NGAY TRONG FILE NÀY, không
//      đọc từ CSS: đọc từ CSS thì CSS sai gì cổng cũng "đạt" theo (oracle phải độc lập).
//   3. Nút thanh công cụ phải rộng tối thiểu 119px, cỡ chữ 11px, bo góc 3,4px.
//   4. KHÔNG nút nào bị CẮT CỤT CHỮ (scrollWidth > clientWidth) — đây là bẫy của luật max-width cũ.
//   5. KHÔNG còn nút "Xuất Excel / Làm mới / Lọc / Xóa lọc / Thêm…" nào QUÊN gắn data-nut (sót = lệch brand).
// Đếm số phép kiểm ĐỘNG (R198) và chụp ảnh từng màn để LEAD tự nhìn (R200).
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const DIA_CHI = process.env.URL_THU || 'http://127.0.0.1:57914/';
const RA = resolve(import.meta.dirname, '../screenshots/dong-bo-nut');
mkdirSync(RA, { recursive: true });

// ── BẢNG MÀU CHỐT (oracle độc lập) ────────────────────────────────────────────────────────────────
const MAU = {
  excel: { chu: 'rgb(29, 122, 60)', vien: 'rgb(166, 217, 182)', ten: 'Xuất Excel — xanh lá' },
  loc: { chu: 'rgb(29, 122, 60)', vien: 'rgb(166, 217, 182)', ten: 'Lọc — xanh lá' },
  lammoi: { chu: 'rgb(43, 108, 163)', vien: 'rgb(180, 214, 242)', ten: 'Làm mới — xanh biển nhạt' },
  xoaloc: { chu: 'rgb(163, 38, 38)', vien: 'rgb(240, 178, 178)', ten: 'Xóa lọc — đỏ nhạt' },
  them: { chu: 'rgb(255, 255, 255)', vien: 'rgb(23, 99, 165)', ten: 'Thêm — nền xanh SigMa chữ trắng' },
  xoabill: { chu: 'rgb(255, 255, 255)', vien: 'rgb(179, 31, 31)', ten: 'Xóa bill chọn — đỏ đậm' },
  bieudo: { chu: 'rgb(15, 118, 110)', vien: 'rgb(143, 216, 205)', ten: 'Biểu đồ — xanh ngọc' },
  baocao: { chu: 'rgb(180, 83, 9)', vien: 'rgb(240, 196, 138)', ten: 'Báo cáo — cam đất' },
  chuky: { chu: 'rgb(91, 33, 182)', vien: 'rgb(196, 181, 253)', ten: 'Chọn chu kỳ — tím' },
  nhap: { chu: 'rgb(15, 107, 115)', vien: 'rgb(154, 221, 226)', ten: 'Nhập Excel — xanh ngọc' },
  xem: { chu: 'rgb(65, 86, 110)', vien: 'rgb(205, 215, 227)', ten: 'Xem lịch sử — ghi xanh' },
  themqr: { chu: 'rgb(255, 255, 255)', vien: 'rgb(23, 99, 165)', ten: 'Thêm mã QR — nền xanh SigMa' }
};
const TOOLBAR = new Set(['excel', 'loc', 'lammoi', 'xoaloc', 'them', 'xoabill', 'bieudo', 'baocao', 'chuky', 'nhap', 'xem', 'themqr']);
// Nhãn mà HỄ THẤY là phải có data-nut — dùng để bắt màn bị SÓT.
const PHAI_GAN = [/^Xuất Excel/, /^Xuất CSV/, /^Xuất mẫu/, /^Làm mới/, /^Tải lại$/, /^Lọc$/, /^Xóa lọc/, /^Thêm /, /^Tạo /,
  /^Nhập /, /^Import /, /^Ghi nhận giao dịch/, /^Xem lịch sử/];

const MENU = [
  'Doanh Số', 'Trang chủ', 'Quản Lý Nhân Sự', 'Quản Lý Máy POS', 'Quản Lý TID',
  'Quản Lý Doanh Thu & Công Nợ', 'Quản Lý Hồ Sơ HKD', 'Quản Lý Tài Chính', 'Bill Giải Trình',
  'Quản Lý Ngân Hàng - Đối Tác', 'Quản lý dữ liệu yêu cầu duyệt hủy', 'Duyệt xuất kho',
  'Quản Lý Cấu Hình Hệ Thống'
];

let soKiem = 0;
let datHet = true;
const loi = [];
const chot = (ok, ten) => {
  soKiem++;
  if (!ok) {
    datHet = false;
    loi.push(ten);
    console.log('  >>> ĐỎ — ' + ten);
  }
};

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
// Mặc định chạy trên BẢN SAO. Muốn chạy trên SỔ THẬT thì đặt DB_THU=sigma + URL_THU=…57913
// — phải khai TƯỜNG MINH cả hai, để không ai vô tình lái cổng đo vào sổ thật.
u.pathname = '/' + (process.env.DB_THU || 'sigma_thu');
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN_PHIEN = 'kiem-dong-bo-nut (' + (process.env.DB_THU || 'sigma_thu') + ')';
let phienTho = null;
let browser = null;

try {
  const nguoi = (
    await db.query(
      `SELECT u.id, u.username FROM users u WHERE u.deleted_at IS NULL AND u.status='ACTIVE'
       ORDER BY (u.username='adminroot') DESC, u.id LIMIT 1`
    )
  ).rows[0];
  phienTho = randomUUID();
  const bam = createHash('sha256').update(phienTho).digest('hex');
  // Phiên nay lưu BẢN BĂM trong DB (vá 12/11) — cookie giữ mã thô.
  await db.query(
    `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
     VALUES ($1,$2,now(),now()+interval '2 hours',now(),$3)`,
    [bam, nguoi.id, NHAN_PHIEN]
  );
  console.log('Phiên tạm cho:', nguoi.username);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addCookies([{ name: 'ql_session', value: phienTho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
  const page = await ctx.newPage();
  const loiTrang = [];
  page.on('pageerror', (e) => loiTrang.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') loiTrang.push('console.error: ' + m.text());
  });
  await page.goto(DIA_CHI, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  let tongNut = 0;
  for (const ten of MENU) {
    // Màn Doanh Số chạy full màn + ẩn menu → phải bấm nút 3 gạch để lấy lại menu.
    const nutMenu = page.locator("[data-kiem='nut-menu']");
    if (await nutMenu.count()) {
      const hienMenu = await page.locator('aside').first().isVisible().catch(() => false);
      if (!hienMenu) {
        await nutMenu.first().click();
        await page.waitForTimeout(500);
      }
    }
    const muc = page.locator('aside button', { hasText: ten }).first();
    if (!(await muc.count())) {
      console.log('— BỎ QUA (tài khoản không thấy menu): ' + ten);
      continue;
    }
    await muc.click();
    await page.waitForTimeout(1800);
    // CHỜ hiệu ứng mở màn chạy xong — `page-enter` scale 0.965→1, đo giữa chừng là ra số nhỏ hơn thật.
    await page.waitForFunction(() => {
      const el = document.querySelector('main') || document.body;
      const dang = (el.getAnimations ? el.getAnimations({ subtree: true }) : []).filter((a) => a.playState === 'running');
      return dang.length === 0;
    }, { timeout: 8000 }).catch(() => undefined);


    const d = await page.evaluate(() => {
      const hien = (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none';
      };
      const nut = [...document.querySelectorAll('main [data-nut]')].filter(hien).map((e) => {
        const c = getComputedStyle(e);
        return {
          ma: e.getAttribute('data-nut'),
          nhan: (e.textContent || '').trim().slice(0, 30),
          chu: c.color,
          vien: c.borderTopColor,
          bo: c.borderTopLeftRadius,
          co: c.fontSize,
          // Bề ngang BỐ CỤC — rect bị tỉ lệ hiệu ứng `page-enter` (scale 0.965→1) làm méo.
          rong: Math.round(parseFloat(c.width) + parseFloat(c.paddingLeft) + parseFloat(c.paddingRight)
                 + parseFloat(c.borderLeftWidth) + parseFloat(c.borderRightWidth)),
          khoa: e.disabled === true,
          tran: e.scrollWidth > e.clientWidth + 1
        };
      });
      // Nút TAB (dải [data-tab-bar]) không phải nút thanh công cụ — bỏ qua, nếu không "Tạo bill" bị
      // báo nhầm là quên gắn brand.
      const sot = [...document.querySelectorAll('main button:not([data-nut])')]
        .filter((e) => !e.closest('[data-tab-bar]'))
        .filter(hien)
        .map((e) => (e.textContent || '').trim())
        .filter(Boolean);
      return { nut, sot };
    });

    console.log('\n== ' + ten + ' — ' + d.nut.length + ' nút có data-nut');
    tongNut += d.nut.length;
    for (const n of d.nut) {
      const m = MAU[n.ma];
      if (!m) continue; // mã riêng của 1 màn (ghibill, xoaform, thunho…) — không nằm trong bộ thanh công cụ
      if (n.khoa) {
        // Nút ĐANG KHOÁ (vd "Xóa bill chọn" khi chưa tích dòng nào) có bảng màu MỜ riêng — so với bảng màu
        // nút bật là sai. Vẫn kiểm hình dáng + không cắt chữ.
        chot(n.bo === '3.4px', `${ten} · nút KHOÁ "${n.nhan}": bo góc ${n.bo} ≠ 3.4px`);
        chot(!n.tran, `${ten} · nút KHOÁ "${n.nhan}": CHỮ BỊ CẮT CỤT`);
        continue;
      }
      chot(n.chu === m.chu, `${ten} · nút "${n.nhan}" (${n.ma}): màu CHỮ ${n.chu} ≠ chốt ${m.chu} — ${m.ten}`);
      chot(n.vien === m.vien, `${ten} · nút "${n.nhan}" (${n.ma}): màu VIỀN ${n.vien} ≠ chốt ${m.vien}`);
      chot(n.bo === '3.4px', `${ten} · nút "${n.nhan}": bo góc ${n.bo} ≠ 3.4px`);
      chot(!n.tran, `${ten} · nút "${n.nhan}": CHỮ BỊ CẮT CỤT`);
      if (TOOLBAR.has(n.ma)) {
        chot(n.co === '11px', `${ten} · nút "${n.nhan}": cỡ chữ ${n.co} ≠ 11px`);
        chot(n.rong >= 119, `${ten} · nút "${n.nhan}": bề ngang ${n.rong}px < 119px`);
      }
    }
    const sot = d.sot.filter((s) => PHAI_GAN.some((r) => r.test(s)));
    chot(sot.length === 0, `${ten} · còn ${sot.length} nút QUÊN gắn data-nut: ${sot.join(' | ')}`);

    const file = ten.replace(/[^A-Za-zÀ-ỹ0-9]+/g, '-').toLowerCase();
    await page.screenshot({ path: resolve(RA, file + '.png'), fullPage: false });
  }

  chot(loiTrang.length === 0, 'LỖI RUNTIME: ' + loiTrang.slice(0, 5).join(' || '));
  console.log('\n[dong-bo-nut] tổng số nút data-nut đã đo (động) = ' + tongNut);
  console.log('[dong-bo-nut] SỐ PHÉP KIỂM ĐÃ CHẠY (đếm động) = ' + soKiem);
  console.log('[dong-bo-nut] ảnh: ' + RA);
  if (datHet) console.log('[dong-bo-nut] KẾT LUẬN MÁY ĐO: không phép kiểm nào đỏ');
  else {
    console.log('[dong-bo-nut] KẾT LUẬN MÁY ĐO: ' + loi.length + ' phép kiểm ĐỎ');
    process.exitCode = 1;
  }
  if (soKiem < 30) {
    console.log('[dong-bo-nut] NGHI NGỜ: chạy quá ít phép kiểm — có thể không vào được màn nào.');
    process.exitCode = 3;
  }
} catch (e) {
  console.error('[dong-bo-nut] CỔNG KHÔNG CHẠY ĐƯỢC:', e.message);
  process.exitCode = 3;
} finally {
  if (browser) await browser.close();
  if (phienTho) {
    const bam = createHash('sha256').update(phienTho).digest('hex');
    await db.query('DELETE FROM login_sessions WHERE id = ANY($1)', [[bam, phienTho]]);
  }
  const sot = await db.query('SELECT count(*)::int n FROM login_sessions WHERE device_info = $1', [NHAN_PHIEN]);
  if (sot.rows[0].n) {
    console.log('[dong-bo-nut] CÒN SÓT ' + sot.rows[0].n + ' phiên kiểm thử — phải dọn tay!');
    process.exitCode = 3;
  }
  await db.end();
}
