// Bóc TRƯỜNG bill QR từ text thô OCR LOCAL (Admin Demo 8/9: "lần 1 local, lần 2 Claude nếu sai/có cảnh báo").
// Thuần hàm (không I/O) → unit test được bằng fixture text THẬT (scripts/../test).
//
// Nguyên tắc TIỀN (R: cấm suy luận): chỉ nhận trường đọc CHẮC. Bất kỳ nghi ngờ nào (thiếu trường, độ tin cậy
// thấp, số tiền lẻ bất thường, số GD sai dạng) → gắn cảnh báo + `needsClaude` để tầng trên đọc lại bằng Claude.

/** Bỏ dấu tiếng Việt + gọn khoảng trắng, để so nhãn ("Số tiền" ↔ "So tièn" OCR đọc lệch dấu). */
export function normLabel(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Chồng lấn dọc giữa 2 hộp text ≥ 50% chiều cao hộp nhỏ hơn → coi là CÙNG HÀNG. */
function sameRow(a, b) {
  const h = Math.min(a.y2 - a.y, b.y2 - b.y) || 1;
  const overlap = Math.min(a.y2, b.y2) - Math.max(a.y, b.y);
  return overlap / h >= 0.5;
}

/** Giá trị BÊN PHẢI nhãn trên cùng hàng (gộp nếu app xuống dòng thành nhiều hộp). */
function valueRightOf(lines, label) {
  const same = lines.filter((l) => l !== label && sameRow(l, label) && l.x >= label.x);
  if (!same.length) return null;
  same.sort((a, b) => a.x - b.x);
  return { text: same.map((l) => l.t).join(' ').trim(), score: Math.min(...same.map((l) => l.s)) };
}

function findLabel(lines, ...keys) {
  for (const l of lines) {
    const n = normLabel(l.t);
    for (const k of keys) if (n === k || n.startsWith(k)) return l;
  }
  return null;
}

const REF_RE = /^[0-9A-Z]{12,26}$/;

/**
 * @param {{y:number,x:number,y2:number,x2:number,t:string,s:number}[]} lines text thô OCR local
 * @returns {{isQr:boolean, qr:object|null, warnings:string[], needsClaude:boolean}}
 */
export function parseQrBillLines(lines) {
  const ls = (lines || []).filter((l) => l && typeof l.t === 'string');
  const flat = ls.map((l) => normLabel(l.t)).join('|');

  const lbAmount = findLabel(ls, 'sotien');
  const lbHkd = findLabel(ls, 'nhacungcap');
  const lbDate = findLabel(ls, 'ngaythuchien');
  const lbRef = findLabel(ls, 'sogiaodich');
  const lbFrom = ls.find((l) => normLabel(l.t) === 'tu' || normLabel(l.t) === 'tur');

  // Không phải bill QR → trả isQr=false để tầng trên đi tiếp POS/CK, KHÔNG tốn 1 lượt Claude.
  const looksQr = flat.includes('thanhtoanthanhcong') || (!!lbRef && !!lbHkd);
  if (!looksQr) return { isQr: false, qr: null, warnings: [], needsClaude: false };

  const warnings = [];
  const vAmount = lbAmount ? valueRightOf(ls, lbAmount) : null;
  const vHkd = lbHkd ? valueRightOf(ls, lbHkd) : null;
  const vDate = lbDate ? valueRightOf(ls, lbDate) : null;
  const vRef = lbRef ? valueRightOf(ls, lbRef) : null;
  const vFrom = lbFrom ? valueRightOf(ls, lbFrom) : null;

  // Số tiền: bỏ mọi ký tự không phải số ("29,998,000 đ" → 29998000). OCR hay đọc "đ" thành "g"/"d" → bỏ hết.
  const amount = vAmount ? Number(String(vAmount.text).replace(/[^0-9]/g, '')) || 0 : 0;
  if (!amount) warnings.push('THIEU_SO_TIEN');
  else {
    if (vAmount.score < 0.9) warnings.push('SO_TIEN_DOC_KHONG_CHAC');
    if (amount % 1000 !== 0) warnings.push('SO_TIEN_LE_BAT_THUONG'); // bill QR luôn tròn nghìn
  }

  // Ngày giờ: "08:58 08/09/2026" (OCR có thể dính liền "08:5808/09/2026").
  let date = null, time = null;
  if (vDate) {
    const m = /(\d{1,2}:\d{2})\s*(\d{1,2}\/\d{1,2}\/\d{4})/.exec(vDate.text.replace(/\s+/g, ' '));
    if (m) { time = m[1]; date = m[2]; }
  }
  if (!date || !time) warnings.push('THIEU_NGAY_GIO');
  else if (vDate.score < 0.9) warnings.push('NGAY_GIO_DOC_KHONG_CHAC');

  // Số giao dịch: định danh DUY NHẤT (dedup + đối soát báo có) → sai 1 ký tự là hỏng → soi kỹ.
  let ref = vRef ? String(vRef.text).toUpperCase().replace(/[^0-9A-Z]/g, '') : '';
  if (!ref) warnings.push('THIEU_SO_GIAO_DICH');
  else {
    if (!REF_RE.test(ref)) warnings.push('SO_GIAO_DICH_SAI_DANG');
    if (vRef.score < 0.9) warnings.push('SO_GIAO_DICH_DOC_KHONG_CHAC');
  }

  // Tên HKD: app ngân hàng CẮT CỤT ("HKD DEMO 40 Ha...") → GIỮ phần đọc được, KHÔNG vứt bill
  // (vứt = mất doanh số câm — chính bug 8/9). Khớp mã QR dùng tên rút gọn nên tên cắt vẫn dùng được.
  let hkdName = vHkd ? String(vHkd.text).trim() : '';
  const hkdTruncated = /\.{2,}$/.test(hkdName);
  if (hkdTruncated) hkdName = hkdName.replace(/\s*\.{2,}$/, '').trim();
  if (!hkdName) warnings.push('THIEU_TEN_HKD');
  else if (hkdTruncated) warnings.push('TEN_HKD_BI_CAT');

  const fromCard = vFrom ? String(vFrom.text).trim() : '';

  // Cảnh báo nào bắt buộc đọc lại bằng Claude? Tên HKD bị CẮT thì Claude cũng không đọc thêm được
  // (ảnh cắt thật) → KHÔNG tốn lượt; các cảnh báo còn lại đều là "đọc không chắc" → phải đọc lại.
  const CLAUDE_TRIGGER = new Set([
    'THIEU_SO_TIEN', 'SO_TIEN_DOC_KHONG_CHAC', 'SO_TIEN_LE_BAT_THUONG',
    'THIEU_NGAY_GIO', 'NGAY_GIO_DOC_KHONG_CHAC',
    'THIEU_SO_GIAO_DICH', 'SO_GIAO_DICH_SAI_DANG', 'SO_GIAO_DICH_DOC_KHONG_CHAC',
    'THIEU_TEN_HKD'
  ]);
  const needsClaude = warnings.some((w) => CLAUDE_TRIGGER.has(w));

  return {
    isQr: true,
    qr: { hkdName: hkdName || null, amount, date, time, ref: ref || null, fromCard: fromCard || null, hkdTruncated },
    warnings,
    needsClaude
  };
}

/** So khớp 2 lần đọc (local vs Claude) trên các trường QUYẾT ĐỊNH TIỀN. Lệch → cảnh báo đỏ cho người duyệt. */
export function diffQrReads(a, b) {
  if (!a || !b) return [];
  const out = [];
  // [Admin Demo 8/9] CHỈ báo "lệch" khi CẢ HAI cùng ĐỌC ĐƯỢC mà ra khác nhau. Một bên KHÔNG đọc được (tiền 0 / trường
  // rỗng) là "thiếu" — đó chính là lý do đã gọi Claude đọc lại — báo đỏ "2 lần đọc lệch" ở đây là CẢNH BÁO GIẢ,
  // gây nhiễu và làm người duyệt mất tin vào cờ đỏ thật.
  if (a.amount > 0 && b.amount > 0 && a.amount !== b.amount) out.push(`số tiền: local ${a.amount} ≠ Claude ${b.amount}`);
  const na = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (na(a.ref) && na(b.ref) && na(a.ref) !== na(b.ref)) out.push(`số GD: local ${a.ref} ≠ Claude ${b.ref}`);
  if (a.date && b.date && a.date !== b.date) out.push(`ngày: local ${a.date} ≠ Claude ${b.date}`);
  if (a.time && b.time && a.time !== b.time) out.push(`giờ: local ${a.time} ≠ Claude ${b.time}`);
  return out;
}
