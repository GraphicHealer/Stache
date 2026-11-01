import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api } from '../api';
import { useApp } from '../context';
import { dymoPrintLabels } from '../dymo';
import { Icon, IconBtn } from '../components/Bits';
import { resolveSheet, type SheetChoice, type SheetPreset } from '../lib/sheets';

interface SheetLabel {
  code: string;
  dataUrl: string;
}

interface Printer {
  id: string;
  name: string;
  type: 'zpl' | 'cups' | 'dymo' | 'pc';
  builtin?: boolean;
  host: string | null;
  port: number;
  queue: string | null;
  dpi: number;
  label_w_mm: number;
  label_h_mm: number;
  media_type?: 'label' | 'sheet';
  sheet?: SheetChoice | null;
}

const EMPTY_FORM = {
  name: '', type: 'zpl', host: '', port: '9100', queue: '', dpi: '203',
  label_w_mm: '57', label_h_mm: '32', media: 'label',
};

interface SheetForm { preset: string; custom: Record<string, string>; }
const EMPTY_SHEET: SheetForm = { preset: 'avery-5160', custom: {} };

function SheetPicker({
  value, onChange, presets,
}: { value: SheetForm; onChange: (v: SheetForm) => void; presets: SheetPreset[] }) {
  const c = value.custom;
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
      )}
    </>
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

/** Generate sequential labels; print as a sheet or straight to a label printer. */
export function LabelsPage() {
  const qc = useQueryClient();
  const { toast } = useApp();
  const [sheet, setSheet] = useState<SheetLabel[]>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [customCount, setCustomCount] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [progress, setProgress] = useState<string | null>(null);
  const [editPc, setEditPc] = useState(false);
  const [pcForm, setPcForm] = useState<{ media: 'label' | 'sheet'; sheet: SheetForm; w: string; h: string; dpi: string }>({
    media: 'sheet', sheet: EMPTY_SHEET, w: '57', h: '32', dpi: '300',
  });
  const [sheetForm, setSheetForm] = useState<SheetForm>(EMPTY_SHEET);

  const { data } = useQuery({ queryKey: ['labels'], queryFn: () => api.get('/api/labels') });
  const { data: printerData, refetch: refetchPrinters } = useQuery({
    queryKey: ['printers'],
    queryFn: () => api.get('/api/printers'),
  });
  const { data: templatesData } = useQuery({
    queryKey: ['sheet-templates'],
    queryFn: () => api.get('/api/sheet-templates'),
  });
  const presets: SheetPreset[] = templatesData?.templates ?? [];
  const labels = data?.labels ?? [];
  const printers: Printer[] = printerData?.printers ?? [];
  const pc = printers.find((p) => p.id === 'pc');
  const pcSpec = pc?.media_type === 'sheet' ? resolveSheet(pc.sheet, presets) : null;
  const claimed = labels.filter((l: any) => l.area_id).length;
  const unclaimed = labels.filter((l: any) => !l.area_id);
  const sheetCodes = sheet.map((l) => l.code);

  const render = async (codes: string[]) => {
    const origin = window.location.origin;
    const rendered = await Promise.all(
      codes.map(async (code) => ({
        code,
        dataUrl: await QRCode.toDataURL(`${origin}/l/${code}`, { margin: 1, width: 220 }),
      })),
    );
    setSheet(rendered);
  };

  const newBatch = async (count: number) => {
    setBusy(true);
    try {
      const r = await api.post('/api/labels/batch', { count });
      await render(r.labels);
      qc.invalidateQueries({ queryKey: ['labels'] });
      toast(`Batch ${r.batch}: ${r.labels.length} labels`);
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

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
        labels: codes.map((code) => ({
          code,
          name: nameFor(code),
          path: pathFor(code),
          tags: tagsFor(code),
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
        await dymoPrintLabels(p.name, codes, window.location.origin, (done, total) =>
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

  // Claimed labels print their area name + path; unclaimed get write-in lines.
  const labelFor = (code: string) => labels.find((l: any) => l.code === code);
  const nameFor = (code: string) => (labelFor(code)?.area_name as string | null) ?? null;
  const pathFor = (code: string) => (labelFor(code)?.area_path as string | null) ?? null;
  const tagsFor = (code: string) => (labelFor(code)?.area_tags as string[] | null) ?? [];

  // Printing happens on /print/labels - the sheet is handed over via
  // sessionStorage so that page can render it without the app shell.

  useEffect(() => {
    const latest = labels.filter(
      (l: any) => l.batch === Math.max(...labels.map((x: any) => x.batch)),
    );
    if (latest.length && sheet.length === 0) render(latest.map((l: any) => l.code));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels.length]);

  return (
    <div className="page">
      <h1>Labels</h1>
      <p className="muted">
        {labels.length} generated · {claimed} in use. QR codes point at{' '}
        <code>{window.location.origin}/l/…</code> - print from the address you'll scan against.
      </p>
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => newBatch(12)}>+ 12</button>
        <button className="btn" disabled={busy} onClick={() => newBatch(24)}>+ 24</button>
        <button className="btn" disabled={busy} onClick={() => newBatch(30)}>+ 30</button>
        <button className="btn" disabled={busy} onClick={() => newBatch(48)}>+ 48</button>
        <input
          className="input"
          style={{ width: 72 }}
          inputMode="numeric"
          placeholder="n"
          aria-label="Custom label count"
          value={customCount}
          onChange={(e) => setCustomCount(e.target.value)}
          onKeyDown={(e) => {
            const n = parseInt(customCount, 10);
            if (e.key === 'Enter' && n > 0) { setCustomCount(''); newBatch(n); }
          }}
        />
        <button
          className="btn"
          disabled={busy || !(parseInt(customCount, 10) > 0)}
          onClick={() => { const n = parseInt(customCount, 10); setCustomCount(''); newBatch(n); }}
        >
          +
        </button>
        {sheet.length > 0 && (
          <button className="btn has-icon" onClick={() => openPrint(sheetCodes)}>
            <Icon name="printer" /> Print
          </button>
        )}
      </div>
      <div className="row">
        {claimed > 0 && (
          <button
            className="btn btn-ghost"
            onClick={() => render(labels.filter((l: any) => l.area_id).map((l: any) => l.code))}
          >
            Sheet of claimed labels
          </button>
        )}
      </div>
      {progress && <p className="muted">{progress}</p>}

      {printers.length > 0 && sheet.length > 0 && (
        <div className="row">
          {printers.map((p) => (
            <button key={p.id} className="btn" disabled={busy} onClick={() => printTo(p, sheetCodes)}>
              → {p.name}
            </button>
          ))}
        </div>
      )}

      <h2>Printers</h2>
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
                      dpi: String(p.dpi ?? 300),
                    });
                  }}
                />
              ) : (
                <>
                  <IconBtn icon="printer" className="btn-small" label={`Send test label to ${p.name}`} onClick={() => testPrinter(p)} />
                  <IconBtn
                    icon="trash"
                    className="btn-small btn-ghost"
                    label={`Remove ${p.name}`}
                    onClick={() => api.del(`/api/printers/${p.id}`).then(refetchPrinters)}
                  />
                </>
              )}
            </span>
          </div>
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
              <div className="row">
                <button className="btn" onClick={async () => {
                  try {
                    await api.patch('/api/printers/pc', {
                      media_type: pcForm.media,
                      sheet: pcForm.media === 'sheet' ? sheetChoice(pcForm.sheet) : null,
                      label_w_mm: parseFloat(pcForm.w) || 57,
                      label_h_mm: parseFloat(pcForm.h) || 32,
                      dpi: parseInt(pcForm.dpi, 10) || 300,
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
              <option value="cups">CUPS queue</option>
              <option value="dymo">DYMO (DYMO Connect)</option>
            </select>
            <input className="input" style={{ width: 'auto', flex: 1 }}
              placeholder={form.type === 'dymo' ? 'DYMO printer name (e.g. LabelWriter 450)' : 'Printer name'}
              value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          {form.type === 'zpl' && (
            <div className="row">
              <input className="input" style={{ flex: 1 }} placeholder="IP address"
                value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
              <input className="input" style={{ width: 90 }} placeholder="9100"
                value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
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
              <input className="input" style={{ width: 80 }} value={form.dpi}
                onChange={(e) => setForm({ ...form, dpi: e.target.value })} placeholder="dpi" />
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

      {sheet.length > 0 && (
        <>
          <h2>Sheet preview</h2>
          <p className="muted">First label at true size - the print includes all {sheet.length}.</p>
          <div className="label-sheet avery">
            {sheet.map((l) => {
              const name = nameFor(l.code);
              const path = pathFor(l.code);
              return (
                <div key={l.code} className="label-cell">
                  <div className="label-qrcol">
                    <img className="label-qr" src={l.dataUrl} alt={l.code} />
                    <span className="label-code">{l.code}</span>
                  </div>
                  <div className="label-info">
                    {name ? (
                      <>
                        {path && path !== name && (
                          <div className="label-path">
                            {path.endsWith(` / ${name}`) ? path.slice(0, -` / ${name}`.length) : path}
                          </div>
                        )}
                        <div className="label-name">{name}</div>
                        {tagsFor(l.code).length > 0 && (
                          <div className="label-tags">{tagsFor(l.code).join(', ')}</div>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="label-blank" />
                        <div className="label-blank" />
                        <div className="label-blank" />
                      </>
                    )}
                    <img className="label-logo" src="/logo-mono.svg" alt="" />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="row spread">
        <h2>Unclaimed labels</h2>
        {unclaimed.length > 0 && (
          <label className="row muted" style={{ gap: 6, margin: 0 }}>
            <input
              type="checkbox"
              checked={sel.size === unclaimed.length && unclaimed.length > 0}
              onChange={(e) =>
                setSel(e.target.checked ? new Set(unclaimed.map((l: any) => l.code)) : new Set())
              }
              aria-label="Select all unclaimed labels"
            />
            all
          </label>
        )}
        {sel.size > 0 && (
          <button
            className="btn btn-small danger"
            onClick={async () => {
              if (!window.confirm(`Delete ${sel.size} unclaimed label code(s)?`)) return;
              const r = await api.post('/api/labels/delete', { codes: [...sel] }).catch((e) => (toast(e.message), null));
              if (r) {
                toast(`Deleted ${r.deleted}${r.skipped ? `, ${r.skipped} claimed skipped` : ''}`);
                setSel(new Set());
                qc.invalidateQueries({ queryKey: ['labels'] });
              }
            }}
          >
            Delete {sel.size}
          </button>
        )}
      </div>
      <div className="label-list">
        {unclaimed.map((l: any) => (
          <div key={l.code} className="label-row">
            <span className="row" style={{ margin: 0 }}>
              <input
                type="checkbox"
                aria-label={`Select ${l.code}`}
                checked={sel.has(l.code)}
                onChange={(e) => {
                  const next = new Set(sel);
                  e.target.checked ? next.add(l.code) : next.delete(l.code);
                  setSel(next);
                }}
              />
              <code>{l.code}</code>
            </span>
            <span className="muted">unclaimed</span>
          </div>
        ))}
        {unclaimed.length === 0 && <p className="muted">No unclaimed codes - every label is in use.</p>}
      </div>
    </div>
  );
}
