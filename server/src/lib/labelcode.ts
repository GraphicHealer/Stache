import { randomInt } from 'crypto';

// 31 chars - no 0/1/I/L/O so printed codes can't be misread.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 8;

export const LABEL_CODE_RE = /^ST-[2-9A-HJKM-NP-Z]{8}$/i;

/** ST-XXXXXXXX - ~1e12 space; collisions handled by the UNIQUE constraint. */
export function newLabelCode(): string {
  let s = '';
  for (let i = 0; i < LENGTH; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `ST-${s}`;
}
