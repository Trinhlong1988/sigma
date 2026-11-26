// [Nợ C3 11/9] SỬA tham số tạm ứng/hoàn NĐT theo investor_advances.id (nguồn tiền duy nhất). Test 2 CHIỀU trên
// throwaway Postgres qua CHÍNH ingest + edit + báo cáo (không tính lại tiền tay).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema, investorDailyReport } from '@sigma/services';
import type { AuthUser } from '@sigma/shared';
import { getBotDb } from '../src/db.js';
import { ingestInvestorAdvance, editInvestorAdvanceParams } from '../src/investor-advance-ingest.js';

// [14/9 FIX time-bomb] random TRƯỚC timestamp — slice(0,16) từng cắt mất random → ref TRÙNG trong cùng lần chạy
// → ingest dedupe trả row test trước (3,5tr thay 2tr). Base36 gọn: prefix + 6 random + timestamp đảo.
const uniq = (p: string): string => `${p}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`;
const USER: AuthUser = { id: 0, username: 't', fullName: 'T', status: 'ACTIVE', forceChangePassword: false, roles: [], permissions: ['REVENUE_VIEW', 'INVESTOR_VIEW'] };

async function makeInv(): Promise<number> {
  const db = getBotDb();
  const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: 'NĐT edit', nickname: uniq('nv').slice(0, 18), status: 'ACTIVE', investFeeMilli: 0 } });
  return inv.id;
}
beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('editInvestorAdvanceParams — sửa ngày/giờ/tiền tạm ứng NĐT', () => {
  it('CHIỀU ĐÚNG: đổi tiền 5tr→6tr + đổi ngày → row đổi + settlement/report phản ánh đúng kỳ mới', async () => {
    const db = getBotDb();
    const inv = await makeInv();
    const rec = await ingestInvestorAdvance(db, { investorId: inv, receiverName: 'KHACH HANG 01', amount: 5_000_000, ref: uniq('FTED').slice(0, 16), advanceDateIso: '2026-09-10T09:00:00+07:00' });
    expect(rec.action).toBe('recorded');
    const id = (rec as { id: number }).id;
    const r = await editInvestorAdvanceParams(db, { advanceId: id, patch: { amount: 6_000_000, advanceDate: '2026-09-09', advanceTime: '21:30' } });
    expect(r.ok).toBe(true);
    // Row THẬT trong DB: instant = 21:30 +07 ngày 09/9 (kiểm bằng to_char — né bẫy đọc).
    const row = await db.$queryRawUnsafe<{ amount: bigint; hcm: string }[]>(
      `SELECT amount, to_char(advance_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI') AS hcm FROM investor_advances WHERE id = $1`, id);
    expect(Number(row[0].amount)).toBe(6_000_000);
    expect(row[0].hcm).toBe('2026-09-09 21:30');
    // Báo cáo kỳ 09/9 thấy 6tr; kỳ 10/9 KHÔNG còn.
    const rep9 = await investorDailyReport({ db, user: USER }, { investorId: inv, from: '2026-09-09', to: '2026-09-09' });
    expect(rep9.ok).toBe(true);
    const dn9 = await db.$queryRawUnsafe<{ s: bigint }[]>(`SELECT COALESCE(SUM(amount),0)::bigint AS s FROM investor_advances WHERE investor_id=$1 AND advance_date >= '2026-09-09T00:00:00+07:00'::timestamptz AND advance_date < '2026-09-10T00:00:00+07:00'::timestamptz AND deleted_at IS NULL`, inv);
    expect(Number(dn9[0].s)).toBe(6_000_000);
  });
  it('CHIỀU ĐÚNG: chỉ đổi TIỀN → ngày giờ GIỮ NGUYÊN', async () => {
    const db = getBotDb();
    const inv = await makeInv();
    const rec = await ingestInvestorAdvance(db, { investorId: inv, receiverName: 'KHACH HANG 01', amount: 3_000_000, ref: uniq('FTED').slice(0, 16), advanceDateIso: '2026-09-10T14:45:00+07:00' });
    const id = (rec as { id: number }).id;
    const r = await editInvestorAdvanceParams(db, { advanceId: id, patch: { amount: 3_500_000 } });
    expect(r.ok).toBe(true);
    const row = await db.$queryRawUnsafe<{ hcm: string }[]>(
      `SELECT to_char(advance_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI') AS hcm FROM investor_advances WHERE id = $1`, id);
    expect(row[0].hcm).toBe('2026-09-10 14:45');
  });
  it('CHIỀU SAI: tiền ≤0 / ngày sai dạng / id không tồn tại → lỗi rõ, KHÔNG ghi', async () => {
    const db = getBotDb();
    const inv = await makeInv();
    const rec = await ingestInvestorAdvance(db, { investorId: inv, receiverName: 'KHACH HANG 01', amount: 2_000_000, ref: uniq('FTED').slice(0, 16), advanceDateIso: '2026-09-10T08:00:00+07:00' });
    const id = (rec as { id: number }).id;
    const r1 = await editInvestorAdvanceParams(db, { advanceId: id, patch: { amount: -5 } });
    expect(r1.ok).toBe(false);
    const r2 = await editInvestorAdvanceParams(db, { advanceId: id, patch: { advanceDate: '10/09/2026' } });
    expect(r2.ok).toBe(false);
    const r3 = await editInvestorAdvanceParams(db, { advanceId: 99_999_999, patch: { amount: 1_000_000 } });
    expect(r3.ok).toBe(false);
    const row = await db.$queryRawUnsafe<{ amount: bigint }[]>(`SELECT amount FROM investor_advances WHERE id = $1`, id);
    expect(Number(row[0].amount)).toBe(2_000_000); // không đổi
  });
  it('ĐỒNG BỘ TIN CHAT best-effort: meta + caption đổi theo tiền mới (tìm theo image_hash)', async () => {
    const db = getBotDb();
    const inv = await makeInv();
    const hash = uniq('HASHED').slice(0, 24);
    const rec = await ingestInvestorAdvance(db, { investorId: inv, receiverName: 'KHACH HANG 01', amount: 4_000_000, imageHash: hash, advanceDateIso: '2026-09-10T10:00:00+07:00' });
    const id = (rec as { id: number }).id;
    const room = await db.chatRoom.create({ data: { type: 'GROUP', name: uniq('NĐT ') } });
    const agent = await db.agent.create({ data: { code: uniq('AG').slice(0, 16), name: 'Bot' } });
    const msg = await db.chatMessage.create({ data: { roomId: room.id, senderId: agent.id, kind: 'IMAGE', body: `💰 TẠM ỨNG NĐT · ${(4_000_000).toLocaleString('vi-VN')}đ · 10/09/2026`, metadataJson: JSON.stringify({ isTransferRefund: true, isInvestorAdvanceCk: true, advanceAmount: 4_000_000, ocrImageHash: hash, investorId: inv }) } });
    const r = await editInvestorAdvanceParams(db, { advanceId: id, patch: { amount: 4_444_000 } });
    expect(r.ok).toBe(true);
    const m2 = await db.chatMessage.findUnique({ where: { id: msg.id }, select: { body: true, metadataJson: true } });
    expect(m2?.body).toContain('4.444.000đ');
    expect(JSON.parse(m2?.metadataJson ?? '{}').advanceAmount).toBe(4_444_000);
  });
});
