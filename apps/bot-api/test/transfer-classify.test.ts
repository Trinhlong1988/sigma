// Test PHÂN-HƯỚNG bill CK (Admin Demo 31/8) — 4 hướng + khớp đối tác + alias-học, dùng data 5 bill THẬT.
import { describe, it, expect } from 'vitest';
import { classifyTransfer, normalizeVi, loadAliases, recordAlias, type ClassifyContext, type AliasEntry } from '../src/transfer-classify.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ctx: ClassifyContext = {
  alphaNames: ['Nhân viên B', 'Nhân viên E', 'Nguoi Dung Demo'].map(normalizeVi),
  investors: [
    { id: 15, names: ['Khach Demo A', 'Nguyen Thi Thao Giang'] }, // NĐT 2
    { id: 16, names: ['Nguyen Cam Dao'] } // Trung
  ],
  dealerGroups: [
    { roomId: 'room-huy', name: 'ĐL- Huy DakLak' },
    { roomId: 'room-hoang', name: 'ĐL Nguyen Minh Hoang' }
  ],
  aliases: []
};

describe('classifyTransfer — 4 hướng bill CK thật', () => {
  it('SigMa→đại lý (Huy): sender KT Demo, receiver DLY HUY DAKLAK → SIGMA_TO_DEALER, room Huy', () => {
    const r = classifyTransfer({ senderName: 'KHACH HANG 01', receiverName: 'DLY HUY DAKLAK', content: 'MBCT KHACH HANG 01 chuyen tien' }, ctx);
    expect(r.direction).toBe('SIGMA_TO_DEALER');
    expect(r.roomId).toBe('room-huy');
    expect(r.needsManualPick).toBe(false);
  });

  it('SigMa→đại lý (Hoàng): receiver KHACH HANG 25 → SIGMA_TO_DEALER, room Hoàng', () => {
    const r = classifyTransfer({ senderName: 'KHACH HANG 01', receiverName: 'KHACH HANG 25', content: 'KHACH HANG 01 chuyen tien' }, ctx);
    expect(r.direction).toBe('SIGMA_TO_DEALER');
    expect(r.roomId).toBe('room-hoang');
  });

  it('NĐT→SigMa tạm ứng (Khach Demo A→KT Demo): INVESTOR_TO_ALPHA, NĐT Thông (15)', () => {
    const r = classifyTransfer({ senderName: 'KHACH HANG 02', receiverName: 'KHACH HANG 01', content: 'KHACH HANG 02 CHUYEN KHOAN' }, ctx);
    expect(r.direction).toBe('INVESTOR_TO_ALPHA');
    expect(r.entityType).toBe('INVESTOR');
    expect(r.entityId).toBe(15);
  });

  it('NĐT→SigMa tạm ứng (Thao Giang→KT Demo): INVESTOR_TO_ALPHA, NĐT Thông (15)', () => {
    const r = classifyTransfer({ senderName: 'KHACH HANG 07', receiverName: 'KHACH HANG 01' }, ctx);
    expect(r.direction).toBe('INVESTOR_TO_ALPHA');
    expect(r.entityId).toBe(15);
  });

  it('KHÔNG khớp đối tác → UNKNOWN + needsManualPick (dropdown)', () => {
    const r = classifyTransfer({ senderName: 'KHACH HANG 01', receiverName: 'NGUOI LA HOAN TOAN' }, ctx);
    expect(r.direction).toBe('UNKNOWN');
    expect(r.needsManualPick).toBe(true);
  });

  it('Không bên nào SigMa → UNKNOWN (chọn tay)', () => {
    const r = classifyTransfer({ senderName: 'ONG A', receiverName: 'BA B' }, ctx);
    expect(r.direction).toBe('UNKNOWN');
    expect(r.needsManualPick).toBe(true);
  });

  it('ALIAS-HỌC: sau khi phân loại tay + ghi alias theo tên → lần sau tự nhận', () => {
    const withAlias: ClassifyContext = { ...ctx, aliases: [{ key: normalizeVi('NGUOI LA HOAN TOAN'), kind: 'name', entityType: 'DEALER', entityId: null, roomId: 'room-huy', label: 'Huy (học)' }] };
    const r = classifyTransfer({ senderName: 'KHACH HANG 01', receiverName: 'NGUOI LA HOAN TOAN' }, withAlias);
    expect(r.direction).toBe('SIGMA_TO_DEALER');
    expect(r.roomId).toBe('room-huy');
    expect(r.matchBy).toBe('learned-name');
    expect(r.needsManualPick).toBe(false);
  });

  it('ALIAS-HỌC persist: recordAlias → loadAliases đọc lại đúng (append-only, last-wins)', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'alias-')), 'alias.jsonl');
    const e: AliasEntry = { key: '0900000600', kind: 'acct', entityType: 'DEALER', entityId: null, roomId: 'room-huy', label: 'Huy' };
    recordAlias(p, e);
    recordAlias(p, { ...e, roomId: 'room-huy2' }); // ghi đè cùng key
    const loaded = loadAliases(p);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.roomId).toBe('room-huy2');
  });
});
