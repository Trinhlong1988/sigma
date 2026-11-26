// YÊU CẦU HOÀN TIỀN (YC) — GỘP NHIỀU LÔ THÀNH 1 LỆNH CHUYỂN (Admin Demo 17/9).
//
// "làm thế nào để quản lý nhiều lô gộp để xác nhận đã đối soát và hoàn tiền? … chọn lô 2 3 4 5 của nhiều máy khác
//  nhau tổng tiền 100tr thì đó là 1 YC … mã YC này trùng với YC trong gen QR VietQR (vd YC001), được lưu để quản lý
//  bill CK, xác nhận thanh toán".
//
// VÌ SAO CẦN: trước đây hoàn theo từng lô rời, nội dung CK chỉ có tên đại lý ⇒ chuyển 1 lệnh gộp xong thì không
// truy được lệnh đó trả cho những lô nào; bill CK về phải dò tay theo số tiền. Nay 1 YC = 1 mã + 1 số tiền + danh
// sách lô CỐ ĐỊNH, mã YC đi thẳng vào nội dung chuyển khoản nên bill CK về khớp được bằng MÃ chứ không phải đoán.
//
// BẤT BIẾN GIỮ TIỀN: mỗi lô chỉ nằm trong ĐÚNG 1 YC còn sống (bảng refund_request_lot khoá theo lot_id) → không thể
// gộp một lô vào 2 yêu cầu rồi trả tiền hai lần.
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

export interface RefundRequestDto {
  id: number;
  code: string;
  dealerKey: string;
  dealerLabel: string | null;
  nguon: 'DL' | 'QR';
  amount: number;
  lotIds: number[];
  bankCode: string | null;
  accountNo: string | null;
  accountName: string | null;
  status: 'MOI' | 'DA_CHUYEN';
  paidAtIso: string | null;
  paidRef: string | null;
  createdAtIso: string;
}

/** Làm tròn XUỐNG nghìn — cùng luật với tiền hoàn QR (Admin Demo: "tròn tiền, <1000đ làm tròn xuống"). */
export function lamTronNghinXuong(n: number): number {
  // [Admin Demo 17/9 "làm tròn dưới 1k · công thức phải đúng tránh thừa thiếu"] Math.round TRƯỚC khi floor là SAI:
  // 1999.9 → round 2000 → floor 2000 ⇒ TRÒN LÊN ⇒ hoàn THỪA, và lệch với bản ở routes/digistore (ra 1000).
  // Test lam-tron-nghin-xuong khoá: 2 bản phải ra Y HỆT, và số ra LUÔN ≤ số vào.
  return Math.floor(Math.max(0, n) / 1000) * 1000;
}

/** Mã YC kế tiếp: YC + số tăng dần TOÀN CỤC, tối thiểu 3 chữ số (YC001 → YC010 → YC1234).
 *  Đọc mã lớn nhất đang có rồi +1 — gọi TRONG transaction đã khoá để 2 người bấm cùng lúc không ra trùng mã. */
export async function maYcKeTiep(db: Db): Promise<string> {
  const r = await db.$queryRawUnsafe<{ so: number | null }[]>(
    `SELECT max((regexp_replace(code, '\\D', '', 'g'))::bigint)::int AS so FROM refund_request WHERE code ~ '^YC[0-9]+$'`
  );
  const tiep = (r[0]?.so ?? 0) + 1;
  return `YC${String(tiep).padStart(3, '0')}`;
}

export type TaoYcResult =
  | { ok: true; data: RefundRequestDto }
  | { ok: false; error: 'NO_LOT' | 'LOT_DA_CO_YC' | 'LOT_CHUA_DOI_SOAT' | 'AMOUNT'; message: string; lotIds?: number[] };

/** Tạo 1 YC gộp từ danh sách lô. amount = Σ tiền hoàn sau phí của các lô (caller tính từ đúng nguồn doanh số,
 *  service KHÔNG tự tính lại để không đẻ ra con số thứ hai lệch với bảng đang hiển thị). */
export async function taoYeuCauHoan(
  db: Db,
  input: {
    dealerKey: string; dealerLabel?: string | null; nguon?: 'DL' | 'QR';
    lotIds: number[]; amount: number;
    bankCode?: string | null; accountNo?: string | null; accountName?: string | null;
    byAgent?: number | null;
  }
): Promise<TaoYcResult> {
  const lotIds = [...new Set((input.lotIds ?? []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))];
  if (lotIds.length === 0) return { ok: false, error: 'NO_LOT', message: 'Chưa chọn lô nào để gộp vào yêu cầu hoàn.' };
  const amount = lamTronNghinXuong(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'AMOUNT', message: 'Số tiền hoàn phải > 0.' };

  // [PHẢN BIỆN 21/9 — C1+H1+L8 CONFIRMED, fix trọn] Trước đây cả chuỗi check→sinh-mã→INSERT cha→LOOP INSERT con
  // chạy RỜI RẠC không khoá: (a) 2 người tick chồng lô → cả 2 qua check, người sau nổ PK giữa LOOP → row cha
  // MỒ CÔI ở lại (không rollback) mang amount gồm lô của người kia ⇒ đường trả 1 lô 2 LẦN; (b) 2 request đồng
  // thời trùng mã YC; (c) gộp được cả lô CHƯA ĐỐI SOÁT (gate 2 bước chỉ có ở client). Nay: 1 transaction +
  // advisory xact lock serialize toàn bộ, lô chưa đối soát bị chặn fail-closed như markLotRefundDone.
  type TaoRa = { code: string; id: number; createdAt: Date };
  let ra: TaoRa;
  try {
    ra = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(910000003)`); // serialize mọi lần tạo YC
      const daCo = await tx.$queryRawUnsafe<{ lot_id: string; code: string }[]>(
        `SELECT l.lot_id::text, r.code FROM refund_request_lot l JOIN refund_request r ON r.id = l.request_id
          WHERE l.lot_id = ANY($1::bigint[])`, lotIds);
      if (daCo.length > 0) {
        const ds = daCo.map((x) => `lô #${x.lot_id} → ${x.code}`).join(', ');
        throw Object.assign(new Error(`Có lô ĐÃ nằm trong yêu cầu hoàn khác (${ds}). Bỏ lô đó ra hoặc huỷ yêu cầu cũ trước.`), { ycErr: 'LOT_DA_CO_YC', lotIds: daCo.map((x) => Number(x.lot_id)) });
      }
      const chuaDs = await tx.$queryRawUnsafe<{ lot_id: string }[]>(
        `SELECT x.lot_id::text FROM unnest($1::bigint[]) AS x(lot_id)
          LEFT JOIN pos_lot_recon r ON r.lot_id = x.lot_id WHERE COALESCE(r.ds, false) = false`, lotIds);
      if (chuaDs.length > 0) {
        throw Object.assign(new Error(`${chuaDs.length} lô CHƯA xác nhận đối soát (#${chuaDs.map((x) => x.lot_id).join(', #')}) — xác nhận đối soát trước rồi mới gộp yêu cầu hoàn.`), { ycErr: 'LOT_CHUA_DOI_SOAT' });
      }
      const rMax = await tx.$queryRawUnsafe<{ so: number | null }[]>(
        `SELECT max((regexp_replace(code, '\\D', '', 'g'))::bigint)::int AS so FROM refund_request WHERE code ~ '^YC[0-9]+$'`); // [21/9] \D — backtick nuốt \D thành 'D' trần → cast 'YC001' nổ 22P02 khi bảng có YC
      const code = `YC${String((rMax[0]?.so ?? 0) + 1).padStart(3, '0')}`;
      const ins = await tx.$queryRawUnsafe<{ id: number; created_at: Date }[]>(
        `INSERT INTO refund_request (code, dealer_key, dealer_label, nguon, amount, lot_ids, bank_code, account_no, account_name, by_agent)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) RETURNING id, created_at`,
        code, input.dealerKey, input.dealerLabel ?? null, input.nguon ?? 'DL', amount, JSON.stringify(lotIds),
        input.bankCode ?? null, input.accountNo ?? null, input.accountName ?? null, input.byAgent ?? null);
      const id = ins[0]!.id;
      for (const lot of lotIds) {
        await tx.$executeRawUnsafe(`INSERT INTO refund_request_lot (lot_id, request_id) VALUES ($1,$2)`, lot, id);
      }
      return { code, id, createdAt: ins[0]!.created_at };
    });
  } catch (e) {
    const err = e as Error & { ycErr?: string; lotIds?: number[] };
    if (err.ycErr === 'LOT_DA_CO_YC') return { ok: false, error: 'LOT_DA_CO_YC', message: err.message, lotIds: err.lotIds };
    if (err.ycErr === 'LOT_CHUA_DOI_SOAT') return { ok: false, error: 'LOT_CHUA_DOI_SOAT', message: err.message };
    throw e;
  }
  const { code, id } = ra;
  console.error(`[YC] TẠO ${code}: ${input.dealerLabel ?? input.dealerKey} · ${amount.toLocaleString('vi-VN')}đ · ${lotIds.length} lô [${lotIds.join(',')}]`);
  return {
    ok: true,
    data: {
      id, code, dealerKey: input.dealerKey, dealerLabel: input.dealerLabel ?? null, nguon: input.nguon ?? 'DL',
      amount, lotIds, bankCode: input.bankCode ?? null, accountNo: input.accountNo ?? null,
      accountName: input.accountName ?? null, status: 'MOI', paidAtIso: null, paidRef: null,
      createdAtIso: new Date(ra.createdAt).toISOString()
    }
  };
}

/** Đánh dấu YC ĐÃ CHUYỂN TIỀN (+ mã GD của bill CK nếu có). Đồng thời set refund_done cho mọi lô trong YC —
 *  1 thao tác cho cả nhóm, đúng tinh thần "gộp để xác nhận đã đối soát và hoàn tiền". */
export async function danhDauYcDaChuyen(
  db: Db, code: string, opts: { paidRef?: string | null; byAgent?: number | null } = {}
): Promise<{ ok: true; lotIds: number[]; amount: number } | { ok: false; error: string; message: string }> {
  const rows = await db.$queryRawUnsafe<{ id: number; amount: bigint; status: string }[]>(
    `SELECT id, amount, status FROM refund_request WHERE code = $1`, code);
  const yc = rows[0];
  if (!yc) return { ok: false, error: 'NOT_FOUND', message: `Không tìm thấy yêu cầu hoàn ${code}.` };
  // [PHẢN BIỆN 21/9 — C1/H2 CONFIRMED] (1) Lô lấy từ BẢNG KHOÁ refund_request_lot (bất biến mỗi-lô-1-YC nằm ở
  // PK bảng này) — KHÔNG tin cột jsonb lot_ids (row mồ côi từ lỗi cũ có thể mang lô của YC khác ⇒ trả 2 lần).
  // (2) Idempotent: chỉ chuyển MOI→DA_CHUYEN; bấm lại/gọi lại KHÔNG ghi đè paid_at/paid_ref (mất dấu vết tiền).
  const lotRows = await db.$queryRawUnsafe<{ lot_id: string }[]>(
    `SELECT lot_id::text FROM refund_request_lot WHERE request_id = $1`, yc.id);
  const lotIds: number[] = lotRows.map((r) => Number(r.lot_id));
  const nUpd = await db.$executeRawUnsafe(
    `UPDATE refund_request SET status='DA_CHUYEN', paid_at=now(), paid_ref=$2, by_agent=COALESCE($3, by_agent), updated_at=now() WHERE id=$1 AND status='MOI'`,
    yc.id, opts.paidRef ?? null, opts.byAgent ?? null);
  if (nUpd === 0) return { ok: false, error: 'DA_CHUYEN', message: `${code} ĐÃ đánh dấu chuyển tiền trước đó — không ghi đè dấu vết (paid_at/paid_ref giữ nguyên).` };
  for (const lot of lotIds) {
    await db.$executeRawUnsafe(
      `INSERT INTO pos_lot_recon (lot_id, ds, refund_done, refunded_at, by_agent, updated_at)
       VALUES ($1, true, true, now(), $2, now())
       ON CONFLICT (lot_id) DO UPDATE SET ds = true, refund_done = true, refunded_at = now(), updated_at = now()`,
      lot, opts.byAgent ?? null);
  }
  console.error(`[YC] ĐÃ CHUYỂN ${code}: ${Number(yc.amount).toLocaleString('vi-VN')}đ · ${lotIds.length} lô → đánh dấu đã hoàn.`);
  return { ok: true, lotIds, amount: Number(yc.amount) };
}

/** Huỷ 1 YC (tạo nhầm) — nhả các lô ra để gộp lại. CHẶN nếu đã chuyển tiền (phải sửa bằng tay, không xoá dấu vết). */
export async function huyYeuCauHoan(db: Db, code: string): Promise<{ ok: boolean; error?: string; message?: string }> {
  const rows = await db.$queryRawUnsafe<{ id: number; status: string }[]>(`SELECT id, status FROM refund_request WHERE code = $1`, code);
  const yc = rows[0];
  if (!yc) return { ok: false, error: 'NOT_FOUND', message: `Không tìm thấy yêu cầu hoàn ${code}.` };
  if (yc.status === 'DA_CHUYEN') return { ok: false, error: 'DA_CHUYEN', message: `${code} đã đánh dấu CHUYỂN TIỀN — không huỷ được (giữ dấu vết tiền).` };
  await db.$executeRawUnsafe(`DELETE FROM refund_request WHERE id = $1`, yc.id); // lot rơi theo ON DELETE CASCADE
  console.error(`[YC] HUỶ ${code} — đã nhả lô về trạng thái chưa gộp.`);
  return { ok: true };
}

/** Tra YC theo danh sách lô — để BẢNG DOANH SỐ hiện cột "Mã YC" cạnh tiền hoàn sau phí. */
export async function trayYcTheoLo(db: Db, lotIds: number[]): Promise<Map<number, { code: string; status: string; amount: number }>> {
  const ids = [...new Set(lotIds.map(Number).filter((x) => Number.isInteger(x) && x > 0))];
  const out = new Map<number, { code: string; status: string; amount: number }>();
  if (ids.length === 0) return out;
  const rows = await db.$queryRawUnsafe<{ lot_id: string; code: string; status: string; amount: bigint }[]>(
    `SELECT l.lot_id::text, r.code, r.status, r.amount FROM refund_request_lot l JOIN refund_request r ON r.id = l.request_id
      WHERE l.lot_id = ANY($1::bigint[])`, ids);
  for (const x of rows) out.set(Number(x.lot_id), { code: x.code, status: x.status, amount: Number(x.amount) });
  return out;
}
