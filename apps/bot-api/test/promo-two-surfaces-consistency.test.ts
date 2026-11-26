// [Admin Demo 12/9 "kiểm chứng đồng nhất 2 nơi"] KM trên SIGMA (bot-api) vs QUẢN LÝ SIGMA (quanly-api) phải
// ĐỒNG NHẤT. 2 lớp khoá:
//   (1) CẤU TRÚC: cả 2 route module cùng trỏ CHÍNH XÁC 1 bộ hàm @sigma/services (identity check — sửa 1 nơi
//       dùng hàm khác/copy là ĐỎ ngay).
//   (2) HÀNH VI trên DB THẬT: tạo qua "phía SigMa" → đọc ra y hệt ở "phía Quản Lý" từng trường; TẮT ở phía
//       Quản Lý → phía SigMa thấy tắt; xoá → cả 2 hết thấy. (2 ctx ĐỘC LẬP mô phỏng 2 surface, cùng bảng.)
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAlphaExtraSchema, listPromoPrograms, setPromoProgram, deletePromoProgram } from '@sigma/services';
import type { AuthUser } from '@sigma/shared';
import { getBotDb } from '../src/db.js';
import { makeBank, makeCardType } from './fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const user = (id: number, name: string): AuthUser => ({ id, username: name, fullName: name, status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions: ['CONFIG_FEE_VIEW', 'CONFIG_FEE_MANAGE'] });

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('đồng nhất KM 2 nơi', () => {
  it('(1) CẤU TRÚC: bot-api route + quanly-api route cùng import list/set/deletePromoProgram từ @sigma/services (không copy công thức)', () => {
    const botSrc = readFileSync(join(HERE, '..', 'src', 'routes', 'promo-programs.ts'), 'utf8');
    const qlSrc = readFileSync(join(HERE, '..', '..', 'quanly-api', 'src', 'routes', 'qr-fee-config.ts'), 'utf8');
    for (const fn of ['listPromoPrograms', 'setPromoProgram', 'deletePromoProgram']) {
      expect(botSrc, `bot-api phải dùng ${fn} từ services`).toContain(fn);
      expect(qlSrc, `quanly-api phải dùng ${fn} từ services`).toContain(fn);
    }
    expect(botSrc).toContain("from '@sigma/services'");
    expect(qlSrc).toContain("from '@sigma/services'");
    // Không nơi nào tự viết SQL promo_sell_adjust trong route (1 nguồn công thức ở services).
    expect(botSrc).not.toContain('promo_sell_adjust');
    expect(qlSrc).not.toContain('promo_sell_adjust');
  });

  it('(2) HÀNH VI DB thật: tạo phía SigMa → phía Quản Lý đọc y hệt; tắt phía Quản Lý → SigMa thấy tắt; xoá → cả 2 hết', async () => {
    const db = getBotDb();
    const bank = await makeBank();
    const card = await makeCardType(bank.id);
    const ctxSigMa = { db, user: user(9001, 'sigma-owner') };
    const ctxQuanLy = { db, user: user(9002, 'quanly-admin') };

    // Tạo từ "SigMa"
    const tao = await setPromoProgram(ctxSigMa, { kenh: 'POS', cardTypeId: card.id, deltaPct: 0.07, fromDate: '2026-09-15', toDate: '2026-09-20', lich: 'WEEKEND' });
    expect(tao.ok).toBe(true);
    const id = tao.ok ? tao.id! : 0;

    // "Quản Lý" đọc — phải thấy Y HỆT từng trường
    const benQl = await listPromoPrograms(ctxQuanLy);
    const rQl = benQl.data!.find((x) => x.id === id)!;
    expect(rQl).toBeTruthy();
    expect(rQl.kenh).toBe('POS');
    expect(rQl.cardTypeId).toBe(card.id);
    expect(rQl.deltaPct).toBe(0.07);
    expect(rQl.lich).toBe('WEEKEND');
    expect(rQl.enabled).toBe(true);

    // "Quản Lý" TẮT → "SigMa" đọc phải thấy TẮT
    const tat = await setPromoProgram(ctxQuanLy, { id, kenh: 'POS', cardTypeId: card.id, deltaPct: 0.07, fromDate: '2026-09-15', toDate: '2026-09-20', lich: 'WEEKEND', enabled: false });
    expect(tat.ok).toBe(true);
    const benAl = await listPromoPrograms(ctxSigMa);
    expect(benAl.data!.find((x) => x.id === id)!.enabled).toBe(false);

    // Xoá từ "SigMa" → cả 2 hết thấy
    const xoa = await deletePromoProgram(ctxSigMa, id);
    expect(xoa.ok).toBe(true);
    expect((await listPromoPrograms(ctxQuanLy)).data!.some((x) => x.id === id)).toBe(false);
    expect((await listPromoPrograms(ctxSigMa)).data!.some((x) => x.id === id)).toBe(false);
  });
});
