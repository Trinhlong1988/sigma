// [19/11] ĐÂY LÀ CÔNG CỤ ĐO CHẠY TAY, KHÔNG phải cổng chạy tự động: nó đòi sẵn một bản EXE đang chạy kèm
// cổng gỡ lỗi 9444 (đo một lần hôm 16/11 cho bản 0.2.146). Đổi tiền tố `_kiem-` → `_do-` để bộ chạy trọn
// bộ cổng giao diện không đỏ vì lý do không liên quan. Muốn đo lại: mở EXE với --remote-debugging-port=9444.
// VERIFY §4(a) alpha-ship — nối CDP vào CHÍNH BẢN EXE VỪA ĐÓNG GÓI (file://app.asar), gọi API bằng fetch
// TRONG renderer. Đây là chỗ `curl` và Chromium trần bỏ sót: curl không có CSP của app, Chromium trần không
// có origin 'null' của file://. Chỉ ĐỌC — không đăng nhập, không ghi gì.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const CDP = process.env.CDP || 'http://127.0.0.1:9444';
const RA = resolve(import.meta.dirname, '../screenshots/exe-0.2.146');
mkdirSync(RA, { recursive: true });

let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 6;

const b = await chromium.connectOverCDP(CDP);
const p = b.contexts()[0]?.pages().find((x) => x.url().includes('index.html')) || b.contexts()[0]?.pages()[0];
if (!p) { console.log('[exe] ĐỎ không thấy cửa sổ nào qua CDP ' + CDP); process.exit(3); }
await p.waitForTimeout(2500);

const url = p.url();
chot(url.startsWith('file:') && url.includes('app.asar'), 'đang đo CHÍNH EXE đóng gói (url=' + url.slice(0, 70) + '…)');

// BẪY ĐO 16/11: chuỗi "Phiên bản v…" chỉ vẽ SAU khi đăng nhập (màn đăng nhập không có) ⇒ đọc DOM ở đây
// luôn ra null và sẽ kết luận OAN là app sai version. Chưa đăng nhập thì đọc version từ CHÍNH FILE exe.
const ban = await p.evaluate(() => document.body.innerText.match(/Phiên bản\s*v?([\d.]+)/)?.[1] ?? null);
let nguon = 'DOM (đã đăng nhập)';
let banThat = ban;
if (!banThat) {
  const exe = resolve(import.meta.dirname, '../dist/win-unpacked/SigMa.exe');
  banThat = execSync(`powershell -NoProfile -Command "(Get-Item '${exe}').VersionInfo.ProductVersion"`,
    { encoding: 'utf8' }).trim().split('.').slice(0, 3).join('.');
  nguon = 'thuộc tính file SigMa.exe (màn đăng nhập không in version)';
}
console.log('      phiên bản app:', banThat, '· nguồn:', nguon);
chot(banThat === '0.2.146', 'app đóng gói ĐÚNG phiên bản 0.2.146 (' + banThat + ')');

// Badge nguồn dữ liệu — chống cảnh app trỏ nhầm sổ (bài học feedback_desktop_data_source_badge…).
const badge = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
const troSoThat = /localhost:8790/.test(badge) && /sigma(?!_)/.test(badge);
console.log('      badge nguồn:', (badge.match(/Máy chủ:.{0,60}/) ?? ['(không thấy)'])[0]);
chot(troSoThat, 'app trỏ ĐÚNG sổ thật (localhost:8790 · sigma), không phải DB thử');

// Gọi API ngay trong renderer: đây mới là đường app thật đi (CSP connect-src + CORS origin 'null').
const base = await p.evaluate(() => window.__SIGMA_API_BASE__ ?? null).catch(() => null);
const API = process.env.API_THAT || 'http://127.0.0.1:8790';
console.log('      apiBase app khai:', base, '· gọi thử:', API);
const ket = await p.evaluate(async (u) => {
  try {
    const r = await fetch(u + '/v1/health', { credentials: 'include' });
    return { ma: r.status, chu: (await r.text()).slice(0, 120) };
  } catch (e) { return { ma: -1, chu: 'THREW: ' + String(e) }; }
}, API);
console.log('      kết quả fetch trong renderer:', JSON.stringify(ket));
chot(ket.ma === 200, 'renderer file:// gọi được API sổ thật (200) — CSP connect-src + CORS origin null OK');

// R198: chụp hỏng PHẢI thành finding nhìn thấy, cấm nuốt im. (Đo 16/11: app vừa đăng nhập xong đang nạp
// dữ liệu thì Playwright chờ "fonts loaded" rồi treo — không phải app hỏng, nhưng vẫn phải nói ra.)
let anhOk = false, anhLoi = '';
try {
  // Đo 16/11: `page.screenshot` của Playwright CHỜ `document.fonts.ready` — trong app Electron đang nạp dữ liệu
  // nó không bao giờ resolve ⇒ treo tới timeout. Chụp thẳng bằng CDP Page.captureScreenshot thì không chờ font.
  const cdp = await p.context().newCDPSession(p);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(RA, '01-exe-moi-mo.png'), Buffer.from(data, 'base64'));
  await cdp.detach().catch(() => {});
  anhOk = true;
} catch (e) { anhLoi = String(e).slice(0, 140).replace(/\s+/g, ' '); }
chot(anhOk, 'chụp được ảnh màn app đóng gói cho LEAD tự nhìn' + (anhOk ? '' : ' — LỖI: ' + anhLoi));

const loiTrang = await p.evaluate(() => window.__loiTrang ?? []).catch(() => []);
chot(Array.isArray(loiTrang), 'đọc được trạng thái trang (không kẹt)');

console.log('\n[exe] ẢNH: ' + RA);
console.log('[exe] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[exe] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[exe] KHÔNG phép kiểm nào đỏ');
await b.close();
if (loi.length) process.exitCode = 1;
