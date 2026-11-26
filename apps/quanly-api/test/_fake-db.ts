// SHARED fake-Prisma-db factory cho route tests (test/**). MỤC ĐÍCH: chặn class bug tái diễn —
// "một service thêm join model mới → N route test lặng lẽ 500 (Cannot read properties of undefined
// reading 'findMany')". Mỗi test cũ tự dựng 1 object `db` giả CHỈ có vài model nó cần; khi list/service
// mọc thêm join (vd customerChatGroup, tidSellFee, receiveAccount, investor) các fake thiếu model đó ném
// TypeError → chỉ lộ ra dưới dạng lệch route-status. Factory này stub SẴN MỌI model trong schema Prisma
// (87 model) bằng no-op an toàn, nên thêm truy vấn model mới KHÔNG bao giờ 500 test nữa.
//
// CÁCH DÙNG: makeFakeDb(overrides?) trả về 1 object cast `Db`. `overrides` DEEP-MERGE THEO MODEL:
//   makeFakeDb({ customer: { findMany: async () => [seededRow] } })
// → model `customer` = { ...stub mặc định (count/create/update...), ...method test override }. Nghĩa là
// test chỉ ghi đè method mình quan tâm; mọi method khác của model đó VẪN còn stub mặc định — đúng điểm
// chặn bug: service sau này gọi customer.aggregate (test không seed) vẫn có stub, không undefined.
// Key top-level không-phải-model ($transaction, $queryRaw*, ...) được THAY THẲNG khi override.
//
// Danh sách 87 model được DERIVE từ packages/database/prisma/schema.prisma (enumerate ĐỦ — thiếu 1 model
// chính là class bug). Nếu schema thêm model, cập nhật MODELS (test _fake-db-models-complete sẽ đỏ nếu lệch).
import type { Db } from '@sigma/database';

/** 87 Prisma model delegate keys (camelCase) — nguồn: schema.prisma. Enumerate ĐỦ để mọi query có stub. */
export const MODELS = [
  'user', 'message', 'role', 'permission', 'userRole', 'rolePermission', 'auditLog', 'changeToken',
  'appSetting', 'backupLog', 'loginSession', 'agent', 'friendRequest', 'trustedDevice', 'webSession',
  'customer', 'investor', 'investorAdvance', 'investorBankAccount', 'posDevice', 'tid', 'transaction',
  'approvalRequest', 'tidConfigStatus', 'assetEvent', 'warehouse', 'posTidBinding', 'deviceSale',
  'deviceSaleSettlement', 'deviceDeposit', 'deviceDepositRefund', 'codeCounter', 'bank', 'cardType',
  'partner', 'partnerBank', 'statusOption', 'supplier', 'posModel', 'posIntakeStatus', 'posIntake',
  'feeType', 'handoverType', 'feeRate', 'feeSellQuote', 'tidSellFee', 'revenueRecalcLog',
  'receiveAccountSource', 'receiveAccount', 'dossierSource', 'dossier', 'industry', 'product',
  'billExplain', 'cashCategory', 'maintenanceRun', 'fund', 'cashEntry', 'cashDebtSettlement',
  'debtQualityLog', 'exportRequest', 'exportRequestLine', 'lo', 'loRow', 'loBill', 'bankFraudRule',
  'emailOtpChallenge', 'pushToken', 'chatAttachment', 'chatRoom', 'pinnedMessage', 'chatRoomJoinRequest',
  'chatRoomMember', 'chatReport', 'chatCategory', 'chatRoomTid', 'customerChatGroup', 'investorChatGroup',
  'chatMessage', 'chatMessageReaction', 'callSession', 'agentNotification', 'post', 'postImage',
  'postReaction', 'postComment', 'qrLoginChallenge'
] as const;

export type ModelKey = (typeof MODELS)[number];

type Args = { where?: Record<string, unknown>; data?: Record<string, unknown>; create?: Record<string, unknown>; update?: Record<string, unknown> } | undefined;

/** Stub 1 model: mọi phương thức Prisma phổ biến, no-op AN TOÀN (list rỗng / null / count 0 / passthrough). */
function makeModelStub(): Record<string, (args?: Args) => Promise<unknown>> {
  return {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    // Prisma-accurate: findUniqueOrThrow ném khi không thấy. Test cần user thật LUÔN override method này.
    findUniqueOrThrow: async () => { throw new Error('fake-db: findUniqueOrThrow không có bản ghi (chưa override)'); },
    findFirstOrThrow: async () => { throw new Error('fake-db: findFirstOrThrow không có bản ghi (chưa override)'); },
    count: async () => 0,
    aggregate: async () => ({ _count: 0, _sum: {}, _avg: {}, _min: {}, _max: {} }),
    groupBy: async () => [],
    create: async (args?: Args) => ({ id: 1, ...(args?.data ?? {}) }),
    createMany: async () => ({ count: 0 }),
    update: async (args?: Args) => ({ id: 1, ...(args?.where ?? {}), ...(args?.data ?? {}) }),
    updateMany: async () => ({ count: 0 }),
    upsert: async (args?: Args) => ({ id: 1, ...(args?.create ?? {}), ...(args?.update ?? {}) }),
    delete: async (args?: Args) => ({ id: 1, ...(args?.where ?? {}) }),
    deleteMany: async () => ({ count: 0 })
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** overrides: mỗi key = model (deep-merge method) hoặc key hạ tầng ($transaction/$queryRaw*) (thay thẳng). */
export type FakeDbOverrides = Partial<Record<ModelKey, Record<string, unknown>>> & Record<string, unknown>;

/**
 * Dựng Db giả in-memory: 87 model đều có stub mặc định + $transaction / $queryRaw / $executeRaw no-op.
 * `overrides` deep-merge THEO MODEL (method-level). Trả về cast `Db` (mọi test đã cast unknown→Db).
 */
export function makeFakeDb(overrides: FakeDbOverrides = {}): Db {
  const db: Record<string, unknown> = {};
  for (const m of MODELS) db[m] = makeModelStub();

  // Raw + transaction defaults. $transaction hỗ trợ CẢ dạng hàm (fn(tx)) lẫn dạng mảng (Promise.all) như Prisma.
  db['$queryRaw'] = async () => [];
  db['$queryRawUnsafe'] = async () => [];
  db['$executeRaw'] = async () => 0;
  db['$executeRawUnsafe'] = async () => 0;
  db['$transaction'] = async (arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(db);

  for (const [key, val] of Object.entries(overrides)) {
    const base = db[key];
    if (isPlainObject(base) && isPlainObject(val)) {
      // Model đã có stub → merge method-level: override thắng, method không đề cập giữ stub mặc định.
      db[key] = { ...base, ...val };
    } else {
      // Key hạ tầng ($transaction/$queryRaw...) hoặc model chưa có (bất thường) → thay thẳng.
      db[key] = val;
    }
  }

  return db as unknown as Db;
}
