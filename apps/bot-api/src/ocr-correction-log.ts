// [Admin Demo 7/9 "cho nó học lỗi in mờ sau mỗi lần sửa xác nhận"] SỔ HỌC LỖI OCR — mỗi lần người sửa xác nhận tham số
// bill (OCR đọc sai: tiền/lô/TID/ngày/giờ), ghi cặp SAI→ĐÚNG (+ ảnh hash) vào sổ append-only. NỀN để: (1) thống kê lỗi
// hay gặp, (2) sau này feed ví dụ few-shot vào OCR (bước 2). CHỈ GHI SỔ — không đụng tiền, best-effort (không chặn sửa).
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const LOG_PATH = process.env.OCR_CORRECTION_LOG || path.join(process.cwd(), 'data', 'ocr-corrections.jsonl');

export interface OcrCorrectionField { field: 'amount' | 'lo' | 'tid' | 'date' | 'time'; old: string | number | null; neu: string | number | null }
export interface OcrCorrectionEntry {
  messageId: string;
  imageHash: string | null;
  tid: string | null;
  actorAgentId: number;
  fields: OcrCorrectionField[];
}

/** Ghi 1 bản sửa vào sổ học lỗi (append-only jsonl). Chỉ ghi khi CÓ field đổi. Best-effort: lỗi ghi → nuốt (không chặn
 *  luồng sửa bill). Trả true nếu đã ghi. */
export function logOcrCorrection(entry: OcrCorrectionEntry): boolean {
  if (!entry.fields.length) return false;
  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n', 'utf8');
    return true;
  } catch {
    return false; // best-effort — không chặn sửa
  }
}

/** So giá trị cũ vs mới của các trường → danh sách field ĐỔI (để ghi sổ). Chuẩn hoá null/rỗng. */
export function diffCorrectionFields(
  oldVals: { amount?: number | null; lo?: string | null; tid?: string | null; date?: string | null; time?: string | null },
  newVals: { amount?: number | null; lo?: string | null; tid?: string | null; date?: string | null; time?: string | null }
): OcrCorrectionField[] {
  const out: OcrCorrectionField[] = [];
  const norm = (v: string | number | null | undefined): string | number | null => (v == null || v === '' ? null : v);
  for (const f of ['amount', 'lo', 'tid', 'date', 'time'] as const) {
    if (newVals[f] === undefined) continue; // field không được sửa → bỏ qua
    const o = norm(oldVals[f]); const n = norm(newVals[f]);
    if (String(o) !== String(n)) out.push({ field: f, old: o, neu: n });
  }
  return out;
}
