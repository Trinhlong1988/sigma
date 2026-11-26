// SIGMA "Doanh số theo nhóm chat" (1/8) — liên kết TID <-> phòng chat khách hàng (bảng mới `chat_room_tids`,
// migration `20260801160000_chat_room_tid`) + tổng hợp doanh số từ Lo/LoRow hiện có (CÙNG khuôn routes/kpi.ts:
// Σ amountBeforeFee/feeApplied/amountAfterFee của LoRow thuộc các Lô KHÔNG bị hủy, bucket theo ngày LOCAL).
//
// GÁN TAY, KHÔNG tự động khớp theo tên HKD (Admin Demo xác nhận trực tiếp 1/8: "nhân viên tự gán tay trên phần
// mềm quản lý SigMa hoặc SigMa" — tên có thể trùng/viết khác nhau, tự động khớp dễ gắn nhầm, sai lệch số
// liệu doanh số cho SAI nhóm). CHỈ agent SỞ HỮU TID (Tid.agentId) VÀ đang là thành viên đang hoạt động của
// phòng đó mới được gán/gỡ — dùng lại assertActiveMember() (chat-room-service.ts, KHÔNG viết lại kiểm tra
// thành viên lần 2). 1 TID CHỈ gắn được 1 phòng (unique tidId, xem migration) — tránh doanh số bị đếm ở 2 nhóm.
import { type Db } from '@sigma/database';
import { ChatServiceError, assertActiveMember } from './chat-room-service.js';

export interface RoomTidDto {
  tidId: number;
  tid: string;
  hkdName: string | null;
  bankName: string | null;
  linkedAt: Date;
  linkedBy: number | null;
}

async function toRoomTidDto(db: Db, tidRow: { id: number; tid: string; hkdName: string | null; bankId: number | null }, link: { createdAt: Date; createdBy: number | null }): Promise<RoomTidDto> {
  const bank = tidRow.bankId != null ? await db.bank.findUnique({ where: { id: tidRow.bankId }, select: { name: true } }) : null;
  return {
    tidId: tidRow.id,
    tid: tidRow.tid,
    hkdName: tidRow.hkdName,
    bankName: bank?.name ?? null,
    linkedAt: link.createdAt,
    linkedBy: link.createdBy
  };
}

// GỠ (21/8): linkTidToRoom/unlinkTidFromRoom (gắn/gỡ TID tay) — đã bỏ nút app + doanh số nay suy TỪ KHÁCH, KHÔNG
// dùng chat_room_tids. 2 hàm đó gate `tid.agentId === requesterAgentId` mà tids.agentId LUÔN null ở production →
// FORBIDDEN mọi lúc (dead gate). Guard test `no-tid-agentid-gate` chặn tái diễn (tid-agentid-gate.guard.test.ts).

/** TID của 1 phòng = TID của KHÁCH gắn phòng đó (Admin Demo 21/8 "TID phòng tự suy từ khách, khách/đại lý KHÔNG tự
 * ý thêm TID"). ĐẠI LÝ = KHÁCH = 1: phòng gắn khách qua `customer_chat_groups` (1 phòng ↔ 1 khách, partial-unique)
 * → TID của phòng = mọi TID CÒN SỐNG của khách đó. Admin quản TID↔khách trên desktop (Giao TID); app chat KHÔNG
 * gán tay nữa. THAY cách cũ `chat_room_tids` + `tid.agentId` (agentId LUÔN null ở production → doanh số luôn 0 +
 * gán tay luôn FORBIDDEN — bug sót từ audit 20/8 I1, CÙNG lỗi đã sửa ở agents.ts/fee-quote.ts). */
export async function roomCustomerTidRows(db: Db, roomId: string): Promise<{ id: number; tid: string; hkdName: string | null; bankId: number | null; createdAt: Date }[]> {
  const groups = await db.customerChatGroup.findMany({ where: { roomId, unassignedAt: null }, select: { customerId: true } });
  const customerIds = [...new Set(groups.map((g) => g.customerId))];
  if (customerIds.length === 0) return [];
  return db.tid.findMany({
    where: { customerId: { in: customerIds }, deletedAt: null },
    select: { id: true, tid: true, hkdName: true, bankId: true, createdAt: true },
    orderBy: { id: 'asc' }
  });
}

/** Danh sách TID của phòng (suy TỪ KHÁCH — xem roomCustomerTidRows). CHỈ đòi requester là thành viên phòng (xem
 * chung cả nhóm). `linkedAt` = ngày tạo TID (không còn khái niệm "gắn phòng tay"); `linkedBy` = null. */
export async function listRoomTids(db: Db, requesterAgentId: number, roomId: string): Promise<RoomTidDto[]> {
  await assertActiveMember(db, roomId, requesterAgentId);
  const tids = await roomCustomerTidRows(db, roomId);
  if (tids.length === 0) return [];
  const out: RoomTidDto[] = [];
  for (const t of tids) {
    out.push(await toRoomTidDto(db, t, { createdAt: t.createdAt, createdBy: null }));
  }
  return out;
}

// ── Tổng hợp doanh số theo phòng ──────────────────────────────────────────────────────────────────────────

/** Bucket ngày LOCAL (giờ máy chủ) — CÙNG hàm `localDateKey` đã dùng ở routes/kpi.ts (không viết lại 2 nơi
 * khác công thức — nhất quán "1 ngày" giữa 2 báo cáo). */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface RoomRevenueRow {
  loId: number;
  tidId: number;
  date: string; // ngày LOCAL "YYYY-MM-DD" = NGÀY BILL THẬT (COALESCE(los.bill_txn_date, lo_rows.created_at)) — đồng nhất NĐT/GD
  effDateIso: string; // MỐC BILL THẬT có GIỜ (ISO/UTC = COALESCE(bill_txn_date, created_at)) → web format giờ "HH:mm" theo TZ VN (Admin Demo 2/9 lấp cột Giờ).
  bankReportedLoNumber: number | null;
  billLoNumber: string | null; // SỐ LÔ trên bill (từ billKey), khi chưa đối soát bank (Admin Demo 31/8: KHÔNG hiện loId nội bộ).
  /** [Admin Demo 16/9 khuya] MÃ ĐÓNG LÔ ("95") → bảng/Excel/ảnh hiện số lô "84(95)" để theo dõi lô rủi ro. */
  settlementCode?: string | null;
  investorNickname: string | null; // TÊN NĐT của lô (TID → receive_accounts.investor_id → investors.nickname||fullName). Null = không resolve được ('—').
  gross: number; // amountBeforeFee
  fee: number; // feeApplied
  net: number; // amountAfterFee
  // [Admin Demo 7/9 — MƯỢN TID] lô này đại lý phòng MƯỢN TID của đại lý khác để quẹt → doanh số về phòng NÀY (người mượn).
  // borrowed=true + tidOwnerName = tên chủ TID được mượn (hiện "Mượn TID của <owner>" trong báo cáo). false = bình thường.
  // borrowedTid/Hkd/Bank = thông tin TID mượn (TID ∉ danh sách phòng nên client không tra được qua tids → backend trả kèm).
  borrowed: boolean;
  tidOwnerName: string | null;
  borrowedTid?: string;
  borrowedHkd?: string | null;
  borrowedBank?: string | null;
}

export interface RoomRevenueReport {
  from: string;
  to: string;
  tids: RoomTidDto[]; // TẤT CẢ TID đã gắn phòng (cho UI dựng dải chip lọc) — KHÔNG lọc theo tidId filter dưới
  totalGross: number;
  totalFee: number;
  totalNet: number;
  loCount: number;
  daily: { date: string; gross: number; net: number }[];
  rows: RoomRevenueRow[];
}

/** Tổng hợp doanh số các TID TỪNG gắn phòng `roomId` trong khoảng `[from, to)` (nửa-mở, LOCAL — CÙNG quy ước
 * routes/kpi.ts). `tidId` tùy chọn — CHỈ lọc 1 TID cụ thể (đang gắn phòng — chip lọc UI chỉ cho chọn TID
 * ĐANG gắn), KHÔNG lọc gì (mặc định gộp TẤT CẢ TID đang gắn phòng). Loại trừ Lô đã hủy (status CANCELLED,
 * CÙNG kpi.ts).
 *
 * TÍNH THEO GIAI ĐOẠN GẮN THẬT (fix bug review độc lập 1/8): mỗi LoRow chỉ được tính vào phòng này nếu
 * createdAt của nó rơi vào đúng khoảng [linkedAt, unlinkedAt) mà TID đó ĐANG/ĐÃ gắn phòng NÀY — KHÔNG dùng
 * trạng thái gắn hiện tại để lọc, tránh trường hợp TID gỡ khỏi phòng A rồi gắn sang phòng B "cướp" luôn
 * doanh số cũ của phòng A (và phòng A mất khoản đó khỏi báo cáo dù Lô đã tạo lúc TID còn ở phòng A). */
// [Admin Demo 7/9] ATTRIBUTION THEO NGÀY (đúng comment §108-111 nhưng trước nay CHƯA làm — dùng nhóm active nên chuyển
// đại lý là "cướp" cả lịch sử). Khách chuyển phòng có mốc (customer_chat_groups.assigned_at/unassigned_at) → mỗi Lô
// tính vào phòng KHÁCH ĐANG Ở TẠI NGÀY BILL. THUẦN → test khoá cứng.
export interface CustGroupInterval { roomId: string; assignedAt: Date; unassignedAt: Date | null }
/** Phòng active của 1 khách tại thời điểm d: nhóm PHỦ d (assignedAt≤d<unassignedAt||∞). d TRƯỚC nhóm sớm nhất → nhóm
 *  sớm nhất (bill trước khi gán phòng đầu → vẫn về phòng đầu, KHÔNG mất — an toàn case thường dù assignedAt gần đây).
 *  d trong "khe" sau khi rời phòng cũ trước khi vào phòng mới → phòng active GẦN NHẤT trước d. null nếu không có nhóm. */
export function resolveActiveRoomAtDate(groups: CustGroupInterval[], d: Date): string | null {
  if (groups.length === 0) return null;
  const sorted = [...groups].sort((a, b) => a.assignedAt.getTime() - b.assignedAt.getTime());
  const t = d.getTime();
  for (const g of sorted) if (t >= g.assignedAt.getTime() && (g.unassignedAt == null || t < g.unassignedAt.getTime())) return g.roomId;
  if (t < sorted[0].assignedAt.getTime()) return sorted[0].roomId; // bill trước phòng đầu → phòng đầu
  let best: string | null = null; // khe/sau tất cả → phòng gán gần nhất trước d
  for (const g of sorted) if (t >= g.assignedAt.getTime()) best = g.roomId;
  return best;
}

export async function getRoomRevenueReport(
  db: Db,
  requesterAgentId: number,
  roomId: string,
  opts: { from: Date; to: Date; tidId?: number }
): Promise<RoomRevenueReport> {
  await assertActiveMember(db, roomId, requesterAgentId);
  if (opts.from.getTime() >= opts.to.getTime()) {
    throw new ChatServiceError('VALIDATION', 'from phải nhỏ hơn to.');
  }

  // TID của phòng = TID của KHÁCH gắn phòng (Admin Demo 21/8) — KHÔNG còn lọc theo tid.agentId (agentId LUÔN null
  // ở production → scope rỗng → doanh số luôn 0, bug sót audit 20/8). Đại lý=khách=1: mọi TID của khách thuộc
  // phòng đều tính vào doanh số phòng; thành viên phòng đều xem được (không còn phân tách margin theo agent — 1
  // phòng ↔ 1 khách nên không có TID của "đại lý khác" lẫn vào).
  // [Admin Demo 7/9] Scope theo KỲ: khách có nhóm ở phòng này CHỒNG [from,to) (kể cả đã rời — để lịch sử trước-khi-rời
  // vẫn hiện). KHÔNG chỉ nhóm active (nếu chỉ active thì khách chuyển đi = mất sạch lịch sử phòng cũ).
  // Nhóm ở phòng NÀY còn liên quan kỳ: CÒN active (unassignedAt null → khách vẫn ở, bill cũ vẫn về đây qua resolver)
  // HOẶC rời SAU khi kỳ bắt đầu (unassignedAt > from). KHÔNG chặn theo assignedFrom (nhóm tạo gần đây vẫn phủ bill cũ).
  const rGroups = await db.customerChatGroup.findMany({
    where: { roomId, OR: [{ unassignedAt: null }, { unassignedAt: { gt: opts.from } }] },
    select: { customerId: true }
  });
  const periodCustomerIds = [...new Set(rGroups.map((g) => g.customerId))];
  const tidRows = periodCustomerIds.length
    ? await db.tid.findMany({ where: { customerId: { in: periodCustomerIds }, deletedAt: null }, select: { id: true, tid: true, hkdName: true, bankId: true, customerId: true, createdAt: true }, orderBy: { id: 'asc' } })
    : [];
  const tidToCustomer = new Map(tidRows.map((t) => [t.id, t.customerId]));
  // Nhóm của các khách này Ở MỌI PHÒNG (để biết mỗi ngày khách đang ở phòng nào → attribution theo ngày). Bỏ nhóm roomId null.
  const allGroups = periodCustomerIds.length
    ? await db.customerChatGroup.findMany({ where: { customerId: { in: periodCustomerIds } }, select: { customerId: true, roomId: true, assignedFrom: true, unassignedAt: true } })
    : [];
  const custGroups = new Map<number, CustGroupInterval[]>();
  for (const g of allGroups) { if (!g.roomId) continue; const a = custGroups.get(g.customerId) ?? []; a.push({ roomId: g.roomId, assignedAt: g.assignedFrom, unassignedAt: g.unassignedAt }); custGroups.set(g.customerId, a); }
  const tids: RoomTidDto[] = [];
  for (const t of tidRows) tids.push(await toRoomTidDto(db, t, { createdAt: t.createdAt, createdBy: null }));
  if (opts.tidId != null && !tids.some((t) => t.tidId === opts.tidId)) {
    throw new ChatServiceError('TID_NOT_IN_ROOM', `TID id=${opts.tidId} không thuộc khách của phòng id=${roomId}.`);
  }
  const scopeTidIds = (opts.tidId != null ? tids.filter((t) => t.tidId === opts.tidId) : tids).map((t) => t.tidId);
  // [Admin Demo 7/9 — MƯỢN TID] Khi KHÔNG lọc theo 1 TID cụ thể: doanh số phòng còn gồm LÔ đại lý phòng MƯỢN TID người
  // khác (los.borrowed_by_customer_id ∈ khách của phòng), dù TID chủ ∉ phòng. (Lô TID phòng nhưng mượn-RA cho đại lý
  // khác → filter dưới loại khỏi phòng này.) Lọc theo 1 TID thì chỉ TID đó (không kéo lô mượn).
  const borrowScope = opts.tidId == null ? periodCustomerIds : [];
  if (scopeTidIds.length === 0 && borrowScope.length === 0) {
    return { from: opts.from.toISOString(), to: opts.to.toISOString(), tids, totalGross: 0, totalFee: 0, totalNet: 0, loCount: 0, daily: [], rows: [] };
  }

  // Join TAY qua scalar tidId/loId (Lo/LoRow KHÔNG có Prisma relation object — CÙNG lý do đã ghi ở lo-service.ts).
  // NGÀY = NGÀY BILL THẬT (Admin Demo 31/8 "doanh số Huy 30/8 sau vẫn 31/8"): lọc + gán ngày theo
  // COALESCE(los.bill_txn_date, lo_rows.created_at) — KHÔNG dùng created_at (giờ GHI) → đại lý khớp NĐT/GD (bill
  // 30/8 ghi 31/8 vẫn rơi 30/8). Raw SQL vì bill_txn_date là cột ngoài prisma client (đọc/ghi raw ở lo-service).
  // [Admin Demo 8/9 — FIX SẠCH +7h] TRẢ effDate dưới dạng UTC ISO **TEXT** (AT TIME ZONE 'UTC' + to_char), KHÔNG để Prisma
  // parse timestamptz → Date. GỐC: driver-adapter Prisma đọc timestamptz "16:40+07" thành Date 16:40**Z** (bỏ +07) →
  // effDateIso lệch +7 → web hiện giờ +7 (16:47→23:47) VÀ ngày bill tối bị đẩy sang hôm sau. Text UTC → JS new Date()
  // dựng đúng instant. Bộ LỌC [from,to) vẫn so ::timestamptz trong PG (đúng TZ) nên không đổi.
  const loRowsRaw = await db.$queryRawUnsafe<{ loId: number; tidId: number; amountBeforeFee: bigint; feeApplied: bigint; amountAfterFee: bigint; effIso: string; borrowedBy: number | null }[]>(
    `SELECT lr.lo_id AS "loId", lr.tid_id AS "tidId", lr.amount_before_fee AS "amountBeforeFee",
            lr.fee_applied AS "feeApplied", lr.amount_after_fee AS "amountAfterFee",
            l.borrowed_by_customer_id AS "borrowedBy",
            to_char(COALESCE(l.bill_txn_date, lr.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effIso"
     FROM lo_rows lr JOIN los l ON l.id = lr.lo_id
     WHERE (lr.tid_id = ANY($1::int[]) OR l.borrowed_by_customer_id = ANY($4::int[]))
       AND COALESCE(l.bill_txn_date, lr.created_at) >= $2::timestamptz
       AND COALESCE(l.bill_txn_date, lr.created_at) < $3::timestamptz`,
    scopeTidIds, opts.from.toISOString(), opts.to.toISOString(), borrowScope
  );
  // [Admin Demo 7/9] LỌC theo phòng-active-tại-NGÀY-bill + MƯỢN TID: lô tính vào phòng NÀY nếu ĐẠI LÝ GÁN-DOANH-SỐ đang ở
  // phòng này tại effDate. Đại lý gán = borrowed_by_customer_id (nếu MƯỢN) ELSE chủ TID. → lô mượn-VÀO tính cho phòng
  // người mượn; lô TID phòng nhưng mượn-RA (borrowedBy ≠ khách phòng) tự bị loại (custGroups của borrower ∉ phòng → null).
  const loRows = loRowsRaw.filter((r) => {
    const cid = r.borrowedBy != null ? Number(r.borrowedBy) : (tidToCustomer.get(r.tidId) ?? null);
    return cid != null && resolveActiveRoomAtDate(custGroups.get(cid) ?? [], new Date(r.effIso)) === roomId;
  });
  if (loRows.length === 0) {
    return { from: opts.from.toISOString(), to: opts.to.toISOString(), tids, totalGross: 0, totalFee: 0, totalNet: 0, loCount: 0, daily: [], rows: [] };
  }
  const loIds = [...new Set(loRows.map((r) => r.loId))];
  const los = await db.lo.findMany({ where: { id: { in: loIds } }, select: { id: true, status: true, bankReportedLoNumber: true, billKey: true } });
  // Số lô trên BILL = đoạn thứ 3 của billKey `nat|tid|LÔ|hđ` hoặc `VL|tid|LÔ|ngày` (Admin Demo 31/8 "số lô đếm sai" —
  // trước hiện loId nội bộ). '?'/rỗng → null.
  const billLoOf = (billKey: string | null): string | null => {
    const m = /^(?:nat|VL)\|[^|]*\|([^|]*)\|/.exec(billKey ?? '');
    const b = m?.[1]?.trim();
    return b && b !== '?' && !b.startsWith('amt:') ? b : null;
  };
  const loById = new Map(los.map((l) => [l.id, l]));
  // [Admin Demo 16/9 khuya] MÃ ĐÓNG LÔ (95…) — cột thêm bằng schema-ensure nên chưa có trong Prisma model → đọc raw.
  // Cần để bảng doanh số hiện "84(95)" KỂ CẢ khi lô đã có số lô ngân hàng (client ưu tiên số bank).
  const maDongLo = new Map<number, string>();
  try {
    const ids = los.map((l) => l.id);
    if (ids.length) {
      const scRows = await db.$queryRawUnsafe<Array<{ id: number; settlement_code: string | null }>>(
        `SELECT id, settlement_code FROM los WHERE id = ANY($1) AND settlement_code IS NOT NULL`, ids);
      for (const r of scRows) if (r.settlement_code) maDongLo.set(Number(r.id), String(r.settlement_code));
    }
  } catch (e) { console.error('[room-revenue] không đọc được settlement_code (bỏ qua, không chặn báo cáo):', e instanceof Error ? e.message : e); }

  // [Admin Demo 7/9 — MƯỢN TID] TID của lô đang tính (gồm CẢ TID mượn ∉ phòng) — để resolve NĐT + tên CHỦ TID mượn.
  const rowTidIds = [...new Set(loRows.map((r) => r.tidId))];
  // Tên CHỦ TID + tid/hkd/bank cho lô MƯỢN (TID thuộc đại lý khác, ∉ danh sách phòng) → hiện đủ + "Mượn TID của <chủ>".
  const loBorrowedBy = new Map(loRows.filter((r) => r.borrowedBy != null).map((r) => [r.loId, true]));
  const borrowedTidOwner = new Map<number, string | null>();
  const borrowedTidInfo = new Map<number, { tid: string; hkdName: string | null; bankName: string | null }>();
  const borrowedTidIds = [...new Set(loRows.filter((r) => r.borrowedBy != null).map((r) => r.tidId))];
  if (borrowedTidIds.length) {
    const bt = await db.tid.findMany({ where: { id: { in: borrowedTidIds } }, select: { id: true, tid: true, hkdName: true, bankId: true, customerId: true } });
    const ownerIds = [...new Set(bt.map((t) => t.customerId).filter((x): x is number => x != null))];
    const owners = ownerIds.length ? await db.customer.findMany({ where: { id: { in: ownerIds } }, select: { id: true, fullName: true, nickname: true } }) : [];
    const ownerName = new Map(owners.map((o) => [o.id, o.nickname || o.fullName]));
    const bankIds = [...new Set(bt.map((t) => t.bankId).filter((x): x is number => x != null))];
    const banks = bankIds.length ? await db.bank.findMany({ where: { id: { in: bankIds } }, select: { id: true, code: true, name: true } }) : [];
    const bankName = new Map(banks.map((b) => [b.id, b.code || b.name]));
    for (const t of bt) {
      borrowedTidOwner.set(t.id, t.customerId != null ? (ownerName.get(t.customerId) ?? null) : null);
      borrowedTidInfo.set(t.id, { tid: t.tid, hkdName: t.hkdName ?? null, bankName: t.bankId != null ? (bankName.get(t.bankId) ?? null) : null });
    }
  }

  // TÊN NĐT per-TID (Admin Demo 2/9 lấp cột NĐT ở báo cáo đại lý): TID → receive_accounts.investor_id → investors.
  // Batch 3 query (KHÔNG N+1) trên tập TID đang tính (gồm TID mượn). Không resolve được → null ('—').
  const tidAccts = await db.tid.findMany({ where: { id: { in: rowTidIds } }, select: { id: true, receiveAccountId: true } });
  const raIds = [...new Set(tidAccts.map((t) => t.receiveAccountId).filter((x): x is number => x != null))];
  const ras = raIds.length > 0 ? await db.receiveAccount.findMany({ where: { id: { in: raIds }, deletedAt: null }, select: { id: true, investorId: true } }) : [];
  const raToInv = new Map(ras.map((r) => [r.id, r.investorId]));
  const invIds = [...new Set(ras.map((r) => r.investorId).filter((x): x is number => x != null))];
  const invs = invIds.length > 0 ? await db.investor.findMany({ where: { id: { in: invIds } }, select: { id: true, nickname: true, fullName: true } }) : [];
  const invName = new Map(invs.map((i) => [i.id, i.nickname || i.fullName])); // nickname||fullName = investorName chuẩn toàn app
  const tidToInvName = new Map<number, string | null>();
  for (const t of tidAccts) {
    const invId = t.receiveAccountId != null ? raToInv.get(t.receiveAccountId) : null;
    tidToInvName.set(t.id, invId != null ? (invName.get(invId) ?? null) : null);
  }

  const rows: RoomRevenueRow[] = [];
  const dailyMap = new Map<string, { gross: number; net: number }>();
  let totalGross = 0;
  let totalFee = 0;
  let totalNet = 0;
  const activeLoIds = new Set<number>();

  for (const r of loRows) {
    const lo = loById.get(r.loId);
    if (!lo || lo.status === 'CANCELLED') continue; // Lô đã hủy KHÔNG tính vào doanh số (CÙNG kpi.ts).
    const gross = Number(r.amountBeforeFee);
    const fee = Number(r.feeApplied);
    const net = Number(r.amountAfterFee);
    totalGross += gross;
    totalFee += fee;
    totalNet += net;
    activeLoIds.add(r.loId);
    const effDate = new Date(r.effIso); // instant ĐÚNG (dựng từ UTC ISO text — không dính lỗi Prisma +7)
    const date = localDateKey(effDate); // NGÀY BILL THẬT (bill_txn_date fallback created_at) — đồng nhất với NĐT/GD.
    const effDateIso = r.effIso; // MỐC có GIỜ (UTC ISO) → web format "HH:mm" theo TZ VN (cột Giờ) — đúng giờ, hết +7.
    const isBorrowed = loBorrowedBy.get(r.loId) === true;
    const bInfo = isBorrowed ? borrowedTidInfo.get(r.tidId) : undefined;
    rows.push({ loId: r.loId, tidId: r.tidId, date, effDateIso, bankReportedLoNumber: lo.bankReportedLoNumber, billLoNumber: billLoOf(lo.billKey), settlementCode: maDongLo.get(r.loId) ?? null, investorNickname: tidToInvName.get(r.tidId) ?? null, gross, fee, net, borrowed: isBorrowed, tidOwnerName: isBorrowed ? (borrowedTidOwner.get(r.tidId) ?? null) : null, borrowedTid: bInfo?.tid, borrowedHkd: bInfo?.hkdName ?? null, borrowedBank: bInfo?.bankName ?? null });
    const bucket = dailyMap.get(date) ?? { gross: 0, net: 0 };
    bucket.gross += gross;
    bucket.net += net;
    dailyMap.set(date, bucket);
  }

  const daily = [...dailyMap.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, v]) => ({ date, ...v }));
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // mới nhất trước, khớp quy ước danh sách khác trong app.

  return {
    from: opts.from.toISOString(),
    to: opts.to.toISOString(),
    tids,
    totalGross,
    totalFee,
    totalNet,
    loCount: activeLoIds.size,
    daily,
    rows
  };
}
