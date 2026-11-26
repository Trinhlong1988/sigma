// PHÂN LOẠI ẢNH BILL bằng BẰNG CHỨNG CHỮ (Admin Demo 8/9: "đào sâu nguyên nhân, fix triệt để").
//
// GỐC BUG "bill QR mà báo không phải bill QR, OCR ra bill POS": trước đây kind được quyết bởi THỨ TỰ THỬ —
// đọc POS trước, hễ model trả về bill nào có TID/số lô là chốt POS luôn. Ảnh bill QR chỉ cần bị model POS
// "nhận vơ" 1 lần là rơi nhầm nhánh, và ở chế độ Sonnet/Opus (bỏ OCR máy) nhánh QR còn không được thử trước.
// → Phân loại phải dựa vào CHỮ CÓ THẬT TRÊN ẢNH, không dựa vào ai đọc trước.
//
// Module THUẦN (nhận danh sách dòng text, không I/O) → test bằng fixture text RapidOCR thật.

/** Bỏ dấu + bỏ ký tự không phải chữ/số để so từ khoá bền với lỗi dấu của OCR ("So tièn" → "sotien"). */
function chuanHoa(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Dấu hiệu ĐẶC TRƯNG từng loại bill. Trọng số 2 = gần như chỉ loại đó mới có; 1 = gợi ý yếu (nhiều loại có).
const DAU_HIEU = {
  QR: [
    ['thanhtoanthanhcong', 2],
    ['nhacungcap', 2],
    ['sogiaodich', 1],
    ['ngaythuchien', 1],
    ['hoadon', 1]
  ],
  POS: [
    ['settlement', 2],
    ['solo', 2],
    ['tid', 2],
    ['mid', 1],
    ['batch', 1],
    ['approval', 1],
    ['merchant', 1],
    ['chuthe', 1],
    ['tongcong', 1],
    ['ketoan', 1],
    ['dongl', 1]
  ],
  // [Admin Demo 10/9 — ảnh email VIB "Thông báo giao dịch VIB One Card"] THÔNG BÁO GIAO DỊCH THẺ = ảnh phía CHỦ THẺ
  // (email/SMS ngân hàng gửi khách), KHÔNG phải bill bán hàng: chỉ có số thẻ che, tên chủ thẻ, số tiền, giờ, nơi
  // quẹt — KHÔNG có tên HKD, KHÔNG có Số giao dịch. Trước đây rơi vào nhánh POS → không có TID → thử QR → lọc vứt
  // (cần tiền + tên-HKD/số-GD) → "không OCR ra" mà không ai biết vì sao. Nhận đúng loại để tầng trên đi đường
  // ĐỐI SOÁT BÁO-CÓ (tiền + giờ + tên người quẹt) thay vì đòi đọc thứ không in trên ảnh.
  // CHỌN TỪ KHOÁ: chỉ lấy chữ mà bill POS/QR KHÔNG có ("vào lúc", "thông báo giao dịch", "kính gửi quý khách").
  // CỐ Ý KHÔNG lấy "số thẻ"/"chủ thẻ" — bill POS cũng in 2 dòng này (sẽ kéo POS sang loại này).
  CARD_NOTICE: [
    ['thongbaogiaodich', 2],
    ['vaoluc', 2],
    ['kinhguiquykhachhang', 2],
    ['onecard', 1],
    ['giatri', 1],
    ['thetindung', 1]
  ],
  CK: [
    ['chuyentienthanhcong', 2],
    ['chuyentien', 1],
    ['nguoinhan', 2],
    ['nguoihuongthu', 2],
    ['taikhoannhan', 2],
    ['sotaikhoan', 1],
    ['noidungchuyenkhoan', 2],
    ['bienlai', 1],
    ['bienlaichuyentien', 2]
  ]
};

/**
 * Phân loại 1 ảnh bill từ text OCR máy.
 * @param {{t:string}[]} lines dòng text thô (RapidOCR)
 * @returns {{kind:'QR'|'POS'|'CK'|'CARD_NOTICE'|null, scores:{QR:number,POS:number,CK:number,CARD_NOTICE:number}, sawText:boolean}}
 *   kind = null khi KHÔNG đủ bằng chứng (điểm 0, hoặc 2 loại hoà nhau) → tầng trên giữ nguyên cách cũ, KHÔNG đoán.
 */
export function classifyBillLines(lines) {
  const ls = Array.isArray(lines) ? lines : [];
  const flat = ls.map((l) => chuanHoa(l?.t)).join('|');
  const scores = { QR: 0, POS: 0, CK: 0, CARD_NOTICE: 0 };
  for (const [kind, dsach] of Object.entries(DAU_HIEU)) {
    for (const [tu, diem] of dsach) if (flat.includes(tu)) scores[kind] += diem;
  }
  const sawText = ls.length >= 3;
  const xep = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topKind, topDiem] = xep[0];
  const [, nhiDiem] = xep[1];
  // Cần điểm ≥2 (tức có ít nhất 1 dấu hiệu ĐẶC TRƯNG, hoặc 2 dấu hiệu yếu) và HƠN HẲN loại nhì → mới dám chốt.
  if (topDiem >= 2 && topDiem > nhiDiem) return { kind: topKind, scores, sawText };
  return { kind: null, scores, sawText };
}
