// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// TÌM KIẾM KHÔNG PHÂN BIỆT HOA/THƯỜNG — HẠ TẦNG DÙNG CHUNG CHO MỌI MÀN DANH SÁCH
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// ❗ VÌ SAO KHÔNG DÙNG `mode: 'insensitive'` CỦA PRISMA (đọc trước khi "tối ưu" ngược lại) ❗
//
// Database Postgres `sigma` (và bản sao `sigma_thu`) được tạo với collation = "C"
// (`datcollate = 'C'`, `datctype = 'C'` — đo bằng `SELECT datcollate FROM pg_database`).
// Với collation "C", hàm `lower()`/`upper()` của Postgres CHỈ gập được chữ ASCII; MỌI ký tự
// tiếng Việt có dấu (Ễ Ệ Ô Ơ Ư À Đ …) KHÔNG được gập. Toán tử `ILIKE` bên trong chính là
// `lower(vế trái) LIKE lower(vế phải)` nên thừa hưởng nguyên lỗ hổng đó.
//
// Prisma `{ contains: x, mode: 'insensitive' }` sinh ra ĐÚNG `ILIKE` → VÔ DỤNG với tiếng Việt
// trên máy này. SỐ ĐO THẬT (sổ thật `sigma`, bảng `tids`, 13/11/2026):
//
//     hkd_name ILIKE '%nguyễn%'                               →  0 dòng   ❌
//     hkd_name ILIKE '%NGUYỄN%'                               → 10 dòng
//     lower(hkd_name COLLATE "und-x-icu")
//          LIKE lower('%nguyễn%' COLLATE "und-x-icu")         → 10 dòng   ✅
//     lower(hkd_name COLLATE "und-x-icu")
//          LIKE lower('%NGUYỄN%' COLLATE "und-x-icu")         → 10 dòng   ✅
//
// VÀ MỘT BẪY NỮA — `lower()` TRẦN CŨNG KHÔNG ĐỦ (đây là chỗ dễ sửa sai lần hai):
//
//     SELECT lower('NGUYỄN')                                   → 'nguyỄn'  ❌ (Ễ không gập)
//     SELECT lower('NGUYỄN' COLLATE "und-x-icu")               → 'nguyễn'  ✅
//     … WHERE lower(hkd_name) LIKE lower('%nguyễn%')           →  0 dòng   ❌
//
// Tức là `lower(cột) LIKE lower($1)` chỉ "có vẻ chạy" khi người dùng gõ ĐÚNG kiểu hoa như dữ
// liệu; gõ chữ thường tiếng Việt vẫn ra 0. Vì vậy BẮT BUỘC phải ép collation ICU
// (`COLLATE "und-x-icu"`) ở CẢ HAI VẾ — ICU mới gập hoa/thường theo chuẩn Unicode đầy đủ.
//
// KHÔNG đổi collation của database (CẤM), KHÔNG `prisma migrate`, KHÔNG cài thêm extension.
// `und-x-icu` là collation DỰNG SẴN của Postgres (có khi Postgres build kèm ICU — PG16 bản
// Windows đang chạy có sẵn, đã kiểm `SELECT 1 FROM pg_collation WHERE collname='und-x-icu'`).
//
// CÁCH LÀM: khi có từ khoá → chạy 1 truy vấn thô lấy `id` các dòng khớp, rồi trả về mệnh đề
// `{ id: { in: [...] } }` để nhét vào `AND` của `where` Prisma. Toàn bộ phân quyền/bộ lọc khác
// (deletedAt, status, agentId, phân trang…) GIỮ NGUYÊN trong Prisma — hàm này chỉ thay đúng
// phần "chuỗi khớp hoa/thường".
//
// Phạm vi: CHỈ gập hoa/thường. KHÔNG bỏ dấu (gõ "nguyen" vẫn không ra "NGUYỄN") — đúng như
// hành vi cũ, không mở rộng ngầm. (Ô tìm kiếm TOÀN CỤC ở topbar `global-search.ts` là chuyện
// khác: nó cố ý dùng `unaccent` để gợi ý rộng hơn.)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Collation ICU dựng sẵn dùng để gập hoa/thường theo chuẩn Unicode (xem khối chú thích đầu file). */
export const COLLATION_GAP_HOA_THUONG = 'und-x-icu';

/** Khuôn tối thiểu của client DB mà hàm này cần. `Db` của Prisma thỏa khuôn này. */
export interface DbCoRawQuery {
  $queryRawUnsafe?: (sql: string, ...values: unknown[]) => Promise<unknown>;
}

/** Tên bảng/cột do CODE quyết định (không phải input người dùng) — vẫn chặn cứng để không thể nối chuỗi bậy. */
const TEN_DINH_DANH_HOP_LE = /^[a-z_][a-z0-9_]*$/;

/** Ngưỡng cảnh báo: id khớp quá nhiều → `id IN (...)` sẽ nặng. KHÔNG cắt bớt (cắt = sai kết quả âm thầm). */
const NGUONG_CANH_BAO_SO_ID = 20_000;

/** Nhớ kết quả dò collation ICU theo từng client DB (dò 1 lần/tiến trình, không lặp mỗi lần gõ phím). */
const nhoCoICU = new WeakMap<object, Promise<boolean>>();

/** Đã cảnh báo rồi thì thôi — tránh ngập log khi người dùng gõ từng ký tự. */
const daCanhBao = new Set<string>();
function canhBaoMotLan(khoa: string, thongDiep: string): void {
  if (daCanhBao.has(khoa)) return;
  daCanhBao.add(khoa);
  // eslint-disable-next-line no-console
  console.warn(thongDiep);
}

/**
 * Thoát ký tự đại diện của LIKE trong từ khoá NGƯỜI DÙNG GÕ: `%` `_` `\`.
 * Dùng ESCAPE MẶC ĐỊNH của Postgres (dấu `\`) nên KHÔNG cần mệnh đề `ESCAPE`.
 * Không thoát thì gõ `%` sẽ thành "khớp mọi thứ" (sai kết quả), gõ `_` thành "một ký tự bất kỳ".
 */
export function thoatKyTuDaiDien(tuKhoa: string): string {
  return tuKhoa.replace(/([\\%_])/g, '\\$1');
}

/**
 * Dò xem máy chủ Postgres có collation ICU `und-x-icu` không.
 * R198 — KHÔNG nuốt lỗi: dò hỏng/không có → cảnh báo RÕ ra log rồi hạ cấp về `lower()` trần
 * (gập được chữ ASCII, bằng đúng hành vi ILIKE cũ — không tệ hơn hiện trạng, nhưng tiếng Việt
 * sẽ lại phân biệt hoa/thường). Bài kiểm `tim-kiem-khong-phan-biet-hoa-thuong.test.ts` khẳng
 * định mức ICU nên nếu rơi xuống mức này thì bài kiểm ĐỎ, không "xanh giả".
 */
async function coCollationICU(db: DbCoRawQuery): Promise<boolean> {
  const chay = db.$queryRawUnsafe;
  if (typeof chay !== 'function') return false;
  const daNho = nhoCoICU.get(db as object);
  if (daNho) return daNho;
  const p = (async () => {
    try {
      const rows = (await chay.call(db, `SELECT 1 AS co FROM pg_collation WHERE collname = $1 LIMIT 1`, COLLATION_GAP_HOA_THUONG)) as unknown[];
      const co = Array.isArray(rows) && rows.length > 0;
      if (!co)
        canhBaoMotLan(
          'thieu-icu',
          `[tim-kiem] Máy chủ Postgres KHÔNG có collation "${COLLATION_GAP_HOA_THUONG}" → tìm kiếm chỉ gập được hoa/thường chữ ASCII; từ khoá tiếng Việt có dấu sẽ phân biệt hoa/thường. Hãy dùng bản Postgres build kèm ICU.`
        );
      return co;
    } catch (e) {
      canhBaoMotLan('loi-do-icu', `[tim-kiem] KHÔNG dò được collation ICU (tìm kiếm hạ cấp về lower() ASCII): ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  })();
  nhoCoICU.set(db as object, p);
  return p;
}

/**
 * Dựng mệnh đề Prisma lọc theo TỪ KHOÁ, không phân biệt hoa/thường THẬT SỰ (kể cả tiếng Việt có dấu).
 *
 * @param db      client Prisma (hoặc client transaction) — cần `$queryRawUnsafe`.
 * @param bang    TÊN BẢNG trong DB (snake_case, vd `tids`, `customers`).
 * @param cot     map `tên field Prisma` → `tên cột DB`, vd `{ tid: 'tid', hkdName: 'hkd_name' }`.
 *                Dùng cả hai chiều: tên cột DB cho truy vấn thô, tên field Prisma cho đường lui.
 * @param tuKhoaTho từ khoá người dùng gõ (chưa trim).
 *
 * @returns `undefined` khi KHÔNG có từ khoá (gọi xong cứ gán thẳng vào `AND:` — Prisma bỏ qua `undefined`,
 *          hành vi giữ y nguyên như trước). Ngược lại là MỘT MẢNG mệnh đề để đặt vào `AND:` của `where`.
 *
 * Đặt vào `AND` (không phải `OR`/`id` ở gốc) để KHÔNG đè lên `id`/`OR` mà chỗ gọi có thể đã dùng.
 *
 * ĐƯỜNG LUI (chỉ gặp ở unit test dùng Db giả không có `$queryRawUnsafe`): trả lại đúng mệnh đề
 * `OR [{ field: { contains, mode:'insensitive' } }]` như code cũ → test cũ không vỡ, hành vi production
 * không đổi (production luôn có `$queryRawUnsafe`).
 */
export async function dieuKienTimKiem(
  db: DbCoRawQuery,
  bang: string,
  cot: Record<string, string>,
  tuKhoaTho: string | null | undefined
): Promise<Array<Record<string, unknown>> | undefined> {
  const tuKhoa = String(tuKhoaTho ?? '').trim();
  if (tuKhoa === '') return undefined; // KHÔNG có từ khoá → không thêm điều kiện gì (giữ nguyên hành vi cũ)
  const ids = await idKhopTuKhoa(db, bang, cot, tuKhoa);
  // ids rỗng → `{ id: { in: [] } }` = không dòng nào khớp (ĐÚNG), không phải "bỏ qua bộ lọc".
  if (ids !== null) return [{ id: { in: ids } }];
  return [{ OR: menhDeOrCu(cot, tuKhoa) }]; // đường lui (Db giả) — xem docstring
}

/** Đường lui dùng lại ĐÚNG mệnh đề cũ `OR [{ field: { contains, mode:'insensitive' } }]` (chỉ cho Db giả). */
function menhDeOrCu(cot: Record<string, string>, tuKhoa: string): Array<Record<string, unknown>> {
  return Object.keys(cot).map((f) => ({ [f]: { contains: tuKhoa, mode: 'insensitive' as const } }));
}

/**
 * Lấy DANH SÁCH `id` các dòng của `bang` khớp `tuKhoaTho` ở BẤT KỲ cột nào trong `cot`,
 * không phân biệt hoa/thường (kể cả tiếng Việt có dấu — xem khối chú thích đầu file).
 *
 * @returns mảng id (có thể rỗng = không dòng nào khớp), hoặc `null` khi client DB KHÔNG có
 *          `$queryRawUnsafe` (chỉ xảy ra với Db GIẢ trong unit test) để chỗ gọi tự chọn đường lui.
 *
 * Dùng trực tiếp khi chỗ gọi cần chính các id (vd lọc `customerId IN (...)` ở màn TK nhận tiền).
 */
export async function idKhopTuKhoa(
  db: DbCoRawQuery,
  bang: string,
  cot: Record<string, string>,
  tuKhoaTho: string | null | undefined
): Promise<Array<number | string> | null> {
  const tuKhoa = String(tuKhoaTho ?? '').trim();
  if (tuKhoa === '') return [];
  if (Object.keys(cot).length === 0) throw new Error('[tim-kiem] phải khai báo ít nhất 1 cột để tìm');

  const chay = db.$queryRawUnsafe;
  if (typeof chay !== 'function') {
    canhBaoMotLan('khong-co-raw', '[tim-kiem] client DB không có $queryRawUnsafe → dùng lại ILIKE cũ (tiếng Việt sẽ phân biệt hoa/thường). Chỉ chấp nhận được ở Db GIẢ trong unit test.');
    return null;
  }

  if (!TEN_DINH_DANH_HOP_LE.test(bang)) throw new Error(`[tim-kiem] tên bảng không hợp lệ: ${bang}`);
  for (const c of Object.values(cot)) if (!TEN_DINH_DANH_HOP_LE.test(c)) throw new Error(`[tim-kiem] tên cột không hợp lệ: ${c}`);

  const icu = await coCollationICU(db);
  // CẢ HAI VẾ cùng một biểu thức gập — đối xứng tuyệt đối, không có chuyện vế này gập vế kia không.
  const gap = (bieuThuc: string): string => (icu ? `lower(${bieuThuc} COLLATE "${COLLATION_GAP_HOA_THUONG}")` : `lower(${bieuThuc})`);
  const ve = Object.values(cot).map((c) => `${gap(`coalesce("${c}", '')`)} LIKE ${gap('$1::text')}`);
  const sql = `SELECT "id" FROM "${bang}" WHERE (${ve.join(' OR ')})`;
  const mau = `%${thoatKyTuDaiDien(tuKhoa)}%`;

  // R198 — KHÔNG bọc try/catch nuốt lỗi ở đây: truy vấn hỏng (sai tên bảng/cột sau khi đổi schema) PHẢI
  // nổ ra cho adapter trả lỗi, chứ không được âm thầm trả "0 kết quả" (người dùng tưởng là không có dữ liệu).
  const rows = (await chay.call(db, sql, mau)) as Array<{ id: number | string }>;
  const ids = rows.map((r) => r.id);
  if (ids.length > NGUONG_CANH_BAO_SO_ID)
    canhBaoMotLan(`nhieu-id-${bang}`, `[tim-kiem] "${bang}" khớp ${ids.length} dòng cho 1 từ khoá — mệnh đề id IN (...) sẽ nặng. Cân nhắc thêm chỉ mục biểu thức hoặc thu hẹp bộ lọc.`);
  return ids;
}
