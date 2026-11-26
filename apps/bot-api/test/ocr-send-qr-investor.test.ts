// CC BILL QR SANG NHÓM NĐT (Admin Demo 5/9) — mã QR → receiveAccountId → investor → phòng NĐT; đăng ảnh bill + tóm tắt
// (KHÔNG phí/tên đại lý). Regression THẬT trên throwaway Postgres. Khẳng định:
//  (a) resolveInvestorRoomByReceiveAccount: receiveAccount(investorId) + investorChatGroup(active,có phòng) → roomId;
//      chưa uỷ / TK không có investor / nhóm unassigned → null (route bỏ cc, KHÔNG chặn).
//  (b) sendQrToInvestor: đăng 1 tin ẢNH + caption KHÔNG lộ phí bán/%/tên đại lý; idempotent (lần 2 = deduped).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { resolveInvestorRoomByReceiveAccount, sendQrToInvestor, toIsoBillDay, fmtDayDisplay } from '../src/ocr-send-service.js';
import { makeBank, makeChatRoom, makeReceiveAccountSource } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
// PNG 1x1 hợp lệ (saveAttachment sniff magic-bytes THẬT → cần ảnh thật, không nhận buffer rác).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function makeInvestorWithRoom(): Promise<{ investorId: number; receiveAccountId: number; roomId: string }> {
  const db = getBotDb();
  const bank = await makeBank();
  const src = await makeReceiveAccountSource();
  const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: 'NĐT CC', nickname: uniq('nv').slice(0, 18), status: 'ACTIVE', investFeeMilli: 0 } });
  const ra = await db.receiveAccount.create({ data: { sourceId: src.id, bankId: bank.id, accountName: 'TK CC', accountNumber: uniq('AC').slice(0, 18), investorId: inv.id } });
  const room = await makeChatRoom({ type: 'GROUP', name: uniq('NĐT ') });
  await db.investorChatGroup.create({ data: { investorId: inv.id, roomId: room.id } });
  return { investorId: inv.id, receiveAccountId: ra.id, roomId: room.id };
}

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('resolveInvestorRoomByReceiveAccount', () => {
  it('(a) receiveAccount có investor + nhóm active → roomId', async () => {
    const db = getBotDb();
    const { receiveAccountId, roomId } = await makeInvestorWithRoom();
    expect(await resolveInvestorRoomByReceiveAccount(db, receiveAccountId)).toBe(roomId);
  });
  it('(a) null/không investor → null (không cc, không lỗi)', async () => {
    const db = getBotDb();
    expect(await resolveInvestorRoomByReceiveAccount(db, null)).toBeNull();
    const bank = await makeBank();
    const src = await makeReceiveAccountSource();
    const raNoInv = await db.receiveAccount.create({ data: { sourceId: src.id, bankId: bank.id, accountName: 'TK', accountNumber: uniq('AC').slice(0, 18) } });
    expect(await resolveInvestorRoomByReceiveAccount(db, raNoInv.id)).toBeNull();
  });
  it('(a) nhóm NĐT đã unassign → null', async () => {
    const db = getBotDb();
    const bank = await makeBank();
    const src = await makeReceiveAccountSource();
    const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: 'NĐT off', nickname: uniq('nv').slice(0, 18), status: 'ACTIVE' } });
    const ra = await db.receiveAccount.create({ data: { sourceId: src.id, bankId: bank.id, accountName: 'TK', accountNumber: uniq('AC').slice(0, 18), investorId: inv.id } });
    const room = await makeChatRoom({ type: 'GROUP', name: uniq('NĐT off ') });
    await db.investorChatGroup.create({ data: { investorId: inv.id, roomId: room.id, unassignedAt: new Date() } });
    expect(await resolveInvestorRoomByReceiveAccount(db, ra.id)).toBeNull();
  });
});

describe('sendQrToInvestor — cc ảnh bill (idempotent, không lộ phí)', () => {
  it('(b) đăng 1 tin ẢNH + caption không chứa phí/tên đại lý; lần 2 deduped', async () => {
    const db = getBotDb();
    const { roomId } = await makeInvestorWithRoom();
    const ref = uniq('CCREF');
    const r1 = await sendQrToInvestor(db, { investorRoomId: roomId, ref, amount: 7_000_000, billDate: '10/09/2026', hkdName: 'HKD CC TEST', imageBuffer: PNG, imageName: 'bill.png' });
    expect(r1.ok).toBe(true);
    expect(r1.messageId).toBeTruthy();
    expect(r1.deduped).not.toBe(true);
    // Lần 2 cùng ref+amount → dedup (KHÔNG đăng tin thứ 2).
    const r2 = await sendQrToInvestor(db, { investorRoomId: roomId, ref, amount: 7_000_000, billDate: '10/09/2026', hkdName: 'HKD CC TEST', imageBuffer: PNG, imageName: 'bill.png' });
    expect(r2.ok).toBe(true);
    expect(r2.deduped).toBe(true);

    const msgs = await db.chatMessage.findMany({ where: { roomId, deletedAt: null, metadataJson: { contains: '"isQrInvestorCc":true' } }, select: { body: true, metadataJson: true } });
    expect(msgs).toHaveLength(1); // chỉ 1 tin dù gọi 2 lần
    const m = msgs[0];
    expect(m.body).toContain('HKD CC TEST');
    expect(m.body).toContain('7.000.000');
    expect(m.body).toContain(ref);
    // Bảo mật 2 chiều: KHÔNG lộ phí bán/%/tên đại lý/hoàn.
    expect(m.body).not.toMatch(/phí|hoàn|%|đại lý/i);
    expect(m.metadataJson ?? '').not.toMatch(/sellFee|refundAmount|dealer/i);
    // [Admin Demo 7/9 REGRESSION] GỐC bug hoàn QR "sửa ngày mà không ghi nhận": billDate truyền dd/mm/yyyy '10/09/2026'
    // → metadata PHẢI lưu ISO '2026-09-10' (đối soát nhóm ngày theo ISO). Caption vẫn hiển thị dd/mm/yyyy.
    const meta = JSON.parse(m.metadataJson ?? '{}') as { billDate?: string };
    expect(meta.billDate).toBe('2026-09-10');
    expect(m.body).toContain('10/09/2026'); // caption giữ dd/mm/yyyy cho user
  });
});

describe('[Admin Demo 7/9] toIsoBillDay / fmtDayDisplay — chuẩn hoá ngày bill (GỐC bug hoàn QR)', () => {
  it('toIsoBillDay: dd/mm/yyyy → ISO, ISO giữ nguyên, kèm giờ vẫn ra ngày, rác → null', () => {
    expect(toIsoBillDay('05/09/2026')).toBe('2026-09-05');
    expect(toIsoBillDay('5/9/2026')).toBe('2026-09-05');
    expect(toIsoBillDay('2026-09-05')).toBe('2026-09-05');
    expect(toIsoBillDay('2026-09-05 09:17')).toBe('2026-09-05');
    expect(toIsoBillDay('05/09/2026 09:17')).toBe('2026-09-05');
    expect(toIsoBillDay(null)).toBeNull();
    expect(toIsoBillDay('linh tinh')).toBeNull();
  });
  it('fmtDayDisplay: ISO → dd/mm/yyyy cho caption; dd/mm/yyyy giữ nguyên', () => {
    expect(fmtDayDisplay('2026-09-05')).toBe('05/09/2026');
    expect(fmtDayDisplay('05/09/2026')).toBe('05/09/2026');
    expect(fmtDayDisplay(null)).toBeNull();
  });
  it('bất biến so-chuỗi: ISO ngày RƠI trong cửa sổ [from,to) ISO; dd/mm/yyyy thì KHÔNG (đây là gốc lỗi)', () => {
    const from = '2026-09-05', to = '2026-09-06';
    const iso = toIsoBillDay('05/09/2026')!;
    expect(iso >= from && iso < to).toBe(true);       // sau fix: khớp đúng ngày
    expect('05/09/2026' >= from && '05/09/2026' < to).toBe(false); // trước fix: rơi ngoài → "không ghi nhận"
  });
});
