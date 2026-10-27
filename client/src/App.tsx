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

const NAV = [
  { to: '/', label: 'Scan', end: true },
  { to: '/browse', label: 'Browse' },
  { to: '/search', label: 'Find' },
  { to: '/inbox', label: 'Inbox' },
  { to: '/out', label: 'Out' },
  { to: '/labels', label: 'Labels' },
  { to: '/settings', label: 'Setup' },
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
            {n.label}
            {n.to === '/' && pending > 0 && <span className="nav-badge">{pending}</span>}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
