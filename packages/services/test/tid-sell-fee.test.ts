// Test LÕI THUẦN tid-sell-fee core (@sigma/services). ASSERT error code + message tiếng Việt + rule "bán ≥ mua" LUÔN
// chạy (B86-2) + upsert override. Không có xóa/mật khẩu (set = TID_MANAGE).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { txnTzRawStub } from './_fake-db.js';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Db } from '@sigma/database';
import { createPrisma } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { listTidSellFees, setTidSellFees, listSellFeeRowsForBankPartner, ensureAlphaExtraSchema, type ServiceCtx } from '../src/index.js';

function authUser(permissions: string[], id = 42): AuthUser {
  return { id, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

const PAST = new Date('2020-01-01');
// Nửa đêm LOCAL hôm nay — khớp startOfDayLocal service (default effectiveFrom khi không truyền).
const TODAY = new Date();
const todayStart = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate());
function makeFake(opts: { tid?: Record<string, unknown> | null; cards?: Record<string, unknown>[]; rates?: Record<string, unknown>[]; quotes?: Record<string, unknown>[]; overrides?: Record<string, unknown>[] } = {}) {
  const tid = opts.tid === undefined ? { id: 1, tid: 'TID001', bankId: 5, partnerId: 9, deletedAt: null } : opts.tid;
  const sellFees = (opts.overrides ?? []).map((o) => ({ ...o }));
  let nextId = sellFees.reduce((m, r) => Math.max(m, (r['id'] as number) ?? 0), 0) + 1;
  const audits: Record<string, unknown>[] = [];
  // Stub raw dùng chung (GD + giá bán thực tế + giảm phí cuối tuần) — khai trước để tx mượn lại.
  const rawChung = txnTzRawStub(() => [], { giaBanThucTe: () => sellFees as never });
  const fake = {
    tid: {
      findUnique: async ({ where }: { where: { id: number } }) => (tid && (tid['id'] as number) === where.id ? { ...tid } : null),
      // PHA 2 — engine recalc (chạy trong tx setTidSellFees) đọc tid.findMany khi có GD in-range; seed này KHÔNG có GD.
      findMany: async () => []
    },
    feeType: { findUnique: async ({ where }: { where: { id: number } }) => (where.id === 3 ? { id: 3, deletedAt: null, name: 'Phí A' } : null) },
    bank: { findUnique: async () => ({ code: 'VCB' }) },
    cardType: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const list = opts.cards ?? [{ id: 11, code: 'VISA', name: 'Visa', bankId: 5, deletedAt: null }];
        if (where['id']) { const ids = (where['id'] as { in: number[] }).in; return list.filter((c) => ids.includes(c['id'] as number)); }
        return list.filter((c) => c['bankId'] === where['bankId']);
      }
    },
    feeRate: { findMany: async () => opts.rates ?? [{ id: 1, effectiveFrom: PAST, phiMua: 1000, phiCaiMay: 500, deletedAt: null }] },
    feeSellQuote: { findMany: async () => opts.quotes ?? [{ id: 1, effectiveFrom: PAST, phiBan: 3000, deletedAt: null }] },
    tidSellFee: {
      findMany: async () => sellFees.filter((s) => s['deletedAt'] == null).map((s) => ({ ...s })),
      // Mock ĐÚNG SHAPE Prisma cho P1: honor where.effectiveFrom {gte,lt} (cửa sổ NGÀY) + deletedAt (chỉ lọc khi
      // where khai `deletedAt: null`; nếu KHÔNG khai thì khớp cả bản xóa mềm — khuôn upsert hồi sinh) + orderBy id desc.
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const ef = where['effectiveFrom'] as { gte?: Date; lt?: Date } | undefined;
        const matches = sellFees.filter((s) => {
          if (s['tidId'] !== where['tidId'] || s['cardTypeId'] !== where['cardTypeId'] || s['feeTypeId'] !== where['feeTypeId']) return false;
          if (where['deletedAt'] === null && s['deletedAt'] != null) return false;
          if (ef) {
            const t = (s['effectiveFrom'] as Date).getTime();
            if (ef.gte && t < ef.gte.getTime()) return false;
            if (ef.lt && t >= ef.lt.getTime()) return false;
          }
          return true;
        });
        matches.sort((a, b) => (b['id'] as number) - (a['id'] as number)); // id desc
        return matches[0] ? { ...matches[0] } : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: nextId++, deletedAt: null, ...data }; sellFees.push(row); return { ...row }; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = sellFees.find((x) => x['id'] === where.id)!; Object.assign(r, data); return { ...r }; }
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'Tid', version: 1 }) },
    // [B167 16/11] `listTidSellFees` nay đọc mốc hiệu lực BẰNG RAW (giống engine tính tiền) vì driver Prisma
    // đọc timestamptz LỆCH +7h. Db giả phải trả ĐÚNG KHUÔN chuỗi đó: giờ treo tường TP.HCM + đuôi "+07:00"
    // ⇒ `new Date(...)` ra ĐÚNG instant đã lưu. Câu lạ thì NÉM (cấm nuốt im — R198).
    $queryRawUnsafe: async (sql: string, ...p: unknown[]) => {
      if (sql.includes('FROM tid_sell_fees')) {
        const [tidId, feeTypeId] = p as [number, number];
        const isoHCM = (d: Date): string => {
          const w = new Date(d.getTime() + 7 * 3600 * 1000); // dời sang giờ treo tường HCM để đọc bằng UTC-getter
          const z = (n: number, c = 2): string => String(n).padStart(c, '0');
          return `${w.getUTCFullYear()}-${z(w.getUTCMonth() + 1)}-${z(w.getUTCDate())}T${z(w.getUTCHours())}:${z(w.getUTCMinutes())}:${z(w.getUTCSeconds())}.${z(w.getUTCMilliseconds(), 3)}+07:00`;
        };
        return sellFees
          .filter((o) => o['tidId'] === tidId && o['feeTypeId'] === feeTypeId && (o['deletedAt'] ?? null) === null)
          .sort((a, b) => (b['effectiveFrom'] as Date).getTime() - (a['effectiveFrom'] as Date).getTime() || (b['id'] as number) - (a['id'] as number))
          .map((o) => ({ id: o['id'], card_type_id: o['cardTypeId'], phi_ban: o['phiBan'], effective_from: isoHCM(o['effectiveFrom'] as Date) }));
      }
      throw new Error('Db giả chưa biết câu SQL này: ' + sql);
    },
    // PHA 2 — engine recalc chạy TRONG tx setTidSellFees: cần transaction.findMany/update + revenueRecalcLog.create.
    // Seed tid-sell-fee KHÔNG có GD → findMany rỗng → recalc scan 0 (không đụng kết quả assert phí bán).
    transaction: { findMany: async () => [], update: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) },
    revenueRecalcLog: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 1, ...data }) },
    // TOCTOU FIX — setTidSellFees gọi txc.$executeRawUnsafe(pg_advisory_xact_lock) + txc.$queryRawUnsafe(FOR UPDATE)
    // ở đầu tx. Db giả không chạy Postgres → mock no-op (khóa THẬT verify ở test Db-thật cuối file).
    // [13/11] TRƯỚC ĐÂY stub trả `[]` cho MỌI câu ⇒ câu "tìm KỲ cùng ngày" (đọc raw vì cần cột customer_id,
    // thêm 25/9) luôn rỗng ⇒ code tưởng chưa có kỳ nào và ĐẺ DÒNG THỨ 2 thay vì sửa tại chỗ. Test đỏ câm.
    // Nay phục vụ ĐÚNG các câu raw trên `tid_sell_fees` từ chính mảng `sellFees` của fake; câu lạ thì ném lỗi.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      ...fake,
      ...rawChung,
      $queryRawUnsafe: async (sql: string, ...p: unknown[]) => {
        if (sql.includes('FROM tids WHERE id')) return [{ id: p[0] as number }];
        if (sql.includes('FROM tid_sell_fees')) {
          const [tidId, cardTypeId, feeTypeId, tuIso, denIso, khachRieng] = p as [number, number, number, string, string, number];
          const tu = new Date(tuIso).getTime(), den = new Date(denIso).getTime();
          const chiConSong = sql.includes('deleted_at IS NULL');
          const ds = sellFees
            .filter((o) => o['tidId'] === tidId && o['cardTypeId'] === cardTypeId && o['feeTypeId'] === feeTypeId
              && (!chiConSong || (o['deletedAt'] ?? null) === null)
              && ((o['effectiveFrom'] as Date).getTime() >= tu) && ((o['effectiveFrom'] as Date).getTime() < den)
              && ((o['customerId'] as number | null) ?? 0) === khachRieng)
            .sort((a, b) => (b['id'] as number) - (a['id'] as number));
          const r = ds[0];
          return r ? [{ id: r['id'], phi_ban: r['phiBan'], deleted_at: r['deletedAt'] ?? null }] : [];
        }
        // Engine recalc chạy TRONG cùng tx ⇒ còn hỏi các câu về transactions/giá-cuối-tuần: chuyển cho stub
        // dùng chung (stub đó tự NÉM nếu gặp câu lạ — vẫn không nuốt im).
        return rawChung.$queryRawUnsafe(sql, ...p);
      },
      $executeRawUnsafe: async (sql: string, ...p: unknown[]) => {
        if (sql.includes('pg_advisory_xact_lock')) return 0;
        if (sql.includes('UPDATE tid_sell_fees SET effective_from')) {
          const r = sellFees.find((x) => x['id'] === (p[1] as number));
          if (r) r['effectiveFrom'] = new Date(String(p[0]));
          return r ? 1 : 0;
        }
        if (sql.includes('INSERT INTO tid_sell_fees')) {
          const [tidId, cardTypeId, feeTypeId, phiBan, effIso, customerId, by] = p as [number, number, number, number, string, number, number];
          sellFees.push({ id: nextId++, tidId, cardTypeId, feeTypeId, phiBan, effectiveFrom: new Date(effIso), customerId, createdBy: by, updatedBy: by, deletedAt: null });
          return 1;
        }
        return rawChung.$executeRawUnsafe(sql, ...p);
      }
    })
  };
  return { db: fake as unknown as Db, sellFees, audits };
}

describe('listTidSellFees', () => {
  it('thiếu quyền → FORBIDDEN', async () => {
    const { db } = makeFake();
    const r = await listTidSellFees({ db, user: authUser([]) }, 1, 3);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('thiếu loại phí → VALIDATION', async () => {
    const { db } = makeFake();
    const r = await listTidSellFees({ db, user: authUser(['TID_VIEW']) }, 1, 0);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Vui lòng chọn loại phí.');
  });

  it('có quyền → rows với phí mua/bán/cài máy niêm yết (%)', async () => {
    const { db } = makeFake();
    const r = await listTidSellFees({ db, user: authUser(['TID_VIEW']) }, 1, 3);
    expect(r.ok).toBe(true);
    expect(r.data!.rows[0]!.phiMuaNiemYet).toBe(1); // 1000 milli → 1%
    expect(r.data!.rows[0]!.phiBanNiemYet).toBe(3); // 3000 milli → 3%
    expect(r.data!.rows[0]!.phiCaiMayNiemYet).toBe(0.5);
    expect(r.data!.bankCode).toBe('VCB');
  });

  // FIX B (Admin Demo 20/8) — hasOverride/phiBanThucTe PHẢI resolve THEO `at` (pickEffectiveRate, khớp resolveFeeForTxn),
  // KHÔNG phải "bất kỳ dòng override còn sống". Override TƯƠNG LAI KHÔNG được coi là hiệu lực tại `at` trong quá khứ.
  it('FIX B — override TƯƠNG LAI: hasOverride theo `at` (trước mốc=false, từ mốc=true)', async () => {
    const future = new Date(2030, 0, 1); // nửa đêm LOCAL 01/01/2030
    const { db } = makeFake({ overrides: [{ id: 1, tidId: 1, cardTypeId: 11, feeTypeId: 3, phiBan: 4000, effectiveFrom: future, deletedAt: null }] });
    // `at` = hôm nay (TRƯỚC mốc tương lai) → override CHƯA hiệu lực → hasOverride=false (khớp backend rơi về niêm yết).
    const before = await listTidSellFees({ db, user: authUser(['TID_VIEW']) }, 1, 3, new Date());
    expect(before.ok).toBe(true);
    expect(before.data!.rows[0]!.hasOverride).toBe(false);
    expect(before.data!.rows[0]!.phiBanThucTe).toBe(null);
    // `at` ≥ mốc → override hiệu lực → hasOverride=true + phiBanThucTe = 4%.
    const after = await listTidSellFees({ db, user: authUser(['TID_VIEW']) }, 1, 3, future);
    expect(after.ok).toBe(true);
    expect(after.data!.rows[0]!.hasOverride).toBe(true);
    expect(after.data!.rows[0]!.phiBanThucTe).toBe(4); // 4000 milli → 4%
  });
});

// PHA 2 (2A) — LIST niêm yết theo (ngân hàng × đối tác) khi TID CHƯA tồn tại (luồng "Thêm TID" giao ngay).
// Fake db HONOR cardTypeId trong where (2 loại thẻ có quote khác nhau → assert đúng phiBanNiemYet mỗi thẻ).
function makeBankPartnerFake() {
  const cards = [
    { id: 11, code: 'VISA', name: 'Visa', bankId: 5, deletedAt: null },
    { id: 12, code: 'MC', name: 'MasterCard', bankId: 5, deletedAt: null }
  ];
  // FeeRate phí mua/cài máy theo cardType; FeeSellQuote phí bán theo cardType (loại phí 3).
  const rates: Record<number, Record<string, unknown>[]> = {
    11: [{ id: 1, effectiveFrom: PAST, phiMua: 1000, phiCaiMay: 500, deletedAt: null }],
    12: [{ id: 2, effectiveFrom: PAST, phiMua: 1200, phiCaiMay: 600, deletedAt: null }]
  };
  const quotes: Record<number, Record<string, unknown>[]> = {
    11: [{ id: 1, effectiveFrom: PAST, phiBan: 3000, deletedAt: null }], // 3%
    12: [{ id: 2, effectiveFrom: PAST, phiBan: 4500, deletedAt: null }]  // 4.5%
  };
  const fake = {
    feeType: { findUnique: async ({ where }: { where: { id: number } }) => (where.id === 3 ? { id: 3, deletedAt: null, name: 'Phí A' } : null) },
    cardType: { findMany: async ({ where }: { where: Record<string, unknown> }) => cards.filter((c) => c.bankId === where['bankId'] && c.deletedAt == null) },
    feeRate: { findMany: async ({ where }: { where: Record<string, unknown> }) => rates[where['cardTypeId'] as number] ?? [] },
    feeSellQuote: { findMany: async ({ where }: { where: Record<string, unknown> }) => quotes[where['cardTypeId'] as number] ?? [] }
  };
  return { db: fake as unknown as Db };
}

describe('listSellFeeRowsForBankPartner', () => {
  it('thiếu quyền → FORBIDDEN', async () => {
    const { db } = makeBankPartnerFake();
    const r = await listSellFeeRowsForBankPartner({ db, user: authUser([]) }, 5, 9, 3);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('thiếu loại phí → VALIDATION', async () => {
    const { db } = makeBankPartnerFake();
    const r = await listSellFeeRowsForBankPartner({ db, user: authUser(['TID_VIEW']) }, 5, 9, 0);
    expect(r.error).toBe('VALIDATION');
  });

  it('2 loại thẻ + niêm yết đối tác → rows đúng phiBanNiemYet, hasOverride=false, phiBanThucTe=null', async () => {
    const { db } = makeBankPartnerFake();
    const r = await listSellFeeRowsForBankPartner({ db, user: authUser(['TID_VIEW']) }, 5, 9, 3);
    expect(r.ok).toBe(true);
    expect(r.data!.length).toBe(2);
    const visa = r.data!.find((x) => x.cardTypeId === 11)!;
    const mc = r.data!.find((x) => x.cardTypeId === 12)!;
    expect(visa.phiBanNiemYet).toBe(3); // 3000 milli → 3%
    expect(visa.phiMuaNiemYet).toBe(1); // 1000 milli → 1%
    expect(visa.phiCaiMayNiemYet).toBe(0.5);
    expect(mc.phiBanNiemYet).toBe(4.5); // 4500 milli → 4.5%
    expect(mc.phiMuaNiemYet).toBe(1.2);
    // TID chưa tồn tại → không override.
    for (const row of r.data!) {
      expect(row.hasOverride).toBe(false);
      expect(row.phiBanThucTe).toBe(null);
    }
  });
});

describe('setTidSellFees', () => {
  it('thiếu quyền → FORBIDDEN', async () => {
    const { db } = makeFake();
    const r = await setTidSellFees({ db, user: authUser(['TID_VIEW']) }, { tidId: 1, feeTypeId: 3, entries: [{ cardTypeId: 11, phiBan: 2 }] });
    expect(r.error).toBe('FORBIDDEN');
  });

  // [B209 19/11 — Admin Demo "kể cả thẻ khác bank khác"] LUẬT ĐỔI: KHÔNG chặn thẻ khác ngân hàng nữa
  // (máy POS vẫn quẹt thẻ ngoài hệ thống). Bài kiểm nay khẳng định chiều NGƯỢC LẠI: lưu được.
  it('thẻ khác ngân hàng TID vẫn ĐẶT GIÁ BÁN được (luật mới 19/11)', async () => {
    const { db } = makeFake({ cards: [{ id: 11, code: 'VISA', name: 'Visa', bankId: 99, deletedAt: null }] });
    const r = await setTidSellFees({ db, user: authUser(['TID_MANAGE']) }, { tidId: 1, feeTypeId: 3, entries: [{ cardTypeId: 11, phiBan: 2 }] });
    expect(r.error).not.toBe('CARD_BANK_MISMATCH');
    expect(r.ok).toBe(true);
  });

  // [B209 19/11 — Admin Demo "giá bán được phép cao hoặc thấp hơn"] LUẬT ĐỔI: KHÔNG chặn bán dưới giá vốn nữa,
  // nhưng PHẢI trả về cảnh báo nêu rõ lỗ bao nhiêu — bỏ chặn mà im lặng mới là nguy hiểm.
  it('B86-2 — phí bán < phí mua: LƯU ĐƯỢC + kèm CẢNH BÁO nêu rõ phần lỗ', async () => {
    const { db } = makeFake(); // phiMua = 1%
    const r = await setTidSellFees({ db, user: authUser(['TID_MANAGE']) }, { tidId: 1, feeTypeId: 3, entries: [{ cardTypeId: 11, phiBan: 0.5 }] });
    expect(r.ok).toBe(true);
    expect(r.duoiPhiMua).toHaveLength(1);
    expect(r.duoiPhiMua?.[0]).toMatchObject({ cardTypeId: 11, phiBan: 0.5, phiMua: 1, loPct: 0.5 });
  });

  it('B86-2 — TID chưa gắn đối tác → CHẶN rõ ràng (không im lặng)', async () => {
    const { db } = makeFake({ tid: { id: 1, tid: 'TID001', bankId: 5, partnerId: null, deletedAt: null } });
    const r = await setTidSellFees({ db, user: authUser(['TID_MANAGE']) }, { tidId: 1, feeTypeId: 3, entries: [{ cardTypeId: 11, phiBan: 2 }] });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('TID chưa gắn đối tác, không thể xác định phí mua để so sánh.');
  });

  it('hợp lệ → tạo override KỲ hôm nay + audit TID_SELL_FEE_SET', async () => {
    const { db, sellFees, audits } = makeFake();
    const r = await setTidSellFees({ db, user: authUser(['TID_MANAGE']) }, { tidId: 1, feeTypeId: 3, entries: [{ cardTypeId: 11, phiBan: 2 }] });
    expect(r.ok).toBe(true);
    expect(sellFees[0]!['phiBan']).toBe(2000); // 2% → 2000 milli
    expect((sellFees[0]!['effectiveFrom'] as Date).getTime()).toBe(todayStart.getTime()); // default = nửa đêm LOCAL hôm nay
    expect(audits.some((a) => a['action'] === 'TID_SELL_FEE_SET')).toBe(true);
  });

  it('B141 REGRESSION — effectiveFrom LUÔN floor về nửa đêm Asia/Ho_Chi_Minh (TZ-độc-lập). Gốc bug 31/8: giá bán lưu kèm giờ-trong-ngày → bill quẹt sớm hơn giờ đó cùng ngày rớt NO_ACTUAL_SELL_FEE → NĐT/SigMa sót doanh số.', async () => {
    const { db, sellFees } = makeFake();
    // Set với GIỜ-trong-ngày (mô phỏng script thô/desktop lệch TZ) — phải floor về 00:00 HCM, GIỮ ngày 31/8.
    const r = await setTidSellFees({ db, user: authUser(['TID_MANAGE']) }, { tidId: 1, feeTypeId: 3, effectiveFrom: '2026-08-31T09:30:00+07:00', entries: [{ cardTypeId: 11, phiBan: 3 }] });
    expect(r.ok).toBe(true);
    const eff = sellFees[0]!['effectiveFrom'] as Date;
    // Wall-clock HCM của mốc lưu (dời +7h ra UTC) PHẢI đúng nửa đêm ngày 31/8 — không phụ thuộc TZ máy chạy test.
    const hcmWall = new Date(eff.getTime() + 7 * 3600_000).toISOString();
    expect(hcmWall.slice(11)).toBe('00:00:00.000Z'); // 00:00:00 HCM (không còn giờ-trong-ngày)
    expect(hcmWall.slice(0, 10)).toBe('2026-08-31'); // giữ đúng ngày HCM
  });

  it('phiBan null → xóa override (soft-delete) KỲ cùng ngày khi có sẵn', async () => {
    const { db, sellFees } = makeFake({ overrides: [{ id: 1, tidId: 1, cardTypeId: 11, feeTypeId: 3, phiBan: 2000, effectiveFrom: todayStart, deletedAt: null }] });
    const r = await setTidSellFees({ db, user: authUser(['TID_MANAGE']) }, { tidId: 1, feeTypeId: 3, entries: [{ cardTypeId: 11, phiBan: null }] });
    expect(r.ok).toBe(true);
    expect(sellFees[0]!['deletedAt']).not.toBeNull();
  });

  // ── P1 (nhiều KỲ override) ────────────────────────────────────────────────────────────────────
  it('P1: set KỲ LÙI (effectiveFrom quá khứ) tạo KỲ MỚI, KHÔNG đè KỲ hôm nay', async () => {
    const { db, sellFees } = makeFake({ overrides: [{ id: 1, tidId: 1, cardTypeId: 11, feeTypeId: 3, phiBan: 2000, effectiveFrom: todayStart, deletedAt: null }] });
    const r = await setTidSellFees({ db, user: authUser(['TID_MANAGE']) }, { tidId: 1, feeTypeId: 3, effectiveFrom: '2026-03-01', entries: [{ cardTypeId: 11, phiBan: 3 }] });
    expect(r.ok).toBe(true);
    const live = sellFees.filter((s) => s['deletedAt'] == null);
    expect(live.length).toBe(2); // KỲ cũ (hôm nay) GIỮ NGUYÊN + KỲ mới (01/03)
    const march = live.find((s) => (s['effectiveFrom'] as Date).getTime() === new Date(2026, 2, 1).getTime());
    expect(march!['phiBan']).toBe(3000);
  });

  it('P1: set LẠI cùng KỲ (cùng NGÀY) → cập nhật tại chỗ, không tạo dòng thứ 2', async () => {
    const { db, sellFees } = makeFake({ overrides: [{ id: 1, tidId: 1, cardTypeId: 11, feeTypeId: 3, phiBan: 2000, effectiveFrom: todayStart, deletedAt: null }] });
    const r = await setTidSellFees({ db, user: authUser(['TID_MANAGE']) }, { tidId: 1, feeTypeId: 3, entries: [{ cardTypeId: 11, phiBan: 4 }] }); // default = hôm nay = cùng KỲ
    expect(r.ok).toBe(true);
    expect(sellFees.length).toBe(1);
    expect(sellFees[0]!['phiBan']).toBe(4000);
  });

  it('P1: ngày hiệu lực không hợp lệ → VALIDATION', async () => {
    const { db } = makeFake();
    const r = await setTidSellFees({ db, user: authUser(['TID_MANAGE']) }, { tidId: 1, feeTypeId: 3, effectiveFrom: 'không-phải-ngày', entries: [{ cardTypeId: 11, phiBan: 2 }] });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Ngày hiệu lực không hợp lệ.');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// TOCTOU REGRESSION — Db THẬT (throwaway Postgres). Db giả chạy $transaction TUẦN TỰ nên khóa tư vấn cấp-giao-dịch
// là no-op; test này dựng DB thật, CHỨNG MINH (deterministic) setTidSellFees LẤY ĐÚNG khóa (910000002, tidId) NGAY
// đầu tx: nắm sẵn khóa từ kết nối ngoài → setTidSellFees PHẢI TREO; nhả → chạy tiếp. Gỡ khóa khỏi src ⇒ FAIL. Tự
// BỎ QUA nếu không có Postgres. SIGMA_TEST_PG_{HOST,PORT,USER,PASSWORD} override; mặc định postgres/localhost:5432.
const PG_ADMIN = {
  host: process.env['SIGMA_TEST_PG_HOST'] ?? 'localhost',
  port: Number(process.env['SIGMA_TEST_PG_PORT'] ?? 5432),
  user: process.env['SIGMA_TEST_PG_USER'] ?? 'postgres',
  password: process.env['SIGMA_TEST_PG_PASSWORD'] ?? 'postgres'
};
const TID_LOCK_NS = 910000002; // PHẢI khớp namespace trong src/tid-sell-fee.ts
const testDbName = `alpha_toctou_tid_${process.pid}_${Date.now()}`;
const testDbUrl = `postgresql://${PG_ADMIN.user}:${encodeURIComponent(PG_ADMIN.password)}@${PG_ADMIN.host}:${PG_ADMIN.port}/${testDbName}`;
// ĐỘC LẬP CWD: tính từ vị trí file test (packages/services/test → ../../.. = repo root), KHÔNG dựa process.cwd()
// (chạy `npm test` từ repo ROOT thì cwd=root → ../.. trỏ SAI ngoài repo → execFileSync ENOENT → suite fail giả).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const databaseDir = path.join(repoRoot, 'packages', 'database');
const prismaBin = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');

let realDb: Db | null = null;
let pgAvailable = false;

async function adminExec(sql: string): Promise<void> {
  const c = new pg.Client({ host: PG_ADMIN.host, port: PG_ADMIN.port, user: PG_ADMIN.user, password: PG_ADMIN.password, database: 'postgres' });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

beforeAll(async () => {
  try {
    await adminExec(`CREATE DATABASE "${testDbName}"`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[toctou] Postgres không sẵn — BỎ QUA test đua Db-thật:', e instanceof Error ? e.message : e);
    pgAvailable = false;
    return;
  }
  execFileSync(process.execPath, [prismaBin, 'migrate', 'deploy'], { cwd: databaseDir, env: { ...process.env, DATABASE_URL: testDbUrl }, stdio: 'pipe' });
  realDb = createPrisma(testDbUrl);
  // [16/11] `migrate deploy` KHÔNG tạo các CỘT PHỤ do schema-ensure dựng (vd `tid_sell_fees.customer_id`) — mà
  // mã nguồn thì đọc/ghi chúng bằng raw SQL. Thiếu bước này, 3 test Db-thật ở dưới NGÃ ngay câu raw đầu tiên
  // ("column customer_id does not exist") — và vì mặc định không có Postgres nên chúng IM LẶNG bỏ qua suốt,
  // không ai thấy. DB thử phải giống DB thật thì bài kiểm mới có nghĩa.
  await ensureAlphaExtraSchema(realDb);
  pgAvailable = true;
}, 120_000);

afterAll(async () => {
  if (realDb) await realDb.$disconnect().catch(() => {});
  if (pgAvailable) {
    try {
      await adminExec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${testDbName}' AND pid<>pg_backend_pid()`);
      await adminExec(`DROP DATABASE IF EXISTS "${testDbName}"`);
    } catch { /* best-effort dọn dẹp */ }
  }
}, 60_000);

async function seedTidBase(db: Db, tag: string): Promise<{ tidId: number; cardTypeId: number; feeTypeId: number; actorId: number }> {
  const bank = await db.bank.create({ data: { name: 'B', code: 'BK' + tag } });
  const partner = await db.partner.create({ data: { name: 'P', code: 'PT' + tag } });
  const card = await db.cardType.create({ data: { bankId: bank.id, name: 'Visa', code: 'V' } });
  const ft = await db.feeType.create({ data: { name: 'FT' + tag } });
  const tid = await db.tid.create({ data: { tid: 'TID' + tag, bankId: bank.id, partnerId: partner.id } });
  const actor = await db.user.create({ data: { fullName: 'Tester', username: 'u' + tag, passwordHash: 'x' } });
  // FeeRate hiệu lực (phí mua 1%) để check "bán ≥ mua" qua được (setTidSellFees bắt buộc có FeeRate).
  await db.feeRate.create({ data: { partnerId: partner.id, cardTypeId: card.id, phiMua: 1000, phiCaiMay: 0, effectiveFrom: new Date('2020-01-01'), createdBy: actor.id } });
  return { tidId: tid.id, cardTypeId: card.id, feeTypeId: ft.id, actorId: actor.id };
}

// [B167 — Admin Demo 16/11] MỐC HIỆU LỰC PHẢI ĐỌC ĐÚNG INSTANT trên Postgres THẬT.
// Vì sao phải Db thật: driver-adapter Prisma đọc timestamptz theo GIỜ TREO TƯỜNG rồi dán "Z" ⇒ LỆCH +7h.
// Db giả KHÔNG tái hiện được chuyện này (đo thật 16/11: SQL "16:47:54.773+07" ↔ Prisma "16:47:54.773Z").
// Hậu quả ĐÃ GẶP: đặt giá bán xong, màn hình vẫn báo "chưa đặt giá bán" và KHOÁ nút ghi bill, trong khi
// ENGINE tính tiền (transaction.ts) lại chấp nhận — hai bên nói hai kiểu về CÙNG một dòng.
describe('listTidSellFees — mốc hiệu lực đọc ĐÚNG instant (Db thật, B167)', () => {
  it('giá đặt lúc 00:00 giờ HCM ⇒ bill 00:30 CÙNG NGÀY đã có hiệu lực (không trượt 7h)', async () => {
    if (!pgAvailable || !realDb) { console.warn('[B167] skip: no Postgres'); return; }
    const db = realDb;
    const { tidId, cardTypeId, feeTypeId, actorId } = await seedTidBase(db, 'tz' + Date.now());
    const ctx: ServiceCtx = { db, user: authUser(['TID_MANAGE', 'TID_VIEW'], actorId) };

    // Đặt giá bán với mốc hiệu lực = 00:00 giờ HCM của 1 ngày cố định (16/11/2026 00:00+07 = 15/11 17:00Z).
    const nuaDem = new Date('2026-11-16T00:00:00+07:00');
    const r = await setTidSellFees(ctx, { tidId, feeTypeId, entries: [{ cardTypeId, phiBan: 2 }], effectiveFrom: nuaDem });
    expect(r.ok).toBe(true);

    // 00:30 CÙNG NGÀY (giờ HCM) — chỉ 30 phút sau mốc. Lệch +7h sẽ làm dòng này "chưa hiệu lực".
    const nuaGio = new Date('2026-11-16T00:30:00+07:00');
    const ds = await listTidSellFees(ctx, tidId, feeTypeId, nuaGio);
    const dong = (ds.data?.rows ?? []).find((x) => x.cardTypeId === cardTypeId);
    expect(dong?.hasOverride).toBe(true);
    expect(dong?.phiBanThucTe).toBe(2);

    // ĐỐI CHỨNG — TRƯỚC mốc 1 phút thì PHẢI chưa hiệu lực (nếu luôn true thì phép kiểm trên là vô nghĩa).
    const truocMoc = new Date('2026-11-15T23:59:00+07:00');
    const ds2 = await listTidSellFees(ctx, tidId, feeTypeId, truocMoc);
    expect((ds2.data?.rows ?? []).find((x) => x.cardTypeId === cardTypeId)?.hasOverride).toBe(false);

    // Và CHỨNG MINH gốc bệnh vẫn còn ở lớp Prisma: cùng dòng đó, đọc bằng Prisma lệch đúng +7h so với SQL.
    const quaPrisma = await db.tidSellFee.findFirst({ where: { tidId, feeTypeId, deletedAt: null } });
    const quaSql = await db.$queryRawUnsafe<Array<{ ms: string }>>(
      'SELECT (extract(epoch from effective_from)*1000)::bigint::text AS ms FROM tid_sell_fees WHERE tid_id = $1', tidId);
    const lechGio = (quaPrisma!.effectiveFrom.getTime() - Number(quaSql[0]!.ms)) / 3_600_000;
    expect(lechGio).toBe(7); // ĐÚNG 7 giờ — khi nào lớp driver được sửa thì phép kiểm này đỏ để báo đổi cách đọc
  }, 60_000);
});

describe('setTidSellFees — TOCTOU advisory-lock (Db thật)', () => {
  it('LẤY đúng khóa xact (910000002, tidId) đầu tx → chặn lời gọi song song rồi nhả', async () => {
    if (!pgAvailable || !realDb) { console.warn('[toctou] skip: no Postgres'); return; }
    const db = realDb;
    const { tidId, cardTypeId, feeTypeId, actorId } = await seedTidBase(db, 'a' + Date.now());
    const ctx: ServiceCtx = { db, user: authUser(['TID_MANAGE', 'TID_VIEW'], actorId) };

    const ext = new pg.Client(testDbUrl);
    await ext.connect();
    try {
      // objid = tidId NGUYÊN (khớp src). Nắm sẵn khóa → setTidSellFees phải treo tại đầu tx.
      await ext.query('SELECT pg_advisory_lock($1,$2)', [TID_LOCK_NS, tidId]);
      const p = setTidSellFees(ctx, { tidId, feeTypeId, entries: [{ cardTypeId, phiBan: 2 }] });
      let done = false;
      void p.then(() => (done = true), () => (done = true));
      await new Promise((r) => setTimeout(r, 800));
      expect(done).toBe(false); // BỊ CHẶN — src xin đúng key (gỡ khóa src ⇒ done=true ⇒ FAIL)
      await ext.query('SELECT pg_advisory_unlock($1,$2)', [TID_LOCK_NS, tidId]);
      const r = await p;
      expect(r.ok).toBe(true);
    } finally {
      await ext.end();
    }
    const rows = await db.tidSellFee.findMany({ where: { tidId, cardTypeId, feeTypeId, deletedAt: null } });
    expect(rows.length).toBe(1);
  }, 30_000);

  it('N lời gọi setTidSellFees SONG SONG cùng tid → 1 kỳ override, không lỗi, giá trị cuối nhất quán', async () => {
    if (!pgAvailable || !realDb) { console.warn('[toctou] skip: no Postgres'); return; }
    const db = realDb;
    const { tidId, cardTypeId, feeTypeId, actorId } = await seedTidBase(db, 'b' + Date.now());
    const ctx: ServiceCtx = { db, user: authUser(['TID_MANAGE'], actorId) };
    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        setTidSellFees(ctx, { tidId, feeTypeId, entries: [{ cardTypeId, phiBan: 2 + i * 0.001 }] })
      )
    );
    expect(results.every((r) => r.ok)).toBe(true); // serialize → không P2002 partial-unique / deadlock
    const rows = await db.tidSellFee.findMany({ where: { tidId, cardTypeId, feeTypeId, deletedAt: null } });
    expect(rows.length).toBe(1); // đúng 1 KỲ override còn sống (không 2 dòng trùng)
    expect([2000, 2001, 2002, 2003, 2004, 2005]).toContain(rows[0]!.phiBan); // giá trị cuối = 1 lần ghi
  }, 30_000);
});
