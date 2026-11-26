// GUARD thư viện SP bill giải trình (2/10/2026) — chạy trong root vitest (fs-scan thuần, KHÔNG cần
// Electron/Prisma, cùng khuôn money-string-guard.test.ts / server-config-secret-guard.test.ts).
//
// VÌ SAO CÓ FILE NÀY (bug class, không chỉ 1 instance):
//  (1) Bộ seed "199 SP Siêu thị" thực chất là các DÒNG BILL đã sinh bị nhồi làm danh mục: 21 tên trùng
//      chiếm 145 dòng, giá jitter ngẫu nhiên (dầu gội Sunsilk 650g lặp 23 lần, giá 125k–140k), và giá phi lý
//      (rau muống 430.000/kg, hành tây 450.000/kg). Bill giải trình in ra số đó là tự tố.
//  (2) `seedBillExplainLibrary` (V1) có `if (have > 0) continue` ⇒ mở rộng file seed KHÔNG tới máy đã seed.
//      Bản vá là `seedBillExplainLibraryBoSung` (V2) — nhưng V2 ghi vào bảng CÓ dữ liệu người dùng nhập tay,
//      nên luật "chỉ bổ sung, cấm đè, cấm hồi sinh SP đã xoá mềm" phải được CỔNG GIỮ, không chỉ ghi comment.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..');
const SEED = join(ROOT, 'apps', 'desktop', 'build', 'billexplain-seed.json');
const DB_TS = join(ROOT, 'apps', 'desktop', 'src', 'main', 'db.ts');

const norm = (s: string): string => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const DVT = ['Kg', 'Chai', 'Gói', 'Lon', 'Hộp', 'Cái', 'Can', 'Tuýp', 'Túi', 'Bộ', 'Vỉ', 'Thùng', 'Lít', 'Quả', 'Bịch', 'Cuộn', 'Chiếc', 'Đôi', 'Lọ', 'Khay', 'Thanh', 'Viên', 'Bình', 'Bao', 'Cây'];

// Trần giá/Kg theo loại hàng — chặn đúng lớp lỗi "rau muống 430.000/kg". Dùng TỪ ĐẦY ĐỦ CÓ DẤU + biên giới
// chữ: lớp ký tự kiểu `v[ảa]i` từng khớp SAI ("vai" trong "thăn vai bò", "phi lê" khớp nhóm trái cây qua
// `l[êe]`, "Nam Phi" khớp `n[ấa]m`) và trượt ĐÚNG ("sườn" vì "ườ" là 2 ký tự NFC nên `s[ườơ]n` không khớp).
const bien = (tu: string[]): RegExp => new RegExp('(?:^|[^\\p{L}])(?:' + tu.join('|') + ')(?![\\p{L}])', 'iu');
const KG_LOAI: { ten: string; max: number; tu: RegExp }[] = [
  { ten: 'thịt bò/hải sản', max: 600000, tu: bien(['thịt bò', 'bắp bò', 'gầu bò', 'nạm bò', 'lõi rùa', 'thăn bò', 'bò úc', 'bò mỹ', 'cừu', 'tôm', 'cá', 'mực', 'bạch tuộc', 'cua', 'ghẹ', 'nghêu', 'sò', 'ốc', 'hàu', 'ruốc', 'lươn', 'ếch']) },
  { ten: 'thịt heo/gà', max: 250000, tu: bien(['thịt heo', 'nạc heo', 'ba chỉ', 'ba rọi', 'nạc vai', 'nạc dăm', 'cốt lết', 'sườn', 'bắp giò', 'chân giò', 'mỡ phần', 'thịt gà', 'ức gà', 'đùi gà', 'cánh gà', 'gà ta', 'thịt vịt', 'lòng mề', 'thịt xay', 'xương heo', 'thịt nạc']) },
  { ten: 'gạo/ngũ cốc', max: 90000, tu: bien(['gạo', 'nếp', 'tấm', 'đậu xanh', 'đậu đen', 'đậu đỏ', 'đậu nành', 'mè', 'lạc', 'đậu phộng', 'yến mạch', 'bột mì', 'bún', 'phở', 'miến', 'nui', 'hạt sen']) },
  { ten: 'trái cây', max: 200000, tu: bien(['chuối', 'cam', 'quýt', 'bưởi', 'xoài', 'ổi', 'đu đủ', 'thanh long', 'nhãn', 'vải', 'mận', 'đào', 'lê', 'táo', 'nho', 'dưa hấu', 'dưa lưới', 'mãng cầu', 'sầu riêng', 'dừa', 'chôm chôm', 'khế', 'dứa', 'thơm', 'kiwi', 'việt quất', 'dâu tây', 'lựu', 'vú sữa', 'măng cụt', 'bòn bon', 'na', 'hồng xiêm', 'cherry', 'bơ']) },
  { ten: 'rau củ quả', max: 120000, tu: bien(['rau', 'cải', 'muống', 'xà lách', 'hành', 'tỏi', 'gừng', 'khoai', 'bí', 'mướp', 'dưa chuột', 'dưa leo', 'cà chua', 'cà rốt', 'cà tím', 'ớt', 'chanh', 'sả', 'mùng tơi', 'mồng tơi', 'giá đỗ', 'nấm', 'đậu que', 'đậu cove', 'bắp cải', 'súp lơ', 'bầu', 'ngò', 'rau dền', 'hẹ', 'thì là', 'măng', 'bắp', 'ngô', 'su su', 'su hào', 'cần', 'tần ô', 'ngải cứu', 'rau thơm', 'nghệ', 'riềng']) }
];

interface SP { name: string; unit: string; price: number }
const seed = JSON.parse(readFileSync(SEED, 'utf8')) as { industries: string[]; products: Record<string, SP[]> };
const sieuThi = seed.products['Siêu thị'] ?? [];

describe('billexplain-seed.json — thư viện SP sinh bill phải SẠCH', () => {
  it('ngành Siêu thị có >=700 SP (đã mở rộng), ngành Cửa hàng Gas còn nguyên 100', () => {
    expect(sieuThi.length).toBeGreaterThanOrEqual(700);
    expect(seed.products['Cửa hàng Gas']?.length).toBe(100);
    expect(seed.industries).toContain('Siêu thị');
  });

  it('KHÔNG có tên trùng — bộ cũ từng có 21 tên chiếm 145 dòng', () => {
    const dem = new Map<string, number>();
    for (const p of sieuThi) dem.set(norm(p.name), (dem.get(norm(p.name)) ?? 0) + 1);
    const trung = [...dem.entries()].filter(([, n]) => n > 1).map(([k, n]) => k + ' x' + n);
    expect(trung, 'ten trung: ' + trung.slice(0, 10).join(' | ')).toEqual([]);
  });

  it('mọi giá là số nguyên dương, BỘI SỐ 500 — chặn giá jitter ngẫu nhiên kiểu 32.447đ', () => {
    const xau = sieuThi.filter((p) => !Number.isInteger(p.price) || p.price <= 0 || p.price % 500 !== 0);
    expect(xau.map((p) => p.name + '=' + p.price), 'gia khong tron 500').toEqual([]);
  });

  it('mọi ĐVT thuộc danh sách hợp lệ', () => {
    const xau = sieuThi.filter((p) => !DVT.includes(p.unit));
    expect(xau.map((p) => p.name + ' (' + p.unit + ')')).toEqual([]);
  });

  it('SP bán theo Kg: tên phải rõ loại hàng VÀ giá dưới trần loại đó (rau muống 430k/kg = ĐỎ)', () => {
    const loi: string[] = [];
    for (const p of sieuThi) {
      if (p.unit !== 'Kg') continue;
      const l = KG_LOAI.find((x) => x.tu.test(p.name));
      if (!l) loi.push(p.name + ': ban theo Kg ma ten khong khop nhom nao de soi tran gia');
      else if (p.price > l.max) loi.push(p.name + ': ' + p.price + '/Kg vuot tran ' + l.max + ' cua nhom ' + l.ten);
    }
    expect(loi).toEqual([]);
  });

  it('tên chuẩn hoá NFC, bắt đầu bằng chữ HOA, không khoảng trắng thừa', () => {
    const loi = sieuThi.filter((p) => p.name !== p.name.normalize('NFC') || p.name !== p.name.trim() || /\s{2,}/.test(p.name) || !/^\p{Lu}/u.test(p.name));
    expect(loi.map((p) => p.name)).toEqual([]);
  });
});

describe('seed V2 bổ sung — LUẬT GHI phải được code giữ, không chỉ nằm trong comment', () => {
  const src = readFileSync(DB_TS, 'utf8');
  const viTri = src.indexOf('export async function seedBillExplainLibraryBoSung');
  const than = (() => {
    if (viTri < 0) return '';
    const j = src.indexOf('\nexport ', viTri + 10);
    return src.slice(viTri, j === -1 ? src.length : j);
  })();

  it('hàm V2 TỒN TẠI — thiếu nó thì data mới KHÔNG tới máy đã seed V1', () => {
    expect(viTri, 'thieu seedBillExplainLibraryBoSung').toBeGreaterThan(-1);
  });

  it('V2 CHỈ createMany — không update/delete SP (cấm đè dữ liệu người dùng, R202)', () => {
    expect(/db\.product\.(update|updateMany|delete|deleteMany|upsert)/.test(than), 'V2 co lenh ghi de/xoa SP').toBe(false);
    expect(than).toContain('db.product.createMany');
  });

  it('V2 so trùng trên TOÀN BỘ hàng, KHÔNG lọc deletedAt — tránh hồi sinh SP người dùng đã xoá', () => {
    const i = than.indexOf('db.product.findMany');
    expect(i, 'V2 khong doc danh sach SP san co de so trung').toBeGreaterThan(-1);
    const truyVan = than.slice(i, i + 160);
    expect(truyVan).toContain('industryId');
    expect(truyVan, 'V2 loc deletedAt => SP nguoi dung da xoa se bi seed hoi sinh').not.toContain('deletedAt');
  });

  it('V2 được NỐI vào seedIfEmpty bằng cờ RIÊNG V2 (máy đã có cờ V1 vẫn chạy được)', () => {
    expect(src).toContain("const BILLEXPLAIN_LIBRARY_FLAG_V2 = 'seed.billExplainLibraryV2'");
    expect(src).toContain('seedBillExplainLibraryBoSung(db)');
    expect(src).toMatch(/BILLEXPLAIN_LIBRARY_FLAG_V2[\s\S]{0,400}seedBillExplainLibraryBoSung/);
  });

  it('lỗi seed V2 KHÔNG bị nuốt im (R198) — phải log ra được', () => {
    const i = src.indexOf('seedBillExplainLibraryBoSung(db)');
    const sau = src.slice(i, i + 900);
    expect(sau, 'catch rong = loi seed bien mat khong truy duoc').toMatch(/catch\s*\([\s\S]{0,40}\)\s*\{[\s\S]{0,300}console\.error/);
  });
});

describe('ánh xạ tên ngành seed → ngành người dùng (chống đẻ ngành trùng)', () => {
  const src = readFileSync(DB_TS, 'utf8');

  it('có bảng alias khai TƯỜNG MINH, và "siêu thị" trỏ tới "siêu thị - tạp hóa" của người dùng', () => {
    expect(src).toContain('const BILLEXPLAIN_IND_ALIAS');
    const i = src.indexOf('const BILLEXPLAIN_IND_ALIAS');
    const bang = src.slice(i, i + 700);
    expect(bang).toContain("'siêu thị'");
    expect(bang.toLowerCase()).toContain('siêu thị - tạp hóa');
  });

  it('V2 tra ngành qua timNganhTheoAlias, KHÔNG dùng byNorm.get trực tiếp (nguồn lỗi đẻ ngành trùng)', () => {
    const i = src.indexOf('export async function seedBillExplainLibraryBoSung');
    const j = src.indexOf('export async function', i + 10);
    const than = src.slice(i, j === -1 ? src.length : j);
    expect(than).toContain('timNganhTheoAlias(indName, byNorm)');
    expect(/let indId = byNorm\.get\(/.test(than), 'V2 tra nganh truc tiep => se de nganh trung').toBe(false);
  });

  it('KHÔNG so khớp mờ tên ngành (includes/startsWith) — so mờ gán sai âm thầm', () => {
    const i = src.indexOf('function timNganhTheoAlias');
    const than = src.slice(i, i + 500);
    expect(/\.includes\(|\.startsWith\(|\.indexOf\(/.test(than), 'timNganhTheoAlias dung so mo').toBe(false);
  });
});
