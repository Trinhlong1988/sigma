// Tìm kiếm TOÀN CỤC cho ô search topbar — LÕI THUẦN ctx-based (CHỈ ĐỌC). PORT từ
// apps/desktop/src/main/global-search-service.ts (Admin Demo 14/7). Thay me()/getDb() (global Electron) bằng ctx =
// { db, user }: actor = ctx.user (adapter đã bảo đảm đăng nhập → KHÔNG cần NOT_AUTHENTICATED). Hàm KHÔNG có
// requirePermission — chỉ trả bản ghi user CÓ QUYỀN xem (hasPermission per-kind), gom nhóm, giới hạn mỗi nhóm.
// Postgres ILIKE không fold Đ↔đ tiếng Việt → dùng lower(unaccent(...)) hai vế qua $queryRaw (tham số hóa ${q} →
// an toàn injection). Thiếu extension unaccent → bọc try/catch báo lỗi mềm (M-3, audit 16/7).
import { hasPermission } from '@sigma/shared';
import type { ServiceCtx } from './customer.js';

export type SearchKind = 'customer' | 'tid' | 'pos' | 'transaction' | 'dossier';

export interface SearchHit {
  kind: SearchKind;
  id: number;
  code: string; // mã/khóa chính hiển thị
  label: string; // tên/tiêu đề
  sub?: string; // dòng phụ
  /** key trang đích để renderer điều hướng (khớp MENU key ở Dashboard). */
  page: string;
}

export interface GlobalSearchResult {
  ok: boolean;
  error?: string;
  message?: string;
  data?: SearchHit[];
}

const PER_KIND = 6;
const MAX_Q = 64;

export async function globalSearch(ctx: ServiceCtx, rawQuery: string): Promise<GlobalSearchResult> {
  const { db, user: actor } = ctx;
  const q = String(rawQuery ?? '').trim().slice(0, MAX_Q);
  if (q.length < 2) return { ok: true, data: [] }; // < 2 ký tự: không phát truy vấn
  const hits: SearchHit[] = [];
  const like = `%${q}%`; // dùng cho cột số (SĐT) — không unaccent

  // M-3 (audit 16/7, agent phản biện) — nếu tiện ích `unaccent` chưa cài (user Postgres thiếu quyền
  // CREATE EXTENSION và extension chưa pre-install), mọi truy vấn lower(unaccent(...)) sẽ ném. Bọc try/catch
  // → báo lỗi mềm {ok:false} thay vì để lỗi DB thô lọt thẳng client.
  try {
    if (hasPermission(actor, 'CUSTOMER_VIEW')) {
      const rows = await db.$queryRaw<{ id: number; code: string | null; full_name: string; phone: string | null }[]>`
        SELECT id, code, full_name, phone FROM customers
        WHERE deleted_at IS NULL AND (
          lower(unaccent(full_name)) LIKE lower(unaccent(${like}))
          OR lower(unaccent(coalesce(code, ''))) LIKE lower(unaccent(${like}))
          OR lower(unaccent(coalesce(nickname, ''))) LIKE lower(unaccent(${like}))
          OR coalesce(phone, '') LIKE ${like}
        ) ORDER BY full_name ASC LIMIT ${PER_KIND}`;
      for (const r of rows) hits.push({ kind: 'customer', id: r.id, code: r.code ?? `#${r.id}`, label: r.full_name, sub: r.phone ?? undefined, page: 'revdebt' });
    }
    if (hasPermission(actor, 'CONFIG_DOSSIER_VIEW')) {
      const rows = await db.$queryRaw<{ id: number; hkd_name: string; owner_name: string; tax_code: string | null }[]>`
        SELECT id, hkd_name, owner_name, tax_code FROM dossiers
        WHERE deleted_at IS NULL AND (
          lower(unaccent(hkd_name)) LIKE lower(unaccent(${like}))
          OR lower(unaccent(owner_name)) LIKE lower(unaccent(${like}))
          OR lower(unaccent(coalesce(tax_code, ''))) LIKE lower(unaccent(${like}))
          OR lower(unaccent(coalesce(cccd_number, ''))) LIKE lower(unaccent(${like}))
        ) ORDER BY hkd_name ASC LIMIT ${PER_KIND}`;
      for (const r of rows) hits.push({ kind: 'dossier', id: r.id, code: r.tax_code ?? `#${r.id}`, label: r.hkd_name, sub: r.owner_name ?? undefined, page: 'dossier' });
    }
    if (hasPermission(actor, 'TID_VIEW')) {
      const rows = await db.$queryRaw<{ id: number; tid: string; mid: string | null; hkd_name: string | null }[]>`
        SELECT id, tid, mid, hkd_name FROM tids
        WHERE deleted_at IS NULL AND (
          lower(unaccent(tid)) LIKE lower(unaccent(${like}))
          OR lower(unaccent(coalesce(mid, ''))) LIKE lower(unaccent(${like}))
          OR lower(unaccent(coalesce(hkd_name, ''))) LIKE lower(unaccent(${like}))
        ) ORDER BY tid ASC LIMIT ${PER_KIND}`;
      for (const r of rows) hits.push({ kind: 'tid', id: r.id, code: r.tid, label: r.hkd_name ?? r.mid ?? r.tid, sub: r.mid ? `MID ${r.mid}` : undefined, page: 'tid' });
    }
    if (hasPermission(actor, 'POS_VIEW')) {
      const rows = await db.$queryRaw<{ id: number; serial: string; status: string }[]>`
        SELECT id, serial, status FROM pos_devices
        WHERE deleted_at IS NULL AND lower(unaccent(serial)) LIKE lower(unaccent(${like}))
        ORDER BY serial ASC LIMIT ${PER_KIND}`;
      for (const r of rows) hits.push({ kind: 'pos', id: r.id, code: r.serial, label: `Máy POS ${r.serial}`, sub: r.status, page: 'pos' });
    }
    if (hasPermission(actor, 'REVENUE_VIEW')) {
      const rows = await db.$queryRaw<{ id: number; code: string | null }[]>`
        SELECT id, code FROM transactions
        WHERE deleted_at IS NULL AND lower(unaccent(coalesce(code, ''))) LIKE lower(unaccent(${like}))
        ORDER BY id DESC LIMIT ${PER_KIND}`;
      for (const r of rows) hits.push({ kind: 'transaction', id: r.id, code: r.code ?? `#${r.id}`, label: `Giao dịch ${r.code ?? '#' + r.id}`, sub: undefined, page: 'revdebt' });
    }
    return { ok: true, data: hits };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: 'SEARCH_FAILED',
      message: /unaccent/i.test(msg)
        ? 'Tìm kiếm tạm thời không khả dụng (máy chủ thiếu tiện ích unaccent — liên hệ quản trị).'
        : 'Tìm kiếm tạm thời không khả dụng.'
    };
  }
}
