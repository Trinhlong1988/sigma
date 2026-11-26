// [Admin Demo 24-25/9 "máy khác báo MẤT MẠNG khi OCR — fix triệt để"] HÀNG ĐỢI OCR CHẠY NỀN.
//
// GỐC SỰ CỐ (đo thật, không đoán):
//   · Máy CHỦ gọi OCR qua localhost → không giới hạn thời gian → luôn chạy xong.
//   · Máy KHÁC đi qua Cloudflare Tunnel → **Cloudflare cắt kết nối ở ~100 GIÂY** nếu server chưa trả response.
//   · Gemini nhanh (553 lượt: trung vị 3,8s · chậm nhất 30,7s · KHÔNG lượt nào >60s) nên bình thường không sao.
//     NHƯNG khi Gemini hết quota ngày (429) → rơi sang Claude CLI: log có **171 lần `claude -p TIMEOUT 150000ms`**
//     = 171 lượt bill treo >150s ⇒ vượt mốc 100s ⇒ trình duyệt máy khác mất kết nối ⇒ hiện "Lỗi kết nối mạng".
//
// CÁCH FIX TRIỆT ĐỂ: tách đôi — POST /ocr-async TRẢ NGAY `jobId` (<1s, không bao giờ chạm 100s), OCR chạy nền;
// client hỏi kết quả bằng GET /ocr-job/:id (mỗi lượt hỏi trả trong mili-giây). Tunnel không còn gì để cắt.
// Job giữ trong RAM 15 phút rồi tự dọn (kết quả đã nằm trong cache OCR + token ảnh, không mất gì).
export type OcrJobStatus = 'RUNNING' | 'DONE' | 'ERROR';
export interface OcrJob {
  id: string;
  status: OcrJobStatus;
  taoLucMs: number;
  xongLucMs?: number;
  ketQua?: unknown;      // payload y hệt route đồng bộ trả về (client dùng thẳng)
  loi?: { error: string; message: string };
}

const JOB_TTL_MS = 15 * 60 * 1000;
const jobs = new Map<string, OcrJob>();

function donRac(): void {
  const nguong = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) if ((j.xongLucMs ?? j.taoLucMs) < nguong) jobs.delete(id);
}

/** Tạo job + chạy `chay()` ở NỀN. Trả jobId NGAY để route trả về client trong mili-giây. */
export function taoOcrJob(chay: () => Promise<unknown>): string {
  donRac();
  const id = `ocr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const job: OcrJob = { id, status: 'RUNNING', taoLucMs: Date.now() };
  jobs.set(id, job);
  void (async () => {
    try {
      const kq = await chay();
      job.ketQua = kq;
      job.status = 'DONE';
    } catch (e) {
      // R198 — KHÔNG nuốt câm: lỗi nền phải thành trạng thái ERROR có thông điệp cho người dùng.
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[ocr-job] ${id} LỖI:`, msg);
      job.loi = { error: 'OCR_FAILED', message: `OCR thất bại: ${msg}` };
      job.status = 'ERROR';
    } finally {
      job.xongLucMs = Date.now();
    }
  })();
  return id;
}

export function layOcrJob(id: string): OcrJob | null {
  donRac();
  return jobs.get(id) ?? null;
}

/** Số job đang chạy — cho /healthz và chẩn đoán khi Admin Demo hỏi "OCR có treo không". */
export function demOcrJobDangChay(): number {
  let n = 0;
  for (const j of jobs.values()) if (j.status === 'RUNNING') n++;
  return n;
}
