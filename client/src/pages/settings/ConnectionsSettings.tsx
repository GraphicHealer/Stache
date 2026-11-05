import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useApp } from '../../context';
import { IconBtn } from '../../components/Bits';
import { SettingsShell, copy } from './SettingsShell';

/** Connections & Integrations: shared MCP, personal AI connections, API tokens. */
export function ConnectionsSettings() {
  const { toast, user } = useApp();
  const qc = useQueryClient();
  const { data: mcp } = useQuery({ queryKey: ['settings-mcp'], queryFn: () => api.get('/api/settings/mcp').catch(() => null) });
  const { data: apiTokens } = useQuery({ queryKey: ['api-tokens'], queryFn: () => api.get('/api/settings/api-tokens').catch(() => null) });
  const { data: meConns, refetch: refetchMeConns } = useQuery({
    queryKey: ['me-mcp-connections'],
    queryFn: () => api.get('/api/me/mcp-connections'),
  });
  const [connName, setConnName] = useState('');
  const [connScope, setConnScope] = useState<'read' | 'read-write'>('read-write');
  const [aiName, setAiName] = useState('');
  const [aiScope, setAiScope] = useState<'read' | 'read-write'>('read-write');
  const [aiToken, setAiToken] = useState<{ token: string; endpoint: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [tokName, setTokName] = useState('');
  const [tokScope, setTokScope] = useState<'read' | 'read-write'>('read-write');
  const [newApiToken, setNewApiToken] = useState<string | null>(null);
  // New MCP tokens are shown exactly once - the server only stores a hash.
  const [newToken, setNewToken] = useState<string | null>(null);
  const isAdmin = user?.role === 'admin';

  return (
    <SettingsShell title="Connections & Integrations">
      <h2>My personal connections</h2>
      <p className="muted">
        Your own AI assistants (Claude, ChatGPT…) see the shared inventory plus
        your private items. Each connection gets its own endpoint and bearer token.
      </p>
      {(meConns?.connections ?? []).map((c: any) => (
        <div key={c.id} className="suggest">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            {renaming === c.id ? (
              <>
                <input
                  className="input"
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  maxLength={60}
                  autoFocus
                />
                <IconBtn
                  icon="check"
                  className="btn-small"
                  label="Save name"
                  onClick={async () => {
                    const name = renameVal.trim();
                    if (!name) return toast('Name is required');
                    await api.patch(`/api/me/mcp-connections/${c.id}`, { name });
                    setRenaming(null);
                    refetchMeConns();
                    toast('Renamed');
                  }}
                />
                <IconBtn icon="x" className="btn-small btn-ghost" label="Cancel rename" onClick={() => setRenaming(null)} />
              </>
            ) : (
              <>
                <b>{c.name}</b>
                <div className="row" style={{ gap: '.25rem' }}>
                  <IconBtn
                    icon="pencil"
                    className="btn-ghost"
                    label={`Rename ${c.name}`}
                    onClick={() => { setRenaming(c.id); setRenameVal(c.name); }}
                  />
                  <IconBtn
                    icon="trash"
                    className="btn-ghost"
                    label={`Revoke ${c.name}`}
                    onClick={async () => {
                      if (!confirm(`Revoke "${c.name}"? The AI assistant loses access immediately.`)) return;
                      await api.del(`/api/me/mcp-connections/${c.id}`);
                      refetchMeConns();
                      toast('Revoked');
                    }}
                  />
                </div>
              </>
            )}
          </div>
          <div className="row">
            <code className="mcp-url">{`${window.location.origin}/mcp/${c.slug}`}</code>
            <IconBtn icon="copy" className="btn-small" label="Copy endpoint" onClick={() => copy(`${window.location.origin}/mcp/${c.slug}`)} />
          </div>
          <p className="muted">
            {c.scope === 'read' ? 'Read only' : 'Read + write'} ·{' '}
            {c.last_used_at ? `Last used ${new Date(c.last_used_at).toLocaleString()}` : 'Never used'}
          </p>
        </div>
      ))}
      <div className="row">
        <input
          className="input"
          placeholder="Name, e.g. Claude"
          value={aiName}
          onChange={(e) => setAiName(e.target.value)}
        />
        <select
          className="input"
          style={{ maxWidth: '150px' }}
          value={aiScope}
          onChange={(e) => setAiScope(e.target.value as 'read' | 'read-write')}
        >
          <option value="read-write">Read + write</option>
          <option value="read">Read only</option>
        </select>
        <button
          className="btn"
          onClick={async () => {
            if (!aiName.trim()) return;
            const r = await api.post('/api/me/mcp-connections', { name: aiName.trim(), scope: aiScope });
            setAiName('');
            setAiToken({ token: r.token, endpoint: `${window.location.origin}${r.endpoint}` });
            refetchMeConns();
            toast('AI connection created');
          }}
        >
          Add
        </button>
      </div>
      {aiToken && (
        <div className="suggest">
          <p><b>Token (shown once - store it now):</b></p>
          <div className="row">
            <code className="mcp-url">{aiToken.token}</code>
            <IconBtn icon="copy" className="btn-small" label="Copy token" onClick={() => copy(aiToken.token)} />
            <IconBtn icon="x" className="btn-small btn-ghost" label="Dismiss token" onClick={() => setAiToken(null)} />
          </div>
          <details>
            <summary className="muted">Set up your AI client</summary>
            <p className="muted" style={{ margin: '.5rem 0' }}>Paste these into your client's MCP config; replace <code>&lt;token&gt;</code> with the token above.</p>
            {[
              ['Claude Desktop / Cursor', `{
  "mcpServers": {
    "stache": {
      "url": "${aiToken.endpoint}",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}`],
              ['Claude Code', `claude mcp add stache --transport http ${aiToken.endpoint} -H "Authorization: Bearer <token>"`],
              ['ChatGPT', `Settings > Connectors > Create: URL ${aiToken.endpoint}, bearer token <token>`],
              ['VS Code (MCP)', `{
  "servers": {
    "stache": {
      "url": "${aiToken.endpoint}",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}`],
            ].map(([label, cfg]) => (
              <div key={label} className="row" style={{ alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <p className="muted" style={{ marginBottom: '.25rem' }}>{label}</p>
                  <pre className="mcp-url" style={{ whiteSpace: 'pre-wrap' }}>{cfg}</pre>
                </div>
                <IconBtn icon="copy" className="btn-small" label={`Copy ${label} config`} onClick={() => copy(cfg)} />
              </div>
            ))}
          </details>
        </div>
      )}

      {isAdmin && (
        <>
          <h2>Household connections</h2>
          <p className="muted">
            Shared integrations and household-wide assistants (Home Assistant, shared
            Claude setups) see the shared inventory only - never private items.
            Each connection gets its own URL and auth token; revoke either anytime.
            Hosted connectors need HTTPS exposure (reverse proxy, Tailscale Funnel,
            Cloudflare Tunnel).
          </p>
          {(mcp?.connections ?? []).map((c: any) => (
            <div key={c.id} className="suggest">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>{c.name}</b>
                <IconBtn
                  icon="trash"
                  className="btn-ghost"
                  label={`Revoke ${c.name}`}
                  onClick={async () => {
                    if (!confirm(`Revoke "${c.name}"? This connection may be used by other household members or integrations - they all lose access immediately.`)) return;
                    const r = await api.del(`/api/settings/mcp/${c.id}`).catch((e) => (toast(e.message), null));
                    if (!r) return;
                    qc.invalidateQueries({ queryKey: ['settings-mcp'] });
                    toast('Revoked');
                  }}
                />
              </div>
              <div className="row">
                <code className="mcp-url">{`${window.location.origin}/mcp/${c.slug}`}</code>
                <IconBtn icon="copy" className="btn-small" label="Copy connection URL" onClick={() => copy(`${window.location.origin}/mcp/${c.slug}`)} />
              </div>
              <p className="muted">
                {c.scope === 'read' ? 'Read only' : 'Read + write'} ·{' '}
                {c.last_used_at ? `Last used ${new Date(c.last_used_at).toLocaleString()}` : 'Never used'}
              </p>
            </div>
          ))}
          <div className="row">
            <input
              className="input"
              placeholder="Name, e.g. ChatGPT"
              value={connName}
              onChange={(e) => setConnName(e.target.value)}
            />
            <select
              className="input"
              style={{ maxWidth: '150px' }}
              value={connScope}
              onChange={(e) => setConnScope(e.target.value as 'read' | 'read-write')}
            >
              <option value="read-write">Read + write</option>
              <option value="read">Read only</option>
            </select>
            <button
              className="btn"
              onClick={async () => {
                if (!connName.trim()) return;
                const r = await api.post('/api/settings/mcp', { name: connName.trim(), scope: connScope });
                setConnName('');
                setNewToken(r.token ?? null);
                qc.invalidateQueries({ queryKey: ['settings-mcp'] });
                toast('Connection created');
              }}
            >
              Add
            </button>
          </div>
          {newToken && (
            <div className="suggest">
              <p>
                <b>Token (shown once - store it now):</b>
              </p>
              <div className="row">
                <code className="mcp-url">{newToken}</code>
                <IconBtn icon="copy" className="btn-small" label="Copy token" onClick={() => copy(newToken)} />
                <IconBtn icon="x" className="btn-small btn-ghost" label="Dismiss token" onClick={() => setNewToken(null)} />
              </div>
            </div>
          )}

          <h2>API tokens</h2>
          <p className="muted">
            REST bearer tokens for integrations like Home Assistant - full API access limited by
            scope, individually revocable. Use them as <code>Authorization: Bearer &lt;token&gt;</code>
            on <code>{`${window.location.origin}/api/v1`}</code>.
          </p>
          {(apiTokens?.tokens ?? []).map((t: any) => (
            <div key={t.id} className="suggest">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>{t.name}</b>
                <IconBtn
                  icon="trash"
                  className="btn-ghost"
                  label={`Revoke ${t.name}`}
                  onClick={async () => {
                    await api.del(`/api/settings/api-tokens/${t.id}`);
                    qc.invalidateQueries({ queryKey: ['api-tokens'] });
                    toast('Revoked');
                  }}
                />
              </div>
              <p className="muted">
                {t.scope === 'read' ? 'Read only' : 'Read + write'} ·{' '}
                {t.last_used_at ? `Last used ${new Date(t.last_used_at).toLocaleString()}` : 'Never used'}
              </p>
            </div>
          ))}
          <div className="row">
            <input
              className="input"
              placeholder="Name, e.g. Home Assistant"
              value={tokName}
              onChange={(e) => setTokName(e.target.value)}
            />
            <select
              className="input"
              style={{ maxWidth: '150px' }}
              value={tokScope}
              onChange={(e) => setTokScope(e.target.value as 'read' | 'read-write')}
            >
              <option value="read-write">Read + write</option>
              <option value="read">Read only</option>
            </select>
            <button
              className="btn"
              onClick={async () => {
                if (!tokName.trim()) return;
                const r = await api.post('/api/settings/api-tokens', { name: tokName.trim(), scope: tokScope });
                setTokName('');
                setNewApiToken(r.secret ?? null);
                qc.invalidateQueries({ queryKey: ['api-tokens'] });
                toast('Token created');
              }}
            >
              Add
            </button>
          </div>
          {newApiToken && (
            <div className="suggest">
              <p>
                <b>Token (shown once - store it now):</b>
              </p>
              <div className="row">
                <code className="mcp-url">{newApiToken}</code>
                <IconBtn icon="copy" className="btn-small" label="Copy token" onClick={() => copy(newApiToken)} />
                <IconBtn icon="x" className="btn-small btn-ghost" label="Dismiss token" onClick={() => setNewApiToken(null)} />
              </div>
            </div>
          )}
        </>
      )}
    </SettingsShell>
  );
}
