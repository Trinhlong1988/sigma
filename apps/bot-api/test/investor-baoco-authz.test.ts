// [Admin Demo 13/9 "nhóm NĐT thì user của NĐT đó có quyền xem, đảm bảo bảo mật"] GUARD AUTHZ check sao kê NĐT:
// MỌI route /v1/investor-baoco/* PHẢI (1) requireSession ngay trên route, (2) trong handler PHẢI gọi
// agentScopeInvestorIds + check investorId ∈ scope (403 người ngoài nhóm). Route mới thêm vào prefix mà quên
// scope = đỏ CI. Cred MB: mật khẩu KHÔNG bao giờ xuất hiện trong response/log (không res.json chứa password).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src', 'routes', 'ocr-send.ts'), 'utf8');

/** Cắt thân từng handler /v1/investor-baoco/* (từ đăng ký route đến route kế tiếp). */
function handlerBodies(): { path: string; body: string }[] {
  const out: { path: string; body: string }[] = [];
  const re = /\.(get|post|put|patch|delete)\(\s*'(\/v1\/investor-baoco\/[^']+)'/g;
  let m: RegExpExecArray | null;
  const marks: { path: string; idx: number }[] = [];
  while ((m = re.exec(SRC)) !== null) marks.push({ path: m[2], idx: m.index });
  const allRe = /\.(get|post|put|patch|delete)\(\s*'/g;
  const allIdx: number[] = [];
  while ((m = allRe.exec(SRC)) !== null) allIdx.push(m.index);
  for (const mk of marks) {
    const next = allIdx.find((i) => i > mk.idx) ?? SRC.length;
    out.push({ path: mk.path, body: SRC.slice(mk.idx, next) });
  }
  return out;
}

describe('authz /v1/investor-baoco/* — quyền theo nhóm NĐT', () => {
  const routes = handlerBodies();

  it('quét được route (guard không rỗng nghĩa)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(2); // /check + /upload
  });

  it('mọi route có requireSession NGAY TRÊN route', () => {
    const thieu = routes.filter((r) => !r.body.slice(0, 300).includes('requireSession')).map((r) => r.path);
    expect(thieu, `Thiếu requireSession: ${thieu.join(', ')}`).toEqual([]);
  });

  it('mọi handler PHẢI check agentScopeInvestorIds (403 người ngoài nhóm NĐT)', () => {
    const thieu = routes.filter((r) => !r.body.includes('agentScopeInvestorIds') || !r.body.includes('FORBIDDEN')).map((r) => r.path);
    expect(thieu, `Thiếu scope-check nhóm NĐT: ${thieu.join(', ')}`).toEqual([]);
  });

  it('mật khẩu MB không bao giờ trả ra response và không bị log', () => {
    for (const r of routes) {
      // res.json(...) không được chứa biến password/password_enc; console.* không được nhận password.
      const jsonCalls = r.body.match(/res\.(status\(\d+\)\.)?json\([^;]*\)/g) ?? [];
      for (const c of jsonCalls) expect(c.includes('password'), `${r.path} trả password trong response: ${c.slice(0, 80)}`).toBe(false);
      const logs = r.body.match(/console\.\w+\([^;]*\)/g) ?? [];
      for (const c of logs) expect(c.includes('password'), `${r.path} log password: ${c.slice(0, 80)}`).toBe(false);
    }
  });

  it('cred lưu DB phải qua encryptSecret (không lưu bản rõ)', () => {
    const insert = SRC.match(/INSERT INTO investor_feed_creds[\s\S]{0,400}/g) ?? [];
    expect(insert.length).toBeGreaterThan(0);
    for (const c of insert) expect(c.includes('encryptSecret'), 'INSERT investor_feed_creds không encryptSecret').toBe(true);
  });
});
