// GATE KHẲNG-ĐỊNH-BẤT-BIẾN — MỌI TID đang có trong hệ phải SỐNG SÓT qua bộ chuẩn hoá TID của OCR.
//
// VÌ SAO (Admin Demo 28/9 "chống tái diễn", sau vụ bill VPBank "TID: R3600138"): bộ chuẩn hoá OCR từng strip
// `[^0-9]` ⇒ "R3600138" thành "3600138" ⇒ không khớp máy nào ⇒ MỖI LẦN quét đều bắn cảnh báo "TID không có
// trong hệ thống — đã SUY từ tên HKD", bắt người dùng tự xác nhận, dễ gửi nhầm máy.
// Lỗi chỉ lộ khi có máy TID dạng lạ. Test đơn vị chỉ phủ dạng mình NGHĨ RA; gate này soi DỮ LIỆU THẬT nên
// thêm máy dạng lạ (chữ ở giữa, quá dài, có gạch...) là ĐỎ NGAY, không đợi gặp bill mới biết.
//
// Chạy: node scripts/kiem-tid-ocr-chuan-hoa.mjs
// Không có DATABASE_URL → BỎ QUA (in rõ, không coi là xanh giả).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function kiemTidOcrChuanHoa() {
  if (!process.env.DATABASE_URL) {
    console.log('[tid-ocr] ⊘ BỎ QUA — không có DATABASE_URL (KHÔNG tính là đạt)');
    return true;
  }
  let chuanHoaTid, getBotDb;
  try {
    ({ chuanHoaTid } = await import(pathToFileURL(path.join(ROOT, 'apps/zalo-watcher/src/vision-ocr.mjs')).href));
    ({ getBotDb } = await import(pathToFileURL(path.join(ROOT, 'apps/bot-api/src/db.ts')).href));
  } catch (e) {
    console.error('[tid-ocr] ✗ KHÔNG nạp được module để kiểm:', e instanceof Error ? e.message : e);
    return false;   // R198: không chạy được kiểm tra = ĐỎ, không im lặng cho qua
  }
  const db = getBotDb();
  let rows;
  try {
    rows = await db.$queryRawUnsafe(
      // CHỈ máy POS: mã QR (kind='QR', tid dạng "QR-HKDxxx-slug") KHÔNG đi qua OCR bill POS — đưa vào là
      // cổng đỏ thường trực rồi bị bỏ qua, cổng đỏ mãi là cổng chết.
      `SELECT tid, hkd_name FROM tids
        WHERE deleted_at IS NULL AND tid IS NOT NULL AND tid <> ''
          AND (kind IS NULL OR kind <> 'QR') AND tid NOT LIKE 'QR-%'
        ORDER BY tid`);
  } catch (e) {
    console.error('[tid-ocr] ✗ KHÔNG đọc được bảng tids:', e instanceof Error ? e.message : e);
    return false;
  }
  const hong = [];
  for (const r of rows) {
    const goc = String(r.tid).trim();
    const ra = chuanHoaTid(goc);
    if (ra !== goc) hong.push({ goc, ra, hkd: r.hkd_name });
  }
  if (hong.length === 0) {
    console.log(`[tid-ocr] ✓ ${rows.length} TID trong hệ đều sống sót qua chuẩn hoá OCR`);
    return true;
  }
  console.error(`\n[tid-ocr] ✗ ${hong.length}/${rows.length} TID bị bộ chuẩn hoá OCR làm SAI — quét bill các máy này sẽ báo "TID không có trong hệ thống":`);
  for (const h of hong) console.error(`   "${h.goc}" → "${h.ra}"   (${h.hkd ?? '—'})`);
  console.error(`\n  Sửa chuanHoaTid() trong apps/zalo-watcher/src/vision-ocr.mjs cho nhận dạng TID này.`);
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  kiemTidOcrChuanHoa().then((ok) => process.exit(ok ? 0 : 1));
}
