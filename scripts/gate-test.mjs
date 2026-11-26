// GATE TEST DÙNG CHUNG cho publish SigMa + SigMa (Admin Demo 18/9 "dọn tất cả nợ cũ").
//
// VÌ SAO GOM 1 CHỖ: trước đây `publish-sigma.mjs` tự cài gate riêng chỉ chạy bot-api + services, còn
// `publish-quanly-alpha.mjs` KHÔNG có gate nào — SigMa ship được kể cả khi test đỏ toàn bộ. Và 137 file
// test (quanly-api 20, desktop 10, web-demo 84, business-rules 10, zalo-watcher 13) chưa từng chặn được bản ship
// nào. Ca thật 18/9: 2 test web-demo nằm ngoài include của vitest.config (`digistore-noidung-ck` CHƯA TỪNG chạy)
// mà vẫn qua mọi cổng. Hai bản gate rời nhau chắc chắn trôi khỏi nhau — cùng lớp bug với 3 bản sao
// `lamTronNghinXuong` lệch ở ca 1999.9. Nay MỘT nguồn duy nhất, hai script publish cùng gọi.
//
// Dùng: import { chayGateTest } from './gate-test.mjs'; chayGateTest('SigMa');
// Thoát hiểm có chủ đích: PUBLISH_SKIP_TESTS=1 (in cảnh báo to — chỉ khi Admin Demo lệnh khẩn).
// Kiểm chứng riêng khoá này: PUBLISH_TEST_GATE_ONLY=1 (chạy gate rồi thoát, không publish).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kiemLuatManualOps } from './kiem-luat-manual-ops.mjs';
import { kiemMocThoiGianRaw } from './kiem-luat-moc-thoi-gian-raw.mjs';
import { kiemLuatBienKy } from './kiem-luat-bien-ky.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Chuỗi kết nối DB cho các cổng soi SỔ THẬT.
 *
 * VÌ SAO CẦN (13/11): cổng `gate-map-sao-ke.mts` chạy với cwd=`apps/bot-api`, mà ở đó CHỈ có `.env.example` —
 * `dotenv/config` không tìm thấy gì ⇒ cổng chết với "DATABASE_URL không được cấu hình" và CHẶN publish vì lý do
 * MÔI TRƯỜNG, không phải vì tiền chạy nhầm nhà. Fail-closed là đúng, nhưng thông báo sai chỗ thì người ship sẽ
 * tưởng gate "dở hơi" rồi lách bằng PUBLISH_SKIP_TESTS — tức là cổng tự giết mình. Nay tự dò đúng nguồn mà máy
 * chủ đang dùng, và nếu KHÔNG có nguồn nào thì nói thẳng là thiếu cấu hình (vẫn CHẶN).
 */
function timDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const tuongDoi of ['apps/bot-api/.env', 'apps/quanly-api/.env', '.env']) {
    const f = path.join(ROOT, tuongDoi);
    if (!existsSync(f)) continue;
    const m = /^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m.exec(readFileSync(f, 'utf8'));
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

/** Mỗi suite: [tên, thư mục chạy, lệnh]. ROOT chạy trước vì nhanh nhất → đỏ sớm, khỏi chờ 7 phút bot-api. */
export const SUITES = [
  ['root (web-demo + desktop + business-rules)', '.', 'npx vitest run'],
  ['quanly-api', 'apps/quanly-api', 'npx vitest run'],
  ['zalo-watcher', 'apps/zalo-watcher', 'npm test'],
  ['services', 'packages/services', 'npx vitest run'],
  ['bot-api', 'apps/bot-api', 'npx vitest run']
];

/** Chạy toàn bộ gate. Đỏ = in phần lỗi rồi process.exit(1). Trả true nếu xanh (hoặc được bỏ qua có chủ đích). */
export function chayGateTest(nhan = 'publish') {
  if (process.env.PUBLISH_SKIP_TESTS === '1') {
    console.error(`⚠⚠ PUBLISH_SKIP_TESTS=1 — BỎ GATE TEST ${nhan} (chỉ dùng khi Admin Demo lệnh khẩn). ⚠⚠`);
    return true;
  }
  const t0 = Date.now();
  // [Admin Demo 26/9 "xiết chặt quy trình, luật, gate, qa"] BƯỚC 0 — KIỂM LUẬT script sửa dữ liệu TRƯỚC khi chạy
  // test. Rẻ (vài mili-giây) nên đặt đầu tiên: sai luật là đỏ ngay, khỏi chờ 9 phút test.
  // Bắt đúng lớp lỗi đã làm hỏng tiền thật 26/9: đọc mốc raw (+7h) rồi ghi lại · cổng QA không kiểm cột mình ghi
  // · script không có chế độ chạy thử/backup.
  if (!kiemLuatManualOps()) {
    console.error('[gate] ✗ KIỂM LUẬT ĐỎ — CHẶN publish. Sửa script hoặc khai LUAT-BO-QUA kèm lý do.');
    process.exit(1);
  }
  // BƯỚC 0b — KIỂM LUẬT MỐC THỜI GIAN trong MÃ ỨNG DỤNG (không chỉ script vận hành). Bắt lớp lỗi 26/9: đọc
  // `effective_from` thô qua $queryRaw (driver +7h) ⇒ giá bán hiệu lực 0h bị hiểu là 7h ⇒ bill ca đêm báo
  // "chưa cấu hình giá bán", KHÔNG tạo được lô (đo thật máy Chí Đức BM-9). Xem gia-ban-hieu-luc-0h.test.ts.
  if (!kiemMocThoiGianRaw()) {
    console.error('[gate] ✗ KIỂM LUẬT MỐC THỜI GIAN ĐỎ — CHẶN publish. Đọc cột mốc phải qua AT TIME ZONE/to_char.');
    process.exit(1);
  }
  // BƯỚC 0c — KIỂM BIÊN KỲ. Bắt lỗi 27/9: mốc cuối khoảng NỬA MỞ [from,to) đổi thẳng sang chuỗi ngày ⇒ báo cáo
  // "hôm qua" GỘP LUÔN hôm nay (đo thật phòng NĐT NĐT 1: 11 bill thay vì 8). Lớp lỗi này đã tái diễn nhiều lần.
  if (!kiemLuatBienKy()) {
    console.error('[gate] ✗ KIỂM BIÊN KỲ ĐỎ — CHẶN publish. Mốc cuối nửa-mở phải lùi 1ms trước khi đổi sang ngày.');
    process.exit(1);
  }
  // BƯỚC 0d — KIỂM MAP SAO KÊ (Admin Demo 30/9 "bill Tuấn Anh chuyển KT Demo là ĐL TA hoàn ứng sao lại ghi nhận Nhà
  // Nguyễn"). Soi DB THẬT: còn GD nào gán nhà bằng khoá rác (mã QR MB) / khoá của chính SigMa / khoá học được ở
  // nhiều phòng thì CHẶN. Cổng tự thoát 3 khi không chạy được kiểm tra (fail-closed) — ở đây 3 cũng là CHẶN.
  // [15/11] BACKUP CÒN MỚI — ca thật: Scheduled Task backup chạy đúng giờ nhưng trả mã lỗi 2 ngày liền
  // (thiếu apps/bot-api/.env), task vẫn hiện "Ready", sổ tiền không có bản mới nào mà không ai biết.
  // Ship phần mềm tiền trong lúc không có backup là canh bạc ⇒ chặn ngay ở cổng.
  try {
    execSync('node scripts/kiem-backup-moi.mjs', { cwd: ROOT, stdio: 'inherit', shell: true });
  } catch {
    console.error('[gate] ✗ BACKUP KHÔNG CÒN MỚI (hoặc không kiểm được) — CHẶN publish.');
    console.error('[gate]   Chạy backup rồi ship lại. Xem hướng dẫn ngay trên dòng của kiem-backup-moi.');
    process.exit(1);
  }

  // [B180 16/11] PHÂN TRANG — chặn tái diễn lỗi "mất dữ liệu câm": màn gọi danh sách mà máy chủ cắt 100
  // dòng mặc định thì phần dư BIẾN MẤT không báo gì (B179: sổ 114 TID, màn chỉ thấy 100, mất cả 3 TID
  // Xuân Đoàn). Cổng khẳng định mọi đường dẫn có cắt trang đều được kéo hết ở CẢ HAI lớp gọi API.
  try {
    execSync('node scripts/kiem-luat-phan-trang.mjs', { cwd: ROOT, stdio: 'inherit', shell: true });
  } catch {
    console.error('[gate] ✗ CÓ DANH SÁCH PHÂN TRANG CHƯA KÉO HẾT — CHẶN publish (xem dòng ĐỎ ngay trên).');
    process.exit(1);
  }

  // [B181 19/11] NÚT GIẢ — nút "Làm mới" của màn Doanh Số từng là `onClick={() => undefined}`: bấm xong
  // không làm gì, trong khi mách nước hứa "tải lại dữ liệu mới nhất". Người dùng tin là đã mới.
  try {
    execSync('node scripts/kiem-luat-nut-that.mjs', { cwd: ROOT, stdio: 'inherit', shell: true });
  } catch {
    console.error('[gate] ✗ CÓ NÚT GIẢ (trình xử lý rỗng) — CHẶN publish (xem dòng ĐỎ ngay trên).');
    process.exit(1);
  }

  // [B199/B201 19/11] BYTE ĐIỀU KHIỂN TRONG MÃ NGUỒN — rẻ, quét byte. Bản vá B193 từng viết KÝ TỰ NUL THẬT
  // vào biểu thức chính quy; chạy vẫn đúng nên mọi bài kiểm đều xanh, nhưng grep coi file là NHỊ PHÂN ⇒ mọi
  // lần tìm kiếm sau này TRƯỢT IM. Lần quét đầu còn lòi ra hỏng hóc cũ: mẫu tìm biên-từ cho chữ SigMa trong một cổng đã biến
  // thành ký tự BACKSPACE ⇒ phép kiểm đó KHÔNG BAO GIỜ khớp, và 3 chỗ đường dẫn kho cập nhật trên ổ D trong sổ tay mất dấu.
  try {
    execSync('node scripts/kiem-luat-khong-byte-dieu-khien.mjs', { cwd: ROOT, stdio: 'inherit', shell: true });
  } catch {
    console.error('[gate] ✗ CÓ BYTE ĐIỀU KHIỂN TRONG MÃ NGUỒN — CHẶN publish (xem danh sách file ngay trên).');
    process.exit(1);
  }

  // [B210 19/11 — Admin Demo "fix lỗi 7 tiếng"] SO MỐC PHẢI CÙNG HỆ QUY CHIẾU. Mốc do chương trình ghi đang
  // lưu SỚM 7 TIẾNG (thư viện gửi giờ UTC không kèm múi giờ, máy chủ đặt Bangkok nên gán +07), nên mọi phép
  // so với đồng hồ máy chủ đều sai. Hậu quả đã tìm ra: chốt chống GỬI TRÙNG BILL mất tác dụng vì chỗ giữ nào
  // cũng bị coi là "mồ côi quá 10 phút". Cổng cấm so cột mốc với now() trong lớp chạy thật.
  try {
    execSync('node apps/desktop/scripts/_kiem-so-gio-cung-he-quy-chieu.mjs', { cwd: ROOT, stdio: 'inherit', shell: true });
  } catch {
    console.error('[gate] ✗ CÓ CHỖ SO MỐC VỚI ĐỒNG HỒ MÁY CHỦ — CHẶN publish (xem dòng ĐỎ ngay trên).');
    process.exit(1);
  }

  // [B197 19/11] ẨN IM Ở Ô CHỌN — Admin Demo khai báo TID mới rồi vào Thêm bill KHÔNG thấy nó đâu (ô chọn lọc
  // thẳng status==='ACTIVE'). Luật "chưa giao khách thì chưa nhập bill" đúng, nhưng phải NÓI RA chứ không xoá
  // khỏi mắt người dùng. Cổng tĩnh, vài mili-giây, chặn việc lọc cứng đó quay lại.
  try {
    execSync('node scripts/kiem-luat-khong-an-im-o-chon.mjs', { cwd: ROOT, stdio: 'inherit', shell: true });
  } catch {
    console.error('[gate] ✗ Ô CHỌN ĐANG ẨN IM BẢN GHI — CHẶN publish (xem dòng ĐỎ ngay trên).');
    process.exit(1);
  }

  // [B197 19/11 — Admin Demo "tại sao cứ lỗi vậy? tùm lum thế?"] CỔNG GIAO DIỆN.
  // 15 cổng `_kiem-*` lái app thật được viết ra sau từng lỗi thật nhưng CHƯA CÁI NÀO nối vào đây — chạy tay,
  // quên là lọt. Đo 19/11: nối vào thì phát hiện NGAY 2 cổng đã đỏ âm thầm từ 16/11 (ô chọn đổi sang hiện mã
  // viết tắt ngân hàng, cổng vẫn gõ tên đầy đủ). Bộ chạy tự dựng lại bản web để không kiểm nhầm bản cũ.
  // CONG_GIAO_DIEN=0 để bỏ qua (in TO lý do — cấm bỏ im).
  if (process.env.CONG_GIAO_DIEN === '0') {
    console.error('⚠⚠ CONG_GIAO_DIEN=0 — BỎ QUA toàn bộ cổng giao diện theo lệnh. Nợ: chạy lại trước khi giao máy.');
  } else {
    try {
      execSync('node apps/desktop/scripts/_chay-cong-giao-dien.mjs', { cwd: ROOT, stdio: 'inherit', shell: true });
    } catch {
      console.error('[gate] ✗ CỔNG GIAO DIỆN ĐỎ (hoặc môi trường thử chưa lên) — CHẶN publish.');
      console.error('[gate]   Xem bảng TỔNG KẾT ngay trên: cổng nào đỏ thì sửa, môi trường chết thì bật lại.');
      process.exit(1);
    }
  }

  const dbUrl = timDatabaseUrl();
  if (!dbUrl) {
    console.error('[gate] ✗ KHÔNG dò được DATABASE_URL (đã tìm env, apps/bot-api/.env, apps/quanly-api/.env, .env)');
    console.error('[gate]   ⇒ KHÔNG CHẠY được kiểm map sao kê ⇒ CHẶN publish (fail-closed). Cấu hình DB rồi ship lại.');
    process.exit(1);
  }
  try {
    execSync('npx tsx scripts/gate-map-sao-ke.mts', {
      cwd: path.join(ROOT, 'apps/bot-api'), stdio: 'inherit', shell: true,
      env: { ...process.env, DATABASE_URL: dbUrl }
    });
  } catch {
    console.error('[gate] ✗ KIỂM MAP SAO KÊ ĐỎ — CHẶN publish. Tiền đang chạy nhầm nhà hoặc cổng không chạy được.');
    process.exit(1);
  }

  // ── THOÁT HIỂM HẸP (13/11, Admin Demo "push update đi" sau khi đã được báo suite đỏ) ──
  // PUBLISH_SKIP_SUITES=1 bỏ qua ĐÚNG 5 suite vitest (đang đỏ từ TRƯỚC 13/11, đã bị cổng mù che), nhưng VẪN
  // chạy kiểm luật + cổng MAP SAO KÊ (soi SỔ THẬT — tiền chạy nhầm nhà vẫn chặn). Khác hẳn PUBLISH_SKIP_TESTS=1
  // vốn bỏ SẠCH mọi thứ kể cả cổng tiền. In TO từng suite bị bỏ — cấm bỏ im (R198).
  if (process.env.PUBLISH_SKIP_SUITES === '1') {
    console.error(`⚠⚠ PUBLISH_SKIP_SUITES=1 — ${nhan}: BỎ QUA ${SUITES.length} suite vitest theo lệnh Admin Demo.`);
    for (const [ten] of SUITES) console.error(`⚠⚠   · KHÔNG chạy: ${ten}`);
    console.error('⚠⚠ Kiểm luật + cổng map sao kê VẪN CHẠY (ở trên). Nợ: sửa suite đỏ rồi bỏ cờ này.');
    return true;
  }
  // Suite `bot-api` dựng DB THỬ NGHIỆM riêng bằng `createdb` ⇒ cần thông tin đăng nhập Postgres. Mặc định của
  // harness là postgres/postgres — máy này đổi mật khẩu rồi (18/9) nên createdb trượt, suite KHÔNG CHẠY ĐƯỢC
  // (trước đây bị cổng mù che nên hiện "✓ 5s"). Rót từ chính DATABASE_URL máy chủ đang dùng — không chép mật
  // khẩu đi đâu, chỉ truyền cho tiến trình con.
  const envPg = {};
  try {
    const u = new URL(dbUrl ?? timDatabaseUrl() ?? '');
    if (u.protocol.startsWith('postgres')) {
      if (u.username) envPg.PGUSER = decodeURIComponent(u.username);
      if (u.password) envPg.PGPASSWORD = decodeURIComponent(u.password);
      if (u.hostname) envPg.PGHOST = u.hostname;
      if (u.port) envPg.PGPORT = u.port;
      // [16/11] Suite `services` có 3 bài kiểm chạy trên POSTGRES THẬT (khóa tư vấn TOCTOU + mốc hiệu lực giá
      // bán B167). Chúng đọc SIGMA_TEST_PG_* và TỰ BỎ QUA khi không nối được — nghĩa là suốt thời gian qua
      // chúng IM LẶNG không chạy, cổng vẫn xanh (đúng cái bẫy R198 "test PASS ≠ check ĐÃ CHẠY"). Rót thông tin
      // đăng nhập để chúng CHẠY THẬT trong mỗi lần ship. DB thử dùng xong tự xoá (tên alpha_toctou_tid_*).
      if (u.username) envPg.SIGMA_TEST_PG_USER = decodeURIComponent(u.username);
      if (u.password) envPg.SIGMA_TEST_PG_PASSWORD = decodeURIComponent(u.password);
      if (u.hostname) envPg.SIGMA_TEST_PG_HOST = u.hostname;
      if (u.port) envPg.SIGMA_TEST_PG_PORT = u.port;
    }
  } catch { /* không dò được thì để harness dùng mặc định, suite sẽ tự báo đỏ */ }

  for (const [ten, cwd, lenh] of SUITES) {
    process.stdout.write(`[gate] ${nhan} · ${ten}: ${lenh} ...`);
    const t1 = Date.now();
    try {
      // [Admin Demo 18/9 "sao OCR chậm vậy"] Máy này VỪA là máy chủ prod VỪA là máy build/test — gate full suite
      // (~9 phút) từng chiếm CPU làm OCR/bot-api phục vụ người dùng chậm hẳn. Chạy test ở ƯU TIÊN THẤP
      // (BelowNormal, con kế thừa): gate chậm hơn chút nhưng dịch vụ prod không khựng.
      // ⚠️ BẪY ĐÃ CẮN (phát hiện 13/11): `Start-Process -PassThru` trả về Process KHÔNG giữ handle, nên sau
      // `WaitForExit()` thì `$p.ExitCode` là **$null** ⇒ `exit $null` = **exit 0** ⇒ cổng báo "✓ xanh" cho MỌI
      // suite kể cả khi test đỏ. Đo thật: bọc `cmd /c exit 1` qua lớp cũ ra **0** (không bọc ra 1). Nghĩa là từ
      // 18/9 (lúc thêm lớp ưu-tiên-thấp) cổng ship CHƯA TỪNG chặn được bản nào vì test đỏ.
      // Vá: `$null = $p.Handle` TRƯỚC khi chờ (ép .NET giữ handle thì ExitCode mới đọc được), và nếu vẫn null
      // thì thoát 99 — KHÔNG được coi "không đọc được kết quả" là "xanh" (R198 fail-closed).
      const boc = `powershell -NoProfile -Command "$p = Start-Process cmd -ArgumentList '/c','${lenh.replace(/'/g, "''")}' -NoNewWindow -PassThru; $null = $p.Handle; $p.PriorityClass = 'BelowNormal'; $p.WaitForExit(); if ($null -eq $p.ExitCode) { exit 99 } else { exit $p.ExitCode }"`;
      execSync(boc, { cwd: path.join(ROOT, cwd), stdio: 'pipe', shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...envPg } });
      console.log(` ✓ (${((Date.now() - t1) / 1000).toFixed(0)}s)`);
    } catch (e) {
      const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      const tail = out.split(/\r?\n/).filter((l) => /failed|FAIL|×|not ok|Error:/.test(l)).slice(0, 15).join('\n');
      console.error(`\n[gate] ✗ ${ten} ĐỎ — CHẶN publish (sửa test/bug trước, cấm ship khi đỏ):\n${tail || out.slice(-2000)}`);
      process.exit(1);
    }
  }
  console.log(`[gate] ✓ TOÀN BỘ ${SUITES.length} suite xanh (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  return true;
}

// [Admin Demo 25/9 — R198] BẪY XANH GIẢ: `node scripts/gate-test.mjs` trước đây chỉ nạp module rồi thoát 0 —
// KHÔNG chạy suite nào mà vẫn "EXIT=0", đúng loại "check không chạy vẫn báo pass". Nay gọi thẳng file = CHẠY GATE.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  chayGateTest('chay truc tiep');
}
