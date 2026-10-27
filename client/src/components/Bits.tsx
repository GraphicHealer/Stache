import { Link } from 'react-router-dom';
import { useRef } from 'react';

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
