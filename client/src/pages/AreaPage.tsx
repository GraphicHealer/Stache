import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';
import { downscale } from '../image';
import { parseScan } from '../scan';
import { Scanner } from '../components/Scanner';
import { Breadcrumb, CaptureInput, ItemGrid } from '../components/Bits';

export function AreaPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { setCurrentArea, toast } = useApp();
  const [selecting, setSelecting] = useState<Set<string> | null>(null);
  // Stocktake mode: set of item ids confirmed physically present.
  const [stocktake, setStocktake] = useState<Set<string> | null>(null);
  const [scanFor, setScanFor] = useState<null | 'set-current' | 'move-items' | 'move-area'>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['area', id],
    queryFn: () => api.get(`/api/areas/${id}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['area', id] });

  if (isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (error || !data) return <div className="page"><p className="muted">Area not found.</p></div>;

  const { area, breadcrumb, subareas, items, photos } = data;

  const resolveLabelArea = async (code: string): Promise<string | null> => {
    const r = await api.get(`/api/labels/${code}`).catch(() => null);
    if (r?.status === 'unclaimed') {
      nav(`/l/${code}`);
      return null;
    }
    return r?.area?.id ?? null;
  };

  const onScan = async (text: string) => {
    const mode = scanFor;
    setScanFor(null);
    const scan = parseScan(text);
    if (!scan || scan.kind !== 'label' || !mode) return;
    const dest = await resolveLabelArea(scan.code);
    if (!dest) return;

    if (mode === 'set-current') {
      setCurrentArea({ id: dest, name: null, thumb: null });
      toast('Set as current area');
      nav('/');
      return;
    }
    if (mode === 'move-area') {
      const r = await api.patch(`/api/areas/${id}`, { parent_id: dest });
      toast('Area moved', r.event_ids?.[0]);
      refresh();
      return;
    }
    // move-items - one toast for the batch (undo only exists per item, so a
    // multi-item move shows a plain confirmation).
    const ids = [...(selecting ?? [])];
    let failed = 0;
    let lastEvent: string | undefined;
    for (const itemId of ids) {
      const r = await api.patch(`/api/items/${itemId}`, { area_id: dest }).catch(() => null);
      if (r) lastEvent = r.event_ids?.[0];
      else failed++;
    }
    if (ids.length === 1 && !failed) toast('Moved', lastEvent);
    else toast(`Moved ${ids.length - failed}/${ids.length} item(s)`);
    setSelecting(null);
    refresh();
    qc.invalidateQueries({ queryKey: ['area', dest] });
  };

  const rename = async () => {
    const name = window.prompt('Area name (leave blank to clear)', area.name ?? '');
    if (name === null) return;
    const r = await api.patch(`/api/areas/${id}`, { name: name || null });
    toast('Renamed', r.event_ids?.[0]);
    refresh();
  };

  const uploadPhoto = async (blob: Blob) => {
    const form = new FormData();
    form.append('photo', await downscale(blob), 'photo.jpg');
    await api.upload(`/api/areas/${id}/photos`, form).catch((e) => toast(e.message));
    refresh();
  };

  const archive = async () => {
    if (!window.confirm('Hide this area? Its label will still resolve. Undoable.')) return;
    const r = await api.del(`/api/areas/${id}`);
    toast('Area hidden', r.event_id);
    nav(-1);
  };

  const addSubarea = async () => {
    const name = window.prompt('Sub-area name (optional)') ?? '';
    await api.post('/api/areas', { parent_id: id, name: name || null }).then(() => refresh());
  };

  // Stocktake: everything starts ticked (assume it's all there), the user
  // unticks what's missing, and the rest get flagged unaccounted in one go.
  const startStocktake = () => {
    setSelecting(null);
    setStocktake(new Set(items.map((i: any) => i.id)));
  };
  const confirmStocktake = async () => {
    const r = await api
      .post(`/api/areas/${id}/stocktake`, { present_ids: [...(stocktake ?? [])] })
      .catch((e) => { toast(`Stocktake failed: ${e.message}`); return null; });
    setStocktake(null);
    if (r) {
      toast(r.changed ? `${r.changed} status change(s)` : 'All good - nothing changed', r.event_id ?? undefined);
      refresh();
    }
  };

  return (
    <div className="page">
      <Breadcrumb trail={breadcrumb} />

      <div className="area-head">
        {area.cover_thumb ? <img className="area-cover" src={area.cover_url} alt="" /> : null}
        <div>
          <h1 onClick={rename} className="editable">{area.name ?? 'unnamed area'}</h1>
          {area.label_code && <span className="badge">{area.label_code}</span>}
          {data.archived && <span className="badge warn">hidden</span>}
        </div>
      </div>

      <div className="row">
        <button className="btn" onClick={() => {
          setCurrentArea({ id, name: area.name, thumb: area.cover_thumb });
          toast(`Filing into ${area.name ?? 'area'}`);
          nav('/');
        }}>
          File things here
        </button>
        <CaptureInput onCapture={uploadPhoto}>Add photo</CaptureInput>
        <button className="btn" onClick={rename}>Rename</button>
      </div>
      <div className="row">
        <button className="btn" onClick={() => setScanFor('move-area')}>Move area…</button>
        <button className="btn" onClick={addSubarea}>+ Sub-area</button>
        {items.length > 0 && !stocktake && (
          <button className="btn" onClick={startStocktake}>Stocktake</button>
        )}
        <button className="btn danger" onClick={archive}>Hide</button>
      </div>

      {subareas.length > 0 && (
        <>
          <h2>Inside</h2>
          <ItemGrid
            items={subareas.map((a: any) => ({ id: a.id, name: a.name, thumb: a.cover_thumb, sub: a.label_code }))}
            linkTo={(aid) => `/areas/${aid}`}
          />
        </>
      )}

      <div className="row spread">
        <h2>
          {stocktake ? `${stocktake.size}/${items.length} present` : `${items.length} item${items.length === 1 ? '' : 's'}`}
        </h2>
        {items.length > 0 &&
          (stocktake ? (
            <>
              <button className="btn" onClick={confirmStocktake}>Confirm</button>
              <button className="btn" onClick={() => setStocktake(null)}>Cancel</button>
            </>
          ) : selecting ? (
            <>
              <button className="btn" onClick={() => setScanFor('move-items')} disabled={!selecting.size}>
                Move {selecting.size}…
              </button>
              <button className="btn" onClick={() => setSelecting(null)}>Cancel</button>
            </>
          ) : (
            <button className="btn" onClick={() => setSelecting(new Set())}>Select</button>
          ))}
      </div>
      {stocktake && <p className="muted">Untick anything that's missing - it gets flagged unaccounted.</p>}
      <ItemGrid
        items={items.map((i: any) => ({
          id: i.id,
          name: i.name,
          thumb: i.thumb,
          badge: i.status !== 'home' ? (i.status === 'lent' ? `→ ${i.lent_to ?? '?'}` : 'out') : undefined,
          sub: i.quantity > 1 ? `×${i.quantity}` : undefined,
        }))}
        linkTo={(iid) => `/items/${iid}`}
        selected={stocktake ?? selecting ?? undefined}
        onToggle={(stocktake ?? selecting) ? (iid) => {
          const set = stocktake ? setStocktake : setSelecting;
          set((s) => {
            const n = new Set(s);
            n.has(iid) ? n.delete(iid) : n.add(iid);
            return n;
          });
        } : undefined}
      />

      {scanFor && (
        <Scanner
          onResult={onScan}
          onClose={() => setScanFor(null)}
          hint={scanFor === 'move-area' ? 'Scan the new parent area' : 'Scan destination area'}
        />
      )}
    </div>
  );
}
