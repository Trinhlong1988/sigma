// HỌC "NGÂN HÀNG NGƯỜI GỬI" cho bill CHUYỂN KHOẢN (Admin Demo 2/9) — OCR bill CK chỉ đọc được 1 bank (bên NHẬN),
// KHÔNG đọc được bank người GỬI. Cơ chế: lần đầu gặp, user KHAI BÁO bank người gửi ở review → CACHE theo định
// danh người gửi (STK + tên) → lần sau TỰ NHẬN + điền cột "NH gửi". TÁI DÙNG khuôn alias-HỌC của transfer-classify
// (JSONL append-only, last-wins theo `kind|key`). senderBank CHỈ là NHÃN attribution — KHÔNG đụng tiền/dedup/định
// tuyến. Hàm THUẦN (path tường minh) để unit-test; wrapper dùng SENDER_BANK_ALIAS_PATH cho caller live.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { normalizeVi } from './transfer-classify.js';

/** 1 entry alias bank-người-gửi. key = STK (kind 'acct') HOẶC tên chuẩn hoá (kind 'name'). bank = tên NH (UPPER). */
export interface SenderBankAliasEntry { key: string; kind: 'acct' | 'name'; bank: string; }

// File JSONL RIÊNG (cạnh transfer-alias.jsonl ở apps/zalo-watcher). Env override + fallback ĐỒNG NHẤT TRANSFER_ALIAS_PATH.
export const SENDER_BANK_ALIAS_PATH =
  process.env.SENDER_BANK_ALIAS_PATH || '<REPO>/apps/zalo-watcher/sender-bank-alias.jsonl';

/** Chuẩn hoá STK: bỏ khoảng trắng + dấu * (che số) — khớp exact. */
function normAcct(s: string | null | undefined): string { return (s ?? '').toString().replace(/[\s*]/g, '').trim(); }
/** Chuẩn hoá tên: bỏ dấu + UPPER + gộp space (dùng CHUNG normalizeVi của transfer-classify → khớp mờ đồng nhất). */
function normName(s: string | null | undefined): string { return normalizeVi(s); }
/** Chuẩn hoá tên NH khai báo: trim + UPPER (Admin Demo: input tự do → chuẩn hoá viết hoa). Rỗng → ''. */
export function normBank(s: string | null | undefined): string { return (s ?? '').toString().trim().toUpperCase().replace(/\s+/g, ' '); }

/** Đọc alias (append-only + last-wins theo kind|key). File chưa có → []. Dòng hỏng bỏ qua. Pure (path tường minh). */
export function loadSenderBankAliases(path: string): SenderBankAliasEntry[] {
  if (!existsSync(path)) return [];
  const map = new Map<string, SenderBankAliasEntry>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim(); if (!s) continue;
    try {
      const e = JSON.parse(s) as SenderBankAliasEntry;
      if (e && (e.kind === 'acct' || e.kind === 'name') && e.key && typeof e.bank === 'string') map.set(`${e.kind}|${e.key}`, e);
    } catch { /* dòng hỏng bỏ qua */ }
  }
  return [...map.values()];
}

/** GHI 1 alias (append-only). Pure (path tường minh). */
export function appendSenderBankAlias(path: string, e: SenderBankAliasEntry): void {
  appendFileSync(path, JSON.stringify(e) + '\n', 'utf8');
}

/** GHI alias bank-người-gửi vào `path`: ghi CẢ acct-key (nếu có STK) + name-key (nếu có tên). bank rỗng → bỏ.
 *  last-wins → SỬA ĐƯỢC (khai báo lại đè cũ). Trả ok nếu ghi được ≥1 key + bank hợp lệ. */
export function recordSenderBankAliasAt(path: string, input: { account?: string | null; name?: string | null; bank: string }): { ok: boolean } {
  const bank = normBank(input.bank);
  if (!bank) return { ok: false };
  const acct = normAcct(input.account);
  const nm = normName(input.name);
  if (!acct && !nm) return { ok: false };
  if (acct) appendSenderBankAlias(path, { key: acct, kind: 'acct', bank });
  if (nm) appendSenderBankAlias(path, { key: nm, kind: 'name', bank });
  return { ok: true };
}

/** TRA bank-người-gửi từ `aliases` đã nạp (ưu tiên khớp STK → fallback tên). Miss → null. Pure. */
export function lookupSenderBankIn(aliases: SenderBankAliasEntry[], input: { account?: string | null; name?: string | null }): string | null {
  const acct = normAcct(input.account);
  if (acct) { const a = aliases.find((x) => x.kind === 'acct' && x.key === acct); if (a) return a.bank; }
  const nm = normName(input.name);
  if (nm) { const a = aliases.find((x) => x.kind === 'name' && x.key === nm); if (a) return a.bank; }
  return null;
}

/** TRA bank-người-gửi đọc alias từ `path`. Pure (path tường minh). */
export function lookupSenderBankAt(path: string, input: { account?: string | null; name?: string | null }): string | null {
  return lookupSenderBankIn(loadSenderBankAliases(path), input);
}

// ── WRAPPER LIVE (dùng SENDER_BANK_ALIAS_PATH) — caller endpoint/service gọi ──
export function recordSenderBankAlias(input: { account?: string | null; name?: string | null; bank: string }): { ok: boolean } {
  return recordSenderBankAliasAt(SENDER_BANK_ALIAS_PATH, input);
}
export function lookupSenderBank(input: { account?: string | null; name?: string | null }): string | null {
  return lookupSenderBankAt(SENDER_BANK_ALIAS_PATH, input);
}
