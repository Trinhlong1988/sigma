// VERIFY vá "settlement thắng số lô": OCR lại ĐÚNG ảnh bill Huy-1 (2 tờ: THANH TOÁN SỐ LÔ 001 + TỔNG KẾT SỐ LÔ 028)
// bằng prompt MỚI → batchNumber PHẢI ra 28 (không 1). Chạy Opus cho chắc. Bypass cache.
import { fileToPng } from '../src/image-normalize.mjs';
import { readBillOrTransfer } from '../src/vision-ocr.mjs';

const IMG = '<REPO>/Desktop/bill/5.9/6.ĐL - Lộc Sài Gòn/1788588254037_3644140397735929344_gDEMOGROUP0000000003_1b62d7dd4dd65900d01a1370a62eaed2.jpg';
const MODEL = process.argv[2] || 'claude-opus-4-8';

const png = await fileToPng(IMG);
const r = await readBillOrTransfer(png, { model: MODEL, noCache: true });
console.log('MODEL:', MODEL);
console.log('KẾT QUẢ OCR:');
for (const b of (r.bills ?? [])) {
  console.log(`  tờ: type=${b.type} tid=${b.tid} lô=${b.batchNumber} tiền=${b.totalAmount} giờ=${b.dateTime} settlementCode=${b.settlementCode ?? ''}`);
}
const los = (r.bills ?? []).map((b) => String(b.batchNumber));
console.log(`\n→ Số lô đọc được: [${los.join(', ')}]  ${los.includes('28') ? '✅ CÓ lô 28 (settlement thắng)' : '❌ KHÔNG có lô 28'}`);
if (los.includes('1') && los.includes('28')) console.log('  (2 tờ: sale lô nay cũng theo 28 hoặc sale=1 + settlement=28 — aggregation sẽ hút về 28)');
process.exit(0);
