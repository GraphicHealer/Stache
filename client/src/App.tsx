import { useEffect, useRef } from 'react';
import { Link, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { parseScan } from './scan';
import { useApp } from './context';
import { Home } from './pages/Home';
import { LabelPage } from './pages/LabelPage';
import { AreaPage } from './pages/AreaPage';
import { ItemPage } from './pages/ItemPage';
import { BrowsePage } from './pages/BrowsePage';
import { SearchPage } from './pages/SearchPage';
import { InboxPage } from './pages/InboxPage';
import { LabelsPage } from './pages/LabelsPage';
import { SettingsPage } from './pages/SettingsPage';
import { OutPage } from './pages/OutPage';
import { LoginPage } from './pages/LoginPage';

/**
 * Hardware scanners act as keyboard wedges: they "type" the scan fast and
 * end with Enter. Buffer rapid keystrokes and treat an Enter-terminated
 * burst as a scan.
 */
function useWedgeScan() {
  const nav = useNavigate();
  const { toast } = useApp();
  const buf = useRef('');
  const lastKey = useRef(0);
  const reset = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
        buf.current = '';
        return;
      }
      const now = Date.now();
      if (now - lastKey.current > 400) buf.current = '';
      lastKey.current = now;

      if (e.key === 'Enter') {
        const text = buf.current;
        buf.current = '';
        const scan = parseScan(text);
        if (scan) {
          e.preventDefault();
          if (scan.kind === 'label') nav(`/l/${scan.code}`);
          else nav(`/search?barcode=${encodeURIComponent(scan.value)}`);
        }
        return;
      }
      if (e.key.length === 1) {
        buf.current += e.key;
        clearTimeout(reset.current);
        reset.current = setTimeout(() => (buf.current = ''), 500);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav, toast]);
}

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const NAV = [
  {
    to: '/', label: 'Scan', end: true,
    icon: <svg {...ICON_PROPS}><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><circle cx="12" cy="12" r="3" /></svg>,
  },
  {
    to: '/browse', label: 'Browse',
    icon: <svg {...ICON_PROPS}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>,
  },
  {
    to: '/search', label: 'Find',
    icon: <svg {...ICON_PROPS}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>,
  },
  {
    to: '/inbox', label: 'Inbox',
    icon: <svg {...ICON_PROPS}><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.5A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.5z" /></svg>,
  },
  {
    to: '/out', label: 'Out',
    icon: <svg {...ICON_PROPS}><path d="M12 3v10" /><path d="m8.5 6.5 3.5-3.5 3.5 3.5" /><path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8" /></svg>,
  },
  {
    to: '/labels', label: 'Labels',
    icon: <svg {...ICON_PROPS}><path d="M20.59 13.41 13.41 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z" /><circle cx="7" cy="7" r="1.5" /></svg>,
  },
  {
    to: '/settings', label: 'Setup',
    icon: <svg {...ICON_PROPS}><path d="M4 21v-7" /><path d="M4 10V3" /><path d="M12 21v-9" /><path d="M12 8V3" /><path d="M20 21v-5" /><path d="M20 12V3" /><path d="M2 14h4" /><path d="M10 8h4" /><path d="M18 16h4" /></svg>,
  },
];

export function App() {
  useWedgeScan();
  const { pending, user } = useApp();
  if (user === undefined) return <div className="page"><p className="muted">…</p></div>;
  if (user === null) return <LoginPage />;
  return (
    <div className="shell">
      <main className="content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/l/:code" element={<LabelPage />} />
          <Route path="/areas/:id" element={<AreaPage />} />
          <Route path="/items/:id" element={<ItemPage />} />
          <Route path="/browse" element={<BrowsePage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/out" element={<OutPage />} />
          <Route path="/labels" element={<LabelsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="*"
            element={
              <div className="page">
                <h1>Lost?</h1>
                <Link to="/">Back to the camera</Link>
              </div>
            }
          />
        </Routes>
      </main>
      <nav className="nav">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className="nav-link">
            {n.icon}
            <span>{n.label}</span>
            {n.to === '/' && pending > 0 && <span className="nav-badge">{pending}</span>}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
