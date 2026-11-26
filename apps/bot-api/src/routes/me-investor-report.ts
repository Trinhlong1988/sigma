// DOANH SỐ NHÀ ĐẦU TƯ cho SigMa (Admin Demo 26/8: "SigMa phải có doanh số NĐT + nút tải, cả APK+PC").
// Ai là THÀNH VIÊN nhóm chat của 1 NĐT (kể cả đại lý) đều xem được doanh số NĐT đó — access control THẬT ở
// `agentScopeInvestorIds` (thành viên nhóm → investorChatGroup → investorId), KHÔNG nhận investorId tùy ý từ client.
// Số liệu TÁI DÙNG investorDailyReport/investorReportDetail (@sigma/services) — nguồn tiền DUY NHẤT, KHÔNG tính lại.
// Excel dùng buildInvestorDetailWorkbook DÙNG CHUNG với desktop (packages/services) — cùng format.
import { Router } from 'express';
import { requireSession } from '../session-middleware.js';
import { getBotDb } from '../db.js';
import { asyncHandler } from '../async-handler.js';
import { agentScopeInvestorIds } from '../agent-tid-scope.js';
import { verifyBillEditPassword } from '../bill-edit-password-service.js';
import { editInvestorAdvanceParams } from '../investor-advance-ingest.js';
import { buildInvestorAdvanceBillReport } from '../investor-advance-bill-report.js';
import { investorDailyReport, investorReportDetail, buildInvestorDetailWorkbook, investorDailySettlement, listAdvances, sumAdvancesByInvestors, sumRepaymentsByInvestors } from '@sigma/services';
import { qrSplitByInvestor } from '../investor-qr-split.js';
import type { AuthUser } from '@sigma/shared';

export const meInvestorReportRouter = Router();

// User tổng hợp có REVENUE_VIEW để qua gate nội bộ của service. Access control THẬT = agentScopeInvestorIds (thành
// viên nhóm), KHÔNG phải quyền User — CÙNG khuôn dealer KPI (bot-api scope theo nhóm, không theo permission User).
const SYS_USER: AuthUser = { id: 0, username: 'sigma', fullName: 'SigMa', status: 'ACTIVE', forceChangePassword: false, roles: [], permissions: ['REVENUE_VIEW', 'INVESTOR_VIEW'] };

/** Biên instant của 'YYYY-MM-DD' theo ngày LOCAL server (HCM) + offsetDays — cho qrSplitByInvestor. */
function parseLocalDayBound(day: string, offsetDays = 0): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + offsetDays, 0, 0, 0);
}

/** Ngày LOCAL 'YYYY-MM-DD' (bound theo ngày local như investorDailyReport). */
function localToday(): string {
  return localDateStr(new Date());
}
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Lọc TID/ngân hàng/HKD từ query (Admin Demo 27/8) — thu hẹp trong phạm vi uỷ NĐT. Rỗng = không lọc. */
function parseFilters(req: import('express').Request): { bankId?: number; tidId?: number; hkdName?: string; ca?: 1 | 2 | 3 } {
  const out: { bankId?: number; tidId?: number; hkdName?: string; ca?: 1 | 2 | 3 } = {};
  const bankId = Number(req.query.bankId); if (Number.isInteger(bankId) && bankId > 0) out.bankId = bankId;
  const tidId = Number(req.query.tidId); if (Number.isInteger(tidId) && tidId > 0) out.tidId = tidId;
  const hkd = req.query.hkdName; if (typeof hkd === 'string' && hkd.trim() !== '') out.hkdName = hkd.trim();
  // [Admin Demo — CA TIỀN 1/2/3] theo giờ tổng kết bill + bảng mốc ngân hàng (ca-tien.ts). Giá trị lạ → bỏ (không lọc).
  const ca = Number(req.query.ca); if (ca === 1 || ca === 2 || ca === 3) out.ca = ca;
  return out;
}

/** Liệt kê các NGÀY 'YYYY-MM-DD' từ from tới to (bao gồm) — để gọi báo cáo theo TỪNG ngày (mỗi ngày 1 sheet, đúng biên SQL). */
function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  const e = new Date(`${to}T00:00:00`);
  for (const d = new Date(`${from}T00:00:00`); d <= e; d.setDate(d.getDate() + 1)) days.push(localDateStr(d));
  return days;
}

/** Doanh số NHÀ ĐẦU TƯ của 1 PHÒNG chat (Admin Demo 27/8: "mở nhóm NĐT → Doanh số phải hiện doanh số NĐT"). Nếu
 *  phòng là nhóm NĐT (investor_chat_groups) VÀ người gọi ở phạm vi (thành viên nhóm) → trả tóm tắt; else undefined. */
export async function roomInvestorRevenue(db: ReturnType<typeof getBotDb>, agentId: number, roomId: string, from: Date, to: Date):
  Promise<{ investorId: number; investorName: string; from: string; to: string; doanhThu: number; tienVe: number; laiNDT: number; soBill: number; tamUng: number; daHoan: number; qr?: { gross: number; phiMuaGiu: number; traAlpha: number; soBill: number; tvTrongReport: number; laiTrongReport: number } } | undefined> {
  const grp = await db.investorChatGroup.findFirst({ where: { roomId, unassignedAt: null }, select: { investorId: true } });
  if (!grp) return undefined; // không phải nhóm NĐT
  const scoped = await agentScopeInvestorIds(db, agentId);
  if (!scoped.includes(grp.investorId)) return undefined; // an toàn: không ở nhóm thì không trả
  // [Admin Demo 27/9 "chọn ngày hôm qua → ra vẫn sai" + "sao lô 27 nhảy vào ngày 26"] BIÊN KỲ: client gửi khoảng
  // NỬA MỞ [from, to) — "Hôm qua" = [00:00 ngày 26, 00:00 ngày 27). Nhưng investorDailyReport/sumAdvances...
  // nhận chuỗi ngày kiểu BAO GỒM CẢ HAI ĐẦU. Lấy thẳng localDateStr(to) ⇒ toDay = "2026-09-27" ⇒ báo cáo gộp
  // LUÔN ngày 27 vào bảng "hôm qua" (đo thật: 78 bill / 4,21 tỷ cho khoảng 20→27 khi client chỉ xin 1 ngày).
  // Ngày cuối THỰC của kỳ = ngày của thời điểm ngay TRƯỚC `to`.
  const fromDay = localDateStr(from), toDay = localDateStr(new Date(to.getTime() - 1));
  const rep = await investorDailyReport({ db, user: SYS_USER }, { from: fromDay, to: toDay });
  const row = (rep.data ?? []).find((r) => r.investorId === grp.investorId);
  if (!row) return undefined;
  // [Admin Demo 13/9] + TẠM ỨNG trong kỳ (nguồn duy nhất sumAdvancesByInvestors — cùng settlement) →
  // phòng chat NĐT hiện "Phải hoàn về = tạm ứng − tiền về + lãi".
  let tamUng = 0, daHoan = 0;
  try {
    const adv = await sumAdvancesByInvestors({ db, user: SYS_USER }, { investorIds: [grp.investorId], from: fromDay, to: toDay });
    if (adv.ok && adv.totals) tamUng = Number(adv.totals.get(grp.investorId) ?? 0n);
    // [Admin Demo 13/9 "phải có ô đã hoàn về"] SigMa ĐÃ HOÀN về NĐT trong kỳ (source='REPAYMENT') — cùng nguồn settlement.
    const rep2 = await sumRepaymentsByInvestors({ db, user: SYS_USER }, { investorIds: [grp.investorId], from: fromDay, to: toDay });
    if (rep2.ok && rep2.totals) daHoan = Number(rep2.totals.get(grp.investorId) ?? 0n);
  } catch (e) { console.error('[room-investor] tính tạm ứng/đã hoàn lỗi (=0, không chặn):', e instanceof Error ? e.message : e); }
  // [Admin Demo 13/9 "tách riêng QR"] phần QR của NĐT (trả theo phí mua, không tạm ứng) — client trừ khỏi ô tạm ứng.
  let qrPart: { gross: number; phiMuaGiu: number; traAlpha: number; soBill: number; tvTrongReport: number; laiTrongReport: number } | undefined;
  try {
    const qr = await qrSplitByInvestor(db, from, to);
    const q = qr.get(grp.investorId);
    if (q && q.gross > 0) qrPart = { gross: q.gross, phiMuaGiu: q.partner, traAlpha: q.traAlpha, soBill: q.soBill, tvTrongReport: q.tvTrongReport, laiTrongReport: q.laiTrongReport };
  } catch (e) { console.error('[room-investor] tách QR lỗi (bỏ khối QR, không chặn):', e instanceof Error ? e.message : e); }
  return { investorId: row.investorId, investorName: row.investorName, from: fromDay, to: toDay, doanhThu: row.doanhThu, tienVe: row.tienVe, laiNDT: row.laiNDT, soBill: row.soBill, tamUng, daHoan, qr: qrPart };
}
const MAX_RANGE_DAYS = 366;
/** Xác định kỳ [from,to] từ query. Thiếu → hôm nay. Có tham số nhưng SAI định dạng/khoảng → gửi 400 + trả null
 *  (KHÔNG nuốt lỗi rơi về mặc định — R198). Mặc định from=to nếu chỉ có to. */
function resolveRange(req: import('express').Request, res: import('express').Response): { from: string; to: string } | null {
  const parse = (v: unknown): string | null | false => {
    if (v == null || v === '') return null; // vắng → dùng mặc định
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : false; // sai → false
  };
  const tP = parse(req.query.to), fP = parse(req.query.from);
  if (tP === false || fP === false) { res.status(400).json({ error: 'VALIDATION', message: 'Ngày phải dạng YYYY-MM-DD.' }); return null; }
  const to = tP ?? localToday();
  const from = fP ?? to;
  if (from > to) { res.status(400).json({ error: 'VALIDATION', message: 'Từ ngày phải ≤ đến ngày.' }); return null; }
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_RANGE_DAYS) { res.status(400).json({ error: 'VALIDATION', message: `Khoảng tối đa ${MAX_RANGE_DAYS} ngày.` }); return null; }
  return { from, to };
}

// GET /v1/me/investor-report?from=&to= — danh sách NĐT mà người đăng nhập được xem (qua thành viên nhóm) + doanh thu/lãi.
meInvestorReportRouter.get(
  '/v1/me/investor-report',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    const range = resolveRange(req, res);
    if (!range) return;
    const { from, to } = range;
    const scoped = await agentScopeInvestorIds(db, req.agent!.id);
    if (scoped.length === 0) { res.json({ from, to, investors: [] }); return; }
    const rep = await investorDailyReport({ db, user: SYS_USER }, { from, to, ...parseFilters(req) });
    if (!rep.ok) { res.status(400).json({ error: rep.error ?? 'ERROR', message: rep.message ?? 'Không tính được báo cáo.' }); return; }
    // [Admin Demo 13/9 "tách riêng QR"] gắn phần QR per NĐT (trả theo phí mua, không tạm ứng) — màn Doanh số NĐT
    // dùng để (a) trừ QR khỏi ô "phải hoàn về" (b) hiện ô "NĐT trả SigMa (QR)". Lỗi tách → bỏ, không chặn báo cáo.
    let qrMap = new Map<number, { gross: number; phiMuaGiu: number; traAlpha: number; soBill: number; tvTrongReport: number; laiTrongReport: number }>();
    try {
      const f = parseLocalDayBound(from), t = parseLocalDayBound(to, 1);
      if (f && t) {
        const qr = await qrSplitByInvestor(db, f, t);
        qrMap = new Map([...qr.entries()].map(([k, q]) => [k, { gross: q.gross, phiMuaGiu: q.partner, traAlpha: q.traAlpha, soBill: q.soBill, tvTrongReport: q.tvTrongReport, laiTrongReport: q.laiTrongReport }]));
      }
    } catch (e) { console.error('[me-investor-report] tách QR lỗi (bỏ, không chặn):', e instanceof Error ? e.message : e); }
    const investors = (rep.data ?? []).filter((r) => scoped.includes(r.investorId)).map((r) => ({ ...r, qr: qrMap.get(r.investorId) ?? null }));
    res.json({ from, to, investors });
  })
);

// GET /v1/me/investor-settlement?from=&to= — ĐỐI SOÁT TẠM ỨNG cho NĐT TỰ XEM (Admin Demo 31/8: "nhà đầu tư xem được
// đối soát tạm ứng của mình, không xem của đại lý"). TÁI DÙNG investorDailySettlement (phải trả = tạm ứng − tiền về
// + lãi, GIỮ DẤU). Scope THẬT = agentScopeInvestorIds (NĐT của chính user) — CHỈ trả NĐT mình, KHÔNG lộ NĐT/đại lý khác.
meInvestorReportRouter.get(
  '/v1/me/investor-settlement',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    const range = resolveRange(req, res);
    if (!range) return;
    const { from, to } = range;
    const scoped = await agentScopeInvestorIds(db, req.agent!.id);
    if (scoped.length === 0) { res.json({ from, to, rows: [] }); return; }
    const r = await investorDailySettlement({ db, user: SYS_USER }, { from, to, ...parseFilters(req) });
    if (!r.ok) { res.status(400).json({ error: r.error ?? 'ERROR', message: r.message ?? 'Không tính được đối soát tạm ứng.' }); return; }
    const rows = (r.data ?? []).filter((x) => scoped.includes(x.investorId)); // CHỈ NĐT của user (chống lộ NĐT khác)
    res.json({ from, to, rows });
  })
);

// GET /v1/me/investor-advances?investorId=&from=&to= — [Admin Demo 4/9] DANH SÁCH TỪNG GIAO DỊCH TẠM ỨNG của 1 NĐT
// (ngày·giờ·số tiền·người ứng/nhận·nội dung) — như list bill hoàn của đại lý. Scope: investorId PHẢI thuộc NĐT user
// xem được (agentScopeInvestorIds) → chống lộ NĐT khác. TÁI DÙNG core listAdvances (nguồn tiền duy nhất, KHÔNG tính lại).
meInvestorReportRouter.get(
  '/v1/me/investor-advances',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    const range = resolveRange(req, res);
    if (!range) return;
    const { from, to } = range;
    const investorId = Number(req.query.investorId);
    if (!Number.isInteger(investorId) || investorId <= 0) { res.status(400).json({ error: 'VALIDATION', message: 'investorId không hợp lệ.' }); return; }
    const scoped = await agentScopeInvestorIds(db, req.agent!.id);
    if (!scoped.includes(investorId)) { res.status(403).json({ error: 'FORBIDDEN', message: 'Không có quyền xem NĐT này.' }); return; }
    const r = await listAdvances({ db, user: SYS_USER }, { investorId, from, to });
    if (!r.ok) { res.status(400).json({ error: r.error ?? 'ERROR', message: r.message ?? 'Không lấy được danh sách tạm ứng.' }); return; }
    res.json({ from, to, investorId, advances: r.data ?? [] });
  })
);

// GET /v1/me/investor-advance-bills?investorId=&from=&to= — [Admin Demo 17/9 "DANH SÁCH BILL CK CỦA NĐT OCR RA ĐÂU?
// SAO THIẾU?"] BẢNG ĐỐI SOÁT bill CK đã OCR ⇄ dòng tiền đã ghi. Bill không ghép được dòng nào = tiền đang RƠI →
// hiện ĐỎ + tổng LỆCH (chính ca nhà Trung mất 1,2 tỷ mà hệ im lặng). Scope như /v1/me/investor-advances.
meInvestorReportRouter.get(
  '/v1/me/investor-advance-bills',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    const range = resolveRange(req, res);
    if (!range) return;
    const { from, to } = range;
    const investorId = Number(req.query.investorId);
    if (!Number.isInteger(investorId) || investorId <= 0) { res.status(400).json({ error: 'VALIDATION', message: 'investorId không hợp lệ.' }); return; }
    const scoped = await agentScopeInvestorIds(db, req.agent!.id);
    if (!scoped.includes(investorId)) { res.status(403).json({ error: 'FORBIDDEN', message: 'Không có quyền xem NĐT này.' }); return; }
    // Biên NGÀY theo giờ HCM: from 00:00 (gồm) → hết ngày `to` (parseLocalDayBound(to,1) = 00:00 hôm sau, loại trừ).
    const f = parseLocalDayBound(from), t = parseLocalDayBound(to, 1);
    if (!f || !t) { res.status(400).json({ error: 'VALIDATION', message: 'Không dựng được mốc ngày.' }); return; }
    const data = await buildInvestorAdvanceBillReport(db, investorId, f, t);
    res.json(data);
  })
);

// POST /v1/me/investor-advances/edit — [Nợ C3 11/9] SỬA ngày/giờ/tiền 1 khoản tạm ứng/hoàn NĐT. Gate: mật khẩu
// sửa bill (verifyBillEditPassword, mặc định 1111 — cùng khuôn sửa bill POS/CK) + scope: NĐT của dòng phải thuộc
// nhóm người gọi (agentScopeInvestorIds) — chống sửa NĐT người khác.
meInvestorReportRouter.post(
  '/v1/me/investor-advances/edit',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    const advanceId = Number(req.body?.advanceId);
    if (!Number.isInteger(advanceId) || advanceId <= 0) { res.status(400).json({ error: 'VALIDATION', message: 'advanceId không hợp lệ.' }); return; }
    if (!(await verifyBillEditPassword(db, String(req.body?.editPassword ?? '')))) { res.status(403).json({ error: 'BAD_PASSWORD', message: 'Sai mật khẩu sửa.' }); return; }
    const own = await db.$queryRawUnsafe<{ investor_id: number }[]>(`SELECT investor_id FROM investor_advances WHERE id = $1 AND deleted_at IS NULL`, advanceId);
    if (!own[0]) { res.status(404).json({ error: 'NOT_FOUND', message: 'Không tìm thấy khoản tạm ứng/hoàn.' }); return; }
    const scoped = await agentScopeInvestorIds(db, req.agent!.id);
    if (!scoped.includes(own[0].investor_id)) { res.status(403).json({ error: 'FORBIDDEN', message: 'Không có quyền sửa NĐT này.' }); return; }
    const patch = {
      advanceDate: typeof req.body?.advanceDate === 'string' ? req.body.advanceDate : undefined,
      advanceTime: typeof req.body?.advanceTime === 'string' ? req.body.advanceTime : undefined,
      amount: req.body?.amount != null ? Number(req.body.amount) : undefined
    };
    const r = await editInvestorAdvanceParams(db, { advanceId, patch });
    if (!r.ok) { res.status(r.error === 'NOT_FOUND' ? 404 : 400).json({ error: r.error, message: r.message }); return; }
    res.json({ ok: true, data: r });
  })
);

// GET /v1/me/investor-report/filter-options — TID + ngân hàng của các NĐT người dùng xem được (cho dropdown lọc, Admin Demo 27/8).
meInvestorReportRouter.get(
  '/v1/me/investor-report/filter-options',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    const scoped = await agentScopeInvestorIds(db, req.agent!.id);
    if (scoped.length === 0) { res.json({ tids: [], banks: [] }); return; }
    const ras = await db.receiveAccount.findMany({ where: { investorId: { in: scoped }, deletedAt: null }, select: { id: true } });
    const raIds = ras.map((r) => r.id);
    if (raIds.length === 0) { res.json({ tids: [], banks: [] }); return; }
    const tids = await db.tid.findMany({
      where: { receiveAccountId: { in: raIds }, deletedAt: null },
      select: { id: true, tid: true, hkdName: true, bankId: true },
      orderBy: [{ bankId: 'asc' }, { tid: 'asc' }]
    });
    const bankIds = [...new Set(tids.map((t) => t.bankId).filter((x): x is number => x != null))];
    const banks = bankIds.length > 0 ? await db.bank.findMany({ where: { id: { in: bankIds } }, select: { id: true, name: true } }) : [];
    const bankName = new Map(banks.map((b) => [b.id, b.name]));
    res.json({
      tids: tids.map((t) => ({ id: t.id, tid: t.tid, hkdName: t.hkdName, bankId: t.bankId, bankName: t.bankId != null ? bankName.get(t.bankId) ?? null : null })),
      banks: banks.map((b) => ({ id: b.id, name: b.name }))
    });
  })
);

// GET /v1/me/investor-report/detail?investorId=&from=&to= — CHI TIẾT 1 NĐT dạng JSON (Admin Demo 31/8: "NĐT cũng phải
// hiện chi tiết đồng nhất như đại lý chứ sao chỉ có file excel"). TÁI DÙNG investorReportDetail (nguồn tiền DUY NHẤT,
// KHÔNG tính lại) — 1 call cho cả kỳ [from,to] (khác Excel gọi từng-ngày-1-sheet). Kiểm quyền theo nhóm như export.xlsx.
meInvestorReportRouter.get(
  '/v1/me/investor-report/detail',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    const investorId = Number(req.query.investorId);
    if (!Number.isInteger(investorId) || investorId < 1) { res.status(400).json({ error: 'VALIDATION', message: 'Thiếu investorId hợp lệ.' }); return; }
    const scoped = await agentScopeInvestorIds(db, req.agent!.id);
    if (!scoped.includes(investorId)) { res.status(403).json({ error: 'FORBIDDEN', message: 'Bạn không ở nhóm của nhà đầu tư này nên không xem được.' }); return; }
    const range = resolveRange(req, res);
    if (!range) return;
    const { from, to } = range;
    const r = await investorReportDetail({ db, user: SYS_USER }, { investorId, from, to, ...parseFilters(req) });
    if (!r.ok) { res.status(r.error === 'NOT_FOUND' ? 404 : 400).json({ error: r.error, message: r.message }); return; }
    res.json({ ok: true, data: r.data ?? null });
  })
);

// GET /v1/me/investor-report/export.xlsx?investorId=&from=&to= — TẢI Excel chi tiết 1 NĐT (phải trong phạm vi thành viên nhóm).
meInvestorReportRouter.get(
  '/v1/me/investor-report/export.xlsx',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    const investorId = Number(req.query.investorId);
    if (!Number.isInteger(investorId) || investorId < 1) { res.status(400).json({ error: 'VALIDATION', message: 'Thiếu investorId hợp lệ.' }); return; }
    const scoped = await agentScopeInvestorIds(db, req.agent!.id);
    if (!scoped.includes(investorId)) { res.status(403).json({ error: 'FORBIDDEN', message: 'Bạn không ở nhóm của nhà đầu tư này nên không tải được.' }); return; }
    const range = resolveRange(req, res);
    if (!range) return;
    const { from, to } = range;
    // MỖI NGÀY 1 SHEET (Admin Demo 27/8): gọi investorReportDetail theo TỪNG ngày (đúng biên SQL, không cắt JS lệch giờ)
    // → mảng data-mỗi-ngày → workbook nhiều sheet. Kỳ 1 ngày = 1 sheet.
    const filters = parseFilters(req);
    const perDay: NonNullable<Awaited<ReturnType<typeof investorReportDetail>>['data']>[] = [];
    let investorName = '';
    for (const day of enumerateDays(from, to)) {
      const r = await investorReportDetail({ db, user: SYS_USER }, { investorId, from: day, to: day, ...filters });
      if (!r.ok) { res.status(r.error === 'NOT_FOUND' ? 404 : 400).json({ error: r.error, message: r.message }); return; }
      if (r.data) { perDay.push(r.data); investorName = r.data.investorName; }
    }
    if (perDay.length === 0) { res.status(404).json({ error: 'NOT_FOUND', message: 'Không có dữ liệu nhà đầu tư trong kỳ.' }); return; }
    const buf = await buildInvestorDetailWorkbook(perDay);
    const safeName = (investorName || `NDT${investorId}`).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `NDT${investorId}`;
    const fileName = `BaoCaoNDT_${safeName}_${from.replace(/-/g, '')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  })
);
