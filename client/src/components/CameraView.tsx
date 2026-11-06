import { useEffect, useRef, useState } from 'react';
import { IconBtn } from './Bits';

interface Props {
  onCapture: (blob: Blob) => void;
  label?: string;
  /** Fires once a code has been continuously in frame for ~500ms. */
  onQr?: (text: string) => void;
  /** Fires when the code leaves the frame for ~2s. */
  onQrGone?: () => void;
  children?: React.ReactNode;
}

/**
 * Live viewfinder with a big shutter button.
 * Falls back to the native camera via file input where getUserMedia is missing.
 * The shutter freezes the frame for a confirm/retake step - nothing uploads
 * until the user taps check.
 */
export function CameraView({ onCapture, label = 'Capture', onQr, onQrGone, children }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  // Refs so the QR callback (created once) sees current state.
  const shotRef = useRef(shot);
  shotRef.current = shot;
  const onQrRef = useRef(onQr);
  onQrRef.current = onQr;
  const onQrGoneRef = useRef(onQrGone);
  onQrGoneRef.current = onQrGone;
  // Dwell tracking: seen = last decode, since = when this text first appeared.
  const lastSeen = useRef({ text: null as string | null, since: 0, at: 0 });
  const emitted = useRef<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let mounted = true;
    let qrControls: { stop: () => void } | null = null;
    let tick: ReturnType<typeof setInterval> | null = null;
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
          // for ~500ms offers "Open", ~2s out of frame clears it.
          import('@zxing/browser').then(({ BrowserQRCodeReader }) => {
            new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 250 })
              .decodeFromVideoElement(v, (result, _err, controls) => {
                if (!result || shotRef.current) return;
                const text = result.getText();
                const now = Date.now();
                qrControls = controls;
                lastSeen.current = {
                  text,
                  since: text === lastSeen.current.text ? lastSeen.current.since : now,
                  at: now,
                };
              })
              .then((c) => {
                if (!mounted) c.stop();
                else qrControls = c;
              })
              .catch(() => {});
            // Dwell + absence tick.
            tick = setInterval(() => {
              const now = Date.now();
              const { text, since, at } = lastSeen.current;
              if (shotRef.current) {
                if (emitted.current !== null) { emitted.current = null; onQrGoneRef.current?.(); }
                return;
              }
              if (text && now - since >= 500 && now - at <= 400 && emitted.current !== text) {
                emitted.current = text;
                onQrRef.current?.(text);
              }
              if (emitted.current !== null && now - at > 2000) {
                emitted.current = null;
                lastSeen.current = { text: null, since: 0, at: 0 };
                onQrGoneRef.current?.();
              }
            }, 150);
          }).catch(() => {});
        }
      })
      .catch(() => setFailed(true));
    return () => {
      mounted = false;
      if (tick) clearInterval(tick);
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
