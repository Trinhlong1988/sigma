// [Admin Demo 12/9] THƯ VIỆN BIN THẺ — "tra 6 số thẻ của mã BIN ra thẻ gì, ngân hàng gì như bincheck", SigMa dùng.
// OFFLINE hoàn toàn (số thẻ = nhạy cảm, CẤM gọi dịch vụ BIN ngoài): hãng thẻ nhận theo QUY TẮC PREFIX công khai
// (ISO/IEC 7812 — Visa/Mastercard/JCB/Amex/UnionPay/NAPAS); NGÂN HÀNG tra bảng bin_library (seed BIN NAPAS công
// khai chắc chắn + người SigMa BỔ SUNG DẦN khi gặp BIN mới — "xây dựng thư viện"). Chỉ nhận 6-8 chữ số đầu.

import type { Db } from '@sigma/database';

export interface BinInfo {
  bin: string;
  brand: string | null; // hãng thẻ theo prefix (Visa/Mastercard/JCB/…)
  bankName: string | null; // từ thư viện; null = chưa có trong thư viện
  cardType: string | null; // ghi ở thư viện (ghi nợ/tín dụng/nội địa…)
  note: string | null;
  source: 'LIBRARY' | 'RULE' | null; // LIBRARY = có dòng thư viện; RULE = chỉ đoán được hãng theo prefix
}

/** Hãng thẻ theo prefix — quy tắc CÔNG KHAI ổn định (không đoán ngân hàng ở đây). */
export function detectBrand(bin: string): string | null {
  const d = bin.replace(/\D/g, '');
  if (d.length < 2) return null;
  if (d.startsWith('9704')) return 'NAPAS (thẻ nội địa VN)';
  if (d.startsWith('4')) return 'Visa';
  const p2 = Number(d.slice(0, 2));
  const p4 = Number(d.slice(0, 4).padEnd(4, '0'));
  if (p2 >= 51 && p2 <= 55) return 'Mastercard';
  if (p4 >= 2221 && p4 <= 2720) return 'Mastercard';
  if (p4 >= 3528 && p4 <= 3589) return 'JCB';
  if (p2 === 34 || p2 === 37) return 'American Express';
  if (p2 === 62) return 'UnionPay';
  if (d.startsWith('6011') || p2 === 65 || (Number(d.slice(0, 3)) >= 644 && Number(d.slice(0, 3)) <= 649)) return 'Discover';
  if (p2 === 36 || p2 === 38 || Number(d.slice(0, 3)) === 300 || (Number(d.slice(0, 3)) >= 300 && Number(d.slice(0, 3)) <= 305)) return 'Diners Club';
  return null;
}

/** Chuẩn hoá input: chỉ chữ số, 6-8 ký tự đầu. <6 số → null (không tra mò). */
export function normalizeBin(raw: string): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length < 6) return null;
  return d.slice(0, 8);
}

/** Tra BIN: khớp thư viện DÀI NHẤT trước (8→7→6 số — BIN con cụ thể đè BIN gộp), kèm hãng theo prefix. */
export async function lookupBin(db: Pick<Db, '$queryRawUnsafe'>, rawBin: string): Promise<BinInfo | null> {
  const bin = normalizeBin(rawBin);
  if (!bin) return null;
  const candidates = [bin.slice(0, 8), bin.slice(0, 7), bin.slice(0, 6)].filter((x, i, a) => x.length >= 6 && a.indexOf(x) === i);
  const rows = await db.$queryRawUnsafe<Array<{ bin: string; bank_name: string; card_brand: string | null; card_type: string | null; note: string | null }>>(
    `SELECT bin, bank_name, card_brand, card_type, note FROM bin_library WHERE bin = ANY($1::text[]) AND deleted_at IS NULL ORDER BY length(bin) DESC LIMIT 1`,
    candidates
  );
  const brand = detectBrand(bin);
  const hit = rows[0];
  if (hit) return { bin: hit.bin, brand: hit.card_brand || brand, bankName: hit.bank_name, cardType: hit.card_type, note: hit.note, source: 'LIBRARY' };
  return { bin: bin.slice(0, 6), brand, bankName: null, cardType: null, note: null, source: brand ? 'RULE' : null };
}

/** Thêm/sửa 1 mục thư viện (người SigMa bổ sung dần). Upsert theo bin (unique khi còn sống). */
export async function upsertBinEntry(
  db: Pick<Db, '$queryRawUnsafe' | '$executeRawUnsafe'>,
  input: { bin: string; bankName: string; cardBrand?: string | null; cardType?: string | null; note?: string | null; actorAgentId?: number | null }
): Promise<{ ok: true; bin: string } | { ok: false; error: string; message: string }> {
  const bin = normalizeBin(input.bin);
  if (!bin || bin.length < 6) return { ok: false, error: 'VALIDATION', message: 'BIN phải là 6-8 CHỮ SỐ đầu thẻ.' };
  const bank = (input.bankName ?? '').trim();
  if (!bank) return { ok: false, error: 'VALIDATION', message: 'Thiếu tên ngân hàng.' };
  const cur = await db.$queryRawUnsafe<Array<{ id: number }>>(`SELECT id FROM bin_library WHERE bin = $1 AND deleted_at IS NULL`, bin);
  if (cur[0]) {
    await db.$executeRawUnsafe(
      `UPDATE bin_library SET bank_name=$1, card_brand=$2, card_type=$3, note=$4, updated_by=$5, updated_at=now() WHERE id=$6`,
      bank, input.cardBrand ?? detectBrand(bin), input.cardType ?? null, input.note ?? null, input.actorAgentId ?? null, cur[0].id);
  } else {
    await db.$executeRawUnsafe(
      `INSERT INTO bin_library (bin, bank_name, card_brand, card_type, note, source, created_by) VALUES ($1,$2,$3,$4,$5,'SIGMA_NHAP',$6)`,
      bin, bank, input.cardBrand ?? detectBrand(bin), input.cardType ?? null, input.note ?? null, input.actorAgentId ?? null);
  }
  return { ok: true, bin };
}

/** SEED BIN NAPAS nội địa CÔNG KHAI (danh mục thành viên NAPAS — chỉ các mục CHẮC CHẮN; thiếu thì SigMa bổ sung
 *  qua form, cấm nhồi mục không chắc). Idempotent (bỏ qua bin đã có). */
export const NAPAS_SEED: ReadonlyArray<{ bin: string; bank: string }> = [
  { bin: '970403', bank: 'Sacombank' },
  { bin: '970405', bank: 'Agribank' },
  { bin: '970407', bank: 'Techcombank' },
  { bin: '970415', bank: 'VietinBank' },
  { bin: '970416', bank: 'ACB' },
  { bin: '970418', bank: 'BIDV' },
  { bin: '970422', bank: 'MB Bank' },
  { bin: '970423', bank: 'TPBank' },
  { bin: '970426', bank: 'MSB' },
  { bin: '970427', bank: 'VietABank' },
  { bin: '970429', bank: 'SCB' },
  { bin: '970430', bank: 'PGBank' },
  { bin: '970431', bank: 'Eximbank' },
  { bin: '970432', bank: 'VPBank' },
  { bin: '970433', bank: 'VietBank' },
  { bin: '970436', bank: 'Vietcombank' },
  { bin: '970437', bank: 'HDBank' },
  { bin: '970438', bank: 'BaoViet Bank' },
  { bin: '970440', bank: 'SeABank' },
  { bin: '970441', bank: 'VIB' },
  { bin: '970443', bank: 'SHB' },
  { bin: '970448', bank: 'OCB' },
  { bin: '970449', bank: 'LPBank (LienVietPostBank)' },
  { bin: '970452', bank: 'KienlongBank' },
  { bin: '970454', bank: 'BVBank (Bản Việt)' }
];

export async function seedBinLibrary(db: Pick<Db, '$queryRawUnsafe' | '$executeRawUnsafe'>): Promise<number> {
  let added = 0;
  for (const e of NAPAS_SEED) {
    const cur = await db.$queryRawUnsafe<Array<{ id: number }>>(`SELECT id FROM bin_library WHERE bin = $1 AND deleted_at IS NULL`, e.bin);
    if (cur[0]) continue;
    await db.$executeRawUnsafe(
      `INSERT INTO bin_library (bin, bank_name, card_brand, card_type, source) VALUES ($1,$2,'NAPAS (thẻ nội địa VN)','Thẻ nội địa','NAPAS_CONG_KHAI')`,
      e.bin, e.bank);
    added++;
  }
  return added;
}
