// Gửi 1 ảnh PNG (đã chuẩn hoá) tới endpoint nội bộ bot-api /internal/zalo-bill-ingest. Dùng fetch/FormData/Blob
// toàn cục (Node 18+). Trả {status, body}. KHÔNG ném cho lỗi HTTP nghiệp vụ — caller quyết định log/bỏ qua.
/** Lấy DANH SÁCH zaloGroupId đang được map trên server (để watcher CHỈ xử ảnh nhóm đã map). Ném khi lỗi (caller
 *  giữ danh sách cũ, không đổi). */
export async function fetchMappedGroups(cfg) {
  const url = cfg.ingestUrl.replace(/\/zalo-bill-ingest$/, '/zalo-mapped-groups');
  const res = await fetch(url, { method: 'GET', headers: { 'x-internal-token': cfg.token } });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.ok || !Array.isArray(body.groupIds)) throw new Error('shape sai');
  return body.groupIds.map((s) => String(s));
}

/** Lấy map {tid: customer_id} để validate TID + attribution doanh số (pipeline 4 bước). Ném khi lỗi. */
export async function fetchTidMap(cfg) {
  const url = cfg.ingestUrl.replace(/\/zalo-bill-ingest$/, '/tid-map');
  const res = await fetch(url, { method: 'GET', headers: { 'x-internal-token': cfg.token } });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.ok || !body.tidMap) throw new Error('shape sai');
  return body.tidMap;
}

/** Lấy DANH SÁCH zaloGroupId của nhóm NĐT (đối soát) đang map — watcher chạy luồng TẠM ỨNG cho các nhóm này. Ném khi lỗi. */
export async function fetchInvestorGroups(cfg) {
  const url = cfg.ingestUrl.replace(/\/zalo-bill-ingest$/, '/investor-groups');
  const res = await fetch(url, { method: 'GET', headers: { 'x-internal-token': cfg.token } });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.ok || !Array.isArray(body.groupIds)) throw new Error('shape sai');
  return body.groupIds.map((s) => String(s));
}

/** POST 1 tạm ứng NĐT (OCR chuyển khoản) → /internal/investor-advance-ingest. Trả {status, body}. */
export async function postAdvance(cfg, payload) {
  const url = cfg.ingestUrl.replace(/\/zalo-bill-ingest$/, '/investor-advance-ingest');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-internal-token': cfg.token, 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

export async function postBillPng(cfg, { pngBuffer, fileName, zaloGroupId }) {
  const url = `${cfg.ingestUrl}?zaloGroupId=${encodeURIComponent(zaloGroupId)}`;
  const form = new FormData();
  form.append('file', new Blob([pngBuffer], { type: 'image/png' }), fileName);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-internal-token': cfg.token },
    body: form
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}
