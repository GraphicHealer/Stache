import { describe, expect, it } from 'vitest';
import { parseScan } from '../src/scan';

describe('parseScan', () => {
  it('parses a Stache label code', () => {
    expect(parseScan('ST-000123')).toEqual({ kind: 'label', code: 'ST-000123' });
  });

  it('normalizes lowercase labels', () => {
    expect(parseScan('st-000123')).toEqual({ kind: 'label', code: 'ST-000123' });
  });

  it('pads bare numbers into label codes', () => {
    expect(parseScan('123')).toEqual({ kind: 'label', code: 'ST-000123' });
    expect(parseScan('000123')).toEqual({ kind: 'label', code: 'ST-000123' });
  });

  it('extracts the label from a scanned URL', () => {
    expect(parseScan('https://stache.home/l/ST-000042'))
      .toEqual({ kind: 'label', code: 'ST-000042' });
  });

  it('treats long digit strings as product barcodes', () => {
    expect(parseScan('8412345678901')).toEqual({ kind: 'barcode', value: '8412345678901' });
  });

  it('treats free text as a barcode', () => {
    expect(parseScan('ABC123')).toEqual({ kind: 'barcode', value: 'ABC123' });
  });

  it('returns null for empty input', () => {
    expect(parseScan('')).toBeNull();
    expect(parseScan('   ')).toBeNull();
  });
});
