// PHÂN-HƯỚNG bill CHUYỂN KHOẢN (Admin Demo 31/8) — xác định 1 trong 4 hướng + khớp đối tác (đại lý/NĐT) qua
// alias-HỌC (append-only) → alias-SEED (tên NĐT/SigMa) → fuzzy tên nhóm. Logic THUẦN (không DB) để unit-test;
// caller nạp sẵn danh sách entity. Xem reference_alpha_transfer_bill_ocr_refund.md (phương án khóa + 4 hướng).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

/** Chuẩn hoá tên VN: bỏ dấu, UPPER, gộp khoảng trắng. (Đồng nhất normalizeVi ở ocr-send-service.) */
export function normalizeVi(s: string | null | undefined): string {
  return (s ?? '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type PartyType = 'DEALER' | 'INVESTOR' | 'SIGMA';
export type TransferDirection =
  | 'SIGMA_TO_DEALER' // hoàn tiền đại lý (+)
  | 'DEALER_TO_ALPHA' // đại lý hoàn thừa về SigMa (−)
  | 'INVESTOR_TO_ALPHA' // NĐT tạm ứng
  | 'SIGMA_TO_INVESTOR' // SigMa hoàn thừa tạm ứng cho NĐT
  | 'SIGMA_TO_DEALER_ADVANCE' // SigMa ứng tiền TRƯỚC cho đại lý (Admin Demo 1/9) — auto không đoán được, CHỌN TAY
  | 'UNKNOWN';

export interface AliasEntry { key: string; kind: 'acct' | 'name'; entityType: PartyType; entityId: number | null; roomId: string | null; label: string; }

/** Entity nạp từ DB để khớp (thuần — caller cung cấp). */
export interface ClassifyContext {
  alphaNames: string[]; // đã normalizeVi — người/tài khoản SigMa (KT Demo/ND Demo/KH Demo)
  investors: { id: number; names: string[] }[]; // tên/alias NĐT (chưa normalize — hàm tự chuẩn hoá)
  dealerGroups: { roomId: string; name: string }[]; // nhóm chat đại lý (tên nhóm)
  aliases: AliasEntry[]; // alias-HỌC đã lưu (đã normalizeVi key)
}

export interface ClassifyResult {
  direction: TransferDirection;
  entityType: PartyType | null; // đối tác (phía không-SigMa)
  entityId: number | null;
  roomId: string | null;
  matchBy: 'learned-acct' | 'learned-name' | 'investor-name' | 'dealer-fuzzy' | 'none';
  needsManualPick: boolean; // true → UI dropdown bắt buộc + chặn gửi
  warnings: string[];
}

interface TransferInput {
  senderName?: string | null; senderAccount?: string | null;
  receiverName?: string | null; receiverAccount?: string | null;
  content?: string | null;
}

function isAlpha(name: string | null | undefined, alphaNames: string[]): boolean {
  const n = normalizeVi(name);
  return !!n && alphaNames.some((a) => a && n.includes(a));
}

/** Khớp 1 "phía" (tên+STK+content) → đối tác. Ưu tiên: alias-học STK → alias-học tên → NĐT theo tên → đại lý fuzzy. */
function matchParty(
  name: string | null | undefined, account: string | null | undefined, content: string | null | undefined, ctx: ClassifyContext
): { entityType: PartyType; entityId: number | null; roomId: string | null; matchBy: ClassifyResult['matchBy'] } | null {
  const acct = (account ?? '').replace(/\s|\*/g, '').trim();
  const nName = normalizeVi(name);
  // 1) alias-học theo STK (exact, mạnh nhất)
  if (acct) {
    const a = ctx.aliases.find((x) => x.kind === 'acct' && x.key === acct);
    if (a) return { entityType: a.entityType, entityId: a.entityId, roomId: a.roomId, matchBy: 'learned-acct' };
  }
  // 2) alias-học theo tên
  if (nName) {
    const a = ctx.aliases.find((x) => x.kind === 'name' && x.key === nName);
    if (a) return { entityType: a.entityType, entityId: a.entityId, roomId: a.roomId, matchBy: 'learned-name' };
  }
  // 3) NĐT theo tên (seed investor_bank_accounts.account_holder / map tên)
  // [Audit 3/9 #12] KHỚP CHÍNH XÁC (trước đây substring 2 CHIỀU: nName.includes(v)||v.includes(nName) → tên NĐT ngắn
  // lọt trong tên người NHẬN của bill hoàn ĐẠI LÝ → định tuyến NHẦM sang phòng NĐT + ghi thành tạm-ứng-NĐT (rò chéo
  // bảo mật + sai sổ tiền). Fuzzy để ALIAS-HỌC lo; không khớp exact → rơi xuống đại-lý-fuzzy hoặc chọn tay (an toàn).
  if (nName) {
    for (const inv of ctx.investors) {
      if (inv.names.some((iv) => normalizeVi(iv) === nName))
        return { entityType: 'INVESTOR', entityId: inv.id, roomId: null, matchBy: 'investor-name' };
    }
  }
  // 4) đại lý fuzzy theo tên nhóm chat (khớp token receiver+content ↔ tên nhóm)
  const hay = normalizeVi(`${name ?? ''} ${content ?? ''}`);
  if (hay) {
    let best: { roomId: string; score: number } | null = null;
    let tie = false;
    for (const g of ctx.dealerGroups) {
      const tokens = normalizeVi(g.name).split(' ').filter((tk) => tk.length >= 2);
      if (tokens.length === 0) continue;
      const score = tokens.filter((tk) => hay.includes(tk)).length / tokens.length;
      if (score >= 0.5) {
        if (!best || score > best.score) { best = { roomId: g.roomId, score }; tie = false; }
        else if (score === best.score) tie = true;
      }
    }
    if (best && !tie) return { entityType: 'DEALER', entityId: null, roomId: best.roomId, matchBy: 'dealer-fuzzy' };
  }
  return null;
}

/** PHÂN-HƯỚNG 1 transfer. */
export function classifyTransfer(t: TransferInput, ctx: ClassifyContext): ClassifyResult {
  const warnings: string[] = [];
  const senderAlpha = isAlpha(t.senderName, ctx.alphaNames);
  const receiverAlpha = isAlpha(t.receiverName, ctx.alphaNames);
  const none: ClassifyResult = { direction: 'UNKNOWN', entityType: null, entityId: null, roomId: null, matchBy: 'none', needsManualPick: true, warnings };

  if (senderAlpha === receiverAlpha) {
    // cả 2 hoặc không bên nào là SigMa → không xác định được hướng
    warnings.push(senderAlpha ? 'Cả người gửi và nhận đều là SigMa — không rõ hướng.' : 'Không bên nào khớp người SigMa đã biết — chọn tay loại bill + đối tác.');
    return none;
  }
  // SigMa ở 1 phía; đối tác = phía CÒN LẠI
  const alphaIsSender = senderAlpha;
  const party = alphaIsSender
    ? matchParty(t.receiverName, t.receiverAccount, t.content, ctx)
    : matchParty(t.senderName, t.senderAccount, t.content, ctx);
  if (!party) { warnings.push('Chưa khớp được đối tác (đại lý/NĐT) — chọn tay + hệ sẽ ghi nhớ.'); return none; }

  let direction: TransferDirection = 'UNKNOWN';
  if (alphaIsSender && party.entityType === 'DEALER') direction = 'SIGMA_TO_DEALER';
  else if (alphaIsSender && party.entityType === 'INVESTOR') direction = 'SIGMA_TO_INVESTOR';
  else if (!alphaIsSender && party.entityType === 'DEALER') direction = 'DEALER_TO_ALPHA';
  else if (!alphaIsSender && party.entityType === 'INVESTOR') direction = 'INVESTOR_TO_ALPHA';

  return { direction, entityType: party.entityType, entityId: party.entityId, roomId: party.roomId, matchBy: party.matchBy, needsManualPick: direction === 'UNKNOWN', warnings };
}

// ── ALIAS-HỌC (append-only JSONL, KHÔNG schema — cấm tái diễn: phân loại tay 1 lần → tự nhận lần sau) ──
export function loadAliases(path: string): AliasEntry[] {
  if (!existsSync(path)) return [];
  const out: AliasEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim(); if (!s) continue;
    try { out.push(JSON.parse(s) as AliasEntry); } catch { /* dòng hỏng bỏ qua */ }
  }
  // dòng SAU ghi đè dòng trước cùng key+kind (append-only + last-wins)
  const map = new Map<string, AliasEntry>();
  for (const e of out) map.set(`${e.kind}|${e.key}`, e);
  return [...map.values()];
}
export function recordAlias(path: string, e: AliasEntry): void {
  appendFileSync(path, JSON.stringify(e) + '\n', 'utf8');
}

// ── SỬA PHÂN LOẠI THEO ẢNH (Admin Demo 4/9 "đã sửa tay thì re-OCR phải trả trạng thái sửa gần nhất") ──
// Alias-học chỉ nhớ ĐỐI TÁC, KHÔNG nhớ HƯỚNG (ứng/hoàn) → OCR lại luôn về mặc định "hoàn tiền". Store này lưu BẢN SỬA
// TAY CUỐI CÙNG (hướng + đối tác) theo HASH ẢNH → augment khôi phục khi OCR lại (mọi phiên/máy). Append-only, last-wins.
export interface TransferCorrection {
  imageHash: string;
  direction: TransferDirection;
  entityType: PartyType | null;
  entityId: number | null;
  roomId: string | null;
  roomName: string | null;
}
export function loadCorrections(path: string): Map<string, TransferCorrection> {
  const map = new Map<string, TransferCorrection>();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim(); if (!s) continue;
    try { const e = JSON.parse(s) as TransferCorrection; if (e.imageHash) map.set(e.imageHash, e); } catch { /* dòng hỏng bỏ qua */ }
  }
  return map; // last-wins (dòng SAU đè dòng trước cùng imageHash)
}
export function recordCorrection(path: string, e: TransferCorrection): void {
  appendFileSync(path, JSON.stringify(e) + '\n', 'utf8');
}
