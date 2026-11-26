// [Admin Demo 4/9] DDL PHỤ additive cho QR bán hàng + giá cuối tuần — CỐ Ý KHÔNG đưa vào Prisma schema/client
// (tránh `prisma generate` phá server 24/24, feedback_agent_prisma_generate_breaks_live_server). Truy cập bằng raw SQL,
// đồng bộ cách repo đã dùng cho `los.bill_txn_date` / `ocr_bill_sent`. Idempotent — gọi ở boot mọi tiến trình chạm
// bảng này (bot-api, quanly-api, desktop ensureCriticalSchema, selftest). CẤM destructive.
import type { Db } from '@sigma/database';

let _ready = false;

/**
 * Đảm bảo lược đồ phụ tồn tại:
 *  - `tids.kind` ('POS'|'QR', default 'POS') — phân biệt máy POS vs mã QR bán hàng (dùng CHUNG bảng tids).
 *  - `weekend_sell_adjust` — GIẢM phí bán cuối tuần theo LOẠI THẺ (global, admin cấu hình cho MB/MBV). delta_milli ×1000.
 *  - Phí QR 2 TẦNG (Admin Demo 4/9 "qr là mua của đối tác" + "giá mua tuỳ chỉnh theo MÃ, theo đối tác"):
 *      • `qr_partner_fee` (theo ĐỐI TÁC = giá cung cấp GỐC/mặc định): mua thường/cuối tuần + bán. Gắn partner_id.
 *      • `qr_fee_rates` (theo TỪNG MÃ QR = giá THỰC TẾ, ĐÈ giá đối tác): mua thường/cuối tuần + bán. Gắn tid_id (dòng
 *        kind='QR'). Resolver: có giá theo MÃ → dùng; thiếu → rơi về giá ĐỐI TÁC (song song POS: TidSellFee đè FeeSellQuote).
 * Tất cả có kỳ hiệu lực (effective_from) + audit + soft-delete, khớp mô hình FeeRate. Cuối tuần CHỈ đổi giá MUA.
 */
export async function ensureAlphaExtraSchema(db: Db): Promise<void> {
  await db.$executeRawUnsafe(`ALTER TABLE tids ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'POS'`);

  // [Admin Demo 12/9] KHUYẾN MẠI giảm giá bán theo CỬA SỔ NGÀY (from_date ≤ at < to_date), per loại thẻ — khuôn
  // weekend_sell_adjust nhưng áp MỌI NGÀY trong cửa sổ (vd KM T9: MB/MBV −0.02% trọn 1/9→30/9).
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS promo_sell_adjust (
    id bigserial PRIMARY KEY,
    card_type_id integer NOT NULL,
    delta_milli integer NOT NULL,
    from_date timestamptz NOT NULL,
    to_date timestamptz NOT NULL,
    note text,
    created_by integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_by integer,
    updated_at timestamptz,
    deleted_at timestamptz
  )`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_promo_sell_adjust_card ON promo_sell_adjust (card_type_id, from_date DESC)`);
  // [Admin Demo 12/9 v2 — "từ ngày đến ngày, T7 CN, ngày cụ thể, POS hay QR, tắt CTKM"] mở rộng additive:
  //   kenh 'POS'|'QR' · lich 'RANGE'|'WEEKEND'|'DATES' · ngay_cu_the JSON ["YYYY-MM-DD"] (ngày HCM, lich=DATES)
  //   enabled bật/tắt · bank_id scope QR theo ngân hàng (null = mọi bank); POS scope theo card_type_id (QR để null).
  await db.$executeRawUnsafe(`ALTER TABLE promo_sell_adjust ADD COLUMN IF NOT EXISTS kenh text NOT NULL DEFAULT 'POS'`);
  await db.$executeRawUnsafe(`ALTER TABLE promo_sell_adjust ADD COLUMN IF NOT EXISTS lich text NOT NULL DEFAULT 'RANGE'`);
  await db.$executeRawUnsafe(`ALTER TABLE promo_sell_adjust ADD COLUMN IF NOT EXISTS ngay_cu_the text`);
  await db.$executeRawUnsafe(`ALTER TABLE promo_sell_adjust ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true`);
  await db.$executeRawUnsafe(`ALTER TABLE promo_sell_adjust ADD COLUMN IF NOT EXISTS bank_id integer`);
  await db.$executeRawUnsafe(`ALTER TABLE promo_sell_adjust ADD COLUMN IF NOT EXISTS deleted_by integer`);
  await db.$executeRawUnsafe(`ALTER TABLE promo_sell_adjust ALTER COLUMN card_type_id DROP NOT NULL`);
  // [Admin Demo 12/9] THƯ VIỆN BIN THẺ (tra 6-8 số đầu → ngân hàng/loại thẻ, kiểu bincheck) — offline, người SigMa
  // tự bổ sung dần. CHỈ lưu BIN (6-8 số), TUYỆT ĐỐI không lưu số thẻ đầy đủ.
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS bin_library (
    id bigserial PRIMARY KEY,
    bin varchar(8) NOT NULL,
    bank_name text NOT NULL,
    card_brand text,
    card_type text,
    note text,
    source text,
    created_by integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_by integer,
    updated_at timestamptz,
    deleted_at timestamptz
  )`);
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_bin_library_bin ON bin_library (bin) WHERE deleted_at IS NULL`);
  // R198 (audit Đợt 2 QR): `install_fee_amount` được investor-report.ts đọc nhưng KHÔNG migration/ensure nào tạo
  // → prod có (thêm tay/đường khác) nhưng fresh-install & test DB thiếu → report ném 42703. Idempotent, prod = no-op.
  await db.$executeRawUnsafe(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS install_fee_amount bigint`);
  // [Admin Demo 7/9 — MƯỢN TID] đại lý A quẹt nhờ TID của B → doanh số lô về A (người mượn), không về chủ TID. null =
  // không mượn. Ensure ở đây (KHÔNG migration → tránh drift schema.prisma) để CẢ test global-setup lẫn prod boot có cột.
  await db.$executeRawUnsafe(`ALTER TABLE los ADD COLUMN IF NOT EXISTS borrowed_by_customer_id integer`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS los_borrowed_by_customer_id_idx ON los (borrowed_by_customer_id)`);
  // [Admin Demo 7/9 — TRA SOÁT SAO KÊ] Override SỬA TAY 1 giao dịch sao kê (khoá theo Mã Tham Chiếu ref) — nhớ CACHE bền để
  // re-upload sao kê vẫn áp lần sửa gần nhất (như dedup OCR bill). kind = loại (hoàn ĐL/NĐT/chuyển/lãi/dồn vốn/khác);
  // target_name = hoàn cho ai; effective_date = ngày hiệu lực; note = ghi chú. Idempotent additive.
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS statement_txn_override (` +
      `ref text PRIMARY KEY, kind text, target_name text, effective_date text, note text, ` +
      `updated_at timestamptz(3) NOT NULL DEFAULT now())`
  );
  // [Admin Demo 7/9] CACHE toàn bộ GIAO DỊCH SAO KÊ đã nạp (lưu bền theo ngày như báo cáo doanh số) — khoá ref. Re-mở màn
  // = load lại từ đây (không cần upload lại). Upsert theo ref (re-upload cập nhật). Idempotent additive.
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS statement_txn (` +
      `ref text PRIMARY KEY, date_time text, debit bigint NOT NULL DEFAULT 0, credit bigint NOT NULL DEFAULT 0, ` +
      `cp_name text, cp_account text, cp_bank text, desc_name text, ` +
      `src_account text, src_bank text, src_holder text, day text, ` +
      `updated_at timestamptz(3) NOT NULL DEFAULT now())`
  );
  // [Admin Demo 12/9 "tra soat phai co tong so du cuoi ngay"] SO DU sau tung GD (cot "So du" sao ke) — nguon tinh
  // so du cuoi ngay tung TK SigMa. File khong co cot so du -> NULL (man hien "—" + canh bao, khong bia).
  await db.$executeRawUnsafe(`ALTER TABLE statement_txn ADD COLUMN IF NOT EXISTS balance bigint`);
  // [Admin Demo 13/9 "CUSTOMER KET… bị mất nội dung à?"] NỘI DUNG GỐC sao kê — desc_name chỉ là TÊN TRÍCH (bị cắt).
  await db.$executeRawUnsafe(`ALTER TABLE statement_txn ADD COLUMN IF NOT EXISTS descr text`);
  // [Admin Demo 13/9] CRED sao kê MB của NĐT (check báo có trong nhóm NĐT) — mật khẩu AES-GCM (digistore-secret).
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS investor_feed_creds (` +
      `investor_id int NOT NULL, bank text NOT NULL, username text NOT NULL, password_enc text NOT NULL, ` +
      `account_number text NOT NULL, updated_at timestamptz(3) NOT NULL DEFAULT now(), PRIMARY KEY (investor_id, bank))`
  );
  // [Admin Demo 13/9] SỐ DƯ CUỐI KỲ mức TÀI KHOẢN — từ dòng tổng "Số dư cuối kỳ" của file sao kê (file không có
  // cột Số dư per-GD vẫn ra số dư cuối ngày). as_of_day = ngày GD muộn nhất trong file.
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS statement_account_balance (` +
      `account text PRIMARY KEY, bank text, holder text, closing bigint NOT NULL, as_of_day text NOT NULL, ` +
      `updated_at timestamptz(3) NOT NULL DEFAULT now())`
  );
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS statement_txn_day_idx ON statement_txn (day)`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS statement_txn_src_idx ON statement_txn (src_account)`);
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS weekend_sell_adjust (` +
      `id bigserial PRIMARY KEY, ` +
      `card_type_id integer NOT NULL, ` +
      `delta_milli integer NOT NULL, ` +
      `effective_from timestamptz NOT NULL DEFAULT now(), ` +
      `created_by integer, created_at timestamptz NOT NULL DEFAULT now(), ` +
      `updated_by integer, updated_at timestamptz NOT NULL DEFAULT now(), ` +
      `deleted_at timestamptz, deleted_by integer)`
  );
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS weekend_sell_adjust_card_type_id_idx ON weekend_sell_adjust (card_type_id)`
  );
  // TẦNG 1 — giá cung cấp GỐC theo ĐỐI TÁC (mặc định; dùng khi mã QR không set giá riêng).
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS qr_partner_fee (` +
      `id bigserial PRIMARY KEY, ` +
      `partner_id integer NOT NULL, ` +
      `phi_mua_thuong integer NOT NULL, ` +
      `phi_mua_cuoi_tuan integer NOT NULL, ` +
      `phi_ban integer NOT NULL, ` +
      `effective_from timestamptz NOT NULL DEFAULT now(), ` +
      `created_by integer, created_at timestamptz NOT NULL DEFAULT now(), ` +
      `updated_by integer, updated_at timestamptz NOT NULL DEFAULT now(), ` +
      `deleted_at timestamptz, deleted_by integer)`
  );
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS qr_partner_fee_partner_id_idx ON qr_partner_fee (partner_id)`
  );
  // TẦNG 2 — giá THỰC TẾ theo TỪNG MÃ QR (đè giá đối tác). tid_id = dòng tids kind='QR'.
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS qr_fee_rates (` +
      `id bigserial PRIMARY KEY, ` +
      `tid_id integer NOT NULL, ` +
      `phi_mua_thuong integer NOT NULL, ` +
      `phi_mua_cuoi_tuan integer NOT NULL, ` +
      `phi_ban integer NOT NULL, ` +
      `effective_from timestamptz NOT NULL DEFAULT now(), ` +
      `created_by integer, created_at timestamptz NOT NULL DEFAULT now(), ` +
      `updated_by integer, updated_at timestamptz NOT NULL DEFAULT now(), ` +
      `deleted_at timestamptz, deleted_by integer)`
  );
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS qr_fee_rates_tid_id_idx ON qr_fee_rates (tid_id)`
  );
  // GIÁ BÁN QR THEO ĐẠI LÝ (Admin Demo 5/9 — "phí bán tùy khách") — lớp ĐÈ per-đại-lý trên giá bán MẶC ĐỊNH của mã/đối
  // tác (qr_fee_rates/qr_partner_fee.phi_ban). Khóa theo customer_id (đại lý=khách=1, bền hơn roomId). Chưa set →
  // rơi về giá mặc định mã (hiện 1.05% cho tất cả). KHÔNG đổi cuối tuần. Phí ×1000. Song song POS: TidSellFee đè FeeSellQuote.
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS qr_dealer_sell_fee (` +
      `id bigserial PRIMARY KEY, ` +
      `customer_id integer NOT NULL, ` +
      `phi_ban integer NOT NULL, ` +
      `effective_from timestamptz NOT NULL DEFAULT now(), ` +
      `created_by integer, created_at timestamptz NOT NULL DEFAULT now(), ` +
      `updated_by integer, updated_at timestamptz NOT NULL DEFAULT now(), ` +
      `deleted_at timestamptz, deleted_by integer)`
  );
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS qr_dealer_sell_fee_customer_id_idx ON qr_dealer_sell_fee (customer_id)`
  );
  // DEDUP GỬI BILL QR (Đợt 2, Admin Demo 4/9) — khoá theo `ref` = Số giao dịch (unique ref biên lai QR, vd
  // 6247VNIB024EN8TK). Bill QR đã gửi → chặn "đã gửi" idempotent (chống doanh số x2 — học Bug2 cross-TID +
  // feature_alpha_ocr_sent_dedup_by_imagehash). image_hash = lưới phụ khi OCR đọc lệch ref. UNIQUE(ref) → INSERT
  // ON CONFLICT DO NOTHING nguyên tử (chống 2 phiên gửi song song cùng 1 bill QR). Additive/idempotent.
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS qr_bill_sent (` +
      `id bigserial PRIMARY KEY, ` +
      `ref text NOT NULL, ` +
      `image_hash text, ` +
      `dealer_room_id text, ` +
      `amount bigint, ` +
      `sent_at timestamptz NOT NULL DEFAULT now())`
  );
  // DEDUP KEY = (ref, amount) — Admin Demo 5/9 (MED phản biện): ref-only chặn nhầm 2 bill khác tiền TRÙNG ref (OCR lệch ref
  // trên bill khác). (ref, amount): cùng bill gửi lại (cùng ref+tiền) → chặn; ref trùng KHÁC tiền = 2 bill thật → cho.
  // ⚠️ HỎI LEAD (money-risk NGƯỢC): (ref, amount) chấp nhận rủi ro OCR đọc LỆCH TIỀN cùng 1 bill (0↔6) → 2 dòng → x2 doanh
  // số. Lưới phụ image_hash có sẵn (cột) nếu LEAD muốn siết thêm. Migration idempotent: drop constraint ref cũ + unique index mới.
  await db.$executeRawUnsafe(`ALTER TABLE qr_bill_sent DROP CONSTRAINT IF EXISTS qr_bill_sent_ref_uq`);
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS qr_bill_sent_ref_amount_uq ON qr_bill_sent (ref, amount)`);
  // [deep-audit A3/P1] UNIQUE (partial) image_hash → dedup ẢNH nguyên tử (khớp reserveQrSend ocr-send-service.ts).
  await db.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS qr_bill_sent_image_hash_uq ON qr_bill_sent (image_hash) WHERE image_hash IS NOT NULL`
  );
  // ATTRIBUTION ĐẠI LÝ cho GD QR (Đợt 2 — Báo cáo tổng gộp SigMa). QR tid KHÔNG gán customerId (invariant I3) → link
  // QR→đại lý = phòng đại lý CHỌN lúc gửi (dropdown). Lưu vào transactions.qr_dealer_room_id. KIỂU = TEXT vì
  // chat_rooms.id là cuid (String), KHÔNG phải bigint. Additive/idempotent. POS gom theo tid.customerId→phòng như cũ.
  await db.$executeRawUnsafe(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS qr_dealer_room_id text`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS transactions_qr_dealer_room_id_idx ON transactions (qr_dealer_room_id)`);
  // GHÉP ĐỐI SOÁT BÁO-CÓ + BÁO CÁO (Admin Demo 5/9) — additive/idempotent, cột RAW ngoài Prisma client (như qr_dealer_room_id):
  //  • qr_ref = Số giao dịch (ref) trên bill QR OCR, set lúc /send-qr → poll ghép EXACT với digistore_baoco.external_ref_no
  //    (listRecordedQrBillsFromDb trả ref). CÙNG namespace Số-giao-dịch ngân hàng.
  //  • qr_payer_name = tên người quẹt đọc trên bill QR (nhãn báo cáo/đối soát — KHÔNG đụng tiền). transactions không có
  //    field tên người quẹt → lưu raw để báo-có-report + đối soát đọc được.
  await db.$executeRawUnsafe(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS qr_ref text`);
  await db.$executeRawUnsafe(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS qr_payer_name text`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS transactions_qr_ref_idx ON transactions (qr_ref)`);
  // ĐỐI SOÁT "BÁO CÓ" DIGISTORE (BVBank) — Admin Demo 5/9. CACHE RAW idempotent giao dịch báo-có QR kéo từ portal BVBank
  // (digistore-adapter.ts fetchBaoCo). `bill_id` = mã hóa đơn merchant UUID (định danh DigiStore) → UNIQUE để UPSERT
  // (ON CONFLICT) khi poll lại cùng khoảng thời gian (KHÔNG nhân đôi). amount = bigint (VND). reconcile_status: NULL =
  // chưa đối soát; 'MATCHED' = đã khớp 1 bill QR đã ghi (matched_bill_key = mã GD/định danh bill); 'UNRECONCILED' =
  // báo-có CHƯA có bill QR ghi khớp (Admin Demo: "chưa đối soát"). Additive/idempotent; prod = no-op nếu đã có.
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS digistore_baoco (` +
      `id bigserial PRIMARY KEY, ` +
      `bill_id text NOT NULL, ` +
      `qr_code text, ` +
      `hkd_name text, ` +
      `amount bigint, ` +
      `payer_name text, ` +
      `description text, ` +
      `at_ms bigint, ` +
      `status text, ` +
      `fetched_at timestamptz NOT NULL DEFAULT now(), ` +
      `reconcile_status text, ` +
      `matched_bill_key text)`
  );
  // UNIQUE(bill_id) qua unique index (idempotent — không dùng named constraint để CREATE IF NOT EXISTS an toàn).
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS digistore_baoco_bill_id_uq ON digistore_baoco (bill_id)`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS digistore_baoco_at_ms_idx ON digistore_baoco (at_ms)`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS digistore_baoco_hkd_amount_idx ON digistore_baoco (hkd_name, amount)`);
  // PER-MÃ + GHÉP EXACT (Admin Demo 5/9) — additive/idempotent:
  //  • source_tid_id = MÃ QR (tids.id) đã kéo ra báo-có này (per-mã poll) → truy nguồn.
  //  • external_ref_no = Số giao dịch ngân hàng (CÙNG namespace Số-giao-dịch bill OCR) → ghép EXACT khi đối soát.
  await db.$executeRawUnsafe(`ALTER TABLE digistore_baoco ADD COLUMN IF NOT EXISTS source_tid_id integer`);
  await db.$executeRawUnsafe(`ALTER TABLE digistore_baoco ADD COLUMN IF NOT EXISTS external_ref_no text`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS digistore_baoco_source_tid_id_idx ON digistore_baoco (source_tid_id)`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS digistore_baoco_external_ref_no_idx ON digistore_baoco (external_ref_no)`);
  // TÀI KHOẢN DIGISTORE PER-MÃ QR (Admin Demo 5/9) — mỗi mã QR (merchant) có username + password RIÊNG. Host API là
  // MẶC ĐỊNH CHUNG (base NULL → resolver dùng DIGISTORE_BASE || bvbank default) → base cho phép NULL; username +
  // password_enc BẮT BUỘC. password_enc = AES-256-GCM (khoá env DIGISTORE_ENC_KEY, off-repo) — CẤM lưu plaintext.
  // tid_id UNIQUE → 1 mã 1 tài khoản, UPSERT (ON CONFLICT). Additive/idempotent; prod = no-op nếu đã có.
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS qr_digistore_cred (` +
      `id bigserial PRIMARY KEY, ` +
      `tid_id integer NOT NULL, ` +
      `base text, ` +
      `username text NOT NULL, ` +
      `password_enc text NOT NULL, ` +
      `updated_at timestamptz NOT NULL DEFAULT now())`
  );
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS qr_digistore_cred_tid_id_uq ON qr_digistore_cred (tid_id)`);
  // [Admin Demo 14/9 — Báo cáo QR full chức năng CQR] ĐỐI SOÁT TAY per báo-có: tick chọn GD → xác nhận (ds=true, xanh)
  // / bỏ (ds=false, giữ dealer) + GÁN ĐẠI LÝ per GD (dropdown). Độc lập reconcile_status (OCR-match tự động) —
  // 2 lớp bằng chứng song song, không ghi đè nhau. bill_id = digistore_baoco.bill_id (PaySmart chung bảng → dùng chung).
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS qr_baoco_recon (` +
      `bill_id text PRIMARY KEY, ` +
      `dealer text, ` +
      `ds boolean NOT NULL DEFAULT true, ` +
      `by_agent integer, ` +
      `updated_at timestamptz NOT NULL DEFAULT now())`
  );
  // [Admin Demo 16/9 — VietQR hoàn đại lý sau đối soát] (1) cờ ĐÃ HOÀN per báo-có (xanh CHỈ khi đối soát + hoàn đủ 2
  // xác nhận); (2) TÀI KHOẢN NHẬN HOÀN per đại lý (bank/STK/tên — nguồn gen mã VietQR); (3) sổ ĐỢT hoàn (audit
  // tổng tiền làm-tròn-xuống-nghìn + danh sách bill của đợt). Additive CREATE/ADD IF NOT EXISTS — prod no-op khi đã có.
  // [Admin Demo 16/9 khuya] MÃ ĐÓNG LÔ (95…) lưu NGAY TRÊN LÔ → mọi nơi hiển thị số lô đều ghép được "84(95)"
  // (bảng doanh số, Excel, ảnh báo cáo), không phải mò trong metadata tin nhắn như trước.
  await db.$executeRawUnsafe(`ALTER TABLE los ADD COLUMN IF NOT EXISTS settlement_code text`);
  // [Admin Demo 17/9 "đào sâu fix lỗi"] SỔ BILL CK NĐT BỊ BỎ QUA. Trước đây bill chuyển khoản trong nhóm NĐT mà hệ
  // không ghi được (người nhận không nằm trong danh sách TK SigMa, thiếu ngày/số tiền) thì KHÔNG đăng tin, KHÔNG
  // lưu gì — biến mất hoàn toàn, không màn nào thấy (đúng lớp bug vừa nuốt 1,2 tỷ). Nay ghi lại để bảng đối soát
  // hiện ra và người thật phán xử. image_hash UNIQUE → cùng ảnh quét lại không đẻ dòng mới.
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS investor_advance_skips (
    id serial PRIMARY KEY,
    investor_id integer,
    zalo_group_id text,
    amount bigint,
    bill_date text,
    receiver_name text,
    sender_name text,
    ref_number text,
    image_hash text,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_adv_skip_hash ON investor_advance_skips (image_hash) WHERE image_hash IS NOT NULL`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ix_inv_adv_skip_inv_date ON investor_advance_skips (investor_id, created_at)`);
  await db.$executeRawUnsafe(`ALTER TABLE qr_baoco_recon ADD COLUMN IF NOT EXISTS refund_done boolean NOT NULL DEFAULT false`);
  // [Admin Demo 16/9 tối] LOẠI PHÍ BÁN per báo-có: 'cho' (tiền chờ — mặc định) | 'nhanh' (tiền nhanh, vd SmartPay 1.15%).
  await db.$executeRawUnsafe(`ALTER TABLE qr_baoco_recon ADD COLUMN IF NOT EXISTS fee_type text NOT NULL DEFAULT 'cho'`);
  await db.$executeRawUnsafe(`ALTER TABLE qr_baoco_recon ADD COLUMN IF NOT EXISTS refunded_at timestamptz`);
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS qr_dealer_refund_account (` +
      `dealer_key text PRIMARY KEY, ` +
      `dealer_label text NOT NULL, ` +
      `bank_code text NOT NULL, ` +
      `account_no text NOT NULL, ` +
      `account_name text NOT NULL, ` +
      `updated_at timestamptz NOT NULL DEFAULT now())`
  );
  // [Admin Demo 16/9 tối — "1 đại lý có nhiều TK"] Nâng qr_dealer_refund_account: PK dealer_key (1 TK/đại lý) →
  // id bigserial + UNIQUE (dealer_key, account_no) + cờ is_default (TK hiện QR mặc định). Idempotent: chỉ drop PK
  // cũ khi nó còn nằm trên dealer_key; dữ liệu đã áp trong ngày giữ nguyên và tự thành TK mặc định.
  await db.$executeRawUnsafe(
    `DO $$ BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage cu ON cu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'qr_dealer_refund_account' AND tc.constraint_type = 'PRIMARY KEY' AND cu.column_name = 'dealer_key'
       ) THEN
         ALTER TABLE qr_dealer_refund_account DROP CONSTRAINT qr_dealer_refund_account_pkey;
       END IF;
     END $$`
  );
  await db.$executeRawUnsafe(`ALTER TABLE qr_dealer_refund_account ADD COLUMN IF NOT EXISTS id bigserial`);
  await db.$executeRawUnsafe(
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'qr_dealer_refund_account' AND constraint_type = 'PRIMARY KEY'
       ) THEN
         ALTER TABLE qr_dealer_refund_account ADD PRIMARY KEY (id);
       END IF;
     END $$`
  );
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_qr_dealer_refund_acct ON qr_dealer_refund_account (dealer_key, account_no)`);
  await db.$executeRawUnsafe(`ALTER TABLE qr_dealer_refund_account ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false`);
  // Đại lý chưa có TK mặc định → dòng cũ nhất thành mặc định (mỗi đại lý đúng 1).
  await db.$executeRawUnsafe(
    `UPDATE qr_dealer_refund_account a SET is_default = true
      WHERE a.id = (SELECT min(b.id) FROM qr_dealer_refund_account b WHERE b.dealer_key = a.dealer_key)
        AND NOT EXISTS (SELECT 1 FROM qr_dealer_refund_account c WHERE c.dealer_key = a.dealer_key AND c.is_default)`
  );
  // [Admin Demo 16/9 tối — "áp dụng xác nhận đối soát với bill OCR tự động/thủ công"] Đối soát + hoàn tiền per LÔ POS
  // (màn Doanh số phòng): tick nhiều lô → xác nhận đối soát → QR VietQR hoàn → xác nhận đã hoàn. Nguồn sự thật server.
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS pos_lot_recon (` +
      `lot_id bigint PRIMARY KEY, ` +
      `ds boolean NOT NULL DEFAULT false, ` +
      `refund_done boolean NOT NULL DEFAULT false, ` +
      `refunded_at timestamptz, ` +
      `by_agent integer, ` +
      `updated_at timestamptz NOT NULL DEFAULT now())`
  );
  // [Admin Demo 21/9] GHI CHÚ per-lô — hiện đồng nhất ở bảng lô ĐL + báo cáo NĐT + danh sách hoàn tiền.
  await db.$executeRawUnsafe(`ALTER TABLE pos_lot_recon ADD COLUMN IF NOT EXISTS note TEXT`);
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS qr_refund_batch (` +
      `id bigserial PRIMARY KEY, ` +
      `dealer text NOT NULL, ` +
      `amount bigint NOT NULL, ` +
      `bill_ids jsonb NOT NULL, ` +
      `by_agent integer, ` +
      `created_at timestamptz NOT NULL DEFAULT now())`
  );
  // [Admin Demo 17/9] YÊU CẦU HOÀN TIỀN (YC) — GỘP NHIỀU LÔ (của nhiều máy khác nhau) thành MỘT lệnh chuyển:
  // "chọn lô 2 3 4 5 của nhiều máy khác nhau tổng 100tr thì đó là 1 YC… mã YC này TRÙNG với nội dung gen QR VietQR
  // (vd YC001), được lưu để quản lý bill CK, xác nhận thanh toán".
  // Trước đây mỗi lô hoàn rời rạc, nội dung CK chỉ có tên đại lý ⇒ chuyển 1 lệnh gộp xong KHÔNG biết nó trả cho
  // những lô nào, đối chiếu bill CK về phải dò tay. Nay: 1 YC = 1 mã + 1 số tiền + danh sách lô cố định.
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS refund_request (` +
      `id bigserial PRIMARY KEY, ` +
      `code text NOT NULL UNIQUE, ` +              // mã hiển thị + nội dung CK: YC001, YC002…
      `dealer_key text NOT NULL, ` +               // đại lý nhận tiền (khoá chuẩn hoá, khớp qr_dealer_refund_account)
      `dealer_label text, ` +
      `nguon text NOT NULL DEFAULT 'DL', ` +       // 'DL' = hoàn lô POS · 'QR' = hoàn bill QR
      `amount bigint NOT NULL, ` +                 // tổng tiền hoàn (đã làm tròn xuống nghìn như QR)
      `lot_ids jsonb NOT NULL, ` +                 // [loId,…] các lô gộp trong YC (nhiều máy khác nhau)
      `bank_code text, account_no text, account_name text, ` + // TK nhận đã chọn lúc tạo YC (chốt lại, không trôi)
      `status text NOT NULL DEFAULT 'MOI', ` +     // MOI → DA_CHUYEN (đã bấm xác nhận đã hoàn)
      `paid_at timestamptz, ` +
      `paid_ref text, ` +                          // mã GD của bill CK khớp YC (điền khi đối chiếu)
      `by_agent integer, ` +
      `created_at timestamptz NOT NULL DEFAULT now(), ` +
      `updated_at timestamptz NOT NULL DEFAULT now())`
  );
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ix_refund_request_dealer ON refund_request (dealer_key, created_at DESC)`);
  // Mỗi lô chỉ thuộc ĐÚNG 1 YC đang sống → chống gộp 1 lô vào 2 yêu cầu (trả tiền 2 lần).
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS refund_request_lot (` +
      `lot_id bigint PRIMARY KEY, ` +
      `request_id bigint NOT NULL REFERENCES refund_request(id) ON DELETE CASCADE, ` +
      `created_at timestamptz NOT NULL DEFAULT now())`
  );
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ix_refund_request_lot_req ON refund_request_lot (request_id)`);

  // [Admin Demo 23/9 "mỗi lần tạo là 1 YCHT NĐT, file đặt tên theo mã YC"] YÊU CẦU HOÀN TIỀN TỪ NĐT — SigMa đòi NĐT
  // chuyển lại tiền theo GIÁ MUA của các bill QR đã tick. Mã YCHT001… đi vào nội dung CK trên VietQR + tên file ảnh
  // → nhận tiền về đối chiếu đúng đợt. Bảng CON ndt_refund_request_bill có PK bill_id = BẤT BIẾN "1 bill chỉ nằm
  // trong ĐÚNG 1 YCHT" (khuôn refund_request_lot — chính lớp khoá đã chặn vụ trả 1 lô 2 lần bên đại lý).
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS ndt_refund_request (` +
      `id bigserial PRIMARY KEY, ` +
      `code text NOT NULL UNIQUE, ` +              // YCHT001, YCHT002… (nội dung CK + tên file ảnh)
      `amount bigint NOT NULL, ` +                 // tổng NĐT phải hoàn = Σ (tiền − giá mua), tròn xuống nghìn
      `bill_ids jsonb NOT NULL, ` +                // các bill QR trong đợt
      `bank_code text, account_no text, account_name text, ` + // TK SigMa nhận (chốt lúc tạo, không trôi)
      `status text NOT NULL DEFAULT 'MOI', ` +     // MOI → DA_NHAN (NĐT đã chuyển)
      `paid_at timestamptz, paid_ref text, ` +
      `by_agent integer, ` +
      `created_at timestamptz NOT NULL DEFAULT now(), ` +
      `updated_at timestamptz NOT NULL DEFAULT now())`
  );
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ix_ndt_refund_request_created ON ndt_refund_request (created_at DESC)`);
  // [Admin Demo 23/9 CHỐT: "trùng rồi vẫn cho tạo YC, mã QR vẫn phải có"] 1 GD ĐƯỢC nằm trong NHIỀU YCHT (bản đầu
  // PK bill_id chặn cứng — Admin Demo bỏ ràng buộc đó). Vẫn lưu quan hệ để BÁO CHO NGƯỜI DÙNG biết GD nào đang nằm
  // yêu cầu cũ (cảnh báo, KHÔNG chặn) → khoá mới là cặp (request_id, bill_id): 1 GD không lặp trong CÙNG 1 YCHT.
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS ndt_refund_request_bill (` +
      `bill_id text NOT NULL, ` +
      `request_id bigint NOT NULL REFERENCES ndt_refund_request(id) ON DELETE CASCADE, ` +
      `created_at timestamptz NOT NULL DEFAULT now(), ` +
      `PRIMARY KEY (request_id, bill_id))`
  );
  // Nâng cấp bảng đã tạo sáng 23/9 (PK cũ = bill_id): đổi sang PK ghép, giữ nguyên dữ liệu.
  await db.$executeRawUnsafe(`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ndt_refund_request_bill_pkey'
                   AND (SELECT count(*) FROM unnest(conkey) ) = 1) THEN
        ALTER TABLE ndt_refund_request_bill DROP CONSTRAINT ndt_refund_request_bill_pkey;
        ALTER TABLE ndt_refund_request_bill ADD PRIMARY KEY (request_id, bill_id);
      END IF;
    END $$;`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ix_ndt_refund_request_bill_bill ON ndt_refund_request_bill (bill_id)`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ix_ndt_refund_request_bill_req ON ndt_refund_request_bill (request_id)`);

  // [Phản biện 11/9 — R198] investor_advances.image_hash: prod ĐÃ có (DDL tay từ đợt dedup ảnh 31/8) nhưng KHÔNG
  // nằm ở migration/schema.prisma/ensure nào → throwaway DB test THIẾU cột, mọi query dedup theo hash nổ 42703
  // (lỗ "check không chạy được"). Ensure ở đây: prod = no-op, test DB = có cột thật.
  await db.$executeRawUnsafe(`ALTER TABLE investor_advances ADD COLUMN IF NOT EXISTS image_hash text`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS investor_advances_image_hash_idx ON investor_advances (image_hash)`);
  // [Admin Demo DUYỆT 11/9] Lưới unique ref tạm ứng NĐT (thay uq_iadv_ref_global toàn cục cũ — DDL tay đã drop trên
  // prod, script _ddl-iadv-ref-index.mts): per (NĐT, chiều, ref) + toàn cục CHỈ ref DÀI (mã bank thật). Codify để
  // test DB ĐỒNG HÌNH prod (chống false-pass engine-drift R198). KHÔNG drop gì ở đây (ensure additive).
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_iadv_ref_per_investor_source ON investor_advances (investor_id, source, ref_number) WHERE ref_number IS NOT NULL AND deleted_at IS NULL`);
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_iadv_ref_dai_toancuc ON investor_advances (ref_number) WHERE ref_number IS NOT NULL AND deleted_at IS NULL AND (length(ref_number) >= 8 OR ref_number ~ '[^0-9]')`);
  // [Admin Demo 11/9 — mã PaySmart DEMOMAY] GIÁ BÁN 2 MỨC: tiền CHỜ (phi_ban, mặc định) + tiền NHANH (phi_ban_nhanh,
  // NULL = mã không có lựa chọn nhanh → UI ẩn dropdown, hành vi cũ giữ nguyên). Additive cả 2 bảng giá QR.
  await db.$executeRawUnsafe(`ALTER TABLE qr_fee_rates ADD COLUMN IF NOT EXISTS phi_ban_nhanh integer`);
  await db.$executeRawUnsafe(`ALTER TABLE qr_partner_fee ADD COLUMN IF NOT EXISTS phi_ban_nhanh integer`);
  // [Admin Demo 11/9 — cổng PaySmart] cred per-mã QR: user + mật khẩu + TOTP secret (2FA Google Authenticator), tất cả
  // MÃ HOÁ AES-256-GCM (chung khoá DIGISTORE_ENC_KEY). tid_id UNIQUE. Additive/idempotent.
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS qr_paysmart_cred (` +
      `id bigserial PRIMARY KEY, tid_id integer NOT NULL, base text, username text NOT NULL, ` +
      `password_enc text NOT NULL, totp_secret_enc text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`
  );
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS qr_paysmart_cred_tid_id_uq ON qr_paysmart_cred (tid_id)`);
  // [Admin Demo 14/10 "kéo xong báo có phải lưu lại cookie để tái sử dụng"] GIỮ PHIÊN PaySmart: mỗi lượt poll
  // trước đây login LẠI từ đầu (mở trình duyệt + reCAPTCHA + OTP ~20s/mã, 48 lượt/ngày × số mã). Nay cất
  // storageState (cookie + localStorage) + tham số `mch` của phiên, mã hoá AES cùng khoá với mật khẩu — phiên là
  // CHÌA KHOÁ VÀO CỔNG NGÂN HÀNG, cấm để trần. Hết hạn thì tự login lại (phiên chết không được làm hỏng lượt).
  await db.$executeRawUnsafe(`ALTER TABLE qr_paysmart_cred ADD COLUMN IF NOT EXISTS session_enc text`);
  await db.$executeRawUnsafe(`ALTER TABLE qr_paysmart_cred ADD COLUMN IF NOT EXISTS session_at timestamptz`);
  // [Admin Demo 25/9 "khi cho mượn thì được phép sửa giá bán ... cho từng đại lý, giá đã áp dụng ở đại lý khác giữ
  // nguyên"] GIÁ BÁN THEO ĐẠI LÝ: thêm chiều customer_id vào bảng giá bán thực tế của máy.
  //   · customer_id NULL = giá CHUNG của máy (đúng hành vi cũ, mọi đại lý dùng).
  //   · customer_id = X    = giá RIÊNG khi đại lý X cầm/mượn máy này — chỉ X ăn giá này, nhà khác giữ giá chung.
  // Ca thật: máy Chí Đức BM-9 (TID DEMO-TID-01) chủ là Trường Thiện SG bán 1,28%; Tuyên SG mượn cần 1,25% mà KHÔNG
  // được đụng giá của Trường Thiện SG / Oanh SG.
  await db.$executeRawUnsafe(`ALTER TABLE tid_sell_fees ADD COLUMN IF NOT EXISTS customer_id integer`);
  // [B236 22/11 — Admin Demo "thêm loại phí mua NĐT cho dễ"] PHÍ MUA CỦA NĐT (milli-%), khai NGAY CẠNH giá bán
  // theo TID × loại thẻ × kỳ hiệu lực. Mô hình tiền khép kín Admin Demo chốt 22/11:
  //     lãi NĐT   = (phí mua NĐT − phí cài máy) × doanh số
  //     lợi SigMa = (phí bán khách − phí mua NĐT) × doanh số
  // Cộng hai vế = (phí bán − phí cài máy) × doanh số = đúng phần chênh hệ thống vẫn ghi.
  // NULL = TID chưa khai ⇒ KHÔNG bịa số, báo cáo để trống và nói rõ "chưa khai phí mua NĐT".
  await db.$executeRawUnsafe(`ALTER TABLE tid_sell_fees ADD COLUMN IF NOT EXISTS phi_mua_ndt integer`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS tid_sell_fees_customer_id_idx ON tid_sell_fees (customer_id)`);
  // Unique cũ (tid, thẻ, loại phí, NGÀY) sẽ đụng khi 1 máy có giá chung + giá riêng cùng ngày ⇒ phải gộp customer
  // vào khoá (COALESCE(customer_id,0) để dòng giá CHUNG vẫn unique với nhau).
  await db.$executeRawUnsafe(`DROP INDEX IF EXISTS tid_sell_fees_active_uq`);
  await db.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS tid_sell_fees_active_uq ON tid_sell_fees ` +
      `(tid_id, card_type_id, fee_type_id, COALESCE(customer_id, 0), ((effective_from AT TIME ZONE 'Asia/Ho_Chi_Minh'::text)::date)) ` +
      `WHERE deleted_at IS NULL`
  );
  // [Admin Demo 26/9 "a — làm bảng ánh xạ"] ÁNH XẠ ĐỐI ỨNG → ĐẠI LÝ cho TRA SOÁT SAO KÊ.
  // Trước đây tra soát chỉ biết đại lý qua bill hoàn đã OCR; người như "KHACH HANG 22" (chính là ĐL Đại lý C)
  // lại còn nằm trong danh sách TÊN NỘI BỘ SIGMA ⇒ mọi GD với anh ấy bị xếp "Chuyển giữa TK", KHÔNG vào sổ
  // đại lý nào (đo 26/9: 72 GD, ra 7.184.158.000đ, vào 1.195.427.000đ biến mất khỏi sổ Đại lý C).
  //   key      : TÊN đã chuẩn hoá (bỏ dấu, bỏ ký tự lạ, HOA) hoặc SỐ TÀI KHOẢN
  //   key_kind : 'name' | 'acct'
  //   kind_out : loại GD khi TIỀN RA (mặc định DEALER_REFUND = hoàn; đặt DEALER_ADVANCE = tạm ứng cho đại lý).
  //              Tiền VÀO luôn là DEALER_RETURN (đại lý trả lại / thu hồi ứng) — Admin Demo chọn phương án A.
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS statement_dealer_alias (` +
      `id bigserial PRIMARY KEY, key text NOT NULL, key_kind text NOT NULL, customer_id integer NOT NULL, ` +
      `kind_out text, note text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`
  );
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS statement_dealer_alias_uq ON statement_dealer_alias (key, key_kind)`);
  // [Admin Demo 26/9 "cua anh Huy lam C het di"] ANH XA sang NHA DAU TU, khong chi dai ly. Ca that: sao ke
  // TECHCOMBANK KHONG ghi ten nguoi gui cho tien VAO (noi dung chi la "CK107948 CK107947") => 23 GD /
  // 2.501.602.000d ngay 25/9 roi UNKNOWN. Khoa duy nhat con lai = TAI KHOAN SIGMA NHAN (key_kind
  // 'src_acct_noname'): tien vao TK do MA doi ung khong co ten => NDT da khai.
  await db.$executeRawUnsafe(`ALTER TABLE statement_dealer_alias ADD COLUMN IF NOT EXISTS investor_id integer`);
  await db.$executeRawUnsafe(`ALTER TABLE statement_dealer_alias ALTER COLUMN customer_id DROP NOT NULL`);
  // Phai tro DUNG MOT trong hai (dai ly HOAC NDT) — chan hang rac lam khop nham tien.
  await db.$executeRawUnsafe(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'statement_dealer_alias_target_ck') THEN
         ALTER TABLE statement_dealer_alias ADD CONSTRAINT statement_dealer_alias_target_ck
           CHECK ((customer_id IS NOT NULL)::int + (investor_id IS NOT NULL)::int = 1);
       END IF;
     END $$;`);
  // [Admin Demo 15/11 — "thêm 2 ô nhập tay" cho cột NGÀY XUẤT / GIÁ XUẤT ở màn Máy POS] máy POS trước nay chỉ có
  // giá/ngày NHẬP; 2 ô XUẤT nhập tay y như giá nhập. Additive, nullable ⇒ máy cũ không đổi gì. CỐ Ý không đưa vào
  // Prisma schema (tránh `prisma generate` phá server 24/24) — đọc/ghi bằng raw SQL, khuôn `los.bill_txn_date`.
  await db.$executeRawUnsafe('ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS exported_at timestamptz');
  await db.$executeRawUnsafe('ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS export_price bigint');
  // [Admin Demo 15/11 — "set thẻ mặc định… đỡ phải chọn mỗi lần thêm bill"] mỗi ngân hàng được đánh dấu 1 loại thẻ
  // mặc định; màn Thêm bill tự chọn sẵn thẻ đó. Additive, DEFAULT false ⇒ dữ liệu cũ không đổi gì. CỐ Ý không đưa
  // vào Prisma schema (tránh `prisma generate` phá server 24/24) — đọc/ghi bằng raw SQL.
  await db.$executeRawUnsafe('ALTER TABLE card_types ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false');
  // [Admin Demo 16/11 — B172] TIỀN ĐÃ HOÀN cho đại lý + AI HOÀN, ghi NGAY TRÊN LÔ. Trước nay màn "Thêm bill" có
  // 2 ô này nhưng KHÔNG gửi lên máy chủ và danh sách trả cứng 0/'' ⇒ nhập xong tải lại là MẤT, không báo gì.
  // Đây là VẾT GHI CHÉP (ai trả, bao nhiêu, lúc nào) — KHÔNG sinh bút toán, KHÔNG đụng công nợ/doanh thu.
  await db.$executeRawUnsafe('ALTER TABLE los ADD COLUMN IF NOT EXISTS refunded_amount bigint');
  await db.$executeRawUnsafe('ALTER TABLE los ADD COLUMN IF NOT EXISTS refunded_by_user_id integer');
  await db.$executeRawUnsafe('ALTER TABLE los ADD COLUMN IF NOT EXISTS refunded_at timestamptz');
  // [Admin Demo 16/11 — B178 "làm tiền hủy và số hóa đơn luôn đi"] 2 ô cuối cùng của màn Thêm bill chưa được lưu.
  //  • `void_amount` = TIỀN HỦY trên bill. **KHÔNG đổi doanh số**: màn hình đã gửi
  //    `amountBeforeFee = tổng quẹt − tiền hủy` (BillManualEntryPage.tsx:1257) nên con số vào sổ xưa nay vẫn
  //    đúng — cái thiếu chỉ là VẾT "hủy bao nhiêu", để đối soát với sao kê ngân hàng (sao kê in TỔNG QUẸT).
  //  • `invoice_no` = SỐ HÓA ĐƠN in trên bill (chuỗi, giữ nguyên số 0 ở đầu: '000118').
  // Additive, nullable ⇒ lô cũ không đổi gì. CỐ Ý không đưa vào Prisma schema (tránh `prisma generate` phá
  // server 24/24) — đọc/ghi bằng raw SQL, khuôn `los.bill_txn_date`.
  await db.$executeRawUnsafe('ALTER TABLE los ADD COLUMN IF NOT EXISTS void_amount bigint');
  await db.$executeRawUnsafe('ALTER TABLE los ADD COLUMN IF NOT EXISTS invoice_no text');
  // [B206 19/11 — Admin Demo "thêm quyền hoàn tiền, chỉ ai được tích hoàn tiền mới hiện ở danh sách người
  // (áp dụng cho user)"] CỜ TỪNG NHÂN SỰ, không phải vai trò: ô "Người hoàn" ở màn nhập bill trước đây lọc
  // theo vai trò ACCOUNTANT/ADMIN nên ai mang vai trò đó đều hiện, không chọn được đích danh ai được hoàn.
  await db.$executeRawUnsafe('ALTER TABLE users ADD COLUMN IF NOT EXISTS can_refund boolean NOT NULL DEFAULT false');
  // [KẾ TOÁN NĐT 24/11 — Admin Demo] NĐT mà user bị KHÓA PHẠM VI. Additive, nullable ⇒ user cũ không đổi (null =
  // staff full, không khóa). TÁCH ngữ nghĩa với `investor_id` (dành cho tài khoản con R_INVESTOR tự-xem): một
  // user có thể là NHÂN VIÊN kế toán khóa NĐT mà KHÔNG phải tài khoản con của NĐT đó. Đọc/ghi bằng RAW SQL
  // (CỐ Ý ngoài Prisma client — tránh `prisma generate` phá server 24/24, khuôn can_refund/void_amount).
  await db.$executeRawUnsafe('ALTER TABLE users ADD COLUMN IF NOT EXISTS scope_investor_id integer');
  await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_users_scope_investor ON users (scope_investor_id)');
  // CHUYỂN TIẾP MỘT LẦN: bật sẵn cho đúng những người ĐANG được phép theo luật cũ (kế toán/admin còn hoạt
  // động). Không làm bước này thì ngay sau khi lên bản mới danh sách RỖNG ⇒ không ghi được bill có hoàn tiền.
  // Idempotent: chỉ chạy khi CHƯA ai được bật (lần đầu thêm cột); sau đó Admin Demo tự tích/bỏ tích trong màn Nhân sự.
  await db.$executeRawUnsafe(`
    UPDATE users u SET can_refund = true
     WHERE NOT EXISTS (SELECT 1 FROM users WHERE can_refund)
       AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
       AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                    WHERE ur.user_id = u.id AND r.code IN ('ACCOUNTANT','ADMIN'))`);
  // [Admin Demo 19/11 — B185 "thêm trường set ca tiền trong quản lý ngân hàng"] MỐC CA TIỀN THEO TỪNG NGÂN HÀNG.
  // TRƯỚC ĐÂY mốc ca nằm CỨNG trong mã nguồn (`packages/services/src/ca-tien.ts`) và CHỈ có 3 ngân hàng
  // MB/ABB/MBV ⇒ muốn đổi giờ phải sửa code + ship, còn ngân hàng khác (VP, BVB, SHI…) KHÔNG có ca nên mọi
  // báo cáo lọc theo ca loại sạch bill của họ mà không báo gì.
  // Lưu PHÚT-trong-ngày (0..1439) cho khỏi lệ thuộc định dạng chuỗi giờ. NULL = ngân hàng chưa khai ca
  // (giữ nguyên hành vi cũ: không xếp ca). Additive, nullable ⇒ dữ liệu cũ không đổi gì.
  await db.$executeRawUnsafe('ALTER TABLE banks ADD COLUMN IF NOT EXISTS ca1_het_phut integer');
  await db.$executeRawUnsafe('ALTER TABLE banks ADD COLUMN IF NOT EXISTS ca2_het_phut integer');
  // [Admin Demo 19/11 — B189 "chọn ca, thêm ca, set giờ đến giờ"] BẢNG CA TIỀN theo từng ngân hàng: mỗi ca là
  // một khoảng TỪ GIỜ → ĐẾN GIỜ, THÊM/XOÁ được bao nhiêu ca tuỳ ngân hàng (2 cột ở trên chỉ gánh được đúng
  // 3 ca cứng). Lưu PHÚT-trong-ngày 0..1439; `den_phut` là mốc CUỐI của ca (tính cả phút đó).
  // Ngân hàng không khai ca nào ⇒ không xếp ca (giữ nguyên hành vi cũ, không tự đoán).
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS bank_ca_tien (
    id bigserial PRIMARY KEY,
    bank_id integer NOT NULL,
    ten text NOT NULL,
    tu_phut integer NOT NULL,
    den_phut integer NOT NULL,
    thu_tu integer NOT NULL DEFAULT 0,
    created_by integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_by integer,
    updated_at timestamptz,
    deleted_at timestamptz
  )`);
  await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_bank_ca_tien_bank ON bank_ca_tien (bank_id, thu_tu)');
  // [B192 19/11 — ĐÃ THỬ RỒI GỠ] Từng định thêm UNIQUE (lo_id, card_type_id) trên `lo_rows` để chặn
  // race nhân đôi dòng thẻ. SAI NGHIỆP VỤ: một lô hợp lệ VẪN có thể có NHIỀU DÒNG CÙNG LOẠI THẺ (nhiều giao
  // dịch cùng thẻ trong một lô) — cổng ship bắt ngay (`lo.test.ts`: "nhiều dòng → expectedTotalAmount = TỔNG
  // amountAfterFee từng dòng" đỏ với Unique constraint failed). Chống race nay dựa vào `pg_advisory_xact_lock`
  // theo lô trong `lo-service.ts` + khẳng định sau ghi (Σ dòng = tổng lô), KHÔNG dùng ràng buộc duy nhất.
  await db.$executeRawUnsafe('DROP INDEX IF EXISTS uq_lo_rows_lo_card');

  // [Admin Demo 24/11 — "Doanh số tiền chờ / công nợ phải thu ỦY QUYỀN"] BILL NHẬP TỔNG THEO THÁNG cho TID giao đi
  // theo loại phí TIỀN CHỜ (fee_type 8) / UỶ QUYỀN (fee_type 9). KHÁC hẳn bảng Doanh Số (lô theo ngày, Đối ứng):
  // đây là chế độ nhập TỔNG/tháng per (TID × loại thẻ × loại phí) → CẤM lẫn vào Doanh Số chung (chống đếm đúp).
  //   phải_thu = marginToAmount(doanh_so_truoc_phi, phi_ban_milli − phi_cai_may_milli)  (reuse @sigma/business-rules).
  //   phi_ban_milli  = SNAPSHOT từ tid_sell_fees (tid × thẻ × loại phí) lúc nhập — chốt công nợ, đổi phí sau KHÔNG lùi.
  //   phi_cai_may_milli = SNAPSHOT từ fee_rates (đối tác của TID × thẻ) lúc nhập — cùng nguồn phí cài máy bill Đối ứng.
  // CỐ Ý KHÔNG đưa vào Prisma schema (tránh `prisma generate` phá server 24/24) — đọc/ghi bằng raw SQL, khuôn
  // `los.bill_txn_date` / `tid_sell_fees.phi_mua_ndt`. Additive/idempotent; prod = no-op nếu đã có.
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS uy_quyen_thang (
    id bigserial PRIMARY KEY,
    tid_id integer NOT NULL,
    card_type_id integer NOT NULL,
    fee_type_id integer NOT NULL,
    thang char(7) NOT NULL,
    doanh_so_truoc_phi bigint NOT NULL,
    phi_ban_milli integer NOT NULL,
    phi_cai_may_milli integer NOT NULL,
    ghi_chu text,
    created_by integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_by integer,
    updated_at timestamptz,
    deleted_at timestamptz
  )`);
  // 1 dòng sống / (TID × thẻ × loại phí × tháng) — chống trùng khi nhập lại; UPSERT đi qua khoá này.
  await db.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_uy_quyen_thang ON uy_quyen_thang ` +
      `(tid_id, card_type_id, fee_type_id, thang) WHERE deleted_at IS NULL`
  );
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ix_uy_quyen_thang_thang ON uy_quyen_thang (thang)`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ix_uy_quyen_thang_tid ON uy_quyen_thang (tid_id)`);

  _ready = true;
}

/** Gọi 1 lần lười (best-effort) — dùng khi không chắc boot đã chạy ensureAlphaExtraSchema. */
export async function ensureAlphaExtraSchemaOnce(db: Db): Promise<void> {
  if (_ready) return;
  await ensureAlphaExtraSchema(db);
}
