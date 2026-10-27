import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';
import { parseScan } from '../scan';
import { Scanner } from '../components/Scanner';
import { Breadcrumb, CaptureInput, ItemGrid } from '../components/Bits';

export function AreaPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { setCurrentArea, toast } = useApp();
  const [selecting, setSelecting] = useState<Set<string> | null>(null);
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
    // move-items
    for (const itemId of selecting ?? []) {
      const r = await api.patch(`/api/items/${itemId}`, { area_id: dest });
      toast(`Moved ${selecting?.size ?? 0} item(s)`, r.event_ids?.[0]);
    }
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
    form.append('photo', blob, 'photo.jpg');
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
        <h2>{items.length} item{items.length === 1 ? '' : 's'}</h2>
        {items.length > 0 &&
          (selecting ? (
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
      <ItemGrid
        items={items.map((i: any) => ({
          id: i.id,
          name: i.name,
          thumb: i.thumb,
          badge: i.status !== 'home' ? (i.status === 'lent' ? `→ ${i.lent_to ?? '?'}` : 'out') : undefined,
          sub: i.quantity > 1 ? `×${i.quantity}` : undefined,
        }))}
        linkTo={(iid) => `/items/${iid}`}
        selected={selecting ?? undefined}
        onToggle={selecting ? (iid) => setSelecting((s) => {
          const n = new Set(s);
          n.has(iid) ? n.delete(iid) : n.add(iid);
          return n;
        }) : undefined}
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
