// AUDIT ĐỐI KHÁNG KPI DOANH SỐ — DB thử nhãn riêng `sigma_audit_kpi` (DROP sau). CHỈ ĐỌC DB thật.
// Chạy: npx tsx scripts/_audit_kpi_adv.mts
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { createPrisma } from '@sigma/database';
import { kpiDoanhSo } from '@sigma/services';
import { __setDbForTest } from '../apps/quanly-api/src/db.js';

const GOC = resolve(import.meta.dirname, '..');
const BIN = process.env.PG_BIN || '<PG_BIN>\\pgsql\\bin';
const TEN_THU = 'sigma_audit_kpi';
const TI = 1_000_000_000;
let loi = 0;
const ok = (dk: boolean, nhan: string, chiTiet = ''): void => {
  console.log(`${dk ? '  PASS' : '  **FAIL'} · ${nhan}${chiTiet ? ' -> ' + chiTiet : ''}`);
  if (!dk) loi++;
};
const info = (s: string): void => console.log('   [i] ' + s);

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
if (!URL_THAT) throw new Error('khong doc duoc DATABASE_URL');
const u = new URL(URL_THAT);
if (u.pathname.replace(/^\//, '') === TEN_THU) throw new Error('trung ten DB that -> DUNG');
const urlThu = new URL(URL_THAT); urlThu.pathname = '/' + TEN_THU;
const env = { ...process.env, PGPASSWORD: decodeURIComponent(u.password || '') };

const chay = (file: string, args: string[], outFile?: string): Promise<void> =>
  new Promise((res2, rej) => {
    const c = spawn(resolve(BIN, file), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; let out = '';
    c.stdout.on('data', (d) => (out += d.toString()));
    c.stderr.on('data', (d) => (err += d.toString()));
    c.on('error', rej);
    c.on('close', (ma) => { if (outFile) writeFileSync(outFile, out); ma === 0 ? res2() : rej(new Error(`${file} ma ${ma}: ${err.slice(0, 600)}`)); });
  });
const noi = async (url: string): Promise<pg.Client> => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; };
const DUMP = resolve(GOC, '_tmp_audit_kpi_schema.sql');
const FROM = '2026-11-01', TO = '2026-11-30';

// ===== replica cua man DOANH SO (bill-manual GET + screen laiKy) de doi chieu doc lap =====
async function bangDoanhSo(db: any): Promise<{ tongDS: number; soLo: number; laiKy: number; theoNguoiMuon: Map<string, number> }> {
  const rows = await db.$queryRawUnsafe<Array<any>>(
    `SELECT l.id lo_id,
            COALESCE(cm.full_name, c.full_name) AS dai_ly,
            SUM(r.amount_before_fee)::text truoc,
            SUM(r.amount_after_fee)::text  sau,
            COUNT(DISTINCT r.card_type_id)::int so_the,
            MAX(tx.sell_margin_milli) sell_margin_milli,
            MAX(tx.phi_cai_may_milli) phi_cai_may_milli,
            MAX(fm.phi_mua) phi_mua_milli
       FROM los l JOIN lo_rows r ON r.lo_id=l.id
       LEFT JOIN tids t ON t.id=r.tid_id
       LEFT JOIN customers c ON c.id=t.customer_id
       LEFT JOIN customers cm ON cm.id=l.borrowed_by_customer_id
       LEFT JOIN transactions tx ON tx.id=l.transaction_id
       LEFT JOIN LATERAL (SELECT fr.phi_mua FROM fee_rates fr WHERE fr.partner_id=t.partner_id AND fr.card_type_id=r.card_type_id AND fr.deleted_at IS NULL AND fr.effective_from<=COALESCE(l.bill_txn_date,l.created_at) ORDER BY fr.effective_from DESC LIMIT 1) fm ON TRUE
      WHERE l.status<>'CANCELLED'
        AND COALESCE(l.bill_txn_date,l.created_at) >= ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
        AND COALESCE(l.bill_txn_date,l.created_at) <  ((($2::date)+1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
      GROUP BY l.id, cm.full_name, c.full_name`,
    FROM, TO);
  let tongDS = 0, laiKy = 0; const theoNguoiMuon = new Map<string, number>();
  for (const x of rows) {
    const truoc = Number(x.truoc), sau = Number(x.sau);
    tongDS += truoc;
    // phiPct / muaPct y het bill-manual.ts
    const phiPct = x.so_the <= 1 && x.sell_margin_milli != null && x.phi_cai_may_milli != null
      ? (Number(x.sell_margin_milli) + Number(x.phi_cai_may_milli)) / 1000
      : truoc > 0 ? Number((((truoc - sau) / truoc) * 100).toFixed(4)) : null;
    const muaPct = x.so_the > 1 ? null : x.phi_mua_milli != null ? Number(x.phi_mua_milli) / 1000 : null;
    if (phiPct != null && muaPct != null) laiKy += Math.round((truoc * (phiPct - muaPct) * 1000) / 100000);
    const ten = x.dai_ly ?? '(null)';
    theoNguoiMuon.set(ten, (theoNguoiMuon.get(ten) ?? 0) + truoc);
  }
  return { tongDS, soLo: rows.length, laiKy, theoNguoiMuon };
}

async function main(): Promise<void> {
  const urlAdmin = new URL(URL_THAT!); urlAdmin.pathname = '/postgres';
  let admin: pg.Client; try { admin = await noi(urlAdmin.toString()); } catch { admin = await noi(URL_THAT!); }
  await admin.query(`DROP DATABASE IF EXISTS ${TEN_THU}`);
  await admin.query(`CREATE DATABASE ${TEN_THU}`);
  await admin.end();
  await chay('pg_dump.exe', ['--schema-only', '--no-owner', '--no-privileges', '-d', URL_THAT!], DUMP);
  await chay('psql.exe', ['-v', 'ON_ERROR_STOP=0', '-q', '-d', urlThu.toString(), '-f', DUMP]);
  const c = await noi(urlThu.toString());
  await c.query(`SET session_replication_role = replica`);

  const PW = createHash('sha256').update('x').digest('hex');
  await c.query(`
    INSERT INTO permissions (id,code,name) VALUES (1,'REVENUE_VIEW','Xem');
    INSERT INTO roles (id,name,code,status,is_system,updated_at) VALUES (1,'S','STAFF','ACTIVE',false,now());
    INSERT INTO role_permissions (role_id,permission_id) VALUES (1,1);
    INSERT INTO users (id,full_name,username,password_hash,status,updated_at) VALUES (1,'St','st','${PW}','ACTIVE',now());
    INSERT INTO user_roles (user_id,role_id) VALUES (1,1);
    INSERT INTO banks (id,name,code,status,updated_at) VALUES (1,'MB Bank','MB','ACTIVE',now());
    INSERT INTO partners (id,name,code,updated_at) VALUES (1,'P','P1',now());
    INSERT INTO card_types (id,bank_id,name,code,updated_at) VALUES (1,1,'C1','C1',now()),(2,1,'C2','C2',now()),(3,1,'C3','C3',now());
    -- fee_rate cho card1,card2 ; card3 KHONG co (test thieu phi mua)
    INSERT INTO fee_rates (id,partner_id,card_type_id,phi_mua,phi_cai_may,effective_from,updated_at) VALUES
      (1,1,1,880,200,'2026-01-01',now()), (2,1,2,900,200,'2026-01-01',now());
    INSERT INTO customers (id,code,full_name,nickname,updated_at) VALUES
      (1,'A','Agent A','A',now()), (2,'B','Agent B','B',now()), (3,'C','Agent C','C',now());
    -- T1,T2 owner A active ; T3 owner B active ; T4 owner A INACTIVE (thu hoi) ; T5 owner C active
    INSERT INTO tids (id,tid,status,customer_id,bank_id,partner_id,updated_at) VALUES
      (1,'T1','ACTIVE',1,1,1,now()), (2,'T2','ACTIVE',1,1,1,now()),
      (3,'T3','ACTIVE',2,1,1,now()), (4,'T4','INACTIVE',1,1,1,now()),
      (5,'T5','ACTIVE',3,1,1,now());
  `);

  const addTx = async (id: number, tid: number, amount: number, moc: string, sm: number | null, pcm: number | null) =>
    c.query(`INSERT INTO transactions (id,tid_id,amount,txn_date,sell_margin_milli,phi_cai_may_milli,updated_at) VALUES ($1,$2,$3,$4,$5,$6,now())`, [id, tid, amount, moc, sm, pcm]);
  const addLo = async (id: number, moc: string, borrowed: number | null = null, status = 'POSTED') =>
    c.query(`INSERT INTO los (id,agent_id,status,transaction_id,bill_txn_date,borrowed_by_customer_id,created_at,updated_at) VALUES ($1,1,$2,$1,$3,$4,now(),now())`, [id, status, moc, borrowed]);
  const addRow = async (id: number, lo: number, tid: number, card: number, truoc: number, fee: number) =>
    c.query(`INSERT INTO lo_rows (id,lo_id,tid_id,card_type_id,fee_type_id,amount_before_fee,fee_applied,amount_after_fee) VALUES ($1,$2,$3,$4,1,$5,$6,$7)`, [id, lo, tid, card, truoc, fee, truoc - fee]);

  const feeOf = (t: number) => Math.round((t * 1.2) / 100); // 1.2% (sm1.0 + pcm0.2)

  // L1: T1/A card1 2 ti - lai tinh duoc
  await addTx(1, 1, 2 * TI, '2026-11-02 10:00:00+07', 1000, 200); await addLo(1, '2026-11-02 10:00:00+07'); await addRow(1, 1, 1, 1, 2 * TI, feeOf(2 * TI));
  // L2: T1/A MULTI-CARD (card1+card2) tong 2 ti - loai khoi lai (chuaKhai)
  await addTx(2, 1, 2 * TI, '2026-11-05 10:00:00+07', 1000, 200); await addLo(2, '2026-11-05 10:00:00+07');
  await addRow(21, 2, 1, 1, 1 * TI, feeOf(1 * TI)); await addRow(22, 2, 1, 2, 1 * TI, feeOf(1 * TI));
  // L3: T3/B card1 3 ti, borrowed_by = A(1) -> KPI tinh cho B(chu may), bang tinh cho A(muon)
  await addTx(3, 3, 3 * TI, '2026-11-06 10:00:00+07', 1000, 200); await addLo(3, '2026-11-06 10:00:00+07', 1); await addRow(3, 3, 3, 1, 3 * TI, feeOf(3 * TI));
  // L4: T4/A INACTIVE card1 4 ti -> doanh so vao A nhung T4 khong trong universe POS
  await addTx(4, 4, 4 * TI, '2026-11-07 10:00:00+07', 1000, 200); await addLo(4, '2026-11-07 10:00:00+07'); await addRow(4, 4, 4, 1, 4 * TI, feeOf(4 * TI));
  // L5: T5/C card3 (KHONG co fee_rate) 1 ti -> muaPct null -> chuaKhai, doanh so van tinh
  await addTx(5, 5, 1 * TI, '2026-11-08 10:00:00+07', 1000, 200); await addLo(5, '2026-11-08 10:00:00+07'); await addRow(5, 5, 5, 3, 1 * TI, feeOf(1 * TI));
  // L6: bien ky - 23:59:59 ngay cuoi ky (TRONG) T5/C 500tr
  await addTx(6, 5, 0.5 * TI, '2026-11-30 23:59:59+07', 1000, 200); await addLo(6, '2026-11-30 23:59:59+07'); await addRow(6, 6, 5, 1, 0.5 * TI, feeOf(0.5 * TI));
  // L7: 00:00:00 ngay dau thang sau (NGOAI) T5/C 777tr -> khong duoc tinh
  await addTx(7, 5, 0.777 * TI, '2026-12-01 00:00:00+07', 1000, 200); await addLo(7, '2026-12-01 00:00:00+07'); await addRow(7, 7, 5, 1, 0.777 * TI, feeOf(0.777 * TI));
  // L8: 23:59:59 ngay truoc ky (NGOAI) T5/C 888tr
  await addTx(8, 5, 0.888 * TI, '2026-10-31 23:59:59+07', 1000, 200); await addLo(8, '2026-10-31 23:59:59+07'); await addRow(8, 8, 5, 1, 0.888 * TI, feeOf(0.888 * TI));
  // L9: 00:00:00 ngay dau ky (TRONG) T5/C 333tr
  await addTx(9, 5, 0.333 * TI, '2026-11-01 00:00:00+07', 1000, 200); await addLo(9, '2026-11-01 00:00:00+07'); await addRow(9, 9, 5, 1, 0.333 * TI, feeOf(0.333 * TI));
  // L10: CANCELLED 9999 ti - khong duoc tinh
  await addTx(10, 1, 9999 * TI, '2026-11-09 10:00:00+07', 1000, 200); await addLo(10, '2026-11-09 10:00:00+07', null, 'CANCELLED'); await addRow(10, 10, 1, 1, 9999 * TI, 0);

  await c.query(`SET session_replication_role = default`);

  const db = createPrisma(urlThu.toString());
  __setDbForTest(db);
  const ctx = { db, user: { id: 1, username: 'st', fullName: 'St', roles: [], permissions: ['REVENUE_VIEW'] } as never };

  const r = await kpiDoanhSo(ctx as never, { from: FROM, to: TO });
  if (!r.ok) throw new Error('kpi FAIL ' + r.message);
  const d = r.data;
  const bang = await bangDoanhSo(db);

  // doanh so hop le trong ky (loai cancelled + 2 lo ngoai bien) =
  //  L1 2 + L2 2 + L3 3 + L4 4 + L5 1 + L6 0.5 + L9 0.333 = 12.833 ti
  const DS_DUNG = (2 + 2 + 3 + 4 + 1 + 0.5 + 0.333) * TI;
  console.log('\n[KQ] tongDoanhSo=%d soBill=%d tongLai=%d chuaKhai=%d theoNgay=%d', d.tongDoanhSo, d.soBill, d.tongLai, d.soBillChuaKhaiLai, d.theoNgay.length);

  console.log('\n== S1/S4/S10 bien ky + cancelled + tong khop bang ==');
  ok(d.tongDoanhSo === DS_DUNG, 'KPI tongDoanhSo = 12,833 ti (loai cancelled + 2 lo ngoai bien)', String(d.tongDoanhSo));
  ok(d.tongDoanhSo === bang.tongDS, 'KPI tong == bang Doanh So (replica doc lap)', `${d.tongDoanhSo} vs ${bang.tongDS}`);
  ok(d.soBill === 7, 'KPI soBill = 7 lo hop le', String(d.soBill));
  const inDay30 = d.theoNgay.find((x) => x.ngay === '2026-11-30');
  const inDay01 = d.theoNgay.find((x) => x.ngay === '2026-11-01');
  const inDec = d.theoNgay.find((x) => x.ngay >= '2026-12-01');
  const inOct = d.theoNgay.find((x) => x.ngay <= '2026-10-31');
  ok(!!inDay30 && inDay30.doanhSo === 0.5 * TI, 'bill 23:59:59 ngay 30 -> cot ngay 2026-11-30 = 500tr', JSON.stringify(inDay30));
  ok(!!inDay01 && inDay01.doanhSo === 0.333 * TI, 'bill 00:00:00 ngay 01 -> cot 2026-11-01 = 333tr', JSON.stringify(inDay01));
  ok(!inDec && !inOct, 'KHONG co cot ngoai [01..30]/11 (2 lo bien ngoai bi loai)', `dec=${!!inDec} oct=${!!inOct}`);
  const sumNgay = d.theoNgay.reduce((s, x) => s + x.doanhSo, 0);
  const sumDl = d.theoDaiLy.reduce((s, x) => s + x.doanhSo, 0);
  ok(sumNgay === d.tongDoanhSo && sumDl === d.tongDoanhSo, 'Sigma theoNgay == Sigma theoDaiLy == tong', `${sumNgay}/${sumDl}`);

  console.log('\n== S2 multi-card ==');
  const dA = d.theoDaiLy.find((x) => x.daiLyId === 1);
  ok(!!dA, 'co dai ly A', '');
  // A doanh so = L1 2 + L2 2 + L4 4 = 8 ti (L3 borrowed di sang B theo chu may)
  ok(!!dA && dA.doanhSo === 8 * TI, 'A doanh so (KPI, gom chu may) = 8 ti [L1+L2+L4]', String(dA?.doanhSo));
  ok(d.soBillChuaKhaiLai >= 2, 'multi-card L2 + thieu-phi L5 deu vao soBillChuaKhaiLai (>=2)', String(d.soBillChuaKhaiLai));

  console.log('\n== S3 borrowed TID: KPI(chu may) vs bang(nguoi muon) ==');
  const dB = d.theoDaiLy.find((x) => x.daiLyId === 2);
  info(`KPI: A=${dA?.doanhSo} B=${dB?.doanhSo}`);
  info(`BANG(nguoi muon): ${JSON.stringify([...bang.theoNguoiMuon.entries()])}`);
  ok(!!dB && dB.doanhSo === 3 * TI, 'KPI gan lo MUON (3 ti) cho B = CHU MAY', String(dB?.doanhSo));
  ok((bang.theoNguoiMuon.get('Agent A') ?? 0) >= 3 * TI && !(bang.theoNguoiMuon.has('Agent B') && (bang.theoNguoiMuon.get('Agent B')! >= 3 * TI)),
    'BANG gan lo MUON (3 ti) cho A = NGUOI MUON -> KPI vs bang LECH per-dai-ly', `A_bang=${bang.theoNguoiMuon.get('Agent A')} B_bang=${bang.theoNguoiMuon.get('Agent B')}`);

  console.log('\n== S6/S7 POS reconciliation (INACTIVE tid co doanh so) ==');
  const posSumA = (dA?.chiTietPos ?? []).reduce((s, p) => s + p.doanhSoKy, 0);
  info(`A.doanhSo(header)=${dA?.doanhSo} vs Sigma chiTietPos.doanhSoKy=${posSumA} (POS cam: ${dA?.posCam})`);
  // [vá audit F1] BẤT BIẾN: header.doanhSo PHẢI == Σ chiTietPos.doanhSoKy (TID thu hồi có doanh số nay vào chiTiet cờ da_thu_hoi).
  ok(posSumA === dA?.doanhSo, 'BAT BIEN F1: A header doanh so == Sigma POS doanh so (TID thu hoi co doanh so da vao chiTiet)', `header=${dA?.doanhSo} posSum=${posSumA} lech=${(dA?.doanhSo ?? 0) - posSumA}`);
  const coThuHoiA = (dA?.chiTietPos ?? []).some((p) => p.phanLoai === 'da_thu_hoi');
  ok(coThuHoiA, 'F1: T4 INACTIVE co doanh so hien trong chiTiet voi co da_thu_hoi', `coThuHoi=${coThuHoiA}`);
  ok((dA?.posCam ?? 0) === 2, 'A posCam = 2 (T1,T2) - T4 INACTIVE bi loai khoi universe', String(dA?.posCam));

  console.log('\n== S9 lai: KPI tongLai == laiKy replica man Doanh So ==');
  ok(d.tongLai === bang.laiKy, 'KPI tongLai == laiKy (replica) - cung cong thuc', `${d.tongLai} vs ${bang.laiKy}`);

  console.log('\n== S5 BigInt precision (minh hoa) ==');
  const big = 9_007_199_254_740_993; // 2^53 + 1
  info(`Number("${big}") = ${Number(String(big))} (mat +1 neu == 2^53)`);
  ok(true, '(ghi nhan) tongDoanhSo dung Number(SUM::text) - chinh xac khi tong < 2^53 (~9 trieu ti)', '');

  await db.$disconnect(); await c.end();
}

main().catch((e) => { console.error('\n[LOI]', e); loi++; }).finally(async () => {
  try {
    const urlAdmin = new URL(URL_THAT!); urlAdmin.pathname = '/postgres';
    let admin: pg.Client; try { admin = await noi(urlAdmin.toString()); } catch { admin = await noi(URL_THAT!); }
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [TEN_THU]);
    await admin.query(`DROP DATABASE IF EXISTS ${TEN_THU}`); await admin.end();
    console.log(`\n[don] DROP DB thu "${TEN_THU}".`);
  } catch (e) { console.error('[don] khong drop duoc:', e); }
  try { if (existsSync(DUMP)) rmSync(DUMP); } catch { /* skip */ }
  console.log(loi === 0 ? '\n==== TAT CA PASS ====' : `\n==== CO ${loi} ASSERT KHONG DAT (xem **FAIL) ====`);
  process.exit(0);
});
