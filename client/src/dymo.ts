import QRCode from 'qrcode';

/**
 * DYMO LabelWriter printing via the official DYMO Connect Framework
 * (vendored at /vendor/dymo.connect.framework.js - a global-namespace
 * script, lazy-loaded on first use). Requires DYMO Connect running on
 * this device; its web service does the actual printing.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window { dymo?: { label?: { framework?: any } } }
}

let loading: Promise<any> | null = null;

function loadScript(): Promise<any> {
  return (loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/dymo.connect.framework.js';
    s.onload = () =>
      window.dymo?.label?.framework
        ? resolve(window.dymo!.label!.framework)
        : reject(new Error('DYMO framework did not initialize'));
    s.onerror = () => reject(new Error('failed to load DYMO framework script'));
    document.head.appendChild(s);
  }));
}

// The framework's *Async calls use (success, error) callbacks; some builds
// also return a promise. Handle both.
const callAsync = <T>(fn: (ok: (v: T) => void, fail: (e: any) => void) => any): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    try {
      const v = fn(resolve, reject);
      if (v && typeof v.then === 'function') v.then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });

/** Framework handle after init + environment check; throws user-readable errors. */
async function fw() {
  const f = await loadScript();
  await callAsync<void>((ok) => f.init(() => ok()));
  const env = f.checkEnvironment();
  if (!env.isWebServicePresent)
    throw new Error('DYMO Connect service not reachable - is DYMO Connect running on this device?');
  if (!env.isFrameworkInstalled) throw new Error('DYMO framework is not installed on this device');
  if (!env.isBrowserSupported) throw new Error('this browser is not supported by DYMO Connect');
  return f;
}

/** Installed DYMO printer names (only connected ones). */
export async function dymoPrinters(): Promise<string[]> {
  const f = await fw();
  const printers = await callAsync<Record<string, any>>((ok, fail) => f.getPrintersAsync(ok, fail));
  return Object.keys(printers).filter((n) => printers[n]?.isConnected !== false);
}

export interface DymoPrinterLike {
  name: string;
  label_w_mm?: number | null;
  label_h_mm?: number | null;
  top_offset_mm?: number | null;
  left_offset_mm?: number | null;
  right_offset_mm?: number | null;
  bottom_offset_mm?: number | null;
}

const TWIPS = 56.6929; // per mm

// Same inset model as the ZPL path: content box = label minus margins.
function labelXml(code: string, qrPngBase64: string, p?: DymoPrinterLike): string {
  const w = Math.round((p?.label_w_mm ?? 89) * TWIPS);
  const h = Math.round((p?.label_h_mm ?? 28.6) * TWIPS);
  const off = (v?: number | null) => Math.round(Number(v ?? 0) * TWIPS);
  const x0 = off(p?.left_offset_mm);
  const y0 = off(p?.top_offset_mm);
  const cw = Math.max(500, w - x0 - off(p?.right_offset_mm));
  const ch = Math.max(300, h - y0 - off(p?.bottom_offset_mm));
  const qrSide = Math.min(ch, Math.round(cw * 0.42));
  const tx = x0 + qrSide + 120;
  return `<?xml version="1.0" encoding="utf-8"?>
<DieCutLabel Version="8.0" Units="twips">
  <PaperOrientation>Landscape</PaperOrientation>
  <Id>Address</Id>
  <IsOutlined>false</IsOutlined>
  <PaperName>30252 Address</PaperName>
  <DrawCommands>
    <RoundRectangle X="0" Y="0" Width="${h}" Height="${w}" Rx="270" Ry="270"/>
  </DrawCommands>
  <ObjectInfo>
    <ImageObject>
      <Name>QRCODE</Name>
      <ForeColor Alpha="255" Red="0" Green="0" Blue="0"/>
      <BackColor Alpha="0" Red="255" Green="255" Blue="255"/>
      <LinkedObjectName/>
      <Rotation>Rotation0</Rotation>
      <IsMirrored>False</IsMirrored>
      <IsVariable>False</IsVariable>
      <Image>${qrPngBase64}</Image>
      <ScaleMode>Uniform</ScaleMode>
      <BorderWidth>0</BorderWidth>
      <BorderColor Alpha="0" Red="0" Green="0" Blue="0"/>
      <HorizontalAlignment>Center</HorizontalAlignment>
      <VerticalAlignment>Middle</VerticalAlignment>
      <Bounds X="${x0}" Y="${y0}" Width="${qrSide}" Height="${qrSide}"/>
    </ImageObject>
    <TextObject>
      <Name>CODE</Name>
      <ForeColor Alpha="255" Red="0" Green="0" Blue="0"/>
      <BackColor Alpha="0" Red="255" Green="255" Blue="255"/>
      <LinkedObjectName/>
      <Rotation>Rotation0</Rotation>
      <IsMirrored>False</IsMirrored>
      <IsVariable>False</IsVariable>
      <HorizontalAlignment>Left</HorizontalAlignment>
      <VerticalAlignment>Middle</VerticalAlignment>
      <TextFitMode>ShrinkToFit</TextFitMode>
      <UseFullFontHeight>True</UseFullFontHeight>
      <Verticalized>False</Verticalized>
      <StyledText>
        <Element>
          <String>${code}</String>
          <Attributes>
            <Font Family="Helvetica" Size="11" Bold="True" Italic="False" Underline="False" Strikeout="False"/>
            <ForeColor Alpha="255" Red="0" Green="0" Blue="0"/>
          </Attributes>
        </Element>
      </StyledText>
      <Bounds X="${tx}" Y="${y0 + Math.round(ch / 2) - 300}" Width="${x0 + cw - tx - 60}" Height="600"/>
    </TextObject>
  </ObjectInfo>
</DieCutLabel>`;
}

/** Verify the named printer exists/is connected; report loaded media when the service knows it. */
export async function dymoProbe(printerName: string): Promise<{
  connected: boolean;
  label_w_mm?: number;
  label_h_mm?: number;
  dpi?: number;
  info: Record<string, any>;
}> {
  const f = await fw();
  const printers = await callAsync<Record<string, any>>((ok, fail) => f.getPrintersAsync(ok, fail));
  const info = printers[printerName];
  if (!info)
    throw new Error(
      `DYMO printer "${printerName}" not found (installed: ${Object.keys(printers).join(', ') || 'none'})`,
    );
  const out = { connected: info.isConnected !== false, info } as {
    connected: boolean;
    label_w_mm?: number;
    label_h_mm?: number;
    dpi?: number;
    info: Record<string, any>;
  };
  // Consumable/media info is best-effort - not all models/services report it.
  try {
    const media = await callAsync<any>((ok, fail) =>
      info.getConsumableInfoIn ? info.getConsumableInfoIn(ok, fail) : ok(null),
    );
    const w = media?.labelsWidth ?? media?.labelWidth ?? media?.width;
    const h = media?.labelsHeight ?? media?.labelHeight ?? media?.height;
    if (w) out.label_w_mm = Math.round((w / TWIPS) * 10) / 10;
    if (h) out.label_h_mm = Math.round((h / TWIPS) * 10) / 10;
    const dpi = media?.horizontalResolution ?? media?.resolution;
    if (dpi) out.dpi = Number(dpi);
  } catch {
    // no consumable info - printer still verified
  }
  return out;
}

/** Render a preview via Dymo's own renderer; returns a PNG data URL or null. */
export async function dymoRenderLabel(
  p: DymoPrinterLike,
  code: string,
  origin: string,
): Promise<string | null> {
  try {
    const f = await fw();
    const dataUrl = await QRCode.toDataURL(`${origin}/l/${code}`, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 300,
    });
    const xml = labelXml(code, dataUrl.split(',')[1], p);
    const png = f.renderLabel(xml, '', p.name);
    return png ? `data:image/png;base64,${png}` : null;
  } catch {
    return null;
  }
}

/** Prints one label per code. `p` is the saved printer (size + margins apply). */
export async function dymoPrintLabels(
  p: DymoPrinterLike,
  codes: string[],
  origin: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const f = await fw();
  const printers = await callAsync<Record<string, any>>((ok, fail) => f.getPrintersAsync(ok, fail));
  if (!printers[p.name])
    throw new Error(
      `DYMO printer "${p.name}" not found (installed: ${Object.keys(printers).join(', ') || 'none'})`,
    );
  if (printers[p.name].isConnected === false)
    throw new Error(`DYMO printer "${p.name}" is not connected`);

  for (const [i, code] of codes.entries()) {
    const dataUrl = await QRCode.toDataURL(`${origin}/l/${code}`, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 300,
    });
    const xml = labelXml(code, dataUrl.split(',')[1], p);
    const label = f.openLabelXml(xml);
    if (label?.isValidLabel && !label.isValidLabel())
      throw new Error(`DYMO Connect rejected the label XML for ${code}`);
    try {
      f.printLabel(p.name, '', xml, '');
    } catch (e) {
      throw new Error(`DYMO print failed for ${code}: ${(e as Error).message}`);
    }
    onProgress?.(i + 1, codes.length);
  }
}
