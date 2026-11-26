// Test LÕI THUẦN bank-config core (@sigma/services) — Db GIẢ in-memory ĐÚNG SHAPE Prisma + ServiceCtx = { db, user }.
// ASSERT giá trị cụ thể: error code + nguyên văn message tiếng Việt + seq NH auto + audit + soft-delete. §14 xác nhận
// MẬT KHẨU đã CHUYỂN RA ADAPTER (route) — lõi KHÔNG kiểm password (khuôn customer.ts).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  listBanks,
  createBank,
  updateBank,
  deleteBanks,
  listBanksLite,
  bankSeqCode,
  createCardType,
  updateCardType,
  listCardTypes,
  deleteCardTypes,
  createPartner,
  setPartnerBanks,
  getPartnerBankMatrix,
  type ServiceCtx
} from '../src/index.js';

interface Row { [k: string]: unknown; id: number; deletedAt: Date | null }

function makeFakeDb() {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const banks: Row[] = [
    { id: 1, seq: 1, name: 'Vietcombank', code: 'VCB', status: 'ACTIVE', createdBy: 42, createdAt: now, updatedBy: null, updatedAt: now, deletedAt: null, deletedBy: null }
  ];
  const cardTypes: Row[] = [];
  // [B189 19/11] CA TIỀN của ngân hàng (bảng bank_ca_tien, ngoài Prisma) — mock giữ trong mảng để test soi được.
  const caTienGia: { id: number; bank_id: number; ten: string; tu_phut: number; den_phut: number; thu_tu: number }[] = [];
  const partners: Row[] = [];
  const partnerBanks: Row[] = [];
  const statusOptions = [
    { entity: 'BANK', code: 'ACTIVE', deletedAt: null },
    { entity: 'BANK', code: 'INACTIVE', deletedAt: null },
    { entity: 'PARTNER', code: 'UNSIGNED', deletedAt: null },
    { entity: 'PARTNER', code: 'SIGNED', deletedAt: null }
  ];
  const audits: Record<string, unknown>[] = [];
  let nextId = 100;

  function model(store: Row[]) {
    return {
      findMany: async (args?: { where?: Record<string, unknown>; orderBy?: unknown }) => {
        const w = args?.where ?? {};
        let rows = store.slice();
        if ('deletedAt' in w) rows = rows.filter((r) => r.deletedAt === (w['deletedAt'] ?? null));
        if (w['status']) rows = rows.filter((r) => r['status'] === w['status']);
        if (w['bankId'] !== undefined) rows = rows.filter((r) => r['bankId'] === w['bankId']);
        const pid = w['partnerId'] as { in?: number[] } | number | undefined;
        if (typeof pid === 'number') rows = rows.filter((r) => r['partnerId'] === pid);
        else if (pid?.in) rows = rows.filter((r) => pid.in!.includes(r['partnerId'] as number));
        const idIn = (w['id'] as { in?: number[] } | undefined)?.in;
        if (idIn) rows = rows.filter((r) => idIn.includes(r.id));
        return rows.map((r) => ({ ...r }));
      },
      findUnique: async ({ where }: { where: { id: number } }) => {
        const r = store.find((x) => x.id === where.id);
        return r ? { ...r } : null;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const not = (where['NOT'] as { id?: number } | undefined)?.id;
        const r = store.find((x) => {
          if (not !== undefined && x.id === not) return false;
          if (where['code'] !== undefined && x['code'] !== where['code']) return false;
          if (where['name'] !== undefined && x['name'] !== where['name']) return false;
          if (where['bankId'] !== undefined && x['bankId'] !== where['bankId']) return false;
          if (where['partnerId'] !== undefined && x['partnerId'] !== where['partnerId']) return false;
          if (where['deletedAt'] !== undefined && x.deletedAt !== where['deletedAt']) return false;
          return true;
        });
        return r ? { ...r } : null;
      },
      aggregate: async () => ({ _max: { seq: store.reduce((m, r) => Math.max(m, (r['seq'] as number) ?? 0), 0) } }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const t = new Date();
        const row: Row = { id: nextId++, createdAt: t, updatedAt: t, updatedBy: null, deletedAt: null, deletedBy: null, ...data } as Row;
        store.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
        const r = store.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return { ...r };
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let n = 0;
        for (const r of store) {
          if (where['partnerId'] !== undefined && r['partnerId'] !== where['partnerId']) continue;
          if (where['deletedAt'] !== undefined && r.deletedAt !== where['deletedAt']) continue;
          Object.assign(r, data);
          n++;
        }
        return { count: n };
      }
    };
  }

  const fake = {
    bank: model(banks),
    cardType: model(cardTypes),
    partner: model(partners),
    partnerBank: model(partnerBanks),
    statusOption: { findFirst: async ({ where }: { where: { entity: string; code: string; deletedAt: null } }) => statusOptions.find((s) => s.entity === where.entity && s.code === where.code && s.deletedAt === null) ?? null },
    user: { findMany: async () => [{ id: 42, fullName: 'Người Kiểm Thử', username: 'tester' }] },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'Bank', version: 1 }) },
    // CỘT PHỤ `card_types.is_default` (schema-ensure) không có trong Prisma client ⇒ lõi dùng raw SQL.
    // Db giả phải HIỂU ĐÚNG 3 câu đó, nếu không test "xanh" mà thực tế chưa chạy câu nào (R198).
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      if (/SET is_default = false WHERE bank_id = \$1 AND id <> \$2/.test(sql)) {
        let n = 0;
        for (const r of cardTypes) if (r['bankId'] === args[0] && r.id !== args[1]) { r['is_default'] = false; n++; }
        return n;
      }
      if (/SET is_default = true WHERE id = \$1/.test(sql)) {
        const r = cardTypes.find((x) => x.id === args[0]);
        if (r) r['is_default'] = true;
        return r ? 1 : 0;
      }
      if (/SET is_default = false WHERE id = \$1/.test(sql)) {
        const r = cardTypes.find((x) => x.id === args[0]);
        if (r) r['is_default'] = false;
        return r ? 1 : 0;
      }
      // [B185/B189] ghi mốc ca + danh sách ca — chấp nhận nhưng KHÔNG im: ghi vào mảng để test soi được.
      if (/UPDATE banks SET ca1_het_phut/.test(sql)) return 1;
      if (/UPDATE bank_ca_tien SET deleted_at/.test(sql)) { caTienGia.length = 0; return 1; }
      if (/INSERT INTO bank_ca_tien/.test(sql)) {
        caTienGia.push({ id: caTienGia.length + 1, bank_id: args[0] as number, ten: args[1] as string, tu_phut: args[2] as number, den_phut: args[3] as number, thu_tu: args[4] as number });
        return 1;
      }
      throw new Error('Db giả chưa biết câu SQL này: ' + sql); // KHÔNG nuốt — câu lạ phải làm test ĐỎ
    },
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      if (/SELECT id FROM card_types WHERE is_default = true/.test(sql)) {
        return cardTypes.filter((r) => r['is_default'] === true && args.includes(r.id)).map((r) => ({ id: r.id }));
      }
      // [B185/B189 19/11] 2 câu đọc MỐC CA TIỀN. Mock phải trả ĐÚNG HÌNH DẠNG thật (tên cột snake_case,
      // số nguyên phút) — trả shape sai thì test xanh mà app vẫn hỏng.
      if (/SELECT id, ca1_het_phut, ca2_het_phut FROM banks/.test(sql)) {
        const ids = (args[0] ?? []) as number[];
        return banks.filter((b) => ids.includes(b.id)).map((b) => ({ id: b.id, ca1_het_phut: null, ca2_het_phut: null }));
      }
      if (/FROM bank_ca_tien/.test(sql)) {
        return caTienGia; // mặc định rỗng = ngân hàng chưa khai ca
      }
      if (/SELECT ca1_het_phut, ca2_het_phut FROM banks WHERE id = \$1/.test(sql)) {
        return [{ ca1_het_phut: null, ca2_het_phut: null }];
      }
      throw new Error('Db giả chưa biết câu SQL này: ' + sql);
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake)
  };
  return { db: fake as unknown as Db, banks, cardTypes, partners, partnerBanks, audits };
}

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

describe('bankSeqCode', () => {
  it('seq → NH## padStart, null giữ null', () => {
    expect(bankSeqCode(1)).toBe('NH01');
    expect(bankSeqCode(12)).toBe('NH12');
    expect(bankSeqCode(null)).toBeNull();
  });
});

describe('listBanks', () => {
  it('thiếu quyền CONFIG_BANK_VIEW → FORBIDDEN + message nguyên văn', async () => {
    const { db } = makeFakeDb();
    const r = await listBanks({ db, user: authUser([]) }, {});
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });
  it('có quyền → data + seqCode NH01 + trail', async () => {
    const ctx: ServiceCtx = { db: makeFakeDb().db, user: authUser(['CONFIG_BANK_VIEW']) };
    const r = await listBanks(ctx, {});
    expect(r.ok).toBe(true);
    expect(r.data![0]!.seqCode).toBe('NH01');
    expect(r.data![0]!.createdByName).toBe('Người Kiểm Thử');
  });
});

describe('createBank', () => {
  it('trạng thái không hợp lệ → VALIDATION nguyên văn', async () => {
    const { db } = makeFakeDb();
    const r = await createBank({ db, user: authUser(['CONFIG_BANK_MANAGE']) }, { name: 'ACB', code: 'ACB', status: 'SAI' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Trạng thái ngân hàng không hợp lệ.');
  });
  it('tên rỗng → VALIDATION', async () => {
    const { db } = makeFakeDb();
    const r = await createBank({ db, user: authUser(['CONFIG_BANK_MANAGE']) }, { name: '  ', code: 'ACB' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Tên ngân hàng bắt buộc.');
  });
  it('mã trùng (active) → DUPLICATE', async () => {
    const { db } = makeFakeDb();
    const r = await createBank({ db, user: authUser(['CONFIG_BANK_MANAGE']) }, { name: 'VCB2', code: 'vcb' });
    expect(r.error).toBe('DUPLICATE');
    expect(r.message).toBe('Mã ngân hàng "VCB" đã tồn tại.');
  });
  it('hợp lệ → seq tiếp theo + createdBy + audit BANK_CREATED', async () => {
    const { db, banks, audits } = makeFakeDb();
    const r = await createBank({ db, user: authUser(['CONFIG_BANK_MANAGE']) }, { name: 'ACB', code: 'acb' });
    expect(r.ok).toBe(true);
    const created = banks.find((b) => b['code'] === 'ACB')!;
    expect(created['seq']).toBe(2);
    expect(created['createdBy']).toBe(42);
    expect(audits.some((a) => a['action'] === 'BANK_CREATED')).toBe(true);
  });
});

describe('updateBank', () => {
  it('không tồn tại → NOT_FOUND', async () => {
    const { db } = makeFakeDb();
    const r = await updateBank({ db, user: authUser(['CONFIG_BANK_MANAGE']) }, 999, { name: 'X' });
    expect(r.error).toBe('NOT_FOUND');
    expect(r.message).toBe('Ngân hàng không tồn tại.');
  });
  it('optimistic-lock lệch → STALE_WRITE', async () => {
    const { db, banks } = makeFakeDb();
    const r = await updateBank({ db, user: authUser(['CONFIG_BANK_MANAGE']) }, 1, { name: 'Mới', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
    expect(r.error).toBe('STALE_WRITE');
    expect(banks[0]!['name']).toBe('Vietcombank');
  });
});

describe('deleteBanks', () => {
  it('chưa chọn id → VALIDATION', async () => {
    const { db } = makeFakeDb();
    const r = await deleteBanks({ db, user: authUser(['CONFIG_BANK_MANAGE']) }, []);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Chưa chọn ngân hàng để xóa.');
  });
  it('lõi giả định đã xác thực (adapter kiểm mật khẩu) → soft-delete + audit BANK_DELETED', async () => {
    const { db, banks, audits } = makeFakeDb();
    const r = await deleteBanks({ db, user: authUser(['CONFIG_BANK_MANAGE']) }, [1]);
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(1);
    expect(banks[0]!.deletedAt).toBeInstanceOf(Date);
    expect(banks[0]!['deletedBy']).toBe(42);
    expect(audits.some((a) => a['action'] === 'BANK_DELETED')).toBe(true);
  });
});

describe('listBanksLite', () => {
  it('có quyền → data gọn', async () => {
    const r = await listBanksLite({ db: makeFakeDb().db, user: authUser(['CONFIG_BANK_VIEW']) });
    expect(r.ok).toBe(true);
    expect(r.data!.some((b) => b.code === 'VCB')).toBe(true);
  });
});

describe('createCardType', () => {
  it('thiếu bankId → VALIDATION', async () => {
    const { db } = makeFakeDb();
    const r = await createCardType({ db, user: authUser(['CONFIG_BANK_MANAGE']) }, { bankId: 0, name: 'Visa', code: 'VISA' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Vui lòng chọn ngân hàng cho loại thẻ.');
  });
  it('ngân hàng không tồn tại → NOT_FOUND', async () => {
    const { db } = makeFakeDb();
    const r = await createCardType({ db, user: authUser(['CONFIG_BANK_MANAGE']) }, { bankId: 777, name: 'Visa', code: 'VISA' });
    expect(r.error).toBe('NOT_FOUND');
    expect(r.message).toBe('Ngân hàng đã chọn không tồn tại.');
  });
  it('hợp lệ → tạo + audit CARD_TYPE_CREATED', async () => {
    const { db, cardTypes, audits } = makeFakeDb();
    const r = await createCardType({ db, user: authUser(['CONFIG_BANK_MANAGE']) }, { bankId: 1, name: 'Visa', code: 'VISA' });
    expect(r.ok).toBe(true);
    expect(cardTypes[0]!['createdBy']).toBe(42);
    expect(audits.some((a) => a['action'] === 'CARD_TYPE_CREATED')).toBe(true);
  });
});

// [Admin Demo 15/11] THẺ MẶC ĐỊNH — mỗi ngân hàng NHIỀU NHẤT 1. Sai bất biến này thì màn Thêm bill chọn sẵn
// thẻ tuỳ thứ tự trả về ⇒ ghi bill sai loại thẻ = sai % phí = SAI TIỀN, mà không ai thấy.
describe('thẻ mặc định của ngân hàng', () => {
  const CT = ['CONFIG_BANK_MANAGE'];
  it('tạo với isDefault → cắm cờ; mặc định KHÔNG cắm cờ', async () => {
    const { db, cardTypes } = makeFakeDb();
    await createCardType({ db, user: authUser(CT) }, { bankId: 1, name: 'Visa', code: 'VISA' });
    expect(cardTypes[0]!['is_default']).toBeUndefined(); // không gửi ⇒ KHÔNG tự cắm cờ
    await createCardType({ db, user: authUser(CT) }, { bankId: 1, name: 'Napas', code: 'NAPAS', isDefault: true });
    expect(cardTypes[1]!['is_default']).toBe(true);
  });
  it('cắm cờ thẻ mới → thẻ cũ CÙNG ngân hàng tự bỏ cờ, thẻ ngân hàng KHÁC giữ nguyên', async () => {
    const { db, banks, cardTypes } = makeFakeDb();
    banks.push({ id: 2, seq: 2, name: 'MB', code: 'MB', status: 'ACTIVE', createdBy: 42, createdAt: new Date(), updatedBy: null, updatedAt: new Date(), deletedAt: null, deletedBy: null });
    await createCardType({ db, user: authUser(CT) }, { bankId: 1, name: 'Visa', code: 'VISA', isDefault: true });
    await createCardType({ db, user: authUser(CT) }, { bankId: 2, name: 'Visa', code: 'VISA', isDefault: true });
    await createCardType({ db, user: authUser(CT) }, { bankId: 1, name: 'Napas', code: 'NAPAS', isDefault: true });
    const theoNH = (b: number) => cardTypes.filter((r) => r['bankId'] === b && r['is_default'] === true).map((r) => r['code']);
    expect(theoNH(1)).toEqual(['NAPAS']); // CHỈ 1 thẻ mặc định cho NH 1
    expect(theoNH(2)).toEqual(['VISA']); // ngân hàng khác KHÔNG bị đụng
  });
  it('sửa mà KHÔNG gửi isDefault → giữ nguyên cờ; gửi false → bỏ cờ', async () => {
    const { db, cardTypes } = makeFakeDb();
    const r = await createCardType({ db, user: authUser(CT) }, { bankId: 1, name: 'Visa', code: 'VISA', isDefault: true });
    const id = r.id as number;
    await updateCardType({ db, user: authUser(CT) }, id, { name: 'Visa nội địa' });
    expect(cardTypes[0]!['is_default']).toBe(true);
    await updateCardType({ db, user: authUser(CT) }, id, { isDefault: false });
    expect(cardTypes[0]!['is_default']).toBe(false);
  });
  it('listCardTypes trả đúng cờ isDefault cho từng dòng', async () => {
    const { db } = makeFakeDb();
    await createCardType({ db, user: authUser(CT) }, { bankId: 1, name: 'Visa', code: 'VISA' });
    await createCardType({ db, user: authUser(CT) }, { bankId: 1, name: 'Napas', code: 'NAPAS', isDefault: true });
    const ds = await listCardTypes({ db, user: authUser(['CONFIG_BANK_VIEW', ...CT]) }, {});
    const theo = Object.fromEntries((ds.data ?? []).map((x) => [x.code, x.isDefault]));
    expect(theo).toEqual({ VISA: false, NAPAS: true });
  });
});

describe('deleteCardTypes', () => {
  it('chưa chọn id → VALIDATION nguyên văn loại thẻ', async () => {
    const { db } = makeFakeDb();
    const r = await deleteCardTypes({ db, user: authUser(['CONFIG_BANK_MANAGE']) }, []);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Chưa chọn loại thẻ để xóa.');
  });
});

describe('createPartner + setPartnerBanks + matrix', () => {
  it('trạng thái đối tác không hợp lệ → VALIDATION', async () => {
    const { db } = makeFakeDb();
    const r = await createPartner({ db, user: authUser(['CONFIG_BANK_MANAGE']) }, { name: 'Đối tác A', code: 'DTA', status: 'XYZ' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Trạng thái đối tác không hợp lệ.');
  });
  it('tạo đối tác (default UNSIGNED) + liên kết ngân hàng + matrix có tích', async () => {
    const { db, partners, partnerBanks, audits } = makeFakeDb();
    const ctx: ServiceCtx = { db, user: authUser(['CONFIG_BANK_MANAGE', 'CONFIG_BANK_VIEW']) };
    const cr = await createPartner(ctx, { name: 'Đối tác A', code: 'dta' });
    expect(cr.ok).toBe(true);
    const pid = partners[0]!.id;
    const link = await setPartnerBanks(ctx, pid, [1]);
    expect(link.ok).toBe(true);
    expect(link.linked).toBe(1);
    expect(partnerBanks.some((l) => l['partnerId'] === pid && l['bankId'] === 1 && l.deletedAt === null)).toBe(true);
    expect(audits.some((a) => a['action'] === 'PARTNER_BANK_LINKED')).toBe(true);
    const m = await getPartnerBankMatrix(ctx);
    expect(m.ok).toBe(true);
    expect(m.data!.rows.find((x) => x.partnerId === pid)!.bankIds).toContain(1);
  });
  it('setPartnerBanks đối tác không tồn tại → NOT_FOUND', async () => {
    const { db } = makeFakeDb();
    const r = await setPartnerBanks({ db, user: authUser(['CONFIG_BANK_MANAGE']) }, 999, [1]);
    expect(r.error).toBe('NOT_FOUND');
    expect(r.message).toBe('Đối tác không tồn tại.');
  });
});
