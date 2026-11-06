import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useApp } from '../../context';
import { dymoPrintLabels, dymoProbe } from '../../dymo';
import { IconBtn, useConfirm } from '../../components/Bits';
import { PAGE_SIZES, resolveSheet, type SheetChoice, type SheetPreset, type SheetSpec } from '../../lib/sheets';
import { SettingsShell } from './SettingsShell';

interface Printer {
  id: string;
  name: string;
  type: 'zpl' | 'zpl-legacy' | 'cups' | 'dymo' | 'pc';
  builtin?: boolean;
  host: string | null;
  port: number;
  queue: string | null;
  dpi: number;
  label_w_mm: number;
  label_h_mm: number;
  top_offset_mm?: number | null;
  left_offset_mm?: number | null;
  right_offset_mm?: number | null;
  bottom_offset_mm?: number | null;
  media_type?: 'label' | 'sheet';
  sheet?: SheetChoice | null;
}

const EMPTY_FORM = {
  name: '', type: 'zpl', host: '', port: '9100', queue: '', dpi: '203',
  label_w_mm: '57', label_h_mm: '32', media: 'label',
  top_offset_mm: '1', left_offset_mm: '1', right_offset_mm: '1', bottom_offset_mm: '1',
};

interface SheetForm { preset: string; custom: Record<string, string>; }
const EMPTY_SHEET: SheetForm = { preset: 'avery-5160', custom: {} };

type MarginValues = {
  top_offset_mm: string; left_offset_mm: string;
  right_offset_mm: string; bottom_offset_mm: string;
};

function MarginBox({ values, onChange }: {
  values: MarginValues;
  onChange: (k: keyof MarginValues, v: string) => void;
}) {
  const box = (k: keyof MarginValues, edge: 'top' | 'left' | 'right' | 'bottom') => (
    <input className="input" inputMode="decimal"
      style={{ gridArea: edge, width: 58, minHeight: 36, textAlign: 'center' }}
      value={values[k]} onChange={(e) => onChange(k, e.target.value)}
      aria-label={`${edge} margin mm`} title={`${edge} margin (mm)`} />
  );
  return (
    <div style={{
      display: 'grid', gap: 4, alignItems: 'center', justifyItems: 'center',
      gridTemplateAreas: `'. top .' 'left c right' '. bottom .'`,
    }}>
      {box('top_offset_mm', 'top')}
      {box('left_offset_mm', 'left')}
      <span className="muted" style={{ gridArea: 'c', fontSize: '0.75rem', textAlign: 'center', lineHeight: 1.2 }}>
        margins<br />mm
      </span>
      {box('right_offset_mm', 'right')}
      {box('bottom_offset_mm', 'bottom')}
    </div>
  );
}

function SheetPicker({
  value, onChange, presets,
}: { value: SheetForm; onChange: (v: SheetForm) => void; presets: SheetPreset[] }) {
  const { toast } = useApp();
  const qc = useQueryClient();
  const [saveName, setSaveName] = useState('');
  const c = value.custom;
  const save = async () => {
    const spec = resolveSheet({ preset: 'custom', custom: c }, presets);
    if (!spec || !saveName.trim()) return;
    try {
      const r = await api.post('/api/sheet-templates', { name: saveName.trim(), spec });
      setSaveName('');
      qc.invalidateQueries({ queryKey: ['sheet-templates'] });
      onChange({ ...value, preset: r.id });
      toast('Preset saved - available on all sheet printers');
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`);
    }
  };
  const remove = async () => {
    try {
      await api.del(`/api/sheet-templates/${value.preset}`);
      qc.invalidateQueries({ queryKey: ['sheet-templates'] });
      onChange({ ...value, preset: 'custom' });
      toast('Preset deleted');
    } catch (e) {
      toast(`Delete failed: ${(e as Error).message}`);
    }
  };
  const setC = (k: string, v: string) => onChange({ ...value, custom: { ...c, [k]: v } });
  const num = (k: string, label: string, w = 56) => (
    <label key={k} className="muted" style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.8rem' }}>
      {label}
      <input className="input" style={{ width: w, minHeight: 36 }} inputMode="decimal" value={c[k] ?? ''} onChange={(e) => setC(k, e.target.value)} />
    </label>
  );
  return (
    <>
      <div className="row">
        <select className="input" style={{ width: 'auto', flex: 1 }} value={value.preset} aria-label="Sheet template"
          onChange={(e) => onChange({ ...value, preset: e.target.value })}>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          <option value="custom">Custom…</option>
        </select>
      </div>
      {value.preset === 'custom' && (
        <>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {num('cellW', 'cell w')} {num('cellH', 'h')}
          {num('cols', 'cols', 44)} {num('rows', 'rows', 44)}
          {num('gapX', 'gap x')} {num('gapY', 'gap y')}
          {num('marginTop', 'top')} {num('marginX', 'side')}
          <select className="input" style={{ width: 'auto', minHeight: 36 }} value={c.page ?? 'letter'}
            onChange={(e) => setC('page', e.target.value)} aria-label="Page size">
            <option value="letter">Letter</option>
            <option value="a4">A4</option>
          </select>
        </div>
        <SheetPreview spec={resolveSheet({ preset: 'custom', custom: c }, presets)} />
        <div className="row" style={{ gap: 8 }}>
          <input className="input" style={{ flex: 1, minHeight: 36 }} placeholder="Save as preset (e.g. My drawer labels)"
            value={saveName} onChange={(e) => setSaveName(e.target.value)} />
          <button className="btn" disabled={!saveName.trim()} onClick={save}>Save preset</button>
        </div>
      </>
      )}
      {value.preset.startsWith('custom-') && (
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-ghost" onClick={remove}>Delete saved preset</button>
        </div>
      )}
    </>
  );
}

function SheetPreview({ spec }: { spec: SheetSpec | null }) {
  if (!spec) return null;
  const page = PAGE_SIZES[spec.page];
  const scale = 130 / page.w;
  return (
    <div className="muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>
      {spec.cols}&times;{spec.rows} = {spec.cols * spec.rows} labels &middot; {spec.cellW}&times;{spec.cellH}mm cells on {page.w}&times;{page.h}mm
      <div style={{
        width: `${page.w * scale}px`, height: `${page.h * scale}px`, background: '#fff',
        border: '1px solid #555', margin: '4px auto', boxSizing: 'border-box',
        padding: `${spec.marginTop * scale}px ${spec.marginX * scale}px`,
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${spec.cols}, ${spec.cellW * scale}px)`, gap: `${spec.gapY * scale}px ${spec.gapX * scale}px` }}>
          {Array.from({ length: spec.cols * spec.rows }).map((_, i) => (
            <div key={i} style={{ width: `${spec.cellW * scale}px`, height: `${spec.cellH * scale}px`, border: '1px dashed #999', boxSizing: 'border-box' }} />
          ))}
        </div>
      </div>
    </div>
  );
}

const sheetChoice = (f: SheetForm): SheetChoice =>
  f.preset === 'custom'
    ? {
        custom: Object.fromEntries(
          Object.entries(f.custom)
            .filter(([, v]) => v !== '')
            .map(([k, v]) => [k, k === 'page' ? v : Number(v)]),
        ),
      }
    : { preset: f.preset };

/** Printer management: add/edit/remove printers, probe sizes, test prints. */
export function PrinterSettings() {
  const qc = useQueryClient();
  const { toast } = useApp();
  const [askConfirm, confirmUi] = useConfirm();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [progress, setProgress] = useState<string | null>(null);
  const [editPc, setEditPc] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [editSheet, setEditSheet] = useState<SheetForm>(EMPTY_SHEET);
  const [pcForm, setPcForm] = useState<{ media: 'label' | 'sheet'; sheet: SheetForm; w: string; h: string; dpi: string; mt: string; ml: string; mr: string; mb: string }>({
    media: 'sheet', sheet: EMPTY_SHEET, w: '57', h: '32', dpi: '300', mt: '1', ml: '1', mr: '1', mb: '1',
  });
  const [sheetForm, setSheetForm] = useState<SheetForm>(EMPTY_SHEET);

  const { data: printerData, refetch: refetchPrinters } = useQuery({
    queryKey: ['printers'],
    queryFn: () => api.get('/api/printers'),
  });
  const { data: templatesData } = useQuery({
    queryKey: ['sheet-templates'],
    queryFn: () => api.get('/api/sheet-templates'),
  });
  const { data: labelData } = useQuery({ queryKey: ['labels'], queryFn: () => api.get('/api/labels') });
  const presets: SheetPreset[] = templatesData?.templates ?? [];
  const printers: Printer[] = printerData?.printers ?? [];
  // Sample ZPL disclosure - developer detail, lazy-fetched on first open.
  const [zplRaw, setZplRaw] = useState<string | null>(null);
  const defP = printers.find((p) => p.id === printerData?.default_id) ?? printers[0];
  const zplDef = defP && (defP.type === 'zpl' || defP.type === 'zpl-legacy') ? defP : null;
  const loadZpl = async () => {
    const r = await api.get('/api/labels/preview').catch(() => null);
    setZplRaw(r?.zpl ?? 'No ZPL available.');
  };
  const labels = labelData?.labels ?? [];
  const pc = printers.find((p) => p.id === 'pc');
  const pcSpec = pc?.media_type === 'sheet' ? resolveSheet(pc.sheet, presets) : null;

  const addPrinter = async () => {
    try {
      await api.post('/api/printers', {
        name: form.name,
        type: form.type,
        host: form.host || null,
        port: parseInt(form.port, 10) || 9100,
        queue: form.queue || null,
        dpi: parseInt(form.dpi, 10) || 203,
        label_w_mm: parseFloat(form.label_w_mm) || 57,
        label_h_mm: parseFloat(form.label_h_mm) || 32,
        top_offset_mm: parseFloat(form.top_offset_mm) || 0,
        left_offset_mm: parseFloat(form.left_offset_mm) || 0,
        right_offset_mm: parseFloat(form.right_offset_mm) || 0,
        bottom_offset_mm: parseFloat(form.bottom_offset_mm) || 0,
        media_type: form.type === 'cups' ? form.media : 'label',
        sheet: form.type === 'cups' && form.media === 'sheet' ? sheetChoice(sheetForm) : null,
      });
      setAdding(false);
      setForm(EMPTY_FORM);
      refetchPrinters();
      toast('Printer added');
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`);
    }
  };

  // Hand the print job to /print/labels - it renders without the app shell.
  const openPrint = (codes: string[]) => {
    const isSheet = pc?.media_type !== 'label';
    sessionStorage.setItem(
      'stache:print-sheet',
      JSON.stringify({
        mode: isSheet ? 'sheet' : 'label',
        spec: isSheet ? pcSpec : null,
        labelW: pc?.label_w_mm ?? 57,
        labelH: pc?.label_h_mm ?? 32,
        margins: {
          top: pc?.top_offset_mm ?? 0,
          left: pc?.left_offset_mm ?? 0,
          right: pc?.right_offset_mm ?? 0,
          bottom: pc?.bottom_offset_mm ?? 0,
        },
        labels: codes.map((code) => ({
          code,
          name: nameFor(code),
          path: pathFor(code),
          category: categoryFor(code),
        })),
      }),
    );
    window.open('/print/labels', '_blank');
  };

  const printTo = async (p: Printer, codes: string[]) => {
    if (!codes.length) return;
    if (p.id === 'pc') return openPrint(codes);
    setBusy(true);
    try {
      if (p.type === 'dymo') {
        await dymoPrintLabels(p, codes, window.location.origin, (done, total) =>
          setProgress(`Printing ${done}/${total}…`),
        );
        setProgress(null);
      } else {
        await api.post('/api/labels/print', { printer_id: p.id, codes });
      }
      toast(`Sent ${codes.length} label(s) to ${p.name}`);
    } catch (e) {
      setProgress(null);
      toast(`Print failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // Read size/dpi from a Zebra - saved printer via /detect, unsaved via /probe.
  const probe = async (calibrate: boolean, target?: Printer) => {
    try {
      const body = target
        ? { calibrate }
        : { host: form.host, port: parseInt(form.port, 10) || 9100, calibrate, type: form.type };
      const r = target
        ? await api.post(`/api/printers/${target.id}/detect`, body)
        : await api.post('/api/printers/probe', body);
      toast(`Detected ${r.label_w_mm ?? '?'}×${r.label_h_mm ?? '?'}mm @ ${r.dpi}dpi`);
      const fill = (set: (v: any) => void, f: any) =>
        set({ ...f, label_w_mm: r.label_w_mm ? String(r.label_w_mm) : f.label_w_mm, label_h_mm: r.label_h_mm ? String(r.label_h_mm) : f.label_h_mm, dpi: String(r.dpi ?? f.dpi) });
      if (target) {
        fill(setEditForm, editForm);
        const saved = await api.patch(`/api/printers/${target.id}`, {
          label_w_mm: r.label_w_mm ?? undefined,
          label_h_mm: r.label_h_mm ?? undefined,
          dpi: r.dpi ?? undefined,
        }).catch((e) => (toast(`Save failed: ${e.message}`), null));
        if (saved !== null) toast('Detected values saved');
      } else {
        fill(setForm, form);
      }
      refetchPrinters();
    } catch (e) {
      toast(`Detect failed: ${(e as Error).message}`);
    }
  };

  // Client-side Dymo probe - the DYMO Connect service only exists on the
  // browser's machine, so this never goes through the server.
  const dymoRead = async (target?: Printer) => {
    try {
      const r = await dymoProbe(target ? target.name : form.name);
      toast(`DYMO ${r.connected ? 'connected' : 'not connected'}: ${r.label_w_mm ?? '?'}×${r.label_h_mm ?? '?'}mm @ ${r.dpi ?? '?'}dpi`);
      const fill = (set: (v: any) => void, f: any) =>
        set({ ...f, label_w_mm: r.label_w_mm ? String(r.label_w_mm) : f.label_w_mm, label_h_mm: r.label_h_mm ? String(r.label_h_mm) : f.label_h_mm, dpi: r.dpi ? String(r.dpi) : f.dpi });
      if (target) {
        fill(setEditForm, editForm);
        const saved = await api.patch(`/api/printers/${target.id}`, {
          label_w_mm: r.label_w_mm ?? undefined,
          label_h_mm: r.label_h_mm ?? undefined,
          dpi: r.dpi ?? undefined,
        }).catch((e) => (toast(`Save failed: ${e.message}`), null));
        if (saved !== null) toast('Detected values saved');
      } else {
        fill(setForm, form);
      }
      refetchPrinters();
    } catch (e) {
      toast(`Detect failed: ${(e as Error).message}`);
    }
  };

  const testPrinter = async (p: Printer) => {
    if (p.type === 'dymo') {
      await printTo(p, ['ST-SAMPLE22']);
      return;
    }
    try {
      await api.post(`/api/printers/${p.id}/test`);
      toast(`Test label sent to ${p.name}`);
    } catch (e) {
      toast(`Test failed: ${(e as Error).message}`);
    }
  };

  const labelFor = (code: string) => labels.find((l: any) => l.code === code);
  const nameFor = (code: string) => (labelFor(code)?.area_name as string | null) ?? null;
  const pathFor = (code: string) => (labelFor(code)?.area_path as string | null) ?? null;
  const categoryFor = (code: string) => (labelFor(code)?.area_category as string | null) ?? null;

  return (
    <SettingsShell title="Printers">
      <p className="muted">
        Label printers and print targets. Detect sizes, test prints, and edit
        connection details here - printing itself happens on the Labels page.
      </p>
      {printers.map((p) => (
        <div key={p.id}>
          <div className="label-row">
            <span>
              <b>{p.name}</b>{' '}
              <span className="muted">
                {p.type}
                {p.media_type === 'sheet' ? ' · sheet' : ''}
                {p.host ? ` · ${p.host}` : ''}
                {p.queue ? ` · ${p.queue}` : ''}
              </span>
            </span>
            <span className="row" style={{ margin: 0 }}>
              {p.id === 'pc' ? (
                <IconBtn
                  icon="pencil"
                  className="btn-small"
                  label="Configure PC printing"
                  onClick={() => {
                    setEditPc((v) => !v);
                    setPcForm({
                      media: p.media_type === 'label' ? 'label' : 'sheet',
                      sheet: p.sheet?.preset || p.sheet?.custom
                        ? { preset: p.sheet?.custom ? 'custom' : p.sheet!.preset!, custom: p.sheet?.custom ? Object.fromEntries(Object.entries(p.sheet.custom).map(([k, v]) => [k, String(v)])) : {} }
                        : EMPTY_SHEET,
                      w: String(p.label_w_mm ?? 57),
                      h: String(p.label_h_mm ?? 32),
                      mt: String(p.top_offset_mm ?? 0),
                      ml: String(p.left_offset_mm ?? 0),
                      mr: String(p.right_offset_mm ?? 0),
                      mb: String(p.bottom_offset_mm ?? 0),
                      dpi: String(p.dpi ?? 300),
                    });
                  }}
                />
              ) : (
                <>
                  <IconBtn
                    icon="pencil"
                    className="btn-small"
                    label={`Edit ${p.name}`}
                    onClick={() => {
                      const open = editId === p.id;
                      setEditId(open ? null : p.id);
                      if (!open) {
                        setEditForm({
                          name: p.name, type: p.type, host: p.host ?? '', port: String(p.port ?? 9100),
                          queue: p.queue ?? '', dpi: String(p.dpi ?? 203),
                          label_w_mm: String(p.label_w_mm ?? 57), label_h_mm: String(p.label_h_mm ?? 32),
                          top_offset_mm: String(p.top_offset_mm ?? 1),
                          left_offset_mm: String(p.left_offset_mm ?? 0),
                          right_offset_mm: String(p.right_offset_mm ?? 0),
                          bottom_offset_mm: String(p.bottom_offset_mm ?? 0),
                          media: p.media_type === 'sheet' ? 'sheet' : 'label',
                        });
                        setEditSheet(
                          p.sheet?.preset || p.sheet?.custom
                            ? { preset: p.sheet?.custom ? 'custom' : p.sheet!.preset!, custom: p.sheet?.custom ? Object.fromEntries(Object.entries(p.sheet.custom).map(([k, v]) => [k, String(v)])) : {} }
                            : EMPTY_SHEET,
                        );
                      }
                    }}
                  />
                  <IconBtn
                    icon="trash"
                    className="btn-small btn-ghost"
                    label={`Remove ${p.name}`}
                    onClick={async () => {
                      if (!(await askConfirm(`Delete printer "${p.name}"?`, 'Delete'))) return;
                      const r = await api.del(`/api/printers/${p.id}`).catch((e) => (toast(e.message), null));
                      if (!r) return;
                      refetchPrinters();
                      toast('Printer deleted');
                    }}
                  />
                </>
              )}
            </span>
          </div>
          {editId === p.id && (
            <div className="printer-form">
              <div className="row">
                <input className="input" style={{ flex: 1 }} placeholder="Printer name"
                  value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
              </div>
              {(editForm.type === 'zpl' || editForm.type === 'zpl-legacy') && (
                <div className="row">
                  <input className="input" style={{ flex: 1 }} placeholder="IP address"
                    value={editForm.host} onChange={(e) => setEditForm({ ...editForm, host: e.target.value })} />
                  <input className="input" style={{ width: 90 }} placeholder="9100"
                    value={editForm.port} onChange={(e) => setEditForm({ ...editForm, port: e.target.value })} />
                </div>
              )}
              {editForm.type === 'cups' && (
                <>
                  <div className="row">
                    <input className="input" style={{ flex: 1 }} placeholder="Queue name"
                      value={editForm.queue} onChange={(e) => setEditForm({ ...editForm, queue: e.target.value })} />
                    <input className="input" style={{ flex: 1 }} placeholder="CUPS server (optional)"
                      value={editForm.host} onChange={(e) => setEditForm({ ...editForm, host: e.target.value })} />
                  </div>
                  <div className="row">
                    <label className="muted">Media</label>
                    <select className="input" style={{ width: 'auto' }} value={editForm.media}
                      onChange={(e) => setEditForm({ ...editForm, media: e.target.value })}>
                      <option value="label">Single labels (label printer)</option>
                      <option value="sheet">Sheet (laser / Avery-style)</option>
                    </select>
                  </div>
                  {editForm.media === 'sheet' && (
                    <SheetPicker value={editSheet} onChange={setEditSheet} presets={presets} />
                  )}
                </>
              )}
              {(editForm.type !== 'cups' || editForm.media === 'label') && (
                <div className="row">
                  <label className="muted">Label mm</label>
                  <input className="input" style={{ width: 80 }} value={editForm.label_w_mm}
                    onChange={(e) => setEditForm({ ...editForm, label_w_mm: e.target.value })} />
                  <span className="muted">×</span>
                  <input className="input" style={{ width: 80 }} value={editForm.label_h_mm}
                    onChange={(e) => setEditForm({ ...editForm, label_h_mm: e.target.value })} />
                  <label className="muted">dpi</label>
                  <input className="input" style={{ width: 80 }} value={editForm.dpi}
                    onChange={(e) => setEditForm({ ...editForm, dpi: e.target.value })} aria-label="dots per inch" />
                  {(editForm.type === 'zpl' || editForm.type === 'zpl-legacy' || editForm.type === 'dymo') && (
                    <MarginBox values={editForm}
                      onChange={(k, v) => setEditForm({ ...editForm, [k]: v })} />
                  )}
                </div>
              )}
              <div className="row">
                <button className="btn" onClick={async () => {
                  try {
                    await api.patch(`/api/printers/${p.id}`, {
                      name: editForm.name, type: editForm.type,
                      host: editForm.host || null,
                      port: parseInt(editForm.port, 10) || 9100,
                      queue: editForm.queue || null,
                      dpi: parseInt(editForm.dpi, 10) || 203,
                      label_w_mm: parseFloat(editForm.label_w_mm) || 57,
                      label_h_mm: parseFloat(editForm.label_h_mm) || 32,
                      top_offset_mm: parseFloat(editForm.top_offset_mm) || 0,
                      left_offset_mm: parseFloat(editForm.left_offset_mm) || 0,
                      right_offset_mm: parseFloat(editForm.right_offset_mm) || 0,
                      bottom_offset_mm: parseFloat(editForm.bottom_offset_mm) || 0,
                      media_type: editForm.type === 'cups' ? editForm.media : 'label',
                      sheet: editForm.type === 'cups' && editForm.media === 'sheet' ? sheetChoice(editSheet) : null,
                    });
                    setEditId(null);
                    refetchPrinters();
                    toast('Printer saved');
                  } catch (e) {
                    toast(`Failed: ${(e as Error).message}`);
                  }
                }}>Save</button>
                <button className="btn" onClick={() => testPrinter(p)}>Test</button>
                {(p.type === 'zpl' || p.type === 'zpl-legacy') && (
                  <>
                    <button className="btn" onClick={() => probe(false, p)}>Read values</button>
                    <button className="btn" onClick={() => probe(true, p)}
                      title="Feeds ~1 label to measure the gap">Calibrate</button>
                  </>
                )}
                {p.type === 'dymo' && (
                  <button className="btn" onClick={() => dymoRead(p)}>Read values</button>
                )}
                <button className="btn" onClick={() => setEditId(null)}>Cancel</button>
              </div>
            </div>
          )}
          {p.id === 'pc' && editPc && (
            <div className="printer-form">
              <div className="row">
                <label className="muted">Media</label>
                <select className="input" style={{ width: 'auto' }} value={pcForm.media}
                  onChange={(e) => setPcForm({ ...pcForm, media: e.target.value as 'label' | 'sheet' })}>
                  <option value="sheet">Sheet (laser / Avery-style)</option>
                  <option value="label">Single labels (label printer)</option>
                </select>
              </div>
              {pcForm.media === 'sheet' ? (
                <SheetPicker value={pcForm.sheet} onChange={(s) => setPcForm({ ...pcForm, sheet: s })} presets={presets} />
              ) : (
                <div className="row">
                  <label className="muted">Label mm</label>
                  <input className="input" style={{ width: 80 }} value={pcForm.w}
                    onChange={(e) => setPcForm({ ...pcForm, w: e.target.value })} />
                  <span className="muted">×</span>
                  <input className="input" style={{ width: 80 }} value={pcForm.h}
                    onChange={(e) => setPcForm({ ...pcForm, h: e.target.value })} />
                </div>
              )}
              <MarginBox
                values={{ top_offset_mm: pcForm.mt, left_offset_mm: pcForm.ml, right_offset_mm: pcForm.mr, bottom_offset_mm: pcForm.mb }}
                onChange={(k, v) => {
                  const map = { top_offset_mm: 'mt', left_offset_mm: 'ml', right_offset_mm: 'mr', bottom_offset_mm: 'mb' } as const;
                  setPcForm({ ...pcForm, [map[k as keyof typeof map]]: v });
                }} />
              <div className="row">
                <button className="btn" onClick={async () => {
                  try {
                    await api.patch('/api/printers/pc', {
                      media_type: pcForm.media,
                      sheet: pcForm.media === 'sheet' ? sheetChoice(pcForm.sheet) : null,
                      label_w_mm: parseFloat(pcForm.w) || 57,
                      label_h_mm: parseFloat(pcForm.h) || 32,
                      dpi: parseInt(pcForm.dpi, 10) || 300,
                      top_offset_mm: parseFloat(pcForm.mt) || 0,
                      left_offset_mm: parseFloat(pcForm.ml) || 0,
                      right_offset_mm: parseFloat(pcForm.mr) || 0,
                      bottom_offset_mm: parseFloat(pcForm.mb) || 0,
                    });
                    setEditPc(false);
                    refetchPrinters();
                    toast('PC printing saved');
                  } catch (e) {
                    toast(`Failed: ${(e as Error).message}`);
                  }
                }}>Save</button>
                <button className="btn" onClick={() => setEditPc(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}
      {adding ? (
        <div className="printer-form">
          <div className="row">
            <select className="input" style={{ width: 'auto' }} value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="zpl">Zebra / ZPL (network)</option>
              <option value="zpl-legacy">Zebra legacy / ^HH (GX420d etc.)</option>
              <option value="cups">CUPS queue</option>
              <option value="dymo">DYMO (DYMO Connect)</option>
            </select>
            <input className="input" style={{ width: 'auto', flex: 1 }}
              placeholder={form.type === 'dymo' ? 'DYMO printer name (e.g. LabelWriter 450)' : 'Printer name'}
              value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          {(form.type === 'zpl' || form.type === 'zpl-legacy') && (
            <>
              <div className="row">
                <input className="input" style={{ flex: 1 }} placeholder="IP address"
                  value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
                <input className="input" style={{ width: 90 }} placeholder="9100"
                  value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </div>
              <div className="row">
                <button className="btn" disabled={!form.host} onClick={() => probe(false)}>Read values</button>
                <button className="btn" disabled={!form.host} onClick={() => probe(true)}
                  title="Feeds ~1 label to measure the gap">Calibrate</button>
              </div>
            </>
          )}
          {form.type === 'dymo' && (
            <div className="row">
              <button className="btn" disabled={!form.name} onClick={() => dymoRead()}>Read values</button>
            </div>
          )}
          {form.type === 'cups' && (
            <>
              <div className="row">
                <input className="input" style={{ flex: 1 }} placeholder="Queue name"
                  value={form.queue} onChange={(e) => setForm({ ...form, queue: e.target.value })} />
                <input className="input" style={{ flex: 1 }} placeholder="CUPS server (optional)"
                  value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
              </div>
              <div className="row">
                <label className="muted">Media</label>
                <select className="input" style={{ width: 'auto' }} value={form.media}
                  onChange={(e) => setForm({ ...form, media: e.target.value })}>
                  <option value="label">Single labels (label printer)</option>
                  <option value="sheet">Sheet (laser / Avery-style)</option>
                </select>
              </div>
              {form.media === 'sheet' && (
                <SheetPicker value={sheetForm} onChange={setSheetForm} presets={presets} />
              )}
            </>
          )}
          {(form.type !== 'cups' || form.media === 'label') && (
            <div className="row">
              <label className="muted">Label mm</label>
              <input className="input" style={{ width: 80 }} value={form.label_w_mm}
                onChange={(e) => setForm({ ...form, label_w_mm: e.target.value })} />
              <span className="muted">×</span>
              <input className="input" style={{ width: 80 }} value={form.label_h_mm}
                onChange={(e) => setForm({ ...form, label_h_mm: e.target.value })} />
              <label className="muted">dpi</label>
              <input className="input" style={{ width: 80 }} value={form.dpi}
                onChange={(e) => setForm({ ...form, dpi: e.target.value })} aria-label="dots per inch" />
              {(form.type === 'zpl' || form.type === 'zpl-legacy' || form.type === 'dymo') && (
                <MarginBox values={form}
                  onChange={(k, v) => setForm({ ...form, [k]: v })} />
              )}
            </div>
          )}
          <div className="row">
            <button className="btn" onClick={addPrinter} disabled={!form.name}>Add printer</button>
            <button className="btn" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="btn" onClick={() => setAdding(true)}>+ Add printer</button>
      )}
      {progress && <p className="muted">{progress}</p>}
      {zplDef && (
        <details
          onToggle={(e) => {
            if ((e.target as HTMLDetailsElement).open && !zplRaw) loadZpl();
          }}
        >
          <summary className="muted" style={{ cursor: 'pointer' }}>Show generated ZPL</summary>
          <textarea
            readOnly
            className="input"
            value={zplRaw ?? 'Loading…'}
            onFocus={(e) => e.target.select()}
            style={{ width: '100%', minHeight: 140, fontFamily: 'monospace', fontSize: '0.75rem', marginTop: 6 }}
          />
        </details>
      )}
      {confirmUi}
    </SettingsShell>
  );
}
