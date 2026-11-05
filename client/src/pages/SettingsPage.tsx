import { Link } from 'react-router-dom';
import { Icon, type IconName } from '../components/Bits';
import { useApp } from '../context';

const CATS: { to: string; icon: IconName; title: string; desc: string }[] = [
  { to: '/settings/household', icon: 'users', title: 'Household & Account', desc: 'Members, invitations, password' },
  { to: '/settings/ai', icon: 'sparkles', title: 'AI & Automation', desc: 'Suggestions, models, reminders' },
  { to: '/settings/integrations', icon: 'link', title: 'Connections & Integrations', desc: 'MCP, AI assistants, API tokens' },
  { to: '/settings/data', icon: 'download', title: 'Data & Backups', desc: 'Export, import, backups, restore' },
  { to: '/settings/maintenance', icon: 'wrench', title: 'Maintenance', desc: 'Photo storage checks and repair' },
  { to: '/settings/printers', icon: 'printer', title: 'Printers', desc: 'Label printer setup and testing' },
];

/** Settings landing page - six categories, nothing more. */
export function SettingsPage() {
  const { user } = useApp();
  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="muted">
        Signed in as <b>{user?.name}</b> ({user?.email}). Items are shared with the
        household unless marked private on the item.
      </p>
      <div className="settings-cats">
        {CATS.map((c) => (
          <Link key={c.to} to={c.to} className="settings-cat">
            <span className="settings-cat-icon"><Icon name={c.icon} size={22} /></span>
            <span className="settings-cat-body">
              <b>{c.title}</b>
              <span className="muted">{c.desc}</span>
            </span>
          </Link>
        ))}
      </div>
      <p className="muted" style={{ marginTop: '32px' }}>
        Stache {import.meta.env.VITE_APP_VERSION || 'dev'}
      </p>
    </div>
  );
}
