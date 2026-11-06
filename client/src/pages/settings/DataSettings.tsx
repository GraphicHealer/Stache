import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useApp } from '../../context';
import { IconBtn, useConfirm, usePrompt } from '../../components/Bits';
import { SettingsShell, copy } from './SettingsShell';
import { parseImportFile } from './import';

/** Data & Backups: export, import, backups, restore. */
export function DataSettings() {
  const { toast, user } = useApp();
  const [askConfirm, confirmUi] = useConfirm();
  const [askPrompt, promptUi] = usePrompt();
  const qc = useQueryClient();
  const { data: backupSched } = useQuery({ queryKey: ['settings-backup-schedule'], queryFn: () => api.get('/api/settings/backup-schedule').catch(() => null) });
  const [sched, setSched] = useState({ enabled: false, interval_days: 1, keep: 7 });
  const [schedLoaded, setSchedLoaded] = useState(false);
  const [backupOpts, setBackupOpts] = useState({ encrypt: false, passphrase: '', includeKey: false });
  const [backupKey, setBackupKey] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [importRows, setImportRows] = useState<Record<string, unknown>[] | null>(null);
  const [importPreview, setImportPreview] = useState<any>(null);
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    if (backupSched && !schedLoaded) {
      setSched({
        enabled: backupSched.enabled,
        interval_days: backupSched.interval_days,
        keep: backupSched.keep,
      });
      setSchedLoaded(true);
    }
  }, [backupSched, schedLoaded]);

  return (
    <SettingsShell title="Data & Backups">
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

      {isAdmin && (
        <>
          <h2>Backups</h2>
          <p className="muted">
            One zip with everything - database, photos, and a readable manifest.
            Restorable from a fresh install.
          </p>
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
          <p className="muted">
            A backup zip includes photos and everything else; a quick snapshot is
            the database only - fast, but not a full backup.
          </p>

          <h3>Automatic backups</h3>
          <p className="muted">
            Saves an unencrypted bundle on the server (<code>/data/backups</code>) on a
            schedule. Off by default - encrypted backups stay a manual download.
            Server-stored backups are not a substitute for downloading an
            encrypted backup yourself.
          </p>
          <label className="row">
            <input
              type="checkbox"
              checked={sched.enabled}
              onChange={(e) => setSched({ ...sched, enabled: e.target.checked })}
            />
            Back up automatically
          </label>
          {sched.enabled && (
            <div className="row">
              <label>
                Every{' '}
                <input
                  className="input input-inline"
                  type="number"
                  min={1}
                  max={30}
                  value={sched.interval_days}
                  onChange={(e) => setSched({ ...sched, interval_days: Number(e.target.value) || 1 })}
                />{' '}
                day(s)
              </label>
              <label>
                keep last{' '}
                <input
                  className="input input-inline"
                  type="number"
                  min={1}
                  max={30}
                  value={sched.keep}
                  onChange={(e) => setSched({ ...sched, keep: Number(e.target.value) || 1 })}
                />
              </label>
            </div>
          )}
          <div className="row">
            <button
              className="btn btn-small"
              onClick={async () => {
                try {
                  await api.put('/api/settings/backup-schedule', sched);
                  toast(sched.enabled ? `Backing up every ${sched.interval_days} day(s), keeping ${sched.keep}` : 'Automatic backups off');
                } catch (e) {
                  toast(`Save failed: ${(e as Error).message}`);
                }
              }}
            >
              Save schedule
            </button>
          </div>
          {backupKey && (
            <div className="suggest">
              <p><b>Decryption key (shown once):</b></p>
              <p className="muted">
                Keep this key - you cannot decrypt the backup without it.
              </p>
              <div className="row">
                <code className="mcp-url">{backupKey}</code>
                <IconBtn icon="copy" className="btn-small" label="Copy decryption key" onClick={() => copy(backupKey)} />
                <IconBtn icon="x" className="btn-small btn-ghost" label="Dismiss key" onClick={() => setBackupKey(null)} />
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
                  if (!(await askConfirm(`Replace the entire inventory with "${f.name}"?`, 'Replace'))) return;
                  const key = await askPrompt('Decryption key or passphrase', { placeholder: 'Leave blank if unencrypted', allowEmpty: true });
                  if (key === null) return;
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
        </>
      )}
      {confirmUi}
      {promptUi}
    </SettingsShell>
  );
}
