import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';
import { Icon, ItemGrid, KebabMenu } from '../components/Bits';
import { resolveSheet } from '../lib/sheets';

export function BrowsePage() {
  const qc = useQueryClient();
  const { toast } = useApp();
  const { data, isLoading } = useQuery({ queryKey: ['areas'], queryFn: () => api.get('/api/areas') });
  const { data: printerData } = useQuery({ queryKey: ['printers'], queryFn: () => api.get('/api/printers') });
  const { data: templatesData } = useQuery({ queryKey: ['sheet-templates'], queryFn: () => api.get('/api/sheet-templates') });
  const { data: labelsData } = useQuery({ queryKey: ['labels'], queryFn: () => api.get('/api/labels') });
  const [selecting, setSelecting] = useState<Set<string> | null>(null);

  const areas = data?.areas ?? [];
  const printers = printerData?.printers ?? [];
  const presets = templatesData?.templates ?? [];
  const labelByCode = new Map((labelsData?.labels ?? []).map((l: any) => [l.code, l]));

  const addArea = async () => {
    const name = window.prompt('New area name? (optional)') ?? null;
    if (name === null) return;
    const r = await api.post('/api/areas', { name: name || null }).catch((e) => (toast(e.message), null));
    if (r?.area) qc.invalidateQueries({ queryKey: ['areas'] });
  };

  // Only labelled bins can reprint - their QR sticker is the claim.
  const selectedCodes = selecting
    ? areas.filter((a: any) => selecting.has(a.id) && a.label_code).map((a: any) => a.label_code)
    : [];

  const reprint = async (p: any) => {
    if (!selectedCodes.length) return;
    if (p.id === 'pc') {
      const spec = p.media_type === 'sheet' ? resolveSheet(p.sheet, presets) : null;
      sessionStorage.setItem(
        'stache:print-sheet',
        JSON.stringify({
          mode: p.media_type === 'label' ? 'label' : 'sheet',
          spec,
          labelW: p.label_w_mm ?? 57,
          labelH: p.label_h_mm ?? 32,
          labels: selectedCodes.map((code: string) => {
            const l: any = labelByCode.get(code);
            return { code, name: l?.area_name ?? null, path: l?.area_path ?? null, category: l?.area_category ?? null };
          }),
        }),
      );
      window.open('/print/labels', '_blank');
      setSelecting(null);
      return;
    }
    try {
      if (p.type === 'dymo') {
        const { dymoPrintLabels } = await import('../dymo');
        await dymoPrintLabels(p.name, selectedCodes, window.location.origin);
      } else {
        await api.post('/api/labels/print', { printer_id: p.id, codes: selectedCodes });
      }
      toast(`Sent ${selectedCodes.length} label(s) to ${p.name}`);
      setSelecting(null);
    } catch (e) {
      toast(`Print failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="page">
      <div className="row spread">
        <h1>Areas</h1>
        <span className="row" style={{ margin: 0 }}>
          {selecting ? (
            <>
              <KebabMenu
                label={`Reprint ${selectedCodes.length} label(s)`}
                items={printers.map((p: any) => ({
                  label: `→ ${p.name}`,
                  onSelect: () => void reprint(p),
                }))}
              />
              <button className="btn" onClick={() => setSelecting(null)}>Cancel</button>
            </>
          ) : (
            <>
              {areas.some((a: any) => a.label_code) && (
                <button className="btn" onClick={() => setSelecting(new Set())}>Select</button>
              )}
              <button className="btn has-icon" onClick={addArea}>
                <Icon name="plus" /> New area
              </button>
            </>
          )}
        </span>
      </div>
      {isLoading && <p className="muted">Loading…</p>}
      <ItemGrid
        items={areas.map((a: any) => ({
          id: a.id,
          name: a.name,
          thumb: a.cover_thumb,
          sub: a.label_code ?? undefined,
        }))}
        linkTo={(id) => `/areas/${id}`}
        selected={selecting ?? undefined}
        onToggle={
          selecting
            ? (id) => {
                const next = new Set(selecting);
                next.has(id) ? next.delete(id) : next.add(id);
                setSelecting(next);
              }
            : undefined
        }
      />
      <p className="muted">
        {selecting ? 'Select bins to reprint their labels.' : 'Add an area above, or scan an unclaimed QR label.'}
      </p>
    </div>
  );
}
