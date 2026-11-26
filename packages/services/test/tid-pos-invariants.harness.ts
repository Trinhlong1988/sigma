// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION HARNESS — bất biến TID ↔ POS (asset consistency). Dùng SAU MỖI mutation
// tài sản (@sigma/services) để khẳng định trạng thái tồn KHÔNG rơi vào lớp bug đã từng lọt:
// orphan serial (TID chết ÔM máy), delivered-nhưng-không-ACTIVE, on-device-nhưng-không-delivered,
// terminal-tid-giữ-máy, warehouseId lệch IN_STOCK.
//
// Nguồn HIẾN PHÁP: memory reference_tid_pos_consistency_invariants.md (6 invariant gốc) + bản vá
// TID-1 (audit 20/8): TID DEAD/đã-thay GIỮ deliveredAt+customerId (lịch sử) nhưng PHẢI NHẢ posSerial+agentId.
// Vì vậy các invariant PHẢI phân theo TRẠNG THÁI: terminal (DEAD/CLOSED/RECALLED/SOLD) vs operational
// (UNASSIGNED/ACTIVE) — KHÔNG áp "delivered⟹ACTIVE" cho hàng terminal (nó giữ deliveredAt làm lịch sử).
//
// DEPENDENCY-FREE: chỉ dùng db.tid.findMany + db.posDevice.findMany (không import service/business-rules)
// → chạy được với CẢ Db thật (Prisma) LẪN Db giả in-memory. Trả về list chuỗi vi phạm (rỗng = sạch).
// ─────────────────────────────────────────────────────────────────────────────

/** Trạng thái TID đã "chốt sổ" — hàng chết/đóng/thu-hồi/bán. Giữ lịch sử (deliveredAt/customerId) nhưng
 *  KHÔNG còn là hàng đang vận hành: KHÔNG được ôm máy/đại lý. */
export const TERMINAL_TID_STATUSES = new Set(['DEAD', 'CLOSED', 'RECALLED', 'SOLD']);
/** Trạng thái TID đang vận hành. */
export const OPERATIONAL_TID_STATUSES = new Set(['UNASSIGNED', 'ACTIVE']);

/** Shape TID tối thiểu mà checker cần (khớp cột Prisma `tids`). */
export interface InvariantTidRow {
  id: number;
  tid: string;
  status: string;
  posSerial: string | null;
  agentId: number | null;
  customerId: number | null;
  deliveredAt: Date | null;
  deletedAt: Date | null;
}
/** Shape PosDevice tối thiểu mà checker cần (khớp cột Prisma `pos_devices`). */
export interface InvariantDeviceRow {
  id: number;
  serial: string;
  status: string;
  currentTid: string | null;
  currentCustomerId: number | null;
  warehouseId: number | null;
  deletedAt: Date | null;
}

/** Db tối thiểu: chỉ cần list được tids + pos_devices. Cả Prisma Db thật lẫn fake in-memory đều thỏa. */
export interface InvariantDb {
  tid: { findMany: (args?: { where?: Record<string, unknown> }) => Promise<InvariantTidRow[]> };
  posDevice: { findMany: (args?: { where?: Record<string, unknown> }) => Promise<InvariantDeviceRow[]> };
}

/**
 * Quét TẤT CẢ tid chưa xóa + pos_device chưa xóa và trả về danh sách chuỗi vi phạm bất biến TID↔POS.
 * Rỗng = trạng thái tồn nhất quán. Mỗi chuỗi nêu rõ ĐỐI TƯỢNG (tid/serial) + MÃ invariant vi phạm.
 *
 * Invariant (scope: terminal = {DEAD,CLOSED,RECALLED,SOLD}, operational = {UNASSIGNED,ACTIVE}):
 *   I1  tid.posSerial≠null ⟹ status='ACTIVE'                         (chỉ TID sống mới ôm máy)
 *   I2  terminal ⟹ posSerial=null AND agentId=null                   (chống orphan serial — TID chết nhả máy)
 *   I3  status='UNASSIGNED' ⟹ posSerial=null, customerId=null, deliveredAt=null (recall reset sạch)
 *   I4  non-terminal & deliveredAt≠null ⟹ status='ACTIVE'            (delivered⟹ACTIVE, chỉ hàng đang vận hành)
 *   I5  device.warehouseId≠null ⟺ status='IN_STOCK'                  (máy ở kho ⟺ trong kho)
 *   I6  tid.posSerial=S ⟹ device(serial=S) tồn tại, currentTid=tid, status='DEPLOYED'
 *   I7  device DEPLOYED & currentTid≠null ⟹ tồn tại tid với tid=currentTid AND posSerial=serial
 *   I8  device.currentCustomerId≠null ⟹ warehouseId=null AND status ∈ {DEPLOYED, SOLD}
 *       (máy có khách gắn: PHẢI ngoài kho + đang giao HOẶC đã bán — KHÔNG được IN_STOCK/IN_REPAIR/…; SOLD giữ
 *        currentCustomerId = người MUA nên được miễn yêu-cầu-DEPLOYED. Quyết định Admin Demo 21/8.)
 */
/** Trạng thái máy được phép "có khách gắn" (currentCustomerId≠null): đang giao HOẶC đã bán (giữ người mua). */
const CUSTOMER_HELD_DEVICE_STATUSES = new Set(['DEPLOYED', 'SOLD']);
export async function assertTidPosInvariants(db: InvariantDb): Promise<string[]> {
  const violations: string[] = [];

  const tids = await db.tid.findMany({ where: { deletedAt: null } });
  // "TẤT CẢ pos_devices" theo spec — nhưng máy đã xóa mềm không còn ràng buộc tồn kho; quét máy chưa xóa.
  const devices = await db.posDevice.findMany({ where: { deletedAt: null } });

  const deviceBySerial = new Map<string, InvariantDeviceRow>();
  for (const d of devices) deviceBySerial.set(d.serial, d);
  const tidByStr = new Map<string, InvariantTidRow>();
  for (const t of tids) tidByStr.set(t.tid, t);

  for (const t of tids) {
    const terminal = TERMINAL_TID_STATUSES.has(t.status);
    const who = `tid#${t.id}(${t.tid}, status=${t.status})`;

    // I1 — posSerial ⟹ ACTIVE.
    if (t.posSerial != null && t.status !== 'ACTIVE') {
      violations.push(`[I1] ${who} giữ posSerial=${t.posSerial} nhưng status≠ACTIVE (chỉ TID ACTIVE mới được ôm máy).`);
    }

    // I2 — terminal ⟹ nhả máy + nhả đại lý (chống orphan serial).
    if (terminal) {
      if (t.posSerial != null) {
        violations.push(`[I2] ${who} là TID terminal nhưng còn posSerial=${t.posSerial} (orphan serial — phải nhả máy).`);
      }
      if (t.agentId != null) {
        violations.push(`[I2] ${who} là TID terminal nhưng còn agentId=${t.agentId} (phải nhả đại lý).`);
      }
    }

    // I3 — UNASSIGNED ⟹ sạch (recall reset).
    if (t.status === 'UNASSIGNED') {
      if (t.posSerial != null) violations.push(`[I3] ${who} UNASSIGNED nhưng còn posSerial=${t.posSerial} (recall chưa reset máy).`);
      if (t.customerId != null) violations.push(`[I3] ${who} UNASSIGNED nhưng còn customerId=${t.customerId} (recall chưa reset khách).`);
      if (t.deliveredAt != null) violations.push(`[I3] ${who} UNASSIGNED nhưng còn deliveredAt=${t.deliveredAt.toISOString()} (recall chưa reset mốc giao).`);
    }

    // I4 — non-terminal đã giao ⟹ ACTIVE. (Terminal giữ deliveredAt làm lịch sử → KHÔNG áp.)
    if (!terminal && t.deliveredAt != null && t.status !== 'ACTIVE') {
      violations.push(`[I4] ${who} có deliveredAt≠null (đã giao) nhưng status≠ACTIVE (delivered⟹ACTIVE).`);
    }

    // I6 — tid ôm máy ⟹ máy tồn tại + trỏ đúng TID + DEPLOYED.
    if (t.posSerial != null) {
      const dev = deviceBySerial.get(t.posSerial);
      if (!dev) {
        violations.push(`[I6] ${who} trỏ posSerial=${t.posSerial} nhưng KHÔNG có pos_device serial đó (hoặc đã xóa).`);
      } else {
        if (dev.currentTid !== t.tid) violations.push(`[I6] ${who} trỏ máy ${t.posSerial} nhưng device.currentTid=${dev.currentTid ?? 'null'} (≠${t.tid}).`);
        if (dev.status !== 'DEPLOYED') violations.push(`[I6] ${who} trỏ máy ${t.posSerial} nhưng device.status=${dev.status} (≠DEPLOYED).`);
      }
    }
  }

  for (const d of devices) {
    const who = `device#${d.id}(${d.serial}, status=${d.status})`;

    // I5 — warehouseId ⟺ IN_STOCK.
    const hasWarehouse = d.warehouseId != null;
    const inStock = d.status === 'IN_STOCK';
    if (hasWarehouse !== inStock) {
      violations.push(`[I5] ${who} warehouseId=${d.warehouseId ?? 'null'} nhưng ${inStock ? 'IN_STOCK phải CÓ kho' : 'không IN_STOCK phải KHÔNG kho'} (warehouseId≠null ⟺ IN_STOCK).`);
    }

    // I7 — máy DEPLOYED ôm TID ⟹ tồn tại TID trỏ ngược lại.
    if (d.status === 'DEPLOYED' && d.currentTid != null) {
      const t = tidByStr.get(d.currentTid);
      if (!t) {
        violations.push(`[I7] ${who} DEPLOYED mang currentTid=${d.currentTid} nhưng KHÔNG có tid chưa-xóa nào tên đó.`);
      } else if (t.posSerial !== d.serial) {
        violations.push(`[I7] ${who} DEPLOYED mang currentTid=${d.currentTid} nhưng tid#${t.id}.posSerial=${t.posSerial ?? 'null'} (≠${d.serial}).`);
      }
    }

    // I8 — currentCustomerId ⟹ ngoài kho + đang giao HOẶC đã bán (SOLD giữ người mua, được miễn DEPLOYED).
    if (d.currentCustomerId != null) {
      if (!CUSTOMER_HELD_DEVICE_STATUSES.has(d.status)) violations.push(`[I8] ${who} có currentCustomerId=${d.currentCustomerId} nhưng status∉{DEPLOYED,SOLD}.`);
      if (d.warehouseId != null) violations.push(`[I8] ${who} có currentCustomerId=${d.currentCustomerId} nhưng còn warehouseId=${d.warehouseId} (khách giữ máy thì máy không ở kho).`);
    }
  }

  return violations;
}
