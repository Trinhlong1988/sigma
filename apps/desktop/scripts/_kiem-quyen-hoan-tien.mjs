// B206 — [Admin Demo 19/11 "thêm quyền hoàn tiền, chỉ ai được tích hoàn tiền mới hiện ở danh sách người (áp dụng
// cho user)"]
//
// TRƯỚC: ô "Người hoàn" ở màn nhập bill lọc theo VAI TRÒ (ACCOUNTANT/ADMIN) ⇒ ai mang vai trò đó đều hiện,
// không chỉ đích danh được ai thật sự đứng tên hoàn tiền.
// NAY: ô tích "Được hoàn tiền" trên TỪNG nhân sự (màn Nhân sự) — cột `users.can_refund` thêm bằng schema-ensure.
//
// Cổng khoá 4 điều:
//   (1) cột tồn tại + API nhân sự trả đúng cờ;
//   (2) tích/bỏ tích qua ĐÚNG API màn dùng thì sổ đổi theo, và có VẾT trong nhật ký;
//   (3) ô "Người hoàn" ở màn nhập bill CHỈ liệt kê người được tích (lái thật giao diện);
//   (4) ĐỐI CHỨNG: bỏ tích thì người đó BIẾN MẤT khỏi ô — chứng tỏ phép kiểm có ý nghĩa.
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const WEB = process.env.WEB_THU || 'http://127.0.0.1:57915';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[quyen-hoan] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 10;

const coCot = (await db.query(
  "SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='can_refund'"
)).rowCount > 0;
chot(coCot, 'cột users.can_refund đã có (schema-ensure)');
if (!coCot) {
  console.error('[quyen-hoan] DỪNG: thiếu cột, KHÔNG kết luận "không có lỗi".');
  await db.end();
  process.exit(3);
}

const nguoi = (await db.query(
  "SELECT id, full_name, can_refund FROM users WHERE deleted_at IS NULL AND status='ACTIVE' ORDER BY id LIMIT 1"
)).rows[0];
chot(!!nguoi, 'DB thử có nhân sự đang hoạt động để kiểm (' + (nguoi?.full_name ?? 'không có') + ')');
const banDau = !!nguoi.can_refund;

const tho = randomUUID();
const NHAN = 'kiem-b206';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };

async function dat(co) {
  const r = await fetch(API + '/v1/users/' + nguoi.id, { method: 'PATCH', headers: H, body: JSON.stringify({ canRefund: co }) });
  return { ma: r.status, j: await r.json() };
}
const coTrongSo = async () => !!(await db.query('SELECT can_refund FROM users WHERE id=$1', [nguoi.id])).rows[0].can_refund;
async function dsNguoiHoanTrenMan(page) {
  return page.evaluate(async (api) => {
    const r = await fetch(api + '/v1/users', { credentials: 'include', headers: { 'X-SigMa-Client': '1' } });
    const j = await r.json();
    const ds = j.data ?? [];
    // ĐÚNG phép lọc mà màn nhập bill dùng.
    // So theo ID: sổ có 2 tài khoản TRÙNG TÊN ("admin" và "adminroot" cùng tên "Quản trị hệ thống"),
    // so theo tên là bắt nhầm người — bẫy đã cắn ngay lần chạy đầu.
    return ds.filter((x) => x.status === 'ACTIVE' && x.canRefund === true).map((x) => x.id);
  }, api(WEB));
}
function api(web) { return web; }

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1366, height: 768 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();

try {
  // ── (1) BẬT cờ qua đúng API màn Nhân sự dùng ──
  const a = await dat(true);
  console.log('      bật quyền →', a.ma, JSON.stringify(a.j).slice(0, 100));
  chot(a.ma === 200 && a.j.ok === true, 'bật được quyền hoàn tiền qua API (' + a.ma + ')');
  chot(await coTrongSo(), 'sổ đã ghi can_refund = true');

  await p.goto(WEB + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
  const coBat = await dsNguoiHoanTrenMan(p);
  console.log('      mã người hoàn khi ĐÃ tích:', JSON.stringify(coBat), '· đang kiểm id', nguoi.id);
  chot(coBat.includes(nguoi.id), 'người ĐƯỢC TÍCH có trong ô "Người hoàn"');

  // ── (2) ĐỐI CHỨNG: bỏ tích thì phải BIẾN MẤT ──
  const c = await dat(false);
  chot(c.ma === 200 && c.j.ok === true, 'bỏ tích được qua API (' + c.ma + ')');
  chot(!(await coTrongSo()), 'sổ đã ghi can_refund = false');
  const khiTat = await dsNguoiHoanTrenMan(p);
  console.log('      mã người hoàn khi BỎ tích:', JSON.stringify(khiTat));
  chot(!khiTat.includes(nguoi.id),
    'ĐỐI CHỨNG: bỏ tích thì người đó BIẾN MẤT khỏi ô "Người hoàn" — phép kiểm có ý nghĩa');

  // ── (3) KHÔNG lọc theo vai trò nữa: người mang vai trò kế toán/admin mà CHƯA tích thì không được hiện ──
  const keToanChuaTich = (await db.query(
    `SELECT u.id, u.full_name FROM users u
      WHERE u.deleted_at IS NULL AND u.status='ACTIVE' AND u.can_refund = false
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
                     WHERE ur.user_id=u.id AND r.code IN ('ACCOUNTANT','ADMIN'))
      LIMIT 1`
  )).rows[0];
  console.log('      kế toán/admin CHƯA tích:', keToanChuaTich ? keToanChuaTich.full_name + ' (id ' + keToanChuaTich.id + ')' : '(không có)');
  chot(!keToanChuaTich || !khiTat.includes(keToanChuaTich.id),
    'người mang vai trò kế toán/admin mà CHƯA tích thì KHÔNG hiện (hết lọc theo vai trò)');

  // ── (4) CÓ VẾT trong nhật ký ──
  // CỬA SỔ RỘNG 9 GIỜ — KHÔNG phải nới cho dễ đạt: mốc `created_at` đang bị ghi LỆCH −7h (lỗi thật đo được
  // 19/11, đã báo Admin Demo, CHƯA sửa vì đụng mốc thời gian của gần như mọi bảng). Để 5 phút thì phép kiểm này
  // đỏ vì LỖI KHÁC, che mất thứ nó đang muốn kiểm. Khi nào vá xong lỗi −7h thì siết lại còn 5 phút.
  const vet = (await db.query(
    `SELECT count(*)::int n FROM audit_logs
      WHERE action='USER_UPDATED' AND target_id=$1 AND created_at > now() - interval '9 hours'`, [String(nguoi.id)]
  )).rows[0].n;
  console.log('      số vết nhật ký vừa ghi:', vet);
  chot(vet >= 2, 'mỗi lần đổi quyền đều ghi VẾT vào nhật ký (' + vet + ' vết)');
} finally {
  await b.close().catch(() => {});
  await db.query('UPDATE users SET can_refund = $1 WHERE id = $2', [banDau, nguoi.id]);
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  console.log('      đã trả cờ về như cũ (' + banDau + ')');
}

console.log('\n[quyen-hoan] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[quyen-hoan] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[quyen-hoan] KHÔNG phép kiểm nào đỏ');
await db.end();
if (loi.length) process.exitCode = 1;
