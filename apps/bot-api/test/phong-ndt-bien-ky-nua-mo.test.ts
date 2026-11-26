// [Admin Demo 27/9 "chọn ngày hôm qua → ra vẫn sai" + "sao lô 27 nhảy vào ngày 26"] KHOÁ BIÊN KỲ của màn
// "Doanh số · <phòng NĐT>".
//
// LỖI THẬT: client (RoomRevenueScreen.periodRange) gửi khoảng NỬA MỞ [from, to) — "Hôm qua" =
// [00:00 ngày 26, 00:00 ngày 27). `roomInvestorRevenue` đổi sang chuỗi ngày bằng localDateStr(to) ⇒
// toDay = "2026-09-27", mà investorDailyReport nhận kỳ BAO GỒM CẢ HAI ĐẦU ⇒ bảng "hôm qua" GỘP LUÔN
// ngày hôm nay. Đo thật phòng "NĐT 1": hôm qua ra 11 bill (26+27) thay vì 8 bill của riêng ngày 26.
// Cùng một lỗi làm người dùng thấy "lô ngày 27 nhảy vào bảng ngày 26".
//
// LUẬT: ngày cuối THỰC của kỳ = ngày của thời điểm ngay TRƯỚC `to` (to - 1ms).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { roomInvestorRevenue } from '../src/routes/me-investor-report.js';
import { getBotDb } from '../src/db.js';
import { makeBank, makeCardType, makeTid, makePartner, makeCustomer, defaultFeeTypeForQuote, makeFeeRate, makeTidSellFee, makeChatRoom, makeAgent } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

/** 1 phòng NĐT có 2 GD: một của NGÀY A, một của NGÀY B (hôm sau). */
async function dung(ngayA: string, ngayB: string) {
  const db = getBotDb();
  const bank = await makeBank();
  const cardType = await makeCardType(bank.id);
  const feeType = await defaultFeeTypeForQuote();
  const partner = await makePartner();
  const kh = await makeCustomer();
  const agent = await makeAgent();
  const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), nickname: uniq('NDT '), fullName: uniq('NDT ') } });
  const ra = await db.receiveAccount.create({ data: { investorId: inv.id, accountName: uniq('TK '), accountNumber: uniq('7'), bankId: bank.id, sourceId: 5, updatedAt: new Date() } });
  const room = await makeChatRoom({ type: 'GROUP', name: uniq('NDT BIEN ') });
  await db.chatRoomMember.create({ data: { roomId: room.id, agentId: agent.id } });
  await db.investorChatGroup.create({ data: { investorId: inv.id, roomId: room.id } });
  const tid = await makeTid({ tid: `95${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, customerId: kh.id, bankId: bank.id, partnerId: partner.id, hkdName: uniq('HKD BIEN ') });
  await db.$executeRawUnsafe(`UPDATE tids SET receive_account_id=$1, invest_fee_milli=1000 WHERE id=$2`, ra.id, tid.id);
  await makeFeeRate({ partnerId: partner.id, cardTypeId: cardType.id, phiMua: 1000, phiCaiMay: 1000 });
  await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1500 });
  for (const [iso, tien] of [[`${ngayA}T10:00:00+07:00`, 10_000_000], [`${ngayB}T10:00:00+07:00`, 70_000_000]] as [string, number][]) {
    const gd = await db.$queryRawUnsafe<{ id: number }[]>(
      `INSERT INTO transactions (code, tid_id, customer_id, card_type_id, fee_type_id, amount, partner_margin_milli,
         sell_margin_milli, phi_cai_may_milli, revenue_partner, revenue_sell, revenue_amount, txn_date, status, settled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, 0, 500, 1000, 0, 50000, 50000, $7::timestamptz, 'POSTED', false, now(), now()) RETURNING id`,
      uniq('GD'), tid.id, kh.id, cardType.id, feeType.id, tien, iso);
    await db.$executeRawUnsafe(
      `INSERT INTO los (agent_id, expected_total_amount, status, transaction_id, bill_txn_date, created_at, updated_at)
       VALUES (1, $1, 'PENDING', $2, $3::timestamptz, now(), now())`, tien, gd[0]!.id, iso);
  }
  return { db, inv, room, agent, tien: { A: 10_000_000, B: 70_000_000 } };
}

const bien = (ngay: string) => new Date(`${ngay}T00:00:00+07:00`);

describe('màn Doanh số phòng NĐT — khoảng NỬA MỞ [from, to), không gộp ngày hôm sau', () => {
  it('"Hôm qua" = [đầu 26, đầu 27) → CHỈ tính ngày 26, KHÔNG gộp ngày 27', async () => {
    const w = await dung('2026-04-26', '2026-04-27');
    const r = await roomInvestorRevenue(w.db, w.agent.id, w.room.id, bien('2026-04-26'), bien('2026-04-27'));
    expect(r, 'phải trả được khối NĐT cho phòng NĐT').toBeTruthy();
    expect(r!.to, 'ngày cuối kỳ phải là 26, không phải 27').toBe('2026-04-26');
    expect(r!.soBill).toBe(1);
    expect(r!.doanhThu).toBe(w.tien.A);
  });

  it('"Hôm nay" = [đầu 27, đầu 28) → chỉ ngày 27', async () => {
    const w = await dung('2026-04-26', '2026-04-27');
    const r = await roomInvestorRevenue(w.db, w.agent.id, w.room.id, bien('2026-04-27'), bien('2026-04-28'));
    expect(r!.from).toBe('2026-04-27');
    expect(r!.to).toBe('2026-04-27');
    expect(r!.soBill).toBe(1);
    expect(r!.doanhThu).toBe(w.tien.B);
  });

  it('khoảng NHIỀU NGÀY [đầu 26, đầu 28) → gộp đúng 2 ngày, không hụt không thừa', async () => {
    const w = await dung('2026-04-26', '2026-04-27');
    const r = await roomInvestorRevenue(w.db, w.agent.id, w.room.id, bien('2026-04-26'), bien('2026-04-28'));
    expect(r!.from).toBe('2026-04-26');
    expect(r!.to).toBe('2026-04-27');
    expect(r!.soBill).toBe(2);
    expect(r!.doanhThu).toBe(w.tien.A + w.tien.B);
  });
});
