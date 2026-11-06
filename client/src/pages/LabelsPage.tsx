import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api } from '../api';
import { useApp } from '../context';
import { dymoRenderLabel } from '../dymo';
import { Icon, IconBtn, PrintDialog, useConfirm } from '../components/Bits';
import { resolveSheet, type SheetChoice, type SheetPreset, type SheetSpec } from '../lib/sheets';
import { labelMetrics } from '../lib/labelmetrics';
import { renderZplPng } from '../lib/zplrender';

interface SheetLabel {
  code: string;
  dataUrl: string;
}

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

/** Generate sequential labels; print as a sheet or straight to a label printer. */
export function LabelsPage() {
  const qc = useQueryClient();
  const { toast } = useApp();
  const [askConfirm, confirmUi] = useConfirm();
  const [sheet, setSheet] = useState<SheetLabel[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [selClaimed, setSelClaimed] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<'unclaimed' | 'claimed'>('unclaimed');
  const [addN, setAddN] = useState('');
  const [printDlg, setPrintDlg] = useState(false);
  const [defaultId, setDefaultId] = useState('pc');
  const [progress, setProgress] = useState<string | null>(null);

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
  const claimed = labels.filter((l: any) => l.area_id).length;
  const unclaimed = labels.filter((l: any) => !l.area_id);
  const claimedList = labels.filter((l: any) => l.area_id);
  const printCodes = [...sel, ...selClaimed];

  const render = async (codes: string[]) => {
    const origin = window.location.origin;
    const rendered = await Promise.all(
      codes.map(async (code) => ({
        code,
        dataUrl: await QRCode.toDataURL(`${origin}/l/${code}`, { margin: 0, width: 220 }),
      })),
    );
    setSheet(rendered);
  };

  const newBatch = async (count: number) => {
    setBusy(true);
    try {
      const r = await api.post('/api/labels/batch', { count });
      setSel(new Set(r.labels));
      setTab('unclaimed');
      await render(r.labels);
      qc.invalidateQueries({ queryKey: ['labels'] });
      toast(`Batch ${r.batch}: ${r.labels.length} label${r.labels.length === 1 ? '' : 's'}`);
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // Claimed labels print their area name + path; unclaimed get write-in lines.
  const labelFor = (code: string) => labels.find((l: any) => l.code === code);
  const nameFor = (code: string) => (labelFor(code)?.area_name as string | null) ?? null;
  const pathFor = (code: string) => (labelFor(code)?.area_path as string | null) ?? null;
  const categoryFor = (code: string) => (labelFor(code)?.area_category as string | null) ?? null;

  // Printing happens on /print/labels - the sheet is handed over via
  // sessionStorage so that page can render it without the app shell.

  useEffect(() => {
    if (printerData?.default_id) setDefaultId(printerData.default_id);
  }, [printerData?.default_id]);

  const defP = printers.find((p) => p.id === defaultId) ?? printers[0];

  // Exact local render of the generated ZPL (zebrash wasm) for Zebra printers;
  // falls back to the DOM approximation below if it can't render.
  const [zplPng, setZplPng] = useState<string | null>(null);
  const [zplFailed, setZplFailed] = useState(false);
  const zplDef = defP && (defP.type === 'zpl' || defP.type === 'zpl-legacy') ? defP : null;
  const dymoDef = defP?.type === 'dymo' ? defP : null;
  const [dymoPng, setDymoPng] = useState<string | null>(null);
  const [dymoFailed, setDymoFailed] = useState(false);
  const firstCode = sheet[0]?.code;
  useEffect(() => {
    setDymoPng(null);
    setDymoFailed(false);
    if (!dymoDef || !firstCode) return;
    let dead = false;
    dymoRenderLabel(dymoDef, firstCode, window.location.origin)
      .then((png) => { if (!dead) png ? setDymoPng(png) : setDymoFailed(true); })
      .catch(() => { if (!dead) setDymoFailed(true); });
    return () => { dead = true; };
  }, [dymoDef?.id, dymoDef?.label_w_mm, dymoDef?.label_h_mm,
      dymoDef?.top_offset_mm, dymoDef?.left_offset_mm,
      dymoDef?.right_offset_mm, dymoDef?.bottom_offset_mm, firstCode]);
  useEffect(() => {
    setZplPng(null);
    setZplFailed(false);
    if (!zplDef || !firstCode) return;
    let dead = false;
    (async () => {
      const r = await api
        .get(`/api/labels/${firstCode}/zpl?printer_id=${zplDef.id}`)
        .catch(() => null);
      if (!r || dead) { if (!dead) setZplFailed(true); return; }
      const b64 = await renderZplPng(r.zpl, r.w_mm, r.h_mm, r.dpi).catch(() => null);
      if (dead) return;
      if (b64) setZplPng(b64); else setZplFailed(true);
    })();
    return () => {
      dead = true;
    };
  }, [
    firstCode,
    zplDef?.id, zplDef?.label_w_mm, zplDef?.label_h_mm, zplDef?.dpi,
    zplDef?.top_offset_mm, zplDef?.left_offset_mm,
    zplDef?.right_offset_mm, zplDef?.bottom_offset_mm,
  ]);
  const defSpec = defP?.media_type === 'sheet' ? resolveSheet(defP.sheet ?? null, presets) : null;
  const cap = defSpec && defSpec.cols && defSpec.rows ? defSpec.cols * defSpec.rows : 1;
  useEffect(() => {
    setAddN(String(cap));
  }, [cap]);

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
        {labels.length} labels · {claimed} in use · {unclaimed.length} unclaimed
      </p>
      {sheet.length > 0 && (
        <>
          <h2>Label preview</h2>
          <p className="muted">First label at true size · the print includes {sel.size || selClaimed.size ? `${printCodes.length} selected` : 'nothing - select labels to print'}.</p>
          <div className="label-sheet avery">
            {sheet.slice(0, 1).map((l) => {
              // Mirrors zplForLabel's coordinates (server/src/lib/print.ts) so the
              // preview shows what the Zebra actually prints, margins included.
              const name = nameFor(l.code);
              const path = pathFor(l.code);
              const category = categoryFor(l.code);
              const pvW = defP?.media_type === 'sheet' && defSpec ? defSpec.cellW : (defP?.label_w_mm ?? 57);
              const pvH = defP?.media_type === 'sheet' && defSpec ? defSpec.cellH : (defP?.label_h_mm ?? 32);
              const zpl = !!defP && (defP.type === 'zpl' || defP.type === 'zpl-legacy');
              const offL = Number(defP?.left_offset_mm ?? 0);
              const offR = Number(defP?.right_offset_mm ?? 0);
              const offT = Number(defP?.top_offset_mm ?? 0);
              const offB = Number(defP?.bottom_offset_mm ?? 0);
              const cw = Math.max(10, pvW - offL - offR);
              const ch = Math.max(10, pvH - offT - offB);
              const m = labelMetrics(cw, ch);
              const clip = (t: string, font: number, widthMm: number) => {
                const max = Math.floor(widthMm / (font * 0.62));
                return t.length > max && max > 3 ? `${t.slice(0, max - 1)}…` : t;
              };
              const abs = (x: number, y: number, w?: number): CSSProperties =>
                ({ position: 'absolute', left: `${x}mm`, top: `${y}mm`, ...(w != null ? { width: `${w}mm` } : {}) });
              const txt = (t: string, x: number, y: number, wmm: number, font: number, bold = false, center = false) => (
                <div key={`${y}-${t}`} style={{
                  ...abs(x, y, center ? wmm : undefined),
                  fontSize: `${font}mm`, fontWeight: bold ? 700 : 400, color: '#000',
                  lineHeight: 1.15, whiteSpace: 'nowrap', overflow: 'hidden',
                  textAlign: center ? 'center' : 'left', maxWidth: `${wmm}mm`,
                }}>{t}</div>
              );
              const rule = (y: number, x: number, len: number) => (
                <div key={`r${y}`} style={{ ...abs(x, y, len), height: '0.35mm', background: '#000' }} />
              );
              const shortPath = path && path !== name
                ? (path.endsWith(` / ${name}`) ? path.slice(0, -` / ${name}`.length) : path) : null;
              const textWmm = cw - m.qr - 6;
              if (dymoPng && dymoDef) {
                return (
                  <img key={l.code} src={dymoPng}
                    alt={`Rendered label ${l.code}`}
                    style={{ width: `${pvW}mm`, height: 'auto', display: 'block', background: '#fff' }} />
                );
              }
              if (zplPng && zplDef) {
                return (
                  <img key={l.code} src={`data:image/png;base64,${zplPng}`}
                    alt={`Rendered label ${l.code}`}
                    style={{ width: `${pvW}mm`, height: 'auto', display: 'block', background: '#fff' }} />
                );
              }
              if ((zplDef && !zplFailed) || (dymoDef && !dymoFailed)) {
                return (
                  <div key={l.code} className="muted"
                    style={{ width: `${pvW}mm`, height: `${pvH}mm`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', border: '1px dashed var(--border)' }}>
                    Loading preview…
                  </div>
                );
              }
              return (
                <div key={l.code} className="label-cell" style={{
                  width: `${pvW}mm`, height: `${pvH}mm`, position: 'relative',
                  padding: 0, overflow: 'hidden', borderRadius: 0, display: 'block',
                }}>
                  <div style={{
                    ...abs(offL, offT, cw), height: `${ch}mm`,
                  }}>
                  {m.vertical ? (
                    <>
                      <img src="/logo-mono.svg" alt="" style={{ ...abs((cw - m.logo) / 2, 1, m.logo) }} />
                      {name ? (
                        <>
                          {shortPath && txt(clip(shortPath, m.path, cw - 8), 0, m.logo + 6, cw, m.path, false, true)}
                          {txt(clip(name, m.name, cw - 8), 0, m.logo + 6 + (shortPath ? m.path + 1.7 : 0), cw, m.name, true, true)}
                          {category && txt(clip(category, m.category, cw - 8), 0, m.logo + 6 + (shortPath ? m.path + 1.7 : 0) + m.name + 1.7, cw, m.category, false, true)}
                        </>
                      ) : [0.28, 0.38, 0.48].map((f) => rule(ch * f, 4, cw - 8))}
                      <img className="label-qr" src={l.dataUrl} alt={l.code}
                        style={{ ...abs((cw - m.qr) / 2, ch - m.qr - m.code - 2.5, m.qr) }} />
                      <div style={{ ...abs(0, ch - m.code - 1.5, cw), fontSize: `${m.code}mm`,
                        fontFamily: 'monospace', textAlign: 'center', color: '#000' }}>{l.code}</div>
                    </>
                  ) : (
                    <>
                      <img className="label-qr" src={l.dataUrl} alt={l.code}
                        style={{ ...abs(0, 0, m.qr) }} />
                      <div style={{ ...abs(0, ch - m.code, m.qr), fontSize: `${m.code}mm`,
                        fontFamily: 'monospace', textAlign: 'center', color: '#000' }}>{l.code}</div>
                      {name ? (
                        <>
                          {shortPath && txt(clip(shortPath, m.path, textWmm), m.qr + 3, 0, textWmm, m.path)}
                          {txt(clip(name, m.name, textWmm), m.qr + 3, (shortPath ? m.path + 1.7 : 0), textWmm, m.name, true)}
                          {category && txt(clip(category, m.category, textWmm), m.qr + 3, (shortPath ? m.path + 1.7 : 0) + m.name + 1.7, textWmm, m.category)}
                        </>
                      ) : [0.36, 0.62, 0.88].map((f, i) =>
                          rule(ch * f, m.qr + 3, cw - (m.qr + 3) - 4 - (i === 2 ? m.logo : 0)))}
                      <img src="/logo-mono.svg" alt=""
                        style={{ ...abs(cw - m.logo, ch - m.logo, m.logo) }} />
                    </>
                  )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="row">
        <label className="muted" htmlFor="default-printer">Default printer</label>
        <select
          id="default-printer"
          className="input"
          style={{ width: 'auto' }}
          value={defaultId}
          onChange={async (e) => {
            setDefaultId(e.target.value);
            await api.post('/api/printers/default', { id: e.target.value }).catch(() => {});
          }}
        >
          {printers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      <div className="row">
        <input
          className="input"
          style={{ width: 72 }}
          inputMode="numeric"
          aria-label="Number of labels to add"
          value={addN}
          onChange={(e) => setAddN(e.target.value)}
        />
        <button
          className="btn"
          disabled={busy || !(parseInt(addN, 10) > 0)}
          onClick={() => { const n = parseInt(addN, 10); newBatch(n); }}
        >
          Add {parseInt(addN, 10) > 0 ? addN : 'N'}
        </button>
        {printCodes.length > 0 && (
          <button className="btn has-icon" onClick={() => setPrintDlg(true)}>
            <Icon name="printer" /> Print {printCodes.length}
          </button>
        )}
      </div>
      {progress && <p className="muted">{progress}</p>}

      <div className="tabs" role="tablist">
        <button
          type="button"
          className={`tab${tab === 'unclaimed' ? ' on' : ''}`}
          role="tab"
          aria-selected={tab === 'unclaimed'}
          onClick={() => { setTab('unclaimed'); setSelClaimed(new Set()); }}
        >
          Unclaimed{unclaimed.length ? ` (${unclaimed.length})` : ''}
        </button>
        <button
          type="button"
          className={`tab${tab === 'claimed' ? ' on' : ''}`}
          role="tab"
          aria-selected={tab === 'claimed'}
          onClick={() => { setTab('claimed'); setSel(new Set()); }}
        >
          Claimed{claimed ? ` (${claimed})` : ''}
        </button>
      </div>

      {tab === 'claimed' ? (
        <>
          <div className="row spread">
            <h2>Claimed labels</h2>
            {claimedList.length > 0 && (
              <label className="row muted" style={{ gap: 6, margin: 0 }}>
                <input
                  type="checkbox"
                  checked={selClaimed.size === claimedList.length && claimedList.length > 0}
                  onChange={(e) =>
                    setSelClaimed(e.target.checked ? new Set(claimedList.map((l: any) => l.code)) : new Set())
                  }
                  aria-label="Select all claimed labels"
                />
                all
              </label>
            )}
          </div>
          <div className="label-list">
            {claimedList.map((l: any) => (
              <div key={l.code} className="label-row">
                <span className="row" style={{ margin: 0 }}>
                  <label className="check-hit" aria-label={`Select ${l.code}`}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${l.code}`}
                    checked={selClaimed.has(l.code)}
                    onChange={(e) => {
                      const next = new Set(selClaimed);
                      e.target.checked ? next.add(l.code) : next.delete(l.code);
                      setSelClaimed(next);
                    }}
                  />
                  </label>
                  <code>{l.code}</code>
                </span>
                <span className="muted">{l.area_name ?? 'area'}</span>
                {l.printed ? <span className="pill">printed</span> : <span className="muted">claimed</span>}
              </div>
            ))}
            {claimedList.length === 0 && <p className="muted">No claimed labels yet - scan a code on an area.</p>}
          </div>
        </>
      ) : (
        <>
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
              if (!(await askConfirm(`Delete ${sel.size} unclaimed label code(s)? This can't be undone.`, 'Delete'))) return;
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
              <label className="check-hit" aria-label={`Select ${l.code}`}>
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
              </label>
              <code>{l.code}</code>
            </span>
            {l.printed ? <span className="pill">printed</span> : <span className="muted">unclaimed</span>}
          </div>
        ))}
        {unclaimed.length === 0 && <p className="muted">No unclaimed codes - every label is in use.</p>}
      </div>
        </>
      )}

      <p className="muted">
        Manage printers under{' '}
        <Link to="/settings/printers">Settings &rarr; Printers</Link> -
        add them, detect sizes, and test prints there.
      </p>

      <PrintDialog
        open={printDlg}
        onClose={() => {
          setPrintDlg(false);
          qc.invalidateQueries({ queryKey: ['labels'] });
        }}
        printers={printers}
        presets={presets}
        defaultId={defaultId}
        labels={printCodes.map((code) => ({
          code,
          name: nameFor(code),
          path: pathFor(code),
          category: categoryFor(code),
        }))}
      />
      {confirmUi}
    </div>
  );
}
