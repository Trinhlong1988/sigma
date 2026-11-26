// [PHẢN BIỆN ĐỐI KHÁNG 11/9 — agent 1, MẢNG A] Đào bug ẨN nhánh "cứu mã theo báo-có khi tên HKD cắt/mờ" (reviewQr):
//  A1 MIS-ASSIGN: fallback tiền+giờ tra TOÀN CỤC → mã B cùng tiền ±10' CƯỚP bill của mã A (A chưa poll kịp báo-có).
//     Guard: tên OCR còn TƯƠNG THÍCH ≥1 mã (hkdKeyTuongThich) → CHỈ tra báo-có của các mã đó; tên rác hoàn toàn →
//     giữ tra toàn cục (đúng thiết kế đã duyệt — 2 test cũ qr-hkd-cut-baoco-rescue giữ nguyên hành vi).
//  A2 REF THIẾU KIỂM TIỀN: external_ref_no khớp mà amount LỆCH HẲN vẫn gán mã (ref OCR đọc lệch / đụng ref nguồn
//     khác — PaySmart cùng bảng). Guard: ref rescue PHẢI kèm amount + ref đủ dài (≥4, chặn rác ''/'0').
//  A5 DÁN NHÃN BẰNG CHỨNG SAI: khớp bằng tiền+giờ nhưng cảnh báo nói "khớp SỐ GIAO DỊCH" (điều kiện
//     `ref && hits.length === 1` luôn true trong nhánh gán) — người duyệt tiền tưởng bằng chứng mạnh hơn thật.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { reviewQr } from '../src/ocr-send-service.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
/** Số tiền NGẪU NHIÊN LẺ per-test — chống đụng row báo-có của test khác trong cùng throwaway DB. */
const soTienLe = (): number => 7_000_000 + Math.floor(Math.random() * 900_000) * 1 + 137;

async function makeQrTid(hkd: string): Promise<number> {
  const db = getBotDb();
  const bank = await db.bank.create({ data: { name: uniq('BK'), code: uniq('B').slice(0, 18) } });
  const t = await db.tid.create({ data: { tid: uniq('QRC-').slice(0, 24), hkdName: hkd, bankId: bank.id } });
  await db.$executeRawUnsafe(`UPDATE tids SET kind = 'QR' WHERE id = $1`, t.id);
  return t.id;
}
async function ghiBaoCo(tidId: number, amount: number, atMs: number, ref: string): Promise<void> {
  await getBotDb().$executeRawUnsafe(
    `INSERT INTO digistore_baoco (bill_id, qr_code, hkd_name, amount, payer_name, external_ref_no, description, at_ms, status, source_tid_id, fetched_at)
     VALUES ($1, 'QR', 'X', $2, 'NG QUET', $3, 'd', $4, 'success', $5, now())`,
    uniq('BILL'), amount, ref, atMs, tidId);
}
const bill = (hkdCut: string, ref: string, amount: number, d: Date): unknown => ({
  hkdName: hkdCut, ref, amount,
  date: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`,
  time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`
});

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('reviewQr — chống GÁN NHẦM mã khi cứu theo báo-có (phản biện A1/A2/A5)', () => {
  it('A1: tên cắt tương thích mã A (A CHƯA có báo-có) — mã B cùng tiền ±10 phút KHÔNG được cướp bill → kiểm tay', async () => {
    const db = getBotDb();
    const sfx = uniq('').slice(-6);
    const idA = await makeQrTid(`HKD DEMO 33${sfx}`);
    void idA; // A tồn tại nhưng báo-có A CHƯA poll về (kịch bản poll chậm 30')
    const idB = await makeQrTid(`HKD DEMO 24${sfx}`);
    const at = new Date(Date.now() - 3600_000);
    const amount = soTienLe();
    await ghiBaoCo(idB, amount, at.getTime() + 2 * 60_000, uniq('REFB').slice(0, 18)); // B quẹt CÙNG tiền, CÙNG khung giờ
    // Bill của A: tên đọc cắt "KHACH HANG 25" (tương thích A, KHÔNG tương thích B), ref không khớp báo-có nào.
    const [r] = await reviewQr(db, [bill('KHACH HANG 25', uniq('REFA').slice(0, 14), amount, at)] as never, new Date(), [], null);
    expect((r as { tidId: number | null }).tidId).toBeNull(); // CẤM gán B
    expect((r as { warnings: string[] }).warnings.some((w) => w.includes('Không tìm thấy MÃ QR'))).toBe(true);
  });

  it('A1b: tên tương thích mã A + CHÍNH A có báo-có khớp → nhận đúng A, dù mã B (tên khác hẳn) cũng có báo-có cùng tiền+giờ', async () => {
    const db = getBotDb();
    const sfx = uniq('').slice(-6);
    const idA = await makeQrTid(`HKD DEMO 34${sfx}`);
    const idB = await makeQrTid(`HKD DEMO 25${sfx}`);
    const at = new Date(Date.now() - 3600_000);
    const amount = soTienLe();
    await ghiBaoCo(idA, amount, at.getTime() + 60_000, uniq('REFC').slice(0, 18));
    await ghiBaoCo(idB, amount, at.getTime() + 3 * 60_000, uniq('REFD').slice(0, 18));
    const [r] = await reviewQr(db, [bill('KHACH HANG 25', uniq('REFX').slice(0, 14), amount, at)] as never, new Date(), [], null);
    expect((r as { tidId: number | null }).tidId).toBe(idA); // thu hẹp theo tên → bằng chứng của A là DUY NHẤT
    expect((r as { warnings: string[] }).warnings.some((w) => w.includes('đọc cắt/mờ'))).toBe(true);
  });

  it('A2: ref khớp báo-có nhưng SỐ TIỀN LỆCH HẲN → KHÔNG nhận mã (ref đọc lệch/đụng ref nguồn khác)', async () => {
    const db = getBotDb();
    const idC = await makeQrTid(`HKD DAY DU E${uniq('').slice(-6)}`);
    const at = new Date(Date.now() - 3600_000);
    const refTrung = uniq('REFTR').slice(0, 18);
    await ghiBaoCo(idC, 999_000, at.getTime() + 60_000, refTrung); // báo-có 999.000đ
    // Bill tên rác (không tương thích mã nào) + ref TRÙNG nhưng tiền 5.432.100đ — lệch hẳn.
    const [r] = await reviewQr(db, [bill('ZZKY RAC QQQW', refTrung, 5_432_100, at)] as never, new Date(), [], null);
    expect((r as { tidId: number | null }).tidId).toBeNull();
    expect((r as { warnings: string[] }).warnings.some((w) => w.includes('Không tìm thấy MÃ QR'))).toBe(true);
  });

  it('A2b: ref RÁC NGẮN ("0") không được dùng để cứu mã', async () => {
    const db = getBotDb();
    const idE = await makeQrTid(`HKD DAY DU F${uniq('').slice(-6)}`);
    const amount = soTienLe();
    const atBaoCo = Date.now() - 3600_000;
    await ghiBaoCo(idE, amount, atBaoCo, '0'); // dữ liệu báo-có rác ref='0'
    // Bill ref '0', tiền khớp NHƯNG giờ lệch 3h (ngoài ±10') → fallback tiền+giờ không cứu; ref '0' cũng CẤM cứu.
    const [r] = await reviewQr(db, [bill('ZZKY RAC VVVW', '0', amount, new Date(atBaoCo - 3 * 3600_000))] as never, new Date(), [], null);
    expect((r as { tidId: number | null }).tidId).toBeNull();
  });

  it('A5: cứu bằng TIỀN+GIỜ (ref có nhưng không khớp) → cảnh báo phải nói "tiền+giờ", KHÔNG được nói "SỐ GIAO DỊCH"', async () => {
    const db = getBotDb();
    const idD = await makeQrTid(`HKD DAY DU G${uniq('').slice(-6)}`);
    const at = new Date(Date.now() - 3600_000);
    const amount = soTienLe();
    await ghiBaoCo(idD, amount, at.getTime() + 60_000, uniq('REFG').slice(0, 18));
    const [r] = await reviewQr(db, [bill('ZZKY RAC NNNW', uniq('REFNO').slice(0, 14), amount, at)] as never, new Date(), [], null);
    expect((r as { tidId: number | null }).tidId).toBe(idD); // tên rác hoàn toàn → giữ cứu toàn cục (thiết kế đã duyệt)
    const canhBao = (r as { warnings: string[] }).warnings.find((w) => w.includes('đọc cắt/mờ')) ?? '';
    expect(canhBao).toContain('tiền+giờ');
    expect(canhBao).not.toContain('SỐ GIAO DỊCH');
  });
});
