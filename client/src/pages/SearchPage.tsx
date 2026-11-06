import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';
import { downscale } from '../image';
import { CaptureInput, Icon, IconBtn, ItemGrid, areaPaths, type AreaRow } from '../components/Bits';

const path = (crumb: { name: string | null }[]) =>
  (crumb ?? []).map((c) => c.name ?? '?').join(' › ');

const STATUSES = ['home', 'out', 'lent', 'unaccounted', 'gone'];

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const barcode = params.get('barcode') ?? '';
  const query = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const areaId = params.get('area_id') ?? '';
  const priv = params.get('private') ?? '';
  const tag = params.get('tag') ?? '';
  const { toast } = useApp();
  const [photoResults, setPhotoResults] = useState<any[] | null>(null);
  const [photoSearching, setPhotoSearching] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = [status, areaId, priv, tag].filter(Boolean).length;

  const { data: areaList } = useQuery({
    queryKey: ['areas', 'all'],
    queryFn: () => api.get('/api/areas?all=1'),
  });
  const areaOptions = areaPaths((areaList?.areas ?? []) as AreaRow[]);

  // Search-as-you-type: apply ?q= 250ms after typing stops (filters kept).
  useEffect(() => {
    const t = setTimeout(() => {
      if (q.trim() === query) return;
      const next = new URLSearchParams(params);
      q.trim() ? next.set('q', q.trim()) : next.delete('q');
      setParams(next, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const filterParams = () => {
    const p = new URLSearchParams();
    if (query) p.set('q', query);
    if (status) p.set('status', status);
    if (areaId) p.set('area_id', areaId);
    if (priv) p.set('private', priv);
    if (tag) p.set('tag', tag);
    return p.toString();
  };

  const { data, isFetching } = useQuery({
    queryKey: ['search', query, barcode, status, areaId, priv, tag],
    queryFn: () =>
      api.get(barcode ? `/api/search?barcode=${encodeURIComponent(barcode)}`
                      : `/api/search?${filterParams()}`),
    enabled: !!(query || barcode || status || areaId || priv || tag),
  });

  // "Recently filed" feed when nothing is being searched.
  const { data: recent } = useQuery({
    queryKey: ['recent'],
    queryFn: () => api.get('/api/recent'),
    enabled: !(query || barcode || status || areaId || priv || tag || photoResults),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setPhotoResults(null);
    setParams(q ? { q } : {});
  };

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    setParams(next);
  };

  const searchByPhoto = async (blob: Blob) => {
    setPhotoSearching(true);
    try {
      const form = new FormData();
      form.append('photo', await downscale(blob), 'photo.jpg');
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
  const showRecent = !(query || barcode || status || areaId || priv || tag || photoResults);

  return (
    <div className="page">
      <h1 className="sr-only">Find</h1>
      <form onSubmit={submit} className="row">
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="Whatever you remember…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <CaptureInput onCapture={searchByPhoto} className="btn icon-btn" aria-label="Search by photo" title="Search by photo">
          <Icon name="camera" />
        </CaptureInput>
        <IconBtn
          icon="filter"
          className={activeFilters ? 'filter-active' : ''}
          label={activeFilters ? `Filters (${activeFilters} active)` : 'Filters'}
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((o) => !o)}
        />
        {activeFilters > 0 && !filtersOpen && (
          <IconBtn icon="x" label="Clear all filters" onClick={() => setParams(query ? { q: query } : {})} />
        )}
      </form>
      {filtersOpen && (
        <div className="filter-tray">
          <select
            className="input"
            style={{ flex: 1 }}
            value={status}
            onChange={(e) => setFilter('status', e.target.value)}
          >
            <option value="">Any status</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            className="input"
            style={{ flex: 1 }}
            value={areaId}
            onChange={(e) => setFilter('area_id', e.target.value)}
          >
            <option value="">Any area</option>
            {areaOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          <select
            className="input"
            style={{ flex: 1 }}
            value={priv}
            onChange={(e) => setFilter('private', e.target.value)}
          >
            <option value="">Shared + private</option>
            <option value="0">Shared only</option>
            <option value="1">Private only</option>
          </select>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="tag"
            value={tag}
            onChange={(e) => setFilter('tag', e.target.value)}
          />
        </div>
      )}
      {photoSearching && <p className="muted">Looking for similar things…</p>}
      {photoResults && (
        <p className="muted">
          Photo matches{' '}
          <IconBtn icon="x" className="btn-small" label="Clear photo results" onClick={() => setPhotoResults(null)} />
        </p>
      )}
      {barcode && (
        <p className="muted">
          Barcode {barcode}{' '}
          <IconBtn icon="x" className="btn-small" label="Clear barcode filter" onClick={() => setParams({})} />
        </p>
      )}
      {isFetching && <p className="muted">Searching…</p>}
      {data && !data.items?.length && !data.areas?.length && query && !isFetching && (
        <p className="muted">No matches for "{query}"</p>
      )}
      {data?.areas?.length > 0 && (
        <>
          <h2>Areas</h2>
          <ItemGrid
            items={data.areas.map((a: any) => ({ id: a.id, name: a.name, thumb: a.cover_thumb }))}
            linkTo={(id) => `/areas/${id}`}
          />
        </>
      )}
      {(data?.items?.length || photoResults?.length) && (
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
      {showRecent && recent?.items && (
        <>
          <h2>Recently filed</h2>
          <ItemGrid
            items={recent.items.map((i: any) => ({
              id: i.id,
              name: i.name,
              thumb: i.thumb,
              sub: path(i.breadcrumb),
            }))}
            linkTo={(id) => `/items/${id}`}
          />
        </>
      )}
    </div>
  );
}
