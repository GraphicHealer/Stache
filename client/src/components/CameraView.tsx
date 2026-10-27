import { useEffect, useRef, useState } from 'react';

interface Props {
  onCapture: (blob: Blob) => void;
  label?: string;
}

/**
 * Live viewfinder with a big shutter button.
 * Falls back to the native camera via file input where getUserMedia is missing.
 */
export function CameraView({ onCapture, label = 'Capture' }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let mounted = true;
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
        }
      })
      .catch(() => setFailed(true));
    return () => {
      mounted = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    canvas.toBlob((b) => b && onCapture(b), 'image/jpeg', 0.85);
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
      <button className="shutter" onClick={capture} aria-label={label} />
    </div>
  );
}
