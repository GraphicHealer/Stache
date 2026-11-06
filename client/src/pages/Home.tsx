import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { useApp } from '../context';
import { outboxAdd } from '../outbox';
import { downscale } from '../image';
import { detectBarcodeInPhoto, parseScan } from '../scan';
import { CameraView } from '../components/CameraView';
import { ALL_FORMATS, Scanner } from '../components/Scanner';

/**
 * Camera-first home: capture files into the current area; a scan either
 * sets the current area (put-away mode) or files a staged photo into it.
 */
export function Home() {
  const {
    currentArea, setCurrentArea, stagedPhoto, setStagedPhoto,
    toast, refreshPending,
  } = useApp();
  const [scanning, setScanning] = useState(false);
  const [hint, setHint] = useState('Scan an area label');
  const [codePrompt, setCodePrompt] = useState<{ itemId: string; text: string; product: string | null } | null>(null);
  const [backPrompt, setBackPrompt] = useState<{ items: { id: string; name: string | null }[] } | null>(null);
  const [outSum, setOutSum] = useState<{ total: number; items: { id: string; name: string | null; thumb: string | null }[] } | null>(null);
  const qc = useQueryClient();
  const nav = useNavigate();

  const refreshOut = () => api.get('/api/out/summary').then(setOutSum).catch(() => {});
  useEffect(() => { refreshOut(); }, []);

  const putBack = async (ids: string[]) => {
    const r = await api.post('/api/items/put-back', { ids }).catch(() => null);
    if (r?.put_back) toast(`Put back ${r.put_back}`, r.event_ids?.[0]);
    setBackPrompt(null);
    refreshOut();
  };

  const filePhoto = async (blob: Blob, areaId: string) => {
    // Downscale first: saves bandwidth and IndexedDB space; the server caps
    // at 1600px anyway. client_id makes the upload idempotent - a retried
    // request (offline outbox, flaky network) dedupes server-side.
    const photo = await downscale(blob);
    const fields = { area_id: areaId, client_id: crypto.randomUUID() };
    try {
      const r = await api.fileItem(fields, [photo]);
      toast('Filed', r.event_id);
      qc.invalidateQueries({ queryKey: ['area', areaId] });
      qc.invalidateQueries({ queryKey: ['inbox'] });
      // The CLIP check runs in the background on the server - one delayed
      // look surfaces a "this looks like something you already have" hint.
      setTimeout(async () => {
        const d = await api.get(`/api/items/${r.item.id}`).catch(() => null);
        if (d?.item?.duplicate_of) {
          const dup = await api.get(`/api/items/${d.item.duplicate_of}`).catch(() => null);
          toast(
            `Looks like "${dup?.item?.name ?? dup?.item?.ai_name ?? 'an existing item'}" · filed anyway`,
            r.event_id,
          );
        }
      }, 9000);
      // Filing stays fast - ask about a barcode found in the photo after the fact.
      const code = await detectBarcodeInPhoto(photo);
      if (code) {
        api.get(`/api/codes/${encodeURIComponent(code.text)}/lookup`)
          .then((l) => setCodePrompt({ itemId: r.item.id, text: code.text, product: l.product?.name ?? null }))
          .catch(() => setCodePrompt({ itemId: r.item.id, text: code.text, product: null }));
      }
    } catch (e) {
      // A server rejection will never succeed on replay - don't queue it.
      if (e instanceof ApiError) {
        toast(`Not filed: ${e.message}`);
        return;
      }
      await outboxAdd({ kind: 'file-item', fields, blobs: [photo], createdAt: Date.now() });
      await refreshPending();
      toast('Offline · queued for sync');
    }
  };

  const onCapture = (blob: Blob) => {
    if (currentArea) {
      filePhoto(blob, currentArea.id);
    } else {
      setStagedPhoto(blob);
      setHint('Scan where you put it');
      setScanning(true);
    }
  };

  // Shared by scan + manual pick: an area id either becomes the filing
  // destination or receives the staged photo.
  const useArea = async (areaId: string, name: string | null) => {
    if (stagedPhoto) {
      const b = stagedPhoto;
      setStagedPhoto(null);
      await filePhoto(b, areaId);
    } else {
      setCurrentArea({ id: areaId, name, thumb: null });
      toast(`Filing into ${name ?? 'area'}`);
    }
    api.get(`/api/areas/${areaId}/out`)
      .then((o) => { if (o.items?.length) setBackPrompt({ items: o.items }); })
      .catch(() => {});
  };

  const onScan = async (text: string) => {
    setScanning(false);
    const scan = parseScan(text);
    if (!scan) return;
    if (scan.kind === 'barcode') {
      nav(`/search?barcode=${encodeURIComponent(scan.value)}`);
      return;
    }
    try {
      const r = await api.get(`/api/labels/${scan.code}`);
      if (r.status === 'unclaimed') {
        nav(`/l/${scan.code}`);
        return;
      }
      if (r.status === 'area' && r.area) {
        await useArea(r.area.id, r.area.name);
      }
    } catch (e) {
      toast(`Scan failed: ${(e as Error).message}`);
    }
  };

  const onPickBin = async (areaId: string) => {
    setScanning(false);
    const r = await api.get(`/api/areas/${areaId}`).catch(() => null);
    await useArea(areaId, r?.area?.name ?? null);
  };

  return (
    <div className="home">
      <h1 className="sr-only">Scan</h1>
      {outSum && outSum.total > 0 && (
        <div className="still-out">
          <div className="still-out-row">
            {outSum.items.map((i) => (
              <button key={i.id} className="still-out-thumb" title={i.name ?? 'put back'} onClick={() => putBack([i.id])}>
                {i.thumb ? <img src={i.thumb} alt="" /> : <span>{i.name ?? 'item'}</span>}
              </button>
            ))}
            {outSum.total > 6 && (
              <Link className="still-out-more" to="/out">+{outSum.total - 6} more</Link>
            )}
          </div>
          <span className="muted">Still out · tap to put back</span>
        </div>
      )}

      {/* Unmounted while the scanner runs - two getUserMedia streams would
          fight over the camera on some devices. */}
      {!scanning && <CameraView onCapture={onCapture} label="Take photo" />}

      <div className="home-actions">
        <button className="btn btn-big" onClick={() => { setHint('Scan an area label'); setScanning(true); }}>
          Scan label
        </button>
      </div>

      {scanning && <Scanner formats={ALL_FORMATS} onResult={onScan} onClose={() => setScanning(false)} hint={hint} onPickBin={onPickBin} />}

      {backPrompt && (
        <div className="code-prompt card">
          <div>
            <b>{backPrompt.items.length} thing(s) belong back here</b>
            <div className="muted">Mark them returned?</div>
          </div>
          <div className="code-prompt-actions">
            <button className="btn" onClick={() => putBack(backPrompt.items.map((i) => i.id))}>Yes</button>
            <button className="btn btn-ghost" onClick={() => setBackPrompt(null)}>No</button>
          </div>
        </div>
      )}

      {codePrompt && (
        <div className="code-prompt card">
          <div>
            <b>Barcode {codePrompt.text}</b>
            {codePrompt.product && <div className="muted">{codePrompt.product}</div>}
            <div className="muted">Is this the same item?</div>
          </div>
          <div className="code-prompt-actions">
            <button
              className="btn"
              onClick={async () => {
                const p = codePrompt;
                setCodePrompt(null);
                await api.patch(`/api/items/${p.itemId}`, { barcode: p.text }).catch(() => {});
                toast('Barcode attached');
              }}
            >
              Yes
            </button>
            <button className="btn btn-ghost" onClick={() => setCodePrompt(null)}>No</button>
          </div>
        </div>
      )}
    </div>
  );
}
