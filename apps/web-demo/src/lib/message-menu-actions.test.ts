// Test THUẦN cho menu-theo-loại + trích link (message-menu-actions.ts) — menu thao tác tin nhắn theo LOẠI
// (chuột-phải/hover) kiểu Zalo, giữ brand SigMa (7/8). Cùng lớp "pure-logic test" env node (không DOM).
import { describe, expect, it } from 'vitest';
import { extractFirstUrl, menuActionsForMessage, messageHasLink } from './message-menu-actions';

describe('extractFirstUrl', () => {
  it('trả về null khi không có text / không có link', () => {
    expect(extractFirstUrl(undefined)).toBeNull();
    expect(extractFirstUrl('')).toBeNull();
    expect(extractFirstUrl('chỉ là tin nhắn thường')).toBeNull();
    expect(extractFirstUrl('gọi mình qua email a@b.com nhé')).toBeNull(); // không phải http(s)
  });

  it('bắt URL http/https đầu tiên', () => {
    expect(extractFirstUrl('xem https://example.com/tin nhé')).toBe('https://example.com/tin');
    expect(extractFirstUrl('HTTP://VD.COM đây')).toBe('HTTP://VD.COM');
    expect(extractFirstUrl('a https://one.com rồi https://two.com')).toBe('https://one.com');
  });

  it('bỏ dấu câu/ngoặc dính đuôi URL', () => {
    expect(extractFirstUrl('link: https://example.com/abc.')).toBe('https://example.com/abc');
    expect(extractFirstUrl('(https://example.com/x)')).toBe('https://example.com/x');
    expect(extractFirstUrl('vào https://example.com/a?b=1 ngay!')).toBe('https://example.com/a?b=1');
  });
});

describe('messageHasLink', () => {
  it('CHỈ true cho tin text có link', () => {
    expect(messageHasLink('text', 'xem https://a.com')).toBe(true);
    expect(messageHasLink('text', 'không link')).toBe(false);
    expect(messageHasLink('image', 'caption https://a.com')).toBe(false); // ảnh không xét link caption
    expect(messageHasLink('file', 'https://a.com')).toBe(false);
    expect(messageHasLink('system', 'https://a.com')).toBe(false);
  });
});

describe('menuActionsForMessage', () => {
  it('text thường (của mình): reply, forward, copy, delete — KHÔNG có link/download', () => {
    expect(menuActionsForMessage({ type: 'text', isMine: true, hasLink: false, canDownload: false })).toEqual([
      'reply',
      'forward',
      'copy',
      'delete'
    ]);
  });

  it('text thường (người khác): reply, forward, copy — KHÔNG delete', () => {
    expect(menuActionsForMessage({ type: 'text', isMine: false, hasLink: false, canDownload: false })).toEqual([
      'reply',
      'forward',
      'copy'
    ]);
  });

  it('text CÓ link: thêm openLink + copyLink sau copy', () => {
    expect(menuActionsForMessage({ type: 'text', isMine: false, hasLink: true, canDownload: false })).toEqual([
      'reply',
      'forward',
      'copy',
      'openLink',
      'copyLink'
    ]);
  });

  it('ảnh (của mình, tải được): reply, forward, download, share, delete — KHÔNG copy', () => {
    const actions = menuActionsForMessage({ type: 'image', isMine: true, hasLink: false, canDownload: true });
    expect(actions).toEqual(['reply', 'forward', 'download', 'share', 'delete']);
    expect(actions).not.toContain('copy');
  });

  it('ảnh KHÔNG tải được (mock placeholder): KHÔNG có download/share', () => {
    const actions = menuActionsForMessage({ type: 'image', isMine: false, hasLink: false, canDownload: false });
    expect(actions).toEqual(['reply', 'forward']);
    expect(actions).not.toContain('share');
  });

  it('file (tải được): reply, forward, download, share', () => {
    expect(menuActionsForMessage({ type: 'file', isMine: false, hasLink: false, canDownload: true })).toEqual([
      'reply',
      'forward',
      'download',
      'share'
    ]);
  });

  it('Tải xuống (download) LUÔN đi kèm Chia sẻ (share) và NGAY SAU nó — 2 hành động tách bạch', () => {
    for (const type of ['image', 'file'] as const) {
      const actions = menuActionsForMessage({ type, isMine: false, hasLink: false, canDownload: true });
      const di = actions.indexOf('download');
      const si = actions.indexOf('share');
      expect(di).toBeGreaterThanOrEqual(0);
      expect(si).toBe(di + 1); // share NGAY SAU download
    }
  });

  it('voice (của mình): reply, forward, delete — KHÔNG copy/download/share', () => {
    const actions = menuActionsForMessage({ type: 'voice', isMine: true, hasLink: false, canDownload: false });
    expect(actions).toEqual(['reply', 'forward', 'delete']);
    expect(actions).not.toContain('copy');
    expect(actions).not.toContain('download');
    expect(actions).not.toContain('share');
  });

  it('location/qr: chỉ reply, forward (+delete nếu của mình)', () => {
    expect(menuActionsForMessage({ type: 'location', isMine: false, hasLink: false, canDownload: false })).toEqual([
      'reply',
      'forward'
    ]);
    expect(menuActionsForMessage({ type: 'qr', isMine: true, hasLink: false, canDownload: false })).toEqual([
      'reply',
      'forward',
      'delete'
    ]);
  });

  it('system: menu rỗng', () => {
    expect(menuActionsForMessage({ type: 'system', isMine: true, hasLink: true, canDownload: true })).toEqual([]);
  });
});
