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
    toast, pending, refreshPending,
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
          toast(`Looks like "${dup?.item?.name ?? 'an existing item'}" - filed anyway`);
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
      toast('Offline - queued for sync');
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
        if (stagedPhoto) {
          const b = stagedPhoto;
          setStagedPhoto(null);
          await filePhoto(b, r.area.id);
        } else {
          setCurrentArea({ id: r.area.id, name: r.area.name, thumb: null });
          toast(`Filing into ${r.area.name ?? 'area'}`);
        }
        // Scanned a container that expects things back - offer to clear them.
        api.get(`/api/areas/${r.area.id}/out`)
          .then((o) => { if (o.items?.length) setBackPrompt({ items: o.items }); })
          .catch(() => {});
      }
    } catch (e) {
      toast(`Scan failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="home">
      <div className="area-banner">
        {currentArea ? (
          <>
            {currentArea.thumb && <img src={currentArea.thumb} alt="" />}
            <div>
              <div className="banner-label">Filing into</div>
              <div className="banner-name">{currentArea.name ?? 'unnamed area'}</div>
            </div>
            <button className="btn btn-small" onClick={() => setCurrentArea(null)}>
              Clear
            </button>
          </>
        ) : (
          <>
            <img className="banner-logo" src="/icon.svg" alt="" />
            <div className="banner-name muted">
              {stagedPhoto ? 'Photo staged - scan where it went' : 'Scan an area label to start filing'}
            </div>
          </>
        )}
        {pending > 0 && <span className="badge warn">{pending} queued</span>}
      </div>

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
          <span className="muted">Still out - tap to put back</span>
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

      {scanning && <Scanner formats={ALL_FORMATS} onResult={onScan} onClose={() => setScanning(false)} hint={hint} />}

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
