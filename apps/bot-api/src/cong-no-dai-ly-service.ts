// SỔ THEO DÕI TIỀN ĐẠI LÝ ĐANG CẦM (Admin Demo 17/9: "chưa có log hiện thị lô nào, ngày giờ, tên tid, hkd, số tiền
// đại lý cầm chưa đối soát, chờ hoàn tiền — cần log này theo dõi RIÊNG TỪNG ĐẠI LÝ").
//
// Trước đây muốn biết đại lý nào còn cầm bao nhiêu phải mở TỪNG phòng doanh số rồi tự cộng. Sổ này gom 1 chỗ:
// mỗi đại lý 1 khối, liệt kê từng lô chưa xong kèm ngày giờ · TID · HKD · số lô · tiền, và tổng tiền đang cầm.
//
// TRẠNG THÁI (khớp màn Doanh số phòng — cùng bảng pos_lot_recon, không đẻ khái niệm mới):
//   chua    = chưa xác nhận đối soát  → đại lý đang CẦM tiền, SigMa chưa soát
//   choHoan = đã đối soát, CHƯA hoàn  → SigMa nợ đại lý (hoặc ngược lại tuỳ chiều), chờ chuyển
// Lô đã hoàn (refund_done) KHÔNG nằm trong sổ — đã xong thì không phải theo dõi nữa.
//
// GÁN ĐẠI LÝ: đúng luật của doanh số phòng — lô MƯỢN/GHIM (los.borrowed_by_customer_id) thuộc đại lý mượn,
// còn lại thuộc CHỦ TID (tids.customer_id). Sai luật này là tiền hiện nhầm nhà.
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

export interface LoCongNo {
  loId: number;
  note?: string | null; // [21/9] ghi chú per-lô — đồng nhất với bảng lô ĐL/NĐT
  soLo: string;            // số lô ngân hàng (kèm mã đóng lô: "84(95)")
  ngay: string;            // dd/mm/yyyy theo giờ VN
  gio: string;             // HH:mm ('' nếu bill không có giờ)
  tid: string;
  hkdName: string;
  bankName: string;
  truocPhi: number;
  phaiHoan: number;        // sau phí bán = số SigMa phải hoàn đại lý
  trangThai: 'chua' | 'choHoan';
  maYc: string | null;     // đã gộp vào yêu cầu hoàn nào (YC001) — null = chưa gộp
  borrowed: boolean;
}

export interface CongNoDaiLy {
  customerId: number;
  dealerName: string;
  roomId: string | null;   // phòng chat đại lý (để bấm sang màn doanh số)
  soLo: number;
  soLoChua: number;
  soLoChoHoan: number;
  tongTruocPhi: number;
  tongPhaiHoan: number;
  tongChuaDoiSoat: number; // tiền đại lý ĐANG CẦM mà SigMa chưa soát
  tongChoHoan: number;     // đã soát, chờ chuyển
  lots: LoCongNo[];
}

/** Sổ công nợ theo đại lý trong khoảng [from, to). Chỉ lô CHƯA hoàn tiền. */
export async function buildCongNoDaiLy(db: Db, from: Date, to: Date): Promise<{ from: string; to: string; dealers: CongNoDaiLy[]; tongChuaDoiSoat: number; tongChoHoan: number }> {
  const rows = await db.$queryRawUnsafe<{
    lo_id: number; so_lo: string | null; settlement_code: string | null; iso: string;
    tid: string | null; hkd: string | null; bank: string | null;
    truoc: bigint; sau: bigint; customer_id: number | null; dealer_name: string | null;
    room_id: string | null; ds: boolean | null; refund_done: boolean | null; ma_yc: string | null; borrowed: boolean;
  }[]>(
    `SELECT l.id AS lo_id,
            l.bank_reported_lo_number::text AS so_lo,
            l.settlement_code,
            to_char(COALESCE(l.bill_txn_date, l.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD"T"HH24:MI') AS iso,
            td.tid, td.hkd_name AS hkd, b.name AS bank,
            sum(lr.amount_before_fee)::bigint AS truoc,
            sum(lr.amount_after_fee)::bigint AS sau,
            COALESCE(l.borrowed_by_customer_id, td.customer_id) AS customer_id,
            COALESCE(c.nickname, c.full_name) AS dealer_name, -- [21/9] customers KHÔNG có cột name (bug từ 17/9 — màn công nợ chết 500)
            (SELECT g.room_id FROM customer_chat_groups g
              WHERE g.customer_id = COALESCE(l.borrowed_by_customer_id, td.customer_id) AND g.unassigned_at IS NULL
              ORDER BY g.id LIMIT 1) AS room_id,
            r.ds, r.refund_done, r.note, rr.code AS ma_yc,
            (l.borrowed_by_customer_id IS NOT NULL) AS borrowed
       FROM los l
       JOIN lo_rows lr ON lr.lo_id = l.id
       JOIN tids td ON td.id = lr.tid_id
       LEFT JOIN banks b ON b.id = td.bank_id
       LEFT JOIN customers c ON c.id = COALESCE(l.borrowed_by_customer_id, td.customer_id)
       LEFT JOIN pos_lot_recon r ON r.lot_id = l.id
       LEFT JOIN refund_request_lot rl ON rl.lot_id = l.id
       LEFT JOIN refund_request rr ON rr.id = rl.request_id
      WHERE l.status <> 'CANCELLED'
        AND COALESCE(l.bill_txn_date, l.created_at) >= $1::timestamptz
        AND COALESCE(l.bill_txn_date, l.created_at) < $2::timestamptz
        AND COALESCE(r.refund_done, false) = false
      GROUP BY l.id, l.bank_reported_lo_number, l.settlement_code, l.bill_txn_date, l.created_at,
               td.tid, td.hkd_name, b.name, l.borrowed_by_customer_id, td.customer_id, c.nickname, c.full_name, r.ds, r.refund_done, r.note, rr.code
      ORDER BY COALESCE(l.bill_txn_date, l.created_at) DESC`,
    from.toISOString(), to.toISOString()
  );

  // [B-M3 21/9] GOM PER-LÔ thật sự: GROUP BY có td.tid/hkd nên lô hiếm-hoi có lo_rows THUỘC 2 TID sẽ ra 2 dòng
  // cùng lo_id → sổ đếm lô x2 + tách tiền (tổng vẫn đúng nhưng số lô sai, và nếu 2 TID khác CHỦ thì tiền văng 2
  // đại lý). Merge theo lo_id: cộng tiền vào dòng đầu, log rõ (R198) — không nuốt câm.
  {
    const seen = new Map<number, (typeof rows)[number]>();
    const merged: typeof rows = [];
    for (const x of rows) {
      const prev = seen.get(x.lo_id);
      if (!prev) { seen.set(x.lo_id, x); merged.push(x); continue; }
      prev.truoc = BigInt(prev.truoc) + BigInt(x.truoc) as never;
      prev.sau = BigInt(prev.sau) + BigInt(x.sau) as never;
      console.error(`[cong-no] lô ${x.lo_id} có lo_rows thuộc ≥2 TID (${prev.tid} + ${x.tid}) — gom về TID đầu, kiểm dữ liệu lô này.`);
    }
    rows.length = 0; rows.push(...merged);
  }
  const theoDaiLy = new Map<number, CongNoDaiLy>();
  for (const x of rows) {
    const cid = x.customer_id ?? 0;
    const lo: LoCongNo = {
      loId: x.lo_id,
      note: (x as Record<string, unknown>).note as string | null ?? null,
      soLo: ((): string => {
        const g = (x.so_lo ?? '').trim() || `#${x.lo_id}`;
        const sc = String(x.settlement_code ?? '').replace(/[^0-9]/g, '');
        return sc && !g.includes('(') ? `${g}(${sc})` : g; // lô đóng 95 → "84(95)" (Admin Demo 16/9)
      })(),
      ngay: ((): string => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(x.iso); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; })(),
      gio: ((): string => { const m = /T(\d{2}:\d{2})/.exec(x.iso); return m ? m[1] : ''; })(),
      tid: x.tid ?? '',
      hkdName: x.hkd ?? '',
      bankName: x.bank ?? '',
      truocPhi: Number(x.truoc),
      phaiHoan: Number(x.sau),
      trangThai: x.ds === true ? 'choHoan' : 'chua',
      maYc: x.ma_yc ?? null,
      borrowed: x.borrowed === true
    };
    const cur = theoDaiLy.get(cid) ?? {
      customerId: cid, dealerName: x.dealer_name ?? '(chưa gán đại lý)', roomId: x.room_id ?? null,
      soLo: 0, soLoChua: 0, soLoChoHoan: 0, tongTruocPhi: 0, tongPhaiHoan: 0, tongChuaDoiSoat: 0, tongChoHoan: 0, lots: []
    };
    cur.lots.push(lo);
    cur.soLo++;
    cur.tongTruocPhi += lo.truocPhi;
    cur.tongPhaiHoan += lo.phaiHoan;
    if (lo.trangThai === 'chua') { cur.soLoChua++; cur.tongChuaDoiSoat += lo.phaiHoan; }
    else { cur.soLoChoHoan++; cur.tongChoHoan += lo.phaiHoan; }
    theoDaiLy.set(cid, cur);
  }
  // Nhà nào đang cầm/chờ NHIỀU TIỀN nhất lên đầu — mắt nhìn vào là thấy chỗ cần xử trước.
  const dealers = [...theoDaiLy.values()].sort((a, b) => (b.tongChuaDoiSoat + b.tongChoHoan) - (a.tongChuaDoiSoat + a.tongChoHoan));
  return {
    from: from.toISOString(), to: to.toISOString(), dealers,
    tongChuaDoiSoat: dealers.reduce((s, d) => s + d.tongChuaDoiSoat, 0),
    tongChoHoan: dealers.reduce((s, d) => s + d.tongChoHoan, 0)
  };
}
