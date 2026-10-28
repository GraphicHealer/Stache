import crypto from 'node:crypto';
import { authSecret } from '../auth';

/**
 * HMAC-signed photo URLs for contexts that can't carry a session cookie -
 * ntfy/Discord image previews, Home Assistant cards. The signature covers the
 * exact path plus an expiry, so it can't be repurposed for other files.
 */

const DAY_MS = 86_400_000;

export function signPhotoUrl(urlPath: string, expiresInMs = 7 * DAY_MS): string {
  const exp = Date.now() + expiresInMs;
  const sig = crypto
    .createHmac('sha256', authSecret())
    .update(`${urlPath}:${exp}`)
    .digest('base64url');
  return `${urlPath}?exp=${exp}&sig=${sig}`;
}

export function verifyPhotoSig(urlPath: string, exp: string | undefined, sig: string | undefined): boolean {
  if (!exp || !sig) return false;
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  const expected = crypto
    .createHmac('sha256', authSecret())
    .update(`${urlPath}:${exp}`)
    .digest();
  const provided = Buffer.from(sig, 'base64url');
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}
