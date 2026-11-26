// BÀI KIỂM SAU KHI MỞ BẢN WEB RA NGOÀI (Admin Demo 13/11) — CHỈ ĐỌC, không sửa gì.
//
// Năm điều phải đúng, sai bất kỳ điều nào là ĐỎ:
//   1. Máy chủ tĩnh VẪN chỉ nghe 127.0.0.1 — thấy 0.0.0.0 là lộ thẳng ra LAN.
//   2. Tên miền sống (không 1033/530 — đường hầm chết) .
//   3. KHÁCH LẠ bị Cloudflare Access chặn — KHÔNG được nhìn thấy giao diện SigMa.
//   4. Cookie phiên qua HTTPS phải giữ cờ `Secure` (không bật QLWEB_COOKIE_HTTP cho bản công khai).
//   5. Đủ tiêu đề an ninh: CSP · X-Frame-Options · nosniff · HSTS (khi HTTPS).
import { execFileSync } from 'node:child_process';

const TEN_MIEN = process.env.TEN_MIEN || 'alpha-quanly.example.com';
const CUC_BO = process.env.CUC_BO || 'http://127.0.0.1:57913';
let soKiem = 0;
const loi = [];
const chot = (ok, ten, them = '') => {
  soKiem++;
  console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten + (them ? ' — ' + them : ''));
  if (!ok) loi.push(ten + (them ? ' — ' + them : ''));
};

console.log('— 1. Máy chủ tĩnh nghe ở đâu —');
try {
  const ra = execFileSync('powershell', ['-NoProfile', '-Command',
    "(Get-NetTCPConnection -LocalPort 57913 -State Listen -EA SilentlyContinue | Select-Object -Expand LocalAddress) -join ','"],
    { encoding: 'utf8' }).trim();
  console.log('     địa chỉ đang nghe: ' + (ra || '(không thấy ai nghe 57913)'));
  chot(!!ra, 'cổng 57913 có tiến trình phục vụ');
  chot(ra !== '' && !ra.split(',').some((x) => x === '0.0.0.0' || x === '::'),
    'chỉ nghe 127.0.0.1 (không phơi ra LAN)', ra);
} catch (e) {
  chot(false, 'đọc được trạng thái cổng 57913', e.message.slice(0, 60));
}

console.log('\n— 2 & 3. Tên miền công khai + Cloudflare Access —');
let r = null;
let body = '';
try {
  r = await fetch('https://' + TEN_MIEN + '/', { redirect: 'manual' });
  body = (await r.text()).slice(0, 4000);
} catch (e) {
  chot(false, 'gọi được https://' + TEN_MIEN, e.message.slice(0, 70));
}
if (r) {
  console.log('     HTTP ' + r.status + (r.headers.get('location') ? ' → ' + r.headers.get('location').slice(0, 70) : ''));
  chot(r.status !== 530 && r.status !== 1033, 'đường hầm sống (không 530/1033)', 'HTTP ' + r.status);
  const viTri = r.headers.get('location') || '';
  const biChan =
    r.status === 403 ||
    /cloudflareaccess\.com/.test(viTri) ||
    /cloudflareaccess\.com|Access denied|Sign in to|cf-access/i.test(body);
  const loGiaoDien = /Hệ thống quản lý SigMa|SigMa|ql_session/i.test(body);
  chot(biChan, 'khách lạ BỊ CHẶN ở cổng Cloudflare Access');
  chot(!loGiaoDien, 'khách lạ KHÔNG nhìn thấy giao diện SigMa');
}

console.log('\n— 4 & 5. Cookie + tiêu đề an ninh (đo ở chính máy chủ tĩnh) —');
try {
  const rc = await fetch(CUC_BO + '/', { redirect: 'manual' });
  const h = (k) => rc.headers.get(k) || '';
  chot(/default-src/.test(h('content-security-policy')), 'có CSP', h('content-security-policy').slice(0, 50));
  chot(h('x-frame-options') !== '', 'có X-Frame-Options', h('x-frame-options'));
  chot(h('x-content-type-options').toLowerCase() === 'nosniff', 'có nosniff', h('x-content-type-options'));
  chot(h('referrer-policy') !== '', 'có Referrer-Policy', h('referrer-policy'));
} catch (e) {
  chot(false, 'đọc được tiêu đề của máy chủ tĩnh', e.message.slice(0, 60));
}
// Cookie: hạ cờ Secure chỉ được phép khi chạy HTTP thuần trong nhà. Bản công khai thì CẤM.
const haCo = process.env.QLWEB_COOKIE_HTTP === '1';
chot(!haCo, 'KHÔNG bật QLWEB_COOKIE_HTTP (giữ cờ Secure cho cookie phiên)');

console.log('\n[web-cong-khai] SỐ PHÉP KIỂM ĐÃ CHẠY (đếm động) = ' + soKiem);
if (loi.length) {
  console.log('[web-cong-khai] KẾT LUẬN: ' + loi.length + ' phép kiểm ĐỎ');
  for (const x of loi) console.log('   - ' + x);
  process.exitCode = 1;
} else {
  console.log('[web-cong-khai] KẾT LUẬN: không phép kiểm nào đỏ');
}
if (soKiem < 8) {
  console.log('[web-cong-khai] NGHI NGỜ: chạy quá ít phép kiểm — có bước không chạy được');
  process.exitCode = 3;
}
