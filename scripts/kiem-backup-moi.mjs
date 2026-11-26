// CỔNG CANH BACKUP CÒN MỚI — chống "backup chết câm".
//
// CA THẬT 15/11: Scheduled Task `SigMa_DbBackup` chạy ĐÚNG GIỜ 2:30 mỗi ngày nhưng trả mã lỗi 1 suốt
// 2 ngày (thiếu `apps/bot-api/.env`). Task vẫn hiện "Ready", không ai biết, sổ tiền không có bản mới nào —
// trong khi máy chỉ có ĐÚNG 1 ổ vật lý (đã từng reset SSD vì đầy ổ). Task "chạy" ≠ backup "có".
//
// Cổng này soi THỨ THẬT: file backup mới nhất trong kho, tuổi bao nhiêu giờ, và có bản nằm NGOÀI ổ không.
//
// Chạy riêng: node scripts/kiem-backup-moi.mjs
// Ngưỡng:    SIGMA_BACKUP_TRAN_GIO (mặc định 26 — backup chạy 2:30 hằng ngày, chừa 2h xê dịch).
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const KHO_CHINH = '<BACKUP_DIR>\\db';
const KHO_PHU = '\\\\127.0.0.1\\D$\\alpha-db-backups';
const TRAN_GIO = Number(process.env['SIGMA_BACKUP_TRAN_GIO'] ?? 26);

/** Bản .enc mới nhất trong 1 thư mục (null nếu thư mục không có/không đọc được). */
function banMoiNhat(thuMuc) {
  try {
    if (!existsSync(thuMuc)) return null;
    const ds = readdirSync(thuMuc)
      .filter((f) => f.endsWith('.dump.enc'))
      .map((f) => ({ ten: f, mtime: statSync(path.join(thuMuc, f)).mtimeMs, co: statSync(path.join(thuMuc, f)).size }))
      .sort((a, b) => b.mtime - a.mtime);
    return ds[0] ?? null;
  } catch (e) {
    return { loi: String(e && e.message ? e.message : e) };
  }
}

const loi = [];
const chinh = banMoiNhat(KHO_CHINH);
if (!chinh) {
  loi.push(`kho chính KHÔNG có bản backup nào: ${KHO_CHINH}`);
} else if (chinh.loi) {
  loi.push(`không đọc được kho chính ${KHO_CHINH}: ${chinh.loi}`);
} else {
  const gio = (Date.now() - chinh.mtime) / 3_600_000;
  console.log(`[kiem-backup] kho chính: ${chinh.ten} · ${(chinh.co / 1048576).toFixed(1)} MB · ${gio.toFixed(1)} giờ trước`);
  if (gio > TRAN_GIO) loi.push(`bản mới nhất đã ${gio.toFixed(1)} giờ tuổi (trần ${TRAN_GIO}h) — backup có thể đang CHẾT CÂM`);
  if (chinh.co < 1_000_000) loi.push(`bản mới nhất chỉ ${chinh.co} byte — quá nhỏ, nghi dump hỏng`);
}

// Bản NGOÀI ổ: máy chỉ có 1 ổ vật lý nên bản nằm cùng ổ KHÔNG cứu được khi ổ chết.
const phu = banMoiNhat(KHO_PHU);
if (!phu || phu.loi) {
  console.log(`[kiem-backup] ⚠ kho phụ (ngoài ổ) chưa kiểm được: ${KHO_PHU}${phu && phu.loi ? ' — ' + phu.loi : ''}`);
} else {
  const gioPhu = (Date.now() - phu.mtime) / 3_600_000;
  console.log(`[kiem-backup] kho phụ (ngoài ổ): ${phu.ten} · ${gioPhu.toFixed(1)} giờ trước`);
  if (gioPhu > TRAN_GIO * 2) loi.push(`bản NGOÀI ổ đã ${gioPhu.toFixed(1)} giờ tuổi — ổ chết là mất dữ liệu tiền`);
}

if (loi.length > 0) {
  console.error(`[kiem-backup] ✗ ${loi.length} vấn đề:`);
  for (const l of loi) console.error('   · ' + l);
  console.error('[kiem-backup]   Chạy tay: node scripts/backup-db-sigma.mjs "\\\\127.0.0.1\\D$\\alpha-db-backups"');
  process.exit(1);
}
console.log('[kiem-backup] ✓ backup còn mới và có bản nằm ngoài ổ.');
