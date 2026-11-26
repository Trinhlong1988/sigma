// [Agent-4 F6 — LEAD duyệt 12/9] cutoffWarnings phải bắn CẢ KHI KỲ NẰM TRỌN TRƯỚC MỐC CHỐT (vd xem tháng 8 của
// NĐT chốt 30/8: Tổng gộp đầy tiền, tất toán 0 — trước đây điều kiện `moc < to` bỏ sót ca này, người xem lệch mù).
// 2 chiều: kỳ sau mốc hoàn toàn → KHÔNG bắn (không cảnh báo oan).
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { buildAlphaAggregate } from '../src/routes/alpha-aggregate.js';

const uniq = (): number => 900000 + Math.floor(Math.random() * 90000);
const KEY = 'investor.clearCutoffs'; // = INVESTOR_CLEAR_CUTOFF_KEY (services/investor-clear.ts)

async function setCutoff(invId: number, day: string): Promise<void> {
  const db = getBotDb();
  const row = await db.appSetting.findUnique({ where: { key: KEY } });
  const obj = row?.value ? (JSON.parse(row.value) as Record<string, string>) : {};
  obj[String(invId)] = day;
  await db.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(obj) }, update: { value: JSON.stringify(obj) } });
}
async function clearCutoff(invId: number): Promise<void> {
  const db = getBotDb();
  const row = await db.appSetting.findUnique({ where: { key: KEY } });
  if (!row?.value) return;
  const obj = JSON.parse(row.value) as Record<string, string>;
  delete obj[String(invId)];
  await db.appSetting.update({ where: { key: KEY }, data: { value: JSON.stringify(obj) } });
}

describe('cutoffWarnings — kỳ trọn TRƯỚC mốc chốt (F6)', () => {
  it('kỳ nằm trọn TRƯỚC mốc → BẮN cảnh báo "SAU kỳ đang xem"', async () => {
    const inv = uniq();
    await setCutoff(inv, '2026-08-30');
    try {
      const r = await buildAlphaAggregate(new Date('2026-07-31T17:00:00Z'), new Date('2026-08-10T17:00:00Z'));
      const w = ((r as { cutoffWarnings?: string[] }).cutoffWarnings ?? []).filter((x) => x.includes(`#${inv} `) || x.includes(`#${inv}`));
      expect(w.length).toBe(1);
      expect(w[0]).toContain('SAU kỳ đang xem');
    } finally { await clearCutoff(inv); }
  });
  it('mốc trong kỳ → bắn "nằm trong kỳ" (hành vi cũ giữ nguyên)', async () => {
    const inv = uniq();
    await setCutoff(inv, '2026-08-05');
    try {
      const r = await buildAlphaAggregate(new Date('2026-07-31T17:00:00Z'), new Date('2026-08-10T17:00:00Z'));
      const w = ((r as { cutoffWarnings?: string[] }).cutoffWarnings ?? []).filter((x) => x.includes(`#${inv}`));
      expect(w.length).toBe(1);
      expect(w[0]).toContain('nằm trong kỳ');
    } finally { await clearCutoff(inv); }
  });
  it('kỳ nằm trọn SAU mốc → KHÔNG bắn (không cảnh báo oan)', async () => {
    const inv = uniq();
    await setCutoff(inv, '2026-07-01');
    try {
      const r = await buildAlphaAggregate(new Date('2026-07-31T17:00:00Z'), new Date('2026-08-10T17:00:00Z'));
      const w = ((r as { cutoffWarnings?: string[] }).cutoffWarnings ?? []).filter((x) => x.includes(`#${inv}`));
      expect(w.length).toBe(0);
    } finally { await clearCutoff(inv); }
  });
});
