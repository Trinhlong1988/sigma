// Test LÕI THUẦN đính kèm ảnh (setDossierAttachment/getDossierAttachment + setRcvAccountAttachment/
// getRcvAccountAttachment) — Db GIẢ in-memory + ServiceCtx = { db, user } + kho file TMP (SIGMA_FILE_STORE).
// ASSERT: quyền, validate field, ghi kho + lưu path/tên vào DB, đọc lại đúng bytes/mime, thay ảnh trash bản cũ.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  setDossierAttachment, getDossierAttachment,
  setRcvAccountAttachment, getRcvAccountAttachment,
  fileSizeInStore, type ServiceCtx
} from '../src/index.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

const DOSSIER_VIEW = 'CONFIG_DOSSIER_VIEW';
const DOSSIER_MANAGE = 'CONFIG_DOSSIER_MANAGE';
const RCV_VIEW = 'CONFIG_RCV_ACCT_VIEW';
const RCV_MANAGE = 'CONFIG_RCV_ACCT_MANAGE';

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

interface Row { id: number; deletedAt: Date | null; [k: string]: unknown }
function makeTable(seed: Row[]) {
  const rows = seed.map((r) => ({ ...r }));
  return {
    rows,
    findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r.id === where.id) ?? null,
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = rows.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; }
  };
}
function baseFake() {
  const audits: Record<string, unknown>[] = [];
  const fake: Record<string, unknown> = {
    user: { findMany: async () => [{ id: 42, fullName: 'Người Kiểm Thử', username: 'tester' }] },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) }
  };
  return { fake, audits };
}
const ctx = (fake: Record<string, unknown>, perms: string[]): ServiceCtx => ({ db: fake as unknown as Db, user: authUser(perms) });

function dossierRow(id: number): Row {
  return { id, sourceId: 1, hkdName: 'Quán A', ownerName: 'Chủ A', mstStatus: 'ACTIVE', deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date(), dkkdFrontPath: null, dkkdFrontName: null, dkkdBackPath: null, dkkdBackName: null, cccdFrontPath: null, cccdFrontName: null, cccdBackPath: null, cccdBackName: null } as Row;
}
function rcvRow(id: number): Row {
  return { id, sourceId: 1, accountName: 'Chủ TK', accountNumber: '0123', bankId: 1, deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date(), cccdFrontPath: null, cccdFrontName: null, cccdBackPath: null, cccdBackName: null } as Row;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'alpha-attach-'));
  process.env['SIGMA_FILE_STORE'] = root;
});
afterEach(() => {
  delete process.env['SIGMA_FILE_STORE'];
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('dossier attachment core', () => {
  it('thiếu quyền MANAGE → FORBIDDEN', async () => {
    const { fake } = baseFake();
    fake.dossier = makeTable([dossierRow(1)]);
    const r = await setDossierAttachment(ctx(fake, [DOSSIER_VIEW]), 1, 'dkkdFront', { buffer: PNG });
    expect(r.error).toBe('FORBIDDEN');
  });

  it('field không hợp lệ → VALIDATION', async () => {
    const { fake } = baseFake();
    fake.dossier = makeTable([dossierRow(1)]);
    const r = await setDossierAttachment(ctx(fake, [DOSSIER_MANAGE]), 1, 'avatar', { buffer: PNG });
    expect(r.error).toBe('VALIDATION');
  });

  it('nội dung không phải ảnh/PDF → BAD_CONTENT', async () => {
    const { fake } = baseFake();
    fake.dossier = makeTable([dossierRow(1)]);
    const r = await setDossierAttachment(ctx(fake, [DOSSIER_MANAGE]), 1, 'dkkdFront', { buffer: EXE });
    expect(r.error).toBe('BAD_CONTENT');
  });

  it('hồ sơ không tồn tại → NOT_FOUND', async () => {
    const { fake } = baseFake();
    fake.dossier = makeTable([]);
    const r = await setDossierAttachment(ctx(fake, [DOSSIER_MANAGE]), 99, 'dkkdFront', { buffer: PNG });
    expect(r.error).toBe('NOT_FOUND');
  });

  it('upload hợp lệ → ghi kho + lưu path/tên vào DB + audit; tải lại đúng bytes/mime', async () => {
    const { fake, audits } = baseFake();
    const t = makeTable([dossierRow(1)]);
    fake.dossier = t;
    const set = await setDossierAttachment(ctx(fake, [DOSSIER_MANAGE]), 1, 'dkkdFront', { buffer: PNG, originalName: 'dkkd-mt.png' });
    expect(set.ok).toBe(true);
    const row = t.rows[0]!;
    expect(typeof row.dkkdFrontPath).toBe('string');
    expect((row.dkkdFrontPath as string).startsWith('dossiers/1/')).toBe(true);
    expect(row.dkkdFrontName).toBe('dkkd-mt.png');
    expect(audits.some((a) => a['action'] === 'DOSSIER_ATTACHMENT_SET')).toBe(true);

    const get = await getDossierAttachment(ctx(fake, [DOSSIER_VIEW]), 1, 'dkkdFront');
    expect(get.ok).toBe(true);
    expect(get.mime).toBe('image/png');
    expect(Buffer.compare(get.buffer!, PNG)).toBe(0);
    expect(get.fileName).toBe('dkkd-mt.png');
  });

  it('thay ảnh cùng mặt → bản cũ bị trash (không còn ở vị trí gốc), path mới khác', async () => {
    const { fake } = baseFake();
    const t = makeTable([dossierRow(1)]);
    fake.dossier = t;
    await setDossierAttachment(ctx(fake, [DOSSIER_MANAGE]), 1, 'dkkdFront', { buffer: PNG });
    const oldPath = t.rows[0]!.dkkdFrontPath as string;
    await setDossierAttachment(ctx(fake, [DOSSIER_MANAGE]), 1, 'dkkdFront', { buffer: JPG });
    const newPath = t.rows[0]!.dkkdFrontPath as string;
    expect(newPath).not.toBe(oldPath);
    expect(fileSizeInStore(oldPath)).toBe(0); // bản cũ đã rời vị trí gốc (vào _trash)
    expect(fileSizeInStore(newPath)).toBe(JPG.length);
  });

  it('get khi chưa có ảnh → NOT_FOUND "chưa có ảnh này"', async () => {
    const { fake } = baseFake();
    fake.dossier = makeTable([dossierRow(1)]);
    const r = await getDossierAttachment(ctx(fake, [DOSSIER_VIEW]), 1, 'cccdBack');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('NOT_FOUND');
  });
});

describe('receive-account attachment core', () => {
  it('upload + tải lại CCCD mặt trước hợp lệ', async () => {
    const { fake, audits } = baseFake();
    const t = makeTable([rcvRow(1)]);
    fake.receiveAccount = t;
    const set = await setRcvAccountAttachment(ctx(fake, [RCV_MANAGE]), 1, 'cccdFront', { buffer: JPG, originalName: 'cccd.jpg' });
    expect(set.ok).toBe(true);
    expect((t.rows[0]!.cccdFrontPath as string).startsWith('receive-accounts/1/')).toBe(true);
    expect(audits.some((a) => a['action'] === 'RCV_ACCT_ATTACHMENT_SET')).toBe(true);

    const get = await getRcvAccountAttachment(ctx(fake, [RCV_VIEW]), 1, 'cccdFront');
    expect(get.ok).toBe(true);
    expect(get.mime).toBe('image/jpeg');
    expect(Buffer.compare(get.buffer!, JPG)).toBe(0);
  });

  it('field cccd không hợp lệ → VALIDATION', async () => {
    const { fake } = baseFake();
    fake.receiveAccount = makeTable([rcvRow(1)]);
    const r = await setRcvAccountAttachment(ctx(fake, [RCV_MANAGE]), 1, 'dkkdFront', { buffer: JPG });
    expect(r.error).toBe('VALIDATION');
  });

  it('thiếu quyền VIEW khi tải → FORBIDDEN', async () => {
    const { fake } = baseFake();
    fake.receiveAccount = makeTable([rcvRow(1)]);
    const r = await getRcvAccountAttachment(ctx(fake, []), 1, 'cccdFront');
    expect(r.error).toBe('FORBIDDEN');
  });
});
