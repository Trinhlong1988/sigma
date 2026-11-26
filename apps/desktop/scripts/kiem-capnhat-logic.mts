// Phần LOGIC THUẦN của cổng B249 (chạy qua `npx tsx`, gọi từ `_kiem-capnhat-bao-oan.mjs`).
// Khoá đúng 2 cảnh đã BÁO ĐỎ OAN "Cập nhật thất bại" + 1 cảnh đối chứng lỗi THẬT vẫn phải báo.
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evalMarkerTai,
  writeMarkerVao,
  ghiNhatKyVao,
  soSanhPhienBan,
  locBanMoi
} from '../src/main/update-marker.js';

let so = 0;
const loi: string[] = [];
const chot = (ok: boolean, ten: string): void => {
  so++;
  console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten);
  if (!ok) loi.push(ten);
};
const CAN = 13;

const thu = mkdtempSync(join(tmpdir(), 'kiem-capnhat-'));
const mk = join(thu, 'update-result.json');
const nk = join(thu, 'update-log.txt');

// (1) Marker KHÔNG có số bản đích (lúc bấm cài chưa biết pendingVersion).
writeMarkerVao(mk, { targetVersion: '', fromVersion: '0.2.170', startedAt: 'x' });
const r1 = evalMarkerTai('0.2.170', mk, nk);
chot(r1.kind === 'none', 'marker KHÔNG có số bản đích → none (trước đây báo đỏ "Chưa cài được bản v")');
chot(!existsSync(mk), 'marker rỗng vẫn bị XOÁ (không báo lại mỗi lần mở app)');

// (2) Bản đang chạy MỚI HƠN bản đích — cài chồng bản mới hơn / nhận bản mới ngay sau đó.
writeMarkerVao(mk, { targetVersion: '0.2.171', fromVersion: '0.2.170', startedAt: 'x' });
const r2 = evalMarkerTai('0.2.173', mk, nk);
chot(r2.kind === 'success', 'đang chạy MỚI HƠN bản đích → THÀNH CÔNG, không báo thất bại oan');

// (3) ĐỐI CHỨNG: cũ hơn thật thì VẪN phải báo thất bại (không nới tay thành im lặng).
writeMarkerVao(mk, { targetVersion: '0.2.173', fromVersion: '0.2.170', startedAt: 'x' });
const r3 = evalMarkerTai('0.2.170', mk, nk);
chot(r3.kind === 'failed' && r3.targetVersion === '0.2.173',
  'đang chạy CŨ HƠN → vẫn báo THẤT BẠI (lỗi thật không bị nuốt)');

// (4) Bằng nhau → thành công (luật cũ vẫn giữ).
writeMarkerVao(mk, { targetVersion: '0.2.173', fromVersion: '0.2.172', startedAt: 'x' });
chot(evalMarkerTai('0.2.173', mk, nk).kind === 'success', 'đúng bản đích → THÀNH CÔNG');

// (5) So số phiên bản theo SỐ, không theo chữ: '0.2.9' < '0.2.173' (so chuỗi thì ngược).
chot(soSanhPhienBan('0.2.173', '0.2.9') === 1 && soSanhPhienBan('0.2.9', '0.2.173') === -1
  && soSanhPhienBan('0.2.173', '0.2.173') === 0,
  'so số phiên bản theo SỐ không theo chữ (0.2.173 > 0.2.9)');

// (6) JSON hỏng → none, KHÔNG ném lỗi.
writeFileSync(mk, '{ hong', 'utf8');
let nem = false;
let r6: { kind: string } = { kind: '?' };
try { r6 = evalMarkerTai('0.2.173', mk, nk); } catch { nem = true; }
chot(!nem && r6.kind === 'none', 'marker JSON hỏng → none, KHÔNG ném lỗi');

// (7) Nhật ký: có ghi, và các cảnh trên đều để lại dấu vết đọc được.
const log = existsSync(nk) ? readFileSync(nk, 'utf8') : '';
chot(/cài THÀNH CÔNG/.test(log) && /cài THẤT BẠI/.test(log) && /không có số bản đích/.test(log),
  'nhật ký ghi lại ĐỦ 3 loại kết quả (xem được nguyên nhân thay vì đoán)');

// (8) Nhật ký không phình vô hạn.
writeFileSync(nk, 'x'.repeat(70 * 1024), 'utf8');
ghiNhatKyVao(nk, 'sau-khi-phinh');
const sau = readFileSync(nk, 'utf8');
chot(sau.length < 40 * 1024 && sau.includes('sau-khi-phinh'), 'nhật ký quá 64KB thì CẮT BỚT, vẫn ghi tiếp');

// ── [B250 22/11 — Admin Demo "Có bản cập nhật mới v0.2.174 … khi đã cập nhật rồi là sao?"] ──
// Feed LUÔN trả bản mới nhất của nó, kể cả khi mình đang chạy đúng bản đó. Lọc sai là banner
// "Có bản cập nhật mới" hiện lại mỗi lần mở app, ngay sau khi vừa cập nhật xong.
chot(locBanMoi('0.2.174', '0.2.174') === null,
  'feed BẰNG bản đang chạy → KHÔNG phải bản mới (đúng lỗi Admin Demo gặp)');
chot(locBanMoi('0.2.175', '0.2.174')?.version === '0.2.175',
  'feed MỚI HƠN → đúng là bản mới (không nới tay thành câm)');
chot(locBanMoi('0.2.9', '0.2.174') === null,
  'feed 0.2.9 vs đang chạy 0.2.174 → KHÔNG mới (so chuỗi thì nhầm là mới)');
chot(locBanMoi('', '0.2.174') === null && locBanMoi(null, '0.2.174') === null,
  'feed trả rỗng/null → KHÔNG dựng banner bản mới');

rmSync(thu, { recursive: true, force: true });

console.log('\n[capnhat-bao-oan] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[capnhat-bao-oan] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[capnhat-bao-oan] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
