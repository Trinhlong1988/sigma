// LUẬT CHẠY ĐƯỢC — cấm đọc CỘT MỐC THỜI GIAN thô qua $queryRaw rồi so sánh bằng JS.
//
// VÌ SAO (Admin Demo 26/9 "tại sao báo chí đức bm9 bill ocr lại báo chưa set giá bán khi ocr bill của ngày hôm qua"):
// driver Prisma đọc `timestamptz` qua $queryRaw LỆCH +7h — mốc "0h 25/9 giờ VN" ra "7h sáng 25/9 giờ VN".
// Đo thật máy Chí Đức BM-9 (TID DEMO-TID-01, giá bán 1,28% hiệu lực 0h 25/9): quoteRow ở giờ bill 00:30/01:51/
// 05:00/06:59 đều trả NO_ACTUAL_SELL_FEE ⇒ OCR báo "chưa cấu hình giá bán" ⇒ KHÔNG tạo được lô. Cửa sổ mù =
// đúng 7 giờ đầu kể từ mốc, và mốc thường đặt 0h ⇒ nuốt trọn ca đêm. Cùng lớp lỗi đã đốt: los.bill_txn_date
// (+7h khi đọc, −7h khi ghi). Nhắc nhở bằng văn bản KHÔNG chặn được — phải có thứ ĐỎ được.
//
// LUẬT: trong câu raw, mọi cột mốc PHẢI trả chuỗi có offset:
//   to_char(<cột> AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00' AS <cột>
// hoặc (<cột> AT TIME ZONE 'Asia/Ho_Chi_Minh')::text. So sánh THẲNG TRONG SQL (cột <= $1) thì KHÔNG sao —
// chỉ cấm mang giá trị thô về JS.
// Bỏ qua 1 dòng có lý do: đặt `// MOC-RAW-BO-QUA: <lý do>` ngay TRÊN dòng đó.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Cột mốc thời gian — đọc thô là lệch ngày, lệch giá, lệch doanh số. */
const COT_MOC = ['effective_from', 'bill_txn_date', 'txn_date', 'assigned_from', 'paid_at', 'borrowed_from', 'borrowed_to'];

/** Mọi file .ts nguồn (bỏ test/dist/node_modules) — liệt kê bằng git để khỏi lệ thuộc glob của shell. */
function dsFile() {
  const out = execFileSync('git', ['ls-files', '*.ts'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((f) => !/(^|\/)(test|tests)\//.test(f) && !/\.test\.ts$/.test(f) && !/\/dist\//.test(f));
}

/** Câu raw trong file? Lấy các đoạn nằm giữa $queryRaw / $executeRaw và dấu đóng — xấp xỉ bằng cách quét
 *  từng dòng có tên cột mốc đứng trong ngữ cảnh SELECT. Cố tình THÔ nhưng KHÔNG bỏ sót: đã có cơ chế bỏ qua. */
export function kiemMocThoiGianRaw() {
  const viPham = [];
  for (const f of dsFile()) {
    let src;
    try { src = readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (!/\$queryRaw|\$executeRaw/.test(src)) continue;
    const dong = src.split('\n');
    for (let i = 0; i < dong.length; i++) {
      const d = dong[i];
      if (!/\bSELECT\b|^\s*`?\s*\w+\s*,/.test(d)) continue;      // chỉ xét dòng danh sách cột
      if (/MOC-RAW-BO-QUA/.test(dong[i - 1] ?? '')) continue;
      for (const c of COT_MOC) {
        // cột đứng TRẦN trong danh sách SELECT: có dấu , hoặc SELECT ngay trước, KHÔNG nằm sau AT TIME ZONE/to_char
        const re = new RegExp(`(SELECT|,)\s*(\w+\.)?${c}\s*(,|\s+FROM\b|\s*\`)`, 'i');
        if (!re.test(d)) continue;
        if (new RegExp(`${c}[^,]*AT TIME ZONE`, 'i').test(d)) continue;   // đã quy đổi đúng
        if (new RegExp(`AS\s+${c}`, 'i').test(d) && /to_char/i.test(d)) continue;
        viPham.push({ f, dong: i + 1, cot: c, ma: d.trim().slice(0, 110) });
      }
    }
  }
  if (viPham.length === 0) { console.log('[moc-raw] ✓ không câu raw nào đọc cột mốc thời gian thô'); return true; }
  console.error(`\n[moc-raw] ✗ ${viPham.length} chỗ đọc CỘT MỐC thô qua raw (driver lệch +7h):`);
  for (const v of viPham) console.error(`  ${v.f}:${v.dong}  [${v.cot}]  ${v.ma}`);
  console.error(`\n  Sửa: to_char(<cột> AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00' AS <cột>`);
  console.error(`  Hoặc khai lý do: // MOC-RAW-BO-QUA: <lý do> ở dòng ngay trên.`);
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(kiemMocThoiGianRaw() ? 0 : 1);
}
