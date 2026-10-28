import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// textsearch imports the db module, which opens SQLite at import time -
// point it at a throwaway dir first.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'stache-test-'));

let ts: typeof import('../src/lib/textsearch');

beforeAll(async () => {
  ts = await import('../src/lib/textsearch');
});

describe('trigramSim / wordSim', () => {
  it('scores identical strings at 1', () => {
    expect(ts.trigramSim('drill', 'drill')).toBe(1);
  });
  it('scores unrelated strings near 0', () => {
    expect(ts.trigramSim('drill', 'banana')).toBeLessThan(0.2);
  });
  it('finds the query inside a longer text', () => {
    expect(ts.wordSim('drill', 'bosch cordless drill 18v')).toBeGreaterThan(0.3);
  });
});

describe('levenshtein / soundex', () => {
  it('computes small distances', () => {
    expect(ts.levenshtein('drill', 'dril')).toBe(1);
    expect(ts.levenshtein('drill', 'drill')).toBe(0);
  });
  it('caps distance past the limit', () => {
    expect(ts.levenshtein('aaaaaaaa', 'bbbbbbbb', 2)).toBeGreaterThan(2);
  });
  it('soundex groups homophones', () => {
    expect(ts.soundex('Robert')).toBe(ts.soundex('Rupert'));
  });
});

describe('fuzzyItemScore', () => {
  it('matches an exact name', () => {
    const r = ts.fuzzyItemScore('drill', 'Bosch drill', null, null);
    expect(r.matched).toBe(true);
    expect(r.score).toBeGreaterThan(0.5);
  });

  it('matches a typo via levenshtein', () => {
    expect(ts.fuzzyItemScore('drrill', 'drill', null, null).matched).toBe(true);
  });

  it('matches multi-word queries per-token (regression: whole query vs each word)', () => {
    // "dril bts" - both tokens are typos of words in the name.
    const r = ts.fuzzyItemScore('dril bts', 'drill bits', null, null);
    expect(r.matched).toBe(true);
  });

  it('matches barcode exactly, case-sensitive field', () => {
    const r = ts.fuzzyItemScore('8412345', 'thing', null, '8412345');
    expect(r.matched).toBe(true);
    expect(r.score).toBe(1);
  });

  it('matches AI text at lower rank than user text', () => {
    const ai = ts.fuzzyItemScore('sprocket', 'wrench', null, null, 'sprocket set');
    const user = ts.fuzzyItemScore('sprocket', 'sprocket set', null, null, '');
    expect(ai.matched).toBe(true);
    expect(user.score).toBeGreaterThan(ai.score);
  });

  it('does not match unrelated items', () => {
    expect(ts.fuzzyItemScore('lawnmower', 'Bosch drill', null, null).matched).toBe(false);
  });
});

describe('ftsQuery', () => {
  it('ANDs prefix terms', () => {
    expect(ts.ftsQuery('drill bits')).toBe('"drill"* AND "bits"*');
  });
  it('escapes quotes', () => {
    expect(ts.ftsQuery('a"b')).toBe('"a""b"*');
  });
});
