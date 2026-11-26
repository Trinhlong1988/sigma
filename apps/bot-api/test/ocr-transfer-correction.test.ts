import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordCorrection, loadCorrections } from '../src/transfer-classify.js';

// [Admin Demo 4/9] "đã sửa tay thì re-OCR phải trả trạng thái sửa gần nhất" — store correction theo ảnh, last-wins.
describe('transfer correction store — append-only last-wins theo ảnh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corr-'));
  const file = join(dir, 'c.jsonl');
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('recordCorrection + loadCorrections: dòng SAU đè dòng TRƯỚC cùng imageHash', () => {
    recordCorrection(file, { imageHash: 'H1', direction: 'SIGMA_TO_DEALER', entityType: 'DEALER', entityId: null, roomId: 'r1', roomName: 'ĐL A' });
    recordCorrection(file, { imageHash: 'H1', direction: 'SIGMA_TO_DEALER_ADVANCE', entityType: 'DEALER', entityId: null, roomId: 'r1', roomName: 'ĐL A' }); // sửa lại thành tạm ứng
    recordCorrection(file, { imageHash: 'H2', direction: 'INVESTOR_TO_ALPHA', entityType: 'INVESTOR', entityId: 7, roomId: null, roomName: null });
    const m = loadCorrections(file);
    expect(m.get('H1')?.direction).toBe('SIGMA_TO_DEALER_ADVANCE'); // last-wins: bản sửa gần nhất
    expect(m.get('H2')?.direction).toBe('INVESTOR_TO_ALPHA');
    expect(m.get('H2')?.entityId).toBe(7);
  });

  it('file chưa có → map rỗng, không ném', () => {
    expect(loadCorrections(join(dir, 'khong-ton-tai.jsonl')).size).toBe(0);
  });
});

// Khôi phục qua augment: correction đè hướng OCR mặc định (hoàn → tạm ứng) theo ảnh.
describe('augmentTransferReviewWithSentKind — khôi phục bản sửa tay theo ảnh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corr2-'));
  let svc: typeof import('../src/ocr-send-service.js');
  const buf = Buffer.from('anh-bill-gia-lap-cho-hash-on-dinh');
  const mockDb = { chatMessage: { findMany: async () => [], findFirst: async () => null } } as unknown as Parameters<typeof import('../src/ocr-send-service.js').augmentTransferReviewWithSentKind>[0];
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  beforeAll(async () => {
    process.env.TRANSFER_CORRECTION_PATH = join(dir, 'c2.jsonl');
    svc = await import('../src/ocr-send-service.js');
  });

  it('OCR ra "Hoàn tiền đại lý" nhưng đã sửa tay "Đại lý ứng trước" → augment trả về ĐÚNG tạm ứng', async () => {
    svc.saveTransferCorrectionByBuffer(buf, { direction: 'SIGMA_TO_DEALER_ADVANCE', entityType: 'DEALER', entityId: null, roomId: 'room-nguyen-sg', roomName: 'ĐL- Mr Nguyễn SG' });
    const tr = { direction: 'SIGMA_TO_DEALER', entityType: 'DEALER', entityId: null, matchedRoomId: 'room-nguyen-sg', matchedRoomName: 'ĐL- Mr Nguyễn SG', needsManualPick: false, warnings: [] } as unknown as Parameters<typeof svc.augmentTransferReviewWithSentKind>[1][number];
    await svc.augmentTransferReviewWithSentKind(mockDb, [tr], buf);
    expect(tr.direction).toBe('SIGMA_TO_DEALER_ADVANCE'); // khôi phục bản sửa tay
    expect(tr.needsManualPick).toBe(false);
    expect(tr.warnings.some((w: string) => w.includes('sửa tay trước'))).toBe(true);
  });

  it('ảnh KHÁC (chưa sửa) → giữ nguyên hướng OCR', async () => {
    const other = Buffer.from('anh-bill-khac-chua-tung-sua');
    const tr = { direction: 'SIGMA_TO_DEALER', entityType: 'DEALER', entityId: null, matchedRoomId: 'r9', matchedRoomName: 'ĐL X', needsManualPick: false, warnings: [] } as unknown as Parameters<typeof svc.augmentTransferReviewWithSentKind>[1][number];
    await svc.augmentTransferReviewWithSentKind(mockDb, [tr], other);
    expect(tr.direction).toBe('SIGMA_TO_DEALER'); // không đụng
  });
});
