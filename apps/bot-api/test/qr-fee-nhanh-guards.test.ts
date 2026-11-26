// [PHẢN BIỆN ĐỐI KHÁNG 11/9 — agent 1, MẢNG B] Giá QR 2 bậc chờ/nhanh — guard + bất biến:
//  B2 SPREAD ÂM BẬC NHANH: nhanh < mua → reviewQr PHẢI cắm cảnh báo (send đã 422 nhưng UI review đang hiện
//     refundAmountNhanh không cờ gì → người duyệt chọn nhanh rồi mới bị chặn, mù lý do).
//  B3 WEEKEND: cuối tuần CHỈ đổi giá MUA — bậc chờ + bậc nhanh giữ nguyên (không bị weekend ghi đè/bỏ sót).
//  B3b KỲ: kỳ mới phi_ban_nhanh NULL KHÔNG kế thừa nhanh của kỳ cũ (nhanh lấy đúng KỲ hiệu lực như mua/bán).
//  B5 LÀM TRÒN: refundAmountNhanh cùng công thức Math.round từng đồng với bậc chờ (amount lẻ).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema, resolveQrFeeForTid } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { reviewQr } from '../src/ocr-send-service.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;

async function makeQrTid(): Promise<{ tidId: number; hkd: string }> {
  const db = getBotDb();
  const hkd = `HKD NHANH GUARD ${uniq('X')}`;
  const bank = await db.bank.create({ data: { name: uniq('BK'), code: uniq('B').slice(0, 18) } });
  const t = await db.tid.create({ data: { tid: uniq('QR-').slice(0, 24), hkdName: hkd, bankId: bank.id } });
  await db.$executeRawUnsafe(`UPDATE tids SET kind='QR' WHERE id=$1`, t.id);
  return { tidId: t.id, hkd };
}
async function themKy(tidId: number, o: { muaThuong: number; muaCuoiTuan: number; ban: number; banNhanh: number | null; from: string }): Promise<void> {
  await getBotDb().$executeRawUnsafe(
    `INSERT INTO qr_fee_rates (tid_id, phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, phi_ban_nhanh, effective_from, created_by, created_at, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, 1, now(), 1, now())`,
    tidId, o.muaThuong, o.muaCuoiTuan, o.ban, o.banNhanh, o.from);
}
const qr = (hkd: string, amount: number, date = '11/09/2026') => [{ hkdName: hkd, ref: uniq('R').slice(0, 14), amount, date, time: '10:00:00' }];

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('B2 — spread âm bậc NHANH phải có cảnh báo ở review', () => {
  it('nhanh (700) < mua (880) → reviewQr cắm ⚠ spread âm bậc nhanh; bậc chờ hợp lệ nên KHÔNG blocked', async () => {
    const db = getBotDb();
    const { tidId, hkd } = await makeQrTid();
    await themKy(tidId, { muaThuong: 880, muaCuoiTuan: 880, ban: 950, banNhanh: 700, from: '2026-01-01T00:00:00+07:00' });
    const [it0] = await reviewQr(db, qr(hkd, 10_000_000) as never, new Date(), [], null);
    expect((it0 as { tidId: number | null }).tidId).toBe(tidId);
    expect((it0 as { blocked: boolean }).blocked).toBe(false); // chờ 950 ≥ mua 880 → vẫn gửi được bậc chờ
    const w = (it0 as { warnings: string[] }).warnings;
    expect(w.some((x) => x.includes('NHANH') && x.includes('spread âm'))).toBe(true);
  });
});

describe('B3 — weekend chỉ đổi giá MUA, không đụng bậc bán nào', () => {
  it('thứ 7: phiMua = cuối tuần, phiBan + phiBanNhanh giữ nguyên', async () => {
    const db = getBotDb();
    const { tidId } = await makeQrTid();
    await themKy(tidId, { muaThuong: 880, muaCuoiTuan: 950, ban: 1000, banNhanh: 1150, from: '2026-01-01T00:00:00+07:00' });
    const r = await resolveQrFeeForTid(db, { tidId, partnerId: null }, new Date('2026-09-12T03:00:00Z')); // T7 12/9 10:00 HCM
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.isWeekend).toBe(true);
      expect(r.phiMuaMilli).toBe(950);
      expect(r.phiBanMilli).toBe(1000);
      expect(r.phiBanNhanhMilli).toBe(1150);
    }
  });
});

describe('B3b — bậc nhanh lấy đúng KỲ hiệu lực (kỳ mới NULL không kế thừa kỳ cũ)', () => {
  it('kỳ cũ nhanh=1200, kỳ mới (6/2026) nhanh=NULL → tại 9/2026 nhanh=null; tại 3/2026 nhanh=1200', async () => {
    const db = getBotDb();
    const { tidId } = await makeQrTid();
    await themKy(tidId, { muaThuong: 880, muaCuoiTuan: 880, ban: 950, banNhanh: 1200, from: '2026-01-01T00:00:00+07:00' });
    await themKy(tidId, { muaThuong: 880, muaCuoiTuan: 880, ban: 950, banNhanh: null, from: '2026-06-01T00:00:00+07:00' });
    const r9 = await resolveQrFeeForTid(db, { tidId, partnerId: null }, new Date('2026-09-11T03:00:00Z'));
    expect(r9.ok).toBe(true);
    if (r9.ok) expect(r9.phiBanNhanhMilli).toBeNull();
    const r3 = await resolveQrFeeForTid(db, { tidId, partnerId: null }, new Date('2026-03-02T03:00:00Z'));
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.phiBanNhanhMilli).toBe(1200);
  });
});

describe('B5 — làm tròn từng đồng nhất quán chờ vs nhanh (amount lẻ)', () => {
  it('amount 1.234.567: refund mỗi bậc = amount − Math.round(amount×milli/100000)', async () => {
    const db = getBotDb();
    const { tidId, hkd } = await makeQrTid();
    await themKy(tidId, { muaThuong: 880, muaCuoiTuan: 880, ban: 950, banNhanh: 1150, from: '2026-01-01T00:00:00+07:00' });
    void tidId;
    const amount = 1_234_567;
    const [it0] = await reviewQr(db, qr(hkd, amount) as never, new Date(), [], null);
    expect((it0 as { refundAmount: number }).refundAmount).toBe(amount - Math.round((amount * 950) / 100000));
    expect((it0 as { refundAmountNhanh: number }).refundAmountNhanh).toBe(amount - Math.round((amount * 1150) / 100000));
  });
});
