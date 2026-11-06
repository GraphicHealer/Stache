import { useEffect, useRef, useState } from 'react';
import { IconBtn } from './Bits';

interface Props {
  onCapture: (blob: Blob) => void;
  label?: string;
  /** Called when a QR enters the frame - the same stream decodes while live. */
  onQr?: (text: string) => void;
  children?: React.ReactNode;
}

/**
 * Live viewfinder with a big shutter button.
 * Falls back to the native camera via file input where getUserMedia is missing.
 * The shutter freezes the frame for a confirm/retake step - nothing uploads
 * until the user taps check.
 */
export function CameraView({ onCapture, label = 'Capture', onQr, children }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  // Refs so the QR callback (created once) sees current state.
  const shotRef = useRef(shot);
  shotRef.current = shot;
  const onQrRef = useRef(onQr);
  onQrRef.current = onQr;
  const lastQr = useRef({ text: '', at: 0 });

  useEffect(() => {
    let stream: MediaStream | null = null;
    let mounted = true;
    let qrControls: { stop: () => void } | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((s) => {
        if (!mounted) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const v = videoRef.current;
        if (v) {
          v.srcObject = s;
          v.play().catch(() => {});
          // Continuous QR decode on the same stream - a Stache label in frame
          // selects the area without a separate scan mode.
          import('@zxing/browser').then(({ BrowserQRCodeReader }) => {
            new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 300 })
              .decodeFromVideoElement(v, (result, _err, controls) => {
                if (!result || shotRef.current) return;
                const text = result.getText();
                const now = Date.now();
                if (text === lastQr.current.text && now - lastQr.current.at < 4000) return;
                lastQr.current = { text, at: now };
                qrControls = controls;
                onQrRef.current?.(text);
              })
              .then((c) => {
                if (!mounted) c.stop();
                else qrControls = c;
              })
              .catch(() => {});
          }).catch(() => {});
        }
      })
      .catch(() => setFailed(true));
    return () => {
      mounted = false;
      qrControls?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const retake = () => {
    if (shot) URL.revokeObjectURL(shot.url);
    setShot(null);
  };

  const confirm = () => {
    if (!shot) return;
    const { blob, url } = shot;
    setShot(null);
    URL.revokeObjectURL(url);
    onCapture(blob);
  };

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || shot) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    // Per-device preference - default on. 'off' files the photo immediately.
    const confirmFirst = localStorage.getItem('stache:confirm-capture') === 'on';
    canvas.toBlob((b) => {
      if (!b) return;
      if (confirmFirst) setShot({ blob: b, url: URL.createObjectURL(b) });
      else onCapture(b);
    }, 'image/jpeg', 0.85);
  };

  if (failed) {
    return (
      <label className="btn btn-big shutter-fallback">
        {label}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onCapture(f);
            e.target.value = '';
          }}
        />
      </label>
    );
  }

  return (
    <div className="camera-view">
      <video ref={videoRef} className="camera-video" muted playsInline />
      {shot ? (
        <>
          <img className="camera-shot" src={shot.url} alt="Captured" />
          <div className="camera-review">
            <IconBtn icon="undo" label="Retake" onClick={retake} />
            <IconBtn icon="check" label="Use photo" onClick={confirm} />
          </div>
        </>
      ) : (
        <button className="shutter" onClick={capture} aria-label={label} />
      )}
      {children}
    </div>
  );
}
