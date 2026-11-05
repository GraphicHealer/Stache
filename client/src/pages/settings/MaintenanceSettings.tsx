import { useState } from 'react';
import { api } from '../../api';
import { useApp } from '../../context';
import { SettingsShell } from './SettingsShell';

/** Maintenance: photo-storage diagnostics + repair (admin). Check-first. */
export function MaintenanceSettings() {
  const { toast, user } = useApp();
  const [maint, setMaint] = useState<any>(null);
  const isAdmin = user?.role === 'admin';

  if (!isAdmin)
    return (
      <SettingsShell title="Maintenance">
        <p className="muted">Maintenance operations need an administrator.</p>
      </SettingsShell>
    );

  const recheck = () => api.get('/api/photos/maintenance').then(setMaint);
  const run = async (action: string, ok: (r: any) => string) => {
    const r = await api.post('/api/photos/maintenance', { action }).catch((e) => (toast(e.message), null));
    if (!r) return;
    toast(ok(r));
    await recheck();
  };

  const rows = maint
    ? [
        ['Orphaned photo files', maint.orphan_files],
        ['Missing thumbnails', maint.missing_thumbs],
        ['Broken database references', maint.dangling_rows],
      ]
    : [];

  return (
    <SettingsShell title="Maintenance">
      <h2>Photo storage check</h2>
      <p className="muted">
        Checks the photo folder against the database - files nothing
        references, database rows pointing at missing files, missing thumbnails.
        Run the check first; repairs only show when there's something to fix.
      </p>
      <div className="row">
        <button
          className="btn"
          onClick={() => api.get('/api/photos/maintenance').then(setMaint).catch((e) => toast(e.message))}
        >
          Check
        </button>
      </div>
      {maint && (
        <div className="suggest maint-summary">
          {rows.map(([label, count]) => (
            <div key={label} className="row maint-row">
              <span>{label}</span>
              <b className={count ? 'warn-text' : ''}>{count}</b>
            </div>
          ))}
        </div>
      )}
      {maint && (
        <div className="row">
          {maint.orphan_files > 0 && (
            <button className="btn" onClick={() => run('delete_orphans', (r) => `Deleted ${r.deleted} orphan file(s)`)}>
              Delete {maint.orphan_files} orphans
            </button>
          )}
          {maint.missing_thumbs > 0 && (
            <button className="btn" onClick={() => run('repair_thumbs', (r) => `Repaired ${r.repaired} thumbnail(s)`)}>
              Repair {maint.missing_thumbs} thumbs
            </button>
          )}
          {maint.dangling_rows > 0 && (
            <button className="btn" onClick={() => run('prune_dangling', (r) => `Pruned ${r.pruned} broken row(s)`)}>
              Prune {maint.dangling_rows} broken rows
            </button>
          )}
          {maint.orphan_files === 0 && maint.missing_thumbs === 0 && maint.dangling_rows === 0 && (
            <span className="muted">All clean.</span>
          )}
        </div>
      )}
    </SettingsShell>
  );
}
