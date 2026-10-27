import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { ItemGrid } from '../components/Bits';

export function BrowsePage() {
  const { data, isLoading } = useQuery({ queryKey: ['areas'], queryFn: () => api.get('/api/areas') });
  return (
    <div className="page">
      <h1>Areas</h1>
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
      <p className="muted">To add a top-level area, scan an unclaimed label.</p>
    </div>
  );
}
