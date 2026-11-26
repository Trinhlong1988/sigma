// Seed (IMS_SPEC §5/§7/§13). Idempotent — an toàn chạy lại.
// R001: chỉ tạo Admin mặc định khi DB CHƯA có Admin. R002: mật khẩu hash bcrypt.
import { createPrisma } from "../src/client.js";
import { PERMISSIONS, ROLES, DEFAULT_ROLE_PERMISSIONS } from "@sigma/shared";
import { hashPassword } from "@sigma/business-rules";

// DEMO white-label: tài khoản quản trị mặc định. Đổi mật khẩu ngay sau lần đăng nhập đầu (production).
const ADMIN_USERNAME = "admin";
const ADMIN_DEFAULT_PASSWORD = "admin123";

async function main() {
  const prisma = createPrisma();

  // 1) Permissions (20) — §13
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: p.code },
      update: { name: p.name, group: p.group },
      create: { code: p.code, name: p.name, group: p.group },
    });
  }

  // 2) Roles (9) — §7
  for (const r of ROLES) {
    await prisma.role.upsert({
      where: { code: r.code },
      update: { name: r.name, description: r.description, isSystem: r.isSystem },
      create: { name: r.name, code: r.code, description: r.description, isSystem: r.isSystem, status: "ACTIVE" },
    });
  }

  // 3) role_permissions từ ma trận mặc định — §7/§12/§13
  for (const [roleCode, permCodes] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const role = await prisma.role.findUnique({ where: { code: roleCode } });
    if (!role) continue;
    for (const code of permCodes) {
      const perm = await prisma.permission.findUnique({ where: { code } });
      if (!perm) continue;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
  }

  // 3b) code_counters — HIGH-E (G10.C): pre-tạo sẵn dòng đếm cho MỌI prefix đang dùng
  //   • NV = mã nhân viên (user-service + backfillEmployeeCodes)
  //   • KH = mã khách hàng (customer-service)
  // Loại race "insert-đầu 2 client → P2002" khi nhiều client nối chung 1 DB (Postgres/G10).
  // lastValue=0 → nextCode() đầu tiên increment lên 1 → NV01 / KH01 (khớp formatCode ≥2 chữ số).
  // upsert update:{} → IDEMPOTENT: KHÔNG bao giờ reset counter đã tồn tại.
  const CODE_COUNTER_PREFIXES = ["NV", "KH"] as const;
  for (const prefix of CODE_COUNTER_PREFIXES) {
    await prisma.codeCounter.upsert({
      where: { prefix },
      update: {},
      create: { prefix, lastValue: 0 },
    });
  }

  // 4) Admin mặc định — R001 (chỉ khi CHƯA có Admin nào), R002 (hash), R003 (force change)
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: "ADMIN" } });
  const existingAdmin = await prisma.user.findFirst({
    where: { deletedAt: null, roles: { some: { roleId: adminRole.id } } },
  });

  if (!existingAdmin) {
    const admin = await prisma.user.create({
      data: {
        fullName: "Quản trị hệ thống",
        username: ADMIN_USERNAME,
        passwordHash: hashPassword(ADMIN_DEFAULT_PASSWORD),
        status: "ACTIVE",
        forceChangePassword: false,
        roles: { create: { roleId: adminRole.id } },
      },
    });
    console.log(`[seed] Created default admin '${admin.username}' / '${ADMIN_DEFAULT_PASSWORD}' (DEMO — đổi ngay ở production).`);
  } else {
    console.log(`[seed] Admin already exists (id=${existingAdmin.id}) — R001 skip create.`);
  }

  // 5) Danh mục MẪU DEMO (white-label) — tối thiểu để đăng nhập xong có thứ để xem/thử.
  //    KHÔNG seed khách/TID/bill thật. Idempotent (upsert theo khóa unique / findFirst guard).
  //    Banks: name + code(unique) + seq(unique, hiển thị NH01/NH02).
  const DEMO_BANKS = [
    { seq: 1, name: "Demo Bank A", code: "DBA" },
    { seq: 2, name: "Demo Bank B", code: "DBB" },
  ];
  for (const b of DEMO_BANKS) {
    await prisma.bank.upsert({
      where: { code: b.code },
      update: { name: b.name },
      create: { seq: b.seq, name: b.name, code: b.code, status: "ACTIVE" },
    });
  }

  // CardType: không có unique DB (bảng có deletedAt) → findFirst-or-create để idempotent.
  const bankA = await prisma.bank.findUnique({ where: { code: "DBA" } });
  if (bankA) {
    for (const c of [{ name: "Visa", code: "VISA" }, { name: "Napas", code: "NAPAS" }]) {
      const existing = await prisma.cardType.findFirst({ where: { bankId: bankA.id, code: c.code, deletedAt: null } });
      if (!existing) await prisma.cardType.create({ data: { bankId: bankA.id, name: c.name, code: c.code } });
    }
  }

  // FeeType: name @unique → upsert theo name.
  for (const name of ["Đối ứng", "Tiền chờ"]) {
    await prisma.feeType.upsert({ where: { name }, update: {}, create: { name } });
  }

  const counts = {
    permissions: await prisma.permission.count(),
    roles: await prisma.role.count(),
    rolePermissions: await prisma.rolePermission.count(),
    users: await prisma.user.count(),
  };
  console.log("[seed] Done:", counts);
}

main().catch((e) => {
  console.error("[seed] FAILED:", e);
  process.exit(1);
});
