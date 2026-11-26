// [Admin Demo — BỘ LỌC CA TIỀN 1/2/3, làm 11/9] Lọc doanh số NĐT theo CA (giờ TỔNG KẾT BILL, giờ HCM, bảng mốc
// chính chủ ca-tien.ts: MBV ca1≤11:50 · ca2≤17:50 · ca3 sau đó). Test 2 CHIỀU trên throwaway Postgres, qua CHÍNH
// investorReportDetail + investorDailyReport (nguồn tiền duy nhất — không tính lại):
//   CHIỀU ĐÚNG: ca=N chỉ trả bill đúng ca N (giờ HCM, không lệch TZ); không truyền ca → đủ 3 bill.
//   CHIỀU SAI:  bank NGOÀI bảng mốc (không MB/ABB/MBV) → lọc ca loại hết (không gán ca bừa).
// NGUỒN GIỜ = los.bill_txn_date (GIỜ BILL THẬT, ghi raw-SQL). transactions.txn_date do Prisma ghi LỆCH −7h (bằng
// chứng prod 10/9: bill 12:31 → txn_date 05:31) — test mô phỏng đúng thực tế đó: txn_date = giờ bill − 7h.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema, investorReportDetail, investorDailyReport } from '@sigma/services';
import type { AuthUser } from '@sigma/shared';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeReceiveAccountSource } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const USER: AuthUser = { id: 0, username: 'test', fullName: 'Test', status: 'ACTIVE', forceChangePassword: false, roles: [], permissions: ['REVENUE_VIEW', 'INVESTOR_VIEW'] };
/** Instant UTC của giờ HCM hh:mm ngày 10/09/2026 (HCM = UTC+7). */
const hcm = (hhmm: string): Date => new Date(`2026-09-10T${hhmm}:00+07:00`);
const DAY = '2026-09-10';

async function setup(bankName: string, bankCode?: string): Promise<{ investorId: number; tidId: number }> {
  const db = getBotDb();
  const bank = await db.bank.create({ data: { name: bankName, code: bankCode ?? uniq('BK').slice(0, 20) } });
  const src = await makeReceiveAccountSource();
  const agent = await makeAgent();
  const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: 'NĐT ca-tien', nickname: uniq('nv').slice(0, 18), status: 'ACTIVE', investFeeMilli: 100 } });
  const ra = await db.receiveAccount.create({ data: { sourceId: src.id, bankId: bank.id, accountName: 'TK ca', accountNumber: uniq('AC').slice(0, 18), investorId: inv.id } });
  const tid = await db.tid.create({ data: { tid: uniq('9').slice(-12), hkdName: 'HKD DEMO 52', bankId: bank.id, receiveAccountId: ra.id } });
  // 3 bill 3 ca theo mốc MBV: 10:00 (ca1) · 15:00 (ca2) · 19:00 (ca3) — GIỜ BILL trên los.bill_txn_date (raw SQL,
  // đúng giờ HCM như prod); txn_date mô phỏng đúng bệnh Prisma −7h.
  for (const [t, amt] of [['10:00', 1_000_000n], ['15:00', 2_000_000n], ['19:00', 3_000_000n]] as const) {
    // txnDate truyền THẲNG instant giờ bill — chính Prisma write đã lệch −7h (như prod), KHÔNG trừ tay thêm (kép).
    const tx = await db.transaction.create({ data: { code: 'GD' + uniq('').slice(-9), tidId: tid.id, amount: amt, txnDate: hcm(t) } });
    await db.$executeRawUnsafe(
      `INSERT INTO los (agent_id, transaction_id, bill_txn_date, status, expected_total_amount, created_at, updated_at) VALUES ($1, $2, $3::timestamptz, 'CONFIRMED', 0, now(), now())`,
      agent.id, tx.id, hcm(t).toISOString());
  }
  return { investorId: inv.id, tidId: tid.id };
}

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('investorReportDetail — lọc ca tiền', () => {
  it('CHIỀU ĐÚNG: MBV ca 1/2/3 trả đúng từng bill; không ca → đủ 3', async () => {
    const db = getBotDb();
    const { investorId } = await setup(`MBV ${uniq('x')}`);
    const all = await investorReportDetail({ db, user: USER }, { investorId, from: DAY, to: DAY });
    expect(all.ok).toBe(true);
    expect(all.data?.bills.length).toBe(3);
    for (const [ca, amt] of [[1, 1_000_000], [2, 2_000_000], [3, 3_000_000]] as const) {
      const r = await investorReportDetail({ db, user: USER }, { investorId, from: DAY, to: DAY, ca });
      expect(r.ok).toBe(true);
      expect(r.data?.bills.map((b) => b.amount)).toEqual([amt]); // đúng 1 bill của ca đó, giờ HCM không lệch TZ
    }
  });
  it('CHIỀU SAI: bank NGOÀI bảng mốc (VP…) → lọc ca loại hết (không gán ca bừa); không ca vẫn đủ', async () => {
    const db = getBotDb();
    const { investorId } = await setup(`VP ${uniq('y')}`);
    const all = await investorReportDetail({ db, user: USER }, { investorId, from: DAY, to: DAY });
    expect(all.data?.bills.length).toBe(3);
    const r = await investorReportDetail({ db, user: USER }, { investorId, from: DAY, to: DAY, ca: 1 });
    expect(r.ok).toBe(true);
    expect(r.data?.bills.length ?? 0).toBe(0);
  });
});

// [B174b 16/11 — chiều DỮ LIỆU THẬT, bộ test cũ KHÔNG phủ nên bug lọt CÂM nhiều tuần]
// Trên sổ thật thì NGƯỢC với 2 bài trên: `banks.code` mới là MB/MBV/ABB, còn `banks.name` là TÊN PHÁP NHÂN
// ("NH TNHH MTV Việt Nam Hiện đại MBV") — `khoaBankCa(name)` trả null cho CẢ BA ngân hàng. Đo thật 16/11:
// 95 TID MBV + 12 TID MB nằm ở các bank mà CHỈ `code` tra được ca. Bài kiểm này khoá chiều đó: lọc ca phải
// CHẠY khi dấu hiệu ngân hàng nằm ở MÃ, và vẫn KHÔNG gán ca bừa khi cả mã lẫn tên đều ngoài bảng mốc.
describe('investorReportDetail — lọc ca khi dấu hiệu ngân hàng nằm ở MÃ (như sổ thật)', () => {
  it('code=MBV… + name=tên pháp nhân → ca 1/2/3 vẫn trả đúng từng bill', async () => {
    const db = getBotDb();
    const { investorId } = await setup('NH TNHH MTV Việt Nam Hiện đại MBV', uniq('MBV').slice(0, 20));
    const all = await investorReportDetail({ db, user: USER }, { investorId, from: DAY, to: DAY });
    expect(all.data?.bills.length).toBe(3);
    for (const [ca, amt] of [[1, 1_000_000], [2, 2_000_000], [3, 3_000_000]] as const) {
      const r = await investorReportDetail({ db, user: USER }, { investorId, from: DAY, to: DAY, ca });
      expect(r.data?.bills.map((b) => b.amount)).toEqual([amt]);
    }
  });
  it('ĐỐI CHỨNG: mã lẫn tên đều ngoài bảng mốc → lọc ca vẫn loại hết (không gán bừa)', async () => {
    const db = getBotDb();
    const { investorId } = await setup('NH TMCP Việt Nam Thịnh vượng VP', uniq('VP').slice(0, 20));
    const all = await investorReportDetail({ db, user: USER }, { investorId, from: DAY, to: DAY });
    expect(all.data?.bills.length).toBe(3);
    const r = await investorReportDetail({ db, user: USER }, { investorId, from: DAY, to: DAY, ca: 1 });
    expect(r.data?.bills.length ?? 0).toBe(0);
  });
});

describe('investorDailyReport — lọc ca tiền (tổng hợp khớp chi tiết)', () => {
  it('ca=2 → doanhThu đúng bill 15:00; không ca → tổng 3 bill', async () => {
    const db = getBotDb();
    const { investorId } = await setup(`MBV ${uniq('z')}`);
    const all = await investorDailyReport({ db, user: USER }, { investorId, from: DAY, to: DAY });
    expect(all.ok).toBe(true);
    const rowAll = (all.data ?? []).find((r) => r.investorId === investorId);
    expect(rowAll?.doanhThu).toBe(6_000_000);
    const ca2 = await investorDailyReport({ db, user: USER }, { investorId, from: DAY, to: DAY, ca: 2 });
    const row2 = (ca2.data ?? []).find((r) => r.investorId === investorId);
    expect(row2?.doanhThu).toBe(2_000_000);
    expect(row2?.soBill).toBe(1);
  });
});
