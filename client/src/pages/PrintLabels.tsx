import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import type { SheetSpec } from '../lib/sheets';
import { PAGE_SIZES } from '../lib/sheets';

interface PrintLabel {
  code: string;
  name: string | null;
  path: string | null;
  category: string | null;
}

interface PrintSheet {
  // 'sheet' = die-cut grid page; 'label' = one label per page at w×h mm.
  mode: 'sheet' | 'label';
  spec: SheetSpec | null;
  labelW: number;
  labelH: number;
  labels: PrintLabel[];
}

/** "Garage / Shelf 2" -> "Garage" - the leaf is already shown as the name. */
const parentPath = (path: string | null, name: string | null) => {
  if (!path || !name) return null;
  const suffix = ` / ${name}`;
  return path.endsWith(suffix) ? path.slice(0, -suffix.length) : null;
};

/**
 * Bare label print view - no app chrome. Opened via window.open with the
 * job handed over in sessionStorage. Dynamic @page size/margin is injected
 * via a style tag so any sheet spec or label size prints correctly.
 */
export function PrintLabels() {
  const [sheet] = useState<PrintSheet | null>(() => {
    try {
      const raw = sessionStorage.getItem('stache:print-sheet');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const [qrs, setQrs] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(0);
  const [printed, setPrinted] = useState(false);
  const labels = useMemo(() => sheet?.labels ?? [], [sheet]);
  const spec = sheet?.spec ?? null;
  const mode = sheet?.mode ?? 'sheet';

  useEffect(() => {
    document.title = 'Stache labels';
    const origin = window.location.origin;
    let live = true;
    Promise.all(
      labels.map(
        async (l) =>
          [l.code, await QRCode.toDataURL(`${origin}/l/${l.code}`, { margin: 1, width: 220 })] as const,
      ),
    ).then((entries) => live && setQrs(Object.fromEntries(entries)));
    return () => {
      live = false;
    };
  }, [labels]);

  const ready = labels.length > 0 && loaded >= labels.length;
  useEffect(() => {
    if (ready && !printed) {
      setPrinted(true);
      window.print();
    }
  }, [ready, printed]);

  const pages = useMemo(() => {
    if (mode !== 'sheet' || !spec) return [labels];
    const per = spec.cols * spec.rows;
    const chunks: PrintLabel[][] = [];
    for (let i = 0; i < labels.length; i += per) chunks.push(labels.slice(i, i + per));
    return chunks;
  }, [labels, spec, mode]);

  if (!sheet) {
    return (
      <div className="page">
        <p>
          Nothing to print - <Link to="/labels">back to labels</Link>.
        </p>
      </div>
    );
  }

  const cell = (l: PrintLabel) => (
    <div
      key={l.code}
      className="pcell"
      style={spec ? { height: `${spec.cellH}mm` } : undefined}
    >
      <div className="pqrcol">
        {qrs[l.code] && (
          <img
            className="pqr"
            src={qrs[l.code]}
            alt=""
            style={spec ? { width: `${Math.min(spec.cellH - 4, spec.cellW * 0.4)}mm` } : undefined}
            onLoad={() => setLoaded((n) => n + 1)}
          />
        )}
        <span className="pcode">{l.code}</span>
      </div>
      <div className="pinfo">
        {l.name ? (
          <>
            {parentPath(l.path, l.name) && <div className="ppath">{parentPath(l.path, l.name)}</div>}
            <div className="pname">{l.name}</div>
            {l.category && <div className="ptags">{l.category}</div>}
          </>
        ) : (
          <>
            <div className="pblank" />
            <div className="pblank" />
            <div className="pblank" />
          </>
        )}
        <img className="plogo" src="/logo-mono.svg" alt="" />
      </div>
    </div>
  );

  const labelPage = (l: PrintLabel) => (
    <div
      key={l.code}
      className="plabel"
      style={{ width: `${sheet.labelW}mm`, height: `${sheet.labelH}mm` }}
    >
      {qrs[l.code] && (
        <img
          src={qrs[l.code]}
          alt=""
          onLoad={() => setLoaded((n) => n + 1)}
          style={{ width: `${Math.min(sheet.labelW, sheet.labelH) * 0.62}mm` }}
        />
      )}
      <span className="pcode">{l.code}</span>
      {l.name && <span className="plabel-name">{l.name}</span>}
    </div>
  );

  const pageW =
    mode === 'label' ? sheet.labelW : (PAGE_SIZES[spec?.page ?? 'letter'].w);
  const pageH =
    mode === 'label' ? sheet.labelH : (PAGE_SIZES[spec?.page ?? 'letter'].h);

  return (
    <div className="print-doc">
      <style>{`@page { size: ${pageW}mm ${pageH}mm; margin: 0; }`}</style>
      <div className="print-bar">
        <span>
          {labels.length} label(s)
          {mode === 'sheet'
            ? ' · sheet print - match paper size, scale 100%'
            : ` · ${sheet.labelW}×${sheet.labelH}mm labels, scale 100%`}
        </span>
        <button className="btn btn-small" onClick={() => window.print()}>
          Print again
        </button>
        <Link className="btn btn-small btn-ghost" to="/labels">
          Back
        </Link>
      </div>
      {mode === 'label'
        ? labels.map(labelPage)
        : pages.map((chunk, i) => (
            <div
              key={i}
              className="sheet-page"
              style={{
                width: `${pageW}mm`,
                minHeight: `${pageH}mm`,
                padding: `${spec!.marginTop}mm ${spec!.marginX}mm`,
              }}
            >
              <div
                className="sgrid"
                style={{
                  gridTemplateColumns: `repeat(${spec!.cols}, ${spec!.cellW}mm)`,
                  columnGap: `${spec!.gapX}mm`,
                  rowGap: `${spec!.gapY}mm`,
                }}
              >
                {chunk.map(cell)}
              </div>
            </div>
          ))}
    </div>
  );
}
