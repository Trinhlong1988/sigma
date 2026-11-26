// SIGMA "Hồ sơ cá nhân" (1/8) — test services/profile-service.ts trên DB throwaway (global-setup.ts).
// Phủ: happy path GET/PATCH, validation từng field, partial update (field vắng mặt giữ nguyên), đổi email
// (validate định dạng, kiểm trùng loại trừ chính mình, race P2002).
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import {
  applyEmailChange,
  getMyProfile,
  isEmailTakenByOtherAgent,
  updateMyProfile,
  validateNewEmailFormat
} from '../src/services/profile-service.js';
import { makeAgent } from './fixtures.js';

describe('profile-service — Hồ sơ cá nhân (1/8)', () => {
  it('getMyProfile: agent không tồn tại → AGENT_NOT_FOUND', async () => {
    const db = getBotDb();
    const r = await getMyProfile(db, 999999999);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('AGENT_NOT_FOUND');
  });

  it('getMyProfile: trả đúng name/email/gender/dateOfBirth (ISO date-only)/phone', async () => {
    const db = getBotDb();
    const a = await makeAgent(undefined, {
      name: 'Nguyễn Văn A',
      email: `profile_get_${Date.now()}@example.com`,
      phone: '0901234567',
      dateOfBirth: new Date('1995-03-20')
    });
    await db.agent.update({ where: { id: a.id }, data: { gender: 'MALE' } });

    const r = await getMyProfile(db, a.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.name).toBe('Nguyễn Văn A');
    expect(r.data.gender).toBe('MALE');
    expect(r.data.dateOfBirth).toBe('1995-03-20');
    expect(r.data.phone).toBe('0901234567');
  });

  it('getMyProfile: gender/dateOfBirth/phone chưa khai → null (KHÔNG throw)', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const r = await getMyProfile(db, a.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.gender).toBeNull();
    expect(r.data.dateOfBirth).toBeNull();
    expect(r.data.phone).toBeNull();
  });

  it('updateMyProfile: name rỗng/chỉ khoảng trắng → VALIDATION', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const r1 = await updateMyProfile(db, a.id, { name: '' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe('VALIDATION');
    const r2 = await updateMyProfile(db, a.id, { name: '   ' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe('VALIDATION');
  });

  it('updateMyProfile: gender ngoài MALE/FEMALE/OTHER → VALIDATION', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const r = await updateMyProfile(db, a.id, { gender: 'UNKNOWN' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('VALIDATION');
  });

  it('updateMyProfile: dateOfBirth không parse được → VALIDATION', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const r = await updateMyProfile(db, a.id, { dateOfBirth: 'khong-phai-ngay' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('VALIDATION');
  });

  it('updateMyProfile: dateOfBirth ở tương lai → VALIDATION', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const r = await updateMyProfile(db, a.id, { dateOfBirth: future });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('VALIDATION');
  });

  it('updateMyProfile: dateOfBirth năm vô lý (9999 / trước 1900) → VALIDATION', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const r9999 = await updateMyProfile(db, a.id, { dateOfBirth: '9999-01-01' });
    expect(r9999.ok).toBe(false);
    if (!r9999.ok) expect(r9999.error).toBe('VALIDATION');
    const rOld = await updateMyProfile(db, a.id, { dateOfBirth: '1800-01-01' });
    expect(rOld.ok).toBe(false);
    if (!rOld.ok) expect(rOld.error).toBe('VALIDATION');
  });

  it('updateMyProfile: agent không tồn tại → AGENT_NOT_FOUND', async () => {
    const db = getBotDb();
    const r = await updateMyProfile(db, 999999999, { name: 'X' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('AGENT_NOT_FOUND');
  });

  it('updateMyProfile: happy path đổi cả 3 field, GET phản ánh đúng', async () => {
    const db = getBotDb();
    const a = await makeAgent(undefined, { name: 'Tên Cũ' });
    const r = await updateMyProfile(db, a.id, { name: '  Tên Mới  ', gender: 'female', dateOfBirth: '1990-01-15' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.name).toBe('Tên Mới'); // trim
    expect(r.data.gender).toBe('FEMALE'); // uppercase-normalized
    expect(r.data.dateOfBirth).toBe('1990-01-15');

    const check = await getMyProfile(db, a.id);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.data.name).toBe('Tên Mới');
      expect(check.data.gender).toBe('FEMALE');
      expect(check.data.dateOfBirth).toBe('1990-01-15');
    }
  });

  it('updateMyProfile: partial update — CHỈ đổi field có mặt, field vắng mặt giữ nguyên', async () => {
    const db = getBotDb();
    const a = await makeAgent(undefined, { name: 'Giữ Nguyên', dateOfBirth: new Date('1988-06-06') });
    await db.agent.update({ where: { id: a.id }, data: { gender: 'OTHER' } });

    const r = await updateMyProfile(db, a.id, { name: 'Đổi Tên Thôi' }); // KHÔNG gửi gender/dateOfBirth
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.name).toBe('Đổi Tên Thôi');
    expect(r.data.gender).toBe('OTHER'); // giữ nguyên
    expect(r.data.dateOfBirth).toBe('1988-06-06'); // giữ nguyên
  });

  it('validateNewEmailFormat: rỗng/sai định dạng → ok:false', () => {
    expect(validateNewEmailFormat('').ok).toBe(false);
    expect(validateNewEmailFormat('khong-hop-le').ok).toBe(false);
    expect(validateNewEmailFormat('a@b').ok).toBe(false);
  });

  it('validateNewEmailFormat: hợp lệ → trim + lowercase', () => {
    const r = validateNewEmailFormat('  MoiTest@Example.com  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.email).toBe('moitest@example.com');
  });

  it('isEmailTakenByOtherAgent: đã thuộc agent KHÁC → true; loại trừ CHÍNH MÌNH → false; chưa ai dùng → false', async () => {
    const db = getBotDb();
    const email = `taken_${Date.now()}@example.com`;
    const owner = await makeAgent(undefined, { email });
    const other = await makeAgent();

    expect(await isEmailTakenByOtherAgent(db, other.id, email)).toBe(true);
    expect(await isEmailTakenByOtherAgent(db, owner.id, email)).toBe(false); // chính mình, không tính là "trùng"
    expect(await isEmailTakenByOtherAgent(db, other.id, `chuatung_${Date.now()}@example.com`)).toBe(false);
  });

  it('applyEmailChange: happy path ghi thật email mới', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const newEmail = `applied_${Date.now()}@example.com`;
    const r = await applyEmailChange(db, a.id, newEmail);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.email).toBe(newEmail);

    const check = await db.agent.findUnique({ where: { id: a.id } });
    expect(check?.email).toBe(newEmail);
  });

  it('applyEmailChange: email đã bị agent khác chiếm (race P2002) → EMAIL_ALREADY_REGISTERED, KHÔNG throw 500', async () => {
    const db = getBotDb();
    const takenEmail = `raced_${Date.now()}@example.com`;
    await makeAgent(undefined, { email: takenEmail });
    const challenger = await makeAgent();

    const r = await applyEmailChange(db, challenger.id, takenEmail);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('EMAIL_ALREADY_REGISTERED');
  });
});
