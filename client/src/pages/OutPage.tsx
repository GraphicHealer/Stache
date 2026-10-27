import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';

interface OutItem {
  id: string;
  name: string | null;
  status: string;
  lent_to: string | null;
  days: number;
  area_id: string;
  area_path: string;
  snoozed: boolean;
  thumb: string | null;
}

const outText = (i: OutItem) =>
  i.status === 'lent'
    ? `lent to ${i.lent_to ?? '?'}`
    : i.status === 'unaccounted'
      ? 'unaccounted for'
      : i.days === 0
        ? 'out today'
        : `out ${i.days} day${i.days === 1 ? '' : 's'}`;

/** Everything removed from its space. "Out" and "unaccounted" stay separate. */
export function OutPage() {
  const { toast } = useApp();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['out'], queryFn: () => api.get('/api/out') });
  const [sel, setSel] = useState<Set<string> | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['out'] });

  const putBack = async (ids: string[]) => {
    const r = await api.post('/api/items/put-back', { ids }).catch((e) => (toast(e.message), null));
    if (r?.put_back) toast(`Put back ${r.put_back}`, r.event_ids?.[0]);
    setSel(null);
    refresh();
  };

  const patch = async (id: string, body: Record<string, unknown>, msg: string) => {
    const r = await api.patch(`/api/items/${id}`, body).catch((e) => (toast(e.message), null));
    if (r) {
      toast(msg, r.event_ids?.[0]);
      refresh();
    }
  };

  const snooze = async (i: OutItem) => {
    if (i.snoozed) return patch(i.id, { remind_snoozed_until: null }, 'Reminders on');
    const days = window.prompt('Snooze reminders for how many days?', '30');
    if (!days) return;
    const until = new Date(Date.now() + (parseInt(days, 10) || 30) * 86400_000).toISOString();
    patch(i.id, { remind_snoozed_until: until }, 'Snoozed');
  };

  const section = (title: string, list: OutItem[]) => {
    if (!list.length) return null;
    const groups = new Map<string, OutItem[]>();
    for (const i of list) {
      const k = i.area_path || 'somewhere';
      groups.set(k, [...(groups.get(k) ?? []), i]);
    }
    return (
      <section key={title}>
        <h2>{title}</h2>
        {[...groups.entries()].map(([path, rows]) => (
          <div key={path} className="out-group">
            <p className="muted">{path}</p>
            {rows.map((i) => (
              <div key={i.id} className="out-row">
                {sel && (
                  <input
                    type="checkbox"
                    checked={sel.has(i.id)}
                    onChange={(e) => {
                      const next = new Set(sel);
                      e.target.checked ? next.add(i.id) : next.delete(i.id);
                      setSel(next.size ? next : new Set());
                    }}
                  />
                )}
                <Link to={`/items/${i.id}`} className="out-thumb">
                  {i.thumb ? <img src={i.thumb} alt="" /> : <span>?</span>}
                </Link>
                <div className="out-info">
                  <Link to={`/items/${i.id}`}>{i.name ?? 'unnamed'}</Link>
                  <span className="muted">
                    {outText(i)}{i.snoozed ? ' · snoozed' : ''}
                  </span>
                </div>
                <div className="out-actions">
                  <button className="btn btn-small" onClick={() => putBack([i.id])}>Put back</button>
                  <button className="btn btn-small btn-ghost" onClick={() => snooze(i)}>
                    {i.snoozed ? 'Unsnooze' : 'Snooze'}
                  </button>
                  <button
                    className="btn btn-small btn-ghost"
                    onClick={() => patch(i.id, { status: 'gone' }, 'Marked gone')}
                  >
                    Gone
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </section>
    );
  };

  const total = (data?.out?.length ?? 0) + (data?.unaccounted?.length ?? 0);

  return (
    <div className="page">
      <h1>Out of place</h1>
      {!data && <p className="muted">Loading…</p>}
      {data && total === 0 && <p className="muted">Everything's where it belongs.</p>}
      {!!total && (
        <div className="row">
          {sel ? (
            <>
              <button
                className="btn"
                disabled={!sel.size}
                onClick={() => putBack([...sel])}
              >
                Put back {sel.size || ''}
              </button>
              <button className="btn btn-ghost" onClick={() => setSel(null)}>Cancel</button>
            </>
          ) : (
            <button className="btn btn-ghost" onClick={() => setSel(new Set())}>Select</button>
          )}
        </div>
      )}
      {section('Out', data?.out ?? [])}
      {section('Unaccounted for', data?.unaccounted ?? [])}
    </div>
  );
}
