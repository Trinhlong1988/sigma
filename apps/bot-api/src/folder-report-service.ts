// BÁO CÁO FOLDER SAU KHI QUÉT (Admin Demo 8/9): "quét xong 1 folder phải show bảng báo cáo NHƯ báo cáo lô, đầy đủ
// từng lô lỗi gì, có nút Sửa full như review OCR".
//
// NGUYÊN TẮC: KHÔNG tự tính lại tiền/phí ở đây. Số liệu lấy từ CHÍNH hàm của Báo cáo lô (`getRoomRevenueReport`)
// rồi LỌC ra đúng các lô thuộc folder vừa quét → bảng folder và báo cáo lô KHÔNG THỂ lệch nhau.
// Bill chưa ghi được Lô (đọc hụt / chưa gửi / lỗi) vẫn có 1 dòng, đánh dấu rõ để người duyệt xử — không nuốt.
import type { Db } from '@sigma/database';
import { getRoomRevenueReport } from './services/chat-room-tid-service.js';
import { ensureSupportAlphaAgent } from './zalo-bill-support.js';
import { kiemTraSoLo, kiemTraNgayBill, type DayLoMay } from './lot-sanity.js';

/** 1 bill trong folder vừa quét (client gửi lên — đúng thứ tự quét). */
export interface BillTrongFolder {
  tid: string | null;
  lo: string | null;
  /** Phòng đại lý đã resolve lúc review (có thì khỏi tra lại). */
  roomId?: string | null;
  /** "dd/mm/yyyy HH:mm" OCR đọc — dùng để gate ngày + hiển thị khi chưa có Lô. */
  dateTime?: string | null;
  amount?: number | null;
  /** Đã bấm gửi thành công chưa (client biết). */
  sent?: boolean;
  /** Tên file ảnh (để người duyệt mở đúng ảnh). */
  fileName?: string | null;
  /** Vị trí trong folder (0-based) — để nút "Sửa" mở đúng bill. */
  idx?: number | null;
}

/** 1 dòng bảng báo cáo folder — trùng bộ trường bảng báo cáo lô + phần trạng thái/lỗi. */
export interface DongBaoCaoFolder {
  idx: number | null;
  fileName: string | null;
  hkdName: string;
  bankName: string;
  tid: string;
  lo: string;
  date: string;      // YYYY-MM-DD
  time: string;      // HH:MM
  truoc: number;
  fee: number;
  sau: number;
  /** 'DA_GHI' = đã có Lô (doanh số đã vào) · 'CHUA_GUI' = chưa gửi/chưa ghi · 'DOC_HUT' = OCR không ra TID/lô. */
  trangThai: 'DA_GHI' | 'CHUA_GUI' | 'DOC_HUT';
  /** Cảnh báo của CHÍNH lô này (gate ngày bill, lô nhảy vọt, nghi gán nhầm máy…). Rỗng = sạch. */
  loi: string[];
}

export interface BaoCaoFolder {
  rows: DongBaoCaoFolder[];
  tong: { soBill: number; daGhi: number; chuaGui: number; docHut: number; soLoi: number; tongTruoc: number; tongSau: number };
}

/** Dãy lô 30 ngày của mọi máy cùng họ HKD — nguyên liệu gate (tái dùng hàm đã có trong ocr-send-service). */
async function dayLoTheoTid(db: Db, tid: string, cache: Map<string, DayLoMay[]>, layDay: (db: Db, tid: string) => Promise<DayLoMay[]>): Promise<DayLoMay[]> {
  const co = cache.get(tid);
  if (co) return co;
  const ds = await layDay(db, tid);
  cache.set(tid, ds);
  return ds;
}

/**
 * Dựng bảng báo cáo cho danh sách bill vừa quét.
 * @param layDayLo hàm lấy dãy lô cùng họ (truyền từ ocr-send-service để tránh vòng import)
 */
export async function buildFolderReport(
  db: Db,
  bills: BillTrongFolder[],
  layDayLo: (db: Db, tid: string) => Promise<DayLoMay[]>,
  now: Date = new Date()
): Promise<BaoCaoFolder> {
  const bot = await ensureSupportAlphaAgent(db);

  // Gom phòng cần lấy báo cáo + khoảng ngày bao trọn các bill (mặc định hôm nay nếu bill không có ngày).
  const roomIds = new Set<string>();
  let minMs = Infinity, maxMs = -Infinity;
  for (const b of bills) {
    if (b.roomId) roomIds.add(b.roomId);
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(b.dateTime ?? ''));
    if (m) {
      const t = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
      minMs = Math.min(minMs, t); maxMs = Math.max(maxMs, t);
    }
  }
  const homNay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const from = new Date(Number.isFinite(minMs) ? Math.min(minMs, homNay) : homNay);
  const to = new Date((Number.isFinite(maxMs) ? Math.max(maxMs, homNay) : homNay) + 24 * 3600_000);

  // Lấy báo cáo lô của TỪNG phòng bằng CHÍNH hàm báo cáo lô (số liệu không thể lệch). Lỗi 1 phòng không chặn cả bảng.
  const theoKhoa = new Map<string, { row: NonNullable<Awaited<ReturnType<typeof getRoomRevenueReport>>['rows'][number]>; hkd: string; bank: string }>();
  for (const roomId of roomIds) {
    try {
      const rep = await getRoomRevenueReport(db, bot.id, roomId, { from, to });
      const tenTid = new Map(rep.tids.map((t) => [t.tidId, { hkd: t.hkdName ?? '', bank: t.bankName ?? '' }]));
      for (const r of rep.rows) {
        const info = tenTid.get(r.tidId) ?? { hkd: '', bank: '' };
        const tidStr = rep.tids.find((t) => t.tidId === r.tidId)?.tid ?? '';
        const key = `${tidStr}|${r.billLoNumber ?? ''}`;
        theoKhoa.set(key, { row: r, hkd: r.borrowedHkd ?? info.hkd, bank: r.borrowedBank ?? info.bank });
      }
    } catch (err) {
      console.error(`[folder-report] không lấy được báo cáo phòng ${roomId}:`, err);
    }
  }

  const cacheDayLo = new Map<string, DayLoMay[]>();
  const rows: DongBaoCaoFolder[] = [];
  for (const b of bills) {
    const tid = (b.tid ?? '').trim();
    const lo = String(b.lo ?? '').replace(/[^0-9]/g, '');
    const loi: string[] = [...kiemTraNgayBill(b.dateTime, now)];

    if (tid && lo) {
      try {
        const dayLo = await dayLoTheoTid(db, tid, cacheDayLo, layDayLo);
        const me = dayLo.find((m) => m.tid === tid);
        if (me) loi.push(...kiemTraSoLo({ tidId: me.tidId, lo: Number(lo) }, dayLo).canhBao);
      } catch (err) { console.error('[folder-report] gate số lô lỗi:', err); }
    }

    const hit = tid && lo ? theoKhoa.get(`${tid}|${lo}`) : undefined;
    const dm = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(b.dateTime ?? ''));
    const tm = /(\d{1,2}):(\d{2})/.exec(String(b.dateTime ?? ''));
    if (hit) {
      const gioVN = new Date(new Date(hit.row.effDateIso).getTime() + 7 * 3600_000).toISOString().slice(11, 16);
      rows.push({
        idx: b.idx ?? null, fileName: b.fileName ?? null,
        hkdName: hit.hkd, bankName: hit.bank, tid, lo,
        date: hit.row.date, time: gioVN,
        truoc: hit.row.gross, fee: hit.row.fee, sau: hit.row.net,
        trangThai: 'DA_GHI', loi
      });
    } else {
      rows.push({
        idx: b.idx ?? null, fileName: b.fileName ?? null,
        hkdName: '', bankName: '', tid, lo,
        date: dm ? `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}` : '',
        time: tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : '',
        truoc: Number(b.amount ?? 0), fee: 0, sau: 0,
        trangThai: tid && lo ? 'CHUA_GUI' : 'DOC_HUT',
        loi: [...loi, ...(tid && lo ? ['🟡 Chưa ghi doanh số (chưa gửi hoặc gửi hụt) — kiểm rồi gửi lại.'] : ['🔴 OCR không ra TID/số lô — mở bill nhập tay rồi gửi.'])]
      });
    }
  }

  // SẮP ĐỂ REVIEW: lô LỖI lên đầu → rồi HKD → TID → số lô tăng dần.
  rows.sort((a, b2) => {
    const la = a.loi.length > 0 ? 0 : 1, lb = b2.loi.length > 0 ? 0 : 1;
    if (la !== lb) return la - lb;
    return a.hkdName.localeCompare(b2.hkdName) || a.tid.localeCompare(b2.tid) || (Number(a.lo || 0) - Number(b2.lo || 0));
  });

  const tong = rows.reduce(
    (s, r) => ({
      soBill: s.soBill + 1,
      daGhi: s.daGhi + (r.trangThai === 'DA_GHI' ? 1 : 0),
      chuaGui: s.chuaGui + (r.trangThai === 'CHUA_GUI' ? 1 : 0),
      docHut: s.docHut + (r.trangThai === 'DOC_HUT' ? 1 : 0),
      soLoi: s.soLoi + (r.loi.length > 0 ? 1 : 0),
      tongTruoc: s.tongTruoc + r.truoc,
      tongSau: s.tongSau + r.sau
    }),
    { soBill: 0, daGhi: 0, chuaGui: 0, docHut: 0, soLoi: 0, tongTruoc: 0, tongSau: 0 }
  );
  return { rows, tong };
}
