import { useEffect, useRef, useState } from 'react';

interface Props {
  onResult: (text: string) => void;
  onClose: () => void;
  hint?: string;
  /** Symbologies to detect. Defaults to QR only. */
  formats?: string[];
}

interface ScannerControls {
  stop: () => void;
}

const ALL_FORMATS = [
  'qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e',
  'code_128', 'code_39', 'data_matrix', 'itf',
];

/** Full-screen camera scanner. Native BarcodeDetector, @zxing fallback (QR only). */
export function Scanner({ onResult, onClose, hint, formats = ['qr_code'] }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
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
          controls = (await new BrowserQRCodeReader().decodeFromVideoDevice(
            undefined,
            video,
            (res) => res && fire(res.getText()),
          )) as ScannerControls;
        } catch {
          setError('QR scanning not supported on this device');
        }
      } else {
        try {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          controls = (await new BrowserMultiFormatReader().decodeFromVideoDevice(
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
      {(hint || error) && <div className="scanner-hint">{error ?? hint}</div>}
      <button className="btn scanner-close" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}

export { ALL_FORMATS };
