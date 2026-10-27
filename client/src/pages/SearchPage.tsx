import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';
import { CaptureInput, ItemGrid } from '../components/Bits';

const path = (crumb: { name: string | null }[]) =>
  crumb.map((c) => c.name ?? '?').join(' › ');

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const barcode = params.get('barcode') ?? '';
  const query = params.get('q') ?? '';
  const { toast } = useApp();
  const [photoResults, setPhotoResults] = useState<any[] | null>(null);
  const [photoSearching, setPhotoSearching] = useState(false);

  const { data, isFetching } = useQuery({
    queryKey: ['search', query, barcode],
    queryFn: () =>
      api.get(barcode ? `/api/search?barcode=${encodeURIComponent(barcode)}`
                      : `/api/search?q=${encodeURIComponent(query)}`),
    enabled: !!(query || barcode),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setPhotoResults(null);
    setParams(q ? { q } : {});
  };

  const searchByPhoto = async (blob: Blob) => {
    setPhotoSearching(true);
    try {
      const form = new FormData();
      form.append('photo', blob, 'photo.jpg');
      const r = await api.upload('/api/search/photo', form);
      setPhotoResults(r.items);
      setParams({});
      if (!r.items.length) toast('Nothing similar found');
    } catch (e) {
      toast(`Photo search failed: ${(e as Error).message}`);
    } finally {
      setPhotoSearching(false);
    }
  };

  const displayItems = photoResults ?? data?.items;

  return (
    <div className="page">
      <form onSubmit={submit} className="row">
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="Whatever you remember…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <CaptureInput onCapture={searchByPhoto}>By photo</CaptureInput>
      </form>
      {photoSearching && <p className="muted">Looking for similar things…</p>}
      {photoResults && (
        <p className="muted">
          Photo matches{' '}
          <button className="btn btn-small" onClick={() => setPhotoResults(null)}>clear</button>
        </p>
      )}
      {barcode && (
        <p className="muted">
          Barcode {barcode}{' '}
          <button className="btn btn-small" onClick={() => setParams({})}>clear</button>
        </p>
      )}
      {isFetching && <p className="muted">Searching…</p>}
      {data?.areas?.length > 0 && (
        <>
          <h2>Areas</h2>
          <ItemGrid
            items={data.areas.map((a: any) => ({ id: a.id, name: a.name, thumb: a.cover_thumb }))}
            linkTo={(id) => `/areas/${id}`}
          />
        </>
      )}
      {(data || photoResults) && (
        <>
          <h2>Items</h2>
          <ItemGrid
            items={(displayItems ?? []).map((i: any) => ({
              id: i.id,
              name: i.name,
              thumb: i.thumb,
              sub: path(i.breadcrumb),
              badge: i.not_here_count > 0 ? 'unsure' : undefined,
            }))}
            linkTo={(id) => `/items/${id}`}
          />
        </>
      )}
    </div>
  );
}
