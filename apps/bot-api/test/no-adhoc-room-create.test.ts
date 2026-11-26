// [Admin Demo 9/9 "có nhóm sẵn sao lại tạo nhóm mới?"] — GỐC THẬT: script một-lần `scripts/map-haquochuy.mts` (LEAD tự
// viết 26/8) gọi THẲNG `db.chatRoom.create(... createdBy: 1)`, chỉ tìm phòng theo TÊN CHÍNH XÁC "ĐL- Hà Khach Demo SG"
// nên KHÔNG thấy phòng anh Demo đã tạo tên "ĐL- Khach Demo SG", và chỉ thêm BOT làm thành viên → đẻ ra phòng KHÔNG AI
// THẤY; chạy 2 lần còn tạo 2 phòng cách 29 giây.
//
// GUARD: cấm mọi nơi (script/route/service khác) tạo phòng chat TRỰC TIẾP. Muốn tạo nhóm phải đi qua
// `createGroupRoom()` — nơi có gate trùng tên + bắt buộc ≥3 người + thêm creator làm OWNER.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src');
const SCRIPTS = join(process.cwd(), 'scripts');
/** Nơi DUY NHẤT được phép tạo phòng (đã có gate bên trong). */
const CHO_PHEP = ['services/chat-room-service.ts'];

function quet(dir: string, acc: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) quet(full, acc);
    else if (/\.(ts|mts|mjs)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

describe('cấm tạo phòng chat ngoài createGroupRoom', () => {
  it('không file nào (src + scripts) gọi thẳng chatRoom.create', () => {
    const pham: string[] = [];
    for (const f of [...quet(ROOT), ...quet(SCRIPTS)]) {
      const duongChuan = f.split(String.fromCharCode(92)).join('/'); // 92 = dấu \ (đường dẫn Windows) → so khớp POSIX
      if (CHO_PHEP.some((ok) => duongChuan.endsWith(ok))) continue;
      const text = readFileSync(f, 'utf8');
      // Bỏ dòng chú thích (mô tả lịch sử/bài học vẫn được nhắc tên hàm).
      const code = text.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
      if (/\bchatRoom\.create\s*\(/.test(code)) pham.push(f.slice(process.cwd().length + 1));
    }
    expect(pham, `Tạo phòng chat PHẢI qua createGroupRoom() (có gate trùng tên + bắt buộc có người). Vi phạm:\n${pham.join('\n')}`).toEqual([]);
  });
});
