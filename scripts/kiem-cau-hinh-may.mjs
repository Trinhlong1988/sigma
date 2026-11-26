// KIỂM 1 MÁY ĐÃ SẴN SÀNG CHO CHẾ ĐỘ "CHỈ QUA INTERNET" CHƯA (Admin Demo 7/11: "không dùng LAN nữa").
//
// Chạy trên TỪNG máy desktop. In ra bảng trạng thái + KẾT LUẬN rõ ràng, exit ≠ 0 nếu máy chưa sẵn sàng —
// để bước "xác nhận đủ 8 máy" không phải hỏi miệng từng người.
//
// Kiểm 4 điều:
//   1. apiBaseUrl trỏ ĐÚNG tên miền (không còn IP LAN / localhost trên máy trạm).
//   2. Đã có thẻ dịch vụ Cloudflare Access (ID + secret).
//   3. Gọi được API qua tên miền đó (kèm thẻ nếu có) — tức mạng + thẻ đều ổn.
//   4. Nếu cổng đã bật gác: gọi KHÔNG thẻ phải bị chặn (chứng minh gác thật sự có tác dụng).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIEN_CHUAN = process.env.SIGMA_API_DOMAIN || 'https://alpha-quanly-api.example.com';
const DUONG =
  process.env.SIGMA_SERVER_CONFIG ||
  resolve(process.env.APPDATA || resolve(process.env.USERPROFILE || '.', 'AppData/Roaming'), 'AlphaQuanLy', 'server-config.json');

const che = (v) => (typeof v === 'string' && v ? v.slice(0, 4) + '…' + v.slice(-4) : '(chưa có)');

let cfg = {};
if (existsSync(DUONG)) {
  try {
    cfg = JSON.parse(readFileSync(DUONG, 'utf8'));
  } catch (e) {
    console.error('[kiem-may] File cấu hình HỎNG:', e.message);
    process.exit(1);
  }
}

const apiBase = (typeof cfg.apiBaseUrl === 'string' ? cfg.apiBaseUrl : '').trim().replace(/\/+$/, '');
const id = (typeof cfg.cfAccessClientId === 'string' ? cfg.cfAccessClientId : '').trim();
const coSecret = !!(cfg.cfAccessClientSecret || cfg.cfAccessClientSecret_enc);
// Secret THÔ mới gọi thử được; secret đã mã hoá chỉ app giải được (DPAPI theo tài khoản Windows).
const secretTho = typeof cfg.cfAccessClientSecret === 'string' ? cfg.cfAccessClientSecret.trim() : '';

const ketQua = [];
const them = (muc, dat, ghiChu) => ketQua.push({ muc, dat: dat ? 'ĐẠT' : 'CHƯA', ghiChu: ghiChu ?? '' });

// 1. địa chỉ API
const dungMien = apiBase === '' ? false : apiBase === MIEN_CHUAN.replace(/\/+$/, '');
them('apiBaseUrl trỏ đúng tên miền', dungMien, apiBase || '(chưa đặt → app dùng domain mặc định đã bake)');

// 2. thẻ
them('đã có thẻ Cloudflare Access', !!id && coSecret, `id=${che(id)} · secret=${coSecret ? 'có' : 'chưa'}`);

// 3 + 4: gọi thật
const diaChi = (dungMien ? apiBase : MIEN_CHUAN) + '/v1/health';
const goi = async (coThe) => {
  const h = { 'X-SigMa-Client': '1' };
  if (coThe && id && secretTho) {
    h['CF-Access-Client-Id'] = id;
    h['CF-Access-Client-Secret'] = secretTho;
  }
  try {
    const r = await fetch(diaChi, { headers: h, redirect: 'manual' });
    const loai = r.headers.get('content-type') ?? '';
    return { status: r.status, laJson: loai.includes('application/json') };
  } catch (e) {
    return { status: 0, laJson: false, loi: String(e.message).slice(0, 60) };
  }
};

const coThe = await goi(true);
them('gọi được API (kèm thẻ nếu có)', coThe.status === 200 && coThe.laJson, `HTTP ${coThe.status}${coThe.loi ? ' · ' + coThe.loi : ''}`);

const khongThe = await goi(false);
const dangGac = khongThe.status !== 200 || !khongThe.laJson;
them(
  'cổng đã bật gác (gọi KHÔNG thẻ bị chặn)',
  dangGac,
  dangGac ? `HTTP ${khongThe.status} — đúng như mong đợi khi đã gác` : 'HTTP 200 — cổng CHƯA gác, ai cũng gọi được'
);

console.log('[kiem-may] File cấu hình:', DUONG, existsSync(DUONG) ? '' : '(CHƯA CÓ)');
console.log('[kiem-may] Đích kiểm      :', diaChi);
console.table(ketQua);

// "Sẵn sàng" = 3 điều đầu. Điều 4 chỉ là THÔNG TIN về trạng thái cổng, không phải việc của máy trạm.
const sanSang = ketQua.slice(0, 3).every((x) => x.dat === 'ĐẠT');
if (!secretTho && coSecret) {
  console.log('[kiem-may] Ghi chú: secret đang ở dạng MÃ HOÁ nên script không gọi thử kèm thẻ được —');
  console.log('[kiem-may] hãy mở app và đăng nhập để xác nhận thật (app tự giải mã được).');
}
console.log('[kiem-may] KẾT LUẬN:', sanSang ? 'MÁY NÀY SẴN SÀNG' : '*** MÁY NÀY CHƯA SẴN SÀNG — xem dòng CHƯA ở trên ***');
process.exitCode = sanSang ? 0 : 1;
