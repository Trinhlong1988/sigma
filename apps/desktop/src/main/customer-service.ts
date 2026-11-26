// Customer CRUD — ADAPTER MỎNG desktop (IPC). Nghiệp vụ THUẦN nay nằm ở @sigma/services (customer.ts) dùng CHUNG
// desktop + apps/quanly-api (không còn 2 bản logic trùng). File này CHỈ: guard phiên/quyền desktop
// (requirePermission — lo phiên còn sống R48, forceChangePassword, audit PERMISSION_DENIED) → dựng
// ctx = { db, user } từ guard → gọi hàm LÕI tương ứng. Signature export GIỮ NGUYÊN nên ipc.ts +
// entity-cancel-service + *-service (dùng dateRange) + selftest KHÔNG phải đổi.
// deleteCustomer GIỮ bước xác thực lại MẬT KHẨU người thao tác (§14) Ở ĐÂY — lõi KHÔNG kiểm password (chủ đích,
// lõi không truy cập session/hash Electron). Mọi message tiếng Việt + hành vi audit y hệt bản trước.
import { requirePermission, verifyActorPassword } from './guard.js';
import { me } from './auth-service.js';
import { getDb } from './db.js';
import { writeAudit } from './audit.js';
import {
  listCustomers as coreListCustomers,
  countCustomers as coreCountCustomers,
  createCustomer as coreCreateCustomer,
  updateCustomer as coreUpdateCustomer,
  deleteCustomer as coreDeleteCustomer,
  listAgents as coreListAgents,
  type CustomerDto,
  type CustomerFilter,
  type CreateCustomerInput,
  type UpdateCustomerInput,
  type MutationResult
} from '@sigma/services';

// Re-export type + helper THẲNG từ lõi để mọi caller cũ import từ './customer-service.js' KHÔNG phải đổi:
//  - types: ipc.ts (customerSvc.CustomerFilter/CreateCustomerInput/UpdateCustomerInput), import-service, renderer;
//  - dateRange: dùng chung ~15 *-service dựng bộ lọc ngày;
//  - customerLiveRelationGuard(db,id): entity-cancel-service gọi precheck xóa Customer.
export type { CustomerDto, CustomerFilter, CreateCustomerInput, UpdateCustomerInput, MutationResult };
export { dateRange, customerLiveRelationGuard } from '@sigma/services';

/** CUSTOMER_VIEW — list khách hàng (ẩn soft-deleted), lọc search + đại lý + trạng thái + khoảng ngày. */
export async function listCustomers(
  filter: CustomerFilter = {}
): Promise<{ ok: boolean; data?: CustomerDto[]; error?: string; message?: string }> {
  const g = await requirePermission('CUSTOMER_VIEW', { action: 'CUSTOMER_VIEW' });
  if (!g.ok) return g;
  return coreListCustomers({ db: g.db, user: g.user }, filter);
}

/** CUSTOMER_VIEW — bộ đếm TOÀN CỤC cho dash StatBar (độc lập bộ lọc list). */
export async function countCustomers(): Promise<{
  ok: boolean;
  data?: { total: number; active: number; locked: number; cancelled: number; unassigned: number; byAgent: { agentId: number; count: number }[] };
  error?: string;
  message?: string;
}> {
  const g = await requirePermission('CUSTOMER_VIEW', { action: 'CUSTOMER_VIEW' });
  if (!g.ok) return g;
  return coreCountCustomers({ db: g.db, user: g.user });
}

/** CUSTOMER_CREATE — auto KH## + biệt danh (§D) bắt buộc + audit CUSTOMER_CREATED (nghiệp vụ ở lõi). */
export async function createCustomer(input: CreateCustomerInput): Promise<MutationResult> {
  const g = await requirePermission('CUSTOMER_CREATE', { action: 'CUSTOMER_CREATED', targetType: 'Customer' });
  if (!g.ok) return g;
  return coreCreateCustomer({ db: g.db, user: g.user }, input);
}

/** CUSTOMER_UPDATE — biệt danh vẫn bắt buộc; optimistic-lock + audit before/after (nghiệp vụ ở lõi). */
export async function updateCustomer(id: number, input: UpdateCustomerInput): Promise<MutationResult> {
  const g = await requirePermission('CUSTOMER_UPDATE', { action: 'CUSTOMER_UPDATED', targetType: 'Customer', targetId: String(id) });
  if (!g.ok) return g;
  return coreUpdateCustomer({ db: g.db, user: g.user }, id, input);
}

/**
 * CUSTOMER_DELETE — soft-delete + guard quan hệ sống + audit (nghiệp vụ ở lõi). §14: xác thực lại MẬT KHẨU
 * người thao tác Ở ADAPTER (lõi không kiểm password). Sai mật khẩu → audit từ chối + trả WRONG_PASSWORD, KHÔNG
 * chạm dữ liệu (y hệt hành vi cũ; sai mật khẩu còn tính vào bộ đếm khóa qua verifyActorPassword).
 */
export async function deleteCustomer(id: number, password: string): Promise<MutationResult> {
  const g = await requirePermission('CUSTOMER_DELETE', { action: 'CUSTOMER_DELETED', targetType: 'Customer', targetId: String(id) });
  if (!g.ok) return g;
  const { db, user } = g;

  if (!(await verifyActorPassword(user, password))) {
    await writeAudit(db, {
      actorUserId: user.id,
      action: 'CUSTOMER_DELETED',
      targetType: 'Customer',
      targetId: String(id),
      after: { denied: true, reason: 'WRONG_PASSWORD' }
    });
    return { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
  }

  return coreDeleteCustomer({ db, user }, id);
}

/**
 * Đại lý cho dropdown. GIỮ hành vi cũ: đọc actor từ snapshot phiên (me()) — chưa đăng nhập → NOT_AUTHENTICATED;
 * lõi listAgents kiểm quyền CUSTOMER_VIEW || POS_VIEW || TID_VIEW và trả FORBIDDEN nếu thiếu.
 */
export async function listAgents(): Promise<{
  ok: boolean;
  data?: { id: number; code: string | null; name: string; region: string | null }[];
  error?: string;
  message?: string;
}> {
  const actor = me();
  if (!actor) return { ok: false, error: 'NOT_AUTHENTICATED', message: 'Bạn chưa đăng nhập.' };
  return coreListAgents({ db: getDb(), user: actor });
}
