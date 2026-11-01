import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';

interface PrintLabel {
  code: string;
  name: string | null;
  path: string | null;
  tags: string[];
}

interface PrintSheet {
  template: 'grid' | 'avery';
  labels: PrintLabel[];
}

const AVERY_PER_PAGE = 30;

/** "Garage / Shelf 2" -> "Garage" - the leaf is already shown as the name. */
const parentPath = (path: string | null, name: string | null) => {
  if (!path || !name) return null;
  const suffix = ` / ${name}`;
  return path.endsWith(suffix) ? path.slice(0, -suffix.length) : null;
};

/**
 * Bare label-sheet print view - no app chrome. Opened from the Labels page
 * via window.open; the sheet itself is handed over in sessionStorage.
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
  const template = sheet?.template ?? 'grid';

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
    if (template !== 'avery') return [labels];
    const chunks: PrintLabel[][] = [];
    for (let i = 0; i < labels.length; i += AVERY_PER_PAGE) chunks.push(labels.slice(i, i + AVERY_PER_PAGE));
    return chunks;
  }, [labels, template]);

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
    <div key={l.code} className="pcell">
      <div className="pqrcol">
        {qrs[l.code] && (
          <img className="pqr" src={qrs[l.code]} alt="" onLoad={() => setLoaded((n) => n + 1)} />
        )}
        <span className="pcode">{l.code}</span>
      </div>
      <div className="pinfo">
        <img className="plogo" src="/logo-mono.svg" alt="" />
        {l.name ? (
          <>
            {parentPath(l.path, l.name) && <div className="ppath">{parentPath(l.path, l.name)}</div>}
            <div className="pname">{l.name}</div>
            {l.tags?.length > 0 && <div className="ptags">{l.tags.join(', ')}</div>}
          </>
        ) : (
          <>
            <div className="pblank" />
            <div className="pblank" />
            <div className="pblank" />
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="print-doc">
      <div className="print-bar">
        <span>
          {labels.length} label(s)
          {template === 'avery' ? ' · Avery 5160 - Letter paper, scale 100%' : ' · plain sheet'}
        </span>
        <button className="btn btn-small" onClick={() => window.print()}>
          Print again
        </button>
        <Link className="btn btn-small btn-ghost" to="/labels">
          Back
        </Link>
      </div>
      {pages.map((chunk, i) => (
        <div key={i} className={template === 'avery' ? 'avery-page' : 'grid-page'}>
          <div className={template === 'avery' ? 'agrid' : 'ggrid'}>{chunk.map(cell)}</div>
        </div>
      ))}
    </div>
  );
}
