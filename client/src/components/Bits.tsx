import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import loadingAmber from '../assets/loading-amber.svg';
import loadingBlack from '../assets/loading-black.svg';
import loadingWhite from '../assets/loading-white.svg';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';
import { resolveSheet } from '../lib/sheets';

const ICP = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const GLYPHS = {
  camera: <><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></>,
  copy: <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  trash: <><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6" /><path d="M14 11v6" /></>,
  pencil: <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />,
  mic: <><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><path d="M12 19v3" /></>,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  check: <path d="M20 6 9 17l-5-5" />,
  undo: <><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-15-6.7L3 13" /></>,
  later: <><path d="m5 4 10 8-10 8V4z" /><path d="M19 5v14" /></>,
  printer: <><path d="M6 9V3h12v6" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></>,
  receipt: <><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z" /><path d="M8 7h8" /><path d="M8 11h8" /><path d="M8 15h5" /></>,
  filter: <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />,
  barcode: (
    <>
      <path d="M3 5v14" /><path d="M7 5v14" /><path d="M10 5v10" /><path d="M13 5v14" />
      <path d="M16 5v10" /><path d="M20 5v14" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  box: <><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></>,
  dots: <><circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" /><circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none" /></>,
  users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  sparkles: <><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></>,
  wrench: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
  back: <><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></>,
};

export type IconName = keyof typeof GLYPHS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg {...ICP} width={size} height={size} aria-hidden="true">{GLYPHS[name]}</svg>;
}

/** Icon-only button - always carries an accessible label + tooltip. */
export function IconBtn({
  icon,
  label,
  className = '',
  size = 20,
  badge,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  label: string;
  size?: number;
  /** Count shown as a small badge - used for applied-filter counts. */
  badge?: number;
}) {
  return (
    <button
      type="button"
      className={`btn icon-btn ${className}`}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={icon} size={size} />
      {badge ? <span className="filter-count">{badge}</span> : null}
    </button>
  );
}

export interface Crumb {
  id: string;
  name: string | null;
}

export function Breadcrumb({ trail }: { trail: Crumb[] }) {
  return (
    <div className="breadcrumb">
      <Link to="/browse" className="crumb crumb-root" aria-label="All areas" title="All areas">
        <img src="/logo-crumb.svg" alt="" />
      </Link>
      {trail.length > 0 && <span className="crumb-sep">›</span>}
      {trail.map((c, i) => (
        <span key={c.id}>
          {i > 0 && <span className="crumb-sep">›</span>}
          <Link to={`/areas/${c.id}`} className="crumb">
            {c.name ?? 'unnamed'}
          </Link>
        </span>
      ))}
    </div>
  );
}

export interface GridItem {
  id: string;
  name: string | null;
  ai_name?: string | null;
  thumb: string | null;
  grid?: string[];
  sub?: string;
  badge?: string;
}

/** Grid card with Photos-app selection: long-press starts, taps toggle. */
function SelectableCard({
  to,
  isSel,
  active,
  onToggle,
  children,
}: {
  to: string;
  isSel: boolean;
  active: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const nav = useNavigate();
  const timer = useRef<number | undefined>(undefined);
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const clear = () => window.clearTimeout(timer.current);
  return (
    <div
      className={`card selectable${isSel ? ' selected' : ''}${active ? ' sel-on' : ''}`}
      role="button"
      tabIndex={0}
      onPointerDown={(e) => {
        fired.current = false;
        start.current = { x: e.clientX, y: e.clientY };
        timer.current = window.setTimeout(() => {
          fired.current = true;
          onToggle();
        }, 500);
      }}
      onPointerUp={(e) => {
        clear();
        if (!fired.current) (active ? onToggle() : nav(to));
        start.current = null;
      }}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onPointerMove={(e) => {
        if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) clear();
      }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          active ? onToggle() : nav(to);
        }
      }}
    >
      <span
        className={`card-check${isSel ? ' on' : ''}`}
        aria-hidden
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        onClick={(e) => e.stopPropagation()}
      />
      {children}
    </div>
  );
}

export function ItemGrid({
  items,
  linkTo,
  selected,
  onToggle,
  placeholderLogo,
  selectable,
  forceSelect,
}: {
  items: GridItem[];
  linkTo: (id: string) => string;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  /** Show the stache logo instead of an empty block when there's no photo. */
  placeholderLogo?: boolean;
  /** Photos-app selection: long-press (mobile) or checkbox (hover) to pick. */
  selectable?: boolean;
  /** Force selection mode on even with an empty set (e.g. stocktake). */
  forceSelect?: boolean;
}) {
  if (!items.length) return <div className="empty">Nothing here yet</div>;
  const active = forceSelect || !!selected?.size;
  return (
    <div className="grid">
      {items.map((i) => {
        const body = (
          <>
            {i.grid?.length ? (
              <div className="cover-grid" data-count={Math.min(4, i.grid.length)}>
                {i.grid.slice(0, 4).map((u) => (
                  <img key={u} src={u} alt="" loading="lazy" />
                ))}
              </div>
            ) : i.thumb ? (
              <img src={i.thumb} alt="" loading="lazy" />
            ) : placeholderLogo ? (
              <img className="thumb-placeholder ph-logo" src="/icon.svg" alt="" />
            ) : (
              <div className="thumb-placeholder" />
            )}
            <div className="grid-caption">
              {i.badge && <span className="badge">{i.badge}</span>}
              {i.name ?? (i.ai_name ? <em className="muted">{i.ai_name}</em> : 'unnamed')}
              {i.sub && <div className="grid-sub">{i.sub}</div>}
            </div>
          </>
        );
        if (selectable)
          return (
            <SelectableCard
              key={i.id}
              to={linkTo(i.id)}
              isSel={selected?.has(i.id) ?? false}
              active={active}
              onToggle={() => onToggle?.(i.id)}
            >
              {body}
            </SelectableCard>
          );
        const cls = `card${selected?.has(i.id) ? ' selected' : ''}`;
        return onToggle ? (
          <button key={i.id} className={cls} onClick={() => onToggle(i.id)}>
            {body}
          </button>
        ) : (
          <Link key={i.id} to={linkTo(i.id)} className={cls}>
            {body}
          </Link>
        );
      })}
    </div>
  );
}

export interface AreaRow {
  id: string;
  name: string | null;
  parent_id: string | null;
}

/** "Hall closet / Top shelf" paths for every live area, sorted for scanning. */
export function areaPaths(list: AreaRow[]) {
  const byId = new Map(list.map((a) => [a.id, a]));
  const path = (a: AreaRow): string => {
    const parts = [a.name ?? 'Unnamed area'];
    let p = a.parent_id;
    for (let i = 0; p && i < 20; i++) {
      const pa = byId.get(p);
      if (!pa) break;
      parts.unshift(pa.name ?? 'Unnamed area');
      p = pa.parent_id;
    }
    return parts.join(' / ');
  };
  return list.map((a) => ({ id: a.id, label: path(a) })).sort((x, y) => x.label.localeCompare(y.label));
}

export interface KebabItem {
  label: string;
  icon?: IconName;
  /** Destructive-ish actions - styled red, conventionally placed last. */
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * Overflow (3-dot) menu for secondary/second-step actions on an item or
 * object. Keeps the screen clean: primaries stay visible, the rest live
 * here - destructive entries conventionally at the bottom.
 */
export function KebabMenu({
  items,
  label = 'More actions',
  className,
}: {
  items: (KebabItem | 'sep')[];
  label?: string;
  /** 'page-menu' floats the trigger to the header's top-right corner. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);
  return (
    <div className={`kebab${className ? ` ${className}` : ''}`}>
      <IconBtn
        icon="dots"
        label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <>
          <div className="kebab-overlay" onClick={() => setOpen(false)} />
          <div className="kebab-menu" role="menu">
            {items.map((it, i) =>
              it === 'sep' ? (
                <hr key={i} className="menu-sep" />
              ) : (
                <button
                  key={i}
                  className={`more-link${it.danger ? ' danger' : ''}`}
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    it.onSelect();
                  }}
                >
                  {it.icon && <Icon name={it.icon} />}
                  <span>{it.label}</span>
                </button>
              ),
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Manual alternative to scanning a label: pick an area from the location
 * tree (or create a new top-level one - no QR required).
 */
export function AreaPicker({
  onPick,
  onClose,
}: {
  onPick: (areaId: string) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useApp();
  const [askPrompt, promptUi] = usePrompt();
  const { data } = useQuery({
    queryKey: ['areas', 'all'],
    queryFn: () => api.get('/api/areas?all=1'),
  });
  const options = areaPaths((data?.areas ?? []) as AreaRow[]);

  const createArea = async () => {
    const name = await askPrompt('New area name');
    if (name === null) return;
    const r = await api.post('/api/areas', { name: name || null }).catch((e) => (toast(e.message), null));
    if (!r?.area) return;
    qc.invalidateQueries({ queryKey: ['areas'] });
    onPick(r.area.id);
  };

  return (
    <div className="more-overlay" onClick={onClose}>
      <div className="picker-menu" role="dialog" aria-label="Pick an area" onClick={(e) => e.stopPropagation()}>
        <button className="more-link" onClick={createArea}>
          <Icon name="plus" />
          <span>New area…</span>
        </button>
        {options.map((o) => (
          <button key={o.id} className="more-link" onClick={() => onPick(o.id)}>
            <Icon name="box" />
            <span>{o.label}</span>
          </button>
        ))}
        {!data && <p className="muted picker-empty">Loading…</p>}
        {data && !options.length && <p className="muted picker-empty">No areas yet - make one above.</p>}
        {promptUi}
      </div>
    </div>
  );
}
export function CaptureInput({
  onCapture,
  className = 'btn',
  children,
  ...rest
}: {
  onCapture: (b: Blob) => void;
  className?: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={className} onClick={() => ref.current?.click()} {...rest}>
        {children}
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onCapture(f);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** Shared print picker: copies + printer, dispatches to PC page/Dymo/server. */
export function PrintDialog({
  open,
  labels,
  printers,
  presets,
  defaultId,
  onClose,
}: {
  open: boolean;
  labels: { code: string; name: string | null; path: string | null; category: string | null }[];
  printers: any[];
  presets: any[];
  defaultId?: string;
  onClose: () => void;
}) {
  const { toast } = useApp();
  const [copies, setCopies] = useState('1');
  const [printerId, setPrinterId] = useState('pc');
  const userPicked = useRef(false);
  useEffect(() => {
    if (open) userPicked.current = false;
  }, [open]);
  useEffect(() => {
    if (open && !userPicked.current && printers.length)
      setPrinterId(
        defaultId && printers.some((p) => p.id === defaultId) ? defaultId : printers[0].id,
      );
  }, [open, printers, defaultId]);
  if (!open || !labels.length) return null;

  const run = async () => {
    const p = printers.find((x) => x.id === printerId);
    if (!p) return;
    const n = Math.max(1, parseInt(copies, 10) || 1);
    onClose();
    if (p.id === 'pc') {
      const spec = p.media_type === 'sheet' ? resolveSheet(p.sheet, presets) : null;
      const out: typeof labels = [];
      for (const l of labels) for (let i = 0; i < n; i++) out.push(l);
      sessionStorage.setItem('stache:print-sheet', JSON.stringify({
        mode: p.media_type === 'label' ? 'label' : 'sheet',
        spec, labelW: p.label_w_mm ?? 57, labelH: p.label_h_mm ?? 32, labels: out,
      }));
      window.open('/print/labels', '_blank');
      return;
    }
    const repeated: string[] = [];
    for (const l of labels) for (let i = 0; i < n; i++) repeated.push(l.code);
    try {
      if (p.type === 'dymo') {
        const { dymoPrintLabels } = await import('../dymo');
        await dymoPrintLabels(p, repeated, window.location.origin);
        api.post('/api/labels/mark-printed', { codes: repeated }).catch(() => {});
      } else {
        await api.post('/api/labels/print', { printer_id: p.id, codes: repeated });
      }
      toast(`Sent ${repeated.length} label(s) to ${p.name}`);
    } catch (e) {
      toast(`Print failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="dlg-overlay" onClick={onClose}>
      <div className="dlg" role="dialog" aria-label="Print labels" onClick={(e) => e.stopPropagation()}>
        <h2>Print {labels.length === 1 ? 'label' : `${labels.length} labels`}</h2>
        <label className="muted">Printer</label>
        <select className="input" value={printerId} onChange={(e) => { userPicked.current = true; setPrinterId(e.target.value); }}>
          {printers.map((p: any) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <label className="muted">Copies per label</label>
        <input className="input" inputMode="numeric" value={copies} onChange={(e) => setCopies(e.target.value)} />
        <div className="row">
          <button className="btn" onClick={() => void run()}>Print</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/** Bottom-corner banner while the local AI model downloads. Links to Settings. */
export function ModelBanner() {
  const { data } = useQuery({
    queryKey: ['ai-model-status'],
    queryFn: () => api.get('/api/settings/ai'),
    refetchInterval: (q) => (q.state.data?.ml?.state === 'downloading' ? 3000 : 30000),
  });
  const ml = data?.ml;
  const { pathname } = useLocation();
  if (ml?.state !== 'downloading') return null;
  // On Scan the full banner covers the shutter - collapse to a small
  // top-left chip: animated logo + percent, still links to Settings.
  if (pathname === '/') {
    return (
      <Link to="/settings" className="model-banner compact" aria-label={`AI model downloading${ml.percent != null ? ` ${ml.percent}%` : ''} - open Settings`}>
        <img src={loadingAmber} alt="" className="model-banner-logo" />
        {ml.percent != null && <span className="muted">{ml.percent}%</span>}
      </Link>
    );
  }
  return (
    <Link to="/settings" className="model-banner">
      <img src={loadingAmber} alt="" className="model-banner-logo" />
      <span className="model-banner-body">
        <span className="muted">
          Downloading AI model{ml.percent != null ? ` - ${ml.percent}%` : '...'}
        </span>
        <div className="model-banner-bar">
          <div style={{ width: `${ml.percent ?? 2}%` }} />
        </div>
      </span>
    </Link>
  );
}

/** In-app confirm sheet - replaces window.confirm for non-undoable actions.
 *  const [askConfirm, confirmUi] = useConfirm();  ... render {confirmUi} once. */
export function useConfirm(): [
  ask: (msg: string, okLabel?: string) => Promise<boolean>,
  ui: React.ReactNode,
] {
  const [req, setReq] = useState<{ msg: string; ok: string; resolve: (v: boolean) => void } | null>(null);
  const ask = (msg: string, okLabel = 'Confirm') =>
    new Promise<boolean>((resolve) => setReq({ msg, ok: okLabel, resolve }));
  const done = (v: boolean) => {
    req?.resolve(v);
    setReq(null);
  };
  const ui = req && (
    <div className="dlg-overlay" onClick={() => done(false)}>
      <div
        className="dlg"
        role="alertdialog"
        aria-modal="true"
        aria-label={req.msg}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && done(false)}
      >
        <p>{req.msg}</p>
        <div className="row">
          <button className="btn" onClick={() => done(true)} autoFocus>{req.ok}</button>
          <button className="btn" onClick={() => done(false)}>Cancel</button>
        </div>
      </div>
    </div>
  );
  return [ask, ui];
}

/** In-app input sheet - replaces window.prompt for collecting short text.
 *  const [askPrompt, promptUi] = usePrompt();  ... render {promptUi} once. */
export function usePrompt(): [
  ask: (title: string, opts?: { placeholder?: string; defaultValue?: string; allowEmpty?: boolean }) => Promise<string | null>,
  ui: React.ReactNode,
] {
  const [req, setReq] = useState<
    { title: string; placeholder?: string; allowEmpty?: boolean; resolve: (v: string | null) => void } | null
  >(null);
  const [val, setVal] = useState('');
  const ask = (
    title: string,
    opts: { placeholder?: string; defaultValue?: string; allowEmpty?: boolean } = {},
  ) => {
    setVal(opts.defaultValue ?? '');
    return new Promise<string | null>((resolve) => setReq({ title, ...opts, resolve }));
  };
  const done = (v: string | null) => {
    req?.resolve(v);
    setReq(null);
  };
  const ui = req && (
    <div className="dlg-overlay" onClick={() => done(null)}>
      <div
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-label={req.title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && done(null)}
      >
        <label className="muted">{req.title}</label>
        <input
          className="input"
          autoFocus
          value={val}
          placeholder={req.placeholder}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') done(val.trim());
            if (e.key === 'Escape') done(null);
          }}
        />
        <div className="row">
          <button className="btn" onClick={() => done(val.trim())} disabled={!req.allowEmpty && !val.trim()}>
            OK
          </button>
          <button className="btn" onClick={() => done(null)}>Cancel</button>
        </div>
      </div>
    </div>
  );
  return [ask, ui];
}

/** Standard tag editor: chips with x, comma/Enter adds, backspace removes last. */
export function TagEditor({
  tags,
  onChange,
  placeholder = 'Add a tag',
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const t = raw.trim().replace(/,+$/, '').toLowerCase();
    if (!t) return;
    if (!tags.map((x) => x.toLowerCase()).includes(t)) onChange([...tags, t]);
    setDraft('');
  };
  return (
    <div className="tag-editor">
      {tags.map((t) => (
        <span key={t} className="badge tag-chip">
          {t}
          <button
            type="button"
            aria-label={`Remove tag ${t}`}
            onClick={() => onChange(tags.filter((x) => x !== t))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="input"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(',')) add(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(draft);
          } else if (e.key === 'Backspace' && !draft && tags.length) {
            onChange(tags.slice(0, -1));
          }
        }}
        onBlur={() => add(draft)}
      />
    </div>
  );
}

/** Animated logo loader - theme-aware (white on dark, black on light);
 *  tone="amber" for brand moments like app boot. */
export function Loader({
  tone = 'auto',
  size = 48,
  label = 'Loading',
}: {
  tone?: 'auto' | 'amber';
  size?: number;
  label?: string;
}) {
  return (
    <div className="loader" role="status" aria-label={label}>
      {tone === 'amber' ? (
        <img src={loadingAmber} width={size} height={size} alt="" />
      ) : (
        <picture>
          <source srcSet={loadingBlack} media="(prefers-color-scheme: light)" />
          <img src={loadingWhite} width={size} height={size} alt="" />
        </picture>
      )}
    </div>
  );
}
