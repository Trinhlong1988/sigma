// [Admin Demo 8/9 — GATE khóa lỗi "mất cache" double-wrap] Gốc bug: route /statement-recon/{cached,upload} trả
// {ok:true,data:X} TRONG KHI jsonCall client TỰ bọc {ok,data} → client thành {ok,data:{ok,data:{txns}}} →
// r.data.txns = undefined → .length ném lỗi → txns rỗng → màn quay về "Chọn nhiều file" (tưởng mất cache).
// Backend + DB đều PASS khi test trực tiếp (loadCachedReconciled trả 134) → lỗi CHỈ lộ khi đi qua HTTP+client shape.
// Bài học: phải verify ĐÚNG VANTAGE người dùng (qua HTTP theo contract client), không test mảnh DB rồi suy luận.
//
// GATE này hit endpoint LIVE bằng 1 session OWNER thật (lấy từ DB) + khẳng định response ĐÚNG shape client cần:
//   • /cached  → body.txns là MẢNG ở TOP-LEVEL (KHÔNG nested body.data.txns) — không double-wrap.
//   • /upload  → (contract) trả StmtReconResult phẳng (txns/accountHolder/...) — kiểm bằng shape /cached là đủ đại diện.
// Chạy: node --import tsx apps/bot-api/scripts/_gate-statement-recon-shape.mts   (cần bot-api LIVE :8788 + DB sigma)
// Exit 0 = PASS. Exit 1 = FAIL (double-wrap tái diễn / route rỗng / không có session owner).
import pg from 'pg';

const API = process.env.BOT_API_URL || 'http://localhost:8788';
const DB = process.env.DATABASE_URL || 'postgresql://postgres:<DIEN_VAO>@localhost:5432/sigma';

function fail(msg: string): never { console.error('❌ GATE FAIL:', msg); process.exit(1); }

const c = new pg.Client({ connectionString: DB });
await c.connect();
const q = await c.query(
  `SELECT ws.id AS sid FROM web_sessions ws JOIN agents a ON a.id = ws.agent_id
   WHERE a.code IN ('DL22','DL62','DL64') AND (ws.expires_at IS NULL OR ws.expires_at > now())
   ORDER BY ws.created_at DESC LIMIT 1`
);
await c.end();
if (!q.rows[0]) fail('Không tìm thấy session OWNER (DL22/DL62/DL64) còn hạn để test contract.');
const sid = q.rows[0].sid as string;

const res = await fetch(`${API}/v1/statement-recon/cached`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-sigma-client': 'web', cookie: `sigma_ws=${sid}` },
  body: '{}'
});
if (res.status !== 200) fail(`/cached trả HTTP ${res.status} (mong 200 với session owner).`);
const body = (await res.json()) as Record<string, unknown>;

// KHẲNG ĐỊNH CONTRACT (đúng cái client jsonCall mong): txns MẢNG ở TOP-LEVEL, KHÔNG có tầng data.* bọc kép.
if (!Array.isArray((body as { txns?: unknown }).txns)) {
  fail(`/cached KHÔNG có "txns" mảng ở top-level. Keys=${JSON.stringify(Object.keys(body))} — nghi DOUBLE-WRAP tái diễn (route res.json({ok,data}) thay vì res.json(payload)).`);
}
const nested = (body as { data?: { txns?: unknown; ok?: unknown } }).data;
if (nested && (Array.isArray(nested.txns) || nested.ok !== undefined)) {
  fail(`/cached bị DOUBLE-WRAP: có body.data.{txns|ok}. jsonCall client tự bọc {ok,data} → phải trả PAYLOAD PHẲNG.`);
}
console.log(`✅ GATE PASS: /cached trả {txns:[${(body as { txns: unknown[] }).txns.length}]} phẳng (không double-wrap) — client r.data.txns đọc được.`);
process.exit(0);
