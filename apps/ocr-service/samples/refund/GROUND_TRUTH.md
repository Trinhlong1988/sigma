# Ground truth — mẫu biên lai chuyển tiền THẬT (Admin Demo gửi 3/8, để verify OCR hoàn tiền B123)

> Đọc trực tiếp từ ảnh, KHÔNG suy đoán. Dùng để đối chiếu output OCR thật (refund-ocr-bridge / ocr-service).
> Bài học B121: có ảnh thật thì PHẢI chạy OCR thật đối chiếu, cấm mở rộng alias bằng cách nhìn ảnh bằng mắt.

## refund_bidv_to_tcb_102707000.jpg  (app BIDV → nhận Techcombank)
- Trạng thái: Giao dịch thành công
- Số tiền: 102,707,000 VND        <-- phân tách nghìn bằng DẤU PHẨY
- Thời gian: 02/08/2026 15:52:57
- Người nhận (Đến): KHACH HANG 44
- Số tài khoản: 8791797777        <-- dãy số thuần
- Ngân hàng nhận: NHTMCP Kỹ Thương Việt Nam (TCB) = Techcombank  (KHÁC app gửi = BIDV)
- Nội dung: LUU THI TRANG NHUNG Chuyen tien
- Số tham chiếu: 6214BIDVE2DY1464

## refund_acb_to_mb_177712000.jpg  (app ACB → nhận MB Bank)
- Trạng thái: Chuyển tiền thành công
- Số tiền: 177.712.000 VND        <-- phân tách nghìn bằng DẤU CHẤM (ngược ảnh trên)
- Bằng chữ: Một trăm bảy mươi bảy triệu bảy trăm mười hai nghìn đồng
- Từ: LUU THI TRANG NHUNG ******86
- Người nhận (Đến): KHACH HANG 38
- Ngân hàng nhận: MB Bank - NH TMCP Quân Đội  (KHÁC app gửi = ACB)
- "Tài khoản" hiển thị: VQRQAASGJ6634   <-- MÃ VietQR/napas, KHÔNG phải dãy số TK thuần!
- Thời gian: 02/08/2026, 22:45:20
- Phí: Miễn phí
- Mã giao dịch: 6819
- Nội dung: LUU THI TRANG NHUNG CHUYEN KHOAN-020826-22:45:20 6214ASCB02TA3BAV

## refund_acb_ocb_2line.jpg  (app ACB → nhận OCB Bank) — Admin Demo gửi 3/8, ca TÊN 2 DÒNG + STK SAU BANK
- Trạng thái: Chuyển tiền thành công
- Số tiền: 53.166.000 VND        <-- phân tách nghìn bằng DẤU CHẤM
- Từ: LUU THI TRANG NHUNG ******86
- Người nhận (Đến): KHACH HANG 06   <-- TÊN TRÀN 2 DÒNG: "KHACH HANG 30" + "DOANH"
- Ngân hàng nhận: OCB - NH TMCP Phuong Dong (OCB)  (KHÁC app gửi = ACB) — đứng GIỮA tên và STK
- Số tài khoản: 0003100018565008   <-- 16 SỐ THUẦN, đứng NGAY SAU dòng bank, KHÔNG có nhãn "Tài khoản"
- Thời gian: 03/08/2026, 18:02:56
- Mã giao dịch: 6968
- Số tham chiếu (nội dung): 6215ASCB02T1NVWT
- Fixture test THẬT: `apps/bot-api/test/refund-acb-ocb-2line-real.test.ts` (B139-vòng2).

## Rủi ro OCR 2 mẫu này phơi ra (phải có test khẳng định)
1. PHẨY vs CHẤM phân tách nghìn (102,707,000 vs 177.712.000) — lớp bug B93/B94 đọc sai ×1.000.000. PHẢI đọc đúng CẢ hai.
2. Ảnh ACB: "số tài khoản" = mã VietQR `VQRQAASGJ6634` (không phải digits). Đối chiếu tài khoản người nhận (#4)
   nếu so bằng dãy số thật sẽ LỆCH → nguy cơ tick "đã hoàn đủ" SAI hoặc báo lệch giả. Cần quyết cách xử lý ca này.
3. Ngân hàng người NHẬN khác app gửi (BIDV→TCB, ACB→MB) — OCR/đối chiếu phải lấy ngân hàng NGƯỜI NHẬN, không phải brand app.
