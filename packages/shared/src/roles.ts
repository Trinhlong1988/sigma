// Default system roles (IMS_SPEC §7). Codes are the source of truth; names are Vietnamese labels.

export interface RoleDef {
  code: string;
  name: string;
  description: string;
  isSystem: boolean;
}

export const ROLES: RoleDef[] = [
  { code: 'ADMIN', name: 'Admin', description: 'Toàn quyền hệ thống', isSystem: true },
  { code: 'MANAGER', name: 'Manager', description: 'Tạo user giới hạn, xem/sửa theo phân quyền', isSystem: true },
  { code: 'D_MANAGER', name: 'D Manager', description: 'Xem/duyệt giới hạn, không tạo/xóa user', isSystem: true },
  { code: 'ACCOUNTANT', name: 'Kế toán', description: 'Thu chi, công nợ, báo cáo (sau này)', isSystem: true },
  { code: 'TECHNICIAN', name: 'Kỹ thuật', description: 'Kỹ thuật, bảo hành, vận hành', isSystem: true },
  { code: 'SUPPORT', name: 'Support', description: 'Hỗ trợ khách hàng', isSystem: true },
  { code: 'WAREHOUSE', name: 'Kho', description: 'Nhập/xuất/tồn kho (sau này)', isSystem: true },
  { code: 'SALES', name: 'Sales', description: 'Bán hàng, khách hàng (sau này)', isSystem: true },
  { code: 'CUSTOMER', name: 'Khách hàng', description: 'Tài khoản khách hàng, quyền rất giới hạn', isSystem: true },
  // Phase D — Nhà đầu tư: user NĐT đăng nhập CHỈ xem báo cáo/tất toán đầu tư CỦA MÌNH + xuất file (INVESTOR_SELF_VIEW).
  // isSystem=true (builtin). Quyền mặc định ở DEFAULT_ROLE_PERMISSIONS. Seed: seedIfEmpty (db.ts) tạo role + gán quyền
  // vì là role MỚI (freshlyCreated) trên MỌI DB — không cần grant-flag riêng (xem báo cáo Phase D).
  { code: 'R_INVESTOR', name: 'Nhà đầu tư', description: 'User nhà đầu tư — chỉ xem báo cáo đầu tư của mình + xuất file', isSystem: true },
  // KẾ TOÁN NĐT (Admin Demo 24/11) — NHÂN VIÊN kế toán bị KHÓA PHẠM VI đúng 1 nhà đầu tư. Nhập bill + xem/lọc/tìm
  // doanh số + báo cáo lãi + xuất Excel GIỐNG kế toán SigMa, nhưng CHỈ với TID/POS/bill/lãi của ĐÚNG 1 NĐT gán
  // vào cột users.scope_investor_id. KHÁC R_INVESTOR (chỉ-xem báo cáo): vai này ĐƯỢC GHI bill (REVENUE_MANAGE).
  // Phạm vi ép Ở BACKEND (resolveScopeInvestorId) — KHÔNG tin UI. KHÔNG set giá (không TID_MANAGE), không cấu hình.
  { code: 'R_KETOAN_NDT', name: 'Kế toán NĐT', description: 'Kế toán bị khóa phạm vi 1 nhà đầu tư — nhập bill + xem doanh số/lãi + xuất Excel của NĐT đó', isSystem: true }
];

export const ROLE_CODES = ROLES.map((r) => r.code);

export const ADMIN_ROLE_CODE = 'ADMIN';
export const MANAGER_ROLE_CODE = 'MANAGER';

/** Vietnamese label for a role code, falls back to the code itself. */
export function roleLabel(code: string): string {
  return ROLES.find((r) => r.code === code)?.name ?? code;
}
