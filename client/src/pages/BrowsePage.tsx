import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';
import { Icon, ItemGrid } from '../components/Bits';

export function BrowsePage() {
  const qc = useQueryClient();
  const { toast } = useApp();
  const { data, isLoading } = useQuery({ queryKey: ['areas'], queryFn: () => api.get('/api/areas') });

  const addArea = async () => {
    const name = window.prompt('New area name? (optional)') ?? null;
    if (name === null) return;
    const r = await api.post('/api/areas', { name: name || null }).catch((e) => (toast(e.message), null));
    if (r?.area) qc.invalidateQueries({ queryKey: ['areas'] });
  };

  return (
    <div className="page">
      <div className="row spread">
        <h1>Areas</h1>
        <button className="btn has-icon" onClick={addArea}>
          <Icon name="plus" /> New area
        </button>
      </div>
      {isLoading && <p className="muted">Loading…</p>}
      <ItemGrid
        items={(data?.areas ?? []).map((a: any) => ({
          id: a.id,
          name: a.name,
          thumb: a.cover_thumb,
          sub: a.label_code ?? undefined,
        }))}
        linkTo={(id) => `/areas/${id}`}
      />
      <p className="muted">Add an area above, or scan an unclaimed QR label.</p>
    </div>
  );
}
