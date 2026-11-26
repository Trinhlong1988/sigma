// R34 — Duyệt hủy (xóa qua duyệt) TID/POS/Khách/Nhân sự — self-test (SIGMA_SELFTEST=34).
// Số thật, real service, DB throwaway. Phủ: request tạo yêu cầu · chống trùng PENDING · phân vai
// (warehouse/manager/admin, self-forbidden, need-elevated) · mật khẩu người duyệt (Q2) · guard POS-đang-gắn-TID
// · guard User self-delete · approve → soft-delete thật · reject → giữ nguyên.
import { login, logout } from './auth-service.js';
import { getDb } from './db.js';
import * as userSvc from './user-service.js';
import { requestEntityCancel, approveEntityCancel, rejectEntityCancel, listEntityCancelRequests } from './entity-cancel-service.js';

let pass = 0,
  fail = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) pass++;
  else fail++;
  // eslint-disable-next-line no-console
  console.log(`ENTITYCANCEL34 ${cond ? 'PASS' : 'FAIL'} | ${name}` + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
}
const ADMIN_PW = 'Admin@123456';
const PW = 'User@123456';

export async function runEntityCancelSelfTest(): Promise<number> {
  const db = getDb();
  await login('adminroot', ADMIN_PW);

  // ═══ SETUP ═══
  const bank = await db.bank.create({ data: { name: 'NH Hủy', code: 'CXBANK' } });
  const partner = await db.partner.create({ data: { name: 'Đối tác Hủy', code: 'CXP' } });
  const cust = await db.customer.create({ data: { code: 'KHCX', fullName: 'Khách Hủy', nickname: 'KCX' } });
  const cust2 = await db.customer.create({ data: { code: 'KHCX2', fullName: 'Khách Hủy 2', nickname: 'KCX2' } });
  const tid = await db.tid.create({ data: { tid: 'TIDCX', hkdName: 'HKD Hủy', bankId: bank.id, partnerId: partner.id } });
  const posClean = await db.posDevice.create({ data: { serial: 'POSCLEAN', status: 'IN_STOCK', bankId: bank.id } });
  const posWithTid = await db.posDevice.create({ data: { serial: 'POSBUSY', status: 'DEPLOYED', bankId: bank.id, currentTid: 'TIDCX' } });

  const wh = await userSvc.createUser({ fullName: 'Kho Vận', username: 'whouse01', password: PW, roleCodes: ['WAREHOUSE'] });
  const mgr = await userSvc.createUser({ fullName: 'Quản Lý', username: 'mgrcx001', password: PW, roleCodes: ['MANAGER'] });
  const mgr2 = await userSvc.createUser({ fullName: 'Quản Lý 2', username: 'mgrcx002', password: PW, roleCodes: ['MANAGER'] });
  const victim = await userSvc.createUser({ fullName: 'Nhân Viên Bị Xóa', username: 'victim01', password: PW, roleCodes: ['ACCOUNTANT'] });
  ok('tạo user (wh/mgr/mgr2/victim)', !!(wh as { id?: number }).id && !!(mgr as { id?: number }).id && !!(mgr2 as { id?: number }).id && !!(victim as { id?: number }).id);
  const victimId = (victim as { id: number }).id;

  // ═══ 1) TID — warehouse REQUEST (không có APPROVE) → manager duyệt (không cần elevated) ═══
  await logout();
  await login('whouse01', PW);
  const reqNoReason = await requestEntityCancel('Tid', tid.id, '  ');
  ok('request thiếu lý do → VALIDATION', reqNoReason.ok === false && reqNoReason.error === 'VALIDATION', reqNoReason);
  const reqTid = await requestEntityCancel('Tid', tid.id, 'TID nhập sai, cần hủy');
  ok('warehouse tạo yêu cầu hủy TID → ok', reqTid.ok === true, reqTid);
  const dupTid = await requestEntityCancel('Tid', tid.id, 'lần 2');
  ok('yêu cầu trùng khi đang PENDING → ALREADY_PENDING', dupTid.ok === false && dupTid.error === 'ALREADY_PENDING', dupTid);
  const tidStillThere = await db.tid.findUnique({ where: { id: tid.id } });
  ok('TID CHƯA bị xóa khi mới tạo yêu cầu', tidStillThere?.deletedAt == null);

  // ═══ 2) POS đang gắn TID → precheck DEVICE_HAS_TID ═══
  const reqPosBusy = await requestEntityCancel('PosDevice', posWithTid.id, 'thử hủy máy đang gắn TID');
  ok('hủy POS đang gắn TID → DEVICE_HAS_TID', reqPosBusy.ok === false && reqPosBusy.error === 'DEVICE_HAS_TID', reqPosBusy);
  const reqPosClean = await requestEntityCancel('PosDevice', posClean.id, 'máy hỏng thanh lý khỏi hệ thống');
  ok('warehouse tạo yêu cầu hủy POS sạch → ok', reqPosClean.ok === true, reqPosClean);

  // ═══ 3) Manager DUYỆT (mật khẩu Q2) — sai mật khẩu chặn, tự duyệt của người khác thì được ═══
  await logout();
  await login('mgrcx001', PW);
  const badPw = await approveEntityCancel('Tid', reqTid.id!, 'SAI_MAT_KHAU');
  ok('duyệt sai mật khẩu → WRONG_PASSWORD', badPw.ok === false && badPw.error === 'WRONG_PASSWORD', badPw);
  const tidAfterBadPw = await db.tid.findUnique({ where: { id: tid.id } });
  ok('sai mật khẩu KHÔNG xóa TID', tidAfterBadPw?.deletedAt == null);
  const apprTid = await approveEntityCancel('Tid', reqTid.id!, PW, 'duyệt hủy TID');
  ok('manager duyệt đúng mật khẩu → ok', apprTid.ok === true, apprTid);
  const tidDeleted = await db.tid.findUnique({ where: { id: tid.id } });
  ok('TID đã bị XÓA MỀM sau duyệt', tidDeleted?.deletedAt != null && tidDeleted?.deletedBy != null, { deletedAt: !!tidDeleted?.deletedAt });
  const apprPos = await approveEntityCancel('PosDevice', reqPosClean.id!, PW);
  ok('manager duyệt hủy POS → ok', apprPos.ok === true, apprPos);
  const posDeleted = await db.posDevice.findUnique({ where: { id: posClean.id } });
  ok('POS đã bị XÓA MỀM sau duyệt', posDeleted?.deletedAt != null);

  // ═══ 4) Customer — manager tạo yêu cầu (có APPROVE) → manager2 NEED_ELEVATED → admin duyệt ═══
  const reqCust = await requestEntityCancel('Customer', cust.id, 'khách trùng, gộp hồ sơ');
  ok('manager tạo yêu cầu hủy khách → ok', reqCust.ok === true, reqCust);
  await logout();
  await login('mgrcx002', PW);
  const needElev = await approveEntityCancel('Customer', reqCust.id!, PW);
  ok('manager khác duyệt yêu cầu do manager tạo → NEED_ELEVATED', needElev.ok === false && needElev.error === 'NEED_ELEVATED', needElev);
  await logout();
  await login('adminroot', ADMIN_PW);
  const adminApprCust = await approveEntityCancel('Customer', reqCust.id!, ADMIN_PW, 'admin duyệt');
  ok('admin (elevated) duyệt hủy khách → ok', adminApprCust.ok === true, adminApprCust);
  const custDeleted = await db.customer.findUnique({ where: { id: cust.id } });
  ok('khách hàng đã bị XÓA MỀM sau duyệt', custDeleted?.deletedAt != null);

  // ═══ 5) Self-approve bị chặn (manager tự duyệt yêu cầu của chính mình) ═══
  await logout();
  await login('mgrcx001', PW);
  const reqCust2 = await requestEntityCancel('Customer', cust2.id, 'khách 2 cần hủy');
  ok('manager tạo yêu cầu hủy khách 2 → ok', reqCust2.ok === true, reqCust2);
  const selfAppr = await approveEntityCancel('Customer', reqCust2.id!, PW);
  ok('tự duyệt yêu cầu của chính mình → SELF_APPROVAL_FORBIDDEN', selfAppr.ok === false && selfAppr.error === 'SELF_APPROVAL_FORBIDDEN', selfAppr);
  // admin TỪ CHỐI → khách 2 KHÔNG bị xóa, yêu cầu REJECTED.
  await logout();
  await login('adminroot', ADMIN_PW);
  const rejCust2 = await rejectEntityCancel('Customer', reqCust2.id!, 'khách vẫn dùng, không hủy');
  ok('admin từ chối yêu cầu → ok', rejCust2.ok === true, rejCust2);
  const cust2Alive = await db.customer.findUnique({ where: { id: cust2.id } });
  ok('khách 2 KHÔNG bị xóa sau từ chối', cust2Alive?.deletedAt == null);

  // ═══ 6) User — self-delete chặn; manager tạo yêu cầu xóa victim → admin duyệt → DELETED ═══
  await logout();
  await login('mgrcx001', PW);
  const selfDel = await requestEntityCancel('User', (mgr as { id: number }).id, 'tự xóa mình');
  ok('tạo yêu cầu tự xóa mình → SELF_DELETE', selfDel.ok === false && selfDel.error === 'SELF_DELETE', selfDel);
  const reqUser = await requestEntityCancel('User', victimId, 'nhân viên nghỉ việc');
  ok('manager tạo yêu cầu hủy nhân sự → ok', reqUser.ok === true, reqUser);
  await logout();
  await login('adminroot', ADMIN_PW);
  const apprUser = await approveEntityCancel('User', reqUser.id!, ADMIN_PW);
  ok('admin duyệt hủy nhân sự → ok', apprUser.ok === true, apprUser);
  const victimRow = await db.user.findUnique({ where: { id: victimId } });
  ok('nhân sự đã bị xóa (status DELETED + deletedAt)', victimRow?.status === 'DELETED' && victimRow?.deletedAt != null, { status: victimRow?.status });

  // ═══ 7) listEntityCancelRequests: admin thấy PENDING còn lại (đã xử lý hết → rỗng) ═══
  const inbox = await listEntityCancelRequests('PENDING');
  ok('inbox PENDING trả ok (đã xử lý hết)', inbox.ok === true && (inbox.data ?? []).length === 0, { n: inbox.data?.length });

  // ═══ 8) BACKSTOP TƯƠNG TRANH (audit đợt 4): partial-unique 1 yêu cầu CANCEL PENDING / (loại,id) ═══
  const idx = await db.$queryRawUnsafe<{ indexname: string }[]>(
    `SELECT indexname FROM pg_indexes WHERE tablename='approval_requests' AND indexname='approval_requests_pending_cancel_uq'`
  );
  ok('tồn tại partial-unique index approval_requests_pending_cancel_uq', Array.isArray(idx) && idx.length === 1, idx);

  // ═══ 9) BULK yêu cầu hủy (Nhóm 1) — lặp requestEntityCancel cho nhiều id (mô phỏng nút "Yêu cầu hủy (n)"):
  //       mỗi id 1 yêu cầu PENDING, KHÔNG xóa cứng — đúng luồng Duyệt Hủy R34. ═══
  const p1 = await db.posDevice.create({ data: { serial: 'POSBULK1', status: 'IN_STOCK', bankId: bank.id } });
  const p2 = await db.posDevice.create({ data: { serial: 'POSBULK2', status: 'IN_STOCK', bankId: bank.id } });
  let bulkOk = 0;
  for (const id of [p1.id, p2.id]) {
    const r = await requestEntityCancel('PosDevice', id, 'bulk hủy máy tồn');
    if (r.ok) bulkOk++;
  }
  ok('bulk: 2 yêu cầu hủy POS tạo được (lặp từng id)', bulkOk === 2, { bulkOk });
  const pend = await db.approvalRequest.count({ where: { entityType: 'PosDevice', action: 'CANCEL', status: 'PENDING', entityId: { in: [p1.id, p2.id] } } });
  ok('bulk: đúng 2 yêu cầu PENDING (đi qua duyệt, chưa xóa)', pend === 2, { pend });
  const p1Alive = await db.posDevice.findUnique({ where: { id: p1.id } });
  const p2Alive = await db.posDevice.findUnique({ where: { id: p2.id } });
  ok('bulk: 2 máy CHƯA bị xóa (không xóa cứng, chờ duyệt)', p1Alive?.deletedAt == null && p2Alive?.deletedAt == null);

  // ═══ P1-08 (PING invariant #7): CHẶN hủy khách/TID còn QUAN HỆ SỐNG (chống mồ côi tham chiếu) ═══
  await logout();
  await login('adminroot', ADMIN_PW);
  const custHold = await db.customer.create({ data: { code: 'KHHOLD', fullName: 'Khách Giữ Máy', nickname: 'KH' } });
  const posHeld = await db.posDevice.create({ data: { serial: 'POSHELD', status: 'DEPLOYED', bankId: bank.id, currentCustomerId: custHold.id } });
  const reqHold = await requestEntityCancel('Customer', custHold.id, 'thử hủy khách đang giữ máy');
  ok('P1-08: hủy khách đang giữ máy POS → IN_USE (chống mồ côi)', reqHold.ok === false && reqHold.error === 'IN_USE', reqHold);
  await db.posDevice.update({ where: { id: posHeld.id }, data: { currentCustomerId: null, status: 'IN_STOCK' } });
  const reqHold2 = await requestEntityCancel('Customer', custHold.id, 'khách đã trả máy');
  ok('P1-08: khách đã trả máy → tạo yêu cầu hủy được', reqHold2.ok === true, reqHold2);
  // TID còn gắn máy (posSerial) → chặn.
  const tidOn = await db.tid.create({ data: { tid: 'TIDON', hkdName: 'HKD On', bankId: bank.id, partnerId: partner.id, status: 'ACTIVE', posSerial: 'POSHELD' } });
  const reqTidOn = await requestEntityCancel('Tid', tidOn.id, 'thử hủy TID đang gắn máy');
  ok('P1-08: hủy TID đang gắn máy POS → IN_USE', reqTidOn.ok === false && reqTidOn.error === 'IN_USE', reqTidOn);
  // TID còn cọc OPEN → chặn.
  const tidDep = await db.tid.create({ data: { tid: 'TIDDEP', hkdName: 'HKD Dep', bankId: bank.id, partnerId: partner.id, status: 'ACTIVE' } });
  await db.deviceDeposit.create({ data: { customerId: custHold.id, tid: 'TIDDEP', amount: 500_000n, status: 'OPEN', occurredAt: new Date('2026-07-01T00:00:00.000Z') } });
  const reqTidDep = await requestEntityCancel('Tid', tidDep.id, 'thử hủy TID còn cọc');
  ok('P1-08: hủy TID còn cọc OPEN → IN_USE', reqTidDep.ok === false && reqTidDep.error === 'IN_USE', reqTidDep);

  // ═══ P1-08b: RE-GUARD lúc DUYỆT — khách SẠCH lúc tạo yêu cầu, nhận máy TRƯỚC khi duyệt → duyệt chặn IN_USE ═══
  const custRace = await db.customer.create({ data: { code: 'KHRACE', fullName: 'Khách Race', nickname: 'KR' } });
  await logout();
  await login('mgrcx001', PW);
  const reqRace = await requestEntityCancel('Customer', custRace.id, 'hủy khách sạch');
  ok('P1-08b: tạo yêu cầu hủy khách sạch ok', reqRace.ok === true, reqRace);
  await db.posDevice.update({ where: { id: posHeld.id }, data: { currentCustomerId: custRace.id, status: 'DEPLOYED' } }); // nhận máy sau khi tạo yêu cầu
  await logout();
  await login('adminroot', ADMIN_PW);
  const apprRace = await approveEntityCancel('Customer', reqRace.id!, ADMIN_PW);
  ok('P1-08b: duyệt hủy khách vừa nhận máy → IN_USE (re-guard trong tx)', apprRace.ok === false && apprRace.error === 'IN_USE', apprRace);
  const custRaceRow = await db.customer.findUnique({ where: { id: custRace.id } });
  ok('P1-08b: khách KHÔNG bị xóa (re-guard rollback)', custRaceRow?.deletedAt == null, { del: custRaceRow?.deletedAt });

  // ═══ BUG-1 (audit cụm DUYỆT HỦY): Customer applyCancel re-guard PHẢI phủ ĐỦ 5 quan hệ ═══
  //     Trước vá chỉ kiểm 3/5 (máy/TID-đã-giao/cọc) → THIẾU phiếu xuất PENDING + nợ device-sale → TOCTOU:
  //     khách SẠCH lúc tạo yêu cầu → phát sinh PHIẾU XUẤT KHO PENDING trong lúc chờ → duyệt PHẢI chặn IN_USE.
  await logout();
  await login('mgrcx001', PW);
  const custExp = await db.customer.create({ data: { code: 'KHEXP', fullName: 'Khách Export', nickname: 'KE' } });
  const reqExp = await requestEntityCancel('Customer', custExp.id, 'hủy khách sạch (export phát sinh sau)');
  ok('BUG-1: tạo yêu cầu hủy khách sạch ok', reqExp.ok === true, reqExp);
  await db.exportRequest.create({
    data: { code: 'YCXKB1', kind: 'POS', handoverKind: 'SALE', requesterUserId: (mgr as { id: number }).id, customerId: custExp.id, unitPrice: 1_000_000n, quantity: 1, amount: 1_000_000n, status: 'PENDING' }
  });
  await logout();
  await login('adminroot', ADMIN_PW);
  const apprExp = await approveEntityCancel('Customer', reqExp.id!, ADMIN_PW);
  ok('BUG-1: duyệt hủy khách có phiếu xuất PENDING → IN_USE (re-guard đủ 5 quan hệ)', apprExp.ok === false && apprExp.error === 'IN_USE', apprExp);
  const custExpRow = await db.customer.findUnique({ where: { id: custExp.id } });
  ok('BUG-1: khách KHÔNG bị xóa (re-guard rollback)', custExpRow?.deletedAt == null, { del: custExpRow?.deletedAt });

  // ═══ BUG-4: Duyệt hủy máy POS PHẢI chặn DEPLOYED / đang giữ khách / cọc OPEN theo serial ═══
  const custPos = await db.customer.create({ data: { code: 'KHPOS4', fullName: 'Khách POS4', nickname: 'KP4' } });
  const posDeployed = await db.posDevice.create({ data: { serial: 'POSDEP4', status: 'DEPLOYED', bankId: bank.id, currentCustomerId: custPos.id } });
  const reqDep = await requestEntityCancel('PosDevice', posDeployed.id, 'thử hủy máy đang giao khách');
  ok('BUG-4: hủy máy POS DEPLOYED/giữ khách → IN_USE', reqDep.ok === false && reqDep.error === 'IN_USE', reqDep);
  const posDepo = await db.posDevice.create({ data: { serial: 'POSDEPO4', status: 'IN_STOCK', bankId: bank.id } });
  await db.deviceDeposit.create({ data: { customerId: custPos.id, deviceSerial: 'POSDEPO4', amount: 300_000n, status: 'OPEN', occurredAt: new Date('2026-07-01T00:00:00.000Z') } });
  const reqDepo = await requestEntityCancel('PosDevice', posDepo.id, 'thử hủy máy còn cọc');
  ok('BUG-4: hủy máy POS còn cọc OPEN (theo serial) → IN_USE', reqDepo.ok === false && reqDepo.error === 'IN_USE', reqDepo);
  // re-guard lúc DUYỆT: máy SẠCH lúc tạo yêu cầu → thành DEPLOYED trước khi duyệt → duyệt chặn IN_USE.
  const posRace4 = await db.posDevice.create({ data: { serial: 'POSRACE4', status: 'IN_STOCK', bankId: bank.id } });
  await logout();
  await login('mgrcx001', PW);
  const reqRace4 = await requestEntityCancel('PosDevice', posRace4.id, 'hủy máy sạch');
  ok('BUG-4: tạo yêu cầu hủy máy sạch ok', reqRace4.ok === true, reqRace4);
  await db.posDevice.update({ where: { id: posRace4.id }, data: { status: 'DEPLOYED', currentCustomerId: custPos.id } });
  await logout();
  await login('adminroot', ADMIN_PW);
  const apprRace4 = await approveEntityCancel('PosDevice', reqRace4.id!, ADMIN_PW);
  ok('BUG-4: duyệt hủy máy vừa DEPLOYED → IN_USE (re-guard trong tx)', apprRace4.ok === false && apprRace4.error === 'IN_USE', apprRace4);
  const posRace4Row = await db.posDevice.findUnique({ where: { id: posRace4.id } });
  ok('BUG-4: máy KHÔNG bị xóa (re-guard rollback)', posRace4Row?.deletedAt == null, { del: posRace4Row?.deletedAt });

  // ═══ BUG-2 (bằng chứng CODE CHẾT): guard "TID nằm trong export PENDING" ở precheck Tid KHÔNG BAO GIỜ khớp —
  //     exportRequestLine CHỈ tạo lúc DUYỆT (status→APPROVED) → mọi phiếu PENDING luôn có 0 dòng → pendReq≡0. ═══
  await db.exportRequest.create({
    data: { code: 'YCXKB2', kind: 'TID', handoverKind: 'SALE', requesterUserId: (mgr as { id: number }).id, customerId: custPos.id, bankId: bank.id, partnerId: partner.id, unitPrice: 500_000n, quantity: 2, amount: 1_000_000n, status: 'PENDING' }
  });
  const pendExpIds = (await db.exportRequest.findMany({ where: { status: 'PENDING' }, select: { id: true } })).map((r) => r.id);
  const pendLines = pendExpIds.length ? await db.exportRequestLine.count({ where: { exportRequestId: { in: pendExpIds } } }) : 0;
  ok('BUG-2: 0 dòng ExportRequestLine cho MỌI phiếu PENDING (guard TID-export = code chết)', pendLines === 0, { pendExp: pendExpIds.length, pendLines });

  await logout();
  // eslint-disable-next-line no-console
  console.log(`ENTITYCANCEL34 SUMMARY | pass=${pass} fail=${fail}`);
  return fail === 0 ? 0 : 1;
}
