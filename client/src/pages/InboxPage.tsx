import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';

/** Optional triage of unnamed items. Skipping forever is supported. */
export function InboxPage() {
  const qc = useQueryClient();
  const { toast } = useApp();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({ queryKey: ['inbox'], queryFn: () => api.get('/api/inbox') });

  const items = (data?.items ?? []).filter((i: any) => !done.has(i.id));

  const save = async (id: string) => {
    const name = (drafts[id] ?? '').trim();
    if (!name) return;
    await api.patch(`/api/items/${id}`, { name }).then((r) => toast('Named', r.event_ids?.[0]));
    setDone((s) => new Set(s).add(id));
    qc.invalidateQueries({ queryKey: ['inbox'] });
  };

  return (
    <div className="page">
      <h1>Inbox</h1>
      <p className="muted">Unnamed things, newest first. Name them if you feel like it - or don't.</p>
      {isLoading && <p className="muted">Loading…</p>}
      {!isLoading && items.length === 0 && <p className="muted">All clear.</p>}
      {items.map((i: any) => (
        <div key={i.id} className="inbox-card">
          {i.thumb ? <img src={i.thumb} alt="" /> : <div className="thumb-placeholder" />}
          <div className="inbox-body">
            <div className="grid-sub">{i.area_path}</div>
            <div className="row">
              <input
                className="input"
                placeholder={i.ai_name ? `AI: ${i.ai_name}` : 'Name it?'}
                value={drafts[i.id] ?? i.ai_name ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [i.id]: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && save(i.id)}
              />
              <button className="btn" onClick={() => save(i.id)}>Save</button>
              <button className="btn" onClick={() => setDone((s) => new Set(s).add(i.id))}>Later</button>
            </div>
          </div>
        </div>
      ))}

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
