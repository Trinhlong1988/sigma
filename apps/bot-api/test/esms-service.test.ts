// SIGMA "eSMS.vn SMS OTP" (4/8, CMD_BUILD) — unit test esms-service.ts: chuẩn hoá SĐT + sendOtpSms() gọi
// eSMS ĐÚNG SHAPE (mock HTTP qua fetchOverride, KHÔNG gọi mạng thật). Assert GIÁ TRỊ THẬT: body.Phone=84…,
// Content chứa code, ApiKey/SecretKey/Brandname LẤY TỪ ENV, IsUnicode="0", SmsType mặc định "2". Fail-closed
// khi thiếu env. CodeResult != "100" → ném EsmsSendError rõ.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeVnPhoneTo84,
  normalizeVnPhoneToLocal,
  buildOtpSmsContent,
  sendOtpSms,
  EsmsNotConfiguredError,
  EsmsSendError
} from '../src/esms-service.js';

const ENV_KEYS = ['ESMS_API_KEY', 'ESMS_SECRET_KEY', 'ESMS_BRANDNAME', 'ESMS_SMS_TYPE'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ESMS_API_KEY = 'test-api-key';
  process.env.ESMS_SECRET_KEY = 'test-secret-key';
  process.env.ESMS_BRANDNAME = 'SigMa';
  delete process.env.ESMS_SMS_TYPE;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function okFetch(codeResult = '100', smsId = 'SMS123'): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ CodeResult: codeResult, SMSID: smsId }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  ) as unknown as typeof fetch;
}

describe('normalizeVnPhoneTo84 / normalizeVnPhoneToLocal', () => {
  it('chuẩn hoá 3 dạng người dùng gõ (0…/84…/+84…) về CÙNG 84xxxxxxxxx', () => {
    expect(normalizeVnPhoneTo84('0912345678')).toBe('84912345678');
    expect(normalizeVnPhoneTo84('84912345678')).toBe('84912345678');
    expect(normalizeVnPhoneTo84('+84912345678')).toBe('84912345678');
    expect(normalizeVnPhoneTo84('091 234 5678')).toBe('84912345678');
    expect(normalizeVnPhoneTo84('091-234-5678')).toBe('84912345678');
  });

  it('local form luôn ra 0xxxxxxxxx', () => {
    expect(normalizeVnPhoneToLocal('+84987654321')).toBe('0987654321');
    expect(normalizeVnPhoneToLocal('0987654321')).toBe('0987654321');
  });

  it('từ chối SĐT không hợp lệ (quá ngắn/đầu số cố định 2/rác) → null', () => {
    expect(normalizeVnPhoneTo84('12345')).toBeNull();
    expect(normalizeVnPhoneTo84('0212345678')).toBeNull(); // đầu 2 (cố định) không nhận cho OTP
    expect(normalizeVnPhoneTo84('abcxyz')).toBeNull();
    expect(normalizeVnPhoneTo84('')).toBeNull();
    expect(normalizeVnPhoneTo84('091234567')).toBeNull(); // thiếu 1 số
  });
});

describe('buildOtpSmsContent', () => {
  it('chứa mã + thương hiệu + KHÔNG dấu (IsUnicode=0)', () => {
    const content = buildOtpSmsContent('123456', 10);
    expect(content).toContain('123456');
    expect(content).toContain('SigMa');
    expect(content).toContain('10 phut');
    // không dấu tiếng Việt (segment 1 SMS): không có ký tự có dấu.
    expect(content).not.toMatch(/[àáãạảăâêôơưđ]/i);
  });
});

describe('sendOtpSms — gọi eSMS đúng shape', () => {
  it('POST body ĐÚNG shape eSMS: Phone=84…, Content chứa code, ApiKey/SecretKey/Brandname từ env, IsUnicode="0", SmsType mặc định "2"', async () => {
    const fetchMock = okFetch();
    const res = await sendOtpSms('0912345678', '654321', { fetchOverride: fetchMock });
    expect(res.smsId).toBe('SMS123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.Phone).toBe('84912345678');
    expect(body.ApiKey).toBe('test-api-key');
    expect(body.SecretKey).toBe('test-secret-key');
    expect(body.Brandname).toBe('SigMa');
    expect(body.SmsType).toBe('2');
    expect(body.IsUnicode).toBe('0');
    expect(body.Content).toContain('654321');
  });

  it('SmsType đọc từ env ESMS_SMS_TYPE khi có', async () => {
    process.env.ESMS_SMS_TYPE = '8';
    const fetchMock = okFetch();
    await sendOtpSms('0912345678', '111222', { fetchOverride: fetchMock });
    const body = JSON.parse(((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string);
    expect(body.SmsType).toBe('8');
  });

  it('thiếu ESMS_API_KEY → ném EsmsNotConfiguredError, KHÔNG gọi fetch (fail-closed)', async () => {
    delete process.env.ESMS_API_KEY;
    const fetchMock = okFetch();
    await expect(sendOtpSms('0912345678', '000000', { fetchOverride: fetchMock })).rejects.toBeInstanceOf(EsmsNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('thiếu ESMS_SECRET_KEY → ném EsmsNotConfiguredError', async () => {
    delete process.env.ESMS_SECRET_KEY;
    await expect(sendOtpSms('0912345678', '000000', { fetchOverride: okFetch() })).rejects.toBeInstanceOf(EsmsNotConfiguredError);
  });

  it('SmsType "2" (brandname) mà thiếu ESMS_BRANDNAME → fail-closed EsmsNotConfiguredError', async () => {
    delete process.env.ESMS_BRANDNAME;
    await expect(sendOtpSms('0912345678', '000000', { fetchOverride: okFetch() })).rejects.toBeInstanceOf(EsmsNotConfiguredError);
  });

  it('SĐT không hợp lệ → EsmsSendError (không gọi eSMS với số rác)', async () => {
    const fetchMock = okFetch();
    await expect(sendOtpSms('12345', '000000', { fetchOverride: fetchMock })).rejects.toBeInstanceOf(EsmsSendError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('CodeResult != "100" → ném EsmsSendError kèm codeResult (map message rõ, KHÔNG nuốt)', async () => {
    const fetchMock = okFetch('101'); // sai ApiKey/SecretKey
    await expect(sendOtpSms('0912345678', '000000', { fetchOverride: fetchMock })).rejects.toMatchObject({
      name: 'EsmsSendError',
      codeResult: '101'
    });
  });

  it('HTTP != 2xx → EsmsSendError', async () => {
    const fetchMock = vi.fn(async () => new Response('err', { status: 500 })) as unknown as typeof fetch;
    await expect(sendOtpSms('0912345678', '000000', { fetchOverride: fetchMock })).rejects.toBeInstanceOf(EsmsSendError);
  });
});
