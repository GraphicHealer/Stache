import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';
import { Icon, ItemGrid, PrintDialog, usePrompt } from '../components/Bits';

export function BrowsePage() {
  const qc = useQueryClient();
  const { toast } = useApp();
  const [askPrompt, promptUi] = usePrompt();
  const { data, isLoading } = useQuery({ queryKey: ['areas'], queryFn: () => api.get('/api/areas') });
  const { data: printerData } = useQuery({ queryKey: ['printers'], queryFn: () => api.get('/api/printers') });
  const { data: templatesData } = useQuery({ queryKey: ['sheet-templates'], queryFn: () => api.get('/api/sheet-templates') });
  const { data: labelsData } = useQuery({ queryKey: ['labels'], queryFn: () => api.get('/api/labels') });
  const [selecting, setSelecting] = useState<Set<string>>(new Set());
  const [printDlg, setPrintDlg] = useState(false);
  const [moveDlg, setMoveDlg] = useState(false);
  const [moveTarget, setMoveTarget] = useState('');
  const { data: allAreasData } = useQuery({
    queryKey: ['areas-all'],
    queryFn: () => api.get('/api/areas?all=1'),
    enabled: moveDlg,
  });

  const areas = data?.areas ?? [];
  const printers = printerData?.printers ?? [];
  const presets = templatesData?.templates ?? [];
  const labelByCode = new Map((labelsData?.labels ?? []).map((l: any) => [l.code, l]));

  const addArea = async () => {
    const name = await askPrompt('New area name');
    if (name === null) return;
    const r = await api.post('/api/areas', { name: name || null }).catch((e) => (toast(e.message), null));
    if (r?.area) qc.invalidateQueries({ queryKey: ['areas'] });
  };

  const toggle = (id: string) => {
    const next = new Set(selecting);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelecting(next);
  };
  const active = !!selecting?.size;

  // Only labelled bins can reprint - their QR sticker is the claim.
  const selectedCodes = selecting
    ? areas.filter((a: any) => selecting.has(a.id) && a.label_code).map((a: any) => a.label_code)
    : [];

  // Areas without a code get one minted + assigned, like the area page does.
  const [minting, setMinting] = useState(false);
  const openPrint = async () => {
    setMinting(true);
    try {
      for (const a of areas.filter((x: any) => selecting.has(x.id) && !x.label_code)) {
        const r = await api.post('/api/labels/batch', { count: 1 }).catch(() => null);
        const code = r?.labels?.[0];
        if (code) {
          await api.post(`/api/labels/${code}/assign`, { area_id: a.id }).catch(() => null);
          a.label_code = code;
        }
      }
      qc.invalidateQueries({ queryKey: ['areas'] });
      setPrintDlg(true);
    } finally {
      setMinting(false);
    }
  };

  return (
    <div className="page">
      <div className="row spread">
        <h1>Areas</h1>
        {!active && (
          <button className="btn has-icon" onClick={addArea}>
            <Icon name="plus" /> New area
          </button>
        )}
      </div>
      {active && (
        <div className="selection-bar">
          <button
            className={`sel-all${selecting.size === areas.length && areas.length ? ' on' : ''}`}
            onClick={() =>
              setSelecting(selecting.size === areas.length ? new Set() : new Set(areas.map((a: any) => a.id)))
            }
          >
            Select all
          </button>
          <span className="muted">{selecting.size} selected</span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => { setMoveTarget(''); setMoveDlg(true); }}>
            Move into…
          </button>
          <button className="btn" disabled={minting} onClick={() => void openPrint()}>
            {minting ? 'Making codes…' : `Print ${selecting.size}`}
          </button>
          <button className="btn btn-ghost" onClick={() => setSelecting(new Set())}>Done</button>
        </div>
      )}
      {isLoading && <p className="muted">Loading…</p>}
      <ItemGrid
        items={areas.map((a: any) => ({
          id: a.id,
          name: a.name,
          thumb: a.cover_thumb,
          sub: a.item_count
              ? a.own_count != null && a.own_count !== a.item_count
                ? `${a.own_count} here · ${a.item_count} total`
                : `${a.item_count} item${a.item_count === 1 ? '' : 's'}`
              : undefined,
        }))}
        linkTo={(id) => `/areas/${id}`}
        placeholderLogo
        selectable
        selected={selecting}
        onToggle={toggle}
      />
      {!active && (
        <p className="muted">Long-press an area to select, or add an area / scan an unclaimed QR label.</p>
      )}
      {moveDlg && (
        <div className="dlg-overlay" onClick={() => setMoveDlg(false)}>
          <div className="dlg" role="dialog" aria-label="Move areas" onClick={(e) => e.stopPropagation()}>
            <h2>Move {selecting.size} area{selecting.size === 1 ? '' : 's'} into…</h2>
            <select
              className="input"
              value={moveTarget}
              onChange={(e) => setMoveTarget(e.target.value)}
              autoFocus
            >
              <option value="">Top level (no parent)</option>
              {(allAreasData?.areas ?? [])
                .filter((a: any) => !selecting.has(a.id))
                .map((a: any) => (
                  <option key={a.id} value={a.id}>{a.name ?? 'unnamed'}</option>
                ))}
            </select>
            <div className="row">
              <button
                className="btn"
                onClick={async () => {
                  for (const aid of selecting) {
                    await api
                      .patch(`/api/areas/${aid}`, { parent_id: moveTarget || null })
                      .catch((e) => toast(e.message));
                  }
                  qc.invalidateQueries({ queryKey: ['areas'] });
                  qc.invalidateQueries({ queryKey: ['areas-all'] });
                  setMoveDlg(false);
                  setSelecting(new Set());
                }}
              >
                Move
              </button>
              <button className="btn" onClick={() => setMoveDlg(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      <PrintDialog
        open={printDlg}
        onClose={() => { setPrintDlg(false); setSelecting(new Set()); }}
        printers={printers}
        defaultId={printerData?.default_id}
        presets={presets}
        labels={selectedCodes.map((code: string) => {
          const l: any = labelByCode.get(code);
          const a: any = areas.find((x: any) => x.label_code === code);
          return { code, name: l?.area_name ?? a?.name ?? null, path: l?.area_path ?? null, category: l?.area_category ?? a?.category ?? null };
        })}
      />
      {promptUi}
    </div>
  );
}
