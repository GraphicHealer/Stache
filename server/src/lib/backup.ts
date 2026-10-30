import AdmZip from 'adm-zip';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sqlite, query } from '../db';
import { env } from '../env';

/**
 * Backup bundle: a ZIP whose root always holds a plaintext manifest.json.
 * The payload (database snapshot + photos) rides as payload.zip, or as
 * payload.enc when encryption is requested - AES-256-GCM with either a
 * passphrase-derived key (scrypt) or a generated raw key.
 */

export interface Manifest {
  format: 'stache-backup';
  format_version: 1;
  app_version: string;
  created_at: string;
  counts: { areas: number; items: number; photos: number };
  encrypted: boolean;
  cipher?: 'aes-256-gcm';
  kdf?: 'scrypt' | 'raw';
  salt?: string;
  iv?: string;
  tag?: string;
  /** Only present when the user opted to store the raw key in the bundle. */
  key?: string;
  restore: {
    steps: string[];
  };
}

async function payloadZip(): Promise<{ buf: Buffer; counts: Manifest['counts'] }> {
  // WAL-safe snapshot of the live DB into a temp file, then into the zip.
  const tmp = path.join(env.dataDir, `backup-${crypto.randomUUID()}.db`);
  await sqlite.backup(tmp);
  try {
    const zip = new AdmZip();
    zip.addFile('stache.db', await fs.readFile(tmp));
    const dir = path.join(env.dataDir, 'photos');
    let nPhotos = 0;
    try {
      for (const f of await fs.readdir(dir)) {
        if (!f.endsWith('.webp')) continue;
        zip.addFile(`photos/${f}`, await fs.readFile(path.join(dir, f)));
        nPhotos++;
      }
    } catch {
      /* empty photos dir */
    }
    const [{ c: nAreas }] = query<{ c: number }>(`SELECT COUNT(*) c FROM areas`);
    const [{ c: nItems }] = query<{ c: number }>(`SELECT COUNT(*) c FROM items WHERE hidden_at IS NULL`);
    return {
      buf: zip.toBuffer(),
      counts: { areas: nAreas, items: nItems, photos: nPhotos },
    };
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

function deriveKey(passphrase: string | null, salt: Buffer | null) {
  if (passphrase) {
    const s = salt ?? crypto.randomBytes(16);
    return { key: crypto.scryptSync(passphrase, s, 32), salt: s, kdf: 'scrypt' as const };
  }
  return { key: crypto.randomBytes(32), salt: null, kdf: 'raw' as const };
}

export interface BuildOptions {
  encrypt?: boolean;
  passphrase?: string | null;
  /** Include the raw key in the manifest (only valid for generated keys). */
  includeKey?: boolean;
}

export async function buildBackup(opts: BuildOptions): Promise<{ buf: Buffer; key: string | null }> {
  const { buf: payload, counts } = await payloadZip();
  const appVersion = process.env.npm_package_version ?? 'dev';

  const manifest: Manifest = {
    format: 'stache-backup',
    format_version: 1,
    app_version: appVersion,
    created_at: new Date().toISOString(),
    counts,
    encrypted: !!opts.encrypt,
    restore: {
      steps: [
        'Upload this file on the Settings > Backup page of a Stache instance.',
        'The server validates the manifest, stages the database and photos,',
        'then restarts; the entrypoint swaps the staged data in before boot.',
      ],
    },
  };

  const out = new AdmZip();
  let keyHex: string | null = null;

  if (!opts.encrypt) {
    out.addFile('payload.zip', payload);
  } else {
    const { key, salt, kdf } = deriveKey(opts.passphrase ?? null, null);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag = cipher.getAuthTag();
    manifest.cipher = 'aes-256-gcm';
    manifest.kdf = kdf;
    manifest.iv = iv.toString('hex');
    manifest.tag = tag.toString('hex');
    if (salt) manifest.salt = salt.toString('hex');
    if (kdf === 'raw') {
      keyHex = key.toString('hex');
      if (opts.includeKey) manifest.key = keyHex;
    }
    out.addFile('payload.enc', enc);
  }

  out.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  return { buf: out.toBuffer(), key: keyHex };
}

export class RestoreError extends Error {}

/** Parses an uploaded bundle → raw payload (db + photos) zip entries. */
export async function unpackBackup(
  bundle: Buffer,
  keyOrPass: string | null,
): Promise<{ manifest: Manifest; db: Buffer; photos: Map<string, Buffer> }> {
  let outer: AdmZip;
  try {
    outer = new AdmZip(bundle);
  } catch {
    throw new RestoreError('not a zip file');
  }
  const manifestEntry = outer.getEntry('manifest.json');
  if (!manifestEntry) throw new RestoreError('no manifest.json in bundle');
  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch {
    throw new RestoreError('manifest.json is not valid JSON');
  }
  if (manifest.format !== 'stache-backup') {
    throw new RestoreError('not a Stache backup');
  }

  let payloadBuf: Buffer;
  const encEntry = outer.getEntry('payload.enc');
  if (encEntry) {
    if (manifest.cipher !== 'aes-256-gcm' || !manifest.iv || !manifest.tag) {
      throw new RestoreError('corrupt encryption metadata in manifest');
    }
    let key: Buffer;
    if (manifest.kdf === 'scrypt') {
      if (!keyOrPass) throw new RestoreError('backup is passphrase-protected - key required');
      if (!manifest.salt) throw new RestoreError('corrupt manifest: missing salt');
      key = crypto.scryptSync(keyOrPass, Buffer.from(manifest.salt, 'hex'), 32);
    } else {
      const hex = keyOrPass ?? manifest.key;
      if (!hex) throw new RestoreError('backup is encrypted - key required');
      if (!/^[0-9a-f]{64}$/i.test(hex)) throw new RestoreError('key must be 64 hex chars');
      key = Buffer.from(hex, 'hex');
    }
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(manifest.iv, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(manifest.tag, 'hex'));
      payloadBuf = Buffer.concat([decipher.update(encEntry.getData()), decipher.final()]);
    } catch {
      throw new RestoreError('decryption failed - wrong key or corrupted payload');
    }
  } else {
    const zipEntry = outer.getEntry('payload.zip');
    if (!zipEntry) throw new RestoreError('no payload in bundle');
    payloadBuf = zipEntry.getData();
  }

  let inner: AdmZip;
  try {
    inner = new AdmZip(payloadBuf);
  } catch {
    throw new RestoreError('payload is not a valid archive');
  }
  const dbEntry = inner.getEntry('stache.db');
  if (!dbEntry) throw new RestoreError('payload has no stache.db');
  const photosMap = new Map<string, Buffer>();
  for (const e of inner.getEntries()) {
    if (e.entryName.startsWith('photos/') && !e.isDirectory) {
      // Sanitize: flat filenames only, no traversal.
      const name = path.basename(e.entryName);
      if (name.endsWith('.webp')) photosMap.set(name, e.getData());
    }
  }
  return { manifest, db: dbEntry.getData(), photos: photosMap };
}
