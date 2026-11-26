// B215 — [Admin Demo 20/11 "chưa lên feed"] NÚT KIỂM TRA CẬP NHẬT + rút chu kỳ hỏi feed.
//
// Ca thật: feed công khai đã có 0.2.160 (đo: HTTP 200, header no-cache, không bị CDN giữ bản cũ) nhưng app
// Admin Demo đang mở vẫn ở 0.2.159 nên không thấy gì — vì app CHỈ hỏi feed lúc khởi động rồi mỗi 60 phút.
// Admin Demo tưởng bản chưa được đẩy lên. Không phải lỗi phát hành, mà là app không có cách hỏi NGAY.
//
// Cổng khoá 5 điều:
//   (1) chu kỳ hỏi feed ≤ 10 phút (không để 60 phút như cũ);
//   (2) có nút bấm tay, gắn trình xử lý THẬT (không phải nút giả);
//   (3) nút CHỈ hiện ở bản desktop (bản web không có bộ cập nhật — hiện ra là bấm vào chỗ chắc chắn vô ích);
//   (4) PHẢI báo kết quả cả khi KHÔNG có bản mới — im lặng thì người dùng lại tưởng hỏng;
//   (5) ĐỐI CHỨNG trên bản web đang chạy: nút KHÔNG xuất hiện.
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const WEB = process.env.WEB_THU || 'http://127.0.0.1:57915';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[nut-capnhat] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 9;

// ── (1) Chu kỳ hỏi feed ──
const dv = readFileSync(resolve(GOC, 'apps/desktop/src/main/update-service.ts'), 'utf8');
const m = /intervalMs\s*=\s*deps\.intervalMs\s*\?\?\s*(\d+)\s*\*\s*60\s*\*\s*1000/.exec(dv);
const phut = m ? Number(m[1]) : null;
console.log('      chu kỳ hỏi feed:', phut, 'phút');
chot(phut !== null && phut <= 10, 'app hỏi feed ít nhất mỗi 10 phút (' + phut + ' phút) — 60 phút là quá lâu');

// ── (2)(3)(4) Nút ở thanh bên ──
const db2 = readFileSync(resolve(GOC, 'apps/desktop/src/renderer/src/pages/Dashboard.tsx'), 'utf8');
chot(/data-nut="kiemcapnhat"/.test(db2) && /onClick=\{\(\) => void kiemCapNhat\(\)\}/.test(db2),
  'có nút "Kiểm tra cập nhật" gắn trình xử lý THẬT (không phải nút giả)');
chot(/\{coDesktop && \(/.test(db2) && db2.indexOf('coDesktop && (') < db2.indexOf('data-nut="kiemcapnhat"'),
  'nút CHỈ hiện ở bản desktop (bản web không có bộ cập nhật)');
chot(/Đang dùng bản mới nhất/.test(db2),
  'KHÔNG im lặng: không có bản mới cũng phải báo "đang dùng bản mới nhất"');
chot(/Có bản mới v/.test(db2) && /Không hỏi được máy chủ cập nhật/.test(db2),
  'báo đủ cả 3 trường hợp: có bản mới · đang mới nhất · hỏi không được');

// ── [B226 21/11 — Admin Demo "bấm cập nhật không tải được"] CẤM ĐOÁN "ĐANG DÙNG BẢN MỚI NHẤT" ──
// Ca thật: hàm hỏi máy chủ NUỐT LỖI rồi trả void; màn hình ngủ cứng 2,5 giây rồi đọc bộ nhớ sự kiện.
// Mạng chậm hơn 2,5 giây hoặc máy chủ lỗi ⇒ bộ nhớ rỗng ⇒ app báo "Đang dùng bản mới nhất" DÙ CHƯA
// HỎI ĐƯỢC. Người dùng bấm mãi không thấy gì, tưởng app hỏng. Đây đúng lớp lỗi R198 (nuốt lỗi → pass giả).
chot(!/setTimeout\(r, 2500\)/.test(db2),
  'màn hình KHÔNG còn ngủ cứng 2,5 giây rồi đoán kết quả');
chot(/kq\.ok === false/.test(db2) && /window\.api\.checkUpdate\(\)/.test(db2),
  'màn hình DÙNG kết quả thật của lần hỏi (ok/không ok), không đọc bộ nhớ sự kiện rồi suy');
const us = readFileSync(resolve(GOC, 'apps/desktop/src/main/update-service.ts'), 'utf8');
const nuot = /const check = async \(\): Promise<void> => \{[\s\S]{0,200}?catch \{/.test(us);
chot(!nuot && /Promise<KetQuaHoiCapNhat>/.test(us),
  'hàm hỏi máy chủ TRẢ KẾT QUẢ (ok · version · lý do), KHÔNG nuốt lỗi rồi trả rỗng');

// ── (5) ĐỐI CHỨNG trên bản web đang chạy: nút phải VẮNG ──
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const tho = randomUUID();
const NHAN = 'kiem-b215';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '10 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);
const b = await chromium.launch();
try {
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
  const p = await ctx.newPage();
  await p.goto(WEB + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(3000);
  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
  // Thanh bên MẶC ĐỊNH THU GỌN — không mở ra thì dòng phiên bản chưa dựng, phép kiểm sẽ đỏ oan (đã cắn).
  const nutMenu = p.locator("[data-kiem='nut-menu']");
  if (await nutMenu.count()) {
    const hien = await p.locator('aside').first().isVisible().catch(() => false);
    if (!hien) { await nutMenu.first().click(); await p.waitForTimeout(900); }
  }
  const coNut = await p.locator('[data-nut="kiemcapnhat"]').count();
  const coPhienBan = /Phiên bản v/.test(await p.evaluate(() => document.body.innerText));
  console.log('      trên bản WEB: thấy nút?', coNut, '· thấy dòng phiên bản?', coPhienBan);
  chot(coNut === 0 && coPhienBan,
    'ĐỐI CHỨNG: bản WEB hiện dòng phiên bản nhưng KHÔNG hiện nút (đúng — web không tự cập nhật)');
} finally {
  await b.close().catch(() => {});
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  await db.end();
}

console.log('\n[nut-capnhat] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[nut-capnhat] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[nut-capnhat] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
