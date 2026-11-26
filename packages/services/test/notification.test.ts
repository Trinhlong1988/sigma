// Test LÕI THUẦN notification core (@sigma/services, CHỈ ĐỌC). ASSERT: thiếu TID_VIEW → FORBIDDEN nguyên văn; có
// quyền → tóm tắt đúng (count, topTid = TID tồn LÂU NHẤT do listUndeliveredTids sort dài-nhất-trước, totalAgingDays
// = tổng aging). Fake Db đủ shape cho listUndeliveredTids (tid.findMany + buildTidMaps FK tables rỗng).
// GHI CHÚ: chỉ phần ĐỌC getUndeliveredSummary được migrate — push Zalo + scheduler nền KHÔNG (ngoài phạm vi route).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { getUndeliveredSummary } from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 1, username: 'admin', fullName: 'Admin', status: 'ACTIVE', forceChangePassword: false, roles: ['ADMIN'], permissions };
}

/** 1 dòng TID tối thiểu (mọi FK null → buildTidMaps maps rỗng, toDto không cần join). */
function tidRow(over: { id: number; tid: string; openedAt: Date }): Record<string, unknown> {
  return {
    id: over.id,
    tid: over.tid,
    mid: null,
    bank: null,
    status: 'ACTIVE',
    posSerial: null,
    customerId: null,
    agentId: null,
    openedAt: over.openedAt,
    deliveredAt: null,
    closedAt: null,
    createdAt: over.openedAt,
    updatedAt: over.openedAt, // toDto đọc updatedAt.toISOString() — cột DB thật luôn có (fixture cũ thiếu).
    customerDeviceSerial: null,
    dossierId: null,
    industryId: null,
    bankId: null,
    partnerId: null,
    hkdName: null,
    receiveAccountId: null,
    issuedAt: null,
    configStatusId: null,
    dossierSourceId: null,
    note: null
  };
}

function makeFakeDb(rows: Record<string, unknown>[]): Db {
  const emptyFind = { findMany: async () => [] as unknown[] };
  return {
    tid: { findMany: async () => rows },
    // buildTidMaps FK lookup tables — không cần dữ liệu vì mọi FK null.
    bank: { ...emptyFind },
    partner: { ...emptyFind },
    tidConfigStatus: { ...emptyFind },
    dossierSource: { ...emptyFind },
    customer: { ...emptyFind },
    agent: { ...emptyFind },
    industry: { ...emptyFind },
    receiveAccount: { ...emptyFind }, // Phase B — buildTidMaps join TK nhận tiền
    investor: { ...emptyFind }, // Phase B — owy investor
    customerChatGroup: { ...emptyFind }, // P4 — buildTidMaps batch cảnh báo giao-dở
    tidSellFee: { ...emptyFind } // P4 — buildTidMaps batch cảnh báo giá bán thực tế
  } as unknown as Db;
}

describe('getUndeliveredSummary', () => {
  it('thiếu quyền TID_VIEW → FORBIDDEN nguyên văn', async () => {
    const r = await getUndeliveredSummary({ db: makeFakeDb([]), user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('có quyền, không TID chưa giao → summary rỗng (count 0)', async () => {
    const r = await getUndeliveredSummary({ db: makeFakeDb([]), user: authUser(['TID_VIEW']) });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ count: 0, totalAgingDays: 0, topAgingDays: 0, topTid: null });
  });

  it('có quyền → count đúng + topTid = TID tồn LÂU NHẤT + totalAgingDays = tổng', async () => {
    const now = Date.now();
    const rows = [
      tidRow({ id: 1, tid: 'TID-NEW', openedAt: new Date(now - 2 * 86_400_000) }), // ~2 ngày
      tidRow({ id: 2, tid: 'TID-OLD', openedAt: new Date(now - 10 * 86_400_000) }) // ~10 ngày (lâu nhất)
    ];
    const r = await getUndeliveredSummary({ db: makeFakeDb(rows), user: authUser(['TID_VIEW']) });
    expect(r.ok).toBe(true);
    expect(r.data!.count).toBe(2);
    // listUndeliveredTids sort dài-nhất-trước → top là TID-OLD.
    expect(r.data!.topTid).toBe('TID-OLD');
    expect(r.data!.topAgingDays).toBeGreaterThanOrEqual(9);
    // tổng = top + dòng còn lại; nhất quán với chính kết quả trả về (không đoán ngày tuyệt đối).
    expect(r.data!.totalAgingDays).toBeGreaterThanOrEqual(r.data!.topAgingDays);
    expect(r.data!.totalAgingDays).toBeGreaterThanOrEqual(11);
  });
});
