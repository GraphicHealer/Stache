import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api } from '../api';
import { useApp } from '../context';
import { dymoPrintLabels } from '../dymo';

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
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
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
      await printTo(p, ['ST-000000']);
      return;
    }
    try {
      await api.post(`/api/printers/${p.id}/test`);
      toast(`Test label sent to ${p.name}`);
    } catch (e) {
      toast(`Test failed: ${(e as Error).message}`);
    }
  };

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
        <code>{window.location.origin}/l/…</code> — print from the address you'll scan against.
      </p>
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => newBatch(12)}>+ 12</button>
        <button className="btn" disabled={busy} onClick={() => newBatch(24)}>+ 24</button>
        <button className="btn" disabled={busy} onClick={() => newBatch(48)}>+ 48</button>
        {sheet.length > 0 && <button className="btn" onClick={() => window.print()}>Print sheet</button>}
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

      {sheet.length > 0 && (
        <div className="label-sheet">
          {sheet.map((l) => (
            <div key={l.code} className="label-cell">
              <img src={l.dataUrl} alt={l.code} />
              <div className="label-code">{l.code}</div>
            </div>
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
            <button className="btn btn-small" onClick={() => testPrinter(p)}>Test</button>
            <button
              className="btn btn-small"
              onClick={() => api.del(`/api/printers/${p.id}`).then(refetchPrinters)}
            >
              Remove
            </button>
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

      <h2>All labels</h2>
      <div className="label-list">
        {labels.map((l: any) => (
          <div key={l.code} className="label-row">
            <code>{l.code}</code>
            <span className={l.area_id ? '' : 'muted'}>
              {l.area_id ? (l.area_name ?? 'claimed') : 'unclaimed'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
