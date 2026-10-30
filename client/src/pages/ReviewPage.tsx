import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';

/**
 * The "clean-up pass" - AI-flagged duplicates, unnamed photos, and items
 * whose AI processing failed. All optional; nothing here is urgent.
 */
export function ReviewPage() {
  const { toast } = useApp();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['review-queue'],
    queryFn: () => api.get('/api/review-queue'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['review-queue'] });

  if (isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  const { duplicates = [], incomplete = [], failed_ai = [] } = data ?? {};
  const empty = !duplicates.length && !incomplete.length && !failed_ai.length;

  const merge = async (winnerId: string, loserId: string) => {
    const r = await api
      .post(`/api/items/${winnerId}/merge`, { item_id: loserId })
      .catch((e) => (toast(`Merge failed: ${e.message}`), null));
    if (r) {
      toast('Merged - photos moved over', r.event_id);
      refresh();
    }
  };

  const keep = async (itemId: string) => {
    const r = await api
      .patch(`/api/items/${itemId}`, { duplicate_of: null })
      .catch((e) => (toast(e.message), null));
    if (r) {
      toast('Kept as separate', r.event_ids?.[0]);
      refresh();
    }
  };

  const rerun = async (itemId: string) => {
    await api.post(`/api/items/${itemId}/ai-rerun`).catch((e) => toast(e.message));
    toast('Queued for AI');
    refresh();
  };

  return (
    <div className="page">
      <h1>Review</h1>
      {empty && <p className="muted">Nothing needs a look. Nice.</p>}

      {duplicates.length > 0 && (
        <>
          <h2>Possible duplicates ({duplicates.length})</h2>
          {duplicates.map((d: any) => (
            <div key={d.id} className="inbox-card">
              {d.thumb ? <img src={d.thumb} alt="" /> : <div className="thumb-placeholder" />}
              <div className="inbox-body">
                <Link to={`/items/${d.id}`}><b>{d.name ?? 'unnamed'}</b></Link>
                <div className="muted">looks like</div>
                <div className="row" style={{ alignItems: 'center' }}>
                  {d.original.thumb && <img src={d.original.thumb} alt="" className="mini-thumb" />}
                  <Link to={`/items/${d.original.id}`}>{d.original.name ?? 'unnamed'}</Link>
                </div>
                <div className="row">
                  <button className="btn" onClick={() => merge(d.original.id, d.id)}>
                    Merge into it
                  </button>
                  <button className="btn" onClick={() => merge(d.id, d.original.id)}>
                    Keep this one
                  </button>
                  <button className="btn btn-ghost" onClick={() => keep(d.id)}>
                    Not a dup
                  </button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      {incomplete.length > 0 && (
        <>
          <h2>Unnamed ({incomplete.length})</h2>
          <p className="muted">Photos without names - tap to name, or leave them.</p>
          <div className="grid">
            {incomplete.map((i: any) => (
              <Link key={i.id} to={`/items/${i.id}`} className="card">
                {i.thumb ? <img src={i.thumb} alt="" /> : <div className="thumb-placeholder" />}
                <div className="grid-caption">
                  {i.ai_name ?? 'unnamed'}
                  {i.ai_name && <div className="grid-sub">AI guess</div>}
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      {failed_ai.length > 0 && (
        <>
          <h2>AI hiccups ({failed_ai.length})</h2>
          {failed_ai.map((i: any) => (
            <div key={i.id} className="inbox-card">
              {i.thumb ? <img src={i.thumb} alt="" /> : <div className="thumb-placeholder" />}
              <div className="inbox-body">
                <Link to={`/items/${i.id}`}><b>{i.name ?? 'unnamed'}</b></Link>
                <div className="row">
                  <button className="btn" onClick={() => rerun(i.id)}>Try AI again</button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
