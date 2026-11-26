// Test LÕI THUẦN customer-chat-group core (@sigma/services) — KHÔNG cần Postgres/Electron: bơm 1 Db GIẢ in-memory
// ĐÚNG SHAPE Prisma (customer / feeType / chatRoom / customerChatGroup / auditLog / changeToken) + dựng ServiceCtx.
// ASSERT GIÁ TRỊ CỤ THỂ (error code + nguyên văn message tiếng Việt + KỲ gán/hủy + feeTypeName/roomName join).
// MÔ HÌNH KỲ: hàng sống = unassignedAt IS NULL (thay soft-delete cũ). Hủy gán = set unassignedAt; Đổi nhóm = đóng
// kỳ cũ + mở kỳ mới. Picker listAssignableChatGroups = nhóm GROUP CHƯA gán khách nào.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { listCustomerChatGroups, setCustomerChatGroups, listAssignableChatGroups } from '../src/customer-chat-group.js';
import type { ServiceCtx } from '../src/customer.js';

interface FakeGroup {
  id: number;
  customerId: number;
  feeTypeId: number;
  roomId: string | null;
  link: string | null;
  qr: string | null;
  note: string | null;
  zaloGroupId: string | null;
  createdBy: number | null;
  assignedFrom: Date;
  unassignedAt: Date | null;
}

interface FakeRoom { id: string; type: string; name: string | null; deletedAt: Date | null }

interface FakeOpts {
  customer?: { id: number; deletedAt: Date | null } | null;
  feeTypes?: { id: number; name: string; deletedAt: Date | null }[];
  rooms?: FakeRoom[];
  groups?: Partial<FakeGroup>[];
}

function mkGroup(g: Partial<FakeGroup>): FakeGroup {
  return {
    id: g.id ?? 0,
    customerId: g.customerId ?? 1,
    feeTypeId: g.feeTypeId ?? 0,
    roomId: g.roomId ?? null,
    link: g.link ?? null,
    qr: g.qr ?? null,
    note: g.note ?? null,
    zaloGroupId: g.zaloGroupId ?? null,
    createdBy: g.createdBy ?? null,
    assignedFrom: g.assignedFrom ?? new Date('2026-01-01T00:00:00Z'),
    unassignedAt: g.unassignedAt ?? null
  };
}

function makeFakeDb(opts: FakeOpts = {}) {
  const customerSeed = opts.customer === undefined ? { id: 1, deletedAt: null } : opts.customer;
  const feeSeed = opts.feeTypes ?? [
    { id: 10, name: 'Ủy quyền', deletedAt: null },
    { id: 11, name: 'Tiền chờ', deletedAt: null },
    { id: 12, name: 'Tiền nhanh', deletedAt: null }
  ];
  const roomSeed: FakeRoom[] = opts.rooms ?? [
    { id: 'room-A', type: 'GROUP', name: 'Nhóm Ủy quyền A', deletedAt: null },
    { id: 'room-B', type: 'GROUP', name: 'Nhóm Tiền chờ B', deletedAt: null }
  ];
  const groups: FakeGroup[] = (opts.groups ?? []).map(mkGroup);
  const audits: Record<string, unknown>[] = [];
  let nextId = groups.reduce((m, g) => Math.max(m, g.id), 0) + 1;

  const matchWhere = (g: FakeGroup, where?: { customerId?: number; unassignedAt?: Date | null; roomId?: { not: null }; zaloGroupId?: string; NOT?: { customerId?: number } }) =>
    (where?.customerId === undefined || g.customerId === where.customerId) &&
    (where?.unassignedAt === undefined || g.unassignedAt === where.unassignedAt) &&
    (where?.roomId === undefined || (where.roomId.not === null && g.roomId !== null)) &&
    (where?.zaloGroupId === undefined || g.zaloGroupId === where.zaloGroupId) &&
    (where?.NOT?.customerId === undefined || g.customerId !== where.NOT.customerId);

  const customerChatGroup = {
    findMany: async ({ where, orderBy, select }: { where?: Record<string, unknown>; orderBy?: unknown; select?: { roomId?: boolean } }) => {
      let rows = groups.filter((g) => matchWhere(g, where as never)).map((g) => ({ ...g }));
      if (orderBy) rows = rows.sort((a, b) => a.id - b.id);
      if (select?.roomId) return rows.map((r) => ({ roomId: r.roomId }));
      return rows;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = mkGroup({
        id: nextId++,
        customerId: data['customerId'] as number,
        feeTypeId: data['feeTypeId'] as number,
        roomId: (data['roomId'] as string | null) ?? null,
        link: (data['link'] as string | null) ?? null,
        qr: (data['qr'] as string | null) ?? null,
        note: (data['note'] as string | null) ?? null,
        zaloGroupId: (data['zaloGroupId'] as string | null) ?? null,
        createdBy: (data['createdBy'] as number | null) ?? null,
        assignedFrom: (data['assignedFrom'] as Date) ?? new Date(),
        unassignedAt: (data['unassignedAt'] as Date | null) ?? null
      });
      groups.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
      const g = groups.find((x) => x.id === where.id);
      if (!g) throw new Error('group not found');
      for (const [k, v] of Object.entries(data)) (g as unknown as Record<string, unknown>)[k] = v;
      return { ...g };
    },
    findFirst: async ({ where, select }: { where?: Record<string, unknown>; select?: { customerId?: boolean; roomId?: boolean } }) => {
      const g = groups.find((x) => matchWhere(x, where as never));
      if (!g) return null;
      if (select) return { customerId: g.customerId, roomId: g.roomId };
      return { ...g };
    }
  };

  const feeType = {
    findFirst: async ({ where }: { where: { id: number; deletedAt: null } }) => {
      const f = feeSeed.find((x) => x.id === where.id && x.deletedAt === null);
      return f ? { id: f.id } : null;
    },
    findMany: async ({ where }: { where: { id: { in: number[] } } }) =>
      feeSeed.filter((f) => where.id.in.includes(f.id)).map((f) => ({ id: f.id, name: f.name }))
  };

  const chatRoom = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const r = roomSeed.find((x) => x.id === where.id);
      return r ? { id: r.id, deletedAt: r.deletedAt } : null;
    },
    findMany: async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
      // Nhánh 1: join tên phòng cho list (where {id:{in:[...]}}).
      const idIn = (where['id'] as { in?: string[] } | undefined)?.in;
      if (idIn) return roomSeed.filter((r) => idIn.includes(r.id)).map((r) => ({ id: r.id, name: r.name }));
      // Nhánh 2: picker — {type:'GROUP', deletedAt:null, id?:{notIn}, AND?:[{OR:[{name:{contains,mode}}, {id:{contains}}]}]}.
      let rows = roomSeed.filter((r) => r.type === (where['type'] as string) && r.deletedAt === null);
      const notIn = (where['id'] as { notIn?: string[] } | undefined)?.notIn;
      if (notIn) rows = rows.filter((r) => !notIn.includes(r.id));
      const and = where['AND'] as { OR: { name?: { contains: string }; id?: { contains: string } }[] }[] | undefined;
      if (and) {
        for (const clause of and) {
          rows = rows.filter((r) =>
            clause.OR.some((o) =>
              (o.name && (r.name ?? '').toLowerCase().includes(o.name.contains.toLowerCase())) ||
              (o.id && r.id.toLowerCase().includes(o.id.contains.toLowerCase()))
            )
          );
        }
      }
      if (orderBy) rows = rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
      if (take) rows = rows.slice(0, take);
      return rows.map((r) => ({ id: r.id, name: r.name }));
    }
  };

  const customer = {
    findUnique: async ({ where }: { where: { id: number } }) => (customerSeed && customerSeed.id === where.id ? { ...customerSeed } : null)
  };

  const fake = {
    customer,
    feeType,
    chatRoom,
    customerChatGroup,
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'Customer', version: 1 }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake)
  };
  return { db: fake as unknown as Db, groups, audits };
}

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

// ───────────────────────── set (mô hình kỳ) ─────────────────────────
describe('setCustomerChatGroups', () => {
  it('thiếu quyền (không UPDATE và không CREATE) → FORBIDDEN', async () => {
    const { db } = makeFakeDb();
    const r = await setCustomerChatGroups({ db, user: authUser(['CUSTOMER_VIEW']) }, 1, []);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('đặt 3 nhóm 3 loại phí hợp lệ → ok + 3 kỳ active + audit CUSTOMER_UPDATED', async () => {
    const { db, groups, audits } = makeFakeDb();
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_UPDATE']) };
    const r = await setCustomerChatGroups(ctx, 1, [
      { feeTypeId: 10, roomId: 'room-A', link: 'https://a', qr: 'qrA' },
      { feeTypeId: 11, roomId: 'room-B' },
      { feeTypeId: 12, note: 'nhanh' }
    ]);
    expect(r.ok).toBe(true);
    expect(r.id).toBe(1);
    expect(groups.filter((g) => g.unassignedAt === null)).toHaveLength(3);
    expect(groups.find((g) => g.feeTypeId === 10)!.roomId).toBe('room-A');
    expect(groups.find((g) => g.feeTypeId === 10)!.createdBy).toBe(42);
    expect(groups.find((g) => g.feeTypeId === 10)!.assignedFrom).toBeInstanceOf(Date);
    expect(groups.find((g) => g.feeTypeId === 12)!.roomId).toBeNull();
    expect(audits[0]!['action']).toBe('CUSTOMER_UPDATED');
    expect(audits[0]!['targetType']).toBe('Customer');
  });

  it('CUSTOMER_CREATE (không UPDATE) cũng cho phép đặt nhóm', async () => {
    const { db, groups } = makeFakeDb();
    const r = await setCustomerChatGroups({ db, user: authUser(['CUSTOMER_CREATE']) }, 1, [{ feeTypeId: 10, roomId: 'room-A' }]);
    expect(r.ok).toBe(true);
    expect(groups).toHaveLength(1);
  });

  it('khách không tồn tại → NOT_FOUND', async () => {
    const { db } = makeFakeDb({ customer: null });
    const r = await setCustomerChatGroups({ db, user: authUser(['CUSTOMER_UPDATE']) }, 999, [{ feeTypeId: 10 }]);
    expect(r.error).toBe('NOT_FOUND');
    expect(r.message).toBe('Khách hàng không tồn tại.');
  });

  it('feeTypeId không tồn tại → VALIDATION, KHÔNG ghi hàng nào', async () => {
    const { db, groups } = makeFakeDb();
    const r = await setCustomerChatGroups({ db, user: authUser(['CUSTOMER_UPDATE']) }, 1, [{ feeTypeId: 9999 }]);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Loại phí được chọn không tồn tại (hoặc đã bị xóa). Vui lòng chọn lại.');
    expect(groups).toHaveLength(0);
  });

  it('roomId trỏ phòng không tồn tại → VALIDATION', async () => {
    const { db, groups } = makeFakeDb();
    const r = await setCustomerChatGroups({ db, user: authUser(['CUSTOMER_UPDATE']) }, 1, [{ feeTypeId: 10, roomId: 'room-X' }]);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Phòng chat được chọn không tồn tại (hoặc đã bị xóa). Vui lòng chọn lại.');
    expect(groups).toHaveLength(0);
  });

  it('roomId trỏ phòng ĐÃ XÓA MỀM → VALIDATION', async () => {
    const { db } = makeFakeDb({ rooms: [{ id: 'room-A', type: 'GROUP', name: 'X', deletedAt: new Date() }] });
    const r = await setCustomerChatGroups({ db, user: authUser(['CUSTOMER_UPDATE']) }, 1, [{ feeTypeId: 10, roomId: 'room-A' }]);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Phòng chat được chọn không tồn tại (hoặc đã bị xóa). Vui lòng chọn lại.');
  });

  it('trùng feeTypeId trong CÙNG 1 lần set → VALIDATION, KHÔNG ghi', async () => {
    const { db, groups } = makeFakeDb();
    const r = await setCustomerChatGroups({ db, user: authUser(['CUSTOMER_UPDATE']) }, 1, [
      { feeTypeId: 10, roomId: 'room-A' },
      { feeTypeId: 10, roomId: 'room-B' }
    ]);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Mỗi loại phí chỉ được cấu hình 1 nhóm chat cho khách. Vui lòng bỏ loại phí bị trùng.');
    expect(groups).toHaveLength(0);
  });

  it('HỦY GÁN: bỏ loại phí khỏi danh sách → đóng kỳ (unassignedAt), GIỮ hàng lịch sử', async () => {
    const { db, groups } = makeFakeDb({
      groups: [
        { id: 1, customerId: 1, feeTypeId: 10, roomId: 'room-A' },
        { id: 2, customerId: 1, feeTypeId: 11, roomId: 'room-B' }
      ]
    });
    // gửi lên chỉ còn feeType 10 (bỏ 11) — 11 phải bị đóng kỳ, 10 giữ nguyên (cùng room → update tại chỗ).
    const r = await setCustomerChatGroups({ db, user: authUser(['CUSTOMER_UPDATE']) }, 1, [{ feeTypeId: 10, roomId: 'room-A' }]);
    expect(r.ok).toBe(true);
    expect(groups.find((g) => g.feeTypeId === 11)!.unassignedAt).toBeInstanceOf(Date);
    expect(groups.find((g) => g.feeTypeId === 10 && g.unassignedAt === null)!.roomId).toBe('room-A');
    // KHÔNG mở kỳ mới cho feeType 10 (cùng room → update, không create) → vẫn 1 hàng feeType 10.
    expect(groups.filter((g) => g.feeTypeId === 10)).toHaveLength(1);
  });

  it('GIỮ nhóm, đổi link → update tại chỗ, KHÔNG mở kỳ mới', async () => {
    const { db, groups } = makeFakeDb({
      groups: [{ id: 1, customerId: 1, feeTypeId: 10, roomId: 'room-A', link: 'old' }]
    });
    const r = await setCustomerChatGroups({ db, user: authUser(['CUSTOMER_UPDATE']) }, 1, [{ feeTypeId: 10, roomId: 'room-A', link: 'new' }]);
    expect(r.ok).toBe(true);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.roomId).toBe('room-A');
    expect(groups[0]!.link).toBe('new');
    expect(groups[0]!.unassignedAt).toBeNull();
  });

  it('ĐỔI NHÓM: đổi roomId cùng loại phí → đóng kỳ nhóm CŨ + mở kỳ nhóm MỚI', async () => {
    const { db, groups } = makeFakeDb({
      groups: [{ id: 1, customerId: 1, feeTypeId: 10, roomId: 'room-A', link: 'x' }]
    });
    const r = await setCustomerChatGroups({ db, user: authUser(['CUSTOMER_UPDATE']) }, 1, [{ feeTypeId: 10, roomId: 'room-B' }]);
    expect(r.ok).toBe(true);
    // kỳ cũ (room-A) đóng, kỳ mới (room-B) mở
    const old = groups.find((g) => g.roomId === 'room-A')!;
    const neo = groups.find((g) => g.roomId === 'room-B')!;
    expect(old.unassignedAt).toBeInstanceOf(Date);
    expect(neo.unassignedAt).toBeNull();
    expect(neo.assignedFrom).toBeInstanceOf(Date);
    expect(groups.filter((g) => g.feeTypeId === 10)).toHaveLength(2); // 1 lịch sử + 1 active
  });

  it('GÁN LẠI cùng loại phí sau khi đã hủy → mở kỳ MỚI (kỳ cũ đã đóng, KHÔNG bị chặn)', async () => {
    const { db, groups } = makeFakeDb({
      groups: [{ id: 1, customerId: 1, feeTypeId: 10, roomId: 'room-A', unassignedAt: new Date('2026-02-01T00:00:00Z') }]
    });
    const r = await setCustomerChatGroups({ db, user: authUser(['CUSTOMER_UPDATE']) }, 1, [{ feeTypeId: 10, roomId: 'room-A' }]);
    expect(r.ok).toBe(true);
    const active = groups.filter((g) => g.feeTypeId === 10 && g.unassignedAt === null);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(1); // hàng MỚI, không hồi sinh hàng đã đóng
    expect(groups.filter((g) => g.feeTypeId === 10)).toHaveLength(2);
  });
});

// ───────────────────────── list ─────────────────────────
describe('listCustomerChatGroups', () => {
  it('thiếu quyền CUSTOMER_VIEW → FORBIDDEN', async () => {
    const { db } = makeFakeDb();
    const r = await listCustomerChatGroups({ db, user: authUser([]) }, 1);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('trả đúng kỳ active + feeTypeName + roomName (join), ẩn kỳ đã đóng', async () => {
    const { db } = makeFakeDb({
      groups: [
        { id: 1, customerId: 1, feeTypeId: 10, roomId: 'room-A', link: 'https://a', qr: 'qrA', note: 'n1' },
        { id: 2, customerId: 1, feeTypeId: 11, roomId: 'room-B', unassignedAt: new Date() }
      ]
    });
    const r = await listCustomerChatGroups({ db, user: authUser(['CUSTOMER_VIEW']) }, 1);
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(1); // kỳ đã đóng bị ẩn
    expect(r.data![0]!.feeTypeId).toBe(10);
    expect(r.data![0]!.feeTypeName).toBe('Ủy quyền');
    expect(r.data![0]!.roomId).toBe('room-A');
    expect(r.data![0]!.roomName).toBe('Nhóm Ủy quyền A');
    expect(r.data![0]!.link).toBe('https://a');
    expect(r.data![0]!.qr).toBe('qrA');
  });
});

// ───────────────────────── picker (listAssignableChatGroups) ─────────────────────────
describe('listAssignableChatGroups', () => {
  it('thiếu quyền CUSTOMER_VIEW → FORBIDDEN', async () => {
    const { db } = makeFakeDb();
    const r = await listAssignableChatGroups({ db, user: authUser([]) }, {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('CHỈ trả nhóm GROUP chưa gán (loại nhóm đang có kỳ active) + đúng id/tên', async () => {
    const { db } = makeFakeDb({
      rooms: [
        { id: 'room-A', type: 'GROUP', name: 'Nhóm A', deletedAt: null },
        { id: 'room-B', type: 'GROUP', name: 'Nhóm B', deletedAt: null },
        { id: 'room-C', type: 'GROUP', name: 'Nhóm C', deletedAt: null },
        { id: 'room-D', type: 'DIRECT', name: null, deletedAt: null }, // DIRECT bị loại
        { id: 'room-E', type: 'GROUP', name: 'Nhóm E', deletedAt: new Date() } // đã xóa bị loại
      ],
      groups: [
        { id: 1, customerId: 1, feeTypeId: 10, roomId: 'room-A' }, // room-A đã gán (active) → bị loại
        { id: 2, customerId: 2, feeTypeId: 11, roomId: 'room-B', unassignedAt: new Date() } // room-B kỳ ĐÃ ĐÓNG → vẫn gán được
      ]
    });
    const r = await listAssignableChatGroups({ db, user: authUser(['CUSTOMER_VIEW']) }, {});
    expect(r.ok).toBe(true);
    const ids = r.data!.map((x) => x.roomId).sort();
    expect(ids).toEqual(['room-B', 'room-C']); // A bị chiếm; D là DIRECT; E đã xóa
    expect(r.data!.find((x) => x.roomId === 'room-C')!.name).toBe('Nhóm C');
  });

  it('tìm kiếm theo TÊN (contains, không phân biệt hoa/thường)', async () => {
    const { db } = makeFakeDb({
      rooms: [
        { id: 'r1', type: 'GROUP', name: 'Ủy quyền Hải Phòng', deletedAt: null },
        { id: 'r2', type: 'GROUP', name: 'Tiền chờ Hà Nội', deletedAt: null }
      ],
      groups: []
    });
    const r = await listAssignableChatGroups({ db, user: authUser(['CUSTOMER_VIEW']) }, { search: 'tiền' });
    expect(r.data!.map((x) => x.roomId)).toEqual(['r2']);
  });

  it('tìm kiếm theo ID phòng', async () => {
    const { db } = makeFakeDb({
      rooms: [
        { id: 'abc123', type: 'GROUP', name: 'X', deletedAt: null },
        { id: 'xyz789', type: 'GROUP', name: 'Y', deletedAt: null }
      ],
      groups: []
    });
    const r = await listAssignableChatGroups({ db, user: authUser(['CUSTOMER_VIEW']) }, { search: 'abc' });
    expect(r.data!.map((x) => x.roomId)).toEqual(['abc123']);
  });
});

// ───────────────────────── zaloGroupId (Admin Demo 25/8 — watcher lấy bill Zalo → phòng khách) ─────────────────────────
describe('setCustomerChatGroups — zaloGroupId', () => {
  it('lưu zaloGroupId → list trả về đúng (round-trip, giữ nguyên hậu tố _group)', async () => {
    const { db } = makeFakeDb();
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_UPDATE']) };
    const set = await setCustomerChatGroups(ctx, 1, [
      { feeTypeId: 10, roomId: 'room-A', zaloGroupId: '9135320275466171227_group' }
    ]);
    expect(set.ok).toBe(true);
    const list = await listCustomerChatGroups({ db, user: authUser(['CUSTOMER_VIEW']) }, 1);
    expect(list.data).toHaveLength(1);
    // CHUẨN HOÁ canonical g<N>: '9135320275466171227_group' → 'gDEMOGROUP0000000011' (khớp watcher gửi).
    expect(list.data![0].zaloGroupId).toBe('gDEMOGROUP0000000011');
  });

  it('zaloGroupId "  " (chỉ khoảng trắng) → chuẩn hóa null', async () => {
    const { db } = makeFakeDb();
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_UPDATE']) };
    await setCustomerChatGroups(ctx, 1, [{ feeTypeId: 10, roomId: 'room-A', zaloGroupId: '   ' }]);
    const list = await listCustomerChatGroups({ db, user: authUser(['CUSTOMER_VIEW']) }, 1);
    expect(list.data![0].zaloGroupId).toBeNull();
  });

  it('2 dòng CÙNG khách gán CÙNG zaloGroupId cho 2 phòng khác → VALIDATION (1 nhóm Zalo = 1 phòng)', async () => {
    const { db } = makeFakeDb();
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_UPDATE']) };
    const r = await setCustomerChatGroups(ctx, 1, [
      { feeTypeId: 10, roomId: 'room-A', zaloGroupId: 'g999' },
      { feeTypeId: 11, roomId: 'room-B', zaloGroupId: 'g999' }
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toContain('g999');
  });

  it('zaloGroupId đã gán cho khách KHÁC (kỳ active) → VALIDATION, KHÔNG cướp', async () => {
    const { db } = makeFakeDb({
      groups: [{ id: 1, customerId: 2, feeTypeId: 10, roomId: 'room-B', zaloGroupId: 'gTaken', unassignedAt: null }]
    });
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_UPDATE']) };
    const r = await setCustomerChatGroups(ctx, 1, [{ feeTypeId: 10, roomId: 'room-A', zaloGroupId: 'gTaken' }]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toContain('khách khác');
  });

  it('canonical cross-form: khách khác giữ "g123", khách này dán "123_group" → VẪN clash (cùng g123)', async () => {
    const { db } = makeFakeDb({
      groups: [{ id: 1, customerId: 2, feeTypeId: 10, roomId: 'room-B', zaloGroupId: 'g123', unassignedAt: null }]
    });
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_UPDATE']) };
    const r = await setCustomerChatGroups(ctx, 1, [{ feeTypeId: 10, roomId: 'room-A', zaloGroupId: '123_group' }]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('VALIDATION');
  });

  it('giữ nguyên phòng, ĐỔI zaloGroupId → cập nhật tại chỗ (không mở kỳ mới)', async () => {
    const { db, groups } = makeFakeDb({
      groups: [{ id: 1, customerId: 1, feeTypeId: 10, roomId: 'room-A', zaloGroupId: 'gOld', unassignedAt: null }]
    });
    const ctx: ServiceCtx = { db, user: authUser(['CUSTOMER_UPDATE']) };
    const r = await setCustomerChatGroups(ctx, 1, [{ feeTypeId: 10, roomId: 'room-A', zaloGroupId: 'gNew' }]);
    expect(r.ok).toBe(true);
    const active = groups.filter((g) => g.unassignedAt === null);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(1); // CÙNG hàng (không mở kỳ mới)
    expect(active[0].zaloGroupId).toBe('gNew');
  });
});
