// [Admin Demo 17/9] YC = gộp nhiều lô (nhiều máy khác nhau) thành 1 lệnh chuyển, mã YC đi vào nội dung CK VietQR,
// lưu lại để quản lý bill CK + xác nhận thanh toán.
//
// Bất biến GIỮ TIỀN mà test này khoá:
//   1) mã YC tăng dần, không trùng (nội dung CK trùng mã = đối chiếu sai bill);
//   2) 1 lô chỉ nằm trong ĐÚNG 1 YC — gộp lại lần 2 phải CHẶN (nếu không: chuyển tiền 2 lần cho cùng lô);
//   3) xác nhận đã chuyển 1 YC ⇒ đánh dấu hoàn cho MỌI lô trong YC (đúng ý "gộp để xác nhận 1 lần");
//   4) YC đã chuyển tiền thì KHÔNG huỷ được (giữ dấu vết tiền);
//   5) tiền làm tròn XUỐNG nghìn như luật hoàn hiện hành.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { taoYeuCauHoan, danhDauYcDaChuyen, huyYeuCauHoan, trayYcTheoLo, lamTronNghinXuong } from '../src/refund-request-service.js';

const db = getBotDb();
let seed = 900_000;
// [B-H1 21/9] taoYeuCauHoan nay CHẶN lô chưa đối soát (ds=false / chưa có recon) — luật Admin Demo "chỉ gộp lô đã
// đối soát". Lô throwaway của test phải seed pos_lot_recon ds=true như lô thật đã soát; loMoiChuaSoat() để test gate.
const loMoiChuaSoat = (): number => ++seed; // id lô throwaway KHÔNG seed recon (ds coi như false)
const loMoi = (): number => { const id = ++seed; daSoat.push(id); return id; };
const daSoat: number[] = [];
beforeAll(async () => { await ensureAlphaExtraSchema(db); });
// seed recon ds=true LƯỜI ngay trước mỗi lần gọi service (id sinh trong it() nên không seed trước được toàn bộ)
async function seedDaSoat(): Promise<void> {
  while (daSoat.length) {
    const id = daSoat.shift()!;
    await db.$executeRawUnsafe(`INSERT INTO pos_lot_recon (lot_id, ds) VALUES ($1, true) ON CONFLICT (lot_id) DO UPDATE SET ds = true`, id);
  }
}
const taoYc: typeof taoYeuCauHoan = async (d, i) => { await seedDaSoat(); return taoYeuCauHoan(d, i); };

describe('lamTronNghinXuong', () => {
  it('cắt xuống nghìn, không làm tròn lên', () => {
    expect(lamTronNghinXuong(15_380_640)).toBe(15_380_000);
    expect(lamTronNghinXuong(999)).toBe(0);
    expect(lamTronNghinXuong(-5)).toBe(0);
  });
});

describe('taoYeuCauHoan — gộp lô thành YC', () => {
  it('gộp 4 lô của NHIỀU MÁY thành 1 YC, mã dạng YCxxx, tiền tròn nghìn', async () => {
    const lots = [loMoi(), loMoi(), loMoi(), loMoi()];
    const r = await taoYc(db, { dealerKey: 'BÌNH SG', dealerLabel: 'Bình SG', lotIds: lots, amount: 100_000_500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.code).toMatch(/^YC\d{3,}$/);
    expect(r.data.amount).toBe(100_000_000); // 500đ lẻ bị cắt xuống
    expect(r.data.lotIds).toEqual(lots);
    expect(r.data.status).toBe('MOI');
  });

  it('mã YC TĂNG DẦN, không trùng nhau', async () => {
    const a = await taoYc(db, { dealerKey: 'A', lotIds: [loMoi()], amount: 1_000_000 });
    const b = await taoYc(db, { dealerKey: 'A', lotIds: [loMoi()], amount: 2_000_000 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.data.code).not.toBe(b.data.code);
    const so = (c: string): number => Number(c.replace(/\D/g, ''));
    expect(so(b.data.code)).toBe(so(a.data.code) + 1);
  });

  it('CHẶN gộp lô ĐÃ nằm trong YC khác (chống chuyển tiền 2 lần cho 1 lô)', async () => {
    const chung = loMoi();
    const r1 = await taoYc(db, { dealerKey: 'B', lotIds: [chung, loMoi()], amount: 5_000_000 });
    expect(r1.ok).toBe(true);
    const r2 = await taoYc(db, { dealerKey: 'B', lotIds: [chung, loMoi()], amount: 7_000_000 });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error).toBe('LOT_DA_CO_YC');
    expect(r2.lotIds).toContain(chung);
    expect(r2.message).toMatch(/YC\d+/); // nói RÕ lô đó đang thuộc YC nào
  });

  it('không có lô / tiền ≤ 0 → từ chối rõ ràng', async () => {
    expect((await taoYc(db, { dealerKey: 'C', lotIds: [], amount: 1_000_000 })).ok).toBe(false);
    expect((await taoYc(db, { dealerKey: 'C', lotIds: [loMoi()], amount: 0 })).ok).toBe(false);
  });
});

describe('danhDauYcDaChuyen / huyYeuCauHoan', () => {
  it('xác nhận CHUYỂN TIỀN 1 YC ⇒ MỌI lô trong YC thành đã đối soát + đã hoàn', async () => {
    const lots = [loMoi(), loMoi(), loMoi()];
    const r = await taoYc(db, { dealerKey: 'D', lotIds: lots, amount: 30_000_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = await danhDauYcDaChuyen(db, r.data.code, { paidRef: 'FT26260203013109' });
    expect(p.ok).toBe(true);
    const rows = await db.$queryRawUnsafe<{ lot_id: string; ds: boolean; refund_done: boolean }[]>(
      `SELECT lot_id::text, ds, refund_done FROM pos_lot_recon WHERE lot_id = ANY($1::bigint[])`, lots);
    expect(rows).toHaveLength(3);
    for (const x of rows) { expect(x.ds).toBe(true); expect(x.refund_done).toBe(true); }
  });

  it('YC ĐÃ chuyển tiền thì KHÔNG huỷ được (giữ dấu vết tiền)', async () => {
    const r = await taoYc(db, { dealerKey: 'E', lotIds: [loMoi()], amount: 9_000_000 });
    if (!r.ok) throw new Error('setup');
    await danhDauYcDaChuyen(db, r.data.code, {});
    const h = await huyYeuCauHoan(db, r.data.code);
    expect(h.ok).toBe(false);
    expect(h.error).toBe('DA_CHUYEN');
  });

  it('YC chưa chuyển thì huỷ được và NHẢ lô ra để gộp lại', async () => {
    const lot = loMoi();
    const r = await taoYc(db, { dealerKey: 'F', lotIds: [lot], amount: 4_000_000 });
    if (!r.ok) throw new Error('setup');
    expect((await huyYeuCauHoan(db, r.data.code)).ok).toBe(true);
    const lai = await taoYc(db, { dealerKey: 'F', lotIds: [lot], amount: 4_000_000 });
    expect(lai.ok).toBe(true); // lô đã được nhả → gộp lại được
  });
});

describe('trayYcTheoLo — cột "Mã YC" trên bảng doanh số', () => {
  it('trả mã + trạng thái theo từng lô; lô chưa gộp thì không có trong map', async () => {
    const lots = [loMoi(), loMoi()];
    const chuaGop = loMoi();
    const r = await taoYc(db, { dealerKey: 'G', lotIds: lots, amount: 12_345_678 });
    if (!r.ok) throw new Error('setup');
    const map = await trayYcTheoLo(db, [...lots, chuaGop]);
    expect(map.get(lots[0]!)?.code).toBe(r.data.code);
    expect(map.get(lots[1]!)?.code).toBe(r.data.code);
    expect(map.get(lots[0]!)?.amount).toBe(12_345_000);
    expect(map.has(chuaGop)).toBe(false);
  });
});


describe('[21/9] gate + race — B-C1/B-H1/B-H2', () => {
  it('CHẶN gộp lô CHƯA đối soát (ds=false) — fail-loud LOT_CHUA_DOI_SOAT', async () => {
    const chua = loMoiChuaSoat();
    const r = await taoYc(db, { dealerKey: 'GATE', lotIds: [chua], amount: 1_000_000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('LOT_CHUA_DOI_SOAT');
  });

  it('RACE 2 request cùng lô: đúng 1 thắng (advisory lock + check daCo trong CÙNG tx)', async () => {
    const lo = loMoi();
    await seedDaSoat();
    const [a, b] = await Promise.all([
      taoYeuCauHoan(db, { dealerKey: 'R1', lotIds: [lo], amount: 1_000_000 }),
      taoYeuCauHoan(db, { dealerKey: 'R2', lotIds: [lo], amount: 1_000_000 })
    ]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1); // trước fix: cả 2 ok → lô nằm 2 YC → chuyển tiền x2
  });

  it('danhDauYcDaChuyen LẦN 2 → DA_CHUYEN (không ghi đè dấu vết)', async () => {
    const r = await taoYc(db, { dealerKey: 'DD', lotIds: [loMoi()], amount: 1_000_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m1 = await danhDauYcDaChuyen(db, r.data.code);
    expect(m1.ok).toBe(true);
    const m2 = await danhDauYcDaChuyen(db, r.data.code);
    expect(m2.ok).toBe(false);
    if (!m2.ok) expect(m2.error).toBe('DA_CHUYEN');
  });
});
