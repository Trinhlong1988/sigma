-- [B210 20/11 — Admin Demo "fix lỗi 7 tiếng"] ĐƯA MỐC THỜI GIAN VỀ ĐÚNG SỰ THẬT.
--
-- GỐC (đo 3 lần, không suy luận): thư viện gửi mốc xuống dạng giờ UTC NHƯNG KHÔNG kèm múi giờ; máy chủ đặt
-- TimeZone=Asia/Bangkok nên tự gán +07 ⇒ mọi mốc do chương trình ghi bị lưu SỚM 7 TIẾNG. Lúc đọc thì sai
-- ngược lại +7h nên hai cái bù nhau, app hiển thị đúng — vì thế lỗi sống nhiều tháng mà không ai thấy.
-- Bằng chứng: giao TID 50580459 lúc 17:13, sổ lưu 10:13.
--
-- BỎ QUA 6 cột vừa GHI vừa ĐỌC bằng SQL thuần nên VỐN ĐÃ ĐÚNG — dịch là làm HỎNG giờ bill và tiền NĐT.
--
-- ĐÃ CHẠY THỬ TRỌN VẸN trên bản nhân bản sổ thật (sigma_thugio) 19/11: 306 cột / 44.395 ô; sau khi dịch
-- + đổi múi giờ, danh sách bill GIỐNG HỆT, tiền tạm ứng NĐT Y NGUYÊN 160.277.541.298đ, giờ giao TID về
-- ĐÚNG 17:13.
--
-- Chạy trong MỘT giao dịch: sai bất kỳ bước nào là lùi sạch, dữ liệu nguyên như cũ.
BEGIN;

DO $$
DECLARE
  r      record;
  n      int;
  tong   bigint := 0;
  socot  int := 0;
BEGIN
  FOR r IN
    SELECT c.table_name AS b, c.column_name AS k
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema
       AND tb.table_name   = c.table_name
       AND tb.table_type   = 'BASE TABLE'
     WHERE c.table_schema = 'public'
       AND c.data_type LIKE 'timestamp%'
       AND (c.table_name || '.' || c.column_name) NOT IN (
             'los.bill_txn_date',
             'transactions.txn_date',
             'tid_sell_fees.effective_from',
             'qr_dealer_sell_fee.effective_from',
             'investor_advances.advance_date',
             'pos_devices.exported_at')
     ORDER BY 1, 2
  LOOP
    EXECUTE format('UPDATE %I SET %I = %I + interval ''7 hours'' WHERE %I IS NOT NULL', r.b, r.k, r.k, r.k);
    GET DIAGNOSTICS n = ROW_COUNT;
    tong  := tong + n;
    socot := socot + 1;
  END LOOP;
  RAISE NOTICE 'DA DICH % cot, % o', socot, tong;
END $$;

COMMIT;
