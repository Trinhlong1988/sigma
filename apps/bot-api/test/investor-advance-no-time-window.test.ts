// [Admin Demo 17/9 — "NĐT TRUNG TẠM ỨNG 2050 MÀ CHỈ GHI NHẬN 1750?"] BUG NUỐT 1,2 TỶ: lưới chống-trùng "cùng NĐT +
// cùng tiền + ±2 phút" chạy trên `advance_date`, MÀ ngày này lấy TỪ BILL nên GIỜ = 00:00 khi OCR không đọc được
// giờ ⇒ cửa sổ ±2' hoá ra "cả ngày" ⇒ NĐT chuyển NHIỀU LẦN cùng mệnh giá trong ngày (Trung: 300tr × nhiều lần)
// chỉ ghi được lần ĐẦU, các lần sau bị nuốt CÂM. Test khẳng định cả 2 chiều + bẫy múi giờ đã sập bẫy vòng 1:
// chuỗi ngày TRẦN "2026-09-16" bị JS parse là 00:00 UTC ⇒ Date#getHours() trên máy giờ VN ra 7 ⇒ tưởng "có giờ".
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { ingestInvestorAdvance, recordInvestorRepayment, coGioThatTrenBill } from '../src/investor-advance-ingest.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const hash = (): string => uniq('h').padEnd(40, '0');

async function makeInvestor(): Promise<number> {
  const db = getBotDb();
  const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: 'NĐT no-time', nickname: uniq('nv').slice(0, 18), status: 'ACTIVE', investFeeMilli: 0 } });
  return inv.id;
}

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('coGioThatTrenBill — đọc giờ TRÊN CHUỖI bill, độc lập múi giờ máy', () => {
  it('ngày trần / 00:00 → KHÔNG có giờ thật; giờ khác 00:00 → có', () => {
    expect(coGioThatTrenBill('2026-09-16')).toBe(false);              // bẫy TZ: getHours() sẽ ra 7 trên máy VN
    expect(coGioThatTrenBill('2026-09-16T00:00:00')).toBe(false);     // watcher điền 00:00 khi OCR không đọc được giờ
    expect(coGioThatTrenBill('2026-09-16T00:00:00+07:00')).toBe(false);
    expect(coGioThatTrenBill('2026-09-16T08:41:00')).toBe(true);
    expect(coGioThatTrenBill('2026-09-16T00:01:00')).toBe(true);
    expect(coGioThatTrenBill(null)).toBe(false);
  });
});

describe('ingestInvestorAdvance — bill KHÔNG có giờ thì lưới ±2 phút phải TẮT', () => {
  it('CA THẬT: 3 lần chuyển 300tr cùng ngày, không giờ, không mã GD, ảnh KHÁC → ghi đủ 3 (trước fix chỉ ghi 1)', async () => {
    const db = getBotDb();
    const inv = await makeInvestor();
    const bill = { investorId: inv, receiverName: 'KHACH HANG 01', amount: 300_000_000, ref: null as string | null, advanceDateIso: '2026-09-16T00:00:00' };
    const r = [
      await ingestInvestorAdvance(db, { ...bill, imageHash: hash() }),
      await ingestInvestorAdvance(db, { ...bill, imageHash: hash() }),
      await ingestInvestorAdvance(db, { ...bill, imageHash: hash() })
    ];
    expect(r.map((x) => x.action)).toEqual(['recorded', 'recorded', 'recorded']);
  });
  it('Bẫy TZ: advanceDateIso là NGÀY TRẦN (parse ra 00:00 UTC = 07:00 giờ VN) cũng phải ghi đủ', async () => {
    const db = getBotDb();
    const inv = await makeInvestor();
    const bill = { investorId: inv, receiverName: 'KHACH HANG 01', amount: 400_000_000, advanceDateIso: '2026-09-14' };
    expect((await ingestInvestorAdvance(db, { ...bill, imageHash: hash() })).action).toBe('recorded');
    expect((await ingestInvestorAdvance(db, { ...bill, imageHash: hash() })).action).toBe('recorded');
  });
  it('CÙNG ẢNH (forward/OCR lại) vẫn phải chặn — lưới hash ảnh là hàng rào thay thế', async () => {
    const db = getBotDb();
    const inv = await makeInvestor();
    const h = hash();
    const bill = { investorId: inv, receiverName: 'KHACH HANG 01', amount: 250_000_000, advanceDateIso: '2026-09-16T00:00:00', imageHash: h };
    expect((await ingestInvestorAdvance(db, bill)).action).toBe('recorded');
    expect((await ingestInvestorAdvance(db, bill)).action).toBe('duplicate');
  });
  it('CÓ GIỜ THẬT: 2 bill cùng phút, cùng tiền, không mã GD → vẫn chặn (lưới ±2 phút giữ nguyên)', async () => {
    const db = getBotDb();
    const inv = await makeInvestor();
    const bill = { investorId: inv, receiverName: 'KHACH HANG 01', amount: 120_000_000, advanceDateIso: '2026-09-16T08:41:00' };
    expect((await ingestInvestorAdvance(db, { ...bill, imageHash: hash() })).action).toBe('recorded');
    expect((await ingestInvestorAdvance(db, { ...bill, imageHash: hash() })).action).toBe('duplicate');
  });
});

describe('recordInvestorRepayment — CÙNG LỚP BUG ở chiều hoàn thừa', () => {
  it('2 lần hoàn cùng mệnh giá trong ngày, không giờ, ảnh khác → ghi đủ 2', async () => {
    const db = getBotDb();
    const inv = await makeInvestor();
    const bill = { investorId: inv, amount: 80_000_000, advanceDateIso: '2026-09-16T00:00:00' };
    expect((await recordInvestorRepayment(db, { ...bill, imageHash: hash() })).action).toBe('recorded');
    expect((await recordInvestorRepayment(db, { ...bill, imageHash: hash() })).action).toBe('recorded');
  });
  it('CÓ GIỜ THẬT cùng phút → vẫn chặn', async () => {
    const db = getBotDb();
    const inv = await makeInvestor();
    const bill = { investorId: inv, amount: 70_000_000, advanceDateIso: '2026-09-16T09:15:00' };
    expect((await recordInvestorRepayment(db, { ...bill, imageHash: hash() })).action).toBe('recorded');
    expect((await recordInvestorRepayment(db, { ...bill, imageHash: hash() })).action).toBe('duplicate');
  });
});
