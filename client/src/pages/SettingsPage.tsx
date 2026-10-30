import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';

const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});

/** Minimal CSV parse - quoted fields, escaped quotes, CRLF all handled. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [''];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur[cur.length - 1] += '"';
          i++;
        } else inQ = false;
      } else cur[cur.length - 1] += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') cur.push('');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      rows.push(cur);
      cur = [''];
    } else cur[cur.length - 1] += ch;
  }
  if (cur.length > 1 || cur[0] !== '') rows.push(cur);
  return rows;
}

const HEADER_ALIASES: Record<string, string> = {
  description: 'note',
  desc: 'note',
  area: 'area_name',
  location: 'area_name',
  label: 'area_label',
};

/** JSON (array or {items:[…]}) or CSV with a header row → import rows. */
function parseImportFile(text: string, filename: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (filename.endsWith('.json') || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const j = JSON.parse(trimmed);
    const rows = Array.isArray(j) ? j : j.items;
    if (!Array.isArray(rows)) throw new Error('JSON must be an array or { items: […] }');
    return rows;
  }
  const lines = parseCsv(text);
  if (lines.length < 2) throw new Error('CSV needs a header row plus data rows');
  const headers = lines[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? h.trim().toLowerCase());
  return lines
    .slice(1)
    .filter((r) => r.some((c) => c.trim()))
    .map((cols) => {
      const row: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        const v = cols[i]?.trim();
        if (!v) return;
        if (h === 'tags') row.tags = v.split(';').map((t) => t.trim()).filter(Boolean);
        else if (h === 'private') row.private = /^(1|true|yes)$/i.test(v);
        else row[h] = v;
      });
      return row;
    });
}

/** AI provider settings + MCP connections - any OpenAI-compatible endpoint. */
export function SettingsPage() {
  const { toast, user, signOut } = useApp();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings-ai'], queryFn: () => api.get('/api/settings/ai') });
  const { data: mcp } = useQuery({ queryKey: ['settings-mcp'], queryFn: () => api.get('/api/settings/mcp') });
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/api/users') });
  const { data: digest } = useQuery({ queryKey: ['settings-digest'], queryFn: () => api.get('/api/settings/digest') });
  const [form, setForm] = useState({ provider: 'off', base_url: '', model: '', api_key: '' });
  const [dg, setDg] = useState({ enabled: false, webhook_url: '', time: '09:00', base_url: '' });
  const [dgLoaded, setDgLoaded] = useState(false);
  const [connName, setConnName] = useState('');
  const [connScope, setConnScope] = useState<'read' | 'read-write'>('read-write');
  const [backupOpts, setBackupOpts] = useState({ encrypt: false, passphrase: '', includeKey: false });
  const [backupKey, setBackupKey] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [importRows, setImportRows] = useState<Record<string, unknown>[] | null>(null);
  const [importPreview, setImportPreview] = useState<any>(null);
  const [maint, setMaint] = useState<any>(null);
  const [member, setMember] = useState({ name: '', email: '', password: '' });
  const [pw, setPw] = useState({ current: '', next: '' });
  // New MCP tokens are shown exactly once - the server only stores a hash.
  const [newToken, setNewToken] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    if (data && !loaded) {
      setForm({
        provider: !data.enabled ? 'off' : data.provider ?? 'remote',
        base_url: data.base_url,
        model: data.model,
        api_key: '',
      });
      setLoaded(true);
    }
    if (digest && !dgLoaded) {
      setDg({
        enabled: digest.enabled,
        webhook_url: digest.webhook_url,
        time: digest.time,
        base_url: digest.base_url,
      });
      setDgLoaded(true);
    }
  }, [data, loaded, digest, dgLoaded]);

  const save = async () => {
    try {
      const body: Record<string, unknown> = {
        enabled: form.provider !== 'off',
        provider: form.provider === 'local' ? 'local' : 'remote',
        base_url: form.base_url,
        model: form.model,
      };
      if (form.api_key) body.api_key = form.api_key;
      await api.put('/api/settings/ai', body);
      qc.invalidateQueries({ queryKey: ['settings-ai'] });
      toast('AI settings saved');
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="page">
      <h1>Settings</h1>
      <h2>Household</h2>
      <p className="muted">
        Signed in as <b>{user?.name}</b> ({user?.email}). Items are shared with the
        household unless marked private on the item.
      </p>
      {(users?.users ?? []).map((u: any) => (
        <div key={u.id} className="row">
          <span>
            {u.name} <span className="muted">{u.email}</span>
            {u.role === 'admin' && <span className="badge warn">admin</span>}
          </span>
          {isAdmin && u.id !== user?.id && u.role !== 'admin' && (
            <button
              className="btn btn-small btn-ghost"
              onClick={async () => {
                if (!window.confirm(`Remove ${u.name}? Their private items become invisible to everyone.`)) return;
                await api.del(`/api/users/${u.id}`).catch((e) => (toast(e.message), null));
                qc.invalidateQueries({ queryKey: ['users'] });
                toast('Member removed');
              }}
            >
              Remove
            </button>
          )}
        </div>
      ))}
      {isAdmin && (
      <>
      <input
        className="input"
        placeholder="Name"
        value={member.name}
        onChange={(e) => setMember({ ...member, name: e.target.value })}
      />
      <input
        className="input"
        type="email"
        placeholder="Email"
        value={member.email}
        onChange={(e) => setMember({ ...member, email: e.target.value })}
      />
      <input
        className="input"
        type="password"
        placeholder="Temporary password (8+ chars)"
        value={member.password}
        onChange={(e) => setMember({ ...member, password: e.target.value })}
      />
      <div className="row">
        <button
          className="btn"
          onClick={async () => {
            try {
              await api.post('/api/users', member);
              setMember({ name: '', email: '', password: '' });
              qc.invalidateQueries({ queryKey: ['users'] });
              toast('Member added');
            } catch (e) {
              toast(`Failed: ${(e as Error).message}`);
            }
          }}
        >
          Add member
        </button>
      </div>
      </>
      )}

      <h2>Your password</h2>
      <input
        className="input"
        type="password"
        placeholder="Current password"
        value={pw.current}
        onChange={(e) => setPw({ ...pw, current: e.target.value })}
      />
      <input
        className="input"
        type="password"
        placeholder="New password (8+ chars)"
        value={pw.next}
        onChange={(e) => setPw({ ...pw, next: e.target.value })}
      />
      <div className="row">
        <button
          className="btn"
          onClick={async () => {
            try {
              await api.post('/api/auth/change-password', {
                currentPassword: pw.current,
                newPassword: pw.next,
                revokeOtherSessions: true,
              });
              setPw({ current: '', next: '' });
              toast('Password changed - other sessions signed out');
            } catch (e) {
              toast(`Failed: ${(e as Error).message}`);
            }
          }}
        >
          Change password
        </button>
        <button className="btn btn-ghost" onClick={signOut}>Sign out</button>
      </div>

      <h2>AI suggestions</h2>
      <p className="muted">
        Optional. Runs the built-in model, or point at any OpenAI-compatible vision endpoint -
        Ollama, LM Studio, llama.cpp, or a hosted provider. It only ever <i>suggests</i>;
        your text always wins.
      </p>
      <select
        className="input"
        value={form.provider}
        onChange={(e) => setForm({ ...form, provider: e.target.value })}
      >
        <option value="off">Off</option>
        <option value="local">Built-in model (this device)</option>
        <option value="remote">External endpoint</option>
      </select>
      {form.provider === 'local' && (
        <p className="muted">
          Florence-2 downloads into your data folder on first use (~400MB) and runs offline
          after that.{data?.local_ready ? ' Model downloaded.' : ''}
        </p>
      )}
      {form.provider === 'remote' && (
        <>
          <input
            className="input"
            placeholder="Base URL, e.g. http://host.docker.internal:11434/v1"
            value={form.base_url}
            onChange={(e) => setForm({ ...form, base_url: e.target.value })}
          />
          <input
            className="input"
            placeholder="Model, e.g. llava, qwen2.5vl, gpt-4o-mini"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
          <input
            className="input"
            type="password"
            placeholder={data?.has_api_key ? 'API key (set - enter to replace)' : 'API key (optional)'}
            value={form.api_key}
            onChange={(e) => setForm({ ...form, api_key: e.target.value })}
          />
        </>
      )}
      <button className="btn" onClick={save}>Save</button>

      <h2>MCP connections</h2>
      <p className="muted">
        Let external AIs (ChatGPT, Claude…) search and manage this inventory. Each connection gets
        its own URL and auth token - share both, revoke either anytime. Needs HTTPS exposure
        (reverse proxy, Tailscale Funnel, Cloudflare Tunnel) for hosted connectors.
      </p>
      {(mcp?.connections ?? []).map((c: any) => (
        <div key={c.id} className="suggest">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>{c.name}</b>
            <button
              className="btn btn-ghost"
              onClick={async () => {
                await api.del(`/api/settings/mcp/${c.id}`);
                qc.invalidateQueries({ queryKey: ['settings-mcp'] });
                toast('Revoked');
              }}
            >
              Revoke
            </button>
          </div>
          <div className="row">
            <code className="mcp-url">{`${window.location.origin}/mcp/${c.slug}`}</code>
            <button className="btn btn-small" onClick={() => copy(`${window.location.origin}/mcp/${c.slug}`)}>
              Copy URL
            </button>
          </div>
          <p className="muted">
            {c.scope === 'read' ? 'Read only' : 'Read + write'} ·{' '}
            {c.last_used_at ? `Last used ${new Date(c.last_used_at).toLocaleString()}` : 'Never used'}
          </p>
        </div>
      ))}
      <div className="row">
        <input
          className="input"
          placeholder="Name, e.g. ChatGPT"
          value={connName}
          onChange={(e) => setConnName(e.target.value)}
        />
        <select
          className="input"
          style={{ maxWidth: '150px' }}
          value={connScope}
          onChange={(e) => setConnScope(e.target.value as 'read' | 'read-write')}
        >
          <option value="read-write">Read + write</option>
          <option value="read">Read only</option>
        </select>
        <button
          className="btn"
          onClick={async () => {
            if (!connName.trim()) return;
            const r = await api.post('/api/settings/mcp', { name: connName.trim(), scope: connScope });
            setConnName('');
            setNewToken(r.token ?? null);
            qc.invalidateQueries({ queryKey: ['settings-mcp'] });
            toast('Connection created');
          }}
        >
          Add
        </button>
      </div>
      {newToken && (
        <div className="suggest">
          <p>
            <b>Token (shown once - store it now):</b>
          </p>
          <div className="row">
            <code className="mcp-url">{newToken}</code>
            <button className="btn btn-small" onClick={() => copy(newToken)}>Copy token</button>
            <button className="btn btn-small btn-ghost" onClick={() => setNewToken(null)}>Done</button>
          </div>
        </div>
      )}

      <h2>Out reminders</h2>
      <p className="muted">
        Optional. One bundled digest of everything still out, posted to a webhook - works with
        ntfy, Discord, a Home Assistant webhook, or anything that takes a JSON POST.
        Never per-item pings.
      </p>
      <label className="row">
        <input
          type="checkbox"
          checked={dg.enabled}
          onChange={(e) => setDg({ ...dg, enabled: e.target.checked })}
        />
        Enabled
      </label>
      <input
        className="input"
        placeholder="Webhook URL (ntfy, HA webhook, etc.)"
        value={dg.webhook_url}
        onChange={(e) => setDg({ ...dg, webhook_url: e.target.value })}
      />
      <div className="row">
        <input
          className="input"
          type="time"
          style={{ maxWidth: '140px' }}
          value={dg.time}
          onChange={(e) => setDg({ ...dg, time: e.target.value })}
        />
        <span className="muted">daily (server timezone)</span>
      </div>
      <input
        className="input"
        placeholder="Public base URL for photo links (optional)"
        value={dg.base_url}
        onChange={(e) => setDg({ ...dg, base_url: e.target.value })}
      />
      <div className="row">
        <button
          className="btn"
          onClick={async () => {
            await api.put('/api/settings/digest', dg);
            toast('Saved');
          }}
        >
          Save
        </button>
        <button
          className="btn btn-ghost"
          onClick={async () => {
            try {
              const r = await api.post('/api/digest/test');
              toast(r.sent ? `Sent (${r.count} items)` : `Nothing sent (${r.count} out)`);
            } catch (e) {
              toast(`Failed: ${(e as Error).message}`);
            }
          }}
        >
          Send test
        </button>
      </div>
      {digest?.webhook_token && (
        <>
          <p className="muted">For Home Assistant automations and sensors:</p>
          <div className="row">
            <code className="mcp-url">{`${window.location.origin}/api/webhooks/out-sensor?token=${digest.webhook_token}`}</code>
            <button
              className="btn btn-small"
              onClick={() => copy(`${window.location.origin}/api/webhooks/out-sensor?token=${digest.webhook_token}`)}
            >
              Copy sensor URL
            </button>
          </div>
          <div className="row">
            <code className="mcp-url">{`${window.location.origin}/api/webhooks/digest?token=${digest.webhook_token}`}</code>
            <button
              className="btn btn-small"
              onClick={() => copy(`${window.location.origin}/api/webhooks/digest?token=${digest.webhook_token}`)}
            >
              Copy trigger URL
            </button>
          </div>
          <p className="muted">Sensor = GET. Digest trigger = POST.</p>
        </>
      )}

      <h2>AI on existing items</h2>
      <p className="muted">
        Re-runs suggestions and CLIP embeddings for everything filed before AI
        was switched on. Runs in the background - one photo at a time.
      </p>
      <button
        className="btn"
        onClick={async () => {
          try {
            const r = await api.post('/api/settings/backfill');
            toast(`Queued ${r.ai_queued} AI + ${r.embeddings_queued} embeddings`);
          } catch (e) {
            toast(`Failed: ${(e as Error).message}`);
          }
        }}
      >
        Backfill AI/ML
      </button>

      <h2>Export / Import</h2>
      <p className="muted">Everything you can see - items and areas - as a file.</p>
      <div className="row">
        <a className="btn" href="/api/export?format=json" download="stache-export.json">JSON</a>
        <a className="btn" href="/api/export?format=csv" download="stache-items.csv">CSV</a>
      </div>
      {isAdmin && (
        <>
          <p className="muted">
            Import a JSON or CSV file of items. Columns/keys: <code>name</code>,{' '}
            <code>note</code>, <code>quantity</code>, <code>tags</code> (semicolon-separated
            in CSV), <code>barcode</code>, <code>status</code>, <code>area_name</code>
            {' '}(found or created), <code>area_label</code> (<code>ST-…</code>),{' '}
            <code>area_id</code>. Rows without an area land in "Unsorted".
          </p>
          <div className="row">
            <label className="btn">
              Choose file…
              <input
                type="file"
                accept=".json,.csv"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  try {
                    const rows = parseImportFile(await f.text(), f.name);
                    setImportRows(rows);
                    setImportPreview(await api.post('/api/import', { items: rows, dry_run: true }));
                  } catch (err) {
                    toast(`Import read failed: ${(err as Error).message}`);
                  }
                }}
              />
            </label>
            {importPreview && (
              <button
                className="btn"
                onClick={async () => {
                  const r = await api
                    .post('/api/import', { items: importRows })
                    .catch((e) => (toast(`Import failed: ${e.message}`), null));
                  if (r) {
                    toast(`Imported ${r.created.length} item(s)`, r.event_id);
                    setImportRows(null);
                    setImportPreview(null);
                  }
                }}
              >
                Import {importPreview.create} item(s)
              </button>
            )}
            {importPreview && (
              <button className="btn btn-ghost" onClick={() => { setImportRows(null); setImportPreview(null); }}>
                Cancel
              </button>
            )}
          </div>
          {importPreview && (
            <div className="suggest">
              <p>
                <b>{importPreview.create}</b> of {importPreview.total} will import
                {importPreview.new_areas.length > 0 &&
                  ` · new areas: ${importPreview.new_areas.join(', ')}`}
              </p>
              {importPreview.errors.map((e: any) => (
                <p key={e.row} className="muted">Row {e.row + 1}: {e.error}</p>
              ))}
            </div>
          )}
        </>
      )}

      <h2>Backup</h2>
      <p className="muted">
        One zip with everything - database, photos, and a readable manifest.
        Restorable from a fresh install.
      </p>
      {isAdmin && (
        <>
          <label className="row">
            <input
              type="checkbox"
              checked={backupOpts.encrypt}
              onChange={(e) => setBackupOpts({ ...backupOpts, encrypt: e.target.checked })}
            />
            Encrypt the backup
          </label>
          {backupOpts.encrypt && (
            <>
              <input
                className="input"
                type="password"
                placeholder="Passphrase (blank = generate a key)"
                value={backupOpts.passphrase}
                onChange={(e) => setBackupOpts({ ...backupOpts, passphrase: e.target.value })}
              />
              {!backupOpts.passphrase && (
                <label className="row">
                  <input
                    type="checkbox"
                    checked={backupOpts.includeKey}
                    onChange={(e) => setBackupOpts({ ...backupOpts, includeKey: e.target.checked })}
                  />
                  Save the generated key inside the backup
                </label>
              )}
            </>
          )}
          <div className="row">
            <button
              className="btn"
              disabled={backupBusy}
              onClick={async () => {
                setBackupBusy(true);
                try {
                  const res = await fetch('/api/backup/download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      encrypt: backupOpts.encrypt,
                      passphrase: backupOpts.passphrase || null,
                      include_key: backupOpts.includeKey,
                    }),
                  });
                  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `${res.status}`);
                  const key = res.headers.get('x-stache-key');
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `stache-backup-${new Date().toISOString().slice(0, 10)}.zip`;
                  a.click();
                  URL.revokeObjectURL(url);
                  if (key) setBackupKey(key);
                  else toast('Backup downloaded');
                } catch (e) {
                  toast(`Backup failed: ${(e as Error).message}`);
                } finally {
                  setBackupBusy(false);
                }
              }}
            >
              {backupBusy ? 'Building…' : 'Download backup'}
            </button>
            <button
              className="btn btn-ghost"
              onClick={async () => {
                try {
                  const r = await api.post('/api/backup');
                  toast(`Snapshot saved: ${r.file}`);
                } catch (e) {
                  toast(`Snapshot failed: ${(e as Error).message}`);
                }
              }}
            >
              Quick DB snapshot
            </button>
          </div>
          {backupKey && (
            <div className="suggest">
              <p><b>Decryption key (shown once):</b></p>
              <div className="row">
                <code className="mcp-url">{backupKey}</code>
                <button className="btn btn-small" onClick={() => copy(backupKey)}>Copy</button>
                <button className="btn btn-small btn-ghost" onClick={() => setBackupKey(null)}>Done</button>
              </div>
            </div>
          )}

          <h2>Restore</h2>
          <p className="muted">
            Replaces the whole inventory with a backup bundle - the app restarts
            itself to apply it. This can't be undone.
          </p>
          {restoring ? (
            <p className="muted">Restoring - the server is restarting, this takes a moment…</p>
          ) : (
            <label className="btn danger">
              Restore from zip…
              <input
                type="file"
                accept=".zip"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  if (!window.confirm(`Replace the entire inventory with "${f.name}"?`)) return;
                  const key = window.prompt('Decryption key or passphrase (leave blank if unencrypted)') ?? '';
                  const form = new FormData();
                  form.append('file', f, f.name);
                  if (key.trim()) form.append('key', key.trim());
                  try {
                    const r = await api.upload('/api/backup/restore', form);
                    setRestoring(true);
                    if (!r.auto_restart) {
                      toast('Staged - restart the server to apply');
                      setRestoring(false);
                      return;
                    }
                    // Poll until the restarted server answers, then reload.
                    for (let i = 0; i < 60; i++) {
                      await new Promise((s) => setTimeout(s, 2000));
                      const ok = await fetch('/api/health').then((x) => x.ok).catch(() => false);
                      if (ok) {
                        window.location.reload();
                        return;
                      }
                    }
                    setRestoring(false);
                    toast('Restore applied - reload the page');
                  } catch (err) {
                    toast(`Restore failed: ${(err as Error).message}`);
                  }
                }}
              />
            </label>
          )}

          <h2>Photo maintenance</h2>
          <p className="muted">
            Checks the photo folder against the database - files nothing
            references, database rows pointing at missing files, missing thumbnails.
          </p>
          <div className="row">
            <button
              className="btn"
              onClick={async () => {
                setMaint(await api.get('/api/photos/maintenance').catch((e) => (toast(e.message), null)));
              }}
            >
              Check
            </button>
            {maint && (
              <>
                {maint.orphan_files > 0 && (
                  <button
                    className="btn"
                    onClick={async () => {
                      const r = await api.post('/api/photos/maintenance', { action: 'delete_orphans' });
                      toast(`Deleted ${r.deleted} orphan file(s)`);
                      setMaint(await api.get('/api/photos/maintenance'));
                    }}
                  >
                    Delete {maint.orphan_files} orphans
                  </button>
                )}
                {maint.missing_thumbs > 0 && (
                  <button
                    className="btn"
                    onClick={async () => {
                      const r = await api.post('/api/photos/maintenance', { action: 'repair_thumbs' });
                      toast(`Repaired ${r.repaired} thumbnail(s)`);
                      setMaint(await api.get('/api/photos/maintenance'));
                    }}
                  >
                    Repair {maint.missing_thumbs} thumbs
                  </button>
                )}
                {maint.dangling_rows > 0 && (
                  <button
                    className="btn"
                    onClick={async () => {
                      const r = await api.post('/api/photos/maintenance', { action: 'prune_dangling' });
                      toast(`Pruned ${r.pruned} dangling row(s)`);
                      setMaint(await api.get('/api/photos/maintenance'));
                    }}
                  >
                    Prune {maint.dangling_rows} broken rows
                  </button>
                )}
                {maint.orphan_files === 0 && maint.missing_thumbs === 0 && maint.dangling_rows === 0 && (
                  <span className="muted">All clean.</span>
                )}
              </>
            )}
          </div>
        </>
      )}

      <p className="muted" style={{ marginTop: '32px' }}>
        Stache {import.meta.env.VITE_APP_VERSION || 'dev'}
      </p>
    </div>
  );
}
