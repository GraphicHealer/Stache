import dns from 'node:dns/promises';

// The AI endpoint is fetched server-side - validate it like an SSRF surface.
// LAN/loopback hosts are deliberately allowed (Ollama on the network or on
// localhost is the intended use); link-local/cloud-metadata targets and
// non-http schemes are refused. The URL parser normalizes decimal/hex/octal
// IPv4 and compresses IPv6 literals, so the checks below run on canonical
// forms.

/** Dotted-quad -> int32, or null. */
export function parseV4(h: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

/** IPv6 literal (no brackets) -> 16 bytes, or null. Handles `::` and mixed
 *  `::ffff:a.b.c.d` spellings. */
export function parseV6(h: string): number[] | null {
  let tailV4: number | null = null;
  if (h.includes('.')) {
    tailV4 = parseV4(h.slice(h.lastIndexOf(':') + 1));
    if (tailV4 === null) return null;
    h = h.slice(0, h.lastIndexOf(':')) + ':0:0';
  }
  if (h.split('::').length > 2) return null;
  const [left, right] = h.split('::');
  const l = left ? left.split(':') : [];
  const r = right ? right.split(':') : [];
  if (l.length + r.length > 8 || (right === undefined && l.length !== 8)) return null;
  const groups = [...l, ...Array(8 - l.length - r.length).fill('0'), ...r];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tailV4 !== null) {
    bytes[12] = tailV4 >>> 24;
    bytes[13] = (tailV4 >>> 16) & 0xff;
    bytes[14] = (tailV4 >>> 8) & 0xff;
    bytes[15] = tailV4 & 0xff;
  }
  return bytes;
}

function blockedV4(v4: number): boolean {
  // 169.254.0.0/16 link-local: AWS/GCP/Azure/ECS metadata all live here.
  if (v4 >>> 16 === 0xa9fe) return true;
  // 100.100.100.200 - Alibaba metadata. (Not the whole /10: Tailscale is CGNAT.)
  return v4 === ((100 * 256 + 100) * 256 + 100) * 256 + 200;
}

/** Is a literal IP (v4 dotted quad or [v6]) a refused SSRF target? */
export function badIpLiteral(host: string): boolean {
  const v4 = parseV4(host);
  if (v4 !== null) return blockedV4(v4);
  if (!host.startsWith('[')) return false;
  const bytes = parseV6(host.slice(1, -1));
  if (!bytes) return true; // unparseable literal - refuse rather than guess
  // IPv4-embedded forms (::ffff:x, NAT64 64:ff9b::x) - judge the inner v4.
  const embedded =
    (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) ||
    (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
      bytes.slice(4, 12).every((b) => b === 0));
  if (embedded) {
    return blockedV4(((bytes[12] * 256 + bytes[13]) * 256 + bytes[14]) * 256 + bytes[15]);
  }
  // fe80::/10 IPv6 link-local (AWS v6 metadata is fe80::a9fe:a9fe).
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  // fd00:ec2::/64 - AWS IPv6 metadata prefix.
  if (
    bytes[0] === 0xfd && bytes[1] === 0x00 && bytes[2] === 0x0e && bytes[3] === 0xc2 &&
    bytes.slice(4, 8).every((b) => b === 0)
  ) return true;
  return false;
}

export async function badAiUrl(raw: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'base_url must be a URL like http://ollama:11434/v1';
  }
  if (!['http:', 'https:'].includes(u.protocol)) return 'base_url must be http or https';
  if (!u.hostname) return 'base_url needs a hostname';
  const h = u.hostname.toLowerCase();
  if (h === 'metadata.google.internal' || h.endsWith('.metadata.google.internal'))
    return 'base_url points at a cloud metadata endpoint';
  if (badIpLiteral(h)) return 'base_url points at a link-local/metadata address';
  // A name can still point at a blocked address (nip.io magic domains, a
  // rebind). If it resolves, check every answer; a name that doesn't resolve
  // yet is allowed - the service may simply be down right now.
  if (parseV4(h) === null && !h.startsWith('[')) {
    try {
      for (const a of await dns.lookup(h, { all: true })) {
        if (badIpLiteral(a.family === 4 ? a.address : `[${a.address}]`))
          return 'base_url resolves to a link-local/metadata address';
      }
    } catch {
      /* unresolvable - the fetch will fail cleanly later */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Connect-time check: validating DNS when the URL is saved doesn't stop a
// rebind - the HTTP client resolves again at fetch time, possibly getting a
// different answer. This lookup hook runs the same checks on the *actual*
// address undici is about to connect to. Residual risk: an admin who can set
// base_url can also just... set it to a LAN host, which is allowed by design;
// and TOCTOU exists only between the hook and TCP connect (same answer).
// ---------------------------------------------------------------------------
type LookupFn = (hostname: string, opts: any) => Promise<{ address: string; family: number }>;

/** Returns an undici `connect.lookup` that refuses prohibited resolved IPs. */
export function checkedLookup(lookupFn?: (h: string, o: any) => Promise<any>) {
  const lookup: LookupFn = lookupFn ?? ((h, o) => dns.lookup(h, { ...o, all: false }) as any);
  return (hostname: string, _opts: unknown, cb: (err: Error | null, addr?: string, fam?: number) => void) => {
    lookup(hostname, { all: false })
      .then((r: any) => {
        const addr = Array.isArray(r) ? r[0] : r;
        const a = typeof addr === 'string' ? { address: addr, family: addr.includes(':') ? 6 : 4 } : addr;
        if (badIpLiteral(a.family === 4 ? a.address : `[${a.address}]`))
          cb(new Error('ai endpoint resolves to a prohibited address'));
        else cb(null, a.address, a.family);
      })
      .catch((e) => cb(e instanceof Error ? e : new Error(String(e))));
  };
}
