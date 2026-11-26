// B219 — [Admin Demo 20/11 "tất cả trường lọc 1 dòng xanh 1 dòng trắng như brand"] DẢI XEN KẼ PHẢI THẤY ĐƯỢC.
//
// Ca thật: bản đầu dùng `bg-brand-tint/30`. Lớp CSS CÓ, dải CÓ, nhưng đo ra rgb(250,252,253) — chênh nền
// trắng đúng 2-3/255 ⇒ MẮT KHÔNG THẤY ⇒ Admin Demo báo "lọc chưa có màu dòng". Bài học: có class ≠ nhìn thấy.
//
// Cổng này ĐO MÀU THẬT trên bản web đang chạy (không đọc class rồi suy):
//   (1) dòng xen kẽ phải khác nền trắng ÍT NHẤT 8/255 ở một kênh màu;
//   (2) dòng ĐÃ CHỌN phải đậm hơn hẳn dải xen kẽ (nếu không thì chọn rồi cũng không biết đã chọn);
//   (3) ĐỐI CHỨNG: dòng chẵn vẫn TRẮNG (không phải tô cả bảng thành xanh).
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
  console.error('[dai-xen-ke] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 5;

// ĐO ĐÚNG CÁI MẮT THẤY: trình duyệt nay trả màu dạng `oklab(... / .35)` và `rgba(0,0,0,0)`. Tách chuỗi bằng
// regex rgb là SAI cả hai: oklab không khớp (ra -1), còn "trong suốt" bị đọc thành ĐEN trong khi mắt thấy
// TRẮNG (nền bảng). Nên trộn thật trên nền trắng bằng canvas rồi đọc điểm ảnh — đúng màu đã hiện ra.
const lech = (a, b) => (a && b ? Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) : -1);

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN = 'kiem-b219';
const tho = randomUUID();
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '10 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);
const b = await chromium.launch();
try {
  const ctx = await b.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
  const p = await ctx.newPage();
  await p.goto(WEB + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
  const menu = p.locator("[data-kiem='nut-menu']");
  if (await menu.count()) { await menu.first().click(); await p.waitForTimeout(700); }
  const link = p.getByText('Doanh Số', { exact: false }).first();
  if (await link.count()) { await link.click(); await p.waitForTimeout(2500); }

  // [23/11] Kỳ xem MẶC ĐỊNH là hôm nay — thường KHÔNG có bill ⇒ mọi ô lọc rút-từ-dữ-liệu đều rỗng,
  // không đo được màu. Chọn ngày ĐÔNG BILL NHẤT trong sổ thử trước đã.
  const ngayDong = (await db.query(
    "SELECT to_char(COALESCE(bill_txn_date, created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') d, count(*)::int n"
    + " FROM los WHERE status <> 'CANCELLED' GROUP BY 1 ORDER BY n DESC LIMIT 1")).rows[0];
  if (ngayDong) {
    for (const o of await p.locator('input[type="date"]').all()) { await o.fill(ngayDong.d); await p.waitForTimeout(300); }
    await p.waitForTimeout(2500);
    console.log('      kỳ xem đặt về', ngayDong.d, '(' + ngayDong.n + ' bill)');
  }

  // [23/11] TRƯỚC ĐÂY cổng bám cứng ô "Ca" vì "Ca luôn có 3 lựa chọn". Sau B256 ô Ca cũng rút từ DỮ
  // LIỆU (kỳ ít bill có khi chỉ 1-2 ca) ⇒ cổng đỏ oan. Nay DÒ ô lọc đầu tiên có ≥3 mục rồi mới đo màu.
  const UNG_VIEN = ['ca', 'dl', 'tid', 'hkd', 'bank', 'the', 'ndt'];
  let khoaO = null;
  for (const k of UNG_VIEN) {
    const o = p.locator('[data-loc="' + k + '"] button').first();
    if (!(await o.count())) continue;
    await o.click();
    await p.waitForTimeout(700);
    const soMuc = await p.evaluate((kk) => {
      const pn = document.querySelector('[data-loc-hop="' + kk + '"]');
      return pn ? [...pn.querySelectorAll('button')].filter((x) => !/Chọn tất cả|Bỏ chọn/.test(x.textContent || '')).length : 0;
    }, k);
    if (soMuc >= 3) { khoaO = k; console.log('      đo dải màu trên ô lọc "' + k + '" (' + soMuc + ' mục)'); break; }
    await o.click();
    await p.waitForTimeout(300);
  }
  chot(khoaO != null, 'tìm được ô lọc có ít nhất 3 mục để đo dải xen kẽ');
  if (!khoaO) throw new Error('không ô lọc nào đủ 3 mục trong kỳ xem');
  const doc = () => p.evaluate(() => {
    // [B254 22/11] Hộp xổ vẽ bằng portal ra <body> — tìm theo data-loc-hop.
    const pn = document.querySelector('[data-loc-hop]');
    if (!pn) return null;
    const c = document.createElement('canvas');
    c.width = 4; c.height = 4;
    const g = c.getContext('2d');
    const tron = (mau) => {
      g.clearRect(0, 0, 4, 4);
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 4, 4); // nền bảng là TRẮNG
      g.fillStyle = mau; g.fillRect(0, 0, 4, 4);        // phủ màu dòng lên trên
      const d = g.getImageData(2, 2, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const hang = [...pn.children[pn.children.length - 1].children].slice(0, 3);
    return hang.map((x) => {
      const goc = getComputedStyle(x).backgroundColor;
      return { goc, rgb: tron(goc) };
    });
  });
  const truoc = await doc();
  chot(Array.isArray(truoc) && truoc.length >= 3, 'mở được bảng sổ xuống và thấy ít nhất 3 dòng');
  const TRANG = [255, 255, 255];
  const dai = truoc[1].rgb;  // dòng thứ 2 = dòng lẻ = dải xen kẽ
  const chan = truoc[2].rgb;
  console.log('      dòng xen kẽ =', truoc[1].goc, '→ trộn trên nền trắng =', dai.join(','), '· lệch =', lech(dai, TRANG));
  chot(lech(dai, TRANG) >= 8,
    'dải xen kẽ THẤY ĐƯỢC: lệch nền trắng ' + lech(dai, TRANG) + '/255 (cần ≥ 8 — 30% độ mờ chỉ ra 2-3, mắt không thấy)');
  chot(lech(chan, TRANG) <= 2, 'ĐỐI CHỨNG: dòng còn lại vẫn TRẮNG (không tô cả bảng)');

  await p.evaluate(() => {
    // [B254 22/11] Hộp xổ vẽ bằng portal ra <body> — tìm theo data-loc-hop.
    const pn = document.querySelector('[data-loc-hop]');
    [...pn.querySelectorAll('button')].find((x) => /Ca 1/.test(x.textContent || ''))?.click();
  });
  await p.waitForTimeout(600);
  const sau = await doc();
  const chon = sau?.[0]?.rgb ?? null;
  console.log('      dòng ĐÃ CHỌN =', sau?.[0]?.goc, '→', chon?.join(','), '· lệch so với dải xen kẽ =', lech(chon, dai));
  chot(lech(chon, dai) >= 8,
    'dòng ĐÃ CHỌN đậm hơn hẳn dải xen kẽ (' + lech(chon, dai) + '/255) — không thì chọn xong cũng không biết');
} finally {
  await b.close().catch(() => {});
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  await db.end();
}

console.log('\n[dai-xen-ke] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[dai-xen-ke] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[dai-xen-ke] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
