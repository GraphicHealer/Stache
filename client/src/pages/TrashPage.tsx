import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../context';
import { IconBtn, useConfirm } from '../components/Bits';
import { describeEvent, relTime } from '../lib/events';

/**
 * Trash + activity: hidden items and archived areas (restorable, or purgeable
 * to reclaim disk), plus the recent audit feed - who did what, with undo.
 */
export function TrashPage() {
  const { toast } = useApp();
  const [askConfirm, confirmUi] = useConfirm();
  const qc = useQueryClient();
  const { data: trash } = useQuery({ queryKey: ['trash'], queryFn: () => api.get('/api/trash') });
  const { data: ev } = useQuery({ queryKey: ['events-feed'], queryFn: () => api.get('/api/events?limit=50') });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['trash'] });
    qc.invalidateQueries({ queryKey: ['events-feed'] });
    qc.invalidateQueries({ queryKey: ['areas'] });
  };

  const restoreItem = async (id: string) => {
    const r = await api.post(`/api/items/${id}/restore`).catch((e) => (toast(e.message), null));
    if (r) { toast('Restored', r.event_id); refresh(); }
  };

  const purgeItem = async (id: string) => {
    if (!(await askConfirm('Delete permanently? This removes photos too - NOT undoable.', 'Delete'))) return;
    const r = await api.del(`/api/items/${id}/purge`).catch((e) => (toast(e.message), null));
    if (!r) return;
    toast('Purged');
    refresh();
  };

  const restoreArea = async (id: string) => {
    const r = await api.post(`/api/areas/${id}/restore`).catch((e) => (toast(e.message), null));
    if (r) { toast('Area restored', r.event_id); refresh(); }
  };

  const undo = async (id: string) => {
    const r = await api.post(`/api/events/${id}/undo`).catch((e) => (toast(e.message), null));
    if (r?.ok !== false) { toast('Undone'); refresh(); }
  };

  const empty =
    trash && !trash.items.length && !trash.areas.length;

  return (
    <div className="page">
      <h1>Recently deleted & activity</h1>

      <h2>Deleted items</h2>
      {empty && <p className="muted">Nothing in the trash.</p>}
      {(trash?.items ?? []).map((i: any) => (
        <div key={i.id} className="out-row">
          <Link to={`/items/${i.id}`} className="out-thumb" aria-label={i.name ?? i.ai_name ?? 'unnamed'}>
            {i.thumb ? <img src={i.thumb} alt="" /> : <span>?</span>}
          </Link>
          <div className="out-info">
            <Link to={`/items/${i.id}`}>{i.name ?? i.ai_name ?? 'unnamed'}</Link>
            <span className="muted">deleted {new Date(i.hidden_at).toLocaleDateString()}</span>
          </div>
          <div className="out-actions">
            <IconBtn icon="undo" className="btn-small" label="Restore item" onClick={() => restoreItem(i.id)} />
            <IconBtn icon="trash" className="btn-small btn-ghost" label="Purge permanently" onClick={() => purgeItem(i.id)} />
          </div>
        </div>
      ))}

      {(trash?.areas ?? []).length > 0 && (
        <>
          <h2>Archived areas</h2>
          {trash.areas.map((a: any) => (
            <div key={a.id} className="out-row">
              <div className="out-info">
                <Link to={`/areas/${a.id}`}>{a.name ?? 'unnamed'}</Link>
                <span className="muted">deleted {new Date(a.archived_at).toLocaleDateString()}</span>
              </div>
              <div className="out-actions">
                <IconBtn icon="undo" className="btn-small" label="Restore area" onClick={() => restoreArea(a.id)} />
              </div>
            </div>
          ))}
        </>
      )}

      <h2>Activity</h2>
      {(ev?.events ?? []).map((e: any) => (
        <div key={e.id} className="out-row">
          <div className="out-info">
            <span>{describeEvent(e)}{e.undone ? ' (undone)' : ''}</span>
            <span className="muted">
              {e.user_name ?? 'system'} · {relTime(e.created_at)}
            </span>
          </div>
          {!e.undone && (
            <div className="out-actions">
              <IconBtn icon="undo" className="btn-small btn-ghost" label="Undo this change" onClick={() => undo(e.id)} />
            </div>
          )}
        </div>
      ))}
      {ev && !ev.events?.length && <p className="muted">Nothing yet.</p>}
      {confirmUi}
    </div>
  );
}
