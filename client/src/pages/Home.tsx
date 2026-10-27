import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp } from '../context';
import { outboxAdd } from '../outbox';
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
  const qc = useQueryClient();
  const nav = useNavigate();

  const filePhoto = async (blob: Blob, areaId: string) => {
    try {
      const r = await api.fileItem({ area_id: areaId }, [blob]);
      toast('Filed', r.event_id);
      qc.invalidateQueries({ queryKey: ['area', areaId] });
      qc.invalidateQueries({ queryKey: ['inbox'] });
      // Filing stays fast — ask about a barcode found in the photo after the fact.
      const code = await detectBarcodeInPhoto(blob);
      if (code) {
        api.get(`/api/codes/${encodeURIComponent(code.text)}/lookup`)
          .then((l) => setCodePrompt({ itemId: r.item.id, text: code.text, product: l.product?.name ?? null }))
          .catch(() => setCodePrompt({ itemId: r.item.id, text: code.text, product: null }));
      }
    } catch {
      await outboxAdd({ kind: 'file-item', fields: { area_id: areaId }, blobs: [blob], createdAt: Date.now() });
      await refreshPending();
      toast('Offline — queued for sync');
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
          <div className="banner-name muted">
            {stagedPhoto ? 'Photo staged — scan where it went' : 'Scan an area label to start filing'}
          </div>
        )}
        {pending > 0 && <span className="badge warn">{pending} queued</span>}
      </div>

      <CameraView onCapture={onCapture} label="Take photo" />

      <div className="home-actions">
        <button className="btn btn-big" onClick={() => { setHint('Scan an area label'); setScanning(true); }}>
          Scan label
        </button>
      </div>

      {scanning && <Scanner formats={ALL_FORMATS} onResult={onScan} onClose={() => setScanning(false)} hint={hint} />}

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
