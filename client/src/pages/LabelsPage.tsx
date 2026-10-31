import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api } from '../api';
import { useApp } from '../context';
import { dymoPrintLabels } from '../dymo';
import { Icon, IconBtn } from '../components/Bits';

interface SheetLabel {
  code: string;
  dataUrl: string;
}

interface Printer {
  id: string;
  name: string;
  type: 'zpl' | 'cups' | 'dymo';
  host: string | null;
  port: number;
  queue: string | null;
  dpi: number;
  label_w_mm: number;
  label_h_mm: number;
}

const EMPTY_FORM = { name: '', type: 'zpl', host: '', port: '9100', queue: '', dpi: '203', label_w_mm: '57', label_h_mm: '32' };

/** Generate sequential labels; print as a sheet or straight to a label printer. */
export function LabelsPage() {
  const qc = useQueryClient();
  const { toast } = useApp();
  const [sheet, setSheet] = useState<SheetLabel[]>([]);
  const [template, setTemplate] = useState<'grid' | 'avery'>('grid');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [form, setForm] = useState(EMPTY_FORM);
  const [progress, setProgress] = useState<string | null>(null);

  const { data } = useQuery({ queryKey: ['labels'], queryFn: () => api.get('/api/labels') });
  const { data: printerData, refetch: refetchPrinters } = useQuery({
    queryKey: ['printers'],
    queryFn: () => api.get('/api/printers'),
  });
  const labels = data?.labels ?? [];
  const printers: Printer[] = printerData?.printers ?? [];
  const claimed = labels.filter((l: any) => l.area_id).length;
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
      });
      setAdding(false);
      setForm(EMPTY_FORM);
      refetchPrinters();
      toast('Printer added');
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`);
    }
  };

  const printTo = async (p: Printer, codes: string[]) => {
    if (!codes.length) return;
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

  // Claimed labels print their area name; unclaimed get a write-in line.
  const nameFor = (code: string) =>
    (labels.find((l: any) => l.code === code)?.area_name as string | null) ?? null;

  // @page margins + 3×10 layout for the Avery sheet - toggled via body class.
  useEffect(() => {
    document.body.classList.toggle('print-avery', template === 'avery');
    return () => document.body.classList.remove('print-avery');
  }, [template]);

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
        <button className="btn" disabled={busy} onClick={() => newBatch(48)}>+ 48</button>
        {sheet.length > 0 && <button className="btn has-icon" onClick={() => window.print()}><Icon name="printer" /> Print</button>}
      </div>
      <div className="row">
        <select
          className="input"
          style={{ width: 'auto' }}
          value={template}
          onChange={(e) => setTemplate(e.target.value as 'grid' | 'avery')}
          aria-label="Sheet template"
        >
          <option value="grid">Plain grid</option>
          <option value="avery">Avery 5160 (3×10)</option>
        </select>
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
        <div key={p.id} className="label-row">
          <span>
            <b>{p.name}</b> <span className="muted">{p.type}{p.host ? ` · ${p.host}` : ''}{p.queue ? ` · ${p.queue}` : ''}</span>
          </span>
          <span className="row" style={{ margin: 0 }}>
            <IconBtn icon="printer" className="btn-small" label={`Send test label to ${p.name}`} onClick={() => testPrinter(p)} />
            <IconBtn
              icon="trash"
              className="btn-small btn-ghost"
              label={`Remove ${p.name}`}
              onClick={() => api.del(`/api/printers/${p.id}`).then(refetchPrinters)}
            />
          </span>
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
            <div className="row">
              <input className="input" style={{ flex: 1 }} placeholder="Queue name"
                value={form.queue} onChange={(e) => setForm({ ...form, queue: e.target.value })} />
              <input className="input" style={{ flex: 1 }} placeholder="CUPS server (optional)"
                value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
            </div>
          )}
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
          <div className={`label-sheet${template === 'avery' ? ' avery' : ''}`}>
            {sheet.map((l) => {
              const name = nameFor(l.code);
              return (
                <div key={l.code} className="label-cell">
                  <img className="label-qr" src={l.dataUrl} alt={l.code} />
                  <div className="label-info">
                    <div className="label-head">
                      <img className="label-logo" src="/icon.svg" alt="" />
                      <span className="label-code">{l.code}</span>
                    </div>
                    {name ? <div className="label-name">{name}</div> : <div className="label-blank" />}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="row spread">
        <h2>All labels</h2>
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
        {labels.map((l: any) => (
          <div key={l.code} className="label-row">
            <span className="row" style={{ margin: 0 }}>
              {!l.area_id && (
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
              )}
              <code>{l.code}</code>
            </span>
            <span className={l.area_id ? '' : 'muted'}>
              {l.area_id ? (l.area_name ?? 'claimed') : 'unclaimed'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
