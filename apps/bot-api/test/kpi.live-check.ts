// Script CHẠY TAY (KHÔNG *.test.ts, KHÔNG chạy trong vitest/CI) — verify THẬT GET /v1/me/kpi trên DB sản
// xuất `glb` (đọc DATABASE_URL từ .env, KHÔNG phải throwaway DB của vitest.config.ts) + Rocket.Chat THẬT
// (chat.example.com), CÙNG khuôn test/rc-client.live-check.ts (tự tạo user RC test qua rcCreateUser,
// TỰ XÓA ngay sau khi xong — bài học B7/rule cứng global "dọn dữ liệu test thật đã tạo").
//
// Chạy: npx tsx test/kpi.live-check.ts
//
// Vì sao chọn cách này (thay vì mock như kpi.test.ts): kpi.test.ts ĐÃ verify đầy đủ logic nghiệp vụ (nhóm
// ngày/loại trừ CANCELLED/loại trừ đại lý khác/biên from-to) trên throwaway DB thật (Postgres migrate đầy đủ)
// — nhưng đó KHÔNG phải DB `glb` sản xuất mà Admin Demo thật sự dùng. Script này verify THÊM 1 lớp khác: chạy
// đối chiếu SQL RAW độc lập trên chính DB glb thật (schema/dữ liệu thật, không phải DB vừa tạo sạch).
// 4/8 LOẠI RC — TRƯỚC ĐÂY script còn đăng nhập RC thật (rcLogin) rồi gọi GET /v1/me/kpi qua supertest để đối
// chiếu API vs SQL; rcLogin đã bị gỡ export nên phần HTTP-qua-RC-auth đó được GỠ (xem chú thích bước 4). Vẫn
// tạo 1 user RC thật tạm thời (rcCreateUser) rồi TỰ XOÁ, giữ nguyên phần dựng dữ liệu Lô để đối chiếu SQL.
// 4/8 hoàn tất LOẠI RC — `rcLogin` (đăng nhập bằng tài khoản user để lấy authToken) đã bị gỡ export, nên phần
// gọi GET /v1/me/kpi qua supertest kèm x-rc-auth-token/x-rc-user-id KHÔNG còn chạy được ở script này. Verify
// KPI giờ dựa trên đối chiếu SQL RAW độc lập ngay trên DB glb thật (vẫn là bằng chứng thật lớp dữ liệu). Khi
// route /v1/me/kpi được chuyển sang phiên cookie độc-lập-RC, bổ sung lại lớp verify qua HTTP bằng phiên đó.
import 'dotenv/config';
import { getBotDb } from '../src/db.js';
import { rcCreateUser, rcDeleteUser } from '../src/rc-client.js';

const AGENT_CODE = 'TESTKPI01';

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL || '';
  console.log(`[kpi-live-check] DATABASE_URL = ${dbUrl.replace(/:[^:@/]+@/, ':***@')}`); // redact password khi log
  if (!/\/sigma(\?|$)/.test(dbUrl)) {
    console.log('[kpi-live-check] DATABASE_URL không trỏ tới DB tên "sigma" — dừng để tránh chạy nhầm DB khác.');
    return;
  }

  const db = getBotDb();

  // ── PRE-FLIGHT: bảng los/lo_rows PHẢI tồn tại TRƯỚC KHI tạo BẤT KỲ dữ liệu test nào — bài học THẬT lúc
  // build (24/7): DB glb cục bộ trên máy này thiếu 7 migration (bao gồm 20260722100000_sigma_lo), script
  // tạo Bank/Partner/Agent/Tid THÀNH CÔNG rồi mới vỡ ở db.lo.create() → finally cleanup CŨNG vỡ giữa chừng
  // (vì cleanup gọi db.lo.findMany() TRƯỚC khi xoá Agent/Bank/...) → SÓT dữ liệu test + user RC thật trên
  // production (đã dọn tay 1 lần, xem BUGS_FIXED.md). Check sớm ở đây để KHÔNG BAO GIỜ tạo dữ liệu nếu DB
  // chưa sẵn sàng — tránh lặp lại sự cố này.
  try {
    await db.lo.count();
  } catch (err) {
    console.error(
      '[kpi-live-check] BẢNG los/lo_rows CHƯA TỒN TẠI trên DB này — migration 20260722100000_sigma_lo (và có thể vài migration khác) CHƯA được deploy. ' +
        'KHÔNG tạo dữ liệu test (tránh lặp sự cố sót dữ liệu 24/7). Cần chạy `npx prisma migrate deploy` (packages/database) — ' +
        'ĐÂY LÀ THAY ĐỔI SCHEMA TRÊN DB SẢN XUẤT DÙNG CHUNG, CẦN DUYỆT TRƯỚC (R2/R7), KHÔNG tự ý chạy trong script này.'
    );
    console.error('[kpi-live-check] Chi tiết lỗi:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const ts = Date.now();
  const rcUsername = `sigma_kpi_livecheck_${ts}`;
  const rcPassword = `LiveKpi${ts}!`;

  // ── Dọn rác từ lần chạy TRƯỚC lỡ sót lại (idempotent-safe, tên Agent CỐ ĐỊNH TESTKPI01) ──────────────
  const stale = await db.agent.findFirst({ where: { code: AGENT_CODE } });
  if (stale) {
    console.log(`[kpi-live-check] thấy Agent ${AGENT_CODE} sót lại từ lần chạy trước (id=${stale.id}) — dọn trước khi chạy lại.`);
    const staleLos = await db.lo.findMany({ where: { agentId: stale.id }, select: { id: true } });
    const staleLoIds = staleLos.map((l) => l.id);
    if (staleLoIds.length > 0) await db.loRow.deleteMany({ where: { loId: { in: staleLoIds } } });
    await db.lo.deleteMany({ where: { agentId: stale.id } });
    await db.tid.deleteMany({ where: { agentId: stale.id } });
    await db.agent.delete({ where: { id: stale.id } });
  }

  let createdRcUser = false;
  let cleanupIds: { bankId?: number; partnerId?: number; cardTypeId?: number; feeTypeId?: number; agentId?: number } = {};

  try {
    // ── 1. Tạo user Rocket.Chat THẬT (tạm thời) ─────────────────────────────────────────────────────
    console.log(`[kpi-live-check] tạo user RC thật "${rcUsername}"...`);
    const created = await rcCreateUser({ username: rcUsername, email: `${rcUsername}@example.com`, name: 'KPI Live Check (tự xoá)', password: rcPassword });
    if (!created.ok) {
      console.error('[kpi-live-check] rcCreateUser THẤT BẠI, dừng:', JSON.stringify(created, null, 2));
      process.exitCode = 1;
      return;
    }
    createdRcUser = true;
    console.log(`[kpi-live-check] đã tạo user RC _id=${created.data._id}`);

    // ── 2. Dựng dữ liệu tối thiểu trên DB glb: Bank/Partner/CardType/FeeType/Agent/Tid ────────────────
    const bank = await db.bank.create({ data: { name: `NganHang_KPILive_${ts}`, code: `BKKPI${ts}`.slice(0, 20) } });
    cleanupIds.bankId = bank.id;
    const partner = await db.partner.create({ data: { name: `DoiTac_KPILive_${ts}`, code: `PTNKPI${ts}`.slice(0, 20) } });
    cleanupIds.partnerId = partner.id;
    const cardType = await db.cardType.create({ data: { bankId: bank.id, name: `LoaiThe_KPILive_${ts}`, code: `CTKPI${ts}`.slice(0, 20) } });
    cleanupIds.cardTypeId = cardType.id;
    const feeType = await db.feeType.create({ data: { name: `LoaiPhi_KPILive_${ts}` } });
    cleanupIds.feeTypeId = feeType.id;

    const agent = await db.agent.create({
      data: { code: AGENT_CODE, name: 'Đại lý test KPI live-check (tự xoá)', rcUserId: created.data._id, rcUsername: created.data.username }
    });
    cleanupIds.agentId = agent.id;
    console.log(`[kpi-live-check] đã tạo Agent ${AGENT_CODE} id=${agent.id}, link rcUserId=${created.data._id}`);

    const tid = await db.tid.create({ data: { tid: `TID_KPILIVE_${ts}`, agentId: agent.id, partnerId: partner.id, bankId: bank.id, status: 'ACTIVE' } });

    // ── 3. Tạo 4 Lô: 2 trong khoảng (tính), 1 CANCELLED (loại), 1 ngoài khoảng (loại) ─────────────────
    const from = new Date(2026, 6, 1, 0, 0, 0); // 2026-07-01 local
    const to = new Date(2026, 7, 1, 0, 0, 0); // 2026-08-01 local
    const day1 = new Date(2026, 6, 10, 9, 0, 0);
    const day2 = new Date(2026, 6, 20, 15, 0, 0);
    const cancelledDay = new Date(2026, 6, 12, 10, 0, 0);
    const outOfRangeDay = new Date(2026, 5, 15, 10, 0, 0);

    async function makeLo(amountBeforeFee: bigint, createdAt: Date, status: string): Promise<void> {
      const lo = await db.lo.create({
        data: {
          agentId: agent.id,
          status,
          expectedTotalAmount: amountBeforeFee,
          createdAt,
          cancelledAt: status === 'CANCELLED' ? createdAt : null,
          cancelReason: status === 'CANCELLED' ? 'test live-check' : null
        }
      });
      await db.loRow.create({
        data: { loId: lo.id, tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee, feeApplied: 0n, amountAfterFee: amountBeforeFee }
      });
    }

    await makeLo(1_500_000n, day1, 'PENDING');
    await makeLo(2_500_000n, day2, 'CONFIRMED');
    await makeLo(9_000_000n, cancelledDay, 'CANCELLED'); // PHẢI bị loại trừ
    await makeLo(4_000_000n, outOfRangeDay, 'PENDING'); // PHẢI bị loại trừ (ngoài [from,to))
    console.log('[kpi-live-check] đã tạo 4 Lô test (2 hợp lệ trong khoảng, 1 CANCELLED, 1 ngoài khoảng).');

    // ── 4. Đối chiếu TAY bằng SQL RAW độc lập trên DB glb thật ────────────────────────────────────
    // 4/8 LOẠI RC — bỏ bước "đăng nhập RC thật (rcLogin) + gọi GET /v1/me/kpi qua supertest": rcLogin không
    // còn export, và /v1/me/kpi hiện vẫn xác thực qua RC (x-rc-auth-token) nên không có token user để gọi.
    // Verify KPI ở script này giờ dựa TRỰC TIẾP trên SQL RAW độc lập (không đi qua code route) — vẫn là bằng
    // chứng thật ở lớp dữ liệu (schema/dữ liệu glb thật, không phải throwaway DB). Khi /v1/me/kpi chuyển sang
    // phiên cookie độc-lập-RC, bổ sung lại lớp verify qua HTTP bằng phiên đó (không suy đoán cách làm bây giờ).
    const manual = await db.$queryRaw<{ lo_count: bigint; total_revenue: bigint | null }[]>`
      SELECT COUNT(DISTINCT l.id) AS lo_count, COALESCE(SUM(r.amount_before_fee), 0) AS total_revenue
      FROM los l
      JOIN lo_rows r ON r.lo_id = l.id
      WHERE l.agent_id = ${agent.id}
        AND l.status != 'CANCELLED'
        AND l.created_at >= ${from}
        AND l.created_at < ${to}
    `;
    const manualLoCount = Number(manual[0]?.lo_count ?? 0);
    const manualRevenue = Number(manual[0]?.total_revenue ?? 0);
    console.log(`[kpi-live-check] SQL tay: lo_count=${manualLoCount}, total_revenue=${manualRevenue}`);
    console.log(`[kpi-live-check] Kỳ vọng cứng (dữ liệu tự tạo ở bước 3): lo_count=2, total_revenue=${1_500_000 + 2_500_000} (day1=${dayKey(day1)}, day2=${dayKey(day2)})`);

    // Bất biến cốt lõi: chỉ 2 Lô trong khoảng [from,to) và KHÔNG CANCELLED được tính; 1 CANCELLED + 1 ngoài
    // khoảng bị loại. Tổng doanh thu = 1.5tr + 2.5tr = 4tr.
    const countMatch = manualLoCount === 2;
    const revenueMatch = manualRevenue === 4_000_000;
    console.log(`[kpi-live-check] KIỂM SQL tay: lo_count=${manualLoCount} (kỳ vọng 2) → ${countMatch ? 'KHỚP' : 'LỆCH'}`);
    console.log(`[kpi-live-check] KIỂM SQL tay: total_revenue=${manualRevenue} (kỳ vọng 4000000) → ${revenueMatch ? 'KHỚP' : 'LỆCH'}`);

    if (countMatch && revenueMatch) {
      console.log('[kpi-live-check] === KẾT QUẢ: PASS — SQL tay trên DB glb thật khớp kỳ vọng (loại CANCELLED + ngoài khoảng đúng). ===');
    } else {
      console.error('[kpi-live-check] === KẾT QUẢ: FAIL — XEM CHI TIẾT PHÍA TRÊN. ===');
      process.exitCode = 1;
    }
  } finally {
    // ── 7. DỌN SẠCH dữ liệu test thật (rule cứng B7 — KHÔNG để sót trên DB glb sản xuất). MỖI bước bọc
    // try/catch RIÊNG (bài học THẬT lúc build: 1 bước lỗi giữa chừng KHÔNG được phép chặn các bước dọn dẹp
    // CÒN LẠI — trước đây db.lo.findMany() lỗi làm toàn bộ finally dừng, sót cả Agent/Bank/Partner/user RC).
    console.log('[kpi-live-check] dọn dẹp dữ liệu test...');
    if (cleanupIds.agentId) {
      try {
        const los = await db.lo.findMany({ where: { agentId: cleanupIds.agentId }, select: { id: true } });
        const loIds = los.map((l) => l.id);
        if (loIds.length > 0) await db.loRow.deleteMany({ where: { loId: { in: loIds } } });
        await db.lo.deleteMany({ where: { agentId: cleanupIds.agentId } });
      } catch (err) {
        console.error('[kpi-live-check] dọn Lo/LoRow THẤT BẠI (bỏ qua, tiếp tục dọn phần còn lại):', err instanceof Error ? err.message : String(err));
      }
      try {
        await db.tid.deleteMany({ where: { agentId: cleanupIds.agentId } });
        await db.agent.delete({ where: { id: cleanupIds.agentId } });
        console.log(`[kpi-live-check] đã xoá Agent/Tid test (agentId=${cleanupIds.agentId}).`);
      } catch (err) {
        console.error(`[kpi-live-check] XOÁ Agent/Tid THẤT BẠI — agentId=${cleanupIds.agentId} CÓ THỂ CÒN SÓT, cần kiểm tra tay:`, err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    }
    for (const [label, del] of [
      ['CardType', cleanupIds.cardTypeId != null ? () => db.cardType.delete({ where: { id: cleanupIds.cardTypeId! } }) : null],
      ['FeeType', cleanupIds.feeTypeId != null ? () => db.feeType.delete({ where: { id: cleanupIds.feeTypeId! } }) : null],
      ['Partner', cleanupIds.partnerId != null ? () => db.partner.delete({ where: { id: cleanupIds.partnerId! } }) : null],
      ['Bank', cleanupIds.bankId != null ? () => db.bank.delete({ where: { id: cleanupIds.bankId! } }) : null]
    ] as const) {
      if (!del) continue;
      try {
        await del();
      } catch (err) {
        console.error(`[kpi-live-check] XOÁ ${label} THẤT BẠI — CÓ THỂ CÒN SÓT, cần kiểm tra tay:`, err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    }
    console.log('[kpi-live-check] đã dọn xong phần Bank/Partner/CardType/FeeType (xem log lỗi phía trên nếu có sót).');

    if (createdRcUser) {
      try {
        const deleted = await rcDeleteUser(rcUsername);
        if (deleted.ok) {
          console.log(`[kpi-live-check] đã xoá user RC test "${rcUsername}" — KHÔNG còn sót lại trên production.`);
        } else {
          console.error(`[kpi-live-check] XÓA USER RC TEST THẤT BẠI — "${rcUsername}" CÒN SÓT LẠI, cần vào RC admin xoá tay:`, JSON.stringify(deleted, null, 2));
          process.exitCode = 1;
        }
      } catch (err) {
        console.error(`[kpi-live-check] XÓA USER RC TEST GẶP LỖI — "${rcUsername}" CÓ THỂ CÒN SÓT LẠI, cần vào RC admin xoá tay:`, err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    }
  }
}

main().catch((err) => {
  console.error('[kpi-live-check] LỖI KHÔNG BẮT ĐƯỢC:', err);
  process.exitCode = 1;
});
