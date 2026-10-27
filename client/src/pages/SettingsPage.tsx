import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';

const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});

/** AI provider settings + MCP connections - any OpenAI-compatible endpoint. */
export function SettingsPage() {
  const { toast, user, signOut } = useApp();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings-ai'], queryFn: () => api.get('/api/settings/ai') });
  const { data: mcp } = useQuery({ queryKey: ['settings-mcp'], queryFn: () => api.get('/api/settings/mcp') });
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/api/users') });
  const [form, setForm] = useState({ enabled: false, base_url: '', model: '', api_key: '' });
  const [connName, setConnName] = useState('');
  const [member, setMember] = useState({ name: '', email: '', password: '' });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (data && !loaded) {
      setForm({
        enabled: data.enabled,
        base_url: data.base_url,
        model: data.model,
        api_key: '',
      });
      setLoaded(true);
    }
  }, [data, loaded]);

  const save = async () => {
    try {
      const body: Record<string, unknown> = {
        enabled: form.enabled,
        base_url: form.base_url,
        model: form.model,
      };
      if (form.api_key) body.api_key = form.api_key;
      await api.put('/api/settings/ai', body);
      toast('AI settings saved');
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="page">
      <h1>Settings</h1>
      <h2>Household</h2>
      <p className="muted">
        Signed in as <b>{user?.name}</b> ({user?.email}). Items are shared with the
        household unless marked private on the item.
      </p>
      {(users?.users ?? []).map((u: any) => (
        <div key={u.id} className="row">
          <span>{u.name} <span className="muted">{u.email}</span></span>
        </div>
      ))}
      <input
        className="input"
        placeholder="Name"
        value={member.name}
        onChange={(e) => setMember({ ...member, name: e.target.value })}
      />
      <input
        className="input"
        type="email"
        placeholder="Email"
        value={member.email}
        onChange={(e) => setMember({ ...member, email: e.target.value })}
      />
      <input
        className="input"
        type="password"
        placeholder="Temporary password (8+ chars)"
        value={member.password}
        onChange={(e) => setMember({ ...member, password: e.target.value })}
      />
      <div className="row">
        <button
          className="btn"
          onClick={async () => {
            try {
              await api.post('/api/users', member);
              setMember({ name: '', email: '', password: '' });
              qc.invalidateQueries({ queryKey: ['users'] });
              toast('Member added');
            } catch (e) {
              toast(`Failed: ${(e as Error).message}`);
            }
          }}
        >
          Add member
        </button>
        <button className="btn btn-ghost" onClick={signOut}>Sign out</button>
      </div>

      <h2>AI suggestions</h2>
      <p className="muted">
        Optional. Point at any OpenAI-compatible vision endpoint - Ollama, LM Studio, llama.cpp, or a
        hosted provider. It only ever <i>suggests</i>; your text always wins.
      </p>
      <label className="row">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
        />
        Enabled
      </label>
      <input
        className="input"
        placeholder="Base URL, e.g. http://host.docker.internal:11434/v1"
        value={form.base_url}
        onChange={(e) => setForm({ ...form, base_url: e.target.value })}
      />
      <input
        className="input"
        placeholder="Model, e.g. llava, qwen2.5vl, gpt-4o-mini"
        value={form.model}
        onChange={(e) => setForm({ ...form, model: e.target.value })}
      />
      <input
        className="input"
        type="password"
        placeholder={data?.has_api_key ? 'API key (set - enter to replace)' : 'API key (optional)'}
        value={form.api_key}
        onChange={(e) => setForm({ ...form, api_key: e.target.value })}
      />
      <button className="btn" onClick={save}>Save</button>

      <h2>MCP connections</h2>
      <p className="muted">
        Let external AIs (ChatGPT, Claude…) search and manage this inventory. Each connection gets
        its own URL and auth token - share both, revoke either anytime. Needs HTTPS exposure
        (reverse proxy, Tailscale Funnel, Cloudflare Tunnel) for hosted connectors.
      </p>
      {(mcp?.connections ?? []).map((c: any) => (
        <div key={c.id} className="suggest">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>{c.name}</b>
            <button
              className="btn btn-ghost"
              onClick={async () => {
                await api.del(`/api/settings/mcp/${c.id}`);
                qc.invalidateQueries({ queryKey: ['settings-mcp'] });
                toast('Revoked');
              }}
            >
              Revoke
            </button>
          </div>
          <div className="row">
            <code className="mcp-url">{`${window.location.origin}/mcp/${c.slug}`}</code>
            <button className="btn btn-small" onClick={() => copy(`${window.location.origin}/mcp/${c.slug}`)}>
              Copy URL
            </button>
          </div>
          <div className="row">
            <code className="mcp-url">{c.token}</code>
            <button className="btn btn-small" onClick={() => copy(c.token)}>Copy token</button>
          </div>
          <p className="muted">
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
        <button
          className="btn"
          onClick={async () => {
            if (!connName.trim()) return;
            await api.post('/api/settings/mcp', { name: connName.trim() });
            setConnName('');
            qc.invalidateQueries({ queryKey: ['settings-mcp'] });
            toast('Connection created');
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}
