// Pure-JS QR encoder, replacing the old Python app's `qrcode[pil]` dependency
// (member_card/image.py). `qrcode-generator` has zero dependencies, does no
// Canvas/image-library work, and emits a plain SVG string with an explicit
// pixel width/height baked in -- exactly the shape Satori's <img> tag needs
// when handed a data: URL it can't introspect for intrinsic size itself.
import qrcode from 'qrcode-generator';

export interface QrCodeImage {
  /** `data:image/svg+xml;base64,...` -- safe to drop straight into a Satori `<img src>`. */
  dataUrl: string;
  /** Rendered width/height in px (the SVG is always square). */
  size: number;
}

/**
 * Encode `value` (e.g. a member's serial number) as a QR code and return it
 * as a base64 SVG data URL sized for embedding in the card template.
 */
export function buildQrCodeImage(value: string, cellSize = 4, margin = 4): QrCodeImage {
  // Type number 0 = let the library auto-select the smallest QR version that
  // fits `value`; error-correction level M matches what the old Python app
  // used for the printed/pass QR code.
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();

  const svg = qr.createSvgTag({ cellSize, margin });
  const size = qr.getModuleCount() * cellSize + margin * 2;

  // The generated SVG is plain ASCII markup (numbers, path commands, no
  // member-supplied text), so btoa is safe here without a UTF-8 shim.
  const base64 = btoa(svg);

  return { dataUrl: `data:image/svg+xml;base64,${base64}`, size };
}
