// Cấu hình ngân hàng — LÕI THUẦN ctx-based. PORT nghiệp vụ từ apps/desktop/src/main/bank-config-service.ts
// (IMS_SPEC §C1–C4). Thay `requirePermission(current-user global)` bằng ctx = { db, user } do adapter dựng;
// mỗi hàm tự kiểm quyền qua hasPermission(ctx.user, CONFIG_BANK_VIEW/MANAGE). GIỮ NGUYÊN business: mã @unique
// toàn cục (bắt P2002 → DUPLICATE), seq NH## tuần tự không tái dùng, validate status theo StatusOption,
// audit before/after, soft-delete. XÁC NHẬN MẬT KHẨU (§14) do ADAPTER làm TRƯỚC khi gọi lõi (khuôn customer.ts)
// — lõi KHÔNG kiểm password. Gồm: Ngân hàng (C1/C2) · Loại thẻ POS (C3) · Đối tác (C4) · liên kết Đối tác↔NH (C4c).
import { auditSnapshot } from '@sigma/business-rules';
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { staleGuard } from './optimistic-lock.js';
// TÌM KIẾM hoa/thường: DB collation "C" → Prisma mode:'insensitive' (ILIKE) KHÔNG gập chữ tiếng Việt có dấu
// (đo thật trên sổ thật: ILIKE '%nguyễn%' = 0 dòng / ILIKE '%NGUYỄN%' = 10 dòng). Xem tim-kiem-hoa-thuong.ts.
import { dieuKienTimKiem } from './tim-kiem-hoa-thuong.js';
import { dateRange, type ServiceCtx, type MutationResult } from './customer.js';
import { isValidStatus } from './status-catalog.js';
import type { AuditTrail } from './industry.js';
import { nhanBank } from './nhan-bank.js';

const VIEW = 'CONFIG_BANK_VIEW';
const MANAGE = 'CONFIG_BANK_MANAGE';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';
// FIX-PERF — hard-cap chống kéo full-bảng (bảng cấu hình UI cần toàn bộ; không phân trang, chỉ chặn bộ nhớ).
const BANK_CONFIG_LIST_MAX = 500;

// BUG G-CFG-B01: mã ngân hàng/đối tác là @unique TOÀN CỤC (không lọc soft-delete). Nếu 1 bản ghi đã xóa mềm
// (Thùng rác) đang giữ mã đó, pre-check lọc deletedAt:null sẽ KHÔNG thấy → create() ném P2002. Lưới an toàn:
// bắt P2002 map về DUPLICATE thay vì để văng.
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

/** Batch-resolve user id → tên hiển thị (fullName, fallback username) cho cột truy vết. */
async function resolveUserNames(db: Db, ids: (number | null | undefined)[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids.filter((x): x is number => typeof x === 'number'))];
  const map = new Map<number, string>();
  if (uniq.length === 0) return map;
  const users = await db.user.findMany({ where: { id: { in: uniq } }, select: { id: true, fullName: true, username: true } });
  for (const u of users) map.set(u.id, u.fullName || u.username);
  return map;
}

function trail(row: { createdBy: number | null; createdAt: Date; updatedBy: number | null; updatedAt: Date }, names: Map<number, string>): AuditTrail {
  return {
    createdBy: row.createdBy,
    createdByName: row.createdBy != null ? names.get(row.createdBy) ?? null : null,
    createdAt: row.createdAt.toISOString(),
    updatedBy: row.updatedBy,
    updatedByName: row.updatedBy != null ? names.get(row.updatedBy) ?? null : null,
    updatedAt: row.updatedAt.toISOString()
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// C1/C2 — NGÂN HÀNG
// ─────────────────────────────────────────────────────────────────────────────
export interface BankDto extends AuditTrail {
  id: number;
  seq: number | null;
  seqCode: string | null; // NH01, NH02... (từ seq)
  name: string;
  code: string;
  status: string; // ACTIVE | INACTIVE
  // [B185 19/11] MỐC CA TIỀN riêng từng ngân hàng, lưu PHÚT-trong-ngày (0..1439). null = CHƯA KHAI ca ⇒
  // không xếp ca (giữ nguyên hành vi cũ). Cột phụ qua schema-ensure, đọc/ghi bằng SQL thô.
  ca1HetPhut: number | null; // [giữ tương thích] mốc hết ca 1 kiểu cũ
  ca2HetPhut: number | null; // [giữ tương thích] mốc hết ca 2 kiểu cũ
  /** [B189 19/11] DANH SÁCH CA của ngân hàng — thêm/xoá bao nhiêu ca tuỳ ý, mỗi ca TỪ GIỜ → ĐẾN GIỜ. */
  caTien: CaTienDto[];
}
export interface CaTienDto {
  id: number;
  ten: string;
  tuPhut: number;
  denPhut: number;
  thuTu: number;
}
export interface CaTienInput {
  ten: string;
  tuPhut: number;
  denPhut: number;
}
export interface BankFilter {
  search?: string;
  status?: string; // ACTIVE | INACTIVE
  fromDate?: string;
  toDate?: string;
}
export interface CreateBankInput {
  name: string;
  code: string;
  status?: string;
  ca1HetPhut?: number | null;
  ca2HetPhut?: number | null;
  /** [B189] Danh sách ca gửi kèm khi tạo ngân hàng. Không gửi = chưa khai ca. */
  caTien?: CaTienInput[];
}
export interface UpdateBankInput {
  name?: string;
  code?: string;
  status?: string;
  ca1HetPhut?: number | null;
  ca2HetPhut?: number | null;
  /** [B189] Danh sách ca MỚI — gửi lên là THAY TOÀN BỘ danh sách ca của ngân hàng. Không gửi = giữ nguyên. */
  caTien?: CaTienInput[];
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock — mốc updatedAt client giữ lúc mở form
}

/** seq → mã hiển thị NH01, NH02... */
export function bankSeqCode(seq: number | null | undefined): string | null {
  return seq == null ? null : 'NH' + String(seq).padStart(2, '0');
}

export async function listBanks(ctx: ServiceCtx, filter: BankFilter = {}): Promise<{ ok: boolean; data?: BankDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.bank.findMany({
    where: {
      deletedAt: null,
      status: filter.status || undefined,
      createdAt: dateRange(filter.fromDate, filter.toDate),
      // Tìm kiếm mã/tên — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts).
      AND: await dieuKienTimKiem(db, 'banks', { code: 'code', name: 'name' }, filter.search)
    },
    orderBy: [{ name: 'asc' }, { code: 'asc' }], // Admin Demo 13/7 — sắp NGÂN HÀNG theo TÊN A→Z (không theo seq NH01/NH02 nữa)
    take: BANK_CONFIG_LIST_MAX
  });
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.createdBy, r.updatedBy]));
  // [B185] 2 cột mốc ca nằm NGOÀI Prisma (schema-ensure) ⇒ đọc bằng SQL thô rồi ghép vào DTO.
  const mocCa = new Map<number, { c1: number | null; c2: number | null }>();
  if (rows.length > 0) {
    const ca = await db.$queryRawUnsafe<Array<{ id: number; ca1_het_phut: number | null; ca2_het_phut: number | null }>>(
      `SELECT id, ca1_het_phut, ca2_het_phut FROM banks WHERE id = ANY($1::int[])`,
      rows.map((r) => r.id)
    );
    for (const x of ca) mocCa.set(Number(x.id), { c1: x.ca1_het_phut == null ? null : Number(x.ca1_het_phut), c2: x.ca2_het_phut == null ? null : Number(x.ca2_het_phut) });
  }
  // [B189] danh sách ca (bảng riêng, ngoài Prisma)
  const caTheoBank = new Map<number, CaTienDto[]>();
  if (rows.length > 0) {
    const dsCa = await db.$queryRawUnsafe<Array<{ id: number; bank_id: number; ten: string; tu_phut: number; den_phut: number; thu_tu: number }>>(
      `SELECT id, bank_id, ten, tu_phut, den_phut, thu_tu FROM bank_ca_tien
        WHERE deleted_at IS NULL AND bank_id = ANY($1::int[]) ORDER BY bank_id, thu_tu, id`,
      rows.map((r) => r.id)
    ).catch(() => []);
    for (const x of dsCa) {
      const arr = caTheoBank.get(Number(x.bank_id)) ?? [];
      arr.push({ id: Number(x.id), ten: x.ten, tuPhut: Number(x.tu_phut), denPhut: Number(x.den_phut), thuTu: Number(x.thu_tu) });
      caTheoBank.set(Number(x.bank_id), arr);
    }
  }
  return {
    ok: true,
    data: rows.map((r) => ({
      id: r.id, seq: r.seq, seqCode: bankSeqCode(r.seq), name: r.name, code: r.code, status: r.status,
      ca1HetPhut: mocCa.get(r.id)?.c1 ?? null,
      ca2HetPhut: mocCa.get(r.id)?.c2 ?? null,
      caTien: caTheoBank.get(r.id) ?? [],
      ...trail(r, names)
    }))
  };
}

/**
 * [B185] Kiểm 2 mốc ca: phải là PHÚT-trong-ngày nguyên 0..1439, và ca 1 phải kết thúc TRƯỚC ca 2.
 * Cho phép để TRỐNG CẢ HAI (chưa khai ca). Khai lẻ 1 cái là sai — ca 3 sẽ không xác định được.
 */
function kiemMocCa(c1: number | null | undefined, c2: number | null | undefined): string | null {
  const co1 = c1 != null, co2 = c2 != null;
  if (!co1 && !co2) return null; // chưa khai ca — hợp lệ
  if (co1 !== co2) return 'Mốc ca tiền phải khai ĐỦ CẢ HAI (ca 1 đến và ca 2 đến), hoặc để trống cả hai.';
  for (const v of [c1 as number, c2 as number]) {
    if (!Number.isInteger(v) || v < 0 || v > 1439) return 'Mốc ca tiền không hợp lệ (giờ trong ngày 00:00–23:59).';
  }
  if ((c1 as number) >= (c2 as number)) return 'Ca 1 phải kết thúc TRƯỚC ca 2.';
  return null;
}

/**
 * [B189] Kiểm danh sách ca: mỗi ca phải TỪ < ĐẾN, nằm trong ngày (0..1439), tên không rỗng, và CÁC CA
 * KHÔNG ĐƯỢC CHỒNG NHAU (chồng giờ thì 1 bill rơi vào 2 ca — không ai biết lấy ca nào).
 * Trả câu lỗi tiếng Việt nói rõ ca nào sai, hoặc null nếu hợp lệ.
 */
function kiemDanhSachCa(ds: CaTienInput[] | undefined): string | null {
  if (!ds || ds.length === 0) return null; // không khai ca — hợp lệ
  const sach = ds.map((c, i) => ({ i: i + 1, ten: (c.ten ?? '').trim(), tu: c.tuPhut, den: c.denPhut }));
  for (const c of sach) {
    if (!c.ten) return `Ca thứ ${c.i} chưa có tên.`;
    for (const v of [c.tu, c.den]) {
      if (!Number.isInteger(v) || v < 0 || v > 1439) return `Ca "${c.ten}" có giờ không hợp lệ (phải trong 00:00–23:59).`;
    }
    if (c.tu >= c.den) return `Ca "${c.ten}": giờ BẮT ĐẦU phải sớm hơn giờ KẾT THÚC.`;
  }
  const theoGio = [...sach].sort((a, b) => a.tu - b.tu);
  for (let i = 1; i < theoGio.length; i++) {
    if (theoGio[i].tu <= theoGio[i - 1].den) {
      return `Ca "${theoGio[i - 1].ten}" và "${theoGio[i].ten}" bị CHỒNG GIỜ — một bill sẽ rơi vào 2 ca.`;
    }
  }
  return null;
}

/** [B189] Thay TOÀN BỘ danh sách ca của 1 ngân hàng (xoá mềm cái cũ, ghi cái mới). */
async function ghiDanhSachCa(db: Db, bankId: number, ds: CaTienInput[], userId: number | null): Promise<void> {
  await db.$executeRawUnsafe('UPDATE bank_ca_tien SET deleted_at = now() WHERE bank_id = $1 AND deleted_at IS NULL', bankId);
  let thuTu = 0;
  for (const c of [...ds].sort((a, b) => a.tuPhut - b.tuPhut)) {
    await db.$executeRawUnsafe(
      `INSERT INTO bank_ca_tien (bank_id, ten, tu_phut, den_phut, thu_tu, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      bankId, (c.ten ?? '').trim(), c.tuPhut, c.denPhut, thuTu++, userId
    );
  }
}

export async function createBank(ctx: ServiceCtx, input: CreateBankInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const name = input.name?.trim();
  const code = input.code?.trim().toUpperCase();
  // REL-13 (audit 15/7, Codex): validate status theo StatusOption thay vì coerce (input sai chính tả trước
  // đây âm thầm thành 'ACTIVE' → kích hoạt lại nhầm; và bỏ qua status tùy biến).
  const status = input.status ?? 'ACTIVE';
  if (!(await isValidStatus(ctx, 'BANK', status))) return { ok: false, error: 'VALIDATION', message: 'Trạng thái ngân hàng không hợp lệ.' };
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên ngân hàng bắt buộc.' };
  if (!code) return { ok: false, error: 'VALIDATION', message: 'Mã ngân hàng bắt buộc.' };
  const loiCa = kiemMocCa(input.ca1HetPhut, input.ca2HetPhut) ?? kiemDanhSachCa(input.caTien);
  if (loiCa) return { ok: false, error: 'VALIDATION', message: loiCa };

  const dup = await db.bank.findFirst({ where: { code } });
  if (dup) {
    return dup.deletedAt
      ? { ok: false, error: 'DUPLICATE_TRASH', message: `Mã ngân hàng "${code}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn mã khác.` }
      : { ok: false, error: 'DUPLICATE', message: `Mã ngân hàng "${code}" đã tồn tại.` };
  }

  // seq tuần tự = max(seq)+1 trên TOÀN BẢNG (kể cả đã xóa) → số NH không tái dùng.
  const maxSeq = await db.bank.aggregate({ _max: { seq: true } });
  const nextSeq = (maxSeq._max.seq ?? 0) + 1;

  let created;
  try {
    created = await db.bank.create({ data: { name, code, status, seq: nextSeq, createdBy: user.id } });
    // [B185] 2 cột mốc ca ngoài Prisma ⇒ ghi bằng SQL thô ngay sau khi tạo.
    await db.$executeRawUnsafe('UPDATE banks SET ca1_het_phut = $1, ca2_het_phut = $2 WHERE id = $3',
      input.ca1HetPhut ?? null, input.ca2HetPhut ?? null, created.id);
    if (input.caTien && input.caTien.length > 0) await ghiDanhSachCa(db, created.id, input.caTien, user.id);
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `Mã ngân hàng "${code}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'BANK_CREATED',
    targetType: 'Bank',
    targetId: String(created.id),
    after: auditSnapshot({ name: created.name, code: created.code })
  });
  return { ok: true, id: created.id };
}

export async function updateBank(ctx: ServiceCtx, id: number, input: UpdateBankInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const row = await db.bank.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Ngân hàng không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;

  const name = input.name !== undefined ? input.name.trim() : row.name;
  const code = input.code !== undefined ? input.code.trim().toUpperCase() : row.code;
  // REL-13 (audit 15/7, Codex): validate status thay vì coerce (typo → không còn âm thầm về 'ACTIVE').
  if (input.status !== undefined && !(await isValidStatus(ctx, 'BANK', input.status))) return { ok: false, error: 'VALIDATION', message: 'Trạng thái ngân hàng không hợp lệ.' };
  const status = input.status !== undefined ? input.status : row.status;
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên ngân hàng không được để trống.' };
  if (!code) return { ok: false, error: 'VALIDATION', message: 'Mã ngân hàng không được để trống.' };
  if (code !== row.code) {
    const dup = await db.bank.findFirst({ where: { code, NOT: { id } } });
    if (dup) {
      return dup.deletedAt
        ? { ok: false, error: 'DUPLICATE_TRASH', message: `Mã ngân hàng "${code}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn mã khác.` }
        : { ok: false, error: 'DUPLICATE', message: `Mã ngân hàng "${code}" đã tồn tại.` };
    }
  }

  // [B185] mốc ca: không gửi ⇒ GIỮ NGUYÊN giá trị đang có (đọc raw vì cột ngoài Prisma).
  const caCu = (await db.$queryRawUnsafe<Array<{ ca1_het_phut: number | null; ca2_het_phut: number | null }>>(
    'SELECT ca1_het_phut, ca2_het_phut FROM banks WHERE id = $1', id
  ))[0];
  const ca1 = input.ca1HetPhut !== undefined ? input.ca1HetPhut : (caCu?.ca1_het_phut ?? null);
  const ca2 = input.ca2HetPhut !== undefined ? input.ca2HetPhut : (caCu?.ca2_het_phut ?? null);
  const loiCa = kiemMocCa(ca1, ca2) ?? kiemDanhSachCa(input.caTien);
  if (loiCa) return { ok: false, error: 'VALIDATION', message: loiCa };

  const before = auditSnapshot({ name: row.name, code: row.code, status: row.status, ca1HetPhut: caCu?.ca1_het_phut ?? null, ca2HetPhut: caCu?.ca2_het_phut ?? null });
  let updated;
  try {
    updated = await db.bank.update({ where: { id }, data: { name, code, status, updatedBy: user.id } });
    // [B185] ghi 2 cột mốc ca (ngoài Prisma). Ghi THẲNG — người dùng được phép xoá mốc (về chưa khai ca).
    await db.$executeRawUnsafe('UPDATE banks SET ca1_het_phut = $1, ca2_het_phut = $2 WHERE id = $3', ca1, ca2, id);
    // [B189] gửi `caTien` = THAY TOÀN BỘ danh sách ca; không gửi = giữ nguyên ca đang có.
    if (input.caTien !== undefined) await ghiDanhSachCa(db, id, input.caTien, user.id);
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `Mã ngân hàng "${code}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'BANK_UPDATED',
    targetType: 'Bank',
    targetId: String(id),
    before,
    after: auditSnapshot({ name: updated.name, code: updated.code, status: updated.status, ca1HetPhut: ca1, ca2HetPhut: ca2 })
  });
  return { ok: true, id };
}

/** Xóa mềm 1 hoặc nhiều ngân hàng (bulk). §14 xác nhận MẬT KHẨU do ADAPTER kiểm TRƯỚC khi gọi (lõi giả định
 *  caller đã xác thực — khuôn customer.ts). */
export async function deleteBanks(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn ngân hàng để xóa.' };

  let deleted = 0;
  for (const id of ids) {
    const row = await db.bank.findUnique({ where: { id } });
    if (!row || row.deletedAt) continue;
    await db.bank.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.id, deletedBy: user.id } });
    await writeAudit(db, {
      actorUserId: user.id,
      action: 'BANK_DELETED',
      targetType: 'Bank',
      targetId: String(id),
      before: auditSnapshot({ name: row.name, code: row.code })
    });
    deleted++;
  }
  return { ok: true, deleted };
}

// ─────────────────────────────────────────────────────────────────────────────
// C3 — LOẠI THẺ (dùng trên máy POS), thuộc 1 ngân hàng
// ─────────────────────────────────────────────────────────────────────────────
export interface CardTypeDto extends AuditTrail {
  id: number;
  bankId: number;
  bankName: string | null;
  bankCode: string | null;
  name: string;
  code: string;
  /** [Admin Demo 15/11] thẻ MẶC ĐỊNH của ngân hàng — màn Thêm bill tự chọn sẵn. Cột phụ `card_types.is_default`. */
  isDefault: boolean;
}
export interface CardTypeFilter {
  search?: string;
  bankId?: number;
  fromDate?: string;
  toDate?: string;
}
export interface CreateCardTypeInput {
  bankId: number;
  name: string;
  code: string;
  isDefault?: boolean;
}
export interface UpdateCardTypeInput {
  bankId?: number;
  name?: string;
  code?: string;
  isDefault?: boolean;
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock — mốc updatedAt client giữ lúc mở form
}

/**
 * Đặt/bỏ cờ THẺ MẶC ĐỊNH — mỗi ngân hàng NHIỀU NHẤT 1 thẻ mặc định.
 * Chạy 2 câu trong 1 giao dịch: xoá cờ cũ của CHÍNH ngân hàng đó rồi mới cắm cờ mới ⇒ không bao giờ có
 * 2 thẻ cùng mặc định (nếu để 2 cờ, màn Thêm bill sẽ chọn sẵn thẻ nào là tuỳ thứ tự trả về = sai tiền ngầm).
 * `is_default` là CỘT PHỤ (schema-ensure), Prisma client không biết ⇒ phải raw SQL.
 */
async function datCoMacDinh(db: Db, bankId: number, cardTypeId: number, isDefault: boolean): Promise<void> {
  if (isDefault) {
    await db.$executeRawUnsafe('UPDATE card_types SET is_default = false WHERE bank_id = $1 AND id <> $2', bankId, cardTypeId);
    await db.$executeRawUnsafe('UPDATE card_types SET is_default = true WHERE id = $1', cardTypeId);
  } else {
    await db.$executeRawUnsafe('UPDATE card_types SET is_default = false WHERE id = $1', cardTypeId);
  }
}

/** Đọc cờ mặc định cho 1 mớ id (cột phụ ⇒ raw). Trả Set id đang là thẻ mặc định. */
async function docCoMacDinh(db: Db, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db.$queryRawUnsafe<{ id: number }[]>(
    `SELECT id FROM card_types WHERE is_default = true AND id IN (${ids.map((_, i) => '$' + (i + 1)).join(',')})`,
    ...ids
  );
  return new Set(rows.map((r) => Number(r.id)));
}

export async function listCardTypes(ctx: ServiceCtx, filter: CardTypeFilter = {}): Promise<{ ok: boolean; data?: CardTypeDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.cardType.findMany({
    where: {
      deletedAt: null,
      bankId: filter.bankId ?? undefined,
      createdAt: dateRange(filter.fromDate, filter.toDate),
      // Tìm kiếm mã/tên — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts).
      AND: await dieuKienTimKiem(db, 'card_types', { code: 'code', name: 'name' }, filter.search)
    },
    orderBy: [{ bankId: 'asc' }, { name: 'asc' }],
    take: BANK_CONFIG_LIST_MAX
  });
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.createdBy, r.updatedBy]));
  const coMacDinh = await docCoMacDinh(db, rows.map((r) => r.id));
  const bankIds = [...new Set(rows.map((r) => r.bankId))];
  const banks = await db.bank.findMany({ where: { id: { in: bankIds } }, select: { id: true, name: true, code: true } });
  const bankMap = new Map(banks.map((b) => [b.id, b]));
  const data = rows.map((r) => ({
    id: r.id,
    bankId: r.bankId,
    bankName: nhanBank(bankMap.get(r.bankId)), // [16/11] HIỂN THỊ = MÃ viết tắt (MBV), không phải tên pháp nhân dài
    bankCode: bankMap.get(r.bankId)?.code ?? null,
    name: r.name,
    code: r.code,
    isDefault: coMacDinh.has(r.id),
    ...trail(r, names)
  }));
  // Admin Demo 13/7 — "ưu tiên cùng 1 ngân hàng rồi mới đến ngân hàng khác": nhóm theo TÊN NGÂN HÀNG A→Z, trong mỗi
  // ngân hàng sắp theo tên loại thẻ. (orderBy DB không sort được theo bankName vì là join → sort tại service.)
  data.sort((a, b) => (a.bankName ?? '').localeCompare(b.bankName ?? '', 'vi') || a.name.localeCompare(b.name, 'vi'));
  return { ok: true, data };
}

export async function createCardType(ctx: ServiceCtx, input: CreateCardTypeInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const name = input.name?.trim();
  const code = input.code?.trim();
  if (!input.bankId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn ngân hàng cho loại thẻ.' };
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên loại thẻ bắt buộc.' };
  if (!code) return { ok: false, error: 'VALIDATION', message: 'Mã loại thẻ bắt buộc.' };

  const bank = await db.bank.findUnique({ where: { id: input.bankId } });
  if (!bank || bank.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Ngân hàng đã chọn không tồn tại.' };

  const dup = await db.cardType.findFirst({ where: { bankId: input.bankId, code, deletedAt: null } });
  if (dup) return { ok: false, error: 'DUPLICATE', message: `Mã loại thẻ "${code}" đã tồn tại trong ngân hàng ${bank.code}.` };

  const created = await db.cardType.create({ data: { bankId: input.bankId, name, code, createdBy: user.id } });
  if (input.isDefault) await datCoMacDinh(db, input.bankId, created.id, true);
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'CARD_TYPE_CREATED',
    targetType: 'CardType',
    targetId: String(created.id),
    after: auditSnapshot({ bankId: input.bankId, bankCode: bank.code, name, code, isDefault: !!input.isDefault })
  });
  return { ok: true, id: created.id };
}

export async function updateCardType(ctx: ServiceCtx, id: number, input: UpdateCardTypeInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const row = await db.cardType.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại thẻ không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;

  const bankId = input.bankId ?? row.bankId;
  const name = input.name !== undefined ? input.name.trim() : row.name;
  const code = input.code !== undefined ? input.code.trim() : row.code;
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên loại thẻ không được để trống.' };
  if (!code) return { ok: false, error: 'VALIDATION', message: 'Mã loại thẻ không được để trống.' };

  const bank = await db.bank.findUnique({ where: { id: bankId } });
  if (!bank || bank.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Ngân hàng đã chọn không tồn tại.' };

  if (bankId !== row.bankId || code !== row.code) {
    const dup = await db.cardType.findFirst({ where: { bankId, code, deletedAt: null, NOT: { id } } });
    if (dup) return { ok: false, error: 'DUPLICATE', message: `Mã loại thẻ "${code}" đã tồn tại trong ngân hàng ${bank.code}.` };
  }

  const macDinhCu = (await docCoMacDinh(db, [id])).has(id);
  const before = auditSnapshot({ bankId: row.bankId, name: row.name, code: row.code, isDefault: macDinhCu });
  const updated = await db.cardType.update({ where: { id }, data: { bankId, name, code, updatedBy: user.id } });
  // `'isDefault' in input` chứ KHÔNG `input.isDefault !== undefined` ở lớp gọi: phân biệt "không gửi" với "gửi false".
  const macDinhMoi = input.isDefault === undefined ? macDinhCu : input.isDefault;
  if (macDinhMoi !== macDinhCu || bankId !== row.bankId) await datCoMacDinh(db, bankId, id, macDinhMoi);
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'CARD_TYPE_UPDATED',
    targetType: 'CardType',
    targetId: String(id),
    before,
    after: auditSnapshot({ bankId: updated.bankId, name: updated.name, code: updated.code, isDefault: macDinhMoi })
  });
  return { ok: true, id };
}

/** Xóa mềm 1..n loại thẻ. §14 xác nhận MẬT KHẨU do ADAPTER kiểm TRƯỚC khi gọi. */
export async function deleteCardTypes(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn loại thẻ để xóa.' };

  let deleted = 0;
  for (const id of ids) {
    const row = await db.cardType.findUnique({ where: { id } });
    if (!row || row.deletedAt) continue;
    await db.cardType.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.id, deletedBy: user.id } });
    await writeAudit(db, {
      actorUserId: user.id,
      action: 'CARD_TYPE_DELETED',
      targetType: 'CardType',
      targetId: String(id),
      before: auditSnapshot({ bankId: row.bankId, name: row.name, code: row.code })
    });
    deleted++;
  }
  return { ok: true, deleted };
}

// ─────────────────────────────────────────────────────────────────────────────
// C4 — ĐỐI TÁC
// ─────────────────────────────────────────────────────────────────────────────
export interface PartnerDto extends AuditTrail {
  id: number;
  name: string;
  code: string;
  status: string; // SIGNED | UNSIGNED | TERMINATED (mã tra StatusOption entity=PARTNER)
  address: string | null;
  phone: string | null;
  email: string | null;
  contactPerson: string | null;
  bankIds: number[];
}
export interface PartnerFilter {
  search?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
}
export interface CreatePartnerInput {
  name: string;
  code: string;
  status?: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  contactPerson?: string | null;
}
export interface UpdatePartnerInput {
  name?: string;
  code?: string;
  status?: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  contactPerson?: string | null;
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock — mốc updatedAt client giữ lúc mở form
}

export async function listPartners(ctx: ServiceCtx, filter: PartnerFilter = {}): Promise<{ ok: boolean; data?: PartnerDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.partner.findMany({
    where: {
      deletedAt: null,
      status: filter.status || undefined,
      createdAt: dateRange(filter.fromDate, filter.toDate),
      // Tìm kiếm mã/tên/SĐT/người liên hệ — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts).
      AND: await dieuKienTimKiem(db, 'partners', { code: 'code', name: 'name', phone: 'phone', contactPerson: 'contact_person' }, filter.search)
    },
    orderBy: { createdAt: 'asc' },
    take: BANK_CONFIG_LIST_MAX
  });
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.createdBy, r.updatedBy]));
  const links = await db.partnerBank.findMany({ where: { deletedAt: null, partnerId: { in: rows.map((r) => r.id) } }, select: { partnerId: true, bankId: true } });
  const linkMap = new Map<number, number[]>();
  for (const l of links) linkMap.set(l.partnerId, [...(linkMap.get(l.partnerId) ?? []), l.bankId]);
  return {
    ok: true,
    data: rows.map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      status: r.status,
      address: r.address,
      phone: r.phone,
      email: r.email,
      contactPerson: r.contactPerson,
      bankIds: linkMap.get(r.id) ?? [],
      ...trail(r, names)
    }))
  };
}

export async function createPartner(ctx: ServiceCtx, input: CreatePartnerInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const name = input.name?.trim();
  const code = input.code?.trim().toUpperCase();
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên đối tác bắt buộc.' };
  if (!code) return { ok: false, error: 'VALIDATION', message: 'Mã đối tác bắt buộc.' };
  const status = input.status?.trim() || 'UNSIGNED';
  if (!(await isValidStatus(ctx, 'PARTNER', status))) return { ok: false, error: 'VALIDATION', message: 'Trạng thái đối tác không hợp lệ.' };

  const dup = await db.partner.findFirst({ where: { code } });
  if (dup) {
    return dup.deletedAt
      ? { ok: false, error: 'DUPLICATE_TRASH', message: `Mã đối tác "${code}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn mã khác.` }
      : { ok: false, error: 'DUPLICATE', message: `Mã đối tác "${code}" đã tồn tại.` };
  }

  let created;
  try {
    created = await db.partner.create({
      data: {
        name,
        code,
        status,
        address: input.address?.trim() || null,
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        contactPerson: input.contactPerson?.trim() || null,
        createdBy: user.id
      }
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `Mã đối tác "${code}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'PARTNER_CREATED',
    targetType: 'Partner',
    targetId: String(created.id),
    after: auditSnapshot({ name: created.name, code: created.code, phone: created.phone, contactPerson: created.contactPerson })
  });
  return { ok: true, id: created.id };
}

export async function updatePartner(ctx: ServiceCtx, id: number, input: UpdatePartnerInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const row = await db.partner.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Đối tác không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;

  const name = input.name !== undefined ? input.name.trim() : row.name;
  const code = input.code !== undefined ? input.code.trim().toUpperCase() : row.code;
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên đối tác không được để trống.' };
  if (!code) return { ok: false, error: 'VALIDATION', message: 'Mã đối tác không được để trống.' };
  const status = input.status !== undefined ? input.status.trim() || row.status : row.status;
  if (input.status !== undefined && !(await isValidStatus(ctx, 'PARTNER', status))) return { ok: false, error: 'VALIDATION', message: 'Trạng thái đối tác không hợp lệ.' };
  if (code !== row.code) {
    const dup = await db.partner.findFirst({ where: { code, NOT: { id } } });
    if (dup) {
      return dup.deletedAt
        ? { ok: false, error: 'DUPLICATE_TRASH', message: `Mã đối tác "${code}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn mã khác.` }
        : { ok: false, error: 'DUPLICATE', message: `Mã đối tác "${code}" đã tồn tại.` };
    }
  }

  const before = auditSnapshot({ name: row.name, code: row.code, status: row.status, address: row.address, phone: row.phone, contactPerson: row.contactPerson });
  let updated;
  try {
    updated = await db.partner.update({
      where: { id },
      data: {
        name,
        code,
        status,
        address: input.address !== undefined ? input.address?.trim() || null : row.address,
        phone: input.phone !== undefined ? input.phone?.trim() || null : row.phone,
        email: input.email !== undefined ? input.email?.trim() || null : row.email,
        contactPerson: input.contactPerson !== undefined ? input.contactPerson?.trim() || null : row.contactPerson,
        updatedBy: user.id
      }
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `Mã đối tác "${code}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'PARTNER_UPDATED',
    targetType: 'Partner',
    targetId: String(id),
    before,
    after: auditSnapshot({ name: updated.name, code: updated.code, status: updated.status, address: updated.address, phone: updated.phone, contactPerson: updated.contactPerson })
  });
  return { ok: true, id };
}

/** Xóa mềm 1..n đối tác + hủy liên kết ngân hàng. §14 xác nhận MẬT KHẨU do ADAPTER kiểm TRƯỚC khi gọi. */
export async function deletePartners(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn đối tác để xóa.' };

  let deleted = 0;
  for (const id of ids) {
    const row = await db.partner.findUnique({ where: { id } });
    if (!row || row.deletedAt) continue;
    await db.partner.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.id, deletedBy: user.id } });
    // Hủy các liên kết ngân hàng của đối tác (soft) — audit riêng.
    await db.partnerBank.updateMany({ where: { partnerId: id, deletedAt: null }, data: { deletedAt: new Date(), updatedBy: user.id } });
    await writeAudit(db, {
      actorUserId: user.id,
      action: 'PARTNER_DELETED',
      targetType: 'Partner',
      targetId: String(id),
      before: auditSnapshot({ name: row.name, code: row.code })
    });
    deleted++;
  }
  return { ok: true, deleted };
}

// ─────────────────────────────────────────────────────────────────────────────
// C4c — LIÊN KẾT ĐỐI TÁC ↔ NGÂN HÀNG (many-to-many)
// ─────────────────────────────────────────────────────────────────────────────
export interface PartnerBankMatrixRow {
  partnerId: number;
  partnerCode: string;
  partnerName: string;
  bankIds: number[];
}
export interface PartnerBankMatrix {
  banks: { id: number; code: string; name: string }[];
  rows: PartnerBankMatrixRow[];
}

/** Bảng tích xanh: mỗi đối tác × mọi ngân hàng đang có, ô nào liên kết = tích. */
export async function getPartnerBankMatrix(ctx: ServiceCtx): Promise<{ ok: boolean; data?: PartnerBankMatrix; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const banks = await db.bank.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true, code: true, name: true } });
  const partners = await db.partner.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true, code: true, name: true } });
  const links = await db.partnerBank.findMany({ where: { deletedAt: null }, select: { partnerId: true, bankId: true } });
  const linkMap = new Map<number, number[]>();
  for (const l of links) linkMap.set(l.partnerId, [...(linkMap.get(l.partnerId) ?? []), l.bankId]);
  return {
    ok: true,
    data: {
      banks,
      rows: partners.map((p) => ({ partnerId: p.id, partnerCode: p.code, partnerName: p.name, bankIds: linkMap.get(p.id) ?? [] }))
    }
  };
}

/** Đặt tập ngân hàng liên kết cho 1 đối tác (thêm mới + hủy — soft, có audit từng thao tác). */
export async function setPartnerBanks(ctx: ServiceCtx, partnerId: number, bankIds: number[]): Promise<MutationResult & { linked?: number; unlinked?: number }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const partner = await db.partner.findUnique({ where: { id: partnerId } });
  if (!partner || partner.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Đối tác không tồn tại.' };

  const want = new Set<number>();
  for (const bId of bankIds ?? []) {
    const bank = await db.bank.findUnique({ where: { id: bId } });
    if (!bank || bank.deletedAt) return { ok: false, error: 'NOT_FOUND', message: `Ngân hàng (id ${bId}) không tồn tại.` };
    want.add(bId);
  }

  const existing = await db.partnerBank.findMany({ where: { partnerId } });
  const activeNow = new Set(existing.filter((e) => e.deletedAt === null).map((e) => e.bankId));

  let linked = 0;
  let unlinked = 0;
  const now = new Date();

  // Thêm liên kết: bật lại bản soft-deleted hoặc tạo mới.
  for (const bankId of want) {
    if (activeNow.has(bankId)) continue;
    const prior = existing.find((e) => e.bankId === bankId);
    if (prior) {
      await db.partnerBank.update({ where: { id: prior.id }, data: { deletedAt: null, updatedBy: user.id } });
    } else {
      await db.partnerBank.create({ data: { partnerId, bankId, createdBy: user.id } });
    }
    await writeAudit(db, {
      actorUserId: user.id,
      action: 'PARTNER_BANK_LINKED',
      targetType: 'Partner',
      targetId: String(partnerId),
      after: auditSnapshot({ partnerCode: partner.code, bankId })
    });
    linked++;
  }
  // Hủy liên kết không còn trong tập chọn (soft).
  for (const bankId of activeNow) {
    if (want.has(bankId)) continue;
    const prior = existing.find((e) => e.bankId === bankId && e.deletedAt === null);
    if (!prior) continue;
    await db.partnerBank.update({ where: { id: prior.id }, data: { deletedAt: now, updatedBy: user.id } });
    await writeAudit(db, {
      actorUserId: user.id,
      action: 'PARTNER_BANK_UNLINKED',
      targetType: 'Partner',
      targetId: String(partnerId),
      before: auditSnapshot({ partnerCode: partner.code, bankId })
    });
    unlinked++;
  }
  return { ok: true, linked, unlinked };
}

/** Danh sách ngân hàng gọn cho dropdown (chọn ngân hàng cho loại thẻ / liên kết đối tác). */
export async function listBanksLite(ctx: ServiceCtx): Promise<{ ok: boolean; data?: { id: number; code: string; name: string }[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const rows = await ctx.db.bank.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true, code: true, name: true } });
  return { ok: true, data: rows };
}
