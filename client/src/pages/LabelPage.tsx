import { useEffect, useState } from 'react';
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
  const [busy, setBusy] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['label', code],
    queryFn: () => api.get(`/api/labels/${code}`),
    retry: false,
  });

  useEffect(() => {
    if (data?.status === 'area' && data.area) nav(`/areas/${data.area.id}`, { replace: true });
  }, [data, nav]);

  if (isLoading) return <div className="page"><p className="muted">Checking label…</p></div>;
  if (error || !data)
    return (
      <div className="page">
        <h1>Not a Stash label</h1>
        <p className="muted">Code “{code}” isn't in a generated batch. Print labels first.</p>
      </div>
    );

  const claim = async () => {
    setBusy(true);
    try {
      const { area } = await api.post('/api/areas', { label_code: code, name: name || null });
      if (photo) {
        const form = new FormData();
        form.set('cover', 'true');
        form.append('photo', photo, 'cover.jpg');
        await api.upload(`/api/areas/${area.id}/photos`, form);
      }
      qc.invalidateQueries({ queryKey: ['labels'] });
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
          <img src={URL.createObjectURL(photo)} alt="area" />
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
      <button className="btn btn-big" disabled={busy} onClick={claim}>
        {busy ? 'Claiming…' : 'Done'}
      </button>
    </div>
  );
}
