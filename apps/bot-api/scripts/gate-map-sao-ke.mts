// CỔNG (chỉ ĐỌC, DB thật) — "tiền sao kê CẤM chạy nhầm nhà".
// Admin Demo 30/9: bill Nhan Vien Demo chuyển KT Demo (ĐL TA hoàn ứng) bị ghi sang nhà khác. Gốc: map "học từ bill hoàn
// OCR" nuốt cả khoá KHÔNG được phép làm khoá đại lý. Cổng này đếm ĐỘNG và CHẶN nếu còn GD nào khớp bằng:
//   [RÁC]   "số tài khoản" không phải chuỗi số (mã QR MB kiểu VQRQAIUIF6322, chuỗi OCR hỏng…)
//   [SIGMA] số TK của CHÍNH SigMa (TK đã nạp sao kê) hoặc TÊN người nhà SigMa
//   [MƠ HỒ] một khoá học được ở >1 PHÒNG đại lý ⇒ không thể biết của ai
//   [TREO]  dòng loại trung tính (Chuyển giữa TK / lãi / dồn vốn / khác / chưa khớp) mà VẪN treo tên đại lý–NĐT
// Khoá KHAI TAY trong statement_dealer_alias được MIỄN (người khai chịu trách nhiệm, vd Nhân viên E = ĐL Đại lý C).
// Thoát: 0 = sạch · 2 = còn vi phạm (CẤM ship) · 3 = không chạy được kiểm tra (fail-closed, cấm nuốt lỗi R198).
import { createPrisma } from '@sigma/database';
import { loadCachedReconciled, normKey } from '../src/statement-recon.js';

const normAcct = (s: string | null | undefined): string => (s ?? '').replace(/[^0-9A-Za-z]/g, '');
const TEN_NGUOI_NHA_ALPHA = new Set(['KETOANDEMO', 'NGUOIDUNGDEMO', 'NGUOIDUNGDEMO', 'KHACHDEMOB', 'KHACHDEMOC']);
const LOAI_TRUNG_TINH = new Set(['TRANSFER', 'INTEREST', 'CAPITAL', 'OTHER', 'UNKNOWN']);

type ViPham = { ly_do: string; ngay: string; tien: string; loai: string; gan_cho: string; doi_ung: string; noi_dung: string };

async function main(): Promise<number> {
  const db = createPrisma();
  try {
    // 1) Khoá KHAI TAY được miễn
    const mienTen = new Set<string>(); const mienTk = new Set<string>();
    const alias = await db.$queryRawUnsafe<Array<{ key: string; key_kind: string }>>('SELECT key, key_kind FROM statement_dealer_alias');
    for (const a of alias) { if (a.key_kind === 'acct') mienTk.add(normAcct(a.key)); else if (a.key_kind === 'name') mienTen.add(normKey(a.key)); }

    // 2) TK của CHÍNH SigMa = mọi tài khoản đã nạp sao kê
    const srcs = await db.$queryRawUnsafe<Array<{ src_account: string | null }>>('SELECT DISTINCT src_account FROM statement_txn');
    const tkAlpha = new Set(srcs.map((r) => normAcct(r.src_account)).filter(Boolean));

    // 3) Dựng lại map học-từ-bill để biết khoá nào RÁC / MƠ HỒ (một khoá dính nhiều phòng)
    const msgs = await db.$queryRawUnsafe<Array<{ room_id: string; metadata_json: string | null }>>(
      `SELECT room_id, metadata_json FROM chat_messages WHERE kind='IMAGE' AND deleted_at IS NULL AND metadata_json LIKE '%"isDealerRefundCk":true%'`);
    const roomIds = [...new Set(msgs.map((m) => m.room_id))];
    const ccg = await db.$queryRawUnsafe<Array<{ room_id: string; customer_id: number }>>(
      'SELECT room_id, customer_id FROM customer_chat_groups WHERE room_id = ANY($1::text[]) AND unassigned_at IS NULL', roomIds);
    const roomCust = new Map(ccg.map((g) => [g.room_id, g.customer_id]));
    const nhaCuaKhoaTk = new Map<string, Set<number>>(); const nhaCuaKhoaTen = new Map<string, Set<number>>();
    for (const m of msgs) {
      if (!m.metadata_json) continue;
      let p: { receiverAcct?: string | null; receiverName?: string | null };
      try { p = JSON.parse(m.metadata_json); } catch { continue; }
      const cid = roomCust.get(m.room_id); if (cid == null) continue;
      const a = normAcct(p.receiverAcct); if (a) { if (!nhaCuaKhoaTk.has(a)) nhaCuaKhoaTk.set(a, new Set()); nhaCuaKhoaTk.get(a)!.add(cid); }
      const n = normKey(p.receiverName); if (n) { if (!nhaCuaKhoaTen.has(n)) nhaCuaKhoaTen.set(n, new Set()); nhaCuaKhoaTen.get(n)!.add(cid); }
    }
    const laTkHopLe = (a: string): boolean => /^[0-9]{4,}$/.test(a);
    const lyDoKhoaTk = (a: string): string | null => {
      if (!a || mienTk.has(a)) return null;
      if (!laTkHopLe(a)) return 'RÁC (không phải số tài khoản)';
      if (tkAlpha.has(a)) return 'TK CỦA CHÍNH SIGMA';
      if ((nhaCuaKhoaTk.get(a)?.size ?? 0) > 1) return `MƠ HỒ (học ở ${nhaCuaKhoaTk.get(a)!.size} phòng)`;
      return null;
    };
    const lyDoKhoaTen = (n: string): string | null => {
      if (!n || mienTen.has(n)) return null;
      if (TEN_NGUOI_NHA_ALPHA.has(n)) return 'TÊN NGƯỜI NHÀ SIGMA';
      if ((nhaCuaKhoaTen.get(n)?.size ?? 0) > 1) return `MƠ HỒ (học ở ${nhaCuaKhoaTen.get(n)!.size} phòng)`;
      return null;
    };

    // 3b) Bảng khoá HỢP LỆ → nhà (chỉ khoá không dính lý do loại nào) + khoá KHAI TAY
    const nhaHopLeTk = new Map<string, number>(); const nhaHopLeTen = new Map<string, number>();
    for (const [k, v] of nhaCuaKhoaTk) if (!lyDoKhoaTk(k) && v.size === 1) nhaHopLeTk.set(k, [...v][0]);
    for (const [k, v] of nhaCuaKhoaTen) if (!lyDoKhoaTen(k) && v.size === 1) nhaHopLeTen.set(k, [...v][0]);
    const aliasDay = await db.$queryRawUnsafe<Array<{ key: string; key_kind: string; customer_id: number | null }>>(
      'SELECT key, key_kind, customer_id FROM statement_dealer_alias');
    for (const a of aliasDay) {
      if (a.customer_id == null) continue;
      if (a.key_kind === 'acct') nhaHopLeTk.set(normAcct(a.key), a.customer_id);
      else if (a.key_kind === 'name') nhaHopLeTen.set(normKey(a.key), a.customer_id);
    }

    // 4) Soi TỪNG giao dịch đã phân loại
    const { txns } = await loadCachedReconciled(db as never);
    if (!txns.length) { console.error('[GATE] KHÔNG đọc được giao dịch sao kê nào — chưa kết luận được'); return 3; }
    const viPham: ViPham[] = [];
    let mienVisuaTay = 0;   // số dòng miễn vì NGƯỜI sửa tay gán nhà
    const mo = (t: typeof txns[number]): Omit<ViPham, 'ly_do'> => ({
      ngay: String(t.dateTime ?? '?').slice(0, 16).replace('T', ' '),
      tien: (Number(t.debit) + Number(t.credit)).toLocaleString('vi-VN'),
      loai: String(t.kind), gan_cho: t.matchedName ?? '-',
      doi_ung: `${t.cpName ?? '-'} / ${t.cpAccount ?? '-'}`, noi_dung: t.descName ?? '-'
    });
    for (const t of txns) {
      const coGan = t.matchedCustomerId != null || t.matchedInvestorId != null;
      if (coGan && LOAI_TRUNG_TINH.has(String(t.kind))) { viPham.push({ ly_do: 'TREO tên đại lý/NĐT trên dòng loại trung tính', ...mo(t) }); continue; }
      if (t.matchedCustomerId == null) continue;
      // Dòng NGƯỜI SỬA TAY (chọn thẳng đại lý trong modal Sửa) = quyết định của con người, không phải máy đoán ⇒
      // miễn kiểm "khoá đỡ" (vẫn bị kiểm TREO ở trên). Đếm ĐỘNG để không giấu con số này.
      if (t.edited) { mienVisuaTay++; continue; }
      // KIỂM ĐỘC LẬP (không đoán code khớp bằng gì): nhà được gán PHẢI được ít nhất MỘT khoá HỢP LỆ nằm ngay trên
      // dòng đó đỡ (số TK đối ứng hợp lệ · tên đối ứng hợp lệ · tên người gửi trong nội dung · khoá khai tay).
      // Không khoá hợp lệ nào trỏ về nhà đó ⇒ nhà này đến từ khoá rác/mơ hồ/của chính SigMa ⇒ VI PHẠM.
      const khoaDoDuoc: string[] = [];
      const a = normAcct(t.cpAccount);
      if (a && !lyDoKhoaTk(a) && nhaHopLeTk.get(a) === t.matchedCustomerId) khoaDoDuoc.push(`TK ${a}`);
      for (const ten of [t.cpName, t.descName]) {
        const n = normKey(ten);
        if (n && !lyDoKhoaTen(n) && nhaHopLeTen.get(n) === t.matchedCustomerId) khoaDoDuoc.push(`tên ${n}`);
      }
      if (!khoaDoDuoc.length) viPham.push({ ly_do: 'nhà được gán KHÔNG có khoá hợp lệ nào trên dòng đỡ', ...mo(t) });
    }

    console.log(`[GATE map sao kê] soi ${txns.length} GD · khoá TK học được ${nhaCuaKhoaTk.size} · khoá TÊN học được ${nhaCuaKhoaTen.size} · miễn (khai tay) ${mienTk.size + mienTen.size}`);
    console.log(`[GATE map sao kê] khoá TK bị loại: ${[...nhaCuaKhoaTk.keys()].filter((a) => lyDoKhoaTk(a)).length} · khoá TÊN bị loại: ${[...nhaCuaKhoaTen.keys()].filter((n) => lyDoKhoaTen(n)).length} · miễn vì NGƯỜI sửa tay: ${mienVisuaTay} GD`);
    if (viPham.length) {
      console.error(`\n✗ CÒN ${viPham.length} GIAO DỊCH gán nhà bằng khoá KHÔNG ĐƯỢC PHÉP:`);
      for (const v of viPham) console.error(`  · ${v.ngay} · ${v.tien.padStart(15)}đ · ${v.loai.padEnd(16)} → ${v.gan_cho.padEnd(14)} | ${v.ly_do} | đối ứng: ${v.doi_ung} | nội dung: ${v.noi_dung}`);
      console.error('\n⇒ CẤM ship / CẤM chốt số cho tới khi hết vi phạm.');
      return 2;
    }
    console.log('✓ 0 giao dịch gán nhà bằng khoá rác / khoá của chính SigMa / khoá mơ hồ; 0 dòng treo tên sai loại.');
    return 0;
  } catch (e) {
    console.error(`[GATE] KHÔNG chạy được kiểm tra: ${(e as Error)?.message ?? e}`);
    return 3;   // fail-closed
  } finally {
    await (db as unknown as { $disconnect: () => Promise<void> }).$disconnect();
  }
}

process.exit(await main());
