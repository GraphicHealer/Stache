import { describe, expect, it } from 'vitest';
import { parseScan } from '../src/scan';

describe('parseScan', () => {
  it('parses a Stache label code', () => {
    expect(parseScan('ST-K7QX9M2T')).toEqual({ kind: 'label', code: 'ST-K7QX9M2T' });
  });

  it('normalizes lowercase labels', () => {
    expect(parseScan('st-k7qx9m2t')).toEqual({ kind: 'label', code: 'ST-K7QX9M2T' });
  });

  it('rejects codes with ambiguous characters', () => {
    expect(parseScan('ST-K7QX9M2O')).toEqual({ kind: 'barcode', value: 'ST-K7QX9M2O' });
    expect(parseScan('ST-00000001')).toEqual({ kind: 'barcode', value: 'ST-00000001' });
  });

  it('extracts the label from a scanned URL', () => {
    expect(parseScan('https://stache.home/l/ST-K7QX9M2T'))
      .toEqual({ kind: 'label', code: 'ST-K7QX9M2T' });
  });

  it('treats digit strings as product barcodes', () => {
    expect(parseScan('8412345678901')).toEqual({ kind: 'barcode', value: '8412345678901' });
    expect(parseScan('123')).toEqual({ kind: 'barcode', value: '123' });
  });

  it('treats free text as a barcode', () => {
    expect(parseScan('ABC123')).toEqual({ kind: 'barcode', value: 'ABC123' });
  });

  it('returns null for empty input', () => {
    expect(parseScan('')).toBeNull();
    expect(parseScan('   ')).toBeNull();
  });
});
