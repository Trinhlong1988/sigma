// SIGMA Vòng 2.5 (3/8) — RACE XUYÊN TIẾN TRÌNH: markTidDelivered() double-delivery.
//
// Bối cảnh: apps/desktop chạy trên 8 máy, mỗi máy 1 tiến trình Prisma RIÊNG ghi CHUNG Postgres. 2 nhân sự trên
// 2 máy có thể bấm "Giao TID" cho CÙNG 1 TID gần như đồng thời. Guard cũ `if (row.deliveredAt) return
// ALREADY_DELIVERED` đọc NGOÀI transaction (check-then-act) không serialize được 2 tiến trình → cả 2 lọt guard,
// cùng tạo AssetEvent TID_DELIVERED + LOST-UPDATE customer/agent (bên commit sau đè). assignTid() cùng file ĐÃ
// khóa đúng bằng `SELECT ... FOR UPDATE`; markTidDelivered LỆCH khuôn (thiếu khóa). Fix = tách lõi ghi ra
// `apps/desktop/src/main/tid-deliver-tx.ts` (deliverTidWithinTx) khóa FOR UPDATE + re-check delivered_at TRONG tx.
//
// HẠ TẦNG TEST (ghi rõ, không giấu — cùng khuôn desktop-chat-room-tid-invariant.test.ts): apps/desktop KHÔNG có
// harness Postgres (chỉ 7 vitest pure-unit). markTidDelivered() bọc guard.js/auth-service.js (Electron) nên KHÔNG
// import được vào node harness. Vì vậy test này import THẲNG lõi giao dịch Electron-free `deliverTidWithinTx`
// (chỉ phụ thuộc chat-room-tid-service.ts + @sigma/database) và chạy trên throwaway PG của bot-api. Dùng HAI
// PrismaClient ĐỘC LẬP (createPrisma) = 2 pool/2 tiến trình mô phỏng — race THẬT ở tầng DB, không giả lập.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPrisma, type Db } from '@sigma/database';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeTid } from './fixtures.js';
import { deliverTidWithinTx } from '../../desktop/src/main/tid-deliver-tx.js';

let clientA: Db;
let clientB: Db;

beforeAll(() => {
  // 2 client độc lập trên CÙNG throwaway DB (DATABASE_URL do global-setup set) — mô phỏng 2 tiến trình desktop.
  clientA = createPrisma(process.env.DATABASE_URL);
  clientB = createPrisma(process.env.DATABASE_URL);
});

afterAll(async () => {
  await clientA.$disconnect();
  await clientB.$disconnect();
});

async function makeCustomer(agentId: number): Promise<number> {
  const db = getBotDb();
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const c = await db.customer.create({ data: { code: `KH_${suffix}`.slice(0, 30), fullName: `Khach ${suffix}`, nickname: `kh${suffix}`.slice(0, 20), agentId } });
  return c.id;
}

/** Đếm số AssetEvent TID_DELIVERED của 1 TID (chuỗi) — thước đo double-delivery. */
async function countDeliveries(tidStr: string): Promise<number> {
  return getBotDb().assetEvent.count({ where: { tid: tidStr, eventType: 'TID_DELIVERED' } });
}

describe('markTidDelivered — race xuyên tiến trình (double-delivery)', () => {
  it('RED (khuôn CŨ, không FOR UPDATE): 2 tiến trình giao cùng TID → 2 AssetEvent TID_DELIVERED (bug)', async () => {
    const agent = await makeAgent();
    const customerId = await makeCustomer(agent.id);
    const tidRow = await makeTid({ agentId: agent.id, status: 'ACTIVE' });

    // Cả 2 tiến trình đọc deliveredAt NGOÀI tx, thấy null (đều qua guard cũ).
    const pre = await getBotDb().tid.findUnique({ where: { id: tidRow.id }, select: { deliveredAt: true } });
    expect(pre?.deliveredAt).toBeNull();

    // Khuôn CŨ tái hiện: update + tạo AssetEvent BÊN TRONG tx nhưng KHÔNG khóa/không re-check.
    async function oldDeliver(client: Db): Promise<void> {
      await client.$transaction(async (tx) => {
        await tx.tid.update({ where: { id: tidRow.id }, data: { deliveredAt: new Date(), customerId, agentId: agent.id } });
        await tx.assetEvent.create({
          data: { deviceSerial: null, tid: tidRow.tid, eventType: 'TID_DELIVERED', fromState: 'ACTIVE', toState: 'ACTIVE', customerId, toAgentId: agent.id, actorUserId: 1, occurredAt: new Date(), note: null }
        });
      });
    }
    await Promise.all([oldDeliver(clientA), oldDeliver(clientB)]);

    expect(await countDeliveries(tidRow.tid)).toBe(2); // BUG: giao 2 lần cho 1 TID.
  });

  it('GREEN (fix deliverTidWithinTx, FOR UPDATE + re-check): 2 tiến trình giao cùng TID → đúng 1 giao, 1 ALREADY_DELIVERED', async () => {
    const agent = await makeAgent();
    const customerId = await makeCustomer(agent.id);
    const tidRow = await makeTid({ agentId: agent.id, status: 'ACTIVE' });

    async function newDeliver(client: Db) {
      return client.$transaction((tx) =>
        deliverTidWithinTx(tx, {
          tidId: tidRow.id,
          tid: tidRow.tid,
          deviceSerial: null,
          fromState: 'ACTIVE',
          customerId,
          toAgentId: agent.id,
          actorUserId: 1,
          deliveredAt: new Date(),
          note: null
        })
      );
    }
    const results = await Promise.all([newDeliver(clientA), newDeliver(clientB)]);

    const okCount = results.filter((r) => r.ok).length;
    const alreadyCount = results.filter((r) => !r.ok && r.error === 'ALREADY_DELIVERED').length;
    expect(okCount).toBe(1); // đúng 1 giao thành công.
    expect(alreadyCount).toBe(1); // bên thua thấy đã giao — KHÔNG tạo event thứ 2.
    expect(await countDeliveries(tidRow.tid)).toBe(1); // FIXED: đúng 1 AssetEvent TID_DELIVERED.

    // Không lost-update: deliveredAt/customer/agent nhất quán với bên thắng.
    const after = await getBotDb().tid.findUnique({ where: { id: tidRow.id }, select: { deliveredAt: true, customerId: true, agentId: true } });
    expect(after?.deliveredAt).not.toBeNull();
    expect(after?.customerId).toBe(customerId);
    expect(after?.agentId).toBe(agent.id);
  });

  it('GREEN tuần tự: giao lần 2 (đã giao trước) → ALREADY_DELIVERED, KHÔNG tạo event thứ 2 (idempotent guard)', async () => {
    const agent = await makeAgent();
    const customerId = await makeCustomer(agent.id);
    const tidRow = await makeTid({ agentId: agent.id, status: 'ACTIVE' });

    const first = await clientA.$transaction((tx) =>
      deliverTidWithinTx(tx, { tidId: tidRow.id, tid: tidRow.tid, deviceSerial: null, fromState: 'ACTIVE', customerId, toAgentId: agent.id, actorUserId: 1, deliveredAt: new Date(), note: null })
    );
    expect(first.ok).toBe(true);

    const second = await clientB.$transaction((tx) =>
      deliverTidWithinTx(tx, { tidId: tidRow.id, tid: tidRow.tid, deviceSerial: null, fromState: 'ACTIVE', customerId, toAgentId: agent.id, actorUserId: 1, deliveredAt: new Date(), note: null })
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe('ALREADY_DELIVERED');
    expect(await countDeliveries(tidRow.tid)).toBe(1);
  });
});
