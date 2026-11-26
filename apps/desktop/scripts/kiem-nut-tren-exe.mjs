// ĐO NÚT TRÊN BẢN EXE ĐÃ ĐÓNG GÓI, NỐI SỔ THẬT (Admin Demo tự đăng nhập — 12/11).
//
// Vì sao cần bài này: bản web và bản EXE dùng CHUNG mã nguồn giao diện nhưng ĐÓNG GÓI RIÊNG
// (dist-web vs out/renderer trong app.asar). Web xanh KHÔNG chứng minh EXE xanh — đúng bài học
// "sửa web không tự tới EXE". Bài này nối CDP vào EXE đang chạy và đo trên CHÍNH nó.
//
// CHỈ ĐỌC: chỉ bấm chuyển mục menu + đọc kiểu dáng. KHÔNG bấm nút ghi/xóa nào.
// Chạy: EXE mở sẵn với --remote-debugging-port=9333, người dùng đã đăng nhập.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const CDP = process.env.CDP_EXE || 'http://127.0.0.1:9333';
const RA = resolve(import.meta.dirname, '../screenshots/exe-0.2.128');
mkdirSync(RA, { recursive: true });

// Bảng màu CHỐT — chép tay từ quyết định của Admin Demo, KHÔNG đọc từ CSS (oracle phải độc lập).
const MAU = {
  excel: { chu: 'rgb(29, 122, 60)', vien: 'rgb(166, 217, 182)', ten: 'Xuất Excel — xanh lá' },
  loc: { chu: 'rgb(29, 122, 60)', vien: 'rgb(166, 217, 182)', ten: 'Lọc — xanh lá' },
  lammoi: { chu: 'rgb(43, 108, 163)', vien: 'rgb(180, 214, 242)', ten: 'Làm mới — xanh biển nhạt' },
  xoaloc: { chu: 'rgb(163, 38, 38)', vien: 'rgb(240, 178, 178)', ten: 'Xóa lọc — đỏ nhạt' },
  them: { chu: 'rgb(255, 255, 255)', vien: 'rgb(23, 99, 165)', ten: 'Thêm — nền xanh SigMa chữ trắng' },
  themqr: { chu: 'rgb(255, 255, 255)', vien: 'rgb(23, 99, 165)', ten: 'Thêm mã QR — nền xanh SigMa' },
  xoabill: { chu: 'rgb(255, 255, 255)', vien: 'rgb(179, 31, 31)', ten: 'Xóa bill chọn — đỏ đậm' },
  nhap: { chu: 'rgb(15, 107, 115)', vien: 'rgb(154, 221, 226)', ten: 'Nhập Excel — xanh ngọc' },
  xem: { chu: 'rgb(65, 86, 110)', vien: 'rgb(205, 215, 227)', ten: 'Xem lịch sử — ghi xanh' },
  bieudo: { chu: 'rgb(15, 118, 110)', vien: 'rgb(143, 216, 205)', ten: 'Biểu đồ — xanh ngọc' },
  baocao: { chu: 'rgb(180, 83, 9)', vien: 'rgb(240, 196, 138)', ten: 'Báo cáo — cam đất' },
  chuky: { chu: 'rgb(91, 33, 182)', vien: 'rgb(196, 181, 253)', ten: 'Chọn chu kỳ — tím' }
};
const PHAI_GAN = [/^Xuất Excel/, /^Xuất CSV/, /^Xuất mẫu/, /^Làm mới/, /^Tải lại$/, /^Lọc$/, /^Xóa lọc/,
  /^Thêm /, /^Tạo /, /^Nhập /, /^Import /, /^Ghi nhận giao dịch/, /^Xem lịch sử/];
const MENU = ['Doanh Số', 'Trang chủ', 'Quản Lý Nhân Sự', 'Quản Lý Máy POS', 'Quản Lý TID',
  'Quản Lý Doanh Thu & Công Nợ', 'Quản Lý Hồ Sơ HKD', 'Quản Lý Tài Chính', 'Bill Giải Trình',
  'Quản Lý Ngân Hàng - Đối Tác', 'Quản lý dữ liệu yêu cầu duyệt hủy', 'Duyệt xuất kho',
  'Quản Lý Cấu Hình Hệ Thống'];

let soKiem = 0;
const loiDo = [];
const chot = (ok, ten) => { soKiem++; if (!ok) { loiDo.push(ten); console.log('  >>> ĐỎ — ' + ten); } };

const b = await chromium.connectOverCDP(CDP);
const ctx = b.contexts()[0];
const p = ctx.pages()[0];
const loiTrang = [];
p.on('pageerror', (e) => loiTrang.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') loiTrang.push('console.error: ' + m.text()); });
await p.waitForTimeout(1200);

// ĐÃ VÀO HAY CHƯA: KHÔNG chỉ dựa vào `aside` — màn Doanh Số chạy TOÀN MÀN HÌNH, menu bên trái bị gỡ hẳn
// khỏi DOM, nên "không thấy aside" từng bị hiểu nhầm là "chưa đăng nhập" (đo thật 12/11, bản EXE đang mở
// sẵn màn Doanh Số). Dấu hiệu đúng: có <main> hoặc có nút 3 gạch.
const nguon = await p.evaluate(() => {
  const t = document.body.innerText;
  return {
    daVao:
      !!document.querySelector('aside') ||
      !!document.querySelector('main') ||
      !!document.querySelector("[data-kiem='nut-menu']"),
    chu: t.replace(/\n+/g, ' | ').slice(0, 120)
  };
});
if (!nguon.daVao) {
  console.log('CHƯA ĐĂNG NHẬP — màn hiện tại:', nguon.chu);
  console.log('[exe] KHÔNG ĐO ĐƯỢC');
  process.exitCode = 3;
} else {
  let tongNut = 0;
  let soMan = 0;
  for (const ten of MENU) {
    const nutMenu = p.locator("[data-kiem='nut-menu']");
    if (await nutMenu.count()) {
      const hien = await p.locator('aside').first().isVisible().catch(() => false);
      if (!hien) { await nutMenu.first().click(); await p.waitForTimeout(600); }
    }
    let muc = p.locator('aside button', { hasText: ten }).first();
    if (!(await muc.count())) {
      // Menu vừa hiện lại sau khi bấm 3 gạch có thể chưa kịp dựng — chờ thêm rồi thử LẠI, đừng bỏ qua ngay.
      await p.waitForTimeout(1200);
      muc = p.locator('aside button', { hasText: ten }).first();
    }
    if (!(await muc.count())) {
      const boQua = (process.env.BO_QUA_MENU || '').split('|').map((x) => x.trim()).filter(Boolean);
      if (boQua.includes(ten)) {
        console.log('— BỎ QUA theo khai báo BO_QUA_MENU (tài khoản thiếu quyền): ' + ten);
      } else {
        // KHÔNG im lặng: không vào được màn = CHƯA KIỂM ĐƯỢC màn đó, phải đỏ (R198).
        chot(false, `KHÔNG VÀO ĐƯỢC màn "${ten}" — chưa kiểm được màn này`);
      }
      continue;
    }
    await muc.click();
    await p.waitForTimeout(2200);
    // CHỜ hiệu ứng mở màn chạy xong — `page-enter` scale 0.965→1, đo giữa chừng là ra số nhỏ hơn thật.
    await p.waitForFunction(() => {
      const el = document.querySelector('main') || document.body;
      const dang = (el.getAnimations ? el.getAnimations({ subtree: true }) : []).filter((a) => a.playState === 'running');
      return dang.length === 0;
    }, { timeout: 8000 }).catch(() => undefined);
    soMan++;

    const d = await p.evaluate(() => {
      const hien = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'; };
      const nut = [...document.querySelectorAll('main [data-nut]')].filter(hien).map((e) => {
        const c = getComputedStyle(e);
        return { ma: e.getAttribute('data-nut'), nhan: (e.textContent || '').trim().slice(0, 28),
                 chu: c.color, vien: c.borderTopColor, bo: c.borderTopLeftRadius, co: c.fontSize,
                 // Bề ngang BỐ CỤC, không phải rect — rect bị tỉ lệ của hiệu ứng mở màn làm méo.
                 rong: Math.round(parseFloat(c.width) + parseFloat(c.paddingLeft) + parseFloat(c.paddingRight)
                        + parseFloat(c.borderLeftWidth) + parseFloat(c.borderRightWidth)),
                 khoa: e.disabled === true,
                 tran: e.scrollWidth > e.clientWidth + 1 };
      });
      const sot = [...document.querySelectorAll('main button:not([data-nut])')]
        .filter((e) => !e.closest('[data-tab-bar]')).filter(hien)
        .map((e) => (e.textContent || '').trim()).filter(Boolean);
      return { nut, sot };
    });

    console.log('\n== ' + ten + ' — ' + d.nut.length + ' nút có dấu');
    tongNut += d.nut.length;
    for (const n of d.nut) {
      const m = MAU[n.ma];
      if (!m) continue;
      chot(n.bo === '3.4px', `${ten} · "${n.nhan}": bo góc ${n.bo} ≠ 3.4px`);
      chot(!n.tran, `${ten} · "${n.nhan}": CHỮ BỊ CẮT CỤT`);
      if (n.khoa) continue; // nút đang khoá có bảng màu mờ riêng
      chot(n.chu === m.chu, `${ten} · "${n.nhan}" (${n.ma}): màu CHỮ ${n.chu} ≠ chốt ${m.chu} — ${m.ten}`);
      chot(n.vien === m.vien, `${ten} · "${n.nhan}" (${n.ma}): màu VIỀN ${n.vien} ≠ chốt ${m.vien}`);
      chot(n.co === '11px', `${ten} · "${n.nhan}": cỡ chữ ${n.co} ≠ 11px`);
      chot(n.rong >= 119, `${ten} · "${n.nhan}": bề ngang ${n.rong}px < 119px`);
    }
    const sot = d.sot.filter((s) => PHAI_GAN.some((r) => r.test(s)));
    chot(sot.length === 0, `${ten} · còn ${sot.length} nút QUÊN gắn dấu: ${sot.join(' | ')}`);
    await p.screenshot({ path: resolve(RA, ten.replace(/[^A-Za-zÀ-ỹ0-9]+/g, '-').toLowerCase() + '.png'), timeout: 15000 })
      .catch((e) => chot(false, `${ten} · KHÔNG chụp được ảnh (${e.message.slice(0, 60)}) — chưa có bằng chứng mắt nhìn`));
  }
  chot(loiTrang.length === 0, 'LỖI RUNTIME: ' + loiTrang.slice(0, 4).join(' || '));
  console.log('\n[exe] số màn đã đi = ' + soMan + ' · số nút đo được (đếm động) = ' + tongNut);
  console.log('[exe] SỐ PHÉP KIỂM ĐÃ CHẠY (đếm động) = ' + soKiem);
  console.log('[exe] ảnh: ' + RA);
  if (loiDo.length) { console.log('[exe] KẾT LUẬN MÁY ĐO: ' + loiDo.length + ' phép kiểm ĐỎ'); process.exitCode = 1; }
  else console.log('[exe] KẾT LUẬN MÁY ĐO: không phép kiểm nào đỏ');
  if (soKiem < 30) { console.log('[exe] NGHI NGỜ: chạy quá ít phép kiểm'); process.exitCode = 3; }
}
await b.close();
