import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';
import { downscale } from '../image';
import { parseScan } from '../scan';
import { Scanner } from '../components/Scanner';
import { Breadcrumb, CaptureInput, Icon, IconBtn, ItemGrid, KebabMenu, PrintDialog, usePrompt } from '../components/Bits';

export function AreaPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { setCurrentArea, toast } = useApp();
  const [askPrompt, promptUi] = usePrompt();
  const [selecting, setSelecting] = useState<Set<string>>(new Set());
  // Stocktake mode: set of item ids confirmed physically present. Persisted
  // to localStorage so a distracted walk-away doesn't lose the ticks.
  const [stocktake, setStocktake] = useState<Set<string> | null>(null);
  const [stocktakeReview, setStocktakeReview] = useState(false);
  const [markMissing, setMarkMissing] = useState(true);
  const [deep, setDeep] = useState(false);
  const [scanFor, setScanFor] = useState<null | 'set-current' | 'move-items' | 'move-area' | 'merge'>(null);
  const [printDlg, setPrintDlg] = useState(false);
  const [printCode, setPrintCode] = useState<string | null>(null);
  const [editDlg, setEditDlg] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', category: '', tags: '' });

  const stocktakeKey = `stache:stocktake:${id}`;

  // Restore an in-progress stocktake after a reload/app switch.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(stocktakeKey);
      if (saved) setStocktake(new Set(JSON.parse(saved) as string[]));
    } catch { /* corrupt entry - start fresh */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const persistStocktake = (s: Set<string> | null) => {
    setStocktake(s);
    try {
      if (s) localStorage.setItem(stocktakeKey, JSON.stringify([...s]));
      else localStorage.removeItem(stocktakeKey);
    } catch { /* storage full - non-fatal */ }
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ['area', id, deep],
    queryFn: () => api.get(`/api/areas/${id}${deep ? '?deep=1' : ''}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['area', id] });
  const { data: printerData } = useQuery({ queryKey: ['printers'], queryFn: () => api.get('/api/printers') });
  const { data: templatesData } = useQuery({ queryKey: ['sheet-templates'], queryFn: () => api.get('/api/sheet-templates') });

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

  const useDest = async (mode: NonNullable<typeof scanFor>, dest: string) => {
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
    if (mode === 'merge') {
      const r = await api
        .post(`/api/areas/${id}/merge`, { into_id: dest })
        .catch((e) => (toast(`Merge failed: ${(e as Error).message}`), null));
      if (r) {
        toast(`Merged into ${r.into?.name ?? 'area'}`, r.event_id);
        qc.invalidateQueries({ queryKey: ['areas'] });
        nav(`/areas/${dest}`, { replace: true });
      }
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
    setSelecting(new Set());
    refresh();
    qc.invalidateQueries({ queryKey: ['area', dest] });
  };

  const onScan = async (text: string) => {
    const mode = scanFor;
    setScanFor(null);
    const scan = parseScan(text);
    if (!scan || scan.kind !== 'label' || !mode) return;
    const dest = await resolveLabelArea(scan.code);
    if (dest) await useDest(mode, dest);
  };

  const onPickBin = async (dest: string) => {
    const mode = scanFor;
    setScanFor(null);
    if (mode) await useDest(mode, dest);
  };

  const openEdit = () => {
    setEditForm({
      name: area.name ?? '',
      category: area.category ?? '',
      tags: (area.tags ?? []).join(', '),
    });
    setEditDlg(true);
  };
  const saveEdit = async () => {
    const r = await api.patch(`/api/areas/${id}`, {
      name: editForm.name.trim() || null,
      category: editForm.category.trim() || null,
      tags: editForm.tags.split(',').map((t) => t.trim()).filter(Boolean),
    });
    toast('Saved', r.event_ids?.[0]);
    setEditDlg(false);
    refresh();
  };

  const uploadPhoto = async (blob: Blob) => {
    const form = new FormData();
    form.append('photo', await downscale(blob), 'photo.jpg');
    await api.upload(`/api/areas/${id}/photos`, form).catch((e) => toast(e.message));
    refresh();
  };

  const archive = async () => {
    const r = await api.del(`/api/areas/${id}`);
    toast('Area deleted', r.event_id);
    nav(-1);
  };

  const addSubarea = async () => {
    const name = await askPrompt('Sub-area name');
    if (name === null) return;
    await api.post('/api/areas', { parent_id: id, name: name || null }).then(() => refresh());
  };

  // Stocktake: everything starts ticked (assume it's all there), the user
  // unticks what's missing, reviews the count, then commits - unticked items
  // get flagged unaccounted unless they opt out.
  const startStocktake = () => {
    setSelecting(new Set());
    setDeep(false);
    persistStocktake(new Set(items.map((i: any) => i.id)));
  };
  const confirmStocktake = async () => {
    const r = await api
      .post(`/api/areas/${id}/stocktake`, {
        present_ids: [...(stocktake ?? [])],
        mark_unaccounted: markMissing,
      })
      .catch((e) => { toast(`Stocktake failed: ${e.message}`); return null; });
    persistStocktake(null);
    setStocktakeReview(false);
    if (r) {
      toast(r.changed ? `${r.changed} status change(s)` : 'All good - nothing changed', r.event_id ?? undefined);
      refresh();
    }
  };

  return (
    <div className="page">
      <Breadcrumb trail={breadcrumb} />

      <div className="area-head">
        <label className="area-cover-wrap" title="Change photo" aria-label="Change photo">
          {area.cover_thumb ? (
            <>
              <img className="area-cover" src={area.cover_url} alt="" />
              <span className="photo-replace"><Icon name="camera" size={14} /></span>
            </>
          ) : (
            <>
              <img className="area-cover ph-logo" src="/icon.svg" alt="" />
              <span className="cover-cam"><Icon name="camera" size={22} /></span>
            </>
          )}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadPhoto(f);
              e.target.value = '';
            }}
          />
        </label>
        <div>
          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
            <h1>{area.name ?? 'unnamed area'}</h1>
            <IconBtn icon="pencil" label="Edit area" onClick={openEdit} />
          </div>
          {area.category && <div className="muted">{area.category}</div>}
          {(area.tags ?? []).map((t: string) => (
            <span key={t} className="badge">{t}</span>
          ))}
          {(data.label_codes ?? [area.label_code].filter(Boolean)).map((c: string) => (
            <span key={c} className="badge">{c}</span>
          ))}
          {data.archived && <span className="badge warn">hidden</span>}
        </div>
      </div>

      <div className="row">
        <button className="btn btn-primary" onClick={() => {
          setCurrentArea({ id, name: area.name, thumb: area.cover_thumb });
          toast(`Filing into ${area.name ?? 'area'}`);
          nav('/');
        }}>
          Add items to {area.name ?? 'this area'}
        </button>
        <KebabMenu
          className="page-menu"
          label="Area actions"
          items={[
            { label: 'Print QR code', icon: 'printer', onSelect: async () => {
              if (!area.label_code && !(data.label_codes ?? []).length) {
                try {
                  const r = await api.post('/api/labels/batch', { count: 1 });
                  const code = r?.labels?.[0];
                  if (!code) throw new Error('no code minted');
                  await api.post(`/api/labels/${code}/assign`, { area_id: area.id });
                  setPrintCode(code);
                  await qc.invalidateQueries({ queryKey: ['area', id] });
                } catch (e) {
                  toast(`Couldn't create a label: ${(e as Error).message}`);
                  return;
                }
              }
              setPrintDlg(true);
            } },
            { label: 'Move area…', onSelect: () => setScanFor('move-area') },
            { label: 'Merge into…', onSelect: () => setScanFor('merge') },
            { label: '+ Sub-area', onSelect: addSubarea },
            ...(items.length > 0 && !stocktake
              ? [{ label: 'Stocktake', onSelect: startStocktake }]
              : []),
            'sep',
            { label: 'Delete', icon: 'trash', danger: true, onSelect: archive },
          ]}
        />
      </div>

      {editDlg && (
        <div className="dlg-overlay" onClick={() => setEditDlg(false)}>
          <div className="dlg" role="dialog" aria-label="Edit area" onClick={(e) => e.stopPropagation()}>
            <h2>Edit area</h2>
            <label className="muted">Name</label>
            <input
              className="input"
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              placeholder="e.g. Christmas bin"
              autoFocus
            />
            <label className="muted">Category <span style={{ opacity: 0.7 }}>(prints on the label)</span></label>
            <input
              className="input"
              value={editForm.category}
              onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}
              placeholder="e.g. Christmas"
            />
            <label className="muted">Tags</label>
            <div className="row" style={{ gap: 6 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                value={editForm.tags}
                onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })}
                placeholder="christmas, electronics, fragile…"
              />
              <button
                className="btn btn-small btn-ghost"
                onClick={async () => {
                  const r = await api.get(`/api/areas/${id}/suggest-tags`).catch(() => null);
                  const sug: string[] = r?.suggestions ?? [];
                  if (!sug.length) return toast("No suggestions from this area's items");
                  const cur = editForm.tags.split(',').map((t) => t.trim()).filter(Boolean);
                  setEditForm({ ...editForm, tags: [...new Set([...cur, ...sug])].join(', ') });
                }}
                title="Suggest tags from items in this area"
              >
                Suggest
              </button>
            </div>
            <div className="row">
              <button className="btn" onClick={() => void saveEdit()}>Save</button>
              <button className="btn" onClick={() => setEditDlg(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {subareas.length > 0 && (
        <>
          <h2>Inside</h2>
          <ItemGrid
            items={subareas.map((a: any) => ({
              id: a.id,
              name: a.name,
              thumb: a.cover_thumb,
              grid: a.cover_grid,
              sub: a.item_count
              ? a.own_count != null && a.own_count !== a.item_count
                ? `${a.own_count} here · ${a.item_count} total`
                : `${a.item_count} item${a.item_count === 1 ? '' : 's'}`
              : undefined,
            }))}
            linkTo={(aid) => `/areas/${aid}`}
            placeholderLogo
          />
        </>
      )}

      <div className="row spread">
        <h2>
          {stocktake
            ? `${stocktake.size}/${items.length} present`
            : `${items.length} item${items.length === 1 ? '' : 's'}${deep ? ' (incl. sub-areas)' : ''}`}
        </h2>
        {subareas.length > 0 && !stocktake && (
          <label className="row muted" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={deep}
              onChange={(e) => setDeep(e.target.checked)}
            />
            include sub-areas
          </label>
        )}
      </div>
      {stocktake ? (
        <div className="selection-bar">
          <span className="muted">{stocktake.size}/{items.length} present</span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => setStocktakeReview(true)}>Review…</button>
          <button className="btn btn-ghost" onClick={() => persistStocktake(null)}>Done</button>
        </div>
      ) : selecting.size > 0 ? (
        <div className="selection-bar">
          <button
            className={`sel-all${selecting.size === items.length ? ' on' : ''}`}
            onClick={() =>
              setSelecting(selecting.size === items.length ? new Set() : new Set(items.map((i: any) => i.id)))
            }
          >
            Select all
          </button>
          <span className="muted">{selecting.size} selected</span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => setScanFor('move-items')}>Move…</button>
          <button
            className="btn danger"
            onClick={async () => {
              const ids = [...selecting];
              let failed = 0;
              let lastEvent: string | undefined;
              for (const itemId of ids) {
                const r = await api.del(`/api/items/${itemId}`).catch(() => null);
                if (r) lastEvent = r.event_id;
                else failed++;
              }
              if (ids.length === 1 && !failed) toast('Hidden', lastEvent);
              else toast(`Hidden ${ids.length - failed}/${ids.length} item(s)`);
              setSelecting(new Set());
              refresh();
            }}
          >
            Hide
          </button>
          <button className="btn btn-ghost" onClick={() => setSelecting(new Set())}>Done</button>
        </div>
      ) : null}
      {area.last_audit_at && !stocktake && (
        <p className="muted">Last checked {new Date(area.last_audit_at).toLocaleDateString()}</p>
      )}
      {stocktake && !stocktakeReview && (
        <p className="muted">Untick anything that's missing, then Review.</p>
      )}
      {stocktakeReview && stocktake && (
        <div className="suggest">
          <p>
            <b>{stocktake.size}</b> present ·{' '}
            <b>{items.length - stocktake.size}</b> unticked
          </p>
          {items.length - stocktake.size > 0 && (
            <label className="row">
              <input
                type="checkbox"
                checked={markMissing}
                onChange={(e) => setMarkMissing(e.target.checked)}
              />
              Flag the unticked {items.length - stocktake.size} as unaccounted
            </label>
          )}
          <div className="row">
            <button className="btn" onClick={confirmStocktake}>Confirm</button>
            <button className="btn" onClick={() => setStocktakeReview(false)}>Back</button>
          </div>
        </div>
      )}
      <ItemGrid
        items={items.map((i: any) => ({
          id: i.id,
          name: i.name,
          ai_name: i.ai_name,
          thumb: i.thumb,
          badge: i.status !== 'home' ? (i.status === 'lent' ? `→ ${i.lent_to ?? '?'}` : 'out') : undefined,
          sub: [i.area_name, i.quantity > 1 ? `×${i.quantity}` : null].filter(Boolean).join(' · ') || undefined,
        }))}
        linkTo={(iid) => `/items/${iid}`}
        selectable
        forceSelect={!!stocktake && !stocktakeReview}
        selected={stocktake ?? selecting}
        onToggle={(stocktake ?? selecting) && !stocktakeReview ? (iid) => {
          const next = new Set(stocktake ?? selecting ?? []);
          next.has(iid) ? next.delete(iid) : next.add(iid);
          if (stocktake) persistStocktake(next);
          else setSelecting(next);
        } : undefined}
      />

      <PrintDialog
        open={printDlg}
        onClose={() => setPrintDlg(false)}
        printers={printerData?.printers ?? []}
        defaultId={printerData?.default_id}
        presets={templatesData?.templates ?? []}
        labels={[printCode ?? area.label_code ?? (data.label_codes ?? [])[0]].filter((c): c is string => !!c).map((code: string) => ({
          code,
          name: area.name ?? null,
          path: (breadcrumb ?? []).slice(0, -1).map((c: any) => c.name ?? 'unnamed').join(' / ') || null,
          category: area.category ?? null,
        }))}
      />
      {scanFor && (
        <Scanner
          onResult={onScan}
          onClose={() => setScanFor(null)}
          hint={scanFor === 'merge' ? 'Scan (or pick) the area to merge into' : scanFor === 'move-area' ? 'Scan the new parent area' : 'Scan destination area'}
          onPickBin={onPickBin}
        />
      )}
      {promptUi}
    </div>
  );
}
