// SIGMA (21/8, Admin Demo "bill không tự nhận diện thẻ nào giá nào") — bill quẹt KHÔNG in loại-thẻ-nghiệp-vụ
// (MB on-us / Ngoài-Napas nội địa / Ngoài-Visa-Master quốc tế) mà 3 loại này CÓ GIÁ BÁN KHÁC NHAU. Trước đây
// preview phí mặc định "thẻ đầu theo id" (MB) → phí có thể SAI. Module NÀY:
//   1) phân loại 1 loại thẻ (theo TÊN) về nhóm scheme → chọn MẶC ĐỊNH = INTERNATIONAL (Visa-Master, Admin Demo chốt).
//   2) NHẬN DIỆN scheme/BIN từ dòng OCR bill (best-effort, nhiều bill có in "VISA"/"MASTERCARD"/BIN 6 số/AID)
//      → PRE-CHỌN loại thẻ đúng; đại lý vẫn sửa tay được (bill không in rõ / OCR sót → rơi về mặc định).
// KHÔNG suy luận GIÁ ở đây (đúng feedback_cam_suy_luan) — chỉ phân loại + nhận diện để CHỌN loại thẻ; giá lấy
// từ tid_sell_fees qua quoteRow/previewSellFeeForTid như cũ.
import { stripDiacriticsUpper } from './ocr-bridge.js';
import { isNapasBin, lookupBankByBin } from './vietnam-bank-bins.js';

export type CardKlass = 'INTERNATIONAL' | 'NAPAS' | 'ONUS' | 'OTHER';

/** Phân loại 1 loại thẻ theo TÊN về nhóm scheme. Heuristic theo từ khóa (dữ liệu hiện tại đặt tên nhất quán:
 * "Ngoài MB-Visa-Master" / "Ngoài MB-Napas" / "MB"). INTERNATIONAL = Visa/Master/JCB/Amex/UnionPay/quốc tế;
 * NAPAS = thẻ nội địa Napas (KHÔNG phải on-us); ONUS = thẻ CHÍNH ngân hàng đó (còn lại, vd "MB"). Đây CHỈ để
 * chọn mặc định/nhận diện — KHÔNG động tới giá. */
export function classifyCardType(name: string): CardKlass {
  const s = stripDiacriticsUpper(name);
  if (/\b(VISA|MASTER(CARD)?|JCB|AMEX|AMERICAN EXPRESS|UNIONPAY|QUOC TE)\b/.test(s)) return 'INTERNATIONAL';
  if (/\b(NAPAS|NOI DIA)\b/.test(s)) return 'NAPAS';
  return 'ONUS';
}

export interface CardOption { id: number; name: string; klass: CardKlass }

/** Loại thẻ MẶC ĐỊNH khi chưa nhận diện được từ bill: ưu tiên INTERNATIONAL (Visa-Master — Admin Demo 21/8), nếu
 * bank không có thẻ INTERNATIONAL nào thì rơi về thẻ ĐẦU theo thứ tự truyền vào (giữ hành vi cũ, không vỡ). */
export function pickDefaultCardTypeId(cards: CardOption[]): number | null {
  if (cards.length === 0) return null;
  // [Admin Demo 4/9 "cứ bank ABB là Visa, đang JCB mặc định SAI"] Trong nhóm QUỐC TẾ, ƯU TIÊN VISA/MASTER (chuẩn SigMa)
  // TRƯỚC JCB/Amex/UnionPay — trước đây chỉ lấy thẻ quốc-tế ĐẦU danh sách → JCB lọt trước Visa → mặc định nhầm.
  const visaMaster = cards.find((c) => c.klass === 'INTERNATIONAL' && /\b(VISA|MASTER)\b/.test(stripDiacriticsUpper(c.name)));
  if (visaMaster) return visaMaster.id;
  const intl = cards.find((c) => c.klass === 'INTERNATIONAL');
  return (intl ?? cards[0]).id;
}

export type DetectedScheme = 'INTERNATIONAL' | 'DOMESTIC';
export interface CardDetection { scheme: DetectedScheme | null; bin6: string | null }

// BIN (6 số đầu PAN, thẻ Napas nội địa) đã biết thuộc CHÍNH ngân hàng (on-us) — dùng để tách "thẻ nội địa của
// CHÍNH bank (ONUS)" khỏi "thẻ Napas ngân hàng khác (NAPAS)" trên POS của bank đó. Keyed theo MÃ ngân hàng
// (banks.code trong DB). Nguồn: dải BIN thẻ chip nội địa Napas công bố (mỗi ngân hàng 1 tiền tố 9704xx).
//
// ⚠️ MONEY-SENSITIVE (cấm suy luận value): CHỈ giá trị MB=970422 đã Admin Demo dùng thực tế. Các bank khác điền
// theo BIN Napas công bố NHƯNG CẦN Admin Demo xác nhận trước khi bật POS+phí cho bank đó; nhận-diện chỉ PRE-CHỌN
// (đại lý sửa được) nên sai BIN không ghi tiền sai, chỉ chọn nhầm mặc định. 2 mã CHƯA rõ để TRỐNG (chờ xác nhận):
//   - 'MBV' (#14 "MBV"): chưa rõ là ngân hàng nào → chưa gán BIN.
// Admin Demo 21/8 (xác nhận trực tiếp): 'SCB' hệ thống này = SACOMBANK → 970403 (Sài Gòn Thương Tín, KHÔNG phải
// Saigon Commercial 970429). 'MBV' = Ngân hàng Việt Nam Hiện Đại (OceanBank/Đại Dương cũ, đổi tên 18/12/2024) →
// BIN 970414 (thẻ OceanBank giữ nguyên sau đổi tên).
export const ONUS_BINS_BY_BANK: Record<string, string[]> = {
  MB: ['970422'],   // MBBank (đã xác nhận thực tế)
  MBV: ['970414'],  // Việt Nam Hiện Đại (OceanBank cũ)
  ABB: ['970425'],  // ABBANK
  BVB: ['970454'],  // Bản Việt / BVBank
  EIB: ['970431'],  // Eximbank
  HDB: ['970437'],  // HDBank
  VIB: ['970441'],  // VIB (Ngân hàng Quốc tế)
  VP: ['970432'],   // VPBank
  SCB: ['970403']   // Sacombank (Sài Gòn Thương Tín)
};

// AID (EMV Application Identifier) — quốc tế: Visa A0000000031010, Mastercard A0000000041010 (và A00000000410...),
// Amex A00000002501, JCB A0000000651010; nội địa Napas: A000000727... . Chỉ cần khớp TIỀN TỐ đủ phân nhóm.
// Dung sai SỐ LƯỢNG số 0 giữa RID (OCR/bill in khác nhau 6–8 số 0): khớp phần ĐỊNH DANH scheme sau dải 0.
// Visa=…3101(0), Mastercard=…4101(0), Amex=…2501, JCB=…6510(10); Napas nội địa=…727/725.
const AID_INTERNATIONAL = /A0{4,}(3101|4101|2501|6510)/;
const AID_DOMESTIC_NAPAS = /A0{4,}72[57]/;

/** Nhận diện scheme + BIN từ các dòng OCR của bill (best-effort). Ưu tiên: từ khóa scheme/AID → BIN. Không thấy
 * gì → {scheme:null,bin6:null} (rơi về mặc định). KHÔNG bao giờ ném lỗi (đúng nguyên tắc extractBillFields). */
export function detectCardFromOcr(lines: { text: string }[]): CardDetection {
  let bin6: string | null = null;
  let scheme: DetectedScheme | null = null;
  for (const ln of lines) {
    const s = stripDiacriticsUpper(ln.text);
    if (scheme == null) {
      if (AID_INTERNATIONAL.test(s) || /\b(VISA|MASTER(CARD)?|JCB|AMEX|UNIONPAY)\b/.test(s)) scheme = 'INTERNATIONAL';
      else if (AID_DOMESTIC_NAPAS.test(s) || /\bNAPAS\b/.test(s)) scheme = 'DOMESTIC';
    }
    if (bin6 == null) {
      // PAN THẬT trên bill LUÔN bị CHE (PCI): "4786 68** **** 0625" / "970422******1234" / "4030-****". CHỈ bắt BIN
      // khi có ≥6 CHỮ SỐ liền (xen space/'-') NGAY TRƯỚC ký tự che ('*'/'x'/'X') — để KHÔNG nhận nhầm TID/số tiền/
      // số lô/số HĐ (đều là dãy số KHÔNG che) thành số thẻ (bug test bắt: "TID 53550077" → "535500"). Bill che <6 số
      // đầu (vd "4030-****") → không đủ BIN, rơi về scheme từ TỪ KHÓA (VISA...) hoặc mặc định.
      const m = /((?:\d[\s-]?){6,}?)[*xX]/.exec(s);
      if (m) {
        const digits = m[1].replace(/\D/g, '');
        if (digits.length >= 6) bin6 = digits.slice(0, 6);
      }
    }
  }
  // Suy scheme từ BIN nếu chưa có từ khóa: Visa(4)/MC(5,2x)=quốc tế; 9704xx=Napas nội địa (isNapasBin — dải
  // thẻ nội địa Napas, kể cả bank mới chưa có tên trong thư viện).
  if (scheme == null && bin6) {
    if (isNapasBin(bin6)) scheme = 'DOMESTIC';
    else if (/^4/.test(bin6) || /^5[1-5]/.test(bin6) || /^2[2-7]/.test(bin6)) scheme = 'INTERNATIONAL';
  }
  return { scheme, bin6 };
}

/** Từ nhận-diện (scheme/BIN) + danh sách thẻ của bank + MÃ bank → loại thẻ NÊN chọn sẵn. INTERNATIONAL → thẻ
 * INTERNATIONAL; DOMESTIC + BIN thuộc on-us của bank → thẻ ONUS; DOMESTIC khác → thẻ NAPAS. Không đủ tin → null
 * (caller dùng mặc định). */
export function resolveDetectedCardTypeId(cards: CardOption[], bankCode: string | null, det: CardDetection): number | null {
  if (det.scheme == null) return null;
  if (det.scheme === 'INTERNATIONAL') return cards.find((c) => c.klass === 'INTERNATIONAL')?.id ?? null;
  // DOMESTIC:
  const onusBins = bankCode ? (ONUS_BINS_BY_BANK[bankCode.toUpperCase()] ?? []) : [];
  if (det.bin6 && onusBins.includes(det.bin6)) return cards.find((c) => c.klass === 'ONUS')?.id ?? null;
  return cards.find((c) => c.klass === 'NAPAS')?.id ?? null;
}
