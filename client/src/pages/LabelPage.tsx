import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';
import { CaptureInput } from '../components/Bits';

/**
 * What a scanned label resolves to.
 * Claimed → jump to the area. Unclaimed → run the claim flow.
 */
export function LabelPage() {
  const { code = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { toast } = useApp();
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [busy, setBusy] = useState(false);
  const photoUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : ''), [photo]);
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['label', code],
    queryFn: () => api.get(`/api/labels/${code}`),
    retry: false,
  });

  const { data: allAreas } = useQuery({
    queryKey: ['areas', 'all'],
    queryFn: () => api.get('/api/areas?all=1'),
  });

  // "Hall closet / Top shelf" style paths for the parent picker.
  const parentOptions = (() => {
    const list = (allAreas?.areas ?? []) as { id: string; name: string | null; parent_id: string | null }[];
    const byId = new Map(list.map((a) => [a.id, a]));
    const path = (a: (typeof list)[number]): string => {
      const parts = [a.name ?? 'Unnamed area'];
      let p = a.parent_id;
      for (let i = 0; p && i < 20; i++) {
        const pa = byId.get(p);
        if (!pa) break;
        parts.unshift(pa.name ?? 'Unnamed area');
        p = pa.parent_id;
      }
      return parts.join(' / ');
    };
    return list.map((a) => ({ id: a.id, label: path(a) })).sort((x, y) => x.label.localeCompare(y.label));
  })();

  useEffect(() => {
    if (data?.status === 'area' && data.area) nav(`/areas/${data.area.id}`, { replace: true });
  }, [data, nav]);

  if (isLoading) return <div className="page"><p className="muted">Checking label…</p></div>;
  if (error || !data)
    return (
      <div className="page">
        <h1>Not a Stache label</h1>
        <p className="muted">Code “{code}” isn't in a generated batch. Print labels first.</p>
      </div>
    );

  const claim = async () => {
    setBusy(true);
    try {
      const { area } = await api.post('/api/areas', {
        label_code: code,
        name: name || null,
        parent_id: parentId || null,
      });
      if (photo) {
        const form = new FormData();
        form.set('cover', 'true');
        form.append('photo', photo, 'cover.jpg');
        await api.upload(`/api/areas/${area.id}/photos`, form);
      }
      qc.invalidateQueries({ queryKey: ['labels'] });
      qc.invalidateQueries({ queryKey: ['areas'] });
      toast('Label claimed');
      nav(`/areas/${area.id}`, { replace: true });
    } catch (e) {
      toast(`Claim failed: ${(e as Error).message}`);
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1>New area</h1>
      <p className="muted">Label {code}</p>
      <div className="claim-photo">
        {photo ? (
          <img src={photoUrl} alt="area" />
        ) : (
          <CaptureInput onCapture={setPhoto} className="btn btn-big">
            Take a photo of it
          </CaptureInput>
        )}
      </div>
      <input
        className="input"
        placeholder="Name it? (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {parentOptions.length > 0 && (
        <>
          <label className="muted" htmlFor="parent-pick">
            Where does it live?
          </label>
          <select
            id="parent-pick"
            className="input"
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
          >
            <option value="">On its own — not inside anything</option>
            {parentOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </>
      )}
      <button className="btn btn-big" disabled={busy} onClick={claim}>
        {busy ? 'Claiming…' : 'Done'}
      </button>
    </div>
  );
}
