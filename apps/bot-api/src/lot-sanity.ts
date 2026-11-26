// GATE "SỐ LÔ CÓ HỢP LÝ KHÔNG" (Admin Demo 8/9 — sau 2 ca lọt thật trong 1 ngày).
//
// CA 1: TUẤN ĐẠT 1 lô THẬT 66 → OCR đọc 500 (500 là TRACE No/SỐ HOÁ ĐƠN). Dãy lô máy này đang 63·64·65.
// CA 2: lô 101 của XUÂN ĐOÀN 3 bị gán sang XUÂN ĐOÀN 2 (2 máy có TID CHÉO NHAU: XD2=DEMO-TID-08, XD3=59930002).
//       Dãy lô: XD3 đang 93…100 (101 nối tiếp ĐÚNG), XD2 đang 142…157 (101 vô lý).
//
// Prompt ĐÃ dặn rất kỹ "không lấy TRACE/SEQ" và "đọc kỹ số cuối tên máy" — vẫn lọt. Bài học: KHÔNG được để lưới
// phụ thuộc vào việc model đọc đúng. Lưới phải nằm ở CODE, đối chiếu với DÃY LÔ THẬT trong DB:
//   · lô nhảy vọt so với lô gần nhất của chính máy đó  → nghi đọc nhầm số hoá đơn/trace,
//   · lô lại khớp liền mạch với MÁY KHÁC cùng họ HKD   → nghi gán nhầm máy (đọc nhầm số cuối tên).
// Module THUẦN (không I/O) để test được; tầng gọi lo truy vấn dãy lô.

/** Dãy lô gần đây của 1 máy (TID) cùng họ HKD. */
export interface DayLoMay {
  tidId: number;
  tid: string;
  hkdName: string | null;
  /** Số lô lớn nhất đã ghi gần đây (0 = chưa có lô nào). */
  maxLo: number;
  /** [Admin Demo 12/9] TOÀN BỘ số lô gần đây của máy — để gate loại TRỪ CHÍNH BILL đang xét khi so dãy
   *  (bill đã ghi vào DB rồi mới kiểm → so với maxLo là so với chính nó → gate MÙ, ca TUẤN ĐẠT 1 thiếu lô 104
   *  lọt câm vì lô 105 auto-ingest xong mới review). Không truyền → fallback logic maxLo cũ. */
  dsLo?: number[];
}

export interface KetQuaKiemLo {
  /** Cảnh báo hiển thị cho người duyệt (đã kèm emoji mức độ). Rỗng = không có gì bất thường. */
  canhBao: string[];
  /** Máy khớp dãy lô hơn hẳn (nghi gán nhầm máy) — để UI gợi ý đổi TID. */
  goiYMay?: { tid: string; hkdName: string | null; maxLo: number };
}

/** Trên ngưỡng này coi là "nhảy vọt" = nghi đọc nhầm SỐ HOÁ ĐƠN/TRACE (khác hẳn "ngắt quãng vài lô" = sót bill). */
export const NGUONG_NHAY_LO = 20;

/**
 * Kiểm tra 1 số lô vừa OCR.
 * @param bill  máy đang gán (tidId) + số lô đọc được
 * @param dsCungHo  dãy lô gần đây của TẤT CẢ máy cùng họ HKD (gồm cả máy đang gán)
 */
/** Khoảng cách tối thiểu giữa 2 lô liền nhau (đã sắp xếp) để coi phần trên là NGOẠI LAI. Dãy lô thật của 1 máy
 *  nhích vài đơn vị mỗi ngày; nhảy hơn ngần này là số hoá đơn/TRACE No lọt vào ô số lô. */
export const NGUONG_NGOAI_LAI = 60;

/**
 * Bỏ các lô NGOẠI LAI khỏi dãy trước khi tính maxLo.
 *
 * [Admin Demo 18/9 — ca thật] Bill lô 92 của KHACH HANG 60 2 bị kêu "NHỎ HƠN lô gần nhất của máy (548)" trong khi
 * dãy thật của máy là 67–92: hai lô 529/548 (ghi 15/9) là SỐ HOÁ ĐƠN đọc nhầm, đã nằm sẵn trong DB. Một con số
 * rác như thế ĐẦU ĐỘC maxLo vĩnh viễn ⇒ MỌI bill thật sau đó đều cảnh báo oan, người dùng quen tay bấm "xác
 * nhận gửi dù có cảnh báo" → cảnh báo mất hết tác dụng, lúc có lỗi THẬT cũng không ai tin nữa.
 * (KHACH HANG 61 2 cũng dính: 1010/1057 trong khi dãy thật 130–168.)
 */
export function locLoNgoaiLai(dsLo: number[]): { sach: number[]; ngoaiLai: number[] } {
  let ds = [...new Set(dsLo.filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
  const ngoaiLai: number[] = [];
  // [PHẢN BIỆN 21/9 — A-H1 CONFIRMED bằng test tái hiện] Bản đầu chỉ cắt 1 CỤM trên cùng: dãy 67..92 + rác
  // [300, 500] (2 số hoá đơn đọc nhầm 2 NGÀY khác nhau) → cắt được 500, còn 300 SỐNG → maxLo=300 → mọi bill
  // thật vẫn bị kêu oan. Nay LẶP cắt tới khi hết cụm lạc (mỗi vòng bỏ tối đa 1 cụm trên cùng — hội tụ).
  for (let vong = 0; vong < 10; vong++) {
    if (ds.length <= 2) break;
    let cat = false;
    for (let i = ds.length - 1; i > 0; i--) {
      if (ds[i] - ds[i - 1] > NGUONG_NGOAI_LAI) {
        // Chỉ coi là ngoại lai khi phần trên ÍT hơn hẳn phần dưới (vài con lạc lõng), tránh cắt nhầm khi máy
        // thật sự chuyển sang dải lô mới và đã chạy nhiều lô ở dải đó.
        const tren = ds.length - i;
        if (tren * 3 <= i) { ngoaiLai.unshift(...ds.slice(i)); ds = ds.slice(0, i); cat = true; }
        break; // chỉ xử khe trên cùng mỗi vòng; không cắt được thì dừng hẳn
      }
    }
    if (!cat) break;
  }
  return { sach: ds, ngoaiLai };
}

export function kiemTraSoLo(
  bill: { tidId: number; lo: number },
  dsCungHo: DayLoMay[]
): KetQuaKiemLo {
  const canhBao: string[] = [];
  if (!Number.isFinite(bill.lo) || bill.lo <= 0) return { canhBao };
  const mayThô = dsCungHo.find((m) => m.tidId === bill.tidId);
  // Lọc NGOẠI LAI trước khi so sánh: 1 lô rác (số hoá đơn) từng ghi nhầm sẽ làm mọi bill thật sau đó kêu oan.
  const locMay = mayThô?.dsLo ? locLoNgoaiLai(mayThô.dsLo) : null;
  const may = mayThô && locMay
    ? { ...mayThô, dsLo: locMay.sach, maxLo: locMay.sach.length ? Math.max(...locMay.sach) : 0 }
    : mayThô;
  // [Admin Demo 12/9 — SỬA GATE MÙ] PREV = lô lớn nhất TRƯỚC bill này (loại chính nó khỏi dãy). Bill đã ghi DB
  // (auto-ingest/scan lại) thì maxLo == bill.lo → so maxLo là so chính nó → không bao giờ thấy ngắt quãng.
  const prevLo = may
    ? (may.dsLo ? may.dsLo.filter((n) => n < bill.lo).reduce((mx, n) => Math.max(mx, n), 0)
                : (may.maxLo < bill.lo ? may.maxLo : 0))
    : 0;

  // (1) NHẢY VỌT so với chính máy đó → nghi lấy nhầm TRACE No/Số hoá đơn (ca TUẤN ĐẠT 1: 65 → 500).
  if (may && prevLo > 0 && bill.lo > prevLo + NGUONG_NHAY_LO) {
    canhBao.push(
      `🔴 SỐ LÔ ${bill.lo} NHẢY VỌT so với lô gần nhất của máy này (${prevLo}) — NGHI đọc nhầm "SỐ HOÁ ĐƠN/TRACE No" thành số lô. Soi lại ảnh trước khi gửi.`
    );
  } else if (may && prevLo > 0 && bill.lo > prevLo + 1) {
    // (1b) [Admin Demo 10/9 — XIẾT CHẶT] "cùng 1 máy, cùng 1 TID, hôm nay sang ngày kế tiếp PHẢI liên tục liền kề;
    // ngắt quãng hoặc nhảy cóc là SAI". Dãy lô của máy chạy liên tục QUA NGÀY (không reset), nên lô mới phải
    // đúng maxLo+1. Trước đây chỉ kêu khi nhảy > 20 ⇒ hụt 2-20 lô (thiếu bill cả buổi) LỌT CÂM.
    // maxLo lấy trong 30 ngày gần nhất nên tự bao trọn ranh giới ngày.
    // [Admin Demo 12/9] Loại các lô THIẾU đã có thật trong dãy (dsLo) — chỉ kêu lô thật sự vắng.
    const daCo = new Set(may.dsLo ?? []);
    const dsThieuArr = Array.from({ length: bill.lo - prevLo - 1 }, (_, i) => prevLo + 1 + i).filter((n) => !daCo.has(n));
    if (dsThieuArr.length > 0) {
      const dsThieu = dsThieuArr.length <= 6 ? dsThieuArr.join(', ') : `${dsThieuArr[0]} … ${dsThieuArr[dsThieuArr.length - 1]}`;
      canhBao.push(
        `🔴 LÔ NGẮT QUÃNG: máy này lô liền trước là ${prevLo}, bill là lô ${bill.lo} — THIẾU ${dsThieuArr.length} lô (${dsThieu}). Lô của cùng 1 máy phải liền kề kể cả sang ngày mới: tìm bill thiếu (chưa quét/chưa gửi) rồi gửi theo đúng thứ tự.`
      );
    }
  }

  // (2) Lô khớp LIỀN MẠCH với máy KHÁC cùng họ → nghi gán nhầm máy (ca XUÂN ĐOÀN 3 → 2, TID chéo nhau).
  const khop = dsCungHo
    .filter((m) => m.tidId !== bill.tidId && m.maxLo > 0 && bill.lo > m.maxLo && bill.lo - m.maxLo <= 2)
    .sort((a, b) => b.maxLo - a.maxLo)[0];
  const tuNoiTiep = (!!may && prevLo > 0 && bill.lo > prevLo && bill.lo - prevLo <= 2) || !!(may?.dsLo?.includes(bill.lo));
  if (khop && !tuNoiTiep) {
    canhBao.push(
      `🔴 NGHI GÁN NHẦM MÁY: lô ${bill.lo} nối tiếp dãy lô của "${khop.hkdName ?? khop.tid}" (lô gần nhất ${khop.maxLo}), trong khi máy đang chọn${may ? ` (${may.hkdName ?? may.tid}) đang ở lô ${may.maxLo}` : ''}. Kiểm số cuối tên máy (2 ↔ 3) rồi chọn đúng TID.`
    );
    return { canhBao, goiYMay: { tid: khop.tid, hkdName: khop.hkdName, maxLo: khop.maxLo } };
  }

  // (3) Lô LÙI/TRÙNG so với lô gần nhất của chính máy → nghi đọc nhầm hoặc bill cũ gửi lại.
  if (may && may.maxLo > 0 && bill.lo < may.maxLo) {
    canhBao.push(`🟡 Số lô ${bill.lo} NHỎ HƠN lô gần nhất của máy (${may.maxLo}) — bill cũ hay đọc nhầm? Kiểm tay.`);
  }
  // Có lô rác trong DB thì NÓI RA (kèm số cụ thể) — để đi sửa gốc, thay vì để người dùng bấm bỏ qua mỗi lần.
  if (locMay && locMay.ngoaiLai.length > 0) {
    canhBao.push(
      `ℹ️ Máy này đang có ${locMay.ngoaiLai.length} lô BẤT THƯỜNG trong dữ liệu cũ (${locMay.ngoaiLai.join(', ')}) — gần như chắc là SỐ HOÁ ĐƠN bị ghi nhầm vào ô số lô. Đã BỎ QUA khi so sánh (nếu không, mọi bill thật đều bị kêu oan). Nên sửa số lô của các lô đó cho đúng.`
    );
  }
  return { canhBao };
}

/** Ngày bill lệch quá bao nhiêu ngày so với hôm nay thì coi là bất thường (bill quét trong ngày/vài ngày). */
export const NGUONG_LECH_NGAY = 10;

/**
 * GATE NGÀY BILL (Admin Demo 8/9 — ca THẬT: lô 102 XUÂN ĐOÀN 3 quẹt 08/09/2026 nhưng OCR đọc "08/05/2026",
 * nhầm THÁNG 09 → 05 → doanh số rơi sai tháng, phí tra theo biểu phí kỳ khác).
 * Cảnh báo khi: ngày bill Ở TƯƠNG LAI, hoặc lùi quá NGUONG_LECH_NGAY so với hôm nay.
 * @param ngayBill 'dd/mm/yyyy' (hoặc kèm giờ) đọc từ OCR
 */
export function kiemTraNgayBill(ngayBill: string | null | undefined, homNay: Date = new Date()): string[] {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(ngayBill ?? ''));
  if (!m) return [];
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12, 0, 0);
  if (isNaN(d.getTime())) return [];
  const nay = new Date(homNay.getFullYear(), homNay.getMonth(), homNay.getDate(), 12, 0, 0);
  const lechNgay = Math.round((nay.getTime() - d.getTime()) / 86400000);
  const ns = `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  if (lechNgay < 0) return [`🔴 NGÀY BILL ${ns} nằm ở TƯƠNG LAI (hôm nay ${nay.toLocaleDateString('vi-VN')}) — OCR đọc sai ngày/tháng. Sửa ngày rồi mới gửi.`];
  if (lechNgay > NGUONG_LECH_NGAY) {
    return [`🔴 NGÀY BILL ${ns} cách hôm nay ${lechNgay} ngày — NGHI OCR đọc nhầm THÁNG/NGÀY (vd 09 ↔ 05). Soi lại ảnh, sửa ngày rồi mới gửi.`];
  }
  return [];
}
