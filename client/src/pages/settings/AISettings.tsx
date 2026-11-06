import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useApp } from '../../context';
import { IconBtn } from '../../components/Bits';
import { SettingsShell, copy } from './SettingsShell';

/** AI & Automation: suggestions provider, local model, reminders, reprocess. */
export function AISettings() {
  const { toast, user } = useApp();
  const qc = useQueryClient();
  const isAdmin = user?.role === 'admin';
  const { data } = useQuery({
    queryKey: ['settings-ai'],
    queryFn: () => api.get('/api/settings/ai'),
    refetchInterval: (q) => (q.state.data?.ml?.state === 'downloading' ? 1500 : false),
    enabled: isAdmin,
  });
  const { data: digest } = useQuery({ queryKey: ['settings-digest'], queryFn: () => api.get('/api/settings/digest'), enabled: isAdmin });
  const [form, setForm] = useState({ provider: 'off', base_url: '', model: '', api_key: '' });
  const [dg, setDg] = useState({ enabled: false, webhook_url: '', time: '09:00', base_url: '' });
  const [dgLoaded, setDgLoaded] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (data && !loaded) {
      setForm({
        provider: !data.enabled ? 'off' : data.provider ?? 'remote',
        base_url: data.base_url,
        model: data.model,
        api_key: '',
      });
      setLoaded(true);
    }
    if (digest && !dgLoaded) {
      setDg({
        enabled: digest.enabled,
        webhook_url: digest.webhook_url,
        time: digest.time,
        base_url: digest.base_url,
      });
      setDgLoaded(true);
    }
  }, [data, loaded, digest, dgLoaded]);

  const save = async () => {
    try {
      const body: Record<string, unknown> = {
        enabled: form.provider !== 'off',
        provider: form.provider === 'local' ? 'local' : 'remote',
        base_url: form.base_url,
        model: form.model,
      };
      if (form.api_key) body.api_key = form.api_key;
      await api.put('/api/settings/ai', body);
      qc.invalidateQueries({ queryKey: ['settings-ai'] });
      toast('AI settings saved');
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`);
    }
  };

  if (!isAdmin) {
    return (
      <SettingsShell title="AI & Automation">
        <p className="muted">Managed by your household admin.</p>
      </SettingsShell>
    );
  }

  return (
    <SettingsShell title="AI & Automation">
      <h2>AI suggestions</h2>
      <p className="muted">
        Optional. Runs the built-in model, or point at any OpenAI-compatible vision endpoint -
        Ollama, LM Studio, llama.cpp, or a hosted provider. It only ever <i>suggests</i>;
        your text always wins.
      </p>
      <select
        className="input"
        value={form.provider}
        onChange={(e) => setForm({ ...form, provider: e.target.value })}
      >
        <option value="off">Off</option>
        <option value="local">Built-in model (this device)</option>
        <option value="remote">External endpoint</option>
      </select>
      {form.provider === 'local' && (
        <>
          <label className="row" style={{ gap: 8 }}>
            <span className="muted">Model</span>
            <select
              className="input"
              style={{ width: 'auto', flex: 1 }}
              value={String(data?.ml_level ?? 2)}
              onChange={async (e) => {
                await api.put('/api/settings/ai', { ml_level: parseInt(e.target.value, 10) });
                qc.invalidateQueries({ queryKey: ['settings-ai'] });
              }}
            >
              <option value="1">Lightweight / fastest — Florence-2 (~400MB)</option>
              <option value="2">Balanced — LFM2.5-VL 450M, uses your names as context (~700MB)</option>
              <option value="3">Best recognition quality — Moondream2 (~2GB)</option>
            </select>
          </label>
          {data?.ml?.state === 'downloading' && (
            <p className="muted">
              Downloading model
              {data.ml.percent != null ? ` — ${data.ml.percent}%` : '…'}
              {data.ml.file ? ` (${data.ml.file.split('/').pop()})` : ''}
            </p>
          )}
          {data?.ml?.state === 'ready' && <p className="muted">Model downloaded and ready.</p>}
          {data?.ml?.state === 'failed' && (
            <p className="muted">Model download failed — it retries on the next request.</p>
          )}
          <p className="muted">
            Switching models deletes the old one a few minutes after the new one is ready.
          </p>
        </>
      )}
      {form.provider === 'remote' && (
        <>
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
        </>
      )}
      <button className="btn" onClick={save}>Save</button>

      <h2>Out reminders</h2>
      <p className="muted">
        Optional. One bundled digest of everything still out, posted to a webhook - works with
        ntfy, Discord, a Home Assistant webhook, or anything that takes a JSON POST.
        Never per-item pings.
      </p>
      <label className="row">
        <input
          type="checkbox"
          checked={dg.enabled}
          onChange={(e) => setDg({ ...dg, enabled: e.target.checked })}
        />
        Enabled
      </label>
      <input
        className="input"
        placeholder="Webhook URL (ntfy, HA webhook, etc.)"
        value={dg.webhook_url}
        onChange={(e) => setDg({ ...dg, webhook_url: e.target.value })}
      />
      <div className="row">
        <input
          className="input"
          type="time"
          style={{ maxWidth: '140px' }}
          value={dg.time}
          onChange={(e) => setDg({ ...dg, time: e.target.value })}
        />
        <span className="muted">daily (server timezone)</span>
      </div>
      <input
        className="input"
        placeholder="Public base URL for photo links (optional)"
        value={dg.base_url}
        onChange={(e) => setDg({ ...dg, base_url: e.target.value })}
      />
      <div className="row">
        <button
          className="btn"
          onClick={async () => {
            await api.put('/api/settings/digest', dg);
            toast('Saved');
          }}
        >
          Save
        </button>
        <button
          className="btn btn-ghost"
          onClick={async () => {
            try {
              const r = await api.post('/api/digest/test');
              toast(r.sent ? `Sent (${r.count} items)` : `Nothing sent (${r.count} out)`);
            } catch (e) {
              toast(`Failed: ${(e as Error).message}`);
            }
          }}
        >
          Send test
        </button>
      </div>
      {digest?.webhook_token && (
        <>
          <p className="muted">For Home Assistant automations and sensors:</p>
          <div className="row">
            <code className="mcp-url">{`${window.location.origin}/api/webhooks/out-sensor?token=${digest.webhook_token}`}</code>
            <IconBtn
              icon="copy"
              className="btn-small"
              label="Copy sensor URL"
              onClick={() => copy(`${window.location.origin}/api/webhooks/out-sensor?token=${digest.webhook_token}`)}
            />
          </div>
          <div className="row">
            <code className="mcp-url">{`${window.location.origin}/api/webhooks/digest?token=${digest.webhook_token}`}</code>
            <IconBtn
              icon="copy"
              className="btn-small"
              label="Copy trigger URL"
              onClick={() => copy(`${window.location.origin}/api/webhooks/digest?token=${digest.webhook_token}`)}
            />
          </div>
          <p className="muted">Sensor = GET. Digest trigger = POST.</p>
        </>
      )}

      <h2>Reprocess existing items</h2>
      <p className="muted">
        Runs AI suggestions and photo-search indexing on items that were filed
        before AI was enabled. Runs in the background - one photo at a time.
      </p>
      <button
        className="btn"
        onClick={async () => {
          try {
            const r = await api.post('/api/settings/backfill');
            toast(`Queued ${r.ai_queued} AI + ${r.embeddings_queued} embeddings`);
          } catch (e) {
            toast(`Failed: ${(e as Error).message}`);
          }
        }}
      >
        Reprocess existing items
      </button>
    </SettingsShell>
  );
}
