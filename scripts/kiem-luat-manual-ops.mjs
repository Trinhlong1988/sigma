// BỘ KIỂM LUẬT cho script sửa dữ liệu (scripts/manual-ops/*.mts) — Admin Demo 26/9 "xiết chặt quy trình, luật,
// gate, qa, bài học, cấm tái diễn".
//
// VÌ SAO CÓ FILE NÀY: trong 1 ngày, script do LEAD viết đã làm hỏng dữ liệu TIỀN THẬT và cổng QA vẫn báo XANH:
//   · Đọc `bill_txn_date` qua $queryRaw (driver lệch +7h) rồi ghi lại ⇒ +7h MỖI LẦN CHẠY; chạy 2 lần ⇒ +14h
//     ⇒ doanh số NĐT NĐT 1 25/9 hụt 625.714.000đ. Admin Demo phát hiện, KHÔNG phải cổng.
//   · Cổng QA chỉ kiểm phí/tiền, không kiểm chính cột mình ghi.
//   · Script không idempotent nên chạy lại là cộng dồn.
// Văn bản nhắc nhở KHÔNG chặn được — phải có thứ CHẠY ĐƯỢC và ĐỎ. File này là thứ đó, và nó nằm trong gate.
//
// Chạy riêng: node scripts/kiem-luat-manual-ops.mjs
// Bỏ qua 1 luật cho 1 file (phải CÓ LÝ DO): thêm dòng `// LUAT-BO-QUA: <mã> — <lý do>` vào đầu file.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THU_MUC = path.join(ROOT, 'scripts', 'manual-ops');

/** NỢ CŨ: script viết TRƯỚC khi có bộ luật này. Ghi nhận để cổng KHÔNG đỏ thường trực rồi bị bỏ qua — cổng đỏ
 *  mãi là cổng chết. Cổng CHỈ ĐỎ với vi phạm MỚI. Trả nợ dần: sửa script rồi xoá dòng tương ứng khỏi file nợ.
 *  Sinh lại (chỉ khi áp luật lần đầu): node scripts/kiem-luat-manual-ops.mjs --chot-no-cu */
const FILE_NO = path.join(ROOT, 'scripts', '.luat-no-cu.json');
function docNo() {
  try { return new Set(JSON.parse(readFileSync(FILE_NO, 'utf8'))); } catch { return new Set(); }
}

/** Script CÓ GHI vào DB? (INSERT/UPDATE/DELETE hoặc Prisma create/update/delete/upsert) */
function coGhiDb(src) {
  return /\$executeRaw|\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(src)
    || /\.\s*(create|update|upsert|delete|createMany|updateMany|deleteMany)\s*\(/.test(src);
}
/** Cột MỐC THỜI GIAN — ghi sai là lệch ngày, lệch doanh số. */
const COT_MOC = ['bill_txn_date', 'txn_date', 'effective_from', 'assigned_from', 'paid_at', 'at_ms'];

const LUAT = [
  {
    ma: 'APPLY',
    mo: 'Script GHI DB phải có chế độ CHẠY THỬ: mặc định chỉ in, có --apply mới ghi',
    kiem: (src) => (coGhiDb(src) && !/--apply/.test(src) ? 'ghi DB nhưng không thấy cờ --apply' : null)
  },
  {
    ma: 'BACKUP',
    mo: 'Script GHI DB phải BACKUP vùng đụng ra <BACKUP_DIR> trước khi ghi (R202)',
    kiem: (src) => (coGhiDb(src) && !/alpha-backups/.test(src) ? 'ghi DB nhưng không backup ra alpha-backups' : null)
  },
  {
    ma: 'QAGATE',
    mo: 'Script GHI DB phải có CỔNG QA đọc lại sau ghi và exit ≠ 0 khi lệch',
    kiem: (src) => (coGhiDb(src) && !/process\.exit\(1\)/.test(src) ? 'ghi DB nhưng không có cổng QA nào exit(1)' : null)
  },
  {
    ma: 'MOC-DATE',
    mo: 'CẤM new Date(...) trên giá trị mốc đọc từ $queryRaw — driver lệch +7h, ghi lại là hỏng ngày',
    kiem: (src) => {
      const xau = COT_MOC.map((c) => c.replace(/_([a-z])/g, (_, k) => k.toUpperCase()));
      for (const t of [...COT_MOC, ...xau]) {
        const re = new RegExp(`new\\s+Date\\s*\\(\\s*[\\w.]*${t}`, 'i');
        if (re.test(src)) return `new Date(...${t}) — mốc đọc từ raw lệch +7h, phải dùng _moc-thoi-gian.mts hoặc gán thẳng trong SQL`;
      }
      return null;
    }
  },
  {
    ma: 'MOC-VERIFY',
    mo: 'Script GHI cột MỐC THỜI GIAN thì cổng QA phải ĐỌC LẠI mốc đó (::text) và so kỳ vọng',
    kiem: (src) => {
      if (!coGhiDb(src)) return null;
      const ghiMoc = COT_MOC.filter((c) => new RegExp(`(SET|,)\\s*${c}\\s*=|${c}\\s*,|INSERT[^;]*${c}`, 'i').test(src));
      if (ghiMoc.length === 0) return null;
      const coDocLai = /AT TIME ZONE 'Asia\/Ho_Chi_Minh'\)::text|khangDinhMoc|docMocIso/.test(src);
      return coDocLai ? null : `ghi cột mốc (${ghiMoc.join(', ')}) nhưng cổng QA KHÔNG đọc lại mốc bằng ::text`;
    }
  },
  {
    ma: 'REGEX-HEREDOC',
    mo: 'Regex kiểu ^X\\d+$ dựng bằng template literal dễ mất dấu \\ (heredoc) → khớp 0 dòng, XANH GIẢ',
    kiem: (src) => (/new\s+RegExp\s*\(\s*`[^`]*\\d/.test(src) ? 'new RegExp(`...\\d...`) — dễ mất \\ thành ^Xd+$, khớp 0 dòng mà vẫn báo xanh' : null)
  }
];

function boQua(src) {
  const out = new Set();
  for (const m of src.matchAll(/LUAT-BO-QUA:\s*([A-Z-]+)/g)) out.add(m[1]);
  return out;
}

export function kiemLuatManualOps() {
  let files = [];
  try { files = readdirSync(THU_MUC).filter((f) => f.endsWith('.mts') && !f.startsWith('_')); }
  catch { console.log('[luat] không có thư mục manual-ops — bỏ qua'); return true; }

  const viPham = [];
  for (const f of files) {
    const src = readFileSync(path.join(THU_MUC, f), 'utf8');
    const bq = boQua(src);
    for (const l of LUAT) {
      if (bq.has(l.ma)) continue;
      const loi = l.kiem(src);
      if (loi) viPham.push({ f, ma: l.ma, loi });
    }
  }
  // --chot-no-cu: ghi nhận toàn bộ vi phạm hiện tại làm NỢ CŨ (chỉ chạy 1 lần khi áp luật lần đầu).
  if (process.argv.includes('--chot-no-cu')) {
    const ds = [...new Set(viPham.map((v) => `${v.f}|${v.ma}`))].sort();
    writeFileSync(FILE_NO, JSON.stringify(ds, null, 1));
    console.log(`[luat] đã chốt ${ds.length} NỢ CŨ vào scripts/.luat-no-cu.json — từ nay chỉ vi phạm MỚI làm đỏ cổng`);
    return true;
  }
  const no = docNo();
  const moi = viPham.filter((v) => !no.has(`${v.f}|${v.ma}`));
  const soCu = viPham.length - moi.length;
  if (moi.length === 0) {
    console.log(`[luat] ✓ ${files.length} script · 0 vi phạm MỚI${soCu > 0 ? ` (còn ${soCu} nợ cũ — trả dần, xem scripts/.luat-no-cu.json)` : ''}`);
    return true;
  }

  console.error(`
[luat] ✗ ${moi.length} VI PHẠM MỚI (${soCu} nợ cũ bỏ qua) — sửa, hoặc khai LUAT-BO-QUA kèm lý do:`);
  const theoFile = new Map();
  for (const v of moi) { if (!theoFile.has(v.f)) theoFile.set(v.f, []); theoFile.get(v.f).push(v); }
  for (const [f, vs] of theoFile) {
    console.error(`  ${f}`);
    for (const v of vs) console.error(`     [${v.ma}] ${v.loi}`);
  }
  console.error('\n  Luật đầy đủ: scripts/kiem-luat-manual-ops.mjs · công cụ mốc: scripts/manual-ops/_moc-thoi-gian.mts');
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(kiemLuatManualOps() ? 0 : 1);
}
