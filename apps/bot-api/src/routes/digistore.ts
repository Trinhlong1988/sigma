// ĐỐI SOÁT "BÁO CÓ" DIGISTORE — routes (Admin Demo 5/9). requireSession route-level (bài học B12, KHÔNG router.use
// blanket). Vùng route này thuộc adapter DigiStore per-mã:
//   POST /v1/digistore/check-baoco  — kiểm 1 bill QR có báo-có khớp chưa (resolve MÃ QR → creds mã đó → fetch LIVE).
//   POST /v1/digistore/set-cred     — lưu/cập nhật tài khoản DigiStore của 1 MÃ QR (mã hoá password). base optional.
//   GET  /v1/digistore/creds        — liệt kê mã QR + đã cấu hình creds chưa (KHÔNG trả password).
//   POST /v1/digistore/refresh      — chạy 1 lượt poll NGAY (nút "Tải lại giao dịch mới nhất") → trả errors per-mã.
//   POST /v1/digistore/suggest-hkd  — bill QR OCR KHÔNG ra tên HKD → gợi ý mã/HKD từ báo-có theo số GD / tiền+ngày+giờ.
//
// R198 — mọi lỗi fetch/login/giải mã → trả TRUNG THỰC (CANNOT_CHECK + code phân loại), KHÔNG báo xanh/đỏ giả, KHÔNG
// nuốt câm. CẤM trả password/raw payload ngân hàng ra client.
import { Router, type Request, type Response } from 'express';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createRefreshGate, killChildTree } from '../digistore-refresh-gate.js';
import { chayCoHanGio, moTaKetQuaPoll, docKetQuaPaySmart, type LoiMaPaySmart } from '../digistore-poll-message.js';
import { buildBaoCoXlsx } from '../baoco-export.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseBillDateTimeMs, resolveQrFeeForTid, resolveQrDealerSellFee } from '@sigma/services';
import { requireSession } from '../session-middleware.js';
import { isAlphaOwner, requireAlphaOwner, requireQrReconViewer } from '../alpha-owner.js';
import { taoYeuCauHoanNdt, listYcht, danhDauYchtDaNhan, huyYcht } from '../ndt-refund-request-service.js';
import { asyncHandler } from '../async-handler.js';
import { getBotDb } from '../db.js';
import { taoYeuCauHoan, danhDauYcDaChuyen, huyYeuCauHoan, trayYcTheoLo } from '../refund-request-service.js';
import { buildCongNoDaiLy } from '../cong-no-dai-ly-service.js';
import { fetchBaoCo, DigistoreError, type DigistoreCreds } from '../digistore-adapter.js';
import { DigistoreSecretError } from '../digistore-secret.js';
import { readQrDailyLimits, QR_DAILY_LIMIT_KEY, suaNamOcr } from '../ocr-send-service.js';
import {
  checkBillAgainstBaoCo,
  readBaoCoReconcileStatuses,
  digistoreCredForTid,
  resolveQrTidForBill,
  setDigistoreCred,
  runBaoCoPoll,
  buildBaoCoPollDeps,
  suggestHkdFromBaoCo,
  listQrTidsForPoll,
  checkBillWithRetry,
  upsertBaoCoRows,
  RECONCILE_TIME_WINDOW_MS,
  type BaoCoCandidate,
  type BillToCheck,
  type CheckStatus
} from '../digistore-reconcile.js';

export const digistoreRouter = Router();

// Nới cửa sổ FETCH LIVE quanh giờ bill = window đối soát + đệm (OCR giờ có thể lệch phút, báo-có ghi giờ ngân hàng).
const FETCH_PAD_MS = 15 * 60 * 1000;

// Throttle nút "Tải lại" (audit 5/9 — chống spam login BVBank → khoá tài khoản). Tối thiểu 20s giữa 2 lượt refresh thủ công.
// [PHẢN BIỆN 3 — 11/9] throttle thời-gian KHÔNG chặn được 2 lượt CHỒNG NHAU (request 2 tới sau 21s khi lượt 1 còn
// chạy dở tới 90s → 2 browser login bank song song). Nay dùng gate = mutex in-flight + throttle (digistore-refresh-gate.ts).
const REFRESH_MIN_INTERVAL_MS = 20 * 1000;
// [14/10] Chốt phải giữ ĐỦ LÂU cho cả lượt: DigiStore (POLL_DEADLINE_MS = 3') + PaySmart nhiều mã (trần
// PAYSMART_HAN_TOI_DA_MS = 4') + đệm 1' = 8'. Để nguyên mặc định 5' là chốt bị THU HỒI khi lượt còn đang chạy →
// lượt bấm tiếp theo mở browser login bank SONG SONG với lượt cũ — đúng cái nguy cơ khoá tài khoản mà gate sinh ra
// để chặn (phản biện 3 — 11/9). Số viết thẳng vì hai hằng kia khai báo bên dưới (const không dùng được trước TDZ).
const REFRESH_MAX_HOLD_MS = 3 * 60_000 + 4 * 60_000 + 60_000;
const refreshGate = createRefreshGate(REFRESH_MIN_INTERVAL_MS, REFRESH_MAX_HOLD_MS);

// [6/10 — SỰ CỐ THẬT] BVBank trả http=502 hàng loạt, một lượt `runBaoCoPoll` TREO (log đứng im >5 phút trong khi
// lượt y hệt trước đó xong trong vài giây). Nhánh PaySmart đã có hạn 90s, nhánh DigiStore thì KHÔNG → `finally`
// không chạy → chốt kẹt vĩnh viễn. Nay mọi lượt poll đều có HẠN GIỜ TỔNG; quá hạn thì bỏ cuộc và nhả chốt.
// Lưu ý trung thực: đây là lời gọi mạng TRONG tiến trình (không phải child process) nên hết hạn chỉ BỎ CHỜ,
// không giết được request đang treo — nhưng đủ để nhả chốt và trả lời người dùng.
const POLL_DEADLINE_MS = 3 * 60_000;

// POST /v1/digistore/check-baoco — kiểm 1 bill QR có báo-có khớp chưa. Trả trạng thái + ứng viên cho UI.
// GATE (audit đối kháng 5/9 — HIGH IDOR/BOLA): trả báo-có LIVE = dòng tiền + tên khách quẹt (PII) của HKD → CHỈ chủ
// SigMa (requireAlphaOwner theo agent.code từ SESSION, không tin client). Trước đây chỉ requireSession → mọi agent
// (kể cả đại lý ~400 tài khoản) enumerate tidId/hkdName lấy dòng tiền HKD khác. Đồng nhất với baoco-report.
digistoreRouter.post('/v1/digistore/check-baoco', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { hkdName?: unknown; amount?: unknown; dateTime?: unknown; payerName?: unknown; ref?: unknown; tidId?: unknown };
  const amount = Number(b.amount) || 0;
  if (!(amount > 0)) { res.status(400).json({ error: 'NO_AMOUNT', message: 'Thiếu số tiền để đối soát báo-có.' }); return; }
  // [Admin Demo 14/9] SỬA NĂM OCR sai (2025↔2026) trước khi tra báo-có — cùng luật reviewQr.
  const dateTime = suaNamOcr(b.dateTime != null ? String(b.dateTime) : null).date;
  const atMs = parseBillDateTimeMs(dateTime);
  const hkdName = b.hkdName != null ? String(b.hkdName) : null;
  const tidId = b.tidId != null && Number.isFinite(Number(b.tidId)) ? Number(b.tidId) : null;
  const bill: BillToCheck = {
    hkdName,
    amount,
    atMs,
    payerName: b.payerName != null ? String(b.payerName) : null,
    ref: b.ref != null ? String(b.ref) : null // Số giao dịch bill OCR → ghép EXACT với external_ref_no báo-có.
  };

  const db = getBotDb();

  // RESOLVE MÃ QR của bill → creds MÃ ĐÓ. Có mã nhưng CHƯA cấu hình creds → CANNOT_CHECK (NO_CRED). Không resolve
  // được mã (không tidId + tên HKD mơ hồ/không khớp) → rơi về .env fallback (creds=null) để tương thích + cờ warning.
  let creds: DigistoreCreds | null = null;
  let resolvedTid: { tidId: number; tid: string; hkdName: string | null } | null = null;
  try {
    resolvedTid = await resolveQrTidForBill(db, { tidId, hkdName });
  } catch {
    resolvedTid = null;
  }
  if (resolvedTid) {
    try {
      creds = await digistoreCredForTid(db, resolvedTid.tidId);
    } catch (err) {
      // Giải mã lỗi (thiếu DIGISTORE_ENC_KEY / dữ liệu hỏng) → TRUNG THỰC, KHÔNG đoán.
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof DigistoreSecretError ? err.code : 'DECRYPT_FAILED';
      // eslint-disable-next-line no-console
      console.error(`[digistore] check-baoco mã ${resolvedTid.tid} giải mã creds lỗi: ${msg}`);
      res.status(200).json({ ok: false, status: 'CANNOT_CHECK', error: code, message: `Không đọc được tài khoản DigiStore của mã ${resolvedTid.tid}: ${msg}`, candidates: [] });
      return;
    }
    if (!creds) {
      res.status(200).json({ ok: false, status: 'CANNOT_CHECK', error: 'NO_CRED', message: `Mã QR ${resolvedTid.tid} chưa cấu hình tài khoản DigiStore.`, candidates: [] });
      return;
    }
  }

  // Cửa sổ fetch: quanh giờ bill nếu có; không có giờ → 24h gần nhất (kèm cảnh báo hiển thị ở tầng trên/UI).
  const now = Date.now();
  const fromMs = atMs != null ? atMs - RECONCILE_TIME_WINDOW_MS - FETCH_PAD_MS : now - 24 * 60 * 60 * 1000;
  const toMs = atMs != null ? atMs + RECONCILE_TIME_WINDOW_MS + FETCH_PAD_MS : now;

  // TẢI DANH SÁCH + CHECK (Admin Demo 8/9) — 2 việc GỘP LÀM MỘT, tự tải tới 2 lượt cho chắc (báo-có hay về trễ vài
  // giây). Lỗi (chặn/logout/hết hạn/thiếu creds) → CANNOT_CHECK trung thực (KHÔNG báo xanh/đỏ giả).
  //
  // Chưa resolve được mã QR (OCR mất/cắt tên HKD) → QUÉT MỌI mã có tài khoản DigiStore trong đúng cửa sổ giờ bill,
  // thay vì rơi về 1 tài khoản .env chung rồi bắt người dùng sang màn Báo cáo QR bấm "Tải lại" và mò.
  let quetToanBoMa = false;
  const loiTungMa: string[] = [];
  let fetchWindow: (f: number, t: number) => Promise<BaoCoCandidate[]>;
  if (!creds && !resolvedTid) {
    quetToanBoMa = true;
    const dsMa = await listQrTidsForPoll(db);
    const coCreds = dsMa.filter((m) => m.creds);
    if (coCreds.length === 0) {
      res.status(200).json({ ok: false, status: 'CANNOT_CHECK', error: 'NO_CRED', message: 'Chưa mã QR nào cấu hình tài khoản DigiStore — không tra được báo có.', candidates: [] });
      return;
    }
    fetchWindow = async (f, t) => {
      loiTungMa.length = 0;
      const gom: BaoCoCandidate[] = [];
      for (const m of coCreds) {
        try { gom.push(...(await fetchBaoCo(m.creds, f, t))); }
        catch (err) { loiTungMa.push(`${m.tid}: ${err instanceof Error ? err.message : String(err)}`); } // R198: lỗi 1 mã không chặn mã khác, nhưng phải HIỆN
      }
      if (gom.length === 0 && loiTungMa.length === coCreds.length) throw new DigistoreError('NETWORK', `Không mã QR nào tra được báo có: ${loiTungMa.join(' · ')}`);
      return gom;
    };
  } else {
    fetchWindow = (f, t) => fetchBaoCo(creds, f, t);
  }

  let outcome;
  try {
    outcome = await checkBillWithRetry(
      {
        fetchWindow,
        loadStatuses: (ids) => readBaoCoReconcileStatuses(db, ids),
        saveRows: (rows) => upsertBaoCoRows(db, rows) // "check" cũng NẠP danh sách vào cache → báo cáo/gợi ý dùng lại
      },
      bill,
      { fromMs, toMs, windowMs: RECONCILE_TIME_WINDOW_MS, maxAttempts: 2, retryDelayMs: 1500 }
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const code = err instanceof DigistoreError ? err.code : 'DIGISTORE_UNAVAILABLE';
    res.status(200).json({ ok: false, status: 'CANNOT_CHECK', error: code, message: `Không kiểm được báo-có DigiStore: ${reason}`, candidates: [] });
    return;
  }
  const result = outcome.result;

  const candidates = result.candidates.map((c) => ({
    billId: c.billId, qrCode: c.qrCode, hkdName: c.hkdName, amount: c.amount,
    payerName: c.payerName, externalRefNo: c.externalRefNo, description: c.description, atMs: c.atMs, status: c.status,
    reconcileStatus: c.reconcileStatus ?? null
  }));
  // [Admin Demo 8/9] Quét-toàn-bộ mà khớp được → nói luôn bill này thuộc MÃ QR / HKD nào (client tự điền tên, khỏi
  // phải bấm "Tìm mã QR từ báo có" thêm 1 lần). Chỉ gợi ý khi khớp CHẮC (MATCHED, đúng 1 ứng viên).
  const khopChac = quetToanBoMa && result.status === 'MATCHED' && result.candidates.length === 1 ? result.candidates[0] : null;
  res.json({
    ok: true,
    status: result.status,
    candidates,
    hasBillTime: atMs != null,
    resolvedTid: resolvedTid ? { tidId: resolvedTid.tidId, tid: resolvedTid.tid } : null,
    scannedAllQr: quetToanBoMa,                       // đã tự quét mọi mã (không cần tải danh sách trước)
    fetchAttempts: outcome.attempts,                  // số lượt TỰ tải danh sách trước khi kết luận (1 hoặc 2)
    fetchedRows: outcome.fetched,
    cacheSaveError: outcome.saveError,                // R198: nạp cache hỏng vẫn phải hiện
    scanErrors: loiTungMa.length ? loiTungMa : undefined, // R198: mã nào tra hỏng vẫn phải hiện, không nuốt im
    suggestedHkd: khopChac ? { hkdName: khopChac.hkdName ?? null, qrCode: khopChac.qrCode ?? null, payerName: khopChac.payerName ?? null } : null,
    usedEnvFallback: creds == null && !quetToanBoMa   // true = rơi tài khoản .env chung (cảnh báo UI).
  });
}));

// POST /v1/digistore/set-cred — lưu/cập nhật tài khoản DigiStore của 1 MÃ QR. base optional (mặc định BVBank chung),
// username + password bắt buộc. Mã hoá password (AES-256-GCM). Thiếu DIGISTORE_ENC_KEY → 500 TRUNG THỰC (KHÔNG lưu).
// GATE (audit đối kháng 5/9 — HIGH): tài khoản DigiStore = mật khẩu NGÂN HÀNG merchant. Trước đây gác bằng mật khẩu
// sửa bill (PIN dùng-chung, mặc định 1111) → mọi agent biết PIN có thể ghi đè creds bất kỳ mã → đầu độc đối soát
// (trỏ creds về tài khoản kẻ tấn công, bơm báo-có giả). SỬA: CHỈ chủ SigMa (requireAlphaOwner) — bỏ hẳn đường editPassword.
digistoreRouter.post('/v1/digistore/set-cred', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { tidId?: unknown; base?: unknown; username?: unknown; password?: unknown };
  const tidId = Number(b.tidId);
  const username = String(b.username ?? '').trim();
  const password = String(b.password ?? '');
  const base = b.base != null && String(b.base).trim() ? String(b.base).trim() : null;
  if (!(tidId > 0)) { res.status(400).json({ error: 'NO_TID', message: 'Thiếu mã QR (tidId).' }); return; }
  if (!username) { res.status(400).json({ error: 'NO_USERNAME', message: 'Thiếu tên đăng nhập DigiStore.' }); return; }
  if (!password) { res.status(400).json({ error: 'NO_PASSWORD', message: 'Thiếu mật khẩu DigiStore.' }); return; }

  const db = getBotDb();
  const rows = (await db.$queryRawUnsafe(
    `SELECT id, tid FROM tids WHERE id = $1 AND kind = 'QR' AND deleted_at IS NULL LIMIT 1`,
    tidId
  )) as Array<{ id: number; tid: string }>;
  if (!rows.length) { res.status(400).json({ error: 'NOT_QR', message: 'Mã QR không tồn tại (hoặc không phải dòng kind=QR).' }); return; }

  try {
    await setDigistoreCred(db, { tidId, base, username, password });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof DigistoreSecretError ? err.code : 'ENC_FAILED';
    // eslint-disable-next-line no-console
    console.error(`[digistore] set-cred mã ${rows[0].tid} mã hoá lỗi: ${msg}`);
    res.status(500).json({ error: code, message: `Không lưu được tài khoản DigiStore: ${msg}` });
    return;
  }
  res.json({ ok: true, tid: rows[0].tid });
}));

// GET /v1/digistore/creds — liệt kê mã QR + trạng thái cấu hình creds (cho form). KHÔNG trả password.
// GATE (audit 5/9 — MEDIUM): trả username đăng nhập ngân hàng của MỌI merchant → CHỈ chủ SigMa (không để lộ nửa cặp
// đăng nhập bank cho agent thường).
digistoreRouter.get('/v1/digistore/creds', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (_req: Request, res: Response) => {
  const db = getBotDb();
  const rows = (await db.$queryRawUnsafe(
    `SELECT t.id AS "tidId", t.tid AS "tid", t.hkd_name AS "hkdName",
            (c.tid_id IS NOT NULL) AS "hasCred", c.base AS "base", c.username AS "username", c.updated_at AS "updatedAt"
       FROM tids t LEFT JOIN qr_digistore_cred c ON c.tid_id = t.id
      WHERE t.kind = 'QR' AND t.deleted_at IS NULL
      ORDER BY t.hkd_name NULLS LAST, t.id`
  )) as Array<{ tidId: number; tid: string; hkdName: string | null; hasCred: boolean; base: string | null; username: string | null; updatedAt: Date | string | null }>;
  res.json({
    ok: true,
    items: rows.map((r) => ({
      tidId: r.tidId, tid: r.tid, hkdName: r.hkdName,
      hasCred: !!r.hasCred, base: r.base, username: r.username, updatedAt: r.updatedAt
    }))
  });
}));

// POST /v1/digistore/suggest-hkd — [Admin Demo 8/9] Bill QR mà OCR KHÔNG đọc được tên HKD (app ngân hàng cắt cụt,
// ảnh mờ) VẪN phải đối soát được: tra CACHE báo-có theo SỐ GIAO DỊCH (exact) hoặc SỐ TIỀN + NGÀY GIỜ (±window) →
// trả danh sách gợi ý để người duyệt bấm chọn (KHÔNG tự gán — đây là TIỀN).
// Cache trống trong cửa sổ (bill vừa quẹt, worker 30' chưa chạy) → chạy 1 lượt poll LIVE (chung throttle với nút
// "Tải lại") rồi tra lại. Gate chủ SigMa như check-baoco (dữ liệu = dòng tiền + tên khách quẹt).
digistoreRouter.post('/v1/digistore/suggest-hkd', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { amount?: unknown; dateTime?: unknown; ref?: unknown; payerName?: unknown };
  const amount = Number(b.amount) || 0;
  if (!(amount > 0)) { res.status(400).json({ error: 'NO_AMOUNT', message: 'Thiếu số tiền để tìm gợi ý.' }); return; }
  const atMs = parseBillDateTimeMs(suaNamOcr(b.dateTime != null ? String(b.dateTime) : null).date); // [14/9] sửa năm OCR
  const ref = b.ref != null ? String(b.ref) : null;
  // [Admin Demo 10/9] Ảnh THÔNG BÁO GIAO DỊCH THẺ có TÊN CHỦ THẺ → thu hẹp gợi ý theo người quẹt (cùng tiền + giờ mà
  // khác người = giao dịch cửa hàng khác). Không ai khớp tên → giữ nguyên danh sách (không giấu dữ liệu).
  const payerName = b.payerName != null ? String(b.payerName) : null;
  const db = getBotDb();

  let out = await suggestHkdFromBaoCo(db, { amount, atMs, ref, payerName });
  let refreshed = false;
  if (out.candidates.length === 0) {
    // [PHẢN BIỆN 3 — 11/9] dùng CHUNG refreshGate với nút "Tải lại": vừa throttle vừa CHẶN chạy chồng lượt poll
    // đang dở (2 login bank song song). Không acquire được → bỏ qua poll, trả gợi ý từ cache (hành vi cũ giữ nguyên).
    if (refreshGate.tryAcquire(Date.now()).ok) {
      try {
        await runBaoCoPoll(buildBaoCoPollDeps(db));
        refreshed = true;
      } catch (err) {
        // R198: poll hỏng KHÔNG được nuốt im — báo rõ để người duyệt biết gợi ý đang thiếu dữ liệu mới.
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[digistore] suggest-hkd poll lỗi: ${reason}`);
        res.status(200).json({ ok: true, exact: false, weak: out.weak, candidates: [], refreshed: false, warning: `Chưa tải được báo-có mới: ${reason}` });
        return;
      } finally {
        refreshGate.release();
      }
      out = await suggestHkdFromBaoCo(db, { amount, atMs, ref, payerName });
    }
  }
  res.status(200).json({ ok: true, exact: out.exact, weak: out.weak, refreshed, candidates: out.candidates });
}));

/** [Admin Demo 14/10] Số mã QR PaySmart có cred — quyết định hạn giờ (mỗi mã login browser riêng, chạy LẦN LƯỢT).
 *  Không đọc được (bảng chưa tạo/DB lỗi) → coi như 1 mã: hạn ngắn hơn thì cùng lắm báo quá hạn, KHÔNG âm thầm
 *  cho chạy vô hạn. */
async function demMaPaySmart(db: ReturnType<typeof getBotDb>): Promise<number> {
  try {
    const r = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM qr_paysmart_cred`);
    return Math.max(1, Number(r[0]?.n ?? 1));
  } catch (err) {
    console.error('[digistore] không đếm được mã PaySmart (dùng mặc định 1):', err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/** [Admin Demo 11/9] Chạy 1 lượt poll BÁO-CÓ PaySmart qua script cô lập — headless browser + OTP tự sinh nằm TRỌN
 *  trong scripts/paysmart-poll.mts (đã kiểm chứng). Fail-open: lỗi PaySmart KHÔNG chặn refresh DigiStore.
 *
 *  [14/10 — mở nhiều mã] Trước đây 1 mã (DEMOMAY) nên chỉ cần đọc `nạp (\d+) báo-có` + hạn cứng 90s. Với nhiều mã:
 *   · hạn = PAYSMART_HAN_MOI_MA_MS × số mã (trần PAYSMART_HAN_TOI_DA_MS) — 2 mã login nối nhau quá 90s là chuyện
 *     thường, giữ hạn cũ thì mã sau LUÔN bị giết giữa đường.
 *   · đọc dòng `KETQUA naped=.. ok=k/n` + từng dòng `LOIMA tid=.. ten=.. ly=..` ⇒ 1 mã chết KHÔNG còn bị khuôn
 *     cũ hiểu thành "ok" (regex cũ khớp dòng TỔNG là trả ok=true, nuốt sạch lỗi mã kia — R198). */
const PAYSMART_HAN_MOI_MA_MS = 90_000;
const PAYSMART_HAN_TOI_DA_MS = 4 * 60_000;
function hanPaySmart(soMa: number): number {
  return Math.min(PAYSMART_HAN_MOI_MA_MS * Math.max(1, soMa), PAYSMART_HAN_TOI_DA_MS);
}

async function chayPollPaySmart(soMa = 1): Promise<{ ok: boolean; naped?: number; soMa?: number | null; soOk?: number | null; loiMa?: LoiMaPaySmart[]; error?: string }> {
  const botApiRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // src/routes → apps/bot-api
  const han = hanPaySmart(soMa);
  return await new Promise((resolve) => {
    // [PHẢN BIỆN 3 — 11/9, ORPHAN CONFIRMED] KHÔNG dùng option `timeout` của execFile: với shell:true trên Windows
    // nó chỉ giết cmd.exe WRAPPER, cây con npx→tsx→node→CHROMIUM headless SỐNG SÓT (tái hiện _repro-orphan.mjs:
    // con+cháu đều sống sau timeout) → mỗi lần poll treo rò 1 chromium ma (~200MB, giữ khoá profile). Tự quản
    // timeout 90s + killChildTree (taskkill /F /T /PID lúc wrapper CÒN SỐNG — khuôn check-advance.mjs, guard
    // PID-reuse bên trong killChildTree).
    let timedOut = false;
    // [Admin Demo 12/9 — banner báo "Executable doesn't exist at C:\W…"] bot-api chạy dưới SYSTEM (schtask) →
    // Playwright tìm browser ở profile SYSTEM (systemprofile\AppData\Local\ms-playwright — RỖNG). Browser cài ở
    // profile Administrator → chỉ đường tường minh qua PLAYWRIGHT_BROWSERS_PATH (env đã set sẵn thì tôn trọng).
    const psEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '<REPO>/AppData/Local/ms-playwright' }; // forward-slash: miễn nhiễm escape JS (backslash đơn từng bị nuốt separator → "C:UsersAdministrator…" → Executable doesn't exist)
    // [18/9] Đường dẫn đổi `_paysmart-poll.mts` → `scripts/paysmart-poll.mts`: script SỐNG (route này gọi) mà lại
    // mang tiền tố `_` giống hệt quy ước script debug tạm ⇒ đợt dọn rác quét `_*` XOÁ NHẦM → PaySmart/DEMOMAY im
    // lặng không kéo được báo-có. Test `script-duong-dan-ton-tai.guard.test.ts` nay canh: mọi đường dẫn script mà
    // code production gọi PHẢI tồn tại trên đĩa.
    const child = execFile('npx', ['tsx', 'scripts/paysmart-poll.mts'], { cwd: botApiRoot, shell: true, windowsHide: true, env: psEnv },
      (err, stdout) => {
        clearTimeout(timer);
        const kq = docKetQuaPaySmart(String(stdout ?? ''), { timedOut, hanMs: han });
        if (!kq.ok && !kq.soMa) {
          // Chưa tới được dòng KETQUA (script chết sớm / sai đường dẫn / thiếu chromium): log FULL stderr ra
          // service log rồi mới rút gọn cho banner.
          // [12/9 R198 tu dinh] slice(0,200) tung CAT CUT path loi (Executable doesn't exist at C:...U) -> mu chan
          // doan. Log FULL ra service log; banner giu 300 ky tu DUOI (path/ly do nam cuoi message).
          const full = err ? String(err.message || '') : '';
          if (full) console.error('[digistore] PaySmart poll stderr FULL:', full);
          const ly = full ? (full.length > 300 ? `…${full.slice(-300)}` : full) : (kq.error ?? 'poll lỗi');
          resolve({ ok: false, naped: kq.naped, soMa: kq.soMa, soOk: kq.soOk, loiMa: kq.loiMa, error: ly });
          return;
        }
        resolve({ ok: kq.ok, naped: kq.naped, soMa: kq.soMa, soOk: kq.soOk, loiMa: kq.loiMa, error: kq.error });
      });
    const timer = setTimeout(() => { timedOut = true; killChildTree(child); }, han);
  });
}

// POST /v1/digistore/refresh — nút "Tải lại giao dịch mới nhất": chạy 1 lượt poll NGAY (tái dùng runBaoCoPoll +
// buildBaoCoPollDeps — KHÔNG viết lại). Fail 1 mã → tiếp mã khác + gom vào errors (R198). Trả tổng + errors per-mã.
// GATE (audit 5/9 — MEDIUM): mỗi refresh login MỌI tài khoản merchant tới BVBank → agent thường spam = DoS/khoá tài
// khoản bank. CHỈ chủ SigMa + throttle tối thiểu giữa 2 lượt (coalesce với worker 30').
digistoreRouter.post('/v1/digistore/refresh', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  // [PHẢN BIỆN 3 — 11/9] gate = mutex in-flight + throttle. BUSY (lượt trước còn chạy dở — poll có thể tới 90s+)
  // TRƯỚC ĐÂY lọt qua throttle thời-gian sau 20s → 2 browser login bank SONG SONG (JWT đá nhau/khoá tài khoản).
  const quyet = refreshGate.tryAcquire(Date.now());
  if (!quyet.ok) {
    res.status(429).json({
      ok: false,
      error: quyet.code,
      message: quyet.code === 'BUSY'
        // [6/10] Nói rõ đã chạy bao lâu + bao giờ tự nhả, để không bị hiểu nhầm thành "mất mạng" như lần
        // BVBank lỗi 502 làm treo lượt poll (Admin Demo tưởng đứt đường truyền).
        ? `Đang kéo dở một lượt tải lại (đã ${quyet.heldS ?? 0} giây) — đợi lượt đó xong rồi thử lại. Nếu quá ${Math.round(REFRESH_MAX_HOLD_MS / 60_000)} phút mà vẫn báo thế này thì lượt cũ đã treo, hệ thống sẽ tự thu hồi ở lần bấm tiếp theo.`
        : `Vừa tải lại xong — vui lòng đợi ${quyet.waitS ?? 0} giây rồi thử lại.`
    });
    return;
  }
  let r: Awaited<ReturnType<typeof runBaoCoPoll>>;
  let ps: Awaited<ReturnType<typeof chayPollPaySmart>>;
  try {
    const db = getBotDb();
    // [Admin Demo 24/9] "kéo báo có riêng" theo các mã đang tích chọn (body.tidIds) — không chọn thì kéo TẤT CẢ như cũ.
    const bIds = Array.isArray((req.body as { tidIds?: unknown })?.tidIds)
      ? ((req.body as { tidIds: unknown[] }).tidIds.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))
      : [];
    // [6/10] BỌC HẠN GIỜ: trước đây nhánh này không có hạn, treo là chốt kẹt vĩnh viễn.
    r = await chayCoHanGio(() => runBaoCoPoll(buildBaoCoPollDeps(db, bIds.length ? bIds : undefined)),
      POLL_DEADLINE_MS, 'kéo báo-có DigiStore');
    // [Admin Demo 11/9] kéo THÊM PaySmart (mã DEMOMAY) trong cùng nút — chỉ khi bấm, không timer. Fail-open.
    ps = await chayPollPaySmart(await demMaPaySmart(db));
  } catch (err) {
    const ly = err instanceof Error ? err.message : String(err);
    console.error('[digistore] refresh: lượt poll hỏng/quá hạn:', ly);
    res.status(503).json({
      ok: false,
      error: ly.startsWith('QUA_HAN_GIO') ? 'POLL_TIMEOUT' : 'POLL_FAILED',
      message: ly.startsWith('QUA_HAN_GIO')
        ? `Lượt kéo báo-có chạy quá ${Math.round(POLL_DEADLINE_MS / 60_000)} phút nên đã dừng — thường do hệ thống ngân hàng đang lỗi. Thử lại sau ít phút.`
        : `Không kéo được báo-có: ${ly}`
    });
    return;
  } finally {
    refreshGate.release();
  }
  if (!ps.ok) console.error('[digistore] refresh: PaySmart poll lỗi (không chặn DigiStore):', ps.error);
  res.json({
    ok: r.ok,
    reason: r.reason ?? null,
    fetched: r.fetched + (ps.naped ?? 0),
    matched: r.matched,
    unreconciled: r.unreconciled,
    paysmart: ps.ok
      ? { ok: true, naped: ps.naped ?? 0, soMa: ps.soMa ?? 1, soOk: ps.soOk ?? 1, loiMa: [] }
      : { ok: false, naped: ps.naped ?? 0, soMa: ps.soMa ?? null, soOk: ps.soOk ?? null, loiMa: ps.loiMa ?? [], error: ps.error },
    // [6/10] Câu tóm tắt NÓI ĐÚNG BẢN CHẤT: 502 hàng loạt = ngân hàng lỗi, không phải mạng mình.
    message: moTaKetQuaPoll(r),
    errors: r.errors.map((e) => ({ tid: e.tid, code: e.code, reason: e.reason }))
  });
}));

// POST /internal/digistore/paysmart-poll — [12/9 ops] kích poll PaySmart KHÔNG cần phiên người dùng, guard
// X-Internal-Token fail-closed (CÙNG token + khuôn internal-ingest). Mục đích: ops/kiểm chứng sự cố từ máy chủ
// (vd vụ "Executable doesn't exist" — LEAD cần bấm-nút-thật mà không mượn session chủ SigMa). Dùng CHUNG gate
// in-flight với nút refresh (không 2 browser song song).
digistoreRouter.post('/internal/digistore/paysmart-poll', asyncHandler(async (req: Request, res: Response) => {
  const expected = (process.env['SIGMA_INTERNAL_INGEST_TOKEN'] ?? '').trim();
  if (!expected) { res.status(503).json({ ok: false, error: 'NOT_CONFIGURED' }); return; }
  const provided = (req.header('x-internal-token') ?? '').trim();
  const a = Buffer.from(provided, 'utf8'), b = Buffer.from(expected, 'utf8');
  let khop = a.length === b.length; try { khop = khop && timingSafeEqual(a, b); } catch { khop = false; }
  if (!khop) { res.status(401).json({ ok: false, error: 'UNAUTHORIZED' }); return; }
  const g = refreshGate.tryAcquire(Date.now());
  if (!g.ok) { res.status(429).json({ ok: false, error: g.code ?? 'BUSY' }); return; }
  try {
    const ps = await chayPollPaySmart(await demMaPaySmart(getBotDb()));
    res.json({ ok: ps.ok, naped: ps.naped ?? 0, soMa: ps.soMa ?? null, soOk: ps.soOk ?? null, loiMa: ps.loiMa ?? [], error: ps.error ?? null });
  } finally { refreshGate.release(); }
}));

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// BÁO CÁO ĐỐI SOÁT BÁO-CÓ (Admin Demo 5/9) — CHỈ chủ SigMa (requireAlphaOwner). Nối cache digistore_baoco ↔ GD QR đã ghi
// (matched_bill_key = transactions.code, fallback external_ref_no = transactions.qr_ref) → mỗi báo-có 1 dòng kèm phí
// bán/mua + lãi SigMa (từ GD khớp; chưa khớp → null). + byDay + totals. Lọc ngày theo at_ms (giờ ngân hàng, epoch ms)
// bound theo múi giờ HCM. SQL parameterized (chống injection). Tên đại lý resolve batch qua Prisma (đồng nhất alpha-aggregate).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Nửa đêm 00:00 Asia/Ho_Chi_Minh (UTC+7, không DST) của NGÀY chứa `d`. COPY chuẩn alpha-aggregate/fee-config. */
function startOfDayLocalHCM(d: Date): Date {
  const HCM = 7 * 60 * 60 * 1000;
  const w = new Date(d.getTime() + HCM);
  return new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) - HCM);
}
/** Ngày HCM "YYYY-MM-DD" của 1 epoch ms. */
function hcmDayMs(ms: number): string {
  const h = new Date(ms + 7 * 3_600_000);
  return `${h.getUTCFullYear()}-${String(h.getUTCMonth() + 1).padStart(2, '0')}-${String(h.getUTCDate()).padStart(2, '0')}`;
}
/** Parse 1 mốc → epoch ms: ISO instant HOẶC "YYYY-MM-DD" (→ nửa đêm HCM ngày đó). null nếu không hợp lệ (round-trip
 *  validate để Date.UTC KHÔNG cuộn tràn ngày lịch không hợp lệ — chống lệch kỳ âm thầm, như alpha-aggregate.parseBound). */
function parseBoundMs(v: unknown): number | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (md) {
    const y = Number(md[1]), mo = Number(md[2]), da = Number(md[3]);
    const u = new Date(Date.UTC(y, mo - 1, da, 12));
    if (u.getUTCFullYear() !== y || u.getUTCMonth() !== mo - 1 || u.getUTCDate() !== da) return null;
    return startOfDayLocalHCM(u).getTime();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

interface BaoCoReportRow {
  stt: number;
  dateIso: string | null;
  hkdName: string | null;
  amount: number;
  payerName: string | null;
  billId: string;
  externalRefNo: string | null;
  sauPhiBan: number | null;   // amount − phí bán (từ GD khớp; chưa khớp → null)
  sauPhiMua: number | null;   // amount − phí mua
  loiNhuanAlpha: number | null; // phí bán − phí mua (= revenue_sell GD QR)
  dealerName: string | null;
  reconcileStatus: string | null;
  nguon: string | null; // [Admin Demo 11/9] ngân hàng của MÃ QR nguồn (SmartPay=DEMOMAY/PaySmart · BVBank/ACB…=DigiStore) → UI tô màu
  // [Admin Demo 14/9 — full chức năng CQR] Đối soát TAY (qr_baoco_recon) + đại lý gán tay; maChuName = chủ mã (khách
  // được giao mã QR) — mặc định cột Đại lý khi chưa gán tay/chưa có phòng đại lý.
  manualDs: boolean | null;
  manualDealer: string | null;
  maChuName: string | null;
  sourceTidId: number | null;
  /** [Admin Demo 16/9 — VietQR] ĐÃ HOÀN tiền cho đại lý (xác nhận tay sau khi quét QR chuyển). Xanh CHỈ khi đối soát + hoàn. */
  refundDone: boolean | null;
  /** [16/9 tối] Loại phí bán áp cho bill CHƯA khớp GD: 'cho' (mặc định) | 'nhanh'. */
  feeType: 'cho' | 'nhanh';
  /** Mã nguồn CÓ giá tiền nhanh (phi_ban_nhanh) → UI mới cho chọn Nhanh. */
  coPhiNhanh: boolean;
}

/** Dựng báo cáo đối soát báo-có [fromMs, toMs). Export để test gọi trực tiếp (không qua HTTP). filter: 'matched' |
 *  'unreconciled' | undefined (tất cả). hkd = lọc chứa tên HKD (không dấu-nhạy DB). dealer = roomId đại lý (qr_dealer_room_id). */
export async function buildBaoCoReport(
  fromMs: number,
  toMs: number,
  opts: { hkd?: string | null; dealer?: string | null; filter?: string | null; tid?: number | null; tidIds?: number[] | null } = {}
): Promise<{ from: string; to: string; rows: BaoCoReportRow[]; byDay: Array<{ day: string; doanhSo: number; count: number; countUnreconciled: number; loiNhuan: number }>; totals: { amount: number; count: number; countUnreconciled: number; loiNhuanAlpha: number; sauPhiBan: number; sauPhiMua: number }; limitWarnings: Array<{ tidId: number; hkdName: string | null; day: string; doanhSo: number; limit: number }> }> {
  const db = getBotDb();
  const params: unknown[] = [fromMs, toMs];
  const conds: string[] = ['b.at_ms IS NOT NULL', 'b.at_ms >= $1', 'b.at_ms < $2'];
  const hkd = opts.hkd && opts.hkd.trim() ? opts.hkd.trim() : null;
  if (hkd) { params.push(`%${hkd}%`); conds.push(`b.hkd_name ILIKE $${params.length}`); }
  const dealer = opts.dealer && opts.dealer.trim() ? opts.dealer.trim() : null;
  if (dealer) { params.push(dealer); conds.push(`t.qr_dealer_room_id = $${params.length}`); }
  // Lọc theo MÃ QR (như dropdown TID POS) — source_tid_id = mã QR poll ra báo-có đó (Admin Demo 5/9). 2 mã chung NĐT vẫn
  // lọc riêng từng mã được. NULL = tất cả mã.
  const tid = opts.tid != null && Number.isInteger(opts.tid) && opts.tid > 0 ? opts.tid : null;
  // [Admin Demo 24/9] TÍCH CHỌN NHIỀU MÃ: tidIds thắng tid-đơn (client mới gửi tidIds; client cũ vẫn gửi tid).
  const tidIds = (opts.tidIds ?? []).filter((n) => Number.isInteger(n) && n > 0);
  if (tidIds.length) { params.push(tidIds); conds.push(`b.source_tid_id = ANY($${params.length}::int[])`); }
  else if (tid) { params.push(tid); conds.push(`b.source_tid_id = $${params.length}`); }
  const filter = (opts.filter ?? '').toString().trim().toLowerCase();
  if (filter === 'matched') conds.push(`b.reconcile_status = 'MATCHED'`);
  else if (filter === 'unreconciled') conds.push(`b.reconcile_status IS DISTINCT FROM 'MATCHED'`);

  const sql =
    `SELECT b.bill_id AS "billId", b.external_ref_no AS "extRef", b.hkd_name AS "hkdName", b.amount AS "amount",
            b.payer_name AS "payerName", b.at_ms AS "atMs", b.reconcile_status AS "reconcileStatus",
            b.source_tid_id AS "sourceTidId", bk.name AS "nguonBank",
            t.revenue_partner AS "revPartner", t.revenue_sell AS "revSell", t.qr_dealer_room_id AS "dealerRoom", t.code AS "txnCode",
            rc.ds AS "manualDs", rc.dealer AS "manualDealer", rc.refund_done AS "refundDone", rc.fee_type AS "feeType", COALESCE(cu.nickname, cu.full_name) AS "maChuName",
            sti.partner_id AS "srcPartnerId"
       FROM digistore_baoco b
       LEFT JOIN tids sti ON sti.id = b.source_tid_id
       LEFT JOIN customers cu ON cu.id = sti.customer_id AND cu.deleted_at IS NULL
       LEFT JOIN qr_baoco_recon rc ON rc.bill_id = b.bill_id
       LEFT JOIN banks bk ON bk.id = sti.bank_id
       LEFT JOIN transactions t
         ON t.deleted_at IS NULL
        AND ( (b.matched_bill_key IS NOT NULL AND t.code = b.matched_bill_key)
              OR (b.matched_bill_key IS NULL AND b.external_ref_no IS NOT NULL AND t.qr_ref IS NOT NULL AND t.qr_ref = b.external_ref_no) )
      WHERE ${conds.join(' AND ')}
      ORDER BY b.at_ms ASC, b.bill_id ASC`;
  const raw = (await db.$queryRawUnsafe(sql, ...params)) as Array<{
    billId: string; extRef: string | null; hkdName: string | null; amount: bigint | number | null; payerName: string | null;
    atMs: bigint | number | null; reconcileStatus: string | null; revPartner: bigint | number | null; revSell: bigint | number | null;
    dealerRoom: string | null; txnCode: string | null; sourceTidId: number | null; nguonBank: string | null;
    manualDs: boolean | null; manualDealer: string | null; refundDone: boolean | null; feeType: string | null; maChuName: string | null; srcPartnerId: number | null;
  }>;

  // Dedup theo bill_id (LEFT JOIN có thể sinh >1 dòng nếu external_ref_no trùng nhiều GD) — giữ dòng CÓ GD khớp (txnCode
  // not null) ưu tiên, giữ thứ tự at_ms. 1 báo-có = 1 dòng báo cáo.
  const byBill = new Map<string, typeof raw[number]>();
  for (const r of raw) {
    const prev = byBill.get(r.billId);
    if (!prev || (prev.txnCode == null && r.txnCode != null)) byBill.set(r.billId, r);
  }
  const dedup = [...byBill.values()].sort((a, b) => Number(a.atMs ?? 0) - Number(b.atMs ?? 0));

  // Tên đại lý (batch, đồng nhất alpha-aggregate) — chat_rooms.name theo qr_dealer_room_id.
  const roomIds = [...new Set(dedup.map((r) => r.dealerRoom).filter((x): x is string => !!x))];
  const rooms = roomIds.length ? await db.chatRoom.findMany({ where: { id: { in: roomIds } }, select: { id: true, name: true } }) : [];
  const roomName = new Map(rooms.map((r) => [r.id, r.name || `Phòng ${r.id.slice(0, 6)}`]));

  // [Admin Demo 25/9 "nhà Lâm sao VẪN hiện 1.0 ở bảng Báo cáo QR"] GIÁ BÁN ĐÈ CỦA ĐẠI LÝ phải áp Ở ĐÂY nữa.
  // Bill CHƯA khớp GD được ước tính sau-phí CHỈ theo giá của MÃ ⇒ đại lý đã set 0,95% vẫn hiện 1,0% (giá mã Bản Việt).
  // Đường /send-qr (ocr-send-service:1138) đã áp đúng ⇒ HAI MÀN LỆCH NHAU, người xem không biết tin số nào.
  // ĐẠI LÝ của dòng chưa-khớp KHÔNG đến từ giao dịch (t.qr_dealer_room_id null) mà từ: gán tay (rc.dealer) →
  // tên phòng của GD → chủ mã — ĐÚNG thứ tự frontend dùng (BaoCoReportScreen `tenDaiLyCuaRow`).
  // Khớp tên bằng dealerLooseKey (bỏ tiền tố QR-/ĐL-, bỏ dấu, bỏ kính ngữ) — cùng luật với danh bạ TK hoàn.
  const dsKhach = await db.customer.findMany({ where: { deletedAt: null }, select: { id: true, nickname: true, fullName: true } });
  const tenToiKhach = new Map<string, number>();
  for (const c of dsKhach) for (const t of [c.nickname, c.fullName]) {
    const k = t ? dealerLooseKey(t) : '';
    if (k && !tenToiKhach.has(k)) tenToiKhach.set(k, c.id);
  }
  // Phòng QR đã gán khách → tên phòng cũng tra ra khách (đại lý gán tay thường gõ theo tên phòng).
  const ccgAll = await db.customerChatGroup.findMany({ where: { unassignedAt: null }, select: { roomId: true, customerId: true } });
  const phongCoKhach = new Map<string, number>();
  for (const g of ccgAll) if (g.roomId) phongCoKhach.set(g.roomId, g.customerId);
  for (const [rid, ten] of roomName) { const cus = phongCoKhach.get(rid); const k = dealerLooseKey(ten); if (cus != null && k && !tenToiKhach.has(k)) tenToiKhach.set(k, cus); }
  const dealerFeeCache = new Map<string, number | null>();
  /** Giá bán ĐÈ (milli) của đại lý đứng tên dòng này tại ngày bill; null ⇒ caller dùng giá của mã. */
  const layGiaDeDaiLy = async (tenDaiLy: string | null | undefined, atMs: number): Promise<number | null> => {
    const k0 = tenDaiLy ? dealerLooseKey(tenDaiLy) : '';
    if (!k0) return null;
    const cus = tenToiKhach.get(k0);
    if (cus == null) return null;
    const k = `${cus}|${hcmDayMs(atMs)}`;
    if (dealerFeeCache.has(k)) return dealerFeeCache.get(k) ?? null;
    let v: number | null = null;
    // R198 — KHÔNG nuốt câm: đọc hỏng phải log rõ rồi mới rơi về giá mã.
    try { v = await resolveQrDealerSellFee(db, cus, new Date(atMs)); }
    catch (e) { console.error(`[baoco-report] KHÔNG đọc được giá đè đại lý (customer=${cus}) → dùng giá của mã:`, e); }
    dealerFeeCache.set(k, v);
    return v;
  };

  const rows: BaoCoReportRow[] = [];
  const byDayMap = new Map<string, { day: string; doanhSo: number; count: number; countUnreconciled: number; loiNhuan: number }>();
  let tDoanhSo = 0, tCount = 0, tUnrec = 0, tLoiNhuan = 0, tSauPhiBan = 0, tSauPhiMua = 0;
  let stt = 0;
  // (audit 5/9 — MEDIUM many-to-one): 2 báo-có khớp CÙNG 1 GD (cùng HKD+tiền+giờ, chỉ 1 bill ghi) → lãi SigMa/phí thuộc
  // 1 GD, CẤM cộng 2 lần. Đếm phí/lãi theo matched_bill_key: dòng đầu tính, dòng sau = DUPLICATE (cờ đỏ, lãi/phí=null,
  // KHÔNG cộng totals). doanhSo GIỮ cả 2 (mỗi báo-có = 1 lần ghi có THẬT của ngân hàng — để người xem quyết).
  const seenMatchedKey = new Set<string>();
  const feeCache = new Map<string, Awaited<ReturnType<typeof resolveQrFeeForTid>> | null>();
  for (const r of dedup) {
    stt += 1;
    const amount = r.amount == null ? 0 : Number(r.amount);
    const matched = r.txnCode != null;
    let isDuplicateMatch = false;
    if (matched && r.txnCode) {
      if (seenMatchedKey.has(r.txnCode)) isDuplicateMatch = true;
      else seenMatchedKey.add(r.txnCode);
    }
    const countable = matched && !isDuplicateMatch;
    const phiMua = countable ? Number(r.revPartner ?? 0) : null;            // = revenue_partner
    let loiNhuan = countable ? Number(r.revSell ?? 0) : null;               // = revenue_sell = phíBán − phíMua
    const phiBan = countable ? (phiMua ?? 0) + (loiNhuan ?? 0) : null;      // phíBán = phíMua + spread
    let sauPhiMua = phiMua == null ? null : amount - phiMua;
    let sauPhiBan = phiBan == null ? null : amount - phiBan;
    // [Admin Demo 15/9 "sigma có chưa? set đi"] Bill CHƯA khớp GD nhưng CÓ MÃ NGUỒN → TÍNH SẴN sau-phí theo
    // GIÁ ĐÃ SET của mã (engine resolveQrFeeForTid — mã đè đối tác, weekend-aware theo NGÀY BILL) như CQR,
    // không để "—". Lãi SigMa vẫn null (không bịa lãi khi chưa có GD thật). Cache per (mã, ngày).
    // [PHẢN BIỆN 21/9 — C2 CONFIRMED] Điều kiện cũ `!countable` bao cả dòng DUPLICATE (đã khớp GD nhưng là bản
    // trùng) → dòng trùng được GÁN LẠI lãi/sau-phí ƯỚC TÍNH rồi cộng totals lần 2 ⇒ "Lợi nhuận SigMa" phồng ~x2
    // mỗi cặp báo-có trùng. Nhánh ước tính CHỈ dành cho bill CHƯA TỪNG khớp GD nào (`!matched`); DUPLICATE giữ
    // null tuyệt đối như thiết kế chống đếm-kép 5/9.
    if (!matched && r.sourceTidId != null && amount > 0 && r.atMs != null) {
      const kFee = `${r.sourceTidId}|${hcmDayMs(Number(r.atMs))}`;
      let fee = feeCache.get(kFee);
      if (fee === undefined) {
        try { fee = await resolveQrFeeForTid(db, { tidId: Number(r.sourceTidId), partnerId: r.srcPartnerId == null ? null : Number(r.srcPartnerId) }, new Date(Number(r.atMs))); }
        catch { fee = null; }
        feeCache.set(kFee, fee);
      }
      if (fee?.ok) {
        // [Admin Demo 16/9 tối "phí tiền nhanh/tiền chờ"] loại phí per bill (qr_baoco_recon.fee_type, mặc định CHỜ);
        // 'nhanh' chỉ ăn khi mã CÓ giá nhanh (phi_ban_nhanh) — thiếu giá → giữ chờ, không bịa.
        // Bậc NHANH giữ giá riêng của MÃ (không áp đè đại lý) — đúng luật ocr-send-service:1145, hai màn đồng bộ.
        const tenDl = r.manualDealer ?? (r.dealerRoom ? roomName.get(r.dealerRoom) ?? null : null) ?? r.maChuName;
        const deDaiLy = await layGiaDeDaiLy(tenDl, Number(r.atMs));
        const banMilli = r.feeType === 'nhanh' && fee.phiBanNhanhMilli != null
          ? fee.phiBanNhanhMilli
          : (deDaiLy ?? fee.phiBanMilli);
        sauPhiBan = amount - Math.round((amount * banMilli) / 100000);
        sauPhiMua = amount - Math.round((amount * fee.phiMuaMilli) / 100000);
        // [Admin Demo 16/9 "check lại sao không có lợi nhuận"] Bill CHƯA khớp GD: lãi ước = phíBán − phíMua
        // (= sauPhiMua − sauPhiBan) — suy TRỰC TIẾP từ 2 cột đã hiện theo GIÁ ĐÃ SET, không bịa thêm gì.
        // Khi bill khớp GD thật, revenue_sell thay thế (nhánh countable ở trên thắng).
        loiNhuan = sauPhiMua - sauPhiBan;
      }
    }
    const atMs = r.atMs == null ? null : Number(r.atMs);
    const displayStatus = isDuplicateMatch ? 'DUPLICATE' : r.reconcileStatus;
    rows.push({
      stt, dateIso: atMs == null ? null : new Date(atMs).toISOString(), hkdName: r.hkdName, amount,
      payerName: r.payerName, billId: r.billId, externalRefNo: r.extRef,
      sauPhiBan, sauPhiMua, loiNhuanAlpha: loiNhuan,
      dealerName: r.dealerRoom ? (roomName.get(r.dealerRoom) ?? null) : null,
      reconcileStatus: displayStatus,
      nguon: r.nguonBank ?? null,
      manualDs: r.manualDs ?? null,
      refundDone: r.refundDone ?? null,
      feeType: (r.feeType === 'nhanh' ? 'nhanh' : 'cho'),
      coPhiNhanh: ((): boolean => {
        if (countable || r.sourceTidId == null) return false;
        const f = feeCache.get(`${r.sourceTidId}|${hcmDayMs(Number(r.atMs ?? 0))}`);
        return f?.ok === true && f.phiBanNhanhMilli != null; // narrowing qua biến — union NO_QR_FEE không có field này
      })(),
      manualDealer: r.manualDealer ?? null,
      maChuName: r.maChuName ?? null,
      sourceTidId: r.sourceTidId == null ? null : Number(r.sourceTidId)
    });
    tDoanhSo += amount; tCount += 1;
    const isUnrec = displayStatus !== 'MATCHED'; // DUPLICATE cũng tính "chưa đối soát chuẩn" để người xem soi.
    if (isUnrec) tUnrec += 1;
    if (loiNhuan != null) tLoiNhuan += loiNhuan;
    if (sauPhiBan != null) tSauPhiBan += sauPhiBan;
    if (sauPhiMua != null) tSauPhiMua += sauPhiMua;
    if (atMs != null) {
      const day = hcmDayMs(atMs);
      const d = byDayMap.get(day) ?? { day, doanhSo: 0, count: 0, countUnreconciled: 0, loiNhuan: 0 };
      d.doanhSo += amount; d.count += 1; if (isUnrec) d.countUnreconciled += 1; if (loiNhuan != null) d.loiNhuan += loiNhuan;
      byDayMap.set(day, d);
    }
  }
  // [Admin Demo 15/9] BILL MỚI NHẤT LÊN ĐẦU: mọi tính toán (dedup DUPLICATE theo dòng sớm, totals, byDay) giữ
  // nguyên chiều ASC như cũ — chỉ ĐẢO thứ tự HIỂN THỊ + đánh lại STT (client filter cũng tự đánh lại theo hiển thị).
  rows.reverse();
  rows.forEach((r, i) => { r.stt = i + 1; });
  const byDay = [...byDayMap.values()].sort((a, b) => a.day.localeCompare(b.day));
  // [Admin Demo 14/9 — CQR] CẢNH BÁO ĐỎ trong báo cáo: doanh số NGÀY của MÃ ≥ hạn mức (app_settings qr.dailyLimit).
  const perMaDay = new Map<string, { tidId: number; hkdName: string | null; day: string; doanhSo: number }>();
  for (const r of dedup) {
    if (r.sourceTidId == null || r.atMs == null) continue;
    const day = hcmDayMs(Number(r.atMs));
    const k = `${r.sourceTidId}|${day}`;
    const e = perMaDay.get(k) ?? { tidId: Number(r.sourceTidId), hkdName: r.hkdName, day, doanhSo: 0 };
    e.doanhSo += r.amount == null ? 0 : Number(r.amount);
    perMaDay.set(k, e);
  }
  let limitWarnings: Array<{ tidId: number; hkdName: string | null; day: string; doanhSo: number; limit: number }> = [];
  try {
    const limits = await readQrDailyLimits(db);
    limitWarnings = [...perMaDay.values()]
      .filter((e) => { const lim = limits[e.tidId]; return lim != null && lim > 0 && e.doanhSo >= lim; })
      .map((e) => ({ ...e, limit: limits[e.tidId] }))
      .sort((a, b) => a.day.localeCompare(b.day) || b.doanhSo - a.doanhSo);
  } catch { /* thiếu bảng/setting → không cảnh báo, không vỡ báo cáo */ }
  return {
    from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
    rows, byDay,
    // [Admin Demo 7/9 — FIX GỐC] totals PHẢI dùng `amount`/`loiNhuanAlpha` (khớp hợp đồng client BaoCoReport.totals + tên
    // cột dòng) — TRƯỚC trả `doanhSo`/`loiNhuan` → client đọc t.amount/t.loiNhuanAlpha = undefined → thẻ tổng hiện "—"
    // (số GD + chưa đối soát trùng tên nên vẫn hiện). byDay giữ doanhSo/loiNhuan (hợp đồng BaoCoDayKpi khớp).
    totals: { amount: tDoanhSo, count: tCount, countUnreconciled: tUnrec, loiNhuanAlpha: tLoiNhuan, sauPhiBan: tSauPhiBan, sauPhiMua: tSauPhiMua },
    limitWarnings
  };
}

// GET /v1/digistore/baoco-report?from&to&hkd&dealer&filter — CHỈ chủ SigMa. from/to = ISO instant HOẶC YYYY-MM-DD
// (nửa đêm HCM). Mặc định 31 ngày gần nhất. filter = matched|unreconciled (bỏ qua = tất cả).
digistoreRouter.get(
  '/v1/digistore/baoco-report',
  asyncHandler(requireSession),
  requireQrReconViewer, // [22/9] +viewer DL65 (Khach Demo F) xem; route GHI vẫn owner
  asyncHandler(async (req: Request, res: Response) => {
    const toMs = parseBoundMs(req.query.to) ?? startOfDayLocalHCM(new Date(Date.now() + 24 * 60 * 60 * 1000)).getTime();
    const fromMs = parseBoundMs(req.query.from) ?? (toMs - 31 * 24 * 60 * 60 * 1000);
    if (fromMs >= toMs) { res.status(400).json({ error: 'VALIDATION', message: 'from phải nhỏ hơn to.' }); return; }
    const dealer = typeof req.query.dealer === 'string' && req.query.dealer.trim() ? req.query.dealer.trim() : null;
    if (dealer && (dealer.length > 64 || !/^[A-Za-z0-9_-]+$/.test(dealer))) { res.status(400).json({ error: 'VALIDATION', message: 'dealer (roomId) không hợp lệ.' }); return; }
    const hkd = typeof req.query.hkd === 'string' ? req.query.hkd : null;
    const filter = typeof req.query.filter === 'string' ? req.query.filter : null;
    const tidRaw = req.query.tid != null ? Number(req.query.tid) : null;
    const tid = tidRaw != null && Number.isInteger(tidRaw) && tidRaw > 0 ? tidRaw : null;
    if (req.query.tid != null && tid == null) { res.status(400).json({ error: 'VALIDATION', message: 'tid (mã QR) không hợp lệ.' }); return; }
    // [Admin Demo 24/9] LỌC NHIỀU MÃ: tidIds=1,5,9 (tích chọn nhiều HKD). Giữ `tid` 1-mã cho client cũ.
    const tidIdsRaw = typeof req.query.tidIds === 'string' ? req.query.tidIds : '';
    const tidIds = tidIdsRaw.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
    if (tidIdsRaw && tidIds.length === 0) { res.status(400).json({ error: 'VALIDATION', message: 'tidIds (danh sách mã QR) không hợp lệ.' }); return; }
    const report = await buildBaoCoReport(fromMs, toMs, { hkd, dealer, filter, tid, tidIds: tidIds.length ? tidIds : null });
    // [Admin Demo 22/9 "Khach Demo F không xem được lợi nhuận của SigMa"] VIEWER (không owner): TƯỚC lợi nhuận Ở SERVER
    // (ẩn UI không đủ — soi network là thấy). Tước cả sauPhiMua vì lợi nhuận = sauPhiMua − sauPhiBan (suy ngược được).
    if (!isAlphaOwner(req.agent?.code)) {
      for (const r of report.rows) { (r as { loiNhuanAlpha: number | null }).loiNhuanAlpha = null; (r as { sauPhiMua: number | null }).sauPhiMua = null; }
      report.totals.loiNhuanAlpha = 0; report.totals.sauPhiMua = 0;
      for (const d of report.byDay) d.loiNhuan = 0;
    }
    res.json({ ok: true, ...report, hideProfit: !isAlphaOwner(req.agent?.code) });
  })
);

// GET /v1/digistore/baoco-export — [Admin Demo 14/10 "thêm xuất excel báo có của phần này"] TẢI .xlsx đúng bảng
// đang xem. Dùng CHUNG tham số lọc + CHUNG `buildBaoCoReport` với route báo cáo ở trên: file tải về phải khớp
// từng dòng với bảng trên màn hình, không được là đường tính thứ hai (hai đường = hai con số lệch nhau).
// Quyền: y hệt báo cáo (viewer xem được) — và viewer cũng bị TƯỚC lợi nhuận NGAY TRONG FILE, không chỉ trên UI.
digistoreRouter.get(
  '/v1/digistore/baoco-export',
  asyncHandler(requireSession),
  requireQrReconViewer,
  asyncHandler(async (req: Request, res: Response) => {
    const toMs = parseBoundMs(req.query.to) ?? startOfDayLocalHCM(new Date(Date.now() + 24 * 60 * 60 * 1000)).getTime();
    const fromMs = parseBoundMs(req.query.from) ?? (toMs - 31 * 24 * 60 * 60 * 1000);
    if (fromMs >= toMs) { res.status(400).json({ error: 'VALIDATION', message: 'from phải nhỏ hơn to.' }); return; }
    const dealer = typeof req.query.dealer === 'string' && req.query.dealer.trim() ? req.query.dealer.trim() : null;
    if (dealer && (dealer.length > 64 || !/^[A-Za-z0-9_-]+$/.test(dealer))) { res.status(400).json({ error: 'VALIDATION', message: 'dealer (roomId) không hợp lệ.' }); return; }
    const hkd = typeof req.query.hkd === 'string' ? req.query.hkd : null;
    const filter = typeof req.query.filter === 'string' ? req.query.filter : null;
    const tidIdsRaw = typeof req.query.tidIds === 'string' ? req.query.tidIds : '';
    const tidIds = tidIdsRaw.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
    if (tidIdsRaw && tidIds.length === 0) { res.status(400).json({ error: 'VALIDATION', message: 'tidIds (danh sách mã QR) không hợp lệ.' }); return; }

    const report = await buildBaoCoReport(fromMs, toMs, { hkd, dealer, filter, tidIds: tidIds.length ? tidIds : null });
    const laChu = isAlphaOwner(req.agent?.code);
    if (!laChu) {
      for (const r of report.rows) { (r as { loiNhuanAlpha: number | null }).loiNhuanAlpha = null; (r as { sauPhiMua: number | null }).sauPhiMua = null; }
      report.totals.loiNhuanAlpha = 0; report.totals.sauPhiMua = 0;
    }
    const moTaLoc = [
      filter === 'matched' ? 'đã đối soát' : filter === 'unreconciled' ? 'chưa đối soát' : null,
      hkd ? `HKD chứa "${hkd}"` : null,
      tidIds.length ? `${tidIds.length} mã QR` : null,
      dealer ? `đại lý ${dealer}` : null
    ].filter(Boolean).join(' · ');
    const buf = await buildBaoCoXlsx(report.rows, {
      from: report.from, to: report.to, loc: moTaLoc || null,
      tongSo: report.totals.count, tongTien: report.totals.amount, tongLoiNhuan: report.totals.loiNhuanAlpha
    });
    const ten = `bao-co-qr_${report.from.slice(0, 10)}_${report.to.slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${ten}"`);
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  })
);

// [Admin Demo 14/9 — Báo cáo QR full chức năng CQR] ĐỐI SOÁT TAY: tick nhiều GD → xác nhận (xanh) / bỏ (đỏ, GIỮ đại lý).
digistoreRouter.post('/v1/digistore/baoco-recon', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const ids = Array.isArray(req.body?.billIds) ? req.body.billIds.map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 500) : [];
  if (ids.length === 0) { res.status(400).json({ error: 'VALIDATION', message: 'Chưa chọn giao dịch nào.' }); return; }
  const daDoiSoat = req.body?.daDoiSoat === true;
  const dealer = typeof req.body?.dealer === 'string' && req.body.dealer.trim() ? req.body.dealer.trim().slice(0, 120) : null;
  const agentId = (req as unknown as { agent?: { id?: number } }).agent?.id ?? null;
  const db = getBotDb();
  for (const id of ids) {
    if (daDoiSoat) {
      await db.$executeRawUnsafe(
        `INSERT INTO qr_baoco_recon (bill_id, dealer, ds, by_agent, updated_at) VALUES ($1, $2, true, $3, now())
         ON CONFLICT (bill_id) DO UPDATE SET ds = true, dealer = COALESCE($2, qr_baoco_recon.dealer), by_agent = $3, updated_at = now()`,
        id, dealer, agentId);
    } else {
      await db.$executeRawUnsafe(
        `INSERT INTO qr_baoco_recon (bill_id, dealer, ds, by_agent, updated_at) VALUES ($1, $2, false, $3, now())
         ON CONFLICT (bill_id) DO UPDATE SET ds = false, by_agent = $3, updated_at = now()`,
        id, dealer, agentId);
    }
  }
  res.json({ ok: true, message: daDoiSoat ? `✅ Đã đối soát ${ids.length} giao dịch${dealer ? ' → ' + dealer : ''}.` : `↩ Bỏ đối soát ${ids.length} giao dịch.` });
}));

// GÁN ĐẠI LÝ 1 GD (dropdown trong bảng) — KHÔNG đổi trạng thái đối soát (chưa có bản ghi → ds=false).
digistoreRouter.post('/v1/digistore/baoco-recon-dealer', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const billId = String(req.body?.billId ?? '').trim();
  if (!billId) { res.status(400).json({ error: 'VALIDATION', message: 'Thiếu billId.' }); return; }
  const dealer = typeof req.body?.dealer === 'string' && req.body.dealer.trim() ? req.body.dealer.trim().slice(0, 120) : null;
  const agentId = (req as unknown as { agent?: { id?: number } }).agent?.id ?? null;
  await getBotDb().$executeRawUnsafe(
    `INSERT INTO qr_baoco_recon (bill_id, dealer, ds, by_agent, updated_at) VALUES ($1, $2, false, $3, now())
     ON CONFLICT (bill_id) DO UPDATE SET dealer = $2, by_agent = $3, updated_at = now()`,
    billId, dealer, agentId);
  res.json({ ok: true, message: dealer ? `Đã gán đại lý ${dealer}.` : 'Đã bỏ gán đại lý.' });
}));

// DANH MỤC ĐẠI LÝ cho dropdown gán/đối soát — đại lý = khách SigMa (nickname/full_name, lọc mã tự sinh). CHỈ chủ SigMa.
// [Admin Demo 16/9 "tạo nhóm mới sao không hiện nhóm để chọn"] GỘP thêm tên từ NHÓM CHAT "QR - x"/"ĐL - x" (bỏ tiền
// tố): quy trình thật là tạo NHÓM trước, khách (customers) tạo sau/không tạo → đại lý mới phải chọn được ngay.
// [Admin Demo 25/9 "sao drop chọn ĐL Lâm chưa có? mỗi lần làm không kiểm chứng à? — CẤM TÁI DIỄN"]
// Tách hàm THUẦN để KHOÁ BẰNG TEST: ca thật 25/9 — nhóm tạo tên "ĐL- Lâm QN" nên đại lý KHÔNG lên dropdown,
// lọt tới tận Admin Demo. Luật ở đây chỉ có một: **chỉ nhóm tiền tố "QR" mới thành đại lý QR**. Ai đổi luật này
// phải sửa test đi kèm (dealer-names-prefix.test.ts) — không còn sửa ngầm trong thân route được nữa.
// LỌC và CẮT tiền tố PHẢI nằm CÙNG MỘT CHỖ. Trước 25/9 luật bị xé đôi: lọc ở SQL (ILIKE 'QR %'…), cắt ở JS —
// nên hàm JS đứng một mình lại nhận cả "ĐL- Lâm QN", không test khoá được. Nay hàm này tự lọc: phải có DẤU TÁCH
// (khoảng trắng hoặc -_—–) sau "QR", để "QRS Corp" không bị xén thành "S Corp".
export function tenDaiLyTuNhomQr(tenNhom: Array<string | null>): string[] {
  const seen = new Map<string, string>();
  for (const raw of tenNhom) {
    const t = String(raw ?? '');
    const m = /^\s*QR(?:\s*[-_—–]\s*|\s+)/i.exec(t);
    if (!m) continue;                       // không phải nhóm QR → KHÔNG phải đại lý QR
    const x = t.slice(m[0].length).trim();
    if (!x) continue;
    const k = x.toLocaleUpperCase('vi');
    if (!seen.has(k)) seen.set(k, x);
  }
  return [...seen.values()];
}
digistoreRouter.get('/v1/digistore/dealer-names', asyncHandler(requireSession), requireQrReconViewer /* [22/9] viewer xem */, asyncHandler(async (_req: Request, res: Response) => {
  // [Admin Demo 16/9 chốt sau 2 vòng] Dropdown đại lý QR = CHỈ tên rút từ NHÓM CHAT tiền tố "QR" (bỏ tiền tố).
  // KHÔNG kéo danh mục customers (lẫn đại lý POS thành rác), KHÔNG nhóm "ĐL -". Muốn đại lý hiện ở đây:
  // đặt tên nhóm "QR - Tên". Dedupe không phân biệt hoa/thường, giữ bản viết đầu gặp.
  const nhom = await getBotDb().$queryRawUnsafe<Array<{ name: string | null }>>(
    `SELECT name FROM chat_rooms WHERE deleted_at IS NULL AND type = 'GROUP' AND (name ILIKE 'QR %' OR name ILIKE 'QR-%' OR name ILIKE 'QR_%') ORDER BY name ASC`);
  res.json({ ok: true, dealers: tenDaiLyTuNhomQr(nhom.map((r) => r.name)) });
}));

// ═══ [Admin Demo 16/9 — VIETQR HOÀN ĐẠI LÝ] TK nhận hoàn per đại lý + đánh dấu ĐÃ HOÀN + proxy ảnh VietQR ═══
// Chuẩn hoá khoá đại lý (không dấu-hoa-thường) — cùng 1 đại lý viết hoa/thường vẫn 1 dòng cấu hình.
function dealerKeyOf(s: string): string { return s.trim().toLocaleUpperCase('vi'); }
/** [Admin Demo 16/9 tối "QR và ĐL dùng chung tài khoản"] Khoá SO KHỚP LỎNG: bỏ tiền tố nhóm (QR -/ĐL -), bỏ dấu,
 *  bỏ ký tự không chữ-số. "QR - Quỳnh SG" ≡ "ĐL - Quynh SG" ≡ "QUỲNH SG" → cùng 1 đại lý, dùng chung danh bạ TK. */
export function dealerLooseKey(s: string): string {
  let t = String(s ?? '');
  // Bỏ tiền tố nhóm LẶP ("QR - ĐL Thông" → "Thông") — trước chỉ bỏ 1 lần nên 2 nhóm cùng nhà vẫn lệch key.
  for (let i = 0; i < 3; i++) t = t.replace(/^\s*(QR|ĐL|DL)\s*[-_—–]?\s*/i, '');
  t = t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toUpperCase();
  // Bỏ KÍNH NGỮ đầu tên — ca thật 16/9: nhóm "ĐL- Mr. Bảo SG" KHÔNG khớp TK lưu tên "Bảo SG" ⇒ modal hoàn
  // không hiện 2 TK nhà Bảo. Chỉ bỏ ở ĐẦU chuỗi, không đụng chữ giữa tên.
  for (let i = 0; i < 2; i++) t = t.replace(/^\s*(MR|MRS|MS|MSS|ANH|CHI|CO|CHU|BAC)[\s.]+/, '');
  t = t.replace(/SAI\s*GON/g, 'SG'); // "Anh Bình Sài Gòn" ≡ "Bình SG"
  return t.replace(/[^A-Z0-9]/g, '');
}
/** Tra DANH SÁCH TK nhận hoàn của 1 đại lý: khớp CHÍNH XÁC trước; không có → khớp LỎNG (bỏ dấu/tiền tố) để QR và
 *  ĐL cùng tên dùng chung TK. Bảng nhỏ (mỗi đại lý vài dòng) nên quét toàn bảng an toàn về hiệu năng. */
async function timTkDaiLy(db: ReturnType<typeof getBotDb>, dealer: string): Promise<Array<{ bank_code: string; account_no: string; account_name: string; dealer_label: string; is_default: boolean }>> {
  const rows = await db.$queryRawUnsafe<Array<{ bank_code: string; account_no: string; account_name: string; dealer_label: string; is_default: boolean; dealer_key: string }>>(
    `SELECT dealer_key, bank_code, account_no, account_name, dealer_label, is_default FROM qr_dealer_refund_account ORDER BY is_default DESC, id ASC`);
  const chinhXac = rows.filter((r) => r.dealer_key === dealerKeyOf(dealer));
  if (chinhXac.length > 0) return chinhXac;
  const lk = dealerLooseKey(dealer);
  return lk ? rows.filter((r) => dealerLooseKey(r.dealer_key) === lk) : [];
}
/** LÀM TRÒN XUỐNG NGHÌN (lệnh Admin Demo 16/9: "999đ làm tròn dưới, không tròn trên") — SỐ TIỀN hoàn in trên QR. */
export function lamTronNghinXuong(n: number): number { return Math.max(0, Math.floor(n / 1000) * 1000); }

// GET ?dealer= → DANH SÁCH TK nhận hoàn của đại lý (TK mặc định đứng đầu; [] nếu chưa cấu hình). CHỈ chủ SigMa.
// [Admin Demo 16/9 tối "1 đại lý có nhiều TK"] Trả `accounts` (list) + giữ `account` (=TK mặc định) cho client cũ.
digistoreRouter.get('/v1/digistore/dealer-refund-account', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const dealer = String(req.query['dealer'] ?? '').trim();
  if (!dealer) { res.status(400).json({ error: 'NO_DEALER', message: 'Thiếu tên đại lý.' }); return; }
  const rows = await timTkDaiLy(getBotDb(), dealer); // khớp chính xác → fallback khớp lỏng (QR/ĐL chung TK)
  const accounts = rows.map((r) => ({ bankCode: r.bank_code, accountNo: r.account_no, accountName: r.account_name, dealer: r.dealer_label, isDefault: r.is_default }));
  res.json({ ok: true, account: accounts[0] ?? null, accounts });
}));

// POST — quản lý TK nhận hoàn (nhiều TK/đại lý — Admin Demo 16/9 tối). CHỈ chủ SigMa. Các thao tác:
//   {dealer, bankCode, accountNo, accountName, isDefault?}  → THÊM/SỬA 1 TK (upsert theo dealer+STK, không đè TK khác)
//   {dealer, setDefaultAccountNo}                            → đặt TK mặc định (QR hiện trước)
//   {dealer, deleteAccountNo}                                → xoá ĐÚNG 1 TK
digistoreRouter.post('/v1/digistore/dealer-refund-account', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const dealer = String(req.body?.dealer ?? '').trim();
  if (!dealer) { res.status(400).json({ error: 'NO_DEALER', message: 'Thiếu tên đại lý.' }); return; }
  const key = dealerKeyOf(dealer);
  const db = getBotDb();
  const delNo = String(req.body?.deleteAccountNo ?? '').replace(/\s/g, '');
  if (delNo) {
    await db.$executeRawUnsafe(`DELETE FROM qr_dealer_refund_account WHERE dealer_key = $1 AND account_no = $2`, key, delNo);
    // TK mặc định bị xoá → dòng cũ nhất còn lại lên mặc định (không để đại lý mất mặc định câm).
    await db.$executeRawUnsafe(
      `UPDATE qr_dealer_refund_account a SET is_default = true
        WHERE a.dealer_key = $1 AND a.id = (SELECT min(b.id) FROM qr_dealer_refund_account b WHERE b.dealer_key = $1)
          AND NOT EXISTS (SELECT 1 FROM qr_dealer_refund_account c WHERE c.dealer_key = $1 AND c.is_default)`, key);
    res.json({ ok: true, message: `Đã xoá TK ${delNo} của ${dealer}.` }); return;
  }
  const setDef = String(req.body?.setDefaultAccountNo ?? '').replace(/\s/g, '');
  if (setDef) {
    await db.$executeRawUnsafe(`UPDATE qr_dealer_refund_account SET is_default = (account_no = $2), updated_at = now() WHERE dealer_key = $1`, key, setDef);
    res.json({ ok: true, message: `Đã đặt TK mặc định ${setDef} cho ${dealer}.` }); return;
  }
  const bankCode = String(req.body?.bankCode ?? '').trim().toUpperCase();
  const accountNo = String(req.body?.accountNo ?? '').replace(/\s/g, '');
  const accountName = String(req.body?.accountName ?? '').trim().toUpperCase();
  // Fail-closed từng trường (TIỀN sẽ chuyển theo TK này): bank 2-20 chữ-số, STK 4-25 số, tên ≥ 3 ký tự.
  if (!/^[A-Z0-9]{2,20}$/.test(bankCode)) { res.status(400).json({ error: 'BAD_BANK', message: 'Mã ngân hàng không hợp lệ (vd MB, VCB, BIDV, VPB, ACB, TCB…).' }); return; }
  if (!/^[0-9]{3,25}$/.test(accountNo)) { res.status(400).json({ error: 'BAD_ACCOUNT', message: 'Số tài khoản phải là 3-25 chữ số.' }); return; }
  if (accountName.length < 3) { res.status(400).json({ error: 'BAD_NAME', message: 'Thiếu TÊN CHỦ TÀI KHOẢN (in trên QR để người chuyển đối chiếu).' }); return; }
  const macDinh = req.body?.isDefault === true;
  await db.$executeRawUnsafe(
    `INSERT INTO qr_dealer_refund_account (dealer_key, dealer_label, bank_code, account_no, account_name, is_default, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (dealer_key, account_no) DO UPDATE SET dealer_label = $2, bank_code = $3, account_name = $5,
       is_default = qr_dealer_refund_account.is_default OR $6, updated_at = now()`,
    key, dealer, bankCode, accountNo, accountName, macDinh);
  if (macDinh) await db.$executeRawUnsafe(`UPDATE qr_dealer_refund_account SET is_default = (account_no = $2) WHERE dealer_key = $1`, key, accountNo);
  // Đại lý chưa có mặc định (TK đầu tiên) → TK này thành mặc định.
  await db.$executeRawUnsafe(
    `UPDATE qr_dealer_refund_account SET is_default = true WHERE dealer_key = $1 AND account_no = $2
       AND NOT EXISTS (SELECT 1 FROM qr_dealer_refund_account c WHERE c.dealer_key = $1 AND c.is_default)`, key, accountNo);
  res.json({ ok: true, message: `Đã lưu TK của ${dealer}: ${bankCode} ${accountNo} (${accountName}).` });
}));

// POST {billIds[], dealer, amount} — XÁC NHẬN ĐÃ HOÀN đợt: CHỈ bill ĐÃ đối soát tay (ds=true) mới được đánh hoàn
// (fail-closed — xanh phải đủ 2 xác nhận thật). Ghi sổ đợt audit.
digistoreRouter.post('/v1/digistore/refund-done', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const billIds = Array.isArray(req.body?.billIds) ? (req.body.billIds as unknown[]).map((x) => String(x)).filter(Boolean) : [];
  const dealer = String(req.body?.dealer ?? '').trim();
  const amount = Math.round(Number(req.body?.amount));
  if (billIds.length === 0) { res.status(400).json({ error: 'NO_BILLS', message: 'Thiếu danh sách GD của đợt hoàn.' }); return; }
  if (!dealer || !Number.isFinite(amount) || amount <= 0) { res.status(400).json({ error: 'BAD_INPUT', message: 'Thiếu đại lý / số tiền đợt hoàn.' }); return; }
  const agentId = (req as unknown as { agent?: { id?: number } }).agent?.id ?? null;
  const r = await markRefundDone(getBotDb(), billIds, dealer, amount, agentId);
  if (!r.ok) { res.status(400).json({ error: r.error, message: r.message }); return; }
  res.json({ ok: true, message: r.message });
}));

/** LÕI đánh dấu ĐÃ HOÀN đợt (tách export để test đường thật): CHỈ bill đã đối soát tay (ds=true) mới được đánh —
 *  fail-closed, XANH phải đủ 2 xác nhận thật. Ghi sổ qr_refund_batch audit. */
export async function markRefundDone(db: ReturnType<typeof getBotDb>, billIds: string[], dealer: string, amount: number, agentId: number | null): Promise<{ ok: true; message: string } | { ok: false; error: string; message: string }> {
  const ok = await db.$queryRawUnsafe<Array<{ bill_id: string }>>(
    `SELECT bill_id FROM qr_baoco_recon WHERE bill_id = ANY($1) AND ds = true`, billIds);
  const okSet = new Set(ok.map((r) => r.bill_id));
  const thieu = billIds.filter((b) => !okSet.has(b));
  if (thieu.length > 0) return { ok: false, error: 'NOT_RECONCILED', message: `${thieu.length} GD chưa xác nhận đối soát — không thể đánh ĐÃ HOÀN (xanh phải đủ 2 bước).` };
  await db.$executeRawUnsafe(`UPDATE qr_baoco_recon SET refund_done = true, refunded_at = now(), updated_at = now() WHERE bill_id = ANY($1)`, billIds);
  await db.$executeRawUnsafe(`INSERT INTO qr_refund_batch (dealer, amount, bill_ids, by_agent) VALUES ($1, $2, $3::jsonb, $4)`, dealer, amount, JSON.stringify(billIds), agentId);
  return { ok: true, message: `Đã ghi HOÀN ${billIds.length} GD cho ${dealer} · ${amount.toLocaleString('vi-VN')}đ.` };
}

// POST {billIds[]} — BỎ đánh dấu hoàn (sửa nhầm). CHỈ chủ SigMa.
digistoreRouter.post('/v1/digistore/refund-undo', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const billIds = Array.isArray(req.body?.billIds) ? (req.body.billIds as unknown[]).map((x) => String(x)).filter(Boolean) : [];
  if (billIds.length === 0) { res.status(400).json({ error: 'NO_BILLS', message: 'Thiếu danh sách GD.' }); return; }
  await getBotDb().$executeRawUnsafe(`UPDATE qr_baoco_recon SET refund_done = false, refunded_at = NULL, updated_at = now() WHERE bill_id = ANY($1)`, billIds);
  res.json({ ok: true, message: `Đã bỏ đánh dấu hoàn ${billIds.length} GD.` });
}));

// POST {billId, feeType:'cho'|'nhanh'} — chọn LOẠI PHÍ BÁN cho 1 báo-có (bill chưa khớp GD). CHỈ chủ SigMa.
digistoreRouter.post('/v1/digistore/baoco-fee-type', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const billId = String(req.body?.billId ?? '').trim();
  const feeType = req.body?.feeType === 'nhanh' ? 'nhanh' : 'cho';
  if (!billId) { res.status(400).json({ error: 'NO_BILL', message: 'Thiếu bill.' }); return; }
  const agentId = (req as unknown as { agent?: { id?: number } }).agent?.id ?? null;
  await getBotDb().$executeRawUnsafe(
    `INSERT INTO qr_baoco_recon (bill_id, ds, fee_type, by_agent, updated_at) VALUES ($1, false, $2, $3, now())
     ON CONFLICT (bill_id) DO UPDATE SET fee_type = $2, updated_at = now()`,
    billId, feeType, agentId);
  res.json({ ok: true, message: feeType === 'nhanh' ? 'Đã chuyển phí TIỀN NHANH.' : 'Đã chuyển phí TIỀN CHỜ.' });
}));

// ═══ [Admin Demo 16/9 tối — ĐỐI SOÁT + HOÀN per LÔ POS (màn Doanh số phòng)] ═══
// GET ?lotIds=1,2,3 → map trạng thái {lotId: {ds, refundDone}}. CHỈ chủ SigMa (nút chỉ hiện cho owner).
digistoreRouter.get('/v1/pos-lot/recon', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const ids = String(req.query['lotIds'] ?? '').split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0);
  if (ids.length === 0) { res.json({ ok: true, recon: {} }); return; }
  const rows = await getBotDb().$queryRawUnsafe<Array<{ lot_id: bigint; ds: boolean; refund_done: boolean; note: string | null }>>(
    `SELECT lot_id, ds, refund_done, note FROM pos_lot_recon WHERE lot_id = ANY($1)`, ids);
  const recon: Record<string, { ds: boolean; refundDone: boolean; note: string | null }> = {};
  for (const r of rows) recon[String(r.lot_id)] = { ds: r.ds, refundDone: r.refund_done, note: r.note ?? null };
  res.json({ ok: true, recon });
}));

// POST {lotIds[], ds} — xác nhận / bỏ đối soát các lô. Bỏ đối soát cũng bỏ luôn cờ hoàn (chuỗi 2 bước đổ lại).
digistoreRouter.post('/v1/pos-lot/recon', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const ids = (Array.isArray(req.body?.lotIds) ? req.body.lotIds as unknown[] : []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
  const ds = req.body?.ds === true;
  if (ids.length === 0) { res.status(400).json({ error: 'NO_LOTS', message: 'Thiếu danh sách lô.' }); return; }
  const agentId = (req as unknown as { agent?: { id?: number } }).agent?.id ?? null;
  const db = getBotDb();
  for (const id of ids) {
    await db.$executeRawUnsafe(
      `INSERT INTO pos_lot_recon (lot_id, ds, refund_done, by_agent, updated_at) VALUES ($1, $2, false, $3, now())
       ON CONFLICT (lot_id) DO UPDATE SET ds = $2, refund_done = CASE WHEN $2 THEN pos_lot_recon.refund_done ELSE false END, by_agent = $3, updated_at = now()`,
      id, ds, agentId);
  }
  res.json({ ok: true, message: ds ? `Đã xác nhận đối soát ${ids.length} lô.` : `Đã bỏ đối soát ${ids.length} lô.` });
}));

// POST {lotId, note} — [Admin Demo 21/9] GHI CHÚ per-lô, hiện ĐỒNG NHẤT ở bảng lô ĐL + báo cáo NĐT + danh sách hoàn
// tiền (một nguồn pos_lot_recon.note — sửa chỗ nào các bảng kia thấy ngay). note rỗng = xoá ghi chú.
digistoreRouter.post('/v1/pos-lot/note', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const lotId = Number(req.body?.lotId);
  if (!Number.isInteger(lotId) || lotId <= 0) { res.status(400).json({ error: 'VALIDATION', message: 'Thiếu lô.' }); return; }
  const note = String(req.body?.note ?? '').slice(0, 500).trim() || null;
  const agentId = (req as unknown as { agent?: { id?: number } }).agent?.id ?? null;
  await getBotDb().$executeRawUnsafe(
    `INSERT INTO pos_lot_recon (lot_id, ds, refund_done, note, by_agent, updated_at) VALUES ($1, false, false, $2, $3, now())
     ON CONFLICT (lot_id) DO UPDATE SET note = $2, by_agent = $3, updated_at = now()`,
    lotId, note, agentId);
  res.json({ ok: true, message: note ? 'Đã lưu ghi chú.' : 'Đã xoá ghi chú.' });
}));

// ── YÊU CẦU HOÀN TIỀN (YC) — gộp nhiều lô thành 1 lệnh chuyển (Admin Demo 17/9) ──────────────────────────────
// GET /v1/refund-request?lotIds=1,2,3 — tra mã YC của từng lô (bảng doanh số hiện cột "Mã YC").
digistoreRouter.get('/v1/refund-request', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const ids = String(req.query['lotIds'] ?? '').split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0);
  const map = await trayYcTheoLo(getBotDb(), ids);
  const yc: Record<string, { code: string; status: string; amount: number }> = {};
  for (const [lot, v] of map) yc[String(lot)] = v;
  res.json({ ok: true, yc });
}));

// GET /v1/pos-lot/cong-no?from=&to= — SỔ THEO DÕI TIỀN ĐẠI LÝ ĐANG CẦM (Admin Demo 17/9): mỗi đại lý 1 khối, liệt kê
// từng lô CHƯA hoàn kèm ngày giờ · TID · HKD · số lô · tiền, tách rõ "chưa đối soát" và "chờ hoàn".
digistoreRouter.get('/v1/pos-lot/cong-no', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const parseDay = (v: unknown, addDays = 0): Date | null => {
    const t = String(v ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
    const d = new Date(`${t}T00:00:00+07:00`);
    return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() + addDays * 86_400_000);
  };
  const hnay = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const f = parseDay(req.query['from']) ?? parseDay(hnay)!;
  const t = parseDay(req.query['to'], 1) ?? parseDay(hnay, 1)!;
  if (f >= t) { res.status(400).json({ error: 'VALIDATION', message: 'Từ ngày phải ≤ đến ngày.' }); return; }
  const data = await buildCongNoDaiLy(getBotDb(), f, t);
  res.json({ ok: true, ...data });
}));

// GET /v1/refund-request/list?dealer=&status=&limit= — SỔ YC: đại lý nào đi với mã YC nào, bao nhiêu tiền, đã
// chuyển chưa (Admin Demo 17/9 "phải có cache đại lý nào đi với mã YC bao nhiêu").
digistoreRouter.get('/v1/refund-request/list', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const dealer = String(req.query['dealer'] ?? '').trim();
  const status = String(req.query['status'] ?? '').trim().toUpperCase();
  const limit = Math.min(Math.max(Number(req.query['limit'] ?? 100), 1), 500);
  const dk = dealerKeyOf(dealer);
  const rows = await getBotDb().$queryRawUnsafe<Array<{ id: number; code: string; dealer_key: string; dealer_label: string | null; nguon: string; amount: bigint; lot_ids: unknown; bank_code: string | null; account_no: string | null; account_name: string | null; status: string; paid_at: Date | null; paid_ref: string | null; created_at: Date }>>(
    `SELECT id, code, dealer_key, dealer_label, nguon, amount, lot_ids, bank_code, account_no, account_name, status, paid_at, paid_ref, created_at
       FROM refund_request
      WHERE ($1 = '' OR dealer_key = $1) AND ($2 = '' OR status = $2)
      ORDER BY id DESC LIMIT $3`, dk, status, limit);
  res.json({ ok: true, items: rows.map((r) => ({
    id: r.id, code: r.code, dealerKey: r.dealer_key, dealerLabel: r.dealer_label, nguon: r.nguon,
    amount: Number(r.amount), lotIds: Array.isArray(r.lot_ids) ? (r.lot_ids as number[]).map(Number) : [],
    bankCode: r.bank_code, accountNo: r.account_no, accountName: r.account_name, status: r.status,
    paidAtIso: r.paid_at ? new Date(r.paid_at).toISOString() : null, paidRef: r.paid_ref,
    createdAtIso: new Date(r.created_at).toISOString()
  })) });
}));

// POST /v1/refund-request {dealerKey, dealerLabel, nguon, lotIds[], amount, bankCode, accountNo, accountName}
// → tạo YC mới (mã YC001…). Lô đã thuộc YC khác ⇒ 409 (chống trả tiền 2 lần cho 1 lô).
digistoreRouter.post('/v1/refund-request', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const agentId = (req as unknown as { agent?: { id?: number } }).agent?.id ?? null;
  const r = await taoYeuCauHoan(getBotDb(), {
    dealerKey: String(b.dealerKey ?? '').trim(), dealerLabel: b.dealerLabel ?? null,
    nguon: b.nguon === 'QR' ? 'QR' : 'DL',
    lotIds: Array.isArray(b.lotIds) ? b.lotIds as number[] : [],
    amount: Number(b.amount), bankCode: b.bankCode ?? null, accountNo: b.accountNo ?? null,
    accountName: b.accountName ?? null, byAgent: agentId
  });
  if (!r.ok) { res.status(r.error === 'LOT_DA_CO_YC' ? 409 : 400).json({ error: r.error, message: r.message, lotIds: r.lotIds }); return; }
  res.json({ ok: true, data: r.data, message: `Đã tạo ${r.data.code} · ${r.data.amount.toLocaleString('vi-VN')}đ · ${r.data.lotIds.length} lô.` });
}));

// POST /v1/refund-request/paid {code, paidRef} — xác nhận ĐÃ CHUYỂN TIỀN cho cả YC (đánh dấu hoàn mọi lô trong đó).
digistoreRouter.post('/v1/refund-request/paid', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const code = String(req.body?.code ?? '').trim().toUpperCase();
  if (!code) { res.status(400).json({ error: 'NO_CODE', message: 'Thiếu mã YC.' }); return; }
  const agentId = (req as unknown as { agent?: { id?: number } }).agent?.id ?? null;
  const r = await danhDauYcDaChuyen(getBotDb(), code, { paidRef: req.body?.paidRef ?? null, byAgent: agentId });
  if (!r.ok) { res.status(404).json({ error: r.error, message: r.message }); return; }
  res.json({ ok: true, message: `${code}: đã ghi CHUYỂN TIỀN ${r.amount.toLocaleString('vi-VN')}đ · đánh dấu hoàn ${r.lotIds.length} lô.` });
}));

// POST /v1/refund-request/cancel {code} — huỷ YC tạo nhầm (chỉ khi CHƯA chuyển tiền), nhả lô ra gộp lại.
digistoreRouter.post('/v1/refund-request/cancel', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const code = String(req.body?.code ?? '').trim().toUpperCase();
  const r = await huyYeuCauHoan(getBotDb(), code);
  if (!r.ok) { res.status(r.error === 'DA_CHUYEN' ? 409 : 404).json({ error: r.error, message: r.message }); return; }
  res.json({ ok: true, message: `Đã huỷ ${code}.` });
}));

/** LÕI đánh dấu ĐÃ HOÀN lô (fail-closed: CHỈ lô đã đối soát) — export test đường thật, ghi sổ qr_refund_batch chung. */
export async function markLotRefundDone(db: ReturnType<typeof getBotDb>, lotIds: number[], dealer: string, amount: number, agentId: number | null): Promise<{ ok: true; message: string } | { ok: false; error: string; message: string }> {
  const ok = await db.$queryRawUnsafe<Array<{ lot_id: bigint }>>(`SELECT lot_id FROM pos_lot_recon WHERE lot_id = ANY($1) AND ds = true`, lotIds);
  const okSet = new Set(ok.map((r) => Number(r.lot_id)));
  const thieu = lotIds.filter((x) => !okSet.has(x));
  if (thieu.length > 0) return { ok: false, error: 'NOT_RECONCILED', message: `${thieu.length} lô chưa xác nhận đối soát — không thể đánh ĐÃ HOÀN (xanh phải đủ 2 bước).` };
  await db.$executeRawUnsafe(`UPDATE pos_lot_recon SET refund_done = true, refunded_at = now(), updated_at = now() WHERE lot_id = ANY($1)`, lotIds);
  await db.$executeRawUnsafe(`INSERT INTO qr_refund_batch (dealer, amount, bill_ids, by_agent) VALUES ($1, $2, $3::jsonb, $4)`,
    dealer, amount, JSON.stringify(lotIds.map((x) => `lot:${x}`)), agentId);
  return { ok: true, message: `Đã ghi HOÀN ${lotIds.length} lô cho ${dealer} · ${amount.toLocaleString('vi-VN')}đ.` };
}

// POST {lotIds[], dealer, amount} — XÁC NHẬN ĐÃ HOÀN đợt lô POS.
digistoreRouter.post('/v1/pos-lot/refund-done', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const ids = (Array.isArray(req.body?.lotIds) ? req.body.lotIds as unknown[] : []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
  const dealer = String(req.body?.dealer ?? '').trim();
  const amount = Math.round(Number(req.body?.amount));
  if (ids.length === 0 || !dealer || !Number.isFinite(amount) || amount <= 0) { res.status(400).json({ error: 'BAD_INPUT', message: 'Thiếu lô / đại lý / số tiền.' }); return; }
  const agentId = (req as unknown as { agent?: { id?: number } }).agent?.id ?? null;
  const r = await markLotRefundDone(getBotDb(), ids, dealer, amount, agentId);
  if (!r.ok) { res.status(400).json({ error: r.error, message: r.message }); return; }
  res.json({ ok: true, message: r.message });
}));

// POST {lotIds[]} — bỏ đánh dấu hoàn lô (đánh nhầm).
digistoreRouter.post('/v1/pos-lot/refund-undo', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const ids = (Array.isArray(req.body?.lotIds) ? req.body.lotIds as unknown[] : []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
  if (ids.length === 0) { res.status(400).json({ error: 'NO_LOTS', message: 'Thiếu danh sách lô.' }); return; }
  await getBotDb().$executeRawUnsafe(`UPDATE pos_lot_recon SET refund_done = false, refunded_at = NULL, updated_at = now() WHERE lot_id = ANY($1)`, ids);
  res.json({ ok: true, message: `Đã bỏ đánh dấu hoàn ${ids.length} lô.` });
}));

// GET ?dealer=&amount=&info= — PROXY ảnh VietQR (img.vietqr.io compact2: đủ logo bank + STK + TÊN + SỐ TIỀN + note).
// Server tự tra TK theo đại lý (client không tự ghép URL — chống lệch STK) + trả bytes same-origin (canvas không
// taint, EXE/APK không phải mở CSP domain ngoài). CHỈ chủ SigMa.
digistoreRouter.get('/v1/digistore/vietqr-png', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const dealer = String(req.query['dealer'] ?? '').trim();
  const amount = Math.round(Number(req.query['amount']));
  const info = String(req.query['info'] ?? '').slice(0, 90);
  if (!dealer || !Number.isFinite(amount) || amount <= 0) { res.status(400).json({ error: 'BAD_INPUT', message: 'Thiếu đại lý / số tiền.' }); return; }
  const accNoChon = String(req.query['accountNo'] ?? '').replace(/\s/g, '');
  const dsTk = await timTkDaiLy(getBotDb(), dealer); // chính xác → lỏng (QR/ĐL chung TK)
  const acc = accNoChon ? dsTk.find((r) => r.account_no === accNoChon) : dsTk[0];
  if (!acc) { res.status(404).json({ error: 'NO_ACCOUNT', message: `Đại lý ${dealer} chưa cấu hình TK nhận hoàn${accNoChon ? ` (STK ${accNoChon})` : ''}.` }); return; }
  const url = `https://img.vietqr.io/image/${encodeURIComponent(acc.bank_code)}-${encodeURIComponent(acc.account_no)}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(info || `SigMa hoan QR ${dealer}`)}&accountName=${encodeURIComponent(acc.account_name)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) { res.status(502).json({ error: 'VIETQR_FAIL', message: `VietQR trả HTTP ${r.status} — kiểm mã ngân hàng/STK.` }); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') ?? 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: 'VIETQR_FAIL', message: 'Không gọi được img.vietqr.io: ' + (e instanceof Error ? e.message : String(e)) });
  }
}));

// ── [Admin Demo 22/9 — YÊU CẦU NĐT HOÀN] TK SigMa nhận tiền hoàn từ NĐT (app_settings, sửa được không cần deploy)
// + ảnh VietQR TK đó. Dùng cho nút "YC NĐT hoàn" màn Báo cáo QR: tick bill → bảng tính theo GIÁ MUA (sauPhiMua
// server đã tính per-bill, kể cả giá cuối tuần) + QR để NĐT quét chuyển. CHỈ chủ SigMa.
const NDT_REFUND_QR_KEY = 'ndt.refundQrAccount';
async function readNdtQrAccount(db: ReturnType<typeof getBotDb>): Promise<{ bankCode: string; accountNo: string; accountName: string } | null> {
  const row = await db.appSetting.findUnique({ where: { key: NDT_REFUND_QR_KEY } });
  if (!row?.value) return null;
  try {
    const v = JSON.parse(row.value) as { bankCode?: string; accountNo?: string; accountName?: string };
    if (!v.bankCode || !v.accountNo || !v.accountName) return null;
    return { bankCode: v.bankCode, accountNo: v.accountNo, accountName: v.accountName };
  } catch { return null; }
}
digistoreRouter.get('/v1/digistore/ndt-qr-account', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (_req: Request, res: Response) => {
  const acc = await readNdtQrAccount(getBotDb());
  if (!acc) { res.status(404).json({ error: 'NO_NDT_QR', message: 'Chưa cấu hình TK nhận hoàn từ NĐT (app_settings ndt.refundQrAccount).' }); return; }
  res.json({ ok: true, account: acc });
}));
digistoreRouter.get('/v1/digistore/ndt-vietqr-png', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const amount = Math.round(Number(req.query['amount']));
  const info = String(req.query['info'] ?? '').slice(0, 90);
  if (!Number.isFinite(amount) || amount <= 0) { res.status(400).json({ error: 'BAD_INPUT', message: 'Thiếu số tiền.' }); return; }
  const acc = await readNdtQrAccount(getBotDb());
  if (!acc) { res.status(404).json({ error: 'NO_NDT_QR', message: 'Chưa cấu hình TK nhận hoàn từ NĐT.' }); return; }
  const url = `https://img.vietqr.io/image/${encodeURIComponent(acc.bankCode)}-${encodeURIComponent(acc.accountNo)}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(info || 'NDT hoan SigMa')}&accountName=${encodeURIComponent(acc.accountName)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) { res.status(502).json({ error: 'VIETQR_FAIL', message: `VietQR trả HTTP ${r.status} — kiểm mã ngân hàng/STK.` }); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') ?? 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: 'VIETQR_FAIL', message: 'Không gọi được img.vietqr.io: ' + (e instanceof Error ? e.message : String(e)) });
  }
}));

// ── [Admin Demo 23/9] YCHT — YÊU CẦU HOÀN TIỀN TỪ NĐT: mỗi lần tạo = 1 mã YCHT (nội dung CK + tên file ảnh).
digistoreRouter.post('/v1/ndt-refund-request', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { billIds?: unknown; amount?: unknown; bankCode?: string; accountNo?: string; accountName?: string };
  const billIds = Array.isArray(b.billIds) ? b.billIds.map((x) => String(x)) : [];
  const r = await taoYeuCauHoanNdt(getBotDb(), {
    billIds, amount: Number(b.amount),
    bankCode: b.bankCode ?? null, accountNo: b.accountNo ?? null, accountName: b.accountName ?? null,
    byAgent: req.agent?.id ?? null
  });
  if (!r.ok) { res.status(400).json({ error: r.error, message: r.message }); return; }
  res.json({ ok: true, ycht: r.data });
}));
digistoreRouter.get('/v1/ndt-refund-request/list', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  res.json({ ok: true, list: await listYcht(getBotDb(), Number(req.query['limit'] ?? 100)) });
}));
digistoreRouter.post('/v1/ndt-refund-request/paid', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { code?: string; paidRef?: string };
  if (!b.code) { res.status(400).json({ error: 'VALIDATION', message: 'Thiếu mã YCHT.' }); return; }
  const r = await danhDauYchtDaNhan(getBotDb(), String(b.code), { paidRef: b.paidRef ?? null, byAgent: req.agent?.id ?? null });
  if (!r.ok) { res.status(409).json({ error: r.error, message: r.message }); return; }
  res.json({ ok: true, message: `${b.code}: đã đánh dấu NĐT chuyển ${r.amount.toLocaleString('vi-VN')}đ.` });
}));
digistoreRouter.post('/v1/ndt-refund-request/cancel', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { code?: string };
  if (!b.code) { res.status(400).json({ error: 'VALIDATION', message: 'Thiếu mã YCHT.' }); return; }
  const r = await huyYcht(getBotDb(), String(b.code));
  if (!r.ok) { res.status(409).json({ error: r.error, message: r.message }); return; }
  res.json({ ok: true, message: `Đã huỷ ${b.code} — các GD được nhả ra để gộp lại.` });
}));

// [Admin Demo 6/9 — HẠN MỨC QR/ngày] GET danh sách mã QR + hạn mức hiện tại (để dashboard set). CHỈ chủ SigMa.
digistoreRouter.get('/v1/qr-daily-limit', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (_req: Request, res: Response) => {
  const db = getBotDb();
  const limits = await readQrDailyLimits(db);
  const ma = await db.$queryRawUnsafe<Array<{ id: number; tid: string; hkd_name: string | null }>>(
    `SELECT id, tid, hkd_name FROM tids WHERE kind = 'QR' AND deleted_at IS NULL ORDER BY hkd_name ASC, id ASC`);
  res.json({ ok: true, limits, ma: ma.map((m) => ({ tidId: Number(m.id), tid: m.tid, hkdName: m.hkd_name })) });
}));

// POST { tidId, limit } — đặt/xoá hạn mức QR/ngày 1 mã (limit<=0 = xoá). Ghi app_settings 'qr.dailyLimit'. CHỈ chủ SigMa.
digistoreRouter.post('/v1/qr-daily-limit', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const tidId = Number(req.body?.tidId);
  const limit = Number(req.body?.limit);
  if (!Number.isInteger(tidId) || tidId <= 0) { res.status(400).json({ error: 'BAD_TID', message: 'Thiếu/không hợp lệ mã QR.' }); return; }
  const db = getBotDb();
  const cur = await readQrDailyLimits(db);
  if (Number.isFinite(limit) && limit > 0) cur[tidId] = Math.round(limit); else delete cur[tidId];
  const value = JSON.stringify(cur);
  await db.appSetting.upsert({ where: { key: QR_DAILY_LIMIT_KEY }, update: { value }, create: { key: QR_DAILY_LIMIT_KEY, value } });
  res.json({ ok: true, limits: cur });
}));

// [Admin Demo 6/9 — C] ĐÁNH GIÁ BÁO-CÓ cho 1 bill (dùng chung /check-baoco + GATE SERVER lúc sendQr). Trả status + ứng viên.
// FAIL-OPEN: creds thiếu / fetch lỗi / không resolve được mã → 'CANNOT_CHECK' (KHÔNG chặn gửi — chống chặn oan do hạ tầng).
// Chỉ 'MATCHED' = hợp lệ; NOT_FOUND/AMBIGUOUS/DUPLICATE = ngân hàng rõ chưa khớp DUY NHẤT → caller (sendQr) CHẶN.
export async function evaluateQrBaoCoStatus(
  db: ReturnType<typeof getBotDb>, bill: BillToCheck, tidId: number | null
): Promise<{ status: CheckStatus; candidates: BaoCoCandidate[] }> {
  let creds: DigistoreCreds | null = null;
  let resolvedTid: { tidId: number; tid: string; hkdName: string | null } | null = null;
  try { resolvedTid = await resolveQrTidForBill(db, { tidId, hkdName: bill.hkdName }); } catch { resolvedTid = null; }
  if (resolvedTid) {
    try { creds = await digistoreCredForTid(db, resolvedTid.tidId); } catch { return { status: 'CANNOT_CHECK', candidates: [] }; }
    if (!creds) return { status: 'CANNOT_CHECK', candidates: [] };
  }
  const now = Date.now();
  const fromMs = bill.atMs != null ? bill.atMs - RECONCILE_TIME_WINDOW_MS - FETCH_PAD_MS : now - 24 * 60 * 60 * 1000;
  const toMs = bill.atMs != null ? bill.atMs + RECONCILE_TIME_WINDOW_MS + FETCH_PAD_MS : now;
  let list: BaoCoCandidate[];
  try { list = await fetchBaoCo(creds, fromMs, toMs); } catch { return { status: 'CANNOT_CHECK', candidates: [] }; }
  try { const st = await readBaoCoReconcileStatuses(db, list.map((t) => t.billId).filter((id) => !!id)); for (const t of list) t.reconcileStatus = st.get(t.billId) ?? null; } catch { for (const t of list) t.reconcileStatus = null; }
  const r = checkBillAgainstBaoCo(bill, list, { windowMs: RECONCILE_TIME_WINDOW_MS });
  return { status: r.status, candidates: r.candidates };
}
