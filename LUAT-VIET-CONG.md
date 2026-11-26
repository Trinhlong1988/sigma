# LUẬT VIẾT CỔNG TỰ KIỂM — vì sao cổng cứ đỏ, và cách để hết đỏ oan

> Admin Demo 23/11: **"tại sao cứ báo đỏ, bài học đâu, luật đâu?"**
> Tài liệu này là CÂU TRẢ LỜI + LUẬT BẮT BUỘC. Viết cổng mới hay sửa cổng cũ đều phải theo.

## 1. Đỏ OAN khác đỏ THẬT — đếm trên việc thật ngày 22-23/11

| Loại đỏ | Số lần | Ví dụ |
|---|---|---|
| **Đỏ THẬT** (sản phẩm hỏng, cổng cứu bàn thua) | 4 | cửa sổ ngày trượt 7h làm MẤT bill trước 14:00 · bảng "có phát sinh" không lọc theo · hàng TỔNG lệch cột · tổng khối nhân đôi |
| **Đỏ OAN vì cổng bám CÁCH LÀM** | 5 | 3 cổng đòi nút `disabled` · cổng dò chữ "TỔNG" · cổng bám ô lọc "Ca luôn có 3 mục" |
| **Đỏ OAN vì môi trường** | 22 | hộp "Bộ nhớ sắp đầy" che màn làm 20/40 cổng treo 30s · kỳ xem mặc định rỗng · API thử chạy mã cũ |
| **Đỏ OAN vì cổng MỚI tự sai** | 6 | lệch 1 dòng khi đọc khối · Escape đóng cả hộp thoại · 2 nút trùng `data-nut` · dòng `colSpan` bị đếm · regex `\b` giữa chữ-số · epoch của timestamp không múi giờ |

**Kết luận:** đỏ oan gấp ~8 lần đỏ thật. Cổng đang kiểm **cách làm** và **may rủi môi trường** thay vì kiểm **điều người dùng thấy**.

## 2. LUẬT (bắt buộc)

### L1 — Khẳng định HÀNH VI, không khẳng định CÁCH LÀM
- ĐÚNG: *bấm Ghi nhận bill khi thiếu TID → hiện hộp báo nêu lý do + CÁCH SỬA, và **không lô nào mọc ra*** (đếm lô trước/sau).
- SAI: *nút phải có thuộc tính `disabled`* · *hàm phải tên là X* · *phải có chuỗi "TỔNG" trong mã*.
- Lý do: đổi cách làm cho tốt hơn (bỏ nút mờ câm) mà cổng đỏ ⇒ cổng cản tiến bộ, không bảo vệ tiền.

### L2 — Cổng tự DỰNG điều kiện, không trông vào may rủi
Trước khi kiểm, cổng phải tự: dẹp hộp thoại che màn (`gacHopThoai` + `dongHopThoaiChe`), **đặt kỳ xem về ngày có dữ liệu**, **bồi dữ liệu** cần thiết rồi **trả lại nguyên trạng**. Cấm giả định "hôm nay có bill", "ô lọc có ≥3 mục", "không có hộp thoại nào".

### L3 — Cổng mới phải ĐỎ TRƯỚC, XANH SAU (đối chứng âm)
Chưa thấy cổng bắt được lỗi thật thì **chưa được tin**. Cách làm: chạy cổng trên mã CHƯA vá (phải ĐỎ) → vá → chạy lại (phải XANH). Không tái hiện được thì để sẵn **mẫu cố ý sai** trong cổng (xem `_kiem-sql-khong-phu-thuoc-mui-gio.mjs`).

### L4 — Đo cái MẮT THẤY, không đo cái DOM CÓ
Hiển thị thì phải `elementFromPoint` + đo px/màu + **chụp ảnh**, và ít nhất một lượt chạy trên **bản EXE**. DOM có đủ mục mà khung cuộn cắt mất ⇒ người dùng không thấy gì (B254).

### L5 — Bám DẤU NHẬN DẠNG, không bám chữ hiển thị
Dùng `data-nut` / `data-loc` / `data-kiem`. Chữ trên nút đổi theo lựa chọn, chữ Việt có 2 dạng Unicode, cột hiện viết tắt — bám chữ là trượt. **Dấu phải DUY NHẤT**: 2 nút cùng `data-nut="excel"` đã làm cổng bấm trúng nút bị che.

### L6 — Test ghi nhận BỆNH phải khai báo là bệnh
Test khẳng định một lỗi đang tồn tại (vd "ghi lệch −7h") phải ghi rõ ở đầu file: **bệnh gì · khỏi bệnh thì phải sửa test thành chiều ngược lại**. Khi chữa xong: **đảo chiều khẳng định, giữ nguyên tên trục**, ghi "thấy số cũ = tái phát → sửa cấu hình, cấm sửa test".

### L7 — Đổi 1 chỗ, sửa ĐỦ các chỗ ăn theo
Đổi thứ tự cột ⇒ sửa 4 nơi: danh sách cột · tiêu đề · hàng dữ liệu · **hàng TỔNG (colSpan)**. Đổi nguồn dữ liệu ⇒ sửa **deps của useMemo**. Thiếu một nơi là lệch âm thầm.

### L8 — Cấm xanh RỖNG
Mọi phép đối chứng số phải kèm "số > 0" (và nếu hợp lý: nhỏ hơn tổng gốc). `0 = 0` không chứng minh gì — đã cắn ở đối chứng "sau phí mua NĐT".

## 3. Trước khi ship: tự hỏi 3 câu
1. Cổng này **đỏ được** khi sản phẩm hỏng thật không? (nếu không — nó vô dụng)
2. Nó có **đỏ oan** khi tôi làm sản phẩm tốt lên không? (nếu có — nó bám cách làm, phải viết lại theo L1)
3. Số nó in ra có **tự chứng minh** được không? (số thật, có ảnh, có đối chứng âm)

### L9 — Môi trường thử phải chạy MÃ MỚI, chứng minh bằng DẤU, không bằng niềm tin

**Bài học gốc (22–24/11):** API thử 8795 là tiến trình chạy TAY, không tự nạp lại mã — B252 chỉ xanh
sau khi nhớ ra phải restart; web thử 57915 từng phục vụ bundle build ĐÊM TRƯỚC làm cổng "xanh" trên mã cũ.
Trong 33 lần đỏ oan của 22-23/11, nhóm "đỏ oan vì môi trường" chiếm 22 lần — một phần trực tiếp từ đây.
Cùng lớp với sự cố "service chạy CODE CŨ tái diễn lần 2" (27/9) — đây là lần thứ ≥3 của lớp lỗi này.

**Cưỡng chế tự động — cổng mới `scripts/kiem-moi-truong-thu-ma-moi.mjs`** (không cần sửa code sản phẩm):
1. Tìm PID đang nghe 8795 (API thử) và 57915 (web thử) → lấy **StartTime tiến trình**
   (`Get-CimInstance Win32_Process` / `Get-Process`). So với **mtime mới nhất** của
   `apps/quanly-api/src`, `packages/services/src`, `packages/shared/src` (API) và `dist` web (web).
   Src mới hơn lúc tiến trình khởi động → **ĐỎ: "API thử đang chạy mã cũ — restart rồi mới được kiểm"**
   + in sẵn lệnh restart.
2. Web: fetch bundle đang phục vụ (`/assets/index-*.js`) → **sha256 phải BẰNG đúng file trong `dist/`**
   vừa build. Lệch byte nào → ĐỎ kèm 2 hash.
3. **Cắm dây:** chạy ĐẦU TIÊN trong `_chay-cong-giao-dien.mjs` và đầu mọi script `_kiemchung*`;
   gate-test gọi trước nhóm cổng giao diện. Không có cờ tắt im — chỉ `CONG_GIAO_DIEN=0` tổng (đã in TO).

### L10 — Dọn dữ liệu thử theo DANH SÁCH ID / NHÃN, cấm cửa sổ thời gian

**Bài học gốc:** các kiểm chứng 24/11 làm ĐÚNG (nhãn `KCV24`, mảng `don[]` push từng id, bồi phí ghi id
rồi trả `NULL` đúng dòng — 0 mất mát). Làm SAI đã trả giá ở các vụ trước: test cleanup phá read-state
prod, script merge quét mất SĐT/email 28 người (21/9, "cảnh cáo cuối"). Dọn theo `created_at > X`
trên DB thử dùng chung là xoá nhầm dữ liệu của agent khác hoặc dữ liệu nền.

**Cưỡng chế tự động — cổng mới `scripts/kiem-luat-don-theo-id.mjs`:** quét tĩnh mọi file
`_kiem*`, `_kc*`, `_kiemchung*`, `_audit*` trong `scripts/` + `apps/desktop/scripts/`:
- Thấy `DELETE`/`UPDATE ... SET deleted_at` đi với điều kiện thời gian (`created_at`, `now() - interval`,
  `BETWEEN`) trên bảng tiền (`los`, `transactions`, `lo_rows`, `tid_sell_fees`, `fee_rates`,
  `statement_*`, `investor_*`) → **ĐỎ**, trừ khi dòng đó có chú thích `// DON-THEO-ID: <lý do>` kèm lọc nhãn.
- Mẫu đúng in ngay trong thông báo lỗi: trích `don[]` của `_kiemchung-va-tam.mts`.
- Cắm vào `gate-test.mjs` cạnh `kiem-luat-khong-byte-dieu-khien.mjs`.

### L11 — Bản vá PHẢI kèm kiểm chứng TÁI-HIỆN-SAU-VÁ cùng ngày, ghi vào sổ

**Bài học gốc (24/11):** 27 bản vá B281→B307 chỉ được tin sau khi chạy tái hiện trên MÃ ĐÃ VÁ:
đợt 1 10/10 ĐẠT, đợt 2 (đường tiền qua HTTP API) 14/14 ĐẠT — và chính vòng này lòi thêm bẫy NUL B291.
Ngược lại, các vụ "typecheck xanh trên lớp DEAD" (R201) và "72 bài kiểm đỏ CÂM 7 tuần" đều do
tin bản vá mà không tái hiện. "tsc sạch 4 gói" KHÔNG phải kiểm chứng.

**Cưỡng chế tự động — cổng mới `scripts/kiem-luat-vach-kem-kiemchung.mjs`:**
- Diff `BUGS_FIXED.md` so với HEAD → mục `## B<number>` MỚI nào thiếu dòng `**Cổng:**` hoặc
  `**Kiểm chứng:**` (có số phép + kết quả thật, ví dụ "14/14") → **ĐỎ** liệt kê từng mục.
- Chạy trong gate-test TRƯỚC khi cho ship (alpha-ship đã đọc BUGS_FIXED).
- Kiểm chứng phải chạy trên mã SAU VÁ *cùng ngày* — ngày trong tiêu đề mục B phải khớp ngày chạy cổng,
  lệch >1 ngày thì cảnh báo vàng (không đỏ — tránh đỏ oan khi vá lúc 23:59).

### L12 — File chứa tiếng Việt / regex đặc biệt: cấm byte điều khiển; ghi bằng công cụ nào phải ĐỌC LẠI bằng công cụ khác

**Bài học gốc (B291, 24/11):** regex trong `apps/quanly-api/src/routes/bill-manual.ts` chứa **byte NUL
THẬT** do chính LEAD ghi ra; tệ hơn — **bash và node KHÔNG ghi được** file này (ghi xong đọc lại vẫn bản cũ),
phải sửa qua PowerShell. Cổng `kiem-luat-khong-byte-dieu-khien.mjs` là thứ bắt được, không phải mắt người.
Cùng lớp: PS5.1 BOM phá Node JSON · .cmd đổi LF mất TOKEN.

**Cưỡng chế tự động:**
1. `kiem-luat-khong-byte-dieu-khien.mjs` đã cắm gate-test — GIỮ, và thêm chế độ
   `--file <path>` để chạy ngay một file vừa sửa (không chờ tới lúc ship).
2. **Luật thao tác bắt buộc** (ghi vào CLAUDE.md repo): sau khi ghi file `.ts`/`.tsx`/`.mjs` có regex
   hoặc tiếng Việt bằng heredoc/bash/node, phải đọc lại ĐOẠN VỪA SỬA bằng công cụ KHÁC HỌ
   (PowerShell `Format-Hex`/`Select-String`, hoặc chạy ngay cổng byte với `--file`).
   Ghi xong mà diff đọc-lại ≠ nội dung định ghi → dừng, đổi công cụ, KHÔNG thử lại cùng công cụ lần 3.

### L13 — Đợt vá ≥5 bug phải có vòng PHẢN BIỆN ĐỘC LẬP trước ship

**Bài học gốc (20–24/11):** 5 lần cổng đỏ của đợt 20-22/11 đều do **BÀI KIỂM sai** — người viết bài kiểm
tự chấm bài mình là mù điểm mù của chính mình. Đợt 24/11 chạy 16 agent (5 phản biện + 5 tuân-thủ-luật +
5 vùng-mới + cổng) mới lòi: B281 làm tròn HAI LẦN vỡ bất biến ở 43/585 lô, `_kiem-web-khong-demo`
XANH RỖNG + trỏ cứng 57913 sổ thật, health đỏ oan 506 lô QR cũ. Không vòng phản biện = những thứ này ship.

**Cưỡng chế tự động — cổng mới `scripts/kiem-luat-phan-bien-truoc-ship.mjs`:**
- Đếm mục `## B` trong BUGS_FIXED.md thêm mới kể từ tag/version ship gần nhất (đọc VERSION.md).
- ≥5 mục → đòi file bằng chứng `_anh-kiem/phan-bien-<version>.md` do agent phản biện (KHÁC người vá,
  chỉ đọc diff — cấm đọc báo cáo người vá) ghi: danh sách finding + trạng thái. Thiếu file → **ĐỎ chặn ship**.
- Skill `alpha-ship` thêm bước này vào checklist (đổi skill, không đổi code sản phẩm).

### L14 — DB thử dùng chung đa-agent: mỗi agent một NHÃN riêng, phép đếm phải đếm THEO NHÃN

**Bài học gốc (24/11):** có lúc 15–16 agent cùng đánh vào `sigma_thu`. Kiểm chứng của LEAD đếm
đối chứng kiểu `SELECT count(*) FROM los` **toàn bảng** (`demLo`) — chỉ cần một agent khác ghi 1 lô
song song là phép "không lô nào mọc ra" đỏ oan (hoặc tệ hơn: che mất lô mọc thật). Nhãn `KCV24`
cho phép dọn chính xác + truy vết ai bồi gì — nhưng mới là thói quen, chưa là luật.

**Cưỡng chế tự động:**
- Quy ước nhãn: `KC<ddMM><chữ-cái-agent>` (vd `KC2411A`, `KC2411B`) — khai 1 hằng `NHAN` đầu file.
- Cổng `kiem-luat-don-theo-id.mjs` (L10) kiểm luôn: file `_kiemchung*`/`_kiem*` có ghi DB thử mà
  (a) không khai `NHAN`, hoặc (b) có phép `count(*)` không kèm điều kiện lọc (nhãn/id/kỳ) trong cùng
  câu lệnh → **ĐỎ** kèm hướng dẫn.
- Mẫu `_mau-nhomA/B/C.mjs` bổ sung sẵn khối `NHAN` + `don[]` chuẩn để agent chép đúng từ đầu.

### L15 — Vá đổi RAW SQL / thêm method DB ⇒ CẬP NHẬT MOCK ĐÚNG SHAPE cùng commit
Bài học đau nhất phiên 24/11: mỗi lần bản vá thêm `$executeRawUnsafe`/`$queryRawUnsafe`/`cashDebtSettlement.count`/
`DELETE FROM tids`… thì mọi test dùng mẫu-giả (mock) **đỏ oan hàng loạt** (đếm được ~34 case qua các vòng:
approval, revenue-recalc ×29, trash, rename, txn-routes). KHÔNG phải lỗi sản phẩm — là mock THIẾU SHAPE.
- Vá chạm DB (thêm câu raw / model / method) ⇒ **ngay trong commit đó** thêm nhánh tương ứng vào MỌI mock
  đụng tới: shape đúng (`$executeRawUnsafe` trả `number`, `count` trả `number`, raw-select trả mảng `{...}`),
  KHÔNG trả rỗng câm cho SQL lạ — stub chuẩn NÉM LỖI kèm nguyên văn SQL (R198) để bắt chính ca này.
- Phân biệt "đỏ do mock thiếu" (TypeError `x is not a function` / "mẫu giả CHƯA hỗ trợ câu SQL") với "đỏ sản
  phẩm": cái đầu sửa MOCK, cái sau sửa CODE. Đừng sửa test để "cho xanh" khi là đỏ sản phẩm.
- Nối [[feedback_mock_shape_accuracy_assert_values]] + [[feedback_bigint_shim_mock_shape_audit_regression]].
Cưỡng chế: cổng chạy vitest trong gate-test đã bắt được; thêm thói quen chạy 3 suite NGAY sau mỗi đợt vá service.

