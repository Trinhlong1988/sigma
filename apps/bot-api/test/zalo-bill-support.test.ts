// SIGMA — "TỰ LẤY BILL ZALO → SigMa". Regression cho zalo-bill-support.ts trên throwaway DB
// (global-setup.ts đã migrate deploy). Kiểm THẬT (KHÔNG suy luận):
//  • ensureSupportAlphaAgent idempotent — gọi 2 lần = 1 Agent code=SUPPORT_ALPHA, name='Support SigMa'.
//  • matchRoomByZaloGroupName: exact (có dấu), exact (không dấu), chứa-nhau, không phòng → null, tên rỗng →
//    null, 2 phòng cùng tên → null (mơ hồ), phòng DIRECT/đã xóa KHÔNG khớp.
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import {
  ensureSupportAlphaAgent,
  matchRoomByZaloGroupName,
  normalizeGroupName,
  SUPPORT_SIGMA_CODE,
  SUPPORT_SIGMA_NAME
} from '../src/zalo-bill-support.js';
import { makeChatRoom } from './fixtures.js';

let seq = 0;
/** Hậu tố duy nhất để tên phòng KHÔNG đụng nhau giữa các test (mỗi test tự cô lập namespace tên riêng). */
function tag(): string {
  seq += 1;
  return `${Date.now()}_${seq}`;
}

describe('normalizeGroupName', () => {
  it('bỏ dấu + đ→d + uppercase + bỏ ký tự lạ + gộp space', () => {
    expect(normalizeGroupName('ĐL- Mr. Bảo SG')).toBe('DL MR BAO SG');
    expect(normalizeGroupName('  đại   lý  ')).toBe('DAI LY');
    expect(normalizeGroupName('')).toBe('');
    expect(normalizeGroupName('   ')).toBe('');
  });
});

describe('ensureSupportAlphaAgent', () => {
  it('idempotent — gọi 2 lần = 1 Agent code=SUPPORT_ALPHA, name="Support SigMa"', async () => {
    const db = getBotDb();
    const a = await ensureSupportAlphaAgent(db);
    const b = await ensureSupportAlphaAgent(db);
    expect(a.id).toBe(b.id);
    const rows = await db.agent.findMany({ where: { code: SUPPORT_SIGMA_CODE } });
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe(SUPPORT_SIGMA_NAME);
    expect(rows[0].name).toBe('Support SigMa');
  });
});

describe('matchRoomByZaloGroupName', () => {
  it('khớp CHÍNH XÁC (có dấu) — "ĐL- Mr. Bảo SG" ↔ phòng cùng tên → trả roomId đúng', async () => {
    const db = getBotDb();
    const name = `ĐL- Mr. Bảo SG ${tag()}`;
    const room = await makeChatRoom({ type: 'GROUP', name });
    const matched = await matchRoomByZaloGroupName(db, name);
    expect(matched).not.toBeNull();
    expect(matched?.roomId).toBe(room.id);
    expect(matched?.roomName).toBe(name);
  });

  it('khớp KHÔNG DẤU — tên Zalo "DL Mr Bao SG" ↔ phòng "ĐL- Mr. Bảo SG" (chuẩn-hoá bằng nhau)', async () => {
    const db = getBotDb();
    const t = tag();
    const roomName = `ĐL- Mr. Bảo SG ${t}`;
    const room = await makeChatRoom({ type: 'GROUP', name: roomName });
    // Tên Zalo viết không dấu + ký tự khác nhưng CHUẨN-HOÁ RA CÙNG chuỗi "DL MR BAO SG <t>".
    const matched = await matchRoomByZaloGroupName(db, `DL Mr Bao SG ${t}`);
    expect(matched?.roomId).toBe(room.id);
  });

  it('khớp CHỨA-nhau — tên Zalo "Bảo SG" nằm trong phòng "ĐL- Mr. Bảo SG" → khớp', async () => {
    const db = getBotDb();
    const t = tag();
    const roomName = `ĐL- Mr. Bảo SG ${t}`;
    const room = await makeChatRoom({ type: 'GROUP', name: roomName });
    const matched = await matchRoomByZaloGroupName(db, `Bảo SG ${t}`);
    expect(matched?.roomId).toBe(room.id);
  });

  it('chứa-nhau — nhiều phòng khớp thì chọn phòng có ĐỘ DÀI tên gần nhất', async () => {
    const db = getBotDb();
    const t = tag();
    // Cả 2 phòng đều CHỨA tên Zalo "BAO SG <t>"; phòng ngắn (gần độ dài Zalo hơn) phải được chọn.
    const near = await makeChatRoom({ type: 'GROUP', name: `Mr Bao SG ${t}` });
    await makeChatRoom({ type: 'GROUP', name: `Dai ly Mr Bao SG khu vuc mien nam ${t}` });
    const zalo = `Bao SG ${t}`;
    const matched = await matchRoomByZaloGroupName(db, zalo);
    expect(matched?.roomId).toBe(near.id);
  });

  it('KHÔNG phòng nào khớp → null', async () => {
    const db = getBotDb();
    await makeChatRoom({ type: 'GROUP', name: `Nhom hoan toan khac ${tag()}` });
    expect(await matchRoomByZaloGroupName(db, `Ten khong ton tai ${tag()}`)).toBeNull();
  });

  it('tên Zalo RỖNG → null', async () => {
    const db = getBotDb();
    await makeChatRoom({ type: 'GROUP', name: `Phong bat ky ${tag()}` });
    expect(await matchRoomByZaloGroupName(db, '')).toBeNull();
    expect(await matchRoomByZaloGroupName(db, '   ')).toBeNull();
    // Ký tự toàn trang trí (chuẩn-hoá ra rỗng) cũng coi như rỗng → null.
    expect(await matchRoomByZaloGroupName(db, '--- !!! ---')).toBeNull();
  });

  it('2 phòng CÙNG tên chuẩn-hoá khớp exact → null (MƠ HỒ, không đoán liều)', async () => {
    const db = getBotDb();
    const t = tag();
    // 2 phòng viết khác nhau nhưng chuẩn-hoá RA CÙNG "DL MR BAO SG <t>".
    await makeChatRoom({ type: 'GROUP', name: `ĐL- Mr. Bảo SG ${t}` });
    await makeChatRoom({ type: 'GROUP', name: `DL Mr Bao SG ${t}` });
    expect(await matchRoomByZaloGroupName(db, `DL MR BAO SG ${t}`)).toBeNull();
  });

  it('phòng DIRECT hoặc đã XÓA (deletedAt) KHÔNG được khớp', async () => {
    const db = getBotDb();
    const t = tag();
    const zalo = `Khach le ${t}`;
    // Phòng DIRECT cùng tên → KHÔNG khớp (chỉ khớp GROUP).
    await db.chatRoom.create({ data: { type: 'DIRECT', name: `Khach le ${t}` } });
    // Phòng GROUP cùng tên nhưng đã xóa (soft) → KHÔNG khớp.
    await db.chatRoom.create({ data: { type: 'GROUP', name: `Khach le ${t}`, deletedAt: new Date() } });
    expect(await matchRoomByZaloGroupName(db, zalo)).toBeNull();

    // Thêm 1 phòng GROUP sống cùng tên → giờ PHẢI khớp đúng phòng đó (khẳng định lọc chỉ loại DIRECT/deleted).
    const live = await makeChatRoom({ type: 'GROUP', name: `Khach le ${t}` });
    const matched = await matchRoomByZaloGroupName(db, zalo);
    expect(matched?.roomId).toBe(live.id);
  });
});
