// [Admin Demo 23/9] YÊU CẦU HOÀN TIỀN TỪ NĐT (YCHT) — mỗi lần bấm "YC NĐT hoàn" ở màn Báo cáo QR = 1 YCHT mới:
// mã YCHT001… đi vào NỘI DUNG CK trên VietQR + TÊN FILE ảnh gửi NĐT → tiền về đối chiếu đúng đợt.
//
// KHOÁ GIỮ TIỀN (bê nguyên bài học vụ YC đại lý C1/H1 21/9 — cấm tái diễn):
//   · TOÀN BỘ check → sinh mã → INSERT cha → INSERT con nằm trong MỘT $transaction + pg_advisory_xact_lock:
//     2 người bấm cùng lúc thì đúng 1 người thắng, KHÔNG đẻ row cha mồ côi mang bill của người kia.
//   · Bảng con khoá (request_id, bill_id): 1 GD KHÔNG lặp trong cùng 1 YCHT. [Admin Demo 23/9 CHỐT] GD nằm ở YCHT
//     CŨ thì VẪN CHO TẠO yêu cầu mới (không chặn) — chỉ CẢNH BÁO trên màn + log, để anh tự quyết.
//   · Regex SQL trong template literal phải `\\D` (backtick nuốt 1 lớp \ — đúng cú suýt nổ prod 21/9).
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

export interface YchtDto {
  id: number; code: string; amount: number; billIds: string[];
  bankCode: string | null; accountNo: string | null; accountName: string | null;
  status: string; createdAtIso: string;
  /** [Admin Demo 23/9] GD đang nằm trong YCHT CŨ — CẢNH BÁO thôi, KHÔNG chặn tạo (anh chốt "trùng vẫn cho tạo"). */
  trungYchtCu?: Array<{ billId: string; code: string }>;
}
export type TaoYchtResult =
  | { ok: true; data: YchtDto }
  | { ok: false; error: 'NO_BILL' | 'AMOUNT'; message: string };

/** LÀM TRÒN XUỐNG NGHÌN — cùng luật với hoàn đại lý (Admin Demo 16/9: bỏ phần lẻ dưới 1.000đ). */
export function lamTronNghinXuongNdt(n: number): number {
  const x = Math.floor(Number(n) || 0);
  return x <= 0 ? 0 : Math.floor(x / 1000) * 1000;
}

export async function taoYeuCauHoanNdt(
  db: Db,
  input: { billIds: string[]; amount: number; bankCode?: string | null; accountNo?: string | null; accountName?: string | null; byAgent?: number | null }
): Promise<TaoYchtResult> {
  const billIds = [...new Set((input.billIds ?? []).map((x) => String(x).trim()).filter(Boolean))];
  if (billIds.length === 0) return { ok: false, error: 'NO_BILL', message: 'Chưa chọn giao dịch nào để tạo yêu cầu hoàn NĐT.' };
  const amount = lamTronNghinXuongNdt(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'AMOUNT', message: 'Số tiền NĐT hoàn phải > 0 (các bill đã chọn chưa có giá mua?).' };

  type Ra = { code: string; id: number; createdAt: Date; trungCu: Array<{ billId: string; code: string }> };
  let ra: Ra;
  try {
    ra = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(910000004)`); // serialize mọi lần tạo YCHT
      // [Admin Demo 23/9] GD đã nằm YCHT cũ: CHỈ ghi nhận để cảnh báo — KHÔNG chặn tạo (lệnh: "trùng rồi vẫn cho tạo YC").
      const daCo = await tx.$queryRawUnsafe<{ bill_id: string; code: string }[]>(
        `SELECT b.bill_id, r.code FROM ndt_refund_request_bill b JOIN ndt_refund_request r ON r.id = b.request_id
          WHERE b.bill_id = ANY($1::text[])`, billIds);
      if (daCo.length > 0) console.error(`[YCHT] ${daCo.length} GD đã nằm YCHT cũ (${daCo.map((x) => `${x.bill_id}→${x.code}`).join(', ')}) — VẪN TẠO theo lệnh Admin Demo 23/9, có cảnh báo trên màn.`);
      const trungCu = daCo.map((x) => ({ billId: x.bill_id, code: x.code }));
      const rMax = await tx.$queryRawUnsafe<{ so: number | null }[]>(
        `SELECT max((regexp_replace(code, '\\D', '', 'g'))::bigint)::int AS so FROM ndt_refund_request WHERE code ~ '^YCHT[0-9]+$'`);
      const code = `YCHT${String((rMax[0]?.so ?? 0) + 1).padStart(3, '0')}`;
      const ins = await tx.$queryRawUnsafe<{ id: number; created_at: Date }[]>(
        `INSERT INTO ndt_refund_request (code, amount, bill_ids, bank_code, account_no, account_name, by_agent)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7) RETURNING id, created_at`,
        code, amount, JSON.stringify(billIds), input.bankCode ?? null, input.accountNo ?? null, input.accountName ?? null, input.byAgent ?? null);
      const id = ins[0]!.id;
      for (const b of billIds) {
        await tx.$executeRawUnsafe(`INSERT INTO ndt_refund_request_bill (bill_id, request_id) VALUES ($1,$2)`, b, id);
      }
      return { code, id, createdAt: ins[0]!.created_at, trungCu };
    });
  } catch (e) { throw e; }
  console.error(`[YCHT] TẠO ${ra.code}: ${amount.toLocaleString('vi-VN')}đ · ${billIds.length} GD`);
  return {
    ok: true,
    data: {
      id: ra.id, code: ra.code, amount, billIds,
      bankCode: input.bankCode ?? null, accountNo: input.accountNo ?? null, accountName: input.accountName ?? null,
      status: 'MOI', createdAtIso: new Date(ra.createdAt).toISOString(),
      ...(ra.trungCu.length > 0 ? { trungYchtCu: ra.trungCu } : {})
    }
  };
}

/** Danh sách YCHT gần đây (để đối chiếu tiền NĐT chuyển về). */
export async function listYcht(db: Db, limit = 100): Promise<YchtDto[]> {
  const rows = await db.$queryRawUnsafe<Array<{ id: number; code: string; amount: bigint; bill_ids: unknown; bank_code: string | null; account_no: string | null; account_name: string | null; status: string; created_at: Date }>>(
    `SELECT id, code, amount, bill_ids, bank_code, account_no, account_name, status, created_at
       FROM ndt_refund_request ORDER BY id DESC LIMIT $1`, Math.min(500, Math.max(1, limit)));
  return rows.map((r) => ({
    id: Number(r.id), code: r.code, amount: Number(r.amount),
    billIds: Array.isArray(r.bill_ids) ? (r.bill_ids as string[]) : [],
    bankCode: r.bank_code, accountNo: r.account_no, accountName: r.account_name,
    status: r.status, createdAtIso: new Date(r.created_at).toISOString()
  }));
}

/** Đánh dấu NĐT ĐÃ CHUYỂN cho 1 YCHT. Idempotent: chỉ MOI → DA_NHAN, gọi lại KHÔNG ghi đè dấu vết tiền. */
export async function danhDauYchtDaNhan(
  db: Db, code: string, opts: { paidRef?: string | null; byAgent?: number | null } = {}
): Promise<{ ok: true; amount: number } | { ok: false; error: string; message: string }> {
  const rows = await db.$queryRawUnsafe<{ id: number; amount: bigint }[]>(`SELECT id, amount FROM ndt_refund_request WHERE code = $1`, code);
  const yc = rows[0];
  if (!yc) return { ok: false, error: 'NOT_FOUND', message: `Không tìm thấy yêu cầu ${code}.` };
  const n = await db.$executeRawUnsafe(
    `UPDATE ndt_refund_request SET status='DA_NHAN', paid_at=now(), paid_ref=$2, by_agent=COALESCE($3, by_agent), updated_at=now() WHERE id=$1 AND status='MOI'`,
    yc.id, opts.paidRef ?? null, opts.byAgent ?? null);
  if (n === 0) return { ok: false, error: 'DA_NHAN', message: `${code} ĐÃ đánh dấu nhận tiền trước đó — không ghi đè dấu vết.` };
  return { ok: true, amount: Number(yc.amount) };
}

/** Huỷ 1 YCHT tạo nhầm — nhả bill ra để gộp lại. CHẶN nếu đã nhận tiền (giữ dấu vết). */
export async function huyYcht(db: Db, code: string): Promise<{ ok: boolean; error?: string; message?: string }> {
  const rows = await db.$queryRawUnsafe<{ id: number; status: string }[]>(`SELECT id, status FROM ndt_refund_request WHERE code = $1`, code);
  const yc = rows[0];
  if (!yc) return { ok: false, error: 'NOT_FOUND', message: `Không tìm thấy yêu cầu ${code}.` };
  if (yc.status === 'DA_NHAN') return { ok: false, error: 'DA_NHAN', message: `${code} đã nhận tiền — không huỷ được (giữ dấu vết).` };
  await db.$executeRawUnsafe(`DELETE FROM ndt_refund_request WHERE id = $1`, yc.id); // bill rơi theo ON DELETE CASCADE
  console.error(`[YCHT] HUỶ ${code}`);
  return { ok: true };
}
