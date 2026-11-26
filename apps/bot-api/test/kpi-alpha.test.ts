// [PHẢN BIỆN 3 — 11/9] KPI SigMa toàn cục (GET /v1/kpi/alpha + buildAlphaKpi):
//   1) AUTHZ CẤU TRÚC (khuôn digistore-routes-authz.test.ts): route tiền toàn cục PHẢI wire requireAlphaOwner
//      route-level — session đại lý thường gọi phải 403 (hành vi 403 của middleware đã test ở alpha-owner.test.ts,
//      đây là guard "gate ĐƯỢC WIRE").
//   2) BIÊN MÚI GIỜ HCM: GD 16:59:59Z (=23:59:59 HCM ngày D) vs 17:00:00Z (=00:00 HCM ngày D+1) vs 17:01Z —
//      bucket ngày + bound nửa-mở [from, to): không nuốt, không đúp GD quanh nửa đêm.
//   3) revenue_amount: PHẢN BIỆN A3 kiểm "NULL → SUM bỏ câm" — kết quả: cột là NOT NULL @default(0) (schema.prisma
//      :624) + prod 11/9 đếm 0 GD NULL → nhánh NULL KHÔNG tồn tại được (chính test này chứng minh: INSERT NULL bị
//      DB chặn 23502). Rủi ro còn lại là lãi=0 mặc định (GD chưa cấu hình phí) — 0 vẫn vào SUM, không mất dòng.
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { kpiRouter, buildAlphaKpi, hcmMidnight } from '../src/routes/kpi.js';
import { makeBank, makeCardType, makeFeeType, makeTid } from './fixtures.js';

type Layer = { route?: { path: string; stack: Array<{ handle: { name?: string } }> } };
function handlerNamesFor(path: string): string[] {
  const layers = (kpiRouter as unknown as { stack: Layer[] }).stack;
  const names: string[] = [];
  for (const l of layers) if (l.route && l.route.path === path) for (const s of l.route.stack) names.push(s.handle?.name ?? '');
  return names;
}
function allRegisteredPaths(): string[] {
  const layers = (kpiRouter as unknown as { stack: Layer[] }).stack;
  const paths = new Set<string>();
  for (const l of layers) if (l.route?.path) paths.add(l.route.path);
  return [...paths];
}

describe('kpiRouter — phân quyền /v1/kpi/alpha (doanh số + lợi nhuận TOÀN CỤC)', () => {
  it('/v1/kpi/alpha PHẢI wire requireAlphaOwner (lộ = đại lý thường xem được doanh số+LỢI NHUẬN toàn SigMa)', () => {
    const names = handlerNamesFor('/v1/kpi/alpha');
    expect(names.length, 'route /v1/kpi/alpha phải tồn tại').toBeGreaterThan(0);
    expect(names, '/v1/kpi/alpha thiếu owner-gate').toContain('requireAlphaOwner');
  });

  it('QUÉT ĐỘNG (R198): mọi route KHÔNG thuộc /v1/me/* trong kpiRouter phải có requireAlphaOwner', () => {
    const paths = allRegisteredPaths();
    expect(paths.length).toBeGreaterThan(0);
    const global_ = paths.filter((p) => !p.startsWith('/v1/me/'));
    expect(global_, 'phải có ít nhất /v1/kpi/alpha').toContain('/v1/kpi/alpha');
    const thieu = global_.filter((p) => !handlerNamesFor(p).includes('requireAlphaOwner'));
    expect(thieu, `route toàn-cục thiếu owner-gate: ${thieu.join(', ')}`).toEqual([]);
  });
});

/** GD POS raw (txn_date raw-ISO ::timestamptz — cùng khuôn makePosTxn của alpha-aggregate.test.ts, né Prisma −7h). */
async function insertTxn(opts: { tidId: number; cardTypeId: number; feeTypeId: number; amount: number; txnIso: string; revenueAmount: number }): Promise<void> {
  const db = getBotDb();
  await db.$executeRawUnsafe(
    // [Admin Demo 12/9] loiNhuan KPI đổi nguồn revenue_amount → revenue_sell (QR = bán−mua, POS = bán−càiMáy).
    // Ghi CẢ HAI cột: revenue_sell = lãi thật (11/22/33), revenue_amount = GẤP 10 — test khẳng định đọc ĐÚNG CỘT
    // (nếu code lùi về revenue_amount thì tổng lệch 10 lần → đỏ ngay).
    `INSERT INTO transactions (tid_id, card_type_id, fee_type_id, amount, revenue_amount, revenue_sell, txn_date, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, 'POSTED', now(), now())`,
    opts.tidId, opts.cardTypeId, opts.feeTypeId, BigInt(opts.amount), BigInt(opts.revenueAmount * 10), BigInt(opts.revenueAmount), opts.txnIso
  );
}

describe('buildAlphaKpi — biên nửa đêm HCM + bound nửa-mở + Σ revenue_sell (lãi = chênh phí)', () => {
  it('16:59:59Z→ngày D · 17:00:00Z/17:01Z→ngày D+1; [D+1,D+2) không nuốt/không đúp; lãi Σ revenue_sell đúng (không phải revenue_amount)', async () => {
    const bank = await makeBank();
    const ct = await makeCardType(bank.id);
    const ft = await makeFeeType();
    const tid = await makeTid({ bankId: bank.id });

    // NGÀY RIÊNG mỗi lần chạy (buildAlphaKpi là Σ TOÀN CỤC trên DB throwaway dùng chung — khuôn alpha-aggregate.test.ts 9/9)
    const goc = new Date(Date.UTC(2101, 0, 1) + (Date.now() % 20000) * 86_400_000);
    const y = goc.getUTCFullYear(), mo = goc.getUTCMonth(), da = goc.getUTCDate();
    const dayD = `${y}-${String(mo + 1).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
    const ngayKe = new Date(Date.UTC(y, mo, da + 1));
    const dayD1 = `${ngayKe.getUTCFullYear()}-${String(ngayKe.getUTCMonth() + 1).padStart(2, '0')}-${String(ngayKe.getUTCDate()).padStart(2, '0')}`;
    // Nửa đêm HCM: ngày D bắt đầu (D-1)T17:00Z; ngày D+1 bắt đầu (D)T17:00Z; ngày D+2 bắt đầu (D+1)T17:00Z.
    const midD = new Date(Date.UTC(y, mo, da - 1, 17));
    const midD1 = new Date(Date.UTC(y, mo, da, 17));
    const midD2 = new Date(Date.UTC(y, mo, da + 1, 17));

    await insertTxn({ tidId: tid.id, cardTypeId: ct.id, feeTypeId: ft.id, amount: 1_000_001, txnIso: `${dayD}T16:59:59.000Z`, revenueAmount: 11 }); // 23:59:59 HCM ngày D
    await insertTxn({ tidId: tid.id, cardTypeId: ct.id, feeTypeId: ft.id, amount: 1_000_002, txnIso: `${dayD}T17:00:00.000Z`, revenueAmount: 22 }); // 00:00:00 HCM ngày D+1
    await insertTxn({ tidId: tid.id, cardTypeId: ct.id, feeTypeId: ft.id, amount: 1_000_003, txnIso: `${dayD}T17:01:00.000Z`, revenueAmount: 33 }); // 00:01 HCM ngày D+1

    // Kỳ [D+1, D+2): phải chứa ĐÚNG 2 GD nửa đêm (17:00Z + 17:01Z), KHÔNG chứa 16:59:59Z
    const kyD1 = await buildAlphaKpi(midD1, midD2);
    const rD1 = kyD1.rows.filter((r) => r.day === dayD1);
    expect(rD1.reduce((s, r) => s + r.count, 0)).toBe(2);
    expect(rD1.reduce((s, r) => s + r.doanhSo, 0)).toBe(1_000_002 + 1_000_003);
    expect(rD1.reduce((s, r) => s + r.loiNhuan, 0)).toBe(22 + 33);
    expect(kyD1.rows.some((r) => r.day === dayD)).toBe(false);

    // Kỳ [D, D+1): chỉ GD 16:59:59Z
    const kyD = await buildAlphaKpi(midD, midD1);
    const rD = kyD.rows.filter((r) => r.day === dayD);
    expect(rD.reduce((s, r) => s + r.count, 0)).toBe(1);
    expect(rD.reduce((s, r) => s + r.doanhSo, 0)).toBe(1_000_001);
    expect(kyD.rows.some((r) => r.day === dayD1)).toBe(false);

    // Kỳ [D, D+2): đủ 3 GD, tổng KHÔNG đúp
    const kyCa = await buildAlphaKpi(midD, midD2);
    const caHai = kyCa.rows.filter((r) => r.day === dayD || r.day === dayD1);
    expect(caHai.reduce((s, r) => s + r.count, 0)).toBe(3);
    expect(caHai.reduce((s, r) => s + r.doanhSo, 0)).toBe(1_000_001 + 1_000_002 + 1_000_003);
    expect(caHai.reduce((s, r) => s + r.loiNhuan, 0)).toBe(11 + 22 + 33);
  });
});

describe('hcmMidnight — chống CUỘN TRÀN ngày không tồn tại (CONFIRMED 11/9: Date.parse 2026-02-30T…Z KHÔNG NaN)', () => {
  it('ngày không tồn tại → null (không âm thầm cuộn sang tháng sau)', () => {
    expect(hcmMidnight('2026-02-30')).toBeNull(); // Date.parse cũ trả 02/03 → kỳ lệch âm thầm
    expect(hcmMidnight('2027-02-29')).toBeNull(); // 2027 không nhuận
    expect(hcmMidnight('2026-13-01')).toBeNull();
    expect(hcmMidnight('2026-00-10')).toBeNull();
  });
  it('ngày hợp lệ → đúng instant nửa đêm HCM (UTC−7h)', () => {
    expect(hcmMidnight('2026-02-28')?.toISOString()).toBe('2026-02-27T17:00:00.000Z');
    expect(hcmMidnight('2028-02-29')?.toISOString()).toBe('2028-02-28T17:00:00.000Z'); // 2028 nhuận
    expect(hcmMidnight('2026-09-11')?.toISOString()).toBe('2026-09-10T17:00:00.000Z');
  });
  it('sai định dạng → null', () => {
    expect(hcmMidnight('11/09/2026')).toBeNull();
    expect(hcmMidnight('2026-9-1')).toBeNull();
    expect(hcmMidnight('')).toBeNull();
  });
});
