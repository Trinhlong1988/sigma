// GHIM TIÊU ĐỀ CỘT — ĐO TRÊN CHÍNH BẢN EXE ĐANG CHẠY (nối CDP), không phải bản web.
// Lý do có file này: cổng `kiem-ghim-tieu-de.mjs` TỰ mở chromium vào http://127.0.0.1:57914 (bản web);
// đặt biến CDP_EXE cho nó KHÔNG có tác dụng — 13/11 đã tưởng nhầm là đang đo EXE. Cổng này nối thẳng
// vào cửa sổ SigMa.exe đang mở (đã đăng nhập thật) ⇒ đo ở ĐÚNG điều kiện thật (R200).
// Chỉ ĐỌC + lăn chuột + chụp ảnh. KHÔNG sửa dữ liệu, KHÔNG đóng app của Admin Demo.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { doMotMan, chupAnh } from './_do-ghim-tieu-de.mjs';

const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const RA = resolve(import.meta.dirname, '../screenshots/ghim-tieu-de-exe');
mkdirSync(RA, { recursive: true });
const MENU = (process.env.MAN || [
  'Doanh Số', 'Quản Lý Nhân Sự', 'Quản Lý Máy POS', 'Quản Lý TID',
  'Quản Lý Doanh Thu & Công Nợ', 'Quản Lý Hồ Sơ HKD', 'Quản Lý Tài Chính',
  'Quản Lý Ngân Hàng - Đối Tác', 'Quản lý dữ liệu yêu cầu duyệt hủy',
  'Duyệt xuất kho', 'Quản Lý Cấu Hình Hệ Thống'
].join('|')).split('|');

let soKiem = 0; const loi = [];
const chot = (ok, ten) => { soKiem++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };

const b = await chromium.connectOverCDP(CDP);
const p = b.contexts()[0]?.pages().find((x) => x.url().includes('index.html')) || b.contexts()[0]?.pages()[0];
if (!p) { console.log('[ghim-exe] ĐỎ không thấy cửa sổ nào qua CDP ' + CDP); process.exit(3); }

const url = p.url();
chot(url.startsWith('file:') && url.includes('app.asar'), 'đang đo CHÍNH EXE (url = ' + url.slice(0, 80) + '…)');
const vp = await p.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
console.log('[ghim-exe] khung nhìn THẬT của cửa sổ: ' + vp.w + '×' + vp.h + ' px (dpr ' + vp.dpr.toFixed(2) + ')');

const daVao = await p.evaluate(() => !!document.querySelector('aside button, [data-kiem="nut-menu"]'));
if (!daVao) { console.log('[ghim-exe] DỪNG: app chưa đăng nhập, không đo được. KHÔNG kết luận.'); process.exit(3); }

const loiTrang = [];
p.on('pageerror', (e) => loiTrang.push('pageerror: ' + e.message));

const bang = [];
for (const ten of MENU) {
  const nm = p.locator("[data-kiem='nut-menu']");
  if (await nm.count()) {
    const v = await p.locator('aside').first().isVisible().catch(() => false);
    if (!v) { await nm.first().click(); await p.waitForTimeout(700); }
  }
  const m = p.locator('aside button', { hasText: ten }).first();
  if (!(await m.count())) { chot(false, 'KHÔNG vào được màn "' + ten + '"'); continue; }
  await m.click(); await p.waitForTimeout(3500);
  console.log('\n== ' + ten);
  bang.push(...(await doMotMan(p, ten, chot)));
  await chupAnh(p, resolve(RA, ten.replace(/[^A-Za-zÀ-ỹ0-9]+/g, '-').toLowerCase() + '.png'), ten, chot);
}
chot(loiTrang.length === 0, 'không lỗi runtime: ' + loiTrang.slice(0, 2).join(' | '));
console.log('\n[ghim-exe] BẢNG ĐO (EXE thật ' + vp.w + '×' + vp.h + '):');
for (const r of bang) console.log('   ' + r.ten.padEnd(34) + ' lăn ' + String(r.cuon).padStart(6) + '/' + String(r.tran).padEnd(6) + 'px · tiêu đề cách mép ' + r.top + 'px');
console.log('[ghim-exe] SỐ PHÉP KIỂM (đếm động) = ' + soKiem);
console.log('[ghim-exe] ảnh: ' + RA);
console.log(loi.length ? '[ghim-exe] KẾT LUẬN: ' + loi.length + ' ĐỎ' : '[ghim-exe] KẾT LUẬN: không phép kiểm nào đỏ');
// KHÔNG gọi b.close() — tránh đụng vào cửa sổ Admin Demo đang mở.
process.exit(loi.length ? 1 : 0);
