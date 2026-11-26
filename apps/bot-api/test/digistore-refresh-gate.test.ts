// [PHẢN BIỆN 3 — 11/9] Gate refresh báo-có: mutex in-flight + throttle. TÁI HIỆN đúng bug đã confirm bằng đọc code:
// throttle thời-gian cũ (lastRefreshMs set lúc VÀO request) cho request 2 LỌT sau 21s dù lượt poll 1 (tới 90s+)
// chưa xong → 2 browser login bank song song. + killChildTree: đường taskkill /F /T (orphan Windows — tái hiện
// thật bằng _repro-orphan.mjs: execFile{shell:true,timeout} chỉ giết cmd wrapper, con+cháu sống sót).
import { describe, expect, it } from 'vitest';
import { createRefreshGate, killChildTree, type KillableChild } from '../src/digistore-refresh-gate.js';

describe('createRefreshGate — mutex in-flight + throttle', () => {
  it('BUG CŨ: request 2 sau 21s khi lượt 1 CHƯA xong → giờ phải BUSY (trước đây lọt → 2 login bank song song)', () => {
    const g = createRefreshGate(20_000);
    expect(g.tryAcquire(0).ok).toBe(true);          // lượt 1 bắt đầu, poll chạy dở (chưa release)
    const d = g.tryAcquire(21_000);                  // 21s sau — throttle cũ cho qua
    expect(d.ok).toBe(false);
    expect(d.code).toBe('BUSY');
  });

  it('trong 20s sau khi lượt trước XONG → TOO_FREQUENT kèm waitS', () => {
    const g = createRefreshGate(20_000);
    expect(g.tryAcquire(0).ok).toBe(true);
    g.release();
    const d = g.tryAcquire(5_000);
    expect(d).toEqual({ ok: false, code: 'TOO_FREQUENT', waitS: 15 });
  });

  it('qua 20s + đã release → acquire được lại; release xong isInFlight=false', () => {
    const g = createRefreshGate(20_000);
    expect(g.tryAcquire(0).ok).toBe(true);
    g.release();
    expect(g.isInFlight()).toBe(false);
    expect(g.tryAcquire(20_000).ok).toBe(true);
    expect(g.isInFlight()).toBe(true);
  });

  it('BUSY ưu tiên trước TOO_FREQUENT (đang chạy thì lý do là ĐANG CHẠY, không phải "đợi X giây")', () => {
    const g = createRefreshGate(20_000);
    expect(g.tryAcquire(0).ok).toBe(true);
    const d = g.tryAcquire(3_000); // vừa BUSY vừa trong 20s
    expect(d.code).toBe('BUSY');
  });
});

function fakeChild(over: Partial<KillableChild> = {}): KillableChild & { killCalls: unknown[] } {
  const killCalls: unknown[] = [];
  return { pid: 1234, killed: false, exitCode: null, kill: (s?: unknown) => { killCalls.push(s); return true; }, killCalls, ...over } as KillableChild & { killCalls: unknown[] };
}

describe('killChildTree — giết CẢ CÂY trên Windows (chống orphan chromium)', () => {
  it('win32 + wrapper còn sống → taskkill /F /T /PID <pid>', () => {
    const spawned: { cmd: string; args: string[] }[] = [];
    const spawnFn = ((cmd: string, args: string[]) => { spawned.push({ cmd, args }); return { on: () => {} }; }) as never;
    const c = fakeChild();
    expect(killChildTree(c, { spawnFn, platform: 'win32' })).toBe('taskkill');
    expect(spawned).toEqual([{ cmd: 'taskkill', args: ['/F', '/T', '/PID', '1234'] }]);
  });

  it('wrapper ĐÃ thoát (exitCode≠null) → skip (KHÔNG taskkill theo PID — chống PID-reuse giết nhầm, incident vision-ocr 6/9)', () => {
    const c = fakeChild({ exitCode: 1 });
    expect(killChildTree(c, { platform: 'win32' })).toBe('skip');
  });

  it('wrapper đã killed hoặc không có pid → skip', () => {
    expect(killChildTree(fakeChild({ killed: true }), { platform: 'win32' })).toBe('skip');
    expect(killChildTree(fakeChild({ pid: undefined }), { platform: 'win32' })).toBe('skip');
  });

  it('spawnFn ném lỗi → fallback child.kill(SIGKILL)', () => {
    const c = fakeChild();
    const spawnFn = (() => { throw new Error('no taskkill'); }) as never;
    expect(killChildTree(c, { spawnFn, platform: 'win32' })).toBe('kill');
    expect(c.killCalls).toEqual(['SIGKILL']);
  });

  it('non-Windows → kill(SIGKILL) thẳng', () => {
    const c = fakeChild();
    expect(killChildTree(c, { platform: 'linux' })).toBe('kill');
    expect(c.killCalls).toEqual(['SIGKILL']);
  });
});

// [6/10 — SỰ CỐ THẬT] BVBank 502 hàng loạt → một lượt poll TREO (log đứng im >5 phút). release() chỉ nằm trong
// `finally` nên lượt treo không bao giờ nhả chốt ⇒ nút "Tải lại" báo BUSY VĨNH VIỄN, phải restart bot-api mới hết.
// Các test dưới TÁI HIỆN đúng ca đó rồi khẳng định chốt tự thu hồi.
describe('createRefreshGate — thu hồi chốt khi lượt trước TREO (6/10)', () => {
  it('TÁI HIỆN BUG: lượt 1 không bao giờ release → trước đây BUSY mãi mãi', () => {
    const g = createRefreshGate(20_000, 180_000);
    expect(g.tryAcquire(0).ok).toBe(true);           // lượt 1 bắt đầu rồi TREO, không release
    expect(g.tryAcquire(60_000).code).toBe('BUSY');  // 1 phút: vẫn trong hạn → đúng là BUSY
    expect(g.tryAcquire(170_000).code).toBe('BUSY'); // gần hết hạn → vẫn BUSY
  });

  it('quá hạn giữ chốt → THU HỒI và cấp cho lượt mới (không còn kẹt vĩnh viễn)', () => {
    const g = createRefreshGate(20_000, 180_000);
    expect(g.tryAcquire(0).ok).toBe(true);
    const d = g.tryAcquire(180_000);
    expect(d.ok).toBe(true);
    expect(d.thuHoi).toBe(true);
    expect(g.isInFlight()).toBe(true);
  });

  it('BUSY kèm heldS = số giây lượt đang chạy đã chiếm chốt', () => {
    const g = createRefreshGate(20_000, 180_000);
    g.tryAcquire(0);
    expect(g.tryAcquire(45_000)).toEqual({ ok: false, code: 'BUSY', heldS: 45 });
  });

  it('thu hồi KHÔNG bị throttle thời-gian chặn lại (nếu chặn thì vẫn kẹt, chỉ đổi mã lỗi)', () => {
    const g = createRefreshGate(600_000, 180_000);   // throttle 10 phút > hạn giữ chốt 3 phút
    expect(g.tryAcquire(0).ok).toBe(true);
    const d = g.tryAcquire(180_000);                  // mới 3 phút, chưa qua throttle 10 phút
    expect(d.ok).toBe(true);
    expect(d.thuHoi).toBe(true);
  });

  it('sau thu hồi, mốc thời gian được đặt lại theo lượt MỚI (lượt kế vẫn bị throttle bình thường)', () => {
    const g = createRefreshGate(20_000, 180_000);
    g.tryAcquire(0);
    g.tryAcquire(180_000);          // thu hồi, lượt mới bắt đầu lúc 180_000
    g.release();
    expect(g.tryAcquire(185_000)).toEqual({ ok: false, code: 'TOO_FREQUENT', waitS: 15 });
    expect(g.tryAcquire(200_000).ok).toBe(true);
  });

  it('đường bình thường KHÔNG đổi: release trước hạn thì không có cờ thu hồi', () => {
    const g = createRefreshGate(20_000, 180_000);
    g.tryAcquire(0);
    g.release();
    const d = g.tryAcquire(20_000);
    expect(d.ok).toBe(true);
    expect(d.thuHoi).toBeUndefined();
  });
});
