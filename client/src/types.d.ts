// Baked at build time by the release workflow (Dockerfile ARG APP_VERSION).
interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
}

// Native BarcodeDetector (Chrome/Android WebView). Fallback is @zxing/browser.
interface BarcodeDetectorOptions {
  formats?: string[];
}
interface DetectedBarcode {
  rawValue: string;
  format: string;
}
declare class BarcodeDetector {
  constructor(options?: BarcodeDetectorOptions);
  static getSupportedFormats(): Promise<string[]>;
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
