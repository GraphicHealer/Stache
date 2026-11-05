import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Bits';

/** Shared header for settings subpages: back link + consistent title row. */
export function SettingsShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="page">
      <Link to="/settings" className="settings-back muted">
        <Icon name="back" size={16} /> Settings
      </Link>
      <h1>{title}</h1>
      {children}
    </div>
  );
}

export const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});
