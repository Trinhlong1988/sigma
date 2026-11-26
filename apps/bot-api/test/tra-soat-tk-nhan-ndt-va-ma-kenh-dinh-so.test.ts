// [Admin Demo 26/9 "tài khoản tech nhận báo có từ NĐT Huy" + "của anh Huy làm C hết đi"] KHOÁ 2 lỗi THẬT.
//
// CA THẬT ngày 25/9 — TK Techcombank 1900668888 (Nhân viên B):
//  (1) Sao kê TCB KHÔNG ghi tên người gửi cho tiền VÀO (nội dung gốc chỉ "CK107948 CK107947") ⇒ 23 GD /
//      2.501.602.000đ của NĐT NĐT 1 rơi UNKNOWN, tra soát không lọc được. Khoá duy nhất còn lại là TÀI
//      KHOẢN SIGMA NHẬN ⇒ ánh xạ statement_dealer_alias key_kind='src_acct_noname' → investor_id.
//      RÀNG BUỘC SỐNG CÒN: chỉ áp khi đối ứng KHÔNG CÓ TÊN. Có tên thì TÊN THẮNG — nếu không sẽ lặp lại
//      vụ 1 bill lạc kéo 79 GD / 20,7 tỷ về nhầm sổ.
//  (2) MB chèn mã kênh DÍNH SỐ ("Qaiuif6322", "APPMB1") ⇒ regex cắt dùng \b sau F/B không khớp (F↔6, B↔1
//      đều là ký tự từ) ⇒ tên trích ra là cả chuỗi rác ⇒ 4 GD KT Demo tự chuyển (884.242.000đ) không nhận
//      ra "chuyển giữa TK", đứng ngoài sổ.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { reconcileStatement, extractDescName } from '../src/statement-recon.js';
import { getBotDb } from '../src/db.js';
import { makeBank } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

/** 1 NĐT + ánh xạ "TK SigMa nhận → NĐT này" (khuôn TK Techcombank của KT Demo). */
async function dung() {
  const db = getBotDb();
  const bank = await makeBank();
  const ten = uniq('NDT TECH ');
  const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), nickname: uniq('NDT '), fullName: ten } });
  await db.receiveAccount.create({ data: { investorId: inv.id, accountName: ten, accountNumber: uniq('8'), bankId: bank.id, sourceId: 5, updatedAt: new Date() } });
  const tkNhan = String(1_900_000_000 + Math.floor(Math.random() * 1e8));
  await db.$executeRawUnsafe(
    `INSERT INTO statement_dealer_alias (key, key_kind, customer_id, investor_id, note)
     VALUES ($1, 'src_acct_noname', NULL, $2, 'test') ON CONFLICT (key, key_kind) DO UPDATE SET investor_id = EXCLUDED.investor_id`,
    tkNhan, inv.id);
  return { db, inv, tkNhan };
}
/** Sao kê TCB: tiền vào KHÔNG có tên đối tác (đúng đặc thù file thật). */
const saoKe = (tkNhan: string, over: Partial<Record<string, unknown>> = {}) => ({
  accountHolder: 'KHACH HANG 01', accountNumber: tkNhan, accountBank: 'TCB',
  txns: [{ rowIndex: 1, dateTime: '2026-09-25T00:00:00', ref: uniq('FT'), debit: 0, credit: 420_830_000,
    desc: 'CK107948 CK107947', cpName: null, cpAccount: null, cpBank: 'NGAN HANG TMCP TIEN PHONG (TPBANK)',
    descName: null, ...over }]
});

describe('tra soát — khoá TK NHẬN cho GD không tên (sao kê Techcombank)', () => {
  it('tiền vào KHÔNG tên + TK nhận đã ánh xạ → về ĐÚNG NĐT, kind INVESTOR_ADVANCE', async () => {
    const w = await dung();
    const r = await reconcileStatement(w.db, saoKe(w.tkNhan) as never);
    const t = r.txns[0]!;
    expect(t.matchedInvestorId, 'phải gán NĐT đã khai').toBe(w.inv.id);
    expect(t.kind).toBe('INVESTOR_ADVANCE');
    expect(t.matchedCustomerId).toBeNull();
  });

  it('CÙNG TK nhận nhưng đối ứng CÓ TÊN người khác → KHÔNG được kéo về NĐT đó', async () => {
    const w = await dung();
    const r = await reconcileStatement(w.db, saoKe(w.tkNhan, { cpName: 'NGUYEN VAN NGUOI LA', cpAccount: '99887766' }) as never);
    expect(r.txns[0]!.matchedInvestorId, 'có tên thì TÊN THẮNG, không dùng khoá TK nhận').not.toBe(w.inv.id);
  });

  it('TK nhận CHƯA ánh xạ → vẫn UNKNOWN, không đoán bừa', async () => {
    const w = await dung();
    const r = await reconcileStatement(w.db, saoKe(String(1_700_000_000 + Math.floor(Math.random() * 1e8))) as never);
    expect(r.txns[0]!.matchedInvestorId).toBeNull();
  });
});

describe('bóc tên — mã kênh MB DÍNH SỐ vẫn phải cắt được', () => {
  it('"KHACH HANG 01 Qaiuif6322  APPMB1 1  KHACH HANG 01 chuyen tien FT..." → "KHACH HANG 01"', () => {
    const s = extractDescName('KHACH HANG 01 Qaiuif6322  APPMB1 1  KHACH HANG 01 chuyen tien FT26268764896301 k2MK 76KD/630797');
    expect(String(s).toUpperCase().replace(/\s+/g, ' ').trim()).toBe('KHACH HANG 01');
  });

  it('mã kênh KHÔNG dính số vẫn cắt như cũ (không phá ca cũ)', () => {
    const s = extractDescName('KHACH HANG 22 Qaiuif APPMB NGUYEN DINH');
    expect(String(s).toUpperCase().replace(/\s+/g, ' ').trim()).toBe('KHACH HANG 22');
  });

  it('tên thường KHÔNG có mã kênh → giữ nguyên', () => {
    const s = extractDescName('KHACH HANG 21 chuyen tien den Ke Toan Demo');
    expect(String(s).toUpperCase().replace(/\s+/g, ' ').trim()).toBe('KHACH HANG 21');
  });
});
