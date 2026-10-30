import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';

interface InboxItem {
  id: string;
  area_id: string;
  area_path: string;
  ai_name: string | null;
  thumb: string | null;
}

/**
 * Optional triage, one card at a time: photo, where it is, AI's guess.
 * Right / Fix / Later - skipping forever is supported.
 */
export function InboxPage() {
  const qc = useQueryClient();
  const { toast } = useApp();
  const [idx, setIdx] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [done, setDone] = useState<Set<string>>(new Set());
  const [later, setLater] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({ queryKey: ['inbox'], queryFn: () => api.get('/api/inbox') });

  const items: InboxItem[] = (data?.items ?? []).filter(
    (i: InboxItem) => !done.has(i.id) && !later.has(i.id),
  );
  const current = items[Math.min(idx, items.length - 1)];

  const finish = (id: string, s: 'done' | 'later') => {
    const set = s === 'done' ? done : later;
    const setter = s === 'done' ? setDone : setLater;
    setter(new Set(set).add(id));
    setEditing(false);
    setDraft('');
    if (idx >= items.length - 1) setIdx(0);
  };

  const accept = async (item: InboxItem) => {
    if (item.ai_name) {
      const r = await api.patch(`/api/items/${item.id}`, { name: item.ai_name });
      toast(`Named "${item.ai_name}"`, r.event_ids?.[0]);
      qc.invalidateQueries({ queryKey: ['item', item.id] });
    }
    finish(item.id, 'done');
  };

  const saveFix = async (item: InboxItem) => {
    const name = draft.trim();
    if (name) {
      const r = await api.patch(`/api/items/${item.id}`, { name });
      toast(`Named "${name}"`, r.event_ids?.[0]);
      qc.invalidateQueries({ queryKey: ['item', item.id] });
    }
    finish(item.id, 'done');
  };

  return (
    <div className="page">
      <div className="row spread">
        <h1>Inbox</h1>
        <Link to="/review" className="btn btn-ghost">Review queue</Link>
      </div>
      {isLoading && <p className="muted">Loading…</p>}
      {!isLoading && !current && <p className="muted">All clear. Nothing needs naming.</p>}

      {current && (
        <div className="triage">
          <p className="muted">
            {later.size > 0 ? `${items.length} to go · ` : ''}{idx + 1} / {items.length}
          </p>
          <Link to={`/items/${current.id}`} className="triage-photo">
            {current.thumb ? <img src={current.thumb} alt="" /> : <span>no photo</span>}
          </Link>
          <p className="grid-sub">{current.area_path}</p>
          {current.ai_name && <p>AI thinks: <b>{current.ai_name}</b></p>}

          {editing ? (
            <div className="row">
              <input
                className="input"
                autoFocus
                placeholder={current.ai_name ?? 'Name it'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveFix(current)}
              />
              <button className="btn" onClick={() => saveFix(current)}>Save</button>
            </div>
          ) : (
            <div className="triage-actions">
              <button className="btn" onClick={() => accept(current)}>✓ Right</button>
              <button
                className="btn"
                onClick={() => { setEditing(true); setDraft(current.ai_name ?? ''); }}
              >
                ✎ Fix
              </button>
              <button className="btn btn-ghost" onClick={() => finish(current.id, 'later')}>
                ⏭ Later
              </button>
            </div>
          )}
        </div>
      )}

      {(data?.low_stock ?? []).length > 0 && (
        <>
          <h2>Running low</h2>
          {(data?.low_stock ?? []).map((i: any) => (
            <div key={i.id} className="inbox-card">
              {i.thumb ? <img src={i.thumb} alt="" /> : <div className="thumb-placeholder" />}
              <div className="inbox-body">
                <Link to={`/items/${i.id}`}>{i.name ?? 'unnamed'}</Link>
                <div className="grid-sub">
                  {i.quantity} left · restocks below {i.restock_below} · {i.area_path}
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      {(data?.warranty_expiring ?? []).length > 0 && (
        <>
          <h2>Warranties ending</h2>
          {(data?.warranty_expiring ?? []).map((i: any) => (
            <div key={i.id} className="inbox-card">
              {i.thumb ? <img src={i.thumb} alt="" /> : <div className="thumb-placeholder" />}
              <div className="inbox-body">
                <Link to={`/items/${i.id}`}>{i.name ?? 'unnamed'}</Link>
                <div className="grid-sub">until {i.warranty_until} · {i.area_path}</div>
              </div>
            </div>
          ))}
        </>
      )}

      {(data?.lent_out ?? []).length > 0 && (
        <>
          <h2>Out / lent</h2>
          {(data?.lent_out ?? []).map((i: any) => (
            <div key={i.id} className="inbox-card">
              {i.thumb ? <img src={i.thumb} alt="" /> : <div className="thumb-placeholder" />}
              <div className="inbox-body">
                <div>{i.name ?? 'unnamed'}</div>
                <div className="grid-sub">
                  {i.status === 'lent' ? `lent to ${i.lent_to ?? '?'}` : 'out'}
                  {i.out_since ? ` · since ${new Date(i.out_since).toLocaleDateString()}` : ''}
                  {i.area_path ? ` · ${i.area_path}` : ''}
                </div>
                <button
                  className="btn btn-small"
                  onClick={() =>
                    api.patch(`/api/items/${i.id}`, { status: 'home' }).then(() =>
                      qc.invalidateQueries({ queryKey: ['inbox'] }),
                    )
                  }
                >
                  Back home
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
