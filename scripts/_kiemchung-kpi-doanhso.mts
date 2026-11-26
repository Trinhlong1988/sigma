// KIỂM CHỨNG KPI DOANH SỐ trên DB THỬ RIÊNG `sigma_kpi_thu` (luật L14 — nhãn riêng, DROP sau).
// AN TOÀN: với DB THẬT chỉ CHỈ ĐỌC (pg_dump --schema-only). DB thử có TÊN RIÊNG, tạo+xoá trọn gói.
//   • Chứng: (a) theoNgay có ĐÚNG N cột = N ngày có bill; (b) Σ doanh số KPI == Σ bảng Doanh Số cùng kỳ
//     (đếm/ cộng độc lập); (c) phân loại POS thấp/đạt-hạn-mức/không-chạy ĐÚNG từng con số đã seed;
//     (d) route /v1/kpi/doanh-so THẬT qua HTTP (supertest + app thật) trả 200 khớp số + 403 khi thiếu quyền.
//   • Chạy: npx tsx scripts/_kiemchung-kpi-doanhso.mts
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { createPrisma } from '@sigma/database';
import { kpiDoanhSo } from '@sigma/services';
import { createApp } from '../apps/quanly-api/src/app.js';
import { __setDbForTest } from '../apps/quanly-api/src/db.js';

const GOC = resolve(import.meta.dirname, '..');
const BIN = process.env.PG_BIN || '<PG_BIN>\\pgsql\\bin';
const TEN_THU = 'sigma_kpi_thu';
const TI = 1_000_000_000;
let loi = 0;
const ok = (dk: boolean, nhan: string, chiTiet = ''): void => {
  console.log(`${dk ? '  PASS' : '  FAIL'} · ${nhan}${chiTiet ? ' → ' + chiTiet : ''}`);
  if (!dk) loi++;
};

function envVar(ten: string): string | null {
  const f = resolve(GOC, 'apps/quanly-api/.env');
  if (!existsSync(f)) return null;
  for (const d of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = new RegExp('^\\s*' + ten + '\\s*=\\s*(.+)\\s*$').exec(d);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

const URL_THAT = envVar('DATABASE_URL');
if (!URL_THAT) throw new Error('Không đọc được DATABASE_URL');
const u = new URL(URL_THAT);
const TEN_THAT = u.pathname.replace(/^\//, '');
if (TEN_THAT === TEN_THU) throw new Error('Tên DB thử trùng DB thật → DỪNG');
const urlThu = new URL(URL_THAT);
urlThu.pathname = '/' + TEN_THU;
const PGPASS = decodeURIComponent(u.password || '');
const env = { ...process.env, PGPASSWORD: PGPASS };

const chay = (file: string, args: string[], outFile?: string): Promise<void> =>
  new Promise((res2, rej) => {
    const c = spawn(resolve(BIN, file), args, { env, stdio: outFile ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let out = '';
    c.stdout.on('data', (d) => (out += d.toString()));
    c.stderr.on('data', (d) => (err += d.toString()));
    c.on('error', rej);
    c.on('close', (ma) => {
      if (outFile) writeFileSync(outFile, out);
      ma === 0 ? res2() : rej(new Error(`${file} mã ${ma}: ${err.slice(0, 600)}`));
    });
  });

const noi = async (url: string): Promise<pg.Client> => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
};

const DUMP = resolve(GOC, '_tmp_kpi_schema.sql');

async function main(): Promise<void> {
  // 1) Tạo lại DB thử (kết nối DB maintenance, KHÔNG đụng dữ liệu DB thật) ───────────────────────
  const urlAdmin = new URL(URL_THAT);
  urlAdmin.pathname = '/postgres';
  let admin: pg.Client;
  try {
    admin = await noi(urlAdmin.toString());
  } catch {
    admin = await noi(URL_THAT); // fallback nối DB thật chỉ để chạy lệnh cấp-cluster CREATE/DROP (không ghi vào nó)
  }
  await admin.query(`DROP DATABASE IF EXISTS ${TEN_THU}`);
  await admin.query(`CREATE DATABASE ${TEN_THU}`);
  await admin.end();
  console.log(`[1] Đã tạo DB thử "${TEN_THU}".`);

  // 2) Clone SCHEMA từ DB thật (CHỈ ĐỌC) → nạp vào DB thử ────────────────────────────────────────
  await chay('pg_dump.exe', ['--schema-only', '--no-owner', '--no-privileges', '-d', URL_THAT], DUMP);
  await chay('psql.exe', ['-v', 'ON_ERROR_STOP=0', '-q', '-d', urlThu.toString(), '-f', DUMP]);
  console.log('[2] Đã clone schema vào DB thử.');

  const c = await noi(urlThu.toString());
  const soBang = Number((await c.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`)).rows[0].n);
  console.log(`    DB thử có ${soBang} bảng.`);

  // 3) SEED dữ liệu có chủ đích (tắt FK/trigger để chỉ cần thoả NOT NULL) ────────────────────────
  await c.query(`SET session_replication_role = replica`);
  const PW = createHash('sha256').update('x').digest('hex'); // placeholder hash (không đăng nhập qua mật khẩu)
  const seed = `
    INSERT INTO permissions (id,code,name) VALUES (1,'REVENUE_VIEW','Xem doanh số');
    INSERT INTO roles (id,name,code,status,is_system,updated_at) VALUES
      (1,'Staff','STAFF','ACTIVE',false,now()), (2,'Trống','NONE','ACTIVE',false,now());
    INSERT INTO role_permissions (role_id,permission_id) VALUES (1,1);
    INSERT INTO users (id,full_name,username,password_hash,status,updated_at) VALUES
      (1,'KPI Staff','kpistaff','${PW}','ACTIVE',now()), (2,'KPI Ngoai','kpingoai','${PW}','ACTIVE',now());
    INSERT INTO user_roles (user_id,role_id) VALUES (1,1),(2,2);

    INSERT INTO banks (id,name,code,status,updated_at) VALUES (1,'MB Bank','MB','ACTIVE',now());
    INSERT INTO partners (id,name,code,updated_at) VALUES (1,'Đối tác 1','P1',now());
    INSERT INTO card_types (id,bank_id,name,code,updated_at) VALUES (1,1,'MB','MB',now());
    INSERT INTO fee_rates (id,partner_id,card_type_id,phi_mua,phi_cai_may,effective_from,updated_at)
      VALUES (1,1,1,880,200,'2026-01-01 00:00:00',now());

    INSERT INTO customers (id,code,full_name,nickname,updated_at) VALUES
      (1,'KH01','Nguyễn Văn An','An',now()),
      (2,'KH02','Trần Thị Bình','Bình',now()),
      (3,'KH03','Lê Văn Cường','Cường',now());

    INSERT INTO tids (id,tid,status,customer_id,bank_id,partner_id,updated_at) VALUES
      (1,'T-AN-1','ACTIVE',1,1,1,now()),
      (2,'T-AN-2','ACTIVE',1,1,1,now()),
      (3,'T-BINH-1','ACTIVE',2,1,1,now()),
      (4,'T-CUONG-1','ACTIVE',3,1,1,now());
  `;
  await c.query(seed);

  // Bills: mỗi lô = 1 transaction (sell_margin 1.0% + phí cài 0.2% ⇒ phí bán 1.2%; phí mua đối tác 0.88%).
  // Giờ VN 10:00 ⇒ ca 2 (bảng MB 09:40/16:40). Rải nhiều NGÀY để theoNgay có nhiều cột.
  // Đã seed: T-AN-1 = 4,9 tỉ (THẤP), T-BINH-1 = 13,1 tỉ (ĐẠT HẠN MỨC), T-CUONG-1 = 8 tỉ (bình thường),
  //          T-AN-2 = 0 bill (KHÔNG CHẠY).  Tổng = 26 tỉ / 9 lô / 8 ngày phân biệt.
  const bills: { id: number; tid: number; ngay: string; tien: number }[] = [
    { id: 1, tid: 1, ngay: '02', tien: 1.0 * TI },
    { id: 2, tid: 1, ngay: '05', tien: 1.9 * TI },
    { id: 3, tid: 1, ngay: '09', tien: 2.0 * TI },
    { id: 4, tid: 3, ngay: '03', tien: 3.0 * TI },
    { id: 5, tid: 3, ngay: '05', tien: 3.1 * TI },
    { id: 6, tid: 3, ngay: '10', tien: 4.0 * TI },
    { id: 7, tid: 3, ngay: '15', tien: 3.0 * TI },
    { id: 8, tid: 4, ngay: '04', tien: 5.0 * TI },
    { id: 9, tid: 4, ngay: '20', tien: 3.0 * TI }
  ];
  for (const b of bills) {
    const fee = Math.round((b.tien * 1.2) / 100);
    const sau = b.tien - fee;
    const moc = `2026-11-${b.ngay} 10:00:00+07`;
    await c.query(
      `INSERT INTO transactions (id,tid_id,amount,txn_date,sell_margin_milli,phi_cai_may_milli,updated_at)
         VALUES ($1,$2,$3,$4,1000,200,now())`,
      [b.id, b.tid, b.tien, moc]
    );
    await c.query(
      `INSERT INTO los (id,agent_id,status,transaction_id,bill_txn_date,created_at,updated_at)
         VALUES ($1,1,'POSTED',$1,$2,now(),now())`,
      [b.id, moc]
    );
    await c.query(
      `INSERT INTO lo_rows (id,lo_id,tid_id,card_type_id,fee_type_id,amount_before_fee,fee_applied,amount_after_fee)
         VALUES ($1,$1,$2,1,1,$3,$4,$5)`,
      [b.id, b.tid, b.tien, fee, sau]
    );
  }
  // 1 lô ĐÃ HỦY (không được tính) để chứng status<>CANCELLED có tác dụng.
  await c.query(`INSERT INTO transactions (id,tid_id,amount,txn_date,sell_margin_milli,phi_cai_may_milli,updated_at)
                   VALUES (99,1,9999999999,'2026-11-06 10:00:00+07',1000,200,now())`);
  await c.query(`INSERT INTO los (id,agent_id,status,transaction_id,bill_txn_date,created_at,updated_at)
                   VALUES (99,1,'CANCELLED',99,'2026-11-06 10:00:00+07',now(),now())`);
  await c.query(`INSERT INTO lo_rows (id,lo_id,tid_id,card_type_id,fee_type_id,amount_before_fee,fee_applied,amount_after_fee)
                   VALUES (99,99,1,1,1,9999999999,0,9999999999)`);

  // Phiên đăng nhập cho 2 user (cookie giữ UUID thô; DB lưu sha256).
  const sid1 = randomUUID();
  const sid2 = randomUUID();
  const bam = (s: string): string => createHash('sha256').update(s).digest('hex');
  await c.query(
    `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at) VALUES
       ($1,1,now(),now()+interval '1 day',now()), ($2,2,now(),now()+interval '1 day',now())`,
    [bam(sid1), bam(sid2)]
  );
  await c.query(`SET session_replication_role = default`);
  console.log('[3] Đã seed 9 lô hợp lệ (26 tỉ) + 1 lô CANCELLED + 4 TID + 3 đại lý + 2 user.');

  // 4) Gọi SERVICE trực tiếp (chạy ĐÚNG SQL trên schema thật) ────────────────────────────────────
  const db = createPrisma(urlThu.toString());
  __setDbForTest(db);
  const ctx = {
    db,
    user: { id: 1, username: 'kpistaff', fullName: 'KPI Staff', roles: [], permissions: ['REVENUE_VIEW'] } as never
  };
  const FROM = '2026-11-01';
  const TO = '2026-11-30';
  const r = await kpiDoanhSo(ctx as never, { from: FROM, to: TO });
  if (!r.ok) throw new Error('kpiDoanhSo FAIL: ' + r.message);
  const d = r.data;

  // (b) Đối chiếu ĐỘC LẬP với "bảng Doanh Số" cùng kỳ (đếm lô + cộng amount_before_fee, cùng biên kỳ).
  const dsBang = await db.$queryRawUnsafe<Array<{ n: number; tong: string }>>(
    `SELECT count(DISTINCT l.id)::int AS n, COALESCE(SUM(r.amount_before_fee),0)::text AS tong
       FROM los l JOIN lo_rows r ON r.lo_id=l.id
      WHERE l.status <> 'CANCELLED'
        AND COALESCE(l.bill_txn_date,l.created_at) >= ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
        AND COALESCE(l.bill_txn_date,l.created_at) <  ((($2::date)+1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')`,
    FROM,
    TO
  );
  const bangTong = Number(dsBang[0].tong);
  const bangSoLo = Number(dsBang[0].n);

  console.log('\n[4] KẾT QUẢ SERVICE (kỳ 01→30/11):');
  console.log(`    tongDoanhSo=${d.tongDoanhSo} · tongLai=${d.tongLai} · soBill=${d.soBill} · theoNgay=${d.theoNgay.length} cột`);
  ok(d.tongDoanhSo === 26 * TI, '(b) Σ doanh số KPI = 26 tỉ', String(d.tongDoanhSo));
  ok(d.tongDoanhSo === bangTong, '(b) Σ KPI == Σ bảng Doanh Số (độc lập)', `${d.tongDoanhSo} vs ${bangTong}`);
  ok(d.soBill === bangSoLo && bangSoLo === 9, '(b) số lô KPI == bảng Doanh Số == 9 (loại 1 lô CANCELLED)', `${d.soBill}/${bangSoLo}`);
  const sumNgay = d.theoNgay.reduce((s, x) => s + x.doanhSo, 0);
  const sumDl = d.theoDaiLy.reduce((s, x) => s + x.doanhSo, 0);
  ok(sumNgay === d.tongDoanhSo && sumDl === d.tongDoanhSo, '(b) Σ theoNgay == Σ theoDaiLy == tổng', `${sumNgay}/${sumDl}`);
  ok(d.theoNgay.length === 8, '(a) theoNgay có ĐÚNG 8 cột = 8 ngày có bill', String(d.theoNgay.length));

  const dl = (ten: string) => d.theoDaiLy.find((x) => x.ten === ten);
  const An = dl('An'); const Binh = dl('Bình'); const Cuong = dl('Cường');
  ok(!!An && An.doanhSo === 4.9 * TI, 'đại lý An doanh số = 4,9 tỉ', String(An?.doanhSo));
  ok(!!An && An.posCam === 2 && An.posKhongChay === 1 && An.posThap === 1 && An.posDatHanMuc === 0,
    '(c) An: 2 POS cầm · 1 KHÔNG CHẠY · 1 THẤP · 0 đạt', JSON.stringify({ cam: An?.posCam, kc: An?.posKhongChay, thap: An?.posThap, dat: An?.posDatHanMuc }));
  ok(!!Binh && Binh.doanhSo === 13.1 * TI && Binh.posDatHanMuc === 1 && Binh.posThap === 0 && Binh.posKhongChay === 0,
    '(c) Bình: 13,1 tỉ · 1 POS ĐẠT HẠN MỨC', JSON.stringify({ ds: Binh?.doanhSo, dat: Binh?.posDatHanMuc }));
  ok(!!Cuong && Cuong.doanhSo === 8 * TI && Cuong.posDatHanMuc === 0 && Cuong.posThap === 0 && Cuong.posKhongChay === 0,
    '(c) Cường: 8 tỉ · POS bình thường (không cờ)', JSON.stringify({ ds: Cuong?.doanhSo, thap: Cuong?.posThap, dat: Cuong?.posDatHanMuc }));
  // lãi An = 4,9 tỉ × (1,2% − 0,88%) = 4,9 tỉ × 0,32% = 15.680.000
  ok(!!An && An.lai === 15_680_000, 'lãi kỳ An = 15.680.000 (phí bán − phí mua đối tác)', String(An?.lai));

  // CA filter: tất cả bill 10:00 ⇒ ca 2. ca=2 giữ nguyên 26 tỉ; ca=1 = 0.
  const rCa2 = await kpiDoanhSo(ctx as never, { from: FROM, to: TO, ca: 2 });
  const rCa1 = await kpiDoanhSo(ctx as never, { from: FROM, to: TO, ca: 1 });
  ok(rCa2.ok && rCa2.data.tongDoanhSo === 26 * TI, 'lọc CA 2 = 26 tỉ (mọi bill 10:00 thuộc ca 2 MB)', rCa2.ok ? String(rCa2.data.tongDoanhSo) : 'err');
  ok(rCa1.ok && rCa1.data.tongDoanhSo === 0, 'lọc CA 1 = 0 (không bill nào thuộc ca 1)', rCa1.ok ? String(rCa1.data.tongDoanhSo) : 'err');

  // Quy đổi tháng: kỳ 15 ngày ⇒ hệ số 2.0
  const r15 = await kpiDoanhSo(ctx as never, { from: '2026-11-01', to: '2026-11-15' });
  ok(r15.ok && Math.abs(r15.data.heSoQuyDoiThang - 2) < 1e-9, 'kỳ 15 ngày ⇒ hệ số quy đổi tháng = 2.0', r15.ok ? r15.data.heSoQuyDoiThang.toFixed(3) : 'err');

  // 5) HTTP route thật (supertest + app thật) ───────────────────────────────────────────────────
  const app = createApp();
  const res200 = await request(app)
    .get(`/v1/kpi/doanh-so?from=${FROM}&to=${TO}`)
    .set('Cookie', `ql_session=${sid1}`);
  ok(res200.status === 200 && res200.body?.ok === true, '(d) HTTP GET có quyền → 200 ok', `status=${res200.status}`);
  ok(res200.body?.data?.tongDoanhSo === 26 * TI, '(d) HTTP trả tongDoanhSo = 26 tỉ', String(res200.body?.data?.tongDoanhSo));
  ok(Array.isArray(res200.body?.data?.theoDaiLy) && res200.body.data.theoDaiLy.length >= 3, '(d) HTTP trả theoDaiLy ≥ 3 đại lý', String(res200.body?.data?.theoDaiLy?.length));

  const res403 = await request(app)
    .get(`/v1/kpi/doanh-so?from=${FROM}&to=${TO}`)
    .set('Cookie', `ql_session=${sid2}`);
  ok(res403.status === 403, '(d) HTTP user THIẾU quyền REVENUE_VIEW → 403 (deny-by-default)', `status=${res403.status}`);

  await db.$disconnect();
  await c.end();
}

main()
  .catch((e) => {
    console.error('\n[LỖI]', e);
    loi++;
  })
  .finally(async () => {
    try {
      const urlAdmin = new URL(URL_THAT);
      urlAdmin.pathname = '/postgres';
      let admin: pg.Client;
      try { admin = await noi(urlAdmin.toString()); } catch { admin = await noi(URL_THAT); }
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [TEN_THU]);
      await admin.query(`DROP DATABASE IF EXISTS ${TEN_THU}`);
      await admin.end();
      console.log(`\n[dọn] Đã DROP DB thử "${TEN_THU}".`);
    } catch (e) {
      console.error('[dọn] KHÔNG drop được DB thử:', e);
    }
    try { if (existsSync(DUMP)) rmSync(DUMP); } catch { /* bỏ qua */ }
    console.log(loi === 0 ? '\n==== TẤT CẢ PASS ====' : `\n==== CÓ ${loi} LỖI ====`);
    process.exit(loi === 0 ? 0 : 1);
  });
