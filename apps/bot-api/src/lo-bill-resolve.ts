// [Admin Demo 7/9] RESOLVE lô → TIN-BILL gốc (để nút "Sửa" ở báo cáo mở sửa full tham số như review). CHỈ ĐỌC — không
// đụng tiền. Hàng báo cáo chỉ có loId; editBillParams cần messageId → map qua billKey (tid+lô) sang tin bill của
// SupportAlpha trong phòng. Trả messageId + giá trị HIỆN TẠI (để prefill modal). Chọn tin GỐC đại lý (không phải
// mirror NĐT — editBillParams tự cascade sang mirror). Nhiều tin cùng tid+lô (gửi lại) → lấy MỚI NHẤT (card hiện tại).
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

export interface LoEditSource {
  messageId: string;
  current: { amount: number | null; lo: string | null; tid: string | null; dateTime: string | null; hkdName: string | null; bank: string | null };
}

/** Rút [tid, lô] từ billKey `nat|tid|lô|...` / `VL|tid|lô|...`. null nếu không phải billKey đánh-lô. */
function tidLoFromBillKey(billKey: string | null): { tid: string; lo: string } | null {
  if (!billKey) return null;
  const p = String(billKey).split('|');
  if (p.length < 3) return null;
  const tid = (p[1] ?? '').trim();
  const lo = (p[2] ?? '').trim();
  if (!tid || !lo || lo === '?' || lo.startsWith('amt:') || !/^\d+$/.test(lo)) return null;
  return { tid, lo };
}

/** Resolve loId → tin bill gốc đại lý + giá trị hiện tại. ok:false nếu không tìm được (không có billKey lô / không
 *  tìm được tin khớp — UI báo "không mở sửa được, kiểm tay"). KHÔNG đoán bừa (cấm suy luận tiền). */
export async function resolveLoEditSource(db: Db, loId: number): Promise<{ ok: true; data: LoEditSource } | { ok: false; error: 'NO_BILLKEY' | 'MSG_NOT_FOUND' }> {
  const lo = await db.lo.findUnique({ where: { id: loId }, select: { billKey: true } });
  const tl = tidLoFromBillKey(lo?.billKey ?? null);
  if (!tl) return { ok: false, error: 'NO_BILLKEY' };
  // Tìm tin bill POS có posBill.tid==tid & posBill.lo==lô (metadata chứa cả 2 chuỗi). Lọc kỹ ở JS (tránh khớp lỏng).
  const cands = await db.chatMessage.findMany({
    where: {
      deletedAt: null,
      metadataJson: { contains: `"tid":"${tl.tid}"` },
      AND: [{ metadataJson: { contains: `"lo":"${tl.lo}"` } }, { metadataJson: { contains: '"isBillImage":true' } }]
    },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: { id: true, metadataJson: true }
  });
  for (const m of cands) {
    let meta: { posBill?: { tid?: unknown; lo?: unknown; amount?: unknown; dateTime?: unknown; hkd?: unknown; bank?: unknown }; alphaCrossPostSourceId?: unknown } = {};
    try { meta = JSON.parse(m.metadataJson ?? '{}'); } catch { continue; }
    const pb = meta.posBill;
    if (!pb) continue;
    // Khớp CHÍNH XÁC tid+lô (không chỉ contains). Ưu tiên tin GỐC (không có alphaCrossPostSourceId = tin đại lý, không phải mirror NĐT).
    if (String(pb.tid ?? '') !== tl.tid || String(pb.lo ?? '') !== tl.lo) continue;
    if (meta.alphaCrossPostSourceId) continue; // bỏ mirror NĐT — sửa từ tin gốc để cascade đúng
    return {
      ok: true,
      data: {
        messageId: String(m.id),
        current: {
          amount: typeof pb.amount === 'number' ? pb.amount : (pb.amount != null ? Number(pb.amount) || null : null),
          lo: pb.lo != null ? String(pb.lo) : null,
          tid: pb.tid != null ? String(pb.tid) : null,
          dateTime: pb.dateTime != null ? String(pb.dateTime) : null,
          hkdName: pb.hkd != null ? String(pb.hkd) : null,
          bank: pb.bank != null ? String(pb.bank) : null
        }
      }
    };
  }
  return { ok: false, error: 'MSG_NOT_FOUND' };
}
