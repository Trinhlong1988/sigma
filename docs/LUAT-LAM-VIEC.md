# LUẬT LÀM VIỆC — SigMa (L1–L15 + R196/R198/R200/R201/R202)

Bộ luật kỹ thuật dùng chung cho mọi thay đổi trong repo này. Diễn giải CHUNG (không tham chiếu dữ liệu nội bộ).
Bản chi tiết kèm ví dụ cổng tự kiểm: `LUAT-VIET-CONG.md` ở gốc repo.

## L1–L15 — Luật viết cổng tự kiểm

- **L1 — Khẳng định HÀNH VI, không khẳng định CÁCH LÀM.** Cổng kiểm kết quả quan sát được, không bám cách triển khai.
- **L2 — Cổng tự DỰNG điều kiện**, không trông vào may rủi của dữ liệu sẵn có.
- **L3 — Cổng mới phải ĐỎ TRƯỚC, XANH SAU** (có đối chứng âm): chứng minh cổng thật sự bắt được lỗi.
- **L4 — Đo cái MẮT THẤY, không đo cái DOM CÓ.** Với UI, đo trạng thái hiển thị thực, không chỉ sự tồn tại phần tử.
- **L5 — Bám DẤU NHẬN DẠNG, không bám chữ hiển thị** (id/thuộc tính ổn định, không phụ thuộc nhãn đổi theo ngôn ngữ).
- **L6 — Test ghi nhận BỆNH phải khai báo là bệnh** (không để test "mô tả lỗi hiện có" bị hiểu là PASS).
- **L7 — Đổi 1 chỗ, sửa ĐỦ các chỗ ăn theo** (tên biến, route, migration, mock, cấu hình, bản copy service).
- **L8 — Cấm xanh RỖNG.** Suite "0 failure" nhưng 0 phép-khẳng-định-thật = chưa kiểm gì.
- **L9 — Môi trường thử phải chạy MÃ MỚI**, chứng minh bằng DẤU (rebuild/hash/log), không bằng niềm tin.
- **L10 — Dọn dữ liệu thử theo DANH SÁCH ID/NHÃN**, cấm xóa theo cửa sổ thời gian (hỏng read-state của dữ liệu khác).
- **L11 — Bản vá PHẢI kèm kiểm chứng TÁI-HIỆN-SAU-VÁ cùng ngày**, ghi vào `BUGS_FIXED.md`.
- **L12 — File tiếng Việt / regex đặc biệt: cấm byte điều khiển (NUL).** Ghi bằng công cụ A → đọc lại bằng công cụ B.
- **L13 — Đợt vá ≥5 bug phải có vòng PHẢN BIỆN ĐỘC LẬP trước ship.**
- **L14 — DB thử dùng chung đa-agent: mỗi agent một NHÃN riêng**, phép đếm phải đếm THEO NHÃN (không đếm toàn cục).
- **L15 — Đổi RAW SQL / thêm method DB ⇒ CẬP NHẬT MOCK ĐÚNG SHAPE cùng commit.**

## R — Nguyên tắc tối thượng (diễn giải chung)

- **R196 — Engineering PASS ≠ Production PASS.** Một module chưa chạy thật ≥1 lần + người nghiệm thu thì chưa
  "done". Dùng "Engineering Validation PASS / chờ Production Validation", không dùng "complete/100%".
- **R198 — Check phải CHẠY, không chỉ "không có finding".** Mọi `try/catch` quanh một phép kiểm CẤM nuốt lỗi im:
  check ném lỗi phải thành finding hiển thị + ĐẾM ĐỘNG số check thực chạy (cấm hard-code số). Sau khi đổi
  engine/adapter/dialect DB, phải test khẳng định TỪNG path chạy được trên engine mới (không câu lệnh nào bị nuốt).
- **R200 — Gate ảnh cuối + cấm tự báo xanh.** Mọi thay đổi hình/UI/căn/kích thước/màu: trước khi ship phải tự
  render đúng engine ship + nhìn ảnh bằng mắt + đo số ở điều kiện thật. Thay đổi hành vi (điều hướng/luồng):
  một ảnh tĩnh không đủ — phải điều khiển thật + verify trạng thái sau thao tác. Không nhận "xanh/PASS" của
  agent làm kết luận cuối.
- **R201 — Sửa đúng lớp LIVE — trace call-path trước khi edit.** App nhiều lớp (renderer ⇄ HTTP ⇄ service core,
  có bản copy service nhiều nơi): trước khi sửa nghiệp vụ, trace đường gọi thật từ UI để xác định file service
  LIVE; chỉ sửa lớp đó; sau khi sửa phải verify fix tới được app đang chạy (rebuild+redeploy), không chỉ typecheck.
- **R202 — Ghi dữ liệu chung = BACKUP + CHỈ-BỔ-SUNG + QA GATE.** Mọi tool ghi vào nơi có dữ liệu người nhập tay
  (Sheet/DB/file chung): (1) backup toàn bộ vùng đụng ra file có timestamp TRƯỚC khi ghi; (2) chỉ bổ sung ô
  trống + cột máy sở hữu khai báo rõ — cấm đè ô có dữ liệu; (3) QA gate sau ghi: đọc lại so pre/post từng ô,
  ô có dữ liệu bị đổi → ERROR + exit ≠ 0 + chỉ đường backup (không nuốt — theo R198).

## Áp dụng
- Mỗi bug người dùng tìm ra = **thất bại của quy trình kiểm thử**: sau khi sửa phải đề xuất đổi quy trình / thêm
  cổng kiểm để lớp lỗi đó không lọt lại.
- Phân quyền bằng **permission**, không bằng tên role. Soft-delete. Không xóa/khóa Admin cuối cùng.
- Verdict = exit-code / bằng chứng chạy thật, không phải lời văn.
