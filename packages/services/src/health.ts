// Quét sức khỏe hệ thống — LÕI THUẦN ctx-based (SERVER-OPS). PORT từ apps/desktop/src/main/health-scan.ts
// (Nhóm E). Chạy BỘ KIỂM TRA toàn vẹn dữ liệu → danh sách phát hiện (lỗi/bug) kèm ĐỀ XUẤT FIX + một số mục
// TỰ SỬA (autoFix). Thay requirePermission(current-user global) bằng ctx = { db, user }; tự kiểm quyền qua
// hasPermission. Server tự chạy trên máy chủ (chỉ đọc/ghi DB — không phụ thuộc ổ đĩa máy trạm).
//
// Bề mặt route:
//  • healthScan (R, STORAGE_VIEW)      → GET  /v1/health/scan  — quét READ-ONLY (collectFindings), KHÔNG persist.
//  • listHealthRuns (R, STORAGE_VIEW)  → GET  /v1/health/runs  — lịch sử bảo trì (maintenance_runs).
//  • runHealthScan (M, STORAGE_CLEANUP nếu autoFix, else STORAGE_VIEW) → POST /v1/health/run — quét + persist
//    1 MaintenanceRun (+ tùy chọn tự sửa, backup an toàn TRƯỚC khi ghi đè).
import { computeRevenue } from '@sigma/business-rules';
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { systemBackup } from './backup.js';
import { scanZeroPhiCaiMayCore } from './investor-report.js';
import type { ServiceCtx } from './customer.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

export type Severity = 'ERROR' | 'WARN' | 'INFO';

export interface Finding {
  code: string;
  severity: Severity;
  title: string;
  count: number;
  detail: string;
  suggestion: string;
  autoFixable: boolean;
  sampleIds?: number[];
}

async function idSet(model: { findMany: (a: { select: { id: true } }) => Promise<{ id: number }[]> }): Promise<Set<number>> {
  return new Set((await model.findMany({ select: { id: true } })).map((r) => r.id));
}

export interface CollectResult { findings: Finding[]; checksRun: number; }

/**
 * Bộ kiểm tra toàn vẹn — CHỈ ĐỌC (không sửa). Mỗi check bọc safe(name, fn): check nào ném lỗi → đẩy
 * CHECK_FAILED (ERROR) để LỘ ra (KHÔNG nuốt lỗi im — R198); checksRun đếm ĐỘNG số mục thực chạy.
 */
export async function collectFindings(db: Db): Promise<CollectResult> {
  const f: Finding[] = [];
  let checksRun = 0;
  const safe = async (name: string, fn: () => Promise<void>): Promise<void> => {
    checksRun++;
    try { await fn(); }
    catch (err) {
      // eslint-disable-next-line no-console
      console.error('[health-scan] check failed:', name, err);
      f.push({ code: 'CHECK_FAILED', severity: 'ERROR', title: `Không chạy được kiểm tra: ${name}`, count: 1, detail: `Mục "${name}" ném lỗi nên CHƯA hoàn tất — không thể khẳng định dữ liệu sạch ở phần này. Chi tiết: ${(err as Error).message}`, suggestion: 'Báo kỹ thuật (thường do truy vấn sai / lệch schema); coi như CHƯA kiểm tra tới khi chạy lại được.', autoFixable: false });
    }
  };

  const [tidIds, cardIds, custIds, partnerIds, bankIds] = await Promise.all([
    idSet(db.tid), idSet(db.cardType), idSet(db.customer), idSet(db.partner), idSet(db.bank)
  ]);

  const txns = await db.transaction.findMany({
    where: { deletedAt: null },
    select: { id: true, amount: true, tidId: true, cardTypeId: true, customerId: true, partnerMarginMilli: true, sellMarginMilli: true, revenuePartner: true, revenueSell: true, revenueAmount: true }
  });
  // [B297/F2 24/11 — agent phản biện] GD của LÔ NHIỀU THẺ cố ý lưu doanh thu = Σ per-thẻ (CHÍNH XÁC),
  // còn margin lưu là BÌNH QUÂN (xấp xỉ) — check #1 so theo margin sẽ báo ERROR OAN vĩnh viễn, và nút
  // "Tự sửa" sẽ GHI ĐÈ số đúng bằng số xấp xỉ (đo sổ thật: 5 GD, bịa thêm 1.477đ). Nhận diện multi-card
  // bằng install_fee_amount > 0 (cột raw, đọc 1 lần).
  const idsMulti = new Set<number>(
    (await db.$queryRawUnsafe<Array<{ id: number }>>(
      'SELECT id FROM transactions WHERE deleted_at IS NULL AND COALESCE(install_fee_amount, 0) > 0'
    )).map((r) => r.id)
  );

  // 1) ERROR — doanh thu không khớp công thức (bỏ GD multi-card — số per-thẻ mới là số đúng).
  await safe('doanh thu khớp công thức', async () => {
    const bad: number[] = [];
    for (const t of txns) {
      if (idsMulti.has(t.id)) continue; // [B297] multi-card: doanh thu Σ per-thẻ là chuẩn, margin trộn chỉ để hiển thị
      const exp = computeRevenue(Number(t.amount), t.partnerMarginMilli, t.sellMarginMilli);
      if (exp.revenuePartner !== Number(t.revenuePartner) || exp.revenueSell !== Number(t.revenueSell) || exp.revenueAmount !== Number(t.revenueAmount) || Number(t.revenueAmount) !== Number(t.revenuePartner) + Number(t.revenueSell)) bad.push(t.id);
    }
    if (bad.length) f.push({ code: 'REVENUE_MISMATCH', severity: 'ERROR', title: 'Doanh thu giao dịch không khớp công thức 2 khoản chênh', count: bad.length, detail: 'revenueAmount ≠ (chênh đối tác + chênh bán) hoặc lệch so với biểu phí snapshot đã lưu.', suggestion: 'Bấm "Tự sửa" để tính lại doanh thu từ 2 khoản chênh đã lưu trên từng giao dịch.', autoFixable: true, sampleIds: bad.slice(0, 10) });
  });

  // 1b) [B297/F8] ERROR — PHÍ của lô lệch với biên phí trên GD (lưới mà vụ lô 3775 lọt qua: tiền gốc
  // khớp nhưng PHÍ lệch 2.040đ). Lô 1 dòng: Σ fee_applied phải = marginToAmount(Σ trước, sell+pcm).
  // Lô nhiều dòng: GD phải mang install_fee_amount > 0 (không được là GD 1-thẻ đại diện).
  await safe('phí lô khớp biên phí giao dịch', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ lo_id: number; txn_id: number; n: number; truoc: string; fee: string; sm: number; pcm: number; install: string | null }>>(
      `SELECT l.id AS lo_id, t.id AS txn_id, count(r.id)::int AS n,
              COALESCE(sum(r.amount_before_fee),0)::text AS truoc, COALESCE(sum(r.fee_applied),0)::text AS fee,
              t.sell_margin_milli AS sm, t.phi_cai_may_milli AS pcm, t.install_fee_amount::text AS install
         FROM los l JOIN transactions t ON t.id = l.transaction_id AND t.deleted_at IS NULL
         JOIN lo_rows r ON r.lo_id = l.id
        WHERE l.status <> 'CANCELLED'
        GROUP BY l.id, t.id, t.sell_margin_milli, t.phi_cai_may_milli, t.install_fee_amount`);
    // CHỈ so CƠ CẤU, KHÔNG so phí-với-margin: đo DB thử cho thấy 506 lô QR/OCR cũ có biểu phí thật
    // khác snapshot GD một cách HỢP LỆ — so phí sẽ đỏ oan hàng loạt (L1). Lớp lỗi 3775/3726 đều lộ
    // qua cơ cấu: lô 1 dòng mà GD còn install per-thẻ, hoặc lô nhiều dòng mà GD kiểu 1-thẻ.
    const thieuMulti: number[] = [];
    for (const r of rows) {
      if (r.n === 1 && Number(r.install ?? 0) > 0) thieuMulti.push(r.lo_id);
      else if (r.n > 1 && Number(r.install ?? 0) <= 0) thieuMulti.push(r.lo_id);
    }
    if (thieuMulti.length) f.push({ code: 'LO_TXN_CARD_STRUCTURE_DIVERGED', severity: 'ERROR', title: 'Cơ cấu thẻ của lô lệch với giao dịch (multi-card chưa dựng lại)', count: thieuMulti.length, detail: 'Lô nhiều thẻ mà GD ghi kiểu 1-thẻ đại diện, hoặc lô 1 thẻ mà GD còn phí cài máy per-thẻ — tiền về NĐT đọc sai (lớp lô 3726/4072/3775).', suggestion: 'Báo kỹ thuật dựng lại GD bằng đường canonical cho các lô này — KHÔNG tự sửa tay.', autoFixable: false, sampleIds: thieuMulti.slice(0, 10) });
  });

  // 2) ERROR — số tiền giao dịch âm.
  await safe('số tiền giao dịch không âm', async () => {
    const bad = txns.filter((t) => t.amount < 0).map((t) => t.id);
    if (bad.length) f.push({ code: 'TXN_NEGATIVE_AMOUNT', severity: 'ERROR', title: 'Giao dịch có số tiền âm', count: bad.length, detail: 'Số tiền giao dịch phải ≥ 0.', suggestion: 'Kiểm tra & sửa lại số tiền, hoặc xóa giao dịch nhập sai.', autoFixable: false, sampleIds: bad.slice(0, 10) });
  });

  // 3) ERROR — giao dịch trỏ tới TID không tồn tại (orphan).
  await safe('giao dịch trỏ TID tồn tại', async () => {
    const bad = txns.filter((t) => !tidIds.has(t.tidId)).map((t) => t.id);
    if (bad.length) f.push({ code: 'TXN_ORPHAN_TID', severity: 'ERROR', title: 'Giao dịch trỏ tới TID không tồn tại', count: bad.length, detail: 'tid_id không còn bản ghi TID tương ứng.', suggestion: 'Phục hồi TID bị xóa hoặc gán lại giao dịch cho TID đúng.', autoFixable: false, sampleIds: bad.slice(0, 10) });
  });

  // 4) WARN — giao dịch trỏ tới khách/loại thẻ không tồn tại.
  await safe('giao dịch trỏ khách/loại thẻ tồn tại', async () => {
    const badCust = txns.filter((t) => t.customerId != null && !custIds.has(t.customerId)).map((t) => t.id);
    if (badCust.length) f.push({ code: 'TXN_ORPHAN_CUSTOMER', severity: 'WARN', title: 'Giao dịch trỏ tới khách hàng không tồn tại', count: badCust.length, detail: 'customer_id không còn bản ghi khách tương ứng.', suggestion: 'Gán lại khách đúng hoặc để trống (theo TID).', autoFixable: false, sampleIds: badCust.slice(0, 10) });
    const badCard = txns.filter((t) => t.cardTypeId != null && !cardIds.has(t.cardTypeId)).map((t) => t.id);
    if (badCard.length) f.push({ code: 'TXN_ORPHAN_CARDTYPE', severity: 'WARN', title: 'Giao dịch trỏ tới loại thẻ không tồn tại', count: badCard.length, detail: 'card_type_id không còn bản ghi loại thẻ.', suggestion: 'Gán lại loại thẻ hợp lệ cho giao dịch.', autoFixable: false, sampleIds: badCard.slice(0, 10) });
  });

  // REL-02 — WARN: trạng thái KHÔNG nằm trong danh mục StatusOption hợp lệ.
  await safe('trạng thái nằm trong danh mục', async () => {
    const opts = await db.statusOption.findMany({ where: { deletedAt: null }, select: { entity: true, code: true } });
    const validBy = new Map<string, Set<string>>();
    for (const o of opts) { if (!validBy.has(o.entity)) validBy.set(o.entity, new Set()); validBy.get(o.entity)!.add(o.code); }
    const checks: { entity: string; rows: { id: number; status: string }[] }[] = [
      { entity: 'CUSTOMER', rows: await db.customer.findMany({ where: { deletedAt: null }, select: { id: true, status: true } }) },
      { entity: 'BANK', rows: await db.bank.findMany({ where: { deletedAt: null }, select: { id: true, status: true } }) },
      { entity: 'PARTNER', rows: await db.partner.findMany({ where: { deletedAt: null }, select: { id: true, status: true } }) },
      { entity: 'POS_DEVICE', rows: await db.posDevice.findMany({ where: { deletedAt: null }, select: { id: true, status: true } }) }
    ];
    const bad: number[] = [];
    for (const c of checks) {
      const valid = validBy.get(c.entity);
      if (!valid || valid.size === 0) continue;
      for (const r of c.rows) if (r.status && !valid.has(r.status)) bad.push(r.id);
    }
    if (bad.length) f.push({ code: 'INVALID_STATUS', severity: 'WARN', title: 'Bản ghi có trạng thái không nằm trong danh mục', count: bad.length, detail: 'status không khớp StatusOption hợp lệ (gõ sai / import / sửa DB trực tiếp) → dễ bị lọc/báo cáo bỏ sót.', suggestion: 'Sửa lại trạng thái đúng, hoặc thêm mã vào danh mục nếu hợp lệ.', autoFixable: false, sampleIds: bad.slice(0, 10) });
  });

  // 5) WARN — biểu phí trỏ tới đối tác/loại thẻ không tồn tại.
  await safe('biểu phí trỏ đối tác/loại thẻ tồn tại', async () => {
    const rates = await db.feeRate.findMany({ where: { deletedAt: null }, select: { id: true, partnerId: true, cardTypeId: true } });
    const bad = rates.filter((r) => !partnerIds.has(r.partnerId) || !cardIds.has(r.cardTypeId)).map((r) => r.id);
    if (bad.length) f.push({ code: 'FEERATE_ORPHAN', severity: 'WARN', title: 'Biểu phí trỏ tới đối tác/loại thẻ không tồn tại', count: bad.length, detail: 'Bản ghi biểu phí tham chiếu đối tác hoặc loại thẻ đã bị xóa cứng.', suggestion: 'Xóa biểu phí mồ côi hoặc khôi phục đối tác/loại thẻ liên quan.', autoFixable: false, sampleIds: bad.slice(0, 10) });
  });

  // 6) WARN — TID trỏ tới đối tác/ngân hàng không tồn tại.
  await safe('TID trỏ đối tác/ngân hàng tồn tại', async () => {
    const tids = await db.tid.findMany({ where: { deletedAt: null }, select: { id: true, partnerId: true, bankId: true } });
    const bad = tids.filter((t) => (t.partnerId != null && !partnerIds.has(t.partnerId)) || (t.bankId != null && !bankIds.has(t.bankId))).map((t) => t.id);
    if (bad.length) f.push({ code: 'TID_ORPHAN_REF', severity: 'WARN', title: 'TID trỏ tới đối tác/ngân hàng không tồn tại', count: bad.length, detail: 'partner_id/bank_id của TID không còn bản ghi tương ứng.', suggestion: 'Cập nhật lại đối tác/ngân hàng cho TID trong Cấu hình TID.', autoFixable: false, sampleIds: bad.slice(0, 10) });
  });

  // 7) ERROR — không còn quản trị viên hoạt động (ADMIN active).
  await safe('còn quản trị viên hoạt động', async () => {
    const adminActive = await db.user.count({ where: { deletedAt: null, status: 'ACTIVE', roles: { some: { role: { code: 'ADMIN', status: 'ACTIVE' } } } } });
    if (adminActive === 0) f.push({ code: 'NO_ACTIVE_ADMIN', severity: 'ERROR', title: 'Không còn quản trị viên (ADMIN) hoạt động', count: 1, detail: 'Hệ thống phải luôn có ít nhất 1 tài khoản ADMIN đang hoạt động.', suggestion: 'Kích hoạt hoặc tạo lại một tài khoản ADMIN ngay.', autoFixable: false });
  });

  // 8) WARN — bản ghi trong thùng rác thiếu người xóa (deletedBy null).
  await safe('thùng rác có người xóa', async () => {
    const models: { name: string; m: { count: (a: { where: { deletedAt: { not: null }; deletedBy: null } }) => Promise<number> } }[] = [
      { name: 'customer', m: db.customer }, { name: 'tid', m: db.tid }, { name: 'transaction', m: db.transaction },
      { name: 'feeRate', m: db.feeRate }, { name: 'dossier', m: db.dossier }, { name: 'receiveAccount', m: db.receiveAccount }
    ];
    let total = 0;
    for (const { m } of models) { try { total += await m.count({ where: { deletedAt: { not: null }, deletedBy: null } }); } catch { /* bỏ */ } }
    if (total) f.push({ code: 'TRASH_MISSING_DELETER', severity: 'WARN', title: 'Bản ghi trong thùng rác thiếu thông tin người xóa', count: total, detail: 'deleted_at có nhưng deleted_by null (dữ liệu xóa trước khi có truy vết per-user).', suggestion: 'Chấp nhận (dữ liệu cũ) hoặc dọn dẹp trong Bảo trì; các lần xóa mới đã ghi đủ người xóa.', autoFixable: false });
  });

  // 9) WARN — tài khoản đang bị khóa do nhập sai mật khẩu.
  await safe('tài khoản bị khóa', async () => {
    const locked = await db.user.count({ where: { deletedAt: null, lockedAt: { not: null } } });
    if (locked) f.push({ code: 'USERS_LOCKED', severity: 'WARN', title: 'Có tài khoản đang bị khóa (nhập sai mật khẩu ≥ 5 lần)', count: locked, detail: 'Người dùng bị khóa cho tới khi admin mở khóa/đặt lại mật khẩu.', suggestion: 'Vào Quản Lý Nhân Sự để mở khóa hoặc đặt lại mật khẩu cho các tài khoản này.', autoFixable: false });
  });

  // 10) WARN — chưa từng backup / backup quá cũ (> 48h).
  await safe('backup gần đây', async () => {
    const row = await db.appSetting.findUnique({ where: { key: 'backup.lastAt' } });
    const last = row?.value ? new Date(row.value).getTime() : 0;
    const staleMs = 48 * 3600_000;
    if (!last || Date.now() - last > staleMs) f.push({ code: 'BACKUP_STALE', severity: 'WARN', title: 'Chưa backup gần đây', count: 1, detail: last ? `Backup gần nhất đã quá ${Math.round((Date.now() - last) / 3600_000)} giờ.` : 'Chưa có bản backup nào được ghi nhận.', suggestion: 'Chạy backup thủ công hoặc để lịch backup định kỳ chạy (mặc định 24h/lần).', autoFixable: false });
  });

  // 11) WARN — GD uỷ NĐT có phiCaiMayMilli=0 nhưng biểu phí hiệu lực >0 ⇒ "tiền về" NĐT đang tính SAI (thiếu trừ phí
  //     cài máy). L1 (đối kháng 12/8): dùng scanZeroPhiCaiMayCore (db-only) — chỉ báo khi needsBackfill>0 (có rate>0).
  await safe('phí cài máy NĐT chưa backfill', async () => {
    const r = await scanZeroPhiCaiMayCore(db);
    if (r.needsBackfill > 0) f.push({ code: 'INVESTOR_PHICAIMAY_UNBACKFILLED', severity: 'WARN', title: 'Giao dịch uỷ nhà đầu tư chưa trừ phí cài máy', count: r.needsBackfill, detail: `${r.needsBackfill} giao dịch uỷ NĐT có phí cài máy = 0 trong khi biểu phí hiệu lực > 0 ⇒ "tiền về" nhà đầu tư đang tính thừa (chưa trừ phí cài máy).`, suggestion: 'Chạy backfill phí cài máy cho các giao dịch này (theo biểu phí hiệu lực tại ngày GD) để báo cáo tiền về NĐT chính xác.', autoFixable: false });
  });

  // 12) ERROR — [Admin Demo 17/9 "phải có gate chống tái diễn"] LÔ ↔ GIAO DỊCH LỆCH TIỀN. Chính sách cũ coi GD là
  //     "chứng từ bất biến" nên sửa bill chỉ đổi lô, GD giữ số cũ ⇒ doanh số NĐT/SigMa (đọc bảng GIAO DỊCH)
  //     sai CÂM — 17/9 rà ra 23 lô, ca lớn nhất 8.000.000đ. Nay luồng sửa bill đã tự đồng bộ; check này là LƯỚI
  //     CHẶN cuối: còn lệch = có đường nào đó ghi lô mà không cập nhật GD, phải biết NGAY chứ không chờ ai cộng tay.
  await safe('lô ↔ giao dịch lệch tiền', async () => {
    const rows = await db.$queryRawUnsafe<{ lo_id: number; txn_id: number; lech: bigint }[]>(
      `SELECT l.id lo_id, t.id txn_id, (sum(lr.amount_before_fee) - max(t.amount))::bigint lech
         FROM los l JOIN lo_rows lr ON lr.lo_id = l.id JOIN transactions t ON t.id = l.transaction_id
        WHERE l.status <> 'CANCELLED' AND t.deleted_at IS NULL AND t.status <> 'CANCELLED'
        GROUP BY 1, 2 HAVING sum(lr.amount_before_fee) <> max(t.amount) ORDER BY abs(sum(lr.amount_before_fee) - max(t.amount)) DESC LIMIT 50`
    );
    if (rows.length > 0) {
      // [B328/F3-4 24/11 — agent soát] count + tổng chênh THẬT (không cắt 50) — trước đây count=rows.length
      // (≤50) và tổng chỉ cộng 50 lô lớn nhất ⇒ under-report quy mô bom, không cờ bị-cắt. Danh sách ví dụ
      // vẫn giữ 50 lớn nhất, nhưng con số báo cáo phải đúng toàn bộ.
      const thatSu = (await db.$queryRawUnsafe<{ n: number; tong: string }[]>(
        `SELECT count(*)::int n, COALESCE(sum(abs(d)),0)::text tong FROM (
           SELECT sum(lr.amount_before_fee) - max(t.amount) d
             FROM los l JOIN lo_rows lr ON lr.lo_id = l.id JOIN transactions t ON t.id = l.transaction_id
            WHERE l.status <> 'CANCELLED' AND t.deleted_at IS NULL AND t.status <> 'CANCELLED'
            GROUP BY l.id, t.id HAVING sum(lr.amount_before_fee) <> max(t.amount)) q`))[0];
      const nThat = thatSu?.n ?? rows.length;
      const tongThat = Number(thatSu?.tong ?? 0);
      const vd = rows.slice(0, 5).map((r) => `lô#${r.lo_id}↔GD#${r.txn_id} ${Number(r.lech) > 0 ? '+' : ''}${Number(r.lech).toLocaleString('vi-VN')}đ`).join(' · ');
      f.push({ code: 'LO_TXN_AMOUNT_DIVERGED', severity: 'ERROR', title: 'Lô và giao dịch LỆCH số tiền', count: nThat,
        detail: `${nThat} lô có số tiền khác giao dịch của chính nó (tổng chênh tuyệt đối ${tongThat.toLocaleString('vi-VN')}đ). Doanh số nhà đầu tư đọc bảng GIAO DỊCH nên đang SAI đúng phần chênh này.${nThat > 50 ? ' (hiển thị 50 lô lệch lớn nhất)' : ''} Ví dụ: ${vd}.`,
        suggestion: 'Chạy apps/bot-api/scripts/dong-bo-gd-theo-lo.mts --apply để đồng bộ giao dịch theo lô (có backup + audit).', autoFixable: false });
    }
  });

  return { findings: f, checksRun };
}

/** Áp dụng TỰ SỬA cho các phát hiện autoFixable. Hiện hỗ trợ: REVENUE_MISMATCH (tính lại doanh thu). */
export async function applyAutoFixes(db: Db, findings: Finding[]): Promise<number> {
  let fixed = 0;
  const revMismatch = findings.find((x) => x.code === 'REVENUE_MISMATCH');
  if (revMismatch) {
    const txns = await db.transaction.findMany({ where: { deletedAt: null }, select: { id: true, amount: true, partnerMarginMilli: true, sellMarginMilli: true, revenuePartner: true, revenueSell: true, revenueAmount: true } });
    // [B297/F2] CẤM đụng GD multi-card: doanh thu Σ per-thẻ đang lưu MỚI LÀ SỐ ĐÚNG — ghi đè bằng số
    // suy từ margin bình quân là phá 4 chứng từ hợp lệ (đo sổ thật +1.477đ bịa).
    const multiIds = new Set<number>(
      (await db.$queryRawUnsafe<Array<{ id: number }>>(
        'SELECT id FROM transactions WHERE deleted_at IS NULL AND COALESCE(install_fee_amount, 0) > 0'
      )).map((r) => r.id)
    );
    for (const t of txns) {
      if (multiIds.has(t.id)) continue;
      const exp = computeRevenue(Number(t.amount), t.partnerMarginMilli, t.sellMarginMilli);
      if (exp.revenuePartner !== Number(t.revenuePartner) || exp.revenueSell !== Number(t.revenueSell) || exp.revenueAmount !== Number(t.revenueAmount)) {
        await db.transaction.update({ where: { id: t.id }, data: { revenuePartner: exp.revenuePartner, revenueSell: exp.revenueSell, revenueAmount: exp.revenueAmount } });
        fixed++;
      }
    }
  }
  return fixed;
}

function severityRollup(findings: Finding[]): { status: 'OK' | 'WARN' | 'ERROR'; errorCount: number; warnCount: number } {
  const errorCount = findings.filter((x) => x.severity === 'ERROR').length;
  const warnCount = findings.filter((x) => x.severity === 'WARN').length;
  return { status: errorCount > 0 ? 'ERROR' : warnCount > 0 ? 'WARN' : 'OK', errorCount, warnCount };
}

export interface ScanResult {
  runId: number;
  status: 'OK' | 'WARN' | 'ERROR';
  checksTotal: number;
  issuesFound: number;
  errorCount: number;
  warnCount: number;
  autoFixed: number;
  durationMs: number;
  findings: Finding[];
}

/** Kết quả quét READ-ONLY (chưa persist → không có runId). */
export interface HealthScanLive {
  status: 'OK' | 'WARN' | 'ERROR';
  checksTotal: number;
  issuesFound: number;
  errorCount: number;
  warnCount: number;
  findings: Finding[];
}

/** Lưu 1 lần quét vào maintenance_runs (dùng chung cho quét thủ công & bảo trì định kỳ). */
async function persistRun(
  db: Db,
  args: { kind: 'MANUAL' | 'SCHEDULED'; findings: Finding[]; checksTotal: number; actorId: number | null; startedAt: Date; autoFixed?: number; backupFile?: string | null; auditDeleted?: number; trashDeleted?: number; vacuumed?: boolean }
): Promise<ScanResult> {
  const { status, errorCount, warnCount } = severityRollup(args.findings);
  const issuesFound = args.findings.reduce((s, x) => s + x.count, 0);
  const durationMs = Date.now() - args.startedAt.getTime();
  const run = await db.maintenanceRun.create({
    data: {
      kind: args.kind, status, checksTotal: args.checksTotal, issuesFound, errorCount, warnCount,
      reportJson: JSON.stringify(args.findings), backupFile: args.backupFile ?? null,
      auditDeleted: args.auditDeleted ?? 0, trashDeleted: args.trashDeleted ?? 0, vacuumed: args.vacuumed ?? false,
      autoFixed: args.autoFixed ?? 0, durationMs, triggeredBy: args.actorId, startedAt: args.startedAt, finishedAt: new Date()
    }
  });
  return { runId: run.id, status, checksTotal: args.checksTotal, issuesFound, errorCount, warnCount, autoFixed: args.autoFixed ?? 0, durationMs, findings: args.findings };
}

/** STORAGE_VIEW — quét READ-ONLY (collectFindings, KHÔNG persist). GET /v1/health/scan. */
export async function healthScan(ctx: ServiceCtx): Promise<{ ok: boolean; error?: string; message?: string; data?: HealthScanLive }> {
  if (!hasPermission(ctx.user, 'STORAGE_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { findings, checksRun } = await collectFindings(ctx.db);
  const { status, errorCount, warnCount } = severityRollup(findings);
  const issuesFound = findings.reduce((s, x) => s + x.count, 0);
  return { ok: true, data: { status, checksTotal: checksRun, issuesFound, errorCount, warnCount, findings } };
}

/**
 * STORAGE_VIEW (quét) / STORAGE_CLEANUP (khi autoFix) — quét + persist 1 MaintenanceRun. POST /v1/health/run.
 * autoFix → backup an toàn TRƯỚC khi ghi đè dữ liệu tài chính; fail backup → HỦY tự sửa.
 */
export async function runHealthScan(ctx: ServiceCtx, opts: { autoFix?: boolean } = {}): Promise<{ ok: boolean; error?: string; message?: string; data?: ScanResult }> {
  const perm = opts.autoFix ? 'STORAGE_CLEANUP' : 'STORAGE_VIEW';
  if (!hasPermission(ctx.user, perm)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const startedAt = new Date();
  let { findings, checksRun } = await collectFindings(db);
  let autoFixed = 0;
  if (opts.autoFix) {
    const bk = await systemBackup(db, 'pre-autofix snapshot (Health-Scan)');
    if (!bk.ok) return { ok: false, error: 'BACKUP_FAILED', message: `Không tạo được backup an toàn trước khi tự sửa — HỦY: ${bk.error}` };
    autoFixed = await applyAutoFixes(db, findings);
    if (autoFixed > 0) ({ findings, checksRun } = await collectFindings(db)); // quét lại để phản ánh sau khi sửa
  }
  const res = await persistRun(db, { kind: 'MANUAL', findings, checksTotal: checksRun, actorId: user.id, startedAt, autoFixed });
  await writeAudit(db, { actorUserId: user.id, action: 'STORAGE_CLEANUP', targetType: 'System', targetId: 'scan', after: { runId: res.runId, status: res.status, issuesFound: res.issuesFound, autoFixed } });
  return { ok: true, data: res };
}

export interface MaintenanceRunDto {
  id: number;
  kind: string;
  status: string;
  checksTotal: number;
  issuesFound: number;
  errorCount: number;
  warnCount: number;
  autoFixed: number;
  vacuumed: boolean;
  auditDeleted: number;
  trashDeleted: number;
  durationMs: number;
  triggeredByName: string | null;
  startedAt: string;
  finishedAt: string | null;
  findings?: Finding[];
}

/** STORAGE_VIEW — lịch sử bảo trì (mới nhất trước). GET /v1/health/runs. */
export async function listHealthRuns(ctx: ServiceCtx, limit = 50): Promise<{ ok: boolean; error?: string; message?: string; data?: MaintenanceRunDto[] }> {
  if (!hasPermission(ctx.user, 'STORAGE_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.maintenanceRun.findMany({ orderBy: { id: 'desc' }, take: Math.min(200, Math.max(1, limit)) });
  const uids = [...new Set(rows.map((r) => r.triggeredBy).filter((x): x is number => x != null))];
  const names = new Map((uids.length ? await db.user.findMany({ where: { id: { in: uids } }, select: { id: true, fullName: true } }) : []).map((u) => [u.id, u.fullName]));
  return {
    ok: true,
    data: rows.map((r) => ({
      id: r.id, kind: r.kind, status: r.status, checksTotal: r.checksTotal, issuesFound: r.issuesFound,
      errorCount: r.errorCount, warnCount: r.warnCount, autoFixed: r.autoFixed, vacuumed: r.vacuumed,
      auditDeleted: r.auditDeleted, trashDeleted: r.trashDeleted, durationMs: r.durationMs,
      triggeredByName: r.triggeredBy != null ? names.get(r.triggeredBy) ?? null : (r.kind === 'SCHEDULED' ? 'Hệ thống' : null),
      startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null
    }))
  };
}
