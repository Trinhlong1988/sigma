// GUARD "QUY TRÌNH" (Admin Demo 21/8 "quy trình ở đâu?") — chống TÁI DIỄN bug doanh-số-luôn-0.
//
// GỐC BUG: audit 20/8 chuyển scope "TID của đại lý" sang agentScopeCustomerIds nhưng SÓT chat-room-tid-service.ts
// (gate `tid.agentId === requesterAgentId`). Mà `tids.agentId` LUÔN null ở production → gate rơi rỗng → doanh số
// LUÔN 0 âm thầm. Test cũ seed tids.agentId nên xanh giả (Engineering PASS ≠ Production PASS, R196).
//
// GUARD: quét TOÀN BỘ mã nguồn bot-api/src, CẤM mọi SO SÁNH `<x>tid.agentId === / !==` (gate theo tids.agentId —
// field luôn null prod nên MỌI gate như vậy là dead gate im lặng). Ai thêm lại = test này ĐỎ ngay. Dùng
// agentScopeCustomerIds (scope theo KHÁCH qua nhóm chat) thay thế. KHÔNG chặn chatRoomMember.agentId (field THẬT,
// hợp lệ) — chỉ chặn *.agentId của biến TID.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function allTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allTsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Bỏ comment (block + line) để KHÔNG khớp nhầm phần giải thích trong chú thích. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Bất kỳ biến kết thúc bằng "tid" (tid, oldTid, foundTid...) .agentId đem so sánh === / !== = gate theo tids.agentId.
const DEAD_GATE_RE = /\b\w*tid\b\s*\.\s*agentId\s*[!=]==/i;

describe('GUARD: cấm gate theo tids.agentId (field luôn null prod → doanh số luôn 0)', () => {
  it('KHÔNG file src nào so sánh <tid>.agentId === / !== (dùng agentScopeCustomerIds thay thế)', () => {
    const offenders: string[] = [];
    for (const file of allTsFiles(SRC)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        if (DEAD_GATE_RE.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, `Gate chết theo tids.agentId (agentId LUÔN null prod → rơi rỗng im lặng). Dùng agentScopeCustomerIds:\n${offenders.join('\n')}`).toEqual([]);
  });
});
