import { useEffect, useRef, useState } from 'react';
import loadingWhite from '../assets/loading-white.svg';
import { api } from '../api';
import { AreaPicker } from './Bits';

interface Props {
  onResult: (text: string) => void;
  onClose: () => void;
  hint?: string;
  /** Symbologies to detect. Defaults to QR only. */
  formats?: string[];
  /**
   * Optional shutter: adds a capture button and passes the snapped frame.
   * For search flows (photo search alongside barcode scanning).
   */
  onPhoto?: (blob: Blob) => void;
  /**
   * Confirm before firing: a detected code gets looked up and shown as a
   * prompt ("Saltines? Search") instead of firing immediately.
   */
  promptForBarcodes?: boolean;
  /**
   * Optional manual escape hatch: shows a "pick an area" button that opens the
   * area tree instead of scanning a label. The callback gets the area id.
   */
  onPickBin?: (areaId: string) => void;
}

interface ScannerControls {
  stop: () => void;
}

const ALL_FORMATS = [
  'qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e',
  'code_128', 'code_39', 'data_matrix', 'itf',
];

/** Full-screen camera scanner. Native BarcodeDetector, @zxing fallback (QR only). */
export function Scanner({ onResult, onClose, hint, formats = ['qr_code'], onPickBin, onPhoto, promptForBarcodes }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [codePrompt, setCodePrompt] = useState<{ code: string; name: string | null; brand: string | null } | null>(null);
  const promptGate = useRef(false);
  const dismissed = useRef<{ code: string; t: number } | null>(null);
  const qrOnly = formats.length === 1 && formats[0] === 'qr_code';
  const cb = useRef(onResult);
  cb.current = onResult;

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer = 0;
    let controls: ScannerControls | null = null;
    let fired = false;

    const fire = (text: string) => {
      if (fired || stopped) return;
      if (promptForBarcodes) {
        if (promptGate.current) return;
        const d = dismissed.current;
        if (d && d.code === text && Date.now() - d.t < 4000) return;
        promptGate.current = true;
        setCodePrompt({ code: text, name: null, brand: null });
        api
          .get(`/api/codes/${encodeURIComponent(text)}/lookup`)
          .then((r) =>
            setCodePrompt((p) =>
              p && p.code === text ? { ...p, name: r?.product?.name ?? null, brand: r?.product?.brand ?? null } : p,
            ),
          )
          .catch(() => {});
        return;
      }
      fired = true;
      cb.current(text);
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch {
        setError('Camera unavailable');
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      await video.play().catch(() => {});

      if (typeof BarcodeDetector !== 'undefined') {
        let wanted = formats;
        try {
          const supported = await BarcodeDetector.getSupportedFormats();
          wanted = formats.filter((f) => supported.includes(f));
          if (!wanted.length) wanted = ['qr_code'];
        } catch {
          /* older impl: use requested list */
        }
        const det = new BarcodeDetector({ formats: wanted });
        timer = window.setInterval(async () => {
          try {
            const codes = await det.detect(video);
            if (codes.length) fire(codes[0].rawValue);
          } catch {
            /* frame not ready */
          }
        }, 250);
      } else if (qrOnly) {
        try {
          const { BrowserQRCodeReader } = await import('@zxing/browser');
          controls = (await new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 200 }).decodeFromVideoDevice(
            undefined,
            video,
            // Second arg is the per-frame error - NotFound on frames with no
            // code, ignored quietly (keeps the console and battery calm).
            (res) => res && fire(res.getText()),
          )) as ScannerControls;
        } catch {
          setError('QR scanning not supported on this device');
        }
      } else {
        try {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          controls = (await new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 200 }).decodeFromVideoDevice(
            undefined,
            video,
            (res) => res && fire(res.getText()),
          )) as ScannerControls;
        } catch {
          setError('Scanning not supported on this device');
        }
      }
    })();

    return () => {
      stopped = true;
      window.clearInterval(timer);
      controls?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="scanner-overlay">
      <video ref={videoRef} className="scanner-video" muted playsInline />
      {onPhoto && (
        <button
          className="shutter scanner-shutter"
          aria-label="Take a photo"
          onClick={() => {
            const video = videoRef.current;
            if (!video?.videoWidth) return;
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d')!.drawImage(video, 0, 0);
            canvas.toBlob((b) => b && onPhoto(b), 'image/jpeg', 0.9);
          }}
        />
      )}
      {codePrompt && (
        <div className="scanner-prompt">
          <span>
            {codePrompt.name ? (
              <>
                <b>{codePrompt.name}</b>
                {codePrompt.brand ? ` (${codePrompt.brand})` : ''}{' '}
                <span className="grid-sub">{codePrompt.code}</span>
              </>
            ) : (
              <code>{codePrompt.code}</code>
            )}
          </span>
          <button
            className="btn btn-small"
            onClick={() => onResult(codePrompt.code)}
          >
            Search
          </button>
          <button
            className="btn btn-small btn-ghost"
            onClick={() => {
              dismissed.current = { code: codePrompt.code, t: Date.now() };
              promptGate.current = false;
              setCodePrompt(null);
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {formats.includes('qr_code') && (
        <div className="scan-reticle" aria-hidden>
          <div className="scan-window">
            <img className="scan-logo" src={loadingWhite} alt="" />
            <span className="scan-corner tl" /><span className="scan-corner tr" />
            <span className="scan-corner bl" /><span className="scan-corner br" />
            <span className="scan-sweep" />
          </div>
          <div className="scan-dots"><i /><i /><i /></div>
        </div>
      )}
      {(hint || error) && <div className="scanner-hint">{error ?? hint}</div>}
      <div className="scanner-actions">
        {onPickBin && (
          <button className="btn" onClick={() => setPicking(true)}>
            Pick an area
          </button>
        )}
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
      {picking && onPickBin && (
        <AreaPicker onPick={onPickBin} onClose={() => setPicking(false)} />
      )}
    </div>
  );
}

export { ALL_FORMATS };
