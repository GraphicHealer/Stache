import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';
import { downscale } from '../image';
import { parseScan } from '../scan';
import { Scanner } from '../components/Scanner';
import { Breadcrumb, CaptureInput } from '../components/Bits';

export function ItemPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { toast, user } = useApp();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [scanning, setScanning] = useState(false);
  const [suggested, setSuggested] = useState<{ id: string; name: string | null }[] | null>(null);
  const [split, setSplit] = useState<{ photo_url: string; suggestions: { label: string; box: number[] }[] } | null>(null);
  const [splitBusy, setSplitBusy] = useState(false);
  const [picks, setPicks] = useState<{ on: boolean; name: string }[]>([]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['item', id],
    queryFn: () => api.get(`/api/items/${id}`),
  });
  const { data: areaHint } = useQuery({
    queryKey: ['suggested-area', id],
    queryFn: () => api.get(`/api/items/${id}/suggested-area`).catch(() => ({ suggestions: [] })),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['item', id] });
    if (data?.item?.area_id) qc.invalidateQueries({ queryKey: ['area', data.item.area_id] });
  };

  useEffect(() => {
    if (data?.item) {
      setName(data.item.name ?? '');
      setDesc(data.item.description ?? '');
    }
  }, [data]);

  if (isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (error || !data) return <div className="page"><p className="muted">Item not found.</p></div>;

  const { item, breadcrumb, photos } = data;

  const patch = async (body: Record<string, unknown>, message?: string) => {
    try {
      const r = await api.patch(`/api/items/${id}`, body);
      toast(message ?? 'Saved', r.event_ids?.[0]);
      refresh();
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`);
    }
  };

  const saveText = () => {
    const body: Record<string, unknown> = {};
    if ((name || null) !== item.name) body.name = name || null;
    if ((desc || null) !== item.description) body.description = desc || null;
    if (Object.keys(body).length) patch(body);
  };

  const onScan = async (text: string) => {
    setScanning(false);
    const scan = parseScan(text);
    if (scan?.kind !== 'label') return;
    const r = await api.get(`/api/labels/${scan.code}`).catch(() => null);
    if (r?.status === 'unclaimed') {
      nav(`/l/${scan.code}`);
      return;
    }
    if (r?.area?.id) patch({ area_id: r.area.id }, 'Moved');
  };

  const uploadPhoto = async (blob: Blob) => {
    const form = new FormData();
    form.append('photo', await downscale(blob), 'photo.jpg');
    await api.upload(`/api/items/${id}/photos`, form).catch((e) => toast(e.message));
    refresh();
  };

  const notHere = async () => {
    const r = await api.post(`/api/items/${id}/not-here`).catch((e) => (toast(e.message), null));
    if (r) {
      toast('Marked not here', r.event_id);
      setSuggested(r.suggested_areas);
      refresh();
    }
  };

  const startSplit = async () => {
    setSplitBusy(true);
    const r = await api.post(`/api/items/${id}/split-suggestions`, {}).catch((e) => (toast(e.message), null));
    setSplitBusy(false);
    if (!r) return;
    if (!r.suggestions?.length) return toast('No distinct objects found');
    setSplit(r);
    setPicks(r.suggestions.map((s: { label: string }) => ({ on: true, name: s.label })));
  };

  const confirmSplit = async () => {
    if (!split) return;
    const chosen = split.suggestions
      .map((s, i) => ({ ...s, i }))
      .filter((s) => picks[s.i]?.on)
      .map((s) => ({ name: picks[s.i].name.trim() || null, label: s.label, box: s.box }));
    if (!chosen.length) return setSplit(null);
    const r = await api.post(`/api/items/${id}/split`, { picks: chosen }).catch((e) => (toast(e.message), null));
    if (r) {
      toast(`Filed ${r.items.length} item(s)`, r.event_ids?.[0]);
      setSplit(null);
    }
  };

  const hide = async () => {
    if (!window.confirm('Hide this item? Undoable.')) return;
    const r = await api.del(`/api/items/${id}`);
    toast('Hidden', r.event_id);
    nav(-1);
  };

  return (
    <div className="page">
      <Breadcrumb trail={breadcrumb} />

      <div className="photo-strip">
        {photos.map((p: any) => (
          <img key={p.id} src={p.url} alt="" />
        ))}
        <CaptureInput onCapture={uploadPhoto} className="btn">+ Photo</CaptureInput>
      </div>

      <input
        className="input"
        placeholder="Name it? (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={saveText}
      />
      <textarea
        className="input"
        placeholder="Notes? (optional)"
        rows={2}
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        onBlur={saveText}
      />

      {(item.ai_status === 'pending' ||
        (item.ai_status === 'done' && (item.ai_name || item.ai_description))) && (
        <div className="suggest">
          {item.ai_status === 'pending' ? (
            <p className="muted">AI is looking at the photo…</p>
          ) : (
            <>
              <p className="muted">AI suggests:</p>
              {item.ai_name && <div><b>{item.ai_name}</b></div>}
              {item.ai_description && <div className="muted">{item.ai_description}</div>}
              {(item.ai_tags ?? []).map((t: string) => (
                <span key={t} className="badge">{t}</span>
              ))}
              <button
                className="btn"
                onClick={() =>
                  patch(
                    {
                      name: item.name ?? item.ai_name,
                      description: item.description ?? item.ai_description,
                    },
                    'Saved',
                  )
                }
              >
                Use it
              </button>
            </>
          )}
        </div>
      )}

      <div className="row">
        <button className="btn" disabled={item.quantity <= 1} onClick={() => patch({ quantity: item.quantity - 1 })}>−</button>
        <span className="qty">×{item.quantity}</span>
        <button className="btn" onClick={() => patch({ quantity: item.quantity + 1 })}>+</button>
        {item.barcode && <span className="badge">{item.barcode}</span>}
      </div>

      {(item.detected_codes ?? [])
        .filter((c: any) => c.text !== item.barcode)
        .map((c: any) => (
          <div key={c.text} className="suggest">
            <p className="muted">Found barcode <b>{c.text}</b> in a photo - same item?</p>
            <div className="row">
              <button className="btn" onClick={() => patch({ barcode: c.text }, 'Barcode attached')}>Yes</button>
              <button
                className="btn btn-ghost"
                onClick={() =>
                  patch(
                    { detected_codes: item.detected_codes.filter((x: any) => x.text !== c.text) },
                    'Dismissed',
                  )
                }
              >
                No
              </button>
            </div>
          </div>
        ))}

      <div className="row">
        {item.status !== 'home' ? (
          <button className="btn" onClick={() => patch({ status: 'home' }, 'Back home')}>Back home</button>
        ) : (
          <>
            <button className="btn" onClick={() => patch({ status: 'out' }, 'Marked out')}>Out</button>
            <button
              className="btn"
              onClick={() => {
                const to = window.prompt('Lent to whom?');
                if (to !== null) patch({ status: 'lent', lent_to: to || null }, `Lent to ${to || '?'}`);
              }}
            >
              Lend…
            </button>
          </>
        )}
        {item.status === 'lent' && <span className="badge warn">→ {item.lent_to ?? '?'}</span>}
        {item.status === 'out' && <span className="badge warn">out</span>}
      </div>

      {(areaHint?.suggestions ?? []).length > 0 && item.status === 'home' && (
        <div className="suggest">
          <p className="muted">Similar things live in:</p>
          {areaHint.suggestions.map((s: any) => (
            <button
              key={s.area_id}
              className="btn"
              onClick={() => patch({ area_id: s.area_id }, `Moved to ${s.path}`)}
            >
              {s.path}
            </button>
          ))}
        </div>
      )}

      <details className="opt-details">
        <summary>Details (optional)</summary>
        <label className="row">
          <span className="muted">Warranty until</span>
          <input
            className="input"
            type="date"
            defaultValue={item.warranty_until ?? ''}
            onBlur={(e) => patch({ warranty_until: e.target.value || null }, 'Saved')}
          />
        </label>
        <label className="row">
          <span className="muted">Restock when below</span>
          <input
            className="input"
            type="number"
            min={0}
            placeholder="off"
            defaultValue={item.restock_below ?? ''}
            onBlur={(e) =>
              patch({ restock_below: e.target.value === '' ? null : parseInt(e.target.value, 10) }, 'Saved')
            }
          />
        </label>
        <p className="muted">Low stock shows up quietly in the Inbox and digest.</p>
      </details>

      {(!item.owner_id || item.owner_id === user?.id) && (
        <label className="row">
          <input
            type="checkbox"
            checked={item.is_private}
            onChange={(e) => patch({ is_private: e.target.checked }, e.target.checked ? 'Private' : 'Shared')}
          />
          Private - only you can see this
        </label>
      )}
      {item.is_private && <span className="badge warn">private</span>}
      {item.duplicate_of && (
        <p className="muted">
          This photo looks very similar to{' '}
          <Link to={`/items/${item.duplicate_of}`}>another item</Link> - possible duplicate.
        </p>
      )}
      {item.takeout_count > 0 && (
        <p className="muted">
          Taken out {item.takeout_count}×
          {item.last_used ? ` · last ${new Date(item.last_used).toLocaleDateString()}` : ''}
        </p>
      )}

      <div className="row">
        <button className="btn" onClick={() => setScanning(true)}>Move…</button>
        <button className="btn" onClick={notHere}>
          Not here{item.not_here_count > 0 ? ` (${item.not_here_count})` : ''}
        </button>
        <button className="btn" disabled={splitBusy || !photos.length} onClick={startSplit}>
          {splitBusy ? 'Looking…' : 'Split pile…'}
        </button>
        <button className="btn danger" onClick={hide}>Hide</button>
      </div>

      {split && (
        <div className="split-view">
          <div className="split-photo">
            <img src={split.photo_url} alt="" />
            {split.suggestions.map((s, i) =>
              picks[i]?.on ? (
                <div
                  key={i}
                  className="split-box"
                  style={{
                    top: `${s.box[0] / 10}%`,
                    left: `${s.box[1] / 10}%`,
                    height: `${(s.box[2] - s.box[0]) / 10}%`,
                    width: `${(s.box[3] - s.box[1]) / 10}%`,
                  }}
                >
                  <span>{i + 1}</span>
                </div>
              ) : null,
            )}
          </div>
          <p className="muted">Check the objects to file as their own items. Nothing else is added.</p>
          {split.suggestions.map((s, i) => (
            <div key={i} className="row split-row">
              <input
                type="checkbox"
                checked={picks[i]?.on ?? false}
                onChange={(e) =>
                  setPicks((p) => p.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))
                }
              />
              <span className="muted">#{i + 1}</span>
              <input
                className="input"
                value={picks[i]?.name ?? ''}
                placeholder={s.label}
                onChange={(e) =>
                  setPicks((p) => p.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }
              />
            </div>
          ))}
          <div className="row">
            <button className="btn" onClick={confirmSplit}>
              File {picks.filter((p) => p.on).length} item(s)
            </button>
            <button className="btn btn-ghost" onClick={() => setSplit(null)}>Cancel</button>
          </div>
        </div>
      )}

      {suggested && suggested.length > 0 && (
        <div className="suggest">
          <p className="muted">Might be in:</p>
          {suggested.map((a) => (
            <button
              key={a.id}
              className="btn"
              onClick={() => { setSuggested(null); patch({ area_id: a.id }, 'Moved'); }}
            >
              {a.name ?? 'unnamed area'}
            </button>
          ))}
        </div>
      )}

      {scanning && (
        <Scanner onResult={onScan} onClose={() => setScanning(false)} hint="Scan destination area" />
      )}
    </div>
  );
}
