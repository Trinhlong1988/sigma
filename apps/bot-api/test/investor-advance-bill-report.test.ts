// [Admin Demo 17/9 "DANH SÁCH BILL CK CỦA NĐT OCR RA ĐÂU? SAO THIẾU?"] Bảng đối soát bill CK NĐT: bill đã OCR ⇄ dòng
// tiền đã ghi. Khẳng định 3 việc bảng PHẢI làm đúng, vì sai bất kỳ cái nào là báo số láo về tiền:
//   1) bill ghép được dòng tiền → "đã ghi"; bill KHÔNG ghép được → ĐỎ + cộng vào LỆCH (chính ca nuốt 1,2 tỷ);
//   2) ghép 2 LƯỢT — chắc chắn (hash/mã GD) TRƯỚC, mờ (tiền+ngày) SAU: ghép 1 lượt thì bill OCR trượt mã cướp
//      dòng tiền của bill có mã khớp ⇒ báo oan "chưa ghi" (bug tự bắt trên DB thật 17/9);
//   3) 1 dòng tiền chỉ ghép cho 1 bill (2 ảnh cùng 1 GD không được cùng khoe "đã ghi").
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { buildInvestorAdvanceBillReport, ngayTrenCaption, refTuCkTxnKey } from '../src/investor-advance-bill-report.js';
import { ingestInvestorAdvance } from '../src/investor-advance-ingest.js';
import { makeChatRoom } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const FROM = new Date('2026-09-14T00:00:00+07:00');
const TO = new Date('2026-09-17T00:00:00+07:00');

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

async function dungNha(): Promise<{ investorId: number; roomId: string }> {
  const db = getBotDb();
  const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: 'NĐT bảng bill', nickname: uniq('nv').slice(0, 18), status: 'ACTIVE', investFeeMilli: 0 } });
  const room = await makeChatRoom({ name: uniq('NĐT bill ') });
  await db.$executeRawUnsafe(
    `INSERT INTO investor_chat_groups (investor_id, room_id, zalo_group_id, assigned_from, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now(), now())`,
    inv.id, room.id, `g${room.id}`);
  return { investorId: inv.id, roomId: room.id };
}

/** Đăng 1 tin bill CK đã OCR (như watcher làm) vào nhóm NĐT. */
async function dangBill(roomId: string, investorId: number, o: { amount: number; ngay: string; ref?: string | null; hash: string; hoan?: boolean }): Promise<void> {
  const db = getBotDb();
  const meta: Record<string, unknown> = {
    isTransferRefund: true,
    ...(o.hoan ? { isInvestorRepaymentCk: true, repaymentAmount: o.amount } : { isInvestorAdvanceCk: true, advanceAmount: o.amount }),
    ckTxnKey: o.ref ? `ck|ref|${o.ref}` : `ck|hash|${o.hash}`,
    ocrImageHash: o.hash, investorId, senderName: 'KHACH HANG 21', receiverName: 'KHACH HANG 01'
  };
  await db.chatMessage.create({
    data: {
      roomId, kind: 'TEXT',
      body: `💰 ${o.hoan ? 'HOÀN THỪA NĐT' : 'TẠM ỨNG NĐT'} · ${o.amount.toLocaleString('vi-VN')}đ · ${o.ngay}`,
      metadataJson: JSON.stringify(meta)
    }
  });
}

/** Ghi 1 dòng tiền vào investor_advances (vế "đã ghi"). */
async function ghiTien(investorId: number, o: { amount: number; ngayIso: string; ref?: string | null; hash?: string | null; hoan?: boolean }): Promise<number> {
  const db = getBotDb();
  const r = await db.$queryRawUnsafe<{ id: number }[]>(
    `INSERT INTO investor_advances (investor_id, amount, advance_date, source, ref_number, image_hash, note, created_at, updated_at)
     VALUES ($1,$2,$3::timestamptz,$4,$5,$6,'test',now(),now()) RETURNING id`,
    investorId, o.amount, o.ngayIso, o.hoan ? 'REPAYMENT' : 'OCR', o.ref ?? null, o.hash ?? null);
  return r[0]!.id;
}

describe('helper thuần', () => {
  it('ngayTrenCaption: lấy ngày GD trên caption bill', () => {
    expect(ngayTrenCaption('💰 TẠM ỨNG NĐT · 300.000.000đ · 16/09/2026')).toBe('2026-09-16');
    expect(ngayTrenCaption('không có ngày')).toBeNull();
  });
  it('refTuCkTxnKey: CHỈ tier ck|ref| mới là mã GD thật', () => {
    expect(refTuCkTxnKey('ck|ref|6257VNIB02UGFWU5')).toBe('6257VNIB02UGFWU5');
    expect(refTuCkTxnKey('ck|hash|3d994c3014c8')).toBeNull();
    expect(refTuCkTxnKey(null)).toBeNull();
  });
});

describe('buildInvestorAdvanceBillReport', () => {
  it('bill KHÔNG có dòng tiền nào → ĐỎ + vào tổng LỆCH (ca nuốt tiền câm)', async () => {
    const { investorId, roomId } = await dungNha();
    const hA = uniq('ha'), hB = uniq('hb');
    await dangBill(roomId, investorId, { amount: 300_000_000, ngay: '16/09/2026', hash: hA });
    await dangBill(roomId, investorId, { amount: 300_000_000, ngay: '16/09/2026', hash: hB }); // bill bị nuốt
    await ghiTien(investorId, { amount: 300_000_000, ngayIso: '2026-09-16T10:00:00+07:00', hash: hA });

    const r = await buildInvestorAdvanceBillReport(getBotDb(), investorId, FROM, TO);
    expect(r.bills).toHaveLength(2);
    expect(r.tongBillUng).toBe(600_000_000);
    expect(r.tongDaGhiUng).toBe(300_000_000);
    expect(r.soBillChuaGhi).toBe(1);
    expect(r.tienChuaGhi).toBe(300_000_000);
    expect(r.bills.find((b) => b.imageHash === hB)?.recorded).toBe(false);
  });

  it('GHÉP 2 LƯỢT: bill OCR trượt mã KHÔNG được cướp dòng tiền của bill có mã khớp', async () => {
    const { investorId, roomId } = await dungNha();
    const hMo = uniq('hmo'), hMa = uniq('hma');
    // bill đăng TRƯỚC: OCR trượt mã + trượt hash (hash không có trong bảng tiền) → chỉ ghép được kiểu mờ.
    await dangBill(roomId, investorId, { amount: 200_000_000, ngay: '14/09/2026', hash: hMo });
    // bill đăng SAU: hash khớp đúng dòng tiền đã ghi.
    await dangBill(roomId, investorId, { amount: 200_000_000, ngay: '14/09/2026', hash: hMa, ref: uniq('R') });
    const idChac = await ghiTien(investorId, { amount: 200_000_000, ngayIso: '2026-09-14T09:00:00+07:00', hash: hMa });

    const r = await buildInvestorAdvanceBillReport(getBotDb(), investorId, FROM, TO);
    const billMa = r.bills.find((b) => b.imageHash === hMa)!;
    const billMo = r.bills.find((b) => b.imageHash === hMo)!;
    expect(billMa.recorded).toBe(true);
    expect(billMa.advanceId).toBe(idChac);      // dòng chắc chắn thuộc về bill có hash khớp
    expect(billMa.matchedBy).toBe('HASH');
    expect(billMo.recorded).toBe(false);        // bill kia mới là bill đang thiếu tiền
    expect(r.soBillChuaGhi).toBe(1);
  });

  it('1 dòng tiền chỉ ghép cho 1 bill (2 ảnh cùng GD không cùng khoe "đã ghi")', async () => {
    const { investorId, roomId } = await dungNha();
    await dangBill(roomId, investorId, { amount: 150_000_000, ngay: '15/09/2026', hash: uniq('h1') });
    await dangBill(roomId, investorId, { amount: 150_000_000, ngay: '15/09/2026', hash: uniq('h2') });
    await ghiTien(investorId, { amount: 150_000_000, ngayIso: '2026-09-15T08:00:00+07:00' });

    const r = await buildInvestorAdvanceBillReport(getBotDb(), investorId, FROM, TO);
    expect(r.bills.filter((b) => b.recorded)).toHaveLength(1);
    expect(r.soBillChuaGhi).toBe(1);
  });

  it('ghép theo MÃ GD khi hash lệch; chiều HOÀN THỪA tính riêng, không lẫn tạm ứng', async () => {
    const { investorId, roomId } = await dungNha();
    const ref = uniq('FT');
    await dangBill(roomId, investorId, { amount: 500_000_000, ngay: '15/09/2026', hash: uniq('hx'), ref });
    await dangBill(roomId, investorId, { amount: 11_935_000, ngay: '15/09/2026', hash: uniq('hy'), hoan: true });
    await ghiTien(investorId, { amount: 500_000_000, ngayIso: '2026-09-15T11:00:00+07:00', ref, hash: uniq('khac') });
    await ghiTien(investorId, { amount: 11_935_000, ngayIso: '2026-09-15T12:00:00+07:00', hoan: true });

    const r = await buildInvestorAdvanceBillReport(getBotDb(), investorId, FROM, TO);
    expect(r.bills.find((b) => b.ref === ref)?.matchedBy).toBe('REF');
    expect(r.tongBillUng).toBe(500_000_000);
    expect(r.tongBillHoan).toBe(11_935_000);
    expect(r.tongDaGhiHoan).toBe(11_935_000);
    expect(r.soBillChuaGhi).toBe(0);
  });

  it('[Phản biện 17/9] ghép được nhưng SỐ TIỀN LỆCH → vẫn phải BÁO (ghép hash che tiền sai)', async () => {
    const { investorId, roomId } = await dungNha();
    const h = uniq('hl');
    await dangBill(roomId, investorId, { amount: 300_000_000, ngay: '16/09/2026', hash: h });
    // Dòng tiền ghi THIẾU 100tr so với bill (OCR lệch, hoặc sửa bill mà quên sửa dòng tiền).
    await ghiTien(investorId, { amount: 200_000_000, ngayIso: '2026-09-16T10:00:00+07:00', hash: h });

    const r = await buildInvestorAdvanceBillReport(getBotDb(), investorId, FROM, TO);
    const bill = r.bills[0]!;
    expect(bill.recorded).toBe(true);           // vẫn ghép được (cùng ảnh = cùng GD)
    expect(bill.amountRecorded).toBe(200_000_000);
    expect(bill.lechTien).toBe(-100_000_000);   // ghi THIẾU
    expect(r.soBillLechTien).toBe(1);
    expect(r.tienLechGhi).toBe(-100_000_000);
    expect(r.soBillChuaGhi).toBe(0);            // không phải "chưa ghi" — là "ghi sai số"
  });

  it('bill khớp tiền → lechTien = 0 và không báo lệch', async () => {
    const { investorId, roomId } = await dungNha();
    const h = uniq('hk');
    await dangBill(roomId, investorId, { amount: 250_000_000, ngay: '16/09/2026', hash: h });
    await ghiTien(investorId, { amount: 250_000_000, ngayIso: '2026-09-16T10:00:00+07:00', hash: h });
    const r = await buildInvestorAdvanceBillReport(getBotDb(), investorId, FROM, TO);
    expect(r.soBillLechTien).toBe(0);
    expect(r.tienLechGhi).toBe(0);
    expect(r.bills[0]!.lechTien).toBe(0);
  });

  it('[Admin Demo 17/9] bill BỊ BỎ QUA (người nhận không phải TK SigMa) phải VÀO SỔ và hiện trên bảng', async () => {
    const { investorId } = await dungNha();
    const db = getBotDb();
    const r0 = await ingestInvestorAdvance(db, {
      investorId, receiverName: 'KHACH HANG 22', senderName: 'KHACH HANG 21',
      amount: 500_000_000, advanceDateIso: '2026-09-16T10:00:00', imageHash: uniq('hs')
    });
    expect(r0.action).toBe('skip_not_advance');

    const r = await buildInvestorAdvanceBillReport(db, investorId, FROM, TO);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.amount).toBe(500_000_000);
    expect(r.skipped[0]!.receiverName).toBe('KHACH HANG 22');
    expect(r.skipped[0]!.reason).toBe('NGUOI_NHAN_KHONG_PHAI_TK_ALPHA');
    // KHÔNG được cộng vào tổng tiền (chưa chắc là tạm ứng) — chỉ để người thật phán xử.
    expect(r.tongBillUng).toBe(0);
    expect(r.soBillChuaGhi).toBe(0);
  });

  it('bill bỏ qua vì KHÔNG đọc được ngày cũng vào sổ; cùng ẢNH quét lại KHÔNG đẻ dòng mới', async () => {
    const { investorId } = await dungNha();
    const db = getBotDb();
    const h = uniq('hs2');
    const inp = { investorId, receiverName: 'KHACH HANG 01', senderName: 'X', amount: 100_000_000, advanceDateIso: null, imageHash: h };
    expect((await ingestInvestorAdvance(db, inp)).action).toBe('skip_invalid');
    expect((await ingestInvestorAdvance(db, inp)).action).toBe('skip_invalid'); // quét lại cùng ảnh
    // Bill KHÔNG đọc được ngày → ngày hiệu lực = NGÀY QUÉT (hôm nay) → xem kỳ chứa hôm nay mới thấy.
    const homNay = new Date();
    const dauNgay = new Date(homNay.getFullYear(), homNay.getMonth(), homNay.getDate());
    const cuoiNgay = new Date(dauNgay.getTime() + 86_400_000);
    const r = await buildInvestorAdvanceBillReport(db, investorId, dauNgay, cuoiNgay);
    expect(r.skipped).toHaveLength(1); // unique theo hash ảnh → 1 dòng, không phình sổ
    expect(r.skipped[0]!.reason).toBe('KHONG_DOC_DUOC_NGAY');
  });

  it('bill ghi được BÌNH THƯỜNG thì KHÔNG vào sổ bỏ qua (chống nhiễu)', async () => {
    const { investorId } = await dungNha();
    const db = getBotDb();
    const r0 = await ingestInvestorAdvance(db, {
      investorId, receiverName: 'KHACH HANG 01', senderName: 'KHACH HANG 21',
      amount: 100_000_000, advanceDateIso: '2026-09-15T09:30:00', imageHash: uniq('hok')
    });
    expect(r0.action).toBe('recorded');
    const r = await buildInvestorAdvanceBillReport(db, investorId, FROM, TO);
    expect(r.skipped).toHaveLength(0);
  });

  it('lọc KỲ theo ngày trên bill: bill ngoài kỳ không vào bảng', async () => {
    const { investorId, roomId } = await dungNha();
    await dangBill(roomId, investorId, { amount: 100_000_000, ngay: '10/09/2026', hash: uniq('hz') });
    const r = await buildInvestorAdvanceBillReport(getBotDb(), investorId, FROM, TO);
    expect(r.bills).toHaveLength(0);
    expect(r.tongBillUng).toBe(0);
  });
});
