// Dashboard — thống kê realtime cho trang chủ. LÕI THUẦN ctx-based (CHỈ ĐỌC). PORT từ
// apps/desktop/src/main/dashboard-service.ts (Nhóm B #6, LEAD 9/7). Thay requirePermission bằng ctx = { db, user };
// getStats cần DASHBOARD_VIEW, getMonthlyProfit cần CASHENTRY_VIEW. Luôn trả dữ liệu (kể cả 0) để UI hiển thị
// khung + empty-state. Lợi nhuận ACCRUAL (§0/§5) chống double-count (I#13); ngày local (I#10).
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import type { ServiceCtx } from './customer.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

export interface DashboardStats {
  counts: {
    tids: number;
    customers: number;
    posDevices: number;
    dossiers: number;
    users: number;
    banks: number;
    banksActive: number;
    banksInactive: number;
    partners: number;
  };
  tidsByBank: { label: string; count: number }[];
  posByStatus: { label: string; count: number }[];
  monthly: { month: string; tids: number; customers: number }[]; // 12 tháng gần nhất
}

const POS_STATUS_LABEL: Record<string, string> = {
  IN_STOCK: 'Trong kho',
  DEPLOYED: 'Đã triển khai',
  IN_REPAIR: 'Đang sửa',
  DAMAGED: 'Hư hỏng',
  RETIRED: 'Ngừng dùng',
  SOLD: 'Đã bán'
};

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * FIX-PERF B132 — đếm số hàng tạo mới theo THÁNG (12 ô) trong DB, KHÔNG kéo full-bảng createdAt về JS tally.
 * `boundaries` = 13 mốc THÁNG local tăng dần [m0..m11, đầu-tháng-kế] (dựng bằng new Date(y, m, 1) — CÙNG quy ước
 * local như getMonthlyProfit). So sánh theo INSTANT tuyệt đối (timestamptz `>=`/`<`) nên KHÔNG phụ thuộc session
 * timezone của Postgres (tránh lệch ~7h ICT sát biên tháng nếu dùng date_trunc theo session-TZ). 1 query/bảng,
 * quét CÓ BIÊN [m0, đầu-tháng-kế). `table` là hằng nội bộ ('tids'|'customers'), KHÔNG phải input người dùng.
 */
async function monthlyCreatedCounts(db: Db, table: 'tids' | 'customers', boundaries: Date[]): Promise<number[]> {
  const cols: string[] = [];
  for (let i = 0; i < 12; i++) {
    cols.push(`SUM(CASE WHEN created_at >= $${i + 1} AND created_at < $${i + 2} THEN 1 ELSE 0 END)::int AS m${i}`);
  }
  const sql = `SELECT ${cols.join(', ')} FROM "${table}" WHERE deleted_at IS NULL AND created_at >= $1 AND created_at < $13`;
  const rows = await db.$queryRawUnsafe<Record<string, number | bigint | null>[]>(sql, ...boundaries);
  const row = rows[0] ?? {};
  const out: number[] = [];
  for (let i = 0; i < 12; i++) out.push(Number(row[`m${i}`] ?? 0));
  return out;
}

/** DASHBOARD_VIEW — KPI tổng + bộ đếm tách chiều (TID theo ngân hàng, POS theo trạng thái) + chuỗi 12 tháng. */
export async function getStats(ctx: ServiceCtx): Promise<{ ok: boolean; data?: DashboardStats; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'DASHBOARD_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const alive = { deletedAt: null } as const;

  const [tids, customers, posDevices, dossiers, users, banks, banksActive, banksInactive, partners] = await Promise.all([
    db.tid.count({ where: alive }),
    db.customer.count({ where: alive }),
    db.posDevice.count({ where: alive }), // REL-10 (Codex 15/7): loại POS đã xóa mềm khỏi bộ đếm dashboard
    db.dossier.count({ where: alive }),
    db.user.count({ where: { deletedAt: null, status: { not: 'DELETED' } } }),
    db.bank.count({ where: alive }),
    db.bank.count({ where: { ...alive, status: 'ACTIVE' } }),
    db.bank.count({ where: { ...alive, status: 'INACTIVE' } }),
    db.partner.count({ where: alive })
  ]);

  // TID theo ngân hàng (bộ đếm tách chiều — "Tổng TID VPBank..."). FIX-PERF B132: groupBy trong DB (KHÔNG kéo
  // full-bảng bankId về JS tally). Nhiều bankId "lạ" (không tra được tên) gộp chung nhãn 'Khác' → vẫn cần Map.
  const tidBankGroups = await db.tid.groupBy({ by: ['bankId'], where: { ...alive, bankId: { not: null } }, _count: { _all: true } });
  const bankIds = [...new Set(tidBankGroups.map((g) => g.bankId).filter((x): x is number => x !== null))];
  const bankList = bankIds.length ? await db.bank.findMany({ where: { id: { in: bankIds } }, select: { id: true, code: true, name: true } }) : [];
  const bankById = new Map(bankList.map((b) => [b.id, b.code || b.name]));
  const bankTally = new Map<string, number>();
  for (const g of tidBankGroups) {
    const label = (g.bankId != null ? bankById.get(g.bankId) : undefined) ?? 'Khác';
    bankTally.set(label, (bankTally.get(label) ?? 0) + g._count._all);
  }
  const tidsByBank = [...bankTally.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);

  // Máy POS theo trạng thái. FIX-PERF B132: groupBy trong DB (REL-10: alive loại POS xóa mềm khỏi posByStatus).
  const posGroups = await db.posDevice.groupBy({ by: ['status'], where: alive, _count: { _all: true } });
  const posByStatus = posGroups
    .map((g) => ({ label: POS_STATUS_LABEL[g.status] ?? g.status, count: g._count._all }))
    .sort((a, b) => b.count - a.count);

  // Tăng trưởng 12 tháng gần nhất (số TID & khách hàng tạo mới theo tháng). FIX-PERF B132: đếm trong DB theo
  // biên tháng local (13 mốc) — KHÔNG kéo toàn bộ createdAt về JS. Quy ước local đồng nhất monthKey/getMonthlyProfit.
  const now = new Date();
  const months: string[] = [];
  const boundaries: Date[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(monthKey(d));
    boundaries.push(d);
  }
  boundaries.push(new Date(now.getFullYear(), now.getMonth() + 1, 1)); // chặn trên = đầu tháng kế (13 mốc)
  const [tidCounts, custCounts] = await Promise.all([
    monthlyCreatedCounts(db, 'tids', boundaries),
    monthlyCreatedCounts(db, 'customers', boundaries)
  ]);
  const monthly = months.map((m, i) => ({ month: m, tids: tidCounts[i] ?? 0, customers: custCounts[i] ?? 0 }));

  return { ok: true, data: { counts: { tids, customers, posDevices, dossiers, users, banks, banksActive, banksInactive, partners }, tidsByBank, posByStatus, monthly } };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE H2-core — Lợi nhuận Dashboard (ACCRUAL, §0 Q-A / §5). CHỐNG double-count (I#13):
//   profit(tháng) = Σ Transaction.revenueAmount (POSTED, theo txnDate trong tháng)          ← accrual chênh phí quẹt thẻ
//                 + Σ CashEntry POSTED THU affectsPnl=true (theo entryDate trong tháng)      ← doanh thu bán trực tiếp
//                 − Σ CashEntry POSTED CHI affectsPnl=true (theo entryDate trong tháng)      ← chi phí thật
// KHÔNG cộng CashEntry category DEBT_*/DEPOSIT/ADVANCE/FUND_TRANSFER (affectsPnl=false) —
// thu công nợ đã nằm trong Transaction.revenueAmount (đếm lại = double-count). Ngày local (I#10).
// ─────────────────────────────────────────────────────────────────────────────
export interface MonthProfit {
  month: string; // YYYY-MM
  revenueAccrual: number;
  expense: number;
  profit: number;
}
export interface ProfitStats {
  current: MonthProfit;
  previous: MonthProfit;
}

/** Lợi nhuận accrual của khoảng [start, nextStart) (local). affectsIds = danh mục affectsPnl=true. */
async function computeMonthProfit(db: Db, month: string, start: Date, nextStart: Date, affectsIds: number[]): Promise<MonthProfit> {
  const [txAgg, thuAgg, chiAgg] = await Promise.all([
    // [GÓI TZ 11/9] bound txn_date bằng raw-ISO (Prisma bound Date lệch −7h trên cột instant-thật).
    db.$queryRawUnsafe<{ s: bigint | null }[]>(
      `SELECT SUM(revenue_amount)::bigint AS s FROM transactions WHERE status='POSTED' AND deleted_at IS NULL AND txn_date >= $1::timestamptz AND txn_date < $2::timestamptz`,
      start.toISOString(), nextStart.toISOString()
    ).then((r) => ({ _sum: { revenueAmount: r[0]?.s ?? 0n } })),
    db.cashEntry.aggregate({ _sum: { amount: true }, where: { status: 'POSTED', deletedAt: null, kind: 'THU', categoryId: { in: affectsIds }, entryDate: { gte: start, lt: nextStart } } }),
    db.cashEntry.aggregate({ _sum: { amount: true }, where: { status: 'POSTED', deletedAt: null, kind: 'CHI', categoryId: { in: affectsIds }, entryDate: { gte: start, lt: nextStart } } })
  ]);
  const revenueAccrual = Number(txAgg._sum.revenueAmount ?? 0) + Number(thuAgg._sum.amount ?? 0);
  const expense = Number(chiAgg._sum.amount ?? 0);
  return { month, revenueAccrual, expense, profit: revenueAccrual - expense };
}

/** CASHENTRY_VIEW — lợi nhuận accrual tháng hiện tại + tháng trước (Dashboard KpiCard, §5). */
export async function getMonthlyProfit(ctx: ServiceCtx): Promise<{ ok: boolean; data?: ProfitStats; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'CASHENTRY_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const affects = await db.cashCategory.findMany({ where: { affectsPnl: true, deletedAt: null }, select: { id: true } });
  const affectsIds = affects.map((c) => c.id);

  const now = new Date();
  const curStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const key = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

  const [current, previous] = await Promise.all([
    computeMonthProfit(db, key(curStart), curStart, nextStart, affectsIds),
    computeMonthProfit(db, key(prevStart), prevStart, curStart, affectsIds)
  ]);
  return { ok: true, data: { current, previous } };
}
