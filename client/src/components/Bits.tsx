import { Link } from 'react-router-dom';
import { useRef } from 'react';

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
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  label: string;
  size?: number;
}) {
  return (
    <button
      className={`btn icon-btn ${className}`}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={icon} size={size} />
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
  thumb: string | null;
  sub?: string;
  badge?: string;
}

export function ItemGrid({
  items,
  linkTo,
  selected,
  onToggle,
}: {
  items: GridItem[];
  linkTo: (id: string) => string;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
}) {
  if (!items.length) return <div className="empty">Nothing here yet</div>;
  return (
    <div className="grid">
      {items.map((i) => {
        const body = (
          <>
            {i.thumb ? (
              <img src={i.thumb} alt={i.name ?? 'item'} loading="lazy" />
            ) : (
              <div className="thumb-placeholder" />
            )}
            <div className="grid-caption">
              {i.badge && <span className="badge">{i.badge}</span>}
              {i.name ?? 'unnamed'}
              {i.sub && <div className="grid-sub">{i.sub}</div>}
            </div>
          </>
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

/** Native-camera capture fallback usable inline anywhere. */
export function CaptureInput({
  onCapture,
  className = 'btn',
  children,
}: {
  onCapture: (b: Blob) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className={className} onClick={() => ref.current?.click()}>
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
