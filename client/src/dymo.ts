import QRCode from 'qrcode';

/**
 * DYMO LabelWriter printing via the DYMO Web Service — the standard browser
 * path for Dymo. Requires DYMO Connect installed and running on this machine.
 */
const DLS = 'https://127.0.0.1:41951/DYMO/DLS/Printing';

export async function dymoPrinters(): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${DLS}/GetPrinters`);
  } catch {
    throw new Error('DYMO Web Service not reachable — is DYMO Connect running on this device?');
  }
  const doc = new DOMParser().parseFromString(await res.text(), 'text/xml');
  return [...doc.querySelectorAll('Printers > * > Name')]
    .map((el) => el.textContent ?? '')
    .filter(Boolean);
}

function labelXml(code: string, qrPngBase64: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<DieCutLabel Version="8.0" Units="twips">
  <PaperOrientation>Landscape</PaperOrientation>
  <Id>Address</Id>
  <IsOutlined>false</IsOutlined>
  <PaperName>30252 Address</PaperName>
  <DrawCommands>
    <RoundRectangle X="0" Y="0" Width="1581" Height="5040" Rx="270" Ry="270"/>
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
      <Bounds X="120" Y="140" Width="1300" Height="1300"/>
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
      <Bounds X="1600" Y="300" Width="3200" Height="1000"/>
    </TextObject>
  </ObjectInfo>
</DieCutLabel>`;
}

async function printOne(printerName: string, code: string, qrBase64: string): Promise<void> {
  const body = new URLSearchParams({
    printerName,
    labelXml: labelXml(code, qrBase64),
    printParamsXml: '',
    labelSetXml: '',
    isAjax: '1',
  });
  const res = await fetch(`${DLS}/PrintLabel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok || text.trim().startsWith('false'))
    throw new Error(`DYMO print failed for ${code}: ${text.slice(0, 120)}`);
}

/** Prints one label per code. `printerName` must match a DYMO printer name. */
export async function dymoPrintLabels(
  printerName: string,
  codes: string[],
  origin: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  for (const [i, code] of codes.entries()) {
    const dataUrl = await QRCode.toDataURL(`${origin}/l/${code}`, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 300,
    });
    await printOne(printerName, code, dataUrl.split(',')[1]);
    onProgress?.(i + 1, codes.length);
  }
}
