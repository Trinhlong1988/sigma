// [Admin Demo 14/9 — Báo cáo QR full chức năng CQR] Đối soát TAY + gán đại lý per báo-có (qr_baoco_recon) + báo cáo
// trả manualDs/manualDealer/maChuName + limitWarnings. Test thẳng buildBaoCoReport + SQL upsert (không qua HTTP —
// gate quyền requireAlphaOwner đã test riêng ở owner-gate-routes).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { buildBaoCoReport } from '../src/routes/digistore.js';

const uniq = (p: string): string => `${p}${Math.floor(Math.random() * 1e9).toString(36)}${Date.now().toString(36)}`;

async function taoBaoCo(tidId: number | null, amount: number, atMs: number): Promise<string> {
  const billId = uniq('BILLQA');
  await getBotDb().$executeRawUnsafe(
    `INSERT INTO digistore_baoco (bill_id, qr_code, hkd_name, amount, payer_name, external_ref_no, description, at_ms, status, source_tid_id, fetched_at)
     VALUES ($1, 'QR', 'HKD QA RECON', $2, 'NGUOI QUET QA', $3, 'd', $4, 'success', $5, now())`,
    billId, amount, uniq('REF'), atMs, tidId);
  return billId;
}

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('qr_baoco_recon — đối soát tay + đại lý + report fields', () => {
  it('xác nhận tay → manualDs=true + dealer; bỏ đối soát → ds=false nhưng GIỮ dealer; gán đại lý riêng không đổi ds', async () => {
    const db = getBotDb();
    const at = Date.now() - 3600_000;
    const b1 = await taoBaoCo(null, 1_234_567, at);
    const b2 = await taoBaoCo(null, 2_345_678, at + 60_000);

    // xác nhận 2 GD kèm đại lý (đúng câu SQL route dùng)
    for (const id of [b1, b2]) {
      await db.$executeRawUnsafe(
        `INSERT INTO qr_baoco_recon (bill_id, dealer, ds, by_agent, updated_at) VALUES ($1, $2, true, $3, now())
         ON CONFLICT (bill_id) DO UPDATE SET ds = true, dealer = COALESCE($2, qr_baoco_recon.dealer), by_agent = $3, updated_at = now()`,
        id, 'Mr Nguyễn SG QA', 270);
    }
    let rep = await buildBaoCoReport(at - 10_000, at + 120_000);
    let r1 = rep.rows.find((r) => r.billId === b1);
    expect(r1?.manualDs).toBe(true);
    expect(r1?.manualDealer).toBe('Mr Nguyễn SG QA');

    // bỏ đối soát b1 → ds=false, dealer GIỮ
    await db.$executeRawUnsafe(
      `INSERT INTO qr_baoco_recon (bill_id, dealer, ds, by_agent, updated_at) VALUES ($1, $2, false, $3, now())
       ON CONFLICT (bill_id) DO UPDATE SET ds = false, by_agent = $3, updated_at = now()`,
      b1, null, 270);
    rep = await buildBaoCoReport(at - 10_000, at + 120_000);
    r1 = rep.rows.find((r) => r.billId === b1);
    expect(r1?.manualDs).toBe(false);
    expect(r1?.manualDealer).toBe('Mr Nguyễn SG QA'); // giữ đại lý khi bỏ đối soát

    // gán đại lý GD chưa có bản ghi (b3) → ds=false (không tự xanh — bug CQR 14/9 đã học)
    const b3 = await taoBaoCo(null, 3_456_789, at + 120_000 - 1);
    await db.$executeRawUnsafe(
      `INSERT INTO qr_baoco_recon (bill_id, dealer, ds, by_agent, updated_at) VALUES ($1, $2, false, $3, now())
       ON CONFLICT (bill_id) DO UPDATE SET dealer = $2, by_agent = $3, updated_at = now()`,
      b3, 'Bảo SG QA', 270);
    rep = await buildBaoCoReport(at - 10_000, at + 120_000);
    const r3 = rep.rows.find((r) => r.billId === b3);
    expect(r3?.manualDs).toBe(false);
    expect(r3?.manualDealer).toBe('Bảo SG QA');
  });

  it('maChuName = chủ mã (customers.nickname) khi báo-có có source_tid_id; limitWarnings bắn khi doanh số ngày ≥ hạn mức', async () => {
    const db = getBotDb();
    const bank = await db.bank.create({ data: { name: uniq('BK'), code: uniq('B').slice(0, 18) } });
    const cu = await db.customer.create({ data: { code: uniq('KHQA').slice(0, 18), fullName: 'Khách QA Recon', nickname: 'Đại Lý QA Recon' } });
    const t = await db.tid.create({ data: { tid: uniq('QRR-').slice(0, 24), hkdName: 'HKD QA RECON', bankId: bank.id, customerId: cu.id } });
    await db.$executeRawUnsafe(`UPDATE tids SET kind = 'QR' WHERE id = $1`, t.id);
    const at = Date.now() - 7200_000;
    const b = await taoBaoCo(t.id, 500_000_000, at);

    // hạn mức 450tr cho mã này (đúng key app_settings route dùng)
    const curRaw = await db.appSetting.findUnique({ where: { key: 'qr.dailyLimit' } });
    const cur = curRaw?.value ? (JSON.parse(curRaw.value) as Record<string, number>) : {};
    cur[t.id] = 450_000_000;
    const value = JSON.stringify(cur);
    await db.appSetting.upsert({ where: { key: 'qr.dailyLimit' }, update: { value }, create: { key: 'qr.dailyLimit', value } });

    const rep = await buildBaoCoReport(at - 10_000, at + 60_000, { tid: t.id });
    const row = rep.rows.find((r) => r.billId === b);
    expect(row?.maChuName).toBe('Đại Lý QA Recon');
    expect(row?.sourceTidId).toBe(t.id);
    const w = rep.limitWarnings.find((x) => x.tidId === t.id);
    expect(w).toBeTruthy();
    expect(w!.doanhSo).toBeGreaterThanOrEqual(450_000_000);
    expect(w!.limit).toBe(450_000_000);

    // dọn hạn mức QA khỏi setting (không bẩn config dùng chung)
    delete cur[t.id];
    await db.appSetting.update({ where: { key: 'qr.dailyLimit' }, data: { value: JSON.stringify(cur) } });
  });
});
