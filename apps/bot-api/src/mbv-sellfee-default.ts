// [Admin Demo 6/9 — CHỐNG TÁI DIỄN "bill MBV lỗi NO_ACTUAL_SELL_FEE vì thiếu/không-hiệu-lực giá bán"]
// Chuẩn giá bán MẶC ĐỊNH ngân hàng MBV: thẻ NGOÀI (Visa) = 1.25%, Napas = 1.5% (Admin Demo chốt). Máy MBV nào THIẾU
// giá bán (không có override active cho card đó) → tự điền mặc định (hiệu lực từ ngày tạo máy) để bill KHÔNG rơi
// NO_ACTUAL_SELL_FEE. CHỈ ĐIỀN THIẾU — KHÔNG đè giá đã set tay (tôn trọng dealer có giá riêng). Idempotent.
// Chạy boot + 6h (index.ts) + khi tạo máy MBV. LOG LOUD nếu điền (surface — R198, không âm thầm).
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

export const MBV_BANK_CODE = 'MBV';
export const MBV_VISA_MILLI = 1250; // 1.25% — thẻ ngoài (Visa/Master)
export const MBV_NAPAS_MILLI = 1500; // 1.5% — Napas (nội địa)
const DEFAULT_FEE_TYPE_ID = 1; // loại phí mặc định (đầu theo id) — khớp quoteRow default

export interface MbvHealResult {
  scanned: number; // số máy MBV quét
  filled: number; // số DÒNG giá bán vừa điền (thiếu)
  details: string[]; // "tid card=Visa 1.25%" ...
}

/** Điền giá bán mặc định cho máy MBV còn THIẾU (không đè giá đã có). Trả thống kê. */
export async function ensureMbvDefaultSellFee(db: Db): Promise<MbvHealResult> {
  const bank = await db.bank.findFirst({ where: { code: MBV_BANK_CODE }, select: { id: true } });
  if (!bank) return { scanned: 0, filled: 0, details: [] };
  // Resolve card Visa / Napas theo TÊN (không hardcode id — bền khi seed khác máy).
  const cards = await db.cardType.findMany({ where: { bankId: bank.id, deletedAt: null }, select: { id: true, name: true } });
  const visa = cards.find((c) => /visa|master|thẻ ngoài/i.test(c.name));
  const napas = cards.find((c) => /napas/i.test(c.name));
  const targets: { cardId: number; milli: number; label: string }[] = [];
  if (visa) targets.push({ cardId: visa.id, milli: MBV_VISA_MILLI, label: 'Visa 1.25%' });
  if (napas) targets.push({ cardId: napas.id, milli: MBV_NAPAS_MILLI, label: 'Napas 1.5%' });
  if (targets.length === 0) return { scanned: 0, filled: 0, details: [] };

  const tids = await db.tid.findMany({ where: { bankId: bank.id, deletedAt: null }, select: { id: true, tid: true, createdAt: true } });
  let filled = 0;
  const details: string[] = [];
  for (const t of tids) {
    for (const tg of targets) {
      const existing = await db.tidSellFee.findFirst({
        where: { tidId: t.id, cardTypeId: tg.cardId, feeTypeId: DEFAULT_FEE_TYPE_ID, deletedAt: null },
        select: { id: true }
      });
      if (existing) continue; // ĐÃ có giá (tay hoặc trước) → KHÔNG đè.
      // Hiệu lực từ ngày tạo máy (phủ mọi bill của máy). effectiveFrom = Date object (KHÔNG chuỗi::timestamptz).
      await db.tidSellFee.create({ data: { tidId: t.id, cardTypeId: tg.cardId, feeTypeId: DEFAULT_FEE_TYPE_ID, phiBan: tg.milli, effectiveFrom: t.createdAt } });
      filled++;
      details.push(`${t.tid} ${tg.label}`);
    }
  }
  return { scanned: tids.length, filled, details };
}
