import { describe, expect, it } from 'vitest';
import {
  classifyCardType,
  pickDefaultCardTypeId,
  detectCardFromOcr,
  resolveDetectedCardTypeId,
  type CardOption
} from '../src/card-classify.js';

const L = (text: string) => ({ text });

// 3 loại thẻ MB thật (banks.code='MB')
const MB_CARDS: CardOption[] = [
  { id: 15, name: 'MB', klass: classifyCardType('MB') },
  { id: 16, name: 'Ngoài MB-Visa-Master', klass: classifyCardType('Ngoài MB-Visa-Master') },
  { id: 17, name: 'Ngoài MB-Napas', klass: classifyCardType('Ngoài MB-Napas') }
];

describe('classifyCardType', () => {
  it('Visa/Master → INTERNATIONAL', () => {
    expect(classifyCardType('Ngoài MB-Visa-Master')).toBe('INTERNATIONAL');
    expect(classifyCardType('VISA')).toBe('INTERNATIONAL');
    expect(classifyCardType('Thẻ JCB quốc tế')).toBe('INTERNATIONAL');
  });
  it('Napas nội địa → NAPAS', () => {
    expect(classifyCardType('Ngoài MB-Napas')).toBe('NAPAS');
    expect(classifyCardType('Thẻ nội địa Napas')).toBe('NAPAS');
  });
  it('thẻ chính ngân hàng → ONUS', () => {
    expect(classifyCardType('MB')).toBe('ONUS');
  });
});

describe('pickDefaultCardTypeId — mặc định Visa-Master (Admin Demo 21/8)', () => {
  it('ưu tiên INTERNATIONAL', () => {
    expect(pickDefaultCardTypeId(MB_CARDS)).toBe(16); // Ngoài MB-Visa-Master
  });
  it('không có INTERNATIONAL → thẻ đầu', () => {
    expect(pickDefaultCardTypeId([MB_CARDS[0], MB_CARDS[2]])).toBe(15);
  });
  it('rỗng → null', () => {
    expect(pickDefaultCardTypeId([])).toBeNull();
  });
  // [Admin Demo 4/9 "ABB đang JCB mặc định, phải Visa"] Visa/Master ưu tiên HƠN JCB dù cả 2 đều quốc tế.
  it('ABB {JCB, Visa} → chọn VISA (không phải JCB dù JCB đứng trước)', () => {
    const ABB: CardOption[] = [
      { id: 21, name: 'JCB', klass: classifyCardType('JCB') },
      { id: 20, name: 'Visa', klass: classifyCardType('Visa') },
    ];
    expect(pickDefaultCardTypeId(ABB)).toBe(20);           // Visa, KHÔNG phải 21 JCB
    expect(pickDefaultCardTypeId([ABB[0]])).toBe(21);      // chỉ có JCB → JCB (không có Visa)
  });
});

describe('detectCardFromOcr — bill THẬT', () => {
  it('VISA + PAN che chỉ 4 số đầu → INTERNATIONAL qua từ khóa (bin6 null vì <6 số liền)', () => {
    const d = detectCardFromOcr([L('SỐ THẺ: VISA          4030-****-****-1529(C)')]);
    expect(d.scheme).toBe('INTERNATIONAL');
    expect(d.bin6).toBeNull();
  });
  it('MASTERCARD (chỉ từ khóa) → INTERNATIONAL', () => {
    expect(detectCardFromOcr([L('MASTERCARD')]).scheme).toBe('INTERNATIONAL');
  });
  it('BIN 6 số rõ "4786 68** ****" → INTERNATIONAL + bin 478668', () => {
    const d = detectCardFromOcr([L('4786 68** **** 0625 (CHIP)')]);
    expect(d.bin6).toBe('478668');
    expect(d.scheme).toBe('INTERNATIONAL');
  });
  it('AID Visa → INTERNATIONAL', () => {
    expect(detectCardFromOcr([L('AID: A000000031010')]).scheme).toBe('INTERNATIONAL');
  });
  it('Napas BIN 970422 → DOMESTIC', () => {
    const d = detectCardFromOcr([L('970422******1234')]);
    expect(d.scheme).toBe('DOMESTIC');
    expect(d.bin6).toBe('970422');
  });
  it('không có gì → null', () => {
    expect(detectCardFromOcr([L('TID: 53550077'), L('SO TIEN: 10,000,000')])).toEqual({ scheme: null, bin6: null });
  });
});

describe('resolveDetectedCardTypeId — map nhận-diện → loại thẻ', () => {
  it('INTERNATIONAL → thẻ Visa-Master (#16)', () => {
    expect(resolveDetectedCardTypeId(MB_CARDS, 'MB', { scheme: 'INTERNATIONAL', bin6: '478668' })).toBe(16);
  });
  it('DOMESTIC + BIN on-us MB (970422) → thẻ MB (#15)', () => {
    expect(resolveDetectedCardTypeId(MB_CARDS, 'MB', { scheme: 'DOMESTIC', bin6: '970422' })).toBe(15);
  });
  it('DOMESTIC + BIN Napas ngân hàng khác → thẻ Napas (#17)', () => {
    expect(resolveDetectedCardTypeId(MB_CARDS, 'MB', { scheme: 'DOMESTIC', bin6: '970416' })).toBe(17);
  });
  it('không nhận diện → null (dùng mặc định)', () => {
    expect(resolveDetectedCardTypeId(MB_CARDS, 'MB', { scheme: null, bin6: null })).toBeNull();
  });
});
